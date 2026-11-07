// Separate development database (data/dev-synthetic.sqlite) filled with synthetic mails from the public
// Hugging Face eval datasets. Pure functions over an opened DatabaseSync; no network, no Jev calls.
// Stores metadata only (sender noreply@<domain>, subject, location, normalized answers): never a body or excerpt.
import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { syncAccounts, validateDatabasePath } from "./accounts.ts";
import { DEFAULT_SPAM_THRESHOLD, type AccountConfig } from "./accounts-config.ts";
import { persistNormalizedAnswers } from "./classification-pipeline.ts";
import { DEV_SYNTHETIC_DATABASE_PATH, JEV_MODEL, QUESTION_SET_VERSION } from "./constants.ts";
import { openDatabase } from "./db.ts";
import { EVAL_SOURCES, type EvalCase } from "./eval-sources.ts";
import { QUESTIONS } from "./jev-questions.ts";
import { interpretNoul, type NormalizedAnswer } from "./jev-response.ts";
import { recordJevSpam } from "./senders.ts";

export const SYNTHETIC_HOST = "synthetic.invalid";
export const SYNTHETIC_ACCOUNT_PREFIX = "hf-";
export const SYNTHETIC_INBOX = "INBOX";
export const SYNTHETIC_JUNK = "Junk";
export const SYNTHETIC_WINDOW_DAYS = 14;
const SYNTHETIC_UID_VALIDITY = 1;
const DAY_MS = 86_400_000;

export class NotSyntheticDatabaseError extends Error {
  constructor() {
    super("database contains non-synthetic accounts: refusing to write synthetic data into it");
    this.name = "NotSyntheticDatabaseError";
  }
}

export interface SyntheticItem {
  case: EvalCase;
  /** Normalized Jev answers from an eval run. Without them the mail stays unclassified. */
  classification?: { answers: NormalizedAnswer[]; modelReported: string; latencyMs?: number | null };
}

export interface ImportOptions {
  now?: Date;
  traceId?: string;
}

export interface ImportResult {
  cases: number;
  classified: number;
}

export function syntheticAccountId(source: string): string {
  return `${SYNTHETIC_ACCOUNT_PREFIX}${source}`;
}

/** Throws unless every account in the database is a synthetic one (id hf-*, host synthetic.invalid). */
export function assertSyntheticDatabase(db: DatabaseSync): void {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM accounts WHERE NOT (id GLOB '${SYNTHETIC_ACCOUNT_PREFIX}*' AND host = ?)`)
    .get(SYNTHETIC_HOST) as { n: number };
  if (row.n > 0) throw new NotSyntheticDatabaseError();
}

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Deterministic per case id; "now" anchors the window so "today" views have data after every seed. */
export function syntheticReceivedAt(caseId: string, now: Date): string {
  const windowMinutes = SYNTHETIC_WINDOW_DAYS * 24 * 60;
  const offsetMinutes = fnv1a(caseId) % windowMinutes;
  const jitterMs = (fnv1a(`${caseId}#ms`) % 60_000);
  return new Date(now.getTime() - offsetMinutes * 60_000 - jitterMs).toISOString();
}

function syntheticUid(caseId: string): number {
  const m = /-(\d{1,9})$/.exec(caseId);
  return m ? Number(m[1]) + 1 : (fnv1a(caseId) % 2_000_000_000) + 1;
}

/** Fixed tag colors for the synthetic accounts, in EVAL_SOURCES order (the accounts file does not exist in this mode). */
export const SYNTHETIC_COLORS: readonly string[] = ["#3b82f6", "#f97316", "#10b981", "#a855f7", "#ec4899", "#eab308"];

function syntheticAccounts(): AccountConfig[] {
  return EVAL_SOURCES.map((s, i) => ({
    id: syntheticAccountId(s.short),
    label: `Synthetic ${s.short}`,
    color: SYNTHETIC_COLORS.at(i % SYNTHETIC_COLORS.length),
    context: "",
    host: SYNTHETIC_HOST,
    port: 993,
    tls: true,
    user: "synthetic",
    password: "synthetic",
    mailbox: SYNTHETIC_INBOX,
    spam_mailbox: SYNTHETIC_JUNK,
    spam_threshold: DEFAULT_SPAM_THRESHOLD,
    // No worker ever runs against these accounts, so they are shown as disabled.
    enabled: false,
  }));
}

function isJunk(c: EvalCase): boolean {
  return c.expected.is_spam === true || c.expected.is_phishing_or_scam === true;
}

function importOne(db: DatabaseSync, item: SyntheticItem, now: Date, ts: string, traceId: string): boolean {
  const c = item.case;
  if (!c.source || !EVAL_SOURCES.some((s) => s.short === c.source)) throw new Error("unknown_source");
  const accountId = syntheticAccountId(c.source);
  const domain = c.sender_domain.trim().toLowerCase() || "unknown.example.test";
  const sender = `noreply@${domain}`;
  const receivedAt = syntheticReceivedAt(c.id, now);

  const existing = db.prepare("SELECT id FROM emails WHERE account_id = ? AND message_id = ?").get(accountId, c.id) as
    | { id: number }
    | undefined;
  let emailId: number;
  if (existing) {
    emailId = existing.id;
    db.prepare("UPDATE emails SET sender = ?, subject = ?, received_at = ? WHERE id = ?").run(sender, c.subject, receivedAt, emailId);
  } else {
    const res = db
      .prepare(
        `INSERT INTO emails (account_id, message_id, sender, subject, received_at, first_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(accountId, c.id, sender, c.subject, receivedAt, ts);
    emailId = Number(res.lastInsertRowid);
  }

  const folder = isJunk(c) ? SYNTHETIC_JUNK : SYNTHETIC_INBOX;
  const active = db.prepare("SELECT id, folder FROM email_locations WHERE email_id = ? AND is_active = 1").get(emailId) as
    | { id: number; folder: string }
    | undefined;
  if (active && active.folder === folder) {
    db.prepare("UPDATE email_locations SET last_seen_at = ? WHERE id = ?").run(ts, active.id);
  } else {
    // A changed expectation (new dataset revision) moves the mail; the old location stays as history.
    if (active) db.prepare("UPDATE email_locations SET is_active = 0 WHERE email_id = ?").run(emailId);
    db.prepare(
      `INSERT INTO email_locations (email_id, account_id, folder, uid_validity, uid, is_active, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT (account_id, folder, uid_validity, uid) DO UPDATE SET is_active = 1, last_seen_at = excluded.last_seen_at`,
    ).run(emailId, accountId, folder, SYNTHETIC_UID_VALIDITY, syntheticUid(c.id), ts, ts);
  }

  const cls = item.classification;
  if (!cls) return false;
  const expected = Object.keys(QUESTIONS);
  if (cls.answers.length !== expected.length || !expected.every((k) => cls.answers.some((a) => a.key === k))) {
    throw new Error("invalid_answers");
  }
  // Replace semantics: the last run wins. One row per (mail, question set, model); its answers are rebuilt.
  const rerun = db
    .prepare("SELECT 1 FROM classifications WHERE email_id = ? AND question_set_version = ? AND model_requested = ?")
    .get(emailId, QUESTION_SET_VERSION, JEV_MODEL) !== undefined;
  db.prepare(
    `INSERT INTO classifications
       (email_id, question_set_version, model_requested, model_reported, status, attempts, latency_ms, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'classified', 1, ?, ?, ?)
     ON CONFLICT (email_id, question_set_version, model_requested) DO UPDATE SET
       model_reported = excluded.model_reported, status = 'classified', failure_code = NULL, attempts = 1,
       next_attempt_at = NULL, latency_ms = excluded.latency_ms, updated_at = excluded.updated_at`,
  ).run(emailId, QUESTION_SET_VERSION, JEV_MODEL, cls.modelReported, cls.latencyMs ?? null, ts, ts);
  const row = db
    .prepare("SELECT id FROM classifications WHERE email_id = ? AND question_set_version = ? AND model_requested = ?")
    .get(emailId, QUESTION_SET_VERSION, JEV_MODEL) as { id: number };
  db.prepare("DELETE FROM classification_answers WHERE classification_id = ?").run(row.id);
  persistNormalizedAnswers(
    { db, classificationId: row.id, emailId, accountId, traceId, now },
    cls.answers,
    DEFAULT_SPAM_THRESHOLD,
    "eval",
    QUESTION_SET_VERSION,
  );
  // As in the pipeline (createPersistResponse): Jev's spam verdict feeds the sender counter (HITL list). Counted once
  // per mail, so re-importing the same case does not inflate it.
  const spam = cls.answers.find((a) => a.key === "is_spam");
  if (!rerun && spam && interpretNoul(spam, QUESTION_SET_VERSION) === "positive") recordJevSpam(db, emailId, row.id, ts);
  return true;
}

/**
 * Idempotent import in one transaction. Refuses databases that hold non-synthetic accounts.
 * Mails are keyed by (account, message_id = case id); re-importing updates them in place.
 */
export function importSyntheticCases(db: DatabaseSync, items: SyntheticItem[], options: ImportOptions = {}): ImportResult {
  assertSyntheticDatabase(db);
  const now = options.now ?? new Date();
  const ts = now.toISOString();
  const traceId = options.traceId ?? randomUUID();
  syncAccounts(db, syntheticAccounts(), now);
  let classified = 0;
  db.exec("BEGIN");
  try {
    for (const item of items) if (importOne(db, item, now, ts, traceId)) classified++;
    db.prepare(
      `INSERT INTO audit_log (occurred_at, trace_id, actor, action, details_json)
       VALUES (?, ?, 'eval', 'synthetic_import', ?)`,
    ).run(ts, traceId, JSON.stringify({ cases: items.length, classified }));
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return { cases: items.length, classified };
}

/** Opens (and migrates) the dev database under the project root. Closes it again if it holds real accounts. */
export function openSyntheticDevDatabase(projectRoot: string): DatabaseSync {
  const file = validateDatabasePath({ DATABASE_PATH: DEV_SYNTHETIC_DATABASE_PATH }, projectRoot);
  const db = openDatabase(file);
  try {
    assertSyntheticDatabase(db);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

/** For the dev server: ensures the file exists and is synthetic-only. Returns the absolute path and whether it existed. */
export function prepareSyntheticDevDatabase(projectRoot: string): { path: string; existed: boolean } {
  const path = validateDatabasePath({ DATABASE_PATH: DEV_SYNTHETIC_DATABASE_PATH }, projectRoot);
  const existed = existsSync(path);
  openSyntheticDevDatabase(projectRoot).close();
  return { path, existed };
}
