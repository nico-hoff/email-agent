import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareRuns, formatComparison, loadRunReports } from "../scripts/compare-eval-runs.ts";

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
