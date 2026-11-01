// Settings of the automatic mailbox actions that the profile page changes (ADR 0025 Teil 1; docs/imap-write-contract.md):
// the mode of "Spam als gelesen" per account, today's count against the daily limit, and the global emergency stop file.
// Nothing here talks to IMAP. `live` is only ever set by an explicit call with the confirmation flag (lib/settings-api.ts);
// there is no default path to it.
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { AUTO_ACTION_MODES, type AutoActionMode } from "./accounts-config.ts";
import { DAILY_ACTION_LIMIT } from "./constants.ts";

export { DAILY_ACTION_LIMIT };

export const isAutoActionMode = (v: unknown): v is AutoActionMode => typeof v === "string" && AUTO_ACTION_MODES.some((m) => m === v);

/** Live actions of one account in the rolling 24 hours (what the daily limit counts: no undo rows, no "made unread" markers). */
export function liveActionsLast24h(db: DatabaseSync, accountId: string, now: Date): number {
  const since = new Date(now.getTime() - 86_400_000).toISOString();
  return (db.prepare(
    `SELECT COUNT(*) AS n FROM mailbox_actions m JOIN emails e ON e.id = m.email_id
     WHERE e.account_id = ? AND m.mode = 'live' AND m.rule <> 'undo' AND m.created_at >= ?
       AND COALESCE(json_extract(m.reason_json, '$.source'), '') <> 'tombstone'`,
  ).get(accountId, since) as { n: number }).n;
}

export type SetModeResult = { ok: true; previous: AutoActionMode } | { ok: false; code: "not_found" | "not_managed" };

/** Sets mail_accounts.spam_seen_mode of the user's own account. A foreign or unknown id is "not_found" (ADR 0033). */
export function setSpamSeenMode(db: DatabaseSync, userId: number, accountId: string, mode: AutoActionMode, now: Date): SetModeResult {
  const acc = db.prepare("SELECT 1 FROM accounts WHERE id = ? AND user_id = ?").get(accountId, userId);
  if (!acc) return { ok: false, code: "not_found" };
  const cur = db.prepare("SELECT spam_seen_mode FROM mail_accounts WHERE account_id = ? AND user_id = ?").get(accountId, userId) as { spam_seen_mode: string } | undefined;
  if (!cur) return { ok: false, code: "not_managed" };
  db.prepare("UPDATE mail_accounts SET spam_seen_mode = ?, updated_at = ? WHERE account_id = ? AND user_id = ?").run(mode, now.toISOString(), accountId, userId);
  return { ok: true, previous: isAutoActionMode(cur.spam_seen_mode) ? cur.spam_seen_mode : "off" };
}

export const globalStopActive = (file: string): boolean => existsSync(file);

/** Creates or removes the global stop file (admins, after a confirmation in the UI). Idempotent. */
export function setGlobalStop(file: string, stopped: boolean): void {
  if (stopped) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "");
  } else if (existsSync(file)) {
    unlinkSync(file);
  }
}
