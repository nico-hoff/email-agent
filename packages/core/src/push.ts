// Web Push (R6, ADR 0027, ADR 0036): VAPID configuration, the minimal payload, the subscription store and the sender.
// Fail-closed: without a valid VAPID pair and subject nothing is sent and the API reports `push_unavailable`.
// The payload carries kind and count only: never a subject, body, address or name. Endpoints are secrets-like and are
// never logged, never returned by an API and never part of an error message.
// Module is reachable from API routes: no dynamic obj[key] reads (the Veryfront loader rejects them).
import type { DatabaseSync } from "node:sqlite";
import { b64urlDecode, encryptPayload, vapidAuthorization, vapidKeysMatch, VAPID_PRIVATE_BYTES, VAPID_PUBLIC_BYTES, type VapidSigner } from "./push-crypto.ts";

export const PUSH_KINDS = ["important_mail", "briefing_ready"] as const;
export type PushKind = (typeof PUSH_KINDS)[number];
export type PayloadKind = PushKind | "test";

/** At most one push per user and kind within this window; further mails are counted and sent together afterwards. */
export const PUSH_MIN_INTERVAL_MS = 10 * 60_000;
/** How long a push service keeps an undeliverable message (seconds). A stale "2 wichtige Mails" is worthless after hours. */
export const PUSH_TTL_SECONDS = 4 * 3600;
export const PUSH_MAX_DEVICES = 10;
/** After this many failures in a row a device is dropped (404/410 drop it at once). */
export const PUSH_MAX_FAILURES = 10;
export const PUSH_BACKOFF_MIN_MS = 60_000;
export const PUSH_BACKOFF_MAX_MS = 6 * 3600_000;
const SEND_TIMEOUT_MS = 10_000;

// ---- configuration ------------------------------------------------------------------------------------------------

export type PushConfigResult =
  | { ok: true; config: VapidSigner }
  | { ok: false; reason: "vapid_not_configured" | "vapid_invalid" | "vapid_subject_missing" };

const SUBJECT = /^(mailto:[^\s@]+@[^\s@]+|https:\/\/[^\s]+)$/;

/**
 * Reads VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT (formats as in scripts/fly-secrets.ts). Apple's push
 * service rejects tokens without a valid `sub`, so a missing subject also turns the feature off. Values are never returned
 * in a reason and never logged.
 */
export function loadPushConfig(env: Record<string, string | undefined>): PushConfigResult {
  const pub = env.VAPID_PUBLIC_KEY?.trim() ?? "";
  const priv = env.VAPID_PRIVATE_KEY?.trim() ?? "";
  const subject = env.VAPID_SUBJECT?.trim() ?? "";
  if (pub === "" && priv === "") return { ok: false, reason: "vapid_not_configured" };
  if (b64urlDecode(pub)?.length !== VAPID_PUBLIC_BYTES || b64urlDecode(priv)?.length !== VAPID_PRIVATE_BYTES || !vapidKeysMatch(pub, priv)) {
    return { ok: false, reason: "vapid_invalid" };
  }
  if (subject === "") return { ok: false, reason: "vapid_subject_missing" };
  if (!SUBJECT.test(subject)) return { ok: false, reason: "vapid_invalid" };
  return { ok: true, config: { publicKey: pub, privateKey: priv, subject } };
}

// ---- payload ------------------------------------------------------------------------------------------------------

export interface PushPayload { v: 1; kind: PayloadKind; count: number }

/** The only message content there is. `count` is clamped to 1..99. */
export function buildPayload(kind: PayloadKind, count: number): PushPayload {
  const n = Number.isFinite(count) ? Math.floor(count) : 1;
  return { v: 1, kind, count: Math.min(99, Math.max(1, n)) };
}

// ---- endpoint and device validation -------------------------------------------------------------------------------

const PUSH_HOSTS: readonly RegExp[] = [
  /^web\.push\.apple\.com$/,
  /^[a-z0-9-]+\.push\.apple\.com$/,
  /^fcm\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^[a-z0-9-]+\.push\.services\.mozilla\.com$/,
  /^[a-z0-9.-]+\.notify\.windows\.com$/,
];

/**
 * The server only ever POSTs to the push services of the big browsers (SSRF guard): https, default port, no credentials,
 * host on the allowlist. Anything else is refused at subscribe time and again before every send.
 */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  if (endpoint.length < 20 || endpoint.length > 1024) return false;
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.port !== "" || u.username !== "" || u.password !== "" || u.hash !== "") return false;
  return PUSH_HOSTS.some((re) => re.test(u.hostname));
}

/** Coarse browser family from the User-Agent header; the header itself is never stored. */
export function agentFamily(userAgent: string | null): string {
  const ua = userAgent ?? "";
  if (/iPhone|iPad|iPod/.test(ua)) return "iOS Safari";
  if (/Android/.test(ua)) return /Firefox/.test(ua) ? "Android Firefox" : "Android Chrome";
  if (/Edg\//.test(ua)) return "Desktop Edge";
  if (/Firefox\//.test(ua)) return "Desktop Firefox";
  if (/Chrome\//.test(ua)) return "Desktop Chrome";
  if (/Safari\//.test(ua)) return "Desktop Safari";
  return "unknown";
}

// ---- store --------------------------------------------------------------------------------------------------------

export interface DeviceView {
  id: number;
  agent_family: string;
  created_at: string;
  last_success_at: string | null;
  failing: boolean;
  kinds: { important_mail: boolean; briefing_ready: boolean };
}

export interface Subscription {
  id: number;
  user_id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  failure_count: number;
  next_attempt_at: string | null;
}

interface DeviceRow {
  id: number; agent_family: string; created_at: string; last_success_at: string | null; failure_count: number; important_mail: number; briefing_ready: number;
}

const toView = (r: DeviceRow): DeviceView => ({
  id: r.id,
  agent_family: r.agent_family,
  created_at: r.created_at,
  last_success_at: r.last_success_at,
  failing: r.failure_count > 0,
  kinds: { important_mail: r.important_mail === 1, briefing_ready: r.briefing_ready === 1 },
});

const VIEW_COLUMNS = "id, agent_family, created_at, last_success_at, failure_count, important_mail, briefing_ready";

export function listDevices(db: DatabaseSync, userId: number): DeviceView[] {
  const rows = db.prepare(`SELECT ${VIEW_COLUMNS} FROM push_subscriptions WHERE user_id = ? ORDER BY id`).all(userId) as unknown as DeviceRow[];
  return rows.map(toView);
}

export function getDevice(db: DatabaseSync, userId: number, id: number): DeviceView | null {
  const r = db.prepare(`SELECT ${VIEW_COLUMNS} FROM push_subscriptions WHERE user_id = ? AND id = ?`).get(userId, id) as DeviceRow | undefined;
  return r ? toView(r) : null;
}

export interface SubscribeInput {
  endpoint: string;
  p256dh: string;
  auth: string;
  agentFamily: string;
  kinds?: { important_mail?: boolean; briefing_ready?: boolean };
}

export type SubscribeResult = { ok: true; id: number } | { ok: false; code: "invalid_endpoint" | "invalid_keys" | "device_limit" };

/**
 * Registers (or refreshes) a device. The same endpoint again updates keys and resets the failure state; kinds not given
 * keep their value (new devices start with both on). An endpoint that belonged to another user is taken over: the browser
 * profile now signs in as this user, and only someone holding the endpoint and both keys can send this call.
 */
export function subscribeDevice(db: DatabaseSync, userId: number, i: SubscribeInput, now: Date): SubscribeResult {
  if (!isAllowedPushEndpoint(i.endpoint)) return { ok: false, code: "invalid_endpoint" };
  const key = b64urlDecode(i.p256dh);
  const auth = b64urlDecode(i.auth);
  if (key?.length !== 65 || key[0] !== 4 || auth?.length !== 16) return { ok: false, code: "invalid_keys" };
  const ts = now.toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = db.prepare("SELECT id, user_id, important_mail, briefing_ready FROM push_subscriptions WHERE endpoint = ?").get(i.endpoint) as
      | { id: number; user_id: number; important_mail: number; briefing_ready: number }
      | undefined;
    const mine = existing !== undefined && existing.user_id === userId;
    if (existing && !mine) db.prepare("DELETE FROM push_subscriptions WHERE id = ?").run(existing.id);
    if (!existing || !mine) {
      const n = (db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?").get(userId) as { n: number }).n;
      if (n >= PUSH_MAX_DEVICES) {
        db.exec("ROLLBACK");
        return { ok: false, code: "device_limit" };
      }
    }
    const flag = (given: boolean | undefined, prev: number | undefined): number => (given === undefined ? (prev ?? 1) : given ? 1 : 0);
    const important = flag(i.kinds?.important_mail, mine ? existing.important_mail : undefined);
    const briefing = flag(i.kinds?.briefing_ready, mine ? existing.briefing_ready : undefined);
    let id: number;
    if (mine) {
      id = existing.id;
      db.prepare(
        `UPDATE push_subscriptions SET p256dh = ?, auth = ?, agent_family = ?, important_mail = ?, briefing_ready = ?,
           failure_count = 0, next_attempt_at = NULL WHERE id = ?`,
      ).run(i.p256dh, i.auth, i.agentFamily, important, briefing, id);
    } else {
      const r = db.prepare(
        `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, agent_family, important_mail, briefing_ready, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(userId, i.endpoint, i.p256dh, i.auth, i.agentFamily, important, briefing, ts);
      id = Number(r.lastInsertRowid);
    }
    db.exec("COMMIT");
    return { ok: true, id };
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw err;
  }
}

/** Removes a device of this user by endpoint or id. false = not found (a foreign device looks the same). */
export function unsubscribeDevice(db: DatabaseSync, userId: number, by: { endpoint: string } | { id: number }): boolean {
  const r = "endpoint" in by
    ? db.prepare("DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?").run(userId, by.endpoint)
    : db.prepare("DELETE FROM push_subscriptions WHERE user_id = ? AND id = ?").run(userId, by.id);
  return Number(r.changes) > 0;
}

/** Devices of a user that have the kind switched on. `test` goes to every device. */
export function subscriptionsFor(db: DatabaseSync, userId: number, kind: PayloadKind): Subscription[] {
  const filter = kind === "important_mail" ? "AND important_mail = 1" : kind === "briefing_ready" ? "AND briefing_ready = 1" : "";
  return db.prepare(
    `SELECT id, user_id, endpoint, p256dh, auth, failure_count, next_attempt_at FROM push_subscriptions WHERE user_id = ? ${filter} ORDER BY id`,
  ).all(userId) as unknown as Subscription[];
}

export function hasSubscribers(db: DatabaseSync, userId: number, kind: PushKind): boolean {
  return subscriptionsFor(db, userId, kind).length > 0;
}

// ---- sending ------------------------------------------------------------------------------------------------------

export interface TransportRequest {
  url: string;
  headers: Record<string, string>;
  body: Uint8Array;
}
export interface TransportResponse { status: number; retryAfterSeconds?: number }
/** The one place that talks to a push service. Tests inject a fake; there is no real network call in any test. */
export type PushTransport = (req: TransportRequest) => Promise<TransportResponse>;

export const fetchTransport: PushTransport = async (req) => {
  const res = await fetch(req.url, {
    method: "POST",
    headers: req.headers,
    body: req.body as BodyInit,
    redirect: "error",
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  await res.body?.cancel().catch(() => {});
  const ra = Number(res.headers.get("retry-after"));
  return { status: res.status, ...(Number.isFinite(ra) && ra > 0 ? { retryAfterSeconds: ra } : {}) };
};

export type SendOutcome = "sent" | "removed" | "retry_later" | "failed" | "skipped";

export interface SendDeps {
  db: DatabaseSync;
  config: VapidSigner;
  transport: PushTransport;
  now: () => Date;
}

export function backoffMs(failures: number): number {
  return Math.min(PUSH_BACKOFF_MAX_MS, PUSH_BACKOFF_MIN_MS * 2 ** Math.max(0, failures - 1));
}

/**
 * Sends one payload to one device and updates its delivery state. 201/2xx: success. 404/410: the browser dropped the
 * subscription, so the row is deleted. Everything else (429, 5xx, network error, VAPID rejection) counts as a failure:
 * exponential backoff with `next_attempt_at`, honouring Retry-After, and removal after PUSH_MAX_FAILURES in a row.
 * `ignoreBackoff` is for the explicit test push. Never throws and never logs the endpoint.
 */
export async function sendToSubscription(
  deps: SendDeps,
  sub: Subscription,
  payload: PushPayload,
  o: { urgency?: "very-low" | "low" | "normal" | "high"; ttl?: number; ignoreBackoff?: boolean } = {},
): Promise<SendOutcome> {
  const now = deps.now();
  if (!o.ignoreBackoff && sub.next_attempt_at !== null && Date.parse(sub.next_attempt_at) > now.getTime()) return "skipped";
  if (!isAllowedPushEndpoint(sub.endpoint)) {
    deps.db.prepare("DELETE FROM push_subscriptions WHERE id = ?").run(sub.id);
    return "removed";
  }
  let status = 0;
  let retryAfter: number | undefined;
  try {
    const body = encryptPayload(Buffer.from(JSON.stringify(payload)), sub.p256dh, sub.auth);
    const res = await deps.transport({
      url: sub.endpoint,
      headers: {
        authorization: vapidAuthorization(sub.endpoint, deps.config, now.getTime()),
        "content-encoding": "aes128gcm",
        "content-type": "application/octet-stream",
        ttl: String(o.ttl ?? PUSH_TTL_SECONDS),
        urgency: o.urgency ?? "normal",
        // Topic lets the push service replace a still-undelivered message of the same kind instead of stacking them.
        topic: payload.kind.replace(/_/g, ""),
      },
      body,
    });
    status = res.status;
    retryAfter = res.retryAfterSeconds;
  } catch {
    status = 0;
  }
  if (status >= 200 && status < 300) {
    deps.db.prepare("UPDATE push_subscriptions SET last_success_at = ?, failure_count = 0, next_attempt_at = NULL WHERE id = ?").run(now.toISOString(), sub.id);
    return "sent";
  }
  if (status === 404 || status === 410) {
    deps.db.prepare("DELETE FROM push_subscriptions WHERE id = ?").run(sub.id);
    return "removed";
  }
  const failures = sub.failure_count + 1;
  if (failures >= PUSH_MAX_FAILURES) {
    deps.db.prepare("DELETE FROM push_subscriptions WHERE id = ?").run(sub.id);
    return "removed";
  }
  const wait = Math.min(PUSH_BACKOFF_MAX_MS, Math.max(backoffMs(failures), (retryAfter ?? 0) * 1000));
  deps.db.prepare("UPDATE push_subscriptions SET failure_count = ?, next_attempt_at = ? WHERE id = ?")
    .run(failures, new Date(now.getTime() + wait).toISOString(), sub.id);
  return status === 429 || status >= 500 || status === 0 ? "retry_later" : "failed";
}

export interface SendSummary { sent: number; removed: number; retry_later: number; failed: number; skipped: number }

/** Sends to every device of the user that has the kind on. */
export async function sendToUser(
  deps: SendDeps,
  userId: number,
  payload: PushPayload,
  o: { urgency?: "very-low" | "low" | "normal" | "high"; ttl?: number; ignoreBackoff?: boolean } = {},
): Promise<SendSummary> {
  const out: SendSummary = { sent: 0, removed: 0, retry_later: 0, failed: 0, skipped: 0 };
  for (const sub of subscriptionsFor(deps.db, userId, payload.kind)) {
    const r = await sendToSubscription(deps, sub, payload, o);
    if (r === "sent") out.sent++;
    else if (r === "removed") out.removed++;
    else if (r === "retry_later") out.retry_later++;
    else if (r === "failed") out.failed++;
    else out.skipped++;
  }
  return out;
}
