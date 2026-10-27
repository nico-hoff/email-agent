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
