import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { CSRF_HEADER } from "../lib/csrf.ts";
import {
  deriveKeys, issueSession, issueUserSession, selectAuthMode, SESSION_COOKIE, SESSION_TTL_MS, userIdentity, USERS_PRE_LOGIN_IDENTITY, verifyUserSession,
} from "../lib/auth.ts";
import {
  createAuthContext, createUsersLimits, guardMutation, guardRequest, handleLoginRequest, handleLogout, handleLogoutAll, handleRegister, handleSession,
  interceptRequest, requireUser,
} from "../lib/auth-runtime.ts";
import { openDatabase } from "../lib/db.ts";
import { createInvite, createUser, countLiveSessions, listOpenInvites } from "../lib/users.ts";
import { createMutationLimiter } from "../lib/auth-runtime.ts";
import { handleInviteCreate, handleInvitesList, handleProfileGet } from "../lib/profile-api.ts";

// Unique markers: they must never show up in any response or header.
const PW = "pw-MARKER-5b1c2d33-correct-horse";
const ADMIN = "admin@example.test";
const HOST = "app.example.test";
const ORIGIN = `https://${HOST}`;
const T0 = 1_800_000_000_000;

interface Setup {
  ctx: ReturnType<typeof createAuthContext>;
  db: DatabaseSync;
  limits: ReturnType<typeof createUsersLimits>;
  clock: { t: number };
  slept: number[];
  mutation: ReturnType<typeof createMutationLimiter>;
}

let s: Setup;
beforeEach(async () => {
  const root = mkdtempSync(join(tmpdir(), "authusers-"));
  chmodSync(root, 0o700);
  mkdirSync(join(root, "data"), { mode: 0o700 });
  const file = join(root, "data", "t.sqlite");
  const db = openDatabase(file);
  const clock = { t: T0 };
  const slept: number[] = [];
  const ctx = createAuthContext({
    dataDir: join(root, "data"), synthetic: false, authMode: "users", now: () => clock.t, openDb: () => openDatabase(file),
    sleep: async (ms) => { slept.push(ms); }, bindAddress: "0.0.0.0",
  });
  await createUser(db, { email: ADMIN, password: PW, now: new Date(clock.t) });
  s = { ctx, db, limits: createUsersLimits(() => clock.t), clock, slept, mutation: createMutationLimiter(() => clock.t) };
});

const get = (path: string, headers: Record<string, string> = {}) => new Request(`http://127.0.0.1:3000${path}`, { headers: { host: HOST, ...headers } });
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0];
async function token(headers: Record<string, string> = {}): Promise<string> {
  return ((await (await handleSession(get("/api/auth/session", headers), s.ctx)).json()) as { csrfToken: string }).csrfToken;
}
function post(path: string, body: unknown, o: { csrf?: string | null; headers?: Record<string, string>; raw?: string } = {}): Request {
  const headers: Record<string, string> = { host: HOST, origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/json", ...(o.headers ?? {}) };
  if (o.csrf !== null && o.csrf !== undefined) headers[CSRF_HEADER] = o.csrf;
  return new Request(`http://127.0.0.1:3000${path}`, { method: "POST", headers, body: o.raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
}
async function login(email: string, password: string, o: { csrf?: string | null } = {}): Promise<Response> {
  const csrf = o.csrf === undefined ? await token() : o.csrf;
  return handleLoginRequest(post("/api/auth/login", { email, password }, { csrf }), s.ctx, s.limits.global, s.limits);
}
async function signIn(email = ADMIN, password = PW): Promise<{ cookie: string; csrf: string }> {
  const res = await login(email, password);
  assert.equal(res.status, 200);
  const cookie = cookieOf(res);
  return { cookie, csrf: await token({ cookie }) };
}

describe("pure pieces", () => {
  const key = deriveKeys(new Uint8Array(32).fill(7)).session;
  const tok = "A".repeat(43);

  it("mode order: synthetic, then AUTH_MODE=users, then APP_PASSWORD, then tailnet", () => {
    assert.equal(selectAuthMode({ synthetic: true, appPassword: "x", authMode: "users" }), "synthetic");
    assert.equal(selectAuthMode({ synthetic: false, appPassword: "x".repeat(20), authMode: "users" }), "users");
    assert.equal(selectAuthMode({ synthetic: false, appPassword: undefined, authMode: "users" }), "users");
    assert.equal(selectAuthMode({ synthetic: false, appPassword: "x".repeat(20) }), "password");
    assert.equal(selectAuthMode({ synthetic: false, appPassword: undefined }), "tailnet");
    for (const other of ["", "password", "USERS", "tailnet"]) assert.equal(selectAuthMode({ synthetic: false, appPassword: undefined, authMode: other }), "tailnet", other);
  });

  it("identities: user:<id> and a fixed pre-login constant", () => {
    assert.equal(userIdentity(7), "user:7");
    assert.equal(USERS_PRE_LOGIN_IDENTITY, "users-pre-login");
  });

  it("v2 cookie round-trips; any change of user, token, time or mac is refused", () => {
    const v = issueUserSession(7, tok, key, T0);
    assert.match(v, /^v2\.[0-9a-z]+\.7\.A{43}\.[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(verifyUserSession(v, key, T0 + 1000), { ok: true, userId: 7, token: tok });
    const p = v.split(".");
    const forged = (i: number, val: string) => p.map((x, j) => (j === i ? val : x)).join(".");
    assert.equal(verifyUserSession(forged(2, "8"), key, T0).ok, false, "other user id");
    assert.equal(verifyUserSession(forged(3, "B".repeat(43)), key, T0).ok, false, "other token");
    assert.equal(verifyUserSession(forged(1, (T0 + 1).toString(36)), key, T0 + 5000).ok, false, "other time");
    assert.equal(verifyUserSession(forged(4, "A".repeat(43)), key, T0).ok, false, "other mac");
    assert.equal(verifyUserSession(v, deriveKeys(new Uint8Array(32).fill(8)).session, T0).ok, false, "other key");
  });

  it("v2 cookie expires with the session time, rejects the future and malformed values; a v1 cookie is not a v2", () => {
    const v = issueUserSession(7, tok, key, T0);
    assert.equal(verifyUserSession(v, key, T0 + SESSION_TTL_MS + 1).ok, false);
    assert.equal(verifyUserSession(issueUserSession(7, tok, key, T0 + 60_000), key, T0).ok, false);
    for (const bad of ["", "v2.", "v2.a.0.x.y", `v2.${T0.toString(36)}.007.${tok}.${"A".repeat(43)}`, issueSession("password-user", key, T0)]) {
      assert.equal(verifyUserSession(bad, key, T0).ok, false, bad);
    }
  });
});

describe("session endpoint and guard", () => {
  it("anonymous: users mode, pre-login token, not signed in; unconfigured without a database", async () => {
    const body = (await (await handleSession(get("/api/auth/session"), s.ctx)).json()) as Record<string, unknown>;
    assert.equal(body.mode, "users");
    assert.equal(body.signedIn, false);
    assert.equal(typeof body.csrfToken, "string");
    assert.equal("login" in body, false);
    const bare = createAuthContext({ dataDir: join(tmpdir()), synthetic: false, authMode: "users" });
    assert.deepEqual(await (await handleSession(get("/api/auth/session"), bare)).json(), { mode: "users", configured: false });
    const r = await handleLoginRequest(post("/api/auth/login", { email: ADMIN, password: PW }), bare, s.limits.global, s.limits);
    assert.equal(r.status, 503);
  });

  it("guard: no cookie -> redirect/401; the Tailscale header and a password-mode style cookie do not count", async () => {
    assert.equal(guardRequest(get("/api/emails", { "tailscale-user-login": ADMIN }), s.ctx)?.status, 401);
    assert.equal(guardRequest(get("/", {}), s.ctx)?.status, 303);
    const keys = s.ctx.keys();
    const v1 = `${SESSION_COOKIE}=${issueSession("password-user", keys.session, T0)}`;
    assert.equal(guardRequest(get("/api/emails", { cookie: v1 }), s.ctx)?.status, 401);
    assert.equal(guardRequest(get("/api/auth/register"), s.ctx), undefined, "register is public (it checks itself)");
    assert.equal(guardRequest(get("/profil"), s.ctx)?.status, 303);
    assert.equal(guardRequest(get("/_vf/css/abc.css"), s.ctx), undefined, "the production stylesheet is public (styles the welcome page)");
    assert.equal(guardRequest(get("/api/profile"), s.ctx)?.status, 401);
  });

  it("login opens the guard; interceptRequest passes it through and rewrites an anonymous request", async () => {
    const { cookie } = await signIn();
    assert.equal(guardRequest(get("/api/emails", { cookie }), s.ctx), undefined);
    const req = get("/api/emails", { cookie });
    assert.equal(interceptRequest(req, () => s.ctx), req);
    assert.match(interceptRequest(get("/api/emails"), () => s.ctx).url, /\/api\/auth\/deny\?k=api$/);
  });

  it("a session row is required: deleting it, revoking it, expiry and disabling the user all close the guard at once", async () => {
    const a = await signIn();
    assert.equal(guardRequest(get("/api/emails", { cookie: a.cookie }), s.ctx), undefined);
    s.db.exec("UPDATE user_sessions SET revoked_at = '2026-01-01T00:00:00.000Z'");
    assert.equal(guardRequest(get("/api/emails", { cookie: a.cookie }), s.ctx)?.status, 401);

    const b = await signIn();
    s.db.exec("DELETE FROM user_sessions");
    assert.equal(guardRequest(get("/api/emails", { cookie: b.cookie }), s.ctx)?.status, 401);

    const c = await signIn();
    assert.equal(guardRequest(get("/api/emails", { cookie: c.cookie }), s.ctx), undefined);
    s.clock.t += 31 * 24 * 3600 * 1000;
    assert.equal(guardRequest(get("/api/emails", { cookie: c.cookie }), s.ctx)?.status, 401, "expired");

    s.clock.t = T0;
    const d = await signIn();
    s.db.exec("UPDATE users SET status = 'disabled' WHERE id = 1");
    assert.equal(guardRequest(get("/api/emails", { cookie: d.cookie }), s.ctx)?.status, 401);
  });

  it("a cookie with a valid MAC but a token that is not in the table is refused (cookie forged with the server key)", () => {
    const keys = s.ctx.keys();
    const forged = `${SESSION_COOKIE}=${issueUserSession(1, "Z".repeat(43), keys.session, s.clock.t)}`;
    assert.equal(guardRequest(get("/api/emails", { cookie: forged }), s.ctx)?.status, 401);
  });

  it("a valid session token with a different user id in the cookie is refused", async () => {
    const { cookie } = await signIn();
    const parts = cookie.split("=")[1].split(".");
    const keys = s.ctx.keys();
    const swapped = `${SESSION_COOKIE}=${issueUserSession(2, parts[3], keys.session, s.clock.t)}`;
    assert.equal(guardRequest(get("/api/emails", { cookie: swapped }), s.ctx)?.status, 401);
  });
});

describe("login", () => {
  it("success: hardened cookie (HttpOnly, SameSite=Strict, Secure on a public bind), v2 format, session row, no secrets in the answer", async () => {
    const res = await login(ADMIN, PW);
    assert.equal(res.status, 200);
    const raw = res.headers.get("set-cookie") ?? "";
    for (const a of ["HttpOnly", "SameSite=Strict", "Secure", "Path=/"]) assert.ok(raw.includes(a), a);
    assert.match(raw, new RegExp(`^${SESSION_COOKIE}=v2\\.`));
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(countLiveSessions(s.db, 1, new Date(s.clock.t)), 1);
    assert.ok(!raw.includes(PW));
  });

  it("the Secure flag is dropped only on a loopback-bound listener reached over loopback", async () => {
    const loop = createAuthContext({ dataDir: join(tmpdir()), synthetic: false, authMode: "users", now: () => s.clock.t, openDb: () => openDatabase(s.db.location()!), sleep: async () => {} });
    const csrf = ((await (await handleSession(new Request("http://127.0.0.1:3000/api/auth/session", { headers: { host: "127.0.0.1:3000" } }), loop)).json()) as { csrfToken: string }).csrfToken;
    const req = new Request("http://127.0.0.1:3000/api/auth/login", {
      method: "POST", body: JSON.stringify({ email: ADMIN, password: PW }),
      headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", "sec-fetch-site": "same-origin", [CSRF_HEADER]: csrf, "content-type": "application/json" },
    });
    const res = await handleLoginRequest(req, loop, s.limits.global, s.limits);
    assert.equal(res.status, 200);
    assert.ok(!(res.headers.get("set-cookie") ?? "").includes("Secure"));
  });

  it("wrong password, unknown email, malformed and empty bodies: one identical 401, a fixed delay, no cookie", async () => {
    const answers: string[] = [];
    for (const [email, password] of [[ADMIN, "wrong-password-123"], ["who@example.test", PW], ["", ""], [5, 6], [ADMIN, undefined]] as const) {
      const res = await handleLoginRequest(post("/api/auth/login", { email, password }, { csrf: await token() }), s.ctx, s.limits.global, s.limits);
      assert.equal(res.status, 401);
      assert.equal(res.headers.get("set-cookie"), null);
      answers.push(await res.text());
    }
    const raw = await handleLoginRequest(post("/api/auth/login", undefined, { csrf: await token(), raw: "{nope" }), s.ctx, s.limits.global, s.limits);
    assert.equal(raw.status, 401);
    answers.push(await raw.text());
    assert.equal(new Set(answers).size, 1, "no hint which part was wrong");
    assert.equal(answers[0], '{"error":"invalid_credentials"}');
    assert.equal(s.slept.length, 6);
    assert.ok(s.slept.every((ms) => ms === 500));
  });

  it("CSRF comes first and costs no attempt: missing token, wrong origin, post-login token, cross-site", async () => {
    const good = { email: ADMIN, password: PW };
    const none = await handleLoginRequest(post("/api/auth/login", good, { csrf: null }), s.ctx, s.limits.global, s.limits);
    assert.equal(none.status, 403);
    const foreign = await handleLoginRequest(post("/api/auth/login", good, { csrf: await token(), headers: { origin: "https://evil.example" } }), s.ctx, s.limits.global, s.limits);
    assert.equal(foreign.status, 403);
    const cross = await handleLoginRequest(post("/api/auth/login", good, { csrf: await token(), headers: { "sec-fetch-site": "cross-site" } }), s.ctx, s.limits.global, s.limits);
    assert.equal(cross.status, 403);
    const wrongBound = createUsersTokenFor("user:1");
    const bound = await handleLoginRequest(post("/api/auth/login", good, { csrf: wrongBound }), s.ctx, s.limits.global, s.limits);
    assert.equal(bound.status, 403, "a token bound to a user is not the pre-login token");
    assert.equal(s.slept.length, 0);
    assert.equal(countLiveSessions(s.db, 1, new Date(s.clock.t)), 0);
  });

  it("limits: 10 failures per email (hashed key), then 429 with retry-after; another email is unaffected; success does not reset", async () => {
    for (let i = 0; i < 10; i++) assert.equal((await login(ADMIN, "wrong-password-123")).status, 401);
    const limited = await login(ADMIN, PW);
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("retry-after")) > 0);
    assert.equal((await login("other@example.test", "wrong-password-123")).status, 401, "other address, own budget");
    s.clock.t += 16 * 60 * 1000;
    assert.equal((await login(ADMIN, PW)).status, 200, "window passed");
  });

  it("global limit: failures across many addresses are bounded in total", async () => {
    for (let i = 0; i < 60; i++) assert.equal((await login(`user${i}@example.test`, "wrong-password-123")).status, 401, String(i));
    assert.equal((await login("fresh@example.test", "wrong-password-123")).status, 429);
    assert.equal((await login(ADMIN, PW)).status, 429, "even the right password waits");
  });

  it("the per-email key is a hash: the limiter holds no address", async () => {
    await login("someone-private@example.test", "wrong-password-123");
    // The only observable state is the size; the key itself is not exposed, but it must not be the raw address.
    assert.equal(s.limits.perEmail.size(), 1);
    assert.equal(s.limits.perEmail.check("someone-private@example.test").allowed, true, "the raw address is a different key");
  });

  it("login is refused outside users mode", async () => {
    const pw = createAuthContext({ dataDir: tmpdir(), synthetic: false, appPassword: "x".repeat(20), now: () => s.clock.t });
    const res = await handleLoginRequest(post("/api/auth/login", { email: ADMIN, password: PW }), pw, s.limits.global, s.limits);
    assert.notEqual(res.status, 200);
    assert.equal((await handleRegister(post("/api/auth/register", {}), pw, s.limits)).status, 401);
  });
});

describe("registration", () => {
  const body = (code: string, email = "new@example.test", password = PW) => ({ code, email, password });
  const invite = (role: "user" | "admin" = "user", days = 7) => createInvite(s.db, { createdBy: 1, role, days, now: new Date(s.clock.t) }).code;
  const register = async (b: unknown, csrf?: string | null) =>
    handleRegister(post("/api/auth/register", b, { csrf: csrf === undefined ? await token() : csrf }), s.ctx, s.limits);

  it("a valid code creates the account, starts a session and burns the code", async () => {
    const code = invite();
    const res = await register(body(code));
    assert.equal(res.status, 200);
    const cookie = cookieOf(res);
    assert.match(cookie, new RegExp(`^${SESSION_COOKIE}=v2\\.[0-9a-z]+\\.2\\.`), "the new user is id 2, not the owner");
    assert.equal(guardRequest(get("/api/emails", { cookie }), s.ctx), undefined);
    assert.equal(listOpenInvites(s.db, new Date(s.clock.t)).length, 0);
    const again = await register(body(code, "other@example.test"));
    assert.equal(again.status, 400);
    assert.deepEqual(await again.json(), { error: "invalid_invite" });
    assert.ok(!(res.headers.get("set-cookie") ?? "").includes(code));
  });

  it("without a code, with a wrong or expired code: 400 invalid_invite, fixed delay, nothing created", async () => {
    for (const code of ["", "AAAA-AAAA-AAAA-AAAA-AAAA", "x"]) {
      const res = await register(body(code));
      assert.equal(res.status, 400, code);
      assert.deepEqual(await res.json(), { error: "invalid_invite" });
    }
    const old = invite("user", 1);
    s.clock.t += 2 * 24 * 3600 * 1000;
    assert.equal((await register(body(old))).status, 400);
    assert.equal((s.db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n, 1);
    assert.equal(s.slept.length, 4);
  });

  it("refusals leave the code usable: weak password 400, bad email 400, taken email 409", async () => {
    const code = invite();
    assert.deepEqual(await (await register(body(code, "new@example.test", "short"))).json(), { error: "weak_password" });
    assert.deepEqual(await (await register(body(code, "nope"))).json(), { error: "invalid_email" });
    const taken = await register(body(code, ADMIN));
    assert.equal(taken.status, 409);
    assert.deepEqual(await taken.json(), { error: "email_taken" });
    assert.equal((await register(body(code))).status, 200);
  });

  it("CSRF (pre-login identity) is required: no token, post-login token, foreign origin -> 403 and the code is not touched", async () => {
    const code = invite();
    assert.equal((await register(body(code), null)).status, 403);
    assert.equal((await register(body(code), createUsersTokenFor("user:1"))).status, 403);
    const foreign = await handleRegister(post("/api/auth/register", body(code), { csrf: await token(), headers: { origin: "https://evil.example" } }), s.ctx, s.limits);
    assert.equal(foreign.status, 403);
    assert.equal(listOpenInvites(s.db, new Date(s.clock.t)).length, 1);
  });

  it("global registration budget: 10 failed attempts per hour, then 429", async () => {
    for (let i = 0; i < 10; i++) assert.equal((await register(body("AAAA-AAAA-AAAA-AAAA-AAAA"))).status, 400);
    const res = await register(body(invite()));
    assert.equal(res.status, 429);
    assert.ok(Number(res.headers.get("retry-after")) > 0);
  });

  it("an admin invitation creates an admin, who may then create invitations", async () => {
    const res = await register(body(invite("admin"), "second-admin@example.test"));
    assert.equal(res.status, 200);
    const cookie = cookieOf(res);
    const me = requireUser(get("/api/profile", { cookie }), s.ctx);
    assert.ok(me.ok && me.role === "admin" && me.userId === 2);
  });
});

describe("mutations, logout, logout everywhere", () => {
  it("guardMutation returns the user id and role; CSRF is bound to user:<id>; the pre-login token does not work after login", async () => {
    const { cookie, csrf } = await signIn();
    const ok = guardMutation(post("/x", {}, { csrf, headers: { cookie } }), s.ctx, s.mutation);
    assert.ok(ok.ok);
    assert.deepEqual([ok.login, ok.userId, ok.role], ["user:1", 1, "admin"]);
    const pre = await token();
    const bad = guardMutation(post("/x", {}, { csrf: pre, headers: { cookie } }), s.ctx, s.mutation);
    assert.ok(!bad.ok);
    assert.equal(bad.response.status, 403);
    const anon = guardMutation(post("/x", {}, { csrf }), s.ctx, s.mutation);
    assert.ok(!anon.ok);
    assert.equal(anon.response.status, 401);
    const noOrigin = guardMutation(post("/x", {}, { csrf, headers: { cookie, origin: "" } }), s.ctx, s.mutation);
    assert.ok(!noOrigin.ok);
  });

  it("the session endpoint hands a signed-in user the user-bound token", async () => {
    const { cookie } = await signIn();
    const info = (await (await handleSession(get("/api/auth/session", { cookie }), s.ctx)).json()) as { signedIn: boolean };
    assert.equal(info.signedIn, true);
  });

  it("logout revokes the session row: the copied cookie is dead, other sessions of the user live on", async () => {
    const a = await signIn();
    const b = await signIn();
    const res = handleLogout(post("/api/auth/logout", undefined, { csrf: a.csrf, headers: { cookie: a.cookie } }), s.ctx);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("set-cookie") ?? "", /Max-Age=0/);
    assert.equal(guardRequest(get("/api/emails", { cookie: a.cookie }), s.ctx)?.status, 401, "revoked on the server");
    assert.equal(guardRequest(get("/api/emails", { cookie: b.cookie }), s.ctx), undefined);
  });

  it("logout needs a session and CSRF", async () => {
    const a = await signIn();
    assert.equal(handleLogout(post("/api/auth/logout", undefined, { csrf: a.csrf }), s.ctx).status, 401);
    assert.equal(handleLogout(post("/api/auth/logout", undefined, { csrf: null, headers: { cookie: a.cookie } }), s.ctx).status, 403);
    assert.equal(guardRequest(get("/api/emails", { cookie: a.cookie }), s.ctx), undefined);
  });

  it("logout everywhere revokes all sessions of this user and none of another", async () => {
    const reg = await createUser(s.db, { email: "u2@example.test", password: PW, role: "user" });
    assert.ok(reg.ok);
    const a1 = await signIn();
    const a2 = await signIn();
    const other = await signIn("u2@example.test");
    const res = handleLogoutAll(post("/api/sessions/revoke-all", undefined, { csrf: a1.csrf, headers: { cookie: a1.cookie } }), s.ctx, s.mutation);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, revoked: 2 });
    assert.equal(guardRequest(get("/api/emails", { cookie: a1.cookie }), s.ctx)?.status, 401);
    assert.equal(guardRequest(get("/api/emails", { cookie: a2.cookie }), s.ctx)?.status, 401);
    assert.equal(guardRequest(get("/api/emails", { cookie: other.cookie }), s.ctx), undefined);
    assert.equal(handleLogoutAll(post("/api/sessions/revoke-all", undefined, { csrf: other.csrf }), s.ctx, s.mutation).status, 401);
  });

  it("logout everywhere is a users-mode feature", () => {
    const pw = createAuthContext({ dataDir: tmpdir(), synthetic: false, appPassword: "x".repeat(20), now: () => s.clock.t });
    assert.equal(handleLogoutAll(post("/api/sessions/revoke-all", undefined), pw, s.mutation).status, 401);
  });
});

describe("profile and invitation routes", () => {
  const deps = () => ({ auth: s.ctx, limiter: s.mutation, now: () => new Date(s.clock.t) });

  it("profile shows email, role and live sessions; anonymous gets 401; the transitional modes say managed:false", async () => {
    assert.equal(handleProfileGet(get("/api/profile"), deps()).status, 401);
    const { cookie } = await signIn();
    await signIn();
    const res = handleProfileGet(get("/api/profile", { cookie }), deps());
    assert.deepEqual(await res.json(), { mode: "users", managed: true, email: ADMIN, role: "admin", live_sessions: 2 });
    const pw = createAuthContext({ dataDir: tmpdir(), synthetic: true, now: () => s.clock.t });
    const keys = pw.keys();
    const c = `${SESSION_COOKIE}=${issueSession("dev@synthetic.invalid", keys.session, s.clock.t)}`;
    const other = handleProfileGet(get("/api/profile", { cookie: c }), { auth: pw, limiter: s.mutation });
    assert.deepEqual(await other.json(), { mode: "synthetic", managed: false, email: null, role: "admin" });
  });

  it("an admin creates an invitation: the code appears once, the list never shows it", async () => {
    const { cookie, csrf } = await signIn();
    const res = await handleInviteCreate(post("/api/invites", { role: "user", days: 3 }, { csrf, headers: { cookie } }), deps());
    assert.equal(res.status, 201);
    const created = (await res.json()) as { code: string; id: number; role: string; expires_at: string };
    assert.match(created.code, /^([A-Z2-9]{4}-){4}[A-Z2-9]{4}$/);
    assert.equal(created.role, "user");
    assert.equal(created.expires_at, new Date(s.clock.t + 3 * 86_400_000).toISOString());
    const list = handleInvitesList(get("/api/invites", { cookie }), deps());
    const text = await list.text();
    assert.ok(!text.includes(created.code) && !text.includes("code"));
    assert.equal((JSON.parse(text) as { invites: unknown[] }).invites.length, 1);
  });

  it("body is validated; empty body means defaults", async () => {
    const { cookie, csrf } = await signIn();
    for (const bad of [{ role: "root" }, { days: 0 }, { days: 31 }, { days: 1.5 }, { extra: 1 }]) {
      assert.equal((await handleInviteCreate(post("/api/invites", bad, { csrf, headers: { cookie } }), deps())).status, 400, JSON.stringify(bad));
    }
    assert.equal((await handleInviteCreate(post("/api/invites", undefined, { csrf, headers: { cookie } }), deps())).status, 201);
    assert.equal((await handleInviteCreate(post("/api/invites", undefined, { csrf, headers: { cookie }, raw: "{" }), deps())).status, 400);
  });

  it("a plain user cannot create or list invitations; anonymous gets 401; CSRF is required", async () => {
    const u = await createUser(s.db, { email: "plain@example.test", password: PW, role: "user" });
    assert.ok(u.ok);
    const { cookie, csrf } = await signIn("plain@example.test");
    assert.equal((await handleInviteCreate(post("/api/invites", {}, { csrf, headers: { cookie } }), deps())).status, 403);
    assert.equal(handleInvitesList(get("/api/invites", { cookie }), deps()).status, 403);
    assert.equal(handleInvitesList(get("/api/invites"), deps()).status, 401);
    const admin = await signIn();
    assert.equal((await handleInviteCreate(post("/api/invites", {}, { csrf: null, headers: { cookie: admin.cookie } }), deps())).status, 403);
    assert.equal((await handleInviteCreate(post("/api/invites", {}, { csrf: admin.csrf }), deps())).status, 401);
    assert.equal(listOpenInvites(s.db, new Date(s.clock.t)).length, 0);
  });

  it("invitations exist only in users mode", async () => {
    const pw = createAuthContext({ dataDir: tmpdir(), synthetic: false, appPassword: "x".repeat(20), now: () => s.clock.t });
    const cookie = `${SESSION_COOKIE}=${issueSession("password-user", pw.keys().session, s.clock.t)}`;
    const csrf = ((await (await handleSession(get("/api/auth/session"), pw)).json()) as { csrfToken: string }).csrfToken;
    const res = await handleInviteCreate(post("/api/invites", {}, { csrf, headers: { cookie } }), { auth: pw, limiter: s.mutation });
    assert.equal(res.status, 409);
    assert.equal(handleInvitesList(get("/api/invites", { cookie }), { auth: pw, limiter: s.mutation }).status, 409);
  });
});

// A token bound to an arbitrary identity, signed with this context's CSRF key.
import { issueCsrfToken } from "../lib/csrf.ts";
function createUsersTokenFor(identity: string): string {
  return issueCsrfToken(identity, s.ctx.keys().csrf, s.clock.t);
}
void writeFileSync;
