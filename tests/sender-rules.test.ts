import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../lib/db.ts";
import { syncAccounts } from "../lib/accounts.ts";
import { createRule, deactivateRule, listRules, senderRuleHit } from "../lib/sender-rules.ts";

const T = "2026-10-27T12:00:00.000Z";
const T2 = "2026-10-27T13:00:00.000Z";

function setup(): DatabaseSync {
  const db = openDatabase(":memory:");
  const mk = (id: string) => ({
    id, label: id, context: "c", host: "h", port: 993, tls: true, user: "u", password: "p",
    mailbox: "INBOX", spam_threshold: 0.9, enabled: true,
  }) as never;
  syncAccounts(db, [mk("a"), mk("b")]);
  return db;
}
const audits = (db: DatabaseSync) =>
  db.prepare("SELECT actor, action, account_id, email_id, details_json FROM audit_log WHERE action LIKE 'sender_rule_%' ORDER BY id").all().map((r) => ({ ...r }));

describe("createRule", () => {
  test("stores a lower-cased address rule with source nico, active, and audits ids and codes only", () => {
    const db = setup();
    const r = createRule(db, 1, { kind: "blacklist", match: "address", value: " Spam@Junk.TEST ", ts: T });
    assert.ok(r.ok);
    assert.deepEqual({ ...r.rule }, { id: 1, kind: "blacklist", match: "address", value: "spam@junk.test", account_id: null, source: "nico", active: 1, created_at: T });
    assert.deepEqual(r.deactivated, []);
    const a = audits(db);
    assert.equal(a.length, 1);
    assert.equal(a[0].actor, "system");
    assert.equal(a[0].action, "sender_rule_created");
    assert.deepEqual(JSON.parse(a[0].details_json as string), { source: "nico", rule_id: 1, kind: "blacklist", match: "address" });
    assert.ok(!JSON.stringify(a).includes("junk.test"), "the audit never carries the address");
  });

  test("a domain rule needs a plausible domain; freemail domains are refused for domain rules only", () => {
    const db = setup();
    for (const bad of ["", "nodot", "a b.test", "-x.test", "x..test", "x.test/", "@x.test", "a@x.test"]) {
      const r = createRule(db, 1, { kind: "blacklist", match: "domain", value: bad, ts: T });
      assert.deepEqual(r, { ok: false, code: "invalid_value" }, bad);
    }
    for (const d of ["gmail.com", "WEB.DE", "gmx.de", "outlook.com", "icloud.com"]) {
      assert.deepEqual(createRule(db, 1, { kind: "blacklist", match: "domain", value: d, ts: T }), { ok: false, code: "freemail_domain" }, d);
    }
    assert.ok(createRule(db, 1, { kind: "blacklist", match: "address", value: "someone@gmail.com", ts: T }).ok, "single freemail addresses are fine");
    assert.ok(createRule(db, 1, { kind: "allowlist", match: "domain", value: "firma.example", ts: T }).ok);
    assert.equal(listRules(db, 1).length, 2);
  });

  test("an address rule needs exactly one @ and a domain", () => {
    const db = setup();
    for (const bad of ["", "x.test", "a@", "@x.test", "a@@x.test", "a b@x.test", "a@x"]) {
      assert.deepEqual(createRule(db, 1, { kind: "allowlist", match: "address", value: bad, ts: T }), { ok: false, code: "invalid_value" }, bad);
    }
  });

  test("an unknown account is refused, a known one is stored", () => {
    const db = setup();
    assert.deepEqual(createRule(db, 1, { kind: "blacklist", match: "domain", value: "x.test", accountId: "nope", ts: T }), { ok: false, code: "unknown_account" });
    const r = createRule(db, 1, { kind: "blacklist", match: "domain", value: "x.test", accountId: "a", ts: T });
    assert.ok(r.ok && r.rule.account_id === "a");
  });

  test("creating the same rule again changes nothing and audits nothing", () => {
    const db = setup();
    const first = createRule(db, 1, { kind: "blacklist", match: "domain", value: "x.test", ts: T });
    const again = createRule(db, 1, { kind: "blacklist", match: "domain", value: "X.test", ts: T2 });
    assert.ok(first.ok && again.ok);
    assert.equal(again.rule.id, first.rule.id);
    assert.equal(again.changed, false);
    assert.equal(listRules(db, 1).length, 1);
    assert.equal(audits(db).length, 1);
  });

  test("the opposite rule for the same target replaces the active one (one verdict per target)", () => {
    const db = setup();
    const b = createRule(db, 1, { kind: "blacklist", match: "domain", value: "x.test", ts: T });
    assert.ok(b.ok);
    const w = createRule(db, 1, { kind: "allowlist", match: "domain", value: "x.test", ts: T2 });
    assert.ok(w.ok);
    assert.deepEqual(w.deactivated, [b.rule.id]);
    assert.deepEqual(listRules(db, 1).map((r) => [r.kind, r.active]), [["allowlist", 1]]);
    assert.deepEqual(listRules(db, 1, { includeInactive: true }).map((r) => [r.kind, r.active]), [["blacklist", 0], ["allowlist", 1]]);
    // another account's or another target's rule stays untouched
    createRule(db, 1, { kind: "blacklist", match: "domain", value: "y.test", ts: T });
    createRule(db, 1, { kind: "blacklist", match: "domain", value: "x.test", accountId: "a", ts: T });
    createRule(db, 1, { kind: "allowlist", match: "address", value: "p@x.test", ts: T });
    assert.deepEqual(listRules(db, 1).map((r) => r.id).sort(), [2, 3, 4, 5]);
  });

  test("a deactivated rule is reactivated by creating it again (the row is kept)", () => {
    const db = setup();
    const r = createRule(db, 1, { kind: "blacklist", match: "address", value: "a@x.test", ts: T });
    assert.ok(r.ok);
    assert.ok(deactivateRule(db, 1, r.rule.id, T2).ok);
    assert.equal(listRules(db, 1).length, 0);
    const again = createRule(db, 1, { kind: "blacklist", match: "address", value: "a@x.test", ts: T2 });
    assert.ok(again.ok && again.changed && again.rule.id === r.rule.id && again.rule.active === 1);
    assert.equal(listRules(db, 1, { includeInactive: true }).length, 1);
  });
});

describe("deactivateRule", () => {
  test("switches the rule off, audits, is idempotent, and reports unknown ids", () => {
    const db = setup();
    const r = createRule(db, 1, { kind: "allowlist", match: "domain", value: "x.test", ts: T });
    assert.ok(r.ok);
    const d = deactivateRule(db, 1, r.rule.id, T2);
    assert.ok(d.ok && d.changed && d.rule.active === 0);
    const d2 = deactivateRule(db, 1, r.rule.id, T2);
    assert.ok(d2.ok && !d2.changed);
    assert.deepEqual(audits(db).map((a) => a.action), ["sender_rule_created", "sender_rule_deactivated"]);
    assert.deepEqual(deactivateRule(db, 1, 999, T2), { ok: false, code: "not_found" });
  });
});

describe("senderRuleHit", () => {
  test("matches the exact address and the exact domain, not subdomains or look-alikes", () => {
    const db = setup();
    createRule(db, 1, { kind: "blacklist", match: "address", value: "bad@x.test", ts: T });
    createRule(db, 1, { kind: "blacklist", match: "domain", value: "junk.test", ts: T });
    const hit = (s: string, acc = "a") => senderRuleHit(db, 1, s, acc);
    assert.deepEqual(hit("bad@x.test"), { allowlisted: false, blacklisted: true });
    assert.deepEqual(hit("BAD@X.TEST"), { allowlisted: false, blacklisted: true });
    assert.deepEqual(hit("other@x.test"), { allowlisted: false, blacklisted: false });
    assert.deepEqual(hit("anyone@junk.test"), { allowlisted: false, blacklisted: true });
    assert.deepEqual(hit("anyone@sub.junk.test"), { allowlisted: false, blacklisted: false });
    assert.deepEqual(hit("anyone@notjunk.test"), { allowlisted: false, blacklisted: false });
    assert.deepEqual(hit("not-an-address"), { allowlisted: false, blacklisted: false });
  });

  test("an account-bound rule only applies to that account; inactive rules never apply", () => {
    const db = setup();
    createRule(db, 1, { kind: "allowlist", match: "domain", value: "x.test", accountId: "a", ts: T });
    const bl = createRule(db, 1, { kind: "blacklist", match: "domain", value: "y.test", ts: T });
    assert.deepEqual(senderRuleHit(db, 1, "p@x.test", "a"), { allowlisted: true, blacklisted: false });
    assert.deepEqual(senderRuleHit(db, 1, "p@x.test", "b"), { allowlisted: false, blacklisted: false });
    assert.ok(bl.ok);
    deactivateRule(db, 1, bl.rule.id, T2);
    assert.deepEqual(senderRuleHit(db, 1, "p@y.test", "a"), { allowlisted: false, blacklisted: false });
  });

  test("allowlist and blacklist for overlapping targets are both reported (the rule engine lets protection win)", () => {
    const db = setup();
    createRule(db, 1, { kind: "blacklist", match: "domain", value: "x.test", ts: T });
    createRule(db, 1, { kind: "allowlist", match: "address", value: "ok@x.test", ts: T });
    assert.deepEqual(senderRuleHit(db, 1, "ok@x.test", "a"), { allowlisted: true, blacklisted: true });
    assert.deepEqual(senderRuleHit(db, 1, "bad@x.test", "a"), { allowlisted: false, blacklisted: true });
  });
});
