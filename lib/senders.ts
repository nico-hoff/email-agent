// Sender bookkeeping (Plan v5, 3.3, docs/erd.md decisions 15 and 16): one row per lower-case address with counters.
// Stores addresses, domains, timestamps and numbers only: no subject, no name, no content (H3).
import type { DatabaseSync } from "node:sqlite";
import type { AuthResult } from "./imap.ts";

/**
 * Free mail providers. A domain here is never proposed as a domain rule (E8): "all of gmail.com" would block or
 * allow millions of unrelated people. Creating a domain rule for one of them is rejected as well (lib/sender-rules.ts).
 */
export const FREEMAIL_DOMAINS: readonly string[] = [
  "gmail.com", "googlemail.com",
  "web.de", "gmx.de", "gmx.net", "gmx.at", "gmx.ch", "gmx.com",
  "outlook.com", "outlook.de", "hotmail.com", "hotmail.de", "live.com", "live.de", "msn.com",
  "icloud.com", "me.com", "mac.com",
  "yahoo.com", "yahoo.de", "aol.com", "mail.com",
  "t-online.de", "freenet.de", "online.de", "arcor.de", "1und1.de",
  "proton.me", "protonmail.com", "posteo.de", "mailbox.org",
];

export function isFreemailDomain(domain: string): boolean {
  return FREEMAIL_DOMAINS.includes(domain.toLowerCase());
}

const ADDRESS_MAX = 254;

/** emails.sender holds the bare address. Anything that is not exactly one local part, one @ and a domain is rejected. */
export function splitSender(sender: string): { address: string; domain: string } | null {
  const s = sender.trim().toLowerCase();
  if (s.length === 0 || s.length > ADDRESS_MAX || /\s/.test(s)) return null;
  const at = s.indexOf("@");
  if (at < 1 || at !== s.lastIndexOf("@") || at === s.length - 1) return null;
  return { address: s, domain: s.slice(at + 1) };
}

export interface SenderCounts {
  mails_seen: number;
  dmarc_pass: number;
  jev_spam_count: number;
  marked_spam: number;
  marked_not_spam: number;
}

/** A new mail (not a second location of a known one) from this sender. Runs inside the caller's transaction. */
export function recordSenderMail(db: DatabaseSync, userId: number, sender: string, dmarc: AuthResult, ts: string): void {
  const s = splitSender(sender);
  if (!s) return;
  db.prepare(
    `INSERT INTO senders (user_id, address, domain, first_seen_at, last_seen_at, mails_seen, dmarc_pass)
     VALUES (?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT (user_id, address) DO UPDATE SET
       mails_seen = mails_seen + 1,
       dmarc_pass = dmarc_pass + excluded.dmarc_pass,
       last_seen_at = MAX(last_seen_at, excluded.last_seen_at)`,
  ).run(userId, s.address, s.domain, ts, ts, dmarc === "pass" ? 1 : 0);
}

/** Creates the sender row if it is missing (older mails, feedback before ingest) and returns its address. */
export function ensureSender(db: DatabaseSync, userId: number, sender: string, ts: string): string | null {
  const s = splitSender(sender);
  if (!s) return null;
  db.prepare(
    `INSERT INTO senders (user_id, address, domain, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (user_id, address) DO NOTHING`,
  ).run(userId, s.address, s.domain, ts, ts);
  return s.address;
}

/**
 * Jev judged this mail as spam (is_spam positive under the calibration). Counted once per mail: if the mail already has
 * another classified run, a later run (another question set or model) does not count again. Returns whether it counted.
 * Runs inside the transaction that marks the classification `classified`.
 */
export function recordJevSpam(db: DatabaseSync, emailId: number, classificationId: number, ts: string): boolean {
  const other = db.prepare(
    "SELECT 1 FROM classifications WHERE email_id = ? AND status = 'classified' AND id <> ? LIMIT 1",
  ).get(emailId, classificationId);
  if (other !== undefined) return false;
  // Worker side: the sender row belongs to the user who owns the mail's account.
  const mail = db.prepare("SELECT e.sender, a.user_id FROM emails e JOIN accounts a ON a.id = e.account_id WHERE e.id = ?").get(emailId) as
    | { sender: string; user_id: number }
    | undefined;
  if (!mail) return false;
  const address = ensureSender(db, mail.user_id, mail.sender, ts);
  if (address === null) return false;
  db.prepare("UPDATE senders SET jev_spam_count = jev_spam_count + 1 WHERE user_id = ? AND address = ?").run(mail.user_id, address);
  return true;
}

export function senderCounts(db: DatabaseSync, userId: number, sender: string): SenderCounts | null {
  const s = splitSender(sender);
  if (!s) return null;
  const row = db.prepare(
    "SELECT mails_seen, dmarc_pass, jev_spam_count, marked_spam, marked_not_spam FROM senders WHERE user_id = ? AND address = ?",
  ).get(userId, s.address) as SenderCounts | undefined;
  return row ? { ...row } : null;
}

/**
 * The two numbers for the Jev state (T55, H21): only when DMARC passed (an unauthenticated From proves nothing about who
 * sent it) and only when there is something to say. Anything else is left out, never sent as zero.
 */
export function feedbackHistory(
  db: DatabaseSync,
  userId: number,
  sender: string,
  dmarc: AuthResult,
): { user_marked_spam: number; user_marked_not_spam: number } | undefined {
  if (dmarc !== "pass") return undefined;
  const c = senderCounts(db, userId, sender);
  if (!c || (c.marked_spam === 0 && c.marked_not_spam === 0)) return undefined;
  return { user_marked_spam: c.marked_spam, user_marked_not_spam: c.marked_not_spam };
}
