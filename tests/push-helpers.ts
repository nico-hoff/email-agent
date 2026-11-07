// Shared by the push tests: a synthetic browser subscription (own key pair, so payloads can be decrypted again),
// a fake push transport and a fake-mail seeder. No network, no real keys.
import { createDecipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { generateVapidKeys } from "../packages/core/src/push-crypto.ts";
import type { PushTransport, TransportRequest, TransportResponse } from "../packages/core/src/push.ts";

export const SUBJECT_MARKER = "SUBJECT-MARKER-7391";
export const SENDER_MARKER = "sender-marker-7391@example.test";
export const BODY_MARKER = "BODY-MARKER-7391";

export function vapidEnv(subject = "mailto:ops@example.test"): Record<string, string> {
  const k = generateVapidKeys();
  return { VAPID_PUBLIC_KEY: k.publicKey, VAPID_PRIVATE_KEY: k.privateKey, VAPID_SUBJECT: subject };
}

export interface FakeDevice {
  endpoint: string;
  p256dh: string;
  auth: string;
  decrypt(body: Uint8Array): string;
}

let seq = 0;
export function fakeDevice(host = "web.push.apple.com"): FakeDevice {
  const ua = createECDH("prime256v1");
  ua.generateKeys();
  const auth = randomBytes(16);
  seq++;
  return {
    endpoint: `https://${host}/wpush/v2/synthetic-endpoint-${seq}-${randomBytes(6).toString("hex")}`,
    p256dh: ua.getPublicKey().toString("base64url"),
    auth: auth.toString("base64url"),
    decrypt(body) {
      const b = Buffer.from(body);
      const salt = b.subarray(0, 16);
      const asPublic = b.subarray(21, 86);
      const ikm = Buffer.from(hkdfSync("sha256", ua.computeSecret(asPublic), auth, Buffer.concat([Buffer.from("WebPush: info\0"), ua.getPublicKey(), asPublic]), 32));
      const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
      const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
      const rec = b.subarray(86);
      const d = createDecipheriv("aes-128-gcm", cek, nonce);
      d.setAuthTag(rec.subarray(rec.length - 16));
      const plain = Buffer.concat([d.update(rec.subarray(0, rec.length - 16)), d.final()]);
      return plain.subarray(0, plain.length - 1).toString("utf8");
    },
  };
}

export interface FakeTransport {
  transport: PushTransport;
  calls: TransportRequest[];
  /** Status per call; default 201. A function can throw to simulate a network error. */
  respond: (req: TransportRequest) => TransportResponse | Promise<TransportResponse>;
}

export function fakeTransport(respond?: FakeTransport["respond"]): FakeTransport {
  const f: FakeTransport = {
    calls: [],
    respond: respond ?? (() => ({ status: 201 })),
    transport: async (req) => {
      f.calls.push(req);
      return f.respond(req);
    },
  };
  return f;
}

/** Inserts a classified mail with answers; returns the email id. */
export function addMail(
  db: DatabaseSync,
  accountId: string,
  firstSeen: Date,
  o: { urgency?: number; route?: string; category?: string; seen?: boolean } = {},
): number {
  const ts = firstSeen.toISOString();
  const uid = 1000 + Math.floor(Math.random() * 1e6);
  const e = db.prepare("INSERT INTO emails (account_id, message_id, sender, subject, received_at, first_seen_at) VALUES (?,?,?,?,?,?)")
    .run(accountId, `<m${uid}-${seq++}@x>`, SENDER_MARKER, SUBJECT_MARKER, ts, ts);
  const emailId = Number(e.lastInsertRowid);
  db.prepare("INSERT INTO email_locations (email_id, account_id, folder, uid_validity, uid, first_seen_at, last_seen_at) VALUES (?,?,?,?,?,?,?)")
    .run(emailId, accountId, "INBOX", 5, uid, ts, ts);
  if (o.seen) db.prepare("INSERT INTO email_status (email_id, seen, done, updated_at) VALUES (?,?,?,?)").run(emailId, 1, 0, ts);
  const c = db.prepare("INSERT INTO classifications (email_id, question_set_version, model_requested, model_reported, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(emailId, "email-classification-v1", "typesafe/jev-1.13", "typesafe/jev-1.13", "classified", ts, ts);
  const cid = Number(c.lastInsertRowid);
  const ans = db.prepare("INSERT INTO classification_answers (classification_id, question_key, type, answer_json) VALUES (?,?,?,?)");
  ans.run(cid, "category", "choice", JSON.stringify({ value: o.category ?? "work" }));
  ans.run(cid, "route", "choice", JSON.stringify({ value: o.route ?? "ignore" }));
  ans.run(cid, "urgency", "score", JSON.stringify({ value: o.urgency ?? 0 }));
  return emailId;
}
