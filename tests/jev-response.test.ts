import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { normalizeAnswers } from "../lib/jev-response.ts";
import { QUESTIONS } from "../lib/jev-questions.ts";

function fixture(name: string): any {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
}

const minimalQuestions: any = {
  is_spam: QUESTIONS.is_spam,
  category: { type: "choice", instructions: "x", criteria: { promo: "a", personal: "b" } },
  urgency: { type: "score", instructions: "x", criteria: ["a", "b", "c", "d"] },
};

function code(answers: unknown): unknown {
  const r = normalizeAnswers(answers, QUESTIONS);
  return r.ok ? "ok" : r.code;
}

describe("normalizeAnswers", () => {
  it("reads the full-set fixture typed", () => {
    const r = normalizeAnswers(fixture("jev-email-v1-response.json").answers, QUESTIONS);
    assert.ok(r.ok);
    assert.equal(r.answers.length, 9);
    const by = Object.fromEntries(r.answers.map((a) => [a.key, a]));
    assert.deepEqual(by.is_spam, { key: "is_spam", type: "noul", value: 0.82 });
    assert.equal(by.category.type, "choice");
    assert.equal(by.category.value, "spam");
    assert.equal(Object.keys(by.category.probabilities!).length, 7);
    assert.equal(by.urgency.value, 0.05);
    assert.equal(by.urgency.probabilities!["0"], 0.98);
  });

  it("reads the minimal fixture with its own question set", () => {
    const r = normalizeAnswers(fixture("jev-minimal-response.json").answers, minimalQuestions);
    assert.ok(r.ok);
    assert.equal(r.answers.find((a) => a.key === "category")!.value, "promo");
  });

  it("rejects missing, extra, wrong-typed and unsupported answers", () => {
    const base = fixture("jev-email-v1-response.json").answers;
    const missing = { ...base };
    delete missing.route;
    assert.deepEqual(normalizeAnswers(missing, QUESTIONS), { ok: false, code: "missing_answer", key: "route" });
    assert.deepEqual(normalizeAnswers({ ...base, extra: base.is_spam }, QUESTIONS), {
      ok: false,
      code: "unexpected_answer",
      key: "extra",
    });
    assert.deepEqual(normalizeAnswers({ ...base, is_spam: base.urgency }, QUESTIONS), {
      ok: false,
      code: "type_mismatch",
      key: "is_spam",
    });
    assert.equal(code({ ...base, is_spam: { type: "box" } }), "type_mismatch");
    assert.equal(code({ ...base, is_spam: { type: "zzz" } }), "type_mismatch");
    assert.equal(code({ ...base, is_spam: { type: "noul", noul: "x" } }), "invalid_value");
    assert.equal(code({ ...base, category: { type: "choice", choice: "nope" } }), "invalid_value");
    assert.equal(code({ ...base, urgency: { type: "score", score: 4 } }), "invalid_value");
    assert.equal(code({ ...base, urgency: { type: "score", score: Number.NaN } }), "invalid_value");
    assert.equal(code(null), "invalid_answers");
  });

  it("rejects probabilities that do not cover exactly the options", () => {
    const base = fixture("jev-email-v1-response.json").answers;
    const bad = { ...base, route: { type: "choice", choice: "ignore", probabilities: { ignore: 1 } } };
    assert.equal(code(bad), "invalid_value");
  });
});
