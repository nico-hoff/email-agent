// HTTP handlers of the topics (R8, ADR 0026/0037): the user's topic list with custom topics, the switch `topics_enabled`
// and the per-topic counts for the folder view. Thin: session/CSRF/limit gate (guardMutation), body check (zod), then
// packages/core/src/topics-store.ts. Scoped by the session's userId in every mode; a key or account of another user is 404. Responses carry
// keys, labels and hints the user typed, counts and codes; never mail data. Reachable from API routes: Map instead of obj[key].
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { validateDatabasePath } from "./accounts.ts";
import { type AuthContext, defaultAuthContext, defaultMutationLimiter, guardMutation, requireUser } from "./auth-runtime.ts";
import { PROJECT_ROOT } from "./constants.ts";
import { openDatabase } from "./db.ts";
import type { RateLimiter } from "./rate-limit.ts";
import { ownsAccount } from "./tenant.ts";
import { CUSTOM_HINT_MAX, CUSTOM_LABEL_MAX, CUSTOM_LABEL_MIN, FIXED_TOPICS } from "./topics.ts";
import {
  ACTIVE_CUSTOM_TOPICS_LIMIT,
  createCustomTopic,
  listCustomTopics,
  setCustomTopicActive,
  setTopicsEnabled,
  topicListForUser,
  topicsEnabled,
  updateCustomTopic,
  type TopicWriteError,
  type TopicWriteResult,
} from "./topics-store.ts";

export interface TopicsApiDeps {
  auth: AuthContext;
  limiter: RateLimiter;
  openDb(): DatabaseSync;
  now?: () => Date;
}

export function defaultTopicsDeps(): TopicsApiDeps {
  return {
    auth: defaultAuthContext(),
    limiter: defaultMutationLimiter(),
    openDb: () => openDatabase(validateDatabasePath(process.env, PROJECT_ROOT)),
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

function withDb(deps: TopicsApiDeps, fn: (db: DatabaseSync) => Response): Response {
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

function audit(db: DatabaseSync, userId: number, action: string, details: Record<string, unknown>, now: Date): void {
  db.prepare(
    `INSERT INTO audit_log (occurred_at, trace_id, actor, action, details_json, user_id) VALUES (?, ?, 'system', ?, ?, ?)`,
  ).run(now.toISOString(), randomUUID(), action, JSON.stringify(details), userId);
}

/** What the topics page shows: the switch, the limits, fixed topics (label only) and the user's custom topics. */
export function topicsView(db: DatabaseSync, userId: number) {
  const list = topicListForUser(db, userId);
  return {
    enabled: topicsEnabled(db, userId),
    limits: { active_custom_max: ACTIVE_CUSTOM_TOPICS_LIMIT, label_min: CUSTOM_LABEL_MIN, label_max: CUSTOM_LABEL_MAX, hint_max: CUSTOM_HINT_MAX },
    /** Version of the list new classifications are asked with (null if the list is invalid, which the write checks prevent). */
    list_version: list.ok ? list.version : null,
    topics: [
      ...FIXED_TOPICS.map((t, i) => ({ key: t.key, label: t.label, kind: "fixed" as const, hint: null, position: i, active: true })),
      ...listCustomTopics(db, userId).map((t) => ({ key: t.key, label: t.label, kind: "custom" as const, hint: t.hint, position: FIXED_TOPICS.length + t.position, active: t.active })),
    ],
  };
}

/** GET /api/topics */
export function handleTopicsGet(request: Request, deps: TopicsApiDeps): Response {
  const who = requireUser(request, deps.auth);
  if (!who.ok) return who.response;
  return withDb(deps, (db) => json(topicsView(db, who.userId)));
}

const key = z.string().regex(/^custom_[a-z0-9_]{1,32}$/);
const label = z.string().min(1).max(200);
const hint = z.string().max(400);
const postBody = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("create"), label, hint: hint.optional() }),
  z.strictObject({ action: z.literal("update"), key, label: label.optional(), hint: hint.nullable().optional(), position: z.number().int().min(0).max(1000).optional() }),
  z.strictObject({ action: z.literal("set_active"), key, active: z.boolean() }),
  z.strictObject({ action: z.literal("set_enabled"), enabled: z.boolean() }),
]);

const CONFLICTS: ReadonlySet<TopicWriteError> = new Set(["duplicate", "too_many_active", "too_many_rows", "inactive"]);

function writeResponse(db: DatabaseSync, userId: number, r: TopicWriteResult, onOk: () => void): Response {
  if (!r.ok) return json({ error: r.code }, r.code === "not_found" ? 404 : CONFLICTS.has(r.code) ? 409 : 400);
  onOk();
  return json({ ok: true, topic_key: r.topic.key, ...topicsView(db, userId) });
}

/**
 * POST /api/topics: { action: "create", label, hint? } | { action: "update", key, label?, hint?, position? } |
 * { action: "set_active", key, active } | { action: "set_enabled", enabled }.
 */
export async function handleTopicsPost(request: Request, deps: TopicsApiDeps): Promise<Response> {
  const gate = guardMutation(request, deps.auth, deps.limiter);
  if (!gate.ok) return gate.response;
  const parsed = postBody.safeParse(await readBody(request));
  if (!parsed.success) {
    return json({ error: "invalid_body", fields: [...new Set(parsed.error.issues.map((i) => i.path.join(".")))].slice(0, 5) }, 400);
  }
  const body = parsed.data;
  return withDb(deps, (db) => {
    const now = deps.now?.() ?? new Date();
    const userId = gate.userId;
    switch (body.action) {
      case "create": {
        const r = createCustomTopic(db, userId, { label: body.label, ...(body.hint !== undefined ? { hint: body.hint } : {}) }, now);
        return writeResponse(db, userId, r, () => audit(db, userId, "topic_created", { key: r.ok ? r.topic.key : null }, now));
      }
      case "update": {
        const r = updateCustomTopic(db, userId, body.key, {
          ...(body.label !== undefined ? { label: body.label } : {}),
          ...(body.hint !== undefined ? { hint: body.hint } : {}),
          ...(body.position !== undefined ? { position: body.position } : {}),
        }, now);
        return writeResponse(db, userId, r, () => audit(db, userId, "topic_updated", { key: body.key }, now));
      }
      case "set_active": {
        const r = setCustomTopicActive(db, userId, body.key, body.active, now);
        return writeResponse(db, userId, r, () => audit(db, userId, body.active ? "topic_reactivated" : "topic_deactivated", { key: body.key }, now));
      }
      case "set_enabled": {
        setTopicsEnabled(db, userId, body.enabled, now);
        audit(db, userId, body.enabled ? "topics_enabled" : "topics_disabled", {}, now);
        return json({ ok: true, ...topicsView(db, userId) });
      }
    }
  });
}

/**
 * GET /api/topics/counts[?account=<id>]: mails per topic for the folder view. Counts the latest classification of each
 * mail; mails without a topic answer (classified with v2, pending, failed) are `none`. A foreign account id is 404.
 */
export function handleTopicCounts(request: Request, deps: TopicsApiDeps): Response {
  const who = requireUser(request, deps.auth);
  if (!who.ok) return who.response;
  const account = new URL(request.url).searchParams.get("account");
  return withDb(deps, (db) => {
    if (account !== null && !ownsAccount(db, who.userId, account)) return json({ error: "not_found" }, 404);
    const accountSql = account === null ? "" : " AND e.account_id = ?";
    const params: (string | number)[] = account === null ? [who.userId] : [who.userId, account];
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM emails e JOIN accounts a ON a.id = e.account_id WHERE a.user_id = ?${accountSql}`).get(...params) as { n: number }).n;
    const rows = db.prepare(
      `SELECT json_extract(ans.answer_json, '$.value') AS topic, COUNT(*) AS n
       FROM emails e
       JOIN accounts a ON a.id = e.account_id
       JOIN classifications c ON c.id = (SELECT MAX(id) FROM classifications WHERE email_id = e.id)
       JOIN classification_answers ans ON ans.classification_id = c.id AND ans.question_key = 'topic'
       WHERE a.user_id = ?${accountSql} GROUP BY 1`,
    ).all(...params) as unknown as { topic: string; n: number }[];
    const counted = new Map(rows.map((r) => [r.topic, r.n] as const));
    const view = topicsView(db, who.userId);
    const known = new Set(view.topics.map((t) => t.key));
    const topics = view.topics
      // A deactivated custom topic is listed only while mails still carry it.
      .filter((t) => t.active || (counted.get(t.key) ?? 0) > 0)
      .map((t) => ({ key: t.key, label: t.label, kind: t.kind, active: t.active, count: counted.get(t.key) ?? 0 }));
    const withTopic = rows.reduce((s, r) => s + r.n, 0);
    const unlisted = rows.filter((r) => !known.has(r.topic)).reduce((s, r) => s + r.n, 0);
    return json({ enabled: view.enabled, total, none: total - withTopic, unlisted, topics });
  });
}
