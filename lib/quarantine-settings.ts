// Per-account settings of quarantine and trash (R9, ADR 0025 Teil 2, ADR 0038): mode "Spam in Quarantäne verschieben",
// cleanup after X days and YOLO. Stored as columns of mail_accounts (migration 012). Nothing here talks to IMAP. Only the
// signed-in user changes them through lib/settings-api.ts; there is no default path to `live` or to YOLO.
import type { DatabaseSync } from "node:sqlite";
import { type AutoActionMode } from "./accounts-config.ts";
import { isAutoActionMode } from "./auto-actions-settings.ts";

export const DEFAULT_CLEANUP_DAYS = 14;
export const MIN_CLEANUP_DAYS = 1;
export const MAX_CLEANUP_DAYS = 90;

export interface QuarantineSettings {
  mode: AutoActionMode;
  days: number;
  yolo: boolean;
}

export const isCleanupDays = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= MIN_CLEANUP_DAYS && v <= MAX_CLEANUP_DAYS;

interface Row { quarantine_mode: string; quarantine_days: number; quarantine_yolo: number }

function fromRow(r: Row): QuarantineSettings {
  return {
    mode: isAutoActionMode(r.quarantine_mode) ? r.quarantine_mode : "off",
    days: isCleanupDays(r.quarantine_days) ? r.quarantine_days : DEFAULT_CLEANUP_DAYS,
    yolo: r.quarantine_yolo === 1,
  };
}

/** Settings of one account, whoever owns it (executor use). undefined = no credentials row (demo account): nothing acts. */
export function readQuarantineSettings(db: DatabaseSync, accountId: string): QuarantineSettings | undefined {
  const r = db.prepare("SELECT quarantine_mode, quarantine_days, quarantine_yolo FROM mail_accounts WHERE account_id = ?").get(accountId) as Row | undefined;
  return r ? fromRow(r) : undefined;
}

export type QuarantineChange = { mode?: AutoActionMode; days?: number; yolo?: boolean };
export type QuarantineChangeResult =
  | { ok: true; previous: QuarantineSettings; current: QuarantineSettings }
  | { ok: false; code: "not_found" | "not_managed" | "quarantine_off" | "invalid_days" };

/**
 * Applies a change to the user's own account (a foreign or unknown id is "not_found", ADR 0033). Rules: YOLO needs a mode other
 * than `off`; switching the mode to `off` also clears YOLO, so a later switch-on never inherits it.
 */
export function changeQuarantineSettings(db: DatabaseSync, userId: number, accountId: string, change: QuarantineChange, now: Date): QuarantineChangeResult {
  if (!db.prepare("SELECT 1 FROM accounts WHERE id = ? AND user_id = ?").get(accountId, userId)) return { ok: false, code: "not_found" };
  const row = db.prepare("SELECT quarantine_mode, quarantine_days, quarantine_yolo FROM mail_accounts WHERE account_id = ? AND user_id = ?").get(accountId, userId) as Row | undefined;
  if (!row) return { ok: false, code: "not_managed" };
  const previous = fromRow(row);
  const next: QuarantineSettings = { ...previous };
  if (change.mode !== undefined) next.mode = change.mode;
  if (change.days !== undefined) {
    if (!isCleanupDays(change.days)) return { ok: false, code: "invalid_days" };
    next.days = change.days;
  }
  if (change.yolo !== undefined) next.yolo = change.yolo;
  if (change.yolo === true && next.mode === "off") return { ok: false, code: "quarantine_off" };
  if (next.mode === "off") next.yolo = false;
  db.prepare("UPDATE mail_accounts SET quarantine_mode = ?, quarantine_days = ?, quarantine_yolo = ?, updated_at = ? WHERE account_id = ? AND user_id = ?")
    .run(next.mode, next.days, next.yolo ? 1 : 0, now.toISOString(), accountId, userId);
  return { ok: true, previous, current: next };
}
