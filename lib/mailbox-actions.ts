// Executor of automatic mailbox actions (Plan v5, 3.4, M7a: rule "Spam gelesen" = \Seen only) and its undo.
// The only module that creates the IMAP write port (H16; a test enforces it). Dry run is the default (H18): it records
// `mailbox_actions(status='planned', mode='dry_run')` and never opens a connection. Everything stored is ids and codes.
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { type AccountConfig, type AutoActionMode, autoActionMode } from "./accounts-config.ts";
import { BACKFILL_LIMIT, BACKFILL_WINDOW_DAYS, DAILY_ACTION_LIMIT } from "./constants.ts";
import { upsertSeen } from "./email-status.ts";
import { createImapWritePort, ImapWriteError, type ImapWritePort } from "./imap-write.ts";
import type { NormalizedAnswer } from "./jev-response.ts";
import { decideSpamSeen } from "./mailbox-rules.ts";
import { senderRuleHit } from "./sender-rules.ts";
import { accountUserId } from "./tenant.ts";

export { DAILY_ACTION_LIMIT };

export interface MailboxActionsOptions {
  db: DatabaseSync;
  /** Accounts file content. An account that is missing here or disabled never gets an action (mode off). */
  accounts: AccountConfig[];
  /** Global kill switch: while this file exists, nothing is planned and nothing is written (also not by undo). */
  killSwitchFile: string;
  /** Synthetic dev mode: the mode is dry_run for every account that is not configured `off`, and no port is created. */
  forceDryRun?: boolean;
  dailyLimit?: number;
  now?: () => Date;
  /** Test seam. Default: a port built from the account's connection settings. undefined = not available. */
  writePortFor?: (accountId: string) => ImapWritePort | undefined;
}

export type EvaluateResult =
  | { outcome: "planned" | "done" | "exists" | "off" | "kill_switch" | "no_action" | "not_classified" | "no_location" | "limit_reached" | "not_found" }
  | { outcome: "failed"; code: string };

export type UndoResult = { ok: true; mode: "dry_run" | "live" } | { ok: false; code: string };

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
}

interface ActionRow { id: number; mode: "dry_run" | "live"; status: string; reason_json: string }
interface LocationRow { id: number; folder: string; uid_validity: number; uid: number }

export function createMailboxActions(opts: MailboxActionsOptions): MailboxActions {
  const { db } = opts;
  const now = opts.now ?? (() => new Date());
  const dailyLimit = opts.dailyLimit ?? DAILY_ACTION_LIMIT;
  const byId = new Map(opts.accounts.map((a) => [a.id, a]));
  const writePortFor = opts.writePortFor ?? ((id: string) => {
    const a = byId.get(id);
    return a ? createImapWritePort({ host: a.host, port: a.port, tls: a.tls, user: a.user, password: a.password }) : undefined;
  });

  const killed = () => existsSync(opts.killSwitchFile);

  function modeFor(accountId: string): AutoActionMode {
    const a = byId.get(accountId);
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

  function latestAnswers(emailId: number): { answers: NormalizedAnswer[]; version: string } | undefined {
    const c = db.prepare(
      "SELECT id, question_set_version FROM classifications WHERE email_id = ? AND status = 'classified' ORDER BY id DESC LIMIT 1",
    ).get(emailId) as { id: number; question_set_version: string } | undefined;
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
    return { answers, version: c.question_set_version };
  }

  function liveCountToday(accountId: string, ts: Date): number {
    const since = new Date(ts.getTime() - 86_400_000).toISOString();
    return (db.prepare(
      `SELECT COUNT(*) AS n FROM mailbox_actions m JOIN emails e ON e.id = m.email_id
       WHERE e.account_id = ? AND m.mode = 'live' AND m.rule <> 'undo' AND m.created_at >= ?
         AND COALESCE(json_extract(m.reason_json, '$.source'), '') <> 'tombstone'`,
    ).get(accountId, since) as { n: number }).n;
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
    const mail = db.prepare("SELECT account_id, sender FROM emails WHERE id = ?").get(emailId) as { account_id: string; sender: string } | undefined;
    if (!mail) return { outcome: "not_found" };
    const accountId = mail.account_id;
    const mode = modeFor(accountId);
    if (mode === "off") return { outcome: "off" };
    if (killed()) return { outcome: "kill_switch" };

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
    if (liveCountToday(accountId, ts) >= dailyLimit) return { outcome: "limit_reached" };
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
       WHERE e.first_seen_at >= ?
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
    return out;
  }

  return {
    evaluate: (emailId) => enqueue(() => evaluateNow(emailId)),
    async onClassified(emailId) {
      try {
        await enqueue(() => evaluateNow(emailId));
      } catch {
        // never break the classification pipeline
      }
    },
    backfill: (o = {}) => enqueue(() => backfillNow(o.limit ?? BACKFILL_LIMIT)),
    undoSeen: (userId, emailId) => enqueue(() => undoNow(userId, emailId)),
  };
}
