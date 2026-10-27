import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { loadTsx } from "./helpers/load-tsx.ts";
import type { ApiCounts, ApiEmail, ApiEmailDetail } from "../lib/review-ui.ts";

type Review = typeof import("../components/review.tsx");
const { EmailDetailView, ReviewListView, UndoToast } = await loadTsx<Review>("components/review.tsx");

const TZ = "Europe/Berlin";
const NOW = new Date("2026-10-27T12:00:00.000Z");
const COUNTS: ApiCounts = { important: 12, open: 3, noise: 41, all: 53 };

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
    category: "personal",
    route: "digest",
    urgency: 3,
    importance: 2,
    needs_my_reply: null,
    classification: { status: "classified", answers: {} },
    shadow_quarantine: null,
    disagreement: null,
    ...over,
  };
}

const noop = (): void => {};
const list = (emails: ApiEmail[], over: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(ReviewListView, {
    emails, view: "important", counts: COUNTS, accounts: [], account: "", now: NOW, timeZone: TZ,
    loading: false, error: null, canLoadMore: false,
    noise: { open: false, emails: [], loading: false, canLoadMore: false, error: false },
    onDone: noop,
    ...over,
  }));

describe("done actions on the card", () => {
  it("gives open mails a done button with the subject in its label", () => {
    const html = list([mail(1, { open: true, route: "notify" }), mail(2)]);
    assert.equal(html.match(/class="done-btn"/g)?.length, 1, "only open mails get the visible button");
    assert.match(html, /<button type="button" class="done-btn" aria-label="Als erledigt markieren: Betreff 1">/);
  });

  it("wraps swipeable rows with the reveal layer, the button stays outside the link", () => {
    const html = list([mail(1, { open: true, route: "notify" })]);
    assert.match(html, /<div class="swipe-bg" aria-hidden="true">/);
    assert.match(html, /<div class="item-front"/);
    const link = html.slice(html.indexOf('<a class="card"'), html.indexOf("</a>"));
    assert.ok(!link.includes("<button"), "no interactive element inside the link");
  });

  it("does not offer done on done mails or without a handler", () => {
    assert.ok(!list([mail(1, { done: true })]).includes("done-btn"));
    assert.ok(!list([mail(1, { done: true })]).includes("swipe-bg"));
    const without = list([mail(1, { open: true, route: "notify" })], { onDone: undefined });
    assert.ok(!without.includes("done-btn") && !without.includes("swipe-bg"));
  });

  it("does not offer done in the folded noise section", () => {
    const html = list([], {
      noise: { open: true, emails: [mail(90, { open: true, route: "notify" })], loading: false, canLoadMore: false, error: false },
    });
    assert.ok(html.includes("Betreff 90"));
    assert.ok(!html.includes("done-btn"));
  });
});

describe("UndoToast", () => {
  it("announces politely and offers Rückgängig", () => {
    const html = renderToStaticMarkup(createElement(UndoToast, { text: "Als erledigt markiert", onUndo: noop, onClose: noop }));
    assert.match(html, /role="status"/);
    assert.ok(html.includes("Als erledigt markiert"));
    assert.match(html, /<button[^>]*class="toast-btn"[^>]*>Rückgängig<\/button>/);
  });

  it("shows an error toast without the undo button", () => {
    const html = renderToStaticMarkup(createElement(UndoToast, { text: "Konnte nicht gespeichert werden.", error: true, onClose: noop }));
    assert.match(html, /role="alert"/);
    assert.ok(!html.includes("Rückgängig"));
  });

  it("is rendered by the list view when set", () => {
    const html = list([mail(1)], { toast: { text: "Als erledigt markiert", canUndo: true }, onUndo: noop, onToastClose: noop });
    assert.ok(html.includes("Als erledigt markiert"));
    assert.ok(html.includes("Rückgängig"));
  });
});

describe("done in the detail", () => {
  const detailOf = (m: ApiEmail): ApiEmailDetail => ({ ...m, folder_history: [], locations: [] });
  const detail = (m: ApiEmailDetail, over: Record<string, unknown> = {}) =>
    renderToStaticMarkup(createElement(EmailDetailView, { email: m, now: NOW, timeZone: TZ, onToggleDone: noop, ...over }));

  it("offers the button next to the status, above the folded details", () => {
    const html = detail(detailOf(mail(7, { open: true, route: "notify" })));
    const top = html.slice(0, html.indexOf("<details"));
    assert.match(top, /<button type="button" class="btn btn-accent btn-wide done-action"[^>]*>Als erledigt markieren<\/button>/);
  });

  it("offers to reopen a done mail", () => {
    const html = detail(detailOf(mail(7, { done: true })));
    assert.match(html, /done-action[^>]*>Wieder öffnen<\/button>/);
    assert.ok(!html.includes("Als erledigt markieren"));
  });

  it("shows the busy state and an error line", () => {
    assert.match(detail(detailOf(mail(7, { open: true, route: "notify" })), { busy: true }), /done-action[^>]*disabled/);
    assert.match(detail(detailOf(mail(7)), { error: "Konnte nicht gespeichert werden." }), /role="alert"[^>]*>Konnte nicht gespeichert werden\./);
  });

  it("has no button without a handler (read-only shell)", () => {
    assert.ok(!detail(detailOf(mail(7)), { onToggleDone: undefined }).includes("done-action"));
  });
});
