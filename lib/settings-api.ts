// HTTP handlers of the profile settings (R3): automatic mailbox actions (ADR 0025 Teil 1) and the classifier model (ADR 0041).
// Thin: session/CSRF/limit gate (guardMutation), body check (zod), lib/auto-actions-settings.ts and lib/user-settings.ts.
// Scoped by the session's userId in every mode (the transitional modes act as the owner, user 1); a foreign account id is 404.
// Nothing here can switch an account to `live` without `confirm: true` in the body, and nothing defaults to it. Audit rows
// carry codes and ids only. Responses never contain mail data.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { validateDatabasePath } from "./accounts.ts";
import { AUTO_ACTION_MODES } from "./accounts-config.ts";
import { DAILY_ACTION_LIMIT, globalStopActive, liveActionsLast24h, setGlobalStop, setSpamSeenMode } from "./auto-actions-settings.ts";
import { type AuthContext, dataDirFromEnv, defaultAuthContext, defaultMutationLimiter, guardMutation, requireUser } from "./auth-runtime.ts";
import { CLASSIFIER_MODELS, relativeCost } from "./classifier-models.ts";
import { KILL_SWITCH_FILE, PROJECT_ROOT } from "./constants.ts";
import { openDatabase } from "./db.ts";
import type { RateLimiter } from "./rate-limit.ts";
import { classifierModelFor, isSelectableModel, readUserSettings, setClassifierChoice, setClassifierModel, setUserStop } from "./user-settings.ts";

export interface SettingsApiDeps {
  auth: AuthContext;
  limiter: RateLimiter;
  openDb(): DatabaseSync;
  /** The global stop file (default: auto-actions.disabled next to the database). */
  killSwitchFile: string;
  now?: () => Date;
}

export function defaultSettingsDeps(): SettingsApiDeps {
  return {
    auth: defaultAuthContext(),
    limiter: defaultMutationLimiter(),
    openDb: () => openDatabase(validateDatabasePath(process.env, PROJECT_ROOT)),
    killSwitchFile: join(dataDirFromEnv(process.env, PROJECT_ROOT), KILL_SWITCH_FILE),
  };
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const BODY_MAX_CHARS = 1024;

async function readBody(request: Request): Promise<unknown | undefined> {
  try {
    const text = await request.text();
    if (text.length > BODY_MAX_CHARS) return undefined;
    return text.trim() === "" ? {} : JSON.parse(text);
  } catch {
    return undefined;
  }
}

function withDb(deps: SettingsApiDeps, fn: (db: DatabaseSync) => Response): Response {
  let db: DatabaseSync | undefined;
  try {
    db = deps.openDb();
    return fn(db);
  } catch {
    return json({ error: "unavailable" }, 500);
  } finally {
    db?.close();
  }
}

const nowOf = (deps: SettingsApiDeps): Date => deps.now?.() ?? new Date();

function audit(db: DatabaseSync, userId: number, action: string, accountId: string | null, details: Record<string, unknown>, now: Date): void {
  db.prepare(
    `INSERT INTO audit_log (occurred_at, trace_id, actor, action, account_id, details_json, user_id) VALUES (?, ?, 'system', ?, ?, ?, ?)`,
  ).run(now.toISOString(), randomUUID(), action, accountId, JSON.stringify(details), userId);
}

interface AccountRow { id: string; label: string; color: string | null; enabled: number; spam_seen_mode: string | null }

function accountViews(db: DatabaseSync, userId: number, now: Date) {
  const rows = db.prepare(
    `SELECT a.id, a.label, a.color, a.enabled, m.spam_seen_mode
     FROM accounts a LEFT JOIN mail_accounts m ON m.account_id = a.id AND m.user_id = a.user_id
     WHERE a.user_id = ? ORDER BY a.rowid`,
  ).all(userId) as unknown as AccountRow[];
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    color: r.color ?? "#3b82f6",
    enabled: r.enabled === 1,
    managed: r.spam_seen_mode !== null,
    // Demo accounts without credentials row have no mode of their own and never act (the list header reads them as dry run).
    spam_seen_mode: r.spam_seen_mode,
    actions_24h: liveActionsLast24h(db, r.id, now),
  }));
}

function classifierView(db: DatabaseSync, userId: number) {
  const s = readUserSettings(db, userId);
  if (!s.classifier_choice) return { permitted: false as const };
  const effective = classifierModelFor(db, userId);
  return {
    permitted: true as const,
    model: effective,
    models: CLASSIFIER_MODELS.map((m) => ({
      id: m.id, label: m.label, description: m.description, selectable: isSelectableModel(m.id),
      usd_per_1000: m.usdPer1000, relative_cost: relativeCost(m),
    })),
  };
}

/** The users admins see in the permissions list: id, address, role, status and the one switch. */
function members(db: DatabaseSync) {
  const rows = db.prepare(
    `SELECT u.id, u.email, u.role, u.status, COALESCE(s.classifier_choice, 0) AS classifier_choice
     FROM users u LEFT JOIN user_settings s ON s.user_id = u.id WHERE u.status <> 'disabled' ORDER BY u.id`,
  ).all() as unknown as { id: number; email: string; role: string; status: string; classifier_choice: number }[];
  return rows.map((r) => ({ id: r.id, email: r.status === "unclaimed" ? null : r.email, role: r.role, status: r.status, classifier_choice: r.classifier_choice === 1 }));
}

/** GET /api/settings: everything the settings section shows. */
export function handleSettingsGet(request: Request, deps: SettingsApiDeps): Response {
  const who = requireUser(request, deps.auth);
  if (!who.ok) return who.response;
  return withDb(deps, (db) => {
    const now = nowOf(deps);
    const s = readUserSettings(db, who.userId);
    return json({
      stop: { user_stopped_at: s.stopped_at, global_active: globalStopActive(deps.killSwitchFile), can_toggle_global: who.role === "admin" },
      daily_limit: DAILY_ACTION_LIMIT,
      accounts: accountViews(db, who.userId, now),
      classifier: classifierView(db, who.userId),
      ...(who.role === "admin" ? { members: members(db) } : {}),
      synthetic: deps.auth.synthetic,
    });
  });
}

const invalid = (parsed: { success: false; error: z.ZodError }) =>
  json({ error: "invalid_body", fields: [...new Set(parsed.error.issues.map((i) => i.path.join(".")))].slice(0, 5) }, 400);

const spamSeenBody = z.strictObject({
  account_id: z.string().min(1).max(64),
  mode: z.enum(AUTO_ACTION_MODES),
  /** Required for `live` only: the app sends it after the person confirmed the dialog. */
  confirm: z.boolean().optional(),
});

/** POST /api/settings/spam-seen: mode of "Spam als gelesen markieren" for one of the user's own accounts. */
export async function handleSpamSeenMode(request: Request, deps: SettingsApiDeps): Promise<Response> {
  const gate = guardMutation(request, deps.auth, deps.limiter);
  if (!gate.ok) return gate.response;
  const parsed = spamSeenBody.safeParse(await readBody(request));
  if (!parsed.success) return invalid(parsed);
  const { account_id: accountId, mode, confirm } = parsed.data;
  if (mode === "live" && confirm !== true) return json({ error: "confirmation_required" }, 400);
  return withDb(deps, (db) => {
    const now = nowOf(deps);
    const r = setSpamSeenMode(db, gate.userId, accountId, mode, now);
    if (!r.ok) return json({ error: r.code }, r.code === "not_found" ? 404 : 409);
    audit(db, gate.userId, "spam_seen_mode_changed", accountId, { from: r.previous, to: mode }, now);
    return json({ ok: true, account: accountViews(db, gate.userId, now).find((a) => a.id === accountId) ?? null });
  });
}

const stopBody = z.strictObject({
  scope: z.enum(["user", "global"]),
  stopped: z.boolean(),
  /** Global only: the person confirmed the dialog. */
  confirm: z.boolean().optional(),
});

/** POST /api/settings/stop: emergency stop. `user` for the signed-in user, `global` (the stop file) for admins. */
export async function handleStop(request: Request, deps: SettingsApiDeps): Promise<Response> {
  const gate = guardMutation(request, deps.auth, deps.limiter);
  if (!gate.ok) return gate.response;
  const parsed = stopBody.safeParse(await readBody(request));
  if (!parsed.success) return invalid(parsed);
  const { scope, stopped, confirm } = parsed.data;
  if (scope === "global") {
    if (gate.role !== "admin") return json({ error: "forbidden" }, 403);
    if (confirm !== true) return json({ error: "confirmation_required" }, 400);
  }
  return withDb(deps, (db) => {
    const now = nowOf(deps);
    if (scope === "global") {
      try {
        setGlobalStop(deps.killSwitchFile, stopped);
      } catch {
        return json({ error: "unavailable" }, 500);
      }
      audit(db, gate.userId, stopped ? "global_stop_set" : "global_stop_cleared", null, {}, now);
    } else {
      setUserStop(db, gate.userId, stopped, now);
      audit(db, gate.userId, stopped ? "user_stop_set" : "user_stop_cleared", null, {}, now);
    }
    const s = readUserSettings(db, gate.userId);
    return json({ ok: true, stop: { user_stopped_at: s.stopped_at, global_active: globalStopActive(deps.killSwitchFile), can_toggle_global: gate.role === "admin" } });
  });
}

const classifierBody = z.strictObject({ model: z.string().min(1).max(64) });

/** POST /api/settings/classifier: the signed-in user's classifier model. Needs the permission `classifier_choice`. */
export async function handleClassifierModel(request: Request, deps: SettingsApiDeps): Promise<Response> {
  const gate = guardMutation(request, deps.auth, deps.limiter);
  if (!gate.ok) return gate.response;
  const parsed = classifierBody.safeParse(await readBody(request));
  if (!parsed.success) return invalid(parsed);
  return withDb(deps, (db) => {
    const now = nowOf(deps);
    const r = setClassifierModel(db, gate.userId, parsed.data.model, now);
    if (r === "no_permission") return json({ error: "forbidden" }, 403);
    if (r === "invalid_model") return json({ error: "invalid_model" }, 400);
    if (r === "not_calibrated") return json({ error: "not_calibrated" }, 409);
    audit(db, gate.userId, "classifier_model_changed", null, { model: parsed.data.model }, now);
    return json({ ok: true, classifier: classifierView(db, gate.userId) });
  });
}

const permissionBody = z.strictObject({ user_id: z.number().int().positive(), classifier_choice: z.boolean() });

/** POST /api/settings/permissions: an admin grants or revokes `classifier_choice` for a user. */
export async function handlePermission(request: Request, deps: SettingsApiDeps): Promise<Response> {
  const gate = guardMutation(request, deps.auth, deps.limiter);
  if (!gate.ok) return gate.response;
  if (gate.role !== "admin") return json({ error: "forbidden" }, 403);
  const parsed = permissionBody.safeParse(await readBody(request));
  if (!parsed.success) return invalid(parsed);
  const { user_id: target, classifier_choice: granted } = parsed.data;
  return withDb(deps, (db) => {
    const now = nowOf(deps);
    if (!db.prepare("SELECT 1 FROM users WHERE id = ? AND status <> 'disabled'").get(target)) return json({ error: "not_found" }, 404);
    setClassifierChoice(db, target, granted, now);
    // Revoking also drops the stored choice: a later grant starts from the default (Jev).
    if (!granted) db.prepare("UPDATE user_settings SET classifier_model = NULL WHERE user_id = ?").run(target);
    audit(db, gate.userId, granted ? "classifier_choice_granted" : "classifier_choice_revoked", null, { target_user_id: target }, now);
    return json({ ok: true, members: members(db) });
  });
}
