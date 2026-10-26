import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../lib/db.ts";
import { syncAccounts } from "../lib/accounts.ts";
import { ingestMail } from "../lib/ingest.ts";
import type { MessageMeta } from "../lib/imap.ts";

const NOW = new Date("2026-10-26T12:00:00.000Z");
function setup(): DatabaseSync {
  const db = openDatabase(":memory:");
  const mk = (id: string) => ({
    id, label: id, context: "c", host: "h", port: 993, tls: true, user: "u", password: "p",
    mailbox: "INBOX", spam_threshold: 0.9, enabled: true,
  }) as never;
  syncAccounts(db, [mk("a"), mk("b")]);
  return db;
}
const meta = (messageId: string | null): MessageMeta => ({
  messageId, sender: "s@example.test", subject: "subj", receivedAt: "2026-10-26T10:00:00.000Z",
  spf: "pass", dkim: "pass", dmarc: "pass", listUnsubscribePresent: false, replyToDiffersFromFrom: false,
});
const ing = (db: DatabaseSync, account: string, m: MessageMeta, folder: string, uid: number, uv = 1) =>
  ingestMail(db, { accountId: account, meta: m, loc: { folder, uid, uidValidity: uv }, now: NOW, traceId: "t" });
const all = (db: DatabaseSync, sql: string) => db.prepare(sql).all().map((r) => ({ ...r })) as Record<string, unknown>[];

describe("ingestMail", () => {
  test("new mail creates email and location", () => {
    const db = setup();
    const r = ing(db, "a", meta("<m1>"), "INBOX", 5);
    assert.equal(r.isNew, true);
    assert.equal(all(db, "SELECT * FROM emails").length, 1);
    assert.deepEqual(all(db, "SELECT folder, uid, uid_validity, is_active FROM email_locations"), [
      { folder: "INBOX", uid: 5, uid_validity: 1, is_active: 1 },
    ]);
  });

  test("same location again is idempotent", () => {
    const db = setup();
    const r1 = ing(db, "a", meta("<m1>"), "INBOX", 5);
    const r2 = ing(db, "a", meta("<m1>"), "INBOX", 5);
    assert.deepEqual(r2, { emailId: r1.emailId, isNew: false });
    assert.equal(all(db, "SELECT * FROM emails").length, 1);
    assert.equal(all(db, "SELECT * FROM email_locations").length, 1);
    assert.equal(all(db, "SELECT * FROM audit_log").length, 0);
  });

  test("move INBOX -> Junk adds location, deactivates old, audits folder_changed", () => {
    const db = setup();
    const r1 = ing(db, "a", meta("<m1>"), "INBOX", 5);
    const r2 = ing(db, "a", meta("<m1>"), "Junk", 2, 9);
    assert.deepEqual(r2, { emailId: r1.emailId, isNew: false });
    assert.deepEqual(all(db, "SELECT folder, is_active FROM email_locations ORDER BY id"), [
      { folder: "INBOX", is_active: 0 },
      { folder: "Junk", is_active: 1 },
    ]);
    const a = all(db, "SELECT action, actor, account_id, email_id, details_json FROM audit_log");
    assert.equal(a.length, 1);
    assert.equal(a[0].action, "folder_changed");
    assert.equal(a[0].email_id, r1.emailId);
    assert.deepEqual(JSON.parse(String(a[0].details_json)), { from: "INBOX", to: "Junk" });
  });

  test("mail without message-id is deduplicated by location", () => {
    const db = setup();
    const r1 = ing(db, "a", meta(null), "INBOX", 7);
    const r2 = ing(db, "a", meta(null), "INBOX", 7);
    const r3 = ing(db, "a", meta(null), "INBOX", 8);
    assert.equal(r1.isNew, true);
    assert.deepEqual(r2, { emailId: r1.emailId, isNew: false });
    assert.equal(r3.isNew, true);
    assert.notEqual(r3.emailId, r1.emailId);
    assert.equal(all(db, "SELECT * FROM emails").length, 2);
  });

  test("same message-id in another account does not collide", () => {
    const db = setup();
    const r1 = ing(db, "a", meta("<m1>"), "INBOX", 5);
    const r2 = ing(db, "b", meta("<m1>"), "INBOX", 5);
    assert.equal(r2.isNew, true);
    assert.notEqual(r1.emailId, r2.emailId);
  });
});
