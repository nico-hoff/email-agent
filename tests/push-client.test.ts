import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  disablePush, enablePush, fetchPushConfig, fetchPushDevices, isSubscribed, pushSupport, sendTestPush, syncPushSubscription, updatePushKinds, urlBase64ToBytes,
  type PushEnv, type PushSubscriptionLike,
} from "../lib/push-client.ts";
import type { MutationDeps } from "../lib/mutate-client.ts";

const PUB = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
const DEVICE = { id: 4, agent_family: "iOS Safari", created_at: "2026-10-31T10:00:00.000Z", last_success_at: null, failing: false, kinds: { important_mail: true, briefing_ready: true } };

interface Log { prompts: number; subscribed: unknown[]; unsubscribed: number; order: string[] }
function env(o: { ios?: boolean; standalone?: boolean; apis?: boolean; permission?: "default" | "granted" | "denied"; answer?: "default" | "granted" | "denied"; existing?: boolean } = {}) {
  const log: Log = { prompts: 0, subscribed: [], unsubscribed: 0, order: [] };
  let perm = o.permission ?? "default";
  let sub: PushSubscriptionLike | null = o.existing ? makeSub(log) : null;
  const e: PushEnv = {
    hasPushApis: () => o.apis ?? true,
    permission: () => perm,
    requestPermission: async () => { log.prompts++; log.order.push("prompt"); perm = o.answer ?? "granted"; return perm; },
    standalone: () => o.standalone ?? true,
    ios: () => o.ios ?? false,
    registration: async () => ({
      pushManager: {
        getSubscription: async () => sub,
        subscribe: async (opts) => { log.subscribed.push(opts); log.order.push("subscribe"); sub = makeSub(log); return sub; },
      },
    }),
  };
  return { e, log };
}
function makeSub(log: Log): PushSubscriptionLike {
  return {
    endpoint: "https://web.push.apple.com/synthetic-endpoint-1",
    toJSON: () => ({ endpoint: "https://web.push.apple.com/synthetic-endpoint-1", expirationTime: null, keys: { p256dh: "P".repeat(87), auth: "A".repeat(22) } }),
    unsubscribe: async () => { log.unsubscribed++; return true; },
  };
}
interface Call { url: string; method: string; body: unknown }
function deps(handler: (path: string, body: unknown) => Response | undefined = () => undefined) {
  const calls: Call[] = [];
  const d: MutationDeps = {
    fetch: async (url, init) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ url, method: init?.method ?? "GET", body });
      if (url === "/api/auth/session") return Response.json({ csrfToken: "tok" });
      if (url === "/api/push/config") return Response.json({ available: true, public_key: PUB });
      return handler(url, body) ?? Response.json({ ok: true, device: DEVICE }, { status: 201 });
    },
    headers: () => new Headers({ "x-csrf": "1" }),
  };
  return { d, calls };
}

describe("support", () => {
  test("iOS needs the installed PWA; missing APIs are unsupported", () => {
    assert.equal(pushSupport(env({ ios: true, standalone: false }).e), "needs_install");
    assert.equal(pushSupport(env({ ios: true, standalone: true }).e), "supported");
    assert.equal(pushSupport(env({ apis: false }).e), "unsupported");
    assert.equal(pushSupport(env().e), "supported");
  });
  test("urlBase64ToBytes decodes the 65 byte VAPID key", () => {
    const b = urlBase64ToBytes(PUB);
    assert.equal(b.length, 65);
    assert.equal(b[0], 4);
  });
});

describe("enablePush", () => {
  test("asks for permission first, then subscribes with the server key and registers the device", async () => {
    const { e, log } = env();
    const { d, calls } = deps();
    const r = await enablePush(e, d);
    assert.deepEqual(r.ok && r.device, DEVICE);
    assert.deepEqual(log.order, ["prompt", "subscribe"]);
    const subscribe = log.subscribed[0] as { userVisibleOnly: boolean; applicationServerKey: Uint8Array };
    assert.equal(subscribe.userVisibleOnly, true);
    assert.equal(subscribe.applicationServerKey.length, 65);
    const post = calls.find((c) => c.url === "/api/push/subscribe");
    assert.equal(post?.method, "POST");
    assert.deepEqual(Object.keys(post?.body as object).sort(), ["endpoint", "expirationTime", "keys"]);
  });
  test("the permission prompt happens before any network call (user gesture)", async () => {
    const order: string[] = [];
    const { e } = env();
    const wrapped: PushEnv = { ...e, requestPermission: async () => { order.push("prompt"); return "granted"; } };
    const { d } = deps();
    await enablePush(wrapped, { ...d, fetch: async (u, i) => { order.push(u); return d.fetch(u, i); } });
    assert.equal(order[0], "prompt");
  });
  test("no prompt when iOS is not installed or unsupported; denied and dismissed are reported", async () => {
    const a = env({ ios: true, standalone: false });
    assert.deepEqual(await enablePush(a.e, deps().d), { ok: false, reason: "needs_install" });
    assert.equal(a.log.prompts, 0);
    assert.deepEqual(await enablePush(env({ apis: false }).e, deps().d), { ok: false, reason: "unsupported" });
    assert.deepEqual(await enablePush(env({ permission: "denied" }).e, deps().d), { ok: false, reason: "permission_denied" });
    assert.deepEqual(await enablePush(env({ answer: "denied" }).e, deps().d), { ok: false, reason: "permission_denied" });
    assert.deepEqual(await enablePush(env({ answer: "default" }).e, deps().d), { ok: false, reason: "permission_dismissed" });
  });
  test("a server without VAPID: nothing is subscribed", async () => {
    const { e, log } = env();
    const d = deps();
    const off: MutationDeps = { ...d.d, fetch: async (u, i) => (u === "/api/push/config" ? Response.json({ available: false, reason: "vapid_not_configured" }) : d.d.fetch(u, i)) };
    assert.deepEqual(await enablePush(e, off), { ok: false, reason: "push_unavailable" });
    assert.equal(log.subscribed.length, 0);
  });
  test("when the server refuses, the new browser subscription is dropped again; device limit and rate limit are mapped", async () => {
    const a = env();
    assert.deepEqual(await enablePush(a.e, deps((p) => (p === "/api/push/subscribe" ? new Response("{}", { status: 409 }) : undefined)).d), { ok: false, reason: "device_limit" });
    assert.equal(a.log.unsubscribed, 1);
    const b = env();
    const r = await enablePush(b.e, deps((p) => (p === "/api/push/subscribe" ? new Response("{}", { status: 429, headers: { "retry-after": "12" } }) : undefined)).d);
    assert.deepEqual(r, { ok: false, reason: "rate_limited", retryAfterSeconds: 12 });
    const c = env({ existing: true });
    await enablePush(c.e, deps(() => new Response("{}", { status: 500 })).d);
    assert.equal(c.log.unsubscribed, 0, "a subscription that existed before stays");
  });
  test("an existing browser subscription is reused", async () => {
    const { e, log } = env({ existing: true, permission: "granted" });
    const r = await enablePush(e, deps().d);
    assert.equal(r.ok, true);
    assert.equal(log.subscribed.length, 0);
    assert.equal(log.prompts, 0);
  });
  test("kinds are sent along", async () => {
    const { e } = env({ permission: "granted" });
    const { d, calls } = deps();
    await enablePush(e, d, { important_mail: false });
    assert.deepEqual((calls.find((c) => c.url === "/api/push/subscribe")?.body as { kinds: unknown }).kinds, { important_mail: false });
  });
});

describe("other helpers", () => {
  test("disablePush: server first, then the browser; a 404 is fine; no subscription is fine", async () => {
    const a = env({ existing: true, permission: "granted" });
    const { d, calls } = deps(() => Response.json({ ok: true }));
    assert.deepEqual(await disablePush(a.e, d), { ok: true });
    assert.deepEqual(calls.find((c) => c.url === "/api/push/unsubscribe")?.body, { endpoint: "https://web.push.apple.com/synthetic-endpoint-1" });
    assert.equal(a.log.unsubscribed, 1);
    const b = env({ existing: true });
    assert.deepEqual(await disablePush(b.e, deps(() => new Response("{}", { status: 404 })).d), { ok: true });
    const c = env({ existing: true });
    assert.equal((await disablePush(c.e, deps(() => new Response("{}", { status: 500 })).d)).ok, false);
    assert.equal(c.log.unsubscribed, 0, "the browser keeps it if the server could not be told");
    assert.deepEqual(await disablePush(env().e, deps().d), { ok: true });
  });
  test("updatePushKinds and syncPushSubscription never prompt", async () => {
    const a = env({ existing: true, permission: "granted" });
    const { d, calls } = deps();
    assert.equal((await updatePushKinds(a.e, d, { briefing_ready: false })).ok, true);
    assert.deepEqual((calls.at(-1)?.body as { kinds: unknown }).kinds, { briefing_ready: false });
    assert.deepEqual(await syncPushSubscription(a.e, d), { ok: true, synced: true });
    assert.deepEqual(await updatePushKinds(env().e, d, {}), { ok: false, reason: "not_found" });
    assert.deepEqual(await syncPushSubscription(env({ permission: "default", existing: true }).e, d), { ok: true, synced: false });
    assert.deepEqual(await syncPushSubscription(env({ permission: "granted" }).e, d), { ok: true, synced: false });
    assert.equal(a.log.prompts, 0);
  });
  test("isSubscribed, fetchPushConfig, fetchPushDevices, sendTestPush", async () => {
    assert.equal(await isSubscribed(env({ existing: true }).e), true);
    assert.equal(await isSubscribed(env().e), false);
    const f = async (u: string | URL | Request) => (String(u).endsWith("config") ? Response.json({ available: true, public_key: PUB }) : Response.json({ devices: [DEVICE, { id: "x" }] }));
    assert.deepEqual(await fetchPushConfig(f as typeof fetch), { available: true, publicKey: PUB, reason: null });
    assert.deepEqual(await fetchPushDevices(f as typeof fetch), [DEVICE]);
    const off = async () => Response.json({ available: false, reason: "vapid_not_configured" });
    assert.deepEqual(await fetchPushConfig(off as typeof fetch), { available: false, publicKey: null, reason: "vapid_not_configured" });
    const ok = await sendTestPush(deps((p) => (p === "/api/push/test" ? Response.json({ ok: true, sent: 2, removed: 0, failed: 0 }) : undefined)).d);
    assert.deepEqual(ok, { ok: true, delivered: true, sent: 2, removed: 0, failed: 0 });
    assert.deepEqual(await sendTestPush(deps(() => new Response("{}", { status: 409 })).d), { ok: false, reason: "not_found" });
    assert.deepEqual(await sendTestPush(deps(() => new Response("{}", { status: 503 })).d), { ok: false, reason: "push_unavailable" });
  });
});
