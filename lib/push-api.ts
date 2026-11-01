// HTTP handlers of Web Push (R6, ADR 0036). Thin: session/CSRF/limit gate, body check (zod), lib/push.ts.
// Scoped by the session's userId in every mode (the transitional modes act as the owner, user 1); a foreign device is 404.
// No response ever contains an endpoint or a key; the device list shows id, browser family, times and kinds.
// Without a valid VAPID pair the feature is off: config says so, writing routes answer 503 push_unavailable.
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { validateDatabasePath } from "./accounts.ts";
import { type AuthContext, createMutationLimiter, defaultAuthContext, defaultMutationLimiter, guardMutation, requireUser } from "./auth-runtime.ts";
import { PROJECT_ROOT } from "./constants.ts";
import { openDatabase } from "./db.ts";
import {
  agentFamily, buildPayload, fetchTransport, getDevice, listDevices, loadPushConfig, PUSH_MAX_DEVICES, sendToUser, subscribeDevice, unsubscribeDevice,
  type PushTransport,
} from "./push.ts";
import type { RateLimiter } from "./rate-limit.ts";

export interface PushApiDeps {
  auth: AuthContext;
  limiter: RateLimiter;
  /** A test push reaches the outside world: a tighter budget per identity. */
  testLimiter: RateLimiter;
  openDb(): DatabaseSync;
  env: Record<string, string | undefined>;
  transport: PushTransport;
  now?: () => Date;
}

const TEST_LIMIT = 5;
let defaultTest: RateLimiter | undefined;

export function defaultPushDeps(): PushApiDeps {
  return {
    auth: defaultAuthContext(),
    limiter: defaultMutationLimiter(),
    testLimiter: (defaultTest ??= createMutationLimiter(undefined, TEST_LIMIT)),
    openDb: () => openDatabase(validateDatabasePath(process.env, PROJECT_ROOT)),
    env: process.env,
    transport: fetchTransport,
  };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
const BODY_MAX_CHARS = 4096;

async function readBody(request: Request): Promise<unknown | undefined> {
  try {
    const text = await request.text();
    if (text.length > BODY_MAX_CHARS) return undefined;
    return text.trim() === "" ? {} : JSON.parse(text);
  } catch {
    return undefined;
  }
}

function withDb(deps: PushApiDeps, fn: (db: DatabaseSync) => Response | Promise<Response>): Promise<Response> | Response {
  let db: DatabaseSync | undefined;
  try {
    db = deps.openDb();
  } catch {
    return json({ error: "unavailable" }, 500);
  }
  const open = db;
  try {
    const r = fn(open);
    if (r instanceof Promise) return r.catch(() => json({ error: "unavailable" }, 500)).finally(() => open.close());
    open.close();
    return r;
  } catch {
    open.close();
    return json({ error: "unavailable" }, 500);
  }
}

/** GET /api/push/config: whether push is available and the public VAPID key (public by design, needed by subscribe()). */
export function handlePushConfig(request: Request, deps: PushApiDeps): Response {
  const who = requireUser(request, deps.auth);
  if (!who.ok) return who.response;
  const cfg = loadPushConfig(deps.env);
  if (!cfg.ok) return json({ available: false, reason: cfg.reason, max_devices: PUSH_MAX_DEVICES });
  return json({ available: true, public_key: cfg.config.publicKey, max_devices: PUSH_MAX_DEVICES });
}

/** GET /api/push/subscriptions: the user's own devices. */
export function handlePushList(request: Request, deps: PushApiDeps): Promise<Response> | Response {
  const who = requireUser(request, deps.auth);
  if (!who.ok) return who.response;
  return withDb(deps, (db) => json({ devices: listDevices(db, who.userId) }));
}

const subscribeBody = z.object({
  endpoint: z.string().min(20).max(1024),
  expirationTime: z.number().nullable().optional(),
  keys: z.strictObject({ p256dh: z.string().min(1).max(128), auth: z.string().min(1).max(64) }),
  kinds: z.strictObject({ important_mail: z.boolean().optional(), briefing_ready: z.boolean().optional() }).optional(),
});

/** POST /api/push/subscribe: body is PushSubscription.toJSON() plus optional `kinds`. Registers or refreshes this device. */
export async function handlePushSubscribe(request: Request, deps: PushApiDeps): Promise<Response> {
  const gate = guardMutation(request, deps.auth, deps.limiter);
  if (!gate.ok) return gate.response;
  if (!loadPushConfig(deps.env).ok) return json({ error: "push_unavailable" }, 503);
  const parsed = subscribeBody.safeParse(await readBody(request));
  if (!parsed.success) return json({ error: "invalid_body" }, 400);
  const b = parsed.data;
  return withDb(deps, (db) => {
    const kinds = b.kinds ? {
      ...(b.kinds.important_mail !== undefined ? { important_mail: b.kinds.important_mail } : {}),
      ...(b.kinds.briefing_ready !== undefined ? { briefing_ready: b.kinds.briefing_ready } : {}),
    } : undefined;
    const r = subscribeDevice(db, gate.userId, {
      endpoint: b.endpoint, p256dh: b.keys.p256dh, auth: b.keys.auth, agentFamily: agentFamily(request.headers.get("user-agent")),
      ...(kinds ? { kinds } : {}),
    }, deps.now?.() ?? new Date());
    if (!r.ok) return json({ error: r.code }, r.code === "device_limit" ? 409 : 400);
    return json({ ok: true, device: getDevice(db, gate.userId, r.id) }, 201);
  });
}

const unsubscribeBody = z.union([
  z.strictObject({ endpoint: z.string().min(20).max(1024) }),
  z.strictObject({ id: z.number().int().positive() }),
]);

/** POST /api/push/unsubscribe: { endpoint } or { id } of one of the caller's devices; anything else is 404. */
export async function handlePushUnsubscribe(request: Request, deps: PushApiDeps): Promise<Response> {
  const gate = guardMutation(request, deps.auth, deps.limiter);
  if (!gate.ok) return gate.response;
  const parsed = unsubscribeBody.safeParse(await readBody(request));
  if (!parsed.success) return json({ error: "invalid_body" }, 400);
  const by = parsed.data;
  return withDb(deps, (db) => {
    if (!unsubscribeDevice(db, gate.userId, "endpoint" in by ? { endpoint: by.endpoint } : { id: by.id })) return json({ error: "not_found" }, 404);
    return json({ ok: true });
  });
}

/** POST /api/push/test: a test notification to the caller's own devices (all of them, backoff ignored). */
export async function handlePushTest(request: Request, deps: PushApiDeps): Promise<Response> {
  const gate = guardMutation(request, deps.auth, deps.limiter);
  if (!gate.ok) return gate.response;
  const cfg = loadPushConfig(deps.env);
  if (!cfg.ok) return json({ error: "push_unavailable" }, 503);
  const lim = deps.testLimiter.check(gate.login);
  if (!lim.allowed) return json({ error: "rate_limited" }, 429, { "retry-after": String(Math.ceil(lim.retryAfterMs / 1000)) });
  return withDb(deps, async (db) => {
    if (listDevices(db, gate.userId).length === 0) return json({ error: "no_devices" }, 409);
    const s = await sendToUser(
      { db, config: cfg.config, transport: deps.transport, now: deps.now ?? (() => new Date()) },
      gate.userId, buildPayload("test", 1), { urgency: "high", ttl: 300, ignoreBackoff: true },
    );
    return json({ ok: s.sent > 0, sent: s.sent, removed: s.removed, failed: s.failed + s.retry_later });
  });
}
