import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { loadTsx } from "./helpers/load-tsx.ts";
import type { ApiAnswer, ApiEmail } from "../lib/review-ui.ts";

type Review = typeof import("../components/review.tsx");
const { EmailDetailView, ReviewListView } = await loadTsx<Review>("components/review.tsx");

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

function mail(id: number, over: Partial<ApiEmail> = {}): ApiEmail {
  // body/excerpt are not part of ApiEmail on purpose: the render must never print unknown fields.
  return {
    id,
    account_id: "hf-a",
    sender: "noreply@example.test",
    subject: `Betreff ${id}`,
    received_at: "2026-10-27T08:30:00.000Z",
    active_location: { folder: "INBOX", uid: id },
    provider_spam: false,
    classification: { status: "classified", answers: ANSWERS },
    shadow_quarantine: { candidate: false, decision: "no", reason: "unmapped_answer", applied_threshold: 0.9 },
    disagreement: null,
    ...({ body: MARKER, excerpt: MARKER, raw: MARKER } as object),
    ...over,
  };
}

const list = (emails: ApiEmail[], over: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(ReviewListView, {
    emails, view: "all", accounts: ["hf-a", "hf-b"], account: "", now: NOW, timeZone: TZ,
    loading: false, error: null, canLoadMore: false, atApiLimit: false, ...over,
  }));

describe("ReviewListView", () => {
  it("renders segmented control, account select, reload button and cards as links", () => {
    const html = list([mail(1), mail(2)]);
    assert.match(html, /role="group"[^>]*aria-label="Ansicht"/);
    for (const label of ["Heute", "Abweichungen", "Alle"]) assert.ok(html.includes(label), label);
    assert.ok(!html.includes("Braucht Antwort"), "needs_reply is hidden while uncalibrated");
    assert.match(html, /aria-pressed="true"[^>]*>Alle</);
    assert.match(html, /<select[^>]*aria-label="Konto"/);
    assert.match(html, /<option value="hf-b">hf-b<\/option>/);
    assert.match(html, /<button[^>]*>Neu laden<\/button>/);
    assert.equal(html.match(/<a class="card" href="\/emails\/\d+"/g)?.length, 2);
    assert.ok(html.includes("noreply@example.test"));
    assert.ok(html.includes("Betreff 1"));
    assert.ok(html.includes("09:30"));
    assert.ok(html.includes("Persönlich"));
    assert.ok(html.includes("Wichtig: folgenreich"));
    assert.ok(html.includes("Dringend: heute"));
  });

  it("never prints content fields and has no write controls", () => {
    const html = list([mail(1)]);
    assert.ok(!html.includes(MARKER));
    assert.ok(!/<form|<textarea|type="submit"|method="post"/i.test(html));
    assert.equal((html.match(/<button/g) ?? []).length, 4, "3 view buttons + reload, nothing else");
  });

  it("filters by view and shows an empty text", () => {
    const html = list([mail(1, { received_at: "2026-10-01T08:30:00.000Z" })], { view: "today" });
    assert.ok(html.includes("Keine Mails in dieser Ansicht"));
    assert.ok(html.includes("Heute ist noch keine Mail eingegangen."));
    assert.ok(!html.includes("Betreff 1"));
  });

  it("shows shadow hint and disagreement on the card", () => {
    const html = list([mail(1, {
      shadow_quarantine: { candidate: true, decision: "pending_policy", reason: "candidate", applied_threshold: 0.9 },
      disagreement: "provider_spam_jev_not_spam",
    })]);
    assert.ok(html.includes("Shadow: Spam-Kandidat"));
    assert.ok(html.includes("Provider: Spam, Jev: nicht Spam"));
  });

  it("shows error, loading, load-more and the API limit hint", () => {
    assert.match(list([], { error: "Daten nicht verfügbar" }), /role="alert"[^>]*><p>Daten nicht verfügbar<\/p><button[^>]*>Erneut versuchen/);
    assert.ok(list([], { loading: true }).includes("Lädt"));
    assert.ok(list([mail(1)], { canLoadMore: true }).includes("Mehr laden"));
    assert.ok(list([mail(1)], { atApiLimit: true }).includes("neuesten 200"));
  });
});

describe("EmailDetailView", () => {
  const detail = (m: ApiEmail) => renderToStaticMarkup(createElement(EmailDetailView, { email: m, now: NOW, timeZone: TZ }));

  it("renders question and answer pairs, bars, probabilities and the shadow reason", () => {
    const html = detail(mail(7, { disagreement: "jev_spam_provider_not_spam" }));
    assert.match(html, /<a class="back" href="\/">/);
    assert.ok(html.includes("Betreff 7"));
    assert.ok(html.includes("Welche Art von Mail ist das?"));
    assert.ok(html.includes("Persönlich"));
    assert.ok(html.includes("80 %"));
    assert.ok(html.includes("Stufe 3 von 3: Heute oder blockierend"));
    assert.ok(html.includes("Ist das unerwünschte Massen- oder Werbepost?"));
    assert.ok(html.includes("Rohwert 0,9, noch unkalibriert"));
    assert.match(html, /role="meter"[^>]*aria-valuenow="0.9"/);
    assert.ok(html.includes("unkalibriert"));
    assert.ok(html.includes("Jev: Spam, Provider: nicht Spam"));
    assert.ok(html.includes("Noch keine Entscheidung"));
    assert.ok(html.includes("INBOX"));
    assert.ok(!html.includes(MARKER));
    assert.ok(!/<form|<textarea|type="submit"|<button/i.test(html), "no write controls before T37");
  });

  it("renders result, threshold and config version for a calibrated answer", () => {
    const answers: Record<string, ApiAnswer> = { ...ANSWERS, is_spam: { type: "noul", value: 0.87, reading: "positive", threshold: 0.8, calibration_version: "1" } };
    const m = mail(9, { classification: { status: "classified", answers } });
    const html = detail(m);
    assert.ok(html.includes("Rohwert 0,87, Schwelle 0,8 (Kalibrierung Version 1)"));
    assert.ok(!html.includes("Rohwert 0,87, noch unkalibriert"));
  });

  it("explains an unclassified mail", () => {
    const html = detail(mail(8, { classification: null, shadow_quarantine: null }));
    assert.ok(html.includes("Nicht bewertet"));
    assert.ok(html.includes("Noch keine Jev-Antworten"));
  });
});

describe("page shells", () => {
  it("the list page renders no mail data on the server", async () => {
    const page = await loadTsx<{ default: () => React.JSX.Element }>("app/page.tsx");
    const html = renderToStaticMarkup(createElement(page.default));
    assert.ok(html.includes("Mails"));
    assert.ok(html.includes("Lädt"));
    assert.ok(!html.includes('href="/emails/'));
  });

  it("the detail page shell shows only a loading state on the server", async () => {
    const page = await loadTsx<{ default: () => React.JSX.Element }>("app/emails/[id]/page.tsx");
    const html = renderToStaticMarkup(createElement(page.default));
    assert.ok(html.includes("Lädt"));
    assert.ok(!html.includes("Jev-Antworten"));
  });
});
