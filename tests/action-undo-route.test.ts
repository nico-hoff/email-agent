// R9: POST /api/actions/:id/undo (guard order, codes, live move back through a fake port).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../packages/core/src/db.ts";
import { syncAccounts } from "../packages/core/src/accounts.ts";
import { CSRF_HEADER } from "../packages/core/src/csrf.ts";
import { createAuthContext, createLoginLimiter, createMutationLimiter, handleLogin, handleSession } from "../packages/core/src/auth-runtime.ts";
import { handleActionUndo, parseActionId } from "../packages/core/src/action-undo.ts";
import { ImapWriteError, type ImapWritePort, type MoveRequest } from "../packages/core/src/imap-write.ts";
import { createMailboxActions } from "../packages/core/src/mailbox-actions.ts";
import type { AccountConfig } from "../packages/core/src/accounts-config.ts";
import * as undoRoute from "../app/api/actions/[id]/undo/route.ts";

const ME = "nico@example.test";
const HOST = "mac.tail.ts.net";
const ORIGIN = `https://${HOST}`;
const T = "2026-10-27T10:00:00.000Z";

function setup(o: { mode?: "dry_run" | "live"; status?: string; fail?: string; limit?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "undo-"));
  chmodSync(dir, 0o700);
  mkdirSync(join(dir, "data"), { mode: 0o700 });
  writeFileSync(join(dir, "data", "auth-allowlist.json"), JSON.stringify({ logins: [ME] }));
  const auth = createAuthContext({ dataDir: join(dir, "data"), synthetic: false });
  const accounts = [{ id: "a1", label: "A", context: "c", host: "imap.secret.example", port: 993, tls: true, user: "u", password: "p", mailbox: "INBOX", spam_threshold: 0.9, enabled: true }] as unknown as AccountConfig[];
  const db = openDatabase(":memory:");
  syncAccounts(db, accounts);
  db.prepare("INSERT INTO emails (id, account_id, message_id, sender, subject, received_at, first_seen_at) VALUES (1,'a1','<m1>','s@x.example','subj',?,?)").run(T, T);
  db.prepare("INSERT INTO email_locations (email_id, account_id, folder, uid_validity, uid, first_seen_at, last_seen_at) VALUES (1,'a1','Quarantäne',5,77,?,?)").run(T, T);
  db.prepare("INSERT INTO mailbox_actions (id, email_id, location_id, rule, action, mode, status, created_at, done_at) VALUES (1,1,1,'quarantine','move_quarantine',?,?,?,?)")
    .run(o.mode ?? "live", o.status ?? (o.mode === "dry_run" ? "planned" : "done"), T, T);
  const calls: MoveRequest[] = [];
  const port: ImapWritePort = {
    async addSeen() {},
    async removeSeen() {},
    async moveMessage(req) {
      calls.push(req);
      if (o.fail) throw new ImapWriteError(o.fail as never);
      return { folder: "INBOX", uidValidity: 5, uid: 78 };
    },
  };
  const killSwitchFile = join(dir, "data", "auto-actions.disabled");
  const unclosable = { prepare: db.prepare.bind(db), exec: db.exec.bind(db), close() {} } as unknown as DatabaseSync;
  const deps = {
    auth, limiter: createMutationLimiter(undefined, o.limit), openDb: () => unclosable,
    actions: (d: DatabaseSync) => createMailboxActions({ db: d, accounts, killSwitchFile, now: () => new Date(T), writePortFor: () => port }),
  };
  return { auth, db, deps, calls };
}
const tailnet = { host: HOST, "tailscale-user-login": ME };
async function signIn(auth: ReturnType<typeof setup>["auth"]) {
  const info = (await (await handleSession(new Request("http://127.0.0.1:3000/api/auth/session", { headers: tailnet }), auth)).json()) as { csrfToken: string };
  const res = handleLogin(new Request("http://127.0.0.1:3000/api/auth/login", { method: "POST", headers: { ...tailnet, origin: ORIGIN, "sec-fetch-site": "same-origin", [CSRF_HEADER]: info.csrfToken } }), auth, createLoginLimiter());
  return { cookie: (res.headers.get("set-cookie") ?? "").split(";")[0], csrf: info.csrfToken };
}
const post = (headers: Record<string, string>) => new Request("http://127.0.0.1:3000/api/actions/1/undo", { method: "POST", headers: { host: HOST, ...headers } });
const good = (s: { cookie: string; csrf: string }) => ({ cookie: s.cookie, origin: ORIGIN, "sec-fetch-site": "same-origin", [CSRF_HEADER]: s.csrf });
const status = (db: DatabaseSync) => (db.prepare("SELECT status FROM mailbox_actions WHERE id = 1").get() as { status: string }).status;

describe("POST /api/actions/:id/undo", () => {
  test("guards: no session 401, no CSRF proof 403, rate limit 429, bad ids 404; nothing is touched", async () => {
    const t = setup();
    assert.equal((await handleActionUndo(post({}), "1", t.deps)).status, 401);
    const s = await signIn(t.auth);
    assert.equal((await handleActionUndo(post({ cookie: s.cookie }), "1", t.deps)).status, 403);
    for (const id of ["0", "-1", "abc", "1.5", "", undefined, "99"]) assert.equal((await handleActionUndo(post(good(s)), id, t.deps)).status, 404, String(id));
    assert.deepEqual(t.calls, []);
    assert.equal(status(t.db), "done");
    const lim = setup({ limit: 1 });
    const s2 = await signIn(lim.auth);
    assert.deepEqual([(await handleActionUndo(post(good(s2)), "99", lim.deps)).status, (await handleActionUndo(post(good(s2)), "99", lim.deps)).status], [404, 429]);
  });

  test("live: moves back, answers mode live, marks the action undone", async () => {
    const t = setup();
    const s = await signIn(t.auth);
    const res = await handleActionUndo(post(good(s)), "1", t.deps);
    assert.deepEqual([res.status, await res.json()], [200, { ok: true, id: 1, mode: "live" }]);
    assert.deepEqual(t.calls.map((c) => [c.folder, c.uid, c.target]), [["Quarantäne", 77, "inbox"]]);
    assert.equal(status(t.db), "undone");
    const again = await handleActionUndo(post(good(s)), "1", t.deps);
    assert.deepEqual([again.status, await again.json()], [409, { error: "not_undoable" }]);
  });

  test("dry run: drops the plan, no server call", async () => {
    const t = setup({ mode: "dry_run" });
    const s = await signIn(t.auth);
    assert.deepEqual(await (await handleActionUndo(post(good(s)), "1", t.deps)).json(), { ok: true, id: 1, mode: "dry_run" });
    assert.deepEqual(t.calls, []);
  });

  test("a server failure answers 502 with the code only", async () => {
    const t = setup({ fail: "uidvalidity_changed" });
    const s = await signIn(t.auth);
    const res = await handleActionUndo(post(good(s)), "1", t.deps);
    assert.deepEqual([res.status, await res.json()], [502, { error: "uidvalidity_changed" }]);
    assert.equal(status(t.db), "done");
  });

  test("route module exports POST only; ids parse strictly", async () => {
    assert.deepEqual(Object.keys(undoRoute).sort(), ["POST"]);
    assert.equal((await undoRoute.POST(new Request("http://127.0.0.1:3000/api/actions/1/undo", { method: "POST" }), { params: Promise.resolve({ id: "1" }) })).status, 401);
    assert.deepEqual(["1", "42", "0", "01", "1e3", " 1", undefined, 1].map(parseActionId), [1, 42, null, null, null, null, null, null]);
  });
});
