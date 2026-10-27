import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../lib/db.ts";
import { syncAccounts } from "../lib/accounts.ts";
import { ingestMail } from "../lib/ingest.ts";
import type { ImapPort, MessageMeta } from "../lib/imap.ts";
import { readEmailStatus, refreshSeenFlags, setDone, upsertSeen } from "../lib/email-status.ts";

const NOW = new Date("2026-10-27T12:00:00.000Z");
const DAY = 86_400_000;

function setup(): DatabaseSync {
  const db = openDatabase(":memory:");
  syncAccounts(db, [{
    id: "a", label: "A", context: "c", host: "h", port: 993, tls: true, user: "u", password: "p",
    mailbox: "INBOX", spam_mailbox: "Junk", spam_threshold: 0.9, enabled: true,
  } as never]);
  return db;
}
const meta = (id: string): MessageMeta => ({
  messageId: id, sender: "s@example.test", subject: "subj", receivedAt: "2026-10-26T10:00:00.000Z",
  spf: "pass", dkim: "pass", dmarc: "pass", listUnsubscribePresent: false, replyToDiffersFromFrom: false,
});
function mail(db: DatabaseSync, uid: number, o: { folder?: string; seenAt?: Date; uv?: number } = {}): number {
  return ingestMail(db, {
    accountId: "a", meta: meta(`<m${uid}@x>`), loc: { folder: o.folder ?? "INBOX", uid, uidValidity: o.uv ?? 1 },
    now: o.seenAt ?? NOW, traceId: "t",
  }).emailId;
}
const row = (db: DatabaseSync, id: number) => db.prepare("SELECT seen, done, updated_at FROM email_status WHERE email_id = ?").get(id) as
  | { seen: number; done: number; updated_at: string }
  | undefined;

describe("seen and done are independent", () => {
  test("upsertSeen creates the row, reports changes only, and never touches done", () => {
    const db = setup();
    const id = mail(db, 1);
    assert.equal(row(db, id), undefined, "no row means unread and not done: seen 0, done 0");
    assert.deepEqual(readEmailStatus(db, id), { seen: false, done: false });
    assert.equal(upsertSeen(db, id, true, "2026-10-27T10:00:00.000Z"), true);
    assert.deepEqual({ ...row(db, id) }, { seen: 1, done: 0, updated_at: "2026-10-27T10:00:00.000Z" });
    assert.equal(upsertSeen(db, id, true, "2026-10-27T11:00:00.000Z"), false);
    assert.equal(row(db, id)!.updated_at, "2026-10-27T10:00:00.000Z", "an unchanged flag does not rewrite the row");
    setDone(db, id, true, "2026-10-27T11:30:00.000Z");
    upsertSeen(db, id, false, "2026-10-27T12:00:00.000Z");
    assert.deepEqual({ ...row(db, id) }, { seen: 0, done: 1, updated_at: "2026-10-27T12:00:00.000Z" });
  });

  test("setDone creates the row when there is none, keeps seen, and reports whether anything changed", () => {
    const db = setup();
    const id = mail(db, 1);
    assert.deepEqual(setDone(db, id, true, "2026-10-27T10:00:00.000Z"), { changed: true });
    assert.deepEqual({ ...row(db, id) }, { seen: 0, done: 1, updated_at: "2026-10-27T10:00:00.000Z" });
    assert.deepEqual(setDone(db, id, true, "2026-10-27T11:00:00.000Z"), { changed: false });
    upsertSeen(db, id, true, "2026-10-27T11:30:00.000Z");
    assert.deepEqual(setDone(db, id, false, "2026-10-27T12:00:00.000Z"), { changed: true });
    assert.deepEqual({ ...row(db, id) }, { seen: 1, done: 0, updated_at: "2026-10-27T12:00:00.000Z" });
    assert.deepEqual(setDone(db, mail(db, 2), false, "2026-10-27T12:00:00.000Z"), { changed: false }, "undone on a mail without a row stays a no-op");
  });
});

describe("ingestMail takes the provider flag along", () => {
  test("seen is stored for new mails and re-seen locations; unknown (undefined) stores nothing", () => {
    const db = setup();
    const a = ingestMail(db, { accountId: "a", meta: meta("<x1>"), loc: { folder: "INBOX", uid: 1, uidValidity: 1 }, now: NOW, traceId: "t", seen: true });
    const b = ingestMail(db, { accountId: "a", meta: meta("<x2>"), loc: { folder: "INBOX", uid: 2, uidValidity: 1 }, now: NOW, traceId: "t", seen: false });
    const c = ingestMail(db, { accountId: "a", meta: meta("<x3>"), loc: { folder: "INBOX", uid: 3, uidValidity: 1 }, now: NOW, traceId: "t" });
    assert.deepEqual(readEmailStatus(db, a.emailId), { seen: true, done: false });
    assert.deepEqual(readEmailStatus(db, b.emailId), { seen: false, done: false });
    assert.equal(row(db, c.emailId), undefined);
    // same location again with a changed flag
    ingestMail(db, { accountId: "a", meta: meta("<x2>"), loc: { folder: "INBOX", uid: 2, uidValidity: 1 }, now: NOW, traceId: "t", seen: true });
    assert.equal(readEmailStatus(db, b.emailId).seen, true);
  });

  test("a mail the provider moved to the spam folder takes the flag of its new copy", () => {
    const db = setup();
    const a = ingestMail(db, { accountId: "a", meta: meta("<x1>"), loc: { folder: "INBOX", uid: 1, uidValidity: 1 }, now: NOW, traceId: "t", seen: false });
    ingestMail(db, { accountId: "a", meta: meta("<x1>"), loc: { folder: "Junk", uid: 50, uidValidity: 1 }, now: NOW, traceId: "t", seen: true });
    assert.equal(readEmailStatus(db, a.emailId).seen, true);
  });
});

class FlagPort {
  calls: [string, number[]][] = [];
  flags = new Map<number, boolean>();
  async fetchFlags(folder: string, uids: number[]) {
    this.calls.push([folder, uids]);
    return uids.filter((u) => this.flags.has(u)).map((uid) => ({ uid, seen: this.flags.get(uid)! }));
  }
}
const asPort = (p: FlagPort) => p as unknown as ImapPort;

describe("refreshSeenFlags (read-only FETCH FLAGS of known UIDs)", () => {
  test("asks for active locations of the current UIDVALIDITY inside the window, updates changes, keeps done", async () => {
    const db = setup();
    db.prepare("INSERT INTO mailbox_state (account_id, mailbox, uid_validity, last_uid, updated_at) VALUES ('a','INBOX',1,99,'t')").run();
    const fresh = mail(db, 1);
    const alsoFresh = mail(db, 2);
    const doneAlready = mail(db, 3);
    mail(db, 4, { seenAt: new Date(NOW.getTime() - 40 * DAY) }); // outside the 30-day window
    mail(db, 5, { uv: 7 }); // other UIDVALIDITY
    mail(db, 6, { folder: "Junk" }); // other folder
    setDone(db, doneAlready, true, "t");
    upsertSeen(db, alsoFresh, true, "t");
    const port = new FlagPort();
    port.flags = new Map([[1, true], [2, false], [3, true]]);
    const res = await refreshSeenFlags(asPort(port), db, { accountId: "a", folder: "INBOX", now: NOW });
    assert.deepEqual(port.calls, [["INBOX", [1, 2, 3]]]);
    assert.deepEqual(res, { checked: 3, changed: 3 });
    assert.equal(readEmailStatus(db, fresh).seen, true);
    assert.equal(readEmailStatus(db, alsoFresh).seen, false, "the provider can mark a mail unread again");
    assert.deepEqual(readEmailStatus(db, doneAlready), { seen: true, done: true });
    // second run with the same flags changes nothing
    const again = await refreshSeenFlags(asPort(port), db, { accountId: "a", folder: "INBOX", now: NOW });
    assert.deepEqual(again, { checked: 3, changed: 0 });
  });

  test("works in chunks, skips ports without fetchFlags and folders without a checkpoint, ignores unknown UIDs", async () => {
    const db = setup();
    for (let u = 1; u <= 5; u++) mail(db, u);
    const port = new FlagPort();
    port.flags = new Map([[1, true], [5, true], [777, true]]);
    assert.deepEqual(await refreshSeenFlags(asPort(port), db, { accountId: "a", folder: "INBOX", now: NOW }), { checked: 0, changed: 0 });
    assert.deepEqual(port.calls, [], "no mailbox_state, no UIDVALIDITY, nothing to ask");
    db.prepare("INSERT INTO mailbox_state (account_id, mailbox, uid_validity, last_uid, updated_at) VALUES ('a','INBOX',1,5,'t')").run();
    const res = await refreshSeenFlags(asPort(port), db, { accountId: "a", folder: "INBOX", now: NOW, chunk: 2 });
    assert.deepEqual(port.calls.map((c) => c[1]), [[1, 2], [3, 4], [5]]);
    assert.deepEqual(res, { checked: 5, changed: 2 });
    assert.deepEqual(await refreshSeenFlags({} as ImapPort, db, { accountId: "a", folder: "INBOX", now: NOW }), { checked: 0, changed: 0 });
  });
});
