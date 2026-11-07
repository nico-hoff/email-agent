// Browser side of GET /api/emails and /api/emails/:id (T35). Only metadata crosses this boundary. A 401 means the
// session is gone: the caller sends the person back to the welcome screen.
import type { ActionsResponse, ApiEmail, ApiEmailDetail, ListResponse } from "./review-ui.ts";

export class SessionExpired extends Error {}

async function getJson<T>(url: string, fetcher: typeof fetch): Promise<{ status: number; body: T | null }> {
  const r = await fetcher(url, { cache: "no-store" });
  if (r.status === 401 || r.status === 403) throw new SessionExpired("session");
  if (r.status === 404) return { status: 404, body: null };
  if (!r.ok) throw new Error("unavailable");
  return { status: r.status, body: (await r.json()) as T };
}

export async function fetchPage(url: string, fetcher: typeof fetch = fetch): Promise<ListResponse> {
  const { body } = await getJson<ListResponse>(url, fetcher);
  if (body === null || !Array.isArray(body.emails)) throw new Error("unavailable");
  return body;
}

/** null = the mail does not exist (404). */
export async function fetchDetail(id: number, fetcher: typeof fetch = fetch): Promise<ApiEmailDetail | null> {
  const { body } = await getJson<ApiEmailDetail>(`/api/emails/${id}`, fetcher);
  return body;
}

/** Appends a page without duplicates (a cursor page can overlap after local changes). */
export function appendUnique(current: ApiEmail[], more: ApiEmail[]): ApiEmail[] {
  const seen = new Set(current.map((m) => m.id));
  return [...current, ...more.filter((m) => !seen.has(m.id))];
}

/** GET /api/actions (ids and codes only). */
export async function fetchActions(url: string, fetcher: typeof fetch = fetch): Promise<ActionsResponse> {
  const { body } = await getJson<ActionsResponse>(url, fetcher);
  if (body === null || !Array.isArray(body.actions) || typeof body.counts !== "object" || body.counts === null) {
    throw new Error("unavailable");
  }
  return body;
}

/** Runs `fn` over `items` with at most `limit` calls in flight; the result keeps the order of `items`. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, worker));
  return out;
}
