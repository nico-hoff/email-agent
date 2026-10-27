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
