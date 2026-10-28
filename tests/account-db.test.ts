import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../lib/db.ts";
import { startup, syncAccounts, validateDatabasePath } from "../lib/accounts.ts";

const PW = "pw-SECRET-VALUE-123";
let tmp: string;
before(() => {
  tmp = mkdtempSync(join(tmpdir(), "email-agent-accdb-"));
});
after(() => rmSync(tmp, { recursive: true, force: true }));

function acc(id: string, over: Record<string, unknown> = {}) {
  return {
    id, label: `L-${id}`, context: "ctx", host: "imap.example.test", port: 993, tls: true,
    user: "u@example.test", password: PW, mailbox: "INBOX", spam_threshold: 0.8, enabled: true,
    ...over,
  } as never;
}
function mem(): DatabaseSync {
  return openDatabase(":memory:");
}
const rows = (db: DatabaseSync, sql: string) => db.prepare(sql).all().map((r) => ({ ...r })) as Record<string, unknown>[];

describe("syncAccounts", () => {
  test("color is synced like the label: set, changed and cleared by the accounts file", () => {
    const db = mem();
    const color = () => rows(db, "SELECT id, color FROM accounts ORDER BY id");
    syncAccounts(db, [acc("a", { color: "#0a1b2c" }), acc("b")]);
    assert.deepEqual(color(), [{ id: "a", color: "#0a1b2c" }, { id: "b", color: null }]);
    syncAccounts(db, [acc("a", { color: "#ffffff" }), acc("b", { color: "#000000" })]);
    assert.deepEqual(color(), [{ id: "a", color: "#ffffff" }, { id: "b", color: "#000000" }]);
    syncAccounts(db, [acc("a"), acc("b", { color: "#000000" })]);
    assert.deepEqual(color(), [{ id: "a", color: null }, { id: "b", color: "#000000" }]);
  });

  test("upserts metadata and worker_status", () => {
    const db = mem();
    syncAccounts(db, [acc("a", { spam_mailbox: "Junk" }), acc("b", { enabled: false })]);
    assert.deepEqual(rows(db, "SELECT * FROM accounts ORDER BY id"), [
      { id: "a", label: "L-a", host: "imap.example.test", port: 993, mailbox: "INBOX", spam_mailbox: "Junk", enabled: 1, color: null },
      { id: "b", label: "L-b", host: "imap.example.test", port: 993, mailbox: "INBOX", spam_mailbox: null, enabled: 0, color: null },
    ]);
    const ws = rows(db, "SELECT account_id, state FROM worker_status ORDER BY account_id");
    assert.deepEqual(ws, [{ account_id: "a", state: "connecting" }, { account_id: "b", state: "disabled" }]);
  });

  test("missing accounts are disabled, never deleted; re-sync updates", () => {
    const db = mem();
    syncAccounts(db, [acc("a"), acc("b")]);
    syncAccounts(db, [acc("a", { label: "New" })]);
    assert.deepEqual(rows(db, "SELECT id, label, enabled FROM accounts ORDER BY id"), [
      { id: "a", label: "New", enabled: 1 },
      { id: "b", label: "L-b", enabled: 0 },
    ]);
    assert.equal(rows(db, "SELECT state FROM worker_status WHERE account_id='b'")[0].state, "disabled");
    syncAccounts(db, [acc("a"), acc("b")]);
    assert.equal(rows(db, "SELECT state FROM worker_status WHERE account_id='b'")[0].state, "connecting");
  });

  test("password and spam_threshold are not stored", () => {
    const db = mem();
    syncAccounts(db, [acc("a")]);
    const dump = JSON.stringify([rows(db, "SELECT * FROM accounts"), rows(db, "SELECT * FROM worker_status")]);
    assert.ok(!dump.includes(PW));
    assert.ok(!dump.includes("0.8"));
    assert.ok(!dump.includes("u@example.test"));
  });
});

describe("validateDatabasePath / startup", () => {
  test("creates parent with mode 0700", () => {
    const p = validateDatabasePath({}, tmp);
    assert.equal(p, join(tmp, "data", "email-agent.sqlite"));
    assert.equal(statSync(join(tmp, "data")).mode & 0o777, 0o700);
  });

  test("rejects existing parent with group/other access", () => {
    const d = join(tmp, "open");
    mkdirSync(d);
    chmodSync(d, 0o755);
    assert.throws(() => validateDatabasePath({ DATABASE_PATH: join(d, "x.sqlite") }, tmp), /DATABASE_PATH/);
  });

  test("startup without accounts file: migrated, disabled", () => {
    const root = mkdtempSync(join(tmpdir(), "email-agent-accdb-root-"));
    const s = startup({ env: {}, projectRoot: root });
    assert.equal(s.config.status, "disabled");
    assert.equal(rows(s.db, "SELECT count(*) AS n FROM schema_migrations")[0].n, 4);
    s.db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("startup with accounts file syncs accounts", () => {
    const root = mkdtempSync(join(tmpdir(), "email-agent-accdb-root-"));
    mkdirSync(join(root, "data"), { mode: 0o700 });
    const f = join(root, "data", "accounts.json");
    writeFileSync(f, JSON.stringify([acc("a")]));
    chmodSync(f, 0o600);
    const s = startup({ env: {}, projectRoot: root });
    assert.equal(s.config.status, "ok");
    assert.equal(rows(s.db, "SELECT id FROM accounts")[0].id, "a");
    s.db.close();
    rmSync(root, { recursive: true, force: true });
  });
});
