import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { join } from "node:path";
import { datasetPath, formatReport, loadDataset, parseEvalArgs, runEvalSet } from "../scripts/eval-jev.ts";
import { QUESTION_SET_VERSION_V1, QUESTION_SET_VERSION_V2 } from "../lib/constants.ts";
import { QUESTIONS, questionsFor } from "../lib/jev-questions.ts";
import type { JevClient } from "../lib/jev.ts";

const V2_SET = join(import.meta.dirname, "fixtures", "eval", "email-eval-v2.jsonl");
const V1_SET = join(import.meta.dirname, "fixtures", "eval", "email-eval-v1.jsonl");

describe("synthetic eval set v2", () => {
  const cases = loadDataset(V2_SET);

  it("is German and English, synthetic and has unique ids", () => {
    assert.ok(cases.length >= 28);
    assert.equal(new Set(cases.map((c) => c.id)).size, cases.length);
    assert.ok(cases.some((c) => c.lang === "de") && cases.some((c) => c.lang === "en"));
    for (const c of cases) {
      assert.match(c.id, /^v2-[a-z]+-\d+$/);
      assert.match(c.sender_domain, /\.example\.test$/);
      assert.ok(!/@/.test(c.body), `${c.id}: no mail addresses in bodies`);
    }
    const v1ids = new Set(loadDataset(V1_SET).map((c) => c.id));
    for (const c of cases) assert.ok(!v1ids.has(c.id), c.id);
  });

  it("covers the hard cases of T26", () => {
    const by = (p: string) => cases.filter((c) => c.id.startsWith(`v2-${p}-`));
    assert.ok(by("sec").length >= 4); // Login-Code, Passwort-Reset (legitim)
    assert.ok(by("scam").length >= 4); // gefaelschter Login, Paket-Phishing
    assert.ok(by("inv").some((c) => c.expected.is_phishing_or_scam === false)); // echte Rechnung
    assert.ok(by("inv").some((c) => c.expected.is_phishing_or_scam === true)); // Rechnungsbetrug
    assert.ok(by("news").length >= 3 && by("news").every((c) => c.expected.needs_my_reply === false));
    assert.ok(by("news").some((c) => /antworten sie jetzt/i.test(c.subject)));
    assert.ok(by("pers").some((c) => c.expected.needs_my_reply === true));
    assert.ok(by("biz").some((c) => c.expected.needs_my_reply === true));
    assert.ok(by("spam").length >= 3 && by("spam").every((c) => c.lang === "de" && c.expected.is_spam === true));
    assert.ok(by("inj").length >= 3 && by("inj").every((c) => c.expected.addresses_an_ai === true));
    assert.ok(by("unr").length >= 2 && by("unr").every((c) => c.expected.is_assessable === false));
  });

  it("expects legitimate security mails never to be phishing, fraud always", () => {
    for (const c of cases.filter((x) => x.id.startsWith("v2-sec-"))) {
      assert.equal(c.expected.category, "security_auth");
      assert.equal(c.expected.is_phishing_or_scam, false);
    }
    for (const c of cases.filter((x) => x.id.startsWith("v2-scam-"))) assert.equal(c.expected.is_phishing_or_scam, true);
  });
});

describe("eval:jev options for the question set and dataset", () => {
  it("defaults are unchanged", () => {
    assert.deepEqual(parseEvalArgs(["--confirm-live"]), { ok: true, mode: "fixed", maxCost: null });
  });

  it("selects v2 explicitly", () => {
    assert.deepEqual(parseEvalArgs(["--confirm-live", "--question-set", "v2", "--dataset", "v2"]), {
      ok: true, mode: "fixed", maxCost: null, questionSet: QUESTION_SET_VERSION_V2, dataset: "v2",
    });
    assert.deepEqual(parseEvalArgs(["--question-set", "v1"]), { ok: true, mode: "fixed", maxCost: null, questionSet: QUESTION_SET_VERSION_V1 });
    const hf = parseEvalArgs(["--source", "hf", "--seed", "1", "--n", "5", "--question-set", "v2"]);
    assert.ok(hf.ok && hf.mode === "hf" && hf.questionSet === QUESTION_SET_VERSION_V2);
  });

  it("rejects unknown values and misplaced options", () => {
    assert.equal(parseEvalArgs(["--question-set", "v9"]).ok, false);
    assert.equal(parseEvalArgs(["--question-set"]).ok, false);
    assert.equal(parseEvalArgs(["--dataset", "v3"]).ok, false);
    assert.equal(parseEvalArgs(["--source", "hf", "--seed", "1", "--n", "5", "--dataset", "v2"]).ok, false);
  });

  it("--write-dataset is a fixed-set option only", () => {
    assert.deepEqual(parseEvalArgs(["--write-dataset"]), { ok: true, mode: "fixed", maxCost: null, writeDataset: true });
    assert.equal(parseEvalArgs(["--source", "hf", "--seed", "1", "--n", "5", "--write-dataset"]).ok, false);
  });

  it("dataset files are chosen by name", () => {
    assert.equal(datasetPath("/r", "v1"), join("/r", "tests", "fixtures", "eval", "email-eval-v1.jsonl"));
    assert.equal(datasetPath("/r", "v2"), join("/r", "tests", "fixtures", "eval", "email-eval-v2.jsonl"));
  });
});

describe("runEvalSet with the v2 question set", () => {
  const cases = loadDataset(V2_SET);

  function jevFor(expectedQuestions: Record<string, unknown>): { jev: JevClient; seen: unknown[] } {
    const seen: unknown[] = [];
    const jev: JevClient = {
      async classify({ questions, state }) {
        seen.push(questions);
        const c = cases.find((x) => x.subject === state.untrusted_subject && x.sender_domain === state.sender_domain)!;
        const e = c.expected;
        const answers: Record<string, unknown> = {
          is_spam: { type: "noul", noul: e.is_spam ? 0.9 : 0.1 },
          is_phishing_or_scam: { type: "noul", noul: e.is_phishing_or_scam ? 0.9 : 0.1 },
          addresses_an_ai: { type: "noul", noul: e.addresses_an_ai ? 0.9 : 0.1 },
          needs_my_reply: { type: "noul", noul: e.needs_my_reply ? 0.9 : 0.1 },
          is_assessable: { type: "noul", noul: e.is_assessable ? 0.9 : 0.1 },
          category: { type: "choice", choice: e.category ?? "unclear" },
          route: { type: "choice", choice: "ignore" },
          urgency: { type: "score", score: 0 },
          importance: { type: "score", score: 0 },
          ...expectedQuestions,
        };
        return { ok: true, response: { answers, model: "m", usage: { inputTokens: 1, outputTokens: 1 } } as never };
      },
    };
    return { jev, seen };
  }

  it("sends the chosen questions and scores needs_my_reply", async () => {
    const { jev, seen } = jevFor({});
    const report = await runEvalSet({ jev, cases, questions: questionsFor(QUESTION_SET_VERSION_V2) });
    assert.equal(report.errors.count, 0);
    assert.ok(seen.every((q) => q === questionsFor(QUESTION_SET_VERSION_V2)));
    const reply = report.perQuestion["needs_my_reply"];
    assert.ok(reply && reply.n >= 10);
    assert.equal(reply.rate, 1);
    assert.match(formatReport(report), /needs_my_reply: \d+\/\d+/);
  });

  it("a wrong needs_my_reply answer is a miss", async () => {
    const { jev } = jevFor({ needs_my_reply: { type: "noul", noul: 0.95 } });
    const report = await runEvalSet({ jev, cases, questions: questionsFor(QUESTION_SET_VERSION_V2) });
    const reply = report.perQuestion["needs_my_reply"];
    assert.ok(reply && reply.rate < 1);
  });

  it("without questions the v1 set is used and needs_my_reply is not reported", async () => {
    const v1cases = loadDataset(V1_SET);
    let sent: unknown;
    const jev: JevClient = {
      async classify({ questions }) {
        sent = questions;
        return { ok: false, kind: "http", statusCode: 403, errorName: "E" };
      },
    };
    const report = await runEvalSet({ jev, cases: v1cases.slice(0, 1) });
    assert.equal(sent, QUESTIONS);
    assert.equal(report.perQuestion["needs_my_reply"], undefined);
  });
});
