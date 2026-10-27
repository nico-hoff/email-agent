import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildRunReport,
  finalizeEvalRun,
  HF_MAX_CALLS,
  loadHfCases,
  parseEvalArgs,
  prepareHfSample,
  runEvalSet,
  writeRunReport,
  devDbItemsFromReport,
  type EvalCase,
} from "../scripts/eval-jev.ts";
import { existsSync, readFileSync as readFile } from "node:fs";
import { openDatabase } from "../lib/db.ts";
import { DEV_SYNTHETIC_DATABASE_PATH } from "../lib/constants.ts";
import { partitionOf } from "../lib/eval-sources.ts";
import { seedDevDatabase } from "../scripts/seed-dev-db.ts";
import type { JevClient } from "../lib/jev.ts";

function answers(over: Record<string, unknown> = {}) {
  return {
    is_spam: { type: "noul", noul: 0.1 },
    is_phishing_or_scam: { type: "noul", noul: 0.1 },
    addresses_an_ai: { type: "noul", noul: 0.1 },
    needs_my_reply: { type: "noul", noul: 0.1 },
    is_assessable: { type: "noul", noul: 0.9 },
    category: { type: "choice", choice: "business" },
    route: { type: "choice", choice: "ignore" },
    urgency: { type: "score", score: 0 },
    importance: { type: "score", score: 0 },
    ...over,
  };
}

function fakeJev(cost: number | undefined, counter: { calls: number }): JevClient {
  return {
    async classify() {
      counter.calls++;
      const usage = cost === undefined ? { inputTokens: 1, outputTokens: 1 } : { inputTokens: 1, outputTokens: 1, cost };
      return { ok: true, response: { answers: answers(), model: "m", usage } as any };
    },
  };
}

const mkCase = (i: number, over: Partial<EvalCase> = {}): EvalCase => ({
  id: `triage-${i}`,
  source: "triage",
  lang: "en",
  sender_domain: "ZZMARKER-DOMAIN.example.test",
  subject: "ZZMARKER-SUBJECT",
  body: "ZZMARKER-BODY",
  expected: { category: "business", is_spam: false },
  ...over,
});

describe("runner: cost, limits, per-case results", () => {
  it("sums usage.cost and reports cost per mail", async () => {
    const c = { calls: 0 };
    const r = await runEvalSet({ jev: fakeJev(0.0001, c), cases: [mkCase(1), mkCase(2), mkCase(3), mkCase(4)] });
    assert.ok(Math.abs(r.costTotal! - 0.0004) < 1e-12);
    assert.ok(Math.abs(r.costPerMail! - 0.0001) < 1e-12);
    assert.equal(r.aborted, undefined);
  });

  it("reports unknown cost as null and never estimates", async () => {
    const r = await runEvalSet({ jev: fakeJev(undefined, { calls: 0 }), cases: [mkCase(1), mkCase(2)] });
    assert.equal(r.costTotal, null);
    assert.equal(r.costPerMail, null);
  });

  it("refuses to start above maxCalls", async () => {
    const c = { calls: 0 };
    await assert.rejects(
      runEvalSet({ jev: fakeJev(0.1, c), cases: [mkCase(1), mkCase(2), mkCase(3)], maxCalls: 2 }),
      (e: Error) => e.message === "call_limit_exceeded",
    );
    assert.equal(c.calls, 0);
  });

  it("stops once the cost limit is reached", async () => {
    const c = { calls: 0 };
    const r = await runEvalSet({
      jev: fakeJev(0.5, c),
      cases: [mkCase(1), mkCase(2), mkCase(3), mkCase(4)],
      maxCost: 1,
    });
    assert.equal(c.calls, 2);
    assert.equal(r.aborted, "cost_limit");
    assert.equal(r.costTotal, 1);
    assert.equal(r.caseResults.length, 2);
  });

  it("records hits per question and only scores keys the case expects", async () => {
    const r = await runEvalSet({
      jev: fakeJev(0.1, { calls: 0 }),
      cases: [mkCase(1, { expected: { category: "spam" } }), mkCase(2, { expected: {} })],
    });
    assert.deepEqual(r.caseResults[0].hits, { category: false });
    assert.deepEqual(r.caseResults[1].hits, {});
    assert.equal(r.perQuestion.category.n, 1);
    assert.equal(r.perQuestion.is_spam.n, 0);
    assert.equal(r.caseResults[0].answers!.find((a) => a.key === "category")!.value, "business");
  });
});

describe("run report", () => {
  it("contains ids, expectations, answers, hits, cost, model, seed, n, revisions but no mail text", async () => {
    const cases = [mkCase(1), mkCase(2)];
    const report = await runEvalSet({ jev: fakeJev(0.0001, { calls: 0 }), cases });
    const run = buildRunReport({
      report, model: "typesafe/jev-1.13", seed: 7, n: 2, revisions: { triage: "a".repeat(40) },
      createdAt: new Date("2026-03-04T05:06:07Z"),
    });
    const json = JSON.stringify(run);
    for (const marker of ["ZZMARKER-SUBJECT", "ZZMARKER-BODY", "ZZMARKER-DOMAIN"]) {
      assert.ok(!json.includes(marker), marker);
    }
    assert.equal(run.seed, 7);
    assert.equal(run.n, 2);
    assert.equal(run.model, "typesafe/jev-1.13");
    assert.deepEqual(run.revisions, { triage: "a".repeat(40) });
    assert.equal(run.cases[0].id, "triage-1");
    assert.equal(run.cases[0].source, "triage");
    assert.deepEqual(run.cases[0].expected, { category: "business", is_spam: false });
    assert.ok(run.cases[0].answers!.length > 0);
    assert.equal(run.cases[0].hits.category, true);
    assert.equal(run.costTotal, report.costTotal);
  });

  it("writes <iso>-seed<s>.json under the given directory only", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "eval-run-")), "eval-runs");
    const report = await runEvalSet({ jev: fakeJev(0.1, { calls: 0 }), cases: [mkCase(1)] });
    const run = buildRunReport({
      report, model: "m", seed: 3, n: 1, revisions: {}, createdAt: new Date("2026-03-04T05:06:07Z"),
    });
    const path = writeRunReport(dir, run);
    assert.deepEqual(readdirSync(dir), ["2026-03-04T05-06-07Z-seed3.json"]);
    assert.ok(path.startsWith(dir));
    assert.equal(JSON.parse(readFileSync(path, "utf8")).seed, 3);
  });
});

describe("hf dataset loading", () => {
  function setup() {
    const root = mkdtempSync(join(tmpdir(), "eval-ds-"));
    const put = (short: string, rows: unknown[], rev: string) => {
      mkdirSync(join(root, short));
      writeFileSync(join(root, short, "rows.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
      writeFileSync(join(root, short, "manifest.json"), JSON.stringify({ revision: rev }));
    };
    put("triage", [
      { row_idx: 0, row: { subject: "s", body: "b", category: "spam" } },
      { row_idx: 1, row: { subject: "s", body: "b", category: "finance" } },
      { row_idx: 2, row: { subject: 5 } },
    ], "r".repeat(40));
    put("sinabis", [
      { row_idx: 9, row: { subject: "s", body: "b", lang: "fr", from: { email: "a@x.example.test" } } },
    ], "q".repeat(40));
    return root;
  }

  it("maps rows, drops unlabeled and malformed cases, and returns revisions", () => {
    const { cases, revisions } = loadHfCases(setup());
    assert.deepEqual(cases.map((c) => c.id).sort(), ["sinabis-9", "triage-0"]);
    assert.deepEqual(revisions, { triage: "r".repeat(40), sinabis: "q".repeat(40) });
  });

  it("reports missing data as an error code", () => {
    assert.throws(() => loadHfCases(join(tmpdir(), "does-not-exist-eval")), (e: Error) => e.message === "datasets_missing");
  });
});

describe("argument parsing", () => {
  it("defaults to the fixed set", () => {
    assert.deepEqual(parseEvalArgs(["--confirm-live"]), { ok: true, mode: "fixed", maxCost: null });
  });

  it("parses --source hf with seed and n", () => {
    assert.deepEqual(parseEvalArgs(["--confirm-live", "--source", "hf", "--seed", "2", "--n", "100"]), {
      ok: true, mode: "hf", seed: 2, n: 100, maxCost: null, devDb: true, split: "test", strategy: "balanced",
    });
    assert.deepEqual(parseEvalArgs(["--source", "hf", "--seed", "1", "--n", "5", "--max-cost", "0.01"]), {
      ok: true, mode: "hf", seed: 1, n: 5, maxCost: 0.01, devDb: true, split: "test", strategy: "balanced",
    });
  });

  it("rejects missing seed or n, n above the hard limit and unknown flags", () => {
    assert.equal(parseEvalArgs(["--source", "hf", "--n", "5"]).ok, false);
    assert.equal(parseEvalArgs(["--source", "hf", "--seed", "1"]).ok, false);
    assert.equal(parseEvalArgs(["--source", "hf", "--seed", "1", "--n", String(HF_MAX_CALLS + 1)]).ok, false);
    assert.equal(parseEvalArgs(["--source", "other"]).ok, false);
    assert.equal(parseEvalArgs(["--bogus"]).ok, false);
  });
});

describe("dev database wiring", () => {
  it("--no-dev-db switches the dev database write off (hf only)", () => {
    assert.deepEqual(parseEvalArgs(["--source", "hf", "--seed", "1", "--n", "5", "--no-dev-db"]), {
      ok: true, mode: "hf", seed: 1, n: 5, maxCost: null, devDb: false, split: "test", strategy: "balanced",
    });
    assert.equal(parseEvalArgs(["--confirm-live", "--no-dev-db"]).ok, false);
  });

  it("pairs each answered case with its reported model; errored cases carry no answers, unprocessed ones are left out", async () => {
    const cases = [mkCase(1), mkCase(2), mkCase(3)];
    let n = 0;
    const jev: JevClient = {
      async classify() {
        n++;
        if (n === 2) return { ok: false, kind: "http", statusCode: 500, errorName: "X" } as never;
        return { ok: true, response: { answers: answers(), model: "reported-model", usage: { cost: 1 } } as any };
      },
    };
    const limited = await runEvalSet({ jev, cases, maxCost: 1 });
    const items = devDbItemsFromReport(cases, limited);
    assert.deepEqual(items.map((i) => i.case.id), ["triage-1"]);
    assert.equal(items[0].classification!.modelReported, "reported-model");
    assert.ok(items[0].classification!.answers.length > 0);

    n = 0;
    const full = await runEvalSet({ jev, cases });
    const all = devDbItemsFromReport(cases, full);
    assert.deepEqual(all.map((i) => i.case.id), ["triage-1", "triage-2", "triage-3"]);
    assert.equal(all[1].classification, undefined);
  });

  it("keeps the run report free of the reported-model bookkeeping", async () => {
    const report = await runEvalSet({ jev: fakeJev(0.1, { calls: 0 }), cases: [mkCase(1)] });
    const run = buildRunReport({ report, model: "m", seed: 1, n: 1, revisions: {}, createdAt: new Date("2026-03-04T05:06:07Z") });
    assert.ok(!JSON.stringify(run).includes("reportedModels"));
    assert.deepEqual(Object.keys(run.cases[0]).sort(), ["answers", "cost", "expected", "hits", "id", "source"]);
  });
});

function writeDataset(root: string, short: string, rows: unknown[], manifest: Record<string, unknown> = {}) {
  mkdirSync(join(root, short), { recursive: true });
  writeFileSync(join(root, short, "rows.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  writeFileSync(join(root, short, "manifest.json"), JSON.stringify({ revision: "r".repeat(40), ...manifest }));
}

function bigDataset(dir?: string) {
  const root = dir ?? mkdtempSync(join(tmpdir(), "eval-big-"));
  const tri = Array.from({ length: 200 }, (_, i) => ({
    row_idx: i,
    row: { subject: `Synthetic subject ${i}`, body: `Synthetic body ${i}`, category: i % 2 === 0 ? "spam" : "personal" },
  }));
  // exact duplicate of row 0 (different case and spacing), left in the file on purpose
  tri.push({ row_idx: 200, row: { subject: "synthetic  SUBJECT 0", body: "Synthetic body 0", category: "spam" } });
  writeDataset(root, "triage", tri, { duplicates_removed: 4 });
  const sin = Array.from({ length: 100 }, (_, i) => ({
    row_idx: i,
    row: { subject: `Betreff ${i}`, body: `Text ${i}`, lang: "de", from: { email: `a@d${i % 5}.example.test` } },
  }));
  writeDataset(root, "sinabis", sin, { duplicates_removed: 0 });
  return root;
}

describe("loadHfCases: duplicates and fixed partition", () => {
  it("removes duplicates left in the file and adds the manifest count", () => {
    const r = loadHfCases(bigDataset());
    assert.equal(r.cases.length, 300);
    assert.equal(r.duplicatesRemoved, 5);
    assert.ok(r.cases.some((c) => c.id === "triage-0"));
    assert.ok(!r.cases.some((c) => c.id === "triage-200"));
  });

  it("calib and test are disjoint, complete, roughly 30/70 and match partitionOf", () => {
    const root = bigDataset();
    const all = loadHfCases(root).cases;
    const calib = loadHfCases(root, { split: "calib" }).cases;
    const test = loadHfCases(root, { split: "test" }).cases;
    assert.equal(calib.length + test.length, all.length);
    assert.equal(new Set([...calib, ...test].map((c) => c.id)).size, all.length);
    assert.ok(calib.length > 50 && calib.length < 130, String(calib.length));
    assert.ok(calib.every((c) => partitionOf(c) === "calib"));
    assert.ok(test.every((c) => partitionOf(c) === "test"));
    assert.deepEqual(loadHfCases(root, { split: "test" }).cases.map((c) => c.id), test.map((c) => c.id));
  });

  it("keeps both partitions for dev:seed (includeUnlabeled, no split)", () => {
    const { cases } = loadHfCases(bigDataset(), { includeUnlabeled: true });
    assert.equal(cases.length, 300);
  });
});

describe("dev:seed", () => {
  it("imports every deduplicated case of both partitions into the dev database", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "eval-seed-"));
    const ds = join(projectRoot, "data", "eval-datasets");
    mkdirSync(join(projectRoot, "data"), { mode: 0o700 });
    mkdirSync(ds);
    bigDataset(ds);
    const r = seedDevDatabase({ root: projectRoot, now: new Date("2026-10-27T12:00:00Z") });
    assert.equal(r.cases, 300);
    const db = openDatabase(join(projectRoot, DEV_SYNTHETIC_DATABASE_PATH));
    try {
      const n = (db.prepare("SELECT COUNT(*) AS n FROM emails").get() as { n: number }).n;
      assert.equal(n, 300);
    } finally {
      db.close();
    }
  });
});

describe("prepareHfSample", () => {
  it("samples only from the requested split and describes population and sample per stratum", () => {
    const root = bigDataset();
    const r = prepareHfSample(root, { seed: 1, n: 30, split: "test", strategy: "balanced" });
    assert.equal(r.cases.length, 30);
    assert.ok(r.cases.every((c) => partitionOf(c) === "test"));
    assert.equal(r.sampling.split, "test");
    assert.equal(r.sampling.strategy, "balanced");
    assert.equal(r.sampling.duplicates_removed, 5);
    assert.deepEqual(Object.keys(r.sampling.population).sort(), ["sinabis|business", "triage|personal", "triage|spam"]);
    assert.equal(Object.values(r.sampling.sample).reduce((a, b) => a + b, 0), 30);
    for (const [k, v] of Object.entries(r.sampling.sample)) assert.ok(v <= r.sampling.population[k]);
    const popTotal = Object.values(r.sampling.population).reduce((a, b) => a + b, 0);
    assert.equal(popTotal, loadHfCases(root, { split: "test" }).cases.length);
  });

  it("reports strata that were too small and were taken fully", () => {
    const r = prepareHfSample(bigDataset(), { seed: 1, n: 200, split: "test", strategy: "balanced" });
    assert.ok(r.sampling.short_strata.length >= 1);
    for (const k of r.sampling.short_strata) assert.equal(r.sampling.sample[k], r.sampling.population[k]);
  });

  it("is deterministic per seed and differs between seeds and between splits", () => {
    const root = bigDataset();
    const ids = (seed: number, split: "calib" | "test", strategy: "balanced" | "proportional") =>
      prepareHfSample(root, { seed, n: 20, split, strategy }).cases.map((c) => c.id);
    assert.deepEqual(ids(3, "test", "proportional"), ids(3, "test", "proportional"));
    assert.notDeepEqual(ids(3, "test", "balanced"), ids(4, "test", "balanced"));
    const calibIds = new Set(ids(3, "calib", "balanced"));
    assert.ok(ids(3, "test", "balanced").every((id) => !calibIds.has(id)));
  });
});

describe("run report: sampling description", () => {
  it("carries split, strategy, population and sample per stratum and the duplicate count, still without mail text", async () => {
    const report = await runEvalSet({ jev: fakeJev(0.1, { calls: 0 }), cases: [mkCase(1), mkCase(2)] });
    const run = buildRunReport({
      report, model: "m", seed: 2, n: 2, revisions: {}, createdAt: new Date("2026-03-04T05:06:07Z"),
      sampling: {
        split: "test", strategy: "balanced", population: { "triage|business": 5 }, sample: { "triage|business": 2 },
        short_strata: ["triage|business"], duplicates_removed: 3,
      },
    });
    assert.equal(run.split, "test");
    assert.equal(run.strategy, "balanced");
    assert.deepEqual(run.population, { "triage|business": 5 });
    assert.deepEqual(run.sample, { "triage|business": 2 });
    assert.deepEqual(run.short_strata, ["triage|business"]);
    assert.equal(run.duplicates_removed, 3);
    const json = JSON.stringify(run);
    for (const marker of ["ZZMARKER-SUBJECT", "ZZMARKER-BODY", "ZZMARKER-DOMAIN"]) assert.ok(!json.includes(marker));
  });
});

describe("--split and --strategy arguments", () => {
  const base = ["--source", "hf", "--seed", "1", "--n", "5"];
  it("default to test and balanced", () => {
    const a = parseEvalArgs(base);
    assert.ok(a.ok && a.mode === "hf" && a.split === "test" && a.strategy === "balanced");
  });
  it("accept calib and proportional", () => {
    const a = parseEvalArgs([...base, "--split", "calib", "--strategy", "proportional"]);
    assert.ok(a.ok && a.mode === "hf" && a.split === "calib" && a.strategy === "proportional");
  });
  it("reject unknown values and use without --source hf", () => {
    assert.equal(parseEvalArgs([...base, "--split", "all"]).ok, false);
    assert.equal(parseEvalArgs([...base, "--strategy", "random"]).ok, false);
    assert.equal(parseEvalArgs(["--split", "test"]).ok, false);
    assert.equal(parseEvalArgs(["--strategy", "balanced"]).ok, false);
  });
});

describe("eval audit goes to the synthetic dev database only", () => {
  function withRealDbPath<T>(fn: (realPath: string) => T): T {
    const realDir = mkdtempSync(join(tmpdir(), "eval-real-"));
    const realPath = join(realDir, "email-agent.sqlite");
    const saved = process.env.DATABASE_PATH;
    process.env.DATABASE_PATH = realPath;
    try {
      return fn(realPath);
    } finally {
      if (saved === undefined) delete process.env.DATABASE_PATH;
      else process.env.DATABASE_PATH = saved;
    }
  }

  function auditRows(root: string) {
    const db = openDatabase(join(root, DEV_SYNTHETIC_DATABASE_PATH));
    try {
      return db.prepare("SELECT actor, details_json FROM audit_log WHERE action = 'eval_run'").all() as Array<{
        actor: string;
        details_json: string;
      }>;
    } finally {
      db.close();
    }
  }

  it("hf run: leaves the DATABASE_PATH file untouched (not even created) and audits into the dev database", async () => {
    const root = mkdtempSync(join(tmpdir(), "eval-root-"));
    const cases = [mkCase(1), mkCase(2)];
    const report = await runEvalSet({ jev: fakeJev(0.1, { calls: 0 }), cases });
    withRealDbPath((realPath) => {
      const r = finalizeEvalRun({
        root, cases, report, hf: { seed: 4, split: "test", strategy: "balanced" }, importDevDb: true,
      });
      assert.equal(r.imported?.cases, 2);
      assert.equal(existsSync(realPath), false);
    });
    const rows = auditRows(root);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actor, "eval");
    const details = JSON.parse(rows[0].details_json);
    assert.equal(details.cases, 2);
    assert.equal(details.seed, 4);
    assert.equal(details.split, "test");
    assert.ok(!rows[0].details_json.includes("ZZMARKER"));
  });

  it("fixed set run: audit in the dev database, no mails imported", async () => {
    const root = mkdtempSync(join(tmpdir(), "eval-root-"));
    const report = await runEvalSet({ jev: fakeJev(0.1, { calls: 0 }), cases: [mkCase(1)] });
    withRealDbPath((realPath) => {
      const r = finalizeEvalRun({ root, cases: [mkCase(1)], report, hf: null, importDevDb: true });
      assert.equal(r.imported, null);
      assert.equal(existsSync(realPath), false);
    });
    assert.equal(auditRows(root).length, 1);
  });

  it("--no-dev-db still audits but imports no mails", async () => {
    const root = mkdtempSync(join(tmpdir(), "eval-root-"));
    const report = await runEvalSet({ jev: fakeJev(0.1, { calls: 0 }), cases: [mkCase(1)] });
    const r = finalizeEvalRun({
      root, cases: [mkCase(1)], report, hf: { seed: 1, split: "test", strategy: "balanced" }, importDevDb: false,
    });
    assert.equal(r.imported, null);
    assert.equal(auditRows(root).length, 1);
  });

  it("no eval script opens the real database or reads DATABASE_PATH", () => {
    for (const f of ["eval-jev.ts", "fetch-eval-datasets.ts", "compare-eval-runs.ts", "seed-dev-db.ts"]) {
      const src = readFile(join(import.meta.dirname, "..", "scripts", f), "utf8");
      assert.ok(!/DATABASE_PATH/.test(src.replace(/DEV_SYNTHETIC_DATABASE_PATH/g, "")), `${f}: DATABASE_PATH`);
      assert.ok(!/\bopenDatabase\s*\(/.test(src), `${f}: openDatabase`);
    }
  });
});
