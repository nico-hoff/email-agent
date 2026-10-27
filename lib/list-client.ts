// Browser side of GET /api/emails and /api/emails/:id (T35). Only metadata crosses this boundary. A 401 means the
// session is gone: the caller sends the person back to the welcome screen.
import type { ApiEmail, ApiEmailDetail, ListResponse } from "./review-ui.ts";

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
