import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertCalibrationMatchesQuestions, calibrationFor, NOUL_CALIBRATIONS, NoulCalibrationError, noulThreshold, parseNoulCalibration, parseNoulCalibrations } from "../lib/noul-calibration.ts";
import { interpretNoul, type NormalizedAnswer } from "../lib/jev-response.ts";
import { QUESTION_SET_VERSION, QUESTION_SET_VERSION_V1, QUESTION_SET_VERSION_V2 } from "../lib/constants.ts";
import { questionsFor } from "../lib/jev-questions.ts";
import shippedConfig from "../config/noul-calibration.ts";

const root = join(import.meta.dirname, "..");
const V = QUESTION_SET_VERSION_V1; // the tests below that use V are about calibration v1
const noul = (key: string, value: number): NormalizedAnswer => ({ key, type: "noul", value });

const V1 = QUESTION_SET_VERSION_V1;
const V2 = QUESTION_SET_VERSION_V2;
const cal1 = calibrationFor(V1)!;
const cal2 = calibrationFor(V2)!;

describe("config/noul-calibration.ts", () => {
  it("has one entry per question set: v1 unchanged (version 1), v2 new (version 2)", () => {
    assert.equal(NOUL_CALIBRATIONS.length, 2);
    assert.equal(cal1.version, "1");
    assert.equal(cal1.created, "2026-10-27");
    assert.deepEqual(cal1.thresholds, { is_spam: 0.8, is_phishing_or_scam: 0.5, addresses_an_ai: 0.3 });
    assert.equal(cal2.version, "2");
    assert.equal(cal2.created, "2026-10-31");
    assert.deepEqual(cal2.thresholds, { is_spam: 0.7, is_phishing_or_scam: 0.7, addresses_an_ai: 0.3, needs_my_reply: 0.5 });
    assert.ok(cal1.basis.length >= 2 && cal2.basis.length >= 2);
  });

  it("the default question set has a calibration", () => {
    assert.ok(calibrationFor(QUESTION_SET_VERSION));
  });

  const doc = readFileSync(join(root, "docs/jev-contract.md"), "utf8");
  /** Text from a level-2 heading to the next one. */
  const sectionOf = (heading: string): string => {
    const at = doc.indexOf(`\n## ${heading}\n`);
    assert.ok(at >= 0, `section ${heading} missing`);
    const start = at + 1;
    const next = doc.indexOf("\n## ", start + 4);
    return doc.slice(start, next < 0 ? undefined : next);
  };

  for (const [cal, heading] of [[cal1, "Kalibrierung"], [cal2, "Kalibrierung v2"]] as const) {
    it(`matches docs/jev-contract.md (section ${heading}: version, date and every value)`, () => {
      const section = sectionOf(heading);
      assert.ok(section.includes(`Version ${cal.version}`), "version");
      assert.ok(section.includes(cal.created), "date");
      assert.ok(section.includes(cal.question_set_version), "question set");
      for (const [key, t] of Object.entries(cal.thresholds)) {
        assert.match(section, new RegExp(`\\| \`${key}\` \\| ${t.toFixed(2)} \\|`), `${key} ${t}`);
      }
      // Every documented threshold row has a config entry (no value only in the doc).
      const documented = [...section.matchAll(/^\| `(\w+)` \|/gm)].map((m) => m[1]).sort();
      assert.deepEqual(documented, Object.keys(cal.thresholds).sort());
    });
  }
});

describe("parseNoulCalibration", () => {
  const valid = () => structuredClone(shippedConfig[0]) as Record<string, unknown>;
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
    const keys = Object.entries(questionsFor(V1)).filter(([, q]) => q.type === "noul").map(([k]) => k);
    assertCalibrationMatchesQuestions(cal1, V1, keys);
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
    const keys = Object.entries(questionsFor(V1)).filter(([, q]) => q.type === "noul").map(([k]) => k);
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
    assert.equal(interpretNoul(noul("is_spam", 0.99), "email-classification-v9"), "unmapped");
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

describe("calibration v2 (R7)", () => {
  it("the shipped v2 entry passes the cross-check against the v2 questions", () => {
    const keys = Object.entries(questionsFor(V2)).filter(([, q]) => q.type === "noul").map(([k]) => k);
    assertCalibrationMatchesQuestions(cal2, V2, keys);
  });
  it("reads >= threshold as positive, below as negative (boundary included)", () => {
    assert.equal(interpretNoul(noul("is_spam", 0.7), V2), "positive");
    assert.equal(interpretNoul(noul("is_spam", 0.69), V2), "negative");
    assert.equal(interpretNoul(noul("is_spam", 0.75), V), "negative"); // v1 stays at 0.80
    assert.equal(interpretNoul(noul("is_phishing_or_scam", 0.7), V2), "positive");
    assert.equal(interpretNoul(noul("is_phishing_or_scam", 0.6), V2), "negative");
    assert.equal(interpretNoul(noul("is_phishing_or_scam", 0.6), V), "positive"); // v1 stays at 0.50
    assert.equal(interpretNoul(noul("needs_my_reply", 0.5), V2), "positive");
    assert.equal(interpretNoul(noul("needs_my_reply", 0.49), V2), "negative");
    assert.equal(interpretNoul(noul("addresses_an_ai", 0.3), V2), "positive");
  });
  it("needs_my_reply stays unmapped under v1; is_assessable stays unmapped under both", () => {
    for (const v of [0, 0.5, 1]) {
      assert.equal(interpretNoul(noul("needs_my_reply", v), V), "unmapped");
      assert.equal(interpretNoul(noul("is_assessable", v), V), "unmapped");
      assert.equal(interpretNoul(noul("is_assessable", v), V2), "unmapped");
    }
  });
  it("an unknown or missing version, or a missing threshold, is unmapped (fail-closed)", () => {
    for (const v of [undefined, "", "email-classification-v9", "constructor", "1", "2"]) {
      assert.equal(noulThreshold("is_spam", v), null, String(v));
      assert.equal(interpretNoul(noul("is_spam", 0.99), v), "unmapped", String(v));
    }
    assert.equal(calibrationFor("email-classification-v9"), null);
    assert.equal(noulThreshold("not_a_question", V2), null);
    assert.equal(noulThreshold("constructor", V2), null);
  });
  it("a list without entries or with a duplicate question set is invalid", () => {
    const v1 = structuredClone(shippedConfig[0]);
    for (const raw of [[], {}, null, [v1, v1]]) {
      assert.throws(() => parseNoulCalibrations(raw), (e: unknown) => e instanceof NoulCalibrationError && e.code === "noul_calibration_invalid");
    }
    assert.equal(parseNoulCalibrations(structuredClone(shippedConfig)).length, 2);
  });
  it("every v2 threshold belongs to a noul question of v2", () => {
    const noulKeys = new Set(Object.entries(questionsFor(V2)).filter(([, q]) => q.type === "noul").map(([k]) => k));
    for (const key of Object.keys(cal2.thresholds)) assert.ok(noulKeys.has(key), key);
  });
});
