// Live eval for the question set v3 (R8, ADR 0037): is `topic` inside the FULL v3 set as good as measured alone, and does it
// leave the noul answers alone? Per model: the HF test split (balanced, seed 7) asked with v2 AND v3 (paired, same cases), plus the
// synthetic topic fixture asked with v3 (fixed topics + the four probe custom topics). Only synthetic content (ADR 0028).
// Aufruf: node --env-file=<env-datei> scripts/topics-eval.ts --confirm-live [--models jev,luna-decisions]
//   [--hf-n 90] [--topics-n 120] [--seed 7] [--max-calls 500] [--concurrency 2] [--write-gate]
//   (--hf-n und --topics-n koennen je Modell als jev=90,luna-decisions=35 bzw. nur eine Zahl gegeben werden)
// Der Bericht (data/eval-runs/, gitignored) und der Gate-Datensatz (evals/datasets/topics-v3__<modell>.jsonl, mit --write-gate)
// enthalten nur IDs, erwartete Werte, Themen-Schluessel und noul-Zahlen; nie Betreff, Body, Absender oder Roh-Responses.
// Ein Lauf mit Fehlern schreibt keinen Gate-Datensatz (ein Teilsatz wuerde das Gate still verkleinern).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { JEV_MODEL, PROJECT_ROOT, QUESTION_SET_VERSION_V2, QUESTION_SET_VERSION_V3 } from "../packages/core/src/constants.ts";
import { createDecisionsClient, LUNA_DECISIONS_MODEL } from "../packages/core/src/decisions-client.ts";
import { createJevClient, type JevClient } from "../packages/core/src/jev.ts";
import { questionsFor, questionsV3 } from "../packages/core/src/jev-questions.ts";
import { createLimiter } from "../packages/core/src/limiter.ts";
import {
  evaluateTopicsGate, serializeTopicsGateDataset, topicsGateFileName, TOPICS_GATE_DIR,
  type HfGateLine, type TopicGateLine, type TopicsGateLine, type TopicsGateResult,
} from "../packages/core/src/topics-gate.ts";
import { buildTopicList } from "../packages/core/src/topics.ts";
import { expectedOf, runCompare, stateOf, type CaseRec, type SuiteDef, type SuiteRun } from "./model-compare.ts";
import { prepareHfSample } from "./eval-jev.ts";
import { loadTopicCases, PROBE_CUSTOM, sampleTopicCases } from "./jev-topic-probe.ts";
import type { EvalCase } from "../packages/core/src/eval-sources.ts";

export const REPORT_DIR = join(PROJECT_ROOT, "data", "eval-runs");
export const MODEL_IDS = new Map<string, { id: string; short: string }>([
  ["jev", { id: JEV_MODEL, short: "jev" }],
  ["luna-decisions", { id: LUNA_DECISIONS_MODEL, short: "luna-decisions" }],
]);

export type TopicsEvalArgs =
  | { ok: true; confirmLive: boolean; writeGate: boolean; models: string[]; hfN: Map<string, number>; topicsN: Map<string, number>; seed: number; maxCalls: number; concurrency: number }
  | { ok: false; error: string };

function perModel(raw: string, models: readonly string[]): Map<string, number> | null {
  const out = new Map<string, number>();
  if (/^\d+$/.test(raw)) {
    for (const m of models) out.set(m, Number(raw));
  } else {
    for (const part of raw.split(",")) {
      const m = /^([a-z-]+)=(\d+)$/.exec(part);
      if (!m || !models.includes(m[1])) return null;
      out.set(m[1], Number(m[2]));
    }
    if (!models.every((x) => out.has(x))) return null;
  }
  return [...out.values()].every((v) => v >= 1) ? out : null;
}

export function parseTopicsEvalArgs(argv: string[]): TopicsEvalArgs {
  let confirmLive = false, writeGate = false, models = ["jev", "luna-decisions"];
  let hfRaw = "90", topicsRaw = "120", seed = 7, maxCalls = 500, concurrency = 2;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--confirm-live") confirmLive = true;
    else if (a === "--write-gate") writeGate = true;
    else if (a === "--models") models = (argv[++i] ?? "").split(",");
    else if (a === "--hf-n") hfRaw = argv[++i] ?? "";
    else if (a === "--topics-n") topicsRaw = argv[++i] ?? "";
    else if (a === "--seed" || a === "--max-calls" || a === "--concurrency") {
      const v = argv[++i];
      if (v === undefined || !/^\d+$/.test(v) || (a !== "--seed" && Number(v) < 1)) return { ok: false, error: `${a} expects a positive integer` };
      if (a === "--seed") seed = Number(v);
      else if (a === "--max-calls") maxCalls = Number(v);
      else concurrency = Number(v);
    } else return { ok: false, error: `unknown option: ${a}` };
  }
  if (models.length === 0 || !models.every((m) => MODEL_IDS.has(m)) || new Set(models).size !== models.length) {
    return { ok: false, error: `--models expects distinct values of ${[...MODEL_IDS.keys()].join(",")}` };
  }
  const hfN = perModel(hfRaw, models), topicsN = perModel(topicsRaw, models);
  if (!hfN || !topicsN) return { ok: false, error: "--hf-n/--topics-n expect a positive integer or model=n,model=n" };
  if (concurrency > 4) return { ok: false, error: "concurrency must be <= 4" };
  return { ok: true, confirmLive, writeGate, models, hfN, topicsN, seed, maxCalls, concurrency };
}

/** Calls of one model: HF cases asked twice (v2, v3) plus the topic cases once. */
export const plannedCallsFor = (hfN: number, topicsN: number): number => 2 * hfN + topicsN;

/** v3 questions with the probe's option list: the 12 fixed topics plus 4 custom topics (the largest list measured). */
export function probeV3(): { questions: SuiteDef["questions"]; listVersion: string } {
  const list = buildTopicList(PROBE_CUSTOM);
  if (!list.ok) throw new Error(`probe topic list invalid: ${list.code}`);
  return { questions: questionsV3(list.options), listVersion: list.version };
}

export function buildSuites(hf: readonly EvalCase[], topicCases: ReturnType<typeof sampleTopicCases>): SuiteDef[] {
  const v3 = probeV3().questions;
  const hfCases = hf.map((c) => ({ id: c.id, state: stateOf(c), expected: expectedOf(c.expected) }));
  return [
    { name: "hf-v2", questions: questionsFor(QUESTION_SET_VERSION_V2), cases: hfCases },
    { name: "hf-v3", questions: v3, cases: hfCases },
    {
      name: "topics-v3", questions: v3,
      cases: topicCases.map((c) => ({ id: c.id, state: stateOf(c), expected: { noul: {}, choice: { topic: c.expected_topic } } })),
    },
  ];
}

const valueOf = (c: CaseRec, model: string, key: string): number | string | undefined => {
  const o = c.obs[model];
  return o && o.ok ? o.answers.find((a) => a.key === key)?.value : undefined;
};

/** Gate lines of one model from a finished run; null if any call failed (no partial dataset). */
export function gateLinesFromRuns(model: string, modelId: string, runs: readonly SuiteRun[], hfExpected: ReadonlyMap<string, EvalCase["expected"]>): TopicsGateLine[] | null {
  const byName = new Map(runs.map((r) => [r.name, r]));
  const hf2 = byName.get("hf-v2"), hf3 = byName.get("hf-v3"), topics = byName.get("topics-v3");
  if (!hf2 || !hf3 || !topics) return null;
  if ([...hf2.cases, ...hf3.cases, ...topics.cases].some((c) => !c.obs[model]?.ok)) return null;
  const { listVersion } = probeV3();
  const lines: TopicsGateLine[] = [];
  const noulOf = (c: CaseRec, qs: SuiteRun): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const k of qs.questionKeys) {
      const v = valueOf(c, model, k);
      if (typeof v === "number" && ["is_spam", "is_phishing_or_scam", "addresses_an_ai", "needs_my_reply", "is_assessable"].includes(k)) out[k] = v;
    }
    return out;
  };
  const v2ById = new Map(hf2.cases.map((c) => [c.id, c]));
  for (const c of hf3.cases) {
    const c2 = v2ById.get(c.id);
    const exp = hfExpected.get(c.id) ?? {};
    const topic = valueOf(c, model, "topic");
    if (!c2 || typeof topic !== "string") return null;
    const expected: HfGateLine["expected"] = {};
    for (const k of ["is_spam", "is_phishing_or_scam", "addresses_an_ai", "needs_my_reply", "is_assessable"] as const) {
      const v = exp[k];
      if (v !== undefined) expected[k] = v;
    }
    lines.push({
      suite: "hf", id: c.id.toLowerCase(), model: modelId, question_set_version: QUESTION_SET_VERSION_V3,
      expected, v2: noulOf(c2, hf2), v3: noulOf(c, hf3), v3_topic: topic,
    });
  }
  for (const c of topics.cases) {
    const topic = valueOf(c, model, "topic");
    if (typeof topic !== "string") return null;
    lines.push({
      suite: "topics", id: c.id, model: modelId, question_set_version: QUESTION_SET_VERSION_V3, list_version: listVersion,
      expected_topic: c.expected.choice.topic, topic,
    } satisfies TopicGateLine);
  }
  return lines;
}

function usage(runs: readonly SuiteRun[], model: string) {
  let calls = 0, errors = 0, cost = 0, ms: number[] = [];
  for (const r of runs) for (const c of r.cases) {
    const o = c.obs[model];
    calls++;
    if (!o?.ok) errors++;
    else {
      cost += o.cost ?? 0;
      ms = [...ms, o.ms];
    }
  }
  return { calls, errors, cost_usd: cost, latency_mean_ms: ms.length ? ms.reduce((a, b) => a + b, 0) / ms.length : null };
}

/** Confusions of the topic fixture: expected -> actual counts for wrong answers only (keys, no mail content). */
export function confusions(run: SuiteRun, model: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of run.cases) {
    const v = valueOf(c, model, "topic");
    if (typeof v === "string" && v !== c.expected.choice.topic) {
      const k = `${c.expected.choice.topic}->${v}`;
      out[k] = (out[k] ?? 0) + 1;
    }
  }
  return out;
}

async function main(): Promise<number> {
  const args = parseTopicsEvalArgs(process.argv.slice(2));
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
  const planned = args.models.reduce((s, m) => s + plannedCallsFor(args.hfN.get(m) ?? 0, args.topicsN.get(m) ?? 0), 0);
  if (planned > args.maxCalls) {
    console.error(`planned ${planned} calls exceeds --max-calls ${args.maxCalls}`);
    return 2;
  }
  console.log(`planned calls: ${planned}`);
  const report: Record<string, unknown> = { created_at: new Date().toISOString(), seed: args.seed, models: {} };
  let failed = false;
  for (const m of args.models) {
    const meta = MODEL_IDS.get(m)!;
    const hfN = args.hfN.get(m)!, topicsN = args.topicsN.get(m)!;
    const hf = prepareHfSample(join(PROJECT_ROOT, "data", "eval-datasets"), { seed: args.seed, n: hfN, split: "test", strategy: "balanced" });
    const topicCases = sampleTopicCases(loadTopicCases(), topicsN, 1);
    const client: JevClient = m === "jev"
      ? createJevClient({ apiKey, timeoutMs: 60_000, limiter: createLimiter(args.concurrency) })
      : createDecisionsClient({ apiKey, model: LUNA_DECISIONS_MODEL, timeoutMs: 60_000, limiter: createLimiter(args.concurrency) });
    const runs = await runCompare({ clients: { [m]: client }, suites: buildSuites(hf.cases, topicCases), concurrency: args.concurrency });
    const u = usage(runs, m);
    const lines = gateLinesFromRuns(m, meta.id, runs, new Map(hf.cases.map((c) => [c.id, c.expected])));
    let gate: TopicsGateResult | null = null;
    if (lines) gate = evaluateTopicsGate(meta.id, lines);
    else failed = true;
    const conf = confusions(runs.find((r) => r.name === "topics-v3")!, m);
    (report.models as Record<string, unknown>)[m] = { usage: u, gate, confusions: conf, revisions: hf.revisions, hf_n: hfN, topics_n: topicsN };
    console.log(`\n== ${m} ==\n${JSON.stringify({ usage: u, gate, confusions: conf }, null, 1)}`);
    if (lines && args.writeGate) {
      const dir = join(PROJECT_ROOT, TOPICS_GATE_DIR);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, topicsGateFileName(meta.short)), serializeTopicsGateDataset(lines));
      console.log(`gate dataset: ${TOPICS_GATE_DIR}/${topicsGateFileName(meta.short)}`);
    } else if (!lines) console.error(`${m}: run had errors, no gate dataset written`);
  }
  mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = String(report.created_at).replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
  writeFileSync(join(REPORT_DIR, `topics-eval-${stamp}.json`), `${JSON.stringify(report)}\n`);
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
