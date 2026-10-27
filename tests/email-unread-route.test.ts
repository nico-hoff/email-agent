import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../lib/db.ts";
import { syncAccounts } from "../lib/accounts.ts";
import { CSRF_HEADER } from "../lib/csrf.ts";
import { createAuthContext, createLoginLimiter, createMutationLimiter, guardRequest, handleLogin, handleSession } from "../lib/auth-runtime.ts";
import { handleUnread } from "../lib/email-unread.ts";
import { ImapWriteError, type ImapWritePort } from "../lib/imap-write.ts";
import { createMailboxActions } from "../lib/mailbox-actions.ts";
import { upsertSeen } from "../lib/email-status.ts";
import type { AccountConfig } from "../lib/accounts-config.ts";
import * as unreadRoute from "../app/api/emails/[id]/unread/route.ts";

const ME = "nico@example.test";
const HOST = "mac.tail.ts.net";
const ORIGIN = `https://${HOST}`;
const T = "2026-10-27T10:00:00.000Z";

function setup(o: { mode?: "dry_run" | "live"; limit?: number; fail?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "unread-"));
  chmodSync(dir, 0o700);
  mkdirSync(join(dir, "data"), { mode: 0o700 });
  writeFileSync(join(dir, "data", "auth-allowlist.json"), JSON.stringify({ logins: [ME] }));
  const auth = createAuthContext({ dataDir: join(dir, "data"), synthetic: false });
  const accounts = [{
    id: "a1", label: "A", context: "c", host: "imap.secret.example", port: 993, tls: true, user: "u", password: "p",
    mailbox: "INBOX", spam_mailbox: "Junk", spam_threshold: 0.9, enabled: true, auto_actions: { spam_seen: o.mode ?? "dry_run" },
  }] as unknown as AccountConfig[];
  const db = openDatabase(":memory:");
  syncAccounts(db, accounts);
  db.prepare("INSERT INTO emails (id, account_id, message_id, sender, subject, received_at, first_seen_at) VALUES (1,'a1','<m1>','s@x.example','subj',?,?)").run(T, T);
  db.prepare("INSERT INTO email_locations (email_id, account_id, folder, uid_validity, uid, first_seen_at, last_seen_at) VALUES (1,'a1','INBOX',5,77,?,?)").run(T, T);
  upsertSeen(db, 1, true, T);
  const calls: string[] = [];
  const port: ImapWritePort = {
    async addSeen() { calls.push("addSeen"); },
    async removeSeen(folder, v, uid) {
      calls.push(`removeSeen ${folder} ${v} ${uid}`);
      if (o.fail) throw new ImapWriteError(o.fail as never);
    },
  };
  const killSwitchFile = join(dir, "data", "auto-actions.disabled");
  const unclosable = { prepare: db.prepare.bind(db), exec: db.exec.bind(db), close() {} } as unknown as DatabaseSync;
  const deps = {
    auth, limiter: createMutationLimiter(undefined, o.limit), openDb: () => unclosable, now: () => new Date(T),
    actions: (d: DatabaseSync) => createMailboxActions({ db: d, accounts, killSwitchFile, now: () => new Date(T), writePortFor: () => port }),
  };
  return { auth, db, deps, calls, killSwitchFile };
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
const post = (headers: Record<string, string>) => new Request("http://127.0.0.1:3000/api/emails/1/unread", { method: "POST", headers: { host: HOST, ...headers } });
const good = (s: { cookie: string; csrf: string }) => ({ cookie: s.cookie, origin: ORIGIN, "sec-fetch-site": "same-origin", [CSRF_HEADER]: s.csrf });
const actionRows = (db: DatabaseSync) => db.prepare("SELECT COUNT(*) AS n FROM mailbox_actions").get() as { n: number };

describe("H13: POST /api/emails/:id/unread", () => {
  test("without a session: 401, nothing written, no IMAP", async () => {
    const t = setup({ mode: "live" });
    const res = await handleUnread(post({}), "1", t.deps);
    assert.equal(res.status, 401);
    const res2 = await handleUnread(post({ ...tailnet, origin: ORIGIN, [CSRF_HEADER]: "x.y" }), "1", t.deps);
    assert.equal(res2.status, 401, "an identity header alone is not a session");
    assert.equal(guardRequest(post({}), t.auth)?.status, 401, "through the middleware guard");
    assert.equal(actionRows(t.db).n, 0);
    assert.deepEqual(t.calls, []);
    assert.equal((t.db.prepare("SELECT seen FROM email_status WHERE email_id = 1").get() as { seen: number }).seen, 1);
  });

  test("session without a valid CSRF proof: 403", async () => {
    const t = setup({ mode: "live" });
    const s = await signIn(t.auth);
    const h = good(s);
    for (const headers of [{ cookie: s.cookie }, { ...h, [CSRF_HEADER]: "bad" }, { ...h, origin: "https://evil.example" }, { ...h, "sec-fetch-site": "cross-site" }]) {
      assert.equal((await handleUnread(post(headers), "1", t.deps)).status, 403);
    }
    assert.deepEqual(t.calls, []);
  });

  test("the route module exports POST only and rejects an unauthenticated call", async () => {
    assert.deepEqual(Object.keys(unreadRoute).sort(), ["POST"]);
    const res = await unreadRoute.POST(new Request("http://127.0.0.1:3000/api/emails/1/unread", { method: "POST" }), { params: Promise.resolve({ id: "1" }) });
    assert.equal(res.status, 401);
  });

  test("rate limit per identity: 429 with retry-after", async () => {
    const t = setup({ limit: 2 });
    const s = await signIn(t.auth);
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await handleUnread(post(good(s)), "1", t.deps)).status);
    assert.deepEqual(codes, [200, 200, 429, 429]);
    assert.ok(Number((await handleUnread(post(good(s)), "1", t.deps)).headers.get("retry-after")) >= 1);
  });

  test("unknown or malformed ids: 404", async () => {
    const t = setup();
    const s = await signIn(t.auth);
    for (const id of ["2", "0", "-1", "abc", "1.5", "", undefined]) {
      const res = await handleUnread(post(good(s)), id, t.deps);
      assert.equal(res.status, 404, String(id));
      assert.deepEqual(await res.json(), { error: "not_found" });
    }
  });
});

describe("unread: dry run changes the app only, live account removes \\Seen", () => {
  test("dry_run account: app status only, no IMAP", async () => {
    const t = setup({ mode: "dry_run" });
    const s = await signIn(t.auth);
    const res = await handleUnread(post(good(s)), "1", t.deps);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, id: 1, mode: "dry_run", seen: false });
    assert.equal((t.db.prepare("SELECT seen FROM email_status WHERE email_id = 1").get() as { seen: number }).seen, 0);
    assert.deepEqual(t.calls, []);
  });

  test("live account: removeSeen at the stored location, undo recorded and audited with ids only", async () => {
    const t = setup({ mode: "live" });
    const s = await signIn(t.auth);
    const res = await handleUnread(post(good(s)), "1", t.deps);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, id: 1, mode: "live", seen: false });
    assert.deepEqual(t.calls, ["removeSeen INBOX 5 77"]);
    const a = t.db.prepare("SELECT actor, action, email_id, details_json FROM audit_log WHERE action = 'mailbox_action'").all().map((r) => ({ ...r }));
    assert.equal(a.length, 1);
    assert.equal(a[0].actor, "system");
    assert.deepEqual(JSON.parse(a[0].details_json as string), { action_id: 1, rule: "undo", action: "unmark_seen", mode: "live", status: "done" });
    // repeating is harmless: the rule does not mark it read again
    const evaluate = await createMailboxActions({ db: t.db, accounts: [], killSwitchFile: t.killSwitchFile }).evaluate(1);
    assert.notEqual(evaluate.outcome, "done");
  });

  test("a rejected store answers 502 with the code only and keeps the status", async () => {
    const t = setup({ mode: "live", fail: "store_rejected" });
    const s = await signIn(t.auth);
    const res = await handleUnread(post(good(s)), "1", t.deps);
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: "store_rejected" });
    assert.equal((t.db.prepare("SELECT seen FROM email_status WHERE email_id = 1").get() as { seen: number }).seen, 1);
  });

  test("the kill switch answers 409 and writes nothing", async () => {
    const t = setup({ mode: "live" });
    writeFileSync(t.killSwitchFile, "");
    const s = await signIn(t.auth);
    const res = await handleUnread(post(good(s)), "1", t.deps);
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: "kill_switch" });
    assert.deepEqual(t.calls, []);
  });

  test("the response carries no subject, sender, host, user or cookie", async () => {
    const t = setup({ mode: "live" });
    const s = await signIn(t.auth);
    const text = await (await handleUnread(post(good(s)), "1", t.deps)).text();
    for (const secret of ["subj", "s@x.example", "imap.secret.example", "set-cookie"]) assert.ok(!text.includes(secret), secret);
  });
});
