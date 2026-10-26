import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, chmodSync, rmSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { openDatabase } from "../lib/db.ts";
import { syncAccounts } from "../lib/accounts.ts";
import type { NormalizedAnswer, NoulReading } from "../lib/jev-response.ts";

// Outside the Veryfront runtime nobody registers the SchemaValidator that defineSchema() needs at
// module load (the runtime does it in bootstrap, see agent-contract notes). Not a public export,
// hence the file URL. Test-only; the tool module itself stays Veryfront-conformant.
const root = join(import.meta.dirname, "..");
const { ensureBuiltinSchemaValidator } = await import(
  pathToFileURL(join(root, "node_modules/veryfront/esm/src/extensions/builtin-schema-validator.js")).href
) as { ensureBuiltinSchemaValidator: () => void };
ensureBuiltinSchemaValidator();
const { default: getEmailContext, createGetEmailContext } = await import("../tools/get-email-context.ts");

const T = "2026-10-26T10:00:00.000Z";
const SENDER = "Person@Mail.Example.test";
const byValue = (a: NormalizedAnswer): NoulReading => ((a.value as number) >= 0.5 ? "positive" : "negative");

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "email-context-"));
  chmodSync(dir, 0o700);
  const db = openDatabase(join(dir, "t.sqlite"));
  syncAccounts(db, [
    { id: "a1", label: "L", host: "imap.example", port: 993, mailbox: "INBOX", spam_mailbox: "Junk", enabled: true },
  ] as never);
  const mail = (id: number) => {
    db.prepare("INSERT INTO emails (id, account_id, message_id, sender, subject, received_at, first_seen_at) VALUES (?,?,?,?,?,?,?)")
      .run(id, "a1", `m${id}`, SENDER, `Synthetic subject ${id}`, T, T);
  };
  let cls = 0;
  const classify = (emailId: number, status: string, a: Record<string, number | string>) => {
    const id = ++cls;
    db.prepare("INSERT INTO classifications (id, email_id, question_set_version, model_requested, model_reported, status, failure_code, attempts, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(id, emailId, `v${id}`, "typesafe/jev-1.13", status === "classified" ? "typesafe/jev-1.13" : null, status, status === "failed" ? "x" : null, 1, T, T);
    const ins = db.prepare("INSERT INTO classification_answers (classification_id, question_key, type, answer_json, probabilities_json) VALUES (?,?,?,?,?)");
    for (const [k, v] of Object.entries(a)) {
      ins.run(id, k, typeof v === "number" ? "noul" : "choice", JSON.stringify({ value: v }),
        typeof v === "number" ? JSON.stringify({ low: 1 - v, high: v }) : JSON.stringify({ [v]: 0.9, other: 0.1 }));
    }
    ins.run(id, "shadow_quarantine", "derived", JSON.stringify({ candidate: false }), null);
  };
  const ok = { addresses_an_ai: 0.02, is_assessable: 0.9, needs_my_reply: 0.8, category: "business" };
  mail(1); classify(1, "classified", ok);                                   // eligible
  mail(2); classify(2, "classified", { ...ok, category: "security_auth" }); // blocked
  mail(3); classify(3, "failed", {});                                       // not classified
  mail(4); classify(4, "classified", { ...ok, addresses_an_ai: 0.97 });     // addresses an AI
  mail(5); classify(5, "classified", ok); classify(5, "pending", {});      // latest classified one counts
  return { db, dir };
}

function tableCounts(db: ReturnType<typeof openDatabase>) {
  const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
  return Object.fromEntries(names.map((n) => [n, (db.prepare(`SELECT COUNT(*) AS c FROM "${n}"`).get() as { c: number }).c]));
}

function harness(interpret: typeof byValue | null = byValue) {
  const s = setup();
  let opened = 0;
  let closed = 0;
  const tool = createGetEmailContext({
    openDb: () => {
      opened++;
      return new Proxy(s.db, {
        get(t, p) {
          if (p === "close") return () => { closed++; };
          const v = (t as never)[p] as unknown;
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
        },
      });
    },
    ...(interpret ? { interpret } : {}),
  });
  const done = () => { s.db.close(); rmSync(s.dir, { recursive: true, force: true }); };
  return { ...s, tool, done, stats: () => ({ opened, closed }) };
}

test("eligible mail yields exactly the allowlist, nothing else", async () => {
  const h = harness();
  try {
    const before = tableCounts(h.db);
    const r = await h.tool.execute({ email_id: 1 });
    assert.ok(r.ok);
    assert.deepEqual(Object.keys(r).sort(), ["context", "ok"]);
    const c = r.context;
    assert.deepEqual(Object.keys(c).sort(), ["answers", "category", "question_set_version", "received_at", "sender_domain", "subject"]);
    assert.equal(c.sender_domain, "mail.example.test");
    assert.equal(c.subject, "Synthetic subject 1");
    assert.equal(c.received_at, T);
    assert.equal(c.category, "business");
    assert.equal(c.question_set_version, "v1");
    assert.deepEqual(c.answers.map((a) => a.key).sort(), ["addresses_an_ai", "category", "is_assessable", "needs_my_reply"]);
    const reply = c.answers.find((a) => a.key === "needs_my_reply")!;
    assert.equal(reply.value, 0.8);
    assert.deepEqual(reply.probabilities, { low: 1 - 0.8, high: 0.8 });
    for (const a of c.answers) assert.deepEqual(Object.keys(a).filter((k) => !["key", "type", "value", "probabilities"].includes(k)), []);
    assert.deepEqual(tableCounts(h.db), before, "no writes");
    assert.deepEqual(h.stats(), { opened: 1, closed: 1 });
  } finally { h.done(); }
});

test("latest classified classification counts", async () => {
  const h = harness();
  try {
    const r = await h.tool.execute({ email_id: 5 });
    assert.ok(r.ok);
    assert.equal(r.context.question_set_version, "v5");
  } finally { h.done(); }
});

test("blocked cases return only the fixed code and no data", async () => {
  const h = harness();
  try {
    for (const id of [2, 4]) {
      assert.deepEqual(await h.tool.execute({ email_id: id }), { ok: false, code: "not_eligible" }, `mail ${id}`);
    }
  } finally { h.done(); }
  const d = harness(null); // default interpreter: unmapped, fail-closed
  try {
    assert.deepEqual(await d.tool.execute({ email_id: 1 }), { ok: false, code: "not_eligible" });
  } finally { d.done(); }
});

test("unknown and unclassified mails return fixed codes", async () => {
  const h = harness();
  try {
    assert.deepEqual(await h.tool.execute({ email_id: 999 }), { ok: false, code: "email_not_found" });
    assert.deepEqual(await h.tool.execute({ email_id: 3 }), { ok: false, code: "not_classified" });
    assert.deepEqual(h.stats(), { opened: 2, closed: 2 });
  } finally { h.done(); }
});

test("marker: full sender address and host never appear in any result", async () => {
  const h = harness();
  try {
    for (const id of [1, 2, 3, 4, 5, 999]) {
      const out = JSON.stringify(await h.tool.execute({ email_id: id })).toLowerCase();
      assert.ok(!out.includes("person"), `mail ${id}: local part`);
      assert.ok(!out.includes("person@mail.example.test"), `mail ${id}: address`);
      assert.ok(!out.includes("imap.example"), `mail ${id}: host`);
      assert.ok(!out.includes("shadow_quarantine"), `mail ${id}: derived row`);
    }
  } finally { h.done(); }
});

test("input must be exactly a positive integer email_id", async () => {
  const h = harness();
  try {
    for (const bad of [{ email_id: 0 }, { email_id: -1 }, { email_id: 1.5 }, { email_id: "1" }, {}]) {
      await assert.rejects(() => h.tool.execute(bad as never), JSON.stringify(bad));
    }
    assert.deepEqual(h.stats(), { opened: 0, closed: 0 });
  } finally { h.done(); }
});

test("default export is a tool without MCP exposure", () => {
  assert.equal(typeof getEmailContext.execute, "function");
  assert.notEqual(getEmailContext.mcp?.enabled, true);
});

test("T41 guard: no MCP route and no MCP configuration (agent-contract section 2)", () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
  assert.ok(existsSync(join(root, "app")));
  for (const file of walk(join(root, "app"))) {
    assert.ok(!/createMCPServer/.test(readFileSync(file, "utf8")), `${file} must not create an MCP server`);
  }
  for (const name of readdirSync(root).filter((n) => /^veryfront\.config\./.test(n))) {
    const src = readFileSync(join(root, name), "utf8");
    assert.ok(!/\bmcp\b/.test(src), `${name} must not enable MCP`);
  }
});
