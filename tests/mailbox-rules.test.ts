import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { decideSpamSeen, PROTECTED_CATEGORIES, type RuleInput } from "../lib/mailbox-rules.ts";
import type { NormalizedAnswer } from "../lib/jev-response.ts";

const V1 = "email-classification-v1";
const noul = (key: string, value: number): NormalizedAnswer => ({ key, type: "noul", value });
const cat = (value: string): NormalizedAnswer => ({ key: "category", type: "choice", value });

function input(over: Partial<RuleInput> & { answers?: NormalizedAnswer[] } = {}): RuleInput {
  return { answers: [], questionSetVersion: V1, inProviderSpam: false, seen: false, ...over };
}

describe("rule: protection first (H17)", () => {
  test("security_auth and transactional never get an action, however high the spam value or the folder", () => {
    for (const c of ["security_auth", "transactional"]) {
      for (const inProviderSpam of [false, true]) {
        const d = decideSpamSeen(input({ answers: [noul("is_spam", 0.999), cat(c)], inProviderSpam }));
        assert.deepEqual(d, { action: "none", reason: "protected_category" }, `${c} ${inProviderSpam}`);
      }
    }
    assert.deepEqual([...PROTECTED_CATEGORIES].sort(), ["security_auth", "transactional"]);
  });

  test("allowlist placeholder (M5): a hit protects regardless of the spam value", () => {
    const d = decideSpamSeen(input({ answers: [noul("is_spam", 0.99), cat("promotion")], inProviderSpam: true, allowlisted: true }));
    assert.deepEqual(d, { action: "none", reason: "allowlisted" });
  });

  test("protection wins over an already read mail's reason (checked first)", () => {
    assert.equal(decideSpamSeen(input({ answers: [cat("security_auth")], seen: true })).reason, "protected_category");
  });
});

describe("rule: spam read (E12)", () => {
  test("Jev is_spam positive (calibrated >= 0.80) marks the mail read", () => {
    assert.deepEqual(decideSpamSeen(input({ answers: [noul("is_spam", 0.8), cat("promotion")] })), { action: "mark_seen", reason: "jev_spam" });
    assert.deepEqual(decideSpamSeen(input({ answers: [noul("is_spam", 0.97)] })), { action: "mark_seen", reason: "jev_spam" });
  });

  test("below the threshold is explicit negative: no action", () => {
    assert.deepEqual(decideSpamSeen(input({ answers: [noul("is_spam", 0.79), cat("personal")] })), { action: "none", reason: "not_spam" });
  });

  test("a mail that is already read gets no action", () => {
    assert.deepEqual(decideSpamSeen(input({ answers: [noul("is_spam", 0.99)], seen: true })), { action: "none", reason: "already_seen" });
    assert.equal(decideSpamSeen(input({ answers: [], inProviderSpam: true, seen: true })).action, "none");
  });

  test("provider spam folder and Jev not explicitly negative: marks the mail read", () => {
    // unmapped is_spam (missing answer, unknown question set, non-finite value) is not an explicit "no"
    const unmapped: RuleInput[] = [
      input({ answers: [], inProviderSpam: true }),
      input({ answers: [cat("promotion")], inProviderSpam: true }),
      input({ answers: [noul("is_spam", 0.99)], questionSetVersion: "email-classification-v9", inProviderSpam: true }),
      input({ answers: [noul("is_spam", Number.NaN)], inProviderSpam: true }),
      input({ answers: [{ key: "is_spam", type: "choice", value: "yes" }], inProviderSpam: true }),
    ];
    for (const i of unmapped) assert.deepEqual(decideSpamSeen(i), { action: "mark_seen", reason: "provider_spam" });
    // positive Jev in the spam folder is reported as the Jev reason
    assert.equal(decideSpamSeen(input({ answers: [noul("is_spam", 0.9)], inProviderSpam: true })).reason, "jev_spam");
  });

  test("provider spam but Jev explicitly says not spam: no action", () => {
    assert.deepEqual(decideSpamSeen(input({ answers: [noul("is_spam", 0.1), cat("personal")], inProviderSpam: true })), { action: "none", reason: "not_spam" });
  });

  test("fail-closed outside the spam folder: missing or unmapped answers give no action", () => {
    assert.deepEqual(decideSpamSeen(input({ answers: [] })), { action: "none", reason: "no_signal" });
    assert.deepEqual(decideSpamSeen(input({ answers: [noul("is_spam", 0.99)], questionSetVersion: "email-classification-v9" })), { action: "none", reason: "no_signal" });
    assert.deepEqual(decideSpamSeen(input({ answers: [noul("is_spam", Number.NaN)] })), { action: "none", reason: "no_signal" });
  });

  test("uses the injected interpreter, not its own thresholds", () => {
    const d = decideSpamSeen(input({ answers: [noul("is_spam", 0.1)], interpret: () => "positive" }));
    assert.equal(d.action, "mark_seen");
  });
});

describe("rules: sender allowlist and blacklist (M5, H17)", () => {
  test("allowlist protects against every action, whatever Jev, the provider folder or a blacklist hit says", () => {
    for (const spam of [0.0, 0.5, 0.99]) {
      for (const inProviderSpam of [false, true]) {
        for (const blacklisted of [false, true]) {
          const d = decideSpamSeen(input({ answers: [noul("is_spam", spam), cat("promotion")], inProviderSpam, blacklisted, allowlisted: true }));
          assert.deepEqual(d, { action: "none", reason: "allowlisted" }, `${spam} ${inProviderSpam} ${blacklisted}`);
        }
      }
    }
    assert.deepEqual(decideSpamSeen(input({ allowlisted: true })), { action: "none", reason: "allowlisted" });
  });

  test("protected categories still win over a blacklist hit", () => {
    for (const c of ["security_auth", "transactional"]) {
      assert.deepEqual(decideSpamSeen(input({ answers: [noul("is_spam", 0.99), cat(c)], blacklisted: true })), { action: "none", reason: "protected_category" });
    }
  });

  test("a blacklist hit is an additional reason for 'spam read': it marks the mail read even without a Jev spam verdict", () => {
    assert.deepEqual(decideSpamSeen(input({ answers: [noul("is_spam", 0.1), cat("personal")], blacklisted: true })), { action: "mark_seen", reason: "blacklisted" });
    assert.deepEqual(decideSpamSeen(input({ answers: [], blacklisted: true })), { action: "mark_seen", reason: "blacklisted" });
    assert.deepEqual(decideSpamSeen(input({ answers: [noul("is_spam", 0.5)], blacklisted: true })), { action: "mark_seen", reason: "blacklisted" });
  });

  test("with a positive Jev verdict the reason stays jev_spam; an already read mail gets nothing", () => {
    assert.equal(decideSpamSeen(input({ answers: [noul("is_spam", 0.97)], blacklisted: true })).reason, "jev_spam");
    assert.deepEqual(decideSpamSeen(input({ answers: [noul("is_spam", 0.97)], blacklisted: true, seen: true })), { action: "none", reason: "already_seen" });
  });

  test("a blacklist hit never moves or deletes: the only action is mark_seen (deleting comes with M7)", () => {
    const actions = new Set<string>();
    for (const spam of [0, 0.5, 0.8, 0.99]) for (const inProviderSpam of [false, true]) {
      actions.add(decideSpamSeen(input({ answers: [noul("is_spam", spam)], inProviderSpam, blacklisted: true })).action);
    }
    assert.deepEqual([...actions], ["mark_seen"]);
  });

  test("without any sender rule nothing changes", () => {
    assert.deepEqual(decideSpamSeen(input({ answers: [noul("is_spam", 0.1)] })), { action: "none", reason: "not_spam" });
  });
});
