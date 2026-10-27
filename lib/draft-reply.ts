import { buildAgentInput, formatAgentInput, type AgentInputDeps } from "./agent-input.ts";
import type { AgentBlockReason } from "./agent-eligibility.ts";
import { REPLY_DRAFTER_MODEL } from "./constants.ts";

/** Result of the reply agent (docs/agent-contract.md section 1). Lives in memory only (D17/H3). */
export interface ReplyDraft {
  draft: string;
  language: "de" | "en";
  tone: string;
  needs_human_check: boolean;
  reasons: string[];
}

/** The slice of Veryfront's Agent that draftReply needs; tests inject a fake. */
export interface DraftAgent {
  generate(args: { input: string; abortSignal?: AbortSignal; tools?: Record<string, never> }): Promise<{
    data?: unknown;
    object?: unknown;
    usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  }>;
}

export interface DraftReplyDeps extends AgentInputDeps {
  agent: DraftAgent;
  traceId?: string;
  now?: () => Date;
  clock?: () => number;
}

export type DraftReplyResult =
  | { ok: true; draft: ReplyDraft; model: string; latency_ms: number; usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }
  | { ok: false; code: "not_eligible"; reasons: AgentBlockReason[] }
  | { ok: false; code: "email_not_found" | "not_classified" | "source_gone" | "fetch_failed" | "agent_failed" | "invalid_output" };

export function parseReplyDraft(value: unknown): ReplyDraft | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.draft !== "string" || typeof v.tone !== "string" || typeof v.needs_human_check !== "boolean") return undefined;
  if (v.language !== "de" && v.language !== "en") return undefined;
  if (!Array.isArray(v.reasons) || !v.reasons.every((r) => typeof r === "string")) return undefined;
  return { draft: v.draft, language: v.language, tone: v.tone, needs_human_check: v.needs_human_check, reasons: [...v.reasons] as string[] };
}

const num = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) ? n : 0);

/**
 * Order (H11): gate and IMAP refetch via buildAgentInput, only then the agent.
 * Returns the draft in memory. The only write is the audit row `draft_generated` with IDs, model,
 * latency and token counts (D17); never draft text, excerpt or error text from the provider.
 */
export async function draftReply(deps: DraftReplyDeps, emailId: number, abortSignal?: AbortSignal): Promise<DraftReplyResult> {
  const built = await buildAgentInput(deps, emailId);
  if (!built.ok) return built;

  // The tool get-email-context needs the id; the mail text stays inside the fence of formatAgentInput.
  const input = `email_id: ${emailId}\n${formatAgentInput(built.input)}`;
  const clock = deps.clock ?? (() => performance.now());
  const started = clock();
  let response: Awaited<ReturnType<DraftAgent["generate"]>>;
  try {
    response = await deps.agent.generate({ input, ...(abortSignal ? { abortSignal } : {}) });
  } catch {
    // No error details: provider messages could echo prompt content (H3/H4).
    return { ok: false, code: "agent_failed" };
  }
  const latency_ms = Math.round(clock() - started);

  const draft = parseReplyDraft(response.data ?? response.object);
  if (!draft) return { ok: false, code: "invalid_output" };

  const usage = {
    prompt_tokens: num(response.usage?.promptTokens),
    completion_tokens: num(response.usage?.completionTokens),
    total_tokens: num(response.usage?.totalTokens),
  };
  const account = deps.db.prepare("SELECT account_id FROM emails WHERE id = ?").get(emailId) as { account_id: string } | undefined;
  try {
    deps.db.prepare(
      `INSERT INTO audit_log (occurred_at, trace_id, actor, action, account_id, email_id, details_json)
       VALUES (?, ?, 'system', 'draft_generated', ?, ?, ?)`,
    ).run((deps.now ?? (() => new Date()))().toISOString(), deps.traceId ?? crypto.randomUUID(), account?.account_id ?? null, emailId,
      JSON.stringify({ model: REPLY_DRAFTER_MODEL, latency_ms, ...usage }));
  } catch {
    // The draft stays usable; a failed audit write must not leak details either.
  }
  return { ok: true, draft, model: REPLY_DRAFTER_MODEL, latency_ms, usage };
}
