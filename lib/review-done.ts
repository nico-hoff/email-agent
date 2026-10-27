// Offen / Erledigt in the browser (T64): optimistic list updates and the swipe maths. Pure: no React, no I/O.
// "Erledigt" is Nico's decision in the app database only; the mailbox is never written.
import type { ApiCounts, ApiEmail, ViewId } from "./review-ui.ts";

const CTA_ROUTES: ReadonlySet<string> = new Set(["draft_reply", "notify"]);

/** Call to action as the server defines it (Plan v5, 3.6). */
export function isCta(m: Pick<ApiEmail, "needs_my_reply" | "route">): boolean {
  return m.needs_my_reply === "positive" || (m.route !== null && CTA_ROUTES.has(m.route));
}

/** Same order as the server (lib/email-api.ts compareSortKeys): urgency, importance, time, id; descending, gaps last. */
export function compareEmails(a: ApiEmail, b: ApiEmail): number {
  const desc = (x: number | null, y: number | null): number => {
    if (x === y) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return y - x;
  };
  return desc(a.urgency, b.urgency) || desc(a.importance, b.importance) ||
    (a.received_at < b.received_at ? 1 : a.received_at > b.received_at ? -1 : 0) || b.id - a.id;
}

export interface ListState {
  emails: ApiEmail[];
  counts: ApiCounts;
  view: ViewId;
}

const withOpenDelta = (c: ApiCounts, delta: number): ApiCounts => (delta === 0 ? c : { ...c, open: Math.max(c.open + delta, 0) });

/**
 * Optimistic update of "Erledigt" / "Rückgängig": the mail keeps its place (or leaves the Offen view), the open
 * counter follows. `item` is the version before the change, to put back if the request fails or on Undo.
 */
export function markDone(s: ListState, id: number, done: boolean): { state: ListState; item: ApiEmail | null } {
  const before = s.emails.find((m) => m.id === id);
  if (!before) return { state: s, item: null };
  const after: ApiEmail = { ...before, done };
  after.open = isCta(after) && !after.seen && !after.done;
  const keep = !(s.view === "open" && !after.open);
  const emails = keep ? s.emails.map((m) => (m.id === id ? after : m)) : s.emails.filter((m) => m.id !== id);
  return {
    state: { ...s, emails, counts: withOpenDelta(s.counts, Number(after.open) - Number(before.open)) },
    item: before,
  };
}

/** Puts a mail back at its sorted place (or replaces it) and corrects the open counter. */
export function reinsert(s: ListState, item: ApiEmail): ListState {
  const current = s.emails.find((m) => m.id === item.id);
  const rest = s.emails.filter((m) => m.id !== item.id);
  const at = rest.findIndex((m) => compareEmails(item, m) < 0);
  const emails = at < 0 ? [...rest, item] : [...rest.slice(0, at), item, ...rest.slice(at)];
  return { ...s, emails, counts: withOpenDelta(s.counts, Number(item.open) - Number(current?.open ?? false)) };
}

// ---- Wischgeste ---------------------------------------------------------------------------------------------------

export const SWIPE_COMMIT_PX = 96;
export const SWIPE_MAX_PX = 160;

/** Horizontal offset of the row while dragging: left only, damped beyond the commit point, capped. */
export function swipeOffset(dx: number): number {
  if (!(dx < 0)) return 0;
  const over = -dx - SWIPE_COMMIT_PX;
  return over > 0 ? -Math.min(SWIPE_COMMIT_PX + over * 0.35, SWIPE_MAX_PX) : dx;
}

/** A swipe to the left commits at 96 px, on narrow rows at 35 % of the width. */
export function swipeCommits(dx: number, width: number): boolean {
  return dx <= -Math.min(SWIPE_COMMIT_PX, Math.max(width, 1) * 0.35);
}
