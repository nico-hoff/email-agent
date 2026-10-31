import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../lib/db.ts";
import {
  countLiveSessions, createInvite, createSession, createUser, DEV_USER_EMAIL, DEV_USER_PASSWORD, ensureDevUser, findUserByEmail, getUser,
  INVITE_MAX_DAYS, listOpenInvites, newInviteCode, normalizeEmail, normalizeInviteCode, OWNER_USER_ID, registerWithInvite, revokeAllSessions,
  revokeSessionToken, setUserStatus, verifyLogin, verifySessionToken,
} from "../lib/users.ts";

const PW = "synthetic-test-password-1";
const T0 = new Date("2026-10-31T10:00:00.000Z");
const later = (ms: number) => new Date(T0.getTime() + ms);
const DAY = 86_400_000;

let dir: string;
let n = 0;
before(() => { dir = mkdtempSync(join(tmpdir(), "users-")); });
after(() => rmSync(dir, { recursive: true, force: true }));
const fresh = (): DatabaseSync => openDatabase(join(dir, `u${n++}.sqlite`));

describe("normalizers", () => {
  it("emails are trimmed and lower-cased; implausible ones are refused", () => {
    assert.equal(normalizeEmail("  Nico@Example.TEST "), "nico@example.test");
    for (const bad of ["", "a", "a@b", "a b@c.de", "@x.de", "a@@x.de", `${"a".repeat(250)}@x.de`, 5, null, undefined]) assert.equal(normalizeEmail(bad), null, String(bad));
  });

  it("invite codes: 5 groups of 4 from a look-alike-free alphabet; typed variants normalise", () => {
    const c = newInviteCode();
    assert.match(c, /^([A-HJ-NP-Z2-9]{4}-){4}[A-HJ-NP-Z2-9]{4}$/);
    assert.notEqual(c, newInviteCode());
    assert.equal(normalizeInviteCode(c.toLowerCase().replaceAll("-", " ")), c);
    for (const bad of ["", "ABCD", `${c}X`, c.replace(/^./, "0"), c.replace(/^./, "O"), 5, null]) assert.equal(normalizeInviteCode(bad), null, String(bad));
  });
});

describe("createUser", () => {
  it("the first admin claims the owner row (id 1): email, hash and status change, no new row", async () => {
    const db = fresh();
    const r = await createUser(db, { email: "Nico@Example.test", password: PW, now: T0 });
    assert.ok(r.ok);
    assert.equal(r.claimed, true);
    assert.deepEqual({ ...r.user }, { id: OWNER_USER_ID, email: "nico@example.test", role: "admin", status: "active", created_at: r.user.created_at });
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n, 1);
    const row = db.prepare("SELECT password_hash FROM users WHERE id = 1").get() as { password_hash: string };
    assert.match(row.password_hash, /^scrypt\$/);
    assert.ok(!row.password_hash.includes(PW));
  });

  it("existing data stays with the claimed owner", async () => {
    const db = fresh();
    db.exec(`INSERT INTO accounts (id,label,host,port,mailbox,user_id) VALUES ('a','A','h',993,'INBOX',1)`);
    const r = await createUser(db, { email: "nico@example.test", password: PW });
    assert.ok(r.ok && r.user.id === 1);
    assert.deepEqual({ ...db.prepare("SELECT user_id FROM accounts WHERE id='a'").get() }, { user_id: 1 });
  });

  it("later users are new rows; a user-role call never claims the owner row", async () => {
    const db = fresh();
    const u = await createUser(db, { email: "u@example.test", password: PW, role: "user" });
    assert.ok(u.ok);
    assert.equal(u.claimed, false);
    assert.equal(u.user.id, 2);
    assert.equal((db.prepare("SELECT status FROM users WHERE id = 1").get() as { status: string }).status, "unclaimed");
    const a = await createUser(db, { email: "a@example.test", password: PW });
    assert.ok(a.ok && a.claimed && a.user.id === 1);
    const b = await createUser(db, { email: "b@example.test", password: PW });
    assert.ok(b.ok && !b.claimed && b.user.id === 3);
  });

  it("refuses bad email, short password, taken email and unknown role; writes nothing", async () => {
    const db = fresh();
    assert.deepEqual(await createUser(db, { email: "nope", password: PW }), { ok: false, code: "invalid_email" });
    assert.deepEqual(await createUser(db, { email: "a@example.test", password: "short" }), { ok: false, code: "weak_password" });
    assert.deepEqual(await createUser(db, { email: "a@example.test", password: PW, role: "root" as never }), { ok: false, code: "invalid_role" });
    assert.equal((db.prepare("SELECT status FROM users WHERE id = 1").get() as { status: string }).status, "unclaimed");
    await createUser(db, { email: "a@example.test", password: PW });
    assert.deepEqual(await createUser(db, { email: "A@example.test", password: PW }), { ok: false, code: "email_taken" });
  });

  it("audit row carries ids and the role, never the email", async () => {
    const db = fresh();
    await createUser(db, { email: "secret-name@example.test", password: PW, now: T0 });
    const rows = db.prepare("SELECT action, user_id, details_json FROM audit_log").all() as { action: string; user_id: number; details_json: string }[];
    assert.deepEqual(rows.map((r) => [r.action, r.user_id]), [["user_created", 1]]);
    assert.ok(!JSON.stringify(rows).includes("secret-name"));
  });
});

describe("verifyLogin", () => {
  it("right credentials give the user; email case does not matter", async () => {
    const db = fresh();
    await createUser(db, { email: "nico@example.test", password: PW });
    assert.equal((await verifyLogin(db, "NICO@example.test", PW))?.id, 1);
  });

  it("wrong password, unknown email, malformed input, unclaimed owner and disabled user all give null", async () => {
    const db = fresh();
    assert.equal(await verifyLogin(db, "owner@unclaimed.invalid", PW), null, "unclaimed owner has no password");
    await createUser(db, { email: "a@example.test", password: PW });
    await createUser(db, { email: "b@example.test", password: PW });
    assert.equal(await verifyLogin(db, "a@example.test", "wrong-password-xx"), null);
    assert.equal(await verifyLogin(db, "who@example.test", PW), null);
    assert.equal(await verifyLogin(db, 5, PW), null);
    assert.equal(await verifyLogin(db, "a@example.test", undefined), null);
    setUserStatus(db, 2, "disabled");
    assert.equal(await verifyLogin(db, "b@example.test", PW), null);
    setUserStatus(db, 2, "active");
    assert.equal((await verifyLogin(db, "b@example.test", PW))?.id, 2);
  });

  it("results never contain the hash", async () => {
    const db = fresh();
    await createUser(db, { email: "a@example.test", password: PW });
    const u = await verifyLogin(db, "a@example.test", PW);
    assert.deepEqual(Object.keys(u!).sort(), ["created_at", "email", "id", "role", "status"]);
    assert.deepEqual(Object.keys(findUserByEmail(db, "a@example.test")!).sort(), ["created_at", "email", "id", "role", "status"]);
    assert.deepEqual(Object.keys(getUser(db, 1)!).sort(), ["created_at", "email", "id", "role", "status"]);
  });
});

describe("sessions", () => {
  async function withUser(): Promise<DatabaseSync> {
    const db = fresh();
    await createUser(db, { email: "a@example.test", password: PW });
    return db;
  }

  it("a created session verifies; only the SHA-256 of the token is stored", async () => {
    const db = await withUser();
    const s = createSession(db, 1, T0);
    assert.match(s.token, /^[A-Za-z0-9_-]{43}$/);
    const live = verifySessionToken(db, s.token, later(1000));
    assert.equal(live?.user.id, 1);
    const rows = db.prepare("SELECT id FROM user_sessions").all() as { id: string }[];
    assert.equal(rows.length, 1);
    assert.match(rows[0].id, /^[0-9a-f]{64}$/);
    assert.ok(!rows[0].id.includes(s.token));
  });

  it("unknown, malformed, expired, revoked and disabled-user sessions are rejected", async () => {
    const db = await withUser();
    const s = createSession(db, 1, T0, 1);
    assert.equal(verifySessionToken(db, "x".repeat(43), T0), null);
    assert.equal(verifySessionToken(db, "short", T0), null);
    assert.ok(verifySessionToken(db, s.token, later(DAY - 1)));
    assert.equal(verifySessionToken(db, s.token, later(DAY)), null, "expired at the expiry instant");
    const r = createSession(db, 1, T0);
    assert.equal(revokeSessionToken(db, r.token, later(5)), true);
    assert.equal(revokeSessionToken(db, r.token, later(6)), false, "second revoke changes nothing");
    assert.equal(verifySessionToken(db, r.token, later(10)), null);
    const d = createSession(db, 1, T0);
    setUserStatus(db, 1, "disabled", later(20));
    assert.equal(verifySessionToken(db, d.token, later(30)), null);
  });

  it("revokeAll ends every live session of that user only", async () => {
    const db = await withUser();
    await createUser(db, { email: "b@example.test", password: PW });
    const a1 = createSession(db, 1, T0);
    const a2 = createSession(db, 1, T0);
    const b1 = createSession(db, 2, T0);
    assert.equal(countLiveSessions(db, 1, later(1)), 2);
    assert.equal(revokeAllSessions(db, 1, later(2)), 2);
    assert.equal(verifySessionToken(db, a1.token, later(3)), null);
    assert.equal(verifySessionToken(db, a2.token, later(3)), null);
    assert.ok(verifySessionToken(db, b1.token, later(3)));
    assert.equal(countLiveSessions(db, 1, later(3)), 0);
  });

  it("last_used_at is refreshed sparingly", async () => {
    const db = await withUser();
    const s = createSession(db, 1, T0);
    const read = () => (db.prepare("SELECT last_used_at FROM user_sessions").get() as { last_used_at: string }).last_used_at;
    verifySessionToken(db, s.token, later(60_000));
    assert.equal(read(), T0.toISOString(), "within five minutes: no write");
    verifySessionToken(db, s.token, later(10 * 60_000));
    assert.equal(read(), later(10 * 60_000).toISOString());
  });

  it("old expired or revoked rows are cleaned up when a new session is created", async () => {
    const db = await withUser();
    createSession(db, 1, T0, 1);
    createSession(db, 1, later(30 * DAY));
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM user_sessions").get() as { n: number }).n, 1);
  });
});

describe("invitations", () => {
  async function withAdmin(): Promise<DatabaseSync> {
    const db = fresh();
    await createUser(db, { email: "admin@example.test", password: PW });
    return db;
  }

  it("stores only the hash; the code is returned once; open list has no code", async () => {
    const db = await withAdmin();
    const inv = createInvite(db, { createdBy: 1, now: T0 });
    assert.match(inv.code, /^([A-Z2-9]{4}-){4}[A-Z2-9]{4}$/);
    assert.equal(inv.expires_at, new Date(T0.getTime() + 7 * DAY).toISOString());
    const dump = JSON.stringify(db.prepare("SELECT * FROM invites").all());
    assert.ok(!dump.includes(inv.code) && !dump.includes(inv.code.replaceAll("-", "")));
    const open = listOpenInvites(db, later(1000));
    assert.deepEqual(open.map((o) => Object.keys(o).sort()), [["created_at", "expires_at", "id", "role"]]);
    assert.equal(listOpenInvites(db, later(8 * DAY)).length, 0, "expired invitations are not open");
  });

  it("bad role or duration is refused", async () => {
    const db = await withAdmin();
    assert.throws(() => createInvite(db, { createdBy: 1, role: "root" as never }));
    for (const days of [0, -1, INVITE_MAX_DAYS + 1, Number.NaN]) assert.throws(() => createInvite(db, { createdBy: 1, days }), String(days));
    assert.throws(() => createInvite(db, { createdBy: 99 }), "creator must exist");
  });

  it("registration consumes the code once and creates the user with the invite's role and a session-ready account", async () => {
    const db = await withAdmin();
    const inv = createInvite(db, { createdBy: 1, role: "user", now: T0 });
    const r = await registerWithInvite(db, { code: inv.code.toLowerCase(), email: "New@Example.test", password: PW, now: later(1000) });
    assert.ok(r.ok);
    assert.deepEqual({ email: r.user.email, role: r.user.role, status: r.user.status }, { email: "new@example.test", role: "user", status: "active" });
    assert.equal((await verifyLogin(db, "new@example.test", PW))?.id, r.user.id);
    const row = db.prepare("SELECT used_at, used_by FROM invites").get() as { used_at: string; used_by: number };
    assert.deepEqual({ ...row }, { used_at: later(1000).toISOString(), used_by: r.user.id });
    assert.equal(listOpenInvites(db, later(2000)).length, 0);
    const again = await registerWithInvite(db, { code: inv.code, email: "other@example.test", password: PW, now: later(2000) });
    assert.deepEqual(again, { ok: false, code: "invalid_invite" });
  });

  it("an admin invitation creates an admin", async () => {
    const db = await withAdmin();
    const inv = createInvite(db, { createdBy: 1, role: "admin" });
    const r = await registerWithInvite(db, { code: inv.code, email: "b@example.test", password: PW });
    assert.ok(r.ok && r.user.role === "admin");
  });

  it("wrong, malformed and expired codes give the same answer and create nothing", async () => {
    const db = await withAdmin();
    const inv = createInvite(db, { createdBy: 1, now: T0 });
    const usersBefore = (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
    for (const code of [newInviteCode(), "garbage", "", undefined, 7]) {
      assert.deepEqual(await registerWithInvite(db, { code, email: "x@example.test", password: PW, now: later(1) }), { ok: false, code: "invalid_invite" }, String(code));
    }
    assert.deepEqual(await registerWithInvite(db, { code: inv.code, email: "x@example.test", password: PW, now: later(7 * DAY) }), { ok: false, code: "invalid_invite" });
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n, usersBefore);
  });

  it("a refused registration (email taken, weak password, bad email) leaves the invitation unused", async () => {
    const db = await withAdmin();
    const inv = createInvite(db, { createdBy: 1, now: T0 });
    assert.deepEqual(await registerWithInvite(db, { code: inv.code, email: "admin@example.test", password: PW, now: later(1) }), { ok: false, code: "email_taken" });
    assert.deepEqual(await registerWithInvite(db, { code: inv.code, email: "x@example.test", password: "short", now: later(1) }), { ok: false, code: "weak_password" });
    assert.deepEqual(await registerWithInvite(db, { code: inv.code, email: "nope", password: PW, now: later(1) }), { ok: false, code: "invalid_email" });
    assert.equal(listOpenInvites(db, later(2)).length, 1);
    assert.ok((await registerWithInvite(db, { code: inv.code, email: "x@example.test", password: PW, now: later(3) })).ok);
  });

  it("parallel registrations with one code create exactly one account", async () => {
    const db = await withAdmin();
    const inv = createInvite(db, { createdBy: 1, now: T0 });
    const results = await Promise.all(
      [1, 2, 3, 4].map((i) => registerWithInvite(db, { code: inv.code, email: `p${i}@example.test`, password: PW, now: later(1000) })),
    );
    assert.equal(results.filter((r) => r.ok).length, 1);
    assert.equal(results.filter((r) => !r.ok && r.code === "invalid_invite").length, 3);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n, 2);
  });

  it("audit rows carry ids and roles only", async () => {
    const db = await withAdmin();
    const inv = createInvite(db, { createdBy: 1, now: T0 });
    await registerWithInvite(db, { code: inv.code, email: "private@example.test", password: PW, now: later(1) });
    const rows = db.prepare("SELECT action FROM audit_log ORDER BY id").all() as { action: string }[];
    assert.deepEqual(rows.map((r) => r.action), ["user_created", "invite_created", "user_created", "invite_used"]);
    const dump = JSON.stringify(db.prepare("SELECT * FROM audit_log").all());
    assert.ok(!dump.includes("private@") && !dump.includes(inv.code));
  });
});

describe("synthetic dev user", () => {
  it("claims the unclaimed owner once; a claimed owner is left alone", async () => {
    const db = fresh();
    assert.equal(await ensureDevUser(db), true);
    assert.equal(getUser(db, 1)?.email, DEV_USER_EMAIL);
    assert.equal((await verifyLogin(db, DEV_USER_EMAIL, DEV_USER_PASSWORD))?.id, 1);
    assert.equal(await ensureDevUser(db), false);
    const other = fresh();
    await createUser(other, { email: "real@example.test", password: PW });
    assert.equal(await ensureDevUser(other), false);
    assert.equal(getUser(other, 1)?.email, "real@example.test");
  });
});
