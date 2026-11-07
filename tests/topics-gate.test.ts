// R8 offline gate "Eval gruen" (ADR 0037): the committed gate datasets must be green, and the rule must really fail when it should.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { QUESTION_SET_VERSION_V3 } from "../packages/core/src/constants.ts";
import {
  accuracy, evaluateTopicsGate, loadTopicsGateDatasets, macroF1, modelsOf, parseTopicsGateDataset, serializeTopicsGateDataset, TOPICS_GATE,
  TopicsGateError, type TopicsGateLine,
} from "../packages/core/src/topics-gate.ts";
import { loadTopicCases } from "../scripts/jev-topic-probe.ts";

const root = join(import.meta.dirname, "..");
const JEV = "typesafe/jev-1.13";
const LUNA = "openai/gpt-6-luna-decisions";

describe("committed gate datasets", () => {
  const sets = loadTopicsGateDatasets(root);

  it("one dataset per model, each green (this is the gate the switch depends on)", () => {
    assert.deepEqual(sets.map((s) => s.file), ["topics-v3__jev.jsonl", "topics-v3__luna-decisions.jsonl"]);
    for (const set of sets) {
      const models = modelsOf(set.lines);
      assert.equal(models.length, 1, set.file);
      const r = evaluateTopicsGate(models[0], set.lines);
      assert.ok(r.topic.ok, `${set.file} topic ${JSON.stringify(r.topic)}`);
      assert.ok(r.noul.ok, `${set.file} noul ${JSON.stringify(r.noul)}`);
      assert.ok(r.green, set.file);
      assert.ok((r.topic.accuracy ?? 0) >= TOPICS_GATE.topicAccuracyMin && (r.topic.macro_f1 ?? 0) >= TOPICS_GATE.topicMacroF1Min);
    }
  });

  it("the topic lines cover the whole synthetic fixture with the same expectations (no mail text in the dataset)", () => {
    const fixture = new Map(loadTopicCases().map((c) => [c.id, c.expected_topic]));
    for (const set of sets) {
      const topics = set.lines.filter((l) => l.suite === "topics");
      assert.equal(topics.length, fixture.size, set.file);
      for (const l of topics) assert.equal(l.suite === "topics" && l.expected_topic, fixture.get(l.id), l.id);
      // only ids, keys and numbers: serializing again gives the same text and no line carries a free text field
      assert.equal(serializeTopicsGateDataset(set.lines), readText(set.file));
      for (const l of set.lines) assert.ok(Object.values(l).every((v) => typeof v !== "string" || v.length <= 64), l.id);
    }
  });
});

const readText = (file: string) => readFileSync(join(root, "evals", "datasets", file), "utf8");

const topicLine = (id: string, expected: string, topic: string, model = JEV): TopicsGateLine => ({
  suite: "topics", id, model, question_set_version: QUESTION_SET_VERSION_V3, list_version: "topics-0123456789ab", expected_topic: expected, topic,
});
const hfLine = (id: string, e: boolean, v2: number, v3: number, model = JEV): TopicsGateLine => ({
  suite: "hf", id, model, question_set_version: QUESTION_SET_VERSION_V3,
  expected: { is_spam: e, needs_my_reply: e }, v2: { is_spam: v2, needs_my_reply: v2 }, v3: { is_spam: v3, needs_my_reply: v3 }, v3_topic: "other",
});

/** `n` topic cases of which `wrong` are answered wrong (classes alternate so the macro-F1 follows the accuracy). */
const topics = (n: number, wrong: number, model = JEV) =>
  Array.from({ length: n }, (_, i) => topicLine(`t-${i}`, i % 2 === 0 ? "finance" : "work", i < wrong ? "travel" : i % 2 === 0 ? "finance" : "work", model));
/** 40 paired HF cases (20 positive): v2 scores perfectly; v3 misses `miss` positives. */
const hf = (miss: number, model = JEV) =>
  Array.from({ length: 40 }, (_, i) => hfLine(`h-${i}`, i < 20, i < 20 ? 0.95 : 0.05, i < 20 ? (i < miss ? 0.1 : 0.95) : 0.05, model));

describe("the rule", () => {
  it("green: accuracy and macro-F1 at the bound, noul equal", () => {
    // 100 cases, 14 wrong = 0.86
    const r = evaluateTopicsGate(JEV, [...topics(100, 14), ...hf(0)]);
    assert.equal(r.topic.accuracy, 0.86);
    assert.ok(r.topic.ok && r.noul.ok && r.green);
  });

  it("red: topic accuracy below 0.85", () => {
    const r = evaluateTopicsGate(JEV, [...topics(100, 16), ...hf(0)]);
    assert.equal(r.topic.accuracy, 0.84);
    assert.equal(r.topic.ok, false);
    assert.equal(r.green, false);
  });

  it("red: macro-F1 below 0.85 although accuracy passes (a rare class is always wrong)", () => {
    const lines: TopicsGateLine[] = [
      ...Array.from({ length: 96 }, (_, i) => topicLine(`a-${i}`, "finance", "finance")),
      ...Array.from({ length: 4 }, (_, i) => topicLine(`b-${i}`, "other", "finance")),
    ];
    const r = evaluateTopicsGate(JEV, [...lines, ...hf(0)]);
    assert.ok((r.topic.accuracy ?? 0) >= 0.85 && (r.topic.macro_f1 ?? 1) < 0.85);
    assert.equal(r.green, false);
  });

  it("red: too few topic cases (the gate cannot pass on a tiny set)", () => {
    const r = evaluateTopicsGate(JEV, [...topics(99, 0), ...hf(0)]);
    assert.equal(r.topic.ok, false);
  });

  it("noul: F1 of v3 may be 0.02 worse than v2, not more", () => {
    // v2 is perfect on is_spam and needs_my_reply (F1 1.0). Missing 1 of 20 positives gives F1 0.974 (drop 0.026): red.
    const slight = evaluateTopicsGate(JEV, [...topics(100, 0), ...hf(1)]);
    assert.equal(slight.noul.ok, false);
    assert.ok(slight.noul.rows.every((x) => x.ok === false));
    const none = evaluateTopicsGate(JEV, [...topics(100, 0), ...hf(0)]);
    assert.equal(none.noul.ok, true);
    // v3 better than v2 is fine
    const better = hf(0).map((l) => (l.suite === "hf" ? { ...l, v2: { is_spam: 0.1, needs_my_reply: 0.1 } } : l));
    assert.equal(evaluateTopicsGate(JEV, [...topics(100, 0), ...better]).noul.ok, true);
  });

  it("noul: too few paired cases, or fewer than two assessable questions, is red; a question without positives is skipped", () => {
    assert.equal(evaluateTopicsGate(JEV, [...topics(100, 0), ...hf(0).slice(0, 29)]).noul.ok, false);
    const onlyOne = hf(0).map((l) => (l.suite === "hf" ? { ...l, expected: { is_spam: l.expected.is_spam } } : l));
    assert.equal(evaluateTopicsGate(JEV, [...topics(100, 0), ...onlyOne]).noul.ok, false);
    const noPositives = hf(0).map((l) => (l.suite === "hf" ? { ...l, expected: { ...l.expected, addresses_an_ai: false }, v2: { ...l.v2, addresses_an_ai: 0 }, v3: { ...l.v3, addresses_an_ai: 0 } } : l));
    const r = evaluateTopicsGate(JEV, [...topics(100, 0), ...noPositives]);
    assert.equal(r.noul.rows.find((x) => x.key === "addresses_an_ai")?.ok, null);
    assert.equal(r.noul.ok, true);
  });

  it("a model without a v3 calibration cannot be assessed (fail-closed); other models' lines are ignored", () => {
    const r = evaluateTopicsGate("other/model", [...topics(100, 0, "other/model"), ...hf(0, "other/model")]);
    assert.equal(r.noul.ok, false);
    const only = evaluateTopicsGate(LUNA, [...topics(100, 0), ...hf(0)]);
    assert.equal(only.topic.n, 0);
    assert.equal(only.green, false);
  });

  it("metrics: accuracy and macro-F1", () => {
    assert.equal(accuracy([], []), null);
    assert.equal(accuracy(["a", "b"], ["a", "a"]), 0.5);
    assert.equal(macroF1(["a", "b"], ["a", "a"]), (2 / 3 + 0) / 2);
    assert.equal(macroF1([], []), null);
  });
});

describe("dataset parsing", () => {
  const good = serializeTopicsGateDataset([topicLine("t-1", "finance", "finance"), hfLine("h-1", true, 0.9, 0.9)]);
  it("round-trips", () => {
    assert.equal(serializeTopicsGateDataset(parseTopicsGateDataset(good)), good);
  });
  it("rejects free text, unknown fields, other question sets, bad numbers and duplicates (paths only in the error)", () => {
    const bad = (obj: unknown) => assert.throws(() => parseTopicsGateDataset(JSON.stringify(obj)), (e: unknown) => e instanceof TopicsGateError);
    const base = JSON.parse(good.split("\n")[0]);
    bad({ ...base, subject: "Hallo" });
    bad({ ...base, topic: "Ein freier Text mit Leerzeichen" });
    bad({ ...base, question_set_version: "email-classification-v2" });
    bad({ ...base, id: "Has Space" });
    bad({ ...JSON.parse(good.split("\n")[1]), v3: { is_spam: 1.5 } });
    assert.throws(() => parseTopicsGateDataset("{not json"), /line 1: not JSON/);
    assert.throws(() => parseTopicsGateDataset(`${good.split("\n")[0]}\n${good.split("\n")[0]}`), /duplicate id/);
    try {
      parseTopicsGateDataset(JSON.stringify({ ...base, topic: "SECRET VALUE" }));
    } catch (e) {
      assert.ok(!String((e as Error).message).includes("SECRET"));
    }
  });
});
