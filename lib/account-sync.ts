// Progress of the initial import per account (ADR 0043, table account_sync). The worker in the server process writes it,
// route modules read it (they share no memory with server.ts). Only counts, phases and short codes: no mail content.
// The "latest processed mails" are the existing list items (lib/email-api.ts), already in the database.
// No dynamic `obj[key]` access: Veryfront's API loader rejects it in modules that routes import.
import type { DatabaseSync } from "node:sqlite";
import { getEmailItem, type EmailItem } from "./email-api.ts";

export const SYNC_PHASES = ["queued", "connecting", "fetching", "classifying", "done", "failed"] as const;
export type SyncPhase = (typeof SYNC_PHASES)[number];
export const ACTIVE_PHASES: readonly SyncPhase[] = ["queued", "connecting", "fetching", "classifying"];
export const FEED_SIZE = 10;

export interface SyncRow {
  account_id: string;
  user_id: number;
  phase: SyncPhase;
  total: number;
  fetched: number;
  classified: number;
  failed_count: number;
  error_code: string | null;
  runs: number;
  started_at: string | null;
  updated_at: string;
  finished_at: string | null;
}

const COLS = "account_id, user_id, phase, total, fetched, classified, failed_count, error_code, runs, started_at, updated_at, finished_at";

export function readSync(db: DatabaseSync, accountId: string): SyncRow | null {
  return (db.prepare(`SELECT ${COLS} FROM account_sync WHERE account_id = ?`).get(accountId) as SyncRow | undefined) ?? null;
}

/** Creates the queued row when there is none (new account, or an account from before the import existed). True when created. */
export function ensureSync(db: DatabaseSync, accountId: string, userId: number, now: Date): boolean {
  const r = db.prepare(
    `INSERT OR IGNORE INTO account_sync (account_id, user_id, phase, updated_at) VALUES (?, ?, 'queued', ?)`,
  ).run(accountId, userId, now.toISOString());
  return Number(r.changes) > 0;
}

export interface SyncPatch {
  phase?: SyncPhase;
  total?: number;
  fetched?: number;
  classified?: number;
  failed_count?: number;
  /** undefined = keep, null = clear. */
  error_code?: string | null;
}

export function updateSync(db: DatabaseSync, accountId: string, patch: SyncPatch, now: Date): void {
  const row = readSync(db, accountId);
  if (!row) return;
  const phase = patch.phase ?? row.phase;
  const ts = now.toISOString();
  const finished = phase === "done" || phase === "failed";
  const started = row.started_at ?? (phase === "queued" ? null : ts);
  db.prepare(
    `UPDATE account_sync SET phase = ?, total = ?, fetched = ?, classified = ?, failed_count = ?, error_code = ?,
       started_at = ?, updated_at = ?, finished_at = ? WHERE account_id = ?`,
  ).run(
    phase, patch.total ?? row.total, patch.fetched ?? row.fetched, patch.classified ?? row.classified,
    patch.failed_count ?? row.failed_count, patch.error_code === undefined ? row.error_code : patch.error_code,
    started, ts, finished ? (row.finished_at ?? ts) : null, accountId,
  );
}

/** Restart (only from done/failed): back to queued with empty counters. Returns false when not allowed. */
export function restartSync(db: DatabaseSync, accountId: string, now: Date): boolean {
  const r = db.prepare(
    `UPDATE account_sync SET phase = 'queued', total = 0, fetched = 0, classified = 0, failed_count = 0, error_code = NULL,
       runs = runs + 1, started_at = NULL, updated_at = ?, finished_at = NULL
     WHERE account_id = ? AND phase IN ('done', 'failed')`,
  ).run(now.toISOString(), accountId);
  return Number(r.changes) > 0;
}

export function isImported(db: DatabaseSync, emailId: number): boolean {
  return (db.prepare("SELECT origin FROM emails WHERE id = ?").get(emailId) as { origin: string } | undefined)?.origin === "import";
}

export interface SyncView {
  phase: SyncPhase;
  total: number;
  fetched: number;
  classified: number;
  failed: number;
  error_code: string | null;
  runs: number;
  started_at: string | null;
  updated_at: string;
  finished_at: string | null;
  /** The latest mails of this account that the import processed (list item shape of /api/emails). */
  feed: EmailItem[];
}

/** Own accounts only: a foreign or unknown id is null (404). `feed` = newest imported mails of the account, at most FEED_SIZE. */
export function syncView(db: DatabaseSync, userId: number, accountId: string): SyncView | null {
  const owned = db.prepare("SELECT 1 FROM accounts WHERE id = ? AND user_id = ?").get(accountId, userId);
  if (!owned) return null;
  const row = readSync(db, accountId);
  if (!row) return null;
  const ids = db.prepare(
    // processed = classification finished (or failed); newest first by the time the classification finished
    `SELECT e.id FROM emails e JOIN classifications c ON c.id = (SELECT MAX(id) FROM classifications WHERE email_id = e.id)
     WHERE e.account_id = ? AND e.origin = 'import' AND c.status IN ('classified', 'failed')
     ORDER BY c.updated_at DESC, e.id DESC LIMIT ?`,
  ).all(accountId, FEED_SIZE) as { id: number }[];
  const feed: EmailItem[] = [];
  for (const { id } of ids) {
    const item = getEmailItem(db, userId, id);
    if (item) feed.push(item);
  }
  return {
    phase: row.phase, total: row.total, fetched: row.fetched, classified: row.classified, failed: row.failed_count,
    error_code: row.error_code, runs: row.runs, started_at: row.started_at, updated_at: row.updated_at, finished_at: row.finished_at, feed,
  };
}
