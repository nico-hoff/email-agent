import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { EXCERPT_MAX_CHARS } from "../lib/constants.ts";
import { openDatabase } from "../lib/db.ts";
import { syncAccounts } from "../lib/accounts.ts";
import {
  createImapFlowPort,
  fetchNewMessages,
  type ImapPort,
  parseMessage,
  reconcileCheckpoint,
} from "../lib/imap.ts";

const CRLF = "\r\n";
function mime(headers: string[], body: string): Buffer {
  return Buffer.from(headers.join(CRLF) + CRLF + CRLF + body, "utf8");
}
const BASE = [
  "Message-ID: <abc123@example.test>",
  "From: =?UTF-8?Q?J=C3=BCrgen_Test?= <Sender.Name@Example.TEST>",
  "To: me@example.test",
  "Subject: =?UTF-8?B?SGVsbG8gV8O2cmxk?=",
  "Date: Mon, 26 Oct 2026 10:00:00 +0000",
  "MIME-Version: 1.0",
  "Content-Type: text/plain; charset=utf-8",
];

describe("parseMessage", () => {
  test("extracts metadata", async () => {
    const src = mime([
      ...BASE,
      "Authentication-Results: mx.example.test; spf=pass smtp.mailfrom=example.test; dkim=fail header.d=example.test; dmarc=softfail",
      "List-Unsubscribe: <mailto:unsub@example.test>",
      "Reply-To: other@example.test",
    ], "Hallo Welt");
    const { meta, excerpt } = await parseMessage(src);
    assert.equal(meta.messageId, "<abc123@example.test>");
    assert.equal(meta.sender, "sender.name@example.test");
    assert.equal(meta.subject, "Hello Wörld");
    assert.equal(meta.receivedAt, "2026-10-26T10:00:00.000Z");
    assert.equal(meta.spf, "pass");
    assert.equal(meta.dkim, "fail");
    assert.equal(meta.dmarc, "softfail");
    assert.equal(meta.listUnsubscribePresent, true);
    assert.equal(meta.replyToDiffersFromFrom, true);
    assert.equal(excerpt, "Hallo Welt");
  });

  test("defaults: unknown auth, no unsubscribe, same reply-to, missing message-id", async () => {
    const src = mime(
      BASE.filter((h) => !h.startsWith("Message-ID")).concat("Reply-To: SENDER.name@example.test"),
      "x",
    );
    const { meta } = await parseMessage(src);
    assert.equal(meta.messageId, null);
    assert.deepEqual([meta.spf, meta.dkim, meta.dmarc], ["unknown", "unknown", "unknown"]);
    assert.equal(meta.listUnsubscribePresent, false);
    assert.equal(meta.replyToDiffersFromFrom, false);
  });

  test("unrecognised auth values map to unknown", async () => {
    const src = mime([...BASE, "Authentication-Results: mx; spf=bogus; dkim=none; dmarc=temperror"], "x");
    const { meta } = await parseMessage(src);
    assert.deepEqual([meta.spf, meta.dkim, meta.dmarc], ["unknown", "none", "temperror"]);
  });

  test("excerpt is truncated hard and derived from text only, never html or attachments", async () => {
    const src = mime(
      [
        ...BASE.filter((h) => !h.startsWith("Content-Type")),
        'Content-Type: multipart/mixed; boundary="B"',
      ],
      [
        "--B",
        "Content-Type: multipart/alternative; boundary=\"A\"",
        "",
        "--A",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "a".repeat(EXCERPT_MAX_CHARS + 500),
        "--A",
        "Content-Type: text/html; charset=utf-8",
        "",
        "<p>HTMLMARKER</p>",
        "--A--",
        "--B",
        'Content-Type: text/plain; name="x.txt"',
        'Content-Disposition: attachment; filename="x.txt"',
        "",
        "ATTACHMARKER",
        "--B--",
        "",
      ].join(CRLF),
    );
    const { excerpt } = await parseMessage(src);
    assert.equal(excerpt.length, EXCERPT_MAX_CHARS);
    assert.ok(!excerpt.includes("HTMLMARKER") && !excerpt.includes("ATTACHMARKER"));
  });
});

class FakeClient {
  locks: { path: string; options: unknown }[] = [];
  calls: string[] = [];
  mailbox = { uidValidity: 7n, uidNext: 11, exists: 10 };
  usable = true;
  handlers = new Map<string, (...a: unknown[]) => void>();
  on(ev: string, cb: (...a: unknown[]) => void) {
    this.handlers.set(ev, cb);
    return this;
  }
  async connect() {
    this.calls.push("connect");
  }
  async logout() {
    this.calls.push("logout");
  }
  close() {
    this.calls.push("close");
  }
  async getMailboxLock(path: string, options: unknown) {
    this.locks.push({ path, options });
    return { path, release: () => this.calls.push("release") };
  }
  async idle() {
    this.calls.push("idle");
    return true;
  }
  async *fetch(range: string, query: Record<string, unknown>, options: Record<string, unknown>) {
    this.calls.push(`fetch ${range}`);
    assert.equal(options.uid, true);
    assert.ok(!("source" in query), "bulk fetch must not request bodies");
    yield { uid: 9, headers: Buffer.from("Message-ID: <nine@example.test>\r\n\r\n") };
    yield { uid: 10, headers: Buffer.from("Subject: x\r\n\r\n") };
  }
  async fetchOne(seq: string, query: Record<string, unknown>, options: Record<string, unknown>) {
    this.calls.push(`fetchOne ${seq}`);
    assert.equal(options.uid, true);
    assert.ok(query.source);
    return { uid: Number(seq), source: mime(BASE, "body") };
  }
}
for (
  const w of [
    "append", "messageDelete", "messageMove", "messageCopy", "messageFlagsAdd", "messageFlagsRemove",
    "messageFlagsSet", "setFlagColor", "mailboxCreate", "mailboxDelete", "mailboxRename", "store",
    "expunge",
  ]
) {
  (FakeClient.prototype as unknown as Record<string, unknown>)[w] = () => {
    throw new Error(`WRITE CALL: ${w}`);
  };
}

describe("createImapFlowPort (read-only)", () => {
  test("only read operations, all locks readOnly, bulk fetch without bodies", async () => {
    const fake = new FakeClient();
    const port = createImapFlowPort(
      { host: "h", port: 993, tls: true, user: "u", password: "p" },
      () => fake as never,
    );
    await port.connect();
    assert.deepEqual(await port.mailboxStatus("INBOX"), { uidValidity: 7, highestUid: 10 });
    assert.deepEqual(await port.fetchHeadersSince("INBOX", 8), [
      { uid: 9, messageId: "<nine@example.test>" },
      { uid: 10, messageId: null },
    ]);
    const msg = await port.fetchMessageByUid("INBOX", 5);
    assert.equal(msg?.uid, 5);
    await port.watch("INBOX");
    await port.close();
    assert.ok(fake.locks.length >= 3);
    for (const l of fake.locks) assert.deepEqual((l.options as { readOnly: boolean }).readOnly, true);
    assert.ok(!fake.calls.some((c) => c.startsWith("fetchOne") && c.includes("*")));
  });

  test("forwards events", async () => {
    const fake = new FakeClient();
    const port = createImapFlowPort(
      { host: "h", port: 993, tls: true, user: "u", password: "p" },
      () => fake as never,
    );
    const seen: string[] = [];
    port.on("exists", () => seen.push("exists"));
    port.on("close", () => seen.push("close"));
    port.on("error", (e) => seen.push(`error:${e.code}`));
    fake.handlers.get("exists")!({});
    fake.handlers.get("close")!();
    fake.handlers.get("error")!(Object.assign(new Error("secret detail"), { authenticationFailed: true }));
    assert.deepEqual(seen, ["exists", "close", "error:imap_auth"]);
  });
});

function setup(): DatabaseSync {
  const db = openDatabase(":memory:");
  syncAccounts(db, [{
    id: "a", label: "A", context: "c", host: "h", port: 993, tls: true, user: "u", password: "p",
    mailbox: "INBOX", spam_threshold: 0.9, enabled: true,
  } as never]);
  return db;
}
const NOW = new Date("2026-10-26T12:00:00.000Z");

describe("reconcileCheckpoint", () => {
  test("first contact: baseline at highest UID, nothing to import", () => {
    const db = setup();
    const r = reconcileCheckpoint(db, "a", "INBOX", { uidValidity: 5, highestUid: 42 }, { now: NOW, traceId: "t" });
    assert.deepEqual(r, { kind: "baseline", fromUid: 42 });
    const row = db.prepare("SELECT uid_validity, last_uid FROM mailbox_state").get();
    assert.deepEqual({ ...row }, { uid_validity: 5, last_uid: 42 });
  });

  test("same UIDVALIDITY continues from checkpoint", () => {
    const db = setup();
    reconcileCheckpoint(db, "a", "INBOX", { uidValidity: 5, highestUid: 42 }, { now: NOW, traceId: "t" });
    const r = reconcileCheckpoint(db, "a", "INBOX", { uidValidity: 5, highestUid: 50 }, { now: NOW, traceId: "t" });
    assert.deepEqual(r, { kind: "continue", fromUid: 42 });
  });

  test("UIDVALIDITY change: new baseline, locations inactive, audit", () => {
    const db = setup();
    reconcileCheckpoint(db, "a", "INBOX", { uidValidity: 5, highestUid: 42 }, { now: NOW, traceId: "t" });
    db.prepare("INSERT INTO emails (id, account_id, message_id, sender, subject, received_at, first_seen_at) VALUES (1,'a','<m>','s','x','t','t')").run();
    db.prepare("INSERT INTO email_locations (email_id, account_id, folder, uid_validity, uid, first_seen_at, last_seen_at) VALUES (1,'a','INBOX',5,3,'t','t')").run();
    db.prepare("INSERT INTO email_locations (email_id, account_id, folder, uid_validity, uid, first_seen_at, last_seen_at) VALUES (1,'a','Junk',5,4,'t','t')").run();
    const r = reconcileCheckpoint(db, "a", "INBOX", { uidValidity: 6, highestUid: 7 }, { now: NOW, traceId: "tr" });
    assert.deepEqual(r, { kind: "uidvalidity_reset", fromUid: 7 });
    const locs = db.prepare("SELECT folder, is_active FROM email_locations ORDER BY folder").all().map((x) => ({ ...x }));
    assert.deepEqual(locs, [{ folder: "INBOX", is_active: 0 }, { folder: "Junk", is_active: 1 }]);
    const a = db.prepare("SELECT action, actor, trace_id, account_id, details_json FROM audit_log").all().map((x) => ({ ...x }));
    assert.equal(a.length, 1);
    assert.equal(a[0].action, "uidvalidity_reset");
    assert.equal(a[0].account_id, "a");
    assert.deepEqual(JSON.parse(String(a[0].details_json)), { folder: "INBOX" });
    const st = db.prepare("SELECT uid_validity, last_uid FROM mailbox_state").get();
    assert.deepEqual({ ...st }, { uid_validity: 6, last_uid: 7 });
  });
});

describe("fetchNewMessages", () => {
  function fakePort(): ImapPort & { fetched: number[] } {
    const fetched: number[] = [];
    return {
      fetched,
      connect: async () => {},
      mailboxStatus: async () => ({ uidValidity: 5, highestUid: 12 }),
      fetchHeadersSince: async (_f, after) =>
        [11, 12].filter((u) => u > after).map((uid) => ({ uid, messageId: `<${uid}@x>` })),
      fetchMessageByUid: async (_f, uid) => {
        fetched.push(uid);
        return { uid, source: mime(BASE, "SECRETBODY " + uid) };
      },
      watch: async () => {},
      on: () => {},
      close: async () => {},
    };
  }

  test("writer gets metadata only, excerpt goes only to onIngested, checkpoint advances", async () => {
    const db = setup();
    reconcileCheckpoint(db, "a", "INBOX", { uidValidity: 5, highestUid: 10 }, { now: NOW, traceId: "t" });
    const port = fakePort();
    const written: unknown[] = [];
    const transient: [number, unknown][] = [];
    const res = await fetchNewMessages(port, db, {
      accountId: "a", folder: "INBOX", now: NOW, traceId: "t",
      writeMetadata: (meta, loc) => {
        written.push({ meta, loc });
        return loc.uid * 100;
      },
      onIngested: (id, input) => {
        transient.push([id, input]);
      },
    });
    assert.deepEqual(res, { kind: "continue", count: 2 });
    assert.deepEqual(port.fetched, [11, 12]);
    assert.ok(!JSON.stringify(written).includes("SECRETBODY"));
    assert.ok(!JSON.stringify(written).includes("excerpt"));
    assert.deepEqual(transient.map((t) => t[0]), [1100, 1200]);
    assert.ok(JSON.stringify(transient[0][1]).includes("SECRETBODY 11"));
    const st = db.prepare("SELECT last_uid FROM mailbox_state").get();
    assert.equal(st?.last_uid, 12);
  });

  test("baseline run imports nothing", async () => {
    const db = setup();
    const port = fakePort();
    const res = await fetchNewMessages(port, db, {
      accountId: "a", folder: "INBOX", now: NOW, traceId: "t",
      writeMetadata: () => assert.fail("must not write"),
      onIngested: () => assert.fail("must not call"),
    });
    assert.deepEqual(res, { kind: "baseline", count: 0 });
    assert.deepEqual(port.fetched, []);
  });
});
