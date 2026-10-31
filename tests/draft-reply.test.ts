import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../lib/db.ts";
import { syncAccounts } from "../lib/accounts.ts";
import { draftReply, type DraftAgent } from "../lib/draft-reply.ts";
import type { ImapPort } from "../lib/imap.ts";
import type { NormalizedAnswer, NoulReading } from "../lib/jev-response.ts";

const T = "2026-10-26T10:00:00.000Z";
const byValue = (a: NormalizedAnswer): NoulReading => ((a.value as number) >= 0.5 ? "positive" : "negative");
const EXCERPT_MARKER = "EXCERPT-MARKER-7f3a";
const DRAFT_MARKER = "DRAFT-MARKER-9c1d";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "draft-reply-"));
  chmodSync(dir, 0o700);
  const db = openDatabase(join(dir, "t.sqlite"));
  syncAccounts(db, [
    { id: "a1", label: "L", host: "imap.example", port: 993, mailbox: "INBOX", spam_mailbox: "Junk", enabled: true },
  ] as never);
  let cls = 0;
  const mail = (id: number, a: Record<string, number | string>) => {
    db.prepare("INSERT INTO emails (id, account_id, message_id, sender, subject, received_at, first_seen_at) VALUES (?,?,?,?,?,?,?)")
      .run(id, "a1", `m${id}`, "Person@Mail.Example.test", `Synthetic subject ${id}`, T, T);
    db.prepare("INSERT INTO email_locations (email_id, account_id, folder, uid_validity, uid, is_active, first_seen_at, last_seen_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(id, "a1", "INBOX", 1, 100 + id, 1, T, T);
    const c = ++cls;
    db.prepare("INSERT INTO classifications (id, email_id, question_set_version, model_requested, model_reported, status, failure_code, attempts, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(c, id, "v1", "typesafe/jev-1.13", "typesafe/jev-1.13", "classified", null, 1, T, T);
    const ins = db.prepare("INSERT INTO classification_answers (classification_id, question_key, type, answer_json) VALUES (?,?,?,?)");
    for (const [k, v] of Object.entries(a)) ins.run(c, k, typeof v === "number" ? "noul" : "choice", JSON.stringify({ value: v }));
  };
  const ok = { addresses_an_ai: 0.02, is_assessable: 0.9, needs_my_reply: 0.8, category: "business" };
  mail(1, ok);                                       // eligible
  mail(2, { ...ok, category: "security_auth" });     // blocked
  mail(3, { ...ok, addresses_an_ai: 0.97 });         // blocked
  return { db, dir };
}

function fakePort(opts: { throws?: boolean } = {}) {
  const calls: string[] = [];
  const port = {
    connect: async () => { calls.push("connect"); },
    close: async () => { calls.push("close"); },
    fetchMessageByUid: async (_f: string, uid: number) => {
      calls.push("fetch");
      if (opts.throws) throw new Error("host imap.secret.example said no");
      return { uid, source: Buffer.from(`From: a@b.test\r\nSubject: s\r\n\r\n${EXCERPT_MARKER} Bitte um Rückmeldung.\r\n`) };
    },
  } as unknown as ImapPort;
  return { port, calls };
}

const GOOD = { draft: `Guten Tag ${DRAFT_MARKER}`, language: "de", tone: "formal", needs_human_check: false, reasons: [] };

function fakeAgent(data: unknown = GOOD, usage = { promptTokens: 120, completionTokens: 40, totalTokens: 160 }) {
  const inputs: string[] = [];
  const agent: DraftAgent = {
    generate: async ({ input }) => { inputs.push(input); return { data, usage }; },
  };
  return { agent, inputs };
}

function dump(db: ReturnType<typeof openDatabase>): string {
  const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
  return names.map((n) => JSON.stringify(db.prepare(`SELECT * FROM "${n}"`).all())).join("\n");
}

test("blocked mails never reach the agent or the IMAP port (H11)", async () => {
  const { db, dir } = setup();
  try {
    for (const id of [2, 3]) {
      const { agent, inputs } = fakeAgent();
      const { port, calls } = fakePort();
      const r = await draftReply({ db, userId: 1, portFactory: () => port, agent, interpret: byValue }, id);
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.code, "not_eligible");
      assert.deepEqual(inputs, []);
      assert.deepEqual(calls, []);
    }
    const { agent, inputs } = fakeAgent();
    const r = await draftReply({ db, userId: 1, portFactory: () => fakePort().port, agent, interpret: byValue }, 99);
    assert.deepEqual(r, { ok: false, code: "email_not_found" });
    assert.deepEqual(inputs, []);
    // default interpreter is fail-closed (unmapped)
    const d = await draftReply({ db, userId: 1, portFactory: () => fakePort().port, agent }, 1);
    assert.equal(d.ok, false);
    assert.deepEqual(inputs, []);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("IMAP failure yields a fixed code without details", async () => {
  const { db, dir } = setup();
  try {
    const { agent, inputs } = fakeAgent();
    const r = await draftReply({ db, userId: 1, portFactory: () => fakePort({ throws: true }).port, agent, interpret: byValue }, 1);
    assert.deepEqual(r, { ok: false, code: "fetch_failed" });
    assert.deepEqual(inputs, []);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("success returns the schema object, passes the fenced input and the abort signal", async () => {
  const { db, dir } = setup();
  try {
    const seen: { input: string; abortSignal?: AbortSignal }[] = [];
    const agent: DraftAgent = {
      generate: async (a) => { seen.push(a); return { data: GOOD, usage: { promptTokens: 120, completionTokens: 40, totalTokens: 160 } }; },
    };
    const ac = new AbortController();
    const r = await draftReply({ db, userId: 1, portFactory: () => fakePort().port, agent, interpret: byValue }, 1, ac.signal);
    assert.ok(r.ok);
    if (r.ok) {
      assert.deepEqual(r.draft, GOOD);
      assert.equal(r.model, "openai/openai/gpt-6-luna");
      assert.equal(typeof r.latency_ms, "number");
    }
    assert.equal(seen.length, 1);
    assert.equal(seen[0].abortSignal, ac.signal);
    assert.match(seen[0].input, /<untrusted_email_excerpt>/);
    assert.match(seen[0].input, new RegExp(EXCERPT_MARKER));
    assert.match(seen[0].input, /email_id: 1/);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("invalid agent output and agent errors give fixed codes", async () => {
  const { db, dir } = setup();
  try {
    for (const bad of [null,{ draft: "x" }, { ...GOOD, language: "fr" }, { ...GOOD, reasons: [1] }, "text"]) {
      const { agent } = fakeAgent(bad);
      const r = await draftReply({ db, userId: 1, portFactory: () => fakePort().port, agent, interpret: byValue }, 1);
      assert.deepEqual(r, { ok: false, code: "invalid_output" });
    }
    const failing: DraftAgent = { generate: async () => { throw new Error(`provider said ${EXCERPT_MARKER}`); } };
    const r = await draftReply({ db, userId: 1, portFactory: () => fakePort().port, agent: failing, interpret: byValue }, 1);
    assert.deepEqual(r, { ok: false, code: "agent_failed" });
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'draft_generated'").get()?.c, 0);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("audit draft_generated holds only ids, model, latency and tokens (D17)", async () => {
  const { db, dir } = setup();
  try {
    const { agent } = fakeAgent();
    const r = await draftReply({ db, userId: 1, portFactory: () => fakePort().port, agent, interpret: byValue, traceId: "trace-1" }, 1);
    assert.ok(r.ok);
    const rows = db.prepare("SELECT actor, action, account_id, email_id, trace_id, details_json FROM audit_log WHERE action = 'draft_generated'").all() as
      { actor: string; account_id: string; email_id: number; trace_id: string; details_json: string }[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actor, "system");
    assert.equal(rows[0].account_id, "a1");
    assert.equal(rows[0].email_id, 1);
    assert.equal(rows[0].trace_id, "trace-1");
    const details = JSON.parse(rows[0].details_json) as Record<string, unknown>;
    assert.deepEqual(Object.keys(details).sort(), ["completion_tokens", "latency_ms", "model", "prompt_tokens", "total_tokens"]);
    assert.equal(details.model, "openai/openai/gpt-6-luna");
    assert.equal(details.prompt_tokens, 120);
    assert.equal(details.completion_tokens, 40);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("H12: neither draft nor excerpt marker reaches any table or any log output", async () => {
  const { db, dir } = setup();
  const out: string[] = [];
  const so = process.stdout.write, se = process.stderr.write;
  process.stdout.write = ((c: unknown) => { out.push(String(c)); return true; }) as never;
  process.stderr.write = ((c: unknown) => { out.push(String(c)); return true; }) as never;
  try {
    const { agent } = fakeAgent();
    const r = await draftReply({ db, userId: 1, portFactory: () => fakePort().port, agent, interpret: byValue }, 1);
    const failing: DraftAgent = { generate: async () => { throw new Error(`${DRAFT_MARKER} ${EXCERPT_MARKER}`); } };
    await draftReply({ db, userId: 1, portFactory: () => fakePort().port, agent: failing, interpret: byValue }, 1);
    assert.ok(r.ok);
  } finally {
    process.stdout.write = so;
    process.stderr.write = se;
  }
  try {
    const all = dump(db) + out.join("");
    assert.equal(all.includes(DRAFT_MARKER), false, "draft marker");
    assert.equal(all.includes(EXCERPT_MARKER), false, "excerpt marker");
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
