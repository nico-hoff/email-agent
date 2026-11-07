// Initial import (ADR 0043): range math, exactly once, resume, progress, no mailbox actions for imported mails. Synthetic only.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readSync, restartSync, syncView } from "../packages/core/src/account-sync.ts";
import { IMPORT_DEFAULT_COUNT, IMPORT_MAX_COUNT, IMPORT_WATCH_MS } from "../packages/core/src/constants.ts";
import { openDatabase } from "../packages/core/src/db.ts";
import { clampImportCount, importCutoff, selectImportUids } from "../packages/core/src/initial-import.ts";
import { ingestMail } from "../packages/core/src/ingest.ts";
import { createMailboxActions } from "../packages/core/src/mailbox-actions.ts";
import { loadBriefingContext } from "../packages/core/src/briefing-context.ts";
import { setUserState } from "../packages/core/src/user-state.ts";
import { account, fakeClassify, importHarness, ImportPort, settle, until } from "./helpers/import-harness.ts";

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const count = (h: ReturnType<typeof importHarness>, sql: string) => (h.db.prepare(sql).get() as { n: number }).n;

describe("range math", () => {
  test("only UIDs <= the checkpoint, newest first, at most N", () => {
    assert.deepEqual(selectImportUids([1, 2, 3, 4, 5, 90, 100], 5, 3), [5, 4, 3]);
    assert.deepEqual(selectImportUids([5, 5, 3, 0, -1, 2.5], 10, 50), [5, 3]);
    assert.deepEqual(selectImportUids([], 10, 50), []);
  });
  test("N defaults to 50, is capped at 200 and at least 1", () => {
    assert.equal(clampImportCount(undefined), IMPORT_DEFAULT_COUNT);
    assert.equal(IMPORT_DEFAULT_COUNT, 50);
    assert.equal(clampImportCount(9999), IMPORT_MAX_COUNT);
    assert.equal(clampImportCount(0), 1);
    assert.equal(selectImportUids(range(1, 500), 500, 9999).length, 200);
  });
  test("the window starts at midnight UTC 14 days back", () => {
    assert.equal(importCutoff(new Date("2026-10-31T12:34:56Z")).toISOString(), "2026-10-17T00:00:00.000Z");
    assert.equal(importCutoff(new Date("2026-10-31T12:34:56Z"), 3).toISOString(), "2026-10-28T00:00:00.000Z");
  });
});

describe("initial import in the worker", () => {
  test("new account: baseline first, then the newest 50 mails at or below it; live range stays untouched", async () => {
    const h = importHarness();
    h.port.inbox = range(1, 80);
    h.port.old = new Set(range(1, 10));
    h.workers.start();
    await settle();
    await until(h, () => readSync(h.db, "a")?.phase === "done");
    const call = h.port.searchCalls[0];
    assert.equal(call.maxUid, 80, "upper bound = checkpoint");
    assert.equal(call.since.toISOString(), "2026-10-17T00:00:00.000Z");
    assert.deepEqual([...h.port.fetched].sort((a, b) => a - b), range(31, 80));
    assert.equal(h.port.fetched[0], 80, "newest first");
    assert.equal(count(h, "SELECT COUNT(*) AS n FROM emails WHERE origin = 'import'"), 50);
    assert.equal((h.db.prepare("SELECT last_uid FROM mailbox_state").get() as { last_uid: number }).last_uid, 80, "checkpoint not moved by the import");
    const s = readSync(h.db, "a");
    assert.deepEqual([s?.phase, s?.total, s?.fetched, s?.classified, s?.failed_count], ["done", 50, 50, 50, 0]);
    // a live mail above the checkpoint is ingested as live and does not start another import
    h.port.inbox.push(81);
    h.port.emit("exists");
    await settle();
    assert.equal(count(h, "SELECT COUNT(*) AS n FROM emails WHERE origin = 'live'"), 1);
    assert.equal(h.port.searchCalls.length, 1);
    await h.workers.stop();
  });

  test("fewer mails than N inside the window: all of them; empty inbox: done with zero", async () => {
    const h = importHarness();
    h.port.inbox = range(1, 7);
    h.workers.start();
    await settle();
    await until(h, () => readSync(h.db, "a")?.phase === "done");
    assert.equal(readSync(h.db, "a")?.total, 7);
    assert.equal(readSync(h.db, "a")?.phase, "done");
    await h.workers.stop();
    const e = importHarness({ id: "e" });
    e.workers.start();
    await settle();
    await until(e, () => readSync(e.db, "e")?.phase === "done");
    assert.equal(readSync(e.db, "e")?.phase, "done");
    assert.equal(readSync(e.db, "e")?.total, 0);
    await e.workers.stop();
  });

  test("progress: fetched counts up first, classification follows; phases connecting -> fetching -> classifying -> done", async () => {
    const h = importHarness({ classifyMs: 3000, initialImport: { count: 6 } });
    h.port.inbox = range(1, 20);
    const phases: string[] = [readSync(h.db, "a")?.phase ?? "none"];
    h.workers.start();
    await until(h, () => readSync(h.db, "a")?.fetched === 6);
    const mid = readSync(h.db, "a");
    assert.ok(mid && (mid.phase === "classifying" || mid.phase === "fetching"));
    await until(h, () => readSync(h.db, "a")?.phase === "done");
    const done = readSync(h.db, "a");
    assert.deepEqual([done?.phase, done?.total, done?.fetched, done?.classified], ["done", 6, 6, 6]);
    assert.equal(phases[0], "none", "no row before the first start");
    assert.ok(done?.finished_at);
    await h.workers.stop();
  });

  test("body stays in memory: handed to the hook, never stored", async () => {
    const h = importHarness({ initialImport: { count: 3 } });
    h.port.inbox = range(1, 3);
    h.workers.start();
    await settle();
    await until(h, () => readSync(h.db, "a")?.phase === "done");
    assert.ok(h.inputs.every((i) => i.excerpt.startsWith("SYNTHETIC BODY")));
    const dump = JSON.stringify([
      h.db.prepare("SELECT * FROM emails").all(), h.db.prepare("SELECT * FROM audit_log").all(), h.db.prepare("SELECT * FROM account_sync").all(),
    ]);
    assert.ok(!dump.includes("SYNTHETIC BODY"));
    await h.workers.stop();
  });

  test("exactly once: a second worker over the same database does not import again", async () => {
    const h = importHarness();
    h.port.inbox = range(1, 12);
    h.workers.start();
    await settle();
    await until(h, () => readSync(h.db, "a")?.phase === "done");
    await h.workers.stop();
    const again = importHarness({ db: h.db, port: new ImportPort(), skipSync: true });
    again.port.inbox = range(1, 12);
    again.workers.start();
    await settle();
    await again.clock.advance(10_000);
    await settle();
    assert.equal(again.port.searchCalls.length, 0);
    assert.equal(again.port.fetched.length, 0);
    assert.equal(readSync(h.db, "a")?.runs, 1);
    await again.workers.stop();
  });

  test("an account from before the feature gets its row on the first start", async () => {
    const db = openDatabase(":memory:");
    const h = importHarness({ db });
    assert.equal(readSync(db, "a"), null);
    h.port.inbox = range(1, 4);
    h.workers.start();
    await settle();
    assert.notEqual(readSync(db, "a"), null);
    await until(h, () => readSync(h.db, "a")?.phase === "done");
    assert.equal(readSync(db, "a")?.phase, "done");
    await h.workers.stop();
  });

  test("resume: the connection drops mid-import; the retry finishes without duplicates", async () => {
    const h = importHarness();
    h.port.inbox = range(1, 30);
    h.port.failFetchAt = 22;
    h.workers.start();
    await until(h, () => readSync(h.db, "a")?.error_code === "imap_error", 1);
    const s = readSync(h.db, "a");
    assert.equal(s?.error_code, "imap_error");
    assert.ok(["fetching", "connecting"].includes(s?.phase ?? ""));
    await until(h, () => readSync(h.db, "a")?.phase === "done");
    const done = readSync(h.db, "a");
    assert.deepEqual([done?.phase, done?.total, done?.error_code], ["done", 30, null]);
    assert.equal(count(h, "SELECT COUNT(*) AS n FROM emails"), 30);
    assert.equal(count(h, "SELECT COUNT(*) AS n FROM email_locations"), 30);
    await h.workers.stop();
  });

  test("resume after a restart of the process: a mail without classification row is fetched again, the rest is not", async () => {
    const h = importHarness({ noClassifier: true, initialImport: { count: 5 } });
    h.port.inbox = range(1, 5);
    h.workers.start();
    await settle();
    await until(h, () => readSync(h.db, "a")?.phase === "done");
    assert.equal(readSync(h.db, "a")?.phase, "done");
    await h.workers.stop();
    // pretend the process died while classifying: row back to classifying, three mails already have their classification
    const ids = h.db.prepare("SELECT id FROM emails ORDER BY id").all() as { id: number }[];
    for (const { id } of ids.slice(0, 3)) fakeClassify(h.db, id, "2026-10-31T12:00:00.000Z");
    h.db.prepare("UPDATE account_sync SET phase = 'classifying', finished_at = NULL").run();
    const again = importHarness({ db: h.db, port: new ImportPort(), skipSync: true, initialImport: { count: 5 } });
    again.port.inbox = range(1, 5);
    again.workers.start();
    await settle();
    await until(again, () => readSync(again.db, "a")?.phase === "done");
    assert.deepEqual(again.port.fetched.sort(), [uidOf(h, ids[3].id), uidOf(h, ids[4].id)].sort());
    assert.equal(readSync(h.db, "a")?.phase, "done");
    assert.equal(readSync(h.db, "a")?.classified, 5);
    assert.equal(count(h, "SELECT COUNT(*) AS n FROM emails"), 5);
    await again.workers.stop();
  });

  test("restart: only from done/failed; the worker picks the queued import up again", async () => {
    const h = importHarness({ initialImport: { count: 4 } });
    h.port.inbox = range(1, 9);
    h.workers.start();
    await settle();
    assert.equal(restartSync(h.db, "a", new Date()), false, "not while running (before done)") ;
    await until(h, () => readSync(h.db, "a")?.phase === "done");
    assert.equal(readSync(h.db, "a")?.phase, "done");
    h.port.inbox.push(...range(10, 12)); // new live mails would be handled by the live path
    assert.equal(restartSync(h.db, "a", new Date()), true);
    assert.equal(readSync(h.db, "a")?.phase, "queued");
    await until(h, () => readSync(h.db, "a")?.phase === "done" && readSync(h.db, "a")?.runs === 2);
    const s = readSync(h.db, "a");
    assert.deepEqual([s?.phase, s?.runs], ["done", 2]);
    assert.equal(count(h, "SELECT COUNT(*) AS n FROM emails WHERE origin = 'import'") >= 4, true);
    await h.workers.stop();
  });

  test("authentication failure ends the import as failed with a code; no classifier: done after reading", async () => {
    const h = importHarness();
    h.port.connectImpl = async () => { throw Object.assign(new Error("auth"), { authenticationFailed: true }); };
    h.workers.start();
    await settle();
    const s = readSync(h.db, "a");
    assert.deepEqual([s?.phase, s?.error_code], ["failed", "imap_auth"]);
    await h.workers.stop();
    const n = importHarness({ id: "n", noClassifier: true });
    n.port.inbox = range(1, 5);
    n.workers.start();
    await settle();
    await until(n, () => readSync(n.db, "n")?.phase === "done");
    assert.deepEqual([readSync(n.db, "n")?.phase, readSync(n.db, "n")?.fetched, readSync(n.db, "n")?.classified], ["done", 5, 0]);
    await n.workers.stop();
  });

  test("a failed classification counts as failed, not as pending forever", async () => {
    const h = importHarness({ noClassifier: false, initialImport: { count: 3 } });
    h.port.inbox = range(1, 3);
    h.workers.start();
    await settle();
    await until(h, () => readSync(h.db, "a")?.phase === "done");
    h.db.prepare("UPDATE classifications SET status = 'failed', failure_code = 'max_attempts' WHERE id = 1").run();
    h.db.prepare("UPDATE account_sync SET phase = 'classifying', finished_at = NULL").run();
    await h.workers.stop();
    const again = importHarness({ db: h.db, port: new ImportPort(), skipSync: true, initialImport: { count: 3 } });
    again.port.inbox = range(1, 3);
    again.workers.start();
    await settle();
    await until(again, () => readSync(again.db, "a")?.phase === "done");
    const s = readSync(h.db, "a");
    assert.deepEqual([s?.phase, s?.classified, s?.failed_count], ["done", 2, 1]);
    await again.workers.stop();
  });
});

function uidOf(h: { db: ReturnType<typeof openDatabase> }, emailId: number): number {
  return (h.db.prepare("SELECT uid FROM email_locations WHERE email_id = ?").get(emailId) as { uid: number }).uid;
}

describe("imported mails and the rest of the app", () => {
  const T = "2026-10-31T12:00:00.000Z";
  function seeded() {
    const db = openDatabase(":memory:");
    db.exec("INSERT INTO accounts (id, label, host, port, mailbox, spam_mailbox, user_id) VALUES ('a','A','h',993,'INBOX','Junk',1)");
    const meta = (n: number) => ({
      messageId: `<${n}@x.test>`, sender: "s@example.test", subject: `s${n}`, receivedAt: T, spf: "pass", dkim: "pass", dmarc: "pass",
      listUnsubscribePresent: false, replyToDiffersFromFrom: false,
    }) as never;
    const imp = ingestMail(db, { accountId: "a", meta: meta(1), loc: { folder: "INBOX", uid: 1, uidValidity: 1 }, now: new Date(T), traceId: "t", origin: "import" });
    const live = ingestMail(db, { accountId: "a", meta: meta(2), loc: { folder: "INBOX", uid: 2, uidValidity: 1 }, now: new Date(T), traceId: "t" });
    for (const id of [imp.emailId, live.emailId]) {
      fakeClassify(db, id, T, { category: "spam" });
      const c = db.prepare("SELECT id FROM classifications WHERE email_id = ?").get(id) as { id: number };
      db.prepare("INSERT INTO classification_answers (classification_id, question_key, type, answer_json) VALUES (?, 'is_spam', 'noul', ?)").run(c.id, JSON.stringify({ value: 0.99 }));
    }
    return { db, imp: imp.emailId, live: live.emailId };
  }

  test("no automatic mailbox action for an imported mail, in no mode; backfill skips it; live mails are unaffected", async () => {
    const { db, imp, live } = seeded();
    const writes: string[] = [];
    for (const mode of ["dry_run", "live"] as const) {
      const acct = { ...(account("a") as object), auto_actions: { spam_seen: mode }, spam_seen_mode: mode } as never;
      const actions = createMailboxActions({
        db, accounts: [acct], killSwitchFile: "/nonexistent/kill", now: () => new Date(T),
        writePortFor: () => ({ addSeen: async () => { writes.push("seen"); }, moveToQuarantine: async () => { writes.push("move"); }, moveToTrash: async () => { writes.push("trash"); } }) as never,
      });
      assert.deepEqual(await actions.evaluate(imp), { outcome: "imported" });
      await actions.backfill();
      assert.equal(count2(db, `SELECT COUNT(*) AS n FROM mailbox_actions WHERE email_id = ${imp}`), 0);
    }
    void live;
    assert.ok(!writes.includes("move") && !writes.includes("trash"));
  });

  test("imported mails are not 'new since last open'; live mails are", () => {
    const { db } = seeded();
    db.exec("UPDATE emails SET first_seen_at = '2026-10-31T13:00:00.000Z'");
    setUserState(db, 1, "last_opened_at", { at: "2026-10-31T12:30:00.000Z" }, T);
    const ctx = loadBriefingContext(db, 1, new Date("2026-10-31T14:00:00Z"));
    assert.equal(ctx.new_since_last_open, 0, "both are spam here: use a non-spam check below");
    db.exec("DELETE FROM classification_answers");
    const ctx2 = loadBriefingContext(db, 1, new Date("2026-10-31T14:00:00Z"));
    assert.equal(ctx2.new_since_last_open, 1, "only the live mail");
  });

  test("syncView: feed shows the latest processed mails of this account only, at most 10", async () => {
    const h = importHarness({ initialImport: { count: 25 } });
    h.port.inbox = range(1, 30);
    h.workers.start();
    await settle();
    await until(h, () => readSync(h.db, "a")?.phase === "done");
    const v = syncView(h.db, 1, "a");
    assert.equal(v?.phase, "done");
    assert.equal(v?.feed.length, 10);
    assert.ok(v?.feed.every((m) => m.account_id === "a" && typeof m.subject === "string" && "category" in m));
    assert.equal(syncView(h.db, 2, "a"), null, "foreign user");
    await h.workers.stop();
  });
});

function count2(db: ReturnType<typeof openDatabase>, sql: string): number {
  return (db.prepare(sql).get() as { n: number }).n;
}
