// Web Push (R6): configuration, payload, store, sender, triggers. Synthetic data, a fake transport, no network.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../lib/db.ts";
import { syncAccounts } from "../lib/accounts.ts";
import type { AccountConfig } from "../lib/accounts-config.ts";
import { generateVapidKeys, verifyVapidJwt } from "../lib/push-crypto.ts";
import {
  agentFamily, backoffMs, buildPayload, isAllowedPushEndpoint, listDevices, loadPushConfig, PUSH_MAX_DEVICES, PUSH_MAX_FAILURES, sendToSubscription,
  subscribeDevice, subscriptionsFor, unsubscribeDevice,
} from "../lib/push.ts";
import { BRIEFING_PUSH_FROM_MINUTES, createPushNotifier, localClock, PUSH_STATE_KEY } from "../lib/push-notify.ts";
import { getUserState } from "../lib/user-state.ts";
import { addMail, BODY_MARKER, fakeDevice, fakeTransport, SENDER_MARKER, SUBJECT_MARKER, vapidEnv } from "./push-helpers.ts";

const T = "2026-10-31T10:00:00.000Z";
const NOW = new Date(T);

function mem(): DatabaseSync {
  const db = openDatabase(":memory:");
  db.exec(`INSERT INTO users (id,email,password_hash,role,status,created_at,updated_at) VALUES (2,'b@x.test','${"h".repeat(40)}','user','active','${T}','${T}')`);
  return db;
}
const account = (id: string): AccountConfig => ({
  id, label: id, context: "c", host: "imap.example.test", port: 993, tls: true, user: "u", password: "p", mailbox: "INBOX", spam_threshold: 0.95, enabled: true,
}) as AccountConfig;
function sub(db: DatabaseSync, userId = 1, kinds?: { important_mail?: boolean; briefing_ready?: boolean }, host?: string) {
  const d = fakeDevice(host);
  const r = subscribeDevice(db, userId, { endpoint: d.endpoint, p256dh: d.p256dh, auth: d.auth, agentFamily: "iOS Safari", ...(kinds ? { kinds } : {}) }, NOW);
  assert.ok(r.ok);
  return { d, id: r.ok ? r.id : -1 };
}
const config = () => {
  const c = loadPushConfig(vapidEnv());
  assert.ok(c.ok);
  return c.ok ? c.config : (undefined as never);
};

describe("loadPushConfig (fail-closed)", () => {
  test("missing keys, bad keys, mismatched pair and missing or bad subject all turn the feature off", () => {
    assert.deepEqual(loadPushConfig({}), { ok: false, reason: "vapid_not_configured" });
    const e = vapidEnv();
    assert.deepEqual(loadPushConfig({ ...e, VAPID_PUBLIC_KEY: "short" }), { ok: false, reason: "vapid_invalid" });
    assert.deepEqual(loadPushConfig({ ...e, VAPID_PRIVATE_KEY: generateVapidKeys().privateKey }), { ok: false, reason: "vapid_invalid" });
    assert.deepEqual(loadPushConfig({ ...e, VAPID_PRIVATE_KEY: "" }), { ok: false, reason: "vapid_invalid" });
    assert.deepEqual(loadPushConfig({ ...e, VAPID_SUBJECT: "" }), { ok: false, reason: "vapid_subject_missing" });
    assert.deepEqual(loadPushConfig({ ...e, VAPID_SUBJECT: "ops@example.test" }), { ok: false, reason: "vapid_invalid" });
    assert.equal(loadPushConfig(e).ok, true);
    assert.equal(loadPushConfig({ ...e, VAPID_SUBJECT: "https://example.test/contact" }).ok, true);
  });
  test("a reason never contains a key value", () => {
    const e = vapidEnv();
    const r = JSON.stringify(loadPushConfig({ ...e, VAPID_SUBJECT: "nope" }));
    assert.ok(!r.includes(e.VAPID_PUBLIC_KEY ?? "x") && !r.includes(e.VAPID_PRIVATE_KEY ?? "x"));
  });
});

describe("payload", () => {
  test("only version, kind and count", () => {
    assert.deepEqual(buildPayload("important_mail", 2), { v: 1, kind: "important_mail", count: 2 });
    assert.deepEqual(Object.keys(buildPayload("briefing_ready", 3)).sort(), ["count", "kind", "v"]);
    assert.equal(buildPayload("important_mail", 0).count, 1);
    assert.equal(buildPayload("important_mail", 5000).count, 99);
    assert.equal(buildPayload("important_mail", Number.NaN).count, 1);
  });
});

describe("endpoints and device families", () => {
  test("only https push services of the big browsers are accepted", () => {
    for (const ok of ["https://web.push.apple.com/abc123abc123abc123", "https://fcm.googleapis.com/fcm/send/abc123abc123", "https://updates.push.services.mozilla.com/wpush/v2/abc123abc",
      "https://wns2-par02p.notify.windows.com/w/?token=abcabcabcabc"]) assert.ok(isAllowedPushEndpoint(ok), ok);
    for (const bad of ["http://web.push.apple.com/abc123abc123abc123", "https://evil.example.test/abc123abc123abc123", "https://web.push.apple.com.evil.test/abcabcabcabcabc",
      "https://127.0.0.1/abc123abc123abc123", "https://user:pw@web.push.apple.com/abc123abc123abc", "https://web.push.apple.com:8443/abc123abc123abc", "https://169.254.169.254/latest/meta-data", "not a url at all really"]) {
      assert.ok(!isAllowedPushEndpoint(bad), bad);
    }
  });
  test("agentFamily is coarse and never echoes the user agent", () => {
    const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
    assert.equal(agentFamily(iphone), "iOS Safari");
    assert.equal(agentFamily("Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0"), "Desktop Edge");
    assert.equal(agentFamily("Mozilla/5.0 (X11; Linux) Gecko/20100101 Firefox/130.0"), "Desktop Firefox");
    assert.equal(agentFamily(null), "unknown");
    assert.equal(agentFamily("curl/8"), "unknown");
  });
});

describe("store", () => {
  test("subscribe stores one row per endpoint; again refreshes keys, keeps kinds not given and resets failures", () => {
    const db = mem();
    const { d, id } = sub(db, 1, { briefing_ready: false });
    assert.deepEqual(listDevices(db, 1)[0]?.kinds, { important_mail: true, briefing_ready: false });
    db.prepare("UPDATE push_subscriptions SET failure_count = 3, next_attempt_at = ? WHERE id = ?").run(T, id);
    const again = subscribeDevice(db, 1, { endpoint: d.endpoint, p256dh: d.p256dh, auth: d.auth, agentFamily: "iOS Safari", kinds: { important_mail: false } }, NOW);
    assert.deepEqual(again, { ok: true, id });
    const v = listDevices(db, 1);
    assert.equal(v.length, 1);
    assert.deepEqual(v[0]?.kinds, { important_mail: false, briefing_ready: false });
    assert.equal(v[0]?.failing, false);
  });
  test("invalid endpoint, bad keys and the device limit are refused", () => {
    const db = mem();
    const d = fakeDevice();
    const base = { p256dh: d.p256dh, auth: d.auth, agentFamily: "x" };
    assert.deepEqual(subscribeDevice(db, 1, { ...base, endpoint: "https://evil.example.test/aaaaaaaaaaaaaaaaaaaa" }, NOW), { ok: false, code: "invalid_endpoint" });
    assert.deepEqual(subscribeDevice(db, 1, { ...base, endpoint: d.endpoint, p256dh: "AAAA" }, NOW), { ok: false, code: "invalid_keys" });
    assert.deepEqual(subscribeDevice(db, 1, { ...base, endpoint: d.endpoint, auth: "AAAA" }, NOW), { ok: false, code: "invalid_keys" });
    for (let i = 0; i < PUSH_MAX_DEVICES; i++) sub(db);
    const extra = fakeDevice();
    assert.deepEqual(subscribeDevice(db, 1, { endpoint: extra.endpoint, p256dh: extra.p256dh, auth: extra.auth, agentFamily: "x" }, NOW), { ok: false, code: "device_limit" });
    assert.equal(subscribeDevice(db, 2, { endpoint: extra.endpoint, p256dh: extra.p256dh, auth: extra.auth, agentFamily: "x" }, NOW).ok, true, "the limit is per user");
  });
  test("tenant isolation: lists and unsubscribe only see own devices; a foreign id looks like a missing one", () => {
    const db = mem();
    const a = sub(db, 1);
    const b = sub(db, 2);
    assert.deepEqual(listDevices(db, 1).map((x) => x.id), [a.id]);
    assert.deepEqual(listDevices(db, 2).map((x) => x.id), [b.id]);
    assert.equal(unsubscribeDevice(db, 1, { id: b.id }), false);
    assert.equal(unsubscribeDevice(db, 1, { endpoint: b.d.endpoint }), false);
    assert.equal(listDevices(db, 2).length, 1);
    assert.equal(unsubscribeDevice(db, 2, { endpoint: b.d.endpoint }), true);
    assert.equal(subscriptionsFor(db, 2, "important_mail").length, 0);
  });
  test("an endpoint that moves to another user belongs to that user only", () => {
    const db = mem();
    const a = sub(db, 1);
    assert.ok(subscribeDevice(db, 2, { endpoint: a.d.endpoint, p256dh: a.d.p256dh, auth: a.d.auth, agentFamily: "iOS Safari" }, NOW).ok);
    assert.equal(listDevices(db, 1).length, 0);
    assert.equal(listDevices(db, 2).length, 1);
  });
  test("the device view contains no endpoint and no key", () => {
    const db = mem();
    const { d } = sub(db);
    const dump = JSON.stringify(listDevices(db, 1));
    assert.ok(!dump.includes(d.endpoint) && !dump.includes(d.p256dh) && !dump.includes(d.auth) && !dump.includes("push.apple"));
    assert.deepEqual(Object.keys(listDevices(db, 1)[0] ?? {}).sort(), ["agent_family", "created_at", "failing", "id", "kinds", "last_success_at"]);
  });
});

describe("sender", () => {
  const deps = (db: DatabaseSync, f: ReturnType<typeof fakeTransport>, at: Date = NOW) => ({ db, config: config(), transport: f.transport, now: () => at });
  const one = (db: DatabaseSync, id: number) => {
    const s = subscriptionsFor(db, 1, "test").find((x) => x.id === id);
    assert.ok(s);
    return s;
  };

  test("success: encrypted body, VAPID header, TTL, urgency and topic; delivery state is updated", async () => {
    const db = mem();
    const { d, id } = sub(db);
    const f = fakeTransport();
    const cfg = config();
    const r = await sendToSubscription({ db, config: cfg, transport: f.transport, now: () => NOW }, one(db, id), buildPayload("important_mail", 2), { urgency: "high" });
    assert.equal(r, "sent");
    const req = f.calls[0]!;
    assert.equal(req.url, d.endpoint);
    assert.equal(req.headers["content-encoding"], "aes128gcm");
    assert.equal(req.headers.ttl, "14400");
    assert.equal(req.headers.urgency, "high");
    assert.equal(req.headers.topic, "importantmail");
    const jwt = /t=([^,]+), k=(.+)$/.exec(req.headers.authorization ?? "");
    assert.equal(jwt?.[2], cfg.publicKey);
    const v = verifyVapidJwt(jwt![1]!, cfg.publicKey);
    assert.ok(v.ok);
    assert.equal(v.claims?.aud, "https://web.push.apple.com");
    assert.equal(v.claims?.sub, "mailto:ops@example.test");
    assert.deepEqual(JSON.parse(d.decrypt(req.body)), { v: 1, kind: "important_mail", count: 2 });
    const row = db.prepare("SELECT last_success_at, failure_count FROM push_subscriptions WHERE id = ?").get(id) as { last_success_at: string; failure_count: number };
    assert.deepEqual({ ...row }, { last_success_at: T, failure_count: 0 });
  });

  test("404 and 410 remove the device", async () => {
    for (const status of [404, 410]) {
      const db = mem();
      const { id } = sub(db);
      const f = fakeTransport(() => ({ status }));
      assert.equal(await sendToSubscription(deps(db, f), one(db, id), buildPayload("test", 1)), "removed");
      assert.equal(listDevices(db, 1).length, 0);
    }
  });

  test("errors back off exponentially, honour Retry-After, skip while waiting and drop the device after repeated failures", async () => {
    const db = mem();
    const { id } = sub(db);
    const f = fakeTransport(() => ({ status: 503 }));
    assert.equal(await sendToSubscription(deps(db, f), one(db, id), buildPayload("test", 1)), "retry_later");
    let row = db.prepare("SELECT failure_count, next_attempt_at FROM push_subscriptions WHERE id = ?").get(id) as { failure_count: number; next_attempt_at: string };
    assert.equal(row.failure_count, 1);
    assert.equal(Date.parse(row.next_attempt_at) - NOW.getTime(), backoffMs(1));
    // still waiting: not even tried
    const calls = f.calls.length;
    assert.equal(await sendToSubscription(deps(db, f), one(db, id), buildPayload("test", 1)), "skipped");
    assert.equal(f.calls.length, calls);
    // explicit test push ignores the wait
    assert.equal(await sendToSubscription(deps(db, f), one(db, id), buildPayload("test", 1), { ignoreBackoff: true }), "retry_later");
    // later: second failure doubles
    const later = new Date(NOW.getTime() + 3600_000);
    assert.equal(await sendToSubscription(deps(db, f, later), one(db, id), buildPayload("test", 1)), "retry_later");
    row = db.prepare("SELECT failure_count, next_attempt_at FROM push_subscriptions WHERE id = ?").get(id) as { failure_count: number; next_attempt_at: string };
    assert.equal(row.failure_count, 3);
    assert.equal(Date.parse(row.next_attempt_at) - later.getTime(), backoffMs(3));
    assert.ok(backoffMs(3) === 4 * backoffMs(1) && backoffMs(99) <= 6 * 3600_000);
    // 429 with Retry-After longer than the backoff
    const g = fakeTransport(() => ({ status: 429, retryAfterSeconds: 7200 }));
    db.prepare("UPDATE push_subscriptions SET failure_count = 0, next_attempt_at = NULL WHERE id = ?").run(id);
    await sendToSubscription(deps(db, g), one(db, id), buildPayload("test", 1));
    row = db.prepare("SELECT failure_count, next_attempt_at FROM push_subscriptions WHERE id = ?").get(id) as { failure_count: number; next_attempt_at: string };
    assert.equal(Date.parse(row.next_attempt_at) - NOW.getTime(), 7200_000);
    // too many in a row: dropped
    db.prepare("UPDATE push_subscriptions SET failure_count = ?, next_attempt_at = NULL WHERE id = ?").run(PUSH_MAX_FAILURES - 1, id);
    assert.equal(await sendToSubscription(deps(db, f), one(db, id), buildPayload("test", 1)), "removed");
    assert.equal(listDevices(db, 1).length, 0);
  });

  test("a network error is a retryable failure and never throws; a success clears the failure state", async () => {
    const db = mem();
    const { id } = sub(db);
    const boom = fakeTransport(() => { throw new Error("ECONNRESET https://web.push.apple.com/secret-endpoint"); });
    assert.equal(await sendToSubscription(deps(db, boom), one(db, id), buildPayload("test", 1)), "retry_later");
    const ok = fakeTransport();
    assert.equal(await sendToSubscription(deps(db, ok), one(db, id), buildPayload("test", 1), { ignoreBackoff: true }), "sent");
    const row = db.prepare("SELECT failure_count, next_attempt_at FROM push_subscriptions WHERE id = ?").get(id) as { failure_count: number; next_attempt_at: string | null };
    assert.deepEqual({ ...row }, { failure_count: 0, next_attempt_at: null });
  });

  test("an endpoint outside the allowlist is dropped without any request", async () => {
    const db = mem();
    const { id } = sub(db);
    db.exec("PRAGMA ignore_check_constraints = ON");
    db.prepare("UPDATE push_subscriptions SET endpoint = 'https://internal.example.test/aaaaaaaaaaaaaaaaaaaa' WHERE id = ?").run(id);
    const f = fakeTransport();
    assert.equal(await sendToSubscription(deps(db, f), one(db, id), buildPayload("test", 1)), "removed");
    assert.equal(f.calls.length, 0);
  });
});

describe("triggers: important mail", () => {
  function setup(o: { subscribe?: boolean; kinds?: { important_mail?: boolean; briefing_ready?: boolean } } = {}) {
    const db = mem();
    syncAccounts(db, [account("a1")]);
    const f = fakeTransport();
    let clock = new Date(NOW);
    const notifier = createPushNotifier({ db, config: config(), transport: f.transport, now: () => clock });
    const dev = o.subscribe === false ? undefined : sub(db, 1, o.kinds);
    return { db, f, notifier, dev, set: (d: Date) => { clock = d; }, clock: () => clock };
  }
  const payloads = (s: ReturnType<typeof setup>) => s.f.calls.map((c) => JSON.parse(s.dev!.d.decrypt(c.body)) as Record<string, unknown>);

  test("which mails count: urgent or open, not noise, not read, classified and fresh", async () => {
    const cases: [string, Parameters<typeof addMail>[3], boolean][] = [
      ["urgent (2)", { urgency: 2 }, true],
      ["urgent (3)", { urgency: 3 }, true],
      ["open by route notify", { urgency: 0, route: "notify" }, true],
      ["open by route draft_reply", { urgency: 1, route: "draft_reply" }, true],
      ["not urgent, no call to action", { urgency: 1 }, false],
      ["urgent but newsletter (noise)", { urgency: 3, category: "newsletter_promo" }, false],
      ["urgent but spam", { urgency: 3, category: "spam" }, false],
      ["urgent but already read", { urgency: 3, seen: true }, false],
    ];
    for (const [name, mail, expected] of cases) {
      const s = setup();
      const id = addMail(s.db, "a1", NOW, mail);
      await s.notifier.onClassified(id);
      assert.equal(s.f.calls.length, expected ? 1 : 0, name);
    }
  });

  test("old mail (initial sync), unclassified mail, unknown mail and users without a device send nothing", async () => {
    const s = setup();
    await s.notifier.onClassified(addMail(s.db, "a1", new Date(NOW.getTime() - 2 * 3600_000), { urgency: 3 }));
    await s.notifier.onClassified(99999);
    const unclassified = addMail(s.db, "a1", NOW, { urgency: 3 });
    s.db.prepare("UPDATE classifications SET status = 'pending' WHERE email_id = ?").run(unclassified);
    await s.notifier.onClassified(unclassified);
    assert.equal(s.f.calls.length, 0);
    const none = setup({ subscribe: false });
    await none.notifier.onClassified(addMail(none.db, "a1", NOW, { urgency: 3 }));
    assert.equal(none.f.calls.length, 0);
    const off = setup({ kinds: { important_mail: false } });
    await off.notifier.onClassified(addMail(off.db, "a1", NOW, { urgency: 3 }));
    assert.equal(off.f.calls.length, 0);
  });

  test("rate limit and coalescing: one push per 10 minutes, later mails are counted together", async () => {
    const s = setup();
    await s.notifier.onClassified(addMail(s.db, "a1", NOW, { urgency: 3 }));
    assert.deepEqual(payloads(s), [{ v: 1, kind: "important_mail", count: 1 }]);
    await s.notifier.onClassified(addMail(s.db, "a1", NOW, { urgency: 3 }));
    await s.notifier.onClassified(addMail(s.db, "a1", NOW, { urgency: 2 }));
    assert.equal(s.f.calls.length, 1, "within 10 minutes nothing more goes out");
    s.set(new Date(NOW.getTime() + 5 * 60_000));
    await s.notifier.tick();
    assert.equal(s.f.calls.length, 1, "tick before the interval is over still waits");
    s.set(new Date(NOW.getTime() + 10 * 60_000));
    await s.notifier.tick();
    assert.deepEqual(payloads(s).at(-1), { v: 1, kind: "important_mail", count: 2 });
    await s.notifier.tick();
    assert.equal(s.f.calls.length, 2, "nothing pending, nothing sent");
  });

  test("a mail that was read before the push goes out is not counted", async () => {
    const s = setup();
    await s.notifier.onClassified(addMail(s.db, "a1", NOW, { urgency: 3 }));
    const second = addMail(s.db, "a1", NOW, { urgency: 3 });
    await s.notifier.onClassified(second);
    s.db.prepare("INSERT INTO email_status (email_id, seen, done, updated_at) VALUES (?, 1, 0, ?)").run(second, T);
    s.set(new Date(NOW.getTime() + 11 * 60_000));
    await s.notifier.tick();
    assert.equal(s.f.calls.length, 1, "the only pending mail was read: no push");
    assert.deepEqual(getUserState(s.db, 1, PUSH_STATE_KEY), { important_mail: { last_sent_at: T, pending: [] }, briefing_day: null });
  });

  test("devices in backoff keep the backlog; it goes out when they recover", async () => {
    const s = setup();
    let status = 503;
    s.f.respond = () => ({ status });
    await s.notifier.onClassified(addMail(s.db, "a1", NOW, { urgency: 3 }));
    const st = getUserState(s.db, 1, PUSH_STATE_KEY) as { important_mail: { pending: number[]; last_sent_at: string | null } };
    assert.equal(st.important_mail.pending.length, 1);
    assert.equal(st.important_mail.last_sent_at, null);
    status = 201;
    s.set(new Date(NOW.getTime() + 2 * 60_000));
    await s.notifier.tick();
    assert.equal(s.f.calls.length, 2);
    assert.deepEqual(payloads(s).at(-1), { v: 1, kind: "important_mail", count: 1 });
  });

  test("a gone device (410) is removed and the backlog is dropped when no device is left", async () => {
    const s = setup();
    s.f.respond = () => ({ status: 410 });
    await s.notifier.onClassified(addMail(s.db, "a1", NOW, { urgency: 3 }));
    assert.equal(listDevices(s.db, 1).length, 0);
    s.set(new Date(NOW.getTime() + 11 * 60_000));
    await s.notifier.tick();
    assert.deepEqual((getUserState(s.db, 1, PUSH_STATE_KEY) as { important_mail: { pending: number[] } }).important_mail.pending, []);
  });

  test("never any mail content: payload, headers, request URL, stored state and device rows carry no marker string", async () => {
    const s = setup();
    for (let i = 0; i < 3; i++) await s.notifier.onClassified(addMail(s.db, "a1", NOW, { urgency: 3 }));
    s.set(new Date(NOW.getTime() + 11 * 60_000));
    await s.notifier.tick();
    assert.ok(s.f.calls.length >= 1);
    for (const c of s.f.calls) {
      const plain = s.dev!.d.decrypt(c.body);
      const everything = plain + JSON.stringify(c.headers) + c.url;
      for (const m of [SUBJECT_MARKER, SENDER_MARKER, BODY_MARKER, "example.test"]) assert.ok(!everything.includes(m), m);
      assert.ok(!plain.includes("@"), "no address in the payload");
      assert.deepEqual(Object.keys(JSON.parse(plain) as object).sort(), ["count", "kind", "v"]);
      assert.ok(!Buffer.from(c.body).includes(Buffer.from(SUBJECT_MARKER)), "ciphertext is not a plaintext copy either");
    }
    const dump = JSON.stringify([
      s.db.prepare("SELECT * FROM push_subscriptions").all(), s.db.prepare("SELECT * FROM user_state").all(), s.db.prepare("SELECT * FROM audit_log").all(),
    ]);
    for (const m of [SUBJECT_MARKER, SENDER_MARKER, BODY_MARKER]) assert.ok(!dump.includes(m), m);
  });

  test("without a VAPID configuration every method is a no-op", async () => {
    const db = mem();
    syncAccounts(db, [account("a1")]);
    sub(db);
    const f = fakeTransport();
    const n = createPushNotifier({ db, config: undefined, transport: f.transport, now: () => NOW });
    await n.onClassified(addMail(db, "a1", NOW, { urgency: 3 }));
    await n.tick();
    n.start();
    n.stop();
    assert.equal(f.calls.length, 0);
    assert.equal(getUserState(db, 1, PUSH_STATE_KEY), undefined);
  });

  test("start/stop manage one unref'd timer", async () => {
    const s = setup();
    s.notifier.start();
    s.notifier.start();
    s.notifier.stop();
    s.notifier.stop();
  });
});

describe("triggers: briefing ready (daily job)", () => {
  // 2026-10-31 is CET (UTC+1): 06:45 UTC = 07:45 local, 05:00 UTC = 06:00 local, 11:00 UTC = 12:00 local.
  const at = (hhmmUtc: string, day = "2026-10-31") => new Date(`${day}T${hhmmUtc}:00.000Z`);
  function setup(openMails = 2) {
    const db = mem();
    syncAccounts(db, [account("a1")]);
    const f = fakeTransport();
    let clock = at("06:45");
    const notifier = createPushNotifier({ db, config: config(), transport: f.transport, now: () => clock });
    const dev = sub(db);
    for (let i = 0; i < openMails; i++) addMail(db, "a1", at("05:00"), { urgency: 0, route: "notify" });
    return { db, f, notifier, dev, set: (d: Date) => { clock = d; } };
  }

  test("localClock reads Europe/Berlin including daylight saving time", () => {
    assert.deepEqual(localClock(at("06:45")), { day: "2026-10-31", minutes: 7 * 60 + 45 });
    assert.deepEqual(localClock(new Date("2026-07-01T05:45:00Z")), { day: "2026-07-01", minutes: 7 * 60 + 45 });
    assert.equal(BRIEFING_PUSH_FROM_MINUTES, 450);
  });

  test("pushes once per local day, from 07:30, with the number of open mails and nothing else", async () => {
    const s = setup(2);
    s.set(at("05:00")); // 06:00 local: too early
    await s.notifier.tick();
    assert.equal(s.f.calls.length, 0);
    s.set(at("06:45"));
    await s.notifier.tick();
    await s.notifier.tick();
    assert.equal(s.f.calls.length, 1);
    assert.deepEqual(JSON.parse(s.dev.d.decrypt(s.f.calls[0]!.body)), { v: 1, kind: "briefing_ready", count: 2 });
    assert.equal(s.f.calls[0]!.headers.urgency, "normal");
    s.set(at("08:00", "2026-11-01"));
    await s.notifier.tick();
    assert.equal(s.f.calls.length, 2, "next day, next push");
  });

  test("too late in the day (after 11:00 local) it is skipped; nothing open means no push", async () => {
    const s = setup(2);
    s.set(at("11:00"));
    await s.notifier.tick();
    assert.equal(s.f.calls.length, 0);
    const none = setup(0);
    await none.notifier.tick();
    assert.equal(none.f.calls.length, 0);
    assert.equal((getUserState(none.db, 1, PUSH_STATE_KEY) as { briefing_day: string }).briefing_day, "2026-10-31", "the day is marked, no recount every minute");
  });

  test("only devices with briefing_ready on get it, and a device in backoff is retried within the window", async () => {
    const s = setup(1);
    s.db.prepare("UPDATE push_subscriptions SET briefing_ready = 0").run();
    await s.notifier.tick();
    assert.equal(s.f.calls.length, 0);
    s.db.prepare("UPDATE push_subscriptions SET briefing_ready = 1").run();
    s.f.respond = () => ({ status: 503 });
    await s.notifier.tick();
    assert.equal(s.f.calls.length, 1);
    s.f.respond = () => ({ status: 201 });
    s.set(new Date(at("06:45").getTime() + 30_000));
    await s.notifier.tick();
    assert.equal(s.f.calls.length, 1, "the device is still in its one-minute backoff");
    s.set(at("06:47"));
    await s.notifier.tick();
    assert.equal(s.f.calls.length, 2, "retried after the backoff, inside the window");
  });
});
