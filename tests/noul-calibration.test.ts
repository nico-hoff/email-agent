import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertCalibrationMatchesQuestions, NOUL_CALIBRATION, NoulCalibrationError, parseNoulCalibration } from "../lib/noul-calibration.ts";
import { interpretNoul, type NormalizedAnswer } from "../lib/jev-response.ts";
import { QUESTION_SET_VERSION } from "../lib/constants.ts";
import { QUESTIONS } from "../lib/jev-questions.ts";
import shippedConfig from "../config/noul-calibration.ts";

const root = join(import.meta.dirname, "..");
const V = QUESTION_SET_VERSION;
const noul = (key: string, value: number): NormalizedAnswer => ({ key, type: "noul", value });

describe("config/noul-calibration.ts", () => {
  it("is valid, versioned and bound to the current question set", () => {
    assert.equal(NOUL_CALIBRATION.version, "1");
    assert.equal(NOUL_CALIBRATION.created, "2026-10-27");
    assert.equal(NOUL_CALIBRATION.question_set_version, V);
    assert.deepEqual(NOUL_CALIBRATION.thresholds, { is_spam: 0.8, is_phishing_or_scam: 0.5, addresses_an_ai: 0.3 });
    assert.ok(NOUL_CALIBRATION.basis.length >= 2);
  });

  it("matches docs/jev-contract.md (section Kalibrierung: version, date and every value)", () => {
    const doc = readFileSync(join(root, "docs/jev-contract.md"), "utf8");
    const at = doc.indexOf("## Kalibrierung");
    assert.ok(at >= 0, "section Kalibrierung missing");
    const section = doc.slice(at);
    assert.ok(section.includes(`Version ${NOUL_CALIBRATION.version}`), "version");
    assert.ok(section.includes(NOUL_CALIBRATION.created), "date");
    assert.ok(section.includes(NOUL_CALIBRATION.question_set_version), "question set");
    for (const [key, t] of Object.entries(NOUL_CALIBRATION.thresholds)) {
      assert.match(section, new RegExp(`\\| \`${key}\` \\| ${t.toFixed(2)} \\|`), `${key} ${t}`);
    }
    // Every documented threshold row has a config entry (no value only in the doc).
    const documented = [...section.matchAll(/^\| `(\w+)` \|/gm)].map((m) => m[1]).sort();
    assert.deepEqual(documented, Object.keys(NOUL_CALIBRATION.thresholds).sort());
  });
});

describe("parseNoulCalibration", () => {
  const valid = () => structuredClone(shippedConfig) as Record<string, unknown>;
  const code = (raw: unknown) => {
    try {
      parseNoulCalibration(raw);
    } catch (e) {
      assert.ok(e instanceof NoulCalibrationError);
      return e.code;
    }
    return null;
  };

  it("accepts the shipped file", () => assert.equal(code(valid()), null));
  it("the shipped file passes the cross-check against the question set", () => {
    const keys = Object.entries(QUESTIONS).filter(([, q]) => q.type === "noul").map(([k]) => k);
    assertCalibrationMatchesQuestions(NOUL_CALIBRATION, V, keys);
  });
  it("rejects with a clear code, never a silent fallback", () => {
    assert.equal(code(null), "noul_calibration_invalid");
    assert.equal(code({}), "noul_calibration_invalid");
    assert.equal(code({ ...valid(), version: "" }), "noul_calibration_invalid");
    assert.equal(code({ ...valid(), created: "27.10.2026" }), "noul_calibration_invalid");
    assert.equal(code({ ...valid(), thresholds: {} }), "noul_calibration_invalid");
    assert.equal(code({ ...valid(), thresholds: { is_spam: 1.5 } }), "noul_calibration_invalid");
    assert.equal(code({ ...valid(), thresholds: { is_spam: "0.8" } }), "noul_calibration_invalid");
    assert.equal(code({ ...valid(), thresholds: { is_spam: Number.NaN } }), "noul_calibration_invalid");
    assert.equal(code({ ...valid(), extra: 1 }), "noul_calibration_invalid");
  });
  it("start-up cross-check: right question set, thresholds only for noul questions", () => {
    const keys = Object.entries(QUESTIONS).filter(([, q]) => q.type === "noul").map(([k]) => k);
    const mismatch = (cal: Record<string, unknown>) => {
      try {
        assertCalibrationMatchesQuestions(parseNoulCalibration(cal), V, keys);
      } catch (e) {
        assert.ok(e instanceof NoulCalibrationError);
        return e.code;
      }
      return null;
    };
    assert.equal(mismatch(valid()), null);
    assert.equal(mismatch({ ...valid(), thresholds: { category: 0.5 } }), "noul_calibration_mismatch");
    assert.equal(mismatch({ ...valid(), thresholds: { not_a_question: 0.5 } }), "noul_calibration_mismatch");
    assert.equal(mismatch({ ...valid(), question_set_version: "other" }), "noul_calibration_mismatch");
  });
  it("the error message carries no values", () => {
    try {
      parseNoulCalibration({ ...valid(), thresholds: { is_spam: 7.77 } });
      assert.fail("must throw");
    } catch (e) {
      assert.ok(!String((e as Error).message).includes("7.77"));
    }
  });
});

describe("interpretNoul (calibrated)", () => {
  it("reads >= threshold as positive, below as negative (boundary included)", () => {
    assert.equal(interpretNoul(noul("is_spam", 0.8), V), "positive");
    assert.equal(interpretNoul(noul("is_spam", 0.95), V), "positive");
    assert.equal(interpretNoul(noul("is_spam", 0.79), V), "negative");
    assert.equal(interpretNoul(noul("is_phishing_or_scam", 0.5), V), "positive");
    assert.equal(interpretNoul(noul("is_phishing_or_scam", 0.49), V), "negative");
    assert.equal(interpretNoul(noul("addresses_an_ai", 0.3), V), "positive");
    assert.equal(interpretNoul(noul("addresses_an_ai", 0.02), V), "negative");
  });
  it("questions without a threshold stay unmapped", () => {
    for (const k of ["needs_my_reply", "is_assessable", "unknown_question"]) {
      for (const v of [0, 0.5, 1]) assert.equal(interpretNoul(noul(k, v), V), "unmapped", `${k} ${v}`);
    }
  });
  it("another or missing question set version is unmapped (fail-closed)", () => {
    assert.equal(interpretNoul(noul("is_spam", 0.99)), "unmapped");
    assert.equal(interpretNoul(noul("is_spam", 0.99), undefined), "unmapped");
    assert.equal(interpretNoul(noul("is_spam", 0.99), "email-classification-v2"), "unmapped");
    assert.equal(interpretNoul(noul("is_spam", 0.99), ""), "unmapped");
  });
  it("non-noul or non-finite values are unmapped", () => {
    assert.equal(interpretNoul({ key: "is_spam", type: "choice", value: "x" }, V), "unmapped");
    assert.equal(interpretNoul({ key: "is_spam", type: "score", value: 2 }, V), "unmapped");
    assert.equal(interpretNoul(noul("is_spam", Number.NaN), V), "unmapped");
    assert.equal(interpretNoul({ key: "is_spam", type: "noul", value: "0.9" }, V), "unmapped");
  });
  it("does not resolve inherited property names", () => {
    assert.equal(interpretNoul(noul("constructor", 1), V), "unmapped");
    assert.equal(interpretNoul(noul("__proto__", 1), V), "unmapped");
  });
});
