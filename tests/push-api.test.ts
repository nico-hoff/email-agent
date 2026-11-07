// R6 API handlers (tailnet identity = owner user 1). Synthetic data, a fake transport, no network.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createAuthContext, createLoginLimiter, createMutationLimiter, handleLogin, handleSession } from "../packages/core/src/auth-runtime.ts";
import { CSRF_HEADER } from "../packages/core/src/csrf.ts";
import { openDatabase } from "../packages/core/src/db.ts";
import {
  handlePushConfig, handlePushList, handlePushSubscribe, handlePushTest, handlePushUnsubscribe, type PushApiDeps,
} from "../packages/core/src/push-api.ts";
import { PUSH_MAX_DEVICES, subscribeDevice } from "../packages/core/src/push.ts";
import { fakeDevice, fakeTransport, vapidEnv } from "./push-helpers.ts";

const ME = "nico@example.test";
const HOST = "mac.tail.ts.net";
const ORIGIN = `https://${HOST}`;
const NOW = new Date("2026-10-31T10:00:00.000Z");

async function setup(o: { env?: Record<string, string> | null; testLimit?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "push-api-"));
  chmodSync(dir, 0o700);
  mkdirSync(join(dir, "data"), { mode: 0o700 });
  writeFileSync(join(dir, "data", "auth-allowlist.json"), JSON.stringify({ logins: [ME] }));
  const auth = createAuthContext({ dataDir: join(dir, "data"), synthetic: false });
  const db = openDatabase(":memory:");
  db.exec(`INSERT INTO users (id,email,password_hash,role,status,created_at,updated_at) VALUES (2,'b@x.test','${"h".repeat(40)}','user','active','${NOW.toISOString()}','${NOW.toISOString()}')`);
  const unclosable = { prepare: db.prepare.bind(db), exec: db.exec.bind(db), close() {} } as unknown as DatabaseSync;
  const transport = fakeTransport();
  const deps: PushApiDeps = {
    auth, limiter: createMutationLimiter(), testLimiter: createMutationLimiter(undefined, o.testLimit ?? 5), openDb: () => unclosable,
    env: o.env === null ? {} : (o.env ?? vapidEnv()), transport: transport.transport, now: () => NOW,
  };
  const headers = { host: HOST, "tailscale-user-login": ME };
  const info = (await (await handleSession(new Request("http://127.0.0.1:3000/api/auth/session", { headers }), auth)).json()) as { csrfToken: string };
  const res = handleLogin(new Request("http://127.0.0.1:3000/api/auth/login", { method: "POST", headers: { ...headers, origin: ORIGIN, "sec-fetch-site": "same-origin", [CSRF_HEADER]: info.csrfToken } }), auth, createLoginLimiter());
  assert.equal(res.status, 200);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { db, deps, cookie, csrf: info.csrfToken, transport };
}
type S = Awaited<ReturnType<typeof setup>>;
const get = (s: S, path: string) => new Request(`http://127.0.0.1:3000${path}`, { headers: { host: HOST, cookie: s.cookie } });
const post = (s: S, path: string, body?: unknown, csrf = true) => new Request(`http://127.0.0.1:3000${path}`, {
  method: "POST", body: body === undefined ? undefined : JSON.stringify(body),
  headers: { host: HOST, cookie: s.cookie, origin: ORIGIN, "sec-fetch-site": "same-origin", ...(csrf ? { [CSRF_HEADER]: s.csrf } : {}), "content-type": "application/json", "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1" },
});
const body = (d = fakeDevice()) => ({ endpoint: d.endpoint, expirationTime: null, keys: { p256dh: d.p256dh, auth: d.auth } });

describe("push API", () => {
  it("every route needs a session", async () => {
    const s = await setup();
    const anon = (m: string) => new Request("http://127.0.0.1:3000/api/push/x", { method: m, headers: { host: HOST }, body: m === "POST" ? "{}" : undefined });
    // GET routes rely on the central interceptor for the session in the transitional modes (requireUser, as for /api/emails).
    assert.equal((await handlePushSubscribe(anon("POST"), s.deps)).status, 401);
    assert.equal((await handlePushUnsubscribe(anon("POST"), s.deps)).status, 401);
    assert.equal((await handlePushTest(anon("POST"), s.deps)).status, 401);
  });

  it("writing routes demand the CSRF proof", async () => {
    const s = await setup();
    assert.equal((await handlePushSubscribe(post(s, "/api/push/subscribe", body(), false), s.deps)).status, 403);
    assert.equal((await handlePushUnsubscribe(post(s, "/api/push/unsubscribe", { id: 1 }, false), s.deps)).status, 403);
    assert.equal((await handlePushTest(post(s, "/api/push/test", undefined, false), s.deps)).status, 403);
  });

  it("config: available with the public key only; unavailable (fail-closed) without a VAPID pair, writes answer 503", async () => {
    const s = await setup();
    const c = (await handlePushConfig(get(s, "/api/push/config"), s.deps).json()) as Record<string, unknown>;
    assert.equal(c.available, true);
    assert.equal(c.public_key, s.deps.env.VAPID_PUBLIC_KEY);
    assert.ok(!JSON.stringify(c).includes(s.deps.env.VAPID_PRIVATE_KEY ?? "x"));
    const off = await setup({ env: null });
    assert.deepEqual(await handlePushConfig(get(off, "/api/push/config"), off.deps).json(), { available: false, reason: "vapid_not_configured", max_devices: PUSH_MAX_DEVICES });
    const r = await handlePushSubscribe(post(off, "/api/push/subscribe", body()), off.deps);
    assert.equal(r.status, 503);
    assert.deepEqual(await r.json(), { error: "push_unavailable" });
    assert.equal((await handlePushTest(post(off, "/api/push/test"), off.deps)).status, 503);
    assert.equal(off.transport.calls.length, 0);
  });

  it("subscribe stores the device with a coarse family; the list never shows endpoint or keys", async () => {
    const s = await setup();
    const d = fakeDevice();
    const r = await handlePushSubscribe(post(s, "/api/push/subscribe", { ...body(d), kinds: { briefing_ready: false } }), s.deps);
    assert.equal(r.status, 201);
    const created = (await r.json()) as { device: { id: number; agent_family: string; kinds: Record<string, boolean> } };
    assert.equal(created.device.agent_family, "iOS Safari");
    assert.deepEqual(created.device.kinds, { important_mail: true, briefing_ready: false });
    const text = await (await handlePushList(get(s, "/api/push/subscriptions"), s.deps)).text();
    for (const secret of [d.endpoint, d.p256dh, d.auth, "push.apple.com", "Mozilla"]) assert.ok(!text.includes(secret), secret);
    assert.equal(((JSON.parse(text) as { devices: unknown[] }).devices).length, 1);
    const row = s.db.prepare("SELECT agent_family FROM push_subscriptions").get() as { agent_family: string };
    assert.equal(row.agent_family, "iOS Safari");
  });

  it("subscribe validates: foreign hosts, bad keys, unknown fields, device limit", async () => {
    const s = await setup();
    const d = fakeDevice();
    const bad = async (b: unknown, status: number, error: string) => {
      const r = await handlePushSubscribe(post(s, "/api/push/subscribe", b), s.deps);
      assert.equal(r.status, status);
      assert.equal(((await r.json()) as { error: string }).error, error);
    };
    await bad({ ...body(d), endpoint: "https://evil.example.test/aaaaaaaaaaaaaaaaaaaaaa" }, 400, "invalid_endpoint");
    await bad({ ...body(d), keys: { p256dh: "AAAA", auth: d.auth } }, 400, "invalid_keys");
    await bad({ ...body(d), keys: { p256dh: d.p256dh, auth: d.auth, extra: 1 } }, 400, "invalid_body");
    await bad({ endpoint: d.endpoint }, 400, "invalid_body");
    await bad({ ...body(d), kinds: { sender_names: true } }, 400, "invalid_body");
    for (let i = 0; i < PUSH_MAX_DEVICES; i++) assert.equal((await handlePushSubscribe(post(s, "/api/push/subscribe", body()), s.deps)).status, 201);
    await bad(body(), 409, "device_limit");
  });

  it("tenant isolation: another user's devices are invisible and cannot be removed (404)", async () => {
    const s = await setup();
    const other = fakeDevice();
    const r = subscribeDevice(s.db, 2, { endpoint: other.endpoint, p256dh: other.p256dh, auth: other.auth, agentFamily: "Desktop Chrome" }, NOW);
    assert.ok(r.ok);
    const mine = (await (await handlePushList(get(s, "/api/push/subscriptions"), s.deps)).json()) as { devices: unknown[] };
    assert.equal(mine.devices.length, 0);
    for (const b of [{ id: r.ok ? r.id : 0 }, { endpoint: other.endpoint }, { id: 9999 }]) {
      assert.equal((await handlePushUnsubscribe(post(s, "/api/push/unsubscribe", b), s.deps)).status, 404);
    }
    assert.equal((s.db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").get() as { n: number }).n, 1);
    // the test push only reaches the caller's own devices: none, so nothing is sent
    assert.equal((await handlePushTest(post(s, "/api/push/test"), s.deps)).status, 409);
    assert.equal(s.transport.calls.length, 0);
  });

  it("unsubscribe removes an own device by id or endpoint; a repeat is 404", async () => {
    const s = await setup();
    const d = fakeDevice();
    const created = (await (await handlePushSubscribe(post(s, "/api/push/subscribe", body(d)), s.deps)).json()) as { device: { id: number } };
    assert.equal((await handlePushUnsubscribe(post(s, "/api/push/unsubscribe", { endpoint: d.endpoint }), s.deps)).status, 200);
    assert.equal((await handlePushUnsubscribe(post(s, "/api/push/unsubscribe", { id: created.device.id }), s.deps)).status, 404);
    assert.equal((await handlePushUnsubscribe(post(s, "/api/push/unsubscribe", { id: 1, endpoint: d.endpoint }), s.deps)).status, 400);
  });

  it("test push: encrypted test payload to the caller's devices, rate limited, no content", async () => {
    const s = await setup({ testLimit: 2 });
    const d = fakeDevice();
    await handlePushSubscribe(post(s, "/api/push/subscribe", body(d)), s.deps);
    const r = await handlePushTest(post(s, "/api/push/test"), s.deps);
    assert.deepEqual(await r.json(), { ok: true, sent: 1, removed: 0, failed: 0 });
    assert.deepEqual(JSON.parse(d.decrypt(s.transport.calls[0]!.body)), { v: 1, kind: "test", count: 1 });
    assert.equal(s.transport.calls[0]!.headers.ttl, "300");
    await handlePushTest(post(s, "/api/push/test"), s.deps);
    const limited = await handlePushTest(post(s, "/api/push/test"), s.deps);
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("retry-after")) > 0);
  });

  it("test push reports a gone device and removes it", async () => {
    const s = await setup();
    await handlePushSubscribe(post(s, "/api/push/subscribe", body()), s.deps);
    s.transport.respond = () => ({ status: 410 });
    assert.deepEqual(await (await handlePushTest(post(s, "/api/push/test"), s.deps)).json(), { ok: false, sent: 0, removed: 1, failed: 0 });
    assert.equal((s.db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").get() as { n: number }).n, 0);
  });
});
