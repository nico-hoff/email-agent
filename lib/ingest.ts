import type { DatabaseSync } from "node:sqlite";
import { upsertSeen } from "./email-status.ts";
import { recordSenderMail } from "./senders.ts";
import type { MessageMeta } from "./imap.ts";

export interface IngestInput {
  accountId: string;
  meta: MessageMeta;
  loc: { folder: string; uid: number; uidValidity: number };
  now: Date;
  traceId: string;
  /** Provider flag \Seen of this copy; undefined = unknown, nothing is stored. */
  seen?: boolean | undefined;
}

/** Idempotent ingest of one mail location in a single transaction. Persists metadata only. */
export function ingestMail(db: DatabaseSync, i: IngestInput): { emailId: number; isNew: boolean } {
  const ts = i.now.toISOString();
  const { accountId, meta, loc } = i;
  db.exec("BEGIN");
  try {
    const existing = db
      .prepare(
        `SELECT id, email_id FROM email_locations
         WHERE account_id = ? AND folder = ? AND uid_validity = ? AND uid = ?`,
      )
      .get(accountId, loc.folder, loc.uidValidity, loc.uid) as { id: number; email_id: number } | undefined;
    if (existing) {
      db.prepare("UPDATE email_locations SET last_seen_at = ? WHERE id = ?").run(ts, existing.id);
      if (i.seen !== undefined) upsertSeen(db, existing.email_id, i.seen, ts);
      db.exec("COMMIT");
      return { emailId: existing.email_id, isNew: false };
    }

    let emailId: number | undefined;
    if (meta.messageId !== null) {
      const row = db
        .prepare("SELECT id FROM emails WHERE account_id = ? AND message_id = ?")
        .get(accountId, meta.messageId) as { id: number } | undefined;
      emailId = row?.id;
    }
    const isNew = emailId === undefined;
    if (emailId === undefined) {
      const res = db
        .prepare(
          `INSERT INTO emails (account_id, message_id, sender, subject, received_at, first_seen_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(accountId, meta.messageId, meta.sender, meta.subject, meta.receivedAt, ts);
      emailId = Number(res.lastInsertRowid);
      recordSenderMail(db, meta.sender, meta.dmarc, ts);
    } else {
      const prev = db
        .prepare("SELECT folder FROM email_locations WHERE email_id = ? AND is_active = 1")
        .all(emailId) as { folder: string }[];
      db.prepare("UPDATE email_locations SET is_active = 0 WHERE email_id = ? AND is_active = 1").run(emailId);
      const from = prev.find((p) => p.folder !== loc.folder)?.folder;
      if (from !== undefined) {
        db.prepare(
          `INSERT INTO audit_log (occurred_at, trace_id, actor, action, account_id, email_id, details_json)
           VALUES (?, ?, 'worker', 'folder_changed', ?, ?, ?)`,
        ).run(ts, i.traceId, accountId, emailId, JSON.stringify({ from, to: loc.folder }));
      }
    }
    db.prepare(
      `INSERT INTO email_locations (email_id, account_id, folder, uid_validity, uid, is_active, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(emailId, accountId, loc.folder, loc.uidValidity, loc.uid, ts, ts);
    if (i.seen !== undefined) upsertSeen(db, emailId, i.seen, ts);
    db.exec("COMMIT");
    return { emailId, isNew };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
