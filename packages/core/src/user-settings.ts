// Per-user settings and permissions (migration 008, ADR 0025 Teil 1, ADR 0041): the emergency stop of automatic mailbox
// actions, the right to choose the classifier model and that choice. Pure SQLite, scoped by userId. A user without a row has
// the defaults: no permission, no stop, Jev. Values are switches, a timestamp and an allowlisted model name; no mail data.
import type { DatabaseSync } from "node:sqlite";
import { DEFAULT_CLASSIFIER, isClassifierModel } from "./classifier-models.ts";
import { calibrationFor } from "./noul-calibration.ts";
import { QUESTION_SET_VERSION } from "./constants.ts";

export interface UserSettings {
  classifier_choice: boolean;
  classifier_model: string | null;
  /** ISO timestamp while the user's emergency stop is on, else null. */
  stopped_at: string | null;
}

export function readUserSettings(db: DatabaseSync, userId: number): UserSettings {
  const r = db.prepare("SELECT classifier_choice, classifier_model, auto_actions_stopped_at FROM user_settings WHERE user_id = ?")
    .get(userId) as { classifier_choice: number; classifier_model: string | null; auto_actions_stopped_at: string | null } | undefined;
  return {
    classifier_choice: r?.classifier_choice === 1,
    classifier_model: r?.classifier_model ?? null,
    stopped_at: r?.auto_actions_stopped_at ?? null,
  };
}

function ensureRow(db: DatabaseSync, userId: number, ts: string): void {
  db.prepare("INSERT OR IGNORE INTO user_settings (user_id, updated_at) VALUES (?, ?)").run(userId, ts);
}

/** Per-user emergency stop: read before every automatic mailbox action (packages/core/src/mailbox-actions.ts). Unreadable = stopped (fail-closed). */
export function userStopped(db: DatabaseSync, userId: number): boolean {
  try {
    return readUserSettings(db, userId).stopped_at !== null;
  } catch {
    return true;
  }
}

export function setUserStop(db: DatabaseSync, userId: number, stopped: boolean, now: Date): void {
  const ts = now.toISOString();
  ensureRow(db, userId, ts);
  db.prepare("UPDATE user_settings SET auto_actions_stopped_at = ?, updated_at = ? WHERE user_id = ?").run(stopped ? ts : null, ts, userId);
}

export function setClassifierChoice(db: DatabaseSync, userId: number, granted: boolean, now: Date): void {
  const ts = now.toISOString();
  ensureRow(db, userId, ts);
  db.prepare("UPDATE user_settings SET classifier_choice = ?, updated_at = ? WHERE user_id = ?").run(granted ? 1 : 0, ts, userId);
}

/** A model may be chosen when it is on the allowlist and calibrated for the current default question set (ADR 0041). */
export function isSelectableModel(model: string): boolean {
  return isClassifierModel(model) && calibrationFor(QUESTION_SET_VERSION, model) !== null;
}

export type SetModelResult = "ok" | "no_permission" | "invalid_model" | "not_calibrated";

export function setClassifierModel(db: DatabaseSync, userId: number, model: string, now: Date): SetModelResult {
  if (!readUserSettings(db, userId).classifier_choice) return "no_permission";
  if (!isClassifierModel(model)) return "invalid_model";
  if (!isSelectableModel(model)) return "not_calibrated";
  const ts = now.toISOString();
  ensureRow(db, userId, ts);
  db.prepare("UPDATE user_settings SET classifier_model = ?, updated_at = ? WHERE user_id = ?").run(model, ts, userId);
  return "ok";
}

/**
 * The model the pipeline uses for this user's accounts. Without the permission, with an unknown or uncalibrated stored model,
 * or on any error it is the default (Jev). Revoking the permission therefore takes effect at once.
 */
export function classifierModelFor(db: DatabaseSync, userId: number): string {
  try {
    const s = readUserSettings(db, userId);
    if (s.classifier_choice && s.classifier_model !== null && isSelectableModel(s.classifier_model)) return s.classifier_model;
  } catch {
    // fall through to the default
  }
  return DEFAULT_CLASSIFIER;
}
