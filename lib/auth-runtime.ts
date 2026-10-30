import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import {
  type AuthKeys, clearCookieHeader, DEV_IDENTITY, deriveKeys, isHttpsRequest, issueSession, parseAllowlist, readCookie, requestOrigins,
  resolveIdentity, SESSION_COOKIE, sessionCookieHeader, verifySession,
} from "./auth.ts";
import { DEFAULT_DATABASE_PATH, DEV_SYNTHETIC_DATABASE_PATH, PROJECT_ROOT } from "./constants.ts";
import { issueCsrfToken, verifyCsrf } from "./csrf.ts";
import { createRateLimiter, type RateLimiter } from "./rate-limit.ts";

/** Wiring of lib/auth.ts to files, requests and responses. Route modules and server.ts stay thin. */

export const ALLOWLIST_FILE = "auth-allowlist.json";
export const SECRET_FILE = "auth-secret";
export const DEV_SECRET_FILE = "dev-synthetic-auth-secret";
const LOGIN_LIMIT = 10;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
/** State changes by a signed-in user (e.g. marking a mail done): generous, but bounded per identity. */
const MUTATION_LIMIT = 120;

export interface AuthContext {
  readonly synthetic: boolean;
  now(): number;
  /** Read on every call, so editing the file takes effect without a restart. Missing file = empty list. */
  allowlist(): string[];
  /** Throws AuthSecretError when the secret file is unusable (fail-closed). */
  keys(): AuthKeys;
}

export class AuthSecretError extends Error {}

function readSecret(file: string): Uint8Array {
  const st = lstatSync(file);
  if (!st.isFile()) throw new AuthSecretError("auth secret must be a regular file");
  if ((st.mode & 0o077) !== 0) throw new AuthSecretError("auth secret file must not grant group/other access (use 0600)");
  const bytes = Buffer.from(readFileSync(file, "utf8").trim(), "base64url");
  if (bytes.length < 32) throw new AuthSecretError("auth secret file is too short");
  return new Uint8Array(bytes);
}

/** Creates the secret on first use (random, 0600, atomic) and returns it. Never logs or returns it to callers other than auth. */
function loadOrCreateSecret(file: string): Uint8Array {
  mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return readSecret(file);
    } catch (e) {
      if (e instanceof AuthSecretError || (e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    // Write a private temp file, then link it into place: readers never see a partial secret, and a racing creator loses cleanly.
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeSync(fd, randomBytes(32).toString("base64url") + "\n");
    } finally {
      closeSync(fd);
    }
    try {
      chmodSync(tmp, 0o600);
      linkSync(tmp, file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    } finally {
      unlinkSync(tmp);
    }
  }
  throw new AuthSecretError("auth secret could not be created");
}

export function createAuthContext(o: { dataDir: string; synthetic: boolean; now?: () => number }): AuthContext {
  let keys: AuthKeys | undefined;
  const secretPath = join(o.dataDir, o.synthetic ? DEV_SECRET_FILE : SECRET_FILE);
  return {
    synthetic: o.synthetic,
    now: o.now ?? Date.now,
    allowlist() {
      try {
        return parseAllowlist(readFileSync(join(o.dataDir, ALLOWLIST_FILE), "utf8"));
      } catch {
        return [];
      }
    },
    keys() {
      keys ??= deriveKeys(loadOrCreateSecret(secretPath));
      return keys;
    },
  };
}

/** server.ts --synthetic forces DATABASE_PATH to the dev database before anything listens; route modules see the same env. */
export function syntheticFromEnv(env: Record<string, string | undefined>, projectRoot: string): boolean {
  if (env.DATABASE_PATH === undefined || env.DATABASE_PATH === "") return false;
  return resolve(projectRoot, env.DATABASE_PATH).endsWith(`${sep}${DEV_SYNTHETIC_DATABASE_PATH}`);
}

/** Secret and allowlist live next to the database (data/ locally, the /data volume in Docker), the only writable private directory. */
export function dataDirFromEnv(env: Record<string, string | undefined>, projectRoot: string): string {
  return dirname(resolve(projectRoot, env.DATABASE_PATH === undefined || env.DATABASE_PATH === "" ? DEFAULT_DATABASE_PATH : env.DATABASE_PATH));
}

const contexts = new Map<string, AuthContext>();
export function defaultAuthContext(): AuthContext {
  const synthetic = syntheticFromEnv(process.env, PROJECT_ROOT);
  const dataDir = dataDirFromEnv(process.env, PROJECT_ROOT);
  const key = `${synthetic}|${dataDir}`;
  let ctx = contexts.get(key);
  if (!ctx) contexts.set(key, (ctx = createAuthContext({ dataDir, synthetic })));
  return ctx;
}

export function createLoginLimiter(now?: () => number): RateLimiter {
  return createRateLimiter({ limit: LOGIN_LIMIT, windowMs: LOGIN_WINDOW_MS, now });
}
let defaultLimiter: RateLimiter | undefined;
export function defaultLoginLimiter(): RateLimiter {
  return (defaultLimiter ??= createLoginLimiter());
}

/** Limiter for state-changing app routes. Each route module holds its own default instance (modules share no memory). */
export function createMutationLimiter(now?: () => number, limit: number = MUTATION_LIMIT): RateLimiter {
  return createRateLimiter({ limit, windowMs: LOGIN_WINDOW_MS, now });
}
let defaultMutation: RateLimiter | undefined;
export function defaultMutationLimiter(): RateLimiter {
  return (defaultMutation ??= createMutationLimiter());
}

// --- path policy ----------------------------------------------------------------------------------------------------
export const DENY_PATH = "/api/auth/deny";
const PUBLIC_EXACT = new Set(["/api/health", "/welcome", "/api/auth/session", "/api/auth/login", "/api/auth/logout", DENY_PATH]);
// Framework-served client modules, styles and HMR: code only, never mail data.
const PUBLIC_PREFIXES = ["/_vf_modules/", "/_vf_styles/", "/_veryfront/"];
const publicFiles = new Set<string>();
try {
  for (const e of readdirSync(join(PROJECT_ROOT, "public"), { withFileTypes: true })) if (e.isFile()) publicFiles.add(`/${e.name}`);
} catch { /* no public directory */ }

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_EXACT.has(pathname) || publicFiles.has(pathname) || PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));
}

// --- session --------------------------------------------------------------------------------------------------------
function sessionLogin(request: Request, ctx: AuthContext): string | null {
  try {
    const value = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
    if (value === null) return null;
    const v = verifySession(value, ctx.keys().session, ctx.now());
    // Removing a login from the allowlist ends its sessions at once.
    if (!v.ok) return null;
    const known = ctx.allowlist().includes(v.login.toLowerCase()) || (ctx.synthetic && v.login === DEV_IDENTITY);
    return known ? v.login : null;
  } catch {
    return null;
  }
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });

/** Central gate (run by interceptRequest in server.ts): undefined = let the request through. */
export function guardRequest(request: Request, ctx: AuthContext): Response | undefined {
  const url = new URL(request.url);
  if (isPublicPath(url.pathname)) return undefined;
  if (sessionLogin(request, ctx) !== null) return undefined;
  const navigation = (request.method === "GET" || request.method === "HEAD") && !url.pathname.startsWith("/api/");
  return navigation
    ? new Response(null, { status: 303, headers: { location: "/welcome", "cache-control": "no-store" } })
    : json({ error: "unauthorized" }, 401);
}

// --- request interceptor ------------------------------------------------------------------------------------------
// A root middleware.ts is not an option: Veryfront transpiles it to .vf-middleware-*.mjs next to the source, which a
// read-only container with USER node cannot write. startServer's requestInterceptor can only return a (fresh) Request,
// never a Response, so a denied request is rewritten to the public deny route, which answers from a fixed kind only.
const DENY_KINDS = new Set(["page", "api", "forbidden"]);

/** Response of any method on /api/auth/deny?k=...: derived from the allow-listed kind only, anything else is 401. */
export function handleDeny(request: Request): Response {
  let kind: string | null = null;
  try {
    kind = new URL(request.url).searchParams.get("k");
  } catch { /* unparsable: 401 */ }
  if (kind === "page") return new Response(null, { status: 303, headers: { location: "/welcome", "cache-control": "no-store" } });
  if (kind === "forbidden") return json({ error: "forbidden" }, 403);
  return json({ error: "unauthorized" }, 401);
}

function denyRequest(request: Request, kind: string): Request {
  let origin = "http://localhost";
  try {
    origin = new URL(request.url).origin;
  } catch { /* keep the fallback */ }
  // Fresh GET without headers and body: nothing of the original request reaches the deny route.
  return new Request(`${origin}${DENY_PATH}?k=${DENY_KINDS.has(kind) ? kind : "api"}`, { method: "GET" });
}

/**
 * requestInterceptor for startServer: the original request only when the guard says "allowed" explicitly; every denial
 * and every error becomes a rewrite to the deny route (fail-closed).
 */
export function interceptRequest(request: Request, context: () => AuthContext = defaultAuthContext): Request {
  try {
    const denied = guardRequest(request, context());
    if (denied === undefined) return request;
    return denyRequest(request, denied.status === 303 ? "page" : denied.status === 403 ? "forbidden" : "api");
  } catch {
    return denyRequest(request, "api");
  }
}

// --- handlers -------------------------------------------------------------------------------------------------------
/** GET /api/auth/session: the identity Tailscale (or the dev mode) vouches for, plus a CSRF token bound to it. */
export function handleSession(request: Request, ctx: AuthContext): Response {
  const id = resolveIdentity(request.headers, { allowlist: ctx.allowlist(), synthetic: ctx.synthetic });
  if (!id.ok) return json({ error: id.code }, id.status);
  try {
    const keys = ctx.keys();
    return json({ login: id.login, csrfToken: issueCsrfToken(id.login, keys.csrf, ctx.now()), signedIn: sessionLogin(request, ctx) === id.login });
  } catch {
    return json({ error: "auth_unavailable" }, 500);
  }
}

/** POST /api/auth/login: identity (401/403), rate limit (429), CSRF (403), then the session cookie. */
export function handleLogin(request: Request, ctx: AuthContext, limiter: RateLimiter): Response {
  const id = resolveIdentity(request.headers, { allowlist: ctx.allowlist(), synthetic: ctx.synthetic });
  if (!id.ok) return json({ error: id.code }, id.status);
  const limit = limiter.check(id.login);
  if (!limit.allowed) return json({ error: "rate_limited" }, 429, { "retry-after": String(Math.ceil(limit.retryAfterMs / 1000)) });
  try {
    const keys = ctx.keys();
    const csrf = verifyCsrf(request, { identity: id.login, secret: keys.csrf, allowedOrigins: requestOrigins(request, { synthetic: ctx.synthetic }), now: ctx.now });
    if (!csrf.ok) return json({ error: csrf.code }, 403);
    const cookie = sessionCookieHeader(issueSession(id.login, keys.session, ctx.now()), { secure: !ctx.synthetic || isHttpsRequest(request) });
    return json({ ok: true }, 200, { "set-cookie": cookie });
  } catch {
    return json({ error: "auth_unavailable" }, 500);
  }
}

/**
 * Gate for state-changing routes, in the order of the login handler: session (401), rate limit per identity (429),
 * then the same-origin and CSRF proof bound to that identity (403). Returns the verified login or the error response.
 */
export function guardMutation(
  request: Request,
  ctx: AuthContext,
  limiter: RateLimiter,
): { ok: true; login: string } | { ok: false; response: Response } {
  const login = sessionLogin(request, ctx);
  if (login === null) return { ok: false, response: json({ error: "unauthorized" }, 401) };
  const limit = limiter.check(login);
  if (!limit.allowed) {
    return { ok: false, response: json({ error: "rate_limited" }, 429, { "retry-after": String(Math.ceil(limit.retryAfterMs / 1000)) }) };
  }
  try {
    const csrf = verifyCsrf(request, { identity: login, secret: ctx.keys().csrf, allowedOrigins: requestOrigins(request, { synthetic: ctx.synthetic }), now: ctx.now });
    if (!csrf.ok) return { ok: false, response: json({ error: csrf.code }, 403) };
  } catch {
    return { ok: false, response: json({ error: "auth_unavailable" }, 500) };
  }
  return { ok: true, login };
}

/** POST /api/auth/logout: needs a valid session and CSRF, clears the cookie. */
export function handleLogout(request: Request, ctx: AuthContext): Response {
  const login = sessionLogin(request, ctx);
  if (login === null) return json({ error: "unauthorized" }, 401);
  try {
    const csrf = verifyCsrf(request, { identity: login, secret: ctx.keys().csrf, allowedOrigins: requestOrigins(request, { synthetic: ctx.synthetic }), now: ctx.now });
    if (!csrf.ok) return json({ error: csrf.code }, 403);
    return json({ ok: true }, 200, { "set-cookie": clearCookieHeader({ secure: !ctx.synthetic || isHttpsRequest(request) }) });
  } catch {
    return json({ error: "auth_unavailable" }, 500);
  }
}
