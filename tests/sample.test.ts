import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openDatabase } from "../lib/db.ts";
import { syncAccounts } from "../lib/accounts.ts";
import type { ImapPort } from "../lib/imap.ts";
import type { JevCallResult } from "../lib/jev.ts";
import { JEV_MODEL, QUESTION_SET_VERSION } from "../lib/constants.ts";
import { parseSampleArgs, runSample, SampleError, type SampleProgress } from "../tools/sample.ts";

const BODY_MARK = "BODY-MARKER-5D1E";
const fixture = () => JSON.parse(readFileSync(new URL("./fixtures/jev-email-v1-response.json", import.meta.url), "utf8"));
const ok = (): JevCallResult => ({ ok: true, response: fixture() as never });
const account = { id: "a", mailbox: "INBOX", spam_mailbox: "Spam", spam_threshold: 0.9, context: "c" };

type Msg = { uid: number; id: string };
function src(id: string) {
  return Buffer.from(`From: s@example.test\r\nSubject: s ${id}\r\nMessage-ID: <${id}>\r\nDate: Mon, 26 Oct 2026 10:00:00 +0000\r\n\r\n${BODY_MARK}\r\n`);
}

function setup(folders: Record<string, Msg[]>, jevResults: JevCallResult[] = [], serverFolders?: { path: string; specialUse?: string }[]) {
  const db = openDatabase(":memory:");
  syncAccounts(db, [{
    id: "a", label: "a", context: "c", host: "h", port: 993, tls: true, user: "u", password: "p",
    mailbox: "INBOX", spam_mailbox: "Spam", spam_threshold: 0.9, enabled: true,
  } as never]);
  const fetched: string[] = [];
  const jevCalls: number[] = [];
  const jev = { classify: async () => { jevCalls.push(1); return jevResults.shift() ?? ok(); } };
  const readOnly = new Set(["connect", "close", "mailboxStatus", "fetchHeadersSince", "fetchMessageByUid", "listFolders"]);
  const port = new Proxy({
    connect: async () => {}, close: async () => {},
    ...(serverFolders ? { listFolders: async () => serverFolders } : {}),
    mailboxStatus: async () => ({ uidValidity: 1, highestUid: 999 }),
    fetchHeadersSince: async (f: string) => (folders[f] ?? []).map((m) => ({ uid: m.uid, messageId: `<${m.id}>` })),
    fetchMessageByUid: async (f: string, uid: number) => {
      fetched.push(`${f}:${uid}`);
      const m = (folders[f] ?? []).find((x) => x.uid === uid);
      return m ? { uid, source: src(m.id) } : null;
    },
  }, { get(t, p) { if (!readOnly.has(String(p))) throw new Error(`mailbox write attempted: ${String(p)}`); return (t as never)[p]; } }) as unknown as ImapPort;
  const deps = { db, account, port, portFactory: () => port, jev };
  return { db, deps, fetched, jevCalls };
}
const n = (db: ReturnType<typeof openDatabase>, sql: string) => (db.prepare(sql).get() as { n: number }).n;
const mk = (prefix: string, count: number): Msg[] => Array.from({ length: count }, (_, i) => ({ uid: i + 1, id: `${prefix}${i + 1}` }));

describe("sample preview", () => {
  test("counts last N per folder, no Jev call, no import, audit sample_previewed", async () => {
    const s = setup({ INBOX: mk("i", 3), Spam: mk("s", 1) });
    const r = await runSample(s.deps, { limitPerFolder: 2 });
    assert.equal(r.mode, "preview");
    assert.deepEqual(r.selected, { mailbox: 2, spam_mailbox: 1 });
    assert.equal(r.total, 3);
    assert.equal(s.jevCalls.length, 0);
    assert.equal(n(s.db, "SELECT COUNT(*) n FROM emails"), 0);
    const a = s.db.prepare("SELECT actor, action, details_json FROM audit_log").all();
    assert.deepEqual(a.map((x) => [x.actor, x.action]), [["sample", "sample_previewed"]]);
    assert.equal(JSON.parse(a[0].details_json as string).total, 3);
  });

  test("selects the highest UIDs", async () => {
    const s = setup({ INBOX: mk("i", 5) });
    await runSample(s.deps, { limitPerFolder: 2, confirm: 2 });
    assert.deepEqual(s.fetched.sort(), ["INBOX:4", "INBOX:5"]);
  });
});

describe("sample execution guards", () => {
  test("confirm must equal the preview total", async () => {
    const s = setup({ INBOX: mk("i", 2), Spam: mk("s", 1) });
    await assert.rejects(runSample(s.deps, { limitPerFolder: 5, confirm: 2 }),
      (e) => e instanceof SampleError && e.code === "confirm_mismatch");
    assert.equal(s.jevCalls.length, 0);
    assert.equal(n(s.db, "SELECT COUNT(*) n FROM audit_log WHERE action = 'sample_started'"), 0);
  });

  test("hard limit 400 blocks execution, preview reports overLimit", async () => {
    const s = setup({ INBOX: mk("i", 250), Spam: mk("s", 250) });
    const p = await runSample(s.deps, { limitPerFolder: 250 });
    assert.equal(p.overLimit, true);
    assert.equal(p.total, 500);
    await assert.rejects(runSample(s.deps, { limitPerFolder: 250, confirm: 500 }),
      (e) => e instanceof SampleError && e.code === "limit_exceeded");
    assert.equal(s.jevCalls.length, 0);
  });

  test("unknown question set aborts", async () => {
    const s = setup({ INBOX: mk("i", 1) });
    await assert.rejects(runSample(s.deps, { limitPerFolder: 1, questionSet: "nope" }),
      (e) => e instanceof SampleError && e.code === "question_set_unknown");
  });
});

describe("sample run", () => {
  test("imports and classifies incl. spam folder, aggregated progress, audit, no content stored", async () => {
    const s = setup({ INBOX: mk("i", 2), Spam: mk("s", 1) });
    const progress: SampleProgress[] = [];
    const r = await runSample({ ...s.deps, onProgress: (p) => progress.push(p) }, { limitPerFolder: 5, confirm: 3 });
    assert.equal(r.mode, "run");
    assert.equal(r.progress?.classified, 3);
    assert.equal(s.jevCalls.length, 3);
    assert.equal(n(s.db, "SELECT COUNT(*) n FROM email_locations WHERE folder = 'Spam' AND is_active = 1"), 1);
    assert.equal(r.byFolder?.spam_mailbox.classified, 1);
    assert.equal(r.byFolder?.mailbox.classified, 2);
    for (const p of progress) for (const v of Object.values(p)) assert.equal(typeof v, "number");
    assert.equal(progress.at(-1)?.done, 3);
    const audit = s.db.prepare("SELECT actor, action, details_json FROM audit_log WHERE actor = 'sample' ORDER BY id").all();
    assert.deepEqual(audit.map((x) => x.action), ["sample_started", "sample_finished"]);
    for (const a of audit) for (const v of Object.values(JSON.parse(a.details_json as string))) {
      assert.ok(typeof v === "number" || typeof v === "string" || v === null, "counts/labels only");
    }
    const dump = JSON.stringify([
      s.db.prepare("SELECT * FROM emails").all(), s.db.prepare("SELECT * FROM classification_answers").all(),
      s.db.prepare("SELECT * FROM audit_log").all(),
    ]);
    assert.ok(!dump.includes(BODY_MARK));
  });

  test("already classified mails are skipped on the next run", async () => {
    const s = setup({ INBOX: mk("i", 2) });
    await runSample(s.deps, { limitPerFolder: 5, confirm: 2 });
    const p = await runSample(s.deps, { limitPerFolder: 5 });
    assert.equal(p.wouldSkip, 2);
    const r = await runSample(s.deps, { limitPerFolder: 5, confirm: 2 });
    assert.equal(r.progress?.skipped, 2);
    assert.equal(s.jevCalls.length, 2);
  });

  test("--question-set re-evaluates mails classified under another set, body from active location", async () => {
    const s = setup({ INBOX: mk("i", 1) });
    await runSample(s.deps, { limitPerFolder: 1, confirm: 1 });
    s.db.prepare("UPDATE classifications SET question_set_version = 'old-set'").run();
    const skip = await runSample(s.deps, { limitPerFolder: 1, confirm: 1 });
    assert.equal(skip.progress?.skipped, 1);
    assert.equal(s.jevCalls.length, 1);
    s.fetched.length = 0;
    const r = await runSample(s.deps, { limitPerFolder: 1, confirm: 1, questionSet: QUESTION_SET_VERSION });
    assert.equal(r.progress?.classified, 1);
    assert.equal(s.jevCalls.length, 2);
    assert.deepEqual(s.fetched, ["INBOX:1"]);
    const rows = s.db.prepare("SELECT question_set_version v, model_requested m FROM classifications ORDER BY id").all();
    assert.deepEqual(rows.map((x) => [x.v, x.m]), [["old-set", JEV_MODEL], [QUESTION_SET_VERSION, JEV_MODEL]]);
  });

  test("Jev auth failure pauses and stops the sample", async () => {
    const s = setup({ INBOX: mk("i", 3) }, [{ ok: false, kind: "http", statusCode: 401, errorName: "Unauthorized" }]);
    const r = await runSample(s.deps, { limitPerFolder: 5, confirm: 3 });
    assert.equal(r.aborted, "jev_paused");
    assert.equal(s.jevCalls.length, 1);
  });
});

describe("sample args", () => {
  test("parses options and rejects unknown ones", () => {
    assert.deepEqual(parseSampleArgs(["--account", "a", "--limit-per-folder", "50", "--confirm", "7", "--question-set", "v"]),
      { account: "a", limitPerFolder: 50, confirm: 7, questionSet: "v" });
    assert.equal(parseSampleArgs(["--account", "a"]).limitPerFolder, 200);
    assert.throws(() => parseSampleArgs(["--account", "a", "--bogus"]), SampleError);
    assert.throws(() => parseSampleArgs([]), SampleError);
  });
});

describe("sample folder mapping", () => {
  test("RED-guard: wrong spam_mailbox name aborts with the server folder list and \\Junk hint, before any fetch", async () => {
    const s = setup({ INBOX: mk("i", 2) }, [], [
      { path: "INBOX", specialUse: "\\Inbox" }, { path: "Unerwünscht", specialUse: "\\Junk" }, { path: "Gesendet" },
    ]);
    await assert.rejects(runSample(s.deps, { limitPerFolder: 5 }), (e: unknown) => {
      assert.ok(e instanceof SampleError);
      assert.equal(e.code, "folder_not_found");
      assert.match(e.message, /spam_mailbox not found on server: "Spam"/);
      assert.match(e.message, /"Unerwünscht"  <- server marks this as spam/);
      return true;
    });
    assert.equal(s.fetched.length, 0);
    assert.equal(n(s.db, "SELECT COUNT(*) n FROM audit_log"), 0);
  });

  test("exact mapping passes and the preview proceeds", async () => {
    const s = setup({ INBOX: mk("i", 2), Spam: mk("s", 1) }, [], [{ path: "INBOX" }, { path: "Spam", specialUse: "\\Junk" }]);
    const r = await runSample(s.deps, { limitPerFolder: 5 });
    assert.deepEqual(r.selected, { mailbox: 2, spam_mailbox: 1 });
  });

  test("names are matched exactly (IMAP is case-sensitive except INBOX handling by the server)", async () => {
    const s = setup({ INBOX: mk("i", 1) }, [], [{ path: "INBOX" }, { path: "spam" }]);
    await assert.rejects(runSample(s.deps, { limitPerFolder: 5 }), /folder_not_found|not found on server/);
  });
});
