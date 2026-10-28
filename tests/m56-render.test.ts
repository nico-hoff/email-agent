import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { loadTsx } from "./helpers/load-tsx.ts";
import { INITIAL_BRIEFING, type BriefingState } from "../lib/briefing-client.ts";
import type { HitlCandidate, SenderRule } from "../lib/senders-client.ts";
import type { ApiAccount, ApiEmail, ActionTab, AutoMode } from "../lib/review-ui.ts";
import type { DraftViewState } from "../components/draft.tsx";
import type { FeedbackState } from "../lib/feedback-client.ts";

type Briefing = typeof import("../components/briefing.tsx");
type Draft = typeof import("../components/draft.tsx");
type Feedback = typeof import("../components/feedback.tsx");
type Senders = typeof import("../components/senders.tsx");
type Review = typeof import("../components/review.tsx");
type Actions = typeof import("../components/actions.tsx");
const { BriefingBox, HitlCards } = await loadTsx<Briefing>("components/briefing.tsx");
const { DraftPanel } = await loadTsx<Draft>("components/draft.tsx");
const { FeedbackPanel } = await loadTsx<Feedback>("components/feedback.tsx");
const { SendersView } = await loadTsx<Senders>("components/senders.tsx");
const { ReviewListView, HeaderMenu } = await loadTsx<Review>("components/review.tsx");
const { ActionsView } = await loadTsx<Actions>("components/actions.tsx");

const noop = (): void => {};
const html = (el: unknown): string => renderToStaticMarkup(el as Parameters<typeof renderToStaticMarkup>[0]);
const EVIL = '<script>alert(1)</script> [Klick](http://evil.test) **fett** <img src=x onerror=alert(1)>';

const st = (over: Partial<BriefingState>): BriefingState => ({ ...INITIAL_BRIEFING, ...over });
const box = (s: BriefingState, over: Record<string, unknown> = {}) =>
  html(createElement(BriefingBox, { state: s, collapsed: false, onToggle: noop, onRetry: noop, ...over }));

describe("BriefingBox", () => {
  it("loading shows a status and no empty list", () => {
    const h = box(st({ phase: "loading" }));
    assert.match(h, /role="status"/);
    assert.ok(h.includes("Zusammenfassung wird erstellt"));
    assert.ok(!h.includes("<li"));
  });

  it("streams the lines as bullets and keeps at most three visible with a remainder note", () => {
    const h = box(st({ phase: "streaming", source: "model", text: "- Eins\n- Zwei\n- Drei\n- Vier\n- Fünf" }));
    assert.equal(h.match(/<li/g)?.length, 3);
    assert.ok(h.includes("Eins") && h.includes("Drei") && !h.includes("Vier"));
    assert.match(h, /\+ ?2 weitere/);
  });

  it("shows all lines when the box is expanded", () => {
    const h = box(st({ phase: "done", source: "model", text: "- Eins\n- Zwei\n- Drei\n- Vier" }), { showAll: true });
    assert.equal(h.match(/<li/g)?.length, 4);
  });

  it("renders model text as text: no tags, no links, no Markdown", () => {
    const h = box(st({ phase: "done", source: "model", text: `- ${EVIL}` }));
    assert.ok(!h.includes("<script"), "no script element");
    assert.ok(!h.includes("<img"), "no img element");
    assert.ok(!h.includes("<a "), "no link");
    assert.ok(h.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
    assert.ok(h.includes("[Klick](http://evil.test)"));
    assert.ok(h.includes("**fett**"));
  });

  it("marks the fallback with Zusammenfassung ohne KI and the model text without it", () => {
    assert.ok(box(st({ phase: "done", source: "fallback", text: "3 offene Mails." })).includes("Zusammenfassung ohne KI"));
    assert.ok(!box(st({ phase: "done", source: "model", text: "- a" })).includes("ohne KI"));
  });

  it("error shows a message and Erneut versuchen; partial text stays", () => {
    const h = box(st({ phase: "error", text: "- halb", error: { code: "agent_failed", fallback: false } }));
    assert.match(h, /role="alert"/);
    assert.ok(h.includes("Erneut versuchen") && h.includes("halb"));
    assert.ok(h.includes("konnte nicht erstellt werden"));
  });

  it("collapsed shows only the head, with aria-expanded", () => {
    const h = box(st({ phase: "done", source: "model", text: "- Eins", openTotal: 4 }), { collapsed: true });
    assert.match(h, /aria-expanded="false"/);
    assert.ok(!h.includes("Eins"));
    assert.ok(h.includes("4 offen"));
    assert.match(box(st({ phase: "done", source: "model", text: "- Eins" })), /aria-expanded="true"/);
  });

  it("idle renders nothing", () => {
    assert.equal(box(st({ phase: "idle" })), "");
  });
});

const cand = (over: Partial<HitlCandidate> = {}): HitlCandidate => ({
  key: "domain:spam.example", match: "domain", value: "spam.example", jev_spam_count: 4, mails_seen: 5, dmarc_pass_rate: 0.2, sample_email_ids: [1], ...over,
});
const cards = (list: HitlCandidate[], over: Record<string, unknown> = {}) =>
  html(createElement(HitlCards, { candidates: list, busy: new Set<string>(), expanded: false, onExpand: noop, onDecide: noop, ...over }));

describe("HitlCards", () => {
  it("one compact card with title, DMARC hint and the three buttons", () => {
    const h = cards([cand()]);
    assert.ok(h.includes("Die Domain spam.example wurde 4× als Spam erkannt"));
    assert.ok(h.includes("DMARC bei 20 % der Mails bestanden"));
    for (const t of ["Immer aussortieren", "Nie aussortieren", "Später"]) assert.ok(h.includes(`>${t}<`), t);
  });
  it("shows two cards and folds the rest under Weitere", () => {
    const l = [cand({ key: "a", value: "a.example" }), cand({ key: "b", value: "b.example" }), cand({ key: "c", value: "c.example" })];
    const h = cards(l);
    assert.ok(h.includes("a.example") && h.includes("b.example") && !h.includes("c.example"));
    assert.ok(h.includes("Weitere (1)"));
    assert.ok(cards(l, { expanded: true }).includes("c.example"));
  });
  it("renders nothing without candidates", () => {
    assert.equal(cards([]), "");
  });
  it("disables the buttons of a busy card", () => {
    const h = cards([cand()], { busy: new Set(["domain:spam.example"]) });
    assert.equal(h.match(/disabled=""/g)?.length, 3);
  });
  it("an address candidate is named as sender", () => {
    assert.ok(cards([cand({ match: "address", value: "x@spam.example", key: "address:x@spam.example" })]).includes("Der Absender x@spam.example wurde 4× als Spam erkannt"));
  });
});

const ok = { ok: true as const, draft: "Guten Tag,\nvielen Dank.", language: "de", tone: "neutral", needsHumanCheck: false, reasons: [] as string[] };
const draft = (state: DraftViewState, over: Record<string, unknown> = {}) =>
  html(createElement(DraftPanel, { state, onCreate: noop, onCopy: noop, copied: false, ...over }));

describe("DraftPanel", () => {
  it("idle offers Entwurf erzeugen", () => {
    const h = draft({ kind: "idle" });
    assert.match(h, /<button[^>]*>Entwurf erzeugen<\/button>/);
  });
  it("loading disables the button and says what happens", () => {
    const h = draft({ kind: "loading" });
    assert.match(h, /role="status"/);
    assert.match(h, /<button[^>]*disabled=""/);
    assert.ok(h.includes("Entwurf wird erstellt"));
  });
  it("shows the draft as text with Kopieren and the check hint", () => {
    const h = draft({ kind: "ok", result: ok });
    assert.ok(h.includes("Guten Tag,\nvielen Dank."));
    assert.ok(h.includes(">Kopieren<"));
    assert.ok(h.includes("Prüfen vor dem Senden"));
    assert.ok(!h.includes("Bitte besonders sorgfältig"));
  });
  it("needs_human_check shows the warning and the reasons", () => {
    const h = draft({ kind: "ok", result: { ...ok, needsHumanCheck: true, reasons: ["Datum unklar"] } });
    assert.ok(h.includes("Bitte besonders sorgfältig prüfen"));
    assert.ok(h.includes("Datum unklar"));
  });
  it("copied state is announced", () => {
    assert.ok(draft({ kind: "ok", result: ok }, { copied: true }).includes("Kopiert"));
  });
  it("draft text with markup stays text", () => {
    const h = draft({ kind: "ok", result: { ...ok, draft: EVIL } });
    assert.ok(!h.includes("<script") && !h.includes("<img") && !h.includes("<a "));
    assert.ok(h.includes("&lt;script&gt;"));
  });
  it("synthetic mode and eligibility errors read in plain German", () => {
    assert.ok(draft({ kind: "error", result: { ok: false, code: "not_available_in_synthetic", reasons: [] } }).includes("Im Testmodus nicht verfügbar"));
    const h = draft({ kind: "error", result: { ok: false, code: "not_eligible", reasons: ["security_auth"] } });
    assert.ok(h.includes("Sicherheits- und Anmeldemails") && !h.includes("security_auth"));
    assert.match(h, /role="alert"/);
    assert.ok(h.includes("Entwurf erzeugen"), "can try again");
  });
  it("never writes to browser storage", async () => {
    const src = (await import("node:fs")).readFileSync(new URL("../components/draft.tsx", import.meta.url), "utf8")
      + (await import("node:fs")).readFileSync(new URL("../lib/draft-client.ts", import.meta.url), "utf8");
    assert.ok(!/localStorage|sessionStorage|indexedDB/.test(src));
  });
});

const fb = (state: FeedbackState | null, over: Record<string, unknown> = {}) =>
  html(createElement(FeedbackPanel, { state, busy: false, onAnswer: noop, ...over }));

describe("FeedbackPanel", () => {
  it("offers all answers with pressed state from the server", () => {
    const h = fb({ spam: "not_spam", reply: "reply_needed", category: null });
    assert.match(h, /aria-pressed="true"[^>]*>Kein Spam</);
    assert.match(h, /aria-pressed="false"[^>]*>Spam</);
    assert.match(h, /aria-pressed="true"[^>]*>Braucht Antwort</);
    assert.match(h, /aria-pressed="false"[^>]*>Keine Antwort nötig</);
    assert.ok(h.includes("Falsche Kategorie"));
    for (const c of ["Newsletter", "Persönlich", "Geschäftlich"]) assert.ok(h.includes(c), c);
  });
  it("shows the corrected category", () => {
    assert.ok(fb({ spam: null, reply: null, category: "personal" }).includes("Kategorie korrigiert"));
  });
  it("loading state (null) disables the buttons", () => {
    const h = fb(null);
    assert.ok((h.match(/disabled=""/g)?.length ?? 0) >= 4);
  });
});

const WEB: ApiAccount = { id: "a1", label: "Web", color: "#3b82f6" };
const rule = (id: number, kind: SenderRule["kind"], over: Partial<SenderRule> = {}): SenderRule => ({
  id, kind, match: "domain", value: `r${id}.example`, account_id: null, source: "nico", active: 1, created_at: "2026-10-27T10:00:00.000Z", ...over,
});
const senders = (over: Record<string, unknown> = {}) =>
  html(createElement(SendersView, {
    rules: [rule(1, "blacklist"), rule(2, "allowlist", { match: "address", value: "a@ok.example" })], candidates: [cand()],
    loading: false, error: null, busyKeys: new Set<string>(), form: { value: "", kind: "blacklist", busy: false, error: null },
    onFormChange: noop, onSubmit: noop, onRemove: noop, onDecide: noop, onReload: noop, toast: null, onToastClose: noop,
    expanded: false, onExpand: noop, ...over,
  }));

describe("SendersView", () => {
  it("separates Blacklist and Whitelist and offers Entfernen", () => {
    const h = senders();
    assert.ok(h.includes("<h1>Absender</h1>"));
    assert.ok(h.includes("Immer aussortieren") && h.includes("Nie aussortieren"));
    assert.ok(h.includes("r1.example") && h.includes("a@ok.example"));
    assert.equal(h.match(/>Entfernen</g)?.length, 2);
    assert.match(h, /href="\/"/);
  });
  it("lists open HITL questions", () => {
    assert.ok(senders().includes("wurde 4× als Spam erkannt"));
    assert.ok(!senders({ candidates: [] }).includes("wurde 4× als Spam erkannt"));
  });
  it("has the manual form and shows a freemail error in words", () => {
    const h = senders({ form: { value: "gmail.com", kind: "blacklist", busy: false, error: "freemail_domain" } });
    assert.match(h, /<input[^>]*value="gmail.com"/);
    assert.match(h, /role="alert"/);
    assert.ok(h.includes("Freemail") && !h.includes("freemail_domain"));
    assert.ok(h.includes(">Regel anlegen<"));
  });
  it("empty states", () => {
    const h = senders({ rules: [], candidates: [] });
    assert.ok(h.includes("Noch keine Regeln"));
  });
  it("loading and error states", () => {
    assert.match(senders({ loading: true, rules: [], candidates: [] }), /role="status"/);
    assert.match(senders({ error: "Daten nicht verfügbar" }), /role="alert"/);
  });
});

function mail(id: number): ApiEmail {
  return {
    id, account: WEB, sender: `s${id}@example.test`, subject: `Betreff ${id}`, received_at: "2026-10-14T08:30:00.000Z",
    active_location: { folder: "INBOX", uid: id }, provider_spam: false, seen: false, done: false, open: true,
    category: "business", route: "draft_reply", urgency: 1, importance: 1, needs_my_reply: "positive",
    classification: { status: "classified", answers: {} }, shadow_quarantine: null, disagreement: null,
  };
}
const list = (over: Record<string, unknown> = {}) =>
  html(createElement(ReviewListView, {
    emails: [mail(1)], view: "important", counts: { important: 1, open: 1, all: 1, noise: 0 }, accounts: [WEB], account: "", now: new Date("2026-10-27T12:00:00Z"),
    loading: false, error: null, canLoadMore: false, noise: { open: false, emails: [], loading: false, canLoadMore: false, error: false },
    ...over,
  }));

describe("list header and top slot", () => {
  it("puts Aussortiert and Absender into a menu with 44pt targets", () => {
    const h = list();
    assert.match(h, /aria-haspopup="menu"/);
    assert.ok(h.includes('href="/aussortiert"') && h.includes('href="/absender"'));
    assert.ok(h.includes("Neu laden"));
  });
  it("HeaderMenu is closed by default and open on demand", () => {
    assert.match(html(createElement(HeaderMenu, {})), /aria-expanded="false"/);
    assert.match(html(createElement(HeaderMenu, { defaultOpen: true })), /aria-expanded="true"/);
  });
  it("renders the top slot above the cards in Wichtig only", () => {
    const top = createElement("p", { id: "slot" }, "Oben");
    assert.ok(list({ top }).indexOf("id=\"slot\"") < list({ top }).indexOf("Betreff 1"));
    assert.ok(!list({ top, view: "open" }).includes("id=\"slot\""));
  });
});

describe("Aussortiert: Nicht markieren", () => {
  const act = { id: 1, email_id: 1, account: "a1", rule: "spam_seen", action: "mark_seen", mode: "dry_run", status: "planned", failure_code: null, created_at: "2026-10-27T10:00:00.000Z" };
  const counts = { dry_run: { planned: 1, done: 0, failed: 0, undone: 0 }, live: { planned: 0, done: 1, failed: 0, undone: 0 } };
  const view = (tab: ActionTab, mode: "dry_run" | "live") => html(createElement(ActionsView, {
    tab, counts, rows: [{ action: { ...act, mode }, email: mail(1) }], accounts: [WEB], modes: { a1: "dry_run" as AutoMode }, now: new Date("2026-10-27T12:00:00Z"),
    loading: false, error: null, canLoadMore: false, busy: new Set<number>(), onToastClose: noop,
  }));
  it("the dry-run tab says Nicht markieren, the live tab keeps Wieder ungelesen", () => {
    const d = view("dry_run", "dry_run");
    assert.ok(d.includes(">Nicht markieren<") && !d.includes(">Wieder ungelesen<"));
    assert.match(d, /aria-label="Nicht markieren: Betreff 1"/);
    const l = view("live", "live");
    assert.ok(l.includes(">Wieder ungelesen<") && !l.includes(">Nicht markieren<"));
  });
});
