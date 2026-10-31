import assert from "node:assert/strict";
import { test } from "node:test";
import { EXCERPT_MAX_CHARS, QUESTION_SET_VERSION, QUESTION_SET_VERSION_V1, QUESTION_SET_VERSION_V2 } from "../lib/constants.ts";
import { QUESTIONS, QUESTION_SET_VERSIONS, STATE_KEYS, buildState, questionsFor } from "../lib/jev-questions.ts";

test("version constant", () => {
  assert.equal(QUESTION_SET_VERSION, "email-classification-v2"); // default since R7 (ADR 0032)
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

// --- Fragenset v2 (T26) ---

test("v1 stays retrievable unchanged (no longer the default since R7)", () => {
  assert.equal(QUESTION_SET_VERSION_V1, "email-classification-v1");
  assert.notEqual(QUESTION_SET_VERSION, QUESTION_SET_VERSION_V1);
  assert.notEqual(questionsFor("email-classification-v1"), QUESTIONS);
  const reply = questionsFor("email-classification-v1")["needs_my_reply"];
  assert.ok(reply?.type === "noul");
  assert.equal(reply.instructions, "Does the mail expect a reply or action from the recipient (question, request, deadline, appointment)?");
  assert.deepEqual(reply.criteria, {
    false: "No reply or action is expected from the recipient.",
    true: "A reply or action from the recipient is expected.",
  });
  const phish = questionsFor("email-classification-v1")["is_phishing_or_scam"];
  assert.ok(phish?.type === "noul");
  assert.equal(
    phish.instructions,
    "Does the mail try to trick the recipient into giving up credentials, paying, or clicking (fake bank, parcel or account mails, invoice fraud, impersonation)?",
  );
});

test("v2 is registered, explicit, and unknown versions are rejected", () => {
  assert.equal(QUESTION_SET_VERSION_V2, "email-classification-v2");
  assert.deepEqual([...QUESTION_SET_VERSIONS], [QUESTION_SET_VERSION_V1, QUESTION_SET_VERSION_V2]);
  assert.equal(questionsFor(QUESTION_SET_VERSION_V2), QUESTIONS); // QUESTIONS follows the default (v2)
  assert.throws(() => questionsFor("email-classification-v9"), /question_set_unknown/);
  assert.throws(() => questionsFor("constructor"), /question_set_unknown/);
});

test("v2 keeps keys, types and all non-noul questions of v1", () => {
  const v1 = questionsFor(QUESTION_SET_VERSION_V1);
  const v2 = questionsFor(QUESTION_SET_VERSION_V2);
  assert.deepEqual(Object.keys(v2), Object.keys(v1));
  for (const [k, q] of Object.entries(v1)) {
    assert.equal(v2[k]?.type, q.type, k);
    if (q.type !== "noul") assert.deepEqual(v2[k], q, k); // categories stay until the folders of M4
  }
  for (const k of ["is_spam", "addresses_an_ai", "is_assessable"]) assert.deepEqual(v2[k], v1[k], k);
  for (const q of Object.values(v2)) {
    if (q.type === "noul") assert.deepEqual(Object.keys(q.criteria ?? {}).sort(), ["false", "true"]);
  }
});

test("v2 needs_my_reply requires a personal request and excludes marketing calls to action", () => {
  const q = questionsFor(QUESTION_SET_VERSION_V2)["needs_my_reply"];
  assert.ok(q?.type === "noul");
  assert.match(String(q.instructions), /personal/i);
  assert.match(String(q.instructions), /marketing/i);
  assert.match(String(q.instructions), /newsletter/i);
  assert.match(String(q.instructions), /automatic/i);
  assert.match(String(q.criteria?.["true"] ?? ""), /personal/i);
  assert.match(String(q.criteria?.["false"] ?? ""), /marketing|newsletter/i);
  assert.match(String(q.criteria?.["false"] ?? ""), /automatic/i);
});

test("v2 is_phishing_or_scam separates legitimate security mails", () => {
  const q = questionsFor(QUESTION_SET_VERSION_V2)["is_phishing_or_scam"];
  assert.ok(q?.type === "noul");
  const text = `${String(q.instructions)} ${String(q.criteria?.["false"] ?? "")}`;
  assert.match(text, /login code/i);
  assert.match(text, /password reset/i);
  assert.match(text, /recipient (requested|triggered|asked)/i);
  assert.match(text, /payment/i);
  assert.match(String(q.criteria?.["true"] ?? ""), /deceive|trick/i);
});
