import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { loadTsx } from "./helpers/load-tsx.ts";
import type { ApiAnswer, ApiCounts, ApiEmail, ApiEmailDetail } from "../lib/review-ui.ts";

type Review = typeof import("../components/review.tsx");
const { EmailDetailView, ReviewListView } =await loadTsx<Review>("components/review.tsx");

const TZ = "Europe/Berlin";
const NOW = new Date("2026-10-27T12:00:00.000Z");
const MARKER = "GEHEIMER-INHALT-MARKER";

const ANSWERS: Record<string, ApiAnswer> = {
  category: { type: "choice", value: "personal", probabilities: { personal: 0.8, business: 0.2 } },
  route: { type: "choice", value: "notify" },
  importance: { type: "score", value: 2, probabilities: { "0": 0.1, "1": 0.1, "2": 0.7, "3": 0.1 } },
  urgency: { type: "score", value: 3 },
  is_spam: { type: "noul", value: 0.1 },
  is_phishing_or_scam: { type: "noul", value: 0.2 },
  needs_my_reply: { type: "noul", value: 0.9 },
  addresses_an_ai: { type: "noul", value: 0.05 },
  is_assessable: { type: "noul", value: 0.95 },
};

const WEB = { id: "hf-a", label: "Web", color: "#3b82f6" };
const WORK = { id: "hf-b", label: "Firma", color: "#f97316" };

function mail(id: number, over: Partial<ApiEmail> = {}): ApiEmail {
  // body/excerpt are not part of ApiEmail on purpose: the render must never print unknown fields.
  return {
    id,
    account: WEB,
    sender: "noreply@example.test",
    subject: `Betreff ${id}`,
    received_at: "2026-10-27T08:30:00.000Z",
    active_location: { folder: "INBOX", uid: id },
    provider_spam: false,
    seen: false,
    done: false,
    open: false,
    category: "personal",
    route: "digest",
    urgency: 3,
    importance: 2,
    needs_my_reply: null,
    classification: { status: "classified", answers: ANSWERS },
    shadow_quarantine: { candidate: false, decision: "no", reason: "unmapped_answer", applied_threshold: 0.9 },
    disagreement: null,
    ...({ body: MARKER, excerpt: MARKER, raw: MARKER } as object),
    ...over,
  };
}

const COUNTS: ApiCounts = { important: 12, open: 3, noise: 41, all: 53 };

const list = (emails: ApiEmail[], over: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(ReviewListView, {
    emails, view: "important", counts: COUNTS, accounts: [WEB, WORK], account: "", now: NOW, timeZone: TZ,
    loading: false, error: null, canLoadMore: false,
    noise: { open: false, emails: [], loading: false, canLoadMore: false, error: false },
    ...over,
  }));

describe("ReviewListView head", () => {
  it("renders title, reload, the segments Wichtig · Offen · Alle with counts and account chips", () => {
    const html = list([mail(1)]);
    assert.match(html, /<h1>Mails<\/h1>/);
    assert.match(html, /<button[^>]*>Neu laden<\/button>/);
    assert.match(html, /role="group"[^>]*aria-label="Ansicht"/);
    assert.match(html, /aria-pressed="true"[^>]*><span class="seg-label">Wichtig<\/span><span class="seg-count">12<\/span>/);
    assert.match(html, /aria-pressed="false"[^>]*><span class="seg-label">Offen<\/span><span class="seg-count">3<\/span>/);
    assert.match(html, /aria-pressed="false"[^>]*><span class="seg-label">Alle<\/span><span class="seg-count">53<\/span>/);
    assert.ok(html.indexOf("Wichtig</span>") < html.indexOf("Offen</span>") && html.indexOf("Offen</span>") < html.indexOf("Alle</span>"));
    assert.match(html, /role="group"[^>]*aria-label="Konto"/);
    assert.match(html, /aria-pressed="true"[^>]*>Alle Konten</);
    assert.match(html, /class="acct-dot" style="background:#3b82f6"[^>]*><\/span>Web<\/button>/);
    assert.match(html, /class="acct-dot" style="background:#f97316"[^>]*><\/span>Firma<\/button>/);
  });

  it("hides the account chips when there is a single account", () => {
    assert.ok(!list([mail(1)], { accounts: [WEB] }).includes('aria-label="Konto"'));
  });

  it("marks the selected account chip", () => {
    const html = list([mail(1)], { account: "hf-b" });
    assert.match(html, /aria-pressed="true"[^>]*><span class="acct-dot"[^>]*><\/span>Firma</);
    assert.match(html, /aria-pressed="false"[^>]*>Alle Konten</);
  });
});

describe("ReviewListView cards", () => {
  it("renders cards as links with account tag, sender, subject, time and badges", () => {
    const html = list([mail(1), mail(2, { account: WORK })]);
    assert.equal(html.match(/<a class="card" href="\/emails\/\d+"/g)?.length, 2);
    assert.match(html, /<span class="acct acct-sm"><span class="acct-dot" style="background:#3b82f6"[^>]*><\/span>Web<\/span>/);
    assert.match(html, /<span class="acct acct-sm"><span class="acct-dot" style="background:#f97316"[^>]*><\/span>Firma<\/span>/);
    assert.ok(html.includes("noreply@example.test"));
    assert.ok(html.includes("Betreff 1"));
    assert.ok(html.includes("09:30"));
    assert.ok(html.includes("Persönlich"));
    assert.ok(html.includes("Wichtig: folgenreich"));
    assert.ok(html.includes("Dringend: heute"));
  });

  it("highlights open mails with a badge and a state class", () => {
    const html = list([mail(1, { open: true, route: "notify" }), mail(2)]);
    assert.equal(html.match(/<li class="item is-open"/g)?.length, 1);
    assert.equal(html.match(/>Offen<\/li>/g)?.length, 1);
  });

  it("dims read mails and shows done mails as such", () => {
    const html = list([mail(1, { seen: true }), mail(2, { done: true })]);
    assert.match(html, /<li class="item is-seen"/);
    assert.match(html, /<li class="item is-done"/);
    assert.ok(html.includes(">Erledigt</li>"));
    assert.ok(!html.includes("done-btn"));
  });

  it("groups by urgency with headings", () => {
    const html = list([mail(1, { urgency: 3 }), mail(2, { urgency: 2 }), mail(3, { urgency: 0 })]);
    assert.match(html, /<h2 class="group-title">Heute<\/h2>/);
    assert.match(html, /<h2 class="group-title">In 48 Stunden<\/h2>/);
    assert.match(html, /<h2 class="group-title">Später<\/h2>/);
  });

  it("never prints content fields and exposes no mailbox write controls", () => {
    const html = list([mail(1, { open: true, route: "notify" })]);
    assert.ok(!html.includes(MARKER));
    assert.ok(!/<form|<textarea|type="submit"|method="post"/i.test(html));
  });

  it("shows shadow hint and disagreement on the card", () => {
    const html = list([mail(1, {
      shadow_quarantine: { candidate: true, decision: "pending_policy", reason: "candidate", applied_threshold: 0.9 },
      disagreement: "provider_spam_jev_not_spam",
    })]);
    assert.ok(html.includes("Shadow: Spam-Kandidat"));
    assert.ok(html.includes("Provider: Spam, Jev: nicht Spam"));
  });

  it("shows an empty text, error, loading and load-more", () => {
    const empty = list([], { view: "open" });
    assert.ok(empty.includes("Keine Mails in dieser Ansicht"));
    assert.ok(empty.includes("Nichts offen. Alles erledigt."));
    assert.match(list([], { error: "Daten nicht verfügbar" }), /role="alert"[^>]*><p>Daten nicht verfügbar<\/p><button[^>]*>Erneut versuchen/);
    assert.ok(list([], { loading: true }).includes("Lädt"));
    assert.ok(list([mail(1)], { canLoadMore: true }).includes("Mehr laden"));
  });
});

describe("folded noise section", () => {
  const noiseMail = mail(90, { category: "newsletter_promo", subject: "Aktion 90", urgency: 0, importance: 0 });

  it("is collapsed under the list with title and count and loads nothing", () => {
    const html = list([mail(1)], { noise: { open: false, emails: [noiseMail], loading: false, canLoadMore: false, error: false } });
    assert.match(html, /<button type="button" class="fold-head" aria-expanded="false" aria-controls="noise-list">/);
    assert.ok(html.includes("Newsletter &amp; Werbung / Aussortiert"));
    assert.match(html, /<span class="fold-count">41<\/span>/);
    assert.ok(!html.includes("Aktion 90"), "collapsed: no noise cards");
    assert.ok(html.indexOf("Betreff 1") < html.indexOf("fold-head"), "sits under the important list");
  });

  it("shows the noise cards when expanded", () => {
    const html = list([mail(1)], { noise: { open: true, emails: [noiseMail], loading: false, canLoadMore: true, error: false } });
    assert.match(html, /aria-expanded="true" aria-controls="noise-list"/);
    assert.match(html, /<div id="noise-list" class="fold-body">/);
    assert.ok(html.includes("Aktion 90"));
    assert.ok(html.includes("Mehr laden"));
  });

  it("shows loading and error inside the open section", () => {
    const loading = list([mail(1)], { noise: { open: true, emails: [], loading: true, canLoadMore: false, error: false } });
    assert.match(loading, /id="noise-list"[^>]*>[\s\S]*Lädt/);
    const error = list([mail(1)], { noise: { open: true, emails: [], loading: false, canLoadMore: false, error: true } });
    assert.ok(error.includes("Aussortiertes konnte nicht geladen werden"));
  });

  it("is only offered in the Wichtig view and hidden without noise", () => {
    assert.ok(!list([mail(1)], { view: "open" }).includes("fold-head"));
    assert.ok(!list([mail(1)], { view: "all" }).includes("fold-head"));
    assert.ok(!list([mail(1)], { counts: { ...COUNTS, noise: 0 } }).includes("fold-head"));
  });

  it("keeps the section reachable when the important list is empty", () => {
    const html = list([], { counts: { ...COUNTS, important: 0 } });
    assert.ok(html.includes("Nichts Wichtiges. Alles ruhig."));
    assert.ok(html.includes("fold-head"));
  });
});

describe("EmailDetailView", () => {
  const detailOf = (m: ApiEmail, over: Partial<ApiEmailDetail> = {}): ApiEmailDetail => ({
    ...m,
    folder_history: [{ at: "2026-10-26T08:30:00.000Z", from: "INBOX", to: "Junk" }],
    locations: [{ folder: "Junk", is_active: true, first_seen_at: "2026-10-26T08:30:00.000Z", last_seen_at: "2026-10-27T08:30:00.000Z" }],
    ...over,
  });
  const detail = (m: ApiEmailDetail, over: Record<string, unknown> = {}) =>
    renderToStaticMarkup(createElement(EmailDetailView, { email: m, now: NOW, timeZone: TZ, ...over }));

  it("shows the essentials on top: subject, sender, account tag, time, category, urgency, importance, status", () => {
    const html = detail(detailOf(mail(7, { open: true, route: "notify" })));
    assert.match(html, /<a class="back" href="\/">/);
    assert.ok(html.includes("Betreff 7"));
    assert.ok(html.includes("noreply@example.test"));
    assert.match(html, /<span class="acct"><span class="acct-dot" style="background:#3b82f6"[^>]*><\/span>Web<\/span>/);
    assert.ok(html.includes("09:30"));
    const top = html.slice(0, html.indexOf("<details"));
    assert.ok(top.includes("Persönlich"));
    assert.ok(top.includes("Stufe 3 von 3: Heute oder blockierend"));
    assert.ok(top.includes("Stufe 2 von 3: Folgenreich"));
    assert.ok(top.includes("Offen"));
  });

  it("shows the work state of a done mail", () => {
    const html = detail(detailOf(mail(7, { done: true })));
    assert.ok(html.slice(0, html.indexOf("<details")).includes("Erledigt"));
  });

  it("keeps disagreement and shadow short above the folded details", () => {
    const html = detail(detailOf(mail(7, {
      disagreement: "jev_spam_provider_not_spam",
      shadow_quarantine: { candidate: true, decision: "pending_policy", reason: "candidate", applied_threshold: 0.9 },
    })));
    const top = html.slice(0, html.indexOf("<details"));
    assert.ok(top.includes("Jev: Spam, Provider: nicht Spam"));
    assert.ok(top.includes("Spam-Kandidat"));
  });

  it("folds raw values, probabilities, calibration and the folder history into Details", () => {
    const html = detail(detailOf(mail(7)));
    const at = html.indexOf("<details");
    assert.ok(at > 0);
    assert.match(html, /<details class="fold-panel"><summary>Details<\/summary>/, "folded: no open attribute");
    const rest = html.slice(at);
    assert.ok(rest.includes("Welche Art von Mail ist das?"));
    assert.ok(rest.includes("80 %"));
    assert.ok(rest.includes("Rohwert 0,9, noch unkalibriert"));
    assert.match(rest, /role="meter"[^>]*aria-valuenow="0.9"/);
    assert.ok(rest.includes("Ordnerverlauf"));
    assert.ok(rest.includes("INBOX → Junk"));
    assert.ok(rest.includes("Junk"));
    const top = html.slice(0, at);
    assert.ok(!top.includes("Welche Art von Mail ist das?"));
    assert.ok(!top.includes("role=\"meter\""));
    assert.ok(!top.includes("Ordnerverlauf"));
  });

  it("renders threshold and config version for a calibrated answer", () => {
    const answers: Record<string, ApiAnswer> = { ...ANSWERS, is_spam: { type: "noul", value: 0.87, reading: "positive", threshold: 0.8, calibration_version: "1" } };
    const html = detail(detailOf(mail(9, { classification: { status: "classified", answers } })));
    assert.ok(html.includes("Rohwert 0,87, Schwelle 0,8 (Kalibrierung Version 1)"));
  });

  it("explains an unclassified mail and an empty history", () => {
    const html = detail(detailOf(mail(8, { classification: null, shadow_quarantine: null, category: null, urgency: null, importance: null }), { folder_history: [] }));
    assert.ok(html.includes("Nicht bewertet"));
    assert.ok(html.includes("Noch keine Jev-Antworten"));
    assert.ok(html.includes("Kein Ordnerwechsel beobachtet"));
  });

  it("never prints content fields", () => {
    assert.ok(!detail(detailOf(mail(7))).includes(MARKER));
  });
});

describe("page shells", () => {
  it("the list page renders no mail data on the server", async () => {
    const page = await loadTsx<{ default: () => React.JSX.Element }>("app/page.tsx");
    const html = renderToStaticMarkup(createElement(page.default));
    assert.ok(html.includes("Mails"));
    assert.ok(html.includes("Lädt"));
    assert.ok(!html.includes('href="/emails/'));
    assert.ok(!html.includes("fold-head"), "no counts yet, so no noise section");
  });

  it("the detail page shell shows only a loading state on the server", async () => {
    const page = await loadTsx<{ default: () => React.JSX.Element }>("app/emails/[id]/page.tsx");
    const html = renderToStaticMarkup(createElement(page.default));
    assert.ok(html.includes("Lädt"));
    assert.ok(!html.includes("Jev-Antworten"));
  });
});
