// R2: mailboxes in the database. Synthetic data only; no network (fake connector, fake worker factory).
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { loadKeyring, generateKey } from "../lib/account-secrets.ts";
import { createAccountSupervisor } from "../lib/account-supervisor.ts";
import type { AccountConfig } from "../lib/accounts-config.ts";
import { startup } from "../lib/accounts.ts";
import { classifyError, testConnection, type TestPort } from "../lib/connection-test.ts";
import { openDatabase } from "../lib/db.ts";
import {
  createMailAccount, getAccountView, hostProblem, importLegacyAccounts, listAccountViews, loadConnection, loadWorkerAccounts, newAccountId,
  rekeyAll, setAccountEnabled, updateMailAccount, type CreateAccountInput,
} from "../lib/mail-accounts.ts";
import { createUser } from "../lib/users.ts";

const PW = "synthetic-password-XYZ-123";
const NOW = new Date("2026-10-31T10:00:00.000Z");
const KEY = generateKey();
const keys = loadKeyring({ ACCOUNTS_ENCRYPTION_KEY: KEY });
const none = loadKeyring({});
let dir: string;
let n = 0;
const fresh = (): DatabaseSync => openDatabase(join(dir, `t${n++}.sqlite`));
const imap = (over: Partial<CreateAccountInput> = {}): CreateAccountInput => ({ type: "imap", label: "Privat", username: "me@example.test", password: PW, host: "imap.example.test", port: 993, tls: true, ...over });

before(() => { dir = mkdtempSync(join(tmpdir(), "r2-accounts-")); chmodSync(dir, 0o700); });
after(() => rmSync(dir, { recursive: true, force: true }));

describe("host policy", () => {
  it("accepts public names and public IP literals", () => {
    for (const h of ["imap.example.com", "mail.example.co.uk", "8.8.8.8", "2606:4700:4700::1111", "[2606:4700:4700::1111]"]) assert.equal(hostProblem(h, false), null, h);
  });
  it("rejects URLs, ports, spaces, shorthands, single labels", () => {
    for (const h of ["", " ", "imap.example.com:993", "https://imap.example.com", "imap example.com", "user@host.example", "localhostx", "127.1", "0x7f.0.0.1", "2130706433", "a/b.example", "-bad.example.com"]) {
      assert.notEqual(hostProblem(h, false), null, JSON.stringify(h));
    }
  });
  it("blocks loopback, private, link-local, CGNAT, ULA and local names; the env switch lifts it", () => {
    for (const h of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "localhost", "nas.local", "mail.internal", "x.lan"]) {
      assert.equal(hostProblem(h, false), "host_not_allowed", h);
      assert.equal(hostProblem(h, true), null, h);
    }
    assert.equal(hostProblem("172.32.0.1", false), null);
  });
});

describe("create, view, update", () => {
  it("creates with a server-generated id, off mode, encrypted secret; the view carries no secret", () => {
    const db = fresh();
    const r = createMailAccount(db, 1, keys, imap(), { now: NOW });
    assert.ok(r.ok);
    assert.match(r.id, /^a_[0-9a-f]{16}$/);
    const v = getAccountView(db, 1, r.id)!;
    assert.equal(v.managed, true);
    assert.equal(v.secret_set, true);
    assert.equal(v.secret_set_at, NOW.toISOString());
    assert.equal(v.spam_seen_mode, "off");
    assert.equal(v.worker?.state, "connecting");
    assert.ok(!JSON.stringify(v).includes(PW));
    const raw = db.prepare("SELECT * FROM mail_accounts").get() as Record<string, unknown>;
    assert.ok(!Buffer.from(raw.secret_ciphertext as Uint8Array).toString("latin1").includes(PW));
    assert.equal(db.prepare("SELECT action, details_json FROM audit_log WHERE action = 'account_created'").all().length, 1);
    assert.ok(!JSON.stringify(db.prepare("SELECT * FROM audit_log").all()).includes(PW));
  });
  it("ids are unique and never chosen by the caller", () => {
    assert.notEqual(newAccountId(), newAccountId());
    const db = fresh();
    const a = createMailAccount(db, 1, keys, imap());
    const b = createMailAccount(db, 1, keys, imap());
    assert.ok(a.ok && b.ok && a.id !== b.id);
  });
  it("google preset: host, port, TLS and spam folder are fixed; spaces in the app password are dropped", () => {
    const db = fresh();
    const r = createMailAccount(db, 1, keys, { type: "google", label: "G", username: "me@gmail.test", password: "abcd efgh ijkl mnop", host: "evil.example.test", port: 25, tls: false });
    assert.ok(r.ok);
    const v = getAccountView(db, 1, r.id)!;
    assert.deepEqual([v.host, v.port, v.tls, v.mailbox, v.spam_mailbox], ["imap.gmail.com", 993, true, "INBOX", "[Gmail]/Spam"]);
    const c = loadConnection(db, 1, r.id, keys.ok ? keys.keyring : (undefined as never));
    assert.ok(typeof c === "object" && c !== null && c.password === "abcdefghijklmnop");
  });
  it("without a usable key: refused, nothing stored", () => {
    const db = fresh();
    assert.deepEqual(createMailAccount(db, 1, none, imap()), { ok: false, code: "no_encryption_key" });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM accounts").get()!.n, 0);
  });
  it("bad host and bad secret are refused before anything is written", () => {
    const db = fresh();
    assert.deepEqual(createMailAccount(db, 1, keys, imap({ host: "127.0.0.1" })), { ok: false, code: "host_not_allowed" });
    assert.deepEqual(createMailAccount(db, 1, keys, imap({ host: "a b" })), { ok: false, code: "invalid_host" });
    assert.deepEqual(createMailAccount(db, 1, keys, imap({ password: "a\nb" })), { ok: false, code: "invalid_secret" });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM accounts").get()!.n, 0);
  });
  it("update without a password keeps the secret; with a password replaces it and clears the last test; works without a key when no secret changes", () => {
    const db = fresh();
    const r = createMailAccount(db, 1, keys, imap());
    assert.ok(r.ok);
    const before = db.prepare("SELECT secret_ciphertext, secret_nonce, secret_set_at FROM mail_accounts").get()!;
    db.exec("UPDATE mail_accounts SET last_test_code = 'ok', last_test_at = '2026-10-31T00:00:00.000Z'");
    const u = updateMailAccount(db, 1, r.id, none, { label: "Neu", context: "Familie" }, { now: new Date(NOW.getTime() + 1000) });
    assert.deepEqual(u, { ok: true, secretChanged: false });
    const after1 = db.prepare("SELECT secret_ciphertext, secret_nonce, secret_set_at, last_test_code FROM mail_accounts").get()!;
    assert.deepEqual(Buffer.from(after1.secret_ciphertext as Uint8Array), Buffer.from(before.secret_ciphertext as Uint8Array));
    assert.equal(after1.last_test_code, "ok");
    assert.equal(getAccountView(db, 1, r.id)!.label, "Neu");
    assert.deepEqual(updateMailAccount(db, 1, r.id, none, { password: "another-pass" }), { ok: false, code: "no_encryption_key" });
    assert.deepEqual(updateMailAccount(db, 1, r.id, keys, { password: "" }), { ok: true, secretChanged: false });
    assert.deepEqual(updateMailAccount(db, 1, r.id, keys, { password: "another-pass" }, { now: new Date(NOW.getTime() + 5000) }), { ok: true, secretChanged: true });
    const after2 = db.prepare("SELECT secret_set_at, last_test_code FROM mail_accounts").get()!;
    assert.equal(after2.last_test_code, null);
    assert.notEqual(after2.secret_set_at, before.secret_set_at);
    const c = loadConnection(db, 1, r.id, keys.ok ? keys.keyring : (undefined as never));
    assert.ok(typeof c === "object" && c !== null && c.password === "another-pass");
  });
  it("tenant scope: another user's id is not_found and nothing changes", async () => {
    const db = fresh();
    assert.ok((await createUser(db, { email: "b@example.test", password: "isolation-test-password", role: "user" })).ok);
    const r = createMailAccount(db, 1, keys, imap());
    assert.ok(r.ok);
    const snap = JSON.stringify(db.prepare("SELECT * FROM accounts").all()) + JSON.stringify(db.prepare("SELECT * FROM mail_accounts").all());
    assert.deepEqual(updateMailAccount(db, 2, r.id, keys, { label: "x" }), { ok: false, code: "not_found" });
    assert.equal(setAccountEnabled(db, 2, r.id, false), "not_found");
    assert.equal(getAccountView(db, 2, r.id), null);
    assert.deepEqual(listAccountViews(db, 2), []);
    assert.equal(loadConnection(db, 2, r.id, keys.ok ? keys.keyring : (undefined as never)), null);
    assert.equal(JSON.stringify(db.prepare("SELECT * FROM accounts").all()) + JSON.stringify(db.prepare("SELECT * FROM mail_accounts").all()), snap);
  });
  it("accounts without credentials row (demo data) are listed as not managed and cannot be updated", () => {
    const db = fresh();
    db.exec("INSERT INTO accounts (id,label,host,port,mailbox,user_id) VALUES ('demo','Demo','h.example',993,'INBOX',1)");
    const v = getAccountView(db, 1, "demo")!;
    assert.deepEqual([v.managed, v.type, v.secret_set, v.username], [false, null, false, null]);
    assert.deepEqual(updateMailAccount(db, 1, "demo", keys, { label: "x" }), { ok: false, code: "not_managed" });
  });
});

describe("worker accounts and rotation", () => {
  it("loads enabled accounts of all users with the decrypted secret in the AccountConfig shape; disabled and unreadable ones are left out", async () => {
    const db = fresh();
    assert.ok((await createUser(db, { email: "b@example.test", password: "isolation-test-password", role: "user" })).ok);
    const a = createMailAccount(db, 1, keys, imap({ label: "A", context: "ctx a" }));
    const b = createMailAccount(db, 2, keys, imap({ label: "B" }));
    const off = createMailAccount(db, 1, keys, imap({ label: "Off" }));
    assert.ok(a.ok && b.ok && off.ok);
    setAccountEnabled(db, 1, off.id, false);
    const ring = keys.ok ? keys.keyring : (undefined as never);
    const w = loadWorkerAccounts(db, ring);
    assert.deepEqual(w.accounts.map((x) => x.label), ["A", "B"]);
    assert.equal(w.accounts[0]!.password, PW);
    assert.equal(w.accounts[0]!.context, "ctx a");
    assert.deepEqual(w.accounts[0]!.auto_actions, { spam_seen: "off" });
    // wrong key -> unreadable, not started
    const other = loadKeyring({ ACCOUNTS_ENCRYPTION_KEY: generateKey() });
    const w2 = loadWorkerAccounts(db, other.ok ? other.keyring : (undefined as never));
    assert.deepEqual([w2.accounts.length, w2.unreadable.length], [0, 2]);
  });
  it("a ciphertext moved to another account does not decrypt (AAD)", () => {
    const db = fresh();
    const a = createMailAccount(db, 1, keys, imap({ label: "A" }));
    const b = createMailAccount(db, 1, keys, imap({ label: "B" }));
    assert.ok(a.ok && b.ok);
    db.prepare("UPDATE mail_accounts SET secret_ciphertext = (SELECT secret_ciphertext FROM mail_accounts WHERE account_id = ?), secret_nonce = (SELECT secret_nonce FROM mail_accounts WHERE account_id = ?), secret_tag = (SELECT secret_tag FROM mail_accounts WHERE account_id = ?) WHERE account_id = ?").run(a.id, a.id, a.id, b.id);
    const w = loadWorkerAccounts(db, keys.ok ? keys.keyring : (undefined as never));
    assert.deepEqual(w.accounts.map((x) => x.label), ["A"]);
    assert.deepEqual(w.unreadable, [b.id]);
  });
  it("rekey: everything moves to the current key in one transaction; a failure changes nothing", () => {
    const db = fresh();
    const oldKey = generateKey();
    const oldRing = loadKeyring({ ACCOUNTS_ENCRYPTION_KEY: oldKey });
    assert.ok(createMailAccount(db, 1, oldRing, imap({ label: "A" })).ok && createMailAccount(db, 1, oldRing, imap({ label: "B" })).ok);
    const rotating = loadKeyring({ ACCOUNTS_ENCRYPTION_KEY: KEY, ACCOUNTS_ENCRYPTION_KEY_OLD: oldKey });
    assert.ok(rotating.ok && oldRing.ok);
    // one unreadable secret aborts the whole run
    db.exec(`UPDATE mail_accounts SET key_id = '${"b".repeat(16)}' WHERE account_id = (SELECT account_id FROM mail_accounts ORDER BY account_id DESC LIMIT 1)`);
    const snap = JSON.stringify(db.prepare("SELECT * FROM mail_accounts ORDER BY account_id").all().map((r) => ({ ...r, secret_ciphertext: Buffer.from(r.secret_ciphertext as Uint8Array).toString("hex") })));
    assert.throws(() => rekeyAll(db, rotating.keyring));
    assert.equal(JSON.stringify(db.prepare("SELECT * FROM mail_accounts ORDER BY account_id").all().map((r) => ({ ...r, secret_ciphertext: Buffer.from(r.secret_ciphertext as Uint8Array).toString("hex") }))), snap);
    db.exec(`UPDATE mail_accounts SET key_id = '${oldRing.keyring.current.id}'`);
    assert.equal(rekeyAll(db, rotating.keyring), 2);
    const only = loadKeyring({ ACCOUNTS_ENCRYPTION_KEY: KEY });
    assert.equal(loadWorkerAccounts(db, only.ok ? only.keyring : (undefined as never)).accounts.length, 2);
  });
});

describe("legacy accounts file import", () => {
  const entry = (id: string, over: Record<string, unknown> = {}) => ({
    id, label: `L-${id}`, color: "#10B981", context: "legacy ctx", host: "imap.legacy.example", port: 993, tls: true, user: `u-${id}`, password: `pw-${id}-synthetic`,
    mailbox: "INBOX", spam_mailbox: "Junk", spam_threshold: 0.9, enabled: true, ...over,
  });
  function project(accounts: unknown): string {
    const root = mkdtempSync(join(dir, "root-"));
    mkdirSync(join(root, "data"), { mode: 0o700 });
    const f = join(root, "data", "accounts.json");
    writeFileSync(f, JSON.stringify(accounts));
    chmodSync(f, 0o600);
    return root;
  }

  it("imports once: owner user, encrypted secrets, file modes kept, marker; never reads the file again", () => {
    const root = project([entry("one", { auto_actions: { spam_seen: "live" } }), entry("two", { enabled: false }), entry("three", { host: "imap.gmail.com" })]);
    const db = fresh();
    const env = { ACCOUNTS_ENCRYPTION_KEY: KEY };
    const r = importLegacyAccounts(db, { env, projectRoot: root, keys, now: NOW });
    assert.deepEqual(r, { status: "imported", count: 3 });
    const v = listAccountViews(db, 1);
    assert.deepEqual(v.map((x) => [x.id, x.type, x.enabled, x.spam_seen_mode, x.color]), [
      ["one", "imap", true, "live", "#10b981"], ["two", "imap", false, "dry_run", "#10b981"], ["three", "google", true, "dry_run", "#10b981"],
    ]);
    assert.equal(db.prepare("SELECT context, spam_threshold FROM mail_accounts WHERE account_id = 'one'").get()!.context, "legacy ctx");
    assert.equal(db.prepare("SELECT spam_threshold FROM mail_accounts WHERE account_id = 'one'").get()!.spam_threshold, 0.9);
    const w = loadWorkerAccounts(db, keys.ok ? keys.keyring : (undefined as never));
    assert.deepEqual(w.accounts.map((a) => [a.id, a.user, a.password]), [["one", "u-one", "pw-one-synthetic"], ["three", "u-three", "pw-three-synthetic"]]);
    assert.ok(!JSON.stringify(db.prepare("SELECT * FROM mail_accounts").all().map((r) => Buffer.from(r.secret_ciphertext as Uint8Array).toString("latin1"))).includes("pw-one"));
    // idempotent, and the file is gone from the picture: even a broken or deleted file is not touched any more
    writeFileSync(join(root, "data", "accounts.json"), "{ not json");
    assert.deepEqual(importLegacyAccounts(db, { env, projectRoot: root, keys }), { status: "already_imported" });
    rmSync(join(root, "data", "accounts.json"));
    assert.deepEqual(importLegacyAccounts(db, { env, projectRoot: root, keys }), { status: "already_imported" });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM mail_accounts").get()!.n, 3);
  });
  it("without a key nothing is read or imported and no marker is set (the file is picked up after the key is set)", () => {
    const root = project([entry("one")]);
    const db = fresh();
    assert.deepEqual(importLegacyAccounts(db, { env: {}, projectRoot: root, keys: none }), { status: "no_key" });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM accounts").get()!.n, 0);
    assert.deepEqual(importLegacyAccounts(db, { env: {}, projectRoot: root, keys }), { status: "imported", count: 1 });
  });
  it("no file: nothing to do", () => {
    const root = mkdtempSync(join(dir, "root-"));
    assert.deepEqual(importLegacyAccounts(fresh(), { env: {}, projectRoot: root, keys }), { status: "no_file" });
  });
  it("an invalid file fails with field names only and imports nothing", () => {
    const root = project([{ ...entry("one"), port: 0, password: "TOPSECRET-SYNTHETIC" }]);
    const db = fresh();
    assert.throws(() => importLegacyAccounts(db, { env: {}, projectRoot: root, keys }), (e: Error) => /invalid fields/.test(e.message) && !e.message.includes("TOPSECRET"));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM accounts").get()!.n, 0);
  });
  it("a group-readable file is refused as before", () => {
    const root = project([entry("one")]);
    chmodSync(join(root, "data", "accounts.json"), 0o644);
    assert.throws(() => importLegacyAccounts(fresh(), { env: {}, projectRoot: root, keys }), /0600/);
  });
  it("startup imports automatically when the key is set", () => {
    const root = project([entry("one")]);
    const s = startup({ env: { ACCOUNTS_ENCRYPTION_KEY: KEY, DATABASE_PATH: join(root, "data", "app.sqlite") }, projectRoot: root });
    assert.equal(s.legacyImport.status, "imported");
    assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM mail_accounts").get()!.n, 1);
    s.db.close();
  });
});

describe("account supervisor", () => {
  function harness(env: Record<string, string | undefined>) {
    const db = fresh();
    const live: AccountConfig[] = [];
    const events: string[] = [];
    const sup = createAccountSupervisor({
      db, env, accounts: live, now: () => NOW,
      startWorker: (a) => { events.push(`start:${a.label}`); return { stop: async () => { events.push(`stop:${a.label}`); } }; },
      setInterval: () => 0, clearInterval: () => {},
    });
    return { db, live, events, sup };
  }
  const env = { ACCOUNTS_ENCRYPTION_KEY: KEY };
  const state = (db: DatabaseSync, id: string) => ({ ...db.prepare("SELECT state, error_code FROM worker_status WHERE account_id = ?").get(id)! });

  it("starts workers for enabled accounts, stops them on disable, restarts on a connection change, leaves others alone", async () => {
    const h = harness(env);
    const a = createMailAccount(h.db, 1, keys, imap({ label: "A" }));
    const b = createMailAccount(h.db, 1, keys, imap({ label: "B" }));
    assert.ok(a.ok && b.ok);
    await h.sup.reconcile();
    assert.deepEqual(h.events, ["start:A", "start:B"]);
    assert.deepEqual(h.live.map((x) => x.label), ["A", "B"]);
    await h.sup.reconcile();
    assert.equal(h.events.length, 2, "nothing changed, nothing restarted");
    // context/label change applies in place, no restart
    updateMailAccount(h.db, 1, a.id, keys, { context: "neu", label: "A2" });
    await h.sup.reconcile();
    assert.equal(h.events.length, 2);
    assert.deepEqual(h.live.map((x) => [x.label, x.context]), [["A2", "neu"], ["B", ""]]);
    // host change restarts only that worker
    updateMailAccount(h.db, 1, a.id, keys, { host: "imap.other.example" });
    await h.sup.reconcile();
    assert.deepEqual(h.events.slice(2), ["stop:A", "start:A2"]);
    // password change restarts too
    updateMailAccount(h.db, 1, b.id, keys, { password: "new-password-1" });
    await h.sup.reconcile();
    assert.deepEqual(h.events.slice(-2), ["stop:B", "start:B"]);
    // disable
    setAccountEnabled(h.db, 1, a.id, false, NOW);
    await h.sup.reconcile();
    assert.deepEqual(h.sup.running(), [b.id]);
    assert.deepEqual(h.live.map((x) => x.label), ["B"]);
    assert.equal(state(h.db, a.id).state, "disabled");
    // enable again
    setAccountEnabled(h.db, 1, a.id, true, NOW);
    await h.sup.reconcile();
    assert.deepEqual(h.sup.running().sort(), [a.id, b.id].sort());
    await h.sup.stop();
    assert.deepEqual(h.sup.running(), []);
  });
  it("fail-closed without a key: no worker starts, every enabled account shows no_encryption_key", async () => {
    const h = harness({});
    const a = createMailAccount(h.db, 1, keys, imap());
    assert.ok(a.ok);
    await h.sup.reconcile();
    assert.deepEqual(h.events, []);
    assert.deepEqual(state(h.db, a.id), { state: "paused", error_code: "no_encryption_key" });
    const bad = harness({ ACCOUNTS_ENCRYPTION_KEY: "not-a-key" });
    const b = createMailAccount(bad.db, 1, keys, imap());
    assert.ok(b.ok);
    await bad.sup.reconcile();
    assert.deepEqual(bad.events, []);
    assert.equal(state(bad.db, b.id).error_code, "no_encryption_key");
  });
  it("losing the key stops running workers", async () => {
    const e: Record<string, string | undefined> = { ...env };
    const h = harness(e);
    const a = createMailAccount(h.db, 1, keys, imap());
    assert.ok(a.ok);
    await h.sup.reconcile();
    assert.deepEqual(h.sup.running(), [a.id]);
    delete e.ACCOUNTS_ENCRYPTION_KEY;
    await h.sup.reconcile();
    assert.deepEqual(h.sup.running(), []);
    assert.deepEqual(h.live, []);
    assert.equal(state(h.db, a.id).error_code, "no_encryption_key");
  });
  it("an account with an unreadable secret does not start and shows secret_unreadable; others still run", async () => {
    const h = harness(env);
    const a = createMailAccount(h.db, 1, keys, imap({ label: "A" }));
    const b = createMailAccount(h.db, 1, keys, imap({ label: "B" }));
    assert.ok(a.ok && b.ok);
    h.db.prepare("UPDATE mail_accounts SET secret_tag = x'00000000000000000000000000000000' WHERE account_id = ?").run(a.id);
    await h.sup.reconcile();
    assert.deepEqual(h.events, ["start:B"]);
    assert.deepEqual(state(h.db, a.id), { state: "paused", error_code: "secret_unreadable" });
  });
  it("accounts without credentials row never start; a failing worker factory pauses only that account", async () => {
    const db = fresh();
    db.exec("INSERT INTO accounts (id,label,host,port,mailbox,user_id) VALUES ('demo','Demo','h.example',993,'INBOX',1)");
    const live: AccountConfig[] = [];
    const sup = createAccountSupervisor({ db, env, accounts: live, startWorker: () => { throw new Error("boom"); }, setInterval: () => 0, clearInterval: () => {} });
    const a = createMailAccount(db, 1, keys, imap());
    assert.ok(a.ok);
    await sup.reconcile();
    assert.deepEqual(live, []);
    assert.deepEqual(state(db, a.id), { state: "paused", error_code: "start_failed" });
  });
});

describe("connection test", () => {
  const target = { host: "imap.example.test", port: 993, tls: true, user: "u", password: PW, mailbox: "INBOX", spam_mailbox: "Junk" };
  function port(o: { connect?: () => Promise<void>; list?: () => Promise<{ path: string }[]> }): { make: () => TestPort; closed: () => number; cfg: () => unknown } {
    let closed = 0;
    let cfg: unknown;
    return {
      closed: () => closed,
      cfg: () => cfg,
      make: () => ({
        connect: o.connect ?? (async () => {}),
        listFolders: (o.list ?? (async () => [{ path: "INBOX" }, { path: "Junk" }])) as never,
        close: async () => { closed++; },
        on: () => {},
      }),
    };
  }
  it("ok when connected and both folders exist; the port is closed; only LIST is used", async () => {
    const p = port({});
    assert.equal(await testConnection(target, (c) => { return p.make(); }), "ok");
    assert.equal(p.closed(), 1);
  });
  it("mailbox_missing when a configured folder is not on the server", async () => {
    assert.equal(await testConnection(target, () => port({ list: async () => [{ path: "INBOX" }] }).make()), "mailbox_missing");
  });
  it("error classes", async () => {
    const cases: [unknown, string][] = [
      [{ authenticationFailed: true }, "auth_failed"], [{ code: "ENOTFOUND" }, "host_unreachable"], [{ code: "ECONNREFUSED" }, "host_unreachable"],
      [{ code: "CONNECT_TIMEOUT" }, "timeout"], [{ code: "ETIMEDOUT" }, "timeout"], [{ code: "DEPTH_ZERO_SELF_SIGNED_CERT" }, "tls_failed"],
      [{ code: "ERR_TLS_CERT_ALTNAME_INVALID" }, "tls_failed"], [{ code: "EPROTO" }, "tls_failed"], [new Error("weird"), "connect_failed"], [null, "connect_failed"],
    ];
    for (const [err, code] of cases) {
      assert.equal(classifyError(err), code);
      const p = port({ connect: async () => { throw err; } });
      assert.equal(await testConnection(target, () => p.make()), code);
      assert.equal(p.closed(), 1, "closed after a failure too");
    }
  });
  it("times out on a connector that never answers", async () => {
    const p = port({ connect: () => new Promise<void>(() => {}) });
    assert.equal(await testConnection(target, () => p.make(), 20), "timeout");
  });
  it("a throwing connector is classified, not thrown", async () => {
    assert.equal(await testConnection(target, () => { throw Object.assign(new Error("x"), { code: "ENOTFOUND" }); }), "host_unreachable");
  });
});
