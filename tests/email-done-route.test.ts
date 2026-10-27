import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../lib/db.ts";
import { syncAccounts } from "../lib/accounts.ts";
import { CSRF_HEADER } from "../lib/csrf.ts";
import {
  createAuthContext, createLoginLimiter, createMutationLimiter, guardRequest, handleLogin, handleSession,
} from "../lib/auth-runtime.ts";
import { handleSetDone } from "../lib/email-done.ts";
import { readEmailStatus, upsertSeen } from "../lib/email-status.ts";
import * as doneRoute from "../app/api/emails/[id]/done/route.ts";
import * as undoneRoute from "../app/api/emails/[id]/undone/route.ts";

const ME = "nico@example.test";
const HOST = "mac.tail.ts.net";
const ORIGIN = `https://${HOST}`;
const T = "2026-10-27T10:00:00.000Z";
const root = join(import.meta.dirname, "..");

function setup(opts: { limit?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "done-"));
  chmodSync(dir, 0o700);
  mkdirSync(join(dir, "data"), { mode: 0o700 });
  writeFileSync(join(dir, "data", "auth-allowlist.json"), JSON.stringify({ logins: [ME] }));
  const auth = createAuthContext({ dataDir: join(dir, "data"), synthetic: false });
  const db = openDatabase(":memory:");
  syncAccounts(db, [{
    id: "a1", label: "A", context: "c", host: "imap.secret.example", port: 993, tls: true, user: "u", password: "p",
    mailbox: "INBOX", spam_threshold: 0.9, enabled: true,
  } as never]);
  db.prepare("INSERT INTO emails (id, account_id, message_id, sender, subject, received_at, first_seen_at) VALUES (1,'a1','<m1>','s@x.example','subj',?,?)").run(T, T);
  const limiter = createMutationLimiter(undefined, opts.limit);
  // The handler closes what it opens; the test keeps the in-memory database alive for its assertions.
  const unclosable = { prepare: db.prepare.bind(db), exec: db.exec.bind(db), close() {} } as unknown as DatabaseSync;
  const deps = { auth, limiter, openDb: () => unclosable, now: () => new Date(T) };
  return { dir, auth, db, deps, limiter };
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
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  assert.equal(res.status, 200);
  return { cookie, csrf: info.csrfToken };
}
const post = (path: string, headers: Record<string, string>) =>
  new Request(`http://127.0.0.1:3000${path}`, { method: "POST", headers: { host: HOST, ...headers } });
const good = (s: { cookie: string; csrf: string }) => ({ cookie: s.cookie, origin: ORIGIN, "sec-fetch-site": "same-origin", [CSRF_HEADER]: s.csrf });
const audits = (db: DatabaseSync) => db.prepare("SELECT actor, action, account_id, email_id, details_json FROM audit_log WHERE action LIKE 'email_%'").all().map((r) => ({ ...r }));

describe("H13: POST /api/emails/:id/done and /undone", () => {
  test("without a session: 401, nothing written", async () => {
    const t = setup();
    for (const [path, done] of [["/api/emails/1/done", true], ["/api/emails/1/undone", false]] as const) {
      const res = await handleSetDone(post(path, {}), "1", done, t.deps);
      assert.equal(res.status, 401, path);
      // even with the right-looking headers, an identity header alone is not a session
      const res2 = await handleSetDone(post(path, { ...tailnet, origin: ORIGIN, [CSRF_HEADER]: "x.y" }), "1", done, t.deps);
      assert.equal(res2.status, 401, path);
      assert.equal(guardRequest(post(path, {}), t.auth)?.status, 401, `${path} through the middleware guard`);
    }
    assert.equal(db_rows(t.db), 0);
    assert.equal(audits(t.db).length, 0);
  });

  test("session without a valid CSRF proof: 403, nothing written", async () => {
    const t = setup();
    const s = await signIn(t.auth);
    const h = good(s);
    const cases: Record<string, string>[] = [
      { cookie: s.cookie },
      { ...h, [CSRF_HEADER]: "bad" },
      { ...h, origin: "https://evil.example" },
      { ...h, "sec-fetch-site": "cross-site" },
    ];
    for (const headers of cases) assert.equal((await handleSetDone(post("/api/emails/1/done", headers), "1", true, t.deps)).status, 403);
    assert.equal(db_rows(t.db), 0);
  });

  test("the route modules export POST only and use the default wiring", async () => {
    for (const m of [doneRoute, undoneRoute]) {
      assert.deepEqual(Object.keys(m).sort(), ["POST"]);
    }
    const res = await doneRoute.POST(new Request("http://127.0.0.1:3000/api/emails/1/done", { method: "POST" }), { params: { id: "1" } });
    assert.equal(res.status, 401);
    const res2 = await undoneRoute.POST(new Request("http://127.0.0.1:3000/api/emails/1/undone", { method: "POST" }), { params: Promise.resolve({ id: "1" }) });
    assert.equal(res2.status, 401);
  });
});

function db_rows(db: DatabaseSync): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM email_status").get() as { n: number }).n;
}

describe("done and undone (app database only)", () => {
  test("done marks the mail, keeps the provider flag, audits ids only; repeating is a no-op without a second audit row", async () => {
    const t = setup();
    const s = await signIn(t.auth);
    upsertSeen(t.db, 1, true, T);
    const res = await handleSetDone(post("/api/emails/1/done", good(s)), "1", true, t.deps);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, id: 1, done: true, seen: true });
    assert.deepEqual(readEmailStatus(t.db, 1), { seen: true, done: true });
    assert.deepEqual(audits(t.db), [{ actor: "system", action: "email_done", account_id: "a1", email_id: 1, details_json: "{}" }]);
    const again = await handleSetDone(post("/api/emails/1/done", good(s)), "1", true, t.deps);
    assert.equal(again.status, 200);
    assert.equal(audits(t.db).length, 1);
  });

  test("undone reverses it, works for a mail that never had a row, and audits email_undone", async () => {
    const t = setup();
    const s = await signIn(t.auth);
    const never = await handleSetDone(post("/api/emails/1/undone", good(s)), "1", false, t.deps);
    assert.deepEqual(await never.json(), { ok: true, id: 1, done: false, seen: false });
    assert.equal(db_rows(t.db), 0, "undone on an untouched mail creates nothing");
    assert.equal(audits(t.db).length, 0);
    await handleSetDone(post("/api/emails/1/done", good(s)), "1", true, t.deps);
    const res = await handleSetDone(post("/api/emails/1/undone", good(s)), "1", false, t.deps);
    assert.deepEqual(await res.json(), { ok: true, id: 1, done: false, seen: false });
    assert.deepEqual(audits(t.db).map((a) => a.action), ["email_done", "email_undone"]);
  });

  test("unknown or malformed ids: 404 and nothing written", async () => {
    const t = setup();
    const s = await signIn(t.auth);
    for (const id of ["2", "0", "-1", "abc", "1.5", "1e3", "", " 1", "99999999999999999999", undefined]) {
      const res = await handleSetDone(post("/api/emails/x/done", good(s)), id, true, t.deps);
      assert.equal(res.status, 404, String(id));
      assert.deepEqual(await res.json(), { error: "not_found" });
    }
    assert.equal(db_rows(t.db), 0);
  });

  test("rate limit per identity: 429 with retry-after once the window is used up", async () => {
    const t = setup({ limit: 3 });
    const s = await signIn(t.auth);
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await handleSetDone(post("/api/emails/1/done", good(s)), "1", true, t.deps)).status);
    assert.deepEqual(codes, [200, 200, 200, 429, 429]);
    const limited = await handleSetDone(post("/api/emails/1/done", good(s)), "1", true, t.deps);
    assert.ok(Number(limited.headers.get("retry-after")) >= 1);
  });

  test("the response carries no body, subject, sender, host or user", async () => {
    const t = setup();
    const s = await signIn(t.auth);
    const res = await handleSetDone(post("/api/emails/1/done", good(s)), "1", true, t.deps);
    const text = await res.text();
    for (const secret of ["subj", "s@x.example", "imap.secret.example", "set-cookie"]) assert.ok(!text.includes(secret), secret);
  });
});

describe("done and undone never reach a mailbox (H2)", () => {
  test("neither the routes nor their library import IMAP code, workers or the write-capable modules", () => {
    for (const f of ["app/api/emails/[id]/done/route.ts", "app/api/emails/[id]/undone/route.ts", "lib/email-done.ts", "lib/email-status.ts"]) {
      const src = readFileSync(join(root, f), "utf8");
      const imports = [...src.matchAll(/^import (?!type )[^;]*? from "([^"]+)"/gm)].map((m) => m[1]);
      for (const i of imports) assert.doesNotMatch(i, /imap|workers|ingest|mailparser/i, `${f} imports ${i}`);
    }
  });
});
