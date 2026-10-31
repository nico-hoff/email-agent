// Users mode over real HTTP (createService on a temp database): user:create, invitation, registration, two users, isolation,
// logout, revocation, expiry and CSRF negatives. Synthetic data only.
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncAccounts } from "../lib/accounts.ts";
import { openDatabase } from "../lib/db.ts";
import { createService } from "../server.ts";
import { userCreateMain } from "../scripts/user-create.ts";
import { userInviteMain } from "../scripts/user-invite.ts";

const PW1 = "http-MARKER-1f2e3d4c-first-password";
const PW2 = "http-MARKER-9a8b7c6d-second-password";
const T = "2026-10-27T10:00:00.000Z";
const saved = { db: process.env.DATABASE_PATH, mode: process.env.AUTH_MODE, pw: process.env.APP_PASSWORD, bind: process.env.BIND_ADDRESS };
afterEach(() => {
  for (const [k, v] of [["DATABASE_PATH", saved.db], ["AUTH_MODE", saved.mode], ["APP_PASSWORD", saved.pw], ["BIND_ADDRESS", saved.bind]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

/** A tiny browser: keeps the Veryfront CSRF cookie and the session cookie, sends the same-origin headers. */
class Browser {
  vf = "";
  session = "";
  base: string;
  constructor(base: string) {
    this.base = base;
  }
  async open(): Promise<void> {
    const r = await fetch(`${this.base}/welcome`, { headers: { accept: "text/html" } });
    this.vf = /__Host-vf_csrf=([^;]+)/.exec(r.headers.get("set-cookie") ?? "")?.[1] ?? "";
    assert.ok(this.vf, "the Veryfront CSRF cookie is handed out with HTML");
  }
  cookie(): string {
    return [`__Host-vf_csrf=${this.vf}`, this.session].filter(Boolean).join("; ");
  }
  async appToken(): Promise<string> {
    return ((await (await this.get("/api/auth/session")).json()) as { csrfToken: string }).csrfToken;
  }
  get(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${this.base}${path}`, { redirect: "manual", ...init, headers: { cookie: this.cookie(), ...(init.headers as Record<string, string> | undefined) } });
  }
  async post(path: string, body?: unknown, o: { app?: string | null; vf?: boolean; origin?: string | null; headers?: Record<string, string> } = {}): Promise<Response> {
    const headers: Record<string, string> = { cookie: this.cookie(), "content-type": "application/json", "sec-fetch-site": "same-origin", ...o.headers };
    if (o.origin !== null) headers.origin = o.origin ?? this.base;
    if (o.vf !== false) headers["x-csrf-token"] = this.vf;
    const app = o.app === undefined ? await this.appToken() : o.app;
    if (app !== null) headers["x-app-csrf"] = app;
    return fetch(`${this.base}${path}`, { method: "POST", redirect: "manual", headers, body: body === undefined ? undefined : JSON.stringify(body) });
  }
  async login(email: string, password: string): Promise<Response> {
    const r = await this.post("/api/auth/login", { email, password });
    if (r.status === 200) this.session = (r.headers.get("set-cookie") ?? "").split(";")[0];
    return r;
  }
}

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "usrv-"));
  chmodSync(dir, 0o700);
  const file = join(dir, "email-agent.sqlite");
  process.env.DATABASE_PATH = file;
  process.env.AUTH_MODE = "users";
  delete process.env.APP_PASSWORD;
  delete process.env.BIND_ADDRESS;
  const env = { DATABASE_PATH: file };
  const out: string[] = [];
  const io = { out: (l: string) => out.push(l), err: (l: string) => out.push(`ERR ${l}`) };
  // The operator path: the first admin claims the owner row, so data seeded for the owner belongs to the admin.
  const db = openDatabase(file);
  syncAccounts(db, [{ id: "own", label: "Own", host: "imap.a.example", port: 993, mailbox: "INBOX", enabled: true }] as never);
  const mail = db.prepare("INSERT INTO emails (id, account_id, message_id, sender, subject, received_at, first_seen_at) VALUES (1,'own','<1@x>','s@x.example','OWNER-SUBJECT-MARKER',?,?)");
  mail.run(T, T);
  db.prepare("INSERT INTO email_locations (email_id, account_id, folder, uid_validity, uid, first_seen_at, last_seen_at) VALUES (1,'own','INBOX',1,1,?,?)").run(T, T);
  db.close();
  assert.equal(await userCreateMain(["--email", "admin@example.test", "--password-stdin"], { env, readStdin: async () => PW1, ...io }), 0);
  assert.equal(await userInviteMain([], { env, ...io }), 0);
  const code = /: ([A-Z2-9-]{24})$/.exec(out.find((l) => l.startsWith("Einladungscode")) ?? "")?.[1] ?? "";
  assert.ok(code);
  const logs: string[] = [];
  const svc = await createService({ mode: "production", port: 0, bindAddress: "127.0.0.1", workers: false, onSignal: () => {}, log: (m) => logs.push(m) });
  return { svc, base: `http://127.0.0.1:${svc.port}`, file, code, logs, out };
}

describe("users mode over HTTP", () => {
  it("nothing is open without a session; the welcome page and session endpoint announce the users mode", async () => {
    const t = await setup();
    try {
      const anon = new Browser(t.base);
      await anon.open();
      for (const p of ["/api/emails", "/api/emails/1", "/api/profile", "/api/invites", "/api/status", "/api/actions", "/api/senders/rules"]) {
        assert.equal((await anon.get(p)).status, 401, p);
      }
      assert.equal((await anon.get("/")).status, 303);
      assert.equal((await anon.get("/profil")).status, 303);
      const info = (await (await anon.get("/api/auth/session")).json()) as Record<string, unknown>;
      assert.equal(info.mode, "users");
      assert.equal(info.signedIn, false);
      assert.equal("login" in info, false);
      assert.equal((await anon.get("/api/health")).status, 200);
    } finally {
      await t.svc.stop();
    }
  });

  it("full flow: login, profile, invitation, registration, two users, isolation, logout, revocation, expiry", async () => {
    const t = await setup();
    try {
      // --- admin signs in (the claimed owner: the seeded mail is theirs)
      const admin = new Browser(t.base);
      await admin.open();
      const wrong = await admin.login("admin@example.test", "wrong-password-xx");
      assert.equal(wrong.status, 401);
      assert.deepEqual(await wrong.json(), { error: "invalid_credentials" });
      const unknown = await admin.login("nobody@example.test", PW1);
      assert.equal(unknown.status, 401);
      const ok = await admin.login("ADMIN@example.test", PW1);
      assert.equal(ok.status, 200);
      const setCookie = ok.headers.get("set-cookie") ?? "";
      assert.match(setCookie, /HttpOnly/);
      assert.match(setCookie, /SameSite=Strict/);
      assert.match(setCookie, /^ea_session=v2\./);
      assert.ok(!setCookie.includes(PW1));

      const list = (await (await admin.get("/api/emails")).json()) as { emails: { id: number; subject: string }[] };
      assert.deepEqual(list.emails.map((e) => e.id), [1]);
      assert.equal((await admin.get("/api/emails/1")).status, 200);
      const profile = (await (await admin.get("/api/profile")).json()) as Record<string, unknown>;
      assert.deepEqual(profile, { mode: "users", managed: true, email: "admin@example.test", role: "admin", live_sessions: 1 });
      assert.notEqual((await admin.get("/profil")).status, 303, "the profile page opens for a signed-in user");

      // --- the operator's invitation (user:invite) registers a second user; the code works once
      const reg = new Browser(t.base);
      await reg.open();
      const bad = await reg.post("/api/auth/register", { code: "AAAA-AAAA-AAAA-AAAA-AAAA", email: "friend@example.test", password: PW2 });
      assert.equal(bad.status, 400);
      assert.deepEqual(await bad.json(), { error: "invalid_invite" });
      const registered = await reg.post("/api/auth/register", { code: t.code, email: "Friend@example.test", password: PW2 });
      assert.equal(registered.status, 200);
      reg.session = (registered.headers.get("set-cookie") ?? "").split(";")[0];
      const again = new Browser(t.base);
      await again.open();
      assert.equal((await again.post("/api/auth/register", { code: t.code, email: "third@example.test", password: PW2 })).status, 400, "burnt code");

      // --- the second user sees nothing of the first
      const mine = (await (await reg.get("/api/emails")).json()) as { emails: unknown[]; counts: { all: number }; accounts: unknown[] };
      assert.deepEqual([mine.emails.length, mine.counts.all, mine.accounts.length], [0, 0, 0]);
      const peek = await reg.get("/api/emails/1");
      assert.equal(peek.status, 404);
      assert.deepEqual(await peek.json(), { error: "not_found" });
      assert.equal((await reg.post("/api/emails/1/done")).status, 404);
      assert.equal((await reg.post("/api/emails/1/undone")).status, 404);
      assert.equal((await reg.post("/api/emails/1/feedback", { kind: "not_spam" })).status, 404);
      const check = openDatabase(t.file);
      assert.equal((check.prepare("SELECT COUNT(*) AS n FROM email_status").get() as { n: number }).n, 0, "nothing was written for the foreign id");
      assert.equal((check.prepare("SELECT COUNT(*) AS n FROM feedback").get() as { n: number }).n, 0);
      check.close();
      const ownProfile = (await (await reg.get("/api/profile")).json()) as Record<string, unknown>;
      assert.deepEqual([ownProfile.email, ownProfile.role], ["friend@example.test", "user"]);
      assert.equal((await reg.get("/api/invites")).status, 403);
      assert.equal((await reg.post("/api/invites", {})).status, 403);

      // --- the admin still sees the mail and can act on it; invitations come from the profile route too
      assert.equal((await admin.post("/api/emails/1/done")).status, 200);
      const created = await admin.post("/api/invites", { role: "user" });
      assert.equal(created.status, 201);
      const inv = (await created.json()) as { code: string };
      assert.match(inv.code, /^([A-Z2-9]{4}-){4}[A-Z2-9]{4}$/);
      const open = (await (await admin.get("/api/invites")).json()) as { invites: { id: number }[] };
      assert.equal(open.invites.length, 1);
      assert.ok(!JSON.stringify(open).includes(inv.code));

      // --- both log in on a fresh device; sessions are independent
      const friend2 = new Browser(t.base);
      await friend2.open();
      assert.equal((await friend2.login("friend@example.test", PW2)).status, 200);
      assert.equal((await friend2.get("/api/emails")).status, 200);

      // --- logout revokes on the server: the copied cookie is dead
      const copied = reg.session;
      assert.equal((await reg.post("/api/auth/logout")).status, 200);
      const replay = new Browser(t.base);
      await replay.open();
      replay.session = copied;
      assert.equal((await replay.get("/api/emails")).status, 401);
      assert.equal((await friend2.get("/api/emails")).status, 200, "the other device of the same user stays signed in");

      // --- logout everywhere ends the remaining session too
      assert.equal((await friend2.post("/api/sessions/revoke-all")).status, 200);
      assert.equal((await friend2.get("/api/emails")).status, 401);

      // --- expiry: a session row in the past is dead even with a valid cookie
      const db = openDatabase(t.file);
      db.exec("UPDATE user_sessions SET expires_at = '2026-10-27T00:00:00.000Z', created_at = '2026-10-26T00:00:00.000Z' WHERE revoked_at IS NULL");
      db.close();
      assert.equal((await admin.get("/api/emails")).status, 401, "expired on the server");
      const again2 = new Browser(t.base);
      await again2.open();
      assert.equal((await again2.login("admin@example.test", PW1)).status, 200, "a new login works");

      // --- disabling a user ends their access at once
      const disabler = openDatabase(t.file);
      disabler.exec("UPDATE users SET status = 'disabled' WHERE email = 'friend@example.test'");
      disabler.close();
      const blocked = new Browser(t.base);
      await blocked.open();
      assert.equal((await blocked.login("friend@example.test", PW2)).status, 401);
    } finally {
      await t.svc.stop();
    }
    const log = t.logs.join("\n") + t.out.join("\n");
    for (const secret of [PW1, PW2, "admin@example.test", "friend@example.test"]) assert.ok(!log.includes(secret), "no secret or address in logs and CLI output");
  });

  it("CSRF negatives: login, register, logout and mutations are refused without the right proofs", async () => {
    const t = await setup();
    try {
      const b = new Browser(t.base);
      await b.open();
      const creds = { email: "admin@example.test", password: PW1 };
      assert.equal((await b.post("/api/auth/login", creds, { app: null })).status, 403, "no app token");
      assert.equal((await b.post("/api/auth/login", creds, { vf: false })).status, 403, "no Veryfront double-submit header");
      assert.equal((await b.post("/api/auth/login", creds, { origin: "https://evil.example" })).status, 403, "foreign origin");
      assert.equal((await b.post("/api/auth/login", creds, { origin: null })).status, 403, "no origin");
      assert.equal((await b.post("/api/auth/login", creds, { headers: { "sec-fetch-site": "cross-site" } })).status, 403);
      assert.equal((await b.post("/api/auth/login", creds, { app: "abc.def" })).status, 403, "forged app token");
      assert.equal((await b.post("/api/auth/register", { code: t.code, email: "x@example.test", password: PW2 }, { app: null })).status, 403);

      assert.equal((await b.login("admin@example.test", PW1)).status, 200);
      const post = b.session;
      assert.equal((await b.post("/api/emails/1/done", undefined, { app: null })).status, 403);
      assert.equal((await b.post("/api/emails/1/done", undefined, { vf: false })).status, 403);
      assert.equal((await b.post("/api/emails/1/done", undefined, { origin: "https://evil.example" })).status, 403);
      assert.equal((await b.post("/api/invites", {}, { app: "abc.def" })).status, 403);
      assert.equal((await b.post("/api/sessions/revoke-all", undefined, { app: null })).status, 403);
      assert.equal((await b.post("/api/auth/logout", undefined, { app: null })).status, 403);
      // the pre-login token (bound to no user) does not authorise a signed-in mutation
      const savedSession = b.session;
      b.session = "";
      const preToken = await b.appToken();
      b.session = savedSession;
      assert.equal((await b.post("/api/emails/1/done", undefined, { app: preToken })).status, 403);
      assert.equal(b.session, post);
      const db = openDatabase(t.file);
      assert.equal((db.prepare("SELECT COUNT(*) AS n FROM email_status").get() as { n: number }).n, 0, "no refused request changed anything");
      assert.equal((db.prepare("SELECT COUNT(*) AS n FROM invites WHERE used_at IS NOT NULL").get() as { n: number }).n, 0);
      db.close();
      assert.equal((await b.get("/api/emails")).status, 200, "the session itself is still fine");
    } finally {
      await t.svc.stop();
    }
  });

  it("login is rate limited per address and answers 429 with retry-after", async () => {
    const t = await setup();
    try {
      const b = new Browser(t.base);
      await b.open();
      let last: Response | undefined;
      for (let i = 0; i < 11; i++) last = await b.login("admin@example.test", "wrong-password-xx");
      assert.equal(last?.status, 429);
      assert.ok(Number(last?.headers.get("retry-after")) > 0);
      assert.equal((await b.login("admin@example.test", PW1)).status, 429, "the right password waits too");
    } finally {
      await t.svc.stop();
    }
  });

  it("the Tailscale header and APP_PASSWORD-era cookies open nothing in users mode", async () => {
    const t = await setup();
    try {
      const b = new Browser(t.base);
      await b.open();
      assert.equal((await b.get("/api/emails", { headers: { "tailscale-user-login": "admin@example.test" } })).status, 401);
      assert.equal((await b.get("/api/emails", { headers: { cookie: "ea_session=v1.abc.def.ghi" } })).status, 401);
    } finally {
      await t.svc.stop();
    }
  });
});
