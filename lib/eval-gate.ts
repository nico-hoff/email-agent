// Offline eval gate for Jev answers (T27). Pure functions plus two small file loaders.
//
// A gate dataset (evals/datasets/*.jsonl, one JSON object per line) holds, per synthetic eval case, the NORMALIZED
// answers of one run (typed values only) and the expected values of the case. Never subject, body, sender or any
// other mail text (H3): ids must come from the committed synthetic eval sets, every string must be a key or an option
// name. evals/jev-email.eval.ts grades the dataset with Veryfront's evalDataset and metrics.answer.jsonMatch.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { EvalExpected } from "./eval-sources.ts";
import { QUESTION_SET_VERSIONS, questionsFor } from "./jev-questions.ts";
import type { NormalizedAnswer } from "./jev-response.ts";

export const GATE_DATASET_DIR = "evals/datasets";
export const SYNTHETIC_SET_DIR = "tests/fixtures/eval";
/** Ids that do not come from the synthetic sets: cases built from committed live fixtures of synthetic mails. */
export const FIXTURE_CASE_IDS: readonly string[] = ["fixture-v1-ad"];
/** Same provisional rule as eval:jev (scripts/eval-jev.ts, PROVISIONAL_NOUL_THRESHOLD): raw >= 0.5 counts as true. */
export const GATE_NOUL_THRESHOLD = 0.5;

export type GateDatasetName = "v1" | "v2";
export type GateLine = {
  id: string;
  dataset: GateDatasetName;
  question_set_version: string;
  /** `live`: answers of a real eval:jev run. `derived`: built from the expected values (plumbing baseline only). */
  origin: "live" | "derived";
  expected: EvalExpected;
  answers: NormalizedAnswer[];
};

export class GateDatasetError extends Error {
  readonly code = "gate_dataset_invalid";
  constructor(detail: string) {
    // Line numbers and field paths only, never values.
    super(`gate_dataset_invalid: ${detail}`);
    this.name = "GateDatasetError";
  }
}

const NAME = /^[a-z][a-z0-9_]*$/;
const lineSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  dataset: z.enum(["v1", "v2"]),
  question_set_version: z.string().refine((v) => (QUESTION_SET_VERSIONS as readonly string[]).includes(v)),
  origin: z.enum(["live", "derived"]),
  expected: z.strictObject({
    category: z.string().regex(NAME).optional(),
    is_spam: z.boolean().optional(),
    is_phishing_or_scam: z.boolean().optional(),
    addresses_an_ai: z.boolean().optional(),
    is_assessable: z.boolean().optional(),
    needs_my_reply: z.boolean().optional(),
  }),
  answers: z.array(
    z.strictObject({
      key: z.string().regex(NAME),
      type: z.enum(["noul", "choice", "score"]),
      // numbers, or an option name: never free text
      value: z.union([z.number().finite(), z.string().regex(NAME)]),
      probabilities: z.record(z.string().regex(/^[a-z0-9_]+$/), z.number().min(0).max(1)).optional(),
    }),
  ),
});

function checkAgainstQuestions(line: z.infer<typeof lineSchema>, lineNo: number): void {
  const questions = questionsFor(line.question_set_version);
  const keys = line.answers.map((a) => a.key).sort();
  if (JSON.stringify(keys) !== JSON.stringify(Object.keys(questions).sort())) {
    throw new GateDatasetError(`line ${lineNo}: answers do not match the question set`);
  }
  for (const a of line.answers) {
    const q = new Map(Object.entries(questions)).get(a.key);
    if (!q || q.type !== a.type) throw new GateDatasetError(`line ${lineNo}: answers.${a.key}.type`);
    if (q.type === "choice" && !(typeof a.value === "string" && Object.hasOwn(q.criteria, a.value))) {
      throw new GateDatasetError(`line ${lineNo}: answers.${a.key}.value`);
    }
    if (q.type !== "choice" && typeof a.value !== "number") throw new GateDatasetError(`line ${lineNo}: answers.${a.key}.value`);
  }
  const category = new Map(Object.entries(questions)).get("category");
  if (line.expected.category !== undefined && !(category?.type === "choice" && Object.hasOwn(category.criteria, line.expected.category))) {
    throw new GateDatasetError(`line ${lineNo}: expected.category`);
  }
}

/** Parses and validates a gate dataset. `allowedIds` (the synthetic case ids) rejects every other id. */
export function parseGateDataset(text: string, o: { allowedIds?: ReadonlySet<string> } = {}): GateLine[] {
  const out: GateLine[] = [];
  const seen = new Set<string>();
  const rows = text.split("\n");
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].trim() === "") continue;
    let raw: unknown;
    try {
      raw = JSON.parse(rows[i]);
    } catch {
      throw new GateDatasetError(`line ${i + 1}: not JSON`);
    }
    const r = lineSchema.safeParse(raw);
    if (!r.success) {
      const paths = [...new Set(r.error.issues.map((x) => x.path.join(".") || "(root)"))].join(", ");
      throw new GateDatasetError(`line ${i + 1}: ${paths}`);
    }
    if (o.allowedIds && !o.allowedIds.has(r.data.id)) throw new GateDatasetError(`line ${i + 1}: id not in the synthetic sets`);
    if (seen.has(r.data.id)) throw new GateDatasetError(`line ${i + 1}: duplicate id`);
    seen.add(r.data.id);
    checkAgainstQuestions(r.data, i + 1);
    out.push(r.data as GateLine);
  }
  return out;
}

export function serializeGateDataset(lines: readonly GateLine[]): string {
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

/** File name of a gate dataset: bound to the eval set and to the question set the answers came from. */
export function gateDatasetFileName(dataset: GateDatasetName, questionSet: "v1" | "v2"): string {
  return `email-eval-${dataset}__qs-${questionSet}.jsonl`;
}

/** Verdicts for exactly the questions the case expects. A missing answer is `null` and can never match. */
export function gateVerdict(line: GateLine): Record<string, string | boolean | null> {
  const byKey = new Map(line.answers.map((a) => [a.key, a]));
  const verdict: Record<string, string | boolean | null> = {};
  for (const [key, exp] of Object.entries(line.expected)) {
    if (exp === undefined) continue;
    const a = byKey.get(key);
    if (key === "category") verdict[key] = typeof a?.value === "string" ? a.value : null;
    else verdict[key] = typeof a?.value === "number" ? a.value >= GATE_NOUL_THRESHOLD : null;
  }
  return verdict;
}

export type GateExample = {
  id: string;
  input: Record<string, string | boolean | null>;
  reference: EvalExpected;
  metadata: { dataset: string; question_set_version: string; origin: string };
};

/** Veryfront dataset examples: the stored verdicts are graded directly (no target), `reference` is the expectation. */
export function toEvalExamples(lines: readonly GateLine[], prefix: string): GateExample[] {
  return lines
    .filter((l) => Object.keys(l.expected).length > 0)
    .map((l) => ({
      id: `${prefix}:${l.id}`,
      input: gateVerdict(l),
      reference: l.expected,
      metadata: { dataset: l.dataset, question_set_version: l.question_set_version, origin: l.origin },
    }));
}

/**
 * Gate lines from a finished eval:jev run of a fixed set. Null for a run with errors, an abort or missing answers:
 * a partial dataset would silently shrink the gate.
 */
export function gateLinesFromReport(input: {
  dataset: GateDatasetName;
  questionSetVersion: string;
  cases: readonly { id: string; expected: EvalExpected }[];
  report: { errors: { count: number }; aborted?: unknown; caseResults: readonly { id: string; answers?: NormalizedAnswer[]; error?: string }[] };
  origin: "live" | "derived";
}): GateLine[] | null {
  const { report } = input;
  if (report.errors.count > 0 || report.aborted || report.caseResults.length !== input.cases.length) return null;
  const results = new Map(report.caseResults.map((r) => [r.id, r]));
  const lines: GateLine[] = [];
  for (const c of input.cases) {
    const r = results.get(c.id);
    if (!r || r.error || !r.answers) return null;
    if (Object.keys(c.expected).length === 0) continue;
    lines.push({
      id: c.id,
      dataset: input.dataset,
      question_set_version: input.questionSetVersion,
      origin: input.origin,
      expected: c.expected,
      answers: r.answers.map((a) => ({
        key: a.key,
        type: a.type,
        value: a.value,
        ...(a.probabilities ? { probabilities: a.probabilities } : {}),
      })),
    });
  }
  return lines;
}

/** Ids of the committed synthetic eval sets plus the fixture-derived ids. */
export function loadSyntheticIds(root: string): Set<string> {
  const ids = new Set<string>(FIXTURE_CASE_IDS);
  const dir = join(root, SYNTHETIC_SET_DIR);
  if (!existsSync(dir)) return ids;
  for (const file of readdirSync(dir).filter((f) => /^email-eval-.*\.jsonl$/.test(f))) {
    for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
      if (line.trim() === "") continue;
      const id = (JSON.parse(line) as { id?: unknown }).id;
      if (typeof id === "string") ids.add(id);
    }
  }
  return ids;
}

/** All gate datasets of the project, validated against the synthetic ids. `stem` namespaces the example ids. */
export function loadGateDatasets(root: string): { stem: string; lines: GateLine[] }[] {
  const dir = join(root, GATE_DATASET_DIR);
  if (!existsSync(dir)) return [];
  const allowedIds = loadSyntheticIds(root);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .map((f) => ({ stem: f.replace(/\.jsonl$/, ""), lines: parseGateDataset(readFileSync(join(dir, f), "utf8"), { allowedIds }) }));
}
