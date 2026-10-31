import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { createDecisionsClient, LUNA_DECISIONS_MODEL } from "../lib/decisions-client.ts";
import type { JevClient } from "../lib/jev.ts";
import {
  auc,
  bestF1,
  brier,
  buildReport,
  f1At,
  fixedSuite,
  formatMarkdown,
  loadFixedCases,
  macroF1,
  mcnemarP,
  parseCompareArgs,
  pearson,
  plannedCalls,
  runCompare,
  summarizeSuite,
  topicsSuite,
  type SuiteDef,
} from "../scripts/model-compare.ts";

const root = join(import.meta.dirname, "..");

test("auc, f1 and brier", () => {
  assert.equal(auc([0.9, 0.8, 0.2, 0.1], [true, true, false, false]), 1);
  assert.equal(auc([0.5, 0.5], [true, false]), 0.5);
  assert.equal(auc([0.1, 0.2], [true, true]), null);
  assert.equal(f1At([0.9, 0.4, 0.6, 0.1], [true, true, false, false], 0.5), 0.5);
  assert.deepEqual(bestF1([0.9, 0.8, 0.2, 0.1], [true, true, false, false]), { f1: 1, threshold: 0.8 });
  assert.equal(brier([1, 0], [true, false]), 0);
  assert.equal(brier([0, 1], [true, false]), 1);
  assert.ok(Math.abs(pearson([1, 2, 3], [2, 4, 6])! - 1) < 1e-12);
  assert.equal(pearson([1, 1], [1, 2]), null);
});

test("macro F1 and McNemar", () => {
  assert.equal(macroF1(["a", "b"], ["a", "b"]), 1);
  assert.ok(Math.abs(macroF1(["a", "a", "b"], ["a", "b", "b"])! - 2 / 3) < 1e-9);
  assert.equal(mcnemarP(0, 0), null);
  assert.equal(mcnemarP(5, 5), 1);
  assert.ok(Math.abs(mcnemarP(0, 8)! - 2 * 0.5 ** 8) < 1e-12);
});

function fake(opts: { spam: (subject: string) => number; category?: (subject: string) => string; fail?: string; cost?: number }) {
  const seen: { keys: string[]; subject: string }[] = [];
  const client: JevClient = {
    async classify({ questions, state }) {
      const subject = String(state["untrusted_subject"]);
      seen.push({ keys: Object.keys(questions), subject });
      if (opts.fail === subject) return { ok: false, kind: "http", statusCode: 429, errorName: "TooManyRequestsResponseError" };
      const answers: Record<string, unknown> = {};
      for (const [k, q] of Object.entries(questions)) {
        if (q.type === "noul") answers[k] = { type: "noul", noul: k === "is_spam" ? opts.spam(subject) : 0.1 };
        else if (q.type === "choice") {
          const options = Object.keys(q.criteria);
          const pick = k === "category" && opts.category ? opts.category(subject) : options[0];
          answers[k] = { type: "choice", choice: pick, probabilities: Object.fromEntries(options.map((o) => [o, o === pick ? 1 : 0])) };
        } else answers[k] = { type: "score", score: 0, probabilities: { "0": 1, "1": 0, "2": 0, "3": 0 } };
      }
      return { ok: true, response: { answers, model: "m", usage: { inputTokens: 100, outputTokens: 10, ...(opts.cost !== undefined ? { cost: opts.cost } : {}) } } as never };
    },
  };
  return { client, seen };
}

test("fixed suite: both models see identical questions in identical order; paired summary", async () => {
  const cases = loadFixedCases();
  const def = fixedSuite(cases);
  const spamIds = new Set(cases.filter((c) => c.expected.is_spam === true).map((c) => c.subject));
  const a = fake({ spam: (s) => (spamIds.has(s) ? 0.95 : 0.05), cost: 0.0001 });
  const b = fake({ spam: () => 0.6, cost: 0.0004 });
  const runs = await runCompare({ clients: { a: a.client, b: b.client }, suites: [def], concurrency: 2 });
  assert.equal(runs[0].cases.length, cases.length);
  assert.deepEqual(runs[0].cases.map((c) => c.id), cases.map((c) => c.id));
  assert.deepEqual([...a.seen.map((s) => s.subject)].sort(), [...b.seen.map((s) => s.subject)].sort());
  assert.deepEqual(a.seen[0].keys, b.seen[0].keys);
  const s = summarizeSuite(runs[0], ["a", "b"]);
  assert.equal(s.paired_cases, cases.length);
  const qa = s.per_model.a.questions.is_spam;
  const qb = s.per_model.b.questions.is_spam;
  assert.ok(qa.kind === "noul" && qb.kind === "noul");
  assert.equal(qa.auc, 1);
  assert.equal(qb.auc, 0.5);
  assert.ok(Math.abs(s.per_model.a.usage.cost_per_1000_mails_usd! - 0.1) < 1e-9);
  assert.ok(Math.abs(s.per_model.b.usage.cost_per_1000_mails_usd! - 0.4) < 1e-9);
  assert.ok(s.per_model.a.quality_per_usd_per_1000! > s.per_model.b.quality_per_usd_per_1000!);
  assert.equal(s.pairs["a__vs__b"].is_spam.n_both, cases.length);
  assert.ok(formatMarkdown([s], ["a", "b"]).includes("is_spam"));
});

test("an error on one model removes the case from the paired metrics only", async () => {
  const def = fixedSuite(loadFixedCases().slice(0, 4));
  const bad = def.cases[1];
  const badSubject = String(bad.state["untrusted_subject"]);
  const a = fake({ spam: () => 0.5 });
  const b = fake({ spam: () => 0.5, fail: badSubject });
  const runs = await runCompare({ clients: { a: a.client, b: b.client }, suites: [def] });
  const s = summarizeSuite(runs[0], ["a", "b"]);
  assert.equal(s.cases, 4);
  assert.equal(s.paired_cases, 3);
  assert.equal(s.per_model.b.usage.errors, 1);
  assert.deepEqual(s.per_model.b.usage.errors_by_class, { "http:429:TooManyRequestsResponseError": 1 });
  assert.equal(s.per_model.a.usage.errors, 0);
});

test("topics suite is deterministic and the report carries no mail text", async () => {
  const t1 = topicsSuite(24, 3);
  const t2 = topicsSuite(24, 3);
  assert.deepEqual(t1.cases.map((c) => c.id), t2.cases.map((c) => c.id));
  assert.equal(t1.cases.length, 24);
  assert.deepEqual(Object.keys(t1.questions), ["topic"]);
  assert.equal(Object.keys((t1.questions.topic as { criteria: object }).criteria).length, 16);
  const a = fake({ spam: () => 0 });
  const runs = await runCompare({ clients: { a: a.client }, suites: [t1] as SuiteDef[] });
  const s = summarizeSuite(runs[0], ["a"]);
  const report = buildReport({
    createdAt: "2026-10-31T00:00:00.000Z",
    args: parseCompareArgs(["--suite", "topics"]) as never,
    modelIds: { a: "x" }, runs, summaries: [s], revisions: {},
  });
  const text = JSON.stringify(report);
  for (const c of t1.cases) {
    assert.ok(!text.includes(String(c.state["untrusted_subject"])));
    assert.ok(!text.includes(String(c.state["untrusted_body"])));
  }
});

test("args", () => {
  const d = parseCompareArgs([]);
  assert.ok(d.ok && !d.confirmLive && d.models.join() === "jev,luna-decisions" && d.suites.length === 3 && d.split === "test" && d.maxCalls === 400);
  assert.equal(plannedCalls(d as never, 29), 250 + 29 + 120);
  const o = parseCompareArgs(["--confirm-live", "--models", "jev", "--suite", "topics", "--n", "5", "--seed", "0", "--split", "calib", "--concurrency", "4"]);
  assert.ok(o.ok && o.confirmLive && o.suites.join() === "topics" && o.seed === 0 && o.split === "calib");
  assert.equal(parseCompareArgs(["--models", "gpt"]).ok, false);
  assert.equal(parseCompareArgs(["--models", "jev,jev"]).ok, false);
  assert.equal(parseCompareArgs(["--suite", "x"]).ok, false);
  assert.equal(parseCompareArgs(["--concurrency", "3"]).ok, false);
  assert.equal(parseCompareArgs(["--n", "0"]).ok, false);
  assert.equal(parseCompareArgs(["--bogus"]).ok, false);
});

test("refuses without --confirm-live and without a key", () => {
  const env = { PATH: process.env.PATH ?? "" };
  const script = join(root, "scripts/model-compare.ts");
  const none = spawnSync(process.execPath, [script], { env, encoding: "utf8" });
  assert.equal(none.status, 2);
  assert.match(none.stderr, /--confirm-live/);
  const noKey = spawnSync(process.execPath, [script, "--confirm-live"], { env, encoding: "utf8" });
  assert.equal(noKey.status, 2);
  assert.match(noKey.stderr, /OPENROUTER_API_KEY/);
});

test("decisions client: request shape, success and error mapping", async () => {
  const requests: unknown[] = [];
  const okCreate = (async (_c: unknown, req: unknown) => {
    requests.push(req);
    return { ok: true, value: { answers: {}, model: "m", usage: { inputTokens: 1, outputTokens: 0 } } };
  }) as never;
  const ok = createDecisionsClient({ apiKey: "k", model: LUNA_DECISIONS_MODEL, create: okCreate, client: {} as never });
  const r = await ok.classify({ questions: {}, state: { a: 1 } });
  assert.ok(r.ok);
  assert.deepEqual(requests[0], { decisionsRequest: { model: LUNA_DECISIONS_MODEL, questions: {}, state: { a: 1 } } });

  const httpErr = Object.assign(new Error("x"), { name: "ForbiddenResponseError", statusCode: 403 });
  const failing = createDecisionsClient({ apiKey: "k", model: "m", client: {} as never, create: (async () => ({ ok: false, error: httpErr })) as never });
  assert.deepEqual(await failing.classify({ questions: {}, state: {} }), { ok: false, kind: "http", statusCode: 403, errorName: "ForbiddenResponseError" });

  const throwing = createDecisionsClient({ apiKey: "k", model: "m", client: {} as never, create: (async () => { throw new TypeError("net"); }) as never });
  assert.deepEqual(await throwing.classify({ questions: {}, state: {} }), { ok: false, kind: "transport", errorName: "TypeError" });
});
