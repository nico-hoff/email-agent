import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../lib/db.ts";
import { syncAccounts } from "../lib/accounts.ts";
import { ingestMail } from "../lib/ingest.ts";
import type { MessageMeta, TransientInput } from "../lib/imap.ts";
import type { JevCallResult } from "../lib/jev.ts";
import { createClassificationPipeline, createPersistResponse } from "../lib/classification-pipeline.ts";
import { buildState } from "../lib/jev-questions.ts";
import { FREEMAIL_DOMAINS, senderCounts, splitSender } from "../lib/senders.ts";

const T0 = new Date("2026-10-27T12:00:00.000Z");
const clock = { now: () => T0, setInterval: () => 0, clearInterval: () => {} };

function db0(): DatabaseSync {
  const db = openDatabase(":memory:");
  syncAccounts(db, [{
    id: "a", label: "a", context: "c", host: "h", port: 993, tls: true, user: "u", password: "p",
    mailbox: "INBOX", spam_mailbox: "Junk", spam_threshold: 0.9, enabled: true,
  } as never]);
  return db;
}
const meta = (messageId: string | null, over: Partial<MessageMeta> = {}): MessageMeta => ({
  messageId, sender: "s@example.test", subject: "SUBJECT-MARKER", receivedAt: "2026-10-27T10:00:00.000Z",
  spf: "pass", dkim: "pass", dmarc: "pass", listUnsubscribePresent: false, replyToDiffersFromFrom: false, ...over,
});
const ing = (db: DatabaseSync, m: MessageMeta, uid: number, folder = "INBOX", uv = 1) =>
  ingestMail(db, { accountId: "a", meta: m, loc: { folder, uid, uidValidity: uv }, now: T0, traceId: "t" });
const rows = (db: DatabaseSync, sql: string) => db.prepare(sql).all().map((r) => ({ ...r })) as Record<string, unknown>[];

describe("splitSender", () => {
  test("lower-cases, splits at the last @, rejects anything that is not an address", () => {
    assert.deepEqual(splitSender("Info@Shop.Example.TEST"), { address: "info@shop.example.test", domain: "shop.example.test" });
    assert.deepEqual(splitSender(" a@b.test "), { address: "a@b.test", domain: "b.test" });
    for (const bad of ["", "nobody", "@x.test", "a@", "a b@x.test", "a@x .test", "a@b@c.test"]) {
      assert.equal(splitSender(bad), null, bad);
    }
    assert.equal(splitSender("x".repeat(300) + "@a.test"), null);
  });
});

describe("FREEMAIL_DOMAINS", () => {
  test("lists the common free mail providers in lower case", () => {
    for (const d of ["gmail.com", "web.de", "gmx.de", "gmx.net", "outlook.com", "icloud.com", "hotmail.com", "yahoo.com", "t-online.de", "freenet.de", "proton.me"]) {
      assert.ok(FREEMAIL_DOMAINS.includes(d), d);
    }
    for (const d of FREEMAIL_DOMAINS) assert.equal(d, d.toLowerCase());
    assert.equal(new Set(FREEMAIL_DOMAINS).size, FREEMAIL_DOMAINS.length);
  });
});

describe("ingest keeps the senders table", () => {
  test("a new mail creates the sender with domain, timestamps, mails_seen and the DMARC pass counter", () => {
    const db = db0();
    ing(db, meta("<m1>", { sender: "Info@Shop.TEST" }), 1);
    assert.deepEqual(rows(db, "SELECT address,domain,first_seen_at,last_seen_at,mails_seen,dmarc_pass,jev_spam_count,marked_spam,marked_not_spam FROM senders"), [
      { address: "info@shop.test", domain: "shop.test", first_seen_at: T0.toISOString(), last_seen_at: T0.toISOString(),
        mails_seen: 1, dmarc_pass: 1, jev_spam_count: 0, marked_spam: 0, marked_not_spam: 0 },
    ]);
  });

  test("only new mails count: same location again, a folder move and a stub do not", () => {
    const db = db0();
    ing(db, meta("<m1>"), 1);
    ing(db, meta("<m1>"), 1);
    ing(db, meta("<m1>"), 2, "Junk", 9);
    assert.equal(senderCounts(db, 1, "s@example.test")?.mails_seen, 1);
    ing(db, meta("<m2>", { dmarc: "fail" }), 2);
    ing(db, meta(null, { dmarc: "none" }), 3);
    assert.deepEqual(rows(db, "SELECT mails_seen,dmarc_pass FROM senders"), [{ mails_seen: 3, dmarc_pass: 1 }]);
  });

  test("last_seen_at moves forward, first_seen_at stays", () => {
    const db = db0();
    ing(db, meta("<m1>"), 1);
    const later = new Date("2026-10-28T08:00:00.000Z");
    ingestMail(db, { accountId: "a", meta: meta("<m2>"), loc: { folder: "INBOX", uid: 2, uidValidity: 1 }, now: later, traceId: "t" });
    assert.deepEqual(rows(db, "SELECT first_seen_at,last_seen_at FROM senders"), [{ first_seen_at: T0.toISOString(), last_seen_at: later.toISOString() }]);
  });

  test("a sender that is not an address creates no row and does not break ingest", () => {
    const db = db0();
    assert.equal(ing(db, meta("<m1>", { sender: "unknown" }), 1).isNew, true);
    assert.equal(rows(db, "SELECT * FROM senders").length, 0);
  });

  test("senders holds no subject or other content", () => {
    const db = db0();
    ing(db, meta("<m1>"), 1);
    assert.ok(!JSON.stringify(rows(db, "SELECT * FROM senders")).includes("SUBJECT-MARKER"));
  });
});

const fixture = () => JSON.parse(readFileSync(new URL("./fixtures/jev-email-v1-response.json", import.meta.url), "utf8"));
const answersWith = (isSpam: number) => {
  const f = fixture();
  return { ...f.answers, is_spam: { type: "noul", noul: isSpam } };
};
const ok = (answers: unknown): JevCallResult => ({ ok: true, response: { ...fixture(), answers, model: "typesafe/jev-1.13-r" } as never });

function pipelineWith(db: DatabaseSync, results: JevCallResult[]) {
  const requests: { state: Record<string, unknown> }[] = [];
  const pipeline = createClassificationPipeline({
    db,
    jev: { classify: async (req: never) => { requests.push(req); return results.shift()!; } } as never,
    portFactory: () => { throw new Error("no refetch expected"); },
    clock,
    persistResponse: createPersistResponse(() => 0.9),
  });
  return { pipeline, requests };
}
const inputFor = (m: MessageMeta): TransientInput => ({ ...m, excerpt: "EXCERPT-MARKER" });

describe("jev_spam_count", () => {
  test("a positive is_spam (calibrated threshold) counts once for the sender; a negative one does not", async () => {
    const db = db0();
    const { pipeline } = pipelineWith(db, [ok(answersWith(0.9)), ok(answersWith(0.3)), ok(answersWith(0.8))]);
    for (const [i, id] of ["<m1>", "<m2>", "<m3>"].entries()) {
      const m = meta(id);
      const { emailId } = ing(db, m, i + 1);
      await pipeline.submit({ emailId, accountId: "a", input: inputFor(m) });
    }
    assert.deepEqual(rows(db, "SELECT mails_seen,jev_spam_count FROM senders"), [{ mails_seen: 3, jev_spam_count: 2 }]); // 0.9 and 0.8 (>= 0.80)
  });

  test("a re-classification of the same mail does not count again", async () => {
    const db = db0();
    const m = meta("<m1>");
    const { emailId } = ing(db, m, 1);
    const { pipeline } = pipelineWith(db, [ok(answersWith(0.95))]);
    await pipeline.submit({ emailId, accountId: "a", input: inputFor(m) });
    // a later run of another question set on the same mail
    db.prepare(`INSERT INTO classifications (email_id, question_set_version, model_requested, model_reported, status, attempts, created_at, updated_at)
      VALUES (?, 'email-classification-v1', 'typesafe/jev-1.13', 'x', 'pending', 0, ?, ?)`).run(emailId, T0.toISOString(), T0.toISOString());
    assert.equal(senderCounts(db, 1, "s@example.test")?.jev_spam_count, 1);
    db.prepare("UPDATE classifications SET status = 'classified' WHERE question_set_version = 'email-classification-v1'").run();
    const row = db.prepare("SELECT id FROM classifications WHERE question_set_version = 'email-classification-v1'").get() as { id: number };
    const persist = createPersistResponse(() => 0.9);
    // v2 is never persisted by the pipeline today; the guard still has to hold if it was
    db.exec("BEGIN");
    persist({ db, classificationId: row.id, emailId, accountId: "a", response: { ...fixture(), answers: answersWith(0.99) } as never, latencyMs: 0, attempts: 1, traceId: "t", now: T0 });
    db.exec("COMMIT");
    assert.equal(senderCounts(db, 1, "s@example.test")?.jev_spam_count, 1);
  });

  test("a rejected response rolls the count back with the transaction", async () => {
    const db = db0();
    const m = meta("<m1>");
    const { emailId } = ing(db, m, 1);
    const bad = { ...answersWith(0.99), category: { type: "choice", choice: "nonsense" } };
    const { pipeline } = pipelineWith(db, [ok(bad)]);
    await pipeline.submit({ emailId, accountId: "a", input: inputFor(m) });
    assert.equal(senderCounts(db, 1, "s@example.test")?.jev_spam_count, 0);
  });
});

describe("T55: feedback counters in the Jev state", () => {
  async function stateFor(db: DatabaseSync, m: MessageMeta) {
    const { emailId } = ing(db, m, 90 + Math.floor(Math.random() * 1000));
    const { pipeline, requests } = pipelineWith(db, [ok(answersWith(0.1))]);
    await pipeline.submit({ emailId, accountId: "a", input: inputFor(m) });
    return requests[0].state;
  }

  test("DMARC pass and counters above zero: sender_history carries two numbers and nothing else", async () => {
    const db = db0();
    ing(db, meta("<old>"), 1);
    db.prepare("UPDATE senders SET marked_spam = 3, marked_not_spam = 1").run();
    const state = await stateFor(db, meta("<new>"));
    assert.deepEqual(state.sender_history, { user_marked_spam: 3, user_marked_not_spam: 1 });
  });

  test("DMARC not pass: the key is left out entirely", async () => {
    for (const dmarc of ["fail", "none", "softfail", "neutral", "temperror", "permerror", "unknown"] as const) {
      const db = db0();
      ing(db, meta("<old>"), 1);
      db.prepare("UPDATE senders SET marked_spam = 3").run();
      const state = await stateFor(db, meta("<new>", { dmarc }));
      assert.ok(!("sender_history" in state), dmarc);
    }
  });

  test("no feedback yet (both zero) or an unknown sender: the key is left out", async () => {
    const db = db0();
    assert.ok(!("sender_history" in (await stateFor(db, meta("<a>")))));
    assert.ok(!("sender_history" in (await stateFor(db, meta("<b>", { sender: "nobody" })))));
  });

  test("buildState accepts the two new keys as finite numbers only and keeps the old ones", () => {
    const hist = { mails_seen_from_sender: 4, days_since_first_seen: 2, user_marked_spam: 1, user_marked_not_spam: 0 };
    assert.deepEqual(buildState({ dmarc: "pass", sender_history: hist }), { dmarc: "pass", sender_history: hist });
    // without DMARC pass the two feedback counters are dropped, the old keys stay; nothing left = no key
    assert.deepEqual(buildState({ dmarc: "fail", sender_history: hist }), { dmarc: "fail", sender_history: { mails_seen_from_sender: 4, days_since_first_seen: 2 } });
    assert.deepEqual(buildState({ sender_history: { user_marked_spam: 2, user_marked_not_spam: 1 } }), {});
    assert.throws(() => buildState({ sender_history: { user_marked_spam: "3" } as never }), /sender_history value invalid/);
    assert.throws(() => buildState({ sender_history: { user_marked_spam: Number.NaN } }), /sender_history value invalid/);
    assert.throws(() => buildState({ sender_history: { user_marked_junk: 1 } as never }), /sender_history key not allowed/);
    assert.throws(() => buildState({ sender_history: { sender_address: 1 } as never }), /sender_history key not allowed/);
  });
});
