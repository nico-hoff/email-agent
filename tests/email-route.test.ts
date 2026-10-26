import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../lib/db.ts";
import { syncAccounts } from "../lib/accounts.ts";
import { GET } from "../app/api/emails/route.ts";
import * as route from "../app/api/emails/route.ts";

const T = "2026-10-26T10:00:00.000Z";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "emails-"));
  chmodSync(dir, 0o700);
  const file = join(dir, "t.sqlite");
  const prev = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = file;
  const db = openDatabase(file);
  syncAccounts(db, [
    { id: "a1", label: "L1", host: "imap.one.example", port: 993, mailbox: "INBOX", spam_mailbox: "Junk", enabled: true },
    { id: "a2", label: "L2", host: "imap.two.example", port: 993, mailbox: "INBOX", enabled: true },
  ] as never);
  const mail = (id: number, acc: string, recv: string) =>
    db.prepare("INSERT INTO emails (id, account_id, message_id, sender, subject, received_at, first_seen_at) VALUES (?,?,?,?,?,?,?)")
      .run(id, acc, `m${id}`, `s${id}@x.example`, `subj${id}`, recv, T);
  const loc = (id: number, acc: string, folder: string, active: number) =>
    db.prepare("INSERT INTO email_locations (email_id, account_id, folder, uid_validity, uid, is_active, first_seen_at, last_seen_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(id, acc, folder, 1, id * 10 + active, active, T, T);
  const cls = (id: number, status: string) =>
    db.prepare("INSERT INTO classifications (id, email_id, question_set_version, model_requested, model_reported, status, failure_code, attempts, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(id, id, "email-classification-v1", "typesafe/jev-1.13", status === "classified" ? "typesafe/jev-1.13" : null, status, status === "failed" ? "x" : null, 1, T, T);
  const ans = (c: number, key: string, type: string, a: unknown, p: unknown = null) =>
    db.prepare("INSERT INTO classification_answers (classification_id, question_key, type, answer_json, probabilities_json) VALUES (?,?,?,?,?)")
      .run(c, key, type, JSON.stringify(a), p === null ? null : JSON.stringify(p));
  const shadow = (c: number, candidate: boolean) =>
    ans(c, "shadow_quarantine", "derived", {
      candidate, decision: candidate ? "pending_policy" : "no", applied_threshold: 0.8,
      inputs: { is_spam: 0.9, needs_my_reply: 0.1, is_assessable: 0.9, category: "x" }, reason: candidate ? "candidate" : "not_spam",
    });
  // 1: provider spam (Junk), jev category newsletter -> provider_spam_jev_not_spam
  mail(1, "a1", "2026-10-26T09:00:00.000Z"); loc(1, "a1", "INBOX", 0); loc(1, "a1", "Junk", 1); cls(1, "classified");
  ans(1, "category", "choice", { value: "newsletter" }, { newsletter: 0.9 }); ans(1, "is_spam", "noul", { value: 0.2 }); shadow(1, false);
  // 2: INBOX, jev category spam -> jev_spam_provider_not_spam
  mail(2, "a1", "2026-10-26T08:00:00.000Z"); loc(2, "a1", "INBOX", 1); cls(2, "classified");
  ans(2, "category", "choice", { value: "spam" }); shadow(2, false);
  // 3: agree
  mail(3, "a1", "2026-10-26T07:00:00.000Z"); loc(3, "a1", "INBOX", 1); cls(3, "classified");
  ans(3, "category", "choice", { value: "work" }); shadow(3, false);
  // 4: pending, other account, no spam mailbox
  mail(4, "a2", "2026-10-26T11:00:00.000Z"); loc(4, "a2", "INBOX", 1); cls(4, "pending");
  return { db, dir, prev };
}

async function call(qs = "") {
  const res = await GET(new Request(`http://x/api/emails${qs}`));
  const text = await res.text();
  return { res, text, body: res.status === 200 ? JSON.parse(text) : null };
}

const ids = (b: { emails: { id: number }[] }) => b.emails.map((e) => e.id);

test("GET /api/emails returns metadata, answers, shadow and disagreements without content", async () => {
  const { db, dir, prev } = setup();
  db.close();
  try {
    const { res, body, text } = await call();
    assert.equal(res.status, 200);
    assert.deepEqual(ids(body), [4, 1, 2, 3]);
    const by = (id: number) => body.emails.find((e: { id: number }) => e.id === id);
    const e1 = by(1);
    assert.equal(e1.account_id, "a1");
    assert.equal(e1.active_location.folder, "Junk");
    assert.equal(e1.provider_spam, true);
    assert.equal(e1.classification.status, "classified");
    assert.equal(e1.classification.question_set_version, "email-classification-v1");
    assert.deepEqual(e1.classification.answers.category, { type: "choice", value: "newsletter", probabilities: { newsletter: 0.9 } });
    assert.equal(e1.shadow_quarantine.decision, "no");
    assert.equal(e1.disagreement, "provider_spam_jev_not_spam");
    assert.equal(by(2).disagreement, "jev_spam_provider_not_spam");
    assert.equal(by(3).disagreement, null);
    assert.equal(by(4).disagreement, null);
    assert.equal(by(4).provider_spam, false);
    assert.equal(by(4).shadow_quarantine, null);
    for (const bad of ["body", "snippet", "excerpt", "raw", "imap.one", "imap.two", "L1", "password", "OPENROUTER"]) {
      assert.ok(!text.toLowerCase().includes(bad.toLowerCase()), bad);
    }
  } finally {
    if (prev === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GET /api/emails filters by account, status and limit; only GET exported", async () => {
  const { db, dir, prev } = setup();
  db.close();
  try {
    assert.deepEqual(ids((await call("?account=a2")).body), [4]);
    assert.deepEqual(ids((await call("?status=pending")).body), [4]);
    assert.equal((await call("?limit=2")).body.emails.length, 2);
    assert.equal((await call("?limit=99999")).res.status, 200);
    assert.equal((await call("?status=bogus")).res.status, 400);
    assert.equal((await call("?limit=abc")).res.status, 400);
    assert.deepEqual(Object.keys(route).sort(), ["GET"]);
  } finally {
    if (prev === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
