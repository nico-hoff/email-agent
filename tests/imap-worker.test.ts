import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { IMAP_BACKOFF_MAX_MS, IMAP_BACKOFF_MIN_MS, POLL_INTERVAL_MS, WATCHDOG_STALE_MS } from "../lib/constants.ts";
import { openDatabase } from "../lib/db.ts";
import { syncAccounts } from "../lib/accounts.ts";
import type { ImapEventError, ImapPort, TransientInput } from "../lib/imap.ts";
import { ingestMail } from "../lib/ingest.ts";
import { createImapWorkers } from "../workers/imap-worker.ts";

const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
};

class FakeClock {
  t = 1_000_000;
  timers: { at: number; fn: () => void; id: number }[] = [];
  nextId = 1;
  now = () => this.t;
  setTimeout = (fn: () => void, ms: number) => {
    const id = this.nextId++;
    this.timers.push({ at: this.t + ms, fn, id });
    return id;
  };
  clearTimeout = (h: unknown) => {
    this.timers = this.timers.filter((x) => x.id !== h);
  };
  async advance(ms: number) {
    const target = this.t + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.timers[0];
      if (!next || next.at > target) break;
      this.timers.shift();
      this.t = next.at;
      next.fn();
      await settle();
    }
    this.t = target;
    await settle();
  }
}

class FakePort implements ImapPort {
  handlers: Record<string, (...a: never[]) => void> = {};
  closed = false;
  watched: string[] = [];
  fetchedBodies: [string, number][] = [];
  headerCalls: [string, number][] = [];
  connectImpl: () => Promise<void> = async () => {};
  statusImpl: (f: string) => Promise<{ uidValidity: number; highestUid: number }>;
  inboxUids: number[] = [];
  spamHeaders: { uid: number; messageId: string | null }[] = [];
  inflight = 0;
  maxInflight = 0;
  delayStatus = false;
  name: string;
  constructor(name: string) {
    this.name = name;
    this.statusImpl = async (f) => {
      this.inflight++;
      this.maxInflight = Math.max(this.maxInflight, this.inflight);
      if (this.delayStatus) await new Promise((r) => setImmediate(r));
      this.inflight--;
      return { uidValidity: 1, highestUid: f === "INBOX" ? Math.max(10, ...this.inboxUids) : 100 };
    };
  }
  connect() {
    return this.connectImpl();
  }
  mailboxStatus(f: string) {
    return this.statusImpl(f);
  }
  async fetchHeadersSince(f: string, after: number) {
    this.headerCalls.push([f, after]);
    if (f === "INBOX") return this.inboxUids.filter((u) => u > after).map((uid) => ({ uid, messageId: `<${uid}@x>` }));
    return this.spamHeaders.filter((h) => h.uid > after);
  }
  async fetchMessageByUid(f: string, uid: number) {
    this.fetchedBodies.push([f, uid]);
    const src = `Message-ID: <${uid}@x>\r\nFrom: a@example.test\r\nSubject: s\r\nDate: Mon, 26 Oct 2026 10:00:00 +0000\r\n\r\nSYNTHETIC BODY`;
    return { uid, source: Buffer.from(src) };
  }
  async watch(f: string) {
    this.watched.push(f);
  }
  on(ev: string, cb: (...a: never[]) => void) {
    this.handlers[ev] = cb;
  }
  emit(ev: string, arg?: unknown) {
    (this.handlers[ev] as (a?: unknown) => void)?.(arg);
  }
  async close() {
    this.closed = true;
  }
}

const acct = (id: string, over: Record<string, unknown> = {}) => ({
  id, label: id, context: "c", host: "h", port: 993, tls: true, user: "u", password: "p",
  mailbox: "INBOX", spam_mailbox: "Junk", spam_threshold: 0.9, enabled: true, ...over,
}) as never;

interface Harness {
  db: DatabaseSync;
  clock: FakeClock;
  ports: Record<string, FakePort[]>;
  ingested: [number, TransientInput][];
  workers: ReturnType<typeof createImapWorkers>;
  setup(id: string, f: (p: FakePort, n: number) => void): void;
}
function harness(ids: string[]): Harness {
  const db = openDatabase(":memory:");
  const accounts = ids.map((i) => acct(i));
  syncAccounts(db, accounts);
  const clock = new FakeClock();
  const ports: Record<string, FakePort[]> = {};
  const setups: Record<string, (p: FakePort, n: number) => void> = {};
  const ingested: [number, TransientInput][] = [];
  const workers = createImapWorkers({
    db, accounts,
    createPort: (a) => {
      const list = (ports[a.id] ??= []);
      const p = new FakePort(a.id);
      list.push(p);
      setups[a.id]?.(p, list.length);
      return p;
    },
    onIngested: (id, input) => {
      ingested.push([id, input]);
    },
    clock, random: () => 1,
  });
  return { db, clock, ports, ingested, workers, setup: (id, f) => { setups[id] = f; } };
}
const state = (db: DatabaseSync, id: string) =>
  ({ ...db.prepare("SELECT state, error_code, last_event_at, last_poll_at FROM worker_status WHERE account_id = ?").get(id) }) as Record<string, unknown>;
const audits = (db: DatabaseSync, action: string, id?: string) =>
  db.prepare("SELECT * FROM audit_log WHERE action = ?" + (id ? " AND account_id = ?" : "")).all(...(id ? [action, id] : [action])).length;

describe("imap workers", () => {
  test("two accounts have their own client; A failing/backing off does not block B", async () => {
    const h = harness(["a", "b"]);
    h.setup("a", (p) => { p.connectImpl = async () => { throw new Error("net down"); }; });
    h.workers.start();
    await settle();
    assert.equal(h.ports.a.length, 1);
    assert.equal(h.ports.b.length, 1);
    assert.notEqual(h.ports.a[0], h.ports.b[0]);
    assert.equal(state(h.db, "a").state, "backoff");
    assert.equal(state(h.db, "a").error_code, "imap_error");
    assert.equal(state(h.db, "b").state, "connected");
    assert.deepEqual(h.ports.b[0].watched, ["INBOX"]);
    await h.workers.stop();
  });

  test("backoff grows with jitter bound and is capped", async () => {
    const h = harness(["a"]);
    const times: number[] = [];
    h.setup("a", (p) => { times.push(h.clock.now()); p.connectImpl = async () => { throw new Error("x"); }; });
    h.workers.start();
    await settle();
    for (let i = 0; i < 14; i++) await h.clock.advance(IMAP_BACKOFF_MAX_MS);
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    assert.equal(gaps[0], IMAP_BACKOFF_MIN_MS);
    assert.ok(gaps[1] >= gaps[0]);
    assert.ok(gaps.every((g) => g <= IMAP_BACKOFF_MAX_MS));
    assert.equal(Math.max(...gaps), IMAP_BACKOFF_MAX_MS);
    await h.workers.stop();
  });

  test("IDLE exists event triggers immediate sync; ingest + onIngested; events are serial", async () => {
    const h = harness(["a"]);
    h.workers.start();
    await settle();
    const p = h.ports.a[0];
    p.inboxUids = [11, 12];
    p.delayStatus = true;
    p.emit("exists");
    p.emit("exists");
    p.emit("exists");
    await settle();
    assert.equal(p.maxInflight, 1);
    assert.deepEqual(p.fetchedBodies, [["INBOX", 11], ["INBOX", 12]]);
    assert.deepEqual(h.ingested.map((x) => x[1].excerpt), ["SYNTHETIC BODY", "SYNTHETIC BODY"]);
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM emails").get()?.n, 2);
    assert.notEqual(state(h.db, "a").last_event_at, null);
    await h.workers.stop();
  });

  test("poll covers INBOX and spam; spam folder is headers-only and only known message-ids", async () => {
    const h = harness(["a"]);
    h.workers.start();
    await settle();
    const p = h.ports.a[0];
    // a known mail in INBOX (as if ingested earlier)
    ingestMail(h.db, {
      accountId: "a",
      meta: { messageId: "<known@x>", sender: "s@example.test", subject: "s", receivedAt: "2026-10-26T10:00:00.000Z", spf: "pass", dkim: "pass", dmarc: "pass", listUnsubscribePresent: false, replyToDiffersFromFrom: false },
      loc: { folder: "INBOX", uid: 3, uidValidity: 1 }, now: new Date(), traceId: "t",
    });
    p.inboxUids = [11];
    p.spamHeaders = [{ uid: 101, messageId: "<known@x>" }, { uid: 102, messageId: "<unknown@x>" }, { uid: 103, messageId: null }];
    await h.clock.advance(POLL_INTERVAL_MS);
    assert.deepEqual(p.fetchedBodies, [["INBOX", 11]]);
    assert.ok(p.headerCalls.some(([f]) => f === "Junk"));
    assert.deepEqual(
      h.db.prepare("SELECT folder, is_active FROM email_locations WHERE email_id = (SELECT id FROM emails WHERE message_id = '<known@x>') ORDER BY id").all().map((r) => ({ ...r })),
      [{ folder: "INBOX", is_active: 0 }, { folder: "Junk", is_active: 1 }],
    );
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM emails WHERE message_id IN ('<unknown@x>')").get()?.n, 0);
    assert.equal(h.db.prepare("SELECT last_uid FROM mailbox_state WHERE mailbox = 'Junk'").get()?.last_uid, 103);
    assert.notEqual(state(h.db, "a").last_poll_at, null);
    assert.equal(p.watched.at(-1), "INBOX");
    await h.workers.stop();
  });

  test("quiet mailbox with successful polls never triggers reconnect", async () => {
    const h = harness(["a"]);
    h.workers.start();
    await settle();
    for (let i = 0; i < 12; i++) await h.clock.advance(POLL_INTERVAL_MS);
    assert.equal(h.ports.a.length, 1);
    assert.equal(audits(h.db, "worker_reconnect_forced"), 0);
    await h.workers.stop();
  });

  test("watchdog reconnects only the stale account", async () => {
    const h = harness(["a", "b"]);
    h.setup("a", (p, n) => {
      if (n === 1) p.statusImpl = async (f) => (f === "INBOX" && h.clock.now() > 1_000_000 ? new Promise(() => {}) : { uidValidity: 1, highestUid: 10 });
    });
    h.workers.start();
    await settle();
    await h.clock.advance(WATCHDOG_STALE_MS + 2 * POLL_INTERVAL_MS);
    assert.ok(h.ports.a.length >= 2, "a reconnected");
    assert.equal(h.ports.a[0].closed, true);
    assert.equal(h.ports.b.length, 1);
    assert.equal(h.ports.b[0].closed, false);
    assert.ok(audits(h.db, "worker_reconnect_forced", "a") >= 1);
    assert.equal(audits(h.db, "worker_reconnect_forced", "b"), 0);
    assert.equal(state(h.db, "a").state, "connected");
    await h.workers.stop();
  });

  test("IMAP auth failure pauses with imap_auth and is not retried", async () => {
    const h = harness(["a"]);
    h.setup("a", (p) => { p.connectImpl = async () => { throw Object.assign(new Error("denied"), { authenticationFailed: true }); }; });
    h.workers.start();
    await settle();
    assert.equal(state(h.db, "a").state, "paused");
    assert.equal(state(h.db, "a").error_code, "imap_auth");
    await h.clock.advance(IMAP_BACKOFF_MAX_MS * 3);
    assert.equal(h.ports.a.length, 1);
    assert.equal(audits(h.db, "worker_paused", "a"), 1);
    await h.workers.stop();
  });

  test("auth error event after connect also pauses", async () => {
    const h = harness(["a"]);
    h.workers.start();
    await settle();
    h.ports.a[0].emit("error", { code: "imap_auth" } satisfies ImapEventError);
    await settle();
    assert.equal(state(h.db, "a").state, "paused");
    assert.equal(h.ports.a[0].closed, true);
  });

  test("close event reconnects with backoff", async () => {
    const h = harness(["a"]);
    h.workers.start();
    await settle();
    h.ports.a[0].emit("close");
    await settle();
    assert.equal(state(h.db, "a").state, "backoff");
    await h.clock.advance(IMAP_BACKOFF_MIN_MS);
    assert.equal(h.ports.a.length, 2);
    assert.equal(state(h.db, "a").state, "connected");
    assert.equal(state(h.db, "a").error_code, null);
    await h.workers.stop();
  });

  test("stop() closes every client and stops timers", async () => {
    const h = harness(["a", "b"]);
    h.workers.start();
    await settle();
    await h.workers.stop();
    assert.ok(h.ports.a[0].closed && h.ports.b[0].closed);
    await h.clock.advance(WATCHDOG_STALE_MS * 2);
    assert.equal(h.ports.a.length, 1);
    assert.equal(h.clock.timers.length, 0);
  });
});
