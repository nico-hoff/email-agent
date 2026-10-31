import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { loadTsx } from "./helpers/load-tsx.ts";
import { fetchInvites, fetchProfile, formatWhen, postInvite, postLogout, postLogoutAll } from "../lib/profile-client.ts";

type Profile = typeof import("../components/profile.tsx");
const { ProfileView } = await loadTsx<Profile>("components/profile.tsx");
const html = (el: unknown): string => renderToStaticMarkup(el as Parameters<typeof renderToStaticMarkup>[0]);
const base = { invites: [], loading: false, error: null, busy: false, created: null, notice: null, inviteRole: "user" as const, timeZone: "UTC" };
const view = (over: Record<string, unknown>) => html(ProfileView({ ...base, ...over } as unknown as Parameters<typeof ProfileView>[0]));
const admin = { mode: "users", managed: true, email: "admin@example.test", role: "admin" as const, live_sessions: 2 };

describe("profile page", () => {
  it("admin: account, sessions (here and everywhere) and invitations, with the number of live sessions", () => {
    const out = view({ profile: admin });
    assert.match(out, /<h1>Profil<\/h1>/);
    assert.match(out, /admin@example\.test/);
    assert.match(out, />Admin</);
    assert.match(out, /2 aktive Sitzungen/);
    assert.match(out, />Abmelden</);
    assert.match(out, />Auf allen Geräten abmelden</);
    assert.match(out, />Einladung erstellen</);
    assert.match(out, /Keine offenen Einladungen/);
    assert.match(out, /href="\/"/, "link back to the list");
  });

  it("a plain user sees account and sessions but no invitations", () => {
    const out = view({ profile: { ...admin, role: "user", live_sessions: 1 } });
    assert.match(out, />Nutzer</);
    assert.match(out, /1 aktive Sitzung</);
    assert.doesNotMatch(out, /Einladung erstellen|Einladungen/);
  });

  it("transitional modes: an explanation instead of an account, no logout-everywhere, no invitations", () => {
    const out = view({ profile: { mode: "password", managed: false, email: null, role: "admin" } });
    assert.match(out, /ohne Nutzerkonten/);
    assert.match(out, />Abmelden</);
    assert.doesNotMatch(out, /Auf allen Geräten|Einladung erstellen/);
  });

  it("a created invitation shows its code and expiry; the open list shows only role and times, never a code", () => {
    const created = { id: 3, code: "ABCD-EFGH-JKLM-NPQR-STUV", role: "user" as const, created_at: "2026-10-31T10:00:00.000Z", expires_at: "2026-11-07T10:00:00.000Z" };
    const out = view({ profile: admin, created, invites: [{ id: 3, role: "user", created_at: created.created_at, expires_at: created.expires_at }, { id: 2, role: "admin", created_at: created.created_at, expires_at: created.expires_at }] });
    assert.equal((out.match(/ABCD-EFGH-JKLM-NPQR-STUV/g) ?? []).length, 1, "the code appears exactly once");
    assert.match(out, /nur jetzt angezeigt/);
    assert.match(out, /Gilt bis 07\.11\.2026, 10:00/);
    assert.match(out, /Offene Einladungen/);
    assert.equal((out.match(/class="rule"/g) ?? []).length, 2);
  });

  it("states: loading, error with retry, notice toast, role choice pressed, buttons disabled while busy", () => {
    assert.match(view({ profile: null, loading: true }), /Lädt/);
    const err = view({ profile: null, error: "Daten nicht verfügbar" });
    assert.match(err, /role="alert"/);
    assert.match(err, /Erneut versuchen/);
    assert.match(view({ profile: admin, notice: { text: "Zu viele Aktionen. Bitte kurz warten.", error: true } }), /toast-error/);
    assert.match(view({ profile: admin, inviteRole: "admin" }), /aria-pressed="true"[^>]*>Admin</);
    assert.match(view({ profile: admin, busy: true }), /<button[^>]*disabled=""[^>]*>Abmelden</);
  });

  it("the page source and the client keep codes and tokens out of browser storage", () => {
    const src = readFileSync(new URL("../app/profil/page.tsx", import.meta.url), "utf8") + readFileSync(new URL("../lib/profile-client.ts", import.meta.url), "utf8")
      + readFileSync(new URL("../components/profile.tsx", import.meta.url), "utf8");
    assert.doesNotMatch(src, /localStorage|sessionStorage|indexedDB/);
  });

  it("the main page header menu links to the profile", () => {
    assert.match(readFileSync(new URL("../components/review.tsx", import.meta.url), "utf8"), /href="\/profil">Profil</);
  });
});

describe("profile client", () => {
  const res = (status: number, body: unknown = {}, headers: Record<string, string> = {}) => Response.json(body, { status, headers });
  const fetcher = (r: Response) => (async () => r) as unknown as typeof fetch;

  it("fetchProfile: shape, 401 means session, other errors unavailable", async () => {
    assert.deepEqual(await fetchProfile(fetcher(res(200, { mode: "users", managed: true, email: "a@b.test", role: "admin", live_sessions: 3 }))),
      { mode: "users", managed: true, email: "a@b.test", role: "admin", live_sessions: 3 });
    assert.deepEqual(await fetchProfile(fetcher(res(200, { mode: "password", managed: false, email: null, role: "admin" }))),
      { mode: "password", managed: false, email: null, role: "admin" });
    await assert.rejects(fetchProfile(fetcher(res(401))), /session/);
    await assert.rejects(fetchProfile(fetcher(res(500))), /unavailable/);
  });

  it("fetchInvites keeps well-formed rows only", async () => {
    const list = await fetchInvites(fetcher(res(200, { invites: [{ id: 1, role: "user", created_at: "a", expires_at: "b" }, { id: "x" }, null, { id: 2, role: "admin", created_at: "c", expires_at: "d" }] })));
    assert.deepEqual(list, [{ id: 1, role: "user", created_at: "a", expires_at: "b" }, { id: 2, role: "admin", created_at: "c", expires_at: "d" }]);
  });

  function deps(onPost: (path: string, init: RequestInit) => Response) {
    return {
      fetch: async (url: string, init?: RequestInit) => (url === "/api/auth/session" ? res(200, { csrfToken: "tok" }) : onPost(url, init ?? {})),
      headers: (_p: string, t: string) => new Headers({ "x-app-csrf": t }),
    };
  }

  it("postInvite: posts the role with the CSRF handshake and returns the code; maps errors", async () => {
    let seen: { path: string; body: string; csrf: string | null } | undefined;
    const ok = await postInvite({ role: "admin" }, deps((path, init) => {
      seen = { path, body: String(init.body), csrf: new Headers(init.headers).get("x-app-csrf") };
      return res(201, { ok: true, id: 4, code: "CODE-X", role: "admin", created_at: "c", expires_at: "e" });
    }));
    assert.deepEqual(seen, { path: "/api/invites", body: '{"role":"admin"}', csrf: "tok" });
    assert.deepEqual(ok, { ok: true, invite: { id: 4, code: "CODE-X", role: "admin", created_at: "c", expires_at: "e" } });
    assert.deepEqual(await postInvite({}, deps(() => res(429, {}, { "retry-after": "30" }))), { ok: false, reason: "rate_limited", retryAfterSeconds: 30 });
    assert.deepEqual(await postInvite({}, deps(() => res(403))), { ok: false, reason: "forbidden" });
    assert.deepEqual(await postInvite({}, deps(() => res(409))), { ok: false, reason: "users_mode_required" });
    assert.deepEqual(await postInvite({}, deps(() => res(500))), { ok: false, reason: "failed" });
    assert.deepEqual(await postInvite({}, deps(() => res(201, { code: 5 }))), { ok: false, reason: "failed" });
  });

  it("logout and logout-all: success, an already ended session counts as signed out, errors map", async () => {
    assert.deepEqual(await postLogout(deps(() => res(200))), { ok: true });
    assert.deepEqual(await postLogout(deps(() => res(401))), { ok: true });
    assert.deepEqual(await postLogoutAll(deps(() => res(200, { ok: true, revoked: 2 }))), { ok: true });
    assert.deepEqual(await postLogoutAll(deps(() => res(409))), { ok: false, reason: "users_mode_required" });
    assert.deepEqual(await postLogoutAll(deps(() => res(429, {}, { "retry-after": "10" }))), { ok: false, reason: "rate_limited" });
    assert.deepEqual(await postLogoutAll(deps(() => res(500))), { ok: false, reason: "failed" });
  });

  it("formatWhen: German date and time, raw text for garbage", () => {
    assert.match(formatWhen("2026-10-31T14:05:00.000Z", "Europe/Berlin"), /^31\.10\.2026, 15:05$/);
    assert.equal(formatWhen("not a date"), "not a date");
  });
});
