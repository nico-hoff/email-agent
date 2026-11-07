// Initial import ("Erst-Import", ADR 0043): the newest mails of the INBOX, once per account, so a new account is not empty.
// Worker side (server process). Read path only: EXAMINE, SEARCH, FETCH; no flag, no move, no delete. The body is parsed in
// memory and handed to the classifier like on the live path; it is never stored. Everything written here is ids, counts and
// codes (table account_sync) plus the same metadata the live ingest writes (origin = 'import').
//
// Range: UIDs <= the checkpoint (mailbox_state.last_uid) at the time of the import, received within IMPORT_WINDOW_DAYS,
// newest IMPORT_COUNT of them. The live path reads only UIDs > checkpoint, so the two ranges are disjoint by construction.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { FLAG_REFRESH_CHUNK, IMPORT_DEFAULT_COUNT, IMPORT_MAX_COUNT, IMPORT_WINDOW_DAYS } from "./constants.ts";
import { parseMessage, type ImapPort, type TransientInput } from "./imap.ts";
import { ingestMail } from "./ingest.ts";
import { updateSync } from "./account-sync.ts";

export function clampImportCount(n: number | undefined): number {
  if (n === undefined || !Number.isFinite(n)) return IMPORT_DEFAULT_COUNT;
  return Math.min(IMPORT_MAX_COUNT, Math.max(1, Math.floor(n)));
}

/** Start of the window: midnight UTC, `windowDays` days back (SEARCH SINCE has day granularity, so nothing narrower is possible). */
export function importCutoff(now: Date, windowDays: number = IMPORT_WINDOW_DAYS): Date {
  const d = new Date(now.getTime() - windowDays * 86_400_000);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Newest first, only UIDs <= upper (never the live range), unique, at most `count`. */
export function selectImportUids(uids: readonly number[], upper: number, count: number): number[] {
  const uniq = [...new Set(uids.filter((u) => Number.isInteger(u) && u >= 1 && u <= upper))].sort((a, b) => b - a);
  return uniq.slice(0, clampImportCount(count));
}

export interface ImportCounts { total: number; classified: number; failed: number }

/** Classification progress of the selected UIDs, read from the database. A mail without a final status counts as pending. */
export function importCounts(db: DatabaseSync, accountId: string, folder: string, uidValidity: number, uids: readonly number[]): ImportCounts {
  const out: ImportCounts = { total: uids.length, classified: 0, failed: 0 };
  for (let i = 0; i < uids.length; i += 200) {
    const chunk = uids.slice(i, i + 200);
    const rows = db.prepare(
      `SELECT c.status AS status FROM email_locations l
       JOIN classifications c ON c.id = (SELECT MAX(id) FROM classifications WHERE email_id = l.email_id)
       WHERE l.account_id = ? AND l.folder = ? AND l.uid_validity = ? AND l.is_active = 1 AND l.uid IN (${chunk.map(() => "?").join(",")})`,
    ).all(accountId, folder, uidValidity, ...chunk) as { status: string }[];
    for (const r of rows) {
      if (r.status === "classified") out.classified++;
      else if (r.status === "failed") out.failed++;
    }
  }
  return out;
}

export interface FetchPhaseInput {
  db: DatabaseSync;
  port: ImapPort;
  accountId: string;
  folder: string;
  userId: number;
  now: () => Date;
  count: number;
  windowDays: number;
  /** In-memory hand-over for the classifier (body excerpt); absent = the mails are only stored. */
  submit?: ((emailId: number, input: TransientInput) => void) | undefined;
  /** Stops early when the worker is torn down. */
  alive(): boolean;
}

export type FetchPhaseResult =
  | { kind: "unsupported" | "no_checkpoint" | "stopped" }
  | { kind: "ok"; uidValidity: number; selected: number[] };

export async function runFetchPhase(i: FetchPhaseInput): Promise<FetchPhaseResult> {
  const { db, port } = i;
  if (!port.searchUids) return { kind: "unsupported" };
  const status = await port.mailboxStatus(i.folder);
  const cp = db.prepare("SELECT uid_validity, last_uid FROM mailbox_state WHERE account_id = ? AND mailbox = ?")
    .get(i.accountId, i.folder) as { uid_validity: number; last_uid: number } | undefined;
  if (!cp || cp.uid_validity !== status.uidValidity) return { kind: "no_checkpoint" };

  const found = await port.searchUids(i.folder, { since: importCutoff(i.now(), i.windowDays), maxUid: cp.last_uid });
  const selected = selectImportUids(found, cp.last_uid, i.count);

  const known = new Map<number, boolean>(); // uid -> already classified or queued (a classification row exists)
  const locs = db.prepare(
    `SELECT l.uid AS uid, EXISTS (SELECT 1 FROM classifications c WHERE c.email_id = l.email_id) AS cls FROM email_locations l
     WHERE l.account_id = ? AND l.folder = ? AND l.uid_validity = ? AND l.uid = ?`,
  );
  for (const uid of selected) {
    const r = locs.get(i.accountId, i.folder, status.uidValidity, uid) as { uid: number; cls: number } | undefined;
    if (r) known.set(uid, r.cls === 1);
  }
  const todo = selected.filter((u) => known.get(u) !== true);
  const done0 = selected.length - todo.length;
  updateSync(db, i.accountId, { phase: "fetching", total: selected.length, fetched: done0, error_code: null }, i.now());

  const seen = new Map<number, boolean>();
  if (port.fetchFlags && todo.length > 0) {
    for (let k = 0; k < todo.length; k += FLAG_REFRESH_CHUNK) {
      for (const f of await port.fetchFlags(i.folder, todo.slice(k, k + FLAG_REFRESH_CHUNK))) seen.set(f.uid, f.seen);
    }
  }

  let fetched = done0;
  for (const uid of todo) {
    if (!i.alive()) return { kind: "stopped" };
    const raw = await port.fetchMessageByUid(i.folder, uid);
    if (raw) {
      const { meta, excerpt } = await parseMessage(raw.source);
      const r = ingestMail(db, {
        accountId: i.accountId, meta, loc: { folder: i.folder, uid, uidValidity: status.uidValidity }, now: i.now(),
        traceId: randomUUID(), seen: seen.get(uid), origin: "import",
      });
      i.submit?.(r.emailId, { ...meta, excerpt });
    }
    fetched++;
    updateSync(db, i.accountId, { fetched }, i.now());
  }
  // A mail that vanished between SEARCH and FETCH has no location: it leaves the set and the total.
  const present = selected.filter((u) => locs.get(i.accountId, i.folder, status.uidValidity, u) !== undefined);
  if (present.length !== selected.length) updateSync(db, i.accountId, { total: present.length, fetched: present.length }, i.now());
  return { kind: "ok", uidValidity: status.uidValidity, selected: present };
}
