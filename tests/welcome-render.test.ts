import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { loadTsx } from "./helpers/load-tsx.ts";

type Welcome = typeof import("../components/welcome.tsx");
const { WelcomeView, welcomeStateFromSession, loginFailureFromResponse, registerFailureFromResponse } = await loadTsx<Welcome>("components/welcome.tsx");
const noop = (): void => {};
const html = (el: unknown): string => renderToStaticMarkup(el as Parameters<typeof renderToStaticMarkup>[0]);
const view = (state: Parameters<typeof WelcomeView>[0]["state"], over: Record<string, unknown> = {}) =>
  html(WelcomeView({ state, busy: false, failure: null, waitSeconds: 0, onLogin: noop, onPassword: noop, ...over } as Parameters<typeof WelcomeView>[0]));

describe("welcome page", () => {
  it("password mode: password field, login button, no stored value, no identity", () => {
    const out = view({ kind: "password", csrfToken: "t" });
    assert.match(out, /<input[^>]*type="password"/);
    assert.match(out, /autoComplete="current-password"|autocomplete="current-password"/);
    assert.match(out, /<button[^>]*type="submit"/);
    assert.match(out, /<form/);
    assert.doesNotMatch(out, /Angemeldet als|Tailnet/);
    assert.doesNotMatch(out, /value=/, "the field renders empty");
  });

  it("password mode failures: wrong, rate limited with wait time, misconfigured, generic", () => {
    const pw = { kind: "password", csrfToken: "t" } as const;
    assert.match(view(pw, { failure: "invalid" }), /role="alert"[^>]*>[^<]*Passwort[^<]*falsch/);
    const limited = view(pw, { failure: "rate_limited", waitSeconds: 125 });
    assert.match(limited, /Zu viele Versuche/);
    assert.match(limited, /3 Minuten/);
    assert.match(view(pw, { failure: "rate_limited", waitSeconds: 20 }), /20 Sekunden/);
    assert.match(view({ kind: "misconfigured" }), /Server nicht korrekt konfiguriert/);
    assert.doesNotMatch(view({ kind: "misconfigured" }), /type="password"/);
    assert.match(view(pw, { failure: "failed" }), /role="alert"/);
    assert.match(view(pw, { failure: "misconfigured" }), /Server nicht korrekt konfiguriert/);
    assert.doesNotMatch(view(pw, { failure: "invalid" }), /fast|knapp|Zeichen/);
  });

  it("touch targets: input and button are at least 44 px high", () => {
    const css = readFileSync(new URL("../globals.css", import.meta.url), "utf8");
    assert.match(css, /\.welcome input\[type="password"\][^}]*min-height:\s*(4[4-9]|[5-9]\d)px/);
    assert.match(css, /\.welcome button[^}]*min-height:\s*(4[4-9]|[5-9]\d)px/);
  });

  it("tailnet mode: identity and login button as before", () => {
    const out = view({ kind: "ready", login: "me@example.test", csrfToken: "t" });
    assert.match(out, /Angemeldet als <strong>me@example\.test<\/strong>/);
    assert.match(out, />Login</);
    assert.doesNotMatch(out, /type="password"/);
    assert.match(view({ kind: "no_identity" }), /Tailnet-Identit/);
    assert.match(view({ kind: "not_allowed" }), /nicht freigegeben/);
  });

  it("synthetic mode renders like tailnet ready (fixed dev identity)", () => {
    assert.match(view({ kind: "ready", login: "dev@synthetic.invalid", csrfToken: "t" }), /dev@synthetic\.invalid/);
  });

  it("loading and error states", () => {
    assert.match(view({ kind: "loading" }), /Einen Moment/);
    assert.match(view({ kind: "error" }), /derzeit nicht verf/);
  });

  it("session responses map to states by mode", () => {
    assert.deepEqual(welcomeStateFromSession(200, { mode: "password", configured: true, csrfToken: "t", signedIn: false }), { kind: "password", csrfToken: "t" });
    assert.deepEqual(welcomeStateFromSession(200, { mode: "password", configured: false }), { kind: "misconfigured" });
    assert.deepEqual(welcomeStateFromSession(200, { mode: "synthetic", login: "dev@synthetic.invalid", csrfToken: "t", signedIn: false }), { kind: "ready", login: "dev@synthetic.invalid", csrfToken: "t" });
    assert.deepEqual(welcomeStateFromSession(200, { mode: "tailnet", login: "a@b", csrfToken: "t", signedIn: false }), { kind: "ready", login: "a@b", csrfToken: "t" });
    assert.deepEqual(welcomeStateFromSession(200, { mode: "password", configured: true, csrfToken: "t", signedIn: true }), { kind: "signed_in" });
    assert.deepEqual(welcomeStateFromSession(401, { error: "no_identity", mode: "tailnet" }), { kind: "no_identity" });
    assert.deepEqual(welcomeStateFromSession(403, { error: "not_allowed", mode: "tailnet" }), { kind: "not_allowed" });
    assert.deepEqual(welcomeStateFromSession(500, {}), { kind: "error" });
  });

  it("login responses map to failures", () => {
    assert.deepEqual(loginFailureFromResponse(401, null), { failure: "invalid", waitSeconds: 0 });
    assert.deepEqual(loginFailureFromResponse(429, "125"), { failure: "rate_limited", waitSeconds: 125 });
    assert.deepEqual(loginFailureFromResponse(429, null), { failure: "rate_limited", waitSeconds: 60 });
    assert.deepEqual(loginFailureFromResponse(503, null), { failure: "misconfigured", waitSeconds: 0 });
    assert.deepEqual(loginFailureFromResponse(403, null), { failure: "failed", waitSeconds: 0 });
    assert.deepEqual(loginFailureFromResponse(500, null), { failure: "failed", waitSeconds: 0 });
  });

  it("page source keeps the password out of browser storage", () => {
    const src = readFileSync(new URL("../app/welcome/page.tsx", import.meta.url), "utf8") + readFileSync(new URL("../components/welcome.tsx", import.meta.url), "utf8");
    assert.doesNotMatch(src, /localStorage|sessionStorage|indexedDB/);
  });
});

describe("welcome page, users mode", () => {
  const users = { kind: "users", csrfToken: "t" } as const;

  it("session answers map to the users state", () => {
    assert.deepEqual(welcomeStateFromSession(200, { mode: "users", configured: true, csrfToken: "t", signedIn: false }), users);
    assert.deepEqual(welcomeStateFromSession(200, { mode: "users", configured: true, csrfToken: "t", signedIn: true }), { kind: "signed_in" });
    assert.deepEqual(welcomeStateFromSession(200, { mode: "users", configured: false }), { kind: "misconfigured" });
    assert.deepEqual(welcomeStateFromSession(200, { mode: "users", configured: true }), { kind: "error" });
  });

  it("login form: email and password fields, autofill hints, a toggle to the registration form, nothing stored", () => {
    const out = view(users);
    assert.match(out, /<input[^>]*type="email"/);
    assert.match(out, /autoComplete="username"|autocomplete="username"/);
    assert.match(out, /<input[^>]*type="password"/);
    assert.match(out, /autoComplete="current-password"|autocomplete="current-password"/);
    assert.match(out, /<button[^>]*type="submit"[^>]*>Anmelden</);
    assert.match(out, />Mit Einladungscode registrieren</);
    assert.doesNotMatch(out, /Einladungscode<\/label>/, "the code field belongs to the registration form");
    assert.doesNotMatch(out, /value=/, "fields render empty");
    assert.doesNotMatch(out, /Tailnet|Angemeldet als/);
  });

  it("registration form: code, email and new password (at least 12 characters), toggle back", () => {
    const out = html(WelcomeView({ state: users, busy: false, failure: null, waitSeconds: 0, onLogin: noop, onPassword: noop, initialRegister: true } as Parameters<typeof WelcomeView>[0]));
    assert.match(out, /<label[^>]*>Einladungscode<\/label>/);
    assert.match(out, /<input[^>]*id="invite-code"/);
    assert.match(out, /autoComplete="new-password"|autocomplete="new-password"/);
    assert.match(out, /minLength="12"|minlength="12"/);
    assert.match(out, />Registrieren</);
    assert.match(out, />Zurück zur Anmeldung</);
  });

  it("login failures read as one uniform message; the rate limit names the wait", () => {
    assert.match(view(users, { failure: "invalid" }), /role="alert"[^>]*>E-Mail oder Passwort stimmt nicht\./);
    assert.match(view(users, { failure: "rate_limited", waitSeconds: 125 }), /3 Minuten/);
    assert.doesNotMatch(view(users, { failure: "invalid" }), /existiert|unbekannt|nicht gefunden/);
  });

  it("registration failures: every code has a plain German text", () => {
    const reg = (registerFailure: string, waitSeconds = 0) =>
      html(WelcomeView({ state: users, busy: false, failure: null, waitSeconds, onLogin: noop, onPassword: noop, initialRegister: true, registerFailure } as Parameters<typeof WelcomeView>[0]));
    assert.match(reg("invalid_invite"), /Einladungscode ist ungültig, abgelaufen oder schon benutzt/);
    assert.match(reg("invalid_email"), /gültige E-Mail-Adresse/);
    assert.match(reg("weak_password"), /mindestens 12 Zeichen/);
    assert.match(reg("email_taken"), /schon registriert/);
    assert.match(reg("rate_limited", 20), /20 Sekunden/);
    assert.match(reg("failed"), /Registrierung fehlgeschlagen/);
  });

  it("register responses map to failures", () => {
    assert.deepEqual(registerFailureFromResponse(400, "invalid_invite", null), { failure: "invalid_invite", waitSeconds: 0 });
    assert.deepEqual(registerFailureFromResponse(400, "weak_password", null), { failure: "weak_password", waitSeconds: 0 });
    assert.deepEqual(registerFailureFromResponse(409, "email_taken", null), { failure: "email_taken", waitSeconds: 0 });
    assert.deepEqual(registerFailureFromResponse(429, "rate_limited", "90"), { failure: "rate_limited", waitSeconds: 90 });
    assert.deepEqual(registerFailureFromResponse(403, "origin_mismatch", null), { failure: "failed", waitSeconds: 0 });
    assert.deepEqual(registerFailureFromResponse(500, undefined, null), { failure: "failed", waitSeconds: 0 });
  });

  it("touch targets and safe areas: inputs and the link button are at least 44 px high, the page keeps its insets", () => {
    const css = readFileSync(new URL("../globals.css", import.meta.url), "utf8");
    assert.match(css, /\.welcome input\[type="email"\][^}]*min-height:\s*(4[4-9]|[5-9]\d)px/);
    assert.match(css, /\.welcome \.welcome-link[^}]*font-size/);
    assert.match(css, /\.welcome \{[^}]*safe-area-inset-top/);
  });

  it("page source posts registration and login without browser storage", () => {
    const src = readFileSync(new URL("../app/welcome/page.tsx", import.meta.url), "utf8");
    assert.match(src, /\/api\/auth\/register/);
    assert.doesNotMatch(src, /localStorage|sessionStorage|indexedDB/);
  });
});
