import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildReport,
  buildTopicQuestion,
  computeMetrics,
  loadTopicCases,
  parseProbeArgs,
  plannedCallsUpperBound,
  runVariant,
  sampleTopicCases,
  variantOptions,
  type Row,
} from "../scripts/jev-topic-probe.ts";
import type { JevClient } from "../lib/jev.ts";

const root = join(import.meta.dirname, "..");

/** Fake Jev: answers with a fixed key per call, or by the oracle (expected topic from the subject map). */
function fakeJev(pick: (keys: string[], subject: string, call: number) => string) {
  const calls: { keys: string[]; subject: string }[] = [];
  const jev: JevClient = {
    async classify({ questions, state }) {
      const q = questions["topic"];
      assert.equal(q.type, "choice");
      const keys = Object.keys(q.criteria);
      const subject = String(state["untrusted_subject"]);
      calls.push({ keys, subject });
      const choice = pick(keys, subject, calls.length);
      const probabilities = Object.fromEntries(keys.map((k) => [k, k === choice ? 0.8 : 0.2 / (keys.length - 1)]));
      return { ok: true, response: { answers: { topic: { type: "choice", choice, probabilities } }, model: "m", usage: { cost: 0.001 } } as never };
    },
  };
  return { jev, calls };
}

test("args", () => {
  assert.deepEqual(parseProbeArgs(["--options", "9"]), { ok: true, confirmLive: false, variants: ["9"], n: 96, seed: 1, maxCalls: 200 });
  const a = parseProbeArgs(["--confirm-live", "--options", "6,two-stage", "--n", "10", "--seed", "0"]);
  assert.ok(a.ok && a.confirmLive && a.n === 10 && a.seed === 0 && a.variants.length === 2);
  assert.equal(parseProbeArgs(["--options", "7"]).ok, false);
  assert.equal(parseProbeArgs([]).ok, false);
  assert.equal(parseProbeArgs(["--options", "6", "--x"]).ok, false);
  assert.equal(parseProbeArgs(["--options", "6", "--n", "0"]).ok, false);
  assert.equal(plannedCallsUpperBound(["6", "two-stage"], 10), 30);
});

test("refuses without --confirm-live and without a key", () => {
  const env = { PATH: process.env.PATH ?? "" };
  const script = join(root, "scripts/jev-topic-probe.ts");
  const none = spawnSync(process.execPath, [script, "--options", "6"], { env, encoding: "utf8" });
  assert.equal(none.status, 2);
  assert.match(none.stderr, /--confirm-live/);
  const noKey = spawnSync(process.execPath, [script, "--options", "6", "--confirm-live"], { env, encoding: "utf8" });
  assert.equal(noKey.status, 2);
  assert.match(noKey.stderr, /OPENROUTER_API_KEY/);
});

test("variants have 6/9/12/16 options, fallback always included", () => {
  for (const [v, n] of [["6", 6], ["9", 9], ["12", 12], ["16", 16]] as const) {
    const o = variantOptions(v);
    assert.equal(o.length, n);
    assert.ok(o.some((x) => x.key === "other"));
  }
  const q = buildTopicQuestion(variantOptions("16"));
  assert.equal(q.type, "choice");
  assert.equal(Object.keys(q.criteria).length, 16);
});

test("sampling is seeded, stratified and covers all topics when n is large enough", () => {
  const cases = loadTopicCases();
  const a = sampleTopicCases(cases, 32, 7).map((c) => c.id);
  const b = sampleTopicCases(cases, 32, 7).map((c) => c.id);
  assert.deepEqual(a, b);
  assert.equal(new Set(a).size, 32);
  const topics = new Set(sampleTopicCases(cases, 32, 7).map((c) => c.expected_topic));
  assert.equal(topics.size, 16);
  assert.equal(sampleTopicCases(cases, 1000, 1).length, cases.length);
});

test("metrics: accuracy, macro-F1, confusion, abstain, out-of-set", () => {
  const row = (id: string, expected: string, actual: string | null): Row => ({ id, expected, actual, ms: 100, cost: 0.01, top_p: 0.5, calls: 1 });
  const rows = [
    row("1", "a", "a"), row("2", "a", "b"), row("3", "b", "b"), row("4", "b", "other"),
    row("5", "other", "other"), row("6", "zzz", "other"), row("7", "zzz", "a"), row("8", "a", null),
  ];
  const m = computeMetrics(rows, ["a", "b", "other"]);
  assert.equal(m.in_set, 5);
  assert.equal(m.out_of_set, 2);
  assert.equal(m.errors, 1);
  assert.equal(m.accuracy, 3 / 5);
  assert.equal(m.abstain_rate, 1 / 4);
  assert.equal(m.out_of_set_to_fallback, 1 / 2);
  assert.deepEqual(m.confusion.map((c) => `${c.expected}>${c.actual}:${c.count}`), ["a>b:1", "b>other:1"]);
  // a: tp1 fp0 fn1 -> p1 r.5 f.667; b: tp1 fp1 fn1 -> .5/.5 f.5; other: tp1 fp1(b) fn0 -> p.5 r1 f.667
  assert.ok(Math.abs((m.macro_f1 ?? 0) - (2 / 3 + 0.5 + 2 / 3) / 3) < 1e-9);
  assert.equal(m.calls, 8);
  assert.ok(Math.abs(m.cost_usd - 0.08) < 1e-9);
});

test("single stage: one call per case, one question named topic, oracle gives accuracy 1 in-set", async () => {
  const cases = sampleTopicCases(loadTopicCases(), 24, 3);
  const bySubject = new Map(cases.map((c) => [c.subject, c.expected_topic]));
  const { jev, calls } = fakeJev((keys, subject) => {
    const e = bySubject.get(subject) ?? "other";
    return keys.includes(e) ? e : "other";
  });
  const r = await runVariant({ jev, variant: "12", cases });
  assert.equal(calls.length, 24);
  assert.ok(calls.every((c) => c.keys.length === 12));
  assert.equal(r.metrics.accuracy, 1);
  assert.equal(r.metrics.out_of_set_to_fallback, 1);
  assert.equal(r.metrics.errors, 0);
});

test("two stage: stage 2 only for fallback answers, custom topics resolved there", async () => {
  const cases = sampleTopicCases(loadTopicCases(), 32, 5);
  const bySubject = new Map(cases.map((c) => [c.subject, c.expected_topic]));
  const { jev, calls } = fakeJev((keys, subject) => {
    const e = bySubject.get(subject) ?? "other";
    if (keys.includes(e)) return e;
    return "other";
  });
  const r = await runVariant({ jev, variant: "two-stage", cases });
  const custom = cases.filter((c) => c.expected_topic.startsWith("custom_")).length;
  assert.ok(custom > 0);
  assert.equal(calls.filter((c) => c.keys.length === 12).length, 32);
  assert.equal(calls.filter((c) => c.keys.length === 5).length, custom + cases.filter((c) => c.expected_topic === "other").length);
  assert.equal(r.metrics.accuracy, 1);
  assert.equal(r.metrics.calls, calls.length);
});

test("errors are counted, not thrown; report holds no mail text", async () => {
  const cases = sampleTopicCases(loadTopicCases(), 8, 1);
  const jev: JevClient = { async classify() { return { ok: false, kind: "http", statusCode: 429, errorName: "TooMany" }; } };
  const r = await runVariant({ jev, variant: "6", cases });
  assert.equal(r.metrics.errors, 8);
  assert.equal(r.metrics.accuracy, null);
  const ok = fakeJev(() => "other");
  const r2 = await runVariant({ jev: ok.jev, variant: "6", cases });
  const text = JSON.stringify(buildReport({ createdAt: "2026-01-01T00:00:00.000Z", seed: 1, n: 8, reports: [r, r2] }));
  for (const c of cases) {
    assert.ok(!text.includes(c.subject));
    assert.ok(!text.includes(c.body));
    assert.ok(!text.includes(c.sender_domain));
  }
});
