// R6 UI: Profil → Benachrichtigungen. State derivation (unavailable / not installed on iOS / denied / off / on), render of each
// state, the device list, and the client helpers added for it. No real push service, no network.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadTsx } from "./helpers/load-tsx.ts";
import { pushSectionState, type PushSectionState } from "../lib/push-section.ts";
import { currentPushDevice, removePushDevice, type PushConfigInfo, type PushDevice, type PushEnv, type PushSubscriptionLike } from "../lib/push-client.ts";
import type { MutationDeps } from "../lib/mutate-client.ts";

type Mgr = typeof import("../components/push-manager.tsx");
type Prof = typeof import("../components/profile.tsx");
const { PushSection } = await loadTsx<Mgr>("components/push-manager.tsx");
const { ProfileView } = await loadTsx<Prof>("components/profile.tsx");
const html = (el: unknown): string => renderToStaticMarkup(el as Parameters<typeof renderToStaticMarkup>[0]);

const cfg = (available: boolean, reason: string | null = null): PushConfigInfo => ({ available, publicKey: available ? "K" : null, reason, maxDevices: 10 });
const device = (id: number, over: Partial<PushDevice> = {}): PushDevice => ({
  id, agent_family: "iOS Safari", created_at: "2026-10-31T10:00:00.000Z", last_success_at: null, failing: false,
  kinds: { important_mail: true, briefing_ready: false }, ...over,
});

describe("push section state", () => {
  const st = (o: Partial<Parameters<typeof pushSectionState>[0]>): PushSectionState =>
    pushSectionState({ config: cfg(true), support: "supported", permission: "default", subscribed: false, ...o });

  it("loading until the config is there; unavailable when the server has no VAPID keys (wins over everything)", () => {
    assert.equal(st({ config: null }), "loading");
    assert.equal(st({ config: cfg(false, "vapid_not_configured"), support: "needs_install", permission: "denied" }), "server_unavailable");
  });
  it("iOS without the installed PWA, browsers without APIs, denied permission, off and on", () => {
    assert.equal(st({ support: "needs_install" }), "needs_install");
    assert.equal(st({ support: "unsupported" }), "unsupported");
    assert.equal(st({ permission: "denied" }), "permission_denied");
    assert.equal(st({ permission: "default" }), "off");
    assert.equal(st({ permission: "granted" }), "off", "granted but not registered yet: can be switched on");
    assert.equal(st({ permission: "granted", subscribed: true }), "on");
    assert.equal(st({ permission: "denied", subscribed: true }), "permission_denied", "a blocked permission beats a stale subscription");
  });
});

describe("Profil → Benachrichtigungen", () => {
  const base = { state: "off" as PushSectionState, devices: [] as PushDevice[], thisDeviceId: null, kinds: { important_mail: true, briefing_ready: true }, busy: false, timeZone: "UTC" };
  const view = (over: Record<string, unknown> = {}) => html(createElement(PushSection, { ...base, ...over } as never));

  it("unavailable: German hint that the server has no VAPID keys yet; no enable button", () => {
    const out = view({ state: "server_unavailable", reason: "vapid_not_configured" });
    assert.match(out, /noch nicht eingerichtet: Der Server hat noch keine Push-Schlüssel/);
    assert.match(view({ state: "server_unavailable", reason: "vapid_invalid" }), /Push-Schlüssel auf dem Server sind ungültig/);
    assert.doesNotMatch(out, /Auf diesem Gerät aktivieren|Meine Geräte/);
  });
  it("needs_install: tells the iPhone person to install and open from the home screen", () => {
    const out = view({ state: "needs_install" });
    assert.match(out, /Zum Home-Bildschirm/);
    assert.match(out, /vom Home-Bildschirm<\/strong> öffnen/);
    assert.doesNotMatch(out, /Auf diesem Gerät aktivieren/);
  });
  it("denied and unsupported give the way out and no enable button", () => {
    assert.match(view({ state: "permission_denied" }), /blockiert[^<]*Einstellungen des Geräts/);
    assert.doesNotMatch(view({ state: "permission_denied" }), /Auf diesem Gerät aktivieren/);
    assert.match(view({ state: "unsupported" }), /keine Benachrichtigungen/);
  });
  it("off: the enable button says the system prompt comes only after the tap", () => {
    const out = view({ state: "off" });
    assert.match(out, />Auf diesem Gerät aktivieren</);
    assert.match(out, /erscheint erst, wenn du unten tippst/);
    assert.doesNotMatch(out, /Test senden/);
    assert.match(out, /Noch kein Gerät angemeldet/);
  });
  it("on: per-kind switches, test button, own devices with family, since and last success, and remove", () => {
    const out = view({
      state: "on", thisDeviceId: 3, maxDevices: 10, kinds: { important_mail: true, briefing_ready: false },
      devices: [device(3, { last_success_at: "2026-11-01T07:31:00.000Z" }), device(4, { agent_family: "Chrome Android", failing: true })],
    });
    assert.match(out, /data-testid="kind-important_mail"[^>]*>An</);
    assert.match(out, /aria-pressed="false"[^>]*data-testid="kind-briefing_ready"[^>]*>Aus</);
    assert.match(out, />Test senden</);
    assert.match(out, /Wichtige Mail/);
    assert.match(out, /Briefing bereit/);
    assert.equal((out.match(/data-testid="push-device"/g) ?? []).length, 2);
    assert.match(out, /iOS Safari \(dieses Gerät\)/);
    assert.match(out, /Chrome Android/);
    assert.match(out, /Seit /);
    assert.match(out, /Noch keine Zustellung\. Zuletzt fehlgeschlagen\./);
    assert.match(out, /Letzte Zustellung /);
    assert.match(out, /aria-label="Gerät entfernen: Chrome Android"/);
    assert.match(out, /Höchstens 10 Geräte/);
    assert.match(out, /Auf diesem Gerät ausschalten/);
  });
  it("never shows mail data; shows an action message", () => {
    const out = view({ state: "on", message: { text: "Test gesendet.", error: false } });
    assert.match(out, /Test gesendet\./);
    assert.match(out, /nie Betreff, Absender oder Text/);
  });
  it("is part of the profile page when passed", () => {
    const out = html(createElement(ProfileView, {
      profile: { managed: true, email: "a@example.test", role: "user" }, invites: [], loading: false, error: null, busy: false, created: null, notice: null,
      inviteRole: "user", push: { ...base },
    } as never));
    assert.match(out, /aria-label="Benachrichtigungen"/);
  });
});

describe("push client additions", () => {
  const sub: PushSubscriptionLike = {
    endpoint: "https://web.push.apple.com/synthetic-endpoint-1",
    toJSON: () => ({ endpoint: "https://web.push.apple.com/synthetic-endpoint-1", expirationTime: null, keys: { p256dh: "P".repeat(87), auth: "A".repeat(22) } }),
    unsubscribe: async () => true,
  };
  const env = (o: { permission?: "default" | "granted" | "denied"; existing?: boolean } = {}): PushEnv => ({
    hasPushApis: () => true, permission: () => o.permission ?? "granted", requestPermission: async () => { throw new Error("no prompt expected"); },
    standalone: () => true, ios: () => false,
    registration: async () => ({ pushManager: { getSubscription: async () => (o.existing === false ? null : sub), subscribe: async () => { throw new Error("no subscribe expected"); } } }),
  });
  const calls: { url: string; body: unknown }[] = [];
  const deps = (status = 201): MutationDeps => ({
    fetch: async (url, init) => {
      if (url === "/api/auth/session") return Response.json({ csrfToken: "t" });
      calls.push({ url, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
      return status === 404 ? Response.json({ error: "not_found" }, { status: 404 }) : Response.json({ ok: true, device: device(7) }, { status });
    },
    headers: () => new Headers(),
  });

  it("currentPushDevice returns this device's row; silent without permission or subscription", async () => {
    const r = await currentPushDevice(env(), deps());
    assert.ok(r.ok && r.device?.id === 7);
    assert.deepEqual((calls.at(-1)?.body as { kinds?: unknown }).kinds, undefined, "kinds are left untouched");
    assert.deepEqual(await currentPushDevice(env({ permission: "default" }), deps()), { ok: true, device: null });
    assert.deepEqual(await currentPushDevice(env({ existing: false }), deps()), { ok: true, device: null });
  });
  it("removePushDevice posts the id to the existing unsubscribe route", async () => {
    assert.deepEqual(await removePushDevice(7, deps(200)), { ok: true });
    assert.deepEqual(calls.at(-1), { url: "/api/push/unsubscribe", body: { id: 7 } });
    assert.deepEqual(await removePushDevice(7, deps(404)), { ok: false, reason: "not_found" });
  });
});
