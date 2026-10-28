import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../lib/db.ts";
import { syncAccounts } from "../lib/accounts.ts";
import { CSRF_HEADER } from "../lib/csrf.ts";
import { createAuthContext, createLoginLimiter, createMutationLimiter, guardRequest, handleLogin, handleSession } from "../lib/auth-runtime.ts";
import {
  handleFeedbackGet, handleFeedbackPost, handleHitlDismiss, handleHitlList, handleRuleDeactivate, handleRulesCreate, handleRulesList,
  type ApiDeps,
} from "../lib/senders-api.ts";
import { recordSenderMail } from "../lib/senders.ts";
import * as feedbackRoute from "../app/api/emails/[id]/feedback/route.ts";
import * as hitlRoute from "../app/api/senders/hitl/route.ts";
import * as dismissRoute from "../app/api/senders/hitl/dismiss/route.ts";
import * as rulesRoute from "../app/api/senders/rules/route.ts";
import * as deactivateRoute from "../app/api/senders/rules/[id]/deactivate/route.ts";

const ME = "nico@example.test";
const HOST = "mac.tail.ts.net";
const ORIGIN = `https://${HOST}`;
const T = "2026-10-27T10:00:00.000Z";
const root = join(import.meta.dirname, "..");

function setup(opts: { limit?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "senders-api-"));
  chmodSync(dir, 0o700);
  mkdirSync(join(dir, "data"), { mode: 0o700 });
  writeFileSync(join(dir, "data", "auth-allowlist.json"), JSON.stringify({ logins: [ME] }));
  const auth = createAuthContext({ dataDir: join(dir, "data"), synthetic: false });
  const db = openDatabase(":memory:");
  syncAccounts(db, [{
    id: "a1", label: "A", context: "c", host: "imap.secret.example", port: 993, tls: true, user: "u", password: "p",
    mailbox: "INBOX", spam_threshold: 0.9, enabled: true,
  } as never]);
  db.prepare("INSERT INTO emails (id, account_id, message_id, sender, subject, received_at, first_seen_at) VALUES (1,'a1','<m1>','s@x.example','SUBJECT-MARKER',?,?)").run(T, T);
  recordSenderMail(db, "s@x.example", "pass", T);
  const unclosable = { prepare: db.prepare.bind(db), exec: db.exec.bind(db), close() {} } as unknown as DatabaseSync;
  const deps: ApiDeps = { auth, limiter: createMutationLimiter(undefined, opts.limit), openDb: () => unclosable, now: () => new Date(T) };
  return { auth, db, deps };
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
const good = (s: { cookie: string; csrf: string }) => ({ cookie: s.cookie, origin: ORIGIN, "sec-fetch-site": "same-origin", [CSRF_HEADER]: s.csrf, "content-type": "application/json" });
const post = (path: string, headers: Record<string, string>, body?: unknown) =>
  new Request(`http://127.0.0.1:3000${path}`, {
    method: "POST", headers: { host: HOST, ...headers },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
const rows = (db: DatabaseSync, sql: string) => db.prepare(sql).all().map((r) => ({ ...r }));

type Call = (t: ReturnType<typeof setup>, headers: Record<string, string>) => Promise<Response>;
const MUTATIONS: [string, string, Call][] = [
  ["feedback", "/api/emails/1/feedback", (t, h) => handleFeedbackPost(post("/api/emails/1/feedback", h, { kind: "spam_correct" }), "1", t.deps)],
  ["rules create", "/api/senders/rules", (t, h) => handleRulesCreate(post("/api/senders/rules", h, { match: "domain", value: "x.example", kind: "blacklist" }), t.deps)],
  ["rule deactivate", "/api/senders/rules/1/deactivate", (t, h) => handleRuleDeactivate(post("/api/senders/rules/1/deactivate", h), "1", t.deps)],
  ["hitl dismiss", "/api/senders/hitl/dismiss", (t, h) => handleHitlDismiss(post("/api/senders/hitl/dismiss", h, { match: "address", value: "s@x.example" }), t.deps)],
];
const writes = (db: DatabaseSync) =>
  (db.prepare("SELECT (SELECT COUNT(*) FROM feedback) + (SELECT COUNT(*) FROM sender_rules) AS n").get() as { n: number }).n;

describe("H13: session first, then rate limit, then CSRF", () => {
  test("without a session every POST is 401 and nothing is written (also through the middleware guard)", async () => {
    const t = setup();
    for (const [name, path, call] of MUTATIONS) {
      assert.equal((await call(t, {})).status, 401, name);
      assert.equal((await call(t, { ...tailnet, origin: ORIGIN, [CSRF_HEADER]: "x.y" })).status, 401, `${name} with identity header only`);
      assert.equal(guardRequest(post(path, {}), t.auth)?.status, 401, `${name} middleware`);
    }
    assert.equal(writes(t.db), 0);
  });

  test("the GET routes are behind the session guard too", () => {
    const t = setup();
    for (const path of ["/api/senders/rules", "/api/senders/hitl", "/api/emails/1/feedback"]) {
      assert.equal(guardRequest(new Request(`http://127.0.0.1:3000${path}`, { headers: { host: HOST } }), t.auth)?.status, 401, path);
    }
  });

  test("a session without a valid CSRF proof is 403 and nothing is written", async () => {
    const t = setup();
    const s = await signIn(t.auth);
    const h = good(s);
    const variants: Record<string, string>[] = [
      { cookie: s.cookie }, { ...h, [CSRF_HEADER]: "bad" }, { ...h, origin: "https://evil.example" }, { ...h, "sec-fetch-site": "cross-site" },
    ];
    for (const [name, , call] of MUTATIONS) for (const v of variants) assert.equal((await call(t, v)).status, 403, name);
    assert.equal(writes(t.db), 0);
  });

  test("rate limit per identity: 429 with retry-after", async () => {
    const t = setup({ limit: 2 });
    const s = await signIn(t.auth);
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await MUTATIONS[0][2](t, good(s))).status);
    assert.deepEqual(codes, [200, 200, 429, 429]);
    assert.ok(Number((await MUTATIONS[0][2](t, good(s))).headers.get("retry-after")) >= 1);
  });

  test("the route modules export the expected methods and answer 401 with the default wiring", async () => {
    assert.deepEqual(Object.keys(feedbackRoute).sort(), ["GET", "POST"]);
    assert.deepEqual(Object.keys(rulesRoute).sort(), ["GET", "POST"]);
    assert.deepEqual(Object.keys(hitlRoute), ["GET"]);
    assert.deepEqual(Object.keys(dismissRoute), ["POST"]);
    assert.deepEqual(Object.keys(deactivateRoute), ["POST"]);
    const req = (p: string) => new Request(`http://127.0.0.1:3000${p}`, { method: "POST" });
    assert.equal((await feedbackRoute.POST(req("/api/emails/1/feedback"), { params: { id: "1" } })).status, 401);
    assert.equal((await rulesRoute.POST(req("/api/senders/rules"))).status, 401);
    assert.equal((await dismissRoute.POST(req("/api/senders/hitl/dismiss"))).status, 401);
    assert.equal((await deactivateRoute.POST(req("/api/senders/rules/1/deactivate"), { params: Promise.resolve({ id: "1" }) })).status, 401);
  });
});

describe("POST /api/emails/:id/feedback", () => {
  test("stores the feedback, counts the sender, answers with the current state", async () => {
    const t = setup();
    const s = await signIn(t.auth);
    const res = await handleFeedbackPost(post("/api/emails/1/feedback", good(s), { kind: "spam_correct" }), "1", t.deps);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, id: 1, kind: "spam_correct", changed: true, feedback: { spam: "spam_correct", reply: null, category: null } });
    assert.deepEqual(rows(t.db, "SELECT marked_spam, marked_not_spam FROM senders"), [{ marked_spam: 1, marked_not_spam: 0 }]);
    const again = await handleFeedbackPost(post("/api/emails/1/feedback", good(s), { kind: "spam_correct" }), "1", t.deps);
    assert.equal((await again.json() as { changed: boolean }).changed, false);
    const cat = await handleFeedbackPost(post("/api/emails/1/feedback", good(s), { kind: "category_wrong", value: "business" }), "1", t.deps);
    assert.equal(cat.status, 200);
    assert.equal(((await cat.json()) as { feedback: { category: string } }).feedback.category, "business");
    const get = handleFeedbackGet("1", t.deps);
    assert.deepEqual(await get.json(), { id: 1, feedback: { spam: "spam_correct", reply: null, category: "business" } });
  });

  test("bad input: 400 for body/kind/value, 404 for unknown or malformed ids; nothing written", async () => {
    const t = setup();
    const s = await signIn(t.auth);
    const send = (id: unknown, body: unknown) => handleFeedbackPost(post("/api/emails/x/feedback", good(s), body), id, t.deps);
    for (const body of [undefined, "", "{nope", "[]", "null", {}, { kind: "always_spam" }, { kind: "category_wrong" }, { kind: "category_wrong", value: "nonsense" },
      { kind: "not_spam", value: "business" }, { kind: "not_spam", extra: 1 }, { kind: 5 }, "x".repeat(3000)]) {
      const res = await send("1", body);
      assert.equal(res.status, 400, JSON.stringify(body)?.slice(0, 40));
    }
    for (const id of ["2", "0", "-1", "abc", undefined]) assert.equal((await send(id, { kind: "not_spam" })).status, 404, String(id));
    assert.equal(writes(t.db), 0);
    assert.equal(handleFeedbackGet("2", t.deps).status, 404);
  });
});

describe("sender rules over HTTP", () => {
  test("create, list, replace by the opposite kind, deactivate", async () => {
    const t = setup();
    const s = await signIn(t.auth);
    const make = (body: unknown) => handleRulesCreate(post("/api/senders/rules", good(s), body), t.deps);
    const created = await make({ match: "domain", value: "Junk.Example", kind: "blacklist" });
    assert.equal(created.status, 200);
    const body = (await created.json()) as { ok: boolean; rule: Record<string, unknown>; changed: boolean };
    assert.deepEqual(body.rule, { id: 1, kind: "blacklist", match: "domain", value: "junk.example", account_id: null, source: "nico", active: 1, created_at: T });
    const list = (await handleRulesList(new Request("http://x/api/senders/rules"), t.deps).json()) as { rules: unknown[] };
    assert.equal(list.rules.length, 1);
    const flip = (await (await make({ match: "domain", value: "junk.example", kind: "allowlist" })).json()) as { deactivated_rule_ids: number[] };
    assert.deepEqual(flip.deactivated_rule_ids, [1]);
    const all = (await handleRulesList(new Request("http://x/api/senders/rules?include_inactive=1"), t.deps).json()) as { rules: { active: number }[] };
    assert.deepEqual(all.rules.map((r) => r.active), [0, 1]);
    const off = await handleRuleDeactivate(post("/api/senders/rules/2/deactivate", good(s)), "2", t.deps);
    assert.equal(off.status, 200);
    assert.equal(((await off.json()) as { rule: { active: number } }).rule.active, 0);
    assert.equal((await handleRuleDeactivate(post("/api/senders/rules/99/deactivate", good(s)), "99", t.deps)).status, 404);
    assert.equal((await handleRuleDeactivate(post("/api/senders/rules/abc/deactivate", good(s)), "abc", t.deps)).status, 404);
    assert.equal(((await handleRulesList(new Request("http://x/api/senders/rules"), t.deps).json()) as { rules: unknown[] }).rules.length, 0);
  });

  test("validation: freemail domains, bad values, unknown account, unknown fields", async () => {
    const t = setup();
    const s = await signIn(t.auth);
    const make = async (body: unknown) => {
      const res = await handleRulesCreate(post("/api/senders/rules", good(s), body), t.deps);
      return [res.status, ((await res.json()) as { error?: string }).error] as const;
    };
    assert.deepEqual(await make({ match: "domain", value: "gmail.com", kind: "blacklist" }), [400, "freemail_domain"]);
    assert.deepEqual(await make({ match: "domain", value: "nodot", kind: "blacklist" }), [400, "invalid_value"]);
    assert.deepEqual(await make({ match: "address", value: "nobody", kind: "allowlist" }), [400, "invalid_value"]);
    assert.deepEqual(await make({ match: "address", value: "a@x.example", kind: "allowlist", account_id: "zzz" }), [400, "unknown_account"]);
    assert.deepEqual(await make({ match: "host", value: "x.example", kind: "allowlist" }), [400, "invalid_body"]);
    assert.deepEqual(await make({ match: "domain", value: "x.example", kind: "greylist" }), [400, "invalid_body"]);
    assert.deepEqual(await make({ match: "domain", value: "x.example", kind: "blacklist", source: "agent" }), [400, "invalid_body"]);
    assert.deepEqual(await make("{nope"), [400, "invalid_body"]);
    assert.equal(writes(t.db), 0);
    assert.deepEqual(await make({ match: "address", value: "a@x.example", kind: "allowlist", account_id: "a1" }), [200, undefined]);
  });
});

describe("HITL over HTTP", () => {
  test("lists candidates and dismisses one", async () => {
    const t = setup();
    const s = await signIn(t.auth);
    t.db.prepare("UPDATE senders SET jev_spam_count = 3, mails_seen = 4, dmarc_pass = 2").run();
    const list = (await handleHitlList(t.deps).json()) as { candidates: Record<string, unknown>[] };
    assert.deepEqual(list.candidates, [{
      key: "address:s@x.example", match: "address", value: "s@x.example", jev_spam_count: 3, mails_seen: 4, dmarc_pass_rate: 0.5, sample_email_ids: [],
    }]);
    const bad = await handleHitlDismiss(post("/api/senders/hitl/dismiss", good(s), { match: "address", value: "nobody@x.example" }), t.deps);
    assert.equal(bad.status, 404);
    const ok = await handleHitlDismiss(post("/api/senders/hitl/dismiss", good(s), { match: "address", value: "S@x.example" }), t.deps);
    assert.deepEqual(await ok.json(), { ok: true, changed: true });
    assert.deepEqual(((await handleHitlList(t.deps).json()) as { candidates: unknown[] }).candidates, []);
    assert.equal((await handleHitlDismiss(post("/api/senders/hitl/dismiss", good(s), { match: "address", value: "bad" }), t.deps)).status, 400);
  });

  test("responses carry no subject, host or user", async () => {
    const t = setup();
    const s = await signIn(t.auth);
    t.db.prepare("UPDATE senders SET jev_spam_count = 3").run();
    const texts = [
      await handleHitlList(t.deps).text(),
      await (await handleFeedbackPost(post("/api/emails/1/feedback", good(s), { kind: "spam_correct" }), "1", t.deps)).text(),
      await handleRulesList(new Request("http://x/api/senders/rules"), t.deps).text(),
    ];
    for (const text of texts) for (const secret of ["SUBJECT-MARKER", "imap.secret.example", "set-cookie"]) assert.ok(!text.includes(secret), secret);
  });
});

describe("no mailbox access (H2)", () => {
  test("the new routes and libraries import no IMAP code, workers or write-capable modules", () => {
    const files = [
      "app/api/emails/[id]/feedback/route.ts", "app/api/senders/hitl/route.ts", "app/api/senders/hitl/dismiss/route.ts",
      "app/api/senders/rules/route.ts", "app/api/senders/rules/[id]/deactivate/route.ts",
      "lib/senders-api.ts", "lib/feedback.ts", "lib/sender-rules.ts", "lib/sender-hitl.ts", "lib/senders.ts",
    ];
    for (const f of files) {
      const src = readFileSync(join(root, f), "utf8");
      const imports = [...src.matchAll(/^import (?!type )[^;]*? from "([^"]+)"/gm)].map((m) => m[1]);
      for (const i of imports) assert.doesNotMatch(i, /imap|workers|ingest|mailparser|mailbox-actions/i, `${f} imports ${i}`);
    }
  });
});
