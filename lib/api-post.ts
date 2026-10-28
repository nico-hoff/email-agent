// Generic POST for the M5/M6 screens: the same handshake as lib/mutate-client.ts (fresh app token, Veryfront
// double-submit headers), an optional JSON body, and one shared status mapping. A write is never repeated: a network
// error is "failed" and the caller decides what to show.
import type { MutationDeps } from "./mutate-client.ts";

export type CommonReason = "rate_limited" | "forbidden" | "not_found" | "failed";

export type RawPost =
  | { kind: "response"; response: Response }
  | { kind: "forbidden" }
  | { kind: "failed" };

export async function postApi(path: string, deps: MutationDeps, opts: { body?: unknown; signal?: AbortSignal } = {}): Promise<RawPost> {
  try {
    const session = await deps.fetch("/api/auth/session", { cache: "no-store", signal: opts.signal });
    if (!session.ok) return session.status === 401 || session.status === 403 ? { kind: "forbidden" } : { kind: "failed" };
    const { csrfToken } = (await session.json()) as { csrfToken?: unknown };
    if (typeof csrfToken !== "string") return { kind: "failed" };
    const headers = deps.headers(path, csrfToken);
    const init: RequestInit = { method: "POST", headers, signal: opts.signal };
    if (opts.body !== undefined) {
      headers.set("content-type", "application/json");
      init.body = JSON.stringify(opts.body);
    }
    return { kind: "response", response: await deps.fetch(path, init) };
  } catch {
    return { kind: "failed" };
  }
}

/** 429 / 401 / 403 / 404, shared by every caller; null = the caller maps the status itself. */
export function commonReason(r: Response): { reason: CommonReason; retryAfterSeconds?: number } | null {
  if (r.status === 429) {
    const wait = Number(r.headers.get("retry-after"));
    return { reason: "rate_limited", retryAfterSeconds: Number.isFinite(wait) && wait > 0 ? wait : 30 };
  }
  if (r.status === 401 || r.status === 403) return { reason: "forbidden" };
  if (r.status === 404) return { reason: "not_found" };
  return null;
}

export const COMMON_ERROR_TEXT: Record<CommonReason, string> = {
  rate_limited: "Zu viele Aktionen. Bitte kurz warten.",
  forbidden: "Nicht angemeldet. Bitte die App neu öffnen.",
  not_found: "Das gibt es nicht mehr.",
  failed: "Das hat nicht geklappt. Bitte später erneut versuchen.",
};

export async function readJson(r: Response): Promise<Record<string, unknown>> {
  try {
    const v: unknown = await r.json();
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** GET helper for the read endpoints: 401/403 → SessionExpired-like error is the caller's business; here only JSON. */
export async function getJson(url: string, fetcher: typeof fetch): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetcher(url, { cache: "no-store" });
  return { status: r.status, body: r.ok ? await readJson(r) : {} };
}
