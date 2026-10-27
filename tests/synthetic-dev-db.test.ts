import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../lib/db.ts";
import { syncAccounts } from "../lib/accounts.ts";
import { DEFAULT_SPAM_THRESHOLD } from "../lib/accounts-config.ts";
import { DEV_SYNTHETIC_DATABASE_PATH, JEV_MODEL, QUESTION_SET_VERSION } from "../lib/constants.ts";
import { QUESTIONS } from "../lib/jev-questions.ts";
import { normalizeAnswers, type NormalizedAnswer } from "../lib/jev-response.ts";
import { createPersistResponse } from "../lib/classification-pipeline.ts";
import { computeShadowQuarantine } from "../lib/shadow.ts";
import type { EvalCase } from "../lib/eval-sources.ts";
import {
  assertSyntheticDatabase,
  importSyntheticCases,
  NotSyntheticDatabaseError,
  openSyntheticDevDatabase,
  SYNTHETIC_HOST,
  syntheticReceivedAt,
} from "../lib/synthetic-dev-db.ts";
import { seedDevDatabase } from "../scripts/seed-dev-db.ts";

const NOW = new Date("2026-10-27T12:00:00.000Z");

function rawAnswers(over: Record<string, unknown> = {}) {
  return {
    is_spam: { type: "noul", noul: 0.1 },
    is_phishing_or_scam: { type: "noul", noul: 0.1 },
    addresses_an_ai: { type: "noul", noul: 0.1 },
    needs_my_reply: { type: "noul", noul: 0.1 },
    is_assessable: { type: "noul", noul: 0.9 },
    category: { type: "choice", choice: "business" },
    route: { type: "choice", choice: "ignore" },
    urgency: { type: "score", score: 0 },
    importance: { type: "score", score: 0 },
    ...over,
  };
}

function normalized(over: Record<string, unknown> = {}): NormalizedAnswer[] {
  const n = normalizeAnswers(rawAnswers(over), QUESTIONS);
  assert.ok(n.ok);
  return n.answers;
}

const mkCase = (id: string, over: Partial<EvalCase> = {}): EvalCase => ({
  id,
  source: id.split("-")[0],
  lang: "en",
  sender_domain: "Sender.Example.Test",
  subject: `ZZSUBJECT ${id}`,
  body: "ZZMARKER-BODY",
  expected: { category: "business", is_spam: false, is_phishing_or_scam: false },
  ...over,
});

const realAccount = (id: string, host: string) => ({
  id, label: "p", context: "", host, port: 993, tls: true, user: "u", password: "p",
  mailbox: "INBOX", spam_threshold: 0.9, enabled: true,
});

function memDb(): DatabaseSync {
  return openDatabase(":memory:");
}
const count = (db: DatabaseSync, table: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe("import of cases", () => {
  it("creates one synthetic account per source with the synthetic host and mailbox mapping", () => {
    const db = memDb();
    importSyntheticCases(db, [], { now: NOW });
    const rows = db.prepare("SELECT id, host, mailbox, spam_mailbox, enabled FROM accounts ORDER BY id").all();
    assert.deepEqual(rows.map((r) => r.id), ["hf-sinabis", "hf-triage"]);
    for (const r of rows) {
      assert.equal(r.host, SYNTHETIC_HOST);
      assert.equal(r.mailbox, "INBOX");
      assert.equal(r.spam_mailbox, "Junk");
      assert.equal(r.enabled, 0);
    }
  });

  it("is idempotent: same input twice gives identical rows", () => {
    const db = memDb();
    const items = [{ case: mkCase("triage-1") }, { case: mkCase("sinabis-2") }];
    importSyntheticCases(db, items, { now: NOW });
    const snap = () =>
      JSON.stringify(["emails", "email_locations", "classifications"].map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY id`).all()));
    const before = snap();
    importSyntheticCases(db, items, { now: NOW });
    assert.equal(snap(), before);
    assert.equal(count(db, "emails"), 2);
    assert.equal(count(db, "email_locations"), 2);
  });

  it("uses message_id = case id, a noreply sender on the case domain and the case subject", () => {
    const db = memDb();
    importSyntheticCases(db, [{ case: mkCase("triage-7") }], { now: NOW });
    const e = db.prepare("SELECT account_id, message_id, sender, subject FROM emails").get()!;
    assert.deepEqual({ ...e }, {
      account_id: "hf-triage", message_id: "triage-7", sender: "noreply@sender.example.test", subject: "ZZSUBJECT triage-7",
    });
  });

  it("places spam and phishing in Junk, everything else in INBOX, with deterministic uids", () => {
    const db = memDb();
    importSyntheticCases(db, [
      { case: mkCase("triage-1", { expected: { is_spam: true } }) },
      { case: mkCase("triage-2", { expected: { is_phishing_or_scam: true } }) },
      { case: mkCase("triage-3", { expected: { is_spam: false, is_phishing_or_scam: false } }) },
      { case: mkCase("triage-4", { expected: { category: "personal" } }) },
    ], { now: NOW });
    const rows = db.prepare(
      "SELECT e.message_id AS id, l.folder, l.uid, l.is_active FROM email_locations l JOIN emails e ON e.id = l.email_id ORDER BY e.message_id",
    ).all().map((r) => ({ ...r }));
    assert.deepEqual(rows, [
      { id: "triage-1", folder: "Junk", uid: 2, is_active: 1 },
      { id: "triage-2", folder: "Junk", uid: 3, is_active: 1 },
      { id: "triage-3", folder: "INBOX", uid: 4, is_active: 1 },
      { id: "triage-4", folder: "INBOX", uid: 5, is_active: 1 },
    ]);
  });

  it("spreads received_at over the last 14 days, deterministically per id", () => {
    const ids = Array.from({ length: 50 }, (_, i) => `triage-${i}`);
    const times = ids.map((id) => Date.parse(syntheticReceivedAt(id, NOW)));
    for (const t of times) {
      assert.ok(t <= NOW.getTime());
      assert.ok(t > NOW.getTime() - 14 * 86_400_000);
    }
    assert.ok(new Set(times).size > 40);
    assert.equal(syntheticReceivedAt("triage-9", NOW), syntheticReceivedAt("triage-9", NOW));
    assert.match(syntheticReceivedAt("triage-9", NOW), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  });

  it("stores no body or excerpt anywhere", () => {
    const db = memDb();
    importSyntheticCases(db, [
      { case: mkCase("triage-1") },
      { case: mkCase("triage-2"), classification: { answers: normalized(), modelReported: "m" } },
    ], { now: NOW });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
    let dump = "";
    for (const { name } of tables) dump += JSON.stringify(db.prepare(`SELECT * FROM ${name}`).all());
    assert.ok(dump.includes("ZZSUBJECT"));
    assert.ok(!dump.includes("ZZMARKER-BODY"));
  });

  it("leaves mails without answers unclassified (no classification row)", () => {
    const db = memDb();
    importSyntheticCases(db, [{ case: mkCase("triage-1") }], { now: NOW });
    assert.equal(count(db, "emails"), 1);
    assert.equal(count(db, "classifications"), 0);
  });
});

describe("answers", () => {
  const withAnswers = (id: string, over: Record<string, unknown> = {}, model = "typesafe/jev-1.13-reported") => ({
    case: mkCase(id),
    classification: { answers: normalized(over), modelReported: model },
  });

  it("persists a classified row with model_reported, answers and shadow_quarantine", () => {
    const db = memDb();
    importSyntheticCases(db, [withAnswers("triage-1")], { now: NOW });
    const c = db.prepare("SELECT * FROM classifications").get()!;
    assert.equal(c.status, "classified");
    assert.equal(c.model_requested, JEV_MODEL);
    assert.equal(c.question_set_version, QUESTION_SET_VERSION);
    assert.equal(c.model_reported, "typesafe/jev-1.13-reported");
    const keys = db.prepare("SELECT question_key FROM classification_answers ORDER BY id").all().map((r) => r.question_key);
    assert.deepEqual(keys, [...Object.keys(QUESTIONS), "shadow_quarantine"]);
  });

  it("computes the shadow exactly like the pipeline persistence", () => {
    const over = { is_spam: { type: "noul", noul: 0.99 } };
    const dev = memDb();
    importSyntheticCases(dev, [withAnswers("triage-1", over)], { now: NOW });

    const live = memDb();
    syncAccounts(live, [{ ...realAccount("a", "h"), spam_threshold: DEFAULT_SPAM_THRESHOLD }], NOW);
    live.prepare("INSERT INTO emails (id, account_id, message_id, sender, subject, received_at, first_seen_at) VALUES (1,'a','m','s','s','t','t')").run();
    live.prepare("INSERT INTO classifications (id, email_id, question_set_version, model_requested, status, created_at, updated_at) VALUES (1,1,'v','m','pending','t','t')").run();
    createPersistResponse(() => DEFAULT_SPAM_THRESHOLD)({
      db: live, classificationId: 1, emailId: 1, accountId: "a", latencyMs: 1, attempts: 1, traceId: "t", now: NOW,
      response: { answers: rawAnswers(over), model: "m" } as never,
    });

    const shadow = (db: DatabaseSync) =>
      db.prepare("SELECT answer_json FROM classification_answers WHERE question_key = 'shadow_quarantine'").get()!.answer_json as string;
    assert.equal(shadow(dev), shadow(live));
    assert.deepEqual(JSON.parse(shadow(dev)), computeShadowQuarantine(normalized(over), DEFAULT_SPAM_THRESHOLD));
  });

  it("replaces the answers on a second run (last run wins) without duplicating rows", () => {
    const db = memDb();
    importSyntheticCases(db, [withAnswers("triage-1", { category: { type: "choice", choice: "spam" } }, "m1")], { now: NOW });
    importSyntheticCases(db, [withAnswers("triage-1", { category: { type: "choice", choice: "personal" } }, "m2")], { now: NOW });
    assert.equal(count(db, "classifications"), 1);
    assert.equal(count(db, "classification_answers"), Object.keys(QUESTIONS).length + 1);
    const cat = db.prepare("SELECT answer_json FROM classification_answers WHERE question_key = 'category'").get()!;
    assert.deepEqual(JSON.parse(cat.answer_json as string), { value: "personal" });
    assert.equal(db.prepare("SELECT model_reported FROM classifications").get()!.model_reported, "m2");
  });

  it("writes audit rows with actor eval and only ids and counters", () => {
    const db = memDb();
    importSyntheticCases(db, [withAnswers("triage-1")], { now: NOW });
    const rows = db.prepare("SELECT actor, action, details_json FROM audit_log").all();
    assert.ok(rows.length > 0);
    for (const r of rows) {
      assert.equal(r.actor, "eval");
      assert.ok(!(r.details_json as string).includes("ZZSUBJECT"));
      assert.ok(!(r.details_json as string).includes("sender.example"));
    }
  });

  it("rolls everything back when one case fails (single transaction)", () => {
    const db = memDb();
    const bad = {
      case: mkCase("triage-2"),
      classification: { answers: [{ key: "x", type: "noul", value: "oops" }] as never, modelReported: "m" },
    };
    assert.throws(() => importSyntheticCases(db, [{ case: mkCase("triage-1") }, bad], { now: NOW }));
    assert.equal(count(db, "emails"), 0);
    assert.equal(count(db, "classifications"), 0);
  });
});

describe("protection of real data", () => {
  it("refuses to write into a database that contains a non-synthetic account", () => {
    const db = memDb();
    syncAccounts(db, [realAccount("private", "imap.real.example")], NOW);
    assert.throws(() => assertSyntheticDatabase(db), NotSyntheticDatabaseError);
    assert.throws(() => importSyntheticCases(db, [{ case: mkCase("triage-1") }], { now: NOW }), NotSyntheticDatabaseError);
    assert.equal(count(db, "emails"), 0);
    assert.equal(count(db, "audit_log"), 0);
  });

  it("refuses a synthetic-looking id on a real host and a real id on the synthetic host", () => {
    for (const [id, host] of [["hf-triage", "imap.real.example"], ["private", SYNTHETIC_HOST]]) {
      const db = memDb();
      syncAccounts(db, [realAccount(id, host)], NOW);
      assert.throws(() => assertSyntheticDatabase(db), NotSyntheticDatabaseError);
    }
  });

  it("accepts an empty database and one that only holds synthetic accounts", () => {
    const db = memDb();
    assertSyntheticDatabase(db);
    importSyntheticCases(db, [], { now: NOW });
    assertSyntheticDatabase(db);
  });

  it("openSyntheticDevDatabase uses data/dev-synthetic.sqlite under the root, never the real database", () => {
    assert.equal(DEV_SYNTHETIC_DATABASE_PATH, "data/dev-synthetic.sqlite");
    const root = mkdtempSync(join(tmpdir(), "devdb-"));
    const db = openSyntheticDevDatabase(root);
    db.close();
    assert.ok(existsSync(join(root, "data", "dev-synthetic.sqlite")));
    assert.ok(!existsSync(join(root, "data", "email-agent.sqlite")));
  });

  it("openSyntheticDevDatabase refuses a file that holds real accounts", () => {
    const root = mkdtempSync(join(tmpdir(), "devdb-real-"));
    mkdirSync(join(root, "data"), { mode: 0o700 });
    const raw = openDatabase(join(root, "data", "dev-synthetic.sqlite"));
    syncAccounts(raw, [realAccount("private", "imap.real.example")], NOW);
    raw.close();
    assert.throws(() => openSyntheticDevDatabase(root), NotSyntheticDatabaseError);
  });
});

describe("dev:seed", () => {
  function datasets() {
    const root = mkdtempSync(join(tmpdir(), "seed-"));
    chmodSync(root, 0o700);
    const dir = join(root, "data", "eval-datasets");
    const put = (short: string, rows: unknown[]) => {
      mkdirSync(join(dir, short), { recursive: true, mode: 0o700 });
      writeFileSync(join(dir, short, "rows.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
      writeFileSync(join(dir, short, "manifest.json"), JSON.stringify({ revision: "r".repeat(40) }));
    };
    put("triage", [
      { row_idx: 0, row: { subject: "ZZSUBJECT a", body: "ZZMARKER-BODY", category: "phishing" } },
      { row_idx: 1, row: { subject: "ZZSUBJECT b", body: "ZZMARKER-BODY", category: "finance" } },
    ]);
    put("sinabis", [{ row_idx: 4, row: { subject: "ZZSUBJECT c", body: "ZZMARKER-BODY", lang: "de", from: { email: "x@firma.example.test" } } }]);
    return root;
  }

  it("imports all loaded cases without answers, repeatably, into the dev database only", () => {
    const root = datasets();
    assert.deepEqual(seedDevDatabase({ root, now: NOW }), { cases: 3 });
    seedDevDatabase({ root, now: NOW });
    const db = openSyntheticDevDatabase(root);
    assert.equal(count(db, "emails"), 3);
    assert.equal(count(db, "classifications"), 0);
    assert.equal(
      db.prepare("SELECT folder FROM email_locations l JOIN emails e ON e.id = l.email_id WHERE e.message_id = 'triage-0'").get()!.folder,
      "Junk",
    );
    db.close();
    assert.ok(!existsSync(join(root, "data", "email-agent.sqlite")));
  });

  it("fails with datasets_missing when nothing was fetched", () => {
    const root = mkdtempSync(join(tmpdir(), "seed-empty-"));
    assert.throws(() => seedDevDatabase({ root, now: NOW }), (e: Error) => e.message === "datasets_missing");
  });
});
