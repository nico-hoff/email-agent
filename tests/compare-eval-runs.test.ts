import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildInsights, compareRuns, formatComparison, loadRunReports } from "../scripts/compare-eval-runs.ts";

const run = (seed: number, n: number, cat: [number, number], spam: [number, number] | null, cost: number | null) => ({
  seed,
  n,
  costTotal: cost,
  perQuestion: {
    category: { hits: cat[0], n: cat[1], rate: cat[0] / cat[1] },
    is_spam: spam ? { hits: spam[0], n: spam[1], rate: spam[0] / spam[1] } : { hits: 0, n: 0, rate: 0 },
  },
});

describe("compareRuns", () => {
  const runs = [run(1, 100, [80, 100], [90, 100], 0.005), run(2, 100, [60, 100], [100, 100], 0.006), run(3, 90, [70, 100], null, null)];

  it("computes mean, min, max and population stddev of the hit rate per question", () => {
    const c = compareRuns(runs as any);
    assert.equal(c.runs, 3);
    assert.deepEqual(c.nPerRun, [100, 100, 90]);
    const cat = c.perQuestion.category;
    assert.ok(Math.abs(cat.mean - 0.7) < 1e-12);
    assert.equal(cat.min, 0.6);
    assert.equal(cat.max, 0.8);
    assert.ok(Math.abs(cat.stddev - Math.sqrt(((0.1) ** 2 + 0 + (0.1) ** 2) / 3)) < 1e-12);
    assert.equal(cat.runs, 3);
  });

  it("ignores runs where a question had no scored cases", () => {
    const s = compareRuns(runs as any).perQuestion.is_spam;
    assert.equal(s.runs, 2);
    assert.ok(Math.abs(s.mean - 0.95) < 1e-12);
  });

  it("sums known costs and marks unknown costs", () => {
    const c = compareRuns(runs as any);
    assert.ok(Math.abs(c.costTotal! - 0.011) < 1e-12);
    assert.equal(c.costUnknownRuns, 1);
    assert.equal(compareRuns([run(1, 1, [1, 1], null, null)] as any).costTotal, null);
  });

  it("formats a readable table", () => {
    const out = formatComparison(compareRuns(runs as any));
    assert.match(out, /runs=3/);
    assert.match(out, /category/);
    assert.match(out, /70\.0%/);
  });
});

describe("loadRunReports", () => {
  it("reads all json files of a directory, or only the given files", () => {
    const dir = mkdtempSync(join(tmpdir(), "cmp-"));
    writeFileSync(join(dir, "a-seed1.json"), JSON.stringify(run(1, 10, [5, 10], null, 0.1)));
    writeFileSync(join(dir, "b-seed2.json"), JSON.stringify(run(2, 10, [6, 10], null, 0.1)));
    writeFileSync(join(dir, "notes.txt"), "x");
    assert.equal(loadRunReports({ dir, files: [] }).length, 2);
    assert.equal(loadRunReports({ dir, files: [join(dir, "b-seed2.json")] }).length, 1);
  });

  it("rejects files that are not run reports", () => {
    const dir = mkdtempSync(join(tmpdir(), "cmp-"));
    writeFileSync(join(dir, "bad.json"), JSON.stringify({ hello: 1 }));
    assert.throws(() => loadRunReports({ dir, files: [] }), (e: Error) => e.message === "run_report_invalid");
  });
});

// ---- Insights (Markdown) ----

type C = {
  id: string;
  source?: string;
  expected: Record<string, unknown>;
  answers?: { key: string; type: string; value: number | string }[];
  hits: Record<string, boolean>;
  cost: number | null;
  error?: string;
};

const ans = (cat: string | null, spam: number | null) => [
  ...(cat ? [{ key: "category", type: "choice", value: cat }] : []),
  ...(spam !== null ? [{ key: "is_spam", type: "noul", value: spam }] : []),
];

const full = (seed: number, cases: C[], extra: Record<string, unknown> = {}) => {
  const perQuestion: Record<string, { n: number; hits: number; rate: number }> = {};
  for (const c of cases)
    for (const [q, ok] of Object.entries(c.hits)) {
      const s = (perQuestion[q] ??= { n: 0, hits: 0, rate: 0 });
      s.n++;
      if (ok) s.hits++;
      s.rate = s.hits / s.n;
    }
  const costs = cases.filter((c) => c.cost !== null);
  const errs = cases.filter((c) => c.error);
  return {
    version: 1,
    created_at: `2026-01-0${seed}T10:00:00.000Z`,
    source: "hf",
    model: "typesafe/jev-1.13",
    seed,
    n: cases.length,
    n_requested: cases.length,
    revisions: { triage: "rev-t", sinabis: "rev-s" },
    total: cases.length,
    errors: { count: errs.length, byClass: errs.length ? { "http:500:Err": errs.length } : {} },
    perQuestion,
    costTotal: costs.length ? costs.reduce((a, c) => a + (c.cost as number), 0) : null,
    costPerMail: null,
    noulThreshold: 0.5,
    cases,
    ...extra,
  };
};

const mk = (id: string, source: string, expected: Record<string, unknown>, cat: string | null, spam: number | null, cost: number | null = 0.0001): C => {
  const hits: Record<string, boolean> = {};
  if (expected.category !== undefined) hits.category = cat === expected.category;
  if (expected.is_spam !== undefined && spam !== null) hits.is_spam = spam >= 0.5 === expected.is_spam;
  return { id, source, expected, answers: ans(cat, spam), hits, cost };
};

const SPAM = { category: "spam", is_spam: true };
const BIZ = { category: "business", is_spam: false };
const run1 = full(1, [
  mk("a1", "triage", SPAM, "spam", 0.9),
  mk("a2", "triage", SPAM, "business", 0.4),
  mk("a3", "sinabis", BIZ, "business", 0.1),
  mk("a4", "sinabis", { is_spam: false }, "personal", 0.6),
  { id: "a5", source: "sinabis", expected: BIZ, hits: {}, cost: null, error: "http:500:Err" },
]);
const run2 = full(2, [
  mk("a1", "triage", SPAM, "spam", 0.3),
  mk("a2", "triage", SPAM, "business", 0.4),
  mk("a3", "sinabis", BIZ, "business", 0.2),
]);
const insights = (runs: unknown[] = [run1, run2]) =>
  buildInsights(runs as any, { now: new Date("2026-02-03T04:05:06.000Z") });

describe("buildInsights", () => {
  const md = insights();

  it("writes a header with time, model, runs, seeds, n, revisions, threshold, cost and errors", () => {
    assert.match(md, /2026-02-03T04:05:06/);
    assert.match(md, /typesafe\/jev-1\.13/);
    assert.match(md, /Läufe: 2/);
    assert.match(md, /Seeds: 1, 2/);
    assert.match(md, /n je Lauf: 5, 3/);
    assert.match(md, /triage=rev-t/);
    assert.match(md, /noul-Schwelle \(provisorisch\): 0\.5/);
    assert.match(md, /Gesamtkosten: 0\.000700/);
    assert.match(md, /Kosten pro Mail: 0\.000100/);
    assert.match(md, /http:500:Err: 1/);
    assert.match(md, /Abgebrochene Läufe: 0/);
  });

  it("says unknown when no cost is known and counts aborted runs", () => {
    const r = full(1, [mk("x", "triage", SPAM, "spam", 0.9, null)], { aborted: "cost_limit" });
    const out = insights([r]);
    assert.match(out, /Gesamtkosten: unbekannt/);
    assert.match(out, /Kosten pro Mail: unbekannt/);
    assert.match(out, /Abgebrochene Läufe: 1/);
  });

  it("has a per-question table with n, mean, min, max, stddev", () => {
    assert.match(md, /\| category \| 6 \| 66\.7% \| 66\.7% \| 66\.7% \| 0\.0pp \|/);
    assert.match(md, /\| is_spam \| 7 \|/);
  });

  it("breaks down by source x expected category", () => {
    assert.match(md, /\| triage \| spam \| category \| 4 \| 50\.0% \|/);
    assert.match(md, /\| triage \| spam \| is_spam \| 4 \| 25\.0% \|/);
    assert.match(md, /\| sinabis \| \(ohne Kategorie\) \| is_spam \| 1 \| 0\.0% \|/);
  });

  it("lists category confusions only where a category is expected", () => {
    assert.match(md, /\| spam \| business \| 2 \|/);
    assert.match(md, /\| spam \| spam \| 2 \|/);
    assert.doesNotMatch(md, /\| personal \|/);
  });

  it("gives noul quantiles split by expected value and a threshold table", () => {
    assert.match(md, /\| is_spam \| true \| 4 \| 0\.30 \| 0\.33 \| 0\.40 \| 0\.75 \| 0\.90 \|/);
    assert.match(md, /\| is_spam \| false \| 3 \| 0\.10 \| 0\.12 \| 0\.20 \| 0\.52 \| 0\.60 \|/);
    assert.match(md, /\| 0\.50 \| 42\.9% \|/);
    assert.match(md, /\| 0\.65 \| 57\.1% \|/);
    assert.match(md, /\| 0\.95 \| 42\.9% \|/);
    assert.equal(md.split("\n").filter((l) => /^\| 0\.\d\d \|/.test(l)).length, 10);
  });

  it("lists unstable cases present in several runs with differing outcome", () => {
    assert.match(md, /- is_spam: 1 \(a1\)/);
    assert.match(md, /- category: 0/);
  });

  it("caps unstable case ids at 20", () => {
    const many = (seed: number, spam: number) =>
      full(seed, Array.from({ length: 30 }, (_, i) => mk(`c${String(i).padStart(2, "0")}`, "triage", SPAM, "spam", spam)));
    const out = insights([many(1, 0.9), many(2, 0.1)]);
    const line = out.split("\n").find((l) => l.startsWith("- is_spam: 30"))!;
    assert.ok(line);
    assert.equal(line.split(",").length, 20);
  });

  it("flags findings by rule", () => {
    assert.match(md, /Trefferquote unter 0\.7: is_spam, category/);
    assert.match(md, /zu wenig Daten \(< 10\):.*triage \| spam/);
    assert.match(md, /Fehlerquote 12\.5%/);
    const calm = insights([
      full(1, Array.from({ length: 10 }, (_, i) => mk(`n${i}`, "triage", SPAM, "spam", 0.9))),
      full(2, Array.from({ length: 10 }, (_, i) => mk(`m${i}`, "triage", SPAM, "spam", 0.9))),
    ]);
    assert.doesNotMatch(calm, /Fehlerquote|Trefferquote unter|Standardabweichung über|zu wenig Daten/);
    const noisy = insights([
      full(1, Array.from({ length: 10 }, (_, i) => mk(`n${i}`, "triage", SPAM, "spam", 0.9))),
      full(2, Array.from({ length: 10 }, (_, i) => mk(`m${i}`, "triage", SPAM, i < 5 ? "spam" : "business", 0.9))),
    ]);
    assert.match(noisy, /Standardabweichung über 0\.05: category/);
  });

  it("names the questions not checked by the data", () => {
    const line = md.split("\n").find((l) => l.startsWith("Nicht geprüft:"))!;
    assert.ok(line);
    assert.match(line, /needs_my_reply/);
    assert.match(line, /addresses_an_ai/);
    assert.doesNotMatch(line, /\bis_spam\b|\bcategory\b/);
  });

  it("only emits known fields: markers in unexpected fields never appear", () => {
    const M = "MARKER_SUBJECT_9f3";
    const dirty = (r: any) => ({
      ...r,
      subject: M,
      body: M,
      from: M,
      sender_domain: `${M}.example`,
      notes: M,
      model: `${M} model`,
      revisions: { ...r.revisions, [`${M}k`]: M },
      errors: { ...r.errors, extra: M },
      perQuestion: { ...r.perQuestion, [`${M}q`]: { n: 1, hits: 1, rate: 1 } },
      cases: r.cases.map((c: any) => ({
        ...c,
        subject: M,
        body: M,
        excerpt: M,
        sender: M,
        expected: { ...c.expected, note: M, [`${M}e`]: true },
        answers: c.answers?.map((a: any) => ({ ...a, probabilities: { [M]: 1 }, text: M })),
        hits: { ...c.hits, [`${M}h`]: true },
      })),
    });
    const out = insights([dirty(run1), dirty(run2)]);
    assert.ok(!out.includes("MARKER_"), "marker leaked into insights");
    assert.match(out, /\| category \| 6 \|/);
  });
});

// ---- Statistik-Abschnitte ----

const NOUL_POS = [0.9, 0.8, 0.4];
const NOUL_NEG = [0.7, 0.3, 0.4];
const noulRun = (seed: number, extra: Record<string, unknown> = {}) =>
  full(
    seed,
    [
      ...NOUL_POS.map((v, i) => mk(`p${i}`, "triage", { is_spam: true }, null, v)),
      ...NOUL_NEG.map((v, i) => mk(`q${i}`, "sinabis", { is_spam: false }, null, v)),
    ],
    extra,
  );

const catRun = (seed: number, hitsOf: number, total: number, extra: Record<string, unknown> = {}) =>
  full(
    seed,
    Array.from({ length: total }, (_, i) =>
      mk(`k${seed}-${i}`, "triage", { category: "spam" }, i < hitsOf ? "spam" : "business", null),
    ),
    extra,
  );

describe("insights: Wilson intervals per question", () => {
  const md = insights([catRun(1, 8, 10)]);

  it("pools all runs and adds the 95% Wilson interval", () => {
    assert.match(md, /## Trefferquote mit 95-%-Wilson-Intervall/);
    assert.match(md, /\| category \| 10 \| 8 \| 80\.0% \| 49\.0% - 94\.3% \|/);
    const two = insights([catRun(1, 8, 10), catRun(2, 6, 10)]);
    assert.match(two, /\| category \| 20 \| 14 \| 70\.0% \| 48\.1% - 85\.5% \|/);
  });

  it("also lists each run separately", () => {
    const two = insights([catRun(1, 8, 10), catRun(2, 6, 10)]);
    assert.match(two, /\| 1 \| category \| 10 \| 8 \| 80\.0% \| 49\.0% - 94\.3% \|/);
    assert.match(two, /\| 2 \| category \| 10 \| 6 \| 60\.0% \| 31\.3% - 83\.2% \|/);
  });

  it("flags small cells (n < 30) and wide intervals (width > 0.2), and nothing for large narrow ones", () => {
    assert.match(md, /\| category \| 10 \| 8 \| 80\.0% \| 49\.0% - 94\.3% \| kleine Zelle \(n < 30\); Intervall breit \(> 0,2\) \|/);
    const big = insights([catRun(1, 100, 200)]);
    const line = big.split("\n").find((l) => /^\| category \| 200 \| 100 \|/.test(l))!;
    assert.ok(line);
    assert.doesNotMatch(line, /kleine Zelle|Intervall breit/);
  });

  it("warns that overlapping runs are not independent", () => {
    assert.match(md, /nicht unabhängig/);
  });
});

describe("insights: noul confusion matrix, ROC-AUC and threshold table", () => {
  const md = insights([noulRun(1, { split: "test" })]);

  it("gives TP/FP/FN/TN and derived scores at the provisional threshold, plus ROC-AUC from raw values", () => {
    assert.match(md, /## noul-Fragen: Konfusionsmatrix/);
    assert.match(md, /\| is_spam \| 0\.50 \| 2 \| 1 \| 1 \| 2 \| 0\.667 \| 0\.667 \| 0\.667 \| 0\.667 \| 0\.667 \| 0\.833 \|/);
  });

  it("marks small classes (< 30 positives or negatives)", () => {
    const line = md.split("\n").find((l) => l.startsWith("| is_spam | 0.50 | 2 | 1 |"))!;
    assert.match(line, /kleine Zelle \(n < 30\)/);
  });

  it("shows no AUC when only one class is present", () => {
    const only = insights([
      full(1, [mk("x1", "triage", { is_spam: true }, null, 0.9), mk("x2", "triage", { is_spam: true }, null, 0.2)]),
    ]);
    const line = only.split("\n").find((l) => l.startsWith("| is_spam | 0.50 |"))!;
    assert.ok(line);
    assert.match(line, /\| - \|/);
    assert.match(line, /nur eine Klasse/);
  });

  it("threshold table covers 0.50 to 0.95 per question with P, R, F1, balanced accuracy", () => {
    const num = "(?:\\d\\.\\d{3}|-)";
    const rows = md
      .split("\n")
      .filter((l) => new RegExp(`^\\| is_spam \\| 0\\.\\d\\d \\| ${num} \\| ${num} \\| ${num} \\| ${num} \\|`).test(l));
    assert.equal(rows.length, 10);
    assert.ok(rows.some((l) => l.startsWith("| is_spam | 0.50 | 0.667 | 0.667 | 0.667 | 0.667 |")));
    assert.ok(rows.some((l) => l.startsWith("| is_spam | 0.85 | 1.000 | 0.333 | 0.500 | 0.667 |")));
    assert.ok(rows.some((l) => l.startsWith("| is_spam | 0.95 | - | 0.000 | - | 0.500 |")));
  });

  it("marks the best F1 and balanced accuracy only as a candidate on calib", () => {
    assert.match(md, /\| is_spam \| 0\.75 \| 1\.000 \| 0\.667 \| 0\.800 \| 0\.833 \| Kandidat auf calib \(max\. F1, max\. Balanced Acc\.\) \|/);
    assert.equal(md.split("\n").filter((l) => l.includes("Kandidat auf calib (")).length, 1);
  });

  it("warns not to choose thresholds on test, but not for calib runs", () => {
    assert.match(md, /Schwellen nicht auf test wählen/);
    const calib = insights([noulRun(1, { split: "calib" })]);
    assert.doesNotMatch(calib, /Schwellen nicht auf test wählen/);
    assert.match(calib, /\| is_spam \| 0\.75 \|.*Kandidat auf calib/);
  });
});

describe("insights: category metrics", () => {
  const pairs: Array<[string, string]> = [["spam", "spam"], ["spam", "business"], ["business", "business"], ["business", "business"], ["personal", "spam"]];
  const md = insights([full(1, pairs.map(([e, a], i) => mk(`c${i}`, "triage", { category: e }, a, null)))]);

  it("reports accuracy, macro-F1 and per-class precision, recall, F1", () => {
    assert.match(md, /## Kategorie-Metriken/);
    assert.match(md, /Accuracy: 60\.0% \(n = 5\)/);
    assert.match(md, /Macro-F1: 0\.433/);
    assert.match(md, /\| spam \| 2 \| 0\.500 \| 0\.500 \| 0\.500 \|/);
    assert.match(md, /\| business \| 2 \| 0\.667 \| 1\.000 \| 0\.800 \|/);
    assert.match(md, /\| personal \| 1 \| 0\.000 \| 0\.000 \| 0\.000 \|/);
  });
});

describe("insights: sample description", () => {
  const sampling = (pop: Record<string, number>, sample: Record<string, number>, over: Record<string, unknown> = {}) => ({
    split: "test", strategy: "balanced", population: pop, sample, short_strata: [], duplicates_removed: 2, ...over,
  });
  const POP = { "triage|spam": 40, "triage|personal": 40, "sinabis|business": 20 };
  const r1 = full(1, run1.cases as C[], sampling(POP, { "triage|spam": 10, "triage|personal": 10, "sinabis|business": 5 }));
  const r2 = full(2, run2.cases as C[], sampling(POP, { "triage|spam": 8, "triage|personal": 8, "sinabis|business": 4 }, { short_strata: ["sinabis|business"] }));
  const md = insights([r1, r2]);

  it("names split, strategy and removed duplicates in the header", () => {
    assert.match(md, /- Split: test/);
    assert.match(md, /- Strategie: balanced/);
    assert.match(md, /- Entfernte Dubletten: 2/);
  });

  it("compares population and sample per stratum", () => {
    assert.match(md, /## Stichprobe/);
    assert.match(md, /\| triage \| spam \| 40 \| 40\.0% \| 10, 8 \| 40\.0%, 40\.0% \|/);
    assert.match(md, /\| sinabis \| business \| 20 \| 20\.0% \| 5, 4 \| 20\.0%, 20\.0% \|/);
    assert.match(md, /vollständig genommen.*sinabis \| business/);
  });

  it("states the overlap of case ids between runs", () => {
    assert.match(md, /Fall-IDs gesamt \(eindeutig\): 5/);
    assert.match(md, /in mehreren Läufen: 3 \(60\.0%\)/);
    assert.match(md, /\| 1 \| 2 \| 3 \| 60\.0% \| 100\.0% \|/);
  });

  it("says so when the reports carry no sampling description", () => {
    assert.match(insights([run1]), /keine Angaben zur Stichprobe/);
  });

  it("never lets unexpected strata names through", () => {
    const M = "MARKER_STRATUM_77";
    const dirty = full(1, run1.cases as C[], sampling({ [`${M}|${M}`]: 5 }, { [`${M}|${M}`]: 5 }, { split: M, strategy: M }));
    const out = insights([dirty]);
    assert.ok(!out.includes("MARKER_"));
  });
});

describe("eval:compare CLI", () => {
  const script = join(import.meta.dirname, "..", "scripts", "compare-eval-runs.ts");
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), "cmp-md-"));
    const f1 = join(dir, "r1.json");
    const f2 = join(dir, "r2.json");
    writeFileSync(f1, JSON.stringify(run1));
    writeFileSync(f2, JSON.stringify(run2));
    return { dir, f1, f2 };
  };
  const exec = (args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });

  it("--md writes the file and prints its path", () => {
    const { dir, f1, f2 } = setup();
    const out = join(dir, "sub", "ins.md");
    const r = exec([f1, f2, "--md", out]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(out));
    assert.match(readFileSync(out, "utf8"), /^# /);
  });

  it("--no-md writes nothing and prints no markdown path", () => {
    const { f1, f2 } = setup();
    const r = exec([f1, f2, "--no-md"]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stdout.includes(".md"));
  });

  it("rejects --md without a file", () => {
    const { f1 } = setup();
    assert.equal(exec([f1, "--md"]).status, 1);
  });
});
