// R2 API handlers (tailnet identity = owner). Synthetic data, a fake connector, no network.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { generateKey } from "../lib/account-secrets.ts";
import {
  handleAccountCreate, handleAccountEnabled, handleAccountsList, handleAccountTest, handleAccountUpdate, type AccountsApiDeps,
} from "../lib/accounts-api.ts";
import { createAuthContext, createLoginLimiter, createMutationLimiter, handleLogin, handleSession } from "../lib/auth-runtime.ts";
import type { TestConnector } from "../lib/connection-test.ts";
import { CSRF_HEADER } from "../lib/csrf.ts";
import { openDatabase } from "../lib/db.ts";

const ME = "nico@example.test";
const HOST = "mac.tail.ts.net";
const ORIGIN = `https://${HOST}`;
const PW = "synthetic-pw-for-api-test";
const NOW = new Date("2026-10-31T10:00:00.000Z");
const tailnet = { host: HOST, "tailscale-user-login": ME };

async function setup(o: { synthetic?: boolean; key?: string | null; connector?: TestConnector; testLimit?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "acc-api-"));
  chmodSync(dir, 0o700);
  mkdirSync(join(dir, "data"), { mode: 0o700 });
  writeFileSync(join(dir, "data", "auth-allowlist.json"), JSON.stringify({ logins: [ME] }));
  const synthetic = o.synthetic === true;
  const auth = createAuthContext({ dataDir: join(dir, "data"), synthetic });
  const db = openDatabase(":memory:");
  const unclosable = { prepare: db.prepare.bind(db), exec: db.exec.bind(db), close() {} } as unknown as DatabaseSync;
  const deps: AccountsApiDeps = {
    auth, limiter: createMutationLimiter(), testLimiter: createMutationLimiter(undefined, o.testLimit ?? 10), openDb: () => unclosable,
    env: o.key === null ? {} : { ACCOUNTS_ENCRYPTION_KEY: o.key ?? generateKey() }, now: () => NOW,
    ...(o.connector ? { connector: o.connector } : {}),
  };
  const headers = synthetic ? { host: "127.0.0.1:3000" } : tailnet;
  const info = (await (await handleSession(new Request("http://127.0.0.1:3000/api/auth/session", { headers }), auth)).json()) as { csrfToken: string };
  const origin = synthetic ? "http://127.0.0.1:3000" : ORIGIN;
  const res = handleLogin(new Request("http://127.0.0.1:3000/api/auth/login", { method: "POST", headers: { ...headers, origin, "sec-fetch-site": "same-origin", [CSRF_HEADER]: info.csrfToken } }), auth, createLoginLimiter());
  assert.equal(res.status, 200);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { db, deps, cookie, csrf: info.csrfToken, synthetic };
}
type S = Awaited<ReturnType<typeof setup>>;
const get = (s: S, path = "/api/accounts") => new Request(`http://127.0.0.1:3000${path}`, { headers: { ...(s.synthetic ? { host: "127.0.0.1:3000" } : { host: HOST }), cookie: s.cookie } });
const post = (s: S, path: string, body?: unknown) => new Request(`http://127.0.0.1:3000${path}`, {
  method: "POST", body: body === undefined ? undefined : JSON.stringify(body),
  headers: { host: s.synthetic ? "127.0.0.1:3000" : HOST, cookie: s.cookie, origin: s.synthetic ? "http://127.0.0.1:3000" : ORIGIN, "sec-fetch-site": "same-origin", [CSRF_HEADER]: s.csrf, "content-type": "application/json" },
});
const body = { type: "imap", label: "Privat", username: "me@example.test", password: PW, host: "imap.example.test", port: 993, tls: true, mailbox: "INBOX", spam_mailbox: "Junk" };
const fake = (outcome: "ok" | "auth" | "fail", calls: string[] = []): TestConnector => (cfg) => {
  calls.push(`${cfg.host}:${cfg.port}`);
  return {
    connect: async () => { if (outcome === "auth") throw Object.assign(new Error("x"), { authenticationFailed: true }); if (outcome === "fail") throw Object.assign(new Error("x"), { code: "ENOTFOUND" }); },
    listFolders: async () => [{ path: "INBOX" }, { path: "Junk" }],
    close: async () => {}, on: () => {},
  } as never;
};

describe("accounts API", () => {
  it("needs a session for every route", async () => {
    const s = await setup();
    const anon = (m: string) => new Request("http://127.0.0.1:3000/api/accounts", { method: m, headers: { host: HOST }, body: m === "POST" ? "{}" : undefined });
    assert.equal((await handleAccountCreate(anon("POST"), s.deps)).status, 401);
    assert.equal((await handleAccountUpdate(anon("POST"), "x", s.deps)).status, 401);
    assert.equal(handleAccountEnabled(anon("POST"), "x", false, s.deps).status, 401);
    assert.equal((await handleAccountTest(anon("POST"), "x", s.deps)).status, 401);
  });

  it("create, list, update, disable, enable; no response ever contains the password or ciphertext", async () => {
    const s = await setup();
    const empty = (await (await handleAccountsList(get(s), s.deps)).json()) as { accounts: unknown[]; encryption: { ready: boolean } };
    assert.deepEqual([empty.accounts.length, empty.encryption.ready], [0, true]);
    const created = await handleAccountCreate(post(s, "/api/accounts", body), s.deps);
    assert.equal(created.status, 201);
    const text = await created.text();
    const { account } = JSON.parse(text) as { account: { id: string; secret_set: boolean; secret_set_at: string; spam_seen_mode: string } };
    assert.match(account.id, /^a_[0-9a-f]{16}$/);
    assert.deepEqual([account.secret_set, account.secret_set_at, account.spam_seen_mode], [true, NOW.toISOString(), "off"]);
    const all: string[] = [text];
    const upd = await handleAccountUpdate(post(s, `/api/accounts/${account.id}`, { label: "Neu", context: "kurz" }), account.id, s.deps);
    assert.equal(upd.status, 200);
    all.push(await upd.text());
    for (const en of [false, true]) {
      const r = handleAccountEnabled(post(s, `/api/accounts/${account.id}/${en ? "enable" : "disable"}`), account.id, en, s.deps);
      assert.equal(r.status, 200);
      assert.equal(((await r.json()) as { account: { enabled: boolean } }).account.enabled, en);
    }
    all.push(await (await handleAccountsList(get(s), s.deps)).text());
    for (const t of all) {
      assert.ok(!t.includes(PW) && !/ciphertext|secret_nonce|secret_tag|ACCOUNTS_ENCRYPTION/.test(t), "no secret material");
    }
    assert.equal(s.db.prepare("SELECT label FROM accounts").get()!.label, "Neu");
  });

  it("validation: unknown fields, missing password, bad host, bad port, huge body", async () => {
    const s = await setup();
    const code = async (b: unknown) => { const r = await handleAccountCreate(post(s, "/api/accounts", b), s.deps); return [r.status, ((await r.json()) as { error: string }).error] as const; };
    assert.deepEqual(await code({ ...body, id: "chosen" }), [400, "invalid_body"]);
    assert.deepEqual(await code({ ...body, password: undefined }), [400, "invalid_body"]);
    assert.deepEqual(await code({ ...body, port: 70000 }), [400, "invalid_body"]);
    assert.deepEqual(await code({ ...body, color: "red" }), [400, "invalid_body"]);
    assert.deepEqual(await code({ ...body, host: "127.0.0.1" }), [400, "host_not_allowed"]);
    assert.deepEqual(await code({ ...body, host: "a b" }), [400, "invalid_host"]);
    assert.deepEqual(await code({ ...body, label: "x".repeat(41) }), [400, "invalid_body"]);
    assert.deepEqual(await code({ ...body, context: "x".repeat(1001) }), [400, "invalid_body"]);
    assert.deepEqual(await code({ ...body, context: "x".repeat(10000) }), [400, "invalid_body"]);
    assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM accounts").get()!.n, 0);
  });

  it("without ACCOUNTS_ENCRYPTION_KEY: list says not ready, create and secret changes are refused with no_encryption_key", async () => {
    const s = await setup({ key: null });
    assert.equal(((await (await handleAccountsList(get(s), s.deps)).json()) as { encryption: { ready: boolean } }).encryption.ready, false);
    const r = await handleAccountCreate(post(s, "/api/accounts", body), s.deps);
    assert.deepEqual([r.status, await r.json()], [503, { error: "no_encryption_key" }]);
    assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM accounts").get()!.n, 0);
  });

  it("connection test: ok / auth_failed / unreachable are recorded as a short code; the connector gets the stored settings", async () => {
    for (const [outcome, code] of [["ok", "ok"], ["auth", "auth_failed"], ["fail", "host_unreachable"]] as const) {
      const calls: string[] = [];
      const s = await setup({ connector: fake(outcome, calls) });
      const id = ((await (await handleAccountCreate(post(s, "/api/accounts", body), s.deps)).json()) as { account: { id: string } }).account.id;
      const r = await handleAccountTest(post(s, `/api/accounts/${id}/test`), id, s.deps);
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { ok: code === "ok", code });
      assert.deepEqual(calls, ["imap.example.test:993"]);
      const row = s.db.prepare("SELECT last_test_code, last_test_at FROM mail_accounts").get()!;
      assert.deepEqual([row.last_test_code, row.last_test_at], [code, NOW.toISOString()]);
    }
  });

  it("connection test detects the spam folder (\\Junk) when the account has none, stores it, and never overwrites a chosen one", async () => {
    const withJunk: TestConnector = () => ({
      connect: async () => {}, close: async () => {}, on: () => {},
      listFolders: async () => [{ path: "INBOX", specialUse: "\\Inbox" }, { path: "Spamordner", specialUse: "\\Junk" }, { path: "Junk" }],
    }) as never;
    const s = await setup({ connector: withJunk });
    const { spam_mailbox: _s, ...noSpam } = body;
    const id = ((await (await handleAccountCreate(post(s, "/api/accounts", noSpam), s.deps)).json()) as { account: { id: string; spam_mailbox: string | null } }).account.id;
    assert.equal(s.db.prepare("SELECT spam_mailbox FROM accounts WHERE id = ?").get(id)!.spam_mailbox, null);
    const r = await handleAccountTest(post(s, "/x"), id, s.deps);
    assert.deepEqual(await r.json(), { ok: true, code: "ok", spam_mailbox: "Spamordner" });
    assert.equal(s.db.prepare("SELECT spam_mailbox FROM accounts WHERE id = ?").get(id)!.spam_mailbox, "Spamordner");
    // a chosen folder is kept, and a second test reports nothing new
    s.db.prepare("UPDATE accounts SET spam_mailbox = 'Junk' WHERE id = ?").run(id);
    assert.deepEqual(await (await handleAccountTest(post(s, "/x"), id, s.deps)).json(), { ok: true, code: "ok" });
    assert.equal(s.db.prepare("SELECT spam_mailbox FROM accounts WHERE id = ?").get(id)!.spam_mailbox, "Junk");
  });

  it("connection test is rate limited and 404 for unknown ids; the connector is not touched then", async () => {
    const calls: string[] = [];
    const s = await setup({ connector: fake("ok", calls), testLimit: 2 });
    const id = ((await (await handleAccountCreate(post(s, "/api/accounts", body), s.deps)).json()) as { account: { id: string } }).account.id;
    assert.equal((await handleAccountTest(post(s, "/x"), "a_unknown", s.deps)).status, 404);
    assert.equal((await handleAccountTest(post(s, "/x"), id, s.deps)).status, 200);
    assert.equal((await handleAccountTest(post(s, "/x"), id, s.deps)).status, 200);
    const r = await handleAccountTest(post(s, "/x"), id, s.deps);
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get("retry-after")) > 0);
    assert.equal(calls.length, 2);
  });

  it("connection test without key: 503; with an unreadable secret: 409; demo account: 409 not_managed", async () => {
    const calls: string[] = [];
    const s = await setup({ connector: fake("ok", calls) });
    const id = ((await (await handleAccountCreate(post(s, "/api/accounts", body), s.deps)).json()) as { account: { id: string } }).account.id;
    s.db.prepare("UPDATE mail_accounts SET secret_tag = x'00000000000000000000000000000000'").run();
    const r = await handleAccountTest(post(s, "/x"), id, s.deps);
    assert.deepEqual([r.status, await r.json()], [409, { error: "secret_unreadable" }]);
    s.db.exec("INSERT INTO accounts (id,label,host,port,mailbox,user_id) VALUES ('demo','Demo','h.example',993,'INBOX',1)");
    const d = await handleAccountTest(post(s, "/x"), "demo", s.deps);
    assert.deepEqual([d.status, await d.json()], [409, { error: "not_managed" }]);
    const nokey = { ...s.deps, env: {} };
    const k = await handleAccountTest(post(s, "/x"), id, nokey);
    assert.equal(k.status, 503);
    assert.deepEqual(calls, []);
  });

  it("synthetic mode: accounts can be created, but the test answers synthetic_no_network without connecting", async () => {
    const calls: string[] = [];
    const s = await setup({ synthetic: true, connector: fake("ok", calls) });
    const c = await handleAccountCreate(post(s, "/api/accounts", { ...body, type: "google", host: undefined, port: undefined }), s.deps);
    assert.equal(c.status, 201);
    const id = ((await c.json()) as { account: { id: string } }).account.id;
    const r = await handleAccountTest(post(s, "/x"), id, s.deps);
    assert.deepEqual([r.status, await r.json()], [200, { ok: false, code: "synthetic_no_network" }]);
    assert.deepEqual(calls, []);
  });

  it("a request without CSRF headers is refused and changes nothing", async () => {
    const s = await setup();
    const r = await handleAccountCreate(new Request("http://127.0.0.1:3000/api/accounts", { method: "POST", body: JSON.stringify(body), headers: { host: HOST, cookie: s.cookie, "content-type": "application/json" } }), s.deps);
    assert.equal(r.status, 403);
    assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM accounts").get()!.n, 0);
  });
});
