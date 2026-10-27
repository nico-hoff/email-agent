// Vergleicht Laufberichte aus data/eval-runs/ (nur Zahlen, keine Mailinhalte).
// Aufruf: node scripts/compare-eval-runs.ts [bericht.json ...] [--md <datei> | --no-md]
// (ohne Dateiargumente: alle Berichte). Schreibt zusaetzlich data/eval-runs/insights.md (nur Aggregate und Fall-IDs).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { QUESTIONS } from "../lib/jev-questions.ts";
import { EVAL_SOURCES } from "../lib/eval-sources.ts";
import { quantiles, THRESHOLDS } from "./calibrate.ts";

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

// ---- Insights (Markdown) ----
// Liest ausschliesslich bekannte Felder (Allowlist, Werte validiert); alles andere im Bericht wird ignoriert.

const NOUL_KEYS = ["is_spam", "is_phishing_or_scam", "addresses_an_ai", "is_assessable"] as const;
const KNOWN_QUESTIONS = Object.keys(QUESTIONS);
const SOURCE_NAMES = EVAL_SOURCES.map((s) => s.short);
const catQuestion = QUESTIONS.category;
const KNOWN_CATEGORIES = catQuestion?.type === "choice" ? Object.keys(catQuestion.criteria) : [];
const NO_CATEGORY = "(ohne Kategorie)";
const NO_SOURCE = "(ohne Quelle)";
const OTHER = "(anderes)";
const MAX_UNSTABLE_IDS = 20;
const MIN_STRATUM = 10;

const SAFE_TOKEN = /^[\w.:/=+-]{1,80}$/;
const safeToken = (v: unknown, fallback: string): string => (typeof v === "string" && SAFE_TOKEN.test(v) ? v : fallback);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

type SafeCase = {
  id: string;
  stratum: { source: string; category: string };
  expectedCategory: string | null;
  expectedNoul: Record<string, boolean>;
  expectedKeys: string[];
  answeredCategory: string | null;
  raw: Record<string, number>;
  hits: Record<string, boolean>;
  error: boolean;
  costed: boolean;
};

type SafeRun = {
  model: string | null;
  seed: number | null;
  n: number;
  total: number;
  revisions: string[];
  threshold: number | null;
  costTotal: number | null;
  errorsCount: number;
  errorClasses: Record<string, number>;
  aborted: boolean;
  perQuestion: Record<string, { n: number; hits: number; rate: number }>;
  cases: SafeCase[];
};

function safeCase(raw: unknown): SafeCase | null {
  if (!isRecord(raw)) return null;
  const exp = isRecord(raw.expected) ? raw.expected : {};
  const expectedKeys: string[] = [];
  const expectedNoul: Record<string, boolean> = {};
  let expectedCategory: string | null = null;
  if (typeof exp.category === "string") {
    expectedKeys.push("category");
    expectedCategory = KNOWN_CATEGORIES.includes(exp.category) ? exp.category : OTHER;
  }
  for (const k of NOUL_KEYS) {
    const v = exp[k];
    if (typeof v === "boolean") {
      expectedKeys.push(k);
      expectedNoul[k] = v;
    }
  }
  let answeredCategory: string | null = null;
  const rawValues: Record<string, number> = {};
  if (Array.isArray(raw.answers)) {
    for (const a of raw.answers) {
      if (!isRecord(a) || typeof a.key !== "string") continue;
      const value = a.value;
      if (a.key === "category" && typeof value === "string") {
        answeredCategory = KNOWN_CATEGORIES.includes(value) ? value : OTHER;
      } else if ((NOUL_KEYS as readonly string[]).includes(a.key) && num(value) !== null) {
        rawValues[a.key] = value as number;
      }
    }
  }
  const hits: Record<string, boolean> = {};
  if (isRecord(raw.hits)) {
    for (const q of KNOWN_QUESTIONS) {
      const h = raw.hits[q];
      if (typeof h === "boolean") hits[q] = h;
    }
  }
  const source = typeof raw.source === "string" ? (SOURCE_NAMES.includes(raw.source) ? raw.source : OTHER) : NO_SOURCE;
  return {
    id: safeToken(raw.id, "(ungültige-id)"),
    stratum: { source, category: expectedCategory ?? NO_CATEGORY },
    expectedCategory,
    expectedNoul,
    expectedKeys,
    answeredCategory,
    raw: rawValues,
    hits,
    error: typeof raw.error === "string",
    costed: num(raw.cost) !== null,
  };
}

function safeRun(raw: unknown): SafeRun {
  const r = isRecord(raw) ? raw : {};
  const revisions: string[] = [];
  if (isRecord(r.revisions)) {
    for (const k of SOURCE_NAMES) {
      const v = r.revisions[k];
      if (typeof v === "string") revisions.push(`${k}=${safeToken(v, "unbekannt")}`);
    }
  }
  const errs = isRecord(r.errors) ? r.errors : {};
  const errorClasses: Record<string, number> = {};
  if (isRecord(errs.byClass)) {
    for (const [k, v] of Object.entries(errs.byClass)) {
      const n = num(v);
      const key = safeToken(k, "other");
      if (n !== null) errorClasses[key] = (errorClasses[key] ?? 0) + n;
    }
  }
  const perQuestion: SafeRun["perQuestion"] = {};
  if (isRecord(r.perQuestion)) {
    for (const q of KNOWN_QUESTIONS) {
      const s = r.perQuestion[q];
      if (isRecord(s)) {
        const n = num(s.n);
        const rt = num(s.rate);
        if (n !== null && rt !== null) perQuestion[q] = { n, hits: num(s.hits) ?? 0, rate: rt };
      }
    }
  }
  const cases = (Array.isArray(r.cases) ? r.cases : []).map(safeCase).filter((c): c is SafeCase => c !== null);
  return {
    model: typeof r.model === "string" ? safeToken(r.model, "unbekannt") : null,
    seed: num(r.seed),
    n: num(r.n) ?? cases.length,
    total: num(r.total) ?? cases.length,
    revisions,
    threshold: num(r.noulThreshold),
    costTotal: num(r.costTotal),
    errorsCount: num(errs.count) ?? cases.filter((c) => c.error).length,
    errorClasses,
    aborted: r.aborted === "cost_limit",
    perQuestion,
    cases,
  };
}

const list = (xs: Iterable<string | number>): string => [...xs].join(", ");
const uniq = <T,>(xs: T[]): T[] => [...new Set(xs)];
const f2 = (x: number) => x.toFixed(2);
const rate = (hits: number, n: number) => (n === 0 ? "-" : pct(hits / n));
const table = (head: string[], rows: (string | number)[][]): string[] => [
  `| ${head.join(" | ")} |`,
  `|${head.map(() => "---").join("|")}|`,
  ...rows.map((r) => `| ${r.join(" | ")} |`),
];

export function buildInsights(input: readonly unknown[], opts: { now: Date }): string {
  const runs = input.map(safeRun);
  const cmp = compareRuns(runs.map((r) => ({ n: r.n, costTotal: r.costTotal, perQuestion: r.perQuestion })));
  const cases = runs.flatMap((r) => r.cases);
  const out: string[] = [];

  // 1. Kopf
  const costedCases = cases.filter((c) => c.costed).length;
  const costDivisor = costedCases > 0 ? costedCases : runs.reduce((a, r) => a + r.n, 0) || 1;
  const perMail = cmp.costTotal === null ? null : cmp.costTotal / costDivisor;
  const classes: Record<string, number> = {};
  for (const r of runs) for (const [k, v] of Object.entries(r.errorClasses)) classes[k] = (classes[k] ?? 0) + v;
  const revisions = uniq(runs.flatMap((r) => r.revisions));
  const thresholds = uniq(runs.map((r) => r.threshold).filter((t): t is number => t !== null));
  out.push(
    "# Eval-Insights Jev",
    "",
    `- Erstellt: ${opts.now.toISOString()}`,
    `- Modell(e): ${list(uniq(runs.map((r) => r.model ?? "unbekannt")))}`,
    `- Läufe: ${runs.length}`,
    `- Seeds: ${list(runs.map((r) => r.seed ?? "?"))}`,
    `- n je Lauf: ${list(runs.map((r) => r.n))}`,
    `- Dataset-Revisionen: ${revisions.length ? list(revisions) : "unbekannt"}`,
    `- noul-Schwelle (provisorisch): ${thresholds.length ? list(thresholds) : "unbekannt"}`,
    `- Gesamtkosten: ${cmp.costTotal === null ? "unbekannt" : cmp.costTotal.toFixed(6)}`,
    `- Kosten pro Mail: ${perMail === null ? "unbekannt" : perMail.toFixed(6)}`,
    `- Fehlerklassen: ${Object.keys(classes).length ? list(Object.entries(classes).map(([k, v]) => `${k}: ${v}`)) : "keine"}`,
    `- Abgebrochene Läufe: ${runs.filter((r) => r.aborted).length}`,
    "",
  );

  // 2. Je Frage
  out.push("## Trefferquote je Frage über die Läufe", "");
  out.push(
    ...table(
      ["Frage", "n gesamt", "Mittel", "min", "max", "Std.abw."],
      Object.entries(cmp.perQuestion).map(([q, s]) => [
        q,
        runs.reduce((a, r) => a + (r.perQuestion[q]?.n ?? 0), 0),
        pct(s.mean),
        pct(s.min),
        pct(s.max),
        `${(s.stddev * 100).toFixed(1)}pp`,
      ]),
    ),
    "",
  );

  // 3. Quelle x erwartete Kategorie
  type Stratum = { source: string; category: string; cases: number; q: Record<string, { n: number; hits: number }> };
  const strata = new Map<string, Stratum>();
  for (const c of cases) {
    const key = `${c.stratum.source}|${c.stratum.category}`;
    const s = strata.get(key) ?? { ...c.stratum, cases: 0, q: {} };
    s.cases++;
    for (const [q, ok] of Object.entries(c.hits)) {
      const e = (s.q[q] ??= { n: 0, hits: 0 });
      e.n++;
      if (ok) e.hits++;
    }
    strata.set(key, s);
  }
  const strataSorted = [...strata.values()].sort((a, b) =>
    `${a.source}|${a.category}`.localeCompare(`${b.source}|${b.category}`),
  );
  out.push("## Quelle × erwartete Kategorie", "");
  out.push(
    ...table(
      ["Quelle", "Erwartete Kategorie", "Frage", "n", "Trefferquote"],
      strataSorted.flatMap((s) => Object.entries(s.q).map(([q, e]) => [s.source, s.category, q, e.n, rate(e.hits, e.n)])),
    ),
    "",
  );

  // 4. Verwechslungen
  const conf = new Map<string, number>();
  for (const c of cases) {
    if (c.expectedCategory === null || c.answeredCategory === null) continue;
    const k = `${c.expectedCategory}\u0000${c.answeredCategory}`;
    conf.set(k, (conf.get(k) ?? 0) + 1);
  }
  const confRows = [...conf.entries()]
    .map(([k, n]) => {
      const [e, a] = k.split("\u0000");
      return { e, a, n };
    })
    .sort((x, y) => y.n - x.n || x.e.localeCompare(y.e) || x.a.localeCompare(y.a));
  out.push("## Kategorie-Verwechslungen (erwartet → Jev)", "");
  out.push(...table(["Erwartet", "Jev", "Anzahl"], confRows.map((r) => [r.e, r.a, r.n])), "");

  // 5. noul-Verteilungen und Schwellen
  const noulQs = NOUL_KEYS.filter((q) => cases.some((c) => c.expectedNoul[q] !== undefined && c.raw[q] !== undefined));
  out.push("## noul-Rohwerte nach erwartetem Wert", "");
  const distRows: (string | number)[][] = [];
  for (const q of noulQs) {
    for (const exp of [true, false]) {
      const d = quantiles(cases.filter((c) => c.expectedNoul[q] === exp && c.raw[q] !== undefined).map((c) => c.raw[q]));
      if (d) distRows.push([q, String(exp), d.n, f2(d.min), f2(d.p10), f2(d.median), f2(d.p90), f2(d.max)]);
    }
  }
  out.push(...table(["Frage", "erwartet", "n", "min", "p10", "Median", "p90", "max"], distRows), "");
  out.push("### Trefferquote je Schwelle", "");
  out.push(
    ...table(
      ["Schwelle", ...noulQs],
      THRESHOLDS.map((t) => [
        f2(t),
        ...noulQs.map((q) => {
          const pts = cases.filter((c) => c.expectedNoul[q] !== undefined && c.raw[q] !== undefined);
          return rate(pts.filter((c) => c.raw[q] >= t === c.expectedNoul[q]).length, pts.length);
        }),
      ]),
    ),
    "",
  );

  // 6. Stabilitaet
  out.push("## Stabilität (gleiche ID in mehreren Läufen, unterschiedliches Ergebnis)", "");
  for (const q of KNOWN_QUESTIONS) {
    if (!cases.some((c) => c.hits[q] !== undefined)) continue;
    const byId = new Map<string, boolean[]>();
    for (const c of cases) if (c.hits[q] !== undefined) byId.set(c.id, [...(byId.get(c.id) ?? []), c.hits[q]]);
    const unstable = [...byId.entries()]
      .filter(([, v]) => v.length >= 2 && v.some((x) => x !== v[0]))
      .map(([id]) => id)
      .sort();
    out.push(`- ${q}: ${unstable.length}${unstable.length ? ` (${list(unstable.slice(0, MAX_UNSTABLE_IDS))})` : ""}`);
  }
  out.push("");

  // 7. Auffaelligkeiten
  const findings: string[] = [];
  const qs = Object.entries(cmp.perQuestion);
  const low = qs.filter(([, s]) => s.mean < 0.7).map(([q]) => q);
  if (low.length) findings.push(`Trefferquote unter 0.7: ${list(low)}`);
  const noisy = qs.filter(([, s]) => s.runs >= 2 && s.stddev > 0.05).map(([q]) => q);
  if (noisy.length) findings.push(`Standardabweichung über 0.05: ${list(noisy)}`);
  const thin = strataSorted.filter((s) => s.cases < MIN_STRATUM);
  if (thin.length) {
    findings.push(`zu wenig Daten (< ${MIN_STRATUM}): ${list(thin.map((s) => `${s.source} | ${s.category} (${s.cases})`))}`);
  }
  const totalCases = runs.reduce((a, r) => a + r.total, 0);
  const totalErrors = runs.reduce((a, r) => a + r.errorsCount, 0);
  if (totalCases > 0 && totalErrors / totalCases > 0.02) {
    findings.push(`Fehlerquote ${pct(totalErrors / totalCases)} (${totalErrors} von ${totalCases} Fällen)`);
  }
  const aborted = runs.filter((r) => r.aborted).length;
  if (aborted) findings.push(`${aborted} Lauf/Läufe wegen Kostengrenze abgebrochen`);
  out.push("## Auffälligkeiten", "");
  out.push(...(findings.length ? findings.map((f) => `- ${f}`) : ["- keine"]), "");

  // 8. Nicht geprueft
  const checked = new Set(cases.flatMap((c) => c.expectedKeys));
  const unchecked = KNOWN_QUESTIONS.filter((q) => !checked.has(q));
  out.push(`Nicht geprüft: ${unchecked.length ? list(unchecked) : "keine"} (in den Daten ohne erwarteten Wert).`, "");
  return out.join("\n");
}

export type CliArgs = { files: string[]; md: string | null };

export function parseArgs(argv: string[], defaultMd: string): CliArgs {
  const files: string[] = [];
  let md: string | null = defaultMd;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-md") md = null;
    else if (a === "--md") {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error("md_path_missing");
      md = resolve(v);
    } else files.push(a);
  }
  return { files, md };
}

function main(): void {
  const dir = join(import.meta.dirname, "..", "data", "eval-runs");
  try {
    const args = parseArgs(process.argv.slice(2), join(dir, "insights.md"));
    const runs = loadRunReports({ dir, files: args.files });
    if (runs.length === 0) {
      console.error("no run reports found (error: no_runs)");
      process.exit(1);
    }
    console.log(formatComparison(compareRuns(runs)));
    if (args.md !== null) {
      mkdirSync(dirname(args.md), { recursive: true });
      writeFileSync(args.md, buildInsights(runs, { now: new Date() }));
      console.log(`insights: ${args.md}`);
    }
  } catch (e) {
    console.error(`compare failed (${e instanceof Error ? e.message : "unknown"})`);
    process.exit(1);
  }
}

if (import.meta.main) main();
