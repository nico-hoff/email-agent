import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../lib/db.ts";
import { syncAccounts } from "../lib/accounts.ts";
import { ingestMail } from "../lib/ingest.ts";
import type { MessageMeta } from "../lib/imap.ts";
import { CATEGORY_OPTIONS, FEEDBACK_KINDS, feedbackState, recordFeedback } from "../lib/feedback.ts";
import { senderCounts } from "../lib/senders.ts";
import { QUESTIONS } from "../lib/jev-questions.ts";

const T = "2026-10-27T12:00:00.000Z";
const T2 = "2026-10-27T13:00:00.000Z";

function setup() {
  const db = openDatabase(":memory:");
  syncAccounts(db, [{
    id: "a", label: "a", context: "c", host: "h", port: 993, tls: true, user: "u", password: "p",
    mailbox: "INBOX", spam_threshold: 0.9, enabled: true,
  } as never]);
  let uid = 0;
  const add = (sender: string) => {
    const m: MessageMeta = {
      messageId: `<m${++uid}>`, sender, subject: "SUBJECT-MARKER", receivedAt: T,
      spf: "pass", dkim: "pass", dmarc: "pass", listUnsubscribePresent: false, replyToDiffersFromFrom: false,
    };
    return ingestMail(db, { accountId: "a", meta: m, loc: { folder: "INBOX", uid, uidValidity: 1 }, now: new Date(T), traceId: "t" }).emailId;
  };
  return { db, add };
}
const fbRows = (db: DatabaseSync) => db.prepare("SELECT email_id, classification_id, kind, value_json, actor, created_at FROM feedback ORDER BY id").all().map((r) => ({ ...r }));
const audits = (db: DatabaseSync) => db.prepare("SELECT actor, action, account_id, email_id, details_json FROM audit_log WHERE action = 'feedback_recorded' ORDER BY id").all().map((r) => ({ ...r }));

describe("feedback kinds", () => {
  test("the five kinds of T37 and the category options come from the question set", () => {
    assert.deepEqual([...FEEDBACK_KINDS], ["spam_correct", "not_spam", "category_wrong", "reply_needed", "no_reply_needed"]);
    const cat = QUESTIONS.category;
    assert.equal(cat.type, "choice");
    assert.deepEqual([...CATEGORY_OPTIONS], Object.keys((cat as { criteria: Record<string, string> }).criteria));
    assert.ok(CATEGORY_OPTIONS.includes("business"));
  });
});

describe("recordFeedback", () => {
  test("spam_correct stores a row with actor nico, counts for the sender, audits ids and codes only", () => {
    const { db, add } = setup();
    const id = add("s@x.test");
    const r = recordFeedback(db, { emailId: id, kind: "spam_correct", ts: T });
    assert.ok(r.ok && r.changed);
    assert.deepEqual(fbRows(db), [{ email_id: id, classification_id: null, kind: "spam_correct", value_json: "{}", actor: "nico", created_at: T }]);
    assert.equal(senderCounts(db, "s@x.test")?.marked_spam, 1);
    const a = audits(db);
    assert.equal(a.length, 1);
    assert.equal(a[0].actor, "system");
    assert.equal(a[0].email_id, id);
    assert.equal(a[0].account_id, "a");
    assert.deepEqual(JSON.parse(a[0].details_json as string), { source: "nico", kind: "spam_correct" });
    assert.ok(!JSON.stringify(a).includes("x.test"));
  });

  test("repeating the same verdict changes nothing: no second row, no second count, no second audit", () => {
    const { db, add } = setup();
    const id = add("s@x.test");
    recordFeedback(db, { emailId: id, kind: "not_spam", ts: T });
    const again = recordFeedback(db, { emailId: id, kind: "not_spam", ts: T2 });
    assert.ok(again.ok && !again.changed);
    assert.equal(fbRows(db).length, 1);
    assert.equal(senderCounts(db, "s@x.test")?.marked_not_spam, 1);
    assert.equal(audits(db).length, 1);
  });

  test("switching the verdict moves the count (the latest verdict per mail counts once)", () => {
    const { db, add } = setup();
    const id = add("s@x.test");
    const other = add("s@x.test");
    recordFeedback(db, { emailId: id, kind: "spam_correct", ts: T });
    recordFeedback(db, { emailId: other, kind: "spam_correct", ts: T });
    assert.deepEqual({ ...senderCounts(db, "s@x.test") }.marked_spam, 2);
    const sw = recordFeedback(db, { emailId: id, kind: "not_spam", ts: T2 });
    assert.ok(sw.ok && sw.changed);
    const c = senderCounts(db, "s@x.test")!;
    assert.equal(c.marked_spam, 1);
    assert.equal(c.marked_not_spam, 1);
    recordFeedback(db, { emailId: id, kind: "spam_correct", ts: T2 });
    const c2 = senderCounts(db, "s@x.test")!;
    assert.equal(c2.marked_spam, 2);
    assert.equal(c2.marked_not_spam, 0);
    assert.equal(fbRows(db).length, 4); // history is kept
  });

  test("counters are per sender address, case-insensitive, and never negative", () => {
    const { db, add } = setup();
    const a = add("A@x.test");
    const b = add("b@x.test");
    recordFeedback(db, { emailId: a, kind: "spam_correct", ts: T });
    assert.equal(senderCounts(db, "a@x.test")?.marked_spam, 1);
    assert.equal(senderCounts(db, "b@x.test")?.marked_spam, 0);
    db.prepare("UPDATE senders SET marked_spam = 0, marked_not_spam = 0").run(); // counters drifted (e.g. manual repair)
    recordFeedback(db, { emailId: a, kind: "not_spam", ts: T2 });
    const c = senderCounts(db, "a@x.test")!;
    assert.deepEqual([c.marked_spam, c.marked_not_spam], [0, 1]);
    assert.ok(b > 0);
  });

  test("a mail whose sender row is missing (older data) gets one created", () => {
    const { db, add } = setup();
    const id = add("s@x.test");
    db.prepare("DELETE FROM senders").run();
    const r = recordFeedback(db, { emailId: id, kind: "spam_correct", ts: T });
    assert.ok(r.ok);
    assert.equal(senderCounts(db, "s@x.test")?.marked_spam, 1);
  });

  test("category_wrong needs a known category; the value is stored as a code", () => {
    const { db, add } = setup();
    const id = add("s@x.test");
    for (const bad of [undefined, "", "nonsense", "BUSINESS", "business ", 5, null, {}]) {
      assert.deepEqual(recordFeedback(db, { emailId: id, kind: "category_wrong", value: bad as never, ts: T }), { ok: false, code: "invalid_value" }, String(bad));
    }
    assert.equal(fbRows(db).length, 0);
    const r = recordFeedback(db, { emailId: id, kind: "category_wrong", value: "business", ts: T });
    assert.ok(r.ok && r.changed);
    assert.equal(fbRows(db)[0].value_json, '{"category":"business"}');
    assert.deepEqual(JSON.parse(audits(db)[0].details_json as string), { source: "nico", kind: "category_wrong", category: "business" });
    const same = recordFeedback(db, { emailId: id, kind: "category_wrong", value: "business", ts: T2 });
    assert.ok(same.ok && !same.changed);
    const changed = recordFeedback(db, { emailId: id, kind: "category_wrong", value: "personal", ts: T2 });
    assert.ok(changed.ok && changed.changed);
    assert.equal(fbRows(db).length, 2);
  });

  test("the other kinds take no value", () => {
    const { db, add } = setup();
    const id = add("s@x.test");
    for (const kind of ["spam_correct", "not_spam", "reply_needed", "no_reply_needed"] as const) {
      assert.deepEqual(recordFeedback(db, { emailId: id, kind, value: "business", ts: T }), { ok: false, code: "invalid_value" }, kind);
    }
    assert.equal(fbRows(db).length, 0);
  });

  test("unknown kind and unknown mail", () => {
    const { db, add } = setup();
    const id = add("s@x.test");
    assert.deepEqual(recordFeedback(db, { emailId: id, kind: "always_spam" as never, ts: T }), { ok: false, code: "invalid_kind" });
    assert.deepEqual(recordFeedback(db, { emailId: 999, kind: "spam_correct", ts: T }), { ok: false, code: "not_found" });
    assert.equal(fbRows(db).length, 0);
  });

  test("reply feedback is a separate topic: switching it does not touch the spam counters", () => {
    const { db, add } = setup();
    const id = add("s@x.test");
    recordFeedback(db, { emailId: id, kind: "reply_needed", ts: T });
    recordFeedback(db, { emailId: id, kind: "reply_needed", ts: T2 });
    recordFeedback(db, { emailId: id, kind: "no_reply_needed", ts: T2 });
    assert.equal(fbRows(db).length, 2);
    const c = senderCounts(db, "s@x.test")!;
    assert.deepEqual([c.marked_spam, c.marked_not_spam], [0, 0]);
  });

  test("the row is linked to the latest classified run of the mail", () => {
    const { db, add } = setup();
    const id = add("s@x.test");
    db.prepare(`INSERT INTO classifications (id, email_id, question_set_version, model_requested, model_reported, status, attempts, created_at, updated_at)
      VALUES (7, ?, 'email-classification-v1', 'm', 'm', 'classified', 1, ?, ?)`).run(id, T, T);
    db.prepare(`INSERT INTO classifications (id, email_id, question_set_version, model_requested, status, attempts, created_at, updated_at)
      VALUES (8, ?, 'email-classification-v2', 'm', 'pending', 0, ?, ?)`).run(id, T, T);
    recordFeedback(db, { emailId: id, kind: "spam_correct", ts: T });
    assert.equal(fbRows(db)[0].classification_id, 7);
  });
});

describe("feedbackState", () => {
  test("latest answer per topic, null when none", () => {
    const { db, add } = setup();
    const id = add("s@x.test");
    assert.deepEqual(feedbackState(db, id), { spam: null, reply: null, category: null });
    recordFeedback(db, { emailId: id, kind: "spam_correct", ts: T });
    recordFeedback(db, { emailId: id, kind: "not_spam", ts: T2 });
    recordFeedback(db, { emailId: id, kind: "no_reply_needed", ts: T2 });
    recordFeedback(db, { emailId: id, kind: "category_wrong", value: "personal", ts: T2 });
    assert.deepEqual(feedbackState(db, id), { spam: "not_spam", reply: "no_reply_needed", category: "personal" });
  });
});
