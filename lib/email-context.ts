// Pure logic of the get-email-context tool (ADR 0029 Veryfront usage: logic and gate live in lib/, the tool file is a thin
// wrapper). Metadata only, scoped to the user (ADR 0033): a mail of another user is "email_not_found".
import type { DatabaseSync } from "node:sqlite";
import { agentEligibility } from "./agent-eligibility.ts";
import { loadAnswers } from "./agent-input.ts";
import { interpretNoul, type NoulInterpreter, type NormalizedAnswer } from "./jev-response.ts";

/** Allowlist (D19). Never the full sender address, body, excerpt or derived rows (H3). */
export interface EmailContext {
  sender_domain: string;
  subject: string;
  received_at: string;
  category: string;
  question_set_version: string;
  answers: NormalizedAnswer[];
}

export type EmailContextResult =
  | { ok: true; context: EmailContext }
  | { ok: false; code: "not_eligible" | "email_not_found" | "not_classified" };

function senderDomain(sender: string): string {
  const at = sender.lastIndexOf("@");
  return at === -1 ? "" : sender.slice(at + 1).toLowerCase();
}

/** Read-only. Order (H11): load from SQLite, run the gate, only then shape the allowlist. */
export function readEmailContext(db: DatabaseSync, userId: number, emailId: number, interpret: NoulInterpreter | undefined): EmailContextResult {
  const email = db.prepare(
    "SELECT e.sender, e.subject, e.received_at FROM emails e JOIN accounts a ON a.id = e.account_id WHERE e.id = ? AND a.user_id = ?",
  ).get(emailId, userId) as
    | { sender: string; subject: string; received_at: string }
    | undefined;
  if (!email) return { ok: false, code: "email_not_found" };

  const cls = db.prepare(
    "SELECT id, question_set_version FROM classifications WHERE email_id = ? AND status = 'classified' ORDER BY id DESC LIMIT 1",
  ).get(emailId) as { id: number; question_set_version: string } | undefined;
  if (!cls) return { ok: false, code: "not_classified" };

  const answers = loadAnswers(db, cls.id);
  if (!agentEligibility(answers, interpret ?? interpretNoul, cls.question_set_version).eligible) return { ok: false, code: "not_eligible" };

  const category = answers.find((a) => a.key === "category");
  return {
    ok: true,
    context: {
      sender_domain: senderDomain(email.sender),
      subject: email.subject,
      received_at: email.received_at,
      category: String(category?.value ?? ""),
      question_set_version: cls.question_set_version,
      answers,
    },
  };
}

