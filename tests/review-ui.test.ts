import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  cardBadges,
  describeAnswers,
  EMPTY_TITLE,
  emptyText,
  folderHistoryRows,
  formatCount,
  formatPercent,
  formatTime,
  groupByUrgency,
  isViewId,
  listUrl,
  safeColor,
  scoreLevel,
  shadowText,
  VIEWS,
  VIEW_LABEL,
  workState,
  type ApiAnswer,
  type ApiEmail,
} from "../lib/review-ui.ts";

const TZ = "Europe/Berlin";
const NOW = new Date("2026-10-27T12:00:00.000Z");

function mail(id: number, over: Partial<ApiEmail> = {}): ApiEmail {
  return {
    id,
    account: { id: "hf-a", label: "Web", color: "#3b82f6" },
    sender: "noreply@example.test",
    subject: `Betreff ${id}`,
    received_at: "2026-10-27T08:30:00.000Z",
    active_location: { folder: "INBOX", uid: id },
    provider_spam: false,
    seen: false,
    done: false,
    open: false,
    category: null,
    route: null,
    urgency: null,
    importance: null,
    needs_my_reply: null,
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


describe("views and requests", () => {
  it("offers Wichtig, Offen, Alle in this order", () => {
    assert.deepEqual([...VIEWS], ["important", "open", "all"]);
    assert.deepEqual(VIEWS.map((v) => VIEW_LABEL[v]), ["Wichtig", "Offen", "Alle"]);
    assert.equal(isViewId("open"), true);
    assert.equal(isViewId("noise"), false, "noise is the folded section, not a segment");
    assert.equal(isViewId(undefined), false);
  });

  it("builds the list URL with view, account, cursor and limit", () => {
    assert.equal(listUrl({ view: "important", limit: 30 }), "/api/emails?view=important&limit=30");
    assert.equal(
      listUrl({ view: "noise", account: "hf-a", cursor: "abc_-9", limit: 10 }),
      "/api/emails?view=noise&limit=10&account=hf-a&cursor=abc_-9",
    );
    assert.equal(listUrl({ view: "all", account: "", limit: 5 }), "/api/emails?view=all&limit=5", "empty account = all accounts");
    assert.match(listUrl({ view: "all", account: "a b&c", limit: 5 }), /account=a\+b%26c/);
  });

  it("formats counts compactly", () => {
    assert.equal(formatCount(0), "0");
    assert.equal(formatCount(42), "42");
    assert.equal(formatCount(1500), "999+");
  });

  it("has an empty text per view", () => {
    assert.equal(EMPTY_TITLE, "Keine Mails in dieser Ansicht");
    assert.match(emptyText("important"), /Alles ruhig/);
    assert.match(emptyText("open"), /erledigt/i);
    assert.match(emptyText("all"), /Noch keine Mails/);
  });
});

describe("grouping by urgency", () => {
  it("builds contiguous urgency groups and keeps the order", () => {
    const list = [
      mail(1, { urgency: 3.0 }),
      mail(2, { urgency: 2.7 }), // rounds to 3
      mail(3, { urgency: 2 }),
      mail(4, { urgency: 1 }),
      mail(5, { urgency: null }),
    ];
    const g = groupByUrgency(list);
    assert.deepEqual(g.map((x) => [x.key, x.label, x.items.map((m) => m.id)]), [
      ["now", "Dringend – heute", [1, 2]],
      ["soon", "Innerhalb 48 h", [3]],
      ["week", "Diese Woche", [4]],
      ["unrated", "Noch nicht bewertet", [5]],
    ]);
  });

  it("returns no groups for an empty list and does not merge separated runs", () => {
    assert.deepEqual(groupByUrgency([]), []);
    const g = groupByUrgency([mail(1, { urgency: 0 }), mail(2, { urgency: 3 }), mail(3, { urgency: 0 })]);
    assert.deepEqual(g.map((x) => x.key), ["later", "now", "later"]);
    assert.deepEqual(g.map((x) => x.label), ["Kann warten", "Dringend – heute", "Kann warten"]);
  });
});

describe("account color", () => {
  it("accepts hex colors only", () => {
    assert.equal(safeColor("#3b82f6"), "#3b82f6");
    assert.equal(safeColor("#abc"), "#abc");
    assert.equal(safeColor("red; background:url(x)"), "#98a2b3");
    assert.equal(safeColor(""), "#98a2b3");
    assert.equal(safeColor(undefined), "#98a2b3");
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

describe("work state and history", () => {
  it("derives the state shown in the detail", () => {
    assert.equal(workState(mail(1, { open: true })), "open");
    assert.equal(workState(mail(1, { done: true })), "done");
    assert.equal(workState(mail(1, { seen: true })), "seen");
    assert.equal(workState(mail(1)), "none");
    assert.equal(workState(mail(1, { done: true, seen: true })), "done");
  });

  it("describes the folder history, newest first", () => {
    const rows = folderHistoryRows([
      { at: "2026-10-26T08:30:00.000Z", from: "INBOX", to: "Junk" },
      { at: "2026-10-27T08:30:00.000Z", from: "Junk", to: null },
    ], NOW, TZ);
    assert.deepEqual(rows, [
      { key: "1", when: "09:30", text: "Junk → unbekannt" },
      { key: "0", when: "gestern 09:30", text: "INBOX → Junk" },
    ]);
  });
});

describe("badges and answers", () => {
  it("builds speaking badges for a classified mail", () => {
    const m = mail(1, {
      classification: classified(ANSWERS),
      category: "newsletter_promo",
      importance: 0.09,
      urgency: 2.4,
      shadow_quarantine: { candidate: true, decision: "pending_policy", reason: "candidate", applied_threshold: 0.9 },
      disagreement: "jev_spam_provider_not_spam",
    });
    assert.deepEqual(cardBadges(m).map((b) => b.text), [
      "Newsletter / Werbung",
      "Wichtig: Routine",
      "Dringend: 48 Std.",
      "Shadow: Spam-Kandidat",
      "Jev: Spam, Provider: nicht Spam",
    ]);
  });

  it("puts Offen first and shows Erledigt", () => {
    const open = cardBadges(mail(1, { open: true, classification: classified(ANSWERS), category: "personal" }));
    assert.equal(open[0].text, "Offen");
    assert.equal(open[0].tone, "accent");
    assert.equal(open[1].text, "Persönlich");
    const done = cardBadges(mail(2, { done: true, classification: classified(ANSWERS), category: "personal" }));
    assert.equal(done[0].text, "Erledigt");
    assert.equal(done[0].tone, "good");
    assert.ok(!done.some((b) => b.text === "Offen"));
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

  it("shows Ja/Nein plus threshold and config version for calibrated answers, raw value for the rest", () => {
    const cal = (value: number, reading: "positive" | "negative") =>
      ({ type: "noul", value, reading, threshold: 0.8, calibration_version: "1" }) as ApiAnswer;
    const items = describeAnswers({
      is_spam: cal(0.87, "positive"),
      is_phishing_or_scam: { type: "noul", value: 0.1, reading: "negative", threshold: 0.5, calibration_version: "1" },
      needs_my_reply: { type: "noul", value: 0.9, reading: "unmapped", threshold: null, calibration_version: null },
    });
    const by = (k: string) => items.find((i) => i.key === k)!;
    assert.equal(by("is_spam").answer, "Ja");
    assert.equal(by("is_spam").bar?.uncalibrated, false);
    assert.equal(by("is_spam").bar?.detail, "Rohwert 0,87, Schwelle 0,8 (Kalibrierung Version 1)");
    assert.equal(by("is_phishing_or_scam").answer, "Nein");
    assert.equal(by("needs_my_reply").answer, "Rohwert 0,9, noch unkalibriert");
    assert.equal(by("needs_my_reply").bar?.detail, undefined);
  });

  it("explains shadow reasons", () => {
    const base = { candidate: false, decision: "no", applied_threshold: 0.9 };
    assert.match(shadowText({ ...base, reason: "unmapped_answer" }), /unkalibriert/);
    assert.match(shadowText({ ...base, reason: "below_threshold" }), /Schwelle 0,9/);
    assert.match(shadowText({ ...base, reason: "candidate" }), /nichts verschoben/);
    assert.match(shadowText({ ...base, reason: "security_auth" }), /Sicherheit/);
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

  it("keeps focus rings and reduced motion, and a 44 px fold header", () => {
    assert.match(css, /prefers-reduced-motion:\s*reduce/);
    assert.match(css, /:focus-visible/);
    assert.match(css, /\.fold-head[^{]*{[^}]*min-height:\s*44px/);
    assert.match(css, /\.chip[^{]*{[^}]*min-height:\s*44px/);
  });
});
