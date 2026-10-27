// Vergleicht Laufberichte aus data/eval-runs/ (nur Zahlen, keine Mailinhalte).
// Aufruf: node scripts/compare-eval-runs.ts [bericht.json ...]   (ohne Argumente: alle Berichte)
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type RunSummary = {
  seed?: number;
  n: number;
  costTotal: number | null;
  perQuestion: Record<string, { hits: number; n: number; rate: number }>;
};

export type QuestionComparison = { runs: number; mean: number; min: number; max: number; stddev: number };

export type Comparison = {
  runs: number;
  nPerRun: number[];
  perQuestion: Record<string, QuestionComparison>;
  costTotal: number | null;
  costUnknownRuns: number;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isRunSummary(v: unknown): v is RunSummary {
  if (!isRecord(v) || typeof v.n !== "number" || !isRecord(v.perQuestion)) return false;
  if (!(v.costTotal === null || typeof v.costTotal === "number")) return false;
  return Object.values(v.perQuestion).every(
    (q) => isRecord(q) && typeof q.n === "number" && typeof q.rate === "number",
  );
}

export function loadRunReports(input: { dir: string; files: string[] }): RunSummary[] {
  let paths = input.files;
  if (paths.length === 0) {
    try {
      paths = readdirSync(input.dir).filter((f) => f.endsWith(".json")).sort().map((f) => join(input.dir, f));
    } catch {
      throw new Error("run_dir_missing");
    }
  }
  return paths.map((p) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(p, "utf8"));
    } catch {
      throw new Error("run_report_invalid");
    }
    if (!isRunSummary(parsed)) throw new Error("run_report_invalid");
    return parsed;
  });
}

export function compareRuns(runs: RunSummary[]): Comparison {
  const questions = new Set<string>();
  for (const r of runs) for (const q of Object.keys(r.perQuestion)) questions.add(q);
  const perQuestion: Record<string, QuestionComparison> = {};
  for (const q of questions) {
    const rates = runs.map((r) => r.perQuestion[q]).filter((s) => s && s.n > 0).map((s) => s.rate);
    if (rates.length === 0) continue;
    const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
    const variance = rates.reduce((a, b) => a + (b - mean) ** 2, 0) / rates.length;
    perQuestion[q] = {
      runs: rates.length,
      mean,
      min: Math.min(...rates),
      max: Math.max(...rates),
      stddev: Math.sqrt(variance),
    };
  }
  const known = runs.filter((r) => r.costTotal !== null);
  return {
    runs: runs.length,
    nPerRun: runs.map((r) => r.n),
    perQuestion,
    costTotal: known.length ? known.reduce((a, r) => a + (r.costTotal as number), 0) : null,
    costUnknownRuns: runs.length - known.length,
  };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export function formatComparison(c: Comparison): string {
  const lines = [`eval:compare runs=${c.runs} n per run=${c.nPerRun.join(",")}`];
  for (const [q, s] of Object.entries(c.perQuestion)) {
    lines.push(
      `  ${q}: mean ${pct(s.mean)} min ${pct(s.min)} max ${pct(s.max)} stddev ${(s.stddev * 100).toFixed(1)}pp (runs ${s.runs})`,
    );
  }
  lines.push(
    `  cost total: ${c.costTotal === null ? "unknown" : c.costTotal.toFixed(6)}` +
      (c.costUnknownRuns > 0 && c.costTotal !== null ? ` (${c.costUnknownRuns} run(s) without cost)` : ""),
  );
  return lines.join("\n");
}

function main(): void {
  const dir = join(import.meta.dirname, "..", "data", "eval-runs");
  try {
    const runs = loadRunReports({ dir, files: process.argv.slice(2) });
    if (runs.length === 0) {
      console.error("no run reports found (error: no_runs)");
      process.exit(1);
    }
    console.log(formatComparison(compareRuns(runs)));
  } catch (e) {
    console.error(`compare failed (${e instanceof Error ? e.message : "unknown"})`);
    process.exit(1);
  }
}

if (import.meta.main) main();
