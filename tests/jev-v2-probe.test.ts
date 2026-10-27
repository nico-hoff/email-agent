import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { buildFixture, FIXTURE_PATH, parseProbeArgs, PROBE_MAIL, runProbe } from "../scripts/jev-v2-probe.ts";
import { QUESTION_SET_VERSION_V2 } from "../lib/constants.ts";
import { questionsFor } from "../lib/jev-questions.ts";
import type { JevClient } from "../lib/jev.ts";

const root = join(import.meta.dirname, "..");

function fullAnswers(): Record<string, unknown> {
  return {
    is_spam: { type: "noul", noul: 0.1 },
    is_phishing_or_scam: { type: "noul", noul: 0.1 },
    addresses_an_ai: { type: "noul", noul: 0.05 },
    needs_my_reply: { type: "noul", noul: 0.9, leak: "MAIL-BODY-ECHO" },
    is_assessable: { type: "noul", noul: 0.95 },
    category: { type: "choice", choice: "business", confidence: 0.9, probabilities: { spam: 0, newsletter_promo: 0, transactional: 0, security_auth: 0, personal: 0.1, business: 0.9, unclear: 0 } },
    route: { type: "choice", choice: "notify", probabilities: { ignore: 0, digest: 0.1, notify: 0.6, draft_reply: 0.3 } },
    urgency: { type: "score", score: 1.2, probabilities: { "0": 0.1, "1": 0.7, "2": 0.2, "3": 0 } },
    importance: { type: "score", score: 1, legend: { "0": "Routine", "1": "Useful, not critical", "2": "x", "3": "y" } },
  };
}

function fakeJev(response: unknown) {
  const calls: { questions: unknown; state: Record<string, unknown> }[] = [];
  const jev: JevClient = {
    async classify(input) {
      calls.push(input);
      return { ok: true, response: response as never };
    },
  };
  return { jev, calls };
}

const RESPONSE = {
  answers: fullAnswers(),
  id: "gen-dec-1",
  model: "typesafe/jev-1.13-20260917",
  provider: "TypeSafe",
  usage: { inputTokens: 100, outputTokens: 20, cost: 0.00005 },
  headers: { authorization: "Bearer SECRET-KEY" },
  rawBody: "RAW-RESPONSE",
};

test("args: --confirm-live is mandatory, unknown options are reported", () => {
  assert.deepEqual(parseProbeArgs([]), { confirmLive: false, unknown: [] });
  assert.deepEqual(parseProbeArgs(["--confirm-live"]), { confirmLive: true, unknown: [] });
  assert.deepEqual(parseProbeArgs(["--confirm-live", "--x"]).unknown, ["--x"]);
});

test("the script refuses to run without --confirm-live and without a key", () => {
  const env = { PATH: process.env.PATH ?? "" };
  const none = spawnSync(process.execPath, [join(root, "scripts/jev-v2-probe.ts")], { env, encoding: "utf8" });
  assert.equal(none.status, 2);
  assert.match(none.stderr, /--confirm-live/);
  const noKey = spawnSync(process.execPath, [join(root, "scripts/jev-v2-probe.ts"), "--confirm-live"], { env, encoding: "utf8" });
  assert.equal(noKey.status, 2);
  assert.match(noKey.stderr, /OPENROUTER_API_KEY/);
});

test("the built-in mail is synthetic and the fixture path is the planned one", () => {
  assert.match(PROBE_MAIL.sender_domain, /\.example\.test$/);
  assert.ok(PROBE_MAIL.subject.length > 0 && PROBE_MAIL.body.length > 0);
  assert.equal(FIXTURE_PATH, join(root, "tests", "fixtures", "jev-email-v2-response.json"));
});

test("exactly one call with the v2 questions, fixture without mail text, headers or extra fields", async () => {
  const { jev, calls } = fakeJev(RESPONSE);
  const written: { path: string; text: string }[] = [];
  const r = await runProbe({ jev, outPath: "/x/out.json", write: (path, text) => written.push({ path, text }) });
  assert.ok(r.ok);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].questions, questionsFor(QUESTION_SET_VERSION_V2));
  assert.equal(calls[0].state["sender_domain"], PROBE_MAIL.sender_domain);
  assert.equal(calls[0].state["untrusted_subject"], PROBE_MAIL.subject);
  assert.equal(written.length, 1);
  assert.equal(written[0].path, "/x/out.json");
  const text = written[0].text;
  for (const forbidden of ["SECRET-KEY", "RAW-RESPONSE", "MAIL-BODY-ECHO", "authorization", "headers", PROBE_MAIL.body, PROBE_MAIL.subject]) {
    assert.ok(!text.includes(forbidden), forbidden);
  }
  const parsed = JSON.parse(text);
  assert.deepEqual(Object.keys(parsed).sort(), ["answers", "id", "model", "provider", "question_set_version", "usage"]);
  assert.equal(parsed.question_set_version, QUESTION_SET_VERSION_V2);
  assert.equal(parsed.answers.needs_my_reply.noul, 0.9);
  assert.deepEqual(Object.keys(parsed.answers.needs_my_reply).sort(), ["noul", "type"]);
  assert.ok(text.endsWith("\n"));
  assert.ok(!r.lines.join("\n").includes(PROBE_MAIL.body));
});

test("an invalid or failed response writes nothing", async () => {
  const bad = fakeJev({ ...RESPONSE, answers: { is_spam: { type: "noul", noul: 0.1 } } });
  const written: string[] = [];
  const r = await runProbe({ jev: bad.jev, outPath: "/x", write: (_p, t) => written.push(t) });
  assert.equal(r.ok, false);
  assert.equal(written.length, 0);
  assert.equal(bad.calls.length, 1);

  const failing: JevClient = { classify: async () => ({ ok: false, kind: "http", statusCode: 403, errorName: "ForbiddenResponseError" }) };
  const r2 = await runProbe({ jev: failing, outPath: "/x", write: (_p, t) => written.push(t) });
  assert.equal(r2.ok, false);
  assert.match(r2.lines.join("\n"), /http:403:ForbiddenResponseError/);
  assert.equal(written.length, 0);
});

test("buildFixture keeps only whitelisted fields per answer type", () => {
  const f = buildFixture(RESPONSE as never);
  assert.ok(f);
  assert.deepEqual(Object.keys(f.answers["category"] as object).sort(), ["choice", "confidence", "probabilities", "type"]);
  assert.deepEqual(Object.keys(f.answers["importance"] as object).sort(), ["legend", "score", "type"]);
  assert.equal(buildFixture({ ...RESPONSE, answers: {} } as never), null);
});
