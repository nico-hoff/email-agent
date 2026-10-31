import { createHmac, timingSafeEqual } from "node:crypto";

/** Pure auth building blocks (D16, O2a). No file access, no globals; see lib/auth-runtime.ts for the wiring. */

export const TAILSCALE_LOGIN_HEADER = "tailscale-user-login";
export const SESSION_COOKIE = "ea_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Fixed identity of the synthetic dev mode (npm run dev). Never accepted anywhere else. */
export const DEV_IDENTITY = "dev@synthetic.invalid";
const MAX_LOGIN_CHARS = 254;
const MAX_CLOCK_SKEW_MS = 5_000;
const MIN_SECRET_BYTES = 32;

/** The login that Tailscale Serve put into the request, or null when absent or implausible. */
export function readTailnetLogin(headers: Headers): string | null {
  const v = headers.get(TAILSCALE_LOGIN_HEADER)?.trim();
  if (!v || v.length > MAX_LOGIN_CHARS) return null;
  if (!/^[\x21-\x7e]+$/.test(v)) return null;
  return v;
}

/** `{"logins": ["a@b"]}`; anything else yields an empty list, which denies everybody. */
export function parseAllowlist(text: string): string[] {
  try {
    const v: unknown = JSON.parse(text);
    const logins = v !== null && typeof v === "object" ? (v as { logins?: unknown }).logins : undefined;
    if (!Array.isArray(logins) || !logins.every((l) => typeof l === "string" && l.length > 0 && l.length <= MAX_LOGIN_CHARS)) return [];
    return logins.map((l: string) => l.toLowerCase());
  } catch {
    return [];
  }
}

export function isAllowed(login: string, allowlist: readonly string[]): boolean {
  return allowlist.includes(login.toLowerCase());
}

export type IdentityResult =
  | { ok: true; login: string; source: "tailnet" | "dev" }
  | { ok: false; status: 401 | 403; code: "no_identity" | "not_allowed" };

/** Header identity checked against the allowlist. Without a header only the synthetic dev mode yields an identity. */
export function resolveIdentity(headers: Headers, o: { allowlist: readonly string[]; synthetic: boolean }): IdentityResult {
  const login = readTailnetLogin(headers);
  if (login === null) {
    return o.synthetic ? { ok: true, login: DEV_IDENTITY, source: "dev" } : { ok: false, status: 401, code: "no_identity" };
  }
  const allowed = isAllowed(login, o.allowlist) || (o.synthetic && login.toLowerCase() === DEV_IDENTITY);
  return allowed ? { ok: true, login: login.toLowerCase(), source: "tailnet" } : { ok: false, status: 403, code: "not_allowed" };
}

export interface AuthKeys { session: Uint8Array; csrf: Uint8Array }

/** Separate subkeys for session cookies and CSRF tokens from the one stored secret. */
export function deriveKeys(secret: Uint8Array): AuthKeys {
  if (secret.byteLength < MIN_SECRET_BYTES) throw new Error(`auth secret must have at least ${MIN_SECRET_BYTES} bytes`);
  const sub = (label: string) => new Uint8Array(createHmac("sha256", secret).update(`email-agent|${label}`).digest());
  return { session: sub("session"), csrf: sub("csrf") };
}

function mac(key: Uint8Array, iat: number, loginB64: string): Buffer {
  return createHmac("sha256", key).update(`v1|${iat}|${loginB64}`).digest();
}

/** `v1.<issued at, base36>.<login, base64url>.<HMAC>`; expiry is derived from the issue time. */
export function issueSession(login: string, key: Uint8Array, now: number = Date.now()): string {
  const loginB64 = Buffer.from(login, "utf8").toString("base64url");
  return `v1.${now.toString(36)}.${loginB64}.${mac(key, now, loginB64).toString("base64url")}`;
}

export function verifySession(value: string, key: Uint8Array, now: number = Date.now()): { ok: true; login: string } | { ok: false } {
  const m = /^v1\.([0-9a-z]{1,12})\.([A-Za-z0-9_-]{1,400})\.([A-Za-z0-9_-]{43})$/.exec(value);
  if (!m) return { ok: false };
  const iat = parseInt(m[1], 36);
  const given = Buffer.from(m[3], "base64url");
  const expected = mac(key, iat, m[2]);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false };
  if (iat > now + MAX_CLOCK_SKEW_MS || now - iat > SESSION_TTL_MS) return { ok: false };
  return { ok: true, login: Buffer.from(m[2], "base64url").toString("utf8") };
}

// --- users mode cookie ---------------------------------------------------------------------------------------------
function userMac(key: Uint8Array, iat: number, userId: number, token: string): Buffer {
  return createHmac("sha256", key).update(`v2|${iat}|${userId}|${token}`).digest();
}

/** `v2.<issued at, base36>.<user id>.<session token>.<HMAC>`; the token is also checked against its server-side row. */
export function issueUserSession(userId: number, token: string, key: Uint8Array, now: number = Date.now()): string {
  return `v2.${now.toString(36)}.${userId}.${token}.${userMac(key, now, userId, token).toString("base64url")}`;
}

export function verifyUserSession(
  value: string,
  key: Uint8Array,
  now: number = Date.now(),
): { ok: true; userId: number; token: string } | { ok: false } {
  const m = /^v2\.([0-9a-z]{1,12})\.([1-9][0-9]{0,14})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/.exec(value);
  if (!m) return { ok: false };
  const iat = parseInt(m[1], 36);
  const userId = Number(m[2]);
  const given = Buffer.from(m[4], "base64url");
  const expected = userMac(key, iat, userId, m[3]);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false };
  if (iat > now + MAX_CLOCK_SKEW_MS || now - iat > SESSION_TTL_MS) return { ok: false };
  return { ok: true, userId, token: m[3] };
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

const COOKIE_ATTRS = "Path=/; HttpOnly; SameSite=Strict";

export function sessionCookieHeader(value: string, o: { secure: boolean }): string {
  return `${SESSION_COOKIE}=${value}; ${COOKIE_ATTRS}; Max-Age=${SESSION_TTL_MS / 1000}${o.secure ? "; Secure" : ""}`;
}

export function clearCookieHeader(o: { secure: boolean }): string {
  return `${SESSION_COOKIE}=; ${COOKIE_ATTRS}; Max-Age=0${o.secure ? "; Secure" : ""}`;
}

/**
 * Origins a same-origin browser request may carry, derived from the Host header (Tailscale Serve forwards it).
 * Synthetic mode accepts only loopback hosts, so a DNS-rebinding page cannot use the fixed dev identity.
 */
export function requestOrigins(request: Request, o: { synthetic: boolean }): string[] {
  const host = request.headers.get("host");
  if (!host || !/^[A-Za-z0-9.\-:\[\]]{1,255}$/.test(host)) return [];
  if (o.synthetic && !/^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/.test(host)) return [];
  return [`http://${host}`, `https://${host}`];
}

/** Whether the browser reached us over HTTPS (Serve terminates TLS and forwards plain HTTP to 127.0.0.1). */
export function isHttpsRequest(request: Request): boolean {
  return new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
}

// --- password and users mode (public hosting, e.g. fly.io) -----------------------------------------------------------
export type AuthMode = "synthetic" | "users" | "password" | "tailnet";
/** Fixed session identity of the password mode: there is exactly one user, the holder of APP_PASSWORD. */
export const PASSWORD_IDENTITY = "password-user";
export const MIN_PASSWORD_CHARS = 16;
/** CSRF identity of the users mode before login (login and registration forms); after login it is `user:<id>`. */
export const USERS_PRE_LOGIN_IDENTITY = "users-pre-login";

/** Identity string of a signed-in user in the users mode: CSRF binding, rate-limit key, briefing cache key. */
export function userIdentity(userId: number): string {
  return `user:${userId}`;
}

/**
 * Pure mode choice. Synthetic dev mode wins; then the explicit AUTH_MODE=users (ADR 0022/0029); otherwise a set
 * APP_PASSWORD (even an empty or too short one, which then fails closed) selects the password mode, and the Tailscale
 * header is not read at all. Unset = tailnet mode. Password and tailnet stay as transitional modes mapped to the owner.
 */
export function selectAuthMode(o: { synthetic: boolean; appPassword: string | undefined; authMode?: string | undefined }): AuthMode {
  if (o.synthetic) return "synthetic";
  if (o.authMode === "users") return "users";
  return o.appPassword === undefined ? "tailnet" : "password";
}

export function appPasswordStatus(appPassword: string | undefined): "unset" | "ok" | "too_short" {
  if (appPassword === undefined) return "unset";
  return appPassword.length >= MIN_PASSWORD_CHARS ? "ok" : "too_short";
}

const FORWARDING_HEADERS = ["x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "forwarded", "fly-client-ip", "fly-forwarded-proto", "via"];

/** Unset (server default 127.0.0.1) or a loopback address: only this machine can reach the listener. */
export function isLoopbackBind(bindAddress: string | undefined): boolean {
  if (bindAddress === undefined || bindAddress === "") return true;
  return bindAddress === "localhost" || bindAddress === "::1" || bindAddress === "[::1]" || /^127(\.\d{1,3}){3}$/.test(bindAddress);
}

/**
 * True only for a request that can only come from this machine (local tests): the server listens on loopback, the Host
 * header is a loopback name, and no proxy header is present. The bind address is the real guard: the Veryfront server
 * strips x-forwarded-* before our handlers run (observed in production mode), so headers alone prove nothing. Public
 * hosting binds 0.0.0.0 (BIND_ADDRESS), which switches this exception off for good.
 */
export function isLoopbackDirect(request: Request, bindAddress?: string): boolean {
  if (!isLoopbackBind(bindAddress)) return false;
  const host = request.headers.get("host");
  if (!host || !/^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/.test(host)) return false;
  return !FORWARDING_HEADERS.some((h) => request.headers.has(h));
}
