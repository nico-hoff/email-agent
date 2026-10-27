import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildRunReport,
  HF_MAX_CALLS,
  loadHfCases,
  parseEvalArgs,
  runEvalSet,
  writeRunReport,
  devDbItemsFromReport,
  type EvalCase,
} from "../scripts/eval-jev.ts";
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
      ok: true, mode: "hf", seed: 2, n: 100, maxCost: null, devDb: true,
    });
    assert.deepEqual(parseEvalArgs(["--source", "hf", "--seed", "1", "--n", "5", "--max-cost", "0.01"]), {
      ok: true, mode: "hf", seed: 1, n: 5, maxCost: 0.01, devDb: true,
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
      ok: true, mode: "hf", seed: 1, n: 5, maxCost: null, devDb: false,
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
