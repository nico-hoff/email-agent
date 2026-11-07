// Small key-value store for state of the app itself (docs/erd.md, entwurfsentscheidung 15). Values are timestamps,
// numbers and short codes; never mail, briefing or draft text.
import type { DatabaseSync } from "node:sqlite";

export const LAST_OPENED_KEY = "last_opened_at";

export function getUserState(db: DatabaseSync, userId: number, key: string): unknown {
  const row = db.prepare("SELECT value_json FROM user_state WHERE user_id = ? AND key = ?").get(userId, key) as { value_json: string } | undefined;
  if (!row) return undefined;
  try {
    return JSON.parse(row.value_json) as unknown;
  } catch {
    return undefined;
  }
}

export function setUserState(db: DatabaseSync, userId: number, key: string, value: unknown, ts: string): void {
  db.prepare(
    `INSERT INTO user_state (user_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
  ).run(userId, key, JSON.stringify(value), ts);
}

/** The ISO timestamp stored under last_opened_at, or null when the briefing was never generated (or the value is unusable). */
export function readLastOpened(db: DatabaseSync, userId: number): string | null {
  const v = getUserState(db, userId, LAST_OPENED_KEY);
  const at = typeof v === "object" && v !== null && !Array.isArray(v) ? new Map(Object.entries(v)).get("at") : undefined;
  return typeof at === "string" && Number.isFinite(Date.parse(at)) ? at : null;
}
