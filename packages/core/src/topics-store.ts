// Per-user topics (R8, ADR 0026/0037): the custom topics of a user (migration 011), the switch `topics_enabled` and the
// option list the question set v3 is built from. Pure SQLite, scoped by userId; a key of another user is simply unknown
// (the callers answer 404). Values are labels, hints (both typed by the user) and keys; no mail data.
// Reachable from API routes: no dynamic obj[key] reads (Map instead).
import type { DatabaseSync } from "node:sqlite";
import { buildTopicList, deriveCustomKey, FIXED_TOPICS, type TopicListError, type TopicList } from "./topics.ts";

/** Custom topics that can be active at the same time for now: only up to 4 were measured (docs/insights-topics.md). */
export const ACTIVE_CUSTOM_TOPICS_LIMIT = 4;
/** Rows per user including deactivated ones (a deactivated topic keeps its key so that old answers keep their meaning). */
export const CUSTOM_TOPIC_ROWS_MAX = 16;

export interface CustomTopicRow {
  id: number;
  key: string;
  label: string;
  hint: string | null;
  position: number;
  active: boolean;
}

interface DbRow { id: number; key: string; label: string; hint: string | null; position: number; active: number }

const toRow = (r: DbRow): CustomTopicRow => ({ id: r.id, key: r.key, label: r.label, hint: r.hint, position: r.position, active: r.active === 1 });

/** All custom topics of the user, active and deactivated, in list order. */
export function listCustomTopics(db: DatabaseSync, userId: number): CustomTopicRow[] {
  return (db.prepare("SELECT id, key, label, hint, position, active FROM user_topics WHERE user_id = ? ORDER BY position, id").all(userId) as unknown as DbRow[]).map(toRow);
}

/** The option list the user's classifications are asked with: fixed topics plus the ACTIVE custom topics (list order). */
export function topicListForUser(db: DatabaseSync, userId: number): TopicList {
  const active = listCustomTopics(db, userId).filter((t) => t.active);
  return buildTopicList(active.map((t) => ({ key: t.key, label: t.label, ...(t.hint !== null ? { hint: t.hint } : {}) })));
}

/** Is the user's switch `topics_enabled` on? No row, or an unreadable one, is off (fail-closed: the default is v2). */
export function topicsEnabled(db: DatabaseSync, userId: number): boolean {
  try {
    const r = db.prepare("SELECT topics_enabled FROM user_settings WHERE user_id = ?").get(userId) as { topics_enabled: number } | undefined;
    return r?.topics_enabled === 1;
  } catch {
    return false;
  }
}

export function setTopicsEnabled(db: DatabaseSync, userId: number, enabled: boolean, now: Date): void {
  const ts = now.toISOString();
  db.prepare("INSERT OR IGNORE INTO user_settings (user_id, updated_at) VALUES (?, ?)").run(userId, ts);
  db.prepare("UPDATE user_settings SET topics_enabled = ?, updated_at = ? WHERE user_id = ?").run(enabled ? 1 : 0, ts, userId);
}

export type TopicWriteError = TopicListError | "too_many_active" | "too_many_rows" | "not_found" | "inactive";
export type TopicWriteResult = { ok: true; topic: CustomTopicRow } | { ok: false; code: TopicWriteError };

const hintOf = (hint: string | undefined | null): string | undefined => {
  const h = hint?.replace(/\s+/g, " ").trim();
  return h ? h : undefined;
};

/** Validates the active list as it would be after the change (all rules of packages/core/src/topics.ts: count, length, characters, duplicates). */
function validateActive(rows: readonly CustomTopicRow[]): TopicListError | null {
  const list = buildTopicList(rows.filter((t) => t.active).map((t) => ({ key: t.key, label: t.label, ...(t.hint !== null ? { hint: t.hint } : {}) })));
  return list.ok ? null : list.code;
}

/**
 * Creates a custom topic (appended to the list). A label whose key belongs to a deactivated topic of the same user brings
 * that topic back (same key: its old answers keep their meaning), with the new label and hint.
 */
export function createCustomTopic(db: DatabaseSync, userId: number, input: { label: string; hint?: string }, now: Date): TopicWriteResult {
  const rows = listCustomTopics(db, userId);
  const label = input.label.normalize("NFC").replace(/\s+/g, " ").trim();
  const hint = hintOf(input.hint);
  const solo = buildTopicList([{ label, ...(hint !== undefined ? { hint } : {}) }]);
  if (!solo.ok) return { ok: false, code: solo.code };
  const key = deriveCustomKey(label);
  const existing = key === "" ? undefined : rows.find((t) => t.key === key);
  if (existing?.active) return { ok: false, code: "duplicate" };
  if (rows.filter((t) => t.active).length >= ACTIVE_CUSTOM_TOPICS_LIMIT) return { ok: false, code: "too_many_active" };
  if (!existing && rows.length >= CUSTOM_TOPIC_ROWS_MAX) return { ok: false, code: "too_many_rows" };
  const position = rows.reduce((m, t) => Math.max(m, t.position), -1) + 1;
  const candidate: CustomTopicRow = { id: existing?.id ?? 0, key: existing?.key ?? key, label, hint: hint ?? null, position: existing ? existing.position : position, active: true };
  // Validate the whole active list including the new entry (derives the key from the label when it is a new topic).
  const check = validateActive([...rows.filter((t) => t.id !== candidate.id), existing ? candidate : { ...candidate, key }]);
  if (check !== null) return { ok: false, code: check };
  const ts = now.toISOString();
  if (existing) {
    db.prepare("UPDATE user_topics SET label = ?, hint = ?, active = 1, position = ?, updated_at = ? WHERE id = ? AND user_id = ?")
      .run(label, hint ?? null, position, ts, existing.id, userId);
    return { ok: true, topic: { ...candidate, position } };
  }
  const r = db.prepare("INSERT INTO user_topics (user_id, key, label, hint, position, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)")
    .run(userId, key, label, hint ?? null, position, ts, ts);
  return { ok: true, topic: { ...candidate, id: Number(r.lastInsertRowid) } };
}

/** Edits label, hint and/or position of an ACTIVE custom topic. The key never changes (old answers keep their meaning). */
export function updateCustomTopic(
  db: DatabaseSync, userId: number, key: string, change: { label?: string; hint?: string | null; position?: number }, now: Date,
): TopicWriteResult {
  const rows = listCustomTopics(db, userId);
  const current = rows.find((t) => t.key === key);
  if (!current) return { ok: false, code: "not_found" };
  if (!current.active) return { ok: false, code: "inactive" };
  const next: CustomTopicRow = {
    ...current,
    label: change.label !== undefined ? change.label.normalize("NFC").replace(/\s+/g, " ").trim() : current.label,
    hint: change.hint === undefined ? current.hint : (hintOf(change.hint) ?? null),
    position: change.position ?? current.position,
  };
  const check = validateActive(rows.map((t) => (t.id === current.id ? next : t)));
  if (check !== null) return { ok: false, code: check };
  db.prepare("UPDATE user_topics SET label = ?, hint = ?, position = ?, updated_at = ? WHERE id = ? AND user_id = ?")
    .run(next.label, next.hint, next.position, now.toISOString(), current.id, userId);
  return { ok: true, topic: next };
}

/** Deactivates (or reactivates) a custom topic. The row stays: answers with its key keep their label. */
export function setCustomTopicActive(db: DatabaseSync, userId: number, key: string, active: boolean, now: Date): TopicWriteResult {
  const rows = listCustomTopics(db, userId);
  const current = rows.find((t) => t.key === key);
  if (!current) return { ok: false, code: "not_found" };
  if (current.active === active) return { ok: true, topic: current };
  if (active) {
    if (rows.filter((t) => t.active).length >= ACTIVE_CUSTOM_TOPICS_LIMIT) return { ok: false, code: "too_many_active" };
    const check = validateActive(rows.map((t) => (t.id === current.id ? { ...t, active: true } : t)));
    if (check !== null) return { ok: false, code: check };
  }
  db.prepare("UPDATE user_topics SET active = ?, updated_at = ? WHERE id = ? AND user_id = ?").run(active ? 1 : 0, now.toISOString(), current.id, userId);
  return { ok: true, topic: { ...current, active } };
}

/** Key -> German label for every topic a stored answer of this user can carry: fixed, active and deactivated custom topics. */
export function topicLabels(db: DatabaseSync, userId: number): Map<string, string> {
  const m = new Map<string, string>(FIXED_TOPICS.map((t) => [t.key, t.label]));
  for (const t of listCustomTopics(db, userId)) m.set(t.key, t.label);
  return m;
}
