// R8: the pipeline asks question set v3 only for owners with topics_enabled; the topic list version is stored with the answer.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { createClassificationPipeline, createPersistResponse } from "../lib/classification-pipeline.ts";
import { JEV_MODEL, QUESTION_SET_VERSION, QUESTION_SET_VERSION_V3 } from "../lib/constants.ts";
import { syncAccounts } from "../lib/accounts.ts";
import { openDatabase } from "../lib/db.ts";
import { ingestMail } from "../lib/ingest.ts";
import type { ImapPort, MessageMeta, TransientInput } from "../lib/imap.ts";
import type { JevCallResult } from "../lib/jev.ts";
import type { JevQuestion } from "../lib/jev-questions.ts";
import { interpretNoul } from "../lib/jev-response.ts";
import { createCustomTopic, setCustomTopicActive, setTopicsEnabled, topicListForUser, topicsEnabled } from "../lib/topics-store.ts";
import { accountUserId } from "../lib/tenant.ts";
import { getEmailItem } from "../lib/email-api.ts";

const T0 = new Date("2026-11-01T12:00:00.000Z");
const meta = (n: number): MessageMeta => ({
  messageId: `<m${n}>`, sender: "s@example.test", subject: "subj", receivedAt: "2026-11-01T10:00:00.000Z",
  spf: "pass", dkim: "pass", dmarc: "pass", listUnsubscribePresent: false, replyToDiffersFromFrom: false,
});
const fixture = () => JSON.parse(readFileSync(new URL("./fixtures/jev-email-v2-response.json", import.meta.url), "utf8"));

/** A v2 response (fixture) plus a topic choice over the given options. */
function respond(questions: Record<string, JevQuestion>, topic: string): JevCallResult {
  const answers = { ...fixture().answers } as Record<string, unknown>;
  const q = questions["topic"];
  if (q?.type === "choice") {
    const options = Object.keys(q.criteria);
    answers["topic"] = { type: "choice", choice: topic, probabilities: Object.fromEntries(options.map((o) => [o, o === topic ? 1 : 0])) };
  } else delete answers["topic"];
  return { ok: true, response: { ...fixture(), answers, model: "typesafe/jev-1.13-r" } as never };
}

function setup(o: { topicsOn?: boolean } = {}) {
  const db = openDatabase(":memory:");
  syncAccounts(db, [{ id: "a", label: "a", context: "c", host: "h", port: 993, tls: true, user: "u", password: "p", mailbox: "INBOX", spam_threshold: 0.9, enabled: true } as never]);
  if (o.topicsOn) setTopicsEnabled(db, 1, true, T0);
  const asked: { questions: Record<string, JevQuestion> }[] = [];
  let next: (q: Record<string, JevQuestion>) => JevCallResult = (q) => respond(q, "finance");
  const jev = { classify: async ({ questions }: { questions: Record<string, JevQuestion> }) => { asked.push({ questions }); return next(questions); } };
  const port = { connect: async () => {}, close: async () => {}, mailboxStatus: async () => ({ uidValidity: 1, highestUid: 7 }), fetchMessageByUid: async (_f: string, uid: number) => ({ uid, source: Buffer.from("From: s@example.test\r\nMessage-ID: <m1>\r\n\r\nbody\r\n") }) } as unknown as ImapPort;
  let t = T0.getTime();
  const pipeline = createClassificationPipeline({
    db, jev, portFactory: () => port,
    clock: { now: () => new Date(t), setInterval: () => 0, clearInterval: () => {} },
    persistResponse: createPersistResponse(() => 0.9),
    topicsEnabled: (accountId) => topicsEnabled(db, accountUserId(db, accountId)),
    topicList: (accountId) => topicListForUser(db, accountUserId(db, accountId)),
  });
  const mail = (n: number) => ingestMail(db, { accountId: "a", meta: meta(n), loc: { folder: "INBOX", uid: n, uidValidity: 1 }, now: T0, traceId: "t" }).emailId;
  const input = (n: number): TransientInput => ({ ...meta(n), excerpt: "x" });
  return { db, pipeline, asked, mail, input, setNext: (f: typeof next) => { next = f; }, advance: (ms: number) => { t += ms; } };
}
type S = ReturnType<typeof setup>;
const row = (db: DatabaseSync, emailId: number) =>
  ({ ...(db.prepare("SELECT question_set_version AS v, topic_list_version AS tl, status FROM classifications WHERE email_id = ?").get(emailId) as { v: string; tl: string | null; status: string }) });
const submit = async (s: S, n: number) => {
  const id = s.mail(n);
  await s.pipeline.submit({ emailId: id, accountId: "a", input: s.input(n) });
  return id;
};

describe("pipeline and the topics switch", () => {
  test("switch off (default): v2 as before; no topic question, no list version, no topic answer", async () => {
    const s = setup();
    const id = await submit(s, 1);
    assert.deepEqual(row(s.db, id), { v: QUESTION_SET_VERSION, tl: null, status: "classified" });
    assert.ok(!Object.keys(s.asked[0].questions).includes("topic"));
    assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM classification_answers WHERE question_key = 'topic'").get()?.n, 0);
  });

  test("switch on: v3 with the user's list; the list version and the topic answer are stored", async () => {
    const s = setup({ topicsOn: true });
    assert.ok(createCustomTopic(s.db, 1, { label: "Segelverein", hint: "Mails des Segelclubs" }, T0).ok);
    const list = topicListForUser(s.db, 1);
    assert.ok(list.ok);
    s.setNext((q) => respond(q, "custom_segelverein"));
    const id = await submit(s, 1);
    assert.deepEqual(row(s.db, id), { v: QUESTION_SET_VERSION_V3, tl: list.version, status: "classified" });
    const q = s.asked[0].questions["topic"];
    assert.ok(q?.type === "choice");
    assert.equal(Object.keys(q.criteria).length, 13);
    assert.ok(Object.keys(q.criteria).includes("custom_segelverein"));
    const a = s.db.prepare("SELECT type, answer_json FROM classification_answers WHERE question_key = 'topic'").get() as { type: string; answer_json: string };
    assert.deepEqual([a.type, JSON.parse(a.answer_json)], ["choice", { value: "custom_segelverein" }]);
    // v3 answers are read with the v3 calibration (same thresholds as v2) and surface as the item's topic
    assert.equal(interpretNoul({ key: "is_spam", type: "noul", value: 0.7 }, QUESTION_SET_VERSION_V3, JEV_MODEL), "positive");
    assert.equal(getEmailItem(s.db, 1, id)?.topic, "custom_segelverein");
    assert.equal(getEmailItem(s.db, 1, id)?.classification?.["question_set_version"], QUESTION_SET_VERSION_V3);
  });

  test("changing the custom list gives a new list version for NEW mails; the old mail keeps its version and its answer", async () => {
    const s = setup({ topicsOn: true });
    const first = await submit(s, 1);
    const v1 = row(s.db, first).tl;
    assert.ok(createCustomTopic(s.db, 1, { label: "Hausbau" }, T0).ok);
    s.setNext((q) => respond(q, "custom_hausbau"));
    const second = await submit(s, 2);
    const v2 = row(s.db, second).tl;
    assert.ok(v1 && v2 && v1 !== v2);
    assert.equal(row(s.db, first).tl, v1, "the first answer keeps the list it was asked with");
    // deactivating returns to the first list: same version again
    assert.ok(setCustomTopicActive(s.db, 1, "custom_hausbau", false, T0).ok);
    s.setNext((q) => respond(q, "finance"));
    const third = await submit(s, 3);
    assert.equal(row(s.db, third).tl, v1);
  });

  test("turning the switch off again: new mails are v2 again, v3 rows stay", async () => {
    const s = setup({ topicsOn: true });
    const a = await submit(s, 1);
    setTopicsEnabled(s.db, 1, false, T0);
    const b = await submit(s, 2);
    assert.equal(row(s.db, a).v, QUESTION_SET_VERSION_V3);
    assert.equal(row(s.db, b).v, QUESTION_SET_VERSION);
    assert.equal(row(s.db, b).tl, null);
  });

  test("a topic outside the asked list rejects the response (fail-closed), nothing is stored", async () => {
    const s = setup({ topicsOn: true });
    s.setNext((q) => {
      const r = respond(q, "finance");
      if (r.ok) (r.response.answers as Record<string, unknown>)["topic"] = { type: "choice", choice: "custom_not_in_list" };
      return r;
    });
    const id = await submit(s, 1);
    const c = s.db.prepare("SELECT status, failure_code FROM classifications WHERE email_id = ?").get(id) as { status: string; failure_code: string };
    assert.deepEqual({ ...c }, { status: "failed", failure_code: "invalid_response_invalid_value" });
    assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM classification_answers").get()?.n, 0);
    assert.equal(row(s.db, id).tl, null);
  });

  test("a v3 retry uses the owner's CURRENT list and stores that version, even if the switch is off meanwhile", async () => {
    const s = setup({ topicsOn: true });
    let calls = 0;
    s.setNext((q) => (++calls === 1 ? { ok: false, kind: "http", statusCode: 503, errorName: "E" } : respond(q, "custom_segeln")));
    const id = await submit(s, 1);
    assert.equal(row(s.db, id).status, "retry_wait");
    assert.ok(createCustomTopic(s.db, 1, { label: "Segeln" }, T0).ok);
    setTopicsEnabled(s.db, 1, false, T0);
    s.advance(10 * 60_000);
    await s.pipeline.tick();
    const list = topicListForUser(s.db, 1);
    assert.ok(list.ok);
    assert.deepEqual(row(s.db, id), { v: QUESTION_SET_VERSION_V3, tl: list.version, status: "classified" });
    assert.ok(Object.keys((s.asked[1].questions["topic"] as { criteria: object }).criteria).includes("custom_segeln"));
  });

  test("an unusable topic list keeps the mail on v2 (never an empty or invented list)", async () => {
    const s = setup({ topicsOn: true });
    const broken = createClassificationPipeline({
      db: s.db, jev: { classify: async ({ questions }) => respond(questions, "finance") }, portFactory: () => ({}) as ImapPort,
      clock: { now: () => T0, setInterval: () => 0, clearInterval: () => {} }, persistResponse: createPersistResponse(() => 0.9),
      topicsEnabled: () => true, topicList: () => ({ ok: false, code: "duplicate" }),
    });
    const id = s.mail(9);
    await broken.submit({ emailId: id, accountId: "a", input: s.input(9) });
    assert.equal(row(s.db, id).v, QUESTION_SET_VERSION);
  });
});
