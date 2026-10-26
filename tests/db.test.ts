import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { MIGRATIONS_DIR, openDatabase } from "../lib/db.ts";

const root = join(import.meta.dirname, "..");
let tmp: string;
let counter = 0;
const opened: DatabaseSync[] = [];

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "email-agent-db-"));
});
after(() => {
  for (const d of opened) {
    try {
      d.close();
    } catch {
      // already closed
    }
  }
  rmSync(tmp, { recursive: true, force: true });
});

function fresh(): DatabaseSync {
  const db = openDatabase(join(tmp, `t${counter++}.db`));
  opened.push(db);
  return db;
}

function throwsSql(db: DatabaseSync, sql: string, pattern: RegExp): void {
  assert.throws(() => db.exec(sql), pattern, sql);
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

const ALLOWLIST: Record<string, string[]> = {
  accounts: ["id", "label", "host", "port", "mailbox", "spam_mailbox", "enabled"],
  mailbox_state: ["account_id", "mailbox", "uid_validity", "last_uid", "updated_at"],
  worker_status: [
    "account_id",
    "state",
    "error_code",
    "last_event_at",
    "last_poll_at",
    "updated_at",
  ],
  emails: ["id", "account_id", "message_id", "sender", "subject", "received_at", "first_seen_at"],
  email_locations: [
    "id",
    "email_id",
    "account_id",
    "folder",
    "uid_validity",
    "uid",
    "is_active",
    "first_seen_at",
    "last_seen_at",
  ],
  classifications: [
    "id",
    "email_id",
    "question_set_version",
    "model_requested",
    "model_reported",
    "status",
    "failure_code",
    "attempts",
    "next_attempt_at",
    "latency_ms",
    "created_at",
    "updated_at",
  ],
  classification_answers: [
    "id",
    "classification_id",
    "question_key",
    "type",
    "answer_json",
    "probabilities_json",
  ],
  audit_log: [
    "id",
    "occurred_at",
    "trace_id",
    "actor",
    "action",
    "account_id",
    "email_id",
    "details_json",
  ],
  schema_migrations: ["version", "applied_at"],
};

const T = "2026-10-26T19:48:46.692Z";

function seed(db: DatabaseSync): void {
  db.exec(`
    INSERT INTO accounts (id, label, host, port, mailbox) VALUES ('a1','A','h',993,'INBOX'), ('a2','B','h',993,'INBOX');
    INSERT INTO emails (id, account_id, message_id, sender, subject, received_at, first_seen_at)
      VALUES (1,'a1','<m1@x>','s@x.test','s','${T}','${T}');
    INSERT INTO classifications (id, email_id, question_set_version, model_requested, status, created_at, updated_at)
      VALUES (1,1,'v1','m','pending','${T}','${T}');
  `);
}

describe("DDL", () => {
  test("001_init.sql equals the DDL block in docs/erd.md (whitespace-normalised)", () => {
    const md = readFileSync(join(root, "docs", "erd.md"), "utf8");
    const section = md.slice(md.search(/^## DDL/m));
    const blocks = [...section.matchAll(/```sql\n([\s\S]*?)```/g)];
    assert.equal(blocks.length, 1);
    const sql = readFileSync(join(MIGRATIONS_DIR, "001_init.sql"), "utf8");
    assert.equal(norm(sql), norm(blocks[0][1]));
  });

  test("column sets match allowlist and contain no content columns", () => {
    const db = fresh();
    const tables = (db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[]).map((r) => r.name).sort();
    assert.deepEqual(tables, Object.keys(ALLOWLIST).sort());
    const bad = /(^|_)(body|snippet|excerpt|raw|attachment|html|content|spam_threshold)($|_)/i;
    for (const t of tables) {
      const cols = (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) =>
        c.name
      );
      assert.deepEqual([...cols].sort(), [...ALLOWLIST[t]].sort(), t);
      for (const c of cols) assert.doesNotMatch(c, bad, `${t}.${c}`);
    }
  });
});

describe("pragmas", () => {
  test("active on every opened connection", () => {
    for (let i = 0; i < 3; i++) {
      const db = fresh();
      assert.equal((db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys, 1);
      assert.equal((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, "wal");
      assert.equal((db.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout, 5000);
    }
    // reopening an existing file also sets them
    const path = join(tmp, "reopen.db");
    opened.push(openDatabase(path));
    const again = openDatabase(path);
    opened.push(again);
    assert.equal((again.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys, 1);
    assert.equal((again.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout, 5000);
  });
});

describe("foreign keys", () => {
  test("mailbox_state -> accounts", () => {
    throwsSql(
      fresh(),
      `INSERT INTO mailbox_state VALUES ('nope','INBOX',1,0,'${T}')`,
      /FOREIGN KEY/,
    );
  });
  test("worker_status -> accounts", () => {
    throwsSql(
      fresh(),
      `INSERT INTO worker_status (account_id,state,updated_at) VALUES ('nope','paused','${T}')`,
      /FOREIGN KEY/,
    );
  });
  test("emails -> accounts", () => {
    throwsSql(
      fresh(),
      `INSERT INTO emails (account_id,sender,subject,received_at,first_seen_at) VALUES ('nope','s','s','${T}','${T}')`,
      /FOREIGN KEY/,
    );
  });
  test("email_locations -> accounts", () => {
    const db = fresh();
    seed(db);
    throwsSql(
      db,
      `INSERT INTO email_locations (email_id,account_id,folder,uid_validity,uid,first_seen_at,last_seen_at) VALUES (1,'nope','INBOX',1,1,'${T}','${T}')`,
      /FOREIGN KEY/,
    );
  });
  test("composite FK: location of a foreign account is rejected", () => {
    const db = fresh();
    seed(db);
    throwsSql(
      db,
      `INSERT INTO email_locations (email_id,account_id,folder,uid_validity,uid,first_seen_at,last_seen_at) VALUES (1,'a2','INBOX',1,1,'${T}','${T}')`,
      /FOREIGN KEY/,
    );
    db.exec(
      `INSERT INTO email_locations (email_id,account_id,folder,uid_validity,uid,first_seen_at,last_seen_at) VALUES (1,'a1','INBOX',1,1,'${T}','${T}')`,
    );
  });
  test("classifications -> emails", () => {
    throwsSql(
      fresh(),
      `INSERT INTO classifications (email_id,question_set_version,model_requested,status,created_at,updated_at) VALUES (99,'v','m','pending','${T}','${T}')`,
      /FOREIGN KEY/,
    );
  });
  test("classification_answers -> classifications", () => {
    throwsSql(
      fresh(),
      `INSERT INTO classification_answers (classification_id,question_key,type,answer_json) VALUES (99,'k','score','1')`,
      /FOREIGN KEY/,
    );
  });
  test("audit_log -> accounts and emails", () => {
    const db = fresh();
    throwsSql(
      db,
      `INSERT INTO audit_log (occurred_at,trace_id,actor,action,account_id) VALUES ('${T}','t','system','x','nope')`,
      /FOREIGN KEY/,
    );
    throwsSql(
      db,
      `INSERT INTO audit_log (occurred_at,trace_id,actor,action,email_id) VALUES ('${T}','t','system','x',99)`,
      /FOREIGN KEY/,
    );
  });
});

describe("UNIQUE", () => {
  test("accounts primary key", () => {
    const db = fresh();
    seed(db);
    throwsSql(db, `INSERT INTO accounts (id,label,host,port,mailbox) VALUES ('a1','x','h',1,'m')`, /UNIQUE|PRIMARY KEY/);
  });
  test("mailbox_state primary key (account_id, mailbox)", () => {
    const db = fresh();
    seed(db);
    db.exec(`INSERT INTO mailbox_state VALUES ('a1','INBOX',1,0,'${T}')`);
    throwsSql(db, `INSERT INTO mailbox_state VALUES ('a1','INBOX',2,0,'${T}')`, /UNIQUE|PRIMARY KEY/);
  });
  test("worker_status primary key", () => {
    const db = fresh();
    seed(db);
    db.exec(`INSERT INTO worker_status (account_id,state,updated_at) VALUES ('a1','paused','${T}')`);
    throwsSql(db, `INSERT INTO worker_status (account_id,state,updated_at) VALUES ('a1','paused','${T}')`, /UNIQUE|PRIMARY KEY/);
  });
  test("emails (account_id, message_id); NULL message_id may repeat", () => {
    const db = fresh();
    seed(db);
    throwsSql(
      db,
      `INSERT INTO emails (account_id,message_id,sender,subject,received_at,first_seen_at) VALUES ('a1','<m1@x>','s','s','${T}','${T}')`,
      /UNIQUE/,
    );
    const ins = `INSERT INTO emails (account_id,message_id,sender,subject,received_at,first_seen_at) VALUES ('a1',NULL,'s','s','${T}','${T}')`;
    db.exec(ins);
    db.exec(ins);
    // same message_id in another account is fine
    db.exec(
      `INSERT INTO emails (account_id,message_id,sender,subject,received_at,first_seen_at) VALUES ('a2','<m1@x>','s','s','${T}','${T}')`,
    );
  });
  test("emails (id, account_id) is a unique parent key", () => {
    const row = fresh()
      .prepare("SELECT sql FROM sqlite_master WHERE name='emails'")
      .get() as { sql: string };
    assert.match(row.sql, /UNIQUE \(id, account_id\)/);
  });
  test("email_locations (account_id, folder, uid_validity, uid)", () => {
    const db = fresh();
    seed(db);
    const ins = `INSERT INTO email_locations (email_id,account_id,folder,uid_validity,uid,first_seen_at,last_seen_at) VALUES (1,'a1','INBOX',1,1,'${T}','${T}')`;
    db.exec(ins);
    throwsSql(db, ins, /UNIQUE/);
  });
  test("classifications (email_id, question_set_version, model_requested)", () => {
    const db = fresh();
    seed(db);
    throwsSql(
      db,
      `INSERT INTO classifications (email_id,question_set_version,model_requested,status,created_at,updated_at) VALUES (1,'v1','m','pending','${T}','${T}')`,
      /UNIQUE/,
    );
  });
  test("classification_answers (classification_id, question_key)", () => {
    const db = fresh();
    seed(db);
    const ins = `INSERT INTO classification_answers (classification_id,question_key,type,answer_json) VALUES (1,'k','score','1')`;
    db.exec(ins);
    throwsSql(db, ins, /UNIQUE/);
  });
});

describe("CHECK and json_valid", () => {
  test("accounts.port range and enabled", () => {
    const db = fresh();
    throwsSql(db, `INSERT INTO accounts (id,label,host,port,mailbox) VALUES ('x','l','h',0,'m')`, /CHECK/);
    throwsSql(db, `INSERT INTO accounts (id,label,host,port,mailbox) VALUES ('x','l','h',65536,'m')`, /CHECK/);
    throwsSql(db, `INSERT INTO accounts (id,label,host,port,mailbox,enabled) VALUES ('x','l','h',1,'m',2)`, /CHECK/);
  });
  test("mailbox_state.last_uid >= 0", () => {
    const db = fresh();
    seed(db);
    throwsSql(db, `INSERT INTO mailbox_state VALUES ('a1','INBOX',1,-1,'${T}')`, /CHECK/);
  });
  test("worker_status.state enum", () => {
    const db = fresh();
    seed(db);
    throwsSql(db, `INSERT INTO worker_status (account_id,state,updated_at) VALUES ('a1','bogus','${T}')`, /CHECK/);
  });
  test("email_locations.is_active", () => {
    const db = fresh();
    seed(db);
    throwsSql(
      db,
      `INSERT INTO email_locations (email_id,account_id,folder,uid_validity,uid,is_active,first_seen_at,last_seen_at) VALUES (1,'a1','INBOX',1,1,2,'${T}','${T}')`,
      /CHECK/,
    );
  });
  test("classifications.status enum, attempts, latency_ms", () => {
    const db = fresh();
    seed(db);
    const base = (extra: string, vals: string) =>
      `INSERT INTO classifications (email_id,question_set_version,model_requested,created_at,updated_at,${extra}) VALUES (1,'v2','m','${T}','${T}',${vals})`;
    throwsSql(db, base("status", `'bogus'`), /CHECK/);
    throwsSql(db, base("status,attempts", `'pending',-1`), /CHECK/);
    throwsSql(db, base("status,latency_ms", `'pending',-1`), /CHECK/);
  });
  test("classifications: classified requires model_reported; failed requires failure_code", () => {
    const db = fresh();
    seed(db);
    const base = (status: string) =>
      `INSERT INTO classifications (email_id,question_set_version,model_requested,status,created_at,updated_at) VALUES (1,'v3','m','${status}','${T}','${T}')`;
    throwsSql(db, base("classified"), /CHECK/);
    throwsSql(db, base("failed"), /CHECK/);
  });
  test("classification_answers.type enum and json_valid", () => {
    const db = fresh();
    seed(db);
    throwsSql(db, `INSERT INTO classification_answers (classification_id,question_key,type,answer_json) VALUES (1,'k','bogus','1')`, /CHECK/);
    throwsSql(db, `INSERT INTO classification_answers (classification_id,question_key,type,answer_json) VALUES (1,'k','score','{nope')`, /CHECK/);
    throwsSql(db, `INSERT INTO classification_answers (classification_id,question_key,type,answer_json,probabilities_json) VALUES (1,'k','score','1','{nope')`, /CHECK/);
    db.exec(`INSERT INTO classification_answers (classification_id,question_key,type,answer_json,probabilities_json) VALUES (1,'k','score','1',NULL)`);
  });
  test("audit_log.actor enum and details_json json_valid", () => {
    const db = fresh();
    throwsSql(db, `INSERT INTO audit_log (occurred_at,trace_id,actor,action) VALUES ('${T}','t','bogus','x')`, /CHECK/);
    throwsSql(db, `INSERT INTO audit_log (occurred_at,trace_id,actor,action,details_json) VALUES ('${T}','t','system','x','{nope')`, /CHECK/);
  });
});

describe("audit_log append-only triggers", () => {
  test("UPDATE and DELETE are aborted", () => {
    const db = fresh();
    db.exec(`INSERT INTO audit_log (occurred_at,trace_id,actor,action) VALUES ('${T}','t','system','x')`);
    throwsSql(db, `UPDATE audit_log SET action='y'`, /append-only/);
    throwsSql(db, `DELETE FROM audit_log`, /append-only/);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number }).n, 1);
  });
});

describe("migration runner", () => {
  test("idempotent: reopening applies nothing twice", () => {
    const path = join(tmp, "idem.db");
    const a = openDatabase(path);
    opened.push(a);
    a.close();
    const b = openDatabase(path);
    opened.push(b);
    const rows = b.prepare("SELECT version FROM schema_migrations").all() as { version: number }[];
    assert.deepEqual(rows.map((r) => r.version), [1]);
  });

  test("numeric (not lexical) order, applied once", () => {
    const dir = join(tmp, "migs");
    mkdirSync(dir);
    writeFileSync(join(dir, "10_c.sql"), "CREATE TABLE c (x INTEGER); INSERT INTO log VALUES ('c');");
    writeFileSync(join(dir, "2_b.sql"), "CREATE TABLE log (v TEXT); INSERT INTO log VALUES ('b');");
    writeFileSync(join(dir, "001_a.sql"), "CREATE TABLE a (x INTEGER);");
    writeFileSync(join(dir, "notes.txt"), "ignored");
    const path = join(tmp, "order.db");
    const db = openDatabase(path, dir);
    opened.push(db);
    assert.deepEqual(
      (db.prepare("SELECT version FROM schema_migrations ORDER BY applied_at, version").all() as { version: number }[]).map((r) => r.version),
      [1, 2, 10],
    );
    assert.deepEqual((db.prepare("SELECT v FROM log ORDER BY rowid").all() as { v: string }[]).map((r) => r.v), ["b", "c"]);
    db.close();
    const again = openDatabase(path, dir);
    opened.push(again);
    assert.equal((again.prepare("SELECT COUNT(*) AS n FROM log").get() as { n: number }).n, 2);
  });

  test("failing migration rolls back and is not recorded", () => {
    const dir = join(tmp, "migs-bad");
    mkdirSync(dir);
    writeFileSync(join(dir, "001_bad.sql"), "CREATE TABLE ok (x INTEGER); SELECT * FROM missing_table;");
    const path = join(tmp, "bad.db");
    assert.throws(() => openDatabase(path, dir));
  });
});
