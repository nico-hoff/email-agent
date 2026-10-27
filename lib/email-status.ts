// Read and done state of a mail (docs/erd.md, entwurfsentscheidung 10). `seen` mirrors the provider's \Seen flag and is
// only ever read from the server; `done` is set by Nico in the app. Both live in the app database; nothing here
// touches a mailbox. A missing row means seen 0, done 0.
import type { DatabaseSync } from "node:sqlite";
import { FLAG_REFRESH_CHUNK, FLAG_REFRESH_WINDOW_DAYS } from "./constants.ts";
import type { ImapPort } from "./imap.ts";

export interface EmailStatus {
  seen: boolean;
  done: boolean;
}

/** Strict positive decimal id; anything else is "not found" (no 400, so ids cannot be probed for shape). */
export function parseEmailId(raw: unknown): number | null {
  if (typeof raw !== "string" || !/^[1-9]\d{0,14}$/.test(raw)) return null;
  return Number(raw);
}

export function readEmailStatus(db: DatabaseSync, emailId: number): EmailStatus {
  const row = db.prepare("SELECT seen, done FROM email_status WHERE email_id = ?").get(emailId) as
    | { seen: number; done: number }
    | undefined;
  return { seen: row?.seen === 1, done: row?.done === 1 };
}

/** Stores the provider flag. Never touches `done`. Returns whether the stored value changed. */
export function upsertSeen(db: DatabaseSync, emailId: number, seen: boolean, ts: string): boolean {
  const res = db.prepare(
    `INSERT INTO email_status (email_id, seen, done, updated_at) VALUES (?, ?, 0, ?)
     ON CONFLICT (email_id) DO UPDATE SET seen = excluded.seen, updated_at = excluded.updated_at
     WHERE email_status.seen <> excluded.seen`,
  ).run(emailId, seen ? 1 : 0, ts);
  return Number(res.changes) > 0;
}

/** Stores Nico's decision. Never touches `seen`. Returns whether the stored value changed. */
export function setDone(db: DatabaseSync, emailId: number, done: boolean, ts: string): { changed: boolean } {
  if (!done && db.prepare("SELECT 1 FROM email_status WHERE email_id = ?").get(emailId) === undefined) return { changed: false };
  const res = db.prepare(
    `INSERT INTO email_status (email_id, seen, done, updated_at) VALUES (?, 0, ?, ?)
     ON CONFLICT (email_id) DO UPDATE SET done = excluded.done, updated_at = excluded.updated_at
     WHERE email_status.done <> excluded.done`,
  ).run(emailId, done ? 1 : 0, ts);
  return { changed: Number(res.changes) > 0 };
}

export interface RefreshOptions {
  accountId: string;
  folder: string;
  now: Date;
  /** Only locations first seen within this window are re-read. */
  windowDays?: number;
  chunk?: number;
}

/**
 * Re-reads the provider's \Seen flag for known mails of one folder (FETCH FLAGS only; no body, no STORE).
 * Uses the UIDVALIDITY from the checkpoint, so locations of an older validity are never asked for.
 */
export async function refreshSeenFlags(
  port: ImapPort,
  db: DatabaseSync,
  o: RefreshOptions,
): Promise<{ checked: number; changed: number }> {
  const none = { checked: 0, changed: 0 };
  if (!port.fetchFlags) return none;
  const cp = db.prepare("SELECT uid_validity FROM mailbox_state WHERE account_id = ? AND mailbox = ?").get(o.accountId, o.folder) as
    | { uid_validity: number }
    | undefined;
  if (!cp) return none;
  const since = new Date(o.now.getTime() - (o.windowDays ?? FLAG_REFRESH_WINDOW_DAYS) * 86_400_000).toISOString();
  const rows = db.prepare(
    `SELECT uid, email_id FROM email_locations
     WHERE account_id = ? AND folder = ? AND uid_validity = ? AND is_active = 1 AND first_seen_at >= ?
     ORDER BY uid`,
  ).all(o.accountId, o.folder, cp.uid_validity, since) as { uid: number; email_id: number }[];
  const byUid = new Map(rows.map((r) => [r.uid, r.email_id]));
  const uids = rows.map((r) => r.uid);
  const chunk = Math.max(1, o.chunk ?? FLAG_REFRESH_CHUNK);
  const ts = o.now.toISOString();
  let changed = 0;
  for (let i = 0; i < uids.length; i += chunk) {
    for (const f of await port.fetchFlags(o.folder, uids.slice(i, i + chunk))) {
      const emailId = byUid.get(f.uid);
      if (emailId !== undefined && upsertSeen(db, emailId, f.seen, ts)) changed++;
    }
  }
  return { checked: uids.length, changed };
}
