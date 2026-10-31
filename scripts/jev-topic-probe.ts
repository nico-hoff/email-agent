// Live-Probe fuer ADR 0026 (R8): wie viele `topic`-Optionen unterscheidet Jev zuverlaessig?
// Aufruf: npm run jev:probe:topics -- --confirm-live --options 6|9|12|16|two-stage [--n 96] [--seed 1] [--max-calls 200]
//   (node --env-file=<env-datei> scripts/jev-topic-probe.ts ...). Nur synthetische Inhalte (ADR 0028):
//   tests/fixtures/eval/topics-synthetic.jsonl, handgeschrieben. Die HF-Sets (triage `travel`/`finance` usw.) werden
//   bewusst nicht gemappt: ihre Kategorien sind Triage-Klassen, kein eindeutiges Alltagsthema.
// Der Bericht (data/eval-runs/, gitignored) enthaelt nur IDs, erwartete/tatsaechliche Schluessel und Aggregate;
// nie Betreff, Body oder Roh-Responses. Keine Datenbank, kein IMAP. Nicht in CI (Tests nutzen einen Fake).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { JEV_MODEL, PROJECT_ROOT } from "../lib/constants.ts";
import { mulberry32, shuffle } from "../lib/eval-sources.ts";
import { createJevClient, type JevClient } from "../lib/jev.ts";
import { buildState, type JevQuestion } from "../lib/jev-questions.ts";
import { normalizeAnswers } from "../lib/jev-response.ts";
import { createLimiter } from "../lib/limiter.ts";
import {
  buildTopicList,
  FALLBACK_TOPIC_KEY,
  selectTopicOptions,
  type CustomTopicInput,
  type TopicOption,
} from "../lib/topics.ts";

export const FIXTURE_PATH = join(PROJECT_ROOT, "tests", "fixtures", "eval", "topics-synthetic.jsonl");
export const REPORT_DIR = join(PROJECT_ROOT, "data", "eval-runs");

/** The four example custom topics of the probe (fixture has cases for each). */
export const PROBE_CUSTOM: readonly CustomTopicInput[] = [
  { label: "Segelverein" },
  { label: "Hausbau" },
  { label: "Steuerberater" },
  { label: "Auto" },
];

export const VARIANTS = ["6", "9", "12", "16", "two-stage"] as const;
export type Variant = (typeof VARIANTS)[number];

export type TopicCase = {
  id: string;
  lang: string;
  sender_domain: string;
  subject: string;
  body: string;
  expected_topic: string;
};

export type ProbeArgs =
  | { ok: true; confirmLive: boolean; variants: Variant[]; n: number; seed: number; maxCalls: number }
  | { ok: false; error: string };

function int(v: string | undefined): number | null {
  return v !== undefined && /^\d+$/.test(v) ? Number(v) : null;
}

export function parseProbeArgs(argv: string[]): ProbeArgs {
  let confirmLive = false;
  let variants: Variant[] = [];
  let n = 96;
  let seed = 1;
  let maxCalls = 200;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--confirm-live") confirmLive = true;
    else if (a === "--options") {
      const v = argv[++i];
      const picked = (v ?? "").split(",");
      if (picked.length === 0 || !picked.every((p): p is Variant => (VARIANTS as readonly string[]).includes(p))) {
        return { ok: false, error: `--options expects ${VARIANTS.join("|")} (comma separated)` };
      }
      variants = picked as Variant[];
    } else if (a === "--n" || a === "--seed" || a === "--max-calls") {
      const v = int(argv[++i]);
      if (v === null || (a !== "--seed" && v < 1)) return { ok: false, error: `${a} expects a positive integer` };
      if (a === "--n") n = v;
      else if (a === "--seed") seed = v;
      else maxCalls = v;
    } else return { ok: false, error: `unknown option: ${a}` };
  }
  if (variants.length === 0) return { ok: false, error: `--options is required (${VARIANTS.join("|")})` };
  return { ok: true, confirmLive, variants, n, seed, maxCalls };
}

export function parseTopicCases(text: string): TopicCase[] {
  return text.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as TopicCase);
}

export function loadTopicCases(path = FIXTURE_PATH): TopicCase[] {
  return parseTopicCases(readFileSync(path, "utf8"));
}

/** Seeded sample stratified by expected topic (round robin over shuffled strata); same seed and n give the same cases. */
export function sampleTopicCases(cases: readonly TopicCase[], n: number, seed: number): TopicCase[] {
  const rnd = mulberry32(seed);
  const strata = new Map<string, TopicCase[]>();
  for (const c of cases) strata.set(c.expected_topic, [...(strata.get(c.expected_topic) ?? []), c]);
  const queues = [...strata.keys()].sort().map((k) => shuffle([...(strata.get(k) ?? [])], rnd));
  const out: TopicCase[] = [];
  while (out.length < n && queues.some((q) => q.length > 0)) {
    for (const q of queues) {
      const next = q.shift();
      if (next && out.length < n) out.push(next);
    }
  }
  return out;
}

export function variantOptions(variant: Exclude<Variant, "two-stage">): TopicOption[] {
  const list = buildTopicList(PROBE_CUSTOM);
  if (!list.ok) throw new Error(`probe topic list invalid: ${list.code}`);
  const count = Number(variant);
  return selectTopicOptions(list, Math.min(count, 12), count > 12);
}

export function buildTopicQuestion(options: readonly TopicOption[]): JevQuestion {
  return {
    type: "choice",
    instructions:
      "Which everyday topic does this mail belong to? Pick the single best fit. Use the catch-all option only if no other topic fits.",
    criteria: Object.fromEntries(options.map((o) => [o.key, o.criteria])),
  };
}

export type Row = {
  id: string;
  expected: string;
  actual: string | null;
  ms: number;
  cost: number;
  top_p: number | null;
  calls: number;
  error?: string;
};

export type ConfusionPair = { expected: string; actual: string; count: number };

export type VariantMetrics = {
  options: number;
  cases: number;
  in_set: number;
  out_of_set: number;
  errors: number;
  accuracy: number | null;
  macro_f1: number | null;
  /** Share of in-set cases (expected not the fallback) answered with the fallback topic. */
  abstain_rate: number | null;
  /** Share of out-of-set cases answered with the fallback topic (ideal 1). */
  out_of_set_to_fallback: number | null;
  mean_top_p: number | null;
  confusion: ConfusionPair[];
  latency_ms: { mean: number; p95: number } | null;
  calls: number;
  cost_usd: number;
  cost_per_call_usd: number | null;
};

function ratio(a: number, b: number): number | null {
  return b === 0 ? null : a / b;
}

export function computeMetrics(rows: readonly Row[], optionKeys: readonly string[]): VariantMetrics {
  const keys = new Set(optionKeys);
  const answered = rows.filter((r) => r.actual !== null);
  const inSet = answered.filter((r) => keys.has(r.expected));
  const outSet = answered.filter((r) => !keys.has(r.expected));
  const hits = inSet.filter((r) => r.actual === r.expected).length;

  const f1s: number[] = [];
  for (const k of optionKeys) {
    const tp = inSet.filter((r) => r.expected === k && r.actual === k).length;
    const fn = inSet.filter((r) => r.expected === k && r.actual !== k).length;
    const fp = inSet.filter((r) => r.expected !== k && r.actual === k).length;
    if (tp + fn === 0) continue;
    const p = tp + fp === 0 ? 0 : tp / (tp + fp);
    const r = tp / (tp + fn);
    f1s.push(p + r === 0 ? 0 : (2 * p * r) / (p + r));
  }

  const pairs = new Map<string, ConfusionPair>();
  for (const r of inSet) {
    if (r.actual === r.expected || r.actual === null) continue;
    const k = `${r.expected}\u0000${r.actual}`;
    const cur = pairs.get(k);
    if (cur) cur.count++;
    else pairs.set(k, { expected: r.expected, actual: r.actual, count: 1 });
  }
  const confusion = [...pairs.values()]
    .sort((a, b) => b.count - a.count || a.expected.localeCompare(b.expected) || a.actual.localeCompare(b.actual))
    .slice(0, 8);

  const nonFallback = inSet.filter((r) => r.expected !== FALLBACK_TOPIC_KEY);
  const probs = answered.map((r) => r.top_p).filter((p): p is number => p !== null);
  const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
  const calls = rows.reduce((s, r) => s + r.calls, 0);
  const cost = rows.reduce((s, r) => s + r.cost, 0);
  return {
    options: optionKeys.length,
    cases: rows.length,
    in_set: inSet.length,
    out_of_set: outSet.length,
    errors: rows.length - answered.length,
    accuracy: ratio(hits, inSet.length),
    macro_f1: f1s.length === 0 ? null : f1s.reduce((a, b) => a + b, 0) / f1s.length,
    abstain_rate: ratio(nonFallback.filter((r) => r.actual === FALLBACK_TOPIC_KEY).length, nonFallback.length),
    out_of_set_to_fallback: ratio(outSet.filter((r) => r.actual === FALLBACK_TOPIC_KEY).length, outSet.length),
    mean_top_p: probs.length === 0 ? null : probs.reduce((a, b) => a + b, 0) / probs.length,
    confusion,
    latency_ms: ms.length === 0 ? null : { mean: ms.reduce((a, b) => a + b, 0) / ms.length, p95: ms[Math.min(ms.length - 1, Math.ceil(ms.length * 0.95) - 1)] },
    calls,
    cost_usd: cost,
    cost_per_call_usd: ratio(cost, calls),
  };
}

type AskResult = { ok: true; key: string; topP: number | null; cost: number; ms: number } | { ok: false; error: string; cost: number; ms: number };

async function ask(jev: JevClient, options: readonly TopicOption[], c: TopicCase): Promise<AskResult> {
  const questions = { topic: buildTopicQuestion(options) };
  const state = buildState({ sender_domain: c.sender_domain, untrusted_subject: c.subject, untrusted_body: c.body });
  const t0 = performance.now();
  const res = await jev.classify({ questions, state });
  const ms = performance.now() - t0;
  if (!res.ok) return { ok: false, error: `${res.kind}:${res.statusCode ?? "-"}:${res.errorName}`, cost: 0, ms };
  const cost = typeof res.response.usage?.cost === "number" ? res.response.usage.cost : 0;
  const norm = normalizeAnswers(res.response.answers, questions);
  if (!norm.ok) return { ok: false, error: `invalid_response:${norm.code}`, cost, ms };
  const a = norm.answers[0];
  const probs = a.probabilities;
  const topP = probs ? Math.max(...Object.values(probs)) : null;
  return { ok: true, key: String(a.value), topP, cost, ms };
}

async function runPool<T, R>(items: readonly T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const limit = createLimiter(concurrency);
  return Promise.all(items.map((it) => limit(() => fn(it))));
}

export async function runSingleStage(input: { jev: JevClient; cases: readonly TopicCase[]; options: readonly TopicOption[]; concurrency?: number }): Promise<Row[]> {
  return runPool(input.cases, input.concurrency ?? 4, async (c): Promise<Row> => {
    const r = await ask(input.jev, input.options, c);
    return r.ok
      ? { id: c.id, expected: c.expected_topic, actual: r.key, ms: r.ms, cost: r.cost, top_p: r.topP, calls: 1 }
      : { id: c.id, expected: c.expected_topic, actual: null, ms: r.ms, cost: r.cost, top_p: null, calls: 1, error: r.error };
  });
}

/**
 * Two stages: stage 1 asks among the 12 fixed topics, the fallback criteria saying that special-interest topics land
 * there; only mails answered with the fallback go to stage 2 (the user's custom topics plus the fallback).
 */
export async function runTwoStage(input: { jev: JevClient; cases: readonly TopicCase[]; concurrency?: number }): Promise<Row[]> {
  const list = buildTopicList(PROBE_CUSTOM);
  if (!list.ok) throw new Error(`probe topic list invalid: ${list.code}`);
  const fixed = list.options.filter((o) => o.kind === "fixed").map((o) =>
    o.key === FALLBACK_TOPIC_KEY ? { ...o, criteria: `${o.criteria} Also use this for special interests that none of the other topics covers.` } : o
  );
  const stage2 = [...list.options.filter((o) => o.kind === "custom"), ...fixed.filter((o) => o.key === FALLBACK_TOPIC_KEY)];
  return runPool(input.cases, input.concurrency ?? 4, async (c): Promise<Row> => {
    const r1 = await ask(input.jev, fixed, c);
    if (!r1.ok) return { id: c.id, expected: c.expected_topic, actual: null, ms: r1.ms, cost: r1.cost, top_p: null, calls: 1, error: r1.error };
    if (r1.key !== FALLBACK_TOPIC_KEY) return { id: c.id, expected: c.expected_topic, actual: r1.key, ms: r1.ms, cost: r1.cost, top_p: r1.topP, calls: 1 };
    const r2 = await ask(input.jev, stage2, c);
    const ms = r1.ms + r2.ms;
    const cost = r1.cost + r2.cost;
    return r2.ok
      ? { id: c.id, expected: c.expected_topic, actual: r2.key, ms, cost, top_p: r2.topP, calls: 2 }
      : { id: c.id, expected: c.expected_topic, actual: null, ms, cost, top_p: null, calls: 2, error: r2.error };
  });
}

export type VariantReport = { variant: Variant; option_keys: string[]; metrics: VariantMetrics; rows: Row[] };

export async function runVariant(input: { jev: JevClient; variant: Variant; cases: readonly TopicCase[]; concurrency?: number }): Promise<VariantReport> {
  if (input.variant === "two-stage") {
    const list = buildTopicList(PROBE_CUSTOM);
    if (!list.ok) throw new Error(`probe topic list invalid: ${list.code}`);
    const rows = await runTwoStage(input);
    const keys = list.options.map((o) => o.key);
    return { variant: input.variant, option_keys: keys, metrics: computeMetrics(rows, keys), rows };
  }
  const options = variantOptions(input.variant);
  const rows = await runSingleStage({ jev: input.jev, cases: input.cases, options, concurrency: input.concurrency });
  const keys = options.map((o) => o.key);
  return { variant: input.variant, option_keys: keys, metrics: computeMetrics(rows, keys), rows };
}

export function formatVariant(r: VariantReport): string[] {
  const m = r.metrics;
  const f = (v: number | null, d = 3) => (v === null ? "n/a" : v.toFixed(d));
  return [
    `variant ${r.variant}: options=${m.options} cases=${m.cases} in_set=${m.in_set} out_of_set=${m.out_of_set} errors=${m.errors}`,
    `  accuracy=${f(m.accuracy)} macro_f1=${f(m.macro_f1)} abstain_rate=${f(m.abstain_rate)} out_of_set_to_fallback=${f(m.out_of_set_to_fallback)} mean_top_p=${f(m.mean_top_p)}`,
    `  latency_ms mean=${f(m.latency_ms?.mean ?? null, 0)} p95=${f(m.latency_ms?.p95 ?? null, 0)} calls=${m.calls} cost_usd=${m.cost_usd.toFixed(5)}`,
    ...m.confusion.map((c) => `  confusion ${c.expected} -> ${c.actual}: ${c.count}`),
  ];
}

export function buildReport(input: { createdAt: string; seed: number; n: number; reports: readonly VariantReport[] }) {
  return {
    created_at: input.createdAt,
    model_requested: JEV_MODEL,
    seed: input.seed,
    n: input.n,
    fixture: "tests/fixtures/eval/topics-synthetic.jsonl",
    variants: input.reports.map((r) => ({ variant: r.variant, option_keys: r.option_keys, metrics: r.metrics, rows: r.rows })),
  };
}

export function writeReport(dir: string, report: ReturnType<typeof buildReport>): string {
  mkdirSync(dir, { recursive: true });
  const stamp = report.created_at.replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
  const path = join(dir, `topics-${stamp}-seed${report.seed}.json`);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  return path;
}

/** Planned calls: single stage = n; two-stage = n plus the (unknown) stage-2 share, bounded by 2n. */
export function plannedCallsUpperBound(variants: readonly Variant[], n: number): number {
  return variants.reduce((s, v) => s + (v === "two-stage" ? 2 * n : n), 0);
}

async function main(): Promise<number> {
  const args = parseProbeArgs(process.argv.slice(2));
  if (!args.ok) {
    console.error(args.error);
    return 2;
  }
  if (!args.confirmLive) {
    console.error("refusing to call the live endpoint without --confirm-live");
    return 2;
  }
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error("OPENROUTER_API_KEY is not set");
    return 2;
  }
  const planned = plannedCallsUpperBound(args.variants, args.n);
  if (planned > args.maxCalls) {
    console.error(`planned up to ${planned} calls exceeds --max-calls ${args.maxCalls}`);
    return 2;
  }
  const cases = sampleTopicCases(loadTopicCases(), args.n, args.seed);
  const jev = createJevClient({ apiKey, timeoutMs: 60_000, limiter: createLimiter(4) });
  const reports: VariantReport[] = [];
  for (const variant of args.variants) {
    const r = await runVariant({ jev, variant, cases });
    reports.push(r);
    for (const line of formatVariant(r)) console.log(line);
  }
  const path = writeReport(REPORT_DIR, buildReport({ createdAt: new Date().toISOString(), seed: args.seed, n: cases.length, reports }));
  console.log(`report: data/eval-runs/${path.split("/").pop()}`);
  return reports.some((r) => r.metrics.errors > 0) ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
