import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../lib/db.ts";
import { syncAccounts } from "../lib/accounts.ts";
import { ingestMail } from "../lib/ingest.ts";
import { createClassificationPipeline, createPersistResponse } from "../lib/classification-pipeline.ts";
import type { JevCallResult } from "../lib/jev.ts";
import type { MessageMeta } from "../lib/imap.ts";
import { dismissHitl, HITL_MIN_SPAM, hitlCandidates, listHitl, type HitlRule, type HitlSender } from "../lib/sender-hitl.ts";
import { createRule } from "../lib/sender-rules.ts";
import { FREEMAIL_DOMAINS } from "../lib/senders.ts";

const T = "2026-10-27T12:00:00.000Z";
const T2 = "2026-10-27T14:00:00.000Z";

const s = (address: string, over: Partial<HitlSender> = {}): HitlSender => ({
  address, domain: address.slice(address.indexOf("@") + 1), mails_seen: 5, dmarc_pass: 4, jev_spam_count: 0, hitl_asked_count: 0, ...over,
});
const r = (kind: HitlRule["kind"], match: HitlRule["match"], value: string): HitlRule => ({ kind, match, value });
const keys = (c: ReturnType<typeof hitlCandidates>) => c.map((x) => x.key);

describe("hitlCandidates (pure, E7/E8)", () => {
  test("the threshold is three Jev spam verdicts", () => {
    assert.equal(HITL_MIN_SPAM, 3);
    assert.deepEqual(hitlCandidates([s("a@x.test", { jev_spam_count: 2 })], []), []);
    const c = hitlCandidates([s("a@x.test", { jev_spam_count: 3, mails_seen: 6, dmarc_pass: 3 })], []);
    assert.deepEqual(c, [{ key: "address:a@x.test", match: "address", value: "a@x.test", jev_spam_count: 3, mails_seen: 6, dmarc_pass_rate: 0.5 }]);
  });

  test("dmarc_pass_rate is null when no mail was seen", () => {
    const c = hitlCandidates([s("a@x.test", { jev_spam_count: 3, mails_seen: 0, dmarc_pass: 0 })], []);
    assert.equal(c[0].dmarc_pass_rate, null);
  });

  test("one address with all the verdicts stays an address proposal", () => {
    const c = hitlCandidates([s("a@x.test", { jev_spam_count: 4 }), s("b@x.test", { jev_spam_count: 0 })], []);
    assert.deepEqual(keys(c), ["address:a@x.test"]);
  });

  test("verdicts from two or more addresses of one domain, summing to three, propose the domain (E8)", () => {
    const c = hitlCandidates([
      s("a@shop.test", { jev_spam_count: 2, mails_seen: 4, dmarc_pass: 4 }),
      s("b@shop.test", { jev_spam_count: 1, mails_seen: 2, dmarc_pass: 0 }),
      s("c@shop.test", { jev_spam_count: 0, mails_seen: 4, dmarc_pass: 2 }),
    ], []);
    assert.deepEqual(c, [{ key: "domain:shop.test", match: "domain", value: "shop.test", jev_spam_count: 3, mails_seen: 10, dmarc_pass_rate: 0.6 }]);
  });

  test("two addresses but fewer than three verdicts in total: no proposal", () => {
    assert.deepEqual(hitlCandidates([s("a@shop.test", { jev_spam_count: 1 }), s("b@shop.test", { jev_spam_count: 1 })], []), []);
  });

  test("an address with three verdicts is covered by its domain proposal, not listed twice", () => {
    const c = hitlCandidates([s("a@shop.test", { jev_spam_count: 3 }), s("b@shop.test", { jev_spam_count: 1 })], []);
    assert.deepEqual(keys(c), ["domain:shop.test"]);
  });

  test("freemail domains are never proposed as a domain; their addresses are judged one by one", () => {
    for (const d of FREEMAIL_DOMAINS) {
      const c = hitlCandidates([s(`a@${d}`, { jev_spam_count: 2 }), s(`b@${d}`, { jev_spam_count: 2 }), s(`c@${d}`, { jev_spam_count: 3 })], []);
      assert.deepEqual(keys(c), [`address:c@${d}`], d);
    }
  });

  test("an existing rule suppresses the proposal: address rule, domain rule, either kind", () => {
    const rows = [s("a@x.test", { jev_spam_count: 3 }), s("b@y.test", { jev_spam_count: 3 })];
    assert.deepEqual(keys(hitlCandidates(rows, [r("blacklist", "address", "a@x.test")])), ["address:b@y.test"]);
    assert.deepEqual(keys(hitlCandidates(rows, [r("allowlist", "address", "a@x.test")])), ["address:b@y.test"]);
    assert.deepEqual(keys(hitlCandidates(rows, [r("allowlist", "domain", "y.test")])), ["address:a@x.test"]);
    assert.deepEqual(keys(hitlCandidates(rows, [r("blacklist", "domain", "x.test"), r("blacklist", "domain", "y.test")])), []);
  });

  test("an address with its own rule no longer counts towards its domain", () => {
    const rows = [s("a@shop.test", { jev_spam_count: 2 }), s("b@shop.test", { jev_spam_count: 2 })];
    assert.deepEqual(keys(hitlCandidates(rows, [])), ["domain:shop.test"]);
    assert.deepEqual(keys(hitlCandidates(rows, [r("allowlist", "address", "a@shop.test")])), []);
  });

  test("already asked: only new verdicts since the question bring it back", () => {
    assert.deepEqual(hitlCandidates([s("a@x.test", { jev_spam_count: 3, hitl_asked_count: 3 })], []), []);
    assert.deepEqual(keys(hitlCandidates([s("a@x.test", { jev_spam_count: 4, hitl_asked_count: 3 })], [])), ["address:a@x.test"]);
    // domain: compared as a sum
    const dom = (a: number, b: number, askedA: number, askedB: number) =>
      hitlCandidates([s("a@shop.test", { jev_spam_count: a, hitl_asked_count: askedA }), s("b@shop.test", { jev_spam_count: b, hitl_asked_count: askedB })], []);
    assert.deepEqual(dom(2, 2, 2, 2), []);
    assert.deepEqual(keys(dom(3, 2, 2, 2)), ["domain:shop.test"]);
  });

  test("sorted by verdicts (most first), then key; input order does not matter", () => {
    const rows = [s("b@y.test", { jev_spam_count: 3 }), s("a@x.test", { jev_spam_count: 5 }), s("c@z.test", { jev_spam_count: 3 })];
    assert.deepEqual(keys(hitlCandidates(rows, [])), ["address:a@x.test", "address:b@y.test", "address:c@z.test"]);
    assert.deepEqual(keys(hitlCandidates([...rows].reverse(), [])), ["address:a@x.test", "address:b@y.test", "address:c@z.test"]);
  });

  test("does not mutate its input", () => {
    const rows = [s("a@x.test", { jev_spam_count: 3 })];
    const copy = structuredClone(rows);
    hitlCandidates(rows, []);
    assert.deepEqual(rows, copy);
  });
});

// ---- database side ----
const fixture = () => JSON.parse(readFileSync(new URL("./fixtures/jev-email-v1-response.json", import.meta.url), "utf8"));
function setup(): DatabaseSync {
  const db = openDatabase(":memory:");
  syncAccounts(db, [{
    id: "a", label: "a", context: "c", host: "h", port: 993, tls: true, user: "u", password: "p",
    mailbox: "INBOX", spam_threshold: 0.9, enabled: true,
  } as never]);
  return db;
}
let uid = 0;
async function mail(db: DatabaseSync, sender: string, isSpam: number | null, receivedAt = "2026-10-27T10:00:00.000Z"): Promise<number> {
  const m: MessageMeta = {
    messageId: `<m${++uid}>`, sender, subject: "SUBJECT-MARKER", receivedAt,
    spf: "pass", dkim: "pass", dmarc: "pass", listUnsubscribePresent: false, replyToDiffersFromFrom: false,
  };
  const { emailId } = ingestMail(db, { accountId: "a", meta: m, loc: { folder: "INBOX", uid, uidValidity: 1 }, now: new Date(T), traceId: "t" });
  if (isSpam !== null) {
    const res: JevCallResult = { ok: true, response: { ...fixture(), answers: { ...fixture().answers, is_spam: { type: "noul", noul: isSpam } }, model: "typesafe/jev-1.13-r" } as never };
    const p = createClassificationPipeline({
      db, jev: { classify: async () => res } as never, portFactory: () => { throw new Error("x"); },
      clock: { now: () => new Date(T), setInterval: () => 0, clearInterval: () => {} }, persistResponse: createPersistResponse(() => 0.9),
    });
    await p.submit({ emailId, accountId: "a", input: { ...m, excerpt: "e" } });
  }
  return emailId;
}

describe("listHitl (database)", () => {
  test("proposes the sender after the third Jev spam verdict, with at most three sample mail ids (spam-judged, newest first)", async () => {
    const db = setup();
    const ids: number[] = [];
    for (let i = 0; i < 4; i++) ids.push(await mail(db, "spam@junk.test", 0.95, `2026-10-2${i}T10:00:00.000Z`));
    await mail(db, "spam@junk.test", 0.1, "2026-10-29T10:00:00.000Z"); // not judged spam: never a sample
    await mail(db, "nice@ok.test", 0.95);
    const list = listHitl(db, 1);
    assert.equal(list.length, 1);
    assert.deepEqual(list[0], {
      key: "address:spam@junk.test", match: "address", value: "spam@junk.test", jev_spam_count: 4, mails_seen: 5, dmarc_pass_rate: 1,
      sample_email_ids: [ids[3], ids[2], ids[1]],
    });
  });

  test("a domain proposal samples mails of all its addresses", async () => {
    const db = setup();
    const a1 = await mail(db, "a@shop.test", 0.9);
    const b1 = await mail(db, "b@shop.test", 0.9);
    const a2 = await mail(db, "a@shop.test", 0.9);
    await mail(db, "a@other.test", 0.9);
    const list = listHitl(db, 1);
    assert.deepEqual(list.map((c) => c.key), ["domain:shop.test"]);
    assert.deepEqual([...list[0].sample_email_ids].sort(), [a1, a2, b1].sort());
  });

  test("an active rule removes the proposal; deactivating the rule brings it back", async () => {
    const db = setup();
    for (let i = 0; i < 3; i++) await mail(db, "spam@junk.test", 0.95);
    assert.equal(listHitl(db, 1).length, 1);
    const rule = createRule(db, 1, { kind: "allowlist", match: "address", value: "spam@junk.test", ts: T });
    assert.ok(rule.ok);
    assert.equal(listHitl(db, 1).length, 0);
    db.prepare("UPDATE sender_rules SET active = 0").run();
    assert.equal(listHitl(db, 1).length, 1);
  });

  test("dismissHitl asks once: the proposal stays away until another verdict arrives; audits ids and codes only", async () => {
    const db = setup();
    for (let i = 0; i < 3; i++) await mail(db, "spam@junk.test", 0.95);
    const d = dismissHitl(db, 1, "address", "spam@junk.test", T2);
    assert.deepEqual(d, { ok: true, changed: true });
    assert.equal(listHitl(db, 1).length, 0);
    assert.deepEqual(dismissHitl(db, 1, "address", "spam@junk.test", T2), { ok: true, changed: false });
    await mail(db, "spam@junk.test", 0.95);
    assert.equal(listHitl(db, 1).length, 1);
    assert.deepEqual({ ...db.prepare("SELECT hitl_asked_at, hitl_asked_count FROM senders").get() }, { hitl_asked_at: T2, hitl_asked_count: 3 });
    const a = db.prepare("SELECT actor, action, details_json FROM audit_log WHERE action = 'sender_hitl_dismissed'").all().map((x) => ({ ...x }));
    assert.equal(a.length, 1);
    assert.equal(a[0].actor, "system");
    assert.deepEqual(JSON.parse(a[0].details_json as string), { source: "nico", match: "address" });
  });

  test("dismissing a domain marks every address of that domain; unknown targets are not_found", async () => {
    const db = setup();
    await mail(db, "a@shop.test", 0.9);
    await mail(db, "b@shop.test", 0.9);
    await mail(db, "b@shop.test", 0.9);
    assert.equal(listHitl(db, 1).length, 1);
    assert.deepEqual(dismissHitl(db, 1, "domain", "shop.test", T2), { ok: true, changed: true });
    assert.equal(listHitl(db, 1).length, 0);
    assert.deepEqual(dismissHitl(db, 1, "domain", "nowhere.test", T2), { ok: false, code: "not_found" });
    assert.deepEqual(dismissHitl(db, 1, "address", "nobody@shop.test", T2), { ok: false, code: "not_found" });
    assert.deepEqual(dismissHitl(db, 1, "address", "not-an-address", T2), { ok: false, code: "invalid_value" });
  });

  test("the list carries no subject, no mail address of other senders and no content", async () => {
    const db = setup();
    for (let i = 0; i < 3; i++) await mail(db, "spam@junk.test", 0.95);
    const text = JSON.stringify(listHitl(db, 1));
    assert.ok(!text.includes("SUBJECT-MARKER"));
  });
});
