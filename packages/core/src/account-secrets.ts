// The only place that touches mailbox passwords at rest (ADR 0023, docs/accounts-contract.md).
// AES-256-GCM, a fresh random 12-byte nonce per encryption, AAD = "account_id|user_id" (a ciphertext copied to another
// account or user does not decrypt). Key: ACCOUNTS_ENCRYPTION_KEY (32 bytes, canonical base64). key_id = first 16 hex
// characters of SHA-256(key): it names a key without revealing it. ACCOUNTS_ENCRYPTION_KEY_OLD is decrypt-only (rotation).
// Nothing here logs, and error messages never contain secret material.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export const KEY_ENV = "ACCOUNTS_ENCRYPTION_KEY";
export const OLD_KEY_ENV = "ACCOUNTS_ENCRYPTION_KEY_OLD";
export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;
export const SECRET_MAX_CHARS = 1024;

interface Key { readonly id: string; readonly bytes: Buffer }
export interface Keyring { readonly current: Key; readonly old: Key | null }
export type KeyringResult = { ok: true; keyring: Keyring } | { ok: false; code: "no_encryption_key" };

export interface SealedSecret { ciphertext: Buffer; nonce: Buffer; tag: Buffer; keyId: string }
export interface SecretOwner { accountId: string; userId: number }

export class SecretError extends Error {
  readonly code: "unknown_key_id" | "decrypt_failed" | "invalid_secret";
  constructor(code: SecretError["code"]) {
    super(code);
    this.name = "SecretError";
    this.code = code;
  }
}

/** Strict: exactly the canonical base64 of 32 bytes (44 characters, one "="), no whitespace, no other alphabet. */
function parseKey(raw: string | undefined): Key | null {
  if (raw === undefined || !/^[A-Za-z0-9+/]{43}=$/.test(raw)) return null;
  const bytes = Buffer.from(raw, "base64");
  if (bytes.length !== 32 || bytes.toString("base64") !== raw) return null;
  return { id: createHash("sha256").update(bytes).digest("hex").slice(0, 16), bytes };
}

/** Missing or malformed key (current, or old when set) = fail-closed: callers refuse to use or change secrets. */
export function loadKeyring(env: Record<string, string | undefined>): KeyringResult {
  const current = parseKey(env.ACCOUNTS_ENCRYPTION_KEY);
  if (current === null) return { ok: false, code: "no_encryption_key" };
  const oldRaw = env.ACCOUNTS_ENCRYPTION_KEY_OLD;
  if (oldRaw === undefined || oldRaw === "") return { ok: true, keyring: { current, old: null } };
  const old = parseKey(oldRaw);
  if (old === null) return { ok: false, code: "no_encryption_key" };
  return { ok: true, keyring: { current, old: old.id === current.id ? null : old } };
}

/** For tests and `openssl rand -base64 32` documentation: a fresh random key in the accepted format. */
export function generateKey(): string {
  return randomBytes(32).toString("base64");
}

const aad = (o: SecretOwner): Buffer => Buffer.from(`${o.accountId}|${o.userId}`, "utf8");

/** Passwords: 1..1024 characters, no control characters (they would break the IMAP login command). */
export function isValidSecret(plain: string): boolean {
  return plain.length >= 1 && plain.length <= SECRET_MAX_CHARS && !/[\u0000-\u001f\u007f]/.test(plain);
}

export function sealSecret(ring: Keyring, owner: SecretOwner, plain: string): SealedSecret {
  if (!isValidSecret(plain)) throw new SecretError("invalid_secret");
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", ring.current.bytes, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad(owner));
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return { ciphertext, nonce, tag: cipher.getAuthTag(), keyId: ring.current.id };
}

export function openSecret(ring: Keyring, owner: SecretOwner, sealed: SealedSecret): string {
  const key = sealed.keyId === ring.current.id ? ring.current : ring.old !== null && sealed.keyId === ring.old.id ? ring.old : null;
  if (key === null) throw new SecretError("unknown_key_id");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key.bytes, sealed.nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad(owner));
    decipher.setAuthTag(sealed.tag);
    return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new SecretError("decrypt_failed");
  }
}

/** Re-encrypts with the current key (same owner AAD, fresh nonce). Used by `npm run accounts:rekey`. */
export function resealSecret(ring: Keyring, owner: SecretOwner, sealed: SealedSecret): SealedSecret {
  return sealSecret(ring, owner, openSecret(ring, owner, sealed));
}
