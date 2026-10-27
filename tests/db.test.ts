import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  accounts: ["id", "label", "host", "port", "mailbox", "spam_mailbox", "enabled", "color"],
  email_status: ["email_id", "seen", "done", "updated_at"],
  mailbox_actions: [
    "id", "email_id", "location_id", "rule", "action", "mode", "status", "failure_code", "reason_json", "created_at", "done_at",
  ],
  feedback: ["id", "email_id", "classification_id", "kind", "value_json", "actor", "created_at"],
  senders: [
    "id", "address", "domain", "first_seen_at", "last_seen_at", "mails_seen", "marked_spam", "marked_not_spam",
    "jev_spam_count", "dmarc_pass", "hitl_asked_at", "hitl_asked_count",
  ],
  sender_rules: ["id", "kind", "match", "value", "account_id", "source", "active", "created_at"],
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
  user_state: ["key", "value_json", "updated_at"],
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
  test("every migration equals the DDL block of its section in docs/erd.md (whitespace-normalised)", () => {
    const md = readFileSync(join(root, "docs", "erd.md"), "utf8");
    const sections = [...md.matchAll(/^## DDL \(`db\/migrations\/([^`]+)`\)\n([\s\S]*?)(?=^## |(?![\s\S]))/gm)];
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
    assert.deepEqual(sections.map((m) => m[1]).sort(), files, "one DDL section per migration file");
    for (const m of sections) {
      const blocks = [...m[2].matchAll(/```sql\n([\s\S]*?)```/g)];
      assert.equal(blocks.length, 1, m[1]);
      assert.equal(norm(readFileSync(join(MIGRATIONS_DIR, m[1]), "utf8")), norm(blocks[0][1]), m[1]);
    }
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

describe("002 email_status and accounts.color", () => {
  test("email_status -> emails, one row per mail, seen/done are 0/1, defaults are 0", () => {
    const db = fresh();
    seed(db);
    throwsSql(db, `INSERT INTO email_status (email_id,updated_at) VALUES (99,'${T}')`, /FOREIGN KEY/);
    db.exec(`INSERT INTO email_status (email_id,updated_at) VALUES (1,'${T}')`);
    assert.deepEqual({ ...db.prepare("SELECT seen, done FROM email_status WHERE email_id = 1").get() }, { seen: 0, done: 0 });
    throwsSql(db, `INSERT INTO email_status (email_id,updated_at) VALUES (1,'${T}')`, /UNIQUE|PRIMARY/);
    db.exec("DELETE FROM email_status");
    throwsSql(db, `INSERT INTO email_status (email_id,seen,updated_at) VALUES (1,2,'${T}')`, /CHECK/);
    throwsSql(db, `INSERT INTO email_status (email_id,done,updated_at) VALUES (1,-1,'${T}')`, /CHECK/);
  });
  test("accounts.color is optional and only #rrggbb in lower case", () => {
    const db = fresh();
    db.exec(`INSERT INTO accounts (id,label,host,port,mailbox) VALUES ('n','l','h',993,'INBOX')`);
    db.exec(`INSERT INTO accounts (id,label,host,port,mailbox,color) VALUES ('c','l','h',993,'INBOX','#0a1b2c')`);
    for (const bad of ["red", "#fff", "#0A1B2C", "#0a1b2g", "0a1b2c", "#0a1b2c0"]) {
      throwsSql(db, `INSERT INTO accounts (id,label,host,port,mailbox,color) VALUES ('x','l','h',993,'INBOX','${bad}')`, /CHECK/);
    }
    assert.equal((db.prepare("SELECT color FROM accounts WHERE id = 'n'").get() as { color: string | null }).color, null);
  });
  test("a database that only has 001 upgrades without losing rows", () => {
    const dir = join(tmp, "migs-001-only");
    mkdirSync(dir);
    writeFileSync(join(dir, "001_init.sql"), readFileSync(join(MIGRATIONS_DIR, "001_init.sql"), "utf8"));
    const path = join(tmp, "upgrade.db");
    const old = openDatabase(path, dir);
    seed(old);
    old.close();
    const db = openDatabase(path);
    opened.push(db);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM emails").get() as { n: number }).n, 1);
    assert.deepEqual((db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as { version: number }[]).map((r) => r.version), [1, 2, 3, 4, 5]);
    db.exec(`INSERT INTO email_status (email_id,seen,updated_at) VALUES (1,1,'${T}')`);
  });
});

describe("003 mailbox_actions", () => {
  const ins = (cols: string, vals: string) => `INSERT INTO mailbox_actions (email_id,location_id,${cols},created_at) VALUES (1,1,${vals},'${T}')`;
  const base = "'spam_seen','mark_seen','dry_run','planned'";
  function withLocation(): DatabaseSync {
    const db = fresh();
    seed(db);
    db.exec(`INSERT INTO email_locations (email_id,account_id,folder,uid_validity,uid,first_seen_at,last_seen_at) VALUES (1,'a1','INBOX',1,1,'${T}','${T}')`);
    return db;
  }
  test("foreign keys, CHECK lists and the rule/action pairing", () => {
    const db = withLocation();
    throwsSql(db, `INSERT INTO mailbox_actions (email_id,location_id,rule,action,mode,status,created_at) VALUES (99,1,${base},'${T}')`, /FOREIGN KEY/);
    throwsSql(db, `INSERT INTO mailbox_actions (email_id,location_id,rule,action,mode,status,created_at) VALUES (1,99,${base},'${T}')`, /FOREIGN KEY/);
    const cols = "rule,action,mode,status";
    throwsSql(db, ins(cols, "'bogus','mark_seen','dry_run','planned'"), /CHECK/);
    throwsSql(db, ins(cols, "'spam_seen','delete','dry_run','planned'"), /CHECK/);
    throwsSql(db, ins(cols, "'spam_seen','mark_seen','maybe','planned'"), /CHECK/);
    throwsSql(db, ins(cols, "'spam_seen','mark_seen','dry_run','weird'"), /CHECK/);
    throwsSql(db, ins(cols, "'spam_seen','unmark_seen','live','done'"), /CHECK/); // undo action needs rule undo
    throwsSql(db, ins(cols, "'undo','mark_seen','live','done'"), /CHECK/);
    throwsSql(db, ins(cols, "'spam_seen','mark_seen','live','failed'"), /CHECK/); // failed needs a failure_code
    throwsSql(db, ins(`${cols},reason_json`, `${base},'{nope'`), /CHECK/);
    db.exec(ins(cols, base));
    db.exec(ins("rule,action,mode,status,failure_code", "'undo','unmark_seen','live','failed','store_rejected'"));
    // M7 values are accepted now (an SQLite CHECK cannot be altered later)
    for (const [r, a] of [["blacklist", "move_trash"], ["quarantine", "move_quarantine"], ["purge", "move_trash"], ["undo", "move_inbox"]]) {
      db.exec(`DELETE FROM mailbox_actions WHERE rule = '${r}'`);
      db.exec(ins(cols, `'${r}','${a}','dry_run','planned'`));
    }
    assert.deepEqual({ ...db.prepare("SELECT reason_json FROM mailbox_actions WHERE id = 1").get() }, { reason_json: "{}" });
  });
  test("at most one non-undo action per mail and rule; undo rows may repeat", () => {
    const db = withLocation();
    const cols = "rule,action,mode,status";
    db.exec(ins(cols, base));
    throwsSql(db, ins(cols, "'spam_seen','mark_seen','live','done'"), /UNIQUE/);
    db.exec(ins(cols, "'quarantine','move_quarantine','dry_run','planned'"));
    db.exec(ins(cols, "'undo','unmark_seen','live','done'"));
    db.exec(ins(cols, "'undo','unmark_seen','live','done'"));
  });
  test("a database with 001 and 002 only upgrades", () => {
    const dir = join(tmp, "migs-002-only");
    mkdirSync(dir);
    for (const f of ["001_init.sql", "002_status_and_account_color.sql"]) writeFileSync(join(dir, f), readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    const path = join(tmp, "upgrade2.db");
    const old = openDatabase(path, dir);
    seed(old);
    old.close();
    const db = openDatabase(path);
    opened.push(db);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM emails").get() as { n: number }).n, 1);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM mailbox_actions").get() as { n: number }).n, 0);
  });
});

describe("005 user_state", () => {
  test("key is unique, value_json must be valid JSON, nothing references a mail", () => {
    const db = fresh();
    db.exec(`INSERT INTO user_state (key,value_json,updated_at) VALUES ('last_opened_at','{"at":"${T}"}','${T}')`);
    throwsSql(db, `INSERT INTO user_state (key,value_json,updated_at) VALUES ('last_opened_at','{}','${T}')`, /UNIQUE|PRIMARY/);
    throwsSql(db, `INSERT INTO user_state (key,value_json,updated_at) VALUES ('x','{nope','${T}')`, /CHECK/);
    throwsSql(db, `INSERT INTO user_state (key,updated_at) VALUES ('y','${T}')`, /NOT NULL/);
  });
  test("a database with 001 to 003 only upgrades", () => {
    const dir = join(tmp, "migs-003-only");
    mkdirSync(dir);
    for (const f of ["001_init.sql", "002_status_and_account_color.sql", "003_mailbox_actions.sql"]) writeFileSync(join(dir, f), readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    const path = join(tmp, "upgrade3.db");
    const old = openDatabase(path, dir);
    seed(old);
    old.close();
    const db = openDatabase(path);
    opened.push(db);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM user_state").get() as { n: number }).n, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM emails").get() as { n: number }).n, 1);
  });
});

describe("004 feedback, senders, sender_rules", () => {
  const fb = (kind: string, extra = "") =>
    `INSERT INTO feedback (email_id,kind,actor,created_at${extra ? ",value_json" : ""}) VALUES (1,'${kind}','nico','${T}'${extra ? `,'${extra}'` : ""})`;
  test("feedback: foreign keys, kind and actor lists, json check, default value", () => {
    const db = fresh();
    seed(db);
    throwsSql(db, `INSERT INTO feedback (email_id,kind,actor,created_at) VALUES (99,'not_spam','nico','${T}')`, /FOREIGN KEY/);
    throwsSql(db, `INSERT INTO feedback (email_id,classification_id,kind,actor,created_at) VALUES (1,99,'not_spam','nico','${T}')`, /FOREIGN KEY/);
    throwsSql(db, fb("bogus"), /CHECK/);
    throwsSql(db, `INSERT INTO feedback (email_id,kind,actor,created_at) VALUES (1,'not_spam','robot','${T}')`, /CHECK/);
    throwsSql(db, fb("category_wrong", "{nope"), /CHECK/);
    for (const k of ["spam_correct", "not_spam", "category_wrong", "reply_needed", "no_reply_needed"]) db.exec(fb(k));
    db.exec(`INSERT INTO feedback (email_id,classification_id,kind,actor,created_at) VALUES (1,1,'not_spam','nico','${T}')`);
    assert.deepEqual({ ...db.prepare("SELECT value_json FROM feedback WHERE id = 1").get() }, { value_json: "{}" });
  });
  test("senders: unique lower-case address, non-negative counters, defaults", () => {
    const db = fresh();
    const ins = (a: string, d: string, extra = "") => `INSERT INTO senders (address,domain,first_seen_at,last_seen_at${extra ? "," + extra.split("=")[0] : ""}) VALUES ('${a}','${d}','${T}','${T}'${extra ? "," + extra.split("=")[1] : ""})`;
    db.exec(ins("a@x.test", "x.test"));
    throwsSql(db, ins("a@x.test", "x.test"), /UNIQUE/);
    throwsSql(db, ins("A@x.test", "x.test"), /CHECK/);
    throwsSql(db, ins("b@x.test", "X.test"), /CHECK/);
    for (const c of ["mails_seen", "marked_spam", "marked_not_spam", "jev_spam_count", "dmarc_pass", "hitl_asked_count"]) {
      throwsSql(db, ins("c@x.test", "x.test", `${c}=-1`), /CHECK/);
    }
    assert.deepEqual({ ...db.prepare("SELECT mails_seen,marked_spam,marked_not_spam,jev_spam_count,dmarc_pass,hitl_asked_at,hitl_asked_count FROM senders").get() },
      { mails_seen: 0, marked_spam: 0, marked_not_spam: 0, jev_spam_count: 0, dmarc_pass: 0, hitl_asked_at: null, hitl_asked_count: 0 });
  });
  test("sender_rules: CHECK lists, foreign key, uniqueness also without an account", () => {
    const db = fresh();
    seed(db);
    const ins = (kind: string, match: string, value: string, acc: string | null, source = "nico") =>
      `INSERT INTO sender_rules (kind,"match",value,account_id,source,created_at) VALUES ('${kind}','${match}','${value}',${acc === null ? "NULL" : `'${acc}'`},'${source}','${T}')`;
    throwsSql(db, ins("greylist", "domain", "x.test", null), /CHECK/);
    throwsSql(db, ins("blacklist", "host", "x.test", null), /CHECK/);
    throwsSql(db, ins("blacklist", "domain", "X.test", null), /CHECK/);
    throwsSql(db, ins("blacklist", "domain", "", null), /CHECK/);
    throwsSql(db, ins("blacklist", "domain", "x.test", null, "agent"), /CHECK/);
    throwsSql(db, ins("blacklist", "domain", "x.test", "nope"), /FOREIGN KEY/);
    db.exec(ins("blacklist", "domain", "x.test", null));
    throwsSql(db, ins("blacklist", "domain", "x.test", null), /UNIQUE/); // NULL account must not defeat uniqueness
    db.exec(ins("blacklist", "domain", "x.test", "a1"));
    throwsSql(db, ins("blacklist", "domain", "x.test", "a1"), /UNIQUE/);
    db.exec(ins("allowlist", "domain", "x.test", null));
    db.exec(ins("blacklist", "address", "a@x.test", null, "suggested_confirmed"));
    assert.deepEqual({ ...db.prepare("SELECT active FROM sender_rules WHERE id = 1").get() }, { active: 1 });
    throwsSql(db, `UPDATE sender_rules SET active = 2 WHERE id = 1`, /CHECK/);
  });
  test("the migration backfills senders from existing mails (addresses only, no subjects)", () => {
    const dir = join(tmp, "migs-003-only-004");
    mkdirSync(dir);
    for (const f of ["001_init.sql", "002_status_and_account_color.sql", "003_mailbox_actions.sql"]) writeFileSync(join(dir, f), readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    const path = join(tmp, "upgrade3-004.db");
    const old = openDatabase(path, dir);
    seed(old);
    old.exec(`INSERT INTO emails (id,account_id,message_id,sender,subject,received_at,first_seen_at) VALUES
      (2,'a1','<m2@x>','s@x.test','s2','${T}','2026-10-27T10:00:00.000Z'),
      (3,'a1','<m3@x>','other@y.test','s3','${T}','${T}'),
      (4,'a1','<m4@x>','broken','s4','${T}','${T}')`);
    old.close();
    const db = openDatabase(path);
    opened.push(db);
    assert.deepEqual(
      db.prepare("SELECT address,domain,first_seen_at,last_seen_at,mails_seen,jev_spam_count FROM senders ORDER BY address").all().map((r) => ({ ...r })),
      [
        { address: "other@y.test", domain: "y.test", first_seen_at: T, last_seen_at: T, mails_seen: 1, jev_spam_count: 0 },
        { address: "s@x.test", domain: "x.test", first_seen_at: T, last_seen_at: "2026-10-27T10:00:00.000Z", mails_seen: 2, jev_spam_count: 0 },
      ],
    );
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
    assert.deepEqual(rows.map((r) => r.version), [1, 2, 3, 4, 5]);
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
