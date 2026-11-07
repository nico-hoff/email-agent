// R8 live-eval script, offline: arguments, call budget, suite construction and gate lines from a fake run. No network, no key.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { join } from "node:path";
import { QUESTION_SET_VERSION_V3 } from "../packages/core/src/constants.ts";
import type { JevClient } from "../packages/core/src/jev.ts";
import { normalizeAnswers } from "../packages/core/src/jev-response.ts";
import { evaluateTopicsGate } from "../packages/core/src/topics-gate.ts";
import type { EvalCase } from "../packages/core/src/eval-sources.ts";
import { loadTopicCases, sampleTopicCases } from "../scripts/jev-topic-probe.ts";
import { runCompare } from "../scripts/model-compare.ts";
import { buildSuites, confusions, gateLinesFromRuns, parseTopicsEvalArgs, plannedCallsFor, probeV3 } from "../scripts/topics-eval.ts";

const root = join(import.meta.dirname, "..");

test("arguments: defaults, per-model sizes, errors", () => {
  const d = parseTopicsEvalArgs([]);
  assert.ok(d.ok);
  assert.deepEqual([d.confirmLive, d.writeGate, d.models, d.seed, d.maxCalls], [false, false, ["jev", "luna-decisions"], 7, 500]);
  assert.equal(d.hfN.get("jev"), 90);
  const a = parseTopicsEvalArgs(["--confirm-live", "--write-gate", "--hf-n", "jev=90,luna-decisions=32", "--topics-n", "50", "--models", "jev,luna-decisions"]);
  assert.ok(a.ok && a.confirmLive && a.writeGate && a.hfN.get("luna-decisions") === 32 && a.topicsN.get("jev") === 50);
  for (const bad of [["--x"], ["--models", "gpt"], ["--hf-n", "0"], ["--hf-n", "jev=5"], ["--hf-n", "jev=5,luna=3"], ["--seed", "x"], ["--concurrency", "9"], ["--models", "jev,jev"]]) {
    assert.equal(parseTopicsEvalArgs(bad).ok, false, bad.join(" "));
  }
});

test("budget: both HF suites plus the topic cases; the default run stays within 500 calls", () => {
  assert.equal(plannedCallsFor(90, 120), 300);
  assert.equal(plannedCallsFor(32, 120), 184);
  assert.equal(plannedCallsFor(90, 120) + plannedCallsFor(32, 120), 484);
});

test("refuses without --confirm-live and without a key (exit 2, no call)", () => {
  const env = { PATH: process.env.PATH ?? "" };
  const script = join(root, "scripts/topics-eval.ts");
  const none = spawnSync(process.execPath, [script], { env, encoding: "utf8" });
  assert.equal(none.status, 2);
  assert.match(none.stderr, /--confirm-live/);
  const noKey = spawnSync(process.execPath, [script, "--confirm-live"], { env, encoding: "utf8" });
  assert.equal(noKey.status, 2);
  assert.match(noKey.stderr, /OPENROUTER_API_KEY/);
  const tooMany = spawnSync(process.execPath, [script, "--confirm-live", "--max-calls", "10"], { env: { ...env, OPENROUTER_API_KEY: "k-synthetic" }, encoding: "utf8" });
  assert.equal(tooMany.status, 2);
  assert.match(tooMany.stderr, /exceeds --max-calls/);
});

const hfCases: EvalCase[] = Array.from({ length: 40 }, (_, i) => ({
  id: `triage-${i}`, lang: "en", sender_domain: "x.example.test", subject: "s", body: "b",
  expected: { is_spam: i < 20, needs_my_reply: i < 20 },
}));

/** A fake model: noul = 0.9 for positives, 0.1 for negatives; topic = the case's expected topic (looked up by subject marker). */
function fakeClient(answerTopic: (state: Record<string, unknown>) => string): JevClient {
  return {
    async classify({ questions, state }) {
      const subj = String((state as { untrusted_subject?: unknown }).untrusted_subject ?? "");
      const positive = subj.startsWith("pos");
      const answers: Record<string, unknown> = {};
      for (const [k, q] of Object.entries(questions)) {
        if (q.type === "noul") answers[k] = { type: "noul", noul: positive ? 0.9 : 0.1 };
        else if (q.type === "score") answers[k] = { type: "score", score: 1 };
        else {
          const options = Object.keys(q.criteria);
          const choice = k === "topic" ? answerTopic(state) : options[0];
          answers[k] = { type: "choice", choice };
        }
      }
      assert.ok(normalizeAnswers(answers, questions).ok);
      return { ok: true, response: { answers, model: "fake", usage: { inputTokens: 1, outputTokens: 1, cost: 0.001 } } as never };
    },
  };
}

test("suites: HF cases asked with v2 and with v3 (topic only in v3), topic fixture with the 16-option v3 set", () => {
  const topicCases = sampleTopicCases(loadTopicCases(), 20, 1);
  const suites = buildSuites(hfCases.map((c, i) => ({ ...c, subject: i < 20 ? "pos" : "neg" })), topicCases);
  assert.deepEqual(suites.map((s) => s.name), ["hf-v2", "hf-v3", "topics-v3"]);
  assert.ok(!Object.keys(suites[0].questions).includes("topic"));
  assert.ok(Object.keys(suites[1].questions).includes("topic"));
  const topic = suites[2].questions["topic"];
  assert.ok(topic?.type === "choice");
  assert.equal(Object.keys(topic.criteria).length, 16);
  assert.equal(suites[0].cases.length, 40);
  assert.equal(suites[2].cases.length, 20);
});

test("a finished fake run gives gate lines the gate can evaluate; a failed call gives no dataset", async () => {
  const topicCases = sampleTopicCases(loadTopicCases(), 120, 1);
  const byId = new Map(topicCases.map((c) => [c.subject, c.expected_topic]));
  const suites = buildSuites(hfCases.map((c, i) => ({ ...c, subject: i < 20 ? "pos" : "neg" })), topicCases);
  const client = fakeClient((state) => byId.get(String((state as { untrusted_subject?: unknown }).untrusted_subject)) ?? "other");
  const runs = await runCompare({ clients: { jev: client }, suites, concurrency: 2 });
  const lines = gateLinesFromRuns("jev", "typesafe/jev-1.13", runs, new Map(hfCases.map((c) => [c.id, c.expected])));
  assert.ok(lines);
  assert.equal(lines.filter((l) => l.suite === "hf").length, 40);
  assert.equal(lines.filter((l) => l.suite === "topics").length, 120);
  const hf = lines.find((l) => l.suite === "hf");
  assert.ok(hf && hf.suite === "hf" && hf.question_set_version === QUESTION_SET_VERSION_V3);
  assert.ok(lines.filter((l) => l.suite === "topics").every((l) => l.suite === "topics" && l.list_version === probeV3().listVersion));
  const r = evaluateTopicsGate("typesafe/jev-1.13", lines);
  assert.equal(r.topic.accuracy, 1);
  assert.ok(r.green, JSON.stringify(r));
  assert.deepEqual(confusions(runs.find((x) => x.name === "topics-v3")!, "jev"), {});

  const failing: JevClient = { classify: async () => ({ ok: false, kind: "http", statusCode: 500, errorName: "E" }) };
  const bad = await runCompare({ clients: { jev: failing }, suites, concurrency: 2 });
  assert.equal(gateLinesFromRuns("jev", "typesafe/jev-1.13", bad, new Map()), null);
});

test("confusions lists wrong topic answers as expected->actual keys only", async () => {
  const topicCases = sampleTopicCases(loadTopicCases(), 12, 1);
  const suites = buildSuites([], topicCases).filter((s) => s.name === "topics-v3");
  const runs = await runCompare({ clients: { jev: fakeClient(() => "travel") }, suites, concurrency: 2 });
  const c = confusions(runs[0], "jev");
  assert.ok(Object.keys(c).every((k) => /^[a-z_]+->travel$/.test(k)));
  assert.equal(Object.values(c).reduce((a, b) => a + b, 0), topicCases.filter((x) => x.expected_topic !== "travel").length);
});
