import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { loadTsx } from "./helpers/load-tsx.ts";
import type {
  ActionRow, ActionsCounts, ApiAccount, ApiAction, ApiCounts, ApiEmail, ApiEmailDetail, ApiMailboxAction,
} from "../lib/review-ui.ts";

type Actions = typeof import("../components/actions.tsx");
type Review = typeof import("../components/review.tsx");
const { ActionsView } = await loadTsx<Actions>("components/actions.tsx");
const { EmailDetailView, ReviewListView } = await loadTsx<Review>("components/review.tsx");

const TZ = "Europe/Berlin";
const NOW = new Date("2026-10-27T12:00:00.000Z");
const MARKER = "GEHEIMER-INHALT-MARKER";
const WEB: ApiAccount = { id: "a1", label: "Web", color: "#3b82f6" };
const WORK: ApiAccount = { id: "a2", label: "Firma", color: "#f97316" };
const noop = (): void => {};

function mail(id: number, over: Partial<ApiEmail> = {}): ApiEmail {
  return {
    id, account: WEB, sender: `spam${id}@example.test`, subject: `Betreff ${id}`, received_at: "2026-10-14T08:30:00.000Z",
    active_location: { folder: "Junk", uid: id }, provider_spam: true, seen: true, done: false, open: false,
    category: "spam", route: "ignore", urgency: 0, importance: 0, needs_my_reply: null,
    classification: { status: "classified", answers: {} }, shadow_quarantine: null, disagreement: null, ...over,
  };
}
const act = (id: number, over: Partial<ApiAction> = {}): ApiAction => ({
  id, email_id: id, account: "a1", rule: "spam_seen", action: "mark_seen", mode: "dry_run", status: "planned",
  failure_code: null, created_at: "2026-10-27T10:00:00.000Z", ...over,
});
const COUNTS: ActionsCounts = {
  dry_run: { planned: 2, done: 0, failed: 0, undone: 1 }, live: { planned: 0, done: 1, failed: 2, undone: 0 },
};

function view(over: Record<string, unknown> = {}, rows?: ActionRow[]): string {
  return renderToStaticMarkup(createElement(ActionsView, {
    tab: "dry_run", counts: COUNTS, rows: rows ?? [{ action: act(1), email: mail(1) }, { action: act(2), email: mail(2) }],
    accounts: [WEB, WORK], modes: { a1: "dry_run", a2: "dry_run" }, now: NOW, timeZone: TZ,
    loading: false, error: null, canLoadMore: false, busy: new Set<number>(),
    onTab: noop, onMore: noop, onUnread: noop, onReload: noop, toast: null, onToastClose: noop,
    ...over,
  }));
}

describe("Aussortiert view: dry run", () => {
  it("explains the dry run per account and links back to the list", () => {
    const html = view();
    assert.match(html, /<h1>Aussortiert<\/h1>/);
    assert.match(html, /href="\/"/);
    assert.ok(html.includes("Trockenlauf: nichts wird im Postfach geändert"));
    assert.ok(html.includes("Web") && html.includes("Firma"));
  });

  it("shows planned actions as Würde als gelesen markieren with mail card, account tag and the undo button", () => {
    const html = view();
    assert.equal(html.match(/Würde als gelesen markieren/g)?.length, 2, "one label per row");
    assert.ok(html.includes("Betreff 1") && html.includes("spam2@example.test"));
    assert.match(html, /<a class="card" href="\/emails\/1"/);
    assert.ok(html.includes("acct-dot"));
    assert.equal(html.match(/>Wieder ungelesen</g)?.length, 2);
    assert.match(html, /aria-label="Wieder ungelesen: Betreff 1"/);
  });

  it("tabs carry the counts and mark the active one", () => {
    const html = view();
    assert.match(html, /aria-pressed="true"[^>]*><span class="seg-label">Trockenlauf<\/span><span class="seg-count">2<\/span>/);
    assert.match(html, /aria-pressed="false"[^>]*><span class="seg-label">Ausgeführt<\/span><span class="seg-count">1<\/span>/);
  });

  it("is empty-state friendly", () => {
    const html = view({ counts: { ...COUNTS, dry_run: { planned: 0, done: 0, failed: 0, undone: 0 } } }, []);
    assert.ok(html.includes("Nichts geplant"));
    assert.ok(!html.includes("Wieder ungelesen"));
  });

  it("shows skeletons while mails load and a quiet note for a vanished mail", () => {
    const html = view({}, [{ action: act(1), email: null }, { action: act(2), email: "missing" }]);
    assert.ok(html.includes("skeleton"));
    assert.ok(html.includes("Mail nicht mehr vorhanden"));
  });
});

describe("Aussortiert view: live", () => {
  const live = [{ action: act(3, { mode: "live", status: "done" }), email: mail(3, { account: WORK }) }];
  it("shows executed actions as Als gelesen markiert, with the live notice", () => {
    const html = view({ tab: "live", modes: { a1: "dry_run", a2: "live" } }, live);
    assert.ok(html.includes("Als gelesen markiert"));
    assert.ok(!html.includes("Würde als gelesen markieren"), "no dry-run wording in the live tab");
    assert.ok(html.includes("Live: Spam wird im Postfach als gelesen markiert"));
    assert.ok(html.includes("Wieder ungelesen"));
  });
  it("mentions failed live actions without codes", () => {
    const html = view({ tab: "live" }, live);
    assert.ok(html.includes("2 fehlgeschlagen"));
    assert.ok(!/store_rejected|imap_error/.test(html));
  });
});

describe("Aussortiert view: state and errors", () => {
  it("renders the toast and an error alert for the failure texts", () => {
    const ok = view({ toast: { text: "Wieder ungelesen", error: false } });
    assert.match(ok, /role="status"/);
    const bad = view({ toast: { text: "Der Not-Aus ist aktiv.", error: true } });
    assert.match(bad, /role="alert"/);
    assert.ok(bad.includes("Der Not-Aus ist aktiv."));
    assert.ok(view({ error: "Daten nicht verfügbar" }).includes("Erneut versuchen"));
  });
  it("disables the button of a busy row", () => {
    const html = view({ busy: new Set([1]) });
    assert.equal(html.match(/<button[^>]*disabled=""[^>]*>Wieder ungelesen/g)?.length, 1);
  });
  it("prints no content fields and no code values", () => {
    const leaky = { ...mail(1), body: MARKER, excerpt: MARKER, raw: MARKER } as ApiEmail;
    const html = view({}, [{ action: act(1, { failure_code: "imap_error" }), email: leaky }]);
    assert.ok(!html.includes(MARKER));
    assert.ok(!html.includes("imap_error"));
    assert.ok(!/<form|<textarea|method="post"/i.test(html));
  });
});

const COUNTS_LIST: ApiCounts = { important: 12, open: 3, noise: 41, all: 53 };
const list = (over: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(ReviewListView, {
    emails: [mail(1, { urgency: 3, provider_spam: false, category: "personal" })], view: "important", counts: COUNTS_LIST,
    accounts: [WEB, WORK], account: "", now: NOW, timeZone: TZ, loading: false, error: null, canLoadMore: false,
    noise: { open: false, emails: [], loading: false, canLoadMore: false, error: false }, ...over,
  }));

describe("list header", () => {
  it("says read-only while no account is live and links to Aussortiert", () => {
    const html = list({ autoActions: { a1: "dry_run", a2: "dry_run" } });
    assert.ok(html.includes("Alle Konten · Postfach nur lesend"));
    assert.match(html, /<a class="[^"]*" href="\/aussortiert"/);
    assert.ok(html.includes("Dringend – heute"));
  });
  it("announces automatic marking once an account is live", () => {
    const html = list({ autoActions: { a1: "dry_run", a2: "live" } });
    assert.ok(html.includes("Spam wird automatisch als gelesen markiert"));
    assert.ok(!html.includes("Postfach nur lesend"));
  });
  it("without mode information the safe reading stays", () => {
    assert.ok(list().includes("Postfach nur lesend"));
  });
  it("points the folded section to Aussortiert", () => {
    const html = list({ noise: { open: true, emails: [], loading: false, canLoadMore: false, error: false } });
    assert.match(html, /<a class="fold-link" href="\/aussortiert"/);
  });
});

describe("detail: automatic action", () => {
  const ma = (over: Partial<ApiMailboxAction> = {}): ApiMailboxAction => ({
    id: 1, rule: "spam_seen", action: "mark_seen", mode: "dry_run", status: "planned", failure_code: null,
    created_at: "2026-10-27T10:00:00.000Z", ...over,
  });
  const detail = (a: ApiMailboxAction | null, over: Record<string, unknown> = {}) =>
    renderToStaticMarkup(createElement(EmailDetailView, {
      email: { ...mail(1), mailbox_action: a, folder_history: [], locations: [] } as ApiEmailDetail,
      now: NOW, timeZone: TZ, onUnread: noop, ...over,
    }));

  it("planned: Würde automatisch als gelesen markiert plus Wieder ungelesen", () => {
    const html = detail(ma());
    assert.ok(html.includes("Würde automatisch als gelesen markiert"));
    assert.ok(html.includes("Trockenlauf: im Postfach wird nichts geändert"));
    assert.ok(html.includes(">Wieder ungelesen<"));
  });
  it("live done: Automatisch als gelesen markiert", () => {
    const html = detail(ma({ mode: "live", status: "done" }));
    assert.ok(html.includes("Automatisch als gelesen markiert"));
    assert.ok(!html.includes("Würde automatisch"));
    assert.ok(html.includes(">Wieder ungelesen<"));
  });
  it("nothing for undone, failed or no action", () => {
    for (const a of [ma({ status: "undone" }), ma({ mode: "live", status: "failed" }), null]) {
      const html = detail(a);
      assert.ok(!html.includes("automatisch als gelesen"), String(a?.status));
      assert.ok(!html.includes("Wieder ungelesen"));
    }
  });
  it("read-only detail shows the hint without a button; an error text shows as alert", () => {
    const html = detail(ma(), { onUnread: undefined });
    assert.ok(html.includes("Würde automatisch als gelesen markiert") && !html.includes(">Wieder ungelesen<"));
    const err = detail(ma(), { unreadMessage: { text: "Der Not-Aus ist aktiv.", error: true } });
    assert.match(err, /role="alert"[^>]*>Der Not-Aus ist aktiv\./);
  });
});
