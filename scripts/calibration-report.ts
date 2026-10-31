// Kalibrierungsauswertung v2 (R7): liest Laufberichte aus data/eval-runs/ (nur IDs, Rohwerte, erwartete Labels) und
// gibt je Fragenset und Split die Metriken je noul-Frage und Schwelle aus. Schwellen werden nur auf `calib` gewaehlt
// (selectThreshold), berichtet wird auf `test`. Optional mit --thresholds is_spam=0.8,... (Metriken bei festen Schwellen).
// Aufruf: node scripts/calibration-report.ts [--dir data/eval-runs] [--thresholds k=v,...] [--strict-reply]
// Nur Aggregate, nie Mailtexte. Kein Netz, keine Datenbank.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  balancedAccuracy,
  categoryMetrics,
  confusionAt,
  f1,
  precision,
  recall,
  rocAuc,
  specificity,
  type Confusion,
  type ScoredPoint,
} from "../lib/eval-stats.ts";

export const SWEEP: readonly number[] = Array.from({ length: 19 }, (_, i) => (5 + 5 * i) / 100);
export const NOUL_KEYS = ["is_spam", "is_phishing_or_scam", "addresses_an_ai", "needs_my_reply", "is_assessable"] as const;

type RunCase = {
  id: string;
  source?: string;
  expected: Record<string, unknown>;
  answers?: Array<{ key: string; type: string; value: unknown }>;
  error?: string;
};
export type Run = {
  created_at: string;
  seed: number;
  n: number;
  split?: string;
  question_set_version?: string;
  costTotal: number | null;
  errors: { count: number };
  cases: RunCase[];
};

export type Row = { threshold: number; c: Confusion; precision: number | null; recall: number | null; f1: number | null; ba: number | null };

/** Case ID -> triage `action` (local rows only). Lets `needs_my_reply` be read strictly: reply vs ignore, without forward/flag. */
export type ActionLookup = (caseId: string) => string | undefined;

export function pointsFor(cases: readonly RunCase[], key: string, only?: { actions: readonly string[]; lookup: ActionLookup }): ScoredPoint[] {
  const out: ScoredPoint[] = [];
  for (const c of cases) {
    if (only) {
      const action = only.lookup(c.id);
      if (action === undefined || !only.actions.includes(action)) continue;
    }
    const exp = c.expected[key];
    if (typeof exp !== "boolean") continue;
    const a = c.answers?.find((x) => x.key === key);
    if (a && a.type === "noul" && typeof a.value === "number") out.push({ score: a.value, expected: exp });
  }
  return out;
}

export function sweep(points: readonly ScoredPoint[], thresholds: readonly number[] = SWEEP): Row[] {
  return thresholds.map((threshold) => {
    const c = confusionAt(points, threshold);
    return { threshold, c, precision: precision(c), recall: recall(c), f1: f1(c), ba: balancedAccuracy(c) };
  });
}

/**
 * Threshold choice on calib only: the highest F1 among thresholds that reach `minPrecision` (precision before recall,
 * ADR 0007); ties go to the lower threshold. Without such a threshold: the one with the best precision, highest on ties.
 */
export function selectThreshold(rows: readonly Row[], minPrecision: number): number | null {
  const ok = rows.filter((r) => r.precision !== null && r.precision >= minPrecision && r.f1 !== null);
  if (ok.length > 0) return ok.reduce((b, r) => (r.f1! > b.f1! ? r : b)).threshold;
  const withP = rows.filter((r) => r.precision !== null);
  if (withP.length === 0) return null;
  return withP.reduce((b, r) => (r.precision! >= b.precision! ? r : b)).threshold;
}

export function loadRuns(dir: string): Run[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !f.startsWith("agents-"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Run)
    .filter((r) => Array.isArray(r.cases));
}

export function triageActionLookup(rowsPath: string): ActionLookup {
  const actions = new Map<string, string>();
  if (existsSync(rowsPath)) {
    for (const line of readFileSync(rowsPath, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      const o = JSON.parse(line) as { row_idx?: number; row?: { action?: unknown } };
      if (typeof o.row_idx === "number" && typeof o.row?.action === "string") actions.set(`triage-${o.row_idx}`, o.row.action);
    }
  }
  return (id) => actions.get(id);
}

const fmt = (x: number | null, d = 3): string => (x === null ? "-" : x.toFixed(d));

function main(): void {
  const args = process.argv.slice(2);
  const dir = args.includes("--dir") ? args[args.indexOf("--dir") + 1] : join(import.meta.dirname, "..", "data", "eval-runs");
  const fixed = new Map<string, number>();
  if (args.includes("--thresholds")) {
    for (const kv of args[args.indexOf("--thresholds") + 1].split(",")) {
      const [k, v] = kv.split("=");
      fixed.set(k, Number(v));
    }
  }
  const lookup = triageActionLookup(join(import.meta.dirname, "..", "data", "eval-datasets", "triage", "rows.jsonl"));
  const strict = args.includes("--strict-reply");
  const runs = loadRuns(dir);
  for (const run of runs) {
    const qs = run.question_set_version ?? "(v1 default)";
    console.log(`\n## ${run.created_at} split=${run.split} qs=${qs} seed=${run.seed} n=${run.n} errors=${run.errors.count} cost=${run.costTotal}`);
    const pairs: Array<[string, string]> = [];
    for (const c of run.cases) {
      const a = c.answers?.find((x) => x.key === "category");
      if (typeof c.expected.category === "string" && a && typeof a.value === "string") pairs.push([c.expected.category, a.value]);
    }
    if (pairs.length > 0) {
      const m = categoryMetrics(pairs);
      console.log(`category: n=${m.n} accuracy=${fmt(m.accuracy)} macroF1=${fmt(m.macroF1)}`);
    }
    for (const key of NOUL_KEYS) {
      const pts = pointsFor(run.cases, key, strict && key === "needs_my_reply" ? { actions: ["reply", "ignore"], lookup } : undefined);
      if (pts.length === 0) continue;
      const pos = pts.filter((p) => p.expected).length;
      console.log(`${key}: n=${pts.length} pos=${pos} neg=${pts.length - pos} auc=${fmt(rocAuc(pts))}`);
      const t = fixed.get(key);
      const rows = t !== undefined ? sweep(pts, [t]) : sweep(pts);
      for (const r of rows) {
        console.log(
          `  t=${r.threshold.toFixed(2)} tp=${r.c.tp} fp=${r.c.fp} fn=${r.c.fn} tn=${r.c.tn} P=${fmt(r.precision)} R=${fmt(r.recall)} F1=${fmt(r.f1)} BA=${fmt(r.ba)} spec=${fmt(specificity(r.c))}`,
        );
      }
    }
  }
}

if (import.meta.main) main();
