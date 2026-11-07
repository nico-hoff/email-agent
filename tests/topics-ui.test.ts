// R8 UI: Profil → Themen renders from state, the topic client maps the API, the folder row and the topic badge appear in the
// list only with topics on, and the filter works together with the views. No new API.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadTsx } from "./helpers/load-tsx.ts";
import { listUrl, type ApiCounts, type ApiEmail } from "../packages/core/src/review-ui.ts";
import {
  canAddTopic, effectiveTopic, fetchTopicCounts, fetchTopics, parseTopics, postTopicChange, topicErrorText, topicLabels, visibleFolders,
  type TopicCounts, type TopicsData,
} from "../packages/core/src/topics-client.ts";
import type { MutationDeps } from "../packages/core/src/mutate-client.ts";
import { FIXED_TOPICS } from "../packages/core/src/topics.ts";

type Mgr = typeof import("../components/topics-manager.tsx");
type Review = typeof import("../components/review.tsx");
type Prof = typeof import("../components/profile.tsx");
const { TopicsSection } = await loadTsx<Mgr>("components/topics-manager.tsx");
const { ReviewListView } = await loadTsx<Review>("components/review.tsx");
const { ProfileView } = await loadTsx<Prof>("components/profile.tsx");
const html = (el: unknown): string => renderToStaticMarkup(el as Parameters<typeof renderToStaticMarkup>[0]);

const fixed = FIXED_TOPICS.map((t) => ({ key: t.key, label: t.label, kind: "fixed" as const, hint: null, active: true }));
const data = (over: Partial<TopicsData> = {}, custom: TopicsData["topics"] = []): TopicsData => ({
  enabled: false, limits: { active_custom_max: 4, label_min: 2, label_max: 40, hint_max: 120 }, topics: [...fixed, ...custom], ...over,
});
const own = (n: number, active = true) => ({ key: `custom_t${n}`, label: `Eigenes ${n}`, kind: "custom" as const, hint: `Hinweis ${n}`, active });
const section = (d: TopicsData | null, extra: Record<string, unknown> = {}) =>
  html(createElement(TopicsSection, { data: d, busy: false, editor: null, formError: null, ...extra } as never));

describe("Profil → Themen", () => {
  it("renders nothing without data", () => assert.equal(section(null), ""));

  it("switch defaults to Aus, explains that only new mails get a topic, lists the 12 fixed topics read-only", () => {
    const out = section(data());
    assert.match(out, /aria-pressed="true"[^>]*>Aus</);
    assert.match(out, /aria-pressed="false"[^>]*>An</);
    assert.match(out, /<strong>neue<\/strong> Mail ein Thema/);
    assert.match(out, /Bereits vorhandene Mails bekommen kein Thema/);
    assert.equal((out.match(/class="topic-pill"/g) ?? []).length, 12);
    assert.match(out, /Finanzen/);
    assert.match(out, /Einkäufe\/Bestellungen/);
    assert.match(out, /Noch keine eigenen Themen/);
    assert.match(out, /0 von 4 aktiven eigenen Themen/);
  });

  it("switch on shows the state; own topics show name, hint, edit and deactivate; inactive ones can be reactivated", () => {
    const out = section(data({ enabled: true }, [own(1), own(2, false)]));
    assert.match(out, /aria-pressed="true"[^>]*>An</);
    assert.match(out, /Themen sortieren ist an/);
    assert.match(out, /Eigenes 1/);
    assert.match(out, /Hinweis 1/);
    assert.match(out, />Bearbeiten</);
    assert.match(out, />Abwählen</);
    assert.match(out, />Wieder aktivieren</);
    assert.match(out, /is-off/);
    assert.match(out, /1 von 4 aktiven eigenen Themen/);
  });

  it("at the limit the add button is disabled and the German limit message shows", () => {
    const d = data({}, [own(1), own(2), own(3), own(4)]);
    assert.equal(canAddTopic(d), false);
    const out = section(d);
    assert.match(out, /disabled=""[^>]*>Eigenes Thema hinzufügen</);
    assert.match(out, /Das Limit von 4 aktiven eigenen Themen ist erreicht/);
    assert.match(section(data()), /<button type="button" class="btn btn-wide">Eigenes Thema hinzufügen/);
  });

  it("the editor shows name and hint fields, the distinct-hint advice with the Steuerberater example, and an API error", () => {
    const out = section(data(), { editor: { key: null, label: "Steuerberater", hint: "" }, formError: topicErrorText("duplicate") });
    assert.match(out, /Neues Thema/);
    assert.match(out, /maxLength="40"|maxlength="40"/i);
    assert.match(out, /deutlich anders als das nächste feste Thema/);
    assert.match(out, /Steuerberater/);
    assert.match(out, /Finanzen/);
    assert.match(out, /role="alert">Ein Thema mit diesem Namen gibt es schon/);
    assert.match(section(data(), { editor: { key: "custom_t1", label: "A", hint: "" } }), /Thema bearbeiten/);
    assert.match(section(data(), { editor: { key: null, label: "A", hint: "" } }), /disabled=""[^>]*>Speichern</, "a one-letter name cannot be saved");
  });

  it("is part of the profile page when passed", () => {
    const profile = { managed: true, email: "a@example.test", role: "user" } as never;
    const out = html(createElement(ProfileView, {
      profile, invites: [], loading: false, error: null, busy: false, created: null, notice: null, inviteRole: "user",
      topics: { data: data(), busy: false, editor: null, formError: null },
    } as never));
    assert.match(out, /aria-label="Themen"/);
  });
});

describe("topics client", () => {
  const deps = (status: number, body: unknown): MutationDeps => ({
    fetch: async (url) => (url === "/api/auth/session" ? Response.json({ csrfToken: "t" }) : Response.json(body, { status })),
    headers: () => new Headers(),
  });

  it("parseTopics keeps keys, labels, hints, switch and limits; drops junk", () => {
    const d = parseTopics({ enabled: true, limits: { active_custom_max: 4, label_min: 2, label_max: 40, hint_max: 120 }, topics: [...fixed.slice(0, 2), { key: "custom_a", label: "A1", kind: "custom", hint: "h", active: false }, { key: 5 }] });
    assert.equal(d.enabled, true);
    assert.equal(d.topics.length, 3);
    assert.equal(d.topics[2]?.active, false);
    assert.equal(parseTopics({}).enabled, false);
  });

  it("maps API errors to German texts; the response of a write carries the new list", async () => {
    assert.deepEqual(await postTopicChange({ action: "create", label: "X" }, deps(409, { error: "too_many_active" })), { ok: false, reason: "too_many_active" });
    assert.deepEqual(await postTopicChange({ action: "create", label: "X" }, deps(400, { error: "label_length" })), { ok: false, reason: "label_length" });
    assert.deepEqual(await postTopicChange({ action: "create", label: "X" }, deps(500, { error: "weird" })), { ok: false, reason: "failed" });
    assert.deepEqual(await postTopicChange({ action: "set_active", key: "custom_a", active: false }, deps(404, {})), { ok: false, reason: "not_found" });
    const ok = await postTopicChange({ action: "set_enabled", enabled: true }, deps(200, { ok: true, enabled: true, topics: fixed }));
    assert.equal(ok.ok && ok.data.enabled, true);
    assert.match(topicErrorText("too_many_active"), /4 aktive eigene Themen/);
    assert.match(topicErrorText("label_length"), /2 bis 40 Zeichen/);
    assert.match(topicErrorText("hint_length"), /120 Zeichen/);
    assert.match(topicErrorText("too_many_rows"), /abgewählte zählen mit/);
  });

  it("fetchTopics and fetchTopicCounts use only the existing endpoints; 401 is a session error", async () => {
    const urls: string[] = [];
    const f = (async (u: string) => {
      urls.push(u);
      return String(u).startsWith("/api/topics/counts")
        ? Response.json({ enabled: true, total: 9, none: 2, unlisted: 0, topics: [{ key: "finance", label: "Finanzen", kind: "fixed", active: true, count: 4 }] })
        : Response.json({ enabled: false, topics: fixed });
    }) as unknown as typeof fetch;
    assert.equal((await fetchTopics(f)).topics.length, 12);
    const c = await fetchTopicCounts(f, "acc 1");
    assert.deepEqual(urls, ["/api/topics", "/api/topics/counts?account=acc+1"]);
    assert.equal(c.total, 9);
    assert.equal(c.folders[0]?.count, 4);
    await assert.rejects(fetchTopicCounts((async () => new Response("", { status: 401 })) as unknown as typeof fetch), /session/);
  });
});

describe("folders in the list", () => {
  const counts: TopicCounts = {
    enabled: true, total: 30, none: 5,
    folders: [
      { key: "finance", label: "Finanzen", kind: "fixed", active: true, count: 12 },
      { key: "travel", label: "Reisen", kind: "fixed", active: true, count: 0 },
      { key: "custom_a", label: "Steuerberater", kind: "custom", active: true, count: 0 },
      { key: "custom_b", label: "Alt", kind: "custom", active: false, count: 0 },
      { key: "work", label: "Arbeit", kind: "fixed", active: true, count: 7 },
    ],
  };

  it("shows topics with mails, active own topics and the selected one; effectiveTopic falls back to Alle", () => {
    assert.deepEqual(visibleFolders(counts, "").map((f) => f.key), ["finance", "custom_a", "work"]);
    assert.deepEqual(visibleFolders(counts, "travel").map((f) => f.key), ["finance", "travel", "custom_a", "work"]);
    assert.equal(effectiveTopic("finance", counts), "finance");
    assert.equal(effectiveTopic("gone", counts), "");
    assert.equal(effectiveTopic("finance", { ...counts, enabled: false }), "");
  });

  it("the topic filter is part of the list URL next to view and account", () => {
    assert.equal(listUrl({ view: "open", account: "a1", topic: "finance", limit: 30 }), "/api/emails?view=open&limit=30&account=a1&topic=finance");
    assert.equal(listUrl({ view: "all", topic: "", limit: 30 }), "/api/emails?view=all&limit=30");
    assert.equal(listUrl({ view: "noise", topic: "custom_a", cursor: "c1", limit: 30 }), "/api/emails?view=noise&limit=30&topic=custom_a&cursor=c1");
  });

  const mail = (id: number, topic: string | null): ApiEmail => ({
    id, account: { id: "a", label: "Web", color: "#3b82f6" }, sender: "x@example.test", subject: `Betreff ${id}`, received_at: "2026-10-27T08:30:00.000Z",
    active_location: null, provider_spam: false, seen: false, done: false, open: false, category: null, route: null, urgency: null, importance: null,
    needs_my_reply: null, classification: null, shadow_quarantine: null, disagreement: null, topic,
  });
  const COUNTS: ApiCounts = { important: 1, open: 1, noise: 0, all: 2 };
  const list = (over: Record<string, unknown>) => html(createElement(ReviewListView, {
    emails: [mail(1, "finance"), mail(2, null)], view: "all", counts: COUNTS, accounts: [], account: "", now: new Date("2026-10-27T12:00:00Z"), timeZone: "UTC",
    loading: false, error: null, canLoadMore: false, noise: { open: false, emails: [], loading: false, canLoadMore: false, error: false }, ...over,
  } as never));

  it("with topics on: a row with Alle first and counts, the selected folder pressed, a German topic badge on the card", () => {
    const out = list({ topics: { folders: visibleFolders(counts, "finance"), selected: "finance", total: 30 }, topicLabels: topicLabels(counts) });
    assert.match(out, /aria-label="Thema"/);
    assert.ok(out.indexOf(">Alle<span class=\"chip-count\">30") < out.indexOf("Finanzen<span"));
    assert.match(out, /aria-pressed="true"[^>]*>Finanzen<span class="chip-count">12</);
    assert.match(out, /aria-pressed="false"[^>]*>Alle<span class="chip-count">30</);
    assert.match(out, /<li class="badge badge-neutral badge-topic">Finanzen<\/li>/);
    assert.equal((out.match(/badge-topic/g) ?? []).length, 1, "the mail without a topic has no badge");
  });

  it("with topics off the list looks exactly as before: no row, no badge, even if mails carry a topic", () => {
    const off = list({});
    assert.doesNotMatch(off, /Thema|badge-topic|chip-count/);
    const same = list({ emails: [mail(1, null), mail(2, null)] });
    assert.equal(off.replace(/Betreff \d/g, ""), same.replace(/Betreff \d/g, ""));
  });

  it("a topic filter with no mails shows the topic-specific empty hint and hides the briefing area", () => {
    const out = list({ emails: [], view: "important", topics: { folders: [], selected: "travel", total: 3 }, top: createElement("p", null, "BRIEFING") });
    assert.match(out, /In diesem Thema ist hier nichts/);
    assert.doesNotMatch(out, /BRIEFING/);
  });
});
