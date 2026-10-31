import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { chmodSync, closeSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import {
  type AuthKeys, type AuthMode, clearCookieHeader, DEV_IDENTITY, deriveKeys, isHttpsRequest, isLoopbackDirect, issueSession, issueUserSession,
  parseAllowlist, PASSWORD_IDENTITY, readCookie, requestOrigins, resolveIdentity, selectAuthMode, SESSION_COOKIE, sessionCookieHeader,
  userIdentity, USERS_PRE_LOGIN_IDENTITY, verifySession, verifyUserSession,
} from "./auth.ts";
import { DEFAULT_DATABASE_PATH, DEV_SYNTHETIC_DATABASE_PATH, PROJECT_ROOT } from "./constants.ts";
import { issueCsrfToken, verifyCsrf } from "./csrf.ts";
import { validateDatabasePath } from "./accounts.ts";
import { openDatabase } from "./db.ts";
import { createPasswordVerifier } from "./password.ts";
import { createRateLimiter, type RateLimiter } from "./rate-limit.ts";
import { createSession, OWNER_USER_ID, registerWithInvite, revokeAllSessions, revokeSessionToken, type User, type UserRole, verifyLogin, verifySessionToken } from "./users.ts";

/** Wiring of lib/auth.ts to files, requests and responses. Route modules and server.ts stay thin. */

export const ALLOWLIST_FILE = "auth-allowlist.json";
export const SECRET_FILE = "auth-secret";
export const DEV_SECRET_FILE = "dev-synthetic-auth-secret";
const LOGIN_LIMIT = 10;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
/** Password mode: global (there is no identity before login) budget of failed guesses. */
const PASSWORD_LIMIT = 10;
const PASSWORD_WINDOW_MS = 15 * 60 * 1000;
const PASSWORD_LIMIT_KEY = "password-login";
const PASSWORD_FAIL_DELAY_MS = 500;
const MAX_LOGIN_BODY_CHARS = 4096;
/** Users mode: failed logins per email address (hashed key) and in total, registrations per hour in total. */
const USERS_EMAIL_LIMIT = 10;
const USERS_GLOBAL_LIMIT = 60;
const USERS_WINDOW_MS = 15 * 60 * 1000;
const REGISTER_LIMIT = 10;
const REGISTER_WINDOW_MS = 60 * 60 * 1000;
const USERS_MAX_KEYS = 10_000;
/** State changes by a signed-in user (e.g. marking a mail done): generous, but bounded per identity. */
const MUTATION_LIMIT = 120;

export interface AuthContext {
  readonly synthetic: boolean;
  /** synthetic (dev identity), users (accounts in the database), password (APP_PASSWORD, Tailscale header ignored) or tailnet (header plus allowlist). */
  readonly mode: AuthMode;
  /** Password mode with a usable (>= 16 characters) APP_PASSWORD; false = fail-closed, nobody can sign in. */
  readonly passwordConfigured: boolean;
  readonly bindAddress: string | undefined;
  /** Constant-time check of a login attempt against APP_PASSWORD. Always false when not configured. */
  verifyPassword(candidate: string): Promise<boolean>;
  /** Fixed pause after a wrong password. */
  failDelay(): Promise<void>;
  now(): number;
  /** Read on every call, so editing the file takes effect without a restart. Missing file = empty list. */
  allowlist(): string[];
  /** Throws AuthSecretError when the secret file is unusable (fail-closed). */
  keys(): AuthKeys;
  /** Users mode: a connection to the application database (the caller closes it). Absent = users mode fails closed. */
  openDb?(): DatabaseSync;
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

export interface AuthContextOptions {
  dataDir: string;
  synthetic: boolean;
  now?: () => number;
  /** APP_PASSWORD. Only its derived key is kept. */
  appPassword?: string | undefined;
  failDelayMs?: number;
  /** BIND_ADDRESS of the listener (unset = loopback). Decides whether the password cookie may omit Secure on loopback. */
  bindAddress?: string | undefined;
  sleep?: (ms: number) => Promise<void>;
  /** AUTH_MODE. Only "users" has a meaning. */
  authMode?: string | undefined;
  /** Users mode: opens the application database. */
  openDb?: () => DatabaseSync;
}

export function createAuthContext(o: AuthContextOptions): AuthContext {
  let keys: AuthKeys | undefined;
  const secretPath = join(o.dataDir, o.synthetic ? DEV_SECRET_FILE : SECRET_FILE);
  const mode = selectAuthMode({ synthetic: o.synthetic, appPassword: o.appPassword, authMode: o.authMode });
  const verifier = createPasswordVerifier(mode === "password" ? o.appPassword : undefined);
  const delayMs = o.failDelayMs ?? PASSWORD_FAIL_DELAY_MS;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return {
    synthetic: o.synthetic,
    mode,
    passwordConfigured: mode === "password" && verifier.configured,
    bindAddress: o.bindAddress,
    verifyPassword: (candidate) => verifier.verify(candidate),
    failDelay: () => sleep(delayMs),
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
    ...(o.openDb ? { openDb: o.openDb } : {}),
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
  const appPassword = process.env.APP_PASSWORD;
  // The key holds a digest, never the password itself.
  const pwKey = appPassword === undefined ? "-" : createHash("sha256").update(appPassword).digest("hex");
  const bindAddress = process.env.BIND_ADDRESS;
  const authMode = process.env.AUTH_MODE;
  const key = `${synthetic}|${dataDir}|${pwKey}|${bindAddress ?? ""}|${authMode ?? ""}`;
  let ctx = contexts.get(key);
  if (!ctx) {
    contexts.set(key, (ctx = createAuthContext({
      dataDir, synthetic, appPassword, bindAddress, authMode,
      openDb: () => openDatabase(validateDatabasePath(process.env, PROJECT_ROOT)),
    })));
  }
  return ctx;
}

export function createLoginLimiter(now?: () => number): RateLimiter {
  return createRateLimiter({ limit: LOGIN_LIMIT, windowMs: LOGIN_WINDOW_MS, now });
}
/** Password mode: 10 guesses per 15 minutes in total, not per identity (none exists before login). */
export function createPasswordLimiter(now?: () => number): RateLimiter {
  return createRateLimiter({ limit: PASSWORD_LIMIT, windowMs: PASSWORD_WINDOW_MS, now, maxKeys: 1 });
}
let defaultLimiter: RateLimiter | undefined;
let defaultPwLimiter: RateLimiter | undefined;
export function defaultLoginLimiter(mode: AuthMode = "tailnet"): RateLimiter {
  if (mode === "users") return defaultUsersLimits().global;
  return mode === "password" ? (defaultPwLimiter ??= createPasswordLimiter()) : (defaultLimiter ??= createLoginLimiter());
}

/** Users mode: budgets of failed attempts per email address, in total, and for registrations in total. */
export interface UsersLimits { perEmail: RateLimiter; global: RateLimiter; register: RateLimiter }
export function createUsersLimits(now?: () => number): UsersLimits {
  return {
    perEmail: createRateLimiter({ limit: USERS_EMAIL_LIMIT, windowMs: USERS_WINDOW_MS, now, maxKeys: USERS_MAX_KEYS }),
    global: createRateLimiter({ limit: USERS_GLOBAL_LIMIT, windowMs: USERS_WINDOW_MS, now, maxKeys: 1 }),
    register: createRateLimiter({ limit: REGISTER_LIMIT, windowMs: REGISTER_WINDOW_MS, now, maxKeys: 1 }),
  };
}
let usersLimits: UsersLimits | undefined;
export function defaultUsersLimits(): UsersLimits {
  return (usersLimits ??= createUsersLimits());
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
const PUBLIC_EXACT = new Set(["/api/health", "/welcome", "/api/auth/session", "/api/auth/login", "/api/auth/logout", "/api/auth/register", DENY_PATH]);
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
/** Who a request belongs to: the identity string (CSRF binding, rate-limit key) and the data scope (`user_id`). */
export interface SessionIdentity {
  login: string;
  userId: number;
  role: UserRole;
  /** Users mode only: the session token (for logout). */
  token?: string;
  email?: string;
}

/** Runs `fn` with a connection of the users-mode database and closes it. Throws when the context has no database. */
function withUsersDb<T>(ctx: AuthContext, fn: (db: DatabaseSync) => T): T {
  if (!ctx.openDb) throw new Error("no database for users mode");
  const db = ctx.openDb();
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function usersSession(request: Request, ctx: AuthContext): SessionIdentity | null {
  const value = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  if (value === null) return null;
  const v = verifyUserSession(value, ctx.keys().session, ctx.now());
  if (!v.ok) return null;
  // The MAC proves we issued the cookie; the row decides whether the session is still alive (revocation, expiry, status).
  const live = withUsersDb(ctx, (db) => verifySessionToken(db, v.token, new Date(ctx.now())));
  if (live === null || live.user.id !== v.userId) return null;
  return { login: userIdentity(live.user.id), userId: live.user.id, role: live.user.role, token: v.token, email: live.user.email };
}

export function sessionIdentity(request: Request, ctx: AuthContext): SessionIdentity | null {
  try {
    if (ctx.mode === "users") return usersSession(request, ctx);
    const value = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
    if (value === null) return null;
    const v = verifySession(value, ctx.keys().session, ctx.now());
    // Removing a login from the allowlist ends its sessions at once.
    if (!v.ok) return null;
    // Transitional modes have one data owner: the owner user (id 1).
    const owner = (login: string): SessionIdentity => ({ login, userId: OWNER_USER_ID, role: "admin" });
    if (ctx.mode === "password") return ctx.passwordConfigured && v.login === PASSWORD_IDENTITY ? owner(v.login) : null;
    // Tailnet and synthetic: the login must still be known.
    const known = ctx.allowlist().includes(v.login.toLowerCase()) || (ctx.synthetic && v.login === DEV_IDENTITY);
    return known ? owner(v.login) : null;
  } catch {
    return null;
  }
}

function sessionLogin(request: Request, ctx: AuthContext): string | null {
  return sessionIdentity(request, ctx)?.login ?? null;
}

/**
 * For read routes behind the guard: the user whose data the request may see, or the 401 response. The transitional modes
 * (password, tailnet, synthetic) have one data owner and rely on the interceptor for the session check, as before; the
 * users mode verifies the session again here, so a route can never serve data without knowing whose it is.
 */
export function requireUser(request: Request, ctx: AuthContext): { ok: true; userId: number; role: UserRole; login: string } | { ok: false; response: Response } {
  if (ctx.mode !== "users") return { ok: true, userId: OWNER_USER_ID, role: "admin", login: PASSWORD_IDENTITY };
  const id = sessionIdentity(request, ctx);
  if (id === null) return { ok: false, response: Response.json({ error: "unauthorized" }, { status: 401, headers: { "cache-control": "no-store" } }) };
  return { ok: true, userId: id.userId, role: id.role, login: id.login };
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
/**
 * Secure flag of the session cookie. Tailnet: always (Serve is HTTPS). Synthetic dev mode: only when the browser used HTTPS.
 * Password mode (public host): always, no request header can turn it off; the single exception is a loopback-bound listener
 * (BIND_ADDRESS unset or loopback) and a loopback Host without proxy headers, i.e. local tests from the machine itself.
 * The x-forwarded-proto header is not usable here: the Veryfront server removes it before the route runs.
 */
function cookieSecure(request: Request, ctx: AuthContext): boolean {
  if (ctx.mode === "password" || ctx.mode === "users") return !isLoopbackDirect(request, ctx.bindAddress);
  return !ctx.synthetic || isHttpsRequest(request);
}

/**
 * GET /api/auth/session: tells the welcome page the mode and hands out a CSRF token. Tailnet and synthetic mode answer with
 * the identity Tailscale (or the dev mode) vouches for. Password mode never reads the Tailscale header and never names anybody.
 */
export function handleSession(request: Request, ctx: AuthContext): Response {
  if (ctx.mode === "users") {
    if (!ctx.openDb) return json({ mode: "users", configured: false });
    try {
      const keys = ctx.keys();
      const me = sessionIdentity(request, ctx);
      // Signed in: the token is bound to the user, so the existing mutation clients work unchanged. Before login it
      // belongs to the shared pre-login identity (login and registration forms).
      return json({
        mode: "users", configured: true, signedIn: me !== null,
        csrfToken: issueCsrfToken(me?.login ?? USERS_PRE_LOGIN_IDENTITY, keys.csrf, ctx.now()),
      });
    } catch {
      return json({ error: "auth_unavailable", mode: "users" }, 500);
    }
  }
  if (ctx.mode === "password") {
    if (!ctx.passwordConfigured) return json({ mode: "password", configured: false });
    try {
      const keys = ctx.keys();
      return json({
        mode: "password", configured: true, csrfToken: issueCsrfToken(PASSWORD_IDENTITY, keys.csrf, ctx.now()), signedIn: sessionLogin(request, ctx) !== null,
      });
    } catch {
      return json({ error: "auth_unavailable", mode: "password" }, 500);
    }
  }
  const id = resolveIdentity(request.headers, { allowlist: ctx.allowlist(), synthetic: ctx.synthetic });
  if (!id.ok) return json({ error: id.code, mode: ctx.mode }, id.status);
  try {
    const keys = ctx.keys();
    return json({ mode: ctx.mode, login: id.login, csrfToken: issueCsrfToken(id.login, keys.csrf, ctx.now()), signedIn: sessionLogin(request, ctx) === id.login });
  } catch {
    return json({ error: "auth_unavailable" }, 500);
  }
}

/** POST /api/auth/login for tailnet and synthetic mode: identity (401/403), rate limit (429), CSRF (403), then the session cookie. */
export function handleLogin(request: Request, ctx: AuthContext, limiter: RateLimiter): Response {
  if (ctx.mode === "password" || ctx.mode === "users") return json({ error: "unauthorized" }, 401); // these modes log in through their own handlers
  const id = resolveIdentity(request.headers, { allowlist: ctx.allowlist(), synthetic: ctx.synthetic });
  if (!id.ok) return json({ error: id.code }, id.status);
  const limit = limiter.check(id.login);
  if (!limit.allowed) return json({ error: "rate_limited" }, 429, { "retry-after": String(Math.ceil(limit.retryAfterMs / 1000)) });
  try {
    const keys = ctx.keys();
    const csrf = verifyCsrf(request, { identity: id.login, secret: keys.csrf, allowedOrigins: requestOrigins(request, { synthetic: ctx.synthetic }), now: ctx.now });
    if (!csrf.ok) return json({ error: csrf.code }, 403);
    const cookie = sessionCookieHeader(issueSession(id.login, keys.session, ctx.now()), { secure: cookieSecure(request, ctx) });
    return json({ ok: true }, 200, { "set-cookie": cookie });
  } catch {
    return json({ error: "auth_unavailable" }, 500);
  }
}

async function readPasswordCandidate(request: Request): Promise<string> {
  try {
    const length = Number(request.headers.get("content-length") ?? "0");
    if (length > MAX_LOGIN_BODY_CHARS) return "";
    const text = (await request.text()).slice(0, MAX_LOGIN_BODY_CHARS);
    const v: unknown = JSON.parse(text);
    const pw = v !== null && typeof v === "object" ? (v as { password?: unknown }).password : undefined;
    return typeof pw === "string" ? pw : "";
  } catch {
    return "";
  }
}

/**
 * POST /api/auth/login in password mode, body {"password": "..."}. Order: configured (503), CSRF (403; costs no attempt),
 * global limiter (429), password check, then cookie (200) or fixed delay plus 401. One uniform 401 for every wrong or
 * malformed attempt. A successful login gives back only its own slot, so it never resets the failures.
 */
export async function handlePasswordLogin(request: Request, ctx: AuthContext, limiter: RateLimiter): Promise<Response> {
  if (ctx.mode !== "password") return json({ error: "unauthorized" }, 401);
  if (!ctx.passwordConfigured) return json({ error: "server_misconfigured" }, 503);
  let keys: AuthKeys;
  try {
    keys = ctx.keys();
    const csrf = verifyCsrf(request, { identity: PASSWORD_IDENTITY, secret: keys.csrf, allowedOrigins: requestOrigins(request, { synthetic: false }), now: ctx.now });
    if (!csrf.ok) return json({ error: csrf.code }, 403);
  } catch {
    return json({ error: "auth_unavailable" }, 500);
  }
  // The slot is taken before the (slow) check, so parallel guesses cannot exceed the budget.
  const limit = limiter.check(PASSWORD_LIMIT_KEY);
  if (!limit.allowed) return json({ error: "rate_limited" }, 429, { "retry-after": String(Math.ceil(limit.retryAfterMs / 1000)) });
  let ok = false;
  try {
    ok = await ctx.verifyPassword(await readPasswordCandidate(request));
  } catch {
    ok = false;
  }
  if (!ok) {
    await ctx.failDelay();
    return json({ error: "invalid_credentials" }, 401);
  }
  limiter.release(PASSWORD_LIMIT_KEY);
  const cookie = sessionCookieHeader(issueSession(PASSWORD_IDENTITY, keys.session, ctx.now()), { secure: cookieSecure(request, ctx) });
  return json({ ok: true }, 200, { "set-cookie": cookie });
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const length = Number(request.headers.get("content-length") ?? "0");
    if (length > MAX_LOGIN_BODY_CHARS) return {};
    const v: unknown = JSON.parse((await request.text()).slice(0, MAX_LOGIN_BODY_CHARS));
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const field = (body: Record<string, unknown>, name: string): unknown => new Map(Object.entries(body)).get(name);
const retryAfter = (ms: number) => ({ "retry-after": String(Math.ceil(ms / 1000)) });

/** Users mode, before login: CSRF is bound to the shared pre-login identity. */
function preLoginCsrf(request: Request, ctx: AuthContext): Response | AuthKeys {
  try {
    const keys = ctx.keys();
    const csrf = verifyCsrf(request, { identity: USERS_PRE_LOGIN_IDENTITY, secret: keys.csrf, allowedOrigins: requestOrigins(request, { synthetic: false }), now: ctx.now });
    return csrf.ok ? keys : json({ error: csrf.code }, 403);
  } catch {
    return json({ error: "auth_unavailable" }, 500);
  }
}

function startSessionResponse(request: Request, ctx: AuthContext, keys: AuthKeys, userId: number): Response {
  const now = ctx.now();
  const token = withUsersDb(ctx, (db) => createSession(db, userId, new Date(now)).token);
  const cookie = sessionCookieHeader(issueUserSession(userId, token, keys.session, now), { secure: cookieSecure(request, ctx) });
  return json({ ok: true }, 200, { "set-cookie": cookie });
}

const emailKey = (email: unknown): string =>
  typeof email === "string" ? createHash("sha256").update(email.trim().toLowerCase()).digest("hex") : "-";

/**
 * POST /api/auth/login in users mode, body {"email","password"}. Order: configured (503), CSRF (403, costs no attempt),
 * limits per email and in total (429), check, then cookie (200) or fixed delay plus one uniform 401. The slots are taken
 * before the (slow) check; a success gives back only its own slots, so it never resets earlier failures.
 */
export async function handleUsersLogin(request: Request, ctx: AuthContext, limits: UsersLimits): Promise<Response> {
  if (ctx.mode !== "users") return json({ error: "unauthorized" }, 401);
  if (!ctx.openDb) return json({ error: "server_misconfigured" }, 503);
  const gate = preLoginCsrf(request, ctx);
  if (gate instanceof Response) return gate;
  const body = await readJsonBody(request);
  const email = field(body, "email");
  const key = emailKey(email);
  const g = limits.global.check("login");
  if (!g.allowed) return json({ error: "rate_limited" }, 429, retryAfter(g.retryAfterMs));
  const e = limits.perEmail.check(key);
  if (!e.allowed) {
    limits.global.release("login");
    return json({ error: "rate_limited" }, 429, retryAfter(e.retryAfterMs));
  }
  let user: User | null = null;
  try {
    user = await withUsersDb(ctx, (db) => verifyLogin(db, email, field(body, "password")));
  } catch {
    user = null;
  }
  if (user === null) {
    await ctx.failDelay();
    return json({ error: "invalid_credentials" }, 401);
  }
  limits.global.release("login");
  limits.perEmail.release(key);
  try {
    return startSessionResponse(request, ctx, gate, user.id);
  } catch {
    return json({ error: "auth_unavailable" }, 500);
  }
}

const REGISTER_STATUS = new Map<string, number>([["invalid_invite", 400], ["invalid_email", 400], ["weak_password", 400], ["email_taken", 409]]);

/**
 * POST /api/auth/register in users mode, body {"code","email","password"} (ADR 0022: registration only with an invitation).
 * Order: CSRF (403), registration budget (429), then the atomic consumption of the invitation plus the new user.
 * Every failure costs the fixed delay; wrong, used and expired codes are one answer.
 */
export async function handleRegister(request: Request, ctx: AuthContext, limits: UsersLimits): Promise<Response> {
  if (ctx.mode !== "users") return json({ error: "unauthorized" }, 401);
  if (!ctx.openDb) return json({ error: "server_misconfigured" }, 503);
  const gate = preLoginCsrf(request, ctx);
  if (gate instanceof Response) return gate;
  const body = await readJsonBody(request);
  const slot = limits.register.check("register");
  if (!slot.allowed) return json({ error: "rate_limited" }, 429, retryAfter(slot.retryAfterMs));
  let result;
  try {
    result = await withUsersDb(ctx, (db) =>
      registerWithInvite(db, { code: field(body, "code"), email: field(body, "email"), password: field(body, "password"), now: new Date(ctx.now()) }));
  } catch {
    return json({ error: "register_unavailable" }, 500);
  }
  if (!result.ok) {
    await ctx.failDelay();
    return json({ error: result.code }, REGISTER_STATUS.get(result.code) ?? 400);
  }
  limits.register.release("register");
  try {
    return startSessionResponse(request, ctx, gate, result.user.id);
  } catch {
    return json({ error: "auth_unavailable" }, 500);
  }
}

/** Route entry: picks the login flow of the mode. */
export function handleLoginRequest(request: Request, ctx: AuthContext, limiter: RateLimiter, limits?: UsersLimits): Response | Promise<Response> {
  if (ctx.mode === "users") return handleUsersLogin(request, ctx, limits ?? defaultUsersLimits());
  return ctx.mode === "password" ? handlePasswordLogin(request, ctx, limiter) : handleLogin(request, ctx, limiter);
}

/**
 * Gate for state-changing routes, in the order of the login handler: session (401), rate limit per identity (429),
 * then the same-origin and CSRF proof bound to that identity (403). Returns the verified login or the error response.
 */
export function guardMutation(
  request: Request,
  ctx: AuthContext,
  limiter: RateLimiter,
): { ok: true; login: string; userId: number; role: UserRole } | { ok: false; response: Response } {
  const me = sessionIdentity(request, ctx);
  if (me === null) return { ok: false, response: json({ error: "unauthorized" }, 401) };
  const login = me.login;
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
  return { ok: true, login, userId: me.userId, role: me.role };
}

/**
 * POST /api/auth/logout: needs a valid session and CSRF, clears the cookie. In users mode the session row is revoked on the
 * server, so a copied cookie is dead as well.
 */
export function handleLogout(request: Request, ctx: AuthContext): Response {
  const me = sessionIdentity(request, ctx);
  if (me === null) return json({ error: "unauthorized" }, 401);
  try {
    const csrf = verifyCsrf(request, { identity: me.login, secret: ctx.keys().csrf, allowedOrigins: requestOrigins(request, { synthetic: ctx.synthetic }), now: ctx.now });
    if (!csrf.ok) return json({ error: csrf.code }, 403);
    if (ctx.mode === "users" && me.token !== undefined) {
      const token = me.token;
      withUsersDb(ctx, (db) => revokeSessionToken(db, token, new Date(ctx.now())));
    }
    return json({ ok: true }, 200, { "set-cookie": clearCookieHeader({ secure: cookieSecure(request, ctx) }) });
  } catch {
    return json({ error: "auth_unavailable" }, 500);
  }
}

/** POST /api/sessions/revoke-all ("auf allen Geräten abmelden"): revokes every session row of the user, this one included. */
export function handleLogoutAll(request: Request, ctx: AuthContext, limiter: RateLimiter): Response {
  const gate = guardMutation(request, ctx, limiter);
  if (!gate.ok) return gate.response;
  if (ctx.mode !== "users") return json({ error: "users_mode_required" }, 409);
  try {
    const n = withUsersDb(ctx, (db) => revokeAllSessions(db, gate.userId, new Date(ctx.now())));
    return json({ ok: true, revoked: n }, 200, { "set-cookie": clearCookieHeader({ secure: cookieSecure(request, ctx) }) });
  } catch {
    return json({ error: "unavailable" }, 500);
  }
}

/** Exposed for the profile routes: a users-mode database connection scoped to a callback. */
export function withAuthDb<T>(ctx: AuthContext, fn: (db: DatabaseSync) => T): T {
  return withUsersDb(ctx, fn);
}
