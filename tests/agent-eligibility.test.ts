import { test } from "node:test";
import assert from "node:assert/strict";
import { agentEligibility } from "../lib/agent-eligibility.ts";
import type { NormalizedAnswer, NoulReading } from "../lib/jev-response.ts";
import { QUESTION_SET_VERSION } from "../lib/constants.ts";

// Test interpreter: >= 0.5 positive, below negative. Only for these tests; the real one is calibrated (D13).
const byValue = (a: NormalizedAnswer): NoulReading => ((a.value as number) >= 0.5 ? "positive" : "negative");

function answers(over: { addresses_an_ai?: number | null; is_assessable?: number | null; category?: string | null } = {}) {
  const o = { addresses_an_ai: 0.02, is_assessable: 0.9, category: "business", ...over };
  const out: NormalizedAnswer[] = [
    { key: "is_spam", type: "noul", value: 0.1 },
    { key: "needs_my_reply", type: "noul", value: 0.9 },
  ];
  if (o.addresses_an_ai !== null) out.push({ key: "addresses_an_ai", type: "noul", value: o.addresses_an_ai });
  if (o.is_assessable !== null) out.push({ key: "is_assessable", type: "noul", value: o.is_assessable });
  if (o.category !== null) out.push({ key: "category", type: "choice", value: o.category });
  return out;
}

test("an ordinary assessable mail without AI address is eligible", () => {
  assert.deepEqual(agentEligibility(answers(), byValue), { eligible: true });
});

test("addresses_an_ai positive blocks", () => {
  assert.deepEqual(agentEligibility(answers({ addresses_an_ai: 0.9 }), byValue), { eligible: false, reasons: ["addresses_an_ai"] });
});

test("addresses_an_ai unmapped blocks (fail-closed)", () => {
  const unmapped = (a: NormalizedAnswer): NoulReading => (a.key === "addresses_an_ai" ? "unmapped" : byValue(a));
  assert.deepEqual(agentEligibility(answers(), unmapped), { eligible: false, reasons: ["addresses_an_ai"] });
});

test("security_auth blocks regardless of other answers", () => {
  assert.deepEqual(agentEligibility(answers({ category: "security_auth" }), byValue), { eligible: false, reasons: ["security_auth"] });
});

test("is_assessable negative blocks", () => {
  assert.deepEqual(agentEligibility(answers({ is_assessable: 0.1 }), byValue), { eligible: false, reasons: ["not_assessable"] });
});

test("a missing required answer blocks", () => {
  for (const key of ["addresses_an_ai", "is_assessable", "category"] as const) {
    const r = agentEligibility(answers({ [key]: null }), byValue);
    assert.equal(r.eligible, false, key);
    assert.ok(!r.eligible && r.reasons.includes("missing_answer"), key);
  }
  assert.deepEqual(agentEligibility([], byValue), { eligible: false, reasons: ["missing_answer"] });
});

test("all reasons are reported in a fixed order", () => {
  const r = agentEligibility(answers({ addresses_an_ai: 0.9, is_assessable: 0.1, category: "security_auth" }), byValue);
  assert.deepEqual(r, { eligible: false, reasons: ["addresses_an_ai", "security_auth", "not_assessable"] });
});

// Default interpreter = calibrated config (config/noul-calibration.ts). is_assessable stays unmapped there
// (not negative), so it does not block; addresses_an_ai is mapped with threshold 0.30.
test("default interpreter, calibrated: addresses_an_ai 0.02, business, is_assessable unmapped -> allowed", () => {
  assert.deepEqual(agentEligibility(answers({ addresses_an_ai: 0.02 }), undefined, QUESTION_SET_VERSION), { eligible: true });
});

test("default interpreter, calibrated: addresses_an_ai 0.35 and the threshold itself block", () => {
  for (const v of [0.35, 0.3, 0.97]) {
    assert.deepEqual(agentEligibility(answers({ addresses_an_ai: v }), undefined, QUESTION_SET_VERSION), { eligible: false, reasons: ["addresses_an_ai"] }, String(v));
  }
  assert.deepEqual(agentEligibility(answers({ addresses_an_ai: 0.29 }), undefined, QUESTION_SET_VERSION), { eligible: true });
});

test("default interpreter, calibrated: security_auth stays blocked even with addresses_an_ai 0.02", () => {
  assert.deepEqual(
    agentEligibility(answers({ addresses_an_ai: 0.02, category: "security_auth" }), undefined, QUESTION_SET_VERSION),
    { eligible: false, reasons: ["security_auth"] },
  );
});

test("default interpreter without or with another question set version blocks every mail (fail-closed)", () => {
  assert.deepEqual(agentEligibility(answers()), { eligible: false, reasons: ["addresses_an_ai"] });
  assert.deepEqual(agentEligibility(answers(), undefined, "email-classification-v2"), { eligible: false, reasons: ["addresses_an_ai"] });
});
