// HTTP handlers for feedback (T37) and sender rules / HITL (T54 backend). Thin: auth and body checks, then lib calls.
// POST order (guardMutation): session 401, rate limit 429, CSRF 403, then body (400), then the write. GET routes sit behind
// the session guard (interceptRequest in lib/auth-runtime.ts). Responses carry ids, codes and addresses/domains Nico typed himself; no subjects.
import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { validateDatabasePath } from "./accounts.ts";
import { type AuthContext, defaultAuthContext, defaultMutationLimiter, guardMutation } from "./auth-runtime.ts";
import { PROJECT_ROOT } from "./constants.ts";
import { openDatabase } from "./db.ts";
import { parseEmailId } from "./email-status.ts";
import { FEEDBACK_KINDS, feedbackState, recordFeedback } from "./feedback.ts";
import { dismissHitl, listHitl } from "./sender-hitl.ts";
import { createRule, deactivateRule, listRules, RULE_KINDS, RULE_MATCHES } from "./sender-rules.ts";
import type { RateLimiter } from "./rate-limit.ts";

export interface ApiDeps {
  auth: AuthContext;
  limiter: RateLimiter;
  openDb(): DatabaseSync;
  now?: () => Date;
}

/** Wiring for the route modules: the shared auth context and mutation limiter, the configured database. */
export function defaultApiDeps(): ApiDeps {
  return {
    auth: defaultAuthContext(),
    limiter: defaultMutationLimiter(),
    openDb: () => openDatabase(validateDatabasePath(process.env, PROJECT_ROOT)),
  };
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const BODY_MAX_BYTES = 2048;

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    return null;
  }
  if (text.length === 0 || text.length > BODY_MAX_BYTES) return null;
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function mutate(
  request: Request,
  deps: ApiDeps,
  run: (db: DatabaseSync, ts: string, body: Record<string, unknown>) => Response,
  options: { body?: boolean } = {},
): Promise<Response> {
  const gate = guardMutation(request, deps.auth, deps.limiter);
  if (!gate.ok) return gate.response;
  let body: Record<string, unknown> = {};
  if (options.body !== false) {
    const b = await readBody(request);
    if (b === null) return json({ error: "invalid_body" }, 400);
    body = b;
  }
  let db: DatabaseSync | undefined;
  try {
    db = deps.openDb();
    return run(db, (deps.now?.() ?? new Date()).toISOString(), body);
  } catch {
    return json({ error: "unavailable" }, 500);
  } finally {
    db?.close();
  }
}

function read(deps: Pick<ApiDeps, "openDb">, run: (db: DatabaseSync) => Response): Response {
  let db: DatabaseSync | undefined;
  try {
    db = deps.openDb();
    return run(db);
  } catch {
    return json({ error: "unavailable" }, 500);
  } finally {
    db?.close();
  }
}

// ---- feedback ----
const feedbackBody = z.strictObject({ kind: z.enum(FEEDBACK_KINDS), value: z.string().max(64).optional() });

export function handleFeedbackPost(request: Request, rawId: unknown, deps: ApiDeps): Promise<Response> {
  return mutate(request, deps, (db, ts, body) => {
    const id = parseEmailId(rawId);
    if (id === null) return json({ error: "not_found" }, 404);
    const parsed = feedbackBody.safeParse(body);
    if (!parsed.success) return json({ error: "invalid_body" }, 400);
    const r = recordFeedback(db, { emailId: id, kind: parsed.data.kind, value: parsed.data.value, ts });
    if (!r.ok) return r.code === "not_found" ? json({ error: "not_found" }, 404) : json({ error: r.code }, 400);
    return json({ ok: true, id, kind: parsed.data.kind, changed: r.changed, feedback: feedbackState(db, id) });
  });
}

export function handleFeedbackGet(rawId: unknown, deps: Pick<ApiDeps, "openDb">): Response {
  const id = parseEmailId(rawId);
  if (id === null) return json({ error: "not_found" }, 404);
  return read(deps, (db) => {
    if (!db.prepare("SELECT 1 FROM emails WHERE id = ?").get(id)) return json({ error: "not_found" }, 404);
    return json({ id, feedback: feedbackState(db, id) });
  });
}

// ---- rules ----
const ruleBody = z.strictObject({
  match: z.enum(RULE_MATCHES),
  value: z.string().min(1).max(254),
  kind: z.enum(RULE_KINDS),
  account_id: z.string().min(1).max(64).optional(),
});

export function handleRulesCreate(request: Request, deps: ApiDeps): Promise<Response> {
  return mutate(request, deps, (db, ts, body) => {
    const parsed = ruleBody.safeParse(body);
    if (!parsed.success) return json({ error: "invalid_body" }, 400);
    const r = createRule(db, { kind: parsed.data.kind, match: parsed.data.match, value: parsed.data.value, accountId: parsed.data.account_id, ts });
    if (!r.ok) return json({ error: r.code }, 400);
    return json({ ok: true, rule: r.rule, changed: r.changed, deactivated_rule_ids: r.deactivated });
  });
}

export function handleRulesList(request: Request, deps: Pick<ApiDeps, "openDb">): Response {
  const includeInactive = new URL(request.url).searchParams.get("include_inactive") === "1";
  return read(deps, (db) => json({ rules: listRules(db, { includeInactive }) }));
}

export function handleRuleDeactivate(request: Request, rawId: unknown, deps: ApiDeps): Promise<Response> {
  return mutate(request, deps, (db, ts) => {
    const id = parseEmailId(rawId); // same strict positive-integer shape
    if (id === null) return json({ error: "not_found" }, 404);
    const r = deactivateRule(db, id, ts);
    if (!r.ok) return json({ error: "not_found" }, 404);
    return json({ ok: true, rule: r.rule, changed: r.changed });
  }, { body: false });
}

// ---- HITL ----
const dismissBody = z.strictObject({ match: z.enum(RULE_MATCHES), value: z.string().min(1).max(254) });

export function handleHitlList(deps: Pick<ApiDeps, "openDb">): Response {
  return read(deps, (db) => json({ candidates: listHitl(db) }));
}

export function handleHitlDismiss(request: Request, deps: ApiDeps): Promise<Response> {
  return mutate(request, deps, (db, ts, body) => {
    const parsed = dismissBody.safeParse(body);
    if (!parsed.success) return json({ error: "invalid_body" }, 400);
    const r = dismissHitl(db, parsed.data.match, parsed.data.value, ts);
    if (!r.ok) return r.code === "not_found" ? json({ error: "not_found" }, 404) : json({ error: r.code }, 400);
    return json({ ok: true, changed: r.changed });
  });
}
