import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { join } from "node:path";
import { formatReport, loadDataset, runEvalSet } from "../scripts/eval-jev.ts";
import { QUESTIONS } from "../lib/jev-questions.ts";
import type { JevClient } from "../lib/jev.ts";

const DATASET = join(import.meta.dirname, "fixtures", "eval", "email-eval-v1.jsonl");

function answersFor(subject: string, overrides: Record<string, unknown> = {}) {
  const base: Record<string, unknown> = {
    is_spam: { type: "noul", noul: 0.1 },
    is_phishing_or_scam: { type: "noul", noul: 0.1 },
    addresses_an_ai: { type: "noul", noul: 0.1 },
    needs_my_reply: { type: "noul", noul: 0.1 },
    is_assessable: { type: "noul", noul: 0.9 },
    category: { type: "choice", choice: "business" },
    route: { type: "choice", choice: "ignore" },
    urgency: { type: "score", score: 0 },
    importance: { type: "score", score: 0 },
  };
  void subject;
  return { ...base, ...overrides };
}

describe("eval dataset", () => {
  it("has about 30 synthetic cases with the planned distribution", () => {
    const cases = loadDataset(DATASET);
    assert.equal(cases.length, 30);
    const byPrefix = (p: string) => cases.filter((c) => c.id.startsWith(p)).length;
    assert.equal(byPrefix("sec-"), 4);
    assert.equal(byPrefix("phish-"), 4);
    assert.equal(byPrefix("inj-"), 4);
    assert.equal(byPrefix("news-"), 4);
    assert.equal(byPrefix("trans-"), 4);
    assert.equal(byPrefix("spam-"), 3);
    assert.equal(byPrefix("pers-"), 3);
    assert.equal(byPrefix("biz-"), 3);
    assert.ok(byPrefix("unr-") >= 1);
    assert.ok(cases.some((c) => c.lang === "de") && cases.some((c) => c.lang === "en"));
    for (const c of cases) assert.match(c.sender_domain, /\.example\.test$/);
  });
});

describe("eval runner", () => {
  it("computes per-question hit rates and prints only aggregates", async () => {
    const cases = loadDataset(DATASET);
    let calls = 0;
    const jev: JevClient = {
      async classify({ questions, state }) {
        calls++;
        assert.equal(questions, QUESTIONS);
        const subject = String(state.untrusted_subject ?? "");
        const c = cases.find((x) => x.subject === subject && x.sender_domain === state.sender_domain)!;
        const e = c.expected;
        const answers = answersFor(subject, {
          category: { type: "choice", choice: c.id === "biz-1" ? "personal" : e.category },
          is_spam: { type: "noul", noul: e.is_spam ? 0.9 : 0.1 },
          is_phishing_or_scam: { type: "noul", noul: e.is_phishing_or_scam ? 0.9 : 0.1 },
          addresses_an_ai: { type: "noul", noul: e.addresses_an_ai ? 0.9 : 0.1 },
          is_assessable: { type: "noul", noul: e.is_assessable ? 0.9 : 0.1 },
        });
        return { ok: true, response: { answers, model: "m", usage: { inputTokens: 1, outputTokens: 1, cost: 0.5 } } as any };
      },
    };
    const report = await runEvalSet({ jev, cases });
    assert.equal(calls, 30);
    assert.equal(report.total, 30);
    assert.equal(report.errors.count, 0);
    assert.equal(report.perQuestion.category.n, 30);
    assert.equal(report.perQuestion.category.hits, 29);
    assert.equal(report.perQuestion.is_spam.rate, 1);
    assert.equal(report.perQuestion.addresses_an_ai.rate, 1);
    assert.equal(report.costTotal, 15);
    const out = formatReport(report);
    assert.match(out, /category/);
    for (const c of cases) {
      assert.ok(!out.includes(c.body.slice(0, 20)) || c.body === "");
      assert.ok(!out.includes(c.subject) || c.subject === "");
    }
  });

  it("counts errors by class and never retries", async () => {
    const cases = loadDataset(DATASET).slice(0, 3);
    let calls = 0;
    const jev: JevClient = {
      async classify() {
        calls++;
        return { ok: false, kind: "http", statusCode: 403, errorName: "ForbiddenResponseError" };
      },
    };
    const report = await runEvalSet({ jev, cases });
    assert.equal(calls, 3);
    assert.equal(report.errors.count, 3);
    assert.deepEqual(report.errors.byClass, { "http:403:ForbiddenResponseError": 3 });
    assert.equal(report.perQuestion.category.n, 0);
  });

  it("counts malformed responses as errors", async () => {
    const cases = loadDataset(DATASET).slice(0, 1);
    const jev: JevClient = {
      async classify() {
        return { ok: true, response: { answers: {}, model: "m", usage: { inputTokens: 1, outputTokens: 1 } } as any };
      },
    };
    const report = await runEvalSet({ jev, cases });
    assert.equal(report.errors.count, 1);
    assert.deepEqual(report.errors.byClass, { "invalid:missing_answer": 1 });
  });
});
