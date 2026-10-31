import { randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";
import { MIN_PASSWORD_CHARS } from "./auth.ts";

/**
 * Password check for the public (password) mode. The plaintext is derived with scrypt once at construction and then
 * dropped; a candidate is derived with the same process-wide random salt and compared with timingSafeEqual. Nothing
 * here is logged, returned or persisted.
 */

const KEY_BYTES = 32;
const MAX_CANDIDATE_CHARS = 1024;

export interface PasswordVerifier {
  /** False for an unset or too short password: such a verifier accepts nothing (fail-closed). */
  readonly configured: boolean;
  verify(candidate: string): Promise<boolean>;
}

function derive(secret: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(secret, salt, KEY_BYTES, (err, key) => (err ? reject(err) : resolve(key))));
}

export function createPasswordVerifier(password: string | undefined): PasswordVerifier {
  const salt = randomBytes(16);
  const configured = password !== undefined && password.length >= MIN_PASSWORD_CHARS;
  // Unconfigured: compare against random bytes nobody knows, so even this path costs the same.
  const expected = configured ? scryptSync(password, salt, KEY_BYTES) : randomBytes(KEY_BYTES);
  return {
    configured,
    async verify(candidate) {
      const oversized = typeof candidate !== "string" || candidate.length > MAX_CANDIDATE_CHARS;
      const given = await derive(oversized ? "" : candidate, salt);
      const equal = timingSafeEqual(given, expected);
      return configured && !oversized && equal;
    },
  };
}
