// Offline gate "Eval gruen" for the question set v3 / topics (R8, ADR 0037). Pure functions plus a small loader.
// A gate dataset (evals/datasets/topics-v3__<model>.jsonl) holds the NORMALIZED answers of one live run per model: ids,
// expected values, topic keys and noul numbers. Never a subject, body, sender or any other mail text (H3). `npm run eval`
// (evals/topics-v3.eval.ts) and tests/topics-gate.test.ts evaluate it; the switch `topics_enabled` may only be offered to
// users when both are green. Rule (per model):
//   1. topic accuracy >= 0.85 AND macro-F1 >= 0.85 on the synthetic topic fixture with the FULL v3 question set (>= 100 cases);
//   2. for every noul question with >= 5 positives among >= 30 paired HF cases: F1 of v3 at the v3 threshold is not worse
//      than F1 of v2 at the v2 threshold by more than 0.02 (the topic question must not disturb the other answers).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { QUESTION_SET_VERSION_V2, QUESTION_SET_VERSION_V3 } from "./constants.ts";
import { noulThreshold } from "./noul-calibration.ts";

export const TOPICS_GATE = {
  topicAccuracyMin: 0.85,
  topicMacroF1Min: 0.85,
  noulF1MaxDrop: 0.02,
  minTopicCases: 100,
  minHfCases: 30,
  minPositives: 5,
} as const;

const NOUL_GATE_KEYS = ["is_spam", "is_phishing_or_scam", "addresses_an_ai", "needs_my_reply", "is_assessable"] as const;
const KEY = /^[a-z][a-z0-9_]*$/;
const ID = /^[a-z0-9][a-z0-9:_.-]*$/;

const noulValues = z.record(z.string().regex(KEY), z.number().min(0).max(1));
const common = { id: z.string().regex(ID), model: z.string().regex(/^[a-z0-9./_-]+$/), question_set_version: z.literal(QUESTION_SET_VERSION_V3) };
const topicLine = z.strictObject({
  suite: z.literal("topics"),
  ...common,
  list_version: z.string().regex(/^topics-[a-f0-9]{12}$/),
  expected_topic: z.string().regex(KEY),
  topic: z.string().regex(KEY),
});
const hfLine = z.strictObject({
  suite: z.literal("hf"),
  ...common,
  expected: z.strictObject({
    is_spam: z.boolean().optional(),
    is_phishing_or_scam: z.boolean().optional(),
    addresses_an_ai: z.boolean().optional(),
    needs_my_reply: z.boolean().optional(),
    is_assessable: z.boolean().optional(),
  }),
  v2: noulValues,
  v3: noulValues,
  v3_topic: z.string().regex(KEY),
});
const line = z.discriminatedUnion("suite", [topicLine, hfLine]);

export type TopicsGateLine = z.infer<typeof line>;
export type TopicGateLine = z.infer<typeof topicLine>;
export type HfGateLine = z.infer<typeof hfLine>;

export class TopicsGateError extends Error {
  readonly code = "topics_gate_dataset_invalid";
  constructor(detail: string) {
    // Line numbers and field paths only, never values.
    super(`topics_gate_dataset_invalid: ${detail}`);
    this.name = "TopicsGateError";
  }
}

export function parseTopicsGateDataset(text: string): TopicsGateLine[] {
  const out: TopicsGateLine[] = [];
  const seen = new Set<string>();
  const rows = text.split("\n");
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].trim() === "") continue;
    let raw: unknown;
    try {
      raw = JSON.parse(rows[i]);
    } catch {
      throw new TopicsGateError(`line ${i + 1}: not JSON`);
    }
    const r = line.safeParse(raw);
    if (!r.success) throw new TopicsGateError(`line ${i + 1}: ${[...new Set(r.error.issues.map((x) => x.path.join(".") || "(root)"))].join(", ")}`);
    const id = `${r.data.suite}:${r.data.id}`;
    if (seen.has(id)) throw new TopicsGateError(`line ${i + 1}: duplicate id`);
    seen.add(id);
    out.push(r.data);
  }
  return out;
}

export function serializeTopicsGateDataset(lines: readonly TopicsGateLine[]): string {
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

// ---- metrics ----------------------------------------------------------------------------------------------------

export function accuracy(expected: readonly string[], actual: readonly string[]): number | null {
  return expected.length === 0 ? null : expected.filter((e, i) => e === actual[i]).length / expected.length;
}

/** Macro-F1 over the classes that occur in `expected` (a class that is only predicted does not add a zero row). */
export function macroF1(expected: readonly string[], actual: readonly string[]): number | null {
  const classes = [...new Set(expected)];
  if (classes.length === 0) return null;
  const f1s = classes.map((k) => {
    let tp = 0, fp = 0, fn = 0;
    expected.forEach((e, i) => {
      if (actual[i] === k && e === k) tp++;
      else if (actual[i] === k) fp++;
      else if (e === k) fn++;
    });
    return tp + fp + fn === 0 ? 0 : (2 * tp) / (2 * tp + fp + fn);
  });
  return f1s.reduce((a, b) => a + b, 0) / f1s.length;
}

function f1At(scores: readonly number[], labels: readonly boolean[], t: number): number | null {
  let tp = 0, fp = 0, fn = 0;
  scores.forEach((s, i) => {
    const pred = s >= t;
    if (pred && labels[i]) tp++;
    else if (pred) fp++;
    else if (labels[i]) fn++;
  });
  return tp + fp + fn === 0 ? null : (2 * tp) / (2 * tp + fp + fn);
}

export interface NoulGateRow {
  key: string;
  n: number;
  positives: number;
  threshold_v2: number | null;
  threshold_v3: number | null;
  f1_v2: number | null;
  f1_v3: number | null;
  /** null = not assessable (too few positives or no threshold); true/false = within the allowed drop. */
  ok: boolean | null;
}

export interface TopicsGateResult {
  model: string;
  topic: { n: number; accuracy: number | null; macro_f1: number | null; ok: boolean };
  noul: { paired_cases: number; rows: NoulGateRow[]; ok: boolean };
  green: boolean;
}

const round = (x: number | null) => (x === null ? null : Math.round(x * 1000) / 1000);

/** Evaluates the lines of ONE model. Lines of another model are ignored. */
export function evaluateTopicsGate(model: string, lines: readonly TopicsGateLine[]): TopicsGateResult {
  const topics = lines.filter((l): l is TopicGateLine => l.suite === "topics" && l.model === model);
  const hf = lines.filter((l): l is HfGateLine => l.suite === "hf" && l.model === model);
  const exp = topics.map((l) => l.expected_topic);
  const act = topics.map((l) => l.topic);
  const acc = accuracy(exp, act);
  const mf1 = macroF1(exp, act);
  const topicOk = topics.length >= TOPICS_GATE.minTopicCases && acc !== null && mf1 !== null &&
    acc >= TOPICS_GATE.topicAccuracyMin && mf1 >= TOPICS_GATE.topicMacroF1Min;

  const rows: NoulGateRow[] = [];
  for (const key of NOUL_GATE_KEYS) {
    const labelled = hf.flatMap((l) => {
      const e = new Map(Object.entries(l.expected)).get(key);
      const s2 = new Map(Object.entries(l.v2)).get(key);
      const s3 = new Map(Object.entries(l.v3)).get(key);
      return e === undefined || s2 === undefined || s3 === undefined ? [] : [{ e, s2, s3 }];
    });
    if (labelled.length === 0) continue;
    const t2 = noulThreshold(key, QUESTION_SET_VERSION_V2, model);
    const t3 = noulThreshold(key, QUESTION_SET_VERSION_V3, model);
    const labels = labelled.map((x) => x.e);
    const positives = labels.filter(Boolean).length;
    const f2 = t2 === null ? null : f1At(labelled.map((x) => x.s2), labels, t2);
    const f3 = t3 === null ? null : f1At(labelled.map((x) => x.s3), labels, t3);
    const assessable = positives >= TOPICS_GATE.minPositives && f2 !== null && f3 !== null;
    rows.push({
      key, n: labelled.length, positives, threshold_v2: t2, threshold_v3: t3, f1_v2: round(f2), f1_v3: round(f3),
      ok: assessable ? f3 >= f2 - TOPICS_GATE.noulF1MaxDrop - 1e-9 : null,
    });
  }
  const assessed = rows.filter((r) => r.ok !== null);
  const noulOk = hf.length >= TOPICS_GATE.minHfCases && assessed.length >= 2 && assessed.every((r) => r.ok === true);
  return {
    model,
    topic: { n: topics.length, accuracy: round(acc), macro_f1: round(mf1), ok: topicOk },
    noul: { paired_cases: hf.length, rows, ok: noulOk },
    green: topicOk && noulOk,
  };
}

// ---- files --------------------------------------------------------------------------------------------------------

export const TOPICS_GATE_DIR = "evals/datasets";
export const topicsGateFileName = (modelShort: string) => `topics-v3__${modelShort}.jsonl`;

/** All committed topic gate datasets of the project (one file per model), parsed and validated. */
export function loadTopicsGateDatasets(root: string): { file: string; lines: TopicsGateLine[] }[] {
  const dir = join(root, TOPICS_GATE_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^topics-v3__[a-z0-9-]+\.jsonl$/.test(f))
    .sort()
    .map((file) => ({ file, lines: parseTopicsGateDataset(readFileSync(join(dir, file), "utf8")) }));
}

/** Models that appear in a dataset's lines. */
export function modelsOf(lines: readonly TopicsGateLine[]): string[] {
  return [...new Set(lines.map((l) => l.model))].sort();
}
