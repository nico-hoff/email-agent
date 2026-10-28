// Browser side of the state-changing calls (T64): trades the session for a fresh app CSRF token, then posts with the
// Veryfront double-submit headers plus x-app-csrf (same pattern as the login). No body is sent and the write is never
// repeated: an unclear outcome is reported as "failed" and the caller reloads instead of retrying.

export interface MutationDeps {
  fetch(url: string, init?: RequestInit): Promise<Response>;
  /** Wraps `csrfMutationHeaders` from veryfront/index.client: builds the double-submit headers plus the app token. */
  headers(path: string, appToken: string): Headers;
}

export type DoneResult =
  | { ok: true; done: boolean; seen: boolean }
  | { ok: false; reason: "rate_limited"; retryAfterSeconds: number }
  | { ok: false; reason: "forbidden" | "not_found" | "failed" };

export async function postEmailDone(id: number, done: boolean, deps: MutationDeps): Promise<DoneResult> {
  try {
    const session = await deps.fetch("/api/auth/session", { cache: "no-store" });
    if (!session.ok) return { ok: false, reason: session.status === 401 || session.status === 403 ? "forbidden" : "failed" };
    const { csrfToken } = (await session.json()) as { csrfToken?: unknown };
    if (typeof csrfToken !== "string") return { ok: false, reason: "failed" };

    const path = `/api/emails/${id}/${done ? "done" : "undone"}`;
    const r = await deps.fetch(path, { method: "POST", headers: deps.headers(path, csrfToken) });
    if (r.status === 429) {
      const wait = Number(r.headers.get("retry-after"));
      return { ok: false, reason: "rate_limited", retryAfterSeconds: Number.isFinite(wait) && wait > 0 ? wait : 30 };
    }
    if (r.status === 401 || r.status === 403) return { ok: false, reason: "forbidden" };
    if (r.status === 404) return { ok: false, reason: "not_found" };
    if (!r.ok) return { ok: false, reason: "failed" };
    const body = (await r.json()) as { done?: unknown; seen?: unknown };
    return { ok: true, done: body.done === true, seen: body.seen === true };
  } catch {
    return { ok: false, reason: "failed" };
  }
}

export const DONE_ERROR_TEXT: Record<"rate_limited" | "forbidden" | "not_found" | "failed", string> = {
  rate_limited: "Zu viele Aktionen. Bitte kurz warten.",
  forbidden: "Nicht angemeldet. Bitte die App neu öffnen.",
  not_found: "Diese Mail gibt es nicht mehr.",
  failed: "Konnte nicht gespeichert werden.",
};

// ---- Wieder ungelesen (T60a) -------------------------------------------------------------------------------------

export type UnreadReason = "rate_limited" | "forbidden" | "not_found" | "kill_switch" | "account_unavailable" | "mailbox_error" | "failed";

export type UnreadResult =
  | { ok: true; mode: string }
  | { ok: false; reason: "rate_limited"; retryAfterSeconds: number }
  | { ok: false; reason: Exclude<UnreadReason, "rate_limited"> };

/** POST /api/emails/:id/unread: same handshake as /done; 409/503/502 become reasons, the server codes never reach the screen. */
export async function postEmailUnread(id: number, deps: MutationDeps): Promise<UnreadResult> {
  try {
    const session = await deps.fetch("/api/auth/session", { cache: "no-store" });
    if (!session.ok) return { ok: false, reason: session.status === 401 || session.status === 403 ? "forbidden" : "failed" };
    const { csrfToken } = (await session.json()) as { csrfToken?: unknown };
    if (typeof csrfToken !== "string") return { ok: false, reason: "failed" };

    const path = `/api/emails/${id}/unread`;
    const r = await deps.fetch(path, { method: "POST", headers: deps.headers(path, csrfToken) });
    if (r.status === 429) {
      const wait = Number(r.headers.get("retry-after"));
      return { ok: false, reason: "rate_limited", retryAfterSeconds: Number.isFinite(wait) && wait > 0 ? wait : 30 };
    }
    if (r.status === 401 || r.status === 403) return { ok: false, reason: "forbidden" };
    if (r.status === 404) return { ok: false, reason: "not_found" };
    if (r.status === 409) return { ok: false, reason: "kill_switch" };
    if (r.status === 503) return { ok: false, reason: "account_unavailable" };
    if (r.status === 502) return { ok: false, reason: "mailbox_error" };
    if (!r.ok) return { ok: false, reason: "failed" };
    const body = (await r.json()) as { mode?: unknown };
    return { ok: true, mode: typeof body.mode === "string" ? body.mode : "dry_run" };
  } catch {
    return { ok: false, reason: "failed" };
  }
}

export const UNREAD_ERROR_TEXT: Record<Exclude<UnreadReason, "rate_limited">, string> & Record<"rate_limited", string> = {
  rate_limited: DONE_ERROR_TEXT.rate_limited,
  forbidden: DONE_ERROR_TEXT.forbidden,
  not_found: DONE_ERROR_TEXT.not_found,
  failed: "Konnte nicht rückgängig gemacht werden.",
  kill_switch: "Der Not-Aus ist aktiv. Es wird nichts im Postfach geändert.",
  account_unavailable: "Das Konto ist gerade nicht erreichbar oder nicht freigegeben. Bitte später erneut versuchen.",
  mailbox_error: "Der Mailserver hat die Änderung nicht angenommen. Die Mail bleibt gelesen.",
};
