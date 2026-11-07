// Initial import UI (ADR 0043): the live card renders from state in every stage, shows only counts and list-item data, and
// the client maps the API correctly. Synthetic data only.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { loadTsx } from "./helpers/load-tsx.ts";
import { fetchSync, isActivePhase, parseSync, postSyncRestart, showSyncCard, syncHeadline, syncNote, syncStages, type SyncData } from "../packages/core/src/sync-client.ts";
import type { ApiEmail } from "../packages/core/src/review-ui.ts";

type Card = typeof import("../components/sync-card.tsx");
type Profile = typeof import("../components/profile.tsx");
const { SyncCard } = await loadTsx<Card>("components/sync-card.tsx");
const { ProfileView } = await loadTsx<Profile>("components/profile.tsx");
const html = (el: unknown): string => renderToStaticMarkup(el as Parameters<typeof renderToStaticMarkup>[0]);

const mail = (id: number, over: Partial<ApiEmail> = {}): ApiEmail => ({
  id, account: { id: "a", label: "Privat", color: "#10b981" } as never, sender: `absender${id}@example.test`, subject: `Testbetreff ${id}`,
  received_at: "2026-10-30T10:00:00.000Z", active_location: { folder: "INBOX" }, provider_spam: false, seen: false, done: false, open: false,
  category: "personal", route: "digest", urgency: 1, importance: 2, needs_my_reply: null,
  classification: { status: "classified", answers: {} }, shadow_quarantine: null, disagreement: null, ...over,
});
const sync = (over: Partial<SyncData> = {}): SyncData => ({
  phase: "fetching", total: 50, fetched: 37, classified: 0, failed: 0, error_code: null, runs: 1, started_at: "2026-10-31T10:00:00.000Z",
  updated_at: "2026-10-31T10:00:05.000Z", finished_at: null, feed: [], ...over,
});
const card = (s: SyncData, extra: Record<string, unknown> = {}) => html(SyncCard({ sync: s, label: "Privat", ...extra }));

describe("stages", () => {
  it("connecting -> reading -> classifying -> done, with the counts in the labels", () => {
    const key = (s: SyncData) => syncStages(s).map((x) => `${x.key}:${x.state}`).join(" ");
    assert.equal(key(sync({ phase: "queued", total: 0, fetched: 0 })), "connect:active read:todo classify:todo done:todo");
    assert.equal(key(sync({ phase: "connecting", total: 0, fetched: 0 })), "connect:active read:todo classify:todo done:todo");
    assert.equal(key(sync()), "connect:done read:active classify:todo done:todo");
    assert.equal(key(sync({ fetched: 50, classified: 3 })), "connect:done read:active classify:active done:todo");
    assert.equal(key(sync({ phase: "classifying", fetched: 50, classified: 21 })), "connect:done read:done classify:active done:todo");
    assert.equal(key(sync({ phase: "done", fetched: 50, classified: 50 })), "connect:done read:done classify:done done:done");
    const labels = syncStages(sync({ phase: "classifying", fetched: 50, classified: 20, failed: 1 })).map((x) => x.label);
    assert.deepEqual(labels, ["Verbinde mit dem Postfach", "Lese Mails (50/50)", "System One klassifiziert (21/50)", "Fertig"]);
    assert.equal(syncStages(sync())[1]?.label, "Lese Mails (37/50)");
  });
  it("failed marks the stage that was running", () => {
    const key = (s: SyncData) => syncStages(s).map((x) => `${x.key}:${x.state}`).join(" ");
    assert.equal(key(sync({ phase: "failed", total: 0, fetched: 0, error_code: "imap_auth" })), "connect:failed read:todo classify:todo done:todo");
    assert.equal(key(sync({ phase: "failed", fetched: 10 })), "connect:done read:failed classify:todo done:todo");
  });
  it("showSyncCard: active and failed always, done while seen running or shortly after", () => {
    const now = Date.parse("2026-10-31T12:00:00.000Z");
    assert.equal(showSyncCard(null, true, now), false);
    assert.equal(showSyncCard(sync(), false, now), true);
    assert.equal(showSyncCard(sync({ phase: "failed" }), false, now), true);
    assert.equal(showSyncCard(sync({ phase: "done", finished_at: "2026-10-30T10:00:00.000Z" }), false, now), false);
    assert.equal(showSyncCard(sync({ phase: "done", finished_at: "2026-10-30T10:00:00.000Z" }), true, now), true);
    assert.equal(showSyncCard(sync({ phase: "done", finished_at: "2026-10-31T11:50:00.000Z" }), false, now), true);
    assert.equal(isActivePhase("done"), false);
  });
  it("texts are German and name the next step for a rejected login", () => {
    assert.match(syncNote(sync({ phase: "failed", error_code: "imap_auth" })) ?? "", /Anmeldung wurde abgelehnt.*Bearbeiten/);
    assert.match(syncNote(sync({ error_code: "imap_error" })) ?? "", /neuer Versuch folgt automatisch|Ein neuer Versuch/);
    assert.match(syncNote(sync({ phase: "done", classified: 48, failed: 2 })) ?? "", /48 von 50 Mails bewertet, 2 nicht bewertbar.*keine automatischen Aktionen/);
    assert.equal(syncHeadline(sync({ phase: "done", total: 0 })), "Nichts zu importieren");
  });
});

describe("SyncCard", () => {
  it("fetching: stage list, progress bars with values, no restart button", () => {
    const out = card(sync({ classified: 5 }));
    assert.match(out, /data-phase="fetching"/);
    assert.match(out, /Lese Mails \(37\/50\)/);
    assert.match(out, /role="progressbar"[^>]*aria-valuenow="37"/);
    assert.match(out, /width:74%/);
    assert.doesNotMatch(out, /Zu den Mails|Erneut versuchen|Import wiederholen/);
    assert.match(out, /aria-live="polite"/);
  });
  it("connecting shows the waiting bar and no counts", () => {
    const out = card(sync({ phase: "connecting", total: 0, fetched: 0 }));
    assert.match(out, /Verbinde mit dem Postfach/);
    assert.match(out, /sync-bar-wait/);
    assert.doesNotMatch(out, /role="progressbar"/);
  });
  it("feed: subject, sender and badges (Spam, Wichtig, Offen); at most ten; urgency badges stay out", () => {
    const feed = [
      mail(1, { category: "spam", importance: 0, open: false }),
      mail(2, { open: true, category: "business", importance: 3 }),
      ...Array.from({ length: 12 }, (_, i) => mail(10 + i)),
    ];
    const out = card(sync({ phase: "classifying", fetched: 50, classified: 21, feed }));
    assert.equal(out.match(/data-testid="sync-item"/g)?.length, 10);
    assert.match(out, /Testbetreff 1</);
    assert.match(out, /absender2@example\.test/);
    assert.match(out, /cat-spam[^>]*>Spam</);
    assert.match(out, />Offen</);
    assert.match(out, />Wichtig: kritisch</);
    assert.doesNotMatch(out, /Dringend/);
    assert.match(out, /Gerade bewertet/);
  });
  it("done: Zu den Mails and Import wiederholen; zero mails: no Zu den Mails", () => {
    const out = card(sync({ phase: "done", fetched: 50, classified: 50, feed: [mail(1)], finished_at: "2026-10-31T10:05:00.000Z" }), { mailsHref: "/" });
    assert.match(out, /<a class="btn btn-accent btn-wide" href="\/">Zu den Mails<\/a>/);
    assert.match(out, /Import wiederholen/);
    assert.match(out, /Zuletzt bewertet/);
    assert.doesNotMatch(card(sync({ phase: "done", total: 0, fetched: 0 })), /Zu den Mails/);
  });
  it("failed: Erneut versuchen, the reason and a restart error", () => {
    const out = card(sync({ phase: "failed", total: 0, fetched: 0, error_code: "imap_auth" }), { restartError: "Zu viele Neustarts. Bitte kurz warten." });
    assert.match(out, />Erneut versuchen</);
    assert.match(out, /Anmeldung wurde abgelehnt/);
    assert.match(out, /role="alert"[^>]*>Zu viele Neustarts/);
    assert.match(card(sync({ phase: "failed" }), { restarting: true }), /Starte …/);
  });
  it("carries no mail body and no raw field: only the list-item data", () => {
    const out = card(sync({ feed: [mail(1)] }));
    assert.doesNotMatch(out, /excerpt|SYNTHETIC BODY|password/i);
  });
});

describe("in the profile", () => {
  const acct = { id: "a_0123456789abcdef", managed: true, type: "imap", label: "Privat", color: "#10b981", host: "imap.example.test", port: 993, tls: true, username: "me@example.test", mailbox: "INBOX", spam_mailbox: null, enabled: true, context: "", secret_set: true, secret_set_at: "2026-10-31T09:00:00.000Z", last_test_at: null, last_test_code: null, worker: { state: "connected", error_code: null, last_poll_at: null } };
  const view = (accounts: Record<string, unknown>) => html(ProfileView({
    profile: { mode: "users", managed: true, email: "a@example.test", role: "admin", live_sessions: 1 }, invites: [], loading: false, error: null, busy: false,
    created: null, notice: null, inviteRole: "user", timeZone: "UTC",
    accounts: { data: { accounts: [acct], encryptionReady: true, synthetic: false }, editor: null, busy: false, testing: null, testResults: {}, formError: null, timeZone: "UTC", ...accounts },
  } as never));
  it("the card sits in the account row while importing, and not for an old finished import", () => {
    assert.match(view({ sync: { [acct.id]: sync() } }), /data-testid="sync-card"/);
    assert.doesNotMatch(view({}), /sync-card/);
    const old = sync({ phase: "done", finished_at: "2026-10-01T10:00:00.000Z" });
    assert.doesNotMatch(view({ sync: { [acct.id]: old }, nowMs: Date.parse("2026-10-31T12:00:00.000Z") }), /sync-card/);
    assert.match(view({ sync: { [acct.id]: old }, syncSawActive: { [acct.id]: true } }), /Erst-Import abgeschlossen/);
  });
  it("a demo account (not managed) never shows a card", () => {
    assert.doesNotMatch(view({ data: { accounts: [{ ...acct, managed: false }], encryptionReady: true, synthetic: false }, sync: { [acct.id]: sync() } }), /sync-card/);
  });
});

describe("client", () => {
  const res = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
  it("parseSync is strict about the phase and tolerant about the rest", () => {
    assert.equal(parseSync({ phase: "weird" }), null);
    assert.equal(parseSync(null), null);
    const s = parseSync({ phase: "classifying", total: 5, fetched: 5, classified: 2, failed: 0, feed: [{ id: 1 }] });
    assert.deepEqual([s?.phase, s?.classified, s?.feed.length, s?.runs], ["classifying", 2, 1, 1]);
  });
  it("fetchSync: 404 and null mean no import; other errors throw", async () => {
    assert.equal(await fetchSync((async () => res(404, { error: "not_found" })) as never, "x"), null);
    assert.equal(await fetchSync((async () => res(200, { sync: null })) as never, "x"), null);
    assert.equal((await fetchSync((async () => res(200, { sync: { phase: "done", total: 0 } })) as never, "x"))?.phase, "done");
    await assert.rejects(fetchSync((async () => res(500, {})) as never, "x"));
  });
  it("postSyncRestart maps 200, 409, 429", async () => {
    const mk = (r: Response) => ({
      fetch: (async (url: string) => (String(url).endsWith("/api/auth/session") ? res(200, { csrfToken: "t" }) : r)) as never,
      headers: () => new Headers(),
    });
    assert.deepEqual(await postSyncRestart("a", mk(res(200, { ok: true })) as never), { ok: true });
    assert.deepEqual(await postSyncRestart("a", mk(res(409, { error: "not_restartable" })) as never), { ok: false, reason: "not_restartable" });
    assert.deepEqual(await postSyncRestart("a", mk(res(429, { error: "rate_limited" }, { "retry-after": "12" })) as never), { ok: false, reason: "rate_limited", retryAfterSeconds: 12 });
  });
});

describe("styles", () => {
  const css = readFileSync(new URL("../globals.css", import.meta.url), "utf8");
  it("the card uses the existing tokens, has dark-mode friendly colours and honours prefers-reduced-motion", () => {
    const block = css.slice(css.indexOf("Erst-Import: Live-Karte"));
    assert.match(block, /var\(--accent\)/);
    assert.match(block, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.sync-item[\s\S]*animation: none/);
    assert.doesNotMatch(block, /#[0-9a-f]{3,6}\b/i, "no hard-coded colours: tokens only");
  });
});
