import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  availableViews,
  cardBadges,
  defaultView,
  describeAnswers,
  filterByView,
  formatPercent,
  formatTime,
  isNeedsReplyCalibrated,
  scoreLevel,
  shadowText,
  type ApiEmail,
  type ApiAnswer,
} from "../lib/review-ui.ts";

const TZ = "Europe/Berlin";
const NOW = new Date("2026-10-27T12:00:00.000Z");

function mail(id: number, over: Partial<ApiEmail> = {}): ApiEmail {
  return {
    id,
    account_id: "hf-a",
    sender: "noreply@example.test",
    subject: `Betreff ${id}`,
    received_at: "2026-10-27T08:30:00.000Z",
    active_location: { folder: "INBOX", uid: id },
    provider_spam: false,
    classification: null,
    shadow_quarantine: null,
    disagreement: null,
    ...over,
  };
}

const classified = (answers: Record<string, ApiAnswer>): ApiEmail["classification"] => ({ status: "classified", answers });

const ANSWERS: Record<string, ApiAnswer> = {
  category: { type: "choice", value: "newsletter_promo", probabilities: { newsletter_promo: 0.7, spam: 0.2, unclear: 0.1 } },
  route: { type: "choice", value: "ignore" },
  importance: { type: "score", value: 0.09, probabilities: { "0": 0.94, "1": 0.04, "2": 0, "3": 0.02 } },
  urgency: { type: "score", value: 2.4 },
  is_spam: { type: "noul", value: 0.82 },
  is_phishing_or_scam: { type: "noul", value: 0.3 },
  needs_my_reply: { type: "noul", value: 0.83 },
  addresses_an_ai: { type: "noul", value: 0.96 },
  is_assessable: { type: "noul", value: 0.95 },
};

describe("views", () => {
  it("starts with Heute while needs_my_reply is uncalibrated (O4)", () => {
    assert.equal(isNeedsReplyCalibrated(), false);
    assert.deepEqual(availableViews(), ["today", "disagreements", "all"]);
    assert.equal(defaultView(), "today");
  });

  it("offers Braucht Antwort first once the interpreter maps noul", () => {
    const calibrated = (a: { value: number | string }) => (Number(a.value) >= 0.5 ? "positive" as const : "negative" as const);
    assert.deepEqual(availableViews(calibrated), ["needs_reply", "today", "disagreements", "all"]);
    assert.equal(defaultView(calibrated), "needs_reply");
  });

  it("filters today by local calendar day", () => {
    const list = [
      mail(1, { received_at: "2026-10-27T08:30:00.000Z" }),
      mail(2, { received_at: "2026-10-26T23:30:00.000Z" }), // 27.10. 00:30 in Berlin
      mail(3, { received_at: "2026-10-26T22:30:00.000Z" }), // 26.10. 23:30 in Berlin
    ];
    assert.deepEqual(filterByView(list, "today", { now: NOW, timeZone: TZ }).map((m) => m.id), [1, 2]);
  });

  it("filters disagreements and keeps all", () => {
    const list = [mail(1), mail(2, { disagreement: "jev_spam_provider_not_spam" }), mail(3)];
    assert.deepEqual(filterByView(list, "disagreements").map((m) => m.id), [2]);
    assert.equal(filterByView(list, "all").length, 3);
  });

  it("filters needs_reply only through the interpreter", () => {
    const list = [
      mail(1, { classification: classified({ needs_my_reply: { type: "noul", value: 0.9 } }) }),
      mail(2, { classification: classified({ needs_my_reply: { type: "noul", value: 0.1 } }) }),
      mail(3),
    ];
    assert.deepEqual(filterByView(list, "needs_reply").map((m) => m.id), []);
    const calibrated = (a: { value: number | string }) => (Number(a.value) >= 0.5 ? "positive" as const : "negative" as const);
    assert.deepEqual(filterByView(list, "needs_reply", { interpret: calibrated }).map((m) => m.id), [1]);
  });
});

describe("formatting", () => {
  it("formats times relative to now", () => {
    assert.equal(formatTime("2026-10-27T08:30:00.000Z", NOW, TZ), "09:30");
    assert.equal(formatTime("2026-10-26T08:30:00.000Z", NOW, TZ), "gestern 09:30");
    assert.equal(formatTime("2026-10-23T08:30:00.000Z", NOW, TZ), "Fr 10:30");
    assert.equal(formatTime("2026-09-01T08:30:00.000Z", NOW, TZ), "01.09.");
    assert.equal(formatTime("kaputt", NOW, TZ), "");
  });

  it("rounds score levels to 0..3 and clamps", () => {
    assert.equal(scoreLevel(0.09), 0);
    assert.equal(scoreLevel(2.4), 2);
    assert.equal(scoreLevel(7), 3);
    assert.equal(scoreLevel(-1), 0);
    assert.equal(scoreLevel("x"), null);
    assert.equal(formatPercent(0.764), "76 %");
  });
});

describe("badges and answers", () => {
  it("builds speaking badges for a classified mail", () => {
    const m = mail(1, {
      classification: classified(ANSWERS),
      shadow_quarantine: { candidate: true, decision: "pending_policy", reason: "candidate", applied_threshold: 0.9 },
      disagreement: "jev_spam_provider_not_spam",
    });
    const texts = cardBadges(m).map((b) => b.text);
    assert.deepEqual(texts, [
      "Newsletter / Werbung",
      "Wichtig: Routine",
      "Dringend: 48 Std.",
      "Shadow: Spam-Kandidat",
      "Jev: Spam, Provider: nicht Spam",
    ]);
  });

  it("shows only a status badge for unclassified mails", () => {
    assert.deepEqual(cardBadges(mail(1)).map((b) => b.text), ["Nicht bewertet"]);
    const failed = mail(2, { classification: { status: "failed", answers: {} } });
    assert.deepEqual(cardBadges(failed).map((b) => b.text), ["Bewertung fehlgeschlagen"]);
  });

  it("describes answers in German with the noul raw value marked uncalibrated", () => {
    const items = describeAnswers(ANSWERS);
    assert.deepEqual(items.map((i) => i.key), [
      "category", "route", "importance", "urgency",
      "is_spam", "is_phishing_or_scam", "needs_my_reply", "addresses_an_ai", "is_assessable",
    ]);
    const spam = items.find((i) => i.key === "is_spam")!;
    assert.equal(spam.question, "Ist das unerwünschte Massen- oder Werbepost?");
    assert.match(spam.answer, /Rohwert 0,82/);
    assert.match(spam.answer, /unkalibriert/);
    assert.equal(spam.bar?.uncalibrated, true);
    assert.equal(spam.bar?.fill, 0.82);
    const category = items.find((i) => i.key === "category")!;
    assert.equal(category.answer, "Newsletter / Werbung");
    assert.deepEqual(category.probabilities?.map((p) => [p.label, p.percent, p.selected]), [
      ["Newsletter / Werbung", "70 %", true],
      ["Spam", "20 %", false],
      ["Unklar", "10 %", false],
    ]);
    const importance = items.find((i) => i.key === "importance")!;
    assert.equal(importance.answer, "Stufe 0 von 3: Routine");
    assert.equal(importance.probabilities?.[0].percent, "94 %");
    assert.equal(items.find((i) => i.key === "urgency")!.answer, "Stufe 2 von 3: Innerhalb von 48 Stunden");
  });

  it("uses Ja/Nein once the interpreter maps noul", () => {
    const items = describeAnswers({ is_spam: { type: "noul", value: 0.9 } }, () => "positive");
    assert.equal(items[0].answer, "Ja");
    assert.equal(items[0].bar?.uncalibrated, false);
  });

  it("explains shadow reasons", () => {
    const base = { candidate: false, decision: "no", applied_threshold: 0.9 };
    assert.match(shadowText({ ...base, reason: "unmapped_answer" }), /unkalibriert/);
    assert.match(shadowText({ ...base, reason: "below_threshold" }), /Schwelle 0,9/);
    assert.match(shadowText({ ...base, reason: "candidate" }), /nichts verschoben/);
  });
});

describe("stylesheet", () => {
  const css = readFileSync(join(import.meta.dirname, "..", "globals.css"), "utf8");
  it("has tokens, dark mode, safe areas and touch targets", () => {
    assert.match(css, /:root\s*{[^}]*--bg:/);
    assert.match(css, /@media \(prefers-color-scheme: dark\)\s*{\s*:root\s*{[^}]*--bg:/);
    for (const side of ["top", "right", "bottom", "left"]) assert.match(css, new RegExp(`env\\(safe-area-inset-${side}`));
    assert.match(css, /min-height:\s*44px/);
    assert.match(css, /overflow-x:\s*hidden|min-width:\s*0/);
    assert.match(css, /system-ui/);
  });
});
