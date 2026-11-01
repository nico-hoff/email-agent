// Executor of automatic mailbox actions (Plan v5, 3.4): rule "Spam gelesen" (\Seen only, M7a), rule "Spam in Quarantäne"
// (INBOX -> Quarantäne, or YOLO: INBOX -> provider trash), the cleanup (Quarantäne -> trash after X days) and their undo
// (ADR 0025, 0038). Moves are real IMAP MOVEs through the write port; nothing is ever deleted permanently.
// The only module that creates the IMAP write port (H16; a test enforces it). Dry run is the default (H18): it records
// `mailbox_actions(status='planned', mode='dry_run')` and never opens a connection. Everything stored is ids and codes.
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { type AccountConfig, type AutoActionMode, autoActionMode } from "./accounts-config.ts";
import { liveActionsLast24h } from "./auto-actions-settings.ts";
import { BACKFILL_LIMIT, BACKFILL_WINDOW_DAYS, DAILY_ACTION_LIMIT } from "./constants.ts";
import { upsertSeen } from "./email-status.ts";
import { createImapWritePort, ImapWriteError, type ImapWritePort, type MoveResult, type MoveTarget } from "./imap-write.ts";
import type { NormalizedAnswer } from "./jev-response.ts";
import { decideQuarantine, decideSpamSeen } from "./mailbox-rules.ts";
import { readQuarantineSettings } from "./quarantine-settings.ts";
import { senderRuleHit } from "./sender-rules.ts";
import { accountUserId } from "./tenant.ts";
import { userStopped } from "./user-settings.ts";

export { DAILY_ACTION_LIMIT };

export interface MailboxActionsOptions {
  db: DatabaseSync;
  /** Accounts file content. An account that is missing here or disabled never gets an action (mode off). */
  accounts: AccountConfig[];
  /**
   * Global kill switch: while this file exists, nothing is planned and nothing is written (also not by undo).
   * Besides it, every user has an emergency stop in the app (user_settings.auto_actions_stopped_at): it stops the same things for
   * that user's accounts. Both are read before every action.
   */
  killSwitchFile: string;
  /** Synthetic dev mode: the mode is dry_run for every account that is not configured `off`, and no port is created. */
  forceDryRun?: boolean;
  dailyLimit?: number;
  now?: () => Date;
  /** Test seam. Default: a port built from the account's connection settings. undefined = not available. */
  writePortFor?: (accountId: string) => ImapWritePort | undefined;
}

export type EvaluateResult =
  | { outcome: "imported" | "planned" | "done" | "exists" | "off" | "kill_switch" | "no_action" | "not_classified" | "no_location" | "limit_reached" | "not_found" | "user_stop" }
  | { outcome: "failed"; code: string };

export type UndoResult = { ok: true; mode: "dry_run" | "live" } | { ok: false; code: string };

export interface CleanupResult {
  considered: number;
  planned: number;
  done: number;
  failed: number;
  limitReached: boolean;
  killSwitch: boolean;
}

/** The folder "Quarantäne" under whatever delimiter or namespace prefix the server uses. */
export const isQuarantineFolder = (folder: string): boolean => /(^|[^\p{L}\p{N}])Quarantäne$/u.test(folder);

export interface BackfillResult {
  considered: number;
  planned: number;
  done: number;
  failed: number;
  killSwitch: boolean;
}

export interface MailboxActions {
  /** Applies the rule to one classified mail. Idempotent per mail and rule. */
  evaluate(emailId: number): Promise<EvaluateResult>;
  /** Pipeline hook: evaluate, swallow every error (a rule problem must never break classification). */
  onClassified(emailId: number): Promise<void>;
  /** One bounded pass over already classified mails (start-up). Also executes dry-run rows of accounts now `live`. */
  backfill(o?: { limit?: number }): Promise<BackfillResult>;
  /** "Wieder ungelesen": live accounts remove \Seen on the server, dry-run accounts change the app status only. */
  undoSeen(userId: number, emailId: number): Promise<UndoResult>;
  /** Rule "Spam in Quarantäne" (or YOLO: straight to the trash) for one classified mail. Idempotent per mail. */
  evaluateQuarantine(emailId: number): Promise<EvaluateResult>;
  /** Moves mails that sat in Quarantäne for the account's number of days to the provider trash (planned in dry run). */
  cleanup(o?: { limit?: number }): Promise<CleanupResult>;
  /** Undo of one quarantine/trash action of the user: moves the mail back to the INBOX (live) or drops the plan (dry run). */
  undoMove(userId: number, actionId: number): Promise<UndoResult>;
}

interface ActionRow { id: number; mode: "dry_run" | "live"; status: string; reason_json: string }
interface LocationRow { id: number; folder: string; uid_validity: number; uid: number }

export function createMailboxActions(opts: MailboxActionsOptions): MailboxActions {
  const { db } = opts;
  const now = opts.now ?? (() => new Date());
  const dailyLimit = opts.dailyLimit ?? DAILY_ACTION_LIMIT;
  const writePortFor = opts.writePortFor ?? ((id: string) => {
    const a = opts.accounts.find((x) => x.id === id);
    return a ? createImapWritePort({ host: a.host, port: a.port, tls: a.tls, user: a.user, password: a.password }) : undefined;
  });

  const killed = () => existsSync(opts.killSwitchFile);
  /** The per-user emergency stop of the account's owner; unreadable = stopped. */
  const stoppedFor = (accountId: string): boolean => {
    try {
      return userStopped(db, accountUserId(db, accountId));
    } catch {
      return true;
    }
  };

  function modeFor(accountId: string): AutoActionMode {
    const a = opts.accounts.find((x) => x.id === accountId);
    if (opts.forceDryRun) return a && autoActionMode(a, "spam_seen") === "off" ? "off" : "dry_run";
    if (!a || !a.enabled) return "off";
    return autoActionMode(a, "spam_seen");
  }

  function audit(row: { id: number; rule: string; action: string; mode: string; status: string; failureCode?: string | null }, accountId: string, emailId: number, ts: string): void {
    db.prepare(
      `INSERT INTO audit_log (occurred_at, trace_id, actor, action, account_id, email_id, details_json)
       VALUES (?, ?, 'system', 'mailbox_action', ?, ?, ?)`,
    ).run(ts, randomUUID(), accountId, emailId, JSON.stringify({
      action_id: row.id, rule: row.rule, action: row.action, mode: row.mode, status: row.status,
      ...(row.failureCode ? { failure_code: row.failureCode } : {}),
    }));
  }

  const activeLocation = (emailId: number): LocationRow | undefined =>
    db.prepare("SELECT id, folder, uid_validity, uid FROM email_locations WHERE email_id = ? AND is_active = 1 ORDER BY id DESC LIMIT 1")
      .get(emailId) as LocationRow | undefined;

  const existingAction = (emailId: number): ActionRow | undefined =>
    db.prepare("SELECT id, mode, status, reason_json FROM mailbox_actions WHERE email_id = ? AND rule = 'spam_seen'")
      .get(emailId) as ActionRow | undefined;

  function latestAnswers(emailId: number): { answers: NormalizedAnswer[]; version: string; model: string } | undefined {
    const c = db.prepare(
      "SELECT id, question_set_version, model_requested FROM classifications WHERE email_id = ? AND status = 'classified' ORDER BY id DESC LIMIT 1",
    ).get(emailId) as { id: number; question_set_version: string; model_requested: string } | undefined;
    if (!c) return undefined;
    const answers: NormalizedAnswer[] = [];
    const rows = db.prepare("SELECT question_key, type, answer_json FROM classification_answers WHERE classification_id = ?")
      .all(c.id) as { question_key: string; type: string; answer_json: string }[];
    for (const r of rows) {
      if (r.type !== "noul" && r.type !== "choice" && r.type !== "score") continue; // derived rows are not Jev answers
      try {
        const v = (JSON.parse(r.answer_json) as { value?: unknown }).value;
        if (typeof v === "number" || typeof v === "string") answers.push({ key: r.question_key, type: r.type, value: v });
      } catch {
        // an unreadable answer counts as missing (fail-closed)
      }
    }
    return { answers, version: c.question_set_version, model: c.model_requested };
  }

  /** Live write for an existing action row; records the result. */
  async function execute(actionId: number, emailId: number, accountId: string, loc: LocationRow): Promise<EvaluateResult> {
    let code: string | null = null;
    const port = writePortFor(accountId);
    if (!port) code = "account_unavailable";
    else {
      try {
        await port.addSeen(loc.folder, loc.uid_validity, loc.uid);
      } catch (e) {
        code = e instanceof ImapWriteError ? e.code : "imap_error";
      }
    }
    const ts = now().toISOString();
    db.exec("BEGIN");
    try {
      if (code === null) {
        db.prepare("UPDATE mailbox_actions SET status = 'done', failure_code = NULL, done_at = ? WHERE id = ?").run(ts, actionId);
        upsertSeen(db, emailId, true, ts);
      } else {
        db.prepare("UPDATE mailbox_actions SET status = 'failed', failure_code = ?, done_at = ? WHERE id = ?").run(code, ts, actionId);
      }
      audit({ id: actionId, rule: "spam_seen", action: "mark_seen", mode: "live", status: code === null ? "done" : "failed", failureCode: code }, accountId, emailId, ts);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    return code === null ? { outcome: "done" } : { outcome: "failed", code };
  }

  async function evaluateNow(emailId: number): Promise<EvaluateResult> {
    const mail = db.prepare("SELECT account_id, sender, origin FROM emails WHERE id = ?").get(emailId) as { account_id: string; sender: string; origin: string } | undefined;
    if (!mail) return { outcome: "not_found" };
    // Initial import (ADR 0043): old mails are only classified, never acted on, in no mode.
    if (mail.origin === "import") return { outcome: "imported" };
    const accountId = mail.account_id;
    const mode = modeFor(accountId);
    if (mode === "off") return { outcome: "off" };
    if (killed()) return { outcome: "kill_switch" };
    if (stoppedFor(accountId)) return { outcome: "user_stop" };

    const existing = existingAction(emailId);
    // A finished, failed or undone row is final; a planned row is only picked up again once the account is live
    // (go-live upgrade of a dry-run row, resume of a live row that never finished).
    if (existing && !(existing.status === "planned" && mode === "live")) return { outcome: "exists" };

    const loc = activeLocation(emailId);
    if (!loc) return { outcome: "no_location" };
    const cls = latestAnswers(emailId);
    if (!cls) return { outcome: "not_classified" };
    const acct = db.prepare("SELECT spam_mailbox FROM accounts WHERE id = ?").get(accountId) as { spam_mailbox: string | null } | undefined;
    const seen = (db.prepare("SELECT seen FROM email_status WHERE email_id = ?").get(emailId) as { seen: number } | undefined)?.seen === 1;
    const decision = decideSpamSeen({
      answers: cls.answers,
      questionSetVersion: cls.version,
      model: cls.model,
      inProviderSpam: acct?.spam_mailbox != null && acct.spam_mailbox === loc.folder,
      seen,
      ...senderRuleHit(db, accountUserId(db, accountId), mail.sender, accountId),
    });
    const ts = now();

    if (decision.action === "none") {
      // a planned row that no longer applies (the mail was read or reclassified since): drop it without writing
      if (existing) db.prepare("UPDATE mailbox_actions SET status = 'undone', done_at = ? WHERE id = ?").run(ts.toISOString(), existing.id);
      return { outcome: "no_action" };
    }

    if (mode === "dry_run") {
      const reason = JSON.stringify({ rule_reason: decision.reason, question_set_version: cls.version });
      db.exec("BEGIN");
      try {
        const res = db.prepare(
          `INSERT OR IGNORE INTO mailbox_actions (email_id, location_id, rule, action, mode, status, reason_json, created_at)
           VALUES (?, ?, 'spam_seen', 'mark_seen', 'dry_run', 'planned', ?, ?)`,
        ).run(emailId, loc.id, reason, ts.toISOString());
        if (Number(res.changes) === 0) {
          db.exec("ROLLBACK");
          return { outcome: "exists" };
        }
        audit({ id: Number(res.lastInsertRowid), rule: "spam_seen", action: "mark_seen", mode: "dry_run", status: "planned" }, accountId, emailId, ts.toISOString());
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      return { outcome: "planned" };
    }

    // live
    if (liveActionsLast24h(db, accountId, ts) >= dailyLimit) return { outcome: "limit_reached" };
    let actionId: number;
    const reason = JSON.stringify({ rule_reason: decision.reason, question_set_version: cls.version });
    if (existing) {
      // upgrade of a dry-run row or resume of a live row that never finished; created_at restarts the daily window
      db.prepare("UPDATE mailbox_actions SET mode = 'live', location_id = ?, reason_json = ?, created_at = ? WHERE id = ?")
        .run(loc.id, reason, ts.toISOString(), existing.id);
      actionId = existing.id;
    } else {
      const res = db.prepare(
        `INSERT OR IGNORE INTO mailbox_actions (email_id, location_id, rule, action, mode, status, reason_json, created_at)
         VALUES (?, ?, 'spam_seen', 'mark_seen', 'live', 'planned', ?, ?)`,
      ).run(emailId, loc.id, reason, ts.toISOString());
      if (Number(res.changes) === 0) return { outcome: "exists" };
      actionId = Number(res.lastInsertRowid);
    }
    return execute(actionId, emailId, accountId, loc);
  }

  async function undoNow(userId: number, emailId: number): Promise<UndoResult> {
    // Tenant scope: a foreign mail is "not_found" (ADR 0033).
    const mail = db.prepare("SELECT e.account_id FROM emails e JOIN accounts a ON a.id = e.account_id WHERE e.id = ? AND a.user_id = ?")
      .get(emailId, userId) as { account_id: string } | undefined;
    if (!mail) return { ok: false, code: "not_found" };
    const accountId = mail.account_id;
    const row = existingAction(emailId);
    const liveUndo = (row?.mode === "live" && row.status === "done") || modeFor(accountId) === "live";
    const ts = now().toISOString();

    if (!liveUndo) {
      db.exec("BEGIN");
      try {
        upsertSeen(db, emailId, false, ts);
        if (row) {
          if (row.status === "planned") db.prepare("UPDATE mailbox_actions SET status = 'undone', done_at = ? WHERE id = ?").run(ts, row.id);
        } else {
          tombstone(emailId, "dry_run", ts);
        }
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      return { ok: true, mode: "dry_run" };
    }

    if (killed()) return { ok: false, code: "kill_switch" };
    if (stoppedFor(accountId)) return { ok: false, code: "user_stop" };
    const loc = activeLocation(emailId);
    if (!loc) return { ok: false, code: "no_location" };
    const port = writePortFor(accountId);
    if (!port) return { ok: false, code: "account_unavailable" };
    let code: string | null = null;
    try {
      await port.removeSeen(loc.folder, loc.uid_validity, loc.uid);
    } catch (e) {
      code = e instanceof ImapWriteError ? e.code : "imap_error";
    }
    db.exec("BEGIN");
    try {
      const res = db.prepare(
        `INSERT INTO mailbox_actions (email_id, location_id, rule, action, mode, status, failure_code, reason_json, created_at, done_at)
         VALUES (?, ?, 'undo', 'unmark_seen', 'live', ?, ?, '{}', ?, ?)`,
      ).run(emailId, loc.id, code === null ? "done" : "failed", code, ts, ts);
      audit({ id: Number(res.lastInsertRowid), rule: "undo", action: "unmark_seen", mode: "live", status: code === null ? "done" : "failed", failureCode: code }, accountId, emailId, ts);
      if (code === null) {
        upsertSeen(db, emailId, false, ts);
        if (row) db.prepare("UPDATE mailbox_actions SET status = 'undone', done_at = ? WHERE id = ?").run(ts, row.id);
        else tombstone(emailId, "live", ts);
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    return code === null ? { ok: true, mode: "live" } : { ok: false, code };
  }


  // ---- Rule "Spam in Quarantäne", YOLO, cleanup and their undo (ADR 0025 Teil 2, ADR 0038) -------------------------------

  /** Mode of the move rules: the stored setting of the account, never above what the account can do (needs a running account). */
  function quarantineModeFor(accountId: string): AutoActionMode {
    const s = readQuarantineSettings(db, accountId);
    if (!s || s.mode === "off") return "off";
    if (opts.forceDryRun) return "dry_run";
    const a = opts.accounts.find((x) => x.id === accountId);
    return a && a.enabled ? s.mode : "off";
  }

  const inboxOf = (accountId: string): string =>
    (db.prepare("SELECT mailbox FROM accounts WHERE id = ?").get(accountId) as { mailbox: string } | undefined)?.mailbox ?? "INBOX";

  const MOVE_TARGET: ReadonlyMap<string, MoveTarget> = new Map([["move_quarantine", "quarantine"], ["move_trash", "trash"], ["move_inbox", "inbox"]]);

  /** Moves the active location of the record to the result of a confirmed move (old one inactive, new one active). */
  function relocate(emailId: number, accountId: string, from: LocationRow, res: MoveResult, ts: string): void {
    db.prepare("UPDATE email_locations SET is_active = 0 WHERE email_id = ? AND is_active = 1").run(emailId);
    if (res.uid !== undefined && res.uidValidity !== undefined) {
      const same = db.prepare("SELECT id, email_id FROM email_locations WHERE account_id = ? AND folder = ? AND uid_validity = ? AND uid = ?")
        .get(accountId, res.folder, res.uidValidity, res.uid) as { id: number; email_id: number } | undefined;
      if (same) {
        if (same.email_id === emailId) db.prepare("UPDATE email_locations SET is_active = 1, last_seen_at = ? WHERE id = ?").run(ts, same.id);
      } else {
        db.prepare(
          `INSERT INTO email_locations (email_id, account_id, folder, uid_validity, uid, is_active, first_seen_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
        ).run(emailId, accountId, res.folder, res.uidValidity, res.uid, ts, ts);
      }
    }
    db.prepare(
      `INSERT INTO audit_log (occurred_at, trace_id, actor, action, account_id, email_id, details_json)
       VALUES (?, ?, 'system', 'folder_changed', ?, ?, ?)`,
    ).run(ts, randomUUID(), accountId, emailId, JSON.stringify({ from: from.folder, to: res.folder }));
  }

  /** One real move through the write port. Returns the code (null = confirmed) and the new location. */
  async function runMove(accountId: string, loc: LocationRow, action: string): Promise<{ code: string | null; res?: MoveResult }> {
    const target = MOVE_TARGET.get(action);
    const port = writePortFor(accountId);
    if (!target) return { code: "invalid_target" };
    if (!port) return { code: "account_unavailable" };
    try {
      const res = await port.moveMessage({ folder: loc.folder, uidValidity: loc.uid_validity, uid: loc.uid, target, inboxFolder: inboxOf(accountId) });
      return { code: null, res };
    } catch (e) {
      return { code: e instanceof ImapWriteError ? e.code : "imap_error" };
    }
  }

  /** Live move for an existing action row (rule quarantine or purge); records the result and the new location. */
  async function executeMove(actionId: number, rule: string, action: string, emailId: number, accountId: string, loc: LocationRow): Promise<EvaluateResult> {
    const r = await runMove(accountId, loc, action);
    const ts = now().toISOString();
    db.exec("BEGIN");
    try {
      if (r.code === null && r.res) {
        db.prepare("UPDATE mailbox_actions SET status = 'done', failure_code = NULL, done_at = ? WHERE id = ?").run(ts, actionId);
        relocate(emailId, accountId, loc, r.res, ts);
      } else {
        db.prepare("UPDATE mailbox_actions SET status = 'failed', failure_code = ?, done_at = ? WHERE id = ?").run(r.code ?? "imap_error", ts, actionId);
      }
      audit({ id: actionId, rule, action, mode: "live", status: r.code === null ? "done" : "failed", failureCode: r.code }, accountId, emailId, ts);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    return r.code === null ? { outcome: "done" } : { outcome: "failed", code: r.code };
  }

  /** Plans (dry run) or performs (live) one move action; shared by the quarantine rule and the cleanup. */
  async function planOrMove(
    o: { emailId: number; accountId: string; loc: LocationRow; rule: "quarantine" | "purge"; action: "move_quarantine" | "move_trash"; mode: AutoActionMode; reason: Record<string, unknown>; existing?: { id: number; rule: string } | undefined },
  ): Promise<EvaluateResult> {
    const ts = now();
    const reason = JSON.stringify(o.reason);
    if (o.mode === "dry_run") {
      if (o.existing) {
        db.prepare("UPDATE mailbox_actions SET rule = ?, action = ?, reason_json = ? WHERE id = ? AND status = 'planned'").run(o.rule, o.action, reason, o.existing.id);
        return { outcome: "exists" };
      }
      db.exec("BEGIN");
      try {
        const res = db.prepare(
          `INSERT OR IGNORE INTO mailbox_actions (email_id, location_id, rule, action, mode, status, reason_json, created_at)
           VALUES (?, ?, ?, ?, 'dry_run', 'planned', ?, ?)`,
        ).run(o.emailId, o.loc.id, o.rule, o.action, reason, ts.toISOString());
        if (Number(res.changes) === 0) {
          db.exec("ROLLBACK");
          return { outcome: "exists" };
        }
        audit({ id: Number(res.lastInsertRowid), rule: o.rule, action: o.action, mode: "dry_run", status: "planned" }, o.accountId, o.emailId, ts.toISOString());
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      return { outcome: "planned" };
    }
    if (liveActionsLast24h(db, o.accountId, ts) >= dailyLimit) return { outcome: "limit_reached" };
    let actionId: number;
    if (o.existing) {
      db.prepare("UPDATE mailbox_actions SET mode = 'live', rule = ?, action = ?, location_id = ?, reason_json = ?, created_at = ? WHERE id = ?")
        .run(o.rule, o.action, o.loc.id, reason, ts.toISOString(), o.existing.id);
      actionId = o.existing.id;
    } else {
      const res = db.prepare(
        `INSERT OR IGNORE INTO mailbox_actions (email_id, location_id, rule, action, mode, status, reason_json, created_at)
         VALUES (?, ?, ?, ?, 'live', 'planned', ?, ?)`,
      ).run(o.emailId, o.loc.id, o.rule, o.action, reason, ts.toISOString());
      if (Number(res.changes) === 0) return { outcome: "exists" };
      actionId = Number(res.lastInsertRowid);
    }
    return executeMove(actionId, o.rule, o.action, o.emailId, o.accountId, o.loc);
  }

  const moveRow = (emailId: number, rule: "quarantine" | "purge"): { id: number; rule: string; mode: string; status: string; done_at: string | null } | undefined =>
    db.prepare("SELECT id, rule, mode, status, done_at FROM mailbox_actions WHERE email_id = ? AND rule = ?").get(emailId, rule) as
      { id: number; rule: string; mode: string; status: string; done_at: string | null } | undefined;

  async function evaluateQuarantineNow(emailId: number): Promise<EvaluateResult> {
    const mail = db.prepare("SELECT account_id, sender, origin FROM emails WHERE id = ?").get(emailId) as { account_id: string; sender: string; origin: string } | undefined;
    if (!mail) return { outcome: "not_found" };
    if (mail.origin === "import") return { outcome: "imported" }; // ADR 0043: old mails are only classified, never acted on
    const accountId = mail.account_id;
    const mode = quarantineModeFor(accountId);
    if (mode === "off") return { outcome: "off" };
    if (killed()) return { outcome: "kill_switch" };
    if (stoppedFor(accountId)) return { outcome: "user_stop" };

    // one move row per mail: a finished, failed or undone row is final
    const existing = moveRow(emailId, "quarantine") ?? moveRow(emailId, "purge");
    // (a planned row is evaluated again: it follows the YOLO switch, or is dropped when the mail no longer qualifies)
    if (existing && existing.status !== "planned") return { outcome: "exists" };
    const loc = activeLocation(emailId);
    if (!loc) return { outcome: "no_location" };
    const cls = latestAnswers(emailId);
    if (!cls) return { outcome: "not_classified" };
    const acct = db.prepare("SELECT mailbox FROM accounts WHERE id = ?").get(accountId) as { mailbox: string } | undefined;
    const decision = decideQuarantine({
      answers: cls.answers,
      questionSetVersion: cls.version,
      model: cls.model,
      inInbox: acct !== undefined && acct.mailbox === loc.folder,
      ...senderRuleHit(db, accountUserId(db, accountId), mail.sender, accountId),
    });
    if (decision.action === "none") {
      if (existing && existing.status === "planned") db.prepare("UPDATE mailbox_actions SET status = 'undone', done_at = ? WHERE id = ?").run(now().toISOString(), existing.id);
      return { outcome: "no_action" };
    }
    const yolo = readQuarantineSettings(db, accountId)?.yolo === true;
    const reason: Record<string, unknown> = { rule_reason: decision.reason, question_set_version: cls.version, ...(yolo ? { yolo: true } : {}) };
    return planOrMove({
      emailId, accountId, loc, mode, reason, existing,
      rule: yolo ? "purge" : "quarantine", action: yolo ? "move_trash" : "move_quarantine",
    });
  }

  async function cleanupNow(limit: number): Promise<CleanupResult> {
    const out: CleanupResult = { considered: 0, planned: 0, done: 0, failed: 0, limitReached: false, killSwitch: false };
    if (killed()) return { ...out, killSwitch: true };
    const accountIds = (db.prepare("SELECT account_id FROM mail_accounts WHERE quarantine_mode <> 'off'").all() as { account_id: string }[]).map((r) => r.account_id);
    for (const accountId of accountIds) {
      const mode = quarantineModeFor(accountId);
      if (mode === "off" || stoppedFor(accountId)) continue;
      const days = readQuarantineSettings(db, accountId)?.days ?? 14;
      const cutoff = new Date(now().getTime() - days * 86_400_000).toISOString();
      const due = db.prepare(
        `SELECT m.email_id, e.sender FROM mailbox_actions m JOIN emails e ON e.id = m.email_id
         WHERE e.account_id = ? AND e.origin = 'live' AND m.rule = 'quarantine' AND m.mode = 'live' AND m.status = 'done' AND m.done_at <= ?
         ORDER BY m.done_at, m.id LIMIT ?`,
      ).all(accountId, cutoff, limit) as { email_id: number; sender: string }[];
      for (const d of due) {
        const purge = moveRow(d.email_id, "purge");
        if (purge && !(purge.status === "planned" && mode === "live")) continue;
        const loc = activeLocation(d.email_id);
        if (!loc || !isQuarantineFolder(loc.folder)) continue; // restored, moved by the person, or location unknown
        // protection first, again: an allowlist entry or a protected category made since then keeps the mail where it is
        const cls = latestAnswers(d.email_id);
        const guard = decideQuarantine({
          answers: cls?.answers ?? [], questionSetVersion: cls?.version ?? "", ...(cls ? { model: cls.model } : {}), inInbox: true,
          ...senderRuleHit(db, accountUserId(db, accountId), d.sender, accountId),
        });
        if (guard.reason === "protected_category" || guard.reason === "allowlisted") continue;
        out.considered++;
        const r = await planOrMove({
          emailId: d.email_id, accountId, loc, mode, existing: purge, rule: "purge", action: "move_trash", reason: { rule_reason: "cleanup", days },
        });
        if (r.outcome === "planned") out.planned++;
        else if (r.outcome === "done") out.done++;
        else if (r.outcome === "failed") out.failed++;
        else if (r.outcome === "limit_reached") {
          out.limitReached = true;
          break;
        }
      }
    }
    return out;
  }

  async function undoMoveNow(userId: number, actionId: number): Promise<UndoResult> {
    const row = db.prepare(
      `SELECT m.id, m.email_id, m.rule, m.mode, m.status, e.account_id FROM mailbox_actions m
       JOIN emails e ON e.id = m.email_id JOIN accounts a ON a.id = e.account_id
       WHERE m.id = ? AND a.user_id = ? AND m.rule IN ('quarantine', 'purge')`,
    ).get(actionId, userId) as { id: number; email_id: number; rule: string; mode: string; status: string; account_id: string } | undefined;
    if (!row) return { ok: false, code: "not_found" };
    const ts = now().toISOString();
    if (row.status === "planned") {
      db.prepare("UPDATE mailbox_actions SET status = 'undone', done_at = ? WHERE id = ?").run(ts, row.id);
      return { ok: true, mode: "dry_run" };
    }
    if (row.status !== "done" || row.mode !== "live") return { ok: false, code: "not_undoable" };

    if (killed()) return { ok: false, code: "kill_switch" };
    if (stoppedFor(row.account_id)) return { ok: false, code: "user_stop" };
    const loc = activeLocation(row.email_id);
    if (!loc) return { ok: false, code: "no_location" };
    if (loc.folder === inboxOf(row.account_id)) return { ok: false, code: "not_undoable" };
    const r = await runMove(row.account_id, loc, "move_inbox");
    db.exec("BEGIN");
    try {
      const ins = db.prepare(
        `INSERT INTO mailbox_actions (email_id, location_id, rule, action, mode, status, failure_code, reason_json, created_at, done_at)
         VALUES (?, ?, 'undo', 'move_inbox', 'live', ?, ?, '{}', ?, ?)`,
      ).run(row.email_id, loc.id, r.code === null ? "done" : "failed", r.code, ts, ts);
      audit({ id: Number(ins.lastInsertRowid), rule: "undo", action: "move_inbox", mode: "live", status: r.code === null ? "done" : "failed", failureCode: r.code }, row.account_id, row.email_id, ts);
      if (r.code === null && r.res) {
        relocate(row.email_id, row.account_id, loc, r.res, ts);
        // the mail is back: every finished move row of it counts as undone (the unique index keeps the rule from moving it again)
        db.prepare("UPDATE mailbox_actions SET status = 'undone', done_at = ? WHERE email_id = ? AND rule IN ('quarantine', 'purge') AND status = 'done'").run(ts, row.email_id);
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    return r.code === null ? { ok: true, mode: "live" } : { ok: false, code: r.code };
  }

  /** Remembers "Nico made this unread": the unique index then keeps the rule from marking the mail read again. */
  function tombstone(emailId: number, mode: "dry_run" | "live", ts: string): void {
    const loc = activeLocation(emailId);
    if (!loc) return;
    db.prepare(
      `INSERT OR IGNORE INTO mailbox_actions (email_id, location_id, rule, action, mode, status, reason_json, created_at, done_at)
       VALUES (?, ?, 'spam_seen', 'mark_seen', ?, 'undone', '{"source":"tombstone"}', ?, ?)`,
    ).run(emailId, loc.id, mode, ts, ts);
  }

  // One queue: writes are serial, so the daily limit and the unique index never race inside this process.
  let chain: Promise<unknown> = Promise.resolve();
  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const p = chain.then(fn);
    chain = p.then(() => {}, () => {});
    return p;
  }

  async function backfillNow(limit: number): Promise<BackfillResult> {
    const out: BackfillResult = { considered: 0, planned: 0, done: 0, failed: 0, killSwitch: false };
    if (killed()) return { ...out, killSwitch: true };
    const liveIds = opts.accounts.filter((a) => modeFor(a.id) === "live").map((a) => a.id);
    const since = new Date(now().getTime() - BACKFILL_WINDOW_DAYS * 86_400_000).toISOString();
    const candidates = db.prepare(
      `SELECT e.id FROM emails e
       WHERE e.first_seen_at >= ? AND e.origin = 'live'
         AND EXISTS (SELECT 1 FROM classifications c WHERE c.email_id = e.id AND c.status = 'classified')
         AND (NOT EXISTS (SELECT 1 FROM mailbox_actions m WHERE m.email_id = e.id AND m.rule = 'spam_seen')
              OR EXISTS (SELECT 1 FROM mailbox_actions m WHERE m.email_id = e.id AND m.rule = 'spam_seen' AND m.status = 'planned'
                         AND (m.mode = 'live' OR e.account_id IN (${liveIds.map(() => "?").join(",")}))))
       ORDER BY e.id DESC LIMIT ?`,
    ).all(since, ...liveIds, limit) as { id: number }[];
    for (const { id } of candidates) {
      out.considered++;
      const r = await evaluateNow(id);
      if (r.outcome === "planned") out.planned++;
      else if (r.outcome === "done") out.done++;
      else if (r.outcome === "failed") out.failed++;
      else if (r.outcome === "kill_switch") return { ...out, killSwitch: true };
    }
    // second rule: quarantine / YOLO
    const qIds = (db.prepare("SELECT account_id FROM mail_accounts WHERE quarantine_mode <> 'off'").all() as { account_id: string }[])
      .map((r) => r.account_id).filter((id) => quarantineModeFor(id) !== "off");
    const qLive = qIds.filter((id) => quarantineModeFor(id) === "live");
    const qCandidates = db.prepare(
      `SELECT e.id FROM emails e
       WHERE e.first_seen_at >= ? AND e.origin = 'live' AND e.account_id IN (${qIds.map(() => "?").join(",")})
         AND EXISTS (SELECT 1 FROM classifications c WHERE c.email_id = e.id AND c.status = 'classified')
         AND (NOT EXISTS (SELECT 1 FROM mailbox_actions m WHERE m.email_id = e.id AND m.rule IN ('quarantine', 'purge'))
              OR EXISTS (SELECT 1 FROM mailbox_actions m WHERE m.email_id = e.id AND m.rule IN ('quarantine', 'purge') AND m.status = 'planned'
                         AND (m.mode = 'live' OR e.account_id IN (${qLive.map(() => "?").join(",")}))))
       ORDER BY e.id DESC LIMIT ?`,
    ).all(since, ...qIds, ...qLive, limit) as { id: number }[];
    for (const { id } of qCandidates) {
      out.considered++;
      const r = await evaluateQuarantineNow(id);
      if (r.outcome === "planned") out.planned++;
      else if (r.outcome === "done") out.done++;
      else if (r.outcome === "failed") out.failed++;
      else if (r.outcome === "kill_switch") return { ...out, killSwitch: true };
    }
    return out;
  }

  return {
    evaluateQuarantine: (emailId) => enqueue(() => evaluateQuarantineNow(emailId)),
    cleanup: (o = {}) => enqueue(() => cleanupNow(o.limit ?? BACKFILL_LIMIT)),
    undoMove: (userId, actionId) => enqueue(() => undoMoveNow(userId, actionId)),
    evaluate: (emailId) => enqueue(() => evaluateNow(emailId)),
    async onClassified(emailId) {
      try {
        await enqueue(() => evaluateNow(emailId));
      } catch {
        // never break the classification pipeline
      }
      try {
        await enqueue(() => evaluateQuarantineNow(emailId));
      } catch {
        // same for the second rule
      }
    },
    backfill: (o = {}) => enqueue(() => backfillNow(o.limit ?? BACKFILL_LIMIT)),
    undoSeen: (userId, emailId) => enqueue(() => undoNow(userId, emailId)),
  };
}
