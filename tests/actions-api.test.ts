import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../lib/db.ts";
import { syncAccounts } from "../lib/accounts.ts";
import { listActions, parseActionsQuery } from "../lib/actions-api.ts";
import { createAuthContext, guardRequest } from "../lib/auth-runtime.ts";
import * as route from "../app/api/actions/route.ts";

const T = "2026-10-27T10:00:00.000Z";
const SUBJECT = "SUBJECT-MARKER-3141";

function setup(n = 7): DatabaseSync {
  const db = openDatabase(":memory:");
  syncAccounts(db, [
    { id: "a1", label: "A1", host: "imap.one.example", port: 993, mailbox: "INBOX", spam_mailbox: "Junk", enabled: true },
    { id: "a2", label: "A2", host: "imap.two.example", port: 993, mailbox: "INBOX", enabled: true },
  ] as never);
  for (let i = 1; i <= n; i++) {
    const acc = i % 2 ? "a1" : "a2";
    db.prepare("INSERT INTO emails (id, account_id, message_id, sender, subject, received_at, first_seen_at) VALUES (?,?,?,?,?,?,?)")
      .run(i, acc, `<m${i}>`, "s@x.example", SUBJECT, T, T);
    db.prepare("INSERT INTO email_locations (id, email_id, account_id, folder, uid_validity, uid, first_seen_at, last_seen_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(i, i, acc, "INBOX", 1, i, T, T);
  }
  const ins = db.prepare("INSERT INTO mailbox_actions (email_id, location_id, rule, action, mode, status, failure_code, reason_json, created_at) VALUES (?,?,?,?,?,?,?,?,?)");
  // created_at ascending with the id, except the last two share a timestamp
  const at = (m: number) => new Date(Date.parse(T) + m * 60_000).toISOString();
  ins.run(1, 1, "spam_seen", "mark_seen", "dry_run", "planned", null, '{"rule_reason":"jev_spam"}', at(1));
  ins.run(2, 2, "spam_seen", "mark_seen", "dry_run", "planned", null, "{}", at(2));
  ins.run(3, 3, "spam_seen", "mark_seen", "dry_run", "undone", null, "{}", at(3));
  ins.run(4, 4, "spam_seen", "mark_seen", "live", "done", null, "{}", at(4));
  ins.run(5, 5, "spam_seen", "mark_seen", "live", "failed", "store_rejected", "{}", at(5));
  ins.run(6, 6, "spam_seen", "mark_seen", "dry_run", "planned", null, "{}", at(6));
  ins.run(6, 6, "undo", "unmark_seen", "live", "done", null, "{}", at(6));
  return db;
}
const q = (qs: string) => {
  const r = parseActionsQuery(new URL(`http://x/api/actions${qs}`));
  assert.ok(r.ok, qs);
  return r.query;
};

describe("GET /api/actions", () => {
  test("query validation: mode, status, limit (clamped to 50), cursor", () => {
    assert.equal(parseActionsQuery(new URL("http://x/api/actions?mode=maybe")).ok, false);
    assert.deepEqual(parseActionsQuery(new URL("http://x/api/actions?mode=x")), { ok: false, error: "invalid_mode" });
    assert.deepEqual(parseActionsQuery(new URL("http://x/api/actions?status=x")), { ok: false, error: "invalid_status" });
    assert.deepEqual(parseActionsQuery(new URL("http://x/api/actions?limit=abc")), { ok: false, error: "invalid_limit" });
    assert.deepEqual(parseActionsQuery(new URL("http://x/api/actions?cursor=%25%25")), { ok: false, error: "invalid_cursor" });
    assert.equal(q("?limit=500").limit, 50);
    assert.equal(q("?limit=0").limit, 1);
    assert.equal(q("").limit, 20);
    assert.equal(q("").mode, null);
    assert.equal(q("?mode=dry_run").mode, "dry_run");
  });

  test("dry_run list: items have exactly the contract fields, newest first, no content", () => {
    const r = listActions(setup(), q("?mode=dry_run"));
    assert.deepEqual(r.actions.map((a) => a.id), [6, 3, 2, 1]);
    assert.deepEqual(Object.keys(r.actions[0]).sort(), ["account", "action", "created_at", "email_id", "failure_code", "id", "mode", "rule", "status"]);
    assert.deepEqual({ ...r.actions[3] }, {
      id: 1, email_id: 1, account: "a1", rule: "spam_seen", action: "mark_seen", mode: "dry_run", status: "planned",
      failure_code: null, created_at: new Date(Date.parse(T) + 60_000).toISOString(),
    });
    const dump = JSON.stringify(r);
    for (const secret of [SUBJECT, "s@x.example", "imap.one.example", "rule_reason", "jev_spam"]) assert.ok(!dump.includes(secret), secret);
  });

  test("counts cover all modes and statuses, independent of the filters and the page", () => {
    const expected = {
      dry_run: { planned: 3, done: 0, failed: 0, undone: 1 },
      live: { planned: 0, done: 2, failed: 1, undone: 0 },
    };
    for (const qs of ["?mode=dry_run", "?mode=live&limit=1", "?status=failed", ""]) assert.deepEqual(listActions(setup(), q(qs)).counts, expected, qs);
  });

  test("live list and status filter", () => {
    const db = setup();
    assert.deepEqual(listActions(db, q("?mode=live")).actions.map((a) => [a.id, a.status, a.failure_code]), [[7, "done", null], [5, "failed", "store_rejected"], [4, "done", null]]);
    assert.deepEqual(listActions(db, q("?mode=dry_run&status=planned")).actions.map((a) => a.id), [6, 2, 1]);
  });

  test("keyset pagination follows the cursor without gaps or repeats, also across equal timestamps", () => {
    const db = setup();
    const seen: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r = listActions(db, q(`?limit=2${cursor ? `&cursor=${cursor}` : ""}`));
      seen.push(...r.actions.map((a) => a.id));
      cursor = r.next_cursor;
      pages++;
    } while (cursor && pages < 10);
    assert.deepEqual(seen, [7, 6, 5, 4, 3, 2, 1]);
    assert.equal(pages, 4);
    assert.equal(listActions(db, q("?limit=50")).next_cursor, null);
  });

  test("the route is GET only, guarded without a session, and unavailable data answers a code", async () => {
    assert.deepEqual(Object.keys(route).sort(), ["GET"]);
    const dir = mkdtempSync(join(tmpdir(), "actions-"));
    chmodSync(dir, 0o700);
    const auth = createAuthContext({ dataDir: dir, synthetic: false });
    assert.equal(guardRequest(new Request("http://127.0.0.1:3000/api/actions?mode=dry_run"), auth)?.status, 401);
    const prev = process.env.DATABASE_PATH;
    process.env.DATABASE_PATH = join(dir, "t.sqlite");
    try {
      const db = openDatabase(join(dir, "t.sqlite"));
      db.close();
      const res = route.GET(new Request("http://127.0.0.1:3000/api/actions?mode=dry_run"));
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { actions: [], next_cursor: null, counts: { dry_run: { planned: 0, done: 0, failed: 0, undone: 0 }, live: { planned: 0, done: 0, failed: 0, undone: 0 } } });
      assert.equal(route.GET(new Request("http://127.0.0.1:3000/api/actions?mode=zzz")).status, 400);
    } finally {
      if (prev === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = prev;
    }
  });
});
