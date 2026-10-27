import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  compareEmails,
  isCta,
  markDone,
  reinsert,
  swipeCommits,
  swipeOffset,
  type ListState,
} from "../lib/review-done.ts";
import { compareSortKeys } from "../lib/email-api.ts";
import type { ApiCounts, ApiEmail } from "../lib/review-ui.ts";

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

const COUNTS: ApiCounts = { important: 5, open: 3, noise: 2, all: 7 };
const state = (emails: ApiEmail[], view: ListState["view"] = "important", counts: ApiCounts = COUNTS): ListState => ({ emails, counts, view });

describe("open and done (optimistic)", () => {
  it("knows a call to action by reading or route", () => {
    assert.equal(isCta(mail(1, { needs_my_reply: "positive" })), true);
    assert.equal(isCta(mail(1, { route: "notify" })), true);
    assert.equal(isCta(mail(1, { route: "draft_reply" })), true);
    assert.equal(isCta(mail(1, { route: "digest", needs_my_reply: "negative" })), false);
    assert.equal(isCta(mail(1, { needs_my_reply: "unmapped" })), false);
  });

  it("marks done in place: open drops, open counter drops, the input stays untouched", () => {
    const list = [mail(1, { open: true, route: "notify" }), mail(2)];
    const s = state(list);
    const r = markDone(s, 1, true);
    assert.equal(r.item?.id, 1);
    assert.equal(r.item?.done, false, "item is the version before the change (for Undo)");
    assert.equal(r.state.emails[0].done, true);
    assert.equal(r.state.emails[0].open, false);
    assert.deepEqual(r.state.counts, { ...COUNTS, open: 2 });
    assert.equal(s.emails[0].done, false);
    assert.deepEqual(s.counts, COUNTS);
  });

  it("removes the mail from the open view", () => {
    const r = markDone(state([mail(1, { open: true, route: "notify" }), mail(2, { open: true, route: "notify" })], "open"), 1, true);
    assert.deepEqual(r.state.emails.map((m) => m.id), [2]);
    assert.equal(r.state.counts.open, 2);
  });

  it("does not change the open counter for a mail that was not open", () => {
    const r = markDone(state([mail(1)]), 1, true);
    assert.equal(r.state.counts.open, COUNTS.open);
    assert.equal(r.state.emails[0].done, true);
  });

  it("returns the same state for an unknown id", () => {
    const s = state([mail(1)]);
    const r = markDone(s, 99, true);
    assert.equal(r.state, s);
    assert.equal(r.item, null);
  });

  it("undo via done=false recomputes open from the call to action and unread state", () => {
    const done = mail(1, { done: true, route: "notify" });
    assert.equal(markDone(state([done]), 1, false).state.emails[0].open, true);
    assert.equal(markDone(state([{ ...done, seen: true }]), 1, false).state.emails[0].open, false, "read mails are never open");
    assert.equal(markDone(state([mail(2, { done: true })]), 2, false).state.emails[0].open, false, "no call to action");
  });

  it("reinsert puts a removed mail back at its sorted position and restores the counter", () => {
    const a = mail(1, { urgency: 3, open: true, route: "notify" });
    const b = mail(2, { urgency: 2, open: true, route: "notify" });
    const c = mail(3, { urgency: 1, open: true, route: "notify" });
    const r = markDone(state([a, b, c], "open"), 2, true);
    assert.deepEqual(r.state.emails.map((m) => m.id), [1, 3]);
    const back = reinsert(r.state, r.item!);
    assert.deepEqual(back.emails.map((m) => m.id), [1, 2, 3]);
    assert.deepEqual(back.counts, COUNTS);
  });

  it("reinsert replaces a mail that is still in the list", () => {
    const m = mail(1, { open: true, route: "notify" });
    const r = markDone(state([m, mail(2)]), 1, true);
    const back = reinsert(r.state, r.item!);
    assert.equal(back.emails.length, 2);
    assert.deepEqual(back.emails.find((x) => x.id === 1), m);
    assert.deepEqual(back.counts, COUNTS);
  });

  it("client sort order matches the server order", () => {
    const keys = [
      { u: 3, i: 1, t: "2026-10-27T08:00:00.000Z", id: 1 },
      { u: 3, i: 1, t: "2026-10-27T09:00:00.000Z", id: 2 },
      { u: 3, i: 2, t: "2026-10-26T09:00:00.000Z", id: 3 },
      { u: null, i: 3, t: "2026-10-27T09:00:00.000Z", id: 4 },
      { u: 1, i: null, t: "2026-10-27T09:00:00.000Z", id: 5 },
      { u: 1, i: null, t: "2026-10-27T09:00:00.000Z", id: 6 },
    ];
    for (const a of keys) {
      for (const b of keys) {
        const ma = mail(a.id, { urgency: a.u, importance: a.i, received_at: a.t });
        const mb = mail(b.id, { urgency: b.u, importance: b.i, received_at: b.t });
        const server = compareSortKeys(
          { urgency: a.u, importance: a.i, receivedAt: a.t, id: a.id },
          { urgency: b.u, importance: b.i, receivedAt: b.t, id: b.id },
        );
        assert.equal(Math.sign(compareEmails(ma, mb)), Math.sign(server), `${a.id} vs ${b.id}`);
      }
    }
  });
});

describe("swipe", () => {
  it("moves only to the left, with a cap", () => {
    assert.equal(swipeOffset(40), 0, "no swipe to the right");
    assert.equal(swipeOffset(0), 0);
    assert.equal(swipeOffset(-50), -50);
    assert.ok(swipeOffset(-500) >= -160 && swipeOffset(-500) < -96, "capped, past the threshold");
  });

  it("commits at about a third of the width, at most 96 px", () => {
    assert.equal(swipeCommits(-96, 390), true);
    assert.equal(swipeCommits(-95, 390), false);
    assert.equal(swipeCommits(-70, 200), true, "narrow rows commit at 35 % of the width");
    assert.equal(swipeCommits(-69, 200), false);
    assert.equal(swipeCommits(-10, 200), false);
    assert.equal(swipeCommits(120, 390), false);
  });
});

describe("stylesheet for the done actions", () => {
  const css = readFileSync(join(import.meta.dirname, "..", "globals.css"), "utf8");
  it("keeps the swipe gesture scroll-safe and the buttons at 44 px", () => {
    assert.match(css, /touch-action:\s*pan-y/);
    assert.match(css, /\.done-btn[^{]*{[^}]*min-width:\s*44px/);
    assert.match(css, /\.toast-btn[^{]*{[^}]*min-height:\s*44px/);
  });
});
