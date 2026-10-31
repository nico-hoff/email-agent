// Nico's feedback on a mail (T37, Plan v5 3.3). App database only: nothing here touches a mailbox.
// Three topics, each with a "latest answer wins" rule: spam verdict, reply need, category. Repeating the latest answer
// of a topic is a no-op. The spam verdict also feeds the sender counters (marked_spam / marked_not_spam, once per mail).
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { QUESTIONS } from "./jev-questions.ts";
import { ensureSender } from "./senders.ts";

export const FEEDBACK_KINDS = ["spam_correct", "not_spam", "category_wrong", "reply_needed", "no_reply_needed"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

const categoryQuestion = QUESTIONS.category;
/** The categories Jev knows (until app folders replace them in M4). */
export const CATEGORY_OPTIONS: readonly string[] = categoryQuestion.type === "choice" ? Object.keys(categoryQuestion.criteria) : [];

const SPAM_TOPIC: readonly FeedbackKind[] = ["spam_correct", "not_spam"];
const REPLY_TOPIC: readonly FeedbackKind[] = ["reply_needed", "no_reply_needed"];
const CATEGORY_TOPIC: readonly FeedbackKind[] = ["category_wrong"];

function topicOf(kind: FeedbackKind): readonly FeedbackKind[] {
  return SPAM_TOPIC.includes(kind) ? SPAM_TOPIC : REPLY_TOPIC.includes(kind) ? REPLY_TOPIC : CATEGORY_TOPIC;
}

export type RecordResult =
  | { ok: true; changed: boolean }
  | { ok: false; code: "invalid_kind" | "invalid_value" | "not_found" };

interface FeedbackRow { kind: FeedbackKind; value_json: string }

function latestOfTopic(db: DatabaseSync, userId: number, emailId: number, topic: readonly FeedbackKind[]): FeedbackRow | undefined {
  const marks = topic.map(() => "?").join(",");
  return db.prepare(
    `SELECT f.kind, f.value_json FROM feedback f JOIN emails e ON e.id = f.email_id JOIN accounts a ON a.id = e.account_id
     WHERE f.email_id = ? AND a.user_id = ? AND f.kind IN (${marks}) ORDER BY f.id DESC LIMIT 1`,
  ).get(emailId, userId, ...topic) as FeedbackRow | undefined;
}

export function recordFeedback(
  db: DatabaseSync,
  userId: number,
  i: { emailId: number; kind: FeedbackKind; value?: unknown; ts: string },
): RecordResult {
  if (!FEEDBACK_KINDS.includes(i.kind)) return { ok: false, code: "invalid_kind" };
  // Tenant scope: a mail of another user is "not_found" and nothing is written (ADR 0029).
  const mail = db.prepare("SELECT e.account_id, e.sender FROM emails e JOIN accounts a ON a.id = e.account_id WHERE e.id = ? AND a.user_id = ?").get(i.emailId, userId) as
    | { account_id: string; sender: string }
    | undefined;
  if (!mail) return { ok: false, code: "not_found" };
  let category: string | undefined;
  if (i.kind === "category_wrong") {
    if (typeof i.value !== "string" || !CATEGORY_OPTIONS.includes(i.value)) return { ok: false, code: "invalid_value" };
    category = i.value;
  } else if (i.value !== undefined) {
    return { ok: false, code: "invalid_value" };
  }
  const valueJson = category === undefined ? "{}" : JSON.stringify({ category });

  db.exec("BEGIN IMMEDIATE");
  try {
    const prev = latestOfTopic(db, userId, i.emailId, topicOf(i.kind));
    if (prev && prev.kind === i.kind && prev.value_json === valueJson) {
      db.exec("ROLLBACK");
      return { ok: true, changed: false };
    }
    const cls = db.prepare("SELECT id FROM classifications WHERE email_id = ? AND status = 'classified' ORDER BY id DESC LIMIT 1")
      .get(i.emailId) as { id: number } | undefined;
    db.prepare(
      "INSERT INTO feedback (email_id, classification_id, kind, value_json, actor, created_at) VALUES (?, ?, ?, ?, 'nico', ?)",
    ).run(i.emailId, cls?.id ?? null, i.kind, valueJson, i.ts);

    if (SPAM_TOPIC.includes(i.kind)) {
      const address = ensureSender(db, userId, mail.sender, i.ts);
      if (address !== null) {
        const [inc, dec] = i.kind === "spam_correct" ? ["marked_spam", "marked_not_spam"] : ["marked_not_spam", "marked_spam"];
        const undo = prev !== undefined && prev.kind !== i.kind ? `, ${dec} = MAX(${dec} - 1, 0)` : "";
        db.prepare(`UPDATE senders SET ${inc} = ${inc} + 1${undo} WHERE user_id = ? AND address = ?`).run(userId, address);
      }
    }
    db.prepare(
      `INSERT INTO audit_log (occurred_at, trace_id, actor, action, account_id, email_id, details_json)
       VALUES (?, ?, 'system', 'feedback_recorded', ?, ?, ?)`,
    ).run(i.ts, randomUUID(), mail.account_id, i.emailId, JSON.stringify({ source: "nico", kind: i.kind, ...(category ? { category } : {}) }));
    db.exec("COMMIT");
    return { ok: true, changed: true };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export interface FeedbackState {
  spam: "spam_correct" | "not_spam" | null;
  reply: "reply_needed" | "no_reply_needed" | null;
  category: string | null;
}

/** Latest answer per topic, for the buttons' current state. */
export function feedbackState(db: DatabaseSync, userId: number, emailId: number): FeedbackState {
  const spam = latestOfTopic(db, userId, emailId, SPAM_TOPIC)?.kind ?? null;
  const reply = latestOfTopic(db, userId, emailId, REPLY_TOPIC)?.kind ?? null;
  const cat = latestOfTopic(db, userId, emailId, CATEGORY_TOPIC);
  let category: string | null = null;
  if (cat) {
    try {
      const v = (JSON.parse(cat.value_json) as { category?: unknown }).category;
      if (typeof v === "string") category = v;
    } catch {
      category = null;
    }
  }
  return { spam: spam as FeedbackState["spam"], reply: reply as FeedbackState["reply"], category };
}
