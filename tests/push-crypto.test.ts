import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createDecipheriv, createECDH, hkdfSync } from "node:crypto";
import {
  b64urlDecode, createVapidJwt, encryptPayload, generateVapidKeys, vapidAuthorization, vapidKeysMatch, verifyVapidJwt,
} from "../packages/core/src/push-crypto.ts";

// RFC 8291 appendix A.
const RFC = {
  plaintext: "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  header: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  ciphertext: "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrd" + "irN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ",
};

describe("encryptPayload", () => {
  test("matches the RFC 8291 appendix A vector byte for byte", () => {
    const body = encryptPayload(b64urlDecode(RFC.plaintext)!, RFC.uaPublic, RFC.auth, {
      salt: b64urlDecode(RFC.salt)!, asPrivateKey: b64urlDecode(RFC.asPrivate)!,
    });
    // the two RFC strings are encoded separately (86 bytes is not a multiple of 3): compare bytes
    assert.equal(body.toString("hex"), Buffer.concat([b64urlDecode(RFC.header)!, b64urlDecode(RFC.ciphertext)!]).toString("hex"));
    assert.equal(body.length, 86 + 16 + 1 + b64urlDecode(RFC.plaintext)!.length);
  });

  test("a random message decrypts on the receiver side (round trip with a user agent key pair)", () => {
    const ua = createECDH("prime256v1");
    ua.generateKeys();
    const auth = Buffer.alloc(16, 7);
    const msg = JSON.stringify({ v: 1, kind: "important_mail", count: 2 });
    const body = encryptPayload(Buffer.from(msg), ua.getPublicKey().toString("base64url"), auth.toString("base64url"));
    const salt = body.subarray(0, 16);
    assert.equal(body.readUInt32BE(16), 4096);
    assert.equal(body[20], 65);
    const asPublic = body.subarray(21, 86);
    const shared = ua.computeSecret(asPublic);
    const ikm = Buffer.from(hkdfSync("sha256", shared, auth, Buffer.concat([Buffer.from("WebPush: info\0"), ua.getPublicKey(), asPublic]), 32));
    const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
    const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
    const record = body.subarray(86);
    const d = createDecipheriv("aes-128-gcm", cek, nonce);
    d.setAuthTag(record.subarray(record.length - 16));
    const plain = Buffer.concat([d.update(record.subarray(0, record.length - 16)), d.final()]);
    assert.equal(plain.at(-1), 2);
    assert.equal(plain.subarray(0, -1).toString(), msg);
  });

  test("two encryptions of the same message differ (fresh key and salt)", () => {
    const a = encryptPayload(Buffer.from("x"), RFC.uaPublic, RFC.auth);
    const b = encryptPayload(Buffer.from("x"), RFC.uaPublic, RFC.auth);
    assert.notEqual(a.toString("hex"), b.toString("hex"));
  });

  test("rejects bad keys and oversized messages", () => {
    assert.throws(() => encryptPayload(Buffer.from("x"), "AAAA", RFC.auth), /invalid_subscription_key/);
    assert.throws(() => encryptPayload(Buffer.from("x"), RFC.uaPublic, "AAAA"), /invalid_subscription_key/);
    assert.throws(() => encryptPayload(Buffer.alloc(4000), RFC.uaPublic, RFC.auth), /payload_too_large/);
  });
});

describe("VAPID", () => {
  test("generated keys have the documented sizes and match each other", () => {
    const k = generateVapidKeys();
    assert.equal(b64urlDecode(k.publicKey)!.length, 65);
    assert.equal(b64urlDecode(k.privateKey)!.length, 32);
    assert.ok(vapidKeysMatch(k.publicKey, k.privateKey));
    assert.ok(!vapidKeysMatch(k.publicKey, generateVapidKeys().privateKey));
    assert.ok(!vapidKeysMatch("x", "y"));
  });

  test("every generated private key is exactly 32 bytes (leading zero bytes are kept)", () => {
    for (let i = 0; i < 1500; i++) assert.equal(b64urlDecode(generateVapidKeys().privateKey)!.length, 32);
  });

  test("the JWT is ES256 with aud, exp (<= 24 h) and sub, and verifies with the public key only", () => {
    const k = generateVapidKeys();
    const now = Date.UTC(2026, 9, 31, 12);
    const jwt = createVapidJwt("https://push.example.test", { ...k, subject: "mailto:ops@example.test" }, now);
    const [h] = jwt.split(".");
    assert.deepEqual(JSON.parse(Buffer.from(h!, "base64url").toString()), { typ: "JWT", alg: "ES256" });
    const v = verifyVapidJwt(jwt, k.publicKey);
    assert.ok(v.ok);
    assert.equal(v.claims?.aud, "https://push.example.test");
    assert.equal(v.claims?.sub, "mailto:ops@example.test");
    const exp = Number(v.claims?.exp);
    assert.ok(exp > now / 1000 && exp - now / 1000 <= 24 * 3600);
    assert.ok(!verifyVapidJwt(jwt, generateVapidKeys().publicKey).ok);
  });

  test("authorization header carries the origin as audience and the public key", () => {
    const k = generateVapidKeys();
    const h = vapidAuthorization("https://web.push.apple.com/abc/def?x=1", { ...k, subject: "mailto:a@b.test" }, Date.now());
    assert.match(h, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]{87}$/);
    const jwt = /t=([^,]+),/.exec(h)![1]!;
    assert.equal(verifyVapidJwt(jwt, k.publicKey).claims?.aud, "https://web.push.apple.com");
  });
});
