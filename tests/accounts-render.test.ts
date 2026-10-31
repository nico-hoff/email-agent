// R2 UI: "Konten verwalten" renders from state, never shows a secret, and the client maps the API correctly.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { loadTsx } from "./helpers/load-tsx.ts";
import {
  bodyFromForm, emptyForm, fetchAccounts, formFromItem, postAccountEnabled, postCreateAccount, postTestAccount, postUpdateAccount, workerText,
  type AccountItem, type AccountsData,
} from "../lib/accounts-client.ts";

type Profile = typeof import("../components/profile.tsx");
const { ProfileView } = await loadTsx<Profile>("components/profile.tsx");
const html = (el: unknown): string => renderToStaticMarkup(el as Parameters<typeof renderToStaticMarkup>[0]);
const item = (over: Partial<AccountItem> = {}): AccountItem => ({
  id: "a_0123456789abcdef", managed: true, type: "imap", label: "Privat", color: "#10b981", host: "imap.example.test", port: 993, tls: true,
  username: "me@example.test", mailbox: "INBOX", spam_mailbox: "Junk", enabled: true, context: "", secret_set: true, secret_set_at: "2026-10-31T09:00:00.000Z",
  last_test_at: "2026-10-31T09:05:00.000Z", last_test_code: "ok", worker: { state: "connected", error_code: null, last_poll_at: null }, ...over,
});
const data = (accounts: AccountItem[], ready = true): AccountsData => ({ accounts, encryptionReady: ready, synthetic: false });
const admin = { mode: "users", managed: true, email: "admin@example.test", role: "admin" as const, live_sessions: 1 };
const sect = (over: Record<string, unknown> = {}) => ({ data: data([item()]), editor: null, busy: false, testing: null, testResults: {}, formError: null, timeZone: "UTC", ...over });
const view = (accounts: Record<string, unknown>): string =>
  html(ProfileView({ profile: admin, invites: [], loading: false, error: null, busy: false, created: null, notice: null, inviteRole: "user", timeZone: "UTC", accounts: sect(accounts) } as never));

describe("accounts section", () => {
  it("lists label, color tag, type, worker status, last test, and since when a password is stored; never a password", () => {
    const out = view({});
    assert.match(out, /Konten verwalten/);
    assert.match(out, /Privat/);
    assert.match(out, /background:#10b981/);
    assert.match(out, />IMAP</);
    assert.match(out, />Verbunden</);
    assert.match(out, /Test ok/);
    assert.match(out, /Passwort gespeichert seit 31\.10\.2026, 09:00/);
    assert.match(out, />Verbindung testen</);
    assert.match(out, />Deaktivieren</);
    assert.doesNotMatch(out, /type="password"/, "no password field in the list");
  });
  it("states: empty, disabled account offers Aktivieren, paused without key, demo account has no actions", () => {
    assert.match(view({ data: data([]) }), /Noch kein Konto/);
    assert.match(view({ data: data([item({ enabled: false, worker: null })]) }), />Deaktiviert<[\s\S]*>Aktivieren</);
    const paused = view({ data: data([item({ worker: { state: "paused", error_code: "no_encryption_key", last_poll_at: null } })]) });
    assert.match(paused, /Angehalten: Schlüssel fehlt/);
    const demo = view({ data: data([item({ managed: false, type: null, username: null, secret_set: false, secret_set_at: null, last_test_code: null, worker: null })]) });
    assert.match(demo, />Demo</);
    assert.match(demo, /Keine gespeicherten Zugangsdaten/);
    assert.doesNotMatch(demo, /Verbindung testen/);
  });
  it("without encryption key: warning and the add button is disabled", () => {
    const out = view({ data: data([], false) });
    assert.match(out, /ACCOUNTS_ENCRYPTION_KEY/);
    assert.match(out, /<button[^>]*disabled=""[^>]*>Konto hinzufügen</);
  });
  it("test result and busy state", () => {
    const out = view({ testResults: { a_0123456789abcdef: "auth_failed" }, testing: null });
    assert.match(out, /Anmeldung abgelehnt/);
    assert.match(out, /notice-error/);
    assert.match(view({ testing: "a_0123456789abcdef" }), /Teste …/);
  });
  it("add form with the Google preset: hint about App-Passwörter, fixed server text, no host or port field", () => {
    const out = view({ editor: { id: null, form: emptyForm("google") } });
    assert.match(out, /App-Passwort/);
    assert.match(out, /imap\.gmail\.com, Port 993, TLS an/);
    assert.doesNotMatch(out, /id="acct-host"/);
    assert.match(out, /value="\[Gmail\]\/Spam"/);
    assert.match(out, /type="password"[^>]*value=""/);
  });
  it("IMAP form shows host, port, TLS; TLS off warns", () => {
    const f = emptyForm("imap");
    assert.match(view({ editor: { id: null, form: f } }), /id="acct-host"/);
    assert.match(view({ editor: { id: null, form: { ...f, tls: false } } }), /unverschlüsselt/);
  });
  it("edit form is never prefilled with a password and says that empty keeps it", () => {
    const out = view({ editor: { id: "a_0123456789abcdef", form: formFromItem(item({ context: "Familie" })) } });
    assert.match(out, /id="acct-pass"[^>]*value=""/);
    assert.match(out, /behalten/);
    assert.match(out, /Familie/);
    assert.match(out, /Änderungen speichern/);
    assert.doesNotMatch(out, /Art des Kontos/, "the type cannot change");
  });
  it("form error is an alert", () => {
    assert.match(view({ editor: { id: null, form: emptyForm("imap") }, formError: "Der Servername ist ungültig." }), /role="alert"[^>]*>Der Servername/);
  });
  it("source keeps secrets out of browser storage", () => {
    const src = ["components/accounts-manager.tsx", "lib/accounts-client.ts", "app/profil/page.tsx"].map((f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8")).join("\n");
    assert.doesNotMatch(src, /localStorage|sessionStorage|indexedDB/);
  });
});

describe("accounts client", () => {
  const res = (status: number, body: unknown = {}, headers: Record<string, string> = {}) => Response.json(body, { status, headers });
  const deps = (r: Response, seen: { path?: string; body?: string }[] = []) => ({
    fetch: (async (url: string, init?: RequestInit) => {
      if (url === "/api/auth/session") return res(200, { csrfToken: "t" });
      seen.push({ path: url, body: typeof init?.body === "string" ? init.body : undefined });
      return r;
    }) as never,
    headers: () => new Headers(),
  });

  it("fetchAccounts parses the shape and drops malformed rows", async () => {
    const d = await fetchAccounts((async () => res(200, { accounts: [item(), { id: 1 }], encryption: { ready: true }, synthetic: true })) as never);
    assert.deepEqual([d.accounts.length, d.encryptionReady, d.synthetic], [1, true, true]);
    await assert.rejects(fetchAccounts((async () => res(401)) as never), /session/);
    await assert.rejects(fetchAccounts((async () => res(500)) as never), /unavailable/);
  });
  it("body: google sends no host/port/tls; imap does; empty password is omitted on update; create carries the type", () => {
    const g = { ...emptyForm("google"), label: " G ", username: "me@gmail.test", password: "app pass" };
    assert.deepEqual(bodyFromForm(g, "create"), { label: "G", color: null, username: "me@gmail.test", mailbox: "INBOX", context: "", spam_mailbox: "[Gmail]/Spam", type: "google", password: "app pass" });
    const i = { ...emptyForm("imap"), host: " imap.x.test ", port: "143", tls: false };
    const b = bodyFromForm(i, "update");
    assert.deepEqual([b.host, b.port, b.tls, "password" in b, "type" in b, b.spam_mailbox], ["imap.x.test", 143, false, false, false, null]);
  });
  it("create / update / enable / test map statuses and codes to reasons", async () => {
    const seen: { path?: string; body?: string }[] = [];
    const ok = await postCreateAccount({ ...emptyForm("imap"), host: "imap.x.test", username: "u", password: "p" }, deps(res(201, { ok: true, account: item() }), seen));
    assert.ok(ok.ok && ok.account?.label === "Privat");
    assert.equal(seen[0]?.path, "/api/accounts");
    assert.deepEqual(await postCreateAccount(emptyForm("imap"), deps(res(503, { error: "no_encryption_key" }))), { ok: false, reason: "no_encryption_key" });
    assert.deepEqual(await postCreateAccount(emptyForm("imap"), deps(res(400, { error: "host_not_allowed" }))), { ok: false, reason: "host_not_allowed" });
    assert.deepEqual(await postUpdateAccount("a_x", emptyForm("imap"), deps(res(404, { error: "not_found" }))), { ok: false, reason: "not_found" });
    assert.deepEqual(await postUpdateAccount("a_x", emptyForm("imap"), deps(res(400, { error: "something_new" }))), { ok: false, reason: "failed" });
    const r = await postAccountEnabled("a_x", false, deps(res(200, { ok: true, account: item({ enabled: false }) }), seen));
    assert.ok(r.ok);
    assert.equal(seen.at(-1)?.path, "/api/accounts/a_x/disable");
    assert.deepEqual(await postTestAccount("a_x", deps(res(200, { ok: false, code: "auth_failed" }))), { ok: true, code: "auth_failed" });
    assert.deepEqual(await postTestAccount("a_x", deps(res(429, {}, { "retry-after": "12" }))), { ok: false, reason: "rate_limited", retryAfterSeconds: 12 });
    assert.deepEqual(await postTestAccount("a_x", deps(res(409, { error: "secret_unreadable" }))), { ok: false, reason: "secret_unreadable" });
  });
  it("workerText", () => {
    assert.equal(workerText(item({ enabled: false })), "Deaktiviert");
    assert.equal(workerText(item({ worker: { state: "paused", error_code: "imap_auth", last_poll_at: null } })), "Angehalten: Anmeldung abgelehnt");
    assert.equal(workerText(item({ worker: { state: "backoff", error_code: "imap_error", last_poll_at: null } })), "Neuer Versuch folgt");
  });
});
