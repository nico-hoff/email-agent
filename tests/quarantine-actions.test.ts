// R9: rule "Spam in Quarantäne", YOLO, cleanup and undo of moves (ADR 0025 Teil 2, ADR 0038). Offline: fake write port, in-memory DB.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../lib/db.ts";
import { syncAccounts } from "../lib/accounts.ts";
import { ImapWriteError, type ImapWritePort, type MoveRequest } from "../lib/imap-write.ts";
import type { AccountConfig } from "../lib/accounts-config.ts";
import { createMailboxActions, isQuarantineFolder } from "../lib/mailbox-actions.ts";
import { changeQuarantineSettings } from "../lib/quarantine-settings.ts";
import { createRule } from "../lib/sender-rules.ts";
import { setUserStop } from "../lib/user-settings.ts";

const T0 = new Date("2026-10-27T10:00:00.000Z");
const DAY = 86_400_000;
const SUBJECT = "SUBJECT-MARKER-9917";
const SENDER = "sender-marker-9917@example.test";

const account = (id: string, over: Partial<AccountConfig> = {}): AccountConfig => ({
  id, label: id, context: "c", host: "imap.secret.example", port: 993, tls: true, user: "u", password: "p",
  mailbox: "INBOX", spam_mailbox: "Junk", spam_threshold: 0.95, enabled: true, ...over,
}) as AccountConfig;

interface FakeOpts { fail?: (req: MoveRequest) => ImapWriteError | undefined; noCopyUid?: boolean }
function fakePort(o: FakeOpts = {}) {
  const calls: MoveRequest[] = [];
  let uid = 5000;
  const port: ImapWritePort = {
    async addSeen() {},
    async removeSeen() {},
    async moveMessage(req) {
      calls.push({ ...req });
      const e = o.fail?.(req);
      if (e) throw e;
      const folder = req.target === "quarantine" ? "Quarantäne" : req.target === "trash" ? "Trash" : (req.inboxFolder ?? "INBOX");
      return o.noCopyUid ? { folder } : { folder, uidValidity: 900, uid: uid++ };
    },
  };
  return { port, calls };
}

let nextUid = 100;
function addMail(db: DatabaseSync, accountId: string, o: { spam?: number; category?: string; folder?: string; origin?: "live" | "import"; sender?: string } = {}): number {
  const uid = nextUid++;
  const ts = T0.toISOString();
  const e = db.prepare("INSERT INTO emails (account_id, message_id, sender, subject, received_at, first_seen_at, origin) VALUES (?,?,?,?,?,?,?)")
    .run(accountId, `<q${uid}@x>`, o.sender ?? SENDER, SUBJECT, ts, ts, o.origin ?? "live");
  const emailId = Number(e.lastInsertRowid);
  db.prepare("INSERT INTO email_locations (email_id, account_id, folder, uid_validity, uid, first_seen_at, last_seen_at) VALUES (?,?,?,?,?,?,?)")
    .run(emailId, accountId, o.folder ?? "INBOX", 5, uid, ts, ts);
  const c = db.prepare("INSERT INTO classifications (email_id, question_set_version, model_requested, model_reported, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(emailId, "email-classification-v1", "typesafe/jev-1.13", "typesafe/jev-1.13", "classified", ts, ts);
  const cid = Number(c.lastInsertRowid);
  const ans = db.prepare("INSERT INTO classification_answers (classification_id, question_key, type, answer_json) VALUES (?,?,?,?)");
  ans.run(cid, "is_spam", "noul", JSON.stringify({ value: o.spam ?? 0.97 }));
  ans.run(cid, "category", "choice", JSON.stringify({ value: o.category ?? "promotion" }));
  return emailId;
}

function addCredentialsRow(db: DatabaseSync, accountId: string, userId = 1): void {
  const ts = T0.toISOString();
  db.prepare(
    `INSERT INTO mail_accounts (account_id,user_id,type,tls,username,secret_ciphertext,secret_nonce,secret_tag,key_id,secret_set_at,created_at,updated_at)
     VALUES (?,?,'imap',1,'u',x'aa',?,?,?,?,?,?)`,
  ).run(accountId, userId, Buffer.alloc(12), Buffer.alloc(16), "a".repeat(16), ts, ts, ts);
}

function setup(o: { mode?: "off" | "dry_run" | "live"; days?: number; yolo?: boolean; accounts?: AccountConfig[]; limit?: number; forceDryRun?: boolean } & FakeOpts = {}) {
  const accounts = o.accounts ?? [account("a")];
  const db = openDatabase(":memory:");
  syncAccounts(db, accounts);
  for (const a of accounts) addCredentialsRow(db, a.id);
  const mode = o.mode ?? "live";
  if (mode !== "off") {
    const r = changeQuarantineSettings(db, 1, "a", { mode, ...(o.days !== undefined ? { days: o.days } : {}), ...(o.yolo ? { yolo: true } : {}) }, T0);
    assert.ok(r.ok);
  }
  const dir = mkdtempSync(join(tmpdir(), "qa-"));
  const killSwitchFile = join(dir, "auto-actions.disabled");
  const fake = fakePort(o);
  let now = T0;
  const actions = createMailboxActions({
    db, accounts, killSwitchFile, now: () => now,
    ...(o.limit !== undefined ? { dailyLimit: o.limit } : {}),
    ...(o.forceDryRun ? { forceDryRun: true } : {}),
    writePortFor: () => fake.port,
  });
  return { db, actions, calls: fake.calls, killSwitchFile, setNow: (d: Date) => { now = d; }, kill: () => writeFileSync(killSwitchFile, "") };
}
const rows = (db: DatabaseSync) => db.prepare("SELECT id, email_id, rule, action, mode, status, failure_code FROM mailbox_actions ORDER BY id").all().map((r) => ({ ...r }));
const locs = (db: DatabaseSync, emailId: number) => db.prepare("SELECT folder, uid_validity, uid, is_active FROM email_locations WHERE email_id = ? ORDER BY id").all(emailId).map((r) => ({ ...r }));

describe("rule Spam in Quarantäne: planning and moving", () => {
  test("default settings (off): nothing is planned and nothing is created", async () => {
    const t = setup({ mode: "off" });
    const id = addMail(t.db, "a");
    assert.equal((await t.actions.evaluateQuarantine(id)).outcome, "off");
    assert.deepEqual(rows(t.db), []);
    assert.deepEqual(t.calls, []);
  });

  test("dry run plans move_quarantine and never opens a connection", async () => {
    const t = setup({ mode: "dry_run" });
    const id = addMail(t.db, "a");
    assert.equal((await t.actions.evaluateQuarantine(id)).outcome, "planned");
    assert.deepEqual(rows(t.db).map((r) => [r.rule, r.action, r.mode, r.status]), [["quarantine", "move_quarantine", "dry_run", "planned"]]);
    assert.deepEqual(t.calls, []);
    assert.equal((await t.actions.evaluateQuarantine(id)).outcome, "exists");
    assert.equal(rows(t.db).length, 1, "idempotent");
  });

  test("live: moves INBOX -> Quarantäne, records the new location, logs codes only", async () => {
    const t = setup();
    const id = addMail(t.db, "a");
    assert.equal((await t.actions.evaluateQuarantine(id)).outcome, "done");
    assert.equal(t.calls.length, 1);
    assert.deepEqual({ ...t.calls[0], uid: 0 }, { folder: "INBOX", uidValidity: 5, uid: 0, target: "quarantine", inboxFolder: "INBOX" });
    assert.deepEqual(rows(t.db).map((r) => [r.rule, r.action, r.mode, r.status, r.failure_code]), [["quarantine", "move_quarantine", "live", "done", null]]);
    assert.deepEqual(locs(t.db, id).map((l) => [l.folder, l.is_active]), [["INBOX", 0], ["Quarantäne", 1]]);
    assert.deepEqual(locs(t.db, id)[1], { folder: "Quarantäne", uid_validity: 900, uid: 5000, is_active: 1 });
    const dump = JSON.stringify([rows(t.db), t.db.prepare("SELECT * FROM audit_log").all()]);
    assert.ok(!dump.includes(SUBJECT) && !dump.includes(SENDER) && !dump.includes("secret.example"));
  });

  test("YOLO: spam goes straight to the trash with rule purge / move_trash", async () => {
    const t = setup({ yolo: true });
    const id = addMail(t.db, "a");
    assert.equal((await t.actions.evaluateQuarantine(id)).outcome, "done");
    assert.equal(t.calls[0].target, "trash");
    assert.deepEqual(rows(t.db).map((r) => [r.rule, r.action, r.status]), [["purge", "move_trash", "done"]]);
    assert.equal(locs(t.db, id).at(-1)?.folder, "Trash");
  });

  test("YOLO in dry run plans move_trash", async () => {
    const t = setup({ mode: "dry_run", yolo: true });
    await t.actions.evaluateQuarantine(addMail(t.db, "a"));
    assert.deepEqual(rows(t.db).map((r) => [r.rule, r.action, r.mode, r.status]), [["purge", "move_trash", "dry_run", "planned"]]);
  });

  test("a planned row follows the YOLO switch and is upgraded to live", async () => {
    const t = setup({ mode: "dry_run" });
    const id = addMail(t.db, "a");
    await t.actions.evaluateQuarantine(id);
    changeQuarantineSettings(t.db, 1, "a", { yolo: true }, T0);
    await t.actions.evaluateQuarantine(id);
    assert.deepEqual(rows(t.db).map((r) => [r.rule, r.action, r.status]), [["purge", "move_trash", "planned"]]);
    changeQuarantineSettings(t.db, 1, "a", { mode: "live" }, T0);
    assert.equal((await t.actions.evaluateQuarantine(id)).outcome, "done");
    assert.equal(t.calls.length, 1);
  });

  test("protection first: security_auth, transactional, allowlist and a non-spam verdict are never moved", async () => {
    const t = setup();
    const a = addMail(t.db, "a", { category: "security_auth" });
    const b = addMail(t.db, "a", { category: "transactional" });
    const c = addMail(t.db, "a", { sender: "friend@example.test" });
    createRule(t.db, 1, { kind: "allowlist", match: "address", value: "friend@example.test", accountId: null, ts: T0.toISOString() } as never);
    const d = addMail(t.db, "a", { spam: 0.01 });
    for (const id of [a, b, c, d]) assert.equal((await t.actions.evaluateQuarantine(id)).outcome, "no_action");
    assert.deepEqual(t.calls, []);
    assert.deepEqual(rows(t.db), []);
  });

  test("only mails in the INBOX are moved (provider spam folder and others are left alone)", async () => {
    const t = setup();
    assert.equal((await t.actions.evaluateQuarantine(addMail(t.db, "a", { folder: "Junk" }))).outcome, "no_action");
    assert.deepEqual(t.calls, []);
  });

  test("imported mails (origin import) are never acted on, in no mode", async () => {
    for (const mode of ["dry_run", "live"] as const) {
      const t = setup({ mode });
      assert.equal((await t.actions.evaluateQuarantine(addMail(t.db, "a", { origin: "import" }))).outcome, "imported");
      assert.deepEqual(rows(t.db), []);
      assert.deepEqual(t.calls, []);
    }
  });

  test("global stop file, per-user stop and the daily limit", async () => {
    const t = setup({ limit: 1 });
    const [a, b, c] = [addMail(t.db, "a"), addMail(t.db, "a"), addMail(t.db, "a")];
    t.kill();
    assert.equal((await t.actions.evaluateQuarantine(a)).outcome, "kill_switch");
    writeFileSync(t.killSwitchFile, "");
    const t2 = setup({ limit: 1 });
    const [x, y] = [addMail(t2.db, "a"), addMail(t2.db, "a")];
    assert.equal((await t2.actions.evaluateQuarantine(x)).outcome, "done");
    assert.equal((await t2.actions.evaluateQuarantine(y)).outcome, "limit_reached");
    assert.equal(t2.calls.length, 1);
    const t3 = setup();
    setUserStop(t3.db, 1, true, T0);
    assert.equal((await t3.actions.evaluateQuarantine(addMail(t3.db, "a"))).outcome, "user_stop");
    assert.deepEqual(t3.calls, []);
    void [b, c];
  });

  test("an account the app cannot run (missing or disabled) never acts; synthetic mode is always dry run", async () => {
    const t = setup({ accounts: [account("a", { enabled: false })] });
    assert.equal((await t.actions.evaluateQuarantine(addMail(t.db, "a"))).outcome, "off");
    const s = setup({ forceDryRun: true });
    assert.equal((await s.actions.evaluateQuarantine(addMail(s.db, "a"))).outcome, "planned");
    assert.deepEqual(s.calls, []);
  });

  test("a failed move is recorded with its code and never retried", async () => {
    const t = setup({ fail: () => new ImapWriteError("move_unsupported") });
    const id = addMail(t.db, "a");
    assert.deepEqual(await t.actions.evaluateQuarantine(id), { outcome: "failed", code: "move_unsupported" });
    assert.deepEqual(rows(t.db).map((r) => [r.status, r.failure_code]), [["failed", "move_unsupported"]]);
    assert.deepEqual(locs(t.db, id).map((l) => l.is_active), [1], "the location stays where it was");
    assert.equal((await t.actions.evaluateQuarantine(id)).outcome, "exists");
    assert.equal(t.calls.length, 1);
  });

  test("without COPYUID the move is done but the new location is unknown", async () => {
    const t = setup({ noCopyUid: true });
    const id = addMail(t.db, "a");
    assert.equal((await t.actions.evaluateQuarantine(id)).outcome, "done");
    assert.deepEqual(locs(t.db, id).map((l) => l.is_active), [0]);
    assert.equal((await t.actions.undoMove(1, Number(rows(t.db)[0].id))).ok, false);
  });

  test("onClassified runs both rules and swallows errors", async () => {
    const t = setup();
    const id = addMail(t.db, "a");
    await t.actions.onClassified(id);
    assert.deepEqual(rows(t.db).map((r) => r.rule), ["spam_seen", "quarantine"], "the first rule plans (dry run is its default), the move rule acted");
  });

  test("backfill picks up classified mails of accounts with the move rule on", async () => {
    const t = setup({ mode: "dry_run" });
    addMail(t.db, "a");
    const r = await t.actions.backfill();
    assert.equal(r.planned >= 1, true);
    assert.deepEqual(rows(t.db).map((x) => x.rule).sort(), ["quarantine", "spam_seen"]);
  });
});

describe("cleanup: Quarantäne -> provider trash after X days", () => {
  test("moves only after the configured days (fake clock) and records the new location", async () => {
    const t = setup({ days: 3 });
    const id = addMail(t.db, "a");
    await t.actions.evaluateQuarantine(id);
    t.setNow(new Date(T0.getTime() + 2 * DAY));
    assert.equal((await t.actions.cleanup()).considered, 0);
    t.setNow(new Date(T0.getTime() + 3 * DAY + 1000));
    const r = await t.actions.cleanup();
    assert.deepEqual([r.considered, r.done], [1, 1]);
    assert.equal(t.calls.at(-1)?.target, "trash");
    assert.equal(t.calls.at(-1)?.folder, "Quarantäne");
    assert.deepEqual(rows(t.db).map((x) => [x.rule, x.action, x.status]), [["quarantine", "move_quarantine", "done"], ["purge", "move_trash", "done"]]);
    assert.equal(locs(t.db, id).at(-1)?.folder, "Trash");
    assert.equal((await t.actions.cleanup()).considered, 0, "once only");
  });

  test("default is 14 days", async () => {
    const t = setup();
    await t.actions.evaluateQuarantine(addMail(t.db, "a"));
    t.setNow(new Date(T0.getTime() + 13 * DAY));
    assert.equal((await t.actions.cleanup()).considered, 0);
    t.setNow(new Date(T0.getTime() + 14 * DAY + 1000));
    assert.equal((await t.actions.cleanup()).done, 1);
  });

  test("honours stops, limit, mode off, protection added later and a location outside the quarantine", async () => {
    const mk = async (o: Parameters<typeof setup>[0] = {}) => {
      const t = setup({ days: 1, ...o });
      const id = addMail(t.db, "a");
      await t.actions.evaluateQuarantine(id);
      t.setNow(new Date(T0.getTime() + 2 * DAY));
      return { t, id };
    };
    const k = await mk();
    k.t.kill();
    assert.equal((await k.t.actions.cleanup()).killSwitch, true);
    const u = await mk();
    setUserStop(u.t.db, 1, true, T0);
    assert.equal((await u.t.actions.cleanup()).considered, 0);
    const off = await mk();
    off.t.db.prepare("UPDATE mail_accounts SET quarantine_mode = 'off'").run();
    assert.equal((await off.t.actions.cleanup()).considered, 0);
    const lim = await mk({ limit: 1 });
    const other = addMail(lim.t.db, "a");
    const otherLoc = (lim.t.db.prepare("SELECT id FROM email_locations WHERE email_id = ?").get(other) as { id: number }).id;
    lim.t.db.prepare("INSERT INTO mailbox_actions (email_id, location_id, rule, action, mode, status, created_at, done_at) VALUES (?,?,'spam_seen','mark_seen','live','done',?,?)")
      .run(other, otherLoc, new Date(T0.getTime() + 2 * DAY).toISOString(), new Date(T0.getTime() + 2 * DAY).toISOString());
    assert.equal((await lim.t.actions.cleanup()).limitReached, true, "today's actions already used the daily limit");
    const prot = await mk();
    createRule(prot.t.db, 1, { kind: "allowlist", match: "address", value: SENDER, accountId: null, ts: T0.toISOString() } as never);
    assert.equal((await prot.t.actions.cleanup()).considered, 0);
    const back = await mk();
    back.t.db.prepare("UPDATE email_locations SET is_active = 0 WHERE email_id = ?").run(back.id);
    back.t.db.prepare("INSERT INTO email_locations (email_id, account_id, folder, uid_validity, uid, is_active, first_seen_at, last_seen_at) VALUES (?, 'a', 'INBOX', 5, 777, 1, ?, ?)").run(back.id, T0.toISOString(), T0.toISOString());
    assert.equal((await back.t.actions.cleanup()).considered, 0);
    for (const x of [k, u, off, lim, prot, back]) assert.equal(x.t.calls.length, 1, "only the quarantine move itself");
  });

  test("dry-run cleanup only plans a purge", async () => {
    const t = setup({ days: 1 });
    const id = addMail(t.db, "a");
    await t.actions.evaluateQuarantine(id);
    changeQuarantineSettings(t.db, 1, "a", { mode: "dry_run" }, T0);
    t.setNow(new Date(T0.getTime() + 2 * DAY));
    const r = await t.actions.cleanup();
    assert.deepEqual([r.planned, r.done], [1, 0]);
    assert.equal(t.calls.length, 1);
    assert.deepEqual(rows(t.db).at(-1), { ...rows(t.db).at(-1), rule: "purge", mode: "dry_run", status: "planned" });
  });

  test("a failed purge (trash_not_found) is recorded and not retried; nothing is deleted", async () => {
    const t = setup({ days: 1, fail: (r) => (r.target === "trash" ? new ImapWriteError("trash_not_found") : undefined) });
    await t.actions.evaluateQuarantine(addMail(t.db, "a"));
    t.setNow(new Date(T0.getTime() + 2 * DAY));
    assert.equal((await t.actions.cleanup()).failed, 1);
    assert.equal((await t.actions.cleanup()).considered, 0);
    assert.equal(rows(t.db).at(-1)?.failure_code, "trash_not_found");
  });

  test("isQuarantineFolder understands namespace prefixes and delimiters", () => {
    for (const f of ["Quarantäne", "INBOX.Quarantäne", "INBOX/Quarantäne"]) assert.equal(isQuarantineFolder(f), true, f);
    for (const f of ["INBOX", "MyQuarantäne", "Quarantäne2", "Trash"]) assert.equal(isQuarantineFolder(f), false, f);
  });
});

describe("undo of a move", () => {
  test("live: moves the mail back to the INBOX (move_inbox, rule undo) and marks the original undone", async () => {
    const t = setup();
    const id = addMail(t.db, "a");
    await t.actions.evaluateQuarantine(id);
    const actionId = Number(rows(t.db)[0].id);
    assert.deepEqual(await t.actions.undoMove(1, actionId), { ok: true, mode: "live" });
    assert.equal(t.calls.at(-1)?.target, "inbox");
    assert.equal(t.calls.at(-1)?.folder, "Quarantäne");
    assert.deepEqual(rows(t.db).map((r) => [r.rule, r.action, r.status]), [["quarantine", "move_quarantine", "undone"], ["undo", "move_inbox", "done"]]);
    assert.equal(locs(t.db, id).at(-1)?.folder, "INBOX");
    assert.equal(locs(t.db, id).filter((l) => l.is_active === 1).length, 1);
    assert.deepEqual(await t.actions.undoMove(1, actionId), { ok: false, code: "not_undoable" });
    assert.equal((await t.actions.evaluateQuarantine(id)).outcome, "exists", "never moved again");
    assert.equal(t.calls.length, 2);
  });

  test("undo of a trashed mail (purge) brings it back and also closes the quarantine row", async () => {
    const t = setup({ days: 1 });
    const id = addMail(t.db, "a");
    await t.actions.evaluateQuarantine(id);
    t.setNow(new Date(T0.getTime() + 2 * DAY));
    await t.actions.cleanup();
    const purge = rows(t.db).find((r) => r.rule === "purge");
    assert.deepEqual(await t.actions.undoMove(1, Number(purge?.id)), { ok: true, mode: "live" });
    assert.equal(t.calls.at(-1)?.folder, "Trash");
    assert.deepEqual(rows(t.db).filter((r) => r.rule !== "undo").map((r) => r.status), ["undone", "undone"]);
  });

  test("dry run: drops the plan without touching the server, and the rule does not plan it again", async () => {
    const t = setup({ mode: "dry_run" });
    const id = addMail(t.db, "a");
    await t.actions.evaluateQuarantine(id);
    assert.deepEqual(await t.actions.undoMove(1, Number(rows(t.db)[0].id)), { ok: true, mode: "dry_run" });
    assert.deepEqual(rows(t.db).map((r) => r.status), ["undone"]);
    assert.equal((await t.actions.evaluateQuarantine(id)).outcome, "exists");
    assert.deepEqual(t.calls, []);
  });

  test("global stop and per-user stop block the live undo", async () => {
    const t = setup();
    await t.actions.evaluateQuarantine(addMail(t.db, "a"));
    const actionId = Number(rows(t.db)[0].id);
    setUserStop(t.db, 1, true, T0);
    assert.deepEqual(await t.actions.undoMove(1, actionId), { ok: false, code: "user_stop" });
    setUserStop(t.db, 1, false, T0);
    t.kill();
    assert.deepEqual(await t.actions.undoMove(1, actionId), { ok: false, code: "kill_switch" });
    assert.equal(t.calls.length, 1);
  });

  test("a failed undo is recorded and leaves the original untouched", async () => {
    const t = setup({ fail: (r) => (r.target === "inbox" ? new ImapWriteError("uidvalidity_changed") : undefined) });
    await t.actions.evaluateQuarantine(addMail(t.db, "a"));
    assert.deepEqual(await t.actions.undoMove(1, Number(rows(t.db)[0].id)), { ok: false, code: "uidvalidity_changed" });
    assert.deepEqual(rows(t.db).map((r) => [r.rule, r.status, r.failure_code]), [["quarantine", "done", null], ["undo", "failed", "uidvalidity_changed"]]);
  });

  test("tenant isolation: another user's action is not_found and unchanged; the seen rule is not undone here", async () => {
    const t = setup();
    t.db.exec(`INSERT INTO users (id,email,password_hash,role,status,created_at,updated_at) VALUES (2,'u2@x.test','${"h".repeat(40)}','user','active','${T0.toISOString()}','${T0.toISOString()}')`);
    await t.actions.evaluateQuarantine(addMail(t.db, "a"));
    const actionId = Number(rows(t.db)[0].id);
    assert.deepEqual(await t.actions.undoMove(2, actionId), { ok: false, code: "not_found" });
    assert.deepEqual(await t.actions.undoMove(1, 99999), { ok: false, code: "not_found" });
    assert.deepEqual(rows(t.db).map((r) => r.status), ["done"]);
    assert.equal(t.calls.length, 1);
  });
});

describe("safety: the executor only ever moves", () => {
  test("the port interface offers no delete, flag or send; every call in these tests was a move", async () => {
    const t = setup({ days: 1 });
    const id = addMail(t.db, "a");
    await t.actions.evaluateQuarantine(id);
    t.setNow(new Date(T0.getTime() + 2 * DAY));
    await t.actions.cleanup();
    await t.actions.undoMove(1, Number(rows(t.db)[0].id));
    assert.ok(t.calls.every((c) => ["quarantine", "trash", "inbox"].includes(c.target)));
  });
});
