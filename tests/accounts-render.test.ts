// R2 UI: "Konten verwalten" renders from state, never shows a secret, and the client maps the API correctly.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { loadTsx } from "./helpers/load-tsx.ts";
import {
  applyPatch, bodyFromForm, emptyForm, fetchAccounts, formFromItem, postAccountEnabled, postCreateAccount, postTestAccount, postUpdateAccount, workerText,
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
    const demo = view({ testResults: { a_0123456789abcdef: "synthetic_no_network" } });
    assert.match(demo, /Demo-Modus/);
    assert.doesNotMatch(demo, /notice-error|notice-inline|Test fehlgeschlagen/, "the demo answer is not a failure");
  });
  it("add form: three visible fields (E-Mail-Adresse, IMAP-Passwort, IMAP-Server); everything else sits in the collapsed Erweitert section", () => {
    const out = view({ editor: { id: null, form: emptyForm() } });
    const [visible = "", advanced = ""] = out.split('<details class="acct-advanced">');
    assert.match(visible, /E-Mail-Adresse/);
    assert.match(visible, /IMAP-Passwort/);
    assert.match(visible, /IMAP-Server/);
    assert.match(visible, /placeholder="imap\.example\.com"/);
    assert.doesNotMatch(visible, /id="acct-(label|user|port|box|spam|context)"/);
    assert.doesNotMatch(out, /<details[^>]* open/);
    for (const id of ["label", "user", "port", "box", "spam", "context"]) assert.match(advanced, new RegExp(`id="acct-${id}"`));
    assert.match(advanced, /Erweitert|<summary>Erweitert/);
    assert.match(advanced, /value="993"/);
    assert.match(advanced, /value="INBOX"/);
    assert.doesNotMatch(out, /Art des Kontos/, "no type picker: the type follows the server");
  });
  it("placeholder follows the domain; a Gmail address gives the Google preset with the App-Passwort hint", () => {
    const unknown = applyPatch(emptyForm(), { email: "me@firma.example" });
    assert.match(view({ editor: { id: null, form: unknown } }), /placeholder="imap\.firma\.example"/);
    const g = applyPatch(emptyForm(), { email: "me@gmail.com" });
    const out = view({ editor: { id: null, form: g } });
    assert.match(out, /App-Passwort/);
    assert.match(out, /Gmail erkannt: imap\.gmail\.com, Port 993, TLS an/);
    assert.match(out, /id="acct-host"[^>]*value="imap\.gmail\.com"/);
    assert.match(out, /value="me@gmail\.com"/);
    assert.match(out, /placeholder="\[Gmail\]\/Spam"/);
    assert.doesNotMatch(out, /id="acct-port"/, "port and TLS are fixed for Google");
    assert.match(out, /type="password"[^>]*value=""/);
  });
  it("TLS off warns", () => {
    assert.match(view({ editor: { id: null, form: { ...emptyForm(), host: "imap.x.test", tls: false } } }), /unverschlüsselt/);
  });
  it("edit form is never prefilled with a password and says that empty keeps it", () => {
    const out = view({ editor: { id: "a_0123456789abcdef", form: formFromItem(item({ context: "Familie" })) } });
    assert.match(out, /id="acct-pass"[^>]*value=""/);
    assert.match(out, /behalten/);
    assert.match(out, /Familie/);
    assert.match(out, /Änderungen speichern/);
  });
  it("form error is an alert", () => {
    assert.match(view({ editor: { id: null, form: emptyForm() }, formError: "Der Servername ist ungültig." }), /role="alert"[^>]*>Der Servername/);
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
  it("applyPatch: username, label and server follow the address until edited by hand", () => {
    let f = applyPatch(emptyForm(), { email: "me@web.de" });
    assert.deepEqual([f.username, f.label, f.host], ["me@web.de", "me@web.de", "imap.web.de"]);
    f = applyPatch(f, { label: "Privat" });
    f = applyPatch(f, { email: "me@gmx.net" });
    assert.deepEqual([f.username, f.label, f.host], ["me@gmx.net", "Privat", "imap.gmx.net"]);
    f = applyPatch(f, { host: "imap.eigen.example" });
    f = applyPatch(f, { email: "me@posteo.de" });
    assert.equal(f.host, "imap.eigen.example");
    assert.equal(applyPatch(emptyForm(), { email: "me@unbekannt.example" }).host, "");
    assert.equal(applyPatch(emptyForm(), { email: "x".repeat(60) + "@web.de" }).label.length, 40);
  });
  it("body: Gmail sends type google and no host/port/tls; others send them; defaults: username = address, label = address, no spam folder on create; empty password omitted", () => {
    const g = { ...applyPatch(emptyForm(), { email: "me@gmail.com" }), password: "app pass" };
    assert.deepEqual(bodyFromForm(g, "create"), { label: "me@gmail.com", color: null, username: "me@gmail.com", mailbox: "INBOX", context: "", type: "google", password: "app pass" });
    const i = applyPatch(applyPatch(emptyForm(), { email: "me@x.test" }), { host: " imap.x.test ", port: "143", tls: false });
    const b = bodyFromForm(i, "update");
    assert.deepEqual([b.host, b.port, b.tls, "password" in b, "type" in b, b.spam_mailbox, b.username], ["imap.x.test", 143, false, false, false, null, "me@x.test"]);
    assert.equal("spam_mailbox" in bodyFromForm(i, "create"), false);
    assert.equal(bodyFromForm({ ...i, spam_mailbox: " Junk " }, "create").spam_mailbox, "Junk");
  });
  it("create / update / enable / test map statuses and codes to reasons", async () => {
    const seen: { path?: string; body?: string }[] = [];
    const ok = await postCreateAccount({ ...emptyForm(), host: "imap.x.test", username: "u", password: "p" }, deps(res(201, { ok: true, account: item() }), seen));
    assert.ok(ok.ok && ok.account?.label === "Privat");
    assert.equal(seen[0]?.path, "/api/accounts");
    assert.deepEqual(await postCreateAccount(emptyForm(), deps(res(503, { error: "no_encryption_key" }))), { ok: false, reason: "no_encryption_key" });
    assert.deepEqual(await postCreateAccount(emptyForm(), deps(res(400, { error: "host_not_allowed" }))), { ok: false, reason: "host_not_allowed" });
    assert.deepEqual(await postUpdateAccount("a_x", emptyForm(), deps(res(404, { error: "not_found" }))), { ok: false, reason: "not_found" });
    assert.deepEqual(await postUpdateAccount("a_x", emptyForm(), deps(res(400, { error: "something_new" }))), { ok: false, reason: "failed" });
    const r = await postAccountEnabled("a_x", false, deps(res(200, { ok: true, account: item({ enabled: false }) }), seen));
    assert.ok(r.ok);
    assert.equal(seen.at(-1)?.path, "/api/accounts/a_x/disable");
    assert.deepEqual(await postTestAccount("a_x", deps(res(200, { ok: false, code: "auth_failed" }))), { ok: true, code: "auth_failed", spamMailbox: null });
    assert.deepEqual(await postTestAccount("a_x", deps(res(429, {}, { "retry-after": "12" }))), { ok: false, reason: "rate_limited", retryAfterSeconds: 12 });
    assert.deepEqual(await postTestAccount("a_x", deps(res(409, { error: "secret_unreadable" }))), { ok: false, reason: "secret_unreadable" });
  });
  it("workerText", () => {
    assert.equal(workerText(item({ enabled: false })), "Deaktiviert");
    assert.equal(workerText(item({ worker: { state: "paused", error_code: "imap_auth", last_poll_at: null } })), "Angehalten: Anmeldung abgelehnt");
    assert.equal(workerText(item({ worker: { state: "backoff", error_code: "imap_error", last_poll_at: null } })), "Neuer Versuch folgt");
  });
});
