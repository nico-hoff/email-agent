import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateKey, loadKeyring, openSecret, resealSecret, SecretError, sealSecret, type Keyring } from "../lib/account-secrets.ts";

const ring = (env: Record<string, string>): Keyring => {
  const r = loadKeyring(env);
  assert.ok(r.ok);
  return r.keyring;
};
const OWNER = { accountId: "a_0123456789abcdef", userId: 3 };
const PW = "synthetic-app-password-1";

describe("key validation", () => {
  it("accepts exactly 32 bytes of canonical base64", () => {
    assert.equal(loadKeyring({ ACCOUNTS_ENCRYPTION_KEY: generateKey() }).ok, true);
  });
  it("rejects missing, empty, short, long, non-canonical and padded-with-whitespace keys", () => {
    const k = generateKey();
    for (const bad of [undefined, "", "abc", Buffer.alloc(31).toString("base64"), Buffer.alloc(33).toString("base64"), ` ${k}`, `${k}\n`, k.slice(0, 43), k.replace("=", "A"), "!".repeat(44), "-".repeat(43) + "="]) {
      assert.deepEqual(loadKeyring({ ACCOUNTS_ENCRYPTION_KEY: bad }), { ok: false, code: "no_encryption_key" }, String(bad).length + "");
    }
  });
  it("an invalid OLD key fails closed too; an empty one is ignored; the same key as old is dropped", () => {
    const k = generateKey();
    assert.equal(loadKeyring({ ACCOUNTS_ENCRYPTION_KEY: k, ACCOUNTS_ENCRYPTION_KEY_OLD: "nope" }).ok, false);
    assert.equal(loadKeyring({ ACCOUNTS_ENCRYPTION_KEY: k, ACCOUNTS_ENCRYPTION_KEY_OLD: "" }).ok, true);
    const same = loadKeyring({ ACCOUNTS_ENCRYPTION_KEY: k, ACCOUNTS_ENCRYPTION_KEY_OLD: k });
    assert.ok(same.ok && same.keyring.old === null);
  });
  it("key_id is 16 hex characters and differs per key", () => {
    const a = ring({ ACCOUNTS_ENCRYPTION_KEY: generateKey() });
    const b = ring({ ACCOUNTS_ENCRYPTION_KEY: generateKey() });
    assert.match(a.current.id, /^[0-9a-f]{16}$/);
    assert.notEqual(a.current.id, b.current.id);
  });
});

describe("AES-256-GCM", () => {
  const env = { ACCOUNTS_ENCRYPTION_KEY: generateKey() };

  it("round trip incl. unicode; fresh nonce each time; ciphertext does not contain the plaintext", () => {
    const r = ring(env);
    const a = sealSecret(r, OWNER, PW);
    const b = sealSecret(r, OWNER, PW);
    assert.equal(a.nonce.length, 12);
    assert.equal(a.tag.length, 16);
    assert.notDeepEqual(a.nonce, b.nonce);
    assert.notDeepEqual(a.ciphertext, b.ciphertext);
    assert.ok(!a.ciphertext.toString("latin1").includes(PW));
    assert.equal(openSecret(r, OWNER, a), PW);
    assert.equal(openSecret(r, OWNER, sealSecret(r, OWNER, "pässwörd ✓ 日本")), "pässwörd ✓ 日本");
  });
  it("wrong key fails: unknown key id", () => {
    const sealed = sealSecret(ring(env), OWNER, PW);
    assert.throws(() => openSecret(ring({ ACCOUNTS_ENCRYPTION_KEY: generateKey() }), OWNER, sealed), (e) => e instanceof SecretError && e.code === "unknown_key_id");
  });
  it("a tampered tag, ciphertext or nonce fails", () => {
    const r = ring(env);
    const s = sealSecret(r, OWNER, PW);
    const flip = (b: Buffer) => { const c = Buffer.from(b); c[0] = (c[0] ?? 0) ^ 1; return c; };
    for (const bad of [{ ...s, tag: flip(s.tag) }, { ...s, ciphertext: flip(s.ciphertext) }, { ...s, nonce: flip(s.nonce) }]) {
      assert.throws(() => openSecret(r, OWNER, bad), (e) => e instanceof SecretError && e.code === "decrypt_failed");
    }
  });
  it("wrong AAD fails: another account or another user cannot use the ciphertext", () => {
    const r = ring(env);
    const s = sealSecret(r, OWNER, PW);
    assert.throws(() => openSecret(r, { ...OWNER, accountId: "a_ffffffffffffffff" }, s), SecretError);
    assert.throws(() => openSecret(r, { ...OWNER, userId: 4 }, s), SecretError);
  });
  it("rejects empty, control-character and oversized secrets", () => {
    const r = ring(env);
    for (const bad of ["", "a\nb", "a\u0000b", "x".repeat(1025)]) {
      assert.throws(() => sealSecret(r, OWNER, bad), (e) => e instanceof SecretError && e.code === "invalid_secret");
    }
    assert.equal(openSecret(r, OWNER, sealSecret(r, OWNER, "x".repeat(1024))).length, 1024);
  });
  it("errors never contain the secret or key material", () => {
    const k = generateKey();
    const s = sealSecret(ring({ ACCOUNTS_ENCRYPTION_KEY: k }), OWNER, PW);
    try {
      openSecret(ring({ ACCOUNTS_ENCRYPTION_KEY: generateKey() }), OWNER, s);
      assert.fail();
    } catch (e) {
      assert.ok(!String((e as Error).message + (e as Error).stack).includes(PW));
      assert.ok(!String((e as Error).stack).includes(k));
    }
  });
});

describe("rotation", () => {
  it("the old key still decrypts (decrypt-only); reseal moves the secret to the current key", () => {
    const oldKey = generateKey();
    const newKey = generateKey();
    const sealedOld = sealSecret(ring({ ACCOUNTS_ENCRYPTION_KEY: oldKey }), OWNER, PW);
    const rotating = ring({ ACCOUNTS_ENCRYPTION_KEY: newKey, ACCOUNTS_ENCRYPTION_KEY_OLD: oldKey });
    assert.equal(openSecret(rotating, OWNER, sealedOld), PW);
    const moved = resealSecret(rotating, OWNER, sealedOld);
    assert.equal(moved.keyId, rotating.current.id);
    assert.notEqual(moved.keyId, sealedOld.keyId);
    // afterwards the new key alone is enough, the old one alone is not
    assert.equal(openSecret(ring({ ACCOUNTS_ENCRYPTION_KEY: newKey }), OWNER, moved), PW);
    assert.throws(() => openSecret(ring({ ACCOUNTS_ENCRYPTION_KEY: oldKey }), OWNER, moved), SecretError);
  });
  it("without the old key a secret under the old key is unreadable", () => {
    const oldKey = generateKey();
    const sealedOld = sealSecret(ring({ ACCOUNTS_ENCRYPTION_KEY: oldKey }), OWNER, PW);
    assert.throws(() => openSecret(ring({ ACCOUNTS_ENCRYPTION_KEY: generateKey() }), OWNER, sealedOld), SecretError);
  });
});
