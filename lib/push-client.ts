// Browser side of Web Push (R6, ADR 0036), ready for the toggle UI of a later step. Pure functions over an injectable
// browser surface (PushEnv) so they run in unit tests without a browser. The permission prompt is requested ONLY inside
// enablePush, which the UI must call directly from a tap (user gesture): it is the first thing that function does, before
// any await on the network, because iOS Safari ignores prompts that do not stem from a gesture.
// Types are repeated on purpose: server modules use node:sqlite and must not be bundled into the browser.
import { commonReason, postApi, readJson, type CommonReason } from "./api-post.ts";
import type { MutationDeps } from "./mutate-client.ts";

export type PushKindName = "important_mail" | "briefing_ready";
export interface PushKinds { important_mail: boolean; briefing_ready: boolean }

export interface PushDevice {
  id: number;
  agent_family: string;
  created_at: string;
  last_success_at: string | null;
  failing: boolean;
  kinds: PushKinds;
}

/** The part of PushSubscription the helper reads. */
export interface PushSubscriptionLike {
  endpoint: string;
  toJSON(): { endpoint?: string; expirationTime?: number | null; keys?: { p256dh?: string; auth?: string } };
  unsubscribe(): Promise<boolean>;
}
export interface PushRegistrationLike {
  pushManager: {
    getSubscription(): Promise<PushSubscriptionLike | null>;
    subscribe(o: { userVisibleOnly: true; applicationServerKey: Uint8Array }): Promise<PushSubscriptionLike>;
  };
}

/** The browser surface. `createBrowserPushEnv()` builds the real one. */
export interface PushEnv {
  hasPushApis(): boolean;
  permission(): "default" | "granted" | "denied";
  requestPermission(): Promise<"default" | "granted" | "denied">;
  registration(): Promise<PushRegistrationLike>;
  /** Installed to the home screen (display-mode: standalone / navigator.standalone). */
  standalone(): boolean;
  ios(): boolean;
}

export type PushSupport = "supported" | "unsupported" | "needs_install";

/** iOS delivers Web Push only to a PWA that was added to the home screen (iOS 16.4+). */
export function pushSupport(env: PushEnv): PushSupport {
  if (env.ios() && !env.standalone()) return "needs_install";
  return env.hasPushApis() ? "supported" : "unsupported";
}

export type PushReason = CommonReason | "unsupported" | "needs_install" | "permission_denied" | "permission_dismissed" | "push_unavailable" | "device_limit" | "invalid";

export const PUSH_ERROR_TEXT: Record<PushReason, string> = {
  rate_limited: "Zu viele Aktionen. Bitte kurz warten.",
  forbidden: "Nicht angemeldet. Bitte die App neu öffnen.",
  not_found: "Das gibt es nicht mehr.",
  failed: "Das hat nicht geklappt. Bitte später erneut versuchen.",
  unsupported: "Dieser Browser unterstützt keine Benachrichtigungen.",
  needs_install: "Auf dem iPhone zuerst die App zum Home-Bildschirm hinzufügen und von dort öffnen.",
  permission_denied: "Benachrichtigungen sind blockiert. Bitte in den Einstellungen des Geräts erlauben.",
  permission_dismissed: "Die Abfrage wurde nicht bestätigt. Bitte erneut versuchen.",
  push_unavailable: "Benachrichtigungen sind auf diesem Server nicht eingerichtet.",
  device_limit: "Zu viele Geräte angemeldet. Bitte ein altes Gerät entfernen.",
  invalid: "Das Gerät konnte nicht angemeldet werden.",
};

export type PushResult<T = object> = ({ ok: true } & T) | { ok: false; reason: PushReason; retryAfterSeconds?: number };

/** VAPID public key (base64url) to the Uint8Array that PushManager.subscribe expects. */
export function urlBase64ToBytes(value: string): Uint8Array {
  const pad = "=".repeat((4 - (value.length % 4)) % 4);
  const bin = atob((value + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface PushConfigInfo { available: boolean; publicKey: string | null; reason: string | null; maxDevices: number | null }

export async function fetchPushConfig(fetcher: typeof fetch): Promise<PushConfigInfo> {
  const r = await fetcher("/api/push/config", { cache: "no-store" });
  if (r.status === 401 || r.status === 403) throw new Error("session");
  if (!r.ok) throw new Error("unavailable");
  const b = await readJson(r);
  const key = typeof b.public_key === "string" ? b.public_key : null;
  return { available: b.available === true && key !== null, publicKey: key, reason: typeof b.reason === "string" ? b.reason : null, maxDevices: typeof b.max_devices === "number" ? b.max_devices : null };
}

function parseKinds(v: unknown): PushKinds {
  const m = typeof v === "object" && v !== null ? new Map(Object.entries(v)) : new Map<string, unknown>();
  return { important_mail: m.get("important_mail") === true, briefing_ready: m.get("briefing_ready") === true };
}

function parseDevice(v: unknown): PushDevice | null {
  if (typeof v !== "object" || v === null) return null;
  const m = new Map(Object.entries(v));
  const id = m.get("id");
  const family = m.get("agent_family");
  const created = m.get("created_at");
  if (typeof id !== "number" || typeof family !== "string" || typeof created !== "string") return null;
  const last = m.get("last_success_at");
  return { id, agent_family: family, created_at: created, last_success_at: typeof last === "string" ? last : null, failing: m.get("failing") === true, kinds: parseKinds(m.get("kinds")) };
}

export async function fetchPushDevices(fetcher: typeof fetch): Promise<PushDevice[]> {
  const r = await fetcher("/api/push/subscriptions", { cache: "no-store" });
  if (r.status === 401 || r.status === 403) throw new Error("session");
  if (!r.ok) throw new Error("unavailable");
  const b = await readJson(r);
  const out: PushDevice[] = [];
  for (const d of Array.isArray(b.devices) ? b.devices : []) {
    const p = parseDevice(d);
    if (p) out.push(p);
  }
  return out;
}

async function postSubscription(sub: PushSubscriptionLike, kinds: Partial<PushKinds> | undefined, deps: MutationDeps): Promise<PushResult<{ device: PushDevice }>> {
  const j = sub.toJSON();
  if (!j.endpoint || !j.keys?.p256dh || !j.keys.auth) return { ok: false, reason: "invalid" };
  const raw = await postApi("/api/push/subscribe", deps, {
    body: { endpoint: j.endpoint, expirationTime: j.expirationTime ?? null, keys: { p256dh: j.keys.p256dh, auth: j.keys.auth }, ...(kinds ? { kinds } : {}) },
  });
  if (raw.kind === "forbidden") return { ok: false, reason: "forbidden" };
  if (raw.kind === "failed") return { ok: false, reason: "failed" };
  const r = raw.response;
  const common = commonReason(r);
  if (common) return { ok: false, reason: common.reason, ...(common.retryAfterSeconds !== undefined ? { retryAfterSeconds: common.retryAfterSeconds } : {}) };
  if (r.status === 503) return { ok: false, reason: "push_unavailable" };
  if (r.status === 409) return { ok: false, reason: "device_limit" };
  if (r.status === 400) return { ok: false, reason: "invalid" };
  if (!r.ok) return { ok: false, reason: "failed" };
  const device = parseDevice((await readJson(r)).device);
  return device ? { ok: true, device } : { ok: false, reason: "failed" };
}

/**
 * Switches push on for this device. CALL IT FROM A TAP HANDLER: the permission prompt is the first action. Then the
 * browser subscription is created with the server's public key and registered with the server. If the server refuses,
 * the browser subscription is dropped again, so no orphan stays behind.
 */
export async function enablePush(env: PushEnv, deps: MutationDeps, kinds?: Partial<PushKinds>): Promise<PushResult<{ device: PushDevice }>> {
  const support = pushSupport(env);
  if (support !== "supported") return { ok: false, reason: support };
  let permission = env.permission();
  if (permission === "default") permission = await env.requestPermission(); // first await: still inside the user gesture
  if (permission === "denied") return { ok: false, reason: "permission_denied" };
  if (permission !== "granted") return { ok: false, reason: "permission_dismissed" };
  try {
    const config = await fetchPushConfig(deps.fetch as typeof fetch);
    if (!config.available || config.publicKey === null) return { ok: false, reason: "push_unavailable" };
    const reg = await env.registration();
    const existing = await reg.pushManager.getSubscription();
    const sub = existing ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToBytes(config.publicKey) }));
    const res = await postSubscription(sub, kinds, deps);
    if (!res.ok && existing === null) await sub.unsubscribe().catch(() => false);
    return res;
  } catch (err) {
    return { ok: false, reason: err instanceof Error && err.message === "session" ? "forbidden" : "failed" };
  }
}

/** Updates the kinds of this device (no prompt). false when this browser has no subscription. */
export async function updatePushKinds(env: PushEnv, deps: MutationDeps, kinds: Partial<PushKinds>): Promise<PushResult<{ device: PushDevice }>> {
  try {
    const sub = await (await env.registration()).pushManager.getSubscription();
    if (!sub) return { ok: false, reason: "not_found" };
    return await postSubscription(sub, kinds, deps);
  } catch {
    return { ok: false, reason: "failed" };
  }
}

/** Refreshes the server's copy after the browser rotated keys; silent, no prompt, only when permission is already granted. */
export async function syncPushSubscription(env: PushEnv, deps: MutationDeps): Promise<PushResult<{ synced: boolean }>> {
  if (pushSupport(env) !== "supported" || env.permission() !== "granted") return { ok: true, synced: false };
  try {
    const sub = await (await env.registration()).pushManager.getSubscription();
    if (!sub) return { ok: true, synced: false };
    const r = await postSubscription(sub, undefined, deps);
    return r.ok ? { ok: true, synced: true } : r;
  } catch {
    return { ok: false, reason: "failed" };
  }
}

/** Switches push off for this device: server first (a 404 is fine), then the browser subscription. */
export async function disablePush(env: PushEnv, deps: MutationDeps): Promise<PushResult> {
  try {
    const sub = await (await env.registration()).pushManager.getSubscription();
    if (!sub) return { ok: true };
    const raw = await postApi("/api/push/unsubscribe", deps, { body: { endpoint: sub.endpoint } });
    if (raw.kind === "forbidden") return { ok: false, reason: "forbidden" };
    if (raw.kind === "failed") return { ok: false, reason: "failed" };
    const common = commonReason(raw.response);
    if (common && common.reason !== "not_found") return { ok: false, reason: common.reason, ...(common.retryAfterSeconds !== undefined ? { retryAfterSeconds: common.retryAfterSeconds } : {}) };
    if (!common && !raw.response.ok) return { ok: false, reason: "failed" };
    await sub.unsubscribe().catch(() => false);
    return { ok: true };
  } catch {
    return { ok: false, reason: "failed" };
  }
}

/** Is this browser currently subscribed? */
export async function isSubscribed(env: PushEnv): Promise<boolean> {
  try {
    return (await (await env.registration()).pushManager.getSubscription()) !== null;
  } catch {
    return false;
  }
}

export interface TestPushOutcome { sent: number; removed: number; failed: number }

/** Asks the server to send a test notification to the user's own devices. */
export async function sendTestPush(deps: MutationDeps): Promise<PushResult<TestPushOutcome & { delivered: boolean }>> {
  const raw = await postApi("/api/push/test", deps);
  if (raw.kind === "forbidden") return { ok: false, reason: "forbidden" };
  if (raw.kind === "failed") return { ok: false, reason: "failed" };
  const r = raw.response;
  const common = commonReason(r);
  if (common) return { ok: false, reason: common.reason, ...(common.retryAfterSeconds !== undefined ? { retryAfterSeconds: common.retryAfterSeconds } : {}) };
  if (r.status === 503) return { ok: false, reason: "push_unavailable" };
  if (r.status === 409) return { ok: false, reason: "not_found" };
  if (!r.ok) return { ok: false, reason: "failed" };
  const b = await readJson(r);
  const n = (v: unknown) => (typeof v === "number" ? v : 0);
  return { ok: true, delivered: b.ok === true, sent: n(b.sent), removed: n(b.removed), failed: n(b.failed) };
}

/** The real browser surface. Only call it in the browser (client component effect or event handler). */
export function createBrowserPushEnv(): PushEnv {
  const nav = navigator as Navigator & { standalone?: boolean };
  return {
    hasPushApis: () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window,
    permission: () => ("Notification" in window ? Notification.permission : "denied"),
    requestPermission: () => Notification.requestPermission(),
    registration: async () => (await navigator.serviceWorker.ready) as unknown as PushRegistrationLike,
    standalone: () => nav.standalone === true || window.matchMedia("(display-mode: standalone)").matches,
    ios: () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1),
  };
}

/** Removes one of the user's own devices by id (any device, not only this browser). */
export async function removePushDevice(id: number, deps: MutationDeps): Promise<PushResult> {
  const raw = await postApi("/api/push/unsubscribe", deps, { body: { id } });
  if (raw.kind === "forbidden") return { ok: false, reason: "forbidden" };
  if (raw.kind === "failed") return { ok: false, reason: "failed" };
  const common = commonReason(raw.response);
  if (common) return { ok: false, reason: common.reason, ...(common.retryAfterSeconds !== undefined ? { retryAfterSeconds: common.retryAfterSeconds } : {}) };
  return raw.response.ok ? { ok: true } : { ok: false, reason: "failed" };
}

/**
 * Registers this browser's existing subscription with the server again (an upsert, kinds untouched) and returns the
 * server's row, so the page knows which entry of the device list is this device. Silent, no prompt; null when this
 * browser is not subscribed or permission is not granted.
 */
export async function currentPushDevice(env: PushEnv, deps: MutationDeps): Promise<PushResult<{ device: PushDevice | null }>> {
  if (pushSupport(env) !== "supported" || env.permission() !== "granted") return { ok: true, device: null };
  try {
    const sub = await (await env.registration()).pushManager.getSubscription();
    if (!sub) return { ok: true, device: null };
    return await postSubscription(sub, undefined, deps);
  } catch {
    return { ok: false, reason: "failed" };
  }
}
