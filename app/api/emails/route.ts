import { openDatabase } from "../../../lib/db.ts";
import { validateDatabasePath } from "../../../lib/accounts.ts";
import { PROJECT_ROOT } from "../../../lib/constants.ts";

const STATUSES = ["pending", "retry_wait", "classified", "failed", "paused"];
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

interface Row {
  id: number;
  account_id: string;
  sender: string;
  subject: string;
  received_at: string;
  first_seen_at: string;
  folder: string | null;
  uid: number | null;
  spam_mailbox: string | null;
  cls_id: number | null;
  question_set_version: string | null;
  model_requested: string | null;
  model_reported: string | null;
  status: string | null;
  failure_code: string | null;
  attempts: number | null;
  latency_ms: number | null;
}

type Disagreement = "provider_spam_jev_not_spam" | "jev_spam_provider_not_spam" | null;

function parse(json: string | null): unknown {
  if (json === null) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * Disagreement rule (noul is unmapped, so the raw spam value is not interpreted):
 * provider_spam = active location folder equals the account's spam_mailbox.
 * jev_spam = category answer equals "spam" OR shadow_quarantine.candidate is true.
 * Only classified emails are compared.
 */
function disagreementOf(providerSpam: boolean, jevSpam: boolean): Disagreement {
  if (providerSpam && !jevSpam) return "provider_spam_jev_not_spam";
  if (!providerSpam && jevSpam) return "jev_spam_provider_not_spam";
  return null;
}

// Reads only from SQLite. Never exposes body/excerpt/raw data (none is stored) or account host/label.
export function GET(request: Request): Response {
  const url = new URL(request.url);
  const account = url.searchParams.get("account");
  const status = url.searchParams.get("status");
  const limitParam = url.searchParams.get("limit");
  let limit = DEFAULT_LIMIT;
  if (limitParam !== null) {
    if (!/^\d+$/.test(limitParam)) return Response.json({ error: "invalid_limit" }, { status: 400 });
    limit = Math.min(Math.max(Number(limitParam), 1), MAX_LIMIT);
  }
  if (status !== null && !STATUSES.includes(status)) {
    return Response.json({ error: "invalid_status" }, { status: 400 });
  }

  let db;
  try {
    db = openDatabase(validateDatabasePath(process.env, PROJECT_ROOT));
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (account !== null) {
      where.push("e.account_id = ?");
      params.push(account);
    }
    if (status !== null) {
      where.push("c.status = ?");
      params.push(status);
    }
    const rows = db.prepare(
      `SELECT e.id, e.account_id, e.sender, e.subject, e.received_at, e.first_seen_at,
              l.folder, l.uid, a.spam_mailbox,
              c.id AS cls_id, c.question_set_version, c.model_requested, c.model_reported,
              c.status, c.failure_code, c.attempts, c.latency_ms
       FROM emails e
       JOIN accounts a ON a.id = e.account_id
       LEFT JOIN email_locations l ON l.id = (
         SELECT MAX(id) FROM email_locations WHERE email_id = e.id AND is_active = 1)
       LEFT JOIN classifications c ON c.id = (
         SELECT MAX(id) FROM classifications WHERE email_id = e.id)
       ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY e.received_at DESC, e.id DESC
       LIMIT ?`,
    ).all(...params, limit) as unknown as Row[];

    const ansStmt = db.prepare(
      "SELECT question_key, type, answer_json, probabilities_json FROM classification_answers WHERE classification_id = ? ORDER BY id",
    );
    const emails = rows.map((r) => {
      const answers: Record<string, unknown> = {};
      let shadow: Record<string, unknown> | null = null;
      if (r.cls_id !== null) {
        for (const a of ansStmt.all(r.cls_id) as {
          question_key: string;
          type: string;
          answer_json: string;
          probabilities_json: string | null;
        }[]) {
          const parsed = parse(a.answer_json) as Record<string, unknown> | null;
          if (a.question_key === "shadow_quarantine") {
            shadow = parsed;
          } else {
            const entry: Record<string, unknown> = { type: a.type, value: parsed?.value ?? null };
            const p = parse(a.probabilities_json);
            if (p !== null) entry.probabilities = p;
            answers[a.question_key] = entry;
          }
        }
      }
      const providerSpam = r.spam_mailbox !== null && r.folder !== null && r.folder === r.spam_mailbox;
      const category = (answers.category as { value?: unknown } | undefined)?.value;
      const jevSpam = (typeof category === "string" && category.toLowerCase() === "spam") ||
        (shadow as { candidate?: unknown } | null)?.candidate === true;
      return {
        id: r.id,
        account_id: r.account_id,
        sender: r.sender,
        subject: r.subject,
        received_at: r.received_at,
        first_seen_at: r.first_seen_at,
        active_location: r.folder === null ? null : { folder: r.folder, uid: r.uid },
        provider_spam: providerSpam,
        classification: r.cls_id === null ? null : {
          status: r.status,
          question_set_version: r.question_set_version,
          model_requested: r.model_requested,
          model_reported: r.model_reported,
          failure_code: r.failure_code,
          attempts: r.attempts,
          latency_ms: r.latency_ms,
          answers,
        },
        shadow_quarantine: shadow,
        disagreement: r.status === "classified" ? disagreementOf(providerSpam, jevSpam) : null,
      };
    });
    return Response.json({ emails });
  } catch {
    return Response.json({ error: "emails_unavailable" }, { status: 500 });
  } finally {
    db?.close();
  }
}
