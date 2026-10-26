import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openDatabase } from "../lib/db.ts";
import { syncAccounts } from "../lib/accounts.ts";
import { ingestMail } from "../lib/ingest.ts";
import type { ImapPort, MessageMeta, TransientInput } from "../lib/imap.ts";
import type { JevCallResult } from "../lib/jev.ts";
import { JEV_MODEL, QUESTION_SET_VERSION } from "../lib/constants.ts";
import { createClassificationPipeline, createPersistResponse } from "../lib/classification-pipeline.ts";
import { computeShadowQuarantine } from "../lib/shadow.ts";
import type { NormalizedAnswer } from "../lib/jev-response.ts";
import { createWorkersWithPipeline } from "../server.ts";

const T0 = new Date("2026-10-26T12:00:00.000Z");
const EXCERPT_MARK = "EXCERPT-MARKER-7F3A";
const RAW_MARK = "RAWRESP-MARKER-91C2";
const meta: MessageMeta = {
  messageId: "<m1>", sender: "s@example.test", subject: "subj", receivedAt: "2026-10-26T10:00:00.000Z",
  spf: "pass", dkim: "pass", dmarc: "pass", listUnsubscribePresent: false, replyToDiffersFromFrom: false,
};
const input: TransientInput = { ...meta, excerpt: EXCERPT_MARK };
const fixture = () => JSON.parse(readFileSync(new URL("./fixtures/jev-email-v1-response.json", import.meta.url), "utf8"));
const okWith = (answers: unknown, extra: Record<string, unknown> = {}): JevCallResult =>
  ({ ok: true, response: { ...fixture(), answers, model: "typesafe/jev-1.13-r", ...extra } as never });

function setup(results: JevCallResult[] = [okWith(fixture().answers)]) {
  const db = openDatabase(":memory:");
  syncAccounts(db, [{
    id: "a", label: "a", context: "c", host: "h", port: 993, tls: true, user: "u", password: "p",
    mailbox: "INBOX", spam_threshold: 0.9, enabled: true,
  } as never]);
  const { emailId } = ingestMail(db, { accountId: "a", meta, loc: { folder: "INBOX", uid: 7, uidValidity: 1 }, now: T0, traceId: "t" });
  const seen: { emails: number; status: unknown }[] = [];
  const jev = {
    classify: async () => {
      seen.push({
        emails: (db.prepare("SELECT COUNT(*) n FROM emails").get() as { n: number }).n,
        status: (db.prepare("SELECT status FROM classifications").get() as { status: string } | undefined)?.status,
      });
      return results.shift()!;
    },
  };
  // Every property except the four read methods throws: any mailbox write would fail the test.
  const readOnly = new Set(["connect", "close", "mailboxStatus", "fetchMessageByUid"]);
  const port = new Proxy({
    connect: async () => {}, close: async () => {},
    mailboxStatus: async () => ({ uidValidity: 1, highestUid: 7 }),
    fetchMessageByUid: async (_f: string, uid: number) => ({ uid, source: Buffer.from("From: s@example.test\r\nMessage-ID: <m1>\r\n\r\nbody\r\n") }),
  }, { get(t, p) { if (!readOnly.has(String(p))) throw new Error(`mailbox write attempted: ${String(p)}`); return (t as never)[p]; } }) as unknown as ImapPort;
  const pipeline = createClassificationPipeline({
    db, jev, portFactory: () => port, clock: { now: () => T0, setInterval: () => 0, clearInterval: () => {} },
    persistResponse: createPersistResponse(() => 0.9),
  });
  return { db, pipeline, emailId, seen };
}
const count = (db: ReturnType<typeof openDatabase>, sql: string) => (db.prepare(sql).get() as { n: number }).n;

describe("pipeline persistence", () => {
  test("one idempotent row per mail; metadata stored before the Jev call", async () => {
    const s = setup();
    await s.pipeline.submit({ emailId: s.emailId, accountId: "a", input });
    await s.pipeline.submit({ emailId: s.emailId, accountId: "a", input });
    assert.equal(count(s.db, "SELECT COUNT(*) n FROM classifications"), 1);
    assert.equal(s.seen.length, 1);
    assert.deepEqual(s.seen[0], { emails: 1, status: "pending" });
  });

  test("answers, model_reported, latency_ms and derived shadow row land together", async () => {
    const s = setup();
    await s.pipeline.submit({ emailId: s.emailId, accountId: "a", input });
    const c = s.db.prepare("SELECT * FROM classifications").get() as Record<string, unknown>;
    assert.equal(c.status, "classified");
    assert.equal(c.model_reported, "typesafe/jev-1.13-r");
    assert.equal(c.latency_ms, 0);
    const rows = s.db.prepare("SELECT question_key, type, answer_json, probabilities_json FROM classification_answers ORDER BY question_key").all();
    assert.equal(rows.length, 10);
    const cat = rows.find((r) => r.question_key === "category")!;
    assert.equal(cat.type, "choice");
    assert.equal(JSON.parse(cat.answer_json as string).value, "spam");
    assert.ok(JSON.parse(cat.probabilities_json as string).spam > 0);
    const spam = rows.find((r) => r.question_key === "is_spam")!;
    assert.equal(spam.type, "noul");
    assert.equal(spam.probabilities_json, null);
    const sh = rows.find((r) => r.question_key === "shadow_quarantine")!;
    assert.equal(sh.type, "derived");
    const a = JSON.parse(sh.answer_json as string);
    assert.equal(a.candidate, false);
    assert.equal(a.decision, "no");
    assert.equal(a.reason, "unmapped_answer");
    assert.equal(a.applied_threshold, 0.9);
    const au = s.db.prepare("SELECT details_json FROM audit_log WHERE action = 'shadow_quarantine_computed'").all();
    assert.equal(au.length, 1);
  });

  test("a new question set version adds a row and leaves existing ones untouched", async () => {
    const s = setup();
    s.db.prepare(
      `INSERT INTO classifications (email_id, question_set_version, model_requested, status, model_reported, attempts, created_at, updated_at)
       VALUES (?, 'old-v0', ?, 'classified', 'm', 1, 't', 't')`,
    ).run(s.emailId, JEV_MODEL);
    await s.pipeline.submit({ emailId: s.emailId, accountId: "a", input });
    const rows = s.db.prepare("SELECT question_set_version, status FROM classifications ORDER BY id").all();
    assert.deepEqual(rows.map((r) => [r.question_set_version, r.status]), [["old-v0", "classified"], [QUESTION_SET_VERSION, "classified"]]);
  });

  test("invalid answers fail closed: failed row with code, no partial persistence", async () => {
    const answers = fixture().answers;
    delete answers.urgency;
    const s = setup([okWith(answers)]);
    await s.pipeline.submit({ emailId: s.emailId, accountId: "a", input });
    const c = s.db.prepare("SELECT status, failure_code, model_reported FROM classifications").get() as Record<string, unknown>;
    assert.equal(c.status, "failed");
    assert.equal(c.failure_code, "invalid_response_missing_answer");
    assert.equal(c.model_reported, null);
    assert.equal(count(s.db, "SELECT COUNT(*) n FROM classification_answers"), 0);
    assert.equal(count(s.db, "SELECT COUNT(*) n FROM audit_log WHERE action = 'shadow_quarantine_computed'"), 0);
    assert.equal(count(s.db, "SELECT COUNT(*) n FROM audit_log WHERE action = 'classification_failed'"), 1);
  });

  test("no excerpt, raw response or extra SDK fields reach SQLite or logs; no mailbox write", async () => {
    const logs: string[] = [];
    const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
    for (const k of Object.keys(orig) as (keyof typeof orig)[]) console[k] = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
    try {
      const answers = fixture().answers;
      answers.category.reasoning = RAW_MARK;
      const s = setup([
        { ok: false, kind: "http", statusCode: 503, errorName: "E" },
        okWith(answers, { rawDump: RAW_MARK }),
      ]);
      await s.pipeline.submit({ emailId: s.emailId, accountId: "a", input });
      assert.equal(count(s.db, "SELECT COUNT(*) n FROM classifications WHERE status = 'retry_wait'"), 1);
      s.db.prepare("UPDATE classifications SET next_attempt_at = '2000-01-01T00:00:00.000Z'").run();
      await s.pipeline.tick(); // refetch via the write-hostile fake port
      assert.equal(count(s.db, "SELECT COUNT(*) n FROM classifications WHERE status = 'classified'"), 1);
      const tables = s.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name as string);
      const dump = tables.map((t) => JSON.stringify(s.db.prepare(`SELECT * FROM "${t}"`).all())).join("\n");
      for (const mark of [EXCERPT_MARK, RAW_MARK, "rawDump", "reasoning", "legend"]) {
        assert.ok(!dump.includes(mark), `db contains ${mark}`);
        assert.ok(!logs.join("\n").includes(mark), `logs contain ${mark}`);
      }
    } finally {
      Object.assign(console, orig);
    }
  });
});

describe("computeShadowQuarantine", () => {
  const noul = (key: string, value: number): NormalizedAnswer => ({ key, type: "noul", value });
  const base = [noul("is_spam", 0.99), noul("needs_my_reply", 0.01), noul("is_assessable", 0.99),
    { key: "category", type: "choice", value: "security_auth" } as NormalizedAnswer];

  test("unmapped noul interpretation -> candidate false, reason unmapped_answer, category kept raw", () => {
    const r = computeShadowQuarantine(base, 0.95);
    assert.deepEqual(r, {
      candidate: false, decision: "no", applied_threshold: 0.95, reason: "unmapped_answer",
      inputs: { is_spam: 0.99, needs_my_reply: 0.01, is_assessable: 0.99, category: "security_auth" },
    });
  });
  test("missing input answers are unmapped, never defaulted", () => {
    const r = computeShadowQuarantine([], 0.5);
    assert.equal(r.candidate, false);
    assert.equal(r.reason, "unmapped_answer");
  });
  test("candidate path with an injected interpreter (>= 0.5 is positive)", () => {
    const interpret = (a: NormalizedAnswer) => (Number(a.value) >= 0.5 ? "positive" : "negative") as "positive" | "negative";
    const mk = (spam: number, reply: number, assessable: number) =>
      [noul("is_spam", spam), noul("needs_my_reply", reply), noul("is_assessable", assessable)];
    const ok = computeShadowQuarantine(mk(0.99, 0.01, 0.99), 0.95, interpret);
    assert.deepEqual([ok.candidate, ok.decision, ok.reason], [true, "pending_policy", "candidate"]);
    assert.equal(computeShadowQuarantine(mk(0.99, 0.01, 0.99), 0.995, interpret).reason, "below_threshold");
    assert.equal(computeShadowQuarantine(mk(0.99, 0.9, 0.99), 0.9, interpret).reason, "needs_reply");
    assert.equal(computeShadowQuarantine(mk(0.99, 0.1, 0.1), 0.9, interpret).reason, "not_assessable");
    assert.equal(computeShadowQuarantine(mk(0.1, 0.1, 0.9), 0.9, interpret).reason, "not_spam");
  });
});

describe("server wiring", () => {
  test("onIngested submits to the pipeline; start/stop follow the worker lifecycle; threshold from config", async () => {
    const db = openDatabase(":memory:");
    const accounts = [{
      id: "a", label: "a", context: "ctx", host: "h", port: 993, tls: true, user: "u", password: "p",
      mailbox: "INBOX", spam_threshold: 0.8, enabled: true,
    }] as never[];
    syncAccounts(db, accounts);
    const { emailId } = ingestMail(db, { accountId: "a", meta, loc: { folder: "INBOX", uid: 7, uidValidity: 1 }, now: T0, traceId: "t" });
    const calls: string[] = [];
    let captured: ((id: number, i: TransientInput) => void | Promise<void>) | undefined;
    const states: unknown[] = [];
    const w = createWorkersWithPipeline({ db, accounts }, {
      env: { OPENROUTER_API_KEY: "test-key" },
      createJev: () => ({ classify: async (i) => { states.push(i.state); return okWith(fixture().answers); } }),
      createWorkers: (d) => {
        captured = d.onIngested;
        return { start: () => { calls.push("start"); }, stop: async () => { calls.push("stop"); } };
      },
    });
    w.start();
    await captured!(emailId, input);
    assert.equal(count(db, "SELECT COUNT(*) n FROM classifications WHERE status = 'classified'"), 1);
    assert.match(JSON.stringify(states[0]), /ctx/);
    const sh = db.prepare("SELECT answer_json FROM classification_answers WHERE question_key = 'shadow_quarantine'").get() as { answer_json: string };
    assert.equal(JSON.parse(sh.answer_json).applied_threshold, 0.8);
    await w.stop();
    assert.deepEqual(calls, ["start", "stop"]);
  });

  test("without OPENROUTER_API_KEY workers run without classification", () => {
    const db = openDatabase(":memory:");
    let captured: unknown = "unset";
    createWorkersWithPipeline({ db, accounts: [] }, {
      env: {}, createWorkers: (d) => { captured = d.onIngested; return { start() {}, async stop() {} }; },
    });
    assert.equal(captured, undefined);
  });
});
