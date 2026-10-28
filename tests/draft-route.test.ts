import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../lib/db.ts";
import { syncAccounts } from "../lib/accounts.ts";
import { CSRF_HEADER } from "../lib/csrf.ts";
import { createAuthContext, createLoginLimiter, createMutationLimiter, handleLogin, handleSession } from "../lib/auth-runtime.ts";
import { handleDraft } from "../lib/draft-route.ts";
import type { DraftAgent } from "../lib/draft-reply.ts";
import type { ImapPort } from "../lib/imap.ts";
import { getEmailDetail, listEmails } from "../lib/email-api.ts";
import * as draftRoute from "../app/api/emails/[id]/draft/route.ts";

const ME = "nico@example.test";
const HOST = "mac.tail.ts.net";
const ORIGIN = `https://${HOST}`;
const T = "2026-10-27T10:00:00.000Z";
const EXCERPT_MARKER = "EXCERPT-MARKER-5b2e";
const DRAFT_MARKER = "DRAFT-MARKER-c81f";
const GOOD = { draft: `Guten Tag ${DRAFT_MARKER}`, language: "de", tone: "formal", needs_human_check: true, reasons: ["Betrag genannt"] };

function setup(opts: { limit?: number; synthetic?: boolean; fetchThrows?: boolean; agentData?: unknown; agentThrows?: boolean; noAgent?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "draft-route-"));
  chmodSync(dir, 0o700);
  mkdirSync(join(dir, "data"), { mode: 0o700 });
  writeFileSync(join(dir, "data", "auth-allowlist.json"), JSON.stringify({ logins: [ME] }));
  const auth = createAuthContext({ dataDir: join(dir, "data"), synthetic: opts.synthetic ?? false });
  const db = openDatabase(":memory:");
  syncAccounts(db, [{ id: "a1", label: "L", host: "imap.secret.example", port: 993, mailbox: "INBOX", spam_mailbox: "Junk", enabled: true } as never]);
  let cls = 0;
  const mail = (id: number, a: Record<string, number | string>) => {
    db.prepare("INSERT INTO emails (id, account_id, message_id, sender, subject, received_at, first_seen_at) VALUES (?,?,?,?,?,?,?)")
      .run(id, "a1", `<m${id}>`, "person@mail.example.test", `Synthetic subject ${id}`, T, T);
    db.prepare("INSERT INTO email_locations (email_id, account_id, folder, uid_validity, uid, is_active, first_seen_at, last_seen_at) VALUES (?,?,?,?,?,1,?,?)")
      .run(id, "a1", "INBOX", 1, 100 + id, T, T);
    const c = ++cls;
    db.prepare("INSERT INTO classifications (id, email_id, question_set_version, model_requested, model_reported, status, attempts, created_at, updated_at) VALUES (?,?,?,?,?,'classified',1,?,?)")
      .run(c, id, "email-classification-v1", "m", "m", T, T);
    for (const [k, v] of Object.entries(a)) {
      db.prepare("INSERT INTO classification_answers (classification_id, question_key, type, answer_json) VALUES (?,?,?,?)")
        .run(c, k, typeof v === "number" ? "noul" : "choice", JSON.stringify({ value: v }));
    }
  };
  const ok = { addresses_an_ai: 0.02, is_assessable: 0.9, needs_my_reply: 0.8, category: "business" };
  mail(1, ok);
  mail(2, { ...ok, category: "security_auth" });
  mail(3, { ...ok, addresses_an_ai: 0.97 });

  const portCalls: string[] = [];
  const portFactory = (accountId: string): ImapPort => {
    portCalls.push(`factory:${accountId}`);
    return {
      connect: async () => { portCalls.push("connect"); },
      close: async () => { portCalls.push("close"); },
      fetchMessageByUid: async (_f: string, uid: number) => {
        portCalls.push("fetch");
        if (opts.fetchThrows) throw new Error("host imap.secret.example said no");
        return { uid, source: Buffer.from(`From: a@b.test\r\nSubject: s\r\n\r\n${EXCERPT_MARKER} Bitte um Rückmeldung.\r\n`) };
      },
    } as unknown as ImapPort;
  };
  const agentCalls: string[] = [];
  const agent: DraftAgent = {
    generate: async ({ input }) => {
      agentCalls.push(input);
      if (opts.agentThrows) throw new Error("provider echo: " + DRAFT_MARKER);
      return { data: opts.agentData ?? GOOD, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } };
    },
  };
  const unclosable = { prepare: db.prepare.bind(db), exec: db.exec.bind(db), close() {} } as unknown as DatabaseSync;
  let resolverCalls = 0;
  const deps = {
    auth,
    limiter: createMutationLimiter(undefined, opts.limit),
    openDb: () => unclosable,
    portFactory,
    agent: () => { resolverCalls++; return opts.noAgent ? undefined : agent; },
    now: () => new Date(T),
  };
  return { auth, db, deps, portCalls, agentCalls, resolverCalls: () => resolverCalls };
}

const tailnet = { host: HOST, "tailscale-user-login": ME };
async function signIn(auth: ReturnType<typeof setup>["auth"]) {
  const info = (await (await handleSession(new Request("http://127.0.0.1:3000/api/auth/session", { headers: tailnet }), auth)).json()) as { csrfToken: string };
  const res = handleLogin(
    new Request("http://127.0.0.1:3000/api/auth/login", {
      method: "POST", headers: { ...tailnet, origin: ORIGIN, "sec-fetch-site": "same-origin", [CSRF_HEADER]: info.csrfToken },
    }),
    auth, createLoginLimiter(),
  );
  assert.equal(res.status, 200);
  return { cookie: (res.headers.get("set-cookie") ?? "").split(";")[0], csrf: info.csrfToken };
}
const post = (id: number | string, headers: Record<string, string>) =>
  new Request(`http://127.0.0.1:3000/api/emails/${id}/draft`, { method: "POST", headers: { host: HOST, ...headers } });
const good = (s: { cookie: string; csrf: string }) => ({ cookie: s.cookie, origin: ORIGIN, "sec-fetch-site": "same-origin", [CSRF_HEADER]: s.csrf });
const draftAudits = (db: DatabaseSync) => db.prepare("SELECT actor, action, account_id, email_id, details_json FROM audit_log WHERE action = 'draft_generated'").all().map((r) => ({ ...r }));
const dump = (db: DatabaseSync): string => {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
  return tables.map((t) => JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all())).join("\n");
};

describe("H13: POST /api/emails/:id/draft", () => {
  test("without a session: 401; neither IMAP nor the agent is touched", async () => {
    const t = setup();
    for (const headers of [{}, { ...tailnet, origin: ORIGIN, [CSRF_HEADER]: "x.y" }]) {
      assert.equal((await handleDraft(post(1, headers), "1", t.deps)).status, 401);
    }
    assert.deepEqual(t.portCalls, []);
    assert.deepEqual(t.agentCalls, []);
    assert.equal(t.resolverCalls(), 0);
  });

  test("session without a valid CSRF proof: 403", async () => {
    const t = setup();
    const s = await signIn(t.auth);
    const h = good(s);
    for (const headers of [{ cookie: s.cookie }, { ...h, [CSRF_HEADER]: "bad" }, { ...h, origin: "https://evil.example" }, { ...h, "sec-fetch-site": "cross-site" }]) {
      assert.equal((await handleDraft(post(1, headers), "1", t.deps)).status, 403);
    }
    assert.deepEqual(t.portCalls, []);
    assert.deepEqual(t.agentCalls, []);
  });

  test("strict rate limit: 429 once the budget is used, before any IMAP or agent work", async () => {
    const t = setup({ limit: 2 });
    const s = await signIn(t.auth);
    assert.equal((await handleDraft(post(1, good(s)), "1", t.deps)).status, 200);
    assert.equal((await handleDraft(post(1, good(s)), "1", t.deps)).status, 200);
    const calls = t.agentCalls.length;
    const res = await handleDraft(post(1, good(s)), "1", t.deps);
    assert.equal(res.status, 429);
    assert.ok(res.headers.get("retry-after"));
    assert.equal(t.agentCalls.length, calls);
  });

  test("the route module exports POST only and uses the default wiring (401 without a session)", async () => {
    assert.deepEqual(Object.keys(draftRoute).sort(), ["POST"]);
    const res = await draftRoute.POST(new Request("http://127.0.0.1:3000/api/emails/1/draft", { method: "POST" }), { params: { id: "1" } });
    assert.equal(res.status, 401);
    const res2 = await draftRoute.POST(new Request("http://127.0.0.1:3000/api/emails/1/draft", { method: "POST" }), { params: Promise.resolve({ id: "1" }) });
    assert.equal(res2.status, 401);
  });
});

describe("synthetic mode", () => {
  test("not_available_in_synthetic: no mailbox, no agent", async () => {
    const t = setup({ synthetic: true });
    const local = "http://127.0.0.1:3000";
    const info = (await (await handleSession(new Request(`${local}/api/auth/session`, { headers: { host: "127.0.0.1:3000" } }), t.auth)).json()) as { csrfToken: string };
    const base = { host: "127.0.0.1:3000", origin: local, "sec-fetch-site": "same-origin", [CSRF_HEADER]: info.csrfToken };
    const login = handleLogin(new Request(`${local}/api/auth/login`, { method: "POST", headers: base }), t.auth, createLoginLimiter());
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
    const res = await handleDraft(new Request(`${local}/api/emails/1/draft`, { method: "POST", headers: { ...base, cookie } }), "1", t.deps);
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: "not_available_in_synthetic" });
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(t.portCalls, []);
    assert.equal(t.resolverCalls(), 0);
  });
});

describe("the draft", () => {
  test("eligible mail: exactly the contract fields, no-store; one audit row with numbers only", async () => {
    const t = setup();
    const s = await signIn(t.auth);
    const res = await handleDraft(post(1, good(s)), "1", t.deps);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(await res.json(), GOOD);
    assert.equal(t.agentCalls.length, 1);
    assert.match(t.agentCalls[0], /email_id: 1/);
    assert.deepEqual(draftAudits(t.db), [{
      actor: "system", action: "draft_generated", account_id: "a1", email_id: 1,
      details_json: JSON.stringify({ model: "openai/openai/gpt-6-luna", latency_ms: (JSON.parse(String(draftAudits(t.db)[0].details_json)) as { latency_ms: number }).latency_ms, prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }),
    }]);
  });

  test("H11: blocked mails answer not_eligible with the reasons; the mailbox and the agent are never touched", async () => {
    const t = setup();
    const s = await signIn(t.auth);
    const a = await handleDraft(post(2, good(s)), "2", t.deps);
    assert.equal(a.status, 409);
    assert.deepEqual(await a.json(), { error: "not_eligible", reasons: ["security_auth"] });
    const b = await handleDraft(post(3, good(s)), "3", t.deps);
    assert.equal(b.status, 409);
    assert.deepEqual(await b.json(), { error: "not_eligible", reasons: ["addresses_an_ai"] });
    assert.deepEqual(t.portCalls, []);
    assert.deepEqual(t.agentCalls, []);
    assert.equal(draftAudits(t.db).length, 0);
  });

  test("failures leave as codes only, with no provider or server text", async () => {
    const cases: { opts: Parameters<typeof setup>[0]; id: string; status: number; code: string }[] = [
      { opts: { fetchThrows: true }, id: "1", status: 502, code: "fetch_failed" },
      { opts: { agentThrows: true }, id: "1", status: 502, code: "agent_failed" },
      { opts: { agentData: { draft: "x" } }, id: "1", status: 502, code: "invalid_output" },
      { opts: { noAgent: true }, id: "1", status: 503, code: "agent_unavailable" },
      { opts: {}, id: "99", status: 404, code: "email_not_found" },
      { opts: {}, id: "abc", status: 404, code: "not_found" },
    ];
    for (const c of cases) {
      const t = setup(c.opts);
      const s = await signIn(t.auth);
      const res = await handleDraft(post(c.id, good(s)), c.id, t.deps);
      assert.equal(res.status, c.status, c.code);
      const raw = await res.text();
      assert.deepEqual(JSON.parse(raw), { error: c.code });
      assert.doesNotMatch(raw, /imap\.secret|provider echo|MARKER/);
      assert.equal(res.headers.get("cache-control"), "no-store");
    }
  });

  test("a throwing port factory is an error code, not a crash", async () => {
    const t = setup();
    t.deps.portFactory = () => { throw new Error("no such account /secret/path"); };
    const s = await signIn(t.auth);
    const res = await handleDraft(post(1, good(s)), "1", t.deps);
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: "fetch_failed" });
  });
});

describe("H12: the draft marker never reaches disk, logs or later requests", () => {
  test("database, console/stdout/stderr and the read API stay free of the draft and the excerpt", async () => {
    const t = setup();
    const s = await signIn(t.auth);
    const logged: string[] = [];
    const orig = {
      log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug,
      out: process.stdout.write.bind(process.stdout), err: process.stderr.write.bind(process.stderr),
    };
    const grab = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
    console.log = grab; console.info = grab; console.warn = grab; console.error = grab; console.debug = grab;
    process.stdout.write = ((c: unknown, ...rest: unknown[]) => { logged.push(String(c)); return (orig.out as (...a: unknown[]) => boolean)(c, ...rest); }) as typeof process.stdout.write;
    process.stderr.write = ((c: unknown, ...rest: unknown[]) => { logged.push(String(c)); return (orig.err as (...a: unknown[]) => boolean)(c, ...rest); }) as typeof process.stderr.write;
    let body: string;
    try {
      const res = await handleDraft(post(1, good(s)), "1", t.deps);
      body = await res.text();
    } finally {
      console.log = orig.log; console.info = orig.info; console.warn = orig.warn; console.error = orig.error; console.debug = orig.debug;
      process.stdout.write = orig.out; process.stderr.write = orig.err;
    }
    assert.match(body, new RegExp(DRAFT_MARKER), "the response itself carries the draft");

    for (const marker of [DRAFT_MARKER, EXCERPT_MARKER]) {
      assert.doesNotMatch(dump(t.db), new RegExp(marker), `database: ${marker}`);
      assert.equal(logged.join("\n").includes(marker), false, `logs: ${marker}`);
      // follow-up requests: the list and the detail of the same mail
      const list = JSON.stringify(listEmails(t.db, { view: "all", account: null, status: null, limit: 50, cursor: null }));
      const detail = JSON.stringify(getEmailDetail(t.db, 1));
      assert.equal(list.includes(marker), false, `GET /api/emails: ${marker}`);
      assert.equal(detail.includes(marker), false, `GET /api/emails/1: ${marker}`);
    }
  });
});
