import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../lib/db.ts";
import { syncAccounts } from "../lib/accounts.ts";
import { ingestMail } from "../lib/ingest.ts";
import type { ImapPort, MessageMeta, TransientInput } from "../lib/imap.ts";
import type { JevCallResult } from "../lib/jev.ts";
import { JEV_MAX_ATTEMPTS, JEV_MODEL, JEV_RETRY_BACKOFF_MAX_MS, JEV_RETRY_BACKOFF_MIN_MS, QUESTION_SET_VERSION, SCHEDULER_TICK_MS } from "../lib/constants.ts";
import { backoffMs, classifyFailure } from "../lib/retry-policy.ts";
import { createClassificationPipeline, type SchedulerClock } from "../lib/classification-pipeline.ts";

const T0 = new Date("2026-10-26T12:00:00.000Z");
const meta: MessageMeta = {
  messageId: "<m1>", sender: "s@example.test", subject: "subj", receivedAt: "2026-10-26T10:00:00.000Z",
  spf: "pass", dkim: "pass", dmarc: "pass", listUnsubscribePresent: false, replyToDiffersFromFrom: false,
};
const input: TransientInput = { ...meta, excerpt: "SYNTHETIC-EXCERPT" };
const OK: JevCallResult = { ok: true, response: { answers: {}, model: "typesafe/jev-1.13-x", usage: { inputTokens: 1, outputTokens: 1 } } as never };
const http = (statusCode: number): JevCallResult => ({ ok: false, kind: "http", statusCode, errorName: "E" });
const transport: JevCallResult = { ok: false, kind: "transport", errorName: "FetchError" };

function fakeClock(start = T0) {
  let t = start.getTime();
  const timers: { fn: () => void; ms: number }[] = [];
  const clock: SchedulerClock & { advance(ms: number): void; timers: typeof timers } = {
    now: () => new Date(t),
    setInterval: (fn, ms) => { const h = { fn, ms }; timers.push(h); return h; },
    clearInterval: (h) => { const i = timers.indexOf(h as never); if (i >= 0) timers.splice(i, 1); },
    advance: (ms) => { t += ms; },
    timers,
  };
  return clock;
}

function setup() {
  const db = openDatabase(":memory:");
  syncAccounts(db, [{
    id: "a", label: "a", context: "c", host: "h", port: 993, tls: true, user: "u", password: "p",
    mailbox: "INBOX", spam_threshold: 0.9, enabled: true,
  } as never]);
  const { emailId } = ingestMail(db, { accountId: "a", meta, loc: { folder: "INBOX", uid: 7, uidValidity: 1 }, now: T0, traceId: "t" });
  const clock = fakeClock();
  const calls: unknown[] = [];
  const results: JevCallResult[] = [];
  const jev = { classify: async (i: unknown) => { calls.push(i); return results.shift() ?? OK; } };
  const fetched: { folder: string; uid: number }[] = [];
  let source: Buffer | null = Buffer.from("From: s@example.test\r\nSubject: subj\r\nMessage-ID: <m1>\r\n\r\nSYNTHETIC body\r\n");
  const port = {
    connect: async () => {}, close: async () => {},
    mailboxStatus: async () => ({ uidValidity: 1, highestUid: 7 }),
    fetchMessageByUid: async (folder: string, uid: number) => { fetched.push({ folder, uid }); return source ? { uid, source } : null; },
  } as unknown as ImapPort;
  const persisted: number[] = [];
  const pipeline = createClassificationPipeline({
    db, clock, jev, portFactory: () => port,
    persistResponse: ({ classificationId }) => { persisted.push(classificationId); },
  });
  return { db, clock, calls, results, fetched, pipeline, emailId, persisted, setSource: (s: Buffer | null) => { source = s; } };
}
const row = (db: DatabaseSync) => ({ ...(db.prepare("SELECT * FROM classifications").get() as Record<string, unknown>) });
const audits = (db: DatabaseSync) => db.prepare("SELECT action FROM audit_log WHERE action IN ('jev_paused','source_gone')").all().map((r) => r.action);

describe("classifyFailure / backoffMs", () => {
  test("http transient codes", () => {
    for (const s of [429, 500, 502, 503, 524, 529]) assert.equal(classifyFailure(http(s) as never).action, "retry", String(s));
  });
  test("http permanent codes", () => {
    for (const s of [400, 403, 404, 413]) {
      const c = classifyFailure(http(s) as never);
      assert.deepEqual([c.action, c.failureCode], ["fail", `http_${s}`]);
    }
  });
  test("401/402 pause", () => {
    for (const s of [401, 402]) assert.equal(classifyFailure(http(s) as never).action, "pause");
  });
  test("unknown http status is not retried", () => {
    assert.equal(classifyFailure(http(418) as never).action, "fail");
  });
  test("explicit rule: transport errors are transient", () => {
    const c = classifyFailure(transport as never);
    assert.deepEqual([c.action, c.failureCode], ["retry", "transport"]);
  });
  test("backoff doubles from min and caps at max", () => {
    assert.equal(backoffMs(1), JEV_RETRY_BACKOFF_MIN_MS);
    assert.equal(backoffMs(2), JEV_RETRY_BACKOFF_MIN_MS * 2);
    assert.equal(backoffMs(20), JEV_RETRY_BACKOFF_MAX_MS);
  });
});

describe("classification pipeline scheduler", () => {
  test("transient failure -> retry_wait with attempts+1 and next_attempt_at", async () => {
    const s = setup();
    s.results.push(http(429));
    await s.pipeline.submit({ emailId: s.emailId, accountId: "a", input });
    const r = row(s.db);
    assert.equal(r.status, "retry_wait");
    assert.equal(r.attempts, 1);
    assert.equal(r.next_attempt_at, new Date(T0.getTime() + JEV_RETRY_BACKOFF_MIN_MS).toISOString());
    assert.equal(r.model_requested, JEV_MODEL);
    assert.equal(r.question_set_version, QUESTION_SET_VERSION);
    assert.equal(s.fetched.length, 0, "first attempt uses in-memory excerpt");
    assert.match(JSON.stringify(s.calls[0]), /SYNTHETIC-EXCERPT/);
  });

  test("retry refetches via active location, then succeeds", async () => {
    const s = setup();
    s.results.push(http(503));
    await s.pipeline.submit({ emailId: s.emailId, accountId: "a", input });
    await s.pipeline.tick();
    assert.equal(s.calls.length, 1, "not yet due");
    s.clock.advance(JEV_RETRY_BACKOFF_MIN_MS);
    await s.pipeline.tick();
    assert.deepEqual(s.fetched, [{ folder: "INBOX", uid: 7 }]);
    assert.match(JSON.stringify(s.calls[1]), /SYNTHETIC body/);
    const r = row(s.db);
    assert.equal(r.status, "classified");
    assert.equal(r.model_reported, "typesafe/jev-1.13-x");
    assert.equal(r.attempts, 2);
    assert.equal(s.persisted.length, 1);
  });

  test("after JEV_MAX_ATTEMPTS -> failed max_attempts", async () => {
    const s = setup();
    for (let i = 0; i < JEV_MAX_ATTEMPTS; i++) s.results.push(http(500));
    await s.pipeline.submit({ emailId: s.emailId, accountId: "a", input });
    for (let i = 0; i < JEV_MAX_ATTEMPTS; i++) { s.clock.advance(JEV_RETRY_BACKOFF_MAX_MS); await s.pipeline.tick(); }
    const r = row(s.db);
    assert.equal(r.status, "failed");
    assert.equal(r.failure_code, "max_attempts");
    assert.equal(r.attempts, JEV_MAX_ATTEMPTS);
    assert.equal(s.calls.length, JEV_MAX_ATTEMPTS);
  });

  test("400/403/413 -> failed immediately", async () => {
    for (const code of [400, 403, 413]) {
      const s = setup();
      s.results.push(http(code));
      await s.pipeline.submit({ emailId: s.emailId, accountId: "a", input });
      const r = row(s.db);
      assert.deepEqual([r.status, r.failure_code], ["failed", `http_${code}`]);
    }
  });

  test("transport error is retried", async () => {
    const s = setup();
    s.results.push(transport);
    await s.pipeline.submit({ emailId: s.emailId, accountId: "a", input });
    assert.equal(row(s.db).status, "retry_wait");
  });

  test("401 pauses row, audits, and stops further calls until restart", async () => {
    const s = setup();
    s.results.push(http(401));
    await s.pipeline.submit({ emailId: s.emailId, accountId: "a", input });
    assert.equal(row(s.db).status, "paused");
    assert.deepEqual(audits(s.db), ["jev_paused"]);
    const second = ingestMail(s.db, { accountId: "a", meta: { ...meta, messageId: "<m2>" }, loc: { folder: "INBOX", uid: 8, uidValidity: 1 }, now: T0, traceId: "t" });
    await s.pipeline.submit({ emailId: second.emailId, accountId: "a", input });
    await s.pipeline.tick();
    assert.equal(s.calls.length, 1);
    await s.pipeline.start();
    assert.equal(s.calls.length, 3);
    assert.deepEqual(s.db.prepare("SELECT status FROM classifications ORDER BY id").all().map((r) => r.status), ["classified", "classified"]);
    s.pipeline.stop();
  });

  test("402 pauses too", async () => {
    const s = setup();
    s.results.push(http(402));
    await s.pipeline.submit({ emailId: s.emailId, accountId: "a", input });
    assert.equal(row(s.db).status, "paused");
  });

  test("retry without active location -> failed source_gone + audit, no Jev call", async () => {
    const s = setup();
    s.results.push(http(502));
    await s.pipeline.submit({ emailId: s.emailId, accountId: "a", input });
    s.db.prepare("UPDATE email_locations SET is_active = 0").run();
    s.clock.advance(JEV_RETRY_BACKOFF_MIN_MS);
    await s.pipeline.tick();
    const r = row(s.db);
    assert.deepEqual([r.status, r.failure_code], ["failed", "source_gone"]);
    assert.deepEqual(audits(s.db), ["source_gone"]);
    assert.equal(s.calls.length, 1);
  });

  test("retry with UID gone from IMAP -> source_gone", async () => {
    const s = setup();
    s.results.push(http(502));
    await s.pipeline.submit({ emailId: s.emailId, accountId: "a", input });
    s.setSource(null);
    s.clock.advance(JEV_RETRY_BACKOFF_MIN_MS);
    await s.pipeline.tick();
    assert.equal(row(s.db).failure_code, "source_gone");
  });

  test("start loads due rows and ticks every SCHEDULER_TICK_MS; stop clears timer", async () => {
    const s = setup();
    s.results.push(http(500));
    await s.pipeline.submit({ emailId: s.emailId, accountId: "a", input });
    await s.pipeline.start();
    assert.equal(s.clock.timers.length, 1);
    assert.equal(s.clock.timers[0].ms, SCHEDULER_TICK_MS);
    s.pipeline.stop();
    assert.equal(s.clock.timers.length, 0);
  });

  test("persisted rows contain no excerpt/body", async () => {
    const s = setup();
    s.results.push(http(429));
    await s.pipeline.submit({ emailId: s.emailId, accountId: "a", input });
    const dump = JSON.stringify([
      s.db.prepare("SELECT * FROM classifications").all(), s.db.prepare("SELECT * FROM audit_log").all(),
    ]);
    assert.doesNotMatch(dump, /SYNTHETIC/);
  });
});
