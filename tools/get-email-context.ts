import type { DatabaseSync } from "node:sqlite";
import { defineSchema } from "veryfront/schemas";
import { tool } from "veryfront/tool";
import { agentEligibility } from "../lib/agent-eligibility.ts";
import { loadAnswers } from "../lib/agent-input.ts";
import { validateDatabasePath } from "../lib/accounts.ts";
import { PROJECT_ROOT } from "../lib/constants.ts";
import { openDatabase } from "../lib/db.ts";
import { interpretNoul, type NoulInterpreter, type NormalizedAnswer } from "../lib/jev-response.ts";

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

export interface GetEmailContextDeps {
  /** Returns a connection; the tool closes it after every call. */
  openDb: () => DatabaseSync;
  interpret?: NoulInterpreter;
}

const inputSchema = defineSchema((v) =>
  v.object({ email_id: v.number().int().positive().describe("ID of the email in the local database") })
)();

function senderDomain(sender: string): string {
  const at = sender.lastIndexOf("@");
  return at === -1 ? "" : sender.slice(at + 1).toLowerCase();
}

/** Read-only. Order (H11): load from SQLite, run the gate, only then shape the allowlist. */
export function readEmailContext(db: DatabaseSync, emailId: number, interpret: GetEmailContextDeps["interpret"]): EmailContextResult {
  const email = db.prepare("SELECT sender, subject, received_at FROM emails WHERE id = ?").get(emailId) as
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

function toolConfig(deps: GetEmailContextDeps) {
  return {
    description:
      "Read-only context of one classified email: sender domain, subject, received time, category, question set version and the normalized classifier answers. Returns only a fixed error code when the email is not eligible.",
    inputSchema,
    mcp: { enabled: false },
    execute: ({ email_id }: { email_id: number }): Promise<EmailContextResult> => {
      const db = deps.openDb();
      try {
        return Promise.resolve(readEmailContext(db, email_id, deps.interpret));
      } finally {
        db.close();
      }
    },
  };
}

/** For tests: same tool with injected dependencies. */
export function createGetEmailContext(deps: GetEmailContextDeps) {
  return tool(toolConfig(deps));
}

export default tool(toolConfig({
  openDb: () => openDatabase(validateDatabasePath(process.env, PROJECT_ROOT)),
}));
