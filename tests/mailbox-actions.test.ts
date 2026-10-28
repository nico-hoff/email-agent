import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../lib/db.ts";
import { syncAccounts } from "../lib/accounts.ts";
import { upsertSeen } from "../lib/email-status.ts";
import { ImapWriteError, type ImapWritePort } from "../lib/imap-write.ts";
import type { AccountConfig } from "../lib/accounts-config.ts";
import { createMailboxActions, DAILY_ACTION_LIMIT } from "../lib/mailbox-actions.ts";
import { createRule, deactivateRule } from "../lib/sender-rules.ts";

const T0 = new Date("2026-10-27T10:00:00.000Z");
const SUBJECT = "SUBJECT-MARKER-5521";
const SENDER = "sender-marker-5521@example.test";

function account(id: string, mode: "off" | "dry_run" | "live" | undefined, over: Partial<AccountConfig> = {}): AccountConfig {
  return {
    id, label: id, context: "c", host: "imap.secret.example", port: 993, tls: true, user: "u", password: "p",
    mailbox: "INBOX", spam_mailbox: "Junk", spam_threshold: 0.95, enabled: true,
    ...(mode ? { auto_actions: { spam_seen: mode } } : {}), ...over,
  } as AccountConfig;
}

interface PortCall { fn: "addSeen" | "removeSeen"; folder: string; uidValidity: number; uid: number }
function fakePort(fail?: () => ImapWriteError | undefined) {
  const calls: PortCall[] = [];
  const port: ImapWritePort = {
    async addSeen(folder, uidValidity, uid) {
      calls.push({ fn: "addSeen", folder, uidValidity, uid });
      const e = fail?.();
      if (e) throw e;
    },
    async removeSeen(folder, uidValidity, uid) {
      calls.push({ fn: "removeSeen", folder, uidValidity, uid });
      const e = fail?.();
      if (e) throw e;
    },
  };
  return { port, calls };
}

let nextUid = 100;
/** Inserts a classified mail with answers; returns the email id. */
function addMail(db: DatabaseSync, accountId: string, o: { spam?: number | null; category?: string | null; folder?: string; seen?: boolean; uidValidity?: number; classified?: boolean } = {}): number {
  const uid = nextUid++;
  const ts = T0.toISOString();
  const e = db.prepare("INSERT INTO emails (account_id, message_id, sender, subject, received_at, first_seen_at) VALUES (?,?,?,?,?,?)")
    .run(accountId, `<m${uid}@x>`, SENDER, SUBJECT, ts, ts);
  const emailId = Number(e.lastInsertRowid);
  db.prepare("INSERT INTO email_locations (email_id, account_id, folder, uid_validity, uid, first_seen_at, last_seen_at) VALUES (?,?,?,?,?,?,?)")
    .run(emailId, accountId, o.folder ?? "INBOX", o.uidValidity ?? 5, uid, ts, ts);
  if (o.seen !== undefined) upsertSeen(db, emailId, o.seen, ts);
  if (o.classified !== false) {
    const c = db.prepare("INSERT INTO classifications (email_id, question_set_version, model_requested, model_reported, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
      .run(emailId, "email-classification-v1", "typesafe/jev-1.13", "typesafe/jev-1.13", "classified", ts, ts);
    const cid = Number(c.lastInsertRowid);
    const ans = db.prepare("INSERT INTO classification_answers (classification_id, question_key, type, answer_json) VALUES (?,?,?,?)");
    if (o.spam !== null) ans.run(cid, "is_spam", "noul", JSON.stringify({ value: o.spam ?? 0.97 }));
    if (o.category !== null) ans.run(cid, "category", "choice", JSON.stringify({ value: o.category ?? "promotion" }));
    ans.run(cid, "shadow_quarantine", "derived", JSON.stringify({ candidate: true }));
  }
  return emailId;
}

function setup(accounts: AccountConfig[], opts: { forceDryRun?: boolean; limit?: number; fail?: () => ImapWriteError | undefined } = {}) {
  const db = openDatabase(":memory:");
  syncAccounts(db, accounts);
  const dir = mkdtempSync(join(tmpdir(), "ma-"));
  const killSwitchFile = join(dir, "auto-actions.disabled");
  const fake = fakePort(opts.fail);
  let now = T0;
  const factoryCalls: string[] = [];
  const actions = createMailboxActions({
    db, accounts, killSwitchFile,
    ...(opts.forceDryRun ? { forceDryRun: true } : {}),
    ...(opts.limit !== undefined ? { dailyLimit: opts.limit } : {}),
    now: () => now,
    writePortFor: (id) => { factoryCalls.push(id); return fake.port; },
  });
  return {
    db, actions, killSwitchFile, calls: fake.calls, factoryCalls,
    setNow: (d: Date) => { now = d; },
    kill: () => writeFileSync(killSwitchFile, ""),
  };
}
const rows = (db: DatabaseSync) => db.prepare("SELECT id, email_id, rule, action, mode, status, failure_code, reason_json FROM mailbox_actions ORDER BY id").all().map((r) => ({ ...r }));
const seenOf = (db: DatabaseSync, id: number) => (db.prepare("SELECT seen FROM email_status WHERE email_id = ?").get(id) as { seen: number } | undefined)?.seen;
const audits = (db: DatabaseSync) => db.prepare("SELECT actor, action, account_id, email_id, details_json FROM audit_log WHERE action = 'mailbox_action' ORDER BY id").all().map((r) => ({ ...r }));

describe("dry run is the default (H18)", () => {
  test("an account without auto_actions plans the action and never touches IMAP", async () => {
    const t = setup([account("a", undefined)]);
    const id = addMail(t.db, "a");
    const r = await t.actions.evaluate(id);
    assert.equal(r.outcome, "planned");
    assert.deepEqual(rows(t.db).map((x) => [x.rule, x.action, x.mode, x.status, x.failure_code]), [["spam_seen", "mark_seen", "dry_run", "planned", null]]);
    assert.deepEqual(t.calls, []);
    assert.deepEqual(t.factoryCalls, [], "no write port is even created in dry run");
    assert.equal(seenOf(t.db, id), undefined, "the app status is untouched");
  });

  test("audit and action rows carry ids and codes only, never subject or sender", async () => {
    const t = setup([account("a", "dry_run")]);
    const id = addMail(t.db, "a");
    await t.actions.evaluate(id);
    const a = audits(t.db);
    assert.equal(a.length, 1);
    assert.equal(a[0].actor, "system");
    assert.equal(a[0].email_id, id);
    const dump = JSON.stringify([rows(t.db), a, t.db.prepare("SELECT * FROM audit_log").all()]);
    assert.ok(!dump.includes(SUBJECT) && !dump.includes(SENDER) && !dump.includes("secret.example"));
    assert.deepEqual(Object.keys(JSON.parse(a[0].details_json as string)).sort(), ["action", "action_id", "mode", "rule", "status"]);
  });

  test("mode off, an unknown account and a disabled account do nothing", async () => {
    const t = setup([account("off", "off"), account("dis", "live", { enabled: false })]);
    const ids = [addMail(t.db, "off"), addMail(t.db, "dis")];
    for (const id of ids) assert.equal((await t.actions.evaluate(id)).outcome, "off");
    assert.deepEqual(rows(t.db), []);
    const stray = setup([]);
    syncAccounts(stray.db, [account("ghost", "live")]);
    assert.equal((await stray.actions.evaluate(addMail(stray.db, "ghost"))).outcome, "off");
  });

  test("synthetic mode: the engine runs but the mode is always dry_run, even for a live config", async () => {
    const t = setup([account("a", "live")], { forceDryRun: true });
    const id = addMail(t.db, "a");
    assert.equal((await t.actions.evaluate(id)).outcome, "planned");
    assert.equal(rows(t.db)[0].mode, "dry_run");
    assert.deepEqual(t.factoryCalls, []);
    // accounts that are not in any file (hf-* in the synthetic database) are planned too
    const s = setup([], { forceDryRun: true });
    syncAccounts(s.db, [account("hf-x", undefined, { enabled: false })]);
    assert.equal((await s.actions.evaluate(addMail(s.db, "hf-x", { folder: "Junk", spam: null }))).outcome, "planned");
    assert.deepEqual(s.factoryCalls, []);
  });
});

describe("live mode", () => {
  test("marks the mail read through the write port with the stored location, then records it", async () => {
    const t = setup([account("a", "live")]);
    const id = addMail(t.db, "a", { uidValidity: 9 });
    const uid = (t.db.prepare("SELECT uid FROM email_locations WHERE email_id = ?").get(id) as { uid: number }).uid;
    const r = await t.actions.evaluate(id);
    assert.equal(r.outcome, "done");
    assert.deepEqual(t.calls, [{ fn: "addSeen", folder: "INBOX", uidValidity: 9, uid }]);
    const row = rows(t.db)[0];
    assert.deepEqual([row.mode, row.status, row.failure_code], ["live", "done", null]);
    assert.equal(seenOf(t.db, id), 1);
    assert.equal(audits(t.db).length, 1);
    assert.equal((t.db.prepare("SELECT done_at FROM mailbox_actions").get() as { done_at: string }).done_at, T0.toISOString());
  });

  test("idempotent: a second evaluation or a backfill neither adds a row nor writes again", async () => {
    const t = setup([account("a", "live")]);
    const id = addMail(t.db, "a");
    await t.actions.evaluate(id);
    assert.equal((await t.actions.evaluate(id)).outcome, "exists");
    await t.actions.backfill();
    assert.equal(rows(t.db).length, 1);
    assert.equal(t.calls.length, 1);
  });

  test("a rejected store (false from imapflow) is recorded as failed with its code and is not retried", async () => {
    const t = setup([account("a", "live")], { fail: () => new ImapWriteError("store_rejected") });
    const id = addMail(t.db, "a");
    const r = await t.actions.evaluate(id);
    assert.deepEqual(r, { outcome: "failed", code: "store_rejected" });
    assert.deepEqual([rows(t.db)[0].status, rows(t.db)[0].failure_code], ["failed", "store_rejected"]);
    assert.equal(seenOf(t.db, id), undefined, "the app does not claim the mail is read");
    await t.actions.evaluate(id);
    await t.actions.backfill();
    assert.equal(t.calls.length, 1);
  });

  test("a changed UIDVALIDITY is recorded as failed, nothing else", async () => {
    const t = setup([account("a", "live")], { fail: () => new ImapWriteError("uidvalidity_changed") });
    const id = addMail(t.db, "a");
    assert.deepEqual(await t.actions.evaluate(id), { outcome: "failed", code: "uidvalidity_changed" });
    assert.equal(rows(t.db)[0].failure_code, "uidvalidity_changed");
  });

  test("an unexpected error becomes imap_error, never its message", async () => {
    const t = setup([account("a", "live")], { fail: () => { throw new Error("secret server text"); } });
    const id = addMail(t.db, "a");
    assert.deepEqual(await t.actions.evaluate(id), { outcome: "failed", code: "imap_error" });
    assert.ok(!JSON.stringify(t.db.prepare("SELECT * FROM audit_log").all()).includes("secret server text"));
  });

  test("a mail in the provider spam folder is marked read at its current location", async () => {
    const t = setup([account("a", "live")]);
    const id = addMail(t.db, "a", { folder: "Junk", spam: null, category: null });
    assert.equal((await t.actions.evaluate(id)).outcome, "done");
    assert.equal(t.calls[0].folder, "Junk");
    assert.match(rows(t.db)[0].reason_json as string, /provider_spam/);
  });
});

describe("rules in the executor", () => {
  test("protected categories, read mails, low spam and unclassified mails get no row and no write", async () => {
    const t = setup([account("a", "live")]);
    const mails = [
      addMail(t.db, "a", { spam: 0.999, category: "security_auth" }),
      addMail(t.db, "a", { spam: 0.999, category: "transactional", folder: "Junk" }),
      addMail(t.db, "a", { seen: true }),
      addMail(t.db, "a", { spam: 0.1 }),
      addMail(t.db, "a", { classified: false }),
    ];
    const outcomes = [];
    for (const id of mails) outcomes.push((await t.actions.evaluate(id)).outcome);
    assert.deepEqual(outcomes, ["no_action", "no_action", "no_action", "no_action", "not_classified"]);
    assert.deepEqual(rows(t.db), []);
    assert.deepEqual(t.calls, []);
  });

  test("a mail without an active location is skipped", async () => {
    const t = setup([account("a", "live")]);
    const id = addMail(t.db, "a");
    t.db.prepare("UPDATE email_locations SET is_active = 0").run();
    assert.equal((await t.actions.evaluate(id)).outcome, "no_location");
    assert.deepEqual(t.calls, []);
  });

  test("the latest classified run counts", async () => {
    const t = setup([account("a", "dry_run")]);
    const id = addMail(t.db, "a", { spam: 0.1 });
    const c = t.db.prepare("INSERT INTO classifications (email_id, question_set_version, model_requested, model_reported, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
      .run(id, "email-classification-v1", "other-model", "other-model", "classified", T0.toISOString(), T0.toISOString());
    t.db.prepare("INSERT INTO classification_answers (classification_id, question_key, type, answer_json) VALUES (?,?,?,?)")
      .run(Number(c.lastInsertRowid), "is_spam", "noul", JSON.stringify({ value: 0.99 }));
    assert.equal((await t.actions.evaluate(id)).outcome, "planned");
  });
});

describe("kill switch and daily limit (H18)", () => {
  test("the kill switch file stops live writes and new plans, and lifts when removed", async () => {
    const t = setup([account("a", "live"), account("b", "dry_run")]);
    const a = addMail(t.db, "a");
    const b = addMail(t.db, "b");
    t.kill();
    assert.equal((await t.actions.evaluate(a)).outcome, "kill_switch");
    assert.equal((await t.actions.evaluate(b)).outcome, "kill_switch");
    assert.equal((await t.actions.backfill()).killSwitch, true);
    assert.deepEqual(rows(t.db), []);
    assert.deepEqual(t.calls, []);
    const { unlinkSync } = await import("node:fs");
    unlinkSync(t.killSwitchFile);
    assert.equal((await t.actions.evaluate(a)).outcome, "done");
    assert.equal(t.calls.length, 1);
  });

  test("the daily limit per account caps live actions; other accounts and dry runs are unaffected; it resets after 24 h", async () => {
    assert.equal(DAILY_ACTION_LIMIT, 200);
    const t = setup([account("a", "live"), account("b", "live"), account("c", "dry_run")], { limit: 2 });
    const a = [addMail(t.db, "a"), addMail(t.db, "a"), addMail(t.db, "a")];
    const outcomes = [];
    for (const id of a) outcomes.push((await t.actions.evaluate(id)).outcome);
    assert.deepEqual(outcomes, ["done", "done", "limit_reached"]);
    assert.equal(rows(t.db).length, 2);
    assert.equal((await t.actions.evaluate(addMail(t.db, "b"))).outcome, "done");
    for (let i = 0; i < 4; i++) assert.equal((await t.actions.evaluate(addMail(t.db, "c"))).outcome, "planned");
    t.setNow(new Date(T0.getTime() + 25 * 3_600_000));
    assert.equal((await t.actions.evaluate(a[2])).outcome, "done");
    assert.equal(t.calls.filter((c) => c.fn === "addSeen").length, 4);
  });
});

describe("backfill (once at start, bounded)", () => {
  test("plans for existing classified mails, newest first, bounded by the limit and the window", async () => {
    const t = setup([account("a", "dry_run")]);
    const ids = [addMail(t.db, "a"), addMail(t.db, "a"), addMail(t.db, "a"), addMail(t.db, "a", { spam: 0.1 })];
    const old = addMail(t.db, "a");
    t.db.prepare("UPDATE emails SET first_seen_at = ? WHERE id = ?").run(new Date(T0.getTime() - 40 * 86_400_000).toISOString(), old);
    const r = await t.actions.backfill({ limit: 3 });
    assert.equal(r.considered, 3);
    assert.deepEqual(rows(t.db).map((x) => x.email_id), [ids[2], ids[1]], "newest first: the low-spam mail is considered but plans nothing");
    const r2 = await t.actions.backfill();
    assert.equal(r2.considered, 2, "mails with a plan are not considered again; the 40 day old mail is outside the window");
    assert.deepEqual(rows(t.db).map((x) => x.email_id).sort(), [ids[0], ids[1], ids[2]].sort());
  });

  test("switching an account from dry_run to live executes the planned rows at the next backfill", async () => {
    const dry = setup([account("a", "dry_run")]);
    const id = addMail(dry.db, "a");
    await dry.actions.evaluate(id);
    assert.equal(rows(dry.db)[0].mode, "dry_run");
    const fake = fakePort();
    const live = createMailboxActions({
      db: dry.db, accounts: [account("a", "live")], killSwitchFile: dry.killSwitchFile, now: () => T0, writePortFor: () => fake.port,
    });
    const r = await live.backfill();
    assert.equal(r.done, 1);
    assert.equal(fake.calls.length, 1);
    assert.deepEqual(rows(dry.db).map((x) => [x.mode, x.status]), [["live", "done"]]);
  });

  test("a live row left planned (crash) is resumed once; a no longer applicable one is dropped without a write", async () => {
    const t = setup([account("a", "live")]);
    const id = addMail(t.db, "a");
    const loc = (t.db.prepare("SELECT id FROM email_locations WHERE email_id = ?").get(id) as { id: number }).id;
    t.db.prepare("INSERT INTO mailbox_actions (email_id, location_id, rule, action, mode, status, reason_json, created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(id, loc, "spam_seen", "mark_seen", "live", "planned", "{}", T0.toISOString());
    await t.actions.backfill();
    assert.equal(t.calls.length, 1);
    assert.equal(rows(t.db)[0].status, "done");
    const t2 = setup([account("a", "live")]);
    const id2 = addMail(t2.db, "a", { seen: true });
    const loc2 = (t2.db.prepare("SELECT id FROM email_locations WHERE email_id = ?").get(id2) as { id: number }).id;
    t2.db.prepare("INSERT INTO mailbox_actions (email_id, location_id, rule, action, mode, status, reason_json, created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(id2, loc2, "spam_seen", "mark_seen", "live", "planned", "{}", T0.toISOString());
    await t2.actions.backfill();
    assert.deepEqual(t2.calls, []);
    assert.equal(rows(t2.db)[0].status, "undone");
  });
});

describe("undo (H19)", () => {
  test("live: removes \\Seen at the current location, marks the action undone, records the undo, and the rule does not fire again", async () => {
    const t = setup([account("a", "live")]);
    const id = addMail(t.db, "a", { uidValidity: 9 });
    await t.actions.evaluate(id);
    t.calls.length = 0;
    const u = await t.actions.undoSeen(id);
    assert.deepEqual(u, { ok: true, mode: "live" });
    assert.equal(t.calls.length, 1);
    assert.deepEqual([t.calls[0].fn, t.calls[0].folder, t.calls[0].uidValidity], ["removeSeen", "INBOX", 9]);
    assert.equal(seenOf(t.db, id), 0);
    assert.deepEqual(rows(t.db).map((x) => [x.rule, x.action, x.mode, x.status]), [
      ["spam_seen", "mark_seen", "live", "undone"],
      ["undo", "unmark_seen", "live", "done"],
    ]);
    assert.equal(audits(t.db).length, 2);
    assert.equal((await t.actions.evaluate(id)).outcome, "exists");
    await t.actions.backfill();
    assert.equal(t.calls.length, 1, "no second mark_seen");
  });

  test("live: a failing store keeps everything as it was and records a failed undo", async () => {
    let failing = false;
    const t = setup([account("a", "live")], { fail: () => (failing ? new ImapWriteError("store_rejected") : undefined) });
    const id = addMail(t.db, "a");
    await t.actions.evaluate(id);
    failing = true;
    assert.deepEqual(await t.actions.undoSeen(id), { ok: false, code: "store_rejected" });
    assert.equal(seenOf(t.db, id), 1);
    assert.deepEqual(rows(t.db).map((x) => [x.rule, x.status, x.failure_code]), [["spam_seen", "done", null], ["undo", "failed", "store_rejected"]]);
  });

  test("dry run: only the app status changes, no IMAP, the planned row is dropped", async () => {
    const t = setup([account("a", "dry_run")]);
    const id = addMail(t.db, "a", { seen: true });
    t.db.prepare("UPDATE email_status SET seen = 0").run();
    await t.actions.evaluate(id);
    upsertSeen(t.db, id, true, T0.toISOString());
    assert.deepEqual(await t.actions.undoSeen(id), { ok: true, mode: "dry_run" });
    assert.equal(seenOf(t.db, id), 0);
    assert.deepEqual(t.calls, []);
    assert.deepEqual(t.factoryCalls, []);
    assert.deepEqual(rows(t.db).map((x) => [x.rule, x.mode, x.status]), [["spam_seen", "dry_run", "undone"]]);
  });

  test("a mail without an action on a live account: \\Seen is removed and a tombstone stops a later mark", async () => {
    const t = setup([account("a", "live")]);
    const id = addMail(t.db, "a", { seen: true });
    assert.deepEqual(await t.actions.undoSeen(id), { ok: true, mode: "live" });
    assert.equal(t.calls[0].fn, "removeSeen");
    assert.deepEqual(rows(t.db).map((x) => [x.rule, x.status]), [["undo", "done"], ["spam_seen", "undone"]]);
    t.calls.length = 0;
    await t.actions.evaluate(id);
    await t.actions.backfill();
    assert.deepEqual(t.calls, []);
  });

  test("a live action is undone live even after the account was switched back to dry_run", async () => {
    const live = setup([account("a", "live")]);
    const id = addMail(live.db, "a");
    await live.actions.evaluate(id);
    const fake = fakePort();
    const later = createMailboxActions({ db: live.db, accounts: [account("a", "dry_run")], killSwitchFile: live.killSwitchFile, now: () => T0, writePortFor: () => fake.port });
    assert.deepEqual(await later.undoSeen(id), { ok: true, mode: "live" });
    assert.equal(fake.calls[0].fn, "removeSeen");
  });

  test("the kill switch blocks a live undo and changes nothing", async () => {
    const t = setup([account("a", "live")]);
    const id = addMail(t.db, "a");
    await t.actions.evaluate(id);
    t.calls.length = 0;
    t.kill();
    assert.deepEqual(await t.actions.undoSeen(id), { ok: false, code: "kill_switch" });
    assert.deepEqual(t.calls, []);
    assert.equal(seenOf(t.db, id), 1);
    assert.equal(rows(t.db).length, 1);
  });

  test("unknown mail and a live account without credentials fail with a code", async () => {
    const t = setup([account("a", "live")]);
    assert.deepEqual(await t.actions.undoSeen(999), { ok: false, code: "not_found" });
    const bare = createMailboxActions({ db: t.db, accounts: [account("a", "live")], killSwitchFile: t.killSwitchFile, now: () => T0, writePortFor: () => undefined });
    const id = addMail(t.db, "a", { seen: true });
    assert.deepEqual(await bare.undoSeen(id), { ok: false, code: "account_unavailable" });
  });
});

describe("pipeline hook", () => {
  test("onClassified evaluates the mail right after a successful classification", async () => {
    const t = setup([account("a", "dry_run")]);
    const id = addMail(t.db, "a");
    await t.actions.onClassified(id);
    assert.equal(rows(t.db).length, 1);
    await t.actions.onClassified(424242); // unknown mail: swallowed
  });
});

describe("sender rules (M5, H17)", () => {
  test("an allowlisted sender (address or domain) gets no action even at is_spam 0.99 and in the provider spam folder", async () => {
    for (const [match, value] of [["address", SENDER], ["domain", "example.test"]] as const) {
      const t = setup([account("a", "live")]);
      createRule(t.db, { kind: "allowlist", match, value, ts: T0.toISOString() });
      const id = addMail(t.db, "a", { spam: 0.99, folder: "Junk" });
      assert.equal((await t.actions.evaluate(id)).outcome, "no_action", match);
      assert.deepEqual(rows(t.db), []);
      assert.deepEqual(t.calls, []);
    }
  });

  test("an allowlist rule bound to another account does not protect", async () => {
    const t = setup([account("a", "dry_run"), account("b", "dry_run")]);
    createRule(t.db, { kind: "allowlist", match: "domain", value: "example.test", accountId: "b", ts: T0.toISOString() });
    assert.equal((await t.actions.evaluate(addMail(t.db, "a", { spam: 0.99 }))).outcome, "planned");
    assert.equal((await t.actions.evaluate(addMail(t.db, "b", { spam: 0.99 }))).outcome, "no_action");
  });

  test("a blacklisted sender is marked read (reason blacklisted) even when Jev is unsure; live writes only \\Seen", async () => {
    const t = setup([account("a", "live")]);
    createRule(t.db, { kind: "blacklist", match: "address", value: SENDER, ts: T0.toISOString() });
    const id = addMail(t.db, "a", { spam: 0.2, category: "personal" });
    assert.equal((await t.actions.evaluate(id)).outcome, "done");
    assert.deepEqual(t.calls.map((c) => c.fn), ["addSeen"]);
    assert.equal(JSON.parse(rows(t.db)[0].reason_json as string).rule_reason, "blacklisted");
  });

  test("a deactivated rule no longer applies; protected categories still win over the blacklist", async () => {
    const t = setup([account("a", "dry_run")]);
    const r = createRule(t.db, { kind: "blacklist", match: "address", value: SENDER, ts: T0.toISOString() });
    assert.ok(r.ok);
    assert.equal((await t.actions.evaluate(addMail(t.db, "a", { spam: 0.2, category: "security_auth" }))).outcome, "no_action");
    deactivateRule(t.db, r.rule.id, T0.toISOString());
    assert.equal((await t.actions.evaluate(addMail(t.db, "a", { spam: 0.2, category: "personal" }))).outcome, "no_action");
  });
});
