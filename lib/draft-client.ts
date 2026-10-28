// Browser side of POST /api/emails/:id/draft (T42). The draft is shown as text and copied on request; it is never
// kept anywhere but in component state. Error codes become plain German sentences.
import { commonReason, postApi, readJson } from "./api-post.ts";
import type { MutationDeps } from "./mutate-client.ts";

export type DraftErrorCode =
  | "not_eligible" | "not_available_in_synthetic" | "not_classified" | "source_gone"
  | "fetch_failed" | "agent_failed" | "invalid_output" | "agent_unavailable"
  | "not_found" | "rate_limited" | "forbidden" | "failed";

export type DraftResult =
  | { ok: true; draft: string; language: string; tone: string; needsHumanCheck: boolean; reasons: string[] }
  | { ok: false; code: DraftErrorCode; reasons: string[] };

export const DRAFT_ERROR_TEXT: Record<DraftErrorCode, string> = {
  not_eligible: "Für diese Mail wird kein Entwurf erzeugt.",
  not_available_in_synthetic: "Im Testmodus nicht verfügbar",
  not_classified: "Die Mail ist noch nicht bewertet. Bitte später erneut versuchen.",
  source_gone: "Die Mail liegt nicht mehr im Postfach.",
  fetch_failed: "Die Mail konnte nicht vom Mailserver geholt werden.",
  agent_failed: "Der Entwurf konnte nicht erstellt werden.",
  invalid_output: "Der Entwurf war unbrauchbar. Bitte noch einmal versuchen.",
  agent_unavailable: "Der Entwurfs-Assistent ist gerade nicht verfügbar.",
  not_found: "Diese Mail gibt es nicht mehr.",
  rate_limited: "Zu viele Entwürfe in kurzer Zeit. Bitte etwas warten.",
  forbidden: "Nicht angemeldet. Bitte die App neu öffnen.",
  failed: "Der Entwurf konnte nicht erstellt werden.",
};

const REASON_TEXT: Record<string, string> = {
  missing_answer: "Jev hat die Mail noch nicht vollständig bewertet.",
  addresses_an_ai: "Die Mail richtet sich an eine KI.",
  security_auth: "Sicherheits- und Anmeldemails bekommen bewusst keinen Entwurf.",
  not_assessable: "Die Mail ließ sich nicht beurteilen.",
};

/** Plain-language sentence for a block reason; an unknown code never reaches the screen. */
export function reasonText(code: string): string {
  return REASON_TEXT[code] ?? "Die Mail ist für einen Entwurf gesperrt.";
}

export function draftErrorText(r: { code: DraftErrorCode; reasons: string[] }): string {
  if (r.code !== "not_eligible") return DRAFT_ERROR_TEXT[r.code];
  const reasons = [...new Set(r.reasons.map(reasonText))];
  return reasons.length === 0 ? DRAFT_ERROR_TEXT.not_eligible : `${DRAFT_ERROR_TEXT.not_eligible} ${reasons.join(" ")}`;
}

const KNOWN: ReadonlySet<string> = new Set<DraftErrorCode>([
  "not_eligible", "not_available_in_synthetic", "not_classified", "source_gone", "fetch_failed", "agent_failed",
  "invalid_output", "agent_unavailable",
]);

export async function postDraft(id: number, deps: MutationDeps): Promise<DraftResult> {
  const raw = await postApi(`/api/emails/${id}/draft`, deps);
  if (raw.kind === "forbidden") return { ok: false, code: "forbidden", reasons: [] };
  if (raw.kind === "failed") return { ok: false, code: "failed", reasons: [] };
  const r = raw.response;
  const common = commonReason(r);
  if (common) return { ok: false, code: common.reason, reasons: [] };
  const body = await readJson(r);
  if (r.ok) {
    if (typeof body.draft !== "string" || typeof body.needs_human_check !== "boolean") return { ok: false, code: "failed", reasons: [] };
    const reasons = Array.isArray(body.reasons) ? body.reasons.filter((x): x is string => typeof x === "string") : [];
    return {
      ok: true,
      draft: body.draft,
      language: typeof body.language === "string" ? body.language : "",
      tone: typeof body.tone === "string" ? body.tone : "",
      needsHumanCheck: body.needs_human_check,
      reasons,
    };
  }
  const code = typeof body.error === "string" && KNOWN.has(body.error) ? (body.error as DraftErrorCode) : "failed";
  const reasons = Array.isArray(body.reasons) ? body.reasons.filter((x): x is string => typeof x === "string") : [];
  return { ok: false, code, reasons };
}

/** The button is offered for open mails, a positive reply need and route draft_reply; other mails keep it in Details. */
export function showDraftButton(m: { open: boolean; needs_my_reply: string | null; route: string | null }): boolean {
  return m.open || m.needs_my_reply === "positive" || m.route === "draft_reply";
}

export interface ClipboardEnv {
  clipboard?: { writeText(text: string): Promise<void> };
  /** Fallback for browsers or contexts without the Clipboard API (e.g. plain http). Returns whether the copy worked. */
  legacy?: (text: string) => boolean;
}

export async function copyToClipboard(text: string, env: ClipboardEnv): Promise<boolean> {
  if (env.clipboard) {
    try {
      await env.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to the legacy path
    }
  }
  try {
    return env.legacy ? env.legacy(text) : false;
  } catch {
    return false;
  }
}

/** Real browser wiring: Clipboard API, then a hidden textarea with execCommand. */
export function browserClipboardEnv(): ClipboardEnv {
  return {
    clipboard: typeof navigator !== "undefined" && navigator.clipboard ? navigator.clipboard : undefined,
    legacy: (text) => {
      const el = document.createElement("textarea");
      el.value = text;
      el.setAttribute("readonly", "");
      el.style.position = "fixed";
      el.style.opacity = "0";
      document.body.appendChild(el);
      el.select();
      try {
        return document.execCommand("copy");
      } finally {
        document.body.removeChild(el);
      }
    },
  };
}
