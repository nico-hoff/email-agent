import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/**
 * Password hashing for user accounts (ADR 0022). Self-describing scrypt format `scrypt$N$r$p$<salt>$<hash>` (base64url),
 * so the parameters can be raised later without invalidating stored hashes. Pure (no database, no globals).
 * Plaintext is never logged or kept.
 */

export const MIN_USER_PASSWORD_CHARS = 12;
export const MAX_USER_PASSWORD_CHARS = 1024;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
/** N = 2^15, r = 8, p = 1 (about 32 MiB, tens of milliseconds); maxmem leaves headroom above 128 * N * r. */
const DEFAULT_PARAMS = { N: 32768, r: 8, p: 1 };
const MAXMEM = 128 * 1024 * 1024;
const MAX_N = 1 << 17;

interface ScryptParams { N: number; r: number; p: number }

function derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, KEY_BYTES, { N: params.N, r: params.r, p: params.p, maxmem: MAXMEM }, (err, key) => (err ? reject(err) : resolve(key)))
  );
}

/** Policy for a new password: length only (no composition rules). Returns the reason code or null. */
export function passwordProblem(password: unknown): "too_short" | "too_long" | "not_a_string" | null {
  if (typeof password !== "string") return "not_a_string";
  if (password.length < MIN_USER_PASSWORD_CHARS) return "too_short";
  if (password.length > MAX_USER_PASSWORD_CHARS) return "too_long";
  return null;
}

export async function hashPassword(password: string, params: ScryptParams = DEFAULT_PARAMS): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, params);
  return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

function parseHash(stored: string): { params: ScryptParams; salt: Buffer; key: Buffer } | null {
  const m = /^scrypt\$(\d{1,7})\$(\d{1,3})\$(\d{1,2})\$([A-Za-z0-9_-]{22,64})\$([A-Za-z0-9_-]{43})$/.exec(stored);
  if (!m) return null;
  const N = Number(m[1]);
  const r = Number(m[2]);
  const p = Number(m[3]);
  // N must be a power of two; bounds keep a corrupt row from asking for gigabytes.
  if (N < 1024 || N > MAX_N || (N & (N - 1)) !== 0 || r < 1 || r > 16 || p < 1 || p > 4) return null;
  return { params: { N, r, p }, salt: Buffer.from(m[4], "base64url"), key: Buffer.from(m[5], "base64url") };
}

/** Constant-time comparison. A malformed stored hash or an oversized candidate is simply "false". */
export async function verifyPassword(stored: string, candidate: string): Promise<boolean> {
  const parsed = parseHash(stored);
  if (!parsed || typeof candidate !== "string" || candidate.length > MAX_USER_PASSWORD_CHARS) return false;
  const given = await derive(candidate, parsed.salt, parsed.params);
  return given.length === parsed.key.length && timingSafeEqual(given, parsed.key);
}

let dummy: Promise<string> | undefined;
/** A valid hash of a random secret: checked for unknown emails so that they cost the same as known ones. */
export function dummyHash(): Promise<string> {
  return (dummy ??= hashPassword(randomBytes(24).toString("base64url")));
}
