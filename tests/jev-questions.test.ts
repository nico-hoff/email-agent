import assert from "node:assert/strict";
import { test } from "node:test";
import { EXCERPT_MAX_CHARS, QUESTION_SET_VERSION } from "../lib/constants.ts";
import { QUESTIONS, STATE_KEYS, buildState } from "../lib/jev-questions.ts";

test("version constant", () => {
  assert.equal(QUESTION_SET_VERSION, "email-classification-v1");
});

test("keys and types match section 5", () => {
  const expected: Record<string, string> = {
    is_spam: "noul", is_phishing_or_scam: "noul", addresses_an_ai: "noul",
    needs_my_reply: "noul", is_assessable: "noul",
    category: "choice", route: "choice", urgency: "score", importance: "score",
  };
  assert.deepEqual(Object.keys(QUESTIONS).sort(), Object.keys(expected).sort());
  for (const [k, t] of Object.entries(expected)) {
    const q = QUESTIONS[k];
    assert.equal(q?.type, t, k);
    assert.ok(typeof q?.instructions === "string" && q.instructions.length > 10);
  }
});

test("noul criteria have false and true", () => {
  for (const q of Object.values(QUESTIONS)) {
    if (q.type === "noul") assert.deepEqual(Object.keys(q.criteria ?? {}).sort(), ["false", "true"]);
  }
});

test("choice options complete", () => {
  const cat = QUESTIONS["category"];
  const route = QUESTIONS["route"];
  assert.ok(cat?.type === "choice" && route?.type === "choice");
  assert.deepEqual(Object.keys(cat.criteria), ["spam", "newsletter_promo", "transactional", "security_auth", "personal", "business", "unclear"]);
  assert.deepEqual(Object.keys(route.criteria), ["ignore", "digest", "notify", "draft_reply"]);
});

test("score anchors ascending, four each", () => {
  const u = QUESTIONS["urgency"];
  const i = QUESTIONS["importance"];
  assert.ok(u?.type === "score" && i?.type === "score");
  assert.equal(u.criteria.length, 4);
  assert.equal(i.criteria.length, 4);
  assert.match(String(u.criteria[0]), /wait/i);
  assert.match(String(u.criteria[3]), /today|blocking/i);
  assert.match(String(i.criteria[0]), /routine/i);
  assert.match(String(i.criteria[3]), /critical/i);
});

test("state allowlist", () => {
  assert.deepEqual([...STATE_KEYS].sort(), [
    "account_context", "dkim", "dmarc", "list_unsubscribe_present", "reply_to_differs_from_from",
    "sender_domain", "sender_history", "spf", "untrusted_body", "untrusted_subject",
  ]);
});

test("buildState rejects unknown keys", () => {
  assert.throws(() => buildState({ untrusted_body: "x", headers: "all" } as never), /headers/);
});

test("buildState truncates only untrusted fields; others must not be free text", () => {
  const long = "a".repeat(EXCERPT_MAX_CHARS + 50);
  const s = buildState({ untrusted_body: long, untrusted_subject: long, spf: "pass" });
  assert.equal((s["untrusted_body"] as string).length, EXCERPT_MAX_CHARS);
  assert.equal((s["untrusted_subject"] as string).length, EXCERPT_MAX_CHARS);
  assert.equal(s["spf"], "pass");
  assert.throws(() => buildState({ spf: "x".repeat(500) }), /spf/);
  assert.throws(() => buildState({ sender_history: { mails_seen_from_sender: 1, body: "x" } as never }), /body/);
});

test("buildState passes sender_history counters", () => {
  const s = buildState({ sender_history: { mails_seen_from_sender: 3, days_since_first_seen: 9 }, list_unsubscribe_present: true });
  assert.deepEqual(s["sender_history"], { mails_seen_from_sender: 3, days_since_first_seen: 9 });
  assert.equal(s["list_unsubscribe_present"], true);
});
