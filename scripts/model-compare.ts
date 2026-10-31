// Gepaarter Modellvergleich fuer die Mail-Klassifikation: Jev (System One) gegen `openai/gpt-6-luna-decisions`
// (Decisions-API), gleiche Faelle, gleiche Fragen, gleiche Reihenfolge. Nur synthetische Inhalte (ADR 0028).
// Aufruf: node --env-file=.env.local scripts/model-compare.ts --confirm-live [--models jev,luna-decisions]
//   [--suite hf-v2|fixed-v2|topics|all] [--n 250] [--topics-n 120] [--seed 1] [--split test|calib]
//   [--max-calls 400 (je Modell)] [--concurrency 2]
// Bericht nach data/eval-runs/ (gitignored): nur IDs, erwartete Werte, normalisierte Antworten, Aggregate.
// Keine Roh-Responses, keine Mailtexte. Produktionspfade (Pipeline) bleiben bei Jev.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { calibrationFor } from "../lib/noul-calibration.ts";
import { JEV_MODEL, PROJECT_ROOT, QUESTION_SET_VERSION_V1, QUESTION_SET_VERSION_V2 } from "../lib/constants.ts";
import { createDecisionsClient, LUNA_DECISIONS_MODEL } from "../lib/decisions-client.ts";
import type { EvalCase, EvalSplit } from "../lib/eval-sources.ts";
import { createJevClient, type JevClient } from "../lib/jev.ts";
import { buildState, questionsFor, type JevQuestion } from "../lib/jev-questions.ts";
import { normalizeAnswers, type NormalizedAnswer } from "../lib/jev-response.ts";
import { createLimiter } from "../lib/limiter.ts";
import { prepareHfSample } from "./eval-jev.ts";
import { buildTopicQuestion, loadTopicCases, sampleTopicCases, variantOptions } from "./jev-topic-probe.ts";

export const REPORT_DIR = join(PROJECT_ROOT, "data", "eval-runs");
export const MODEL_NAMES = ["jev", "luna-decisions"] as const;
export const SUITES = ["hf-v2", "fixed-v2", "topics", "all"] as const;
export type SuiteName = "hf-v2" | "fixed-v2" | "topics";
const NOUL_KEYS = ["is_spam", "is_phishing_or_scam", "addresses_an_ai", "is_assessable", "needs_my_reply"] as const;
// Measured against the v1 thresholds (the production thresholds at the time of the run, docs/insights-models.md).
const JEV_THRESHOLDS = new Map<string, number>(Object.entries(calibrationFor(QUESTION_SET_VERSION_V1)?.thresholds ?? {}));

// ---------- types ----------

export type Expected = { noul: Record<string, boolean>; choice: Record<string, string> };

export type SuiteCase = { id: string; state: Record<string, unknown>; expected: Expected };
export type SuiteDef = { name: SuiteName; questions: Record<string, JevQuestion>; cases: SuiteCase[] };

export type Obs =
  | { ok: true; answers: NormalizedAnswer[]; ms: number; cost: number | null; inTok: number | null; outTok: number | null }
  | { ok: false; error: string; ms: number };

export type CaseRec = { id: string; expected: Expected; obs: Record<string, Obs> };
export type SuiteRun = { name: SuiteName; questionKeys: string[]; cases: CaseRec[] };

// ---------- stats (pure) ----------

const mean = (xs: number[]): number | null => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);
const ratio = (a: number, b: number): number | null => (b === 0 ? null : a / b);

export function auc(scores: number[], labels: boolean[]): number | null {
  const pos = scores.filter((_, i) => labels[i]);
  const neg = scores.filter((_, i) => !labels[i]);
  if (pos.length === 0 || neg.length === 0) return null;
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

export function f1At(scores: number[], labels: boolean[], t: number): number | null {
  let tp = 0, fp = 0, fn = 0;
  scores.forEach((s, i) => {
    const pred = s >= t;
    if (pred && labels[i]) tp++;
    else if (pred) fp++;
    else if (labels[i]) fn++;
  });
  return tp + fp + fn === 0 ? null : (2 * tp) / (2 * tp + fp + fn);
}

/** Oracle threshold on the same sample: optimistic, reported as a ceiling, not as a usable threshold. */
export function bestF1(scores: number[], labels: boolean[]): { f1: number; threshold: number } | null {
  let best: { f1: number; threshold: number } | null = null;
  for (const t of [...new Set(scores)].sort((a, b) => a - b)) {
    const f = f1At(scores, labels, t);
    if (f !== null && (best === null || f > best.f1)) best = { f1: f, threshold: t };
  }
  return best;
}

export function brier(scores: number[], labels: boolean[]): number | null {
  return mean(scores.map((s, i) => (s - (labels[i] ? 1 : 0)) ** 2));
}

export function pearson(xs: number[], ys: number[]): number | null {
  if (xs.length < 2) return null;
  const mx = mean(xs)!, my = mean(ys)!;
  let sxy = 0, sxx = 0, syy = 0;
  xs.forEach((x, i) => {
    sxy += (x - mx) * (ys[i] - my);
    sxx += (x - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  });
  return sxx === 0 || syy === 0 ? null : sxy / Math.sqrt(sxx * syy);
}

export function macroF1(expected: string[], actual: string[]): number | null {
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
  return mean(f1s);
}

/** Exact two-sided McNemar p (binomial, p=0.5) on the discordant pairs b (A right, B wrong) and c (A wrong, B right). */
export function mcnemarP(b: number, c: number): number | null {
  const n = b + c;
  if (n === 0) return null;
  const k = Math.min(b, c);
  let cdf = 0;
  let term = 0.5 ** n;
  for (let i = 0; i <= k; i++) {
    cdf += term;
    term = (term * (n - i)) / (i + 1);
  }
  return Math.min(1, 2 * cdf);
}

export function percentile95(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)];
}

// ---------- run ----------

function usageOf(response: { usage?: unknown }): { cost: number | null; inTok: number | null; outTok: number | null } {
  const u = (response.usage ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return { cost: num(u.cost), inTok: num(u.inputTokens), outTok: num(u.outputTokens) };
}

async function observe(client: JevClient, def: SuiteDef, c: SuiteCase): Promise<Obs> {
  const t0 = performance.now();
  const res = await client.classify({ questions: def.questions, state: c.state });
  const ms = performance.now() - t0;
  if (!res.ok) return { ok: false, error: `${res.kind}:${res.statusCode ?? "-"}:${res.errorName}`, ms };
  const norm = normalizeAnswers(res.response.answers, def.questions);
  if (!norm.ok) return { ok: false, error: `invalid:${norm.code}${norm.key ? `:${norm.key}` : ""}`, ms };
  return { ok: true, answers: norm.answers, ms, ...usageOf(res.response) };
}

/** Same cases, same questions, same order for every client; each case is asked of all models in parallel. */
export async function runCompare(input: {
  clients: Record<string, JevClient>;
  suites: SuiteDef[];
  concurrency?: number;
}): Promise<SuiteRun[]> {
  const limit = createLimiter(input.concurrency ?? 2);
  const names = Object.keys(input.clients);
  const out: SuiteRun[] = [];
  for (const def of input.suites) {
    const cases = await Promise.all(def.cases.map((c) =>
      limit(async (): Promise<CaseRec> => {
        const results = await Promise.all(names.map((m) => observe(input.clients[m], def, c)));
        return { id: c.id, expected: c.expected, obs: Object.fromEntries(names.map((m, i) => [m, results[i]])) };
      })
    ));
    out.push({ name: def.name, questionKeys: Object.keys(def.questions), cases });
  }
  return out;
}

// ---------- aggregates ----------

function answerOf(o: Obs | undefined, key: string): NormalizedAnswer | undefined {
  return o && o.ok ? o.answers.find((a) => a.key === key) : undefined;
}

export type NoulStats = {
  kind: "noul"; n: number; positives: number; auc: number | null;
  best_f1: number | null; best_threshold: number | null;
  jev_threshold: number | null; f1_at_jev_threshold: number | null; f1_at_05: number | null;
  brier: number | null; accuracy_05: number | null;
};
export type ChoiceStats = { kind: "choice"; n: number; classes: number; accuracy: number | null; macro_f1: number | null };
export type QuestionStats = NoulStats | ChoiceStats;

export type PairStats = {
  n_both: number;
  /** choice: same option; noul: same decision at 0.5. */
  agreement: number | null;
  /** noul only. */
  score_correlation: number | null;
  /** hits of A and B on labelled cases; b = A right and B wrong, c = A wrong and B right. */
  b: number; c: number; mcnemar_p: number | null;
};

export type UsageStats = {
  calls: number; errors: number; errors_by_class: Record<string, number>;
  latency_mean_ms: number | null; latency_p95_ms: number | null;
  input_tokens_mean: number | null; output_tokens_mean: number | null;
  cost_total_usd: number | null; cost_per_call_usd: number | null; cost_per_1000_mails_usd: number | null;
};

export type SuiteSummary = {
  name: SuiteName;
  cases: number;
  /** Cases answered by every model; all quality numbers use these only, so the comparison is paired. */
  paired_cases: number;
  per_model: Record<string, { usage: UsageStats; questions: Record<string, QuestionStats>; quality_index: number | null; quality_per_usd_per_1000: number | null }>;
  pairs: Record<string, Record<string, PairStats>>;
};

function labelled(run: SuiteRun, model: string, key: string, kind: "noul" | "choice") {
  const rows: { exp: boolean | string; ans: NormalizedAnswer }[] = [];
  for (const c of run.cases) {
    const exp = kind === "noul" ? c.expected.noul[key] : c.expected.choice[key];
    const ans = answerOf(c.obs[model], key);
    if (exp !== undefined && ans) rows.push({ exp, ans });
  }
  return rows;
}

export function questionStats(run: SuiteRun, model: string, key: string, kind: "noul" | "choice"): QuestionStats | null {
  const rows = labelled(run, model, key, kind);
  if (rows.length === 0) return null;
  if (kind === "choice") {
    const exp = rows.map((r) => String(r.exp));
    const act = rows.map((r) => String(r.ans.value));
    return {
      kind: "choice", n: rows.length, classes: new Set(exp).size,
      accuracy: ratio(exp.filter((e, i) => e === act[i]).length, rows.length), macro_f1: macroF1(exp, act),
    };
  }
  const scores = rows.map((r) => Number(r.ans.value));
  const labels = rows.map((r) => r.exp === true);
  const jevT = JEV_THRESHOLDS.get(key) ?? null;
  const best = bestF1(scores, labels);
  return {
    kind: "noul", n: rows.length, positives: labels.filter(Boolean).length, auc: auc(scores, labels),
    best_f1: best?.f1 ?? null, best_threshold: best?.threshold ?? null,
    jev_threshold: jevT, f1_at_jev_threshold: jevT === null ? null : f1At(scores, labels, jevT),
    f1_at_05: f1At(scores, labels, 0.5), brier: brier(scores, labels),
    accuracy_05: ratio(scores.filter((s, i) => (s >= 0.5) === labels[i]).length, rows.length),
  };
}

function usageStats(run: SuiteRun, model: string): UsageStats {
  const obs = run.cases.map((c) => c.obs[model]);
  const ok = obs.filter((o): o is Extract<Obs, { ok: true }> => o.ok);
  const byClass: Record<string, number> = {};
  for (const o of obs) if (!o.ok) byClass[o.error] = (byClass[o.error] ?? 0) + 1;
  const costs = ok.map((o) => o.cost).filter((x): x is number => x !== null);
  const ms = ok.map((o) => o.ms);
  const perCall = mean(costs);
  return {
    calls: obs.length, errors: obs.length - ok.length, errors_by_class: byClass,
    latency_mean_ms: mean(ms), latency_p95_ms: percentile95(ms),
    input_tokens_mean: mean(ok.map((o) => o.inTok).filter((x): x is number => x !== null)),
    output_tokens_mean: mean(ok.map((o) => o.outTok).filter((x): x is number => x !== null)),
    cost_total_usd: costs.length === 0 ? null : costs.reduce((a, b) => a + b, 0),
    cost_per_call_usd: perCall, cost_per_1000_mails_usd: perCall === null ? null : perCall * 1000,
  };
}

export function summarizeSuite(run: SuiteRun, models: string[]): SuiteSummary {
  const paired = run.cases.filter((c) => models.every((m) => c.obs[m]?.ok));
  const pairedRun: SuiteRun = { ...run, cases: paired };
  const kinds = new Map<string, "noul" | "choice">();
  for (const k of run.questionKeys) {
    const isNoul = (NOUL_KEYS as readonly string[]).includes(k);
    const isChoice = k === "category" || k === "topic";
    if (isNoul) kinds.set(k, "noul");
    else if (isChoice) kinds.set(k, "choice");
  }
  const per_model: SuiteSummary["per_model"] = {};
  for (const m of models) {
    const questions: Record<string, QuestionStats> = {};
    for (const [k, kind] of kinds) {
      const s = questionStats(pairedRun, m, k, kind);
      if (s) questions[k] = s;
    }
    const usage = usageStats(run, m);
    const parts = Object.values(questions).map((q) => (q.kind === "noul" ? q.auc : q.accuracy)).filter((x): x is number => x !== null);
    const qi = mean(parts);
    const c1000 = usage.cost_per_1000_mails_usd;
    per_model[m] = { usage, questions, quality_index: qi, quality_per_usd_per_1000: qi !== null && c1000 ? qi / c1000 : null };
  }
  const pairs: SuiteSummary["pairs"] = {};
  if (models.length >= 2) {
    const [a, b] = models;
    const key = `${a}__vs__${b}`;
    pairs[key] = {};
    for (const [k, kind] of kinds) {
      const both = paired.filter((c) => answerOf(c.obs[a], k) && answerOf(c.obs[b], k));
      let agree = 0;
      const xs: number[] = [];
      const ys: number[] = [];
      for (const c of both) {
        const x = answerOf(c.obs[a], k)!.value, y = answerOf(c.obs[b], k)!.value;
        if (kind === "choice") agree += x === y ? 1 : 0;
        else {
          agree += (Number(x) >= 0.5) === (Number(y) >= 0.5) ? 1 : 0;
          xs.push(Number(x));
          ys.push(Number(y));
        }
      }
      let bb = 0, cc = 0;
      for (const c of both) {
        const exp = kind === "noul" ? c.expected.noul[k] : c.expected.choice[k];
        if (exp === undefined) continue;
        const hit = (m: string) => {
          const v = answerOf(c.obs[m], k)!.value;
          return kind === "noul" ? (Number(v) >= 0.5) === exp : v === exp;
        };
        const ha = hit(a), hb = hit(b);
        if (ha && !hb) bb++;
        else if (!ha && hb) cc++;
      }
      pairs[key][k] = {
        n_both: both.length, agreement: ratio(agree, both.length),
        score_correlation: kind === "noul" ? pearson(xs, ys) : null, b: bb, c: cc, mcnemar_p: mcnemarP(bb, cc),
      };
    }
  }
  return { name: run.name, cases: run.cases.length, paired_cases: paired.length, per_model, pairs };
}

// ---------- suites ----------

const v2 = (): Record<string, JevQuestion> => questionsFor(QUESTION_SET_VERSION_V2);

function expectedOf(e: EvalCase["expected"]): Expected {
  const noul: Record<string, boolean> = {};
  for (const k of NOUL_KEYS) {
    const v = e[k];
    if (v !== undefined) noul[k] = v;
  }
  return { noul, choice: e.category !== undefined ? { category: e.category } : {} };
}

function stateOf(c: Pick<EvalCase, "sender_domain" | "subject" | "body">): Record<string, unknown> {
  return buildState({ sender_domain: c.sender_domain, untrusted_subject: c.subject, untrusted_body: c.body });
}

export function hfSuite(cases: EvalCase[]): SuiteDef {
  return { name: "hf-v2", questions: v2(), cases: cases.map((c) => ({ id: c.id, state: stateOf(c), expected: expectedOf(c.expected) })) };
}

export function fixedSuite(cases: EvalCase[]): SuiteDef {
  return { name: "fixed-v2", questions: v2(), cases: cases.map((c) => ({ id: c.id, state: stateOf(c), expected: expectedOf(c.expected) })) };
}

export function topicsSuite(n: number, seed: number, path?: string): SuiteDef {
  const cases = sampleTopicCases(loadTopicCases(path), n, seed);
  return {
    name: "topics",
    questions: { topic: buildTopicQuestion(variantOptions("16")) },
    cases: cases.map((c) => ({ id: c.id, state: stateOf(c), expected: { noul: {}, choice: { topic: c.expected_topic } } })),
  };
}

export function loadFixedCases(path = join(PROJECT_ROOT, "tests", "fixtures", "eval", "email-eval-v2.jsonl")): EvalCase[] {
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as EvalCase);
}

// ---------- args ----------

export type CompareArgs =
  | { ok: true; confirmLive: boolean; models: string[]; suites: SuiteName[]; n: number; topicsN: number; seed: number; split: EvalSplit; maxCalls: number; concurrency: number }
  | { ok: false; error: string };

export function parseCompareArgs(argv: string[]): CompareArgs {
  let confirmLive = false;
  let models: string[] = ["jev", "luna-decisions"];
  let suite = "all";
  let n = 250, topicsN = 120, seed = 1, maxCalls = 400, concurrency = 2;
  let split: EvalSplit = "test";
  const int = (v: string | undefined) => (v !== undefined && /^\d+$/.test(v) ? Number(v) : null);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--confirm-live") confirmLive = true;
    else if (a === "--models") models = (argv[++i] ?? "").split(",");
    else if (a === "--suite") suite = argv[++i] ?? "";
    else if (a === "--split") {
      const v = argv[++i];
      if (v !== "calib" && v !== "test") return { ok: false, error: "--split expects calib|test" };
      split = v;
    } else if (a === "--n" || a === "--topics-n" || a === "--seed" || a === "--max-calls" || a === "--concurrency") {
      const v = int(argv[++i]);
      if (v === null || (a !== "--seed" && v < 1)) return { ok: false, error: `${a} expects a positive integer` };
      if (a === "--n") n = v;
      else if (a === "--topics-n") topicsN = v;
      else if (a === "--seed") seed = v;
      else if (a === "--max-calls") maxCalls = v;
      else concurrency = v;
    } else return { ok: false, error: `unknown option: ${a}` };
  }
  if (models.length === 0 || !models.every((m) => (MODEL_NAMES as readonly string[]).includes(m)) || new Set(models).size !== models.length) {
    return { ok: false, error: `--models expects distinct values of ${MODEL_NAMES.join(",")}` };
  }
  if (!(SUITES as readonly string[]).includes(suite)) return { ok: false, error: `--suite expects ${SUITES.join("|")}` };
  if (concurrency * models.length > 4) return { ok: false, error: "concurrency x models must be <= 4" };
  const suites: SuiteName[] = suite === "all" ? ["hf-v2", "fixed-v2", "topics"] : [suite as SuiteName];
  return { ok: true, confirmLive, models, suites, n, topicsN, seed, split, maxCalls, concurrency };
}

/** Calls per model: one call per case and suite. */
export function plannedCalls(args: Extract<CompareArgs, { ok: true }>, fixedCount: number): number {
  return args.suites.reduce((s, name) => s + (name === "hf-v2" ? args.n : name === "topics" ? args.topicsN : fixedCount), 0);
}

// ---------- output ----------

const f = (v: number | null | undefined, d = 3) => (v === null || v === undefined ? "n/a" : v.toFixed(d));
const usd = (v: number | null | undefined) => (v === null || v === undefined ? "n/a" : v.toFixed(6));

export function formatMarkdown(summaries: SuiteSummary[], models: string[]): string {
  const lines: string[] = [];
  for (const s of summaries) {
    lines.push(`## ${s.name}: ${s.cases} cases, ${s.paired_cases} paired`, "");
    lines.push(`| question | metric | ${models.join(" | ")} |`, `| --- | --- | ${models.map(() => "---").join(" | ")} |`);
    const keys = Object.keys(s.per_model[models[0]]?.questions ?? {});
    for (const k of keys) {
      const q0 = s.per_model[models[0]].questions[k];
      const metrics = q0.kind === "noul"
        ? (["auc", "best_f1", "f1_at_jev_threshold", "f1_at_05", "brier", "accuracy_05"] as const)
        : (["accuracy", "macro_f1"] as const);
      for (const mt of metrics) {
        const cells = models.map((m) => {
          const q = s.per_model[m].questions[k] as unknown as Record<string, number | null>;
          return f(q?.[mt]);
        });
        lines.push(`| ${k} (n=${q0.n}${q0.kind === "noul" ? `, pos=${q0.positives}` : ""}) | ${mt} | ${cells.join(" | ")} |`);
      }
    }
    lines.push("", "| model | calls | errors | latency mean/p95 ms | in/out tokens | USD/call | USD/1000 mails | quality index | quality per USD/1000 |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const m of models) {
      const p = s.per_model[m], u = p.usage;
      lines.push(`| ${m} | ${u.calls} | ${u.errors} | ${f(u.latency_mean_ms, 0)} / ${f(u.latency_p95_ms, 0)} | ${f(u.input_tokens_mean, 0)} / ${f(u.output_tokens_mean, 0)} | ${usd(u.cost_per_call_usd)} | ${f(u.cost_per_1000_mails_usd, 4)} | ${f(p.quality_index)} | ${f(p.quality_per_usd_per_1000, 1)} |`);
    }
    for (const [pair, qs] of Object.entries(s.pairs)) {
      lines.push("", `Pair ${pair}`, "", "| question | n_both | agreement | score r | A right only | B right only | McNemar p |", "| --- | --- | --- | --- | --- | --- | --- |");
      for (const [k, p] of Object.entries(qs)) lines.push(`| ${k} | ${p.n_both} | ${f(p.agreement)} | ${f(p.score_correlation)} | ${p.b} | ${p.c} | ${f(p.mcnemar_p)} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function buildReport(input: { createdAt: string; args: Extract<CompareArgs, { ok: true }>; modelIds: Record<string, string>; runs: SuiteRun[]; summaries: SuiteSummary[]; revisions: Record<string, string> }) {
  return {
    created_at: input.createdAt,
    models: input.modelIds,
    seed: input.args.seed, split: input.args.split, n: input.args.n, topics_n: input.args.topicsN,
    revisions: input.revisions,
    summaries: input.summaries,
    // Case level: IDs, expected values, normalized answers, timing and cost. Never subject, body or raw responses.
    cases: input.runs.map((r) => ({ suite: r.name, cases: r.cases })),
  };
}

export function writeReport(dir: string, report: ReturnType<typeof buildReport>, markdown: string): string {
  mkdirSync(dir, { recursive: true });
  const stamp = report.created_at.replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
  const base = join(dir, `model-compare-${stamp}-seed${report.seed}`);
  writeFileSync(`${base}.json`, `${JSON.stringify(report)}\n`);
  writeFileSync(`${base}.md`, markdown);
  return `${base}.json`;
}

async function main(): Promise<number> {
  const args = parseCompareArgs(process.argv.slice(2));
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
  const fixed = args.suites.includes("fixed-v2") ? loadFixedCases() : [];
  const planned = plannedCalls(args, fixed.length);
  if (planned > args.maxCalls) {
    console.error(`planned ${planned} calls per model exceeds --max-calls ${args.maxCalls}`);
    return 2;
  }
  const suites: SuiteDef[] = [];
  let revisions: Record<string, string> = {};
  for (const name of args.suites) {
    if (name === "hf-v2") {
      const hf = prepareHfSample(join(PROJECT_ROOT, "data", "eval-datasets"), { seed: args.seed, n: args.n, split: args.split, strategy: "balanced" });
      revisions = hf.revisions;
      suites.push(hfSuite(hf.cases));
    } else if (name === "fixed-v2") suites.push(fixedSuite(fixed));
    else suites.push(topicsSuite(args.topicsN, args.seed));
  }
  const modelIds: Record<string, string> = { jev: JEV_MODEL, "luna-decisions": LUNA_DECISIONS_MODEL };
  const clients: Record<string, JevClient> = {};
  for (const m of args.models) {
    clients[m] = m === "jev"
      ? createJevClient({ apiKey, timeoutMs: 60_000, limiter: createLimiter(args.concurrency) })
      : createDecisionsClient({ apiKey, model: LUNA_DECISIONS_MODEL, timeoutMs: 60_000, limiter: createLimiter(args.concurrency) });
  }
  const runs = await runCompare({ clients, suites, concurrency: args.concurrency });
  const summaries = runs.map((r) => summarizeSuite(r, args.models));
  const markdown = formatMarkdown(summaries, args.models);
  console.log(markdown);
  const path = writeReport(REPORT_DIR, buildReport({
    createdAt: new Date().toISOString(), args, modelIds: Object.fromEntries(args.models.map((m) => [m, modelIds[m]])),
    runs, summaries, revisions,
  }), markdown);
  console.log(`report: data/eval-runs/${path.split("/").pop()}`);
  return summaries.some((s) => Object.values(s.per_model).some((p) => p.usage.errors > 0)) ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
