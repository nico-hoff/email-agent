// Browser side of GET/POST /api/topics and GET /api/topics/counts (R8, ADR 0026/0037). Types are repeated on purpose: the
// server modules use node:sqlite and must not be bundled into the browser. Only keys, labels, hints, switches and counts
// travel here; nothing from a mail. Maps instead of obj[key] (route-reachable code).
import { commonReason, postApi, readJson, type CommonReason } from "./api-post.ts";
import type { MutationDeps } from "./mutate-client.ts";

export interface TopicItem {
  key: string;
  label: string;
  kind: "fixed" | "custom";
  hint: string | null;
  active: boolean;
}

export interface TopicLimits { active_custom_max: number; label_min: number; label_max: number; hint_max: number }

export interface TopicsData {
  enabled: boolean;
  limits: TopicLimits;
  topics: TopicItem[];
}

export const DEFAULT_LIMITS: TopicLimits = { active_custom_max: 4, label_min: 2, label_max: 40, hint_max: 120 };

const asMap = (v: unknown): Map<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? new Map(Object.entries(v)) : null;

function parseItem(raw: unknown): TopicItem | null {
  const m = asMap(raw);
  if (!m) return null;
  const key = m.get("key");
  const label = m.get("label");
  const kind = m.get("kind");
  if (typeof key !== "string" || typeof label !== "string" || (kind !== "fixed" && kind !== "custom")) return null;
  const hint = m.get("hint");
  return { key, label, kind, hint: typeof hint === "string" ? hint : null, active: m.get("active") !== false };
}

function parseLimits(raw: unknown): TopicLimits {
  const m = asMap(raw);
  const n = (k: string, d: number): number => (typeof m?.get(k) === "number" ? (m.get(k) as number) : d);
  return {
    active_custom_max: n("active_custom_max", DEFAULT_LIMITS.active_custom_max),
    label_min: n("label_min", DEFAULT_LIMITS.label_min),
    label_max: n("label_max", DEFAULT_LIMITS.label_max),
    hint_max: n("hint_max", DEFAULT_LIMITS.hint_max),
  };
}

export function parseTopics(b: Record<string, unknown>): TopicsData {
  const items: TopicItem[] = [];
  for (const x of Array.isArray(b.topics) ? b.topics : []) {
    const p = parseItem(x);
    if (p) items.push(p);
  }
  return { enabled: b.enabled === true, limits: parseLimits(b.limits), topics: items };
}

export async function fetchTopics(fetcher: typeof fetch): Promise<TopicsData> {
  const r = await fetcher("/api/topics", { cache: "no-store" });
  if (r.status === 401 || r.status === 403) throw new Error("session");
  if (!r.ok) throw new Error("unavailable");
  return parseTopics(await readJson(r));
}

export const fixedTopics = (d: TopicsData): TopicItem[] => d.topics.filter((t) => t.kind === "fixed");
export const customTopics = (d: TopicsData): TopicItem[] => d.topics.filter((t) => t.kind === "custom");
export const activeCustomCount = (d: TopicsData): number => customTopics(d).filter((t) => t.active).length;

/** Can another own topic be added? (The server enforces the limit; this only decides whether the form is offered.) */
export const canAddTopic = (d: TopicsData): boolean => activeCustomCount(d) < d.limits.active_custom_max;

export type TopicReason =
  | CommonReason
  | "invalid_body" | "duplicate" | "too_many_active" | "too_many_rows" | "inactive" | "too_many_custom"
  | "label_length" | "label_chars" | "hint_length" | "key_empty" | "key_invalid";

export function topicErrorText(reason: TopicReason, limits: TopicLimits = DEFAULT_LIMITS): string {
  switch (reason) {
    case "rate_limited": return "Zu viele Aktionen. Bitte kurz warten.";
    case "forbidden": return "Nicht angemeldet. Bitte die App neu öffnen.";
    case "not_found": return "Dieses Thema gibt es nicht mehr.";
    case "failed": return "Das hat nicht geklappt. Bitte später erneut versuchen.";
    case "invalid_body": return "Ungültige Eingabe.";
    case "duplicate": return "Ein Thema mit diesem Namen gibt es schon. Die festen Themen zählen mit.";
    case "too_many_active":
    case "too_many_custom": return `Du hast schon ${limits.active_custom_max} aktive eigene Themen. Wähle zuerst eines ab.`;
    case "too_many_rows": return "Du hast zu viele eigene Themen angelegt (abgewählte zählen mit). Benenne ein vorhandenes um und aktiviere es wieder.";
    case "inactive": return "Dieses Thema ist abgewählt. Bitte erst wieder aktivieren.";
    case "label_length": return `Der Name muss ${limits.label_min} bis ${limits.label_max} Zeichen lang sein.`;
    case "label_chars": return "Der Name enthält Zeichen, die nicht erlaubt sind.";
    case "hint_length": return `Der Hinweis darf höchstens ${limits.hint_max} Zeichen lang sein.`;
    case "key_empty":
    case "key_invalid": return "Aus diesem Namen lässt sich kein Thema bilden. Bitte Buchstaben oder Ziffern verwenden.";
  }
}

const KNOWN: ReadonlySet<string> = new Set([
  "invalid_body", "duplicate", "too_many_active", "too_many_rows", "inactive", "too_many_custom",
  "label_length", "label_chars", "hint_length", "key_empty", "key_invalid",
]);
const asReason = (v: unknown): TopicReason => (typeof v === "string" && KNOWN.has(v) ? (v as TopicReason) : "failed");

export type TopicChange =
  | { action: "create"; label: string; hint?: string }
  | { action: "update"; key: string; label?: string; hint?: string | null }
  | { action: "set_active"; key: string; active: boolean }
  | { action: "set_enabled"; enabled: boolean };

export type TopicResult = { ok: true; data: TopicsData } | { ok: false; reason: TopicReason; retryAfterSeconds?: number };

/** One write; the response carries the new list, so the page needs no second request. Never repeated on a doubt. */
export async function postTopicChange(change: TopicChange, deps: MutationDeps): Promise<TopicResult> {
  const raw = await postApi("/api/topics", deps, { body: change });
  if (raw.kind === "forbidden") return { ok: false, reason: "forbidden" };
  if (raw.kind === "failed") return { ok: false, reason: "failed" };
  const r = raw.response;
  const common = commonReason(r);
  if (common) return { ok: false, reason: common.reason, ...(common.retryAfterSeconds !== undefined ? { retryAfterSeconds: common.retryAfterSeconds } : {}) };
  const body = await readJson(r);
  if (!r.ok) return { ok: false, reason: asReason(body.error) };
  return { ok: true, data: parseTopics(body) };
}

// ---- folders in the list ----------------------------------------------------------------------------------------------

export interface TopicFolder { key: string; label: string; kind: "fixed" | "custom"; active: boolean; count: number }

export interface TopicCounts {
  enabled: boolean;
  total: number;
  none: number;
  folders: TopicFolder[];
}

export const NO_COUNTS: TopicCounts = { enabled: false, total: 0, none: 0, folders: [] };

export async function fetchTopicCounts(fetcher: typeof fetch, account = ""): Promise<TopicCounts> {
  const q = account === "" ? "" : `?${new URLSearchParams({ account })}`;
  const r = await fetcher(`/api/topics/counts${q}`, { cache: "no-store" });
  if (r.status === 401 || r.status === 403) throw new Error("session");
  if (!r.ok) throw new Error("unavailable");
  const b = await readJson(r);
  const n = (v: unknown): number => (typeof v === "number" ? v : 0);
  const folders: TopicFolder[] = [];
  for (const x of Array.isArray(b.topics) ? b.topics : []) {
    const m = asMap(x);
    const key = m?.get("key");
    const label = m?.get("label");
    const kind = m?.get("kind");
    if (!m || typeof key !== "string" || typeof label !== "string" || (kind !== "fixed" && kind !== "custom")) continue;
    folders.push({ key, label, kind, active: m.get("active") !== false, count: n(m.get("count")) });
  }
  return { enabled: b.enabled === true, total: n(b.total), none: n(b.none), folders };
}

/**
 * Which folders the row shows: topics that hold mails, active own topics (so a new one is visible at once) and the
 * selected one (so the row never loses the folder the list is filtered by). Order of the API is kept.
 */
export function visibleFolders(c: TopicCounts, selected: string): TopicFolder[] {
  return c.folders.filter((f) => f.count > 0 || f.key === selected || (f.kind === "custom" && f.active));
}

/** Folder filter is offered only when the switch is on. */
export const foldersVisible = (c: TopicCounts): boolean => c.enabled;

export function topicLabels(c: TopicCounts): ReadonlyMap<string, string> {
  return new Map(c.folders.map((f) => [f.key, f.label] as const));
}

/** A selection that no longer exists (switch turned off, topic gone) falls back to "Alle" (""). */
export function effectiveTopic(selected: string, c: TopicCounts): string {
  if (selected === "" || !c.enabled) return "";
  return c.folders.some((f) => f.key === selected) ? selected : "";
}
