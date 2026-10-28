import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ACTION_PAGE_SIZE,
  actionsUrl,
  actionTitle,
  afterUnread,
  canUnread,
  defaultActionTab,
  groupByUrgency,
  headerSubtitle,
  modeNotices,
  tabCount,
  unreadHint,
  type ApiAccount,
  type ApiAction,
  type ActionsCounts,
  type ApiEmail,
  type ApiMailboxAction,
} from "../lib/review-ui.ts";
import { mapLimit, fetchActions } from "../lib/list-client.ts";
import { postEmailUnread, UNREAD_ERROR_TEXT, type MutationDeps } from "../lib/mutate-client.ts";

const A1: ApiAccount = { id: "a1", label: "Web", color: "#3b82f6" };
const A2: ApiAccount = { id: "a2", label: "Arbeit", color: "#f97316" };

function mail(id: number, urgency: number | null): ApiEmail {
  return {
    id, account: A1, sender: "s@x.test", subject: "s", received_at: "2026-10-14T08:00:00.000Z", active_location: null,
    provider_spam: false, seen: false, done: false, open: false, category: null, route: null, urgency, importance: null,
    needs_my_reply: null, classification: null, shadow_quarantine: null, disagreement: null,
  };
}

describe("urgency group titles say urgency, not a date", () => {
  it("uses Dringend – heute, Innerhalb 48 h, Diese Woche, Kann warten and a group for unrated mails", () => {
    const g = groupByUrgency([mail(1, 3), mail(2, 2), mail(3, 1), mail(4, 0), mail(5, null)]);
    assert.deepEqual(g.map((x) => [x.key, x.label]), [
      ["now", "Dringend – heute"],
      ["soon", "Innerhalb 48 h"],
      ["week", "Diese Woche"],
      ["later", "Kann warten"],
      ["unrated", "Noch nicht bewertet"],
    ]);
  });
  it("never contains the bare word Heute", () => {
    const g = groupByUrgency([mail(1, 3)]);
    assert.ok(g.every((x) => x.label !== "Heute"));
  });
});

describe("headerSubtitle", () => {
  it("says read-only until an account is live", () => {
    assert.equal(headerSubtitle([A1, A2], { a1: "dry_run", a2: "off" }, ""), "Alle Konten · Postfach nur lesend");
    assert.equal(headerSubtitle([], {}, ""), "Alle Konten · Postfach nur lesend");
    assert.equal(headerSubtitle([A1], undefined, ""), "Alle Konten · Postfach nur lesend", "unknown modes are the safe reading");
  });
  it("says spam is marked read as soon as any account is live", () => {
    assert.equal(headerSubtitle([A1, A2], { a1: "dry_run", a2: "live" }, ""), "Alle Konten · Spam wird automatisch als gelesen markiert (Arbeit)");
    assert.equal(headerSubtitle([A1, A2], { a1: "live", a2: "live" }, ""), "Alle Konten · Spam wird automatisch als gelesen markiert");
  });
  it("follows the selected account", () => {
    assert.equal(headerSubtitle([A1, A2], { a1: "dry_run", a2: "live" }, "a1"), "Web · Postfach nur lesend");
    assert.equal(headerSubtitle([A1, A2], { a1: "dry_run", a2: "live" }, "a2"), "Arbeit · Spam wird automatisch als gelesen markiert");
  });
});

const counts = (over: Partial<ActionsCounts> = {}): ActionsCounts => ({
  dry_run: { planned: 4, done: 0, failed: 0, undone: 1 }, live: { planned: 0, done: 2, failed: 1, undone: 0 }, ...over,
});

const act = (id: number, over: Partial<ApiAction> = {}): ApiAction => ({
  id, email_id: id * 10, account: "a1", rule: "spam_seen", action: "mark_seen", mode: "dry_run", status: "planned",
  failure_code: null, created_at: "2026-10-27T10:00:00.000Z", ...over,
});

describe("Aussortiert helpers", () => {
  it("builds the API url per tab: dry_run/planned and live/done", () => {
    assert.equal(actionsUrl({ tab: "dry_run", limit: ACTION_PAGE_SIZE }), `/api/actions?mode=dry_run&status=planned&limit=${ACTION_PAGE_SIZE}`);
    assert.equal(actionsUrl({ tab: "live", limit: 20, cursor: "abc_-" }), "/api/actions?mode=live&status=done&limit=20&cursor=abc_-");
    assert.ok(ACTION_PAGE_SIZE <= 50);
  });
  it("titles the rows by what happened", () => {
    assert.equal(actionTitle(act(1)), "Würde als gelesen markieren");
    assert.equal(actionTitle(act(1, { mode: "live", status: "done" })), "Als gelesen markiert");
  });
  it("takes tab numbers from the counts and opens the tab that has something", () => {
    assert.equal(tabCount(counts(), "dry_run"), 4);
    assert.equal(tabCount(counts(), "live"), 2);
    assert.equal(defaultActionTab(counts()), "dry_run");
    assert.equal(defaultActionTab(counts({ dry_run: { planned: 0, done: 0, failed: 0, undone: 0 } })), "live");
    assert.equal(defaultActionTab(null), "dry_run");
  });
  it("describes the mode of each account, dry_run for unknown ones", () => {
    const n = modeNotices([A1, A2], { a1: "dry_run", a2: "live" });
    assert.deepEqual(n.map((x) => [x.account.label, x.mode, x.text]), [
      ["Web", "dry_run", "Trockenlauf: nichts wird im Postfach geändert"],
      ["Arbeit", "live", "Live: Spam wird im Postfach als gelesen markiert"],
    ]);
    assert.equal(modeNotices([A1], undefined)[0]?.mode, "dry_run");
    assert.equal(modeNotices([A1], { a1: "off" })[0]?.text, "Aus: keine automatische Aktion");
  });
  it("removes the row and corrects the counters after Wieder ungelesen", () => {
    const rows = [act(1), act(2), act(3, { mode: "live", status: "done" })];
    const a = afterUnread(rows, counts(), "dry_run", 10);
    assert.deepEqual(a.actions.map((r) => r.id), [2, 3]);
    assert.equal(a.counts.dry_run.planned, 3);
    assert.equal(a.counts.dry_run.undone, 2);
    const b = afterUnread(rows, counts(), "live", 30);
    assert.equal(b.counts.live.done, 1);
    assert.equal(b.counts.live.undone, 1);
    assert.equal(afterUnread(rows, counts(), "live", 99).actions.length, 3, "unknown mail: nothing changes");
  });
});

describe("detail hint", () => {
  const ma = (over: Partial<ApiMailboxAction> = {}): ApiMailboxAction => ({
    id: 1, rule: "spam_seen", action: "mark_seen", mode: "dry_run", status: "planned", failure_code: null,
    created_at: "2026-10-27T10:00:00.000Z", ...over,
  });
  it("names the planned and the executed action, nothing for undone/failed/none", () => {
    assert.equal(unreadHint(ma()), "Würde automatisch als gelesen markiert");
    assert.equal(unreadHint(ma({ mode: "live", status: "done" })), "Automatisch als gelesen markiert");
    assert.equal(unreadHint(ma({ status: "undone" })), null);
    assert.equal(unreadHint(ma({ mode: "live", status: "failed", failure_code: "imap_error" })), null);
    assert.equal(unreadHint(null), null);
    assert.equal(unreadHint(undefined), null);
  });
  it("offers Wieder ungelesen only for planned and done actions", () => {
    assert.equal(canUnread(ma()), true);
    assert.equal(canUnread(ma({ mode: "live", status: "done" })), true);
    assert.equal(canUnread(ma({ status: "undone" })), false);
    assert.equal(canUnread(null), false);
  });
});

interface Call { url: string; init?: RequestInit }
function deps(responses: Response[]): { deps: MutationDeps; calls: Call[] } {
  const calls: Call[] = [];
  const queue = [...responses];
  return {
    calls,
    deps: {
      fetch: (url, init) => {
        calls.push({ url: String(url), init });
        return Promise.resolve(queue.shift() ?? new Response("{}", { status: 500 }));
      },
      headers: (_p, token) => new Headers({ "x-csrf-token": "vf", "x-app-csrf": token }),
    },
  };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const session = () => json({ csrfToken: "t1" });

describe("postEmailUnread", () => {
  it("posts /unread once with both CSRF headers and no body", async () => {
    const f = deps([session(), json({ ok: true, id: 5, mode: "dry_run", seen: false })]);
    assert.deepEqual(await postEmailUnread(5, f.deps), { ok: true, mode: "dry_run" });
    assert.equal(f.calls[1].url, "/api/emails/5/unread");
    assert.equal(f.calls[1].init?.method, "POST");
    assert.equal(f.calls[1].init?.body, undefined);
    assert.equal(new Headers(f.calls[1].init?.headers).get("x-app-csrf"), "t1");
  });
  it("maps the error codes of the route to reasons and German texts", async () => {
    const cases: [number, unknown, string][] = [
      [409, { error: "kill_switch" }, "kill_switch"],
      [503, { error: "account_unavailable" }, "account_unavailable"],
      [502, { error: "imap_error" }, "mailbox_error"],
      [502, { error: "uidvalidity_changed" }, "mailbox_error"],
      [404, { error: "not_found" }, "not_found"],
      [403, {}, "forbidden"],
      [500, {}, "failed"],
    ];
    for (const [status, body, reason] of cases) {
      const f = deps([session(), json(body, status)]);
      const r = await postEmailUnread(1, f.deps);
      assert.deepEqual(r, { ok: false, reason }, `${status} ${reason}`);
      assert.equal(f.calls.length, 2, "a write is never repeated");
    }
    assert.match(UNREAD_ERROR_TEXT.kill_switch, /Not-Aus/);
    assert.match(UNREAD_ERROR_TEXT.account_unavailable, /Konto/);
    assert.match(UNREAD_ERROR_TEXT.mailbox_error, /Mailserver/);
    for (const text of Object.values(UNREAD_ERROR_TEXT)) assert.ok(text.length > 0 && !/imap_error|store_rejected|uidvalidity/.test(text), "codes never reach the screen");
  });
  it("reports rate limits with the wait time and network failures as failed", async () => {
    const f = deps([session(), json({}, 429, { "retry-after": "12" })]);
    assert.deepEqual(await postEmailUnread(1, f.deps), { ok: false, reason: "rate_limited", retryAfterSeconds: 12 });
    const g: MutationDeps = { fetch: () => Promise.reject(new Error("net")), headers: () => new Headers() };
    assert.deepEqual(await postEmailUnread(1, g), { ok: false, reason: "failed" });
  });
});

describe("list client helpers", () => {
  it("mapLimit keeps the order and never runs more than the limit at once", async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return n * 2;
    });
    assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14]);
    assert.ok(peak <= 3 && peak > 1);
  });
  it("fetchActions reads the contract and maps a lost session", async () => {
    const body = { actions: [act(1)], next_cursor: null, counts: counts() };
    const r = await fetchActions("/api/actions?mode=dry_run", () => Promise.resolve(json(body)));
    assert.equal(r.actions.length, 1);
    await assert.rejects(fetchActions("/x", () => Promise.resolve(json({}, 401))), /session/);
    await assert.rejects(fetchActions("/x", () => Promise.resolve(json({ nope: 1 }))), /unavailable/);
  });
});
