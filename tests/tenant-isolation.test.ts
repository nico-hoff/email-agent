// Mandantentrennung (ADR 0033): two users with two accounts each. For every data function and API route, user A sees and
// changes only A's data, and B's ids look like missing ones (404) without any change. Synthetic data only.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { syncAccounts } from "../lib/accounts.ts";
import { getEmailDetail, listEmails, type ListQuery } from "../lib/email-api.ts";
import { listActions } from "../lib/actions-api.ts";
import { buildAgentInput } from "../lib/agent-input.ts";
import { loadBriefingContext } from "../lib/briefing-context.ts";
import { QUESTION_SET_VERSION } from "../lib/constants.ts";
import { openDatabase } from "../lib/db.ts";
import { feedbackState, recordFeedback } from "../lib/feedback.ts";
import { ingestMail } from "../lib/ingest.ts";
import { createMailboxActions } from "../lib/mailbox-actions.ts";
import { dismissHitl, listHitl, sampleEmailIds } from "../lib/sender-hitl.ts";
import { createRule, deactivateRule, listRules, senderRuleHit } from "../lib/sender-rules.ts";
import { ensureSender, feedbackHistory, recordJevSpam, recordSenderMail, senderCounts } from "../lib/senders.ts";
import { accountUserId, emailUserId, ownsAccount, ownsEmail } from "../lib/tenant.ts";
import { getUserState, readLastOpened, setUserState } from "../lib/user-state.ts";
import { createUser } from "../lib/users.ts";
import { handleDraft } from "../lib/draft-route.ts";
import { createMutationLimiter, defaultAuthContext, handleLoginRequest, handleSession } from "../lib/auth-runtime.ts";
import { CSRF_HEADER } from "../lib/csrf.ts";
import * as emailsRoute from "../app/api/emails/route.ts";
import * as emailRoute from "../app/api/emails/[id]/route.ts";
import * as doneRoute from "../app/api/emails/[id]/done/route.ts";
import * as undoneRoute from "../app/api/emails/[id]/undone/route.ts";
import * as unreadRoute from "../app/api/emails/[id]/unread/route.ts";
import * as feedbackRoute from "../app/api/emails/[id]/feedback/route.ts";
import * as actionsRoute from "../app/api/actions/route.ts";
import * as statusRoute from "../app/api/status/route.ts";
import * as hitlRoute from "../app/api/senders/hitl/route.ts";
import * as dismissRoute from "../app/api/senders/hitl/dismiss/route.ts";
import * as rulesRoute from "../app/api/senders/rules/route.ts";
import * as deactivateRoute from "../app/api/senders/rules/[id]/deactivate/route.ts";
import * as briefingRoute from "../app/api/briefing/route.ts";
import * as profileRoute from "../app/api/profile/route.ts";
import * as accountsRoute from "../app/api/accounts/route.ts";
import * as accountRoute from "../app/api/accounts/[id]/route.ts";
import * as accountDisableRoute from "../app/api/accounts/[id]/disable/route.ts";
import * as accountEnableRoute from "../app/api/accounts/[id]/enable/route.ts";
import * as accountTestRoute from "../app/api/accounts/[id]/test/route.ts";
import { generateKey, loadKeyring } from "../lib/account-secrets.ts";
import { loadWorkerAccounts } from "../lib/mail-accounts.ts";

// The tool module needs the schema validator that the Veryfront runtime registers at bootstrap (see get-email-context.test.ts).
const { ensureBuiltinSchemaValidator } = await import(
  pathToFileURL(join(import.meta.dirname, "..", "node_modules/veryfront/esm/src/extensions/builtin-schema-validator.js")).href
) as { ensureBuiltinSchemaValidator: () => void };
ensureBuiltinSchemaValidator();
const { readEmailContext } = await import("../tools/get-email-context.ts");

const PW = "isolation-test-password";
const T = "2026-10-27T10:00:00.000Z";
const NOW = new Date("2026-10-27T12:00:00.000Z");
const QV = QUESTION_SET_VERSION;
const SHARED = "shared-sender@spam.example.test";
const A = 1;
const B = 2;

let dir: string;
let file: string;
let db: DatabaseSync;
const saved = { path: process.env.DATABASE_PATH, mode: process.env.AUTH_MODE, pw: process.env.APP_PASSWORD, bind: process.env.BIND_ADDRESS, key: process.env.OPENROUTER_API_KEY };

interface Mail { id: number; account: string; subject: string }
const mails: { a: Mail[]; b: Mail[] } = { a: [], b: [] };
let nextCls = 0;
let nextUid = 1;

function addMail(owner: "a" | "b", account: string, o: { sender?: string; answers?: Record<string, number | string>; seen?: boolean; done?: boolean; first?: string } = {}): Mail {
  const idx = mails[owner].length + 1;
  const subject = `SUBJ-${owner.toUpperCase()}-${idx}-MARKER`;
  const first = o.first ?? T;
  const e = db.prepare("INSERT INTO emails (account_id, message_id, sender, subject, received_at, first_seen_at) VALUES (?,?,?,?,?,?)")
    .run(account, `<${owner}${idx}@x>`, o.sender ?? `${owner}${idx}@${owner}-corp.example.test`, subject, first, first);
  const id = Number(e.lastInsertRowid);
  db.prepare("INSERT INTO email_locations (email_id, account_id, folder, uid_validity, uid, first_seen_at, last_seen_at) VALUES (?,?,?,?,?,?,?)")
    .run(id, account, "INBOX", 1, nextUid++, first, first);
  const c = ++nextCls;
  db.prepare("INSERT INTO classifications (id, email_id, question_set_version, model_requested, model_reported, status, attempts, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(c, id, QV, "m", "m", "classified", 1, first, first);
  const ins = db.prepare("INSERT INTO classification_answers (classification_id, question_key, type, answer_json) VALUES (?,?,?,?)");
  const base: Record<string, number | string> = { addresses_an_ai: 0.01, needs_my_reply: 0.9, is_spam: 0.01, category: "business", route: "draft_reply", urgency: 2, importance: 2, ...o.answers };
  for (const [k, v] of Object.entries(base)) ins.run(c, k, typeof v === "number" ? (k === "urgency" || k === "importance" ? "score" : "noul") : "choice", JSON.stringify({ value: v }));
  if (o.seen || o.done) db.prepare("INSERT INTO email_status (email_id, seen, done, updated_at) VALUES (?,?,?,?)").run(id, o.seen ? 1 : 0, o.done ? 1 : 0, first);
  const m = { id, account, subject };
  mails[owner].push(m);
  return m;
}

const acct = (id: string, label: string) => ({ id, label, host: "imap.a.example", port: 993, mailbox: "INBOX", spam_mailbox: "Junk", enabled: true }) as never;
const ids = (xs: Mail[]) => xs.map((m) => m.id).sort((x, y) => x - y);
const marker = (owner: "A" | "B") => new RegExp(`SUBJ-${owner}-\\d+-MARKER`);
const query = (over: Partial<ListQuery> = {}): ListQuery => ({ view: "all", account: null, status: null, limit: 50, cursor: null, ...over });

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "isolation-"));
  chmodSync(dir, 0o700);
  mkdirSync(join(dir, "data"), { mode: 0o700 });
  file = join(dir, "data", "iso.sqlite");
  db = openDatabase(file);
  assert.ok((await createUser(db, { email: "a@example.test", password: PW, role: "admin" })).ok);
  assert.ok((await createUser(db, { email: "b@example.test", password: PW, role: "user" })).ok);
  syncAccounts(db, [acct("a-main", "A main"), acct("a-side", "A side")], NOW, A);
  syncAccounts(db, [acct("b-main", "B main"), acct("b-side", "B side")], NOW, B);

  addMail("a", "a-main", { sender: SHARED });
  addMail("a", "a-main", { answers: { category: "spam", route: "ignore", is_spam: 0.99 }, sender: SHARED });
  addMail("a", "a-side");
  addMail("a", "a-side", { seen: true });
  addMail("b", "b-main", { sender: SHARED });
  addMail("b", "b-main", { answers: { category: "spam", route: "ignore", is_spam: 0.99 }, sender: SHARED });
  addMail("b", "b-side");
  addMail("b", "b-side", { done: true });
  addMail("b", "b-side");

  // Sender counters: the same address exists for both users with different numbers.
  const s = db.prepare("INSERT INTO senders (user_id, address, domain, first_seen_at, last_seen_at, mails_seen, jev_spam_count, marked_spam) VALUES (?,?,?,?,?,?,?,?)");
  s.run(A, SHARED, "spam.example.test", T, T, 2, 1, 0);
  s.run(B, SHARED, "spam.example.test", T, T, 7, 5, 3);
  s.run(B, "b-only@b-corp.example.test", "b-corp.example.test", T, T, 3, 3, 0);
  s.run(B, "b-hitl@other-b.example.test", "other-b.example.test", T, T, 4, 4, 0);
  s.run(A, "a-only@a-corp.example.test", "a-corp.example.test", T, T, 3, 3, 0);

  // Rules: B has a rule, A has none yet.
  assert.ok(createRule(db, B, { kind: "blacklist", match: "domain", value: "b-corp.example.test", ts: T }).ok);
  assert.ok(createRule(db, B, { kind: "allowlist", match: "address", value: SHARED, accountId: "b-main", ts: T }).ok);

  // Mailbox actions for one mail of each user.
  const act = db.prepare("INSERT INTO mailbox_actions (email_id, location_id, rule, action, mode, status, created_at, done_at) VALUES (?,?,?,?,?,?,?,?)");
  const loc = (id: number) => (db.prepare("SELECT id FROM email_locations WHERE email_id = ?").get(id) as { id: number }).id;
  act.run(mails.a[1].id, loc(mails.a[1].id), "spam_seen", "mark_seen", "dry_run", "planned", T, null);
  act.run(mails.b[1].id, loc(mails.b[1].id), "spam_seen", "mark_seen", "live", "done", T, T);
  act.run(mails.b[2].id, loc(mails.b[2].id), "spam_seen", "mark_seen", "dry_run", "planned", T, null);

  setUserState(db, B, "last_opened_at", { at: "2026-10-26T00:00:00.000Z" }, T);
  db.exec("UPDATE worker_status SET state = 'connected' WHERE account_id IN ('b-main')");
});

after(() => {
  db?.close();
  for (const [k, v] of [["DATABASE_PATH", saved.path], ["AUTH_MODE", saved.mode], ["APP_PASSWORD", saved.pw], ["BIND_ADDRESS", saved.bind], ["OPENROUTER_API_KEY", saved.key]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("helpers", () => {
  it("ownership helpers", () => {
    assert.equal(accountUserId(db, "a-main"), A);
    assert.equal(accountUserId(db, "b-side"), B);
    assert.throws(() => accountUserId(db, "nope"));
    assert.equal(emailUserId(db, mails.a[0].id), A);
    assert.equal(emailUserId(db, mails.b[0].id), B);
    assert.equal(emailUserId(db, 9999), null);
    assert.equal(ownsEmail(db, A, mails.a[0].id), true);
    assert.equal(ownsEmail(db, A, mails.b[0].id), false);
    assert.equal(ownsAccount(db, B, "b-main"), true);
    assert.equal(ownsAccount(db, B, "a-main"), false);
  });

  it("the account sync of one owner never touches the accounts of another", () => {
    syncAccounts(db, [acct("a-main", "A main")], NOW, A);
    const rows = db.prepare("SELECT id, enabled FROM accounts ORDER BY id").all().map((r) => ({ ...r }));
    assert.deepEqual(rows, [{ id: "a-main", enabled: 1 }, { id: "a-side", enabled: 0 }, { id: "b-main", enabled: 1 }, { id: "b-side", enabled: 1 }]);
    syncAccounts(db, [acct("a-main", "A main"), acct("a-side", "A side")], NOW, A);
  });
});

describe("mail list and detail", () => {
  it("listEmails: each user sees exactly their own mails, counts and accounts", () => {
    const a = listEmails(db, A, query());
    const b = listEmails(db, B, query());
    assert.deepEqual(a.emails.map((e) => e.id).sort((x, y) => x - y), ids(mails.a));
    assert.deepEqual(b.emails.map((e) => e.id).sort((x, y) => x - y), ids(mails.b));
    assert.equal(a.counts.all, 4);
    assert.equal(b.counts.all, 5);
    assert.deepEqual(a.accounts.map((x) => x.id), ["a-main", "a-side"]);
    assert.deepEqual(b.accounts.map((x) => x.id), ["b-main", "b-side"]);
    assert.ok(!JSON.stringify(a).match(marker("B")) && !JSON.stringify(a).includes("b-main"));
    assert.ok(!JSON.stringify(b).match(marker("A")) && !JSON.stringify(b).includes("a-main"));
  });

  it("every view and filter stays inside the user; an account filter naming a foreign account is empty, not an error", () => {
    for (const view of ["important", "open", "noise", "all"] as const) {
      for (const u of [A, B]) {
        const r = listEmails(db, u, query({ view }));
        assert.ok(r.emails.every((e) => ownsEmail(db, u, e.id)), `${view} ${u}`);
      }
    }
    assert.equal(listEmails(db, A, query({ account: "b-main" })).emails.length, 0);
    assert.equal(listEmails(db, A, query({ account: "b-main" })).counts.all, 0);
    assert.equal(listEmails(db, A, query({ status: "classified" })).emails.length, 4);
    assert.ok(listEmails(db, B, query({ view: "open" })).counts.open >= 1);
    const page = listEmails(db, B, query({ limit: 2 }));
    assert.equal(page.emails.length, 2);
    assert.ok(page.next_cursor !== null);
  });

  it("getEmailDetail: own mails open, foreign ids are null", () => {
    for (const m of mails.a) assert.equal(getEmailDetail(db, A, m.id)?.id, m.id);
    for (const m of mails.b) {
      assert.equal(getEmailDetail(db, A, m.id), null);
      assert.equal(getEmailDetail(db, B, m.id)?.id, m.id);
    }
    assert.equal(getEmailDetail(db, A, 999999), null);
  });

  it("listActions: own actions and counts only", () => {
    const a = listActions(db, A, { mode: null, status: null, limit: 20, cursor: null });
    const b = listActions(db, B, { mode: null, status: null, limit: 20, cursor: null });
    assert.deepEqual(a.actions.map((x) => x.email_id), [mails.a[1].id]);
    assert.deepEqual(b.actions.map((x) => x.email_id).sort(), [mails.b[1].id, mails.b[2].id].sort());
    assert.deepEqual(a.counts, { dry_run: { planned: 1, done: 0, failed: 0, undone: 0 }, live: { planned: 0, done: 0, failed: 0, undone: 0 } });
    assert.equal(b.counts.live.done, 1);
    assert.equal(b.counts.dry_run.planned, 1);
    assert.deepEqual(a.actions.map((x) => x.account), ["a-main"]);
  });
});

describe("feedback, senders, rules, HITL", () => {
  it("recordFeedback on a foreign mail is not_found and changes nothing (feedback, sender counters, audit)", () => {
    const before = JSON.stringify([db.prepare("SELECT * FROM feedback").all(), db.prepare("SELECT * FROM senders ORDER BY id").all(), db.prepare("SELECT COUNT(*) AS n FROM audit_log").get()]);
    for (const kind of ["spam_correct", "not_spam", "reply_needed", "no_reply_needed"] as const) {
      assert.deepEqual(recordFeedback(db, A, { emailId: mails.b[0].id, kind, ts: T }), { ok: false, code: "not_found" }, kind);
    }
    assert.deepEqual(recordFeedback(db, A, { emailId: mails.b[0].id, kind: "category_wrong", value: "business", ts: T }), { ok: false, code: "not_found" });
    assert.equal(JSON.stringify([db.prepare("SELECT * FROM feedback").all(), db.prepare("SELECT * FROM senders ORDER BY id").all(), db.prepare("SELECT COUNT(*) AS n FROM audit_log").get()]), before);
  });

  it("feedback of A counts for A's sender row only, even for an address both users receive from", () => {
    const r = recordFeedback(db, A, { emailId: mails.a[0].id, kind: "spam_correct", ts: T });
    assert.deepEqual(r, { ok: true, changed: true });
    assert.equal(senderCounts(db, A, SHARED)?.marked_spam, 1);
    assert.equal(senderCounts(db, B, SHARED)?.marked_spam, 3, "B's counter is untouched");
    assert.deepEqual(feedbackState(db, A, mails.a[0].id), { spam: "spam_correct", reply: null, category: null });
    assert.deepEqual(feedbackState(db, B, mails.a[0].id), { spam: null, reply: null, category: null }, "B cannot read A's feedback");
    assert.deepEqual(feedbackState(db, A, mails.b[0].id), { spam: null, reply: null, category: null });
  });

  it("sender bookkeeping is per user: recordSenderMail, ensureSender, senderCounts, feedbackHistory", () => {
    recordSenderMail(db, A, "fresh@new.example.test", "pass", T);
    assert.equal(senderCounts(db, A, "fresh@new.example.test")?.mails_seen, 1);
    assert.equal(senderCounts(db, B, "fresh@new.example.test"), null);
    assert.equal(ensureSender(db, B, "fresh@new.example.test", T), "fresh@new.example.test");
    assert.equal(senderCounts(db, B, "fresh@new.example.test")?.mails_seen, 0);
    assert.equal(senderCounts(db, A, "fresh@new.example.test")?.mails_seen, 1);
    assert.deepEqual(feedbackHistory(db, B, SHARED, "pass"), { user_marked_spam: 3, user_marked_not_spam: 0 });
    assert.deepEqual(feedbackHistory(db, A, SHARED, "pass"), { user_marked_spam: 1, user_marked_not_spam: 0 });
    assert.equal(feedbackHistory(db, A, "b-only@b-corp.example.test", "pass"), undefined);
  });

  it("recordJevSpam credits the sender row of the mail's owner", () => {
    const a0 = senderCounts(db, A, SHARED)!.jev_spam_count;
    const b0 = senderCounts(db, B, SHARED)!.jev_spam_count;
    // A mail with no other classified run counts once: use a fresh mail of B.
    const m = addMail("b", "b-main", { sender: SHARED });
    db.prepare("DELETE FROM classification_answers WHERE classification_id = (SELECT id FROM classifications WHERE email_id = ?)").run(m.id);
    db.prepare("DELETE FROM classifications WHERE email_id = ?").run(m.id);
    db.prepare("INSERT INTO classifications (email_id, question_set_version, model_requested, model_reported, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
      .run(m.id, QV, "m", "m", "classified", T, T);
    const id = Number(db.prepare("SELECT MAX(id) AS id FROM classifications").get()!.id);
    assert.equal(recordJevSpam(db, m.id, id, T), true);
    assert.equal(senderCounts(db, B, SHARED)!.jev_spam_count, b0 + 1);
    assert.equal(senderCounts(db, A, SHARED)!.jev_spam_count, a0, "A's counter is untouched");
  });

  it("ingest of a mail for B's account creates B's sender row, not A's", () => {
    const meta = { messageId: "<ingest@x>", sender: "ingested@only-b.example.test", subject: "s", receivedAt: T, dmarc: "pass", spf: "pass", dkim: "pass", listUnsubscribePresent: false, replyToDiffersFromFrom: false } as never;
    const ing = ingestMail(db, { accountId: "b-side", meta, loc: { folder: "INBOX", uid: 900, uidValidity: 1 }, now: NOW, traceId: "t" });
    mails.b.push({ id: ing.emailId, account: "b-side", subject: "s" });
    assert.equal(senderCounts(db, B, "ingested@only-b.example.test")?.mails_seen, 1);
    assert.equal(senderCounts(db, A, "ingested@only-b.example.test"), null);
  });

  it("rules: each user lists only their own; a rule of B never matches A's mail", () => {
    assert.deepEqual(listRules(db, A).map((r) => r.value), []);
    assert.deepEqual(listRules(db, B).map((r) => r.value).sort(), [SHARED, "b-corp.example.test"].sort());
    assert.deepEqual(senderRuleHit(db, A, "x@b-corp.example.test", "a-main"), { allowlisted: false, blacklisted: false });
    assert.deepEqual(senderRuleHit(db, B, "x@b-corp.example.test", "b-main"), { allowlisted: false, blacklisted: true });
    assert.deepEqual(senderRuleHit(db, B, SHARED, "b-main"), { allowlisted: true, blacklisted: false });
    assert.deepEqual(senderRuleHit(db, A, SHARED, "a-main"), { allowlisted: false, blacklisted: false }, "B's allowlist does not protect A's mail");
  });

  it("createRule: a foreign account is unknown; deactivateRule on a foreign rule is not_found and the rule stays active", () => {
    assert.deepEqual(createRule(db, A, { kind: "blacklist", match: "domain", value: "x.example.test", accountId: "b-main", ts: T }), { ok: false, code: "unknown_account" });
    const bRule = listRules(db, B)[0];
    assert.deepEqual(deactivateRule(db, A, bRule.id, T), { ok: false, code: "not_found" });
    assert.equal((db.prepare("SELECT active FROM sender_rules WHERE id = ?").get(bRule.id) as { active: number }).active, 1);
    const own = createRule(db, A, { kind: "blacklist", match: "domain", value: "b-corp.example.test", accountId: "a-main", ts: T });
    assert.ok(own.ok);
    assert.equal(listRules(db, B).filter((r) => r.value === "b-corp.example.test").length, 1, "same value, separate rule per user");
    assert.equal(listRules(db, A).length, 1);
    assert.ok(deactivateRule(db, A, own.rule.id, T).ok);
  });

  it("a rule of A replacing its opposite does not deactivate B's rule for the same target", () => {
    assert.ok(createRule(db, A, { kind: "allowlist", match: "domain", value: "b-corp.example.test", ts: T }).ok);
    assert.equal(listRules(db, B).find((r) => r.value === "b-corp.example.test")?.active, 1);
    assert.equal(listRules(db, B).find((r) => r.value === "b-corp.example.test")?.kind, "blacklist");
  });

  it("HITL: questions come from the user's own senders and rules; dismissing a foreign sender is not_found", () => {
    const a = listHitl(db, A);
    const b = listHitl(db, B);
    assert.deepEqual(a.map((c) => c.value), ["a-only@a-corp.example.test"]);
    assert.deepEqual(b.map((c) => c.value), ["b-hitl@other-b.example.test"], "B's domain rule and allowlist close the other questions");
    assert.deepEqual(dismissHitl(db, A, "address", "b-only@b-corp.example.test", T), { ok: false, code: "not_found" });
    assert.deepEqual(dismissHitl(db, A, "address", SHARED, T), { ok: true, changed: true });
    assert.equal((db.prepare("SELECT hitl_asked_count FROM senders WHERE user_id = ? AND address = ?").get(B, SHARED) as { hitl_asked_count: number }).hitl_asked_count, 0, "B was not asked");
    assert.equal((db.prepare("SELECT hitl_asked_count FROM senders WHERE user_id = ? AND address = ?").get(A, SHARED) as { hitl_asked_count: number }).hitl_asked_count, 1);
    const sample = sampleEmailIds(db, A, "address", SHARED);
    assert.ok(sample.every((id) => ownsEmail(db, A, id)), "samples are A's mails");
    assert.ok(sampleEmailIds(db, B, "address", SHARED).every((id) => ownsEmail(db, B, id)));
    assert.deepEqual(sampleEmailIds(db, A, "address", "b-only@b-corp.example.test"), []);
  });
});

describe("briefing context and user state", () => {
  it("the context contains only the user's open mails and counters", () => {
    const a = loadBriefingContext(db, A, NOW);
    const b = loadBriefingContext(db, B, NOW);
    assert.ok(!JSON.stringify(a).match(marker("B")), "A's briefing never mentions B's subjects");
    assert.ok(!JSON.stringify(b).match(marker("A")));
    assert.ok(a.mails.length > 0 && a.mails.every((m) => /A/.test(m.subject)), JSON.stringify(a.mails));
    assert.ok(b.mails.length > 0 && b.mails.every((m) => /SUBJ-B/.test(m.subject)));
    assert.equal(a.new_since_last_open, null, "A was never opened (B's last_opened_at is not A's)");
    assert.equal(typeof b.new_since_last_open, "number");
    assert.equal(b.auto_marked_read, 1, "B's live action; A's dry run does not count");
  });

  it("user_state: values are per user", () => {
    assert.equal(readLastOpened(db, A), null);
    assert.equal(readLastOpened(db, B), "2026-10-26T00:00:00.000Z");
    setUserState(db, A, "last_opened_at", { at: "2026-10-27T00:00:00.000Z" }, T);
    assert.equal(readLastOpened(db, A), "2026-10-27T00:00:00.000Z");
    assert.equal(readLastOpened(db, B), "2026-10-26T00:00:00.000Z");
    assert.deepEqual(getUserState(db, B, "last_opened_at"), { at: "2026-10-26T00:00:00.000Z" });
    db.prepare("DELETE FROM user_state WHERE user_id = ?").run(A);
  });
});

describe("agent paths", () => {
  it("buildAgentInput and the tool's readEmailContext treat a foreign mail as missing, before any IMAP call", async () => {
    let portCalls = 0;
    const portFactory = () => { portCalls++; throw new Error("must not be called"); };
    const r = await buildAgentInput({ db, userId: A, portFactory: portFactory as never }, mails.b[0].id);
    assert.deepEqual(r, { ok: false, code: "email_not_found" });
    assert.equal(portCalls, 0);
    assert.deepEqual(readEmailContext(db, A, mails.b[0].id, undefined), { ok: false, code: "email_not_found" });
    const own = readEmailContext(db, A, mails.a[0].id, undefined);
    assert.notEqual((own as { code?: string }).code, "email_not_found");
  });
});

describe("mailbox actions (undo)", () => {
  it("undoSeen on a foreign mail is not_found and changes nothing", async () => {
    const actions = createMailboxActions({ db, accounts: [], killSwitchFile: join(dir, "no-kill"), forceDryRun: true, now: () => NOW });
    const before = JSON.stringify([db.prepare("SELECT * FROM mailbox_actions ORDER BY id").all(), db.prepare("SELECT * FROM email_status ORDER BY email_id").all()]);
    assert.deepEqual(await actions.undoSeen(A, mails.b[1].id), { ok: false, code: "not_found" });
    assert.equal(JSON.stringify([db.prepare("SELECT * FROM mailbox_actions ORDER BY id").all(), db.prepare("SELECT * FROM email_status ORDER BY email_id").all()]), before);
    assert.deepEqual(await actions.undoSeen(B, mails.b[3].id), { ok: true, mode: "dry_run" });
  });

  it("evaluate for B's mail uses B's rules (the shared address is allowlisted for B only)", async () => {
    const actions = createMailboxActions({
      db, accounts: ["a-main", "b-main"].map((id) => ({
        id, label: id, context: "c", host: "imap.secret.example", port: 993, tls: true, user: "u", password: "p",
        mailbox: "INBOX", spam_mailbox: "Junk", spam_threshold: 0.9, enabled: true, auto_actions: { spam_seen: "dry_run" },
      })) as never,
      killSwitchFile: join(dir, "no-kill"), now: () => NOW,
    });
    db.prepare("DELETE FROM mailbox_actions WHERE email_id IN (?, ?)").run(mails.a[1].id, mails.b[1].id);
    const rA = await actions.evaluate(mails.a[1].id);
    const rB = await actions.evaluate(mails.b[1].id);
    assert.notEqual(rA.outcome, "no_action", "A has no allowlist for the sender: the rule applies");
    assert.equal(rB.outcome, "no_action", "B's allowlist protects B's mail");
  });
});

// ---- HTTP layer: the real route modules in users mode -------------------------------------------------------------
const HOST = "app.example.test";
const ORIGIN = `https://${HOST}`;
interface Who { cookie: string; csrf: string }
const sessions = new Map<string, Who>();
const ctxParams = (id: number | string) => ({ params: { id: String(id) } });

async function signIn(email: string): Promise<Who> {
  const hit = sessions.get(email);
  if (hit) return hit;
  process.env.DATABASE_PATH = file;
  process.env.AUTH_MODE = "users";
  delete process.env.APP_PASSWORD;
  const auth = defaultAuthContext();
  assert.equal(auth.mode, "users");
  const pre = ((await (await handleSession(new Request(`http://${HOST}/api/auth/session`, { headers: { host: HOST } }), auth)).json()) as { csrfToken: string }).csrfToken;
  const res = await handleLoginRequest(
    new Request(`http://${HOST}/api/auth/login`, {
      method: "POST", body: JSON.stringify({ email, password: PW }),
      headers: { host: HOST, origin: ORIGIN, "sec-fetch-site": "same-origin", [CSRF_HEADER]: pre, "content-type": "application/json" },
    }),
    auth, createMutationLimiter(),
  );
  assert.equal(res.status, 200);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  const csrf = ((await (await handleSession(new Request(`http://${HOST}/api/auth/session`, { headers: { host: HOST, cookie } }), auth)).json()) as { csrfToken: string }).csrfToken;
  const who = { cookie, csrf };
  sessions.set(email, who);
  return who;
}
const get = (path: string, who: Who | null) => new Request(`http://${HOST}${path}`, { headers: { host: HOST, ...(who ? { cookie: who.cookie } : {}) } });
const post = (path: string, who: Who, body?: unknown) =>
  new Request(`http://${HOST}${path}`, {
    method: "POST", body: body === undefined ? undefined : JSON.stringify(body),
    headers: { host: HOST, cookie: who.cookie, origin: ORIGIN, "sec-fetch-site": "same-origin", [CSRF_HEADER]: who.csrf, "x-csrf-token": "unused", "content-type": "application/json" },
  });
const snapshot = () => JSON.stringify(["email_status", "feedback", "senders", "sender_rules", "mailbox_actions", "user_state", "audit_log"].map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all()));

describe("API routes in users mode", () => {
  it("reads: lists, detail, actions, status, hitl, rules and feedback only show the caller's data", async () => {
    const a = await signIn("a@example.test");
    const b = await signIn("b@example.test");

    const listA = (await (await emailsRoute.GET(get("/api/emails", a))).json()) as { emails: { id: number }[]; counts: { all: number } };
    const listB = (await (await emailsRoute.GET(get("/api/emails", b))).json()) as { emails: { id: number }[]; counts: { all: number } };
    assert.deepEqual(listA.emails.map((e) => e.id).sort((x, y) => x - y), ids(mails.a));
    assert.deepEqual(listB.emails.map((e) => e.id).sort((x, y) => x - y), ids(mails.b));

    for (const m of mails.b) {
      const res = await emailRoute.GET(get(`/api/emails/${m.id}`, a), ctxParams(m.id));
      assert.equal(res.status, 404, `detail ${m.id}`);
      assert.deepEqual(await res.json(), { error: "not_found" });
      assert.equal((await emailRoute.GET(get(`/api/emails/${m.id}`, b), ctxParams(m.id))).status, 200);
      assert.equal((await feedbackRoute.GET(get(`/api/emails/${m.id}/feedback`, a), ctxParams(m.id))).status, 404);
    }
    assert.equal((await feedbackRoute.GET(get(`/api/emails/${mails.a[0].id}/feedback`, a), ctxParams(mails.a[0].id))).status, 200);

    const actA = (await (await actionsRoute.GET(get("/api/actions", a))).json()) as { actions: { email_id: number }[] };
    assert.deepEqual(actA.actions.map((x) => x.email_id), [mails.a[1].id]);

    const st = (await (await statusRoute.GET(get("/api/status", a))).json()) as { workers: { account_id: string }[]; classifications: Record<string, number> };
    assert.deepEqual(st.workers.map((w) => w.account_id), ["a-main", "a-side"]);
    assert.equal(st.classifications.classified, 4);
    const stB = (await (await statusRoute.GET(get("/api/status", b))).json()) as { workers: { account_id: string }[]; classifications: Record<string, number> };
    assert.deepEqual(stB.workers.map((w) => w.account_id), ["b-main", "b-side"]);
    assert.equal(stB.classifications.classified, 6);

    const hitlA = (await (await hitlRoute.GET(get("/api/senders/hitl", a))).json()) as { candidates: { value: string }[] };
    assert.ok(hitlA.candidates.every((c) => !c.value.includes("b-corp")));
    const rulesA = (await (await rulesRoute.GET(get("/api/senders/rules?include_inactive=1", a))).json()) as { rules: { id: number }[] };
    const ownA = (db.prepare("SELECT id FROM sender_rules WHERE user_id = ? ORDER BY id").all(A) as { id: number }[]).map((r) => r.id);
    assert.deepEqual(rulesA.rules.map((r) => r.id), ownA, "only A's rules, none of B's");
    const rulesB = (await (await rulesRoute.GET(get("/api/senders/rules", b))).json()) as { rules: { value: string }[] };
    assert.ok(rulesB.rules.some((r) => r.value === "b-corp.example.test"));
    const prof = (await (await profileRoute.GET(get("/api/profile", b))).json()) as { email: string; role: string };
    assert.deepEqual([prof.email, prof.role], ["b@example.test", "user"]);
  });

  it("every read route needs a session in users mode, even called without the interceptor", async () => {
    await signIn("a@example.test");
    for (const res of [
      await emailsRoute.GET(get("/api/emails", null)),
      await emailRoute.GET(get(`/api/emails/${mails.a[0].id}`, null), ctxParams(mails.a[0].id)),
      await actionsRoute.GET(get("/api/actions", null)),
      await statusRoute.GET(get("/api/status", null)),
      await hitlRoute.GET(get("/api/senders/hitl", null)),
      await rulesRoute.GET(get("/api/senders/rules", null)),
      await feedbackRoute.GET(get(`/api/emails/${mails.a[0].id}/feedback`, null), ctxParams(mails.a[0].id)),
      await profileRoute.GET(get("/api/profile", null)),
    ]) assert.equal(res.status, 401);
  });

  it("writes: A's done, undone, unread, feedback and deactivate on B's ids give 404 and change nothing; the same calls on A's own ids work", async () => {
    const a = await signIn("a@example.test");
    const before = snapshot();
    const target = mails.b[0].id;
    const bRule = listRules(db, B)[0].id;
    for (const [route, path] of [
      [doneRoute, `/api/emails/${target}/done`], [undoneRoute, `/api/emails/${target}/undone`], [unreadRoute, `/api/emails/${target}/unread`],
    ] as const) {
      const res = await route.POST(post(path, a), ctxParams(target));
      assert.equal(res.status, 404, path);
      assert.deepEqual(await res.json(), { error: "not_found" }, path);
    }
    const fb = await feedbackRoute.POST(post(`/api/emails/${target}/feedback`, a, { kind: "not_spam" }), ctxParams(target));
    assert.equal(fb.status, 404);
    assert.equal((await deactivateRoute.POST(post(`/api/senders/rules/${bRule}/deactivate`, a), ctxParams(bRule))).status, 404);
    assert.equal((await dismissRoute.POST(post("/api/senders/hitl/dismiss", a, { match: "address", value: "b-only@b-corp.example.test" }))).status, 404);
    const withForeignAccount = await rulesRoute.POST(post("/api/senders/rules", a, { match: "domain", value: "x.example.test", kind: "blacklist", account_id: "b-main" }));
    assert.equal(withForeignAccount.status, 400);
    assert.deepEqual(await withForeignAccount.json(), { error: "unknown_account" });
    assert.equal(snapshot(), before, "no table changed");

    const own = mails.a[2].id;
    assert.equal((await doneRoute.POST(post(`/api/emails/${own}/done`, a), ctxParams(own))).status, 200);
    assert.equal((await undoneRoute.POST(post(`/api/emails/${own}/undone`, a), ctxParams(own))).status, 200);
    assert.equal((await feedbackRoute.POST(post(`/api/emails/${own}/feedback`, a, { kind: "reply_needed" }), ctxParams(own))).status, 200);
  });

  it("writes: B's calls on A's ids are 404 too, and B's own calls change only B's rows", async () => {
    const b = await signIn("b@example.test");
    const target = mails.a[2].id;
    const before = JSON.stringify(db.prepare("SELECT * FROM email_status WHERE email_id = ?").all(target));
    assert.equal((await doneRoute.POST(post(`/api/emails/${target}/done`, b), ctxParams(target))).status, 404);
    assert.equal(JSON.stringify(db.prepare("SELECT * FROM email_status WHERE email_id = ?").all(target)), before);
    const own = mails.b[0].id;
    assert.equal((await doneRoute.POST(post(`/api/emails/${own}/done`, b), ctxParams(own))).status, 200);
    assert.equal((db.prepare("SELECT done FROM email_status WHERE email_id = ?").get(own) as { done: number }).done, 1);
    const res = await rulesRoute.POST(post("/api/senders/rules", b, { match: "domain", value: "mine.example.test", kind: "blacklist", account_id: "b-side" }));
    assert.equal(res.status, 200);
    assert.equal((db.prepare("SELECT user_id FROM sender_rules WHERE value = 'mine.example.test'").get() as { user_id: number }).user_id, B);
  });

  it("the briefing route builds its context from the caller's data and stores last_opened_at for the caller only", async () => {
    const a = await signIn("a@example.test");
    delete process.env.OPENROUTER_API_KEY;
    const res = await briefingRoute.POST(post("/api/briefing", a));
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(!marker("B").test(text), "no subject of B in A's briefing stream");
    assert.ok(readLastOpened(db, A) !== null);
    assert.equal(readLastOpened(db, B), "2026-10-26T00:00:00.000Z");
  });

  it("the draft handler answers a foreign mail with 404 before the agent or an IMAP port is touched", async () => {
    const a = await signIn("a@example.test");
    let agentCalls = 0;
    let portCalls = 0;
    const auth = defaultAuthContext();
    const res = await handleDraft(post(`/api/emails/${mails.b[0].id}/draft`, a), String(mails.b[0].id), {
      auth, limiter: createMutationLimiter(), openDb: () => openDatabase(file),
      portFactory: () => { portCalls++; throw new Error("no port"); },
      agent: () => ({ generate: async () => { agentCalls++; return {}; } }) as never,
    });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "email_not_found" });
    assert.deepEqual([agentCalls, portCalls], [0, 0]);
  });

  it("a signed-out request and a disabled user get nothing from the mutation routes either", async () => {
    const a = await signIn("a@example.test");
    const before = snapshot();
    assert.equal((await doneRoute.POST(new Request(`http://${HOST}/x`, { method: "POST", headers: { host: HOST, origin: ORIGIN, [CSRF_HEADER]: a.csrf } }), ctxParams(mails.a[0].id))).status, 401);
    db.exec("UPDATE users SET status = 'disabled' WHERE id = 2");
    const b = await signIn("b@example.test");
    assert.equal((await doneRoute.POST(post(`/api/emails/${mails.b[0].id}/done`, b), ctxParams(mails.b[0].id))).status, 401);
    assert.equal((await emailsRoute.GET(get("/api/emails", b))).status, 401);
    db.exec("UPDATE users SET status = 'active' WHERE id = 2");
    assert.equal((await emailsRoute.GET(get("/api/emails", b))).status, 200);
    assert.equal(snapshot(), before);
  });
});

describe("mail accounts API (R2)", () => {
  const ACC_PW = "synthetic-acc-password-";
  const saved = process.env.ACCOUNTS_ENCRYPTION_KEY;
  const newBody = (label: string, pw: string) => ({ type: "imap", label, username: `${label}@example.test`, password: pw, host: "imap.example.test", port: 993, tls: true });
  const accState = () => JSON.stringify([db.prepare("SELECT * FROM accounts ORDER BY id").all(), db.prepare("SELECT account_id, user_id, type, username, key_id, secret_set_at, last_test_at, last_test_code, context, spam_seen_mode, updated_at, hex(secret_ciphertext) AS c, hex(secret_nonce) AS n, hex(secret_tag) AS t FROM mail_accounts ORDER BY account_id").all(), db.prepare("SELECT account_id, state FROM worker_status ORDER BY account_id").all()]);

  it("each user creates, lists and changes only their own accounts; the other user's ids are 404 and change nothing", async () => {
    process.env.ACCOUNTS_ENCRYPTION_KEY = generateKey();
    try {
      const a = await signIn("a@example.test");
      const b = await signIn("b@example.test");
      const ca = await accountsRoute.POST(post("/api/accounts", a, newBody("alpha", ACC_PW + "A")));
      const cb = await accountsRoute.POST(post("/api/accounts", b, newBody("beta", ACC_PW + "B")));
      assert.deepEqual([ca.status, cb.status], [201, 201]);
      const idA = ((await ca.json()) as { account: { id: string } }).account.id;
      const idB = ((await cb.json()) as { account: { id: string } }).account.id;
      assert.equal((db.prepare("SELECT user_id FROM accounts WHERE id = ?").get(idA) as { user_id: number }).user_id, A);
      assert.equal((db.prepare("SELECT user_id FROM mail_accounts WHERE account_id = ?").get(idB) as { user_id: number }).user_id, B);

      const listA = await (await accountsRoute.GET(get("/api/accounts", a))).text();
      const listB = await (await accountsRoute.GET(get("/api/accounts", b))).text();
      const idsOf = (t: string) => (JSON.parse(t) as { accounts: { id: string }[] }).accounts.map((x) => x.id).sort();
      assert.deepEqual(idsOf(listA), ["a-main", "a-side", idA].sort());
      assert.deepEqual(idsOf(listB), ["b-main", "b-side", idB].sort());
      assert.ok(!listA.includes(idB) && !listA.includes("beta") && !listA.includes("b-main"));
      assert.ok(!listB.includes(idA) && !listB.includes("alpha") && !listB.includes("a-main"));
      assert.ok(!listA.includes(ACC_PW) && !listB.includes(ACC_PW), "no secret in any list");
      assert.equal((await accountsRoute.GET(get("/api/accounts", null))).status, 401);

      const before = accState();
      for (const [route, path, body] of [
        [accountRoute, `/api/accounts/${idB}`, { label: "hijack", password: "hijacked-pass-1" }],
        [accountDisableRoute, `/api/accounts/${idB}/disable`, undefined],
        [accountEnableRoute, `/api/accounts/${idB}/enable`, undefined],
        [accountTestRoute, `/api/accounts/${idB}/test`, undefined],
      ] as const) {
        const res = await route.POST(post(path, a, body), ctxParams(idB));
        assert.equal(res.status, 404, path);
        assert.deepEqual(await res.json(), { error: "not_found" }, path);
      }
      // an unknown id looks exactly the same
      const unknown = await accountDisableRoute.POST(post("/api/accounts/a_0000000000000000/disable", a), ctxParams("a_0000000000000000"));
      assert.deepEqual([unknown.status, await unknown.json()], [404, { error: "not_found" }]);
      assert.equal(accState(), before, "no table changed");

      assert.equal((await accountRoute.POST(post(`/api/accounts/${idA}`, a, { label: "alpha2" }), ctxParams(idA))).status, 200);
      assert.equal((await accountDisableRoute.POST(post(`/api/accounts/${idA}/disable`, a), ctxParams(idA))).status, 200);
      assert.equal((await accountEnableRoute.POST(post(`/api/accounts/${idA}/enable`, a), ctxParams(idA))).status, 200);
      assert.equal((await accountRoute.POST(post(`/api/accounts/${idA}`, b, { label: "x" }), ctxParams(idA))).status, 404);
      assert.equal((db.prepare("SELECT label FROM accounts WHERE id = ?").get(idB) as { label: string }).label, "beta");

      // the worker side sees both users' accounts, each with its own secret
      const ring = loadKeyring(process.env);
      assert.ok(ring.ok);
      const w = loadWorkerAccounts(db, ring.keyring).accounts.filter((x) => x.id === idA || x.id === idB);
      assert.deepEqual(w.map((x) => x.password).sort(), [ACC_PW + "A", ACC_PW + "B"]);
    } finally {
      if (saved === undefined) delete process.env.ACCOUNTS_ENCRYPTION_KEY; else process.env.ACCOUNTS_ENCRYPTION_KEY = saved;
    }
  });

  it("the account sync of the status route and the list header only see own accounts' worker rows", async () => {
    const a = await signIn("a@example.test");
    const st = (await (await statusRoute.GET(get("/api/status", a))).json()) as { workers: { account_id: string }[] };
    assert.ok(st.workers.every((x) => !x.account_id.startsWith("b-")));
  });
});
