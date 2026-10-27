// Expliziter Runner fuer das synthetische Jev-Eval-Set (kein Chat-Agent, nicht in CI).
// `veryfront/eval` bietet nur Adapter fuer Agenten/AG-UI, keinen fuer normale SDK-Funktionen.
// Aufruf: node --env-file=.env.local scripts/eval-jev.ts --confirm-live
//   optional: --source hf --seed <s> --n <N> [--split test|calib] [--strategy balanced|proportional]
//             [--max-cost <usd>] [--no-dev-db]  (Stichprobe aus data/eval-datasets/)
// Partitionen: Schwellen werden nur auf `calib` gewaehlt, berichtet wird auf `test` (Standard).
// Der hf-Lauf schreibt die Faelle samt normalisierten Antworten zusaetzlich in data/dev-synthetic.sqlite
// (getrennte Dev-DB); --no-dev-db schaltet das ab. Die eval_run-Auditzeile geht bei JEDEM Lauf (auch beim festen Set)
// ausschliesslich in diese Dev-DB; die echte Datenbank wird von keinem Eval-Skript geoeffnet.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createJevClient, type JevClient } from "../lib/jev.ts";
import {
  dedupeCases,
  EVAL_SOURCES,
  partitionOf,
  SAMPLE_STRATEGIES,
  sampleCasesDetailed,
  SPLITS,
  type EvalCase,
  type EvalSplit,
  type SampleStrategy,
} from "../lib/eval-sources.ts";
import { buildState, QUESTIONS } from "../lib/jev-questions.ts";
import { normalizeAnswers, type NormalizedAnswer } from "../lib/jev-response.ts";
import { JEV_MODEL } from "../lib/constants.ts";
import {
  importSyntheticCases,
  openSyntheticDevDatabase,
  type ImportResult,
  type SyntheticItem,
} from "../lib/synthetic-dev-db.ts";

export const MAX_LIVE_CALLS = 30;
// Harte Grenze pro Lauf fuer die HF-Stichprobe.
export const HF_MAX_CALLS = 200;

// VORLAEUFIG, nur fuer diese Eval-Statistik (nicht in lib/): ein noul-Rohwert >= 0.5 zaehlt als "true".
// Skala und Schwelle sind in docs/jev-contract.md nicht belegt; das Ergebnis dient zur Schwellenfindung.
export const PROVISIONAL_NOUL_THRESHOLD = 0.5;

export type { EvalCase };

export type QuestionStat = { n: number; hits: number; rate: number };

export type CaseResult = {
  id: string;
  source?: string;
  expected: EvalCase["expected"];
  answers?: NormalizedAnswer[];
  hits: Record<string, boolean>;
  cost: number | null;
  error?: string;
};

export type EvalReport = {
  total: number;
  errors: { count: number; byClass: Record<string, number> };
  perQuestion: Record<string, QuestionStat>;
  costTotal: number | null;
  costPerMail: number | null;
  aborted?: "cost_limit";
  caseResults: CaseResult[];
  /** Case id -> model reported by the endpoint. Only for the dev database import; not part of the run report. */
  reportedModels: Record<string, string>;
  noulThreshold: number;
};

const NOUL_QUESTIONS = ["is_spam", "is_phishing_or_scam", "addresses_an_ai", "is_assessable"] as const;
const SCORED = ["category", ...NOUL_QUESTIONS] as const;

export function loadDataset(path: string): EvalCase[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as EvalCase);
}

export async function runEvalSet(input: {
  jev: JevClient;
  cases: EvalCase[];
  maxCalls?: number;
  maxCost?: number | null;
}): Promise<EvalReport> {
  if (input.maxCalls !== undefined && input.cases.length > input.maxCalls) {
    throw new Error("call_limit_exceeded");
  }
  const perQuestion: Record<string, QuestionStat> = {};
  for (const q of SCORED) perQuestion[q] = { n: 0, hits: 0, rate: 0 };
  const byClass: Record<string, number> = {};
  const caseResults: CaseResult[] = [];
  const reportedModels: Record<string, string> = {};
  let errors = 0;
  let cost = 0;
  let costedCalls = 0;
  let aborted: "cost_limit" | undefined;
  const bump = (k: string) => {
    errors++;
    byClass[k] = (byClass[k] ?? 0) + 1;
  };

  for (const c of input.cases) {
    if (input.maxCost != null && costedCalls > 0 && cost >= input.maxCost) {
      aborted = "cost_limit";
      break;
    }
    const base = { id: c.id, ...(c.source !== undefined ? { source: c.source } : {}), expected: c.expected };
    const state = buildState({
      sender_domain: c.sender_domain,
      untrusted_subject: c.subject,
      untrusted_body: c.body,
    });
    const res = await input.jev.classify({ questions: QUESTIONS, state });
    if (!res.ok) {
      const cls = `${res.kind}:${res.statusCode ?? "-"}:${res.errorName}`;
      bump(cls);
      caseResults.push({ ...base, hits: {}, cost: null, error: cls });
      continue;
    }
    const usage = res.response.usage as { cost?: unknown } | undefined;
    let callCost: number | null = null;
    if (typeof usage?.cost === "number") {
      callCost = usage.cost;
      cost += usage.cost;
      costedCalls++;
    }
    const norm = normalizeAnswers(res.response.answers, QUESTIONS);
    if (!norm.ok) {
      const cls = `invalid:${norm.code}`;
      bump(cls);
      caseResults.push({ ...base, hits: {}, cost: callCost, error: cls });
      continue;
    }
    const byKey = new Map<string, NormalizedAnswer>(norm.answers.map((a) => [a.key, a]));
    const hits: Record<string, boolean> = {};
    const hit = (q: string, ok: boolean) => {
      perQuestion[q].n++;
      if (ok) perQuestion[q].hits++;
      hits[q] = ok;
    };
    if (c.expected.category !== undefined) {
      hit("category", byKey.get("category")?.value === c.expected.category);
    }
    for (const q of NOUL_QUESTIONS) {
      const exp = c.expected[q];
      if (exp === undefined) continue;
      const raw = byKey.get(q)?.value;
      hit(q, typeof raw === "number" && (raw >= PROVISIONAL_NOUL_THRESHOLD) === exp);
    }
    caseResults.push({ ...base, answers: norm.answers, hits, cost: callCost });
    if (typeof res.response.model === "string") reportedModels[c.id] = res.response.model;
  }
  for (const s of Object.values(perQuestion)) s.rate = s.n === 0 ? 0 : s.hits / s.n;
  return {
    total: input.cases.length,
    errors: { count: errors, byClass },
    perQuestion,
    costTotal: costedCalls > 0 ? cost : null,
    costPerMail: costedCalls > 0 ? cost / costedCalls : null,
    ...(aborted ? { aborted } : {}),
    caseResults,
    reportedModels,
    noulThreshold: PROVISIONAL_NOUL_THRESHOLD,
  };
}

/** Cases that were actually processed, with their normalized answers when the call succeeded. Never the body. */
export function devDbItemsFromReport(cases: EvalCase[], report: EvalReport): SyntheticItem[] {
  const results = new Map(report.caseResults.map((r) => [r.id, r]));
  const items: SyntheticItem[] = [];
  for (const c of cases) {
    const r = results.get(c.id);
    if (!r) continue;
    const model = report.reportedModels[c.id];
    items.push(r.answers && model !== undefined ? { case: c, classification: { answers: r.answers, modelReported: model } } : { case: c });
  }
  return items;
}

export function formatReport(r: EvalReport): string {
  const lines = [`eval:jev cases=${r.total} errors=${r.errors.count}`];
  for (const [k, n] of Object.entries(r.errors.byClass)) lines.push(`  error ${k}: ${n}`);
  for (const [q, s] of Object.entries(r.perQuestion)) {
    lines.push(`  ${q}: ${s.hits}/${s.n} (${(s.rate * 100).toFixed(0)}%)`);
  }
  lines.push(`  noul rule (provisional, eval-only): raw >= ${r.noulThreshold} counts as true`);
  lines.push(`  cost total: ${r.costTotal === null ? "unknown" : r.costTotal.toFixed(6)}`);
  lines.push(`  cost per mail: ${r.costPerMail === null ? "unknown" : r.costPerMail.toFixed(6)}`);
  if (r.aborted) lines.push(`  aborted: ${r.aborted} after ${r.caseResults.length} of ${r.total} cases`);
  return lines.join("\n");
}

export type RunReport = {
  version: 1;
  created_at: string;
  source: "hf";
  model: string;
  seed: number;
  n: number;
  n_requested: number;
  revisions: Record<string, string>;
  total: number;
  errors: EvalReport["errors"];
  aborted?: "cost_limit";
  perQuestion: Record<string, QuestionStat>;
  costTotal: number | null;
  costPerMail: number | null;
  noulThreshold: number;
  cases: CaseResult[];
} & Partial<SamplingInfo>;

/** Beschreibung der Stichprobe: Population und Stichprobe je Schicht (Quelle|Klasse), nur Zaehler und Namen. */
export type SamplingInfo = {
  split: EvalSplit;
  strategy: SampleStrategy;
  population: Record<string, number>;
  sample: Record<string, number>;
  /** Schichten, die kleiner als ihr Anteil waren: vollstaendig genommen, Rest umverteilt. */
  short_strata: string[];
  duplicates_removed: number;
};

// Nur IDs, Quelle, erwartete Werte, normalisierte Antworten, Treffer, Kosten: nie Betreff, Body, Absender.
export function buildRunReport(input: {
  report: EvalReport;
  model: string;
  seed: number;
  n: number;
  nRequested?: number;
  revisions: Record<string, string>;
  createdAt: Date;
  sampling?: SamplingInfo;
}): RunReport {
  const r = input.report;
  return {
    ...(input.sampling ?? {}),
    version: 1,
    created_at: input.createdAt.toISOString(),
    source: "hf",
    model: input.model,
    seed: input.seed,
    n: input.n,
    n_requested: input.nRequested ?? input.n,
    revisions: input.revisions,
    total: r.total,
    errors: r.errors,
    ...(r.aborted ? { aborted: r.aborted } : {}),
    perQuestion: r.perQuestion,
    costTotal: r.costTotal,
    costPerMail: r.costPerMail,
    noulThreshold: r.noulThreshold,
    cases: r.caseResults,
  };
}

export function writeRunReport(dir: string, run: RunReport): string {
  mkdirSync(dir, { recursive: true });
  const stamp = run.created_at.replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
  const path = join(dir, `${stamp}-seed${run.seed}.json`);
  writeFileSync(path, `${JSON.stringify(run, null, 2)}\n`);
  return path;
}

// Liest data/eval-datasets/<kurzname>/{rows.jsonl,manifest.json}. Reihenfolge: mappen, exakte Dubletten je Quelle
// entfernen (vor allem anderen), nach fester Partition filtern, dann Faelle ohne jede erwartete Angabe verwerfen
// (sie wuerden nur Aufrufe kosten). includeUnlabeled behaelt sie (dev:seed); split "all" (Standard) beide Partitionen.
export function loadHfCases(
  dir: string,
  o: { includeUnlabeled?: boolean; split?: EvalSplit | "all" } = {},
): { cases: EvalCase[]; revisions: Record<string, string>; duplicatesRemoved: number } {
  const split = o.split ?? "all";
  const cases: EvalCase[] = [];
  const revisions: Record<string, string> = {};
  let duplicatesRemoved = 0;
  for (const source of EVAL_SOURCES) {
    const rowsPath = join(dir, source.short, "rows.jsonl");
    const manifestPath = join(dir, source.short, "manifest.json");
    if (!existsSync(rowsPath) || !existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { revision?: unknown; duplicates_removed?: unknown };
    revisions[source.short] = typeof manifest.revision === "string" ? manifest.revision : "unknown";
    if (typeof manifest.duplicates_removed === "number") duplicatesRemoved += manifest.duplicates_removed;
    const mappedAll: EvalCase[] = [];
    for (const line of readFileSync(rowsPath, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      const parsed = JSON.parse(line) as { row_idx?: unknown; row?: unknown };
      if (typeof parsed.row_idx !== "number") continue;
      const mapped = source.map(parsed.row, parsed.row_idx);
      if (mapped) mappedAll.push(mapped);
    }
    const deduped = dedupeCases(mappedAll);
    duplicatesRemoved += deduped.removed;
    for (const c of deduped.cases) {
      if (split !== "all" && partitionOf(c) !== split) continue;
      if (o.includeUnlabeled || Object.keys(c.expected).length > 0) cases.push(c);
    }
  }
  if (Object.keys(revisions).length === 0) throw new Error("datasets_missing");
  return { cases, revisions, duplicatesRemoved };
}

/** Laedt die Partition, zieht die geschichtete Stichprobe und beschreibt sie (ohne Inhalte). */
export function prepareHfSample(
  dir: string,
  o: { seed: number; n: number; split: EvalSplit; strategy: SampleStrategy },
): { cases: EvalCase[]; revisions: Record<string, string>; sampling: SamplingInfo } {
  const loaded = loadHfCases(dir, { split: o.split });
  const drawn = sampleCasesDetailed(loaded.cases, { seed: o.seed, n: o.n, strategy: o.strategy });
  const population: Record<string, number> = {};
  const sample: Record<string, number> = {};
  for (const s of drawn.strata) {
    population[s.key] = s.population;
    sample[s.key] = s.sampled;
  }
  return {
    cases: drawn.cases,
    revisions: loaded.revisions,
    sampling: {
      split: o.split,
      strategy: o.strategy,
      population,
      sample,
      short_strata: drawn.shortStrata,
      duplicates_removed: loaded.duplicatesRemoved,
    },
  };
}

export type EvalArgs =
  | { ok: true; mode: "fixed"; maxCost: number | null }
  | {
      ok: true;
      mode: "hf";
      seed: number;
      n: number;
      maxCost: number | null;
      devDb: boolean;
      split: EvalSplit;
      strategy: SampleStrategy;
    }
  | { ok: false };

export function parseEvalArgs(argv: string[]): EvalArgs {
  let source: string | null = null;
  let seed: number | null = null;
  let n: number | null = null;
  let maxCost: number | null = null;
  let devDb = true;
  let split: string | null = null;
  let strategy: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--confirm-live") continue;
    if (a === "--source") source = argv[++i] ?? null;
    else if (a === "--seed") seed = Number(argv[++i]);
    else if (a === "--n") n = Number(argv[++i]);
    else if (a === "--max-cost") maxCost = Number(argv[++i]);
    else if (a === "--split") split = argv[++i] ?? "";
    else if (a === "--strategy") strategy = argv[++i] ?? "";
    else if (a === "--no-dev-db") devDb = false;
    else return { ok: false };
  }
  if (maxCost !== null && !(Number.isFinite(maxCost) && maxCost > 0)) return { ok: false };
  if (source === null) {
    return seed === null && n === null && devDb && split === null && strategy === null
      ? { ok: true, mode: "fixed", maxCost }
      : { ok: false };
  }
  if (source !== "hf") return { ok: false };
  if (seed === null || n === null) return { ok: false };
  if (!Number.isInteger(seed) || !Number.isInteger(n) || n < 1 || n > HF_MAX_CALLS) return { ok: false };
  const chosenSplit = (split ?? "test") as EvalSplit;
  const chosenStrategy = (strategy ?? "balanced") as SampleStrategy;
  if (!SPLITS.includes(chosenSplit) || !SAMPLE_STRATEGIES.includes(chosenStrategy)) return { ok: false };
  return { ok: true, mode: "hf", seed, n, maxCost, devDb, split: chosenSplit, strategy: chosenStrategy };
}

function writeEvalAudit(
  db: DatabaseSync,
  report: EvalReport,
  extra: Record<string, number | string>,
): void {
  db.prepare(
    `INSERT INTO audit_log (occurred_at, trace_id, actor, action, details_json)
     VALUES (?, ?, 'eval', 'eval_run', ?)`,
  ).run(
    new Date().toISOString(),
    crypto.randomUUID(),
    JSON.stringify({
      cases: report.total,
      errors: report.errors.count,
      hits: Object.fromEntries(Object.entries(report.perQuestion).map(([q, s]) => [q, [s.hits, s.n]])),
      ...extra,
      ...(report.costTotal !== null ? { cost: report.costTotal } : {}),
    }),
  );
}

/**
 * Alles, was ein Lauf in eine Datenbank schreibt, geht in die synthetische Dev-DB unter <root>/data/:
 * optional die Faelle samt Antworten (nur hf) und immer die Auditzeile `eval_run`. Die echte DB wird nie geoeffnet.
 */
export function finalizeEvalRun(input: {
  root: string;
  cases: EvalCase[];
  report: EvalReport;
  hf: { seed: number; split: EvalSplit; strategy: SampleStrategy } | null;
  importDevDb: boolean;
}): { imported: ImportResult | null } {
  const db = openSyntheticDevDatabase(input.root);
  try {
    let imported: ImportResult | null = null;
    let importError: unknown;
    if (input.hf && input.importDevDb) {
      try {
        imported = importSyntheticCases(db, devDbItemsFromReport(input.cases, input.report));
      } catch (e) {
        importError = e; // the audit row is still written; the error is rethrown below
      }
    }
    writeEvalAudit(
      db,
      input.report,
      input.hf ? { seed: input.hf.seed, split: input.hf.split, strategy: input.hf.strategy } : {},
    );
    if (importError !== undefined) throw importError;
    return { imported };
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  if (!process.argv.includes("--confirm-live")) {
    console.error("refusing to call the live endpoint without --confirm-live");
    process.exit(2);
  }
  const args = parseEvalArgs(process.argv.slice(2));
  if (!args.ok) {
    console.error(
      `usage: eval:jev [--source hf --seed <s> --n <1..${HF_MAX_CALLS}> [--split test|calib] [--strategy balanced|proportional]] [--max-cost <usd>] [--no-dev-db]  (error: args_invalid)`,
    );
    process.exit(2);
  }
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error("OPENROUTER_API_KEY is not set");
    process.exit(2);
  }
  const root = join(import.meta.dirname, "..");
  let cases: EvalCase[];
  let revisions: Record<string, string> = {};
  let sampling: SamplingInfo | undefined;
  let maxCalls = MAX_LIVE_CALLS;
  if (args.mode === "hf") {
    try {
      const prepared = prepareHfSample(join(root, "data", "eval-datasets"), {
        seed: args.seed, n: args.n, split: args.split, strategy: args.strategy,
      });
      cases = prepared.cases;
      revisions = prepared.revisions;
      sampling = prepared.sampling;
    } catch (e) {
      console.error(`dataset load failed (${e instanceof Error ? e.message : "unknown"}); run npm run eval:fetch first`);
      process.exit(2);
    }
    maxCalls = HF_MAX_CALLS;
  } else {
    cases = loadDataset(join(root, "tests", "fixtures", "eval", "email-eval-v1.jsonl"));
  }
  if (cases.length > maxCalls) {
    console.error(`${cases.length} cases, limit is ${maxCalls}`);
    process.exit(2);
  }
  const jev = createJevClient({ apiKey, timeoutMs: 60_000 });
  const report = await runEvalSet({ jev, cases, maxCalls, maxCost: args.maxCost });
  console.log(formatReport(report));

  if (args.mode === "hf" && sampling) {
    console.log(`  split=${sampling.split} strategy=${sampling.strategy} duplicates removed=${sampling.duplicates_removed}`);
    for (const [k, pop] of Object.entries(sampling.population)) {
      console.log(`  stratum ${k}: ${sampling.sample[k] ?? 0} of ${pop}`);
    }
    if (sampling.short_strata.length) console.log(`  smaller than share, taken fully: ${sampling.short_strata.join(", ")}`);
    const run = buildRunReport({
      report, model: JEV_MODEL, seed: args.seed, n: cases.length, nRequested: args.n, revisions, createdAt: new Date(),
      sampling,
    });
    const path = writeRunReport(join(root, "data", "eval-runs"), run);
    console.log(`  run report: data/eval-runs/${path.split("/").pop()}`);
  }

  // The paid run is already reported; a dev database problem must not hide that. Error class only.
  try {
    const r = finalizeEvalRun({
      root,
      cases,
      report,
      hf: args.mode === "hf" ? { seed: args.seed, split: args.split, strategy: args.strategy } : null,
      importDevDb: args.mode === "hf" && args.devDb,
    });
    if (r.imported) console.log(`  dev database: ${r.imported.cases} mails, ${r.imported.classified} with answers (data/dev-synthetic.sqlite)`);
  } catch (e) {
    console.error(`  dev database not written (${e instanceof Error ? e.name : "unknown"})`);
  }
  process.exit(report.errors.count > 0 || report.aborted ? 1 : 0);
}

if (import.meta.main) await main();
