import { createHmac, timingSafeEqual } from "node:crypto";

/** Header that carries the CSRF token on state-changing requests (D20). */
export const CSRF_HEADER = "x-csrf-token";
export const CSRF_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 5_000;
const MIN_SECRET_BYTES = 32;

export type CsrfFailure =
  | "method_not_allowed"
  | "origin_missing"
  | "origin_mismatch"
  | "cross_site"
  | "token_missing"
  | "token_invalid"
  | "token_expired";

export interface CsrfOptions {
  /** Verified identity of the caller (from the auth layer, D16). The token is bound to it. */
  identity: string;
  secret: Uint8Array;
  /** Exact origins of the app as the browser sees it (e.g. the tailnet HTTPS origin). */
  allowedOrigins: readonly string[];
  now?: () => number;
}

function sign(identity: string, secret: Uint8Array, issuedAt: number): Buffer {
  if (secret.byteLength < MIN_SECRET_BYTES) throw new Error(`csrf secret must have at least ${MIN_SECRET_BYTES} bytes`);
  return createHmac("sha256", secret).update(`v1|${identity}|${issuedAt}`).digest();
}

/** Stateless token: issue time plus HMAC over identity and issue time. */
export function issueCsrfToken(identity: string, secret: Uint8Array, now: number = Date.now()): string {
  return `${now.toString(36)}.${sign(identity, secret, now).toString("base64url")}`;
}

/** Same-origin check plus token check. Returns only fixed codes, never header values. */
export function verifyCsrf(request: Request, opts: CsrfOptions): { ok: true } | { ok: false; code: CsrfFailure } {
  const fail = (code: CsrfFailure) => ({ ok: false as const, code });
  if (request.method !== "POST") return fail("method_not_allowed");

  const origin = request.headers.get("origin");
  if (origin === null) return fail("origin_missing");
  if (!opts.allowedOrigins.includes(origin)) return fail("origin_mismatch");
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return fail("cross_site");

  const token = request.headers.get(CSRF_HEADER);
  if (token === null || token === "") return fail("token_missing");
  const m = /^([0-9a-z]{1,12})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m) return fail("token_invalid");
  const issuedAt = parseInt(m[1], 36);
  const given = Buffer.from(m[2], "base64url");
  const expected = sign(opts.identity, opts.secret, issuedAt);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return fail("token_invalid");
  const now = (opts.now ?? Date.now)();
  if (issuedAt > now + MAX_CLOCK_SKEW_MS) return fail("token_invalid");
  if (now - issuedAt > CSRF_TTL_MS) return fail("token_expired");
  return { ok: true };
}
