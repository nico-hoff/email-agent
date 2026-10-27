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
