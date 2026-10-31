import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../lib/db.ts";
import { syncAccounts } from "../lib/accounts.ts";
import { readAutoActionModes } from "../lib/account-modes.ts";
import { getEmailDetail, listEmails, parseListQuery } from "../lib/email-api.ts";
import { listActions, parseActionsQuery } from "../lib/actions-api.ts";

const T = "2026-10-27T10:00:00.000Z";

function setup() {
  const db = openDatabase(":memory:");
  syncAccounts(db, [
    { id: "a1", label: "A1", host: "imap.one.example", port: 993, mailbox: "INBOX", enabled: true },
    { id: "a2", label: "A2", host: "imap.two.example", port: 993, mailbox: "INBOX", enabled: true },
  ] as never);
  for (const i of [1, 2, 3]) {
    db.prepare("INSERT INTO emails (id, account_id, message_id, sender, subject, received_at, first_seen_at) VALUES (?,?,?,?,?,?,?)")
      .run(i, i === 3 ? "a2" : "a1", `<m${i}>`, "s@x.example", "subject", T, T);
    db.prepare("INSERT INTO email_locations (id, email_id, account_id, folder, uid_validity, uid, first_seen_at, last_seen_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(i, i, i === 3 ? "a2" : "a1", "INBOX", 1, i, T, T);
  }
  const ins = db.prepare("INSERT INTO mailbox_actions (email_id, location_id, rule, action, mode, status, failure_code, reason_json, created_at) VALUES (?,?,?,?,?,?,?,?,?)");
  ins.run(1, 1, "spam_seen", "mark_seen", "dry_run", "planned", null, '{"rule_reason":"jev_spam"}', T);
  ins.run(2, 2, "spam_seen", "mark_seen", "live", "done", null, "{}", T);
  ins.run(2, 2, "undo", "unmark_seen", "live", "done", null, "{}", "2026-10-27T11:00:00.000Z");
  return db;
}

describe("account modes for the list header", () => {
  test("readAutoActionModes: explicit mode, off when the account is disabled, absent without credentials row", () => {
    const db = openDatabase(":memory:");
    syncAccounts(db, [
      { id: "a", label: "a", host: "h.example", port: 993, mailbox: "INBOX", enabled: true },
      { id: "b", label: "b", host: "h.example", port: 993, mailbox: "INBOX", enabled: true },
      { id: "c", label: "c", host: "h.example", port: 993, mailbox: "INBOX", enabled: true },
      { id: "d", label: "d", host: "h.example", port: 993, mailbox: "INBOX", enabled: true },
    ] as never);
    const ins = (id: string, mode: string) => db.prepare(
      `INSERT INTO mail_accounts (account_id,user_id,type,tls,username,secret_ciphertext,secret_nonce,secret_tag,key_id,secret_set_at,spam_seen_mode,created_at,updated_at)
       VALUES (?,1,'imap',1,'u',x'aa',x'000000000000000000000000',x'00000000000000000000000000000000','${"a".repeat(16)}','${T}',?,'${T}','${T}')`,
    ).run(id, mode);
    ins("a", "live"); ins("b", "dry_run"); ins("c", "live");
    db.exec("UPDATE accounts SET enabled = 0 WHERE id = 'c'");
    assert.deepEqual([...readAutoActionModes(db, 1)].sort(), [["a", "live"], ["b", "dry_run"], ["c", "off"]]);
    assert.deepEqual([...readAutoActionModes(db, 2)], []);
  });

  test("GET /api/emails carries auto_actions per account id (modes only), dry_run when unknown", () => {
    const db = setup();
    const q = parseListQuery(new URL("http://x/api/emails?view=all"));
    assert.ok(q.ok);
    const plain = listEmails(db, 1, q.query);
    assert.deepEqual(plain.auto_actions, { a1: "dry_run", a2: "dry_run" });
    const live = listEmails(db, 1, q.query, { autoActionModes: new Map([["a2", "live"]]) });
    assert.deepEqual(live.auto_actions, { a1: "dry_run", a2: "live" });
    assert.ok(!JSON.stringify(live).includes("imap.one.example"));
  });
});

describe("GET /api/emails/:id: mailbox action", () => {
  test("shows the spam_seen action with mode and status, codes only", () => {
    const db = setup();
    const d = getEmailDetail(db, 1, 1);
    assert.deepEqual(d?.mailbox_action, { id: 1, rule: "spam_seen", action: "mark_seen", mode: "dry_run", status: "planned", failure_code: null, created_at: T });
    assert.equal(getEmailDetail(db, 1, 2)?.mailbox_action?.mode, "live", "the undo row is not the action");
    assert.equal(getEmailDetail(db, 1, 3)?.mailbox_action, null);
    assert.ok(!JSON.stringify(d).includes("jev_spam"), "no reason details");
  });
});

describe("GET /api/actions without undo rows", () => {
  test("the undo log entry is neither listed nor counted", () => {
    const db = setup();
    const p = parseActionsQuery(new URL("http://x/api/actions?mode=live"));
    assert.ok(p.ok);
    const r = listActions(db, 1, p.query);
    assert.deepEqual(r.actions.map((a) => a.rule), ["spam_seen"]);
    assert.equal(r.counts.live.done, 1);
  });
});
