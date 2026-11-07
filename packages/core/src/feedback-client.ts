// Browser side of the feedback routes (T37). Three topics, "latest answer wins". Buttons update optimistically and
// roll back on an error. No mail content crosses this boundary: kinds and one category value only.
import { commonReason, postApi, readJson, type CommonReason } from "./api-post.ts";
import type { MutationDeps } from "./mutate-client.ts";

export type FeedbackKind = "spam_correct" | "not_spam" | "category_wrong" | "reply_needed" | "no_reply_needed";

export interface FeedbackState {
  spam: "spam_correct" | "not_spam" | null;
  reply: "reply_needed" | "no_reply_needed" | null;
  category: string | null;
}

export const EMPTY_FEEDBACK: FeedbackState = { spam: null, reply: null, category: null };

export const CATEGORY_CHOICES: readonly string[] = [
  "spam", "newsletter_promo", "transactional", "security_auth", "personal", "business", "unclear",
];

export const FEEDBACK_ERROR_TEXT: Record<CommonReason, string> = {
  rate_limited: "Zu viele Aktionen. Bitte kurz warten.",
  forbidden: "Nicht angemeldet. Bitte die App neu öffnen.",
  not_found: "Diese Mail gibt es nicht mehr.",
  failed: "Das Feedback konnte nicht gespeichert werden.",
};

export const FEEDBACK_SAVED_TEXT = "Danke, gemerkt";

/** Optimistic result of one answer (pure). */
export function applyFeedback(s: FeedbackState, kind: FeedbackKind, value?: string): FeedbackState {
  switch (kind) {
    case "spam_correct":
    case "not_spam":
      return { ...s, spam: kind };
    case "reply_needed":
    case "no_reply_needed":
      return { ...s, reply: kind };
    case "category_wrong":
      return { ...s, category: value ?? s.category };
  }
}

function parseState(v: unknown): FeedbackState | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const spam = o.spam === "spam_correct" || o.spam === "not_spam" ? o.spam : null;
  const reply = o.reply === "reply_needed" || o.reply === "no_reply_needed" ? o.reply : null;
  const category = typeof o.category === "string" ? o.category : null;
  return { spam, reply, category };
}

/** GET /api/emails/:id/feedback. null = the mail does not exist; other failures throw. */
export async function fetchFeedback(id: number, fetcher: typeof fetch = fetch): Promise<FeedbackState | null> {
  const r = await fetcher(`/api/emails/${id}/feedback`, { cache: "no-store" });
  if (r.status === 404) return null;
  if (r.status === 401 || r.status === 403) throw new Error("session");
  if (!r.ok) throw new Error("unavailable");
  const state = parseState((await readJson(r)).feedback);
  if (state === null) throw new Error("unavailable");
  return state;
}

export type FeedbackResult = { ok: true; feedback: FeedbackState } | { ok: false; reason: CommonReason };

export async function postFeedback(id: number, kind: FeedbackKind, value: string | undefined, deps: MutationDeps): Promise<FeedbackResult> {
  const body = value === undefined ? { kind } : { kind, value };
  const raw = await postApi(`/api/emails/${id}/feedback`, deps, { body });
  if (raw.kind !== "response") return { ok: false, reason: raw.kind };
  const common = commonReason(raw.response);
  if (common) return { ok: false, reason: common.reason };
  if (!raw.response.ok) return { ok: false, reason: "failed" };
  const state = parseState((await readJson(raw.response)).feedback);
  return state === null ? { ok: false, reason: "failed" } : { ok: true, feedback: state };
}
