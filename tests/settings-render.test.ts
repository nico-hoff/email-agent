// R3 UI: the settings sections render from state; the live switch is never one tap; the client sends `confirm` only after the dialog.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { loadTsx } from "./helpers/load-tsx.ts";
import { costText, fetchSettings, postClassifierModel, postGlobalStop, postQuarantine, postSpamSeenMode, postUserStop, type SettingsData } from "../lib/settings-client.ts";

type Mgr = typeof import("../components/settings-manager.tsx");
const { SettingsSections } = await loadTsx<Mgr>("components/settings-manager.tsx");
const html = (el: unknown): string => renderToStaticMarkup(el as Parameters<typeof renderToStaticMarkup>[0]);

const data = (over: Partial<SettingsData> = {}): SettingsData => ({
  stop: { user_stopped_at: null, global_active: false, can_toggle_global: false },
  daily_limit: 200,
  accounts: [{ id: "a_1", label: "Privat", color: "#10b981", enabled: true, managed: true, spam_seen_mode: "dry_run", actions_24h: 12, quarantine: { mode: "off", days: 14, yolo: false } }],
  classifier: { permitted: false }, members: null, synthetic: false, ...over,
});
const view = (d: SettingsData | null, extra: Record<string, unknown> = {}) => html(SettingsSections({ data: d, busy: false, confirm: null, timeZone: "UTC", ...extra } as never));

describe("settings sections", () => {
  it("shows the three modes, the explanation, the daily count and the link to the actions", () => {
    const out = view(data());
    assert.match(out, />Aus</);
    assert.match(out, />Trockenlauf</);
    assert.match(out, />An</);
    assert.match(out, /aria-pressed="true"[^>]*>Trockenlauf</);
    assert.match(out, /Heute 12 von 200 Aktionen/);
    assert.match(out, /href="\/aussortiert"/);
    assert.match(out, /Not-Aus einschalten/);
    assert.doesNotMatch(out, /Globalen Not-Aus/, "no global toggle for non-admins");
  });

  it("global stop: shown read-only for users, toggle for admins; user stop shows the way back", () => {
    const active = view(data({ stop: { user_stopped_at: "2026-10-31T09:00:00.000Z", global_active: true, can_toggle_global: false } }));
    assert.match(active, /globale Not-Aus ist aktiv/);
    assert.match(active, /Aktionen wieder erlauben/);
    assert.doesNotMatch(active, /Aufheben \(Admin\)|aufheben \(Admin\)/);
    assert.match(view(data({ stop: { user_stopped_at: null, global_active: true, can_toggle_global: true } })), /Globalen Not-Aus aufheben \(Admin\)/);
  });

  it("model section only with the permission; uncalibrated models are disabled with the reason; costs are shown", () => {
    assert.doesNotMatch(view(data()), /Klassifikationsmodell/);
    const out = view(data({ classifier: { permitted: true, model: "typesafe/jev-1.13", models: [
      { id: "typesafe/jev-1.13", label: "Jev", description: "Standard.", selectable: true, relative_cost: 1, usd_per_1000: 0.059 },
      { id: "openai/gpt-6-luna-decisions", label: "Luna Decisions", description: "Schärfer.", selectable: false, relative_cost: 3.3, usd_per_1000: 0.192 },
    ] } }));
    assert.match(out, /Klassifikationsmodell/);
    assert.match(out, /3,3-mal so hoch wie Jev/);
    assert.match(out, /Noch nicht kalibriert/);
    assert.match(out, /disabled=""[^>]*>Luna Decisions</);
    assert.match(costText({ relative_cost: 1, usd_per_1000: 0.059 }), /Referenz/);
  });

  it("permissions list for admins", () => {
    const out = view(data({ members: [{ id: 1, email: "a@example.test", role: "admin", status: "active", classifier_choice: false }, { id: 2, email: null, role: "user", status: "unclaimed", classifier_choice: true }] }));
    assert.match(out, /Berechtigungen/);
    assert.match(out, /Modellwahl: aus/);
    assert.match(out, /Modellwahl: an/);
  });

  it("the live dialog explains the server effect and focuses the safe button; the global dialog differs", () => {
    const live = view(data(), { confirm: { kind: "live", accountId: "a_1", label: "Privat" } });
    assert.match(live, /role="alertdialog"/);
    assert.match(live, /Spam auf dem Server als gelesen markieren\?/);
    assert.match(live, /nur das Merkmal „gelesen“/);
    assert.match(live, /wieder auf „ungelesen“/);
    assert.match(live, /Höchstens 200 Aktionen/);
    assert.match(live, /Not-Aus/);
    assert.match(live, /Ja, einschalten/);
    assert.match(view(data(), { confirm: { kind: "global", stopped: true } }), /Globalen Not-Aus einschalten\?/);
    assert.doesNotMatch(view(data()), /alertdialog/);
  });

  it("renders nothing without data", () => assert.equal(view(null), ""));
});

describe("settings client", () => {
  const deps = (calls: { path: string; body: unknown }[], status = 200) => ({
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u === "/api/auth/session") return Response.json({ csrfToken: "t" });
      calls.push({ path: u, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return status === 200 ? Response.json({ ok: true }) : Response.json({ error: "confirmation_required" }, { status });
    },
    headers: () => new Headers(),
  });

  it("confirm is sent for live only, and only when confirmed", async () => {
    const calls: { path: string; body: unknown }[] = [];
    await postSpamSeenMode("a_1", "live", false, deps(calls) as never);
    await postSpamSeenMode("a_1", "live", true, deps(calls) as never);
    await postSpamSeenMode("a_1", "dry_run", true, deps(calls) as never);
    assert.deepEqual(calls.map((c) => c.body), [{ account_id: "a_1", mode: "live" }, { account_id: "a_1", mode: "live", confirm: true }, { account_id: "a_1", mode: "dry_run" }]);
  });

  it("quarantine: confirm is sent for live and YOLO on only, and only when confirmed", async () => {
    const calls: { path: string; body: unknown }[] = [];
    const d = deps(calls) as never;
    await postQuarantine("a_1", { mode: "live" }, false, d);
    await postQuarantine("a_1", { mode: "live" }, true, d);
    await postQuarantine("a_1", { mode: "dry_run" }, true, d);
    await postQuarantine("a_1", { yolo: true }, true, d);
    await postQuarantine("a_1", { yolo: false }, true, d);
    await postQuarantine("a_1", { days: 30 }, true, d);
    assert.deepEqual(calls.map((c) => [c.path, c.body]), [
      ["/api/settings/quarantine", { account_id: "a_1", mode: "live" }],
      ["/api/settings/quarantine", { account_id: "a_1", mode: "live", confirm: true }],
      ["/api/settings/quarantine", { account_id: "a_1", mode: "dry_run" }],
      ["/api/settings/quarantine", { account_id: "a_1", yolo: true, confirm: true }],
      ["/api/settings/quarantine", { account_id: "a_1", yolo: false }],
      ["/api/settings/quarantine", { account_id: "a_1", days: 30 }],
    ]);
  });

  it("stop, global stop and model bodies; errors map to reasons", async () => {
    const calls: { path: string; body: unknown }[] = [];
    await postUserStop(true, deps(calls) as never);
    await postGlobalStop(false, deps(calls) as never);
    await postClassifierModel("typesafe/jev-1.13", deps(calls) as never);
    assert.deepEqual(calls.map((c) => [c.path, c.body]), [
      ["/api/settings/stop", { scope: "user", stopped: true }],
      ["/api/settings/stop", { scope: "global", stopped: false, confirm: true }],
      ["/api/settings/classifier", { model: "typesafe/jev-1.13" }],
    ]);
    assert.deepEqual(await postUserStop(true, deps([], 400) as never), { ok: false, reason: "confirmation_required" });
  });

  it("fetchSettings parses defensively", async () => {
    const f = (async () => Response.json({ stop: { user_stopped_at: "x", global_active: true }, accounts: [{ id: "a", label: "L", spam_seen_mode: "weird" }, 5], classifier: { permitted: false } })) as unknown as typeof fetch;
    const d = await fetchSettings(f);
    assert.deepEqual([d.stop.global_active, d.accounts.length, d.accounts[0]?.spam_seen_mode, d.members, d.daily_limit], [true, 1, null, null, 200]);
  });
});

describe("quarantine settings (R9)", () => {
  const withQ = (q: { mode: "off" | "dry_run" | "live"; days: number; yolo: boolean }) =>
    data({ accounts: [{ id: "a_1", label: "Privat", color: "#10b981", enabled: true, managed: true, spam_seen_mode: "dry_run", actions_24h: 0, quarantine: q }] });

  it("off by default: three modes, no days, no YOLO", () => {
    const out = view(withQ({ mode: "off", days: 14, yolo: false }));
    assert.match(out, /Spam in Quarantäne verschieben/);
    assert.match(out, /Aus: Spam bleibt im Posteingang/);
    assert.doesNotMatch(out, /Aufräumen nach/);
    assert.doesNotMatch(out, /YOLO/);
  });

  it("dry run explains that nothing changes on the server; shows the days and the YOLO switch", () => {
    const out = view(withQ({ mode: "dry_run", days: 14, yolo: false }));
    assert.match(out, /Trockenlauf: die App zeigt nur, welchen Spam sie in den Ordner „Quarantäne“ verschieben würde/);
    assert.match(out, /Aufräumen nach/);
    assert.match(out, /<option value="14" selected="">14 Tage<\/option>/);
    assert.match(out, /<option value="1">1 Tag<\/option>/);
    assert.match(out, /<option value="90">90 Tage<\/option>/);
    assert.match(out, /YOLO: Spam sofort in den Papierkorb/);
    assert.match(out, /Endgültig gelöscht wird nie von der App/);
  });

  it("live without and with YOLO states what happens", () => {
    assert.match(view(withQ({ mode: "live", days: 7, yolo: false })), /nach 7 Tagen in den Papierkorb/);
    const y = view(withQ({ mode: "live", days: 7, yolo: true }));
    assert.match(y, /Spam wird sofort in den Papierkorb deines Anbieters verschoben, ohne Quarantäne/);
    assert.match(y, /YOLO ist an/);
    assert.match(y, /btn-danger/);
  });

  it("an account without credentials shows no quarantine block", () => {
    const d = data({ accounts: [{ id: "d", label: "Demo", color: "#000000", enabled: true, managed: false, spam_seen_mode: null, actions_24h: 0, quarantine: null }] });
    assert.doesNotMatch(view(d), /Spam in Quarantäne verschieben/);
  });

  it("the live dialog names the move, the folder, the cleanup, the undo and the safe default focus", () => {
    const out = view(data(), { confirm: { kind: "qlive", accountId: "a_1", label: "Privat", yolo: false } });
    assert.match(out, /role="alertdialog"/);
    assert.match(out, /Spam in Quarantäne verschieben\?/);
    assert.match(out, /Ordner „Quarantäne“/);
    assert.match(out, /Standard 14 Tage/);
    assert.match(out, /löscht nie endgültig/);
    assert.match(out, /zurück in den Posteingang/);
    assert.match(out, /Höchstens 200 Aktionen/);
    assert.match(out, /autoFocus|autofocus/i);
    assert.match(view(data(), { confirm: { kind: "qlive", accountId: "a_1", label: "Privat", yolo: true } }), /YOLO ist an: Spam wird sofort in den Papierkorb/);
  });

  it("the YOLO dialog is a strong warning", () => {
    const out = view(data(), { confirm: { kind: "yolo", accountId: "a_1", label: "Privat" } });
    assert.match(out, /YOLO wirklich einschalten\?/);
    assert.match(out, /Achtung/);
    assert.match(out, /ohne Zwischenstation in den Papierkorb/);
    assert.match(out, /auch eine wichtige/);
    assert.match(out, /Wann der Anbieter den Papierkorb leert, bestimmt der Anbieter/);
    assert.match(out, /Ja, YOLO einschalten/);
    assert.match(out, /btn-danger/);
  });
});

