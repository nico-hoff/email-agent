// Web Push cryptography with node:crypto only (ADR 0036): message encryption (RFC 8291, aes128gcm of RFC 8188) and the
// VAPID JWT (RFC 8292, ES256). No dependency: the encryption is verified against the RFC 8291 appendix A test vector
// (tests/push-crypto.test.ts). Pure functions, no I/O, no logging. Keys and secrets never leave these functions in text.
import { createCipheriv, createECDH, createPrivateKey, createPublicKey, hkdfSync, randomBytes, sign, verify } from "node:crypto";

export const B64URL = /^[A-Za-z0-9_-]+$/;
export const VAPID_PUBLIC_BYTES = 65;
export const VAPID_PRIVATE_BYTES = 32;
export const P256DH_BYTES = 65;
export const AUTH_SECRET_BYTES = 16;
/** Record size announced in the aes128gcm header. One record holds the whole (tiny) message. */
export const RECORD_SIZE = 4096;
/** Push services accept at most 4096 bytes in total; the header is 86 bytes and the tag 16. */
export const PLAINTEXT_MAX_BYTES = 3993;

export const b64urlEncode = (b: Uint8Array): string => Buffer.from(b).toString("base64url");

/** Strict base64url (no padding, no standard alphabet) to bytes, or null. */
export function b64urlDecode(value: string): Buffer | null {
  if (!B64URL.test(value)) return null;
  const b = Buffer.from(value, "base64url");
  return b64urlEncode(b) === value ? b : null;
}

export interface VapidKeys { publicKey: string; privateKey: string }

/** A new VAPID key pair as base64url (public 65 bytes uncompressed point, private 32 bytes). For `npm run push:keys`. */
export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { publicKey: b64urlEncode(ecdh.getPublicKey()), privateKey: b64urlEncode(ecdh.getPrivateKey()) };
}

/** True when the private key belongs to the public key (the derived point is compared). */
export function vapidKeysMatch(publicKey: string, privateKey: string): boolean {
  const pub = b64urlDecode(publicKey);
  const priv = b64urlDecode(privateKey);
  if (pub?.length !== VAPID_PUBLIC_BYTES || priv?.length !== VAPID_PRIVATE_BYTES || pub[0] !== 4) return false;
  try {
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(priv);
    return ecdh.getPublicKey().equals(pub);
  } catch {
    return false;
  }
}

export interface EncryptOptions {
  /** Test seam (RFC vector). Default: random. */
  salt?: Uint8Array;
  /** Test seam (RFC vector): the application server's ephemeral private key. Default: a fresh key pair. */
  asPrivateKey?: Uint8Array;
}

/**
 * RFC 8291 section 3.4 + RFC 8188: returns the request body (header with salt, record size, key id = application server
 * public key, followed by the single encrypted record). `p256dh` and `auth` are the subscription's base64url keys.
 */
export function encryptPayload(plaintext: Uint8Array, p256dh: string, auth: string, o: EncryptOptions = {}): Buffer {
  const uaPublic = b64urlDecode(p256dh);
  const authSecret = b64urlDecode(auth);
  if (uaPublic?.length !== P256DH_BYTES || uaPublic[0] !== 4) throw new Error("invalid_subscription_key");
  if (authSecret?.length !== AUTH_SECRET_BYTES) throw new Error("invalid_subscription_key");
  if (plaintext.length > PLAINTEXT_MAX_BYTES) throw new Error("payload_too_large");
  const salt = o.salt ? Buffer.from(o.salt) : randomBytes(16);
  if (salt.length !== 16) throw new Error("invalid_salt");

  const ecdh = createECDH("prime256v1");
  if (o.asPrivateKey) ecdh.setPrivateKey(Buffer.from(o.asPrivateKey));
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);

  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0", "latin1"), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0", "latin1"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0", "latin1"), 12));

  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  // 0x02 is the padding delimiter of the last (here: only) record.
  const record = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, record]);
}

export interface VapidSigner {
  publicKey: string;
  privateKey: string;
  subject: string;
}

const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

/** RFC 8292: JWT {aud, exp, sub} signed ES256 (IEEE P1363 r||s). `exp` is at most 24 h ahead; we use 12 h. */
export function createVapidJwt(audience: string, v: VapidSigner, nowMs: number): string {
  const pub = b64urlDecode(v.publicKey);
  if (pub?.length !== VAPID_PUBLIC_BYTES) throw new Error("invalid_vapid_key");
  const key = createPrivateKey({
    key: { kty: "EC", crv: "P-256", x: b64urlEncode(pub.subarray(1, 33)), y: b64urlEncode(pub.subarray(33, 65)), d: v.privateKey },
    format: "jwk",
  });
  const data = `${enc({ typ: "JWT", alg: "ES256" })}.${enc({ aud: audience, exp: Math.floor(nowMs / 1000) + 12 * 3600, sub: v.subject })}`;
  return `${data}.${sign("sha256", Buffer.from(data), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}

/** Authorization header value for the aes128gcm era: `vapid t=<jwt>, k=<public key>`. */
export function vapidAuthorization(endpoint: string, v: VapidSigner, nowMs: number): string {
  return `vapid t=${createVapidJwt(new URL(endpoint).origin, v, nowMs)}, k=${v.publicKey}`;
}

/** Test helper: verifies a JWT signature against a VAPID public key. */
export function verifyVapidJwt(jwt: string, publicKey: string): { ok: boolean; claims: Record<string, unknown> | null } {
  const parts = jwt.split(".");
  const pub = b64urlDecode(publicKey);
  if (parts.length !== 3 || pub?.length !== VAPID_PUBLIC_BYTES) return { ok: false, claims: null };
  const key = createPublicKey({
    key: { kty: "EC", crv: "P-256", x: b64urlEncode(pub.subarray(1, 33)), y: b64urlEncode(pub.subarray(33, 65)) },
    format: "jwk",
  });
  const ok = verify("sha256", Buffer.from(`${parts[0]}.${parts[1]}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(parts[2] ?? "", "base64url"));
  try {
    return { ok, claims: JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown> };
  } catch {
    return { ok: false, claims: null };
  }
}
