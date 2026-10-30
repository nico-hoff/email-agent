// Offline eval gate for the reply agent and the briefing agent (T43). Pure functions plus small file loaders.
//
// Two committed things per agent:
//   1. the synthetic case set (tests/fixtures/eval/<agent>-v1.jsonl): input of a case and the rules its output must meet;
//   2. the stored outputs of one run (evals/datasets/<agent>__v1.jsonl): ONE output per case.
// evals/*.eval.ts grades every stored output with the deterministic checks of lib/agent-eval-checks.ts through Veryfront's
// evalDataset and metrics.answer.jsonMatch. Everything in both files is synthetic (H3); the gate never calls a model.
// Meaning: `origin: "derived"` outputs are hand-made examples that meet the rules (plumbing only). Only `origin: "live"`
// outputs (written by `npm run eval:agents -- --write-dataset`, run by Nico) say anything about the real agents.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { AgentInput } from "./agent-input.ts";
import {
  checkBriefing,
  checkReplyDraft,
  type BriefingExpect,
  type CheckResult,
  type ReplyExpect,
  type ReplyOutput,
} from "./agent-eval-checks.ts";
import { buildBriefingContext, type BriefingContext, type OpenMail } from "./briefing-context.ts";

export const GATE_DATASET_DIR = "evals/datasets";
export const AGENT_SET_DIR = "tests/fixtures/eval";
export const AGENT_SET_FILES = { reply: "reply-drafter-v1.jsonl", briefing: "briefing-v1.jsonl" } as const;
export const AGENT_GATE_FILES = { reply: "reply-drafter__v1.jsonl", briefing: "briefing__v1.jsonl" } as const;
/** A stored output is a short synthetic text; anything longer is not a draft or a briefing. */
export const MAX_STORED_CHARS = 3000;

export class AgentGateError extends Error {
  readonly code = "gate_dataset_invalid";
  constructor(detail: string) {
    // Line numbers, ids and field paths only, never values.
    super(`gate_dataset_invalid: ${detail}`);
    this.name = "AgentGateError";
  }
}

export type Origin = "live" | "derived";

// ---- case sets ------------------------------------------------------------------------------------------------

export interface ReplyCase {
  id: string;
  lang: "de" | "en";
  sender_domain: string;
  subject: string;
  category: string;
  needs_my_reply: "positive" | "negative" | "unmapped";
  /** Synthetic mail excerpt. May contain an injection attempt on purpose. */
  excerpt: string;
  expect: ReplyExpect;
}

export interface BriefingCase {
  id: string;
  open: OpenMail[];
  counters: { new_since_last_open: number | null; auto_marked_read: number | null; open_questions: number };
  expect: BriefingExpect;
}

const ID = /^[a-z][a-z0-9-]*$/;
const counter = z.number().int().min(0).nullable();

const replyCaseSchema = z.strictObject({
  id: z.string().regex(ID),
  lang: z.enum(["de", "en"]),
  sender_domain: z.string().min(1),
  subject: z.string().min(1),
  category: z.string().min(1),
  needs_my_reply: z.enum(["positive", "negative", "unmapped"]),
  excerpt: z.string().min(1).max(1200),
  expect: z.strictObject({
    language: z.enum(["de", "en"]),
    must_not_contain: z.array(z.string().min(1)),
    must_contain_any: z.array(z.string().min(1)).optional(),
    max_chars: z.number().int().positive().optional(),
    needs_human_check: z.union([z.literal(true), z.literal("any")]),
  }),
});

const openMailSchema = z.strictObject({
  id: z.number().int(),
  received_at: z.string(),
  account_label: z.string(),
  sender: z.string(),
  subject: z.string(),
  category: z.string().nullable(),
  urgency: z.number().nullable(),
  importance: z.number().nullable(),
  addresses_an_ai: z.enum(["positive", "negative", "unmapped"]).nullable(),
});

const briefingCaseSchema = z.strictObject({
  id: z.string().regex(ID),
  open: z.array(openMailSchema),
  counters: z.strictObject({ new_since_last_open: counter, auto_marked_read: counter, open_questions: z.number().int().min(0) }),
  expect: z.strictObject({
    max_bullets: z.number().int().min(0),
    must_mention_any: z.array(z.string().min(1)).optional(),
    must_not_contain: z.array(z.string().min(1)),
  }),
});

function parseLines<T>(text: string, schema: z.ZodType<T>, what: string): T[] {
  const out: T[] = [];
  const ids = new Set<string>();
  const rows = text.split("\n");
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].trim() === "") continue;
    let raw: unknown;
    try {
      raw = JSON.parse(rows[i]);
    } catch {
      throw new AgentGateError(`${what} line ${i + 1}: not JSON`);
    }
    const r = schema.safeParse(raw);
    if (!r.success) {
      const paths = [...new Set(r.error.issues.map((x) => x.path.join(".") || "(root)"))].join(", ");
      throw new AgentGateError(`${what} line ${i + 1}: ${paths}`);
    }
    const id = (r.data as { id: string }).id;
    if (ids.has(id)) throw new AgentGateError(`${what} line ${i + 1}: duplicate id`);
    ids.add(id);
    out.push(r.data);
  }
  return out;
}

export function parseReplyCases(text: string): ReplyCase[] {
  return parseLines(text, replyCaseSchema, "reply case set") as ReplyCase[];
}

export function parseBriefingCases(text: string): BriefingCase[] {
  return parseLines(text, briefingCaseSchema, "briefing case set") as BriefingCase[];
}

export function loadReplyCases(root: string): ReplyCase[] {
  return parseReplyCases(readFileSync(join(root, AGENT_SET_DIR, AGENT_SET_FILES.reply), "utf8"));
}

export function loadBriefingCases(root: string): BriefingCase[] {
  return parseBriefingCases(readFileSync(join(root, AGENT_SET_DIR, AGENT_SET_FILES.briefing), "utf8"));
}

// ---- case -> agent input, case -> checks ------------------------------------------------------------------------

/** The input the reply agent gets, built exactly like lib/agent-input.ts does (without IMAP). */
export function replyInputOf(c: ReplyCase): AgentInput {
  return {
    sender_domain: c.sender_domain,
    subject: c.subject,
    excerpt: { trust: "untrusted", text: c.excerpt },
    category: c.category,
    needs_my_reply: c.needs_my_reply,
  };
}

/** The briefing context of a case, built by the real function the route uses. */
export function briefingContextOf(c: BriefingCase): BriefingContext {
  return buildBriefingContext(c.open, c.counters);
}

export function checkReplyCase(c: ReplyCase, out: ReplyOutput): CheckResult {
  return checkReplyDraft(c.expect, out);
}

/** Allowed domains: those of the context. Counted-only mails (addresses_an_ai not negative) must not be listed. */
export function checkBriefingCase(c: BriefingCase, text: string): CheckResult {
  const ctx = briefingContextOf(c);
  return checkBriefing(c.expect, text, {
    open_total: ctx.open_total,
    allowed_domains: [...new Set(ctx.mails.map((m) => m.sender_domain).filter((d) => d.length > 0))],
    counted_only_subjects: c.open.filter((m) => m.addresses_an_ai !== "negative").map((m) => m.subject),
  });
}

// ---- stored outputs -------------------------------------------------------------------------------------------

export interface ReplyGateLine {
  id: string;
  origin: Origin;
  output: ReplyOutput;
}

export interface BriefingGateLine {
  id: string;
  origin: Origin;
  output: { text: string };
}

const text = z.string().max(MAX_STORED_CHARS);
const replyGateSchema = z.strictObject({
  id: z.string().regex(ID),
  origin: z.enum(["live", "derived"]),
  output: z.strictObject({
    draft: text,
    language: z.enum(["de", "en"]),
    tone: z.string().max(200),
    needs_human_check: z.boolean(),
    reasons: z.array(z.string().max(300)).max(10),
  }),
});
const briefingGateSchema = z.strictObject({
  id: z.string().regex(ID),
  origin: z.enum(["live", "derived"]),
  output: z.strictObject({ text }),
});

function withKnownIds<T extends { id: string }>(lines: T[], allowedIds: ReadonlySet<string>, what: string): T[] {
  lines.forEach((l, i) => {
    if (!allowedIds.has(l.id)) throw new AgentGateError(`${what} line ${i + 1}: id not in the synthetic set`);
  });
  return lines;
}

export function parseReplyGate(content: string, allowedIds: ReadonlySet<string>): ReplyGateLine[] {
  return withKnownIds(parseLines(content, replyGateSchema, "reply gate dataset") as ReplyGateLine[], allowedIds, "reply gate dataset");
}

export function parseBriefingGate(content: string, allowedIds: ReadonlySet<string>): BriefingGateLine[] {
  return withKnownIds(parseLines(content, briefingGateSchema, "briefing gate dataset") as BriefingGateLine[], allowedIds, "briefing gate dataset");
}

export const serializeReplyGate = (lines: readonly ReplyGateLine[]): string => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
export const serializeBriefingGate = (lines: readonly BriefingGateLine[]): string => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";

function loadGateFile(root: string, file: string): string {
  const path = join(root, GATE_DATASET_DIR, file);
  if (!existsSync(path)) throw new AgentGateError(`${file}: missing`);
  return readFileSync(path, "utf8");
}

export function loadReplyGate(root: string): ReplyGateLine[] {
  return parseReplyGate(loadGateFile(root, AGENT_GATE_FILES.reply), new Set(loadReplyCases(root).map((c) => c.id)));
}

export function loadBriefingGate(root: string): BriefingGateLine[] {
  return parseBriefingGate(loadGateFile(root, AGENT_GATE_FILES.briefing), new Set(loadBriefingCases(root).map((c) => c.id)));
}

// ---- Veryfront dataset examples -------------------------------------------------------------------------------

export interface AgentGateExample {
  id: string;
  /** The check result of the stored output: `{ ok, violations }` (rule codes only). */
  input: CheckResult;
  /** Every stored output must be clean. */
  reference: CheckResult;
  metadata: { agent: string; origin: Origin };
}

const CLEAN: CheckResult = { ok: true, violations: [] };

function byId<T extends { id: string }>(lines: readonly T[], id: string): T {
  const l = lines.find((x) => x.id === id);
  if (!l) throw new AgentGateError(`${id}: no stored output for this case`);
  return l;
}

/** One example per case. A case without a stored output throws: the gate must not shrink silently. */
export function replyGateExamples(cases: readonly ReplyCase[], lines: readonly ReplyGateLine[], prefix: string): AgentGateExample[] {
  return cases.map((c) => {
    const l = byId(lines, c.id);
    return { id: `${prefix}:${c.id}`, input: checkReplyCase(c, l.output), reference: CLEAN, metadata: { agent: "reply-drafter", origin: l.origin } };
  });
}

export function briefingGateExamples(cases: readonly BriefingCase[], lines: readonly BriefingGateLine[], prefix: string): AgentGateExample[] {
  return cases.map((c) => {
    const l = byId(lines, c.id);
    return { id: `${prefix}:${c.id}`, input: checkBriefingCase(c, l.output.text), reference: CLEAN, metadata: { agent: "briefing", origin: l.origin } };
  });
}
