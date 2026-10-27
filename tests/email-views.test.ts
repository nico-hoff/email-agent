import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../lib/db.ts";
import { syncAccounts } from "../lib/accounts.ts";
import { accountColor } from "../lib/account-color.ts";
import {
  compareSortKeys, decodeCursor, encodeCursor, getEmailDetail, isNoise, isOpen, listEmails, parseListQuery, type SortKey,
} from "../lib/email-api.ts";
import * as listRoute from "../app/api/emails/route.ts";
import * as detailRoute from "../app/api/emails/[id]/route.ts";

const T = "2026-10-27T08:00:00.000Z";
const QV = "email-classification-v1";

describe("isOpen (Plan v5, 3.6): a call to action that is neither read nor done", () => {
  test("cta = needs_my_reply positive or route draft_reply/notify", () => {
    const base = { seen: false, done: false };
    assert.equal(isOpen({ ...base, needsMyReply: "positive", route: "ignore" }), true);
    assert.equal(isOpen({ ...base, needsMyReply: "positive", route: null }), true);
    assert.equal(isOpen({ ...base, needsMyReply: "unmapped", route: "notify" }), true);
    assert.equal(isOpen({ ...base, needsMyReply: null, route: "draft_reply" }), true);
    assert.equal(isOpen({ ...base, needsMyReply: "negative", route: "notify" }), true, "route alone is enough");
    assert.equal(isOpen({ ...base, needsMyReply: "negative", route: "digest" }), false);
    assert.equal(isOpen({ ...base, needsMyReply: "unmapped", route: "ignore" }), false);
    assert.equal(isOpen({ ...base, needsMyReply: null, route: null }), false);
  });
  test("read or done closes it, each on its own", () => {
    const cta = { needsMyReply: "positive", route: "notify" } as const;
    assert.equal(isOpen({ ...cta, seen: false, done: false }), true);
    assert.equal(isOpen({ ...cta, seen: true, done: false }), false);
    assert.equal(isOpen({ ...cta, seen: false, done: true }), false);
    assert.equal(isOpen({ ...cta, seen: true, done: true }), false);
  });
  test("noise = category spam or newsletter_promo, or the provider filed it as spam", () => {
    assert.equal(isNoise({ category: "spam", providerSpam: false }), true);
    assert.equal(isNoise({ category: "newsletter_promo", providerSpam: false }), true);
    assert.equal(isNoise({ category: "business", providerSpam: true }), true);
    assert.equal(isNoise({ category: null, providerSpam: true }), true);
    assert.equal(isNoise({ category: "transactional", providerSpam: false }), false);
    assert.equal(isNoise({ category: null, providerSpam: false }), false);
  });
});

describe("sort keys and cursors", () => {
  const k = (urgency: number | null, importance: number | null, receivedAt: string, id: number): SortKey => ({ urgency, importance, receivedAt, id });
  test("urgency, then importance, then time, then id, all descending; missing values last", () => {
    const keys = [
      k(null, null, "2026-10-27T12:00:00.000Z", 9),
      k(1, 3, "2026-10-27T01:00:00.000Z", 1),
      k(3, 0, "2026-10-27T01:00:00.000Z", 2),
      k(3, 2, "2026-10-27T01:00:00.000Z", 3),
      k(3, 2, "2026-10-27T05:00:00.000Z", 4),
      k(3, 2, "2026-10-27T05:00:00.000Z", 5),
      k(3, null, "2026-10-27T23:00:00.000Z", 6),
      k(null, 3, "2026-10-27T11:00:00.000Z", 7),
    ];
    assert.deepEqual([...keys].sort(compareSortKeys).map((x) => x.id), [5, 4, 3, 2, 6, 1, 7, 9]);
  });
  test("cursor round trip, opaque, and strict validation", () => {
    const key = k(2.5, null, T, 42);
    const c = encodeCursor(key);
    assert.match(c, /^[A-Za-z0-9_-]+$/);
    assert.deepEqual(decodeCursor(c), key);
    for (const bad of ["", "%%%", "e30", Buffer.from("[1,2]").toString("base64url"), Buffer.from('["a",1,"t",1]').toString("base64url"),
      Buffer.from('[1,1,"t",0]').toString("base64url"), Buffer.from('[1,1,5,1]').toString("base64url"), Buffer.from("[1,1,\"t\",1.5]").toString("base64url"), "x".repeat(2000)]) {
      assert.equal(decodeCursor(bad), null, bad.slice(0, 20));
    }
  });
});

describe("parseListQuery", () => {
  const q = (s: string) => parseListQuery(new URL(`http://x/api/emails${s}`));
  test("defaults, clamp and strict values", () => {
    assert.deepEqual(q(""), { ok: true, query: { view: null, account: null, status: null, limit: 50, cursor: null, paged: false } });
    const paged = q("?view=open&limit=500");
    assert.ok(paged.ok && paged.query.limit === 50 && paged.query.paged && paged.query.view === "open");
    const legacy = q("?limit=500");
    assert.ok(legacy.ok && legacy.query.limit === 200 && !legacy.query.paged);
    assert.deepEqual(q("?view=bogus"), { ok: false, error: "invalid_view" });
    assert.deepEqual(q("?view=folder:work"), { ok: false, error: "invalid_view" });
    assert.deepEqual(q("?limit=abc"), { ok: false, error: "invalid_limit" });
    assert.deepEqual(q("?status=bogus"), { ok: false, error: "invalid_status" });
    assert.deepEqual(q("?cursor=%%"), { ok: false, error: "invalid_cursor" });
    const c = encodeCursor({ urgency: 1, importance: null, receivedAt: T, id: 3 });
    const withCursor = q(`?cursor=${c}`);
    assert.ok(withCursor.ok && withCursor.query.paged && withCursor.query.view === null);
  });
});

// ---- fixture ---------------------------------------------------------------------------------------------------

interface M {
  id: number;
  account?: string;
  recv: string;
  folder?: string;
  category?: string;
  route?: string;
  urgency?: number;
  importance?: number;
  needs?: number;
  seen?: 0 | 1;
  done?: 0 | 1;
  status?: "classified" | "pending";
  version?: string;
}

function fixture(mails: M[]) {
  const dir = mkdtempSync(join(tmpdir(), "views-"));
  chmodSync(dir, 0o700);
  const file = join(dir, "t.sqlite");
  const db = openDatabase(file);
  syncAccounts(db, [
    { id: "a1", label: "Privat", color: "#112233", context: "c", host: "imap.one.example", port: 993, tls: true, user: "secret-user", password: "secret-pw", mailbox: "INBOX", spam_mailbox: "Junk", spam_threshold: 0.9, enabled: true },
    { id: "a2", label: "Arbeit", context: "c", host: "imap.two.example", port: 993, tls: true, user: "u2", password: "p2", mailbox: "INBOX", spam_threshold: 0.9, enabled: true },
  ] as never);
  for (const m of mails) {
    const acc = m.account ?? "a1";
    db.prepare("INSERT INTO emails (id, account_id, message_id, sender, subject, received_at, first_seen_at) VALUES (?,?,?,?,?,?,?)")
      .run(m.id, acc, `m${m.id}`, `s${m.id}@x.example`, `subject ${m.id}`, m.recv, T);
    db.prepare("INSERT INTO email_locations (email_id, account_id, folder, uid_validity, uid, is_active, first_seen_at, last_seen_at) VALUES (?,?,?,?,?,1,?,?)")
      .run(m.id, acc, m.folder ?? "INBOX", 1, m.id, T, T);
    if (m.seen !== undefined || m.done !== undefined) {
      db.prepare("INSERT INTO email_status (email_id, seen, done, updated_at) VALUES (?,?,?,?)").run(m.id, m.seen ?? 0, m.done ?? 0, T);
    }
    const status = m.status ?? "classified";
    db.prepare(
      "INSERT INTO classifications (id, email_id, question_set_version, model_requested, model_reported, status, attempts, created_at, updated_at) VALUES (?,?,?,?,?,?,1,?,?)",
    ).run(m.id, m.id, m.version ?? QV, "typesafe/jev-1.13", status === "classified" ? "typesafe/jev-1.13" : null, status, T, T);
    const ans = (key: string, type: string, value: unknown) =>
      db.prepare("INSERT INTO classification_answers (classification_id, question_key, type, answer_json) VALUES (?,?,?,?)")
        .run(m.id, key, type, JSON.stringify({ value }));
    if (status === "classified") {
      ans("category", "choice", m.category ?? "business");
      ans("route", "choice", m.route ?? "ignore");
      if (m.urgency !== undefined) ans("urgency", "score", m.urgency);
      if (m.importance !== undefined) ans("importance", "score", m.importance);
      if (m.needs !== undefined) ans("needs_my_reply", "noul", m.needs);
      ans("is_spam", "noul", m.category === "spam" ? 0.95 : 0.05);
    }
  }
  return { db, dir, file };
}

const day = (n: number) => `2026-10-${String(n).padStart(2, "0")}T10:00:00.000Z`;
const MIXED: M[] = [
  { id: 1, recv: day(20), category: "personal", route: "notify", urgency: 3, importance: 1 },
  { id: 2, recv: day(21), category: "business", route: "draft_reply", urgency: 3, importance: 2 },
  { id: 3, recv: day(22), category: "spam", route: "ignore", urgency: 0, importance: 0 },
  { id: 4, recv: day(22), category: "newsletter_promo", route: "digest", urgency: 0, importance: 0 },
  { id: 5, recv: day(23), category: "business", route: "ignore", folder: "Junk", urgency: 1, importance: 1 },
  { id: 6, recv: day(19), category: "transactional", route: "ignore", urgency: 0, importance: 1 },
  { id: 7, recv: day(24), status: "pending" },
  { id: 8, recv: day(18), category: "personal", route: "notify", urgency: 2, importance: 2, seen: 1 },
  { id: 9, recv: day(17), category: "personal", route: "notify", urgency: 2, importance: 3, done: 1 },
  { id: 10, recv: day(16), category: "security_auth", route: "notify", urgency: 2, importance: 1, seen: 0 },
  { id: 11, account: "a2", recv: day(15), category: "business", route: "draft_reply", urgency: 1, importance: 0 },
];

type Item = { id: number; open: boolean; seen: boolean; done: boolean; account: { id: string; label: string; color: string } };
type Page = { emails: Item[]; next_cursor: string | null; counts: Record<string, number>; accounts: unknown[]; view: string };

async function call(file: string, qs = "") {
  const prev = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = file;
  try {
    const res = await listRoute.GET(new Request(`http://x/api/emails${qs}`));
    const text = await res.text();
    return { res, text, body: (res.status === 200 ? JSON.parse(text) : JSON.parse(text)) as Page & { error?: string } };
  } finally {
    if (prev === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = prev;
  }
}
const ids = (b: Page) => b.emails.map((e) => e.id);
const cleanup = (f: { db: DatabaseSync; dir: string }) => {
  f.db.close();
  rmSync(f.dir, { recursive: true, force: true });
};

describe("GET /api/emails?view=", () => {
  test("important: everything but spam, newsletter_promo and the provider's spam folder; urgency, importance, time", async () => {
    const f = fixture(MIXED);
    try {
      const { body } = await call(f.file, "?view=important");
      // urgency 3: 2 (imp 2), 1 (imp 1); urgency 2: 9 (imp 3), 8 (imp 2), 10 (imp 1); urgency 1: 11; urgency 0: 6; no answers: 7
      assert.deepEqual(ids(body), [2, 1, 9, 8, 10, 11, 6, 7]);
      assert.equal(body.view, "important");
    } finally { cleanup(f); }
  });

  test("noise: spam, newsletter_promo and provider spam, same ordering", async () => {
    const f = fixture(MIXED);
    try {
      const { body } = await call(f.file, "?view=noise");
      assert.deepEqual(ids(body), [5, 4, 3]);
    } finally { cleanup(f); }
  });

  test("open: call to action, neither seen nor done (needs_my_reply is uncalibrated, so route decides)", async () => {
    const f = fixture([...MIXED, { id: 12, recv: day(14), category: "personal", route: "ignore", urgency: 3, importance: 3, needs: 0.99 }]);
    try {
      const { body } = await call(f.file, "?view=open");
      assert.deepEqual(ids(body), [2, 1, 10, 11], "8 is seen, 9 is done, 12 would need a calibrated needs_my_reply");
      assert.ok(body.emails.every((e) => e.open && !e.seen && !e.done));
    } finally { cleanup(f); }
  });

  test("all, and counts for every view (badges) independent of the selected view and the page size", async () => {
    const f = fixture(MIXED);
    try {
      const all = await call(f.file, "?view=all&limit=3");
      assert.equal(all.body.emails.length, 3);
      assert.deepEqual(all.body.counts, { important: 8, open: 4, noise: 3, all: 11 });
      const open = await call(f.file, "?view=open");
      assert.deepEqual(open.body.counts, all.body.counts);
    } finally { cleanup(f); }
  });

  test("account filter applies to the list and to the counts; every mail carries its tag", async () => {
    const f = fixture(MIXED);
    try {
      const { body, text } = await call(f.file, "?view=all&account=a2");
      assert.deepEqual(ids(body), [11]);
      assert.deepEqual(body.counts, { important: 1, open: 1, noise: 0, all: 1 });
      assert.deepEqual(body.emails[0].account, { id: "a2", label: "Arbeit", color: accountColor("a2", null) });
      const a1 = (await call(f.file, "?view=all&account=a1")).body.emails[0];
      assert.deepEqual(a1.account, { id: "a1", label: "Privat", color: "#112233" });
      assert.deepEqual(body.accounts, [
        { id: "a1", label: "Privat", color: "#112233" },
        { id: "a2", label: "Arbeit", color: accountColor("a2", null) },
      ]);
      for (const bad of ["imap.one", "imap.two", "secret-user", "secret-pw", "host", "password"]) assert.ok(!text.includes(bad), bad);
    } finally { cleanup(f); }
  });

  test("cards carry seen, done, open and the compact classification fields", async () => {
    const f = fixture(MIXED);
    try {
      const { body } = await call(f.file, "?view=all&limit=50");
      const by = (id: number) => body.emails.find((e) => e.id === id) as Item & Record<string, unknown>;
      assert.deepEqual([by(8).seen, by(8).done, by(8).open], [true, false, false]);
      assert.deepEqual([by(9).seen, by(9).done, by(9).open], [false, true, false]);
      assert.deepEqual([by(2).seen, by(2).done, by(2).open], [false, false, true]);
      assert.deepEqual([by(7).seen, by(7).done, by(7).open], [false, false, false], "a pending mail has no status row and is no call to action");
      assert.deepEqual(
        { category: by(2).category, route: by(2).route, urgency: by(2).urgency, importance: by(2).importance },
        { category: "business", route: "draft_reply", urgency: 3, importance: 2 },
      );
      assert.deepEqual({ category: by(7).category, route: by(7).route, urgency: by(7).urgency, importance: by(7).importance }, { category: null, route: null, urgency: null, importance: null });
    } finally { cleanup(f); }
  });

  test("status filter still works in the paged mode", async () => {
    const f = fixture(MIXED);
    try {
      assert.deepEqual(ids((await call(f.file, "?view=all&status=pending")).body), [7]);
    } finally { cleanup(f); }
  });

  test("no body, excerpt, raw source and no host/user/password anywhere", async () => {
    const f = fixture(MIXED);
    try {
      const { text } = await call(f.file, "?view=all");
      for (const bad of ["body", "snippet", "excerpt", "\"raw", "imap.", "secret-pw", "OPENROUTER"]) {
        assert.ok(!text.toLowerCase().includes(bad.toLowerCase()), bad);
      }
    } finally { cleanup(f); }
  });
});

describe("cursor pagination", () => {
  test("pages cover the list exactly once, in order, and the last page has no cursor", async () => {
    const f = fixture(MIXED);
    try {
      const whole = ids((await call(f.file, "?view=all&limit=50")).body);
      const collected: number[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const { body }: { body: Page } = await call(f.file, `?view=all&limit=4${cursor ? `&cursor=${cursor}` : ""}`);
        collected.push(...ids(body));
        cursor = body.next_cursor;
        pages++;
        assert.ok(pages < 10);
      } while (cursor);
      assert.equal(pages, 3);
      assert.deepEqual(collected, whole);
      assert.equal(whole.length, 11);
    } finally { cleanup(f); }
  });

  test("keyset: a mail arriving between two pages neither repeats nor skips rows", async () => {
    const f = fixture(MIXED);
    try {
      const first = (await call(f.file, "?view=all&limit=3")).body;
      // a new, most urgent mail arrives, and one of the already delivered rows is marked done
      f.db.prepare("INSERT INTO emails (id, account_id, message_id, sender, subject, received_at, first_seen_at) VALUES (99,'a1','m99','s@x.example','new',?,?)").run(day(26), T);
      f.db.prepare("INSERT INTO classifications (id, email_id, question_set_version, model_requested, model_reported, status, attempts, created_at, updated_at) VALUES (99,99,?,?,?,'classified',1,?,?)").run(QV, "m", "m", T, T);
      f.db.prepare("INSERT INTO classification_answers (classification_id, question_key, type, answer_json) VALUES (99,'urgency','score','{\"value\":3}')").run();
      f.db.prepare("INSERT INTO email_status (email_id, seen, done, updated_at) VALUES (?,0,1,?)").run(first.emails[0].id, T);
      const second = (await call(f.file, `?view=all&limit=50&cursor=${first.next_cursor}`)).body;
      const seen = new Set(ids(first));
      assert.ok(ids(second).every((id) => !seen.has(id)), "no repeats");
      assert.deepEqual([...ids(first), ...ids(second)].filter((id) => id !== 99).sort((a, b) => a - b), MIXED.map((m) => m.id));
      assert.ok(!ids(second).includes(99), "the new row sorts before the cursor, i.e. into an earlier page");
    } finally { cleanup(f); }
  });

  test("limit is capped at 50 in the paged mode; an exact fit has no cursor", async () => {
    const many: M[] = Array.from({ length: 60 }, (_, i) => ({ id: i + 1, recv: `2026-10-01T${String(i % 24).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00.000Z`, urgency: i % 4 }));
    const f = fixture(many);
    try {
      const { body } = await call(f.file, "?view=all&limit=500");
      assert.equal(body.emails.length, 50);
      assert.ok(body.next_cursor);
      const rest = (await call(f.file, `?view=all&limit=50&cursor=${body.next_cursor}`)).body;
      assert.equal(rest.emails.length, 10);
      assert.equal(rest.next_cursor, null);
      const fit = (await call(f.file, "?view=all&limit=50&account=a1")).body;
      assert.equal(fit.emails.length, 50);
      const exact = fixture(many.slice(0, 50));
      try {
        assert.equal((await call(exact.file, "?view=all&limit=50")).body.next_cursor, null);
      } finally { cleanup(exact); }
    } finally { cleanup(f); }
  });

  test("bad input answers 400 with a fixed code", async () => {
    const f = fixture(MIXED);
    try {
      for (const [qs, code] of [["?view=bogus", "invalid_view"], ["?view=all&cursor=nonsense", "invalid_cursor"], ["?view=all&limit=x", "invalid_limit"], ["?view=all&status=zz", "invalid_status"]]) {
        const { res, body } = await call(f.file, qs);
        assert.equal(res.status, 400, qs);
        assert.equal(body.error, code);
      }
    } finally { cleanup(f); }
  });
});

describe("legacy mode (no view, no cursor): the current UI keeps working until it switches", () => {
  test("newest first, up to 200 rows, status filter and the old fields, plus the additive new ones", async () => {
    const f = fixture(MIXED);
    try {
      const { body } = await call(f.file);
      assert.deepEqual(ids(body), [7, 5, 3, 4, 2, 1, 6, 8, 9, 10, 11].sort((a, b) => {
        const ra = MIXED.find((m) => m.id === a)!.recv, rb = MIXED.find((m) => m.id === b)!.recv;
        return ra < rb ? 1 : ra > rb ? -1 : b - a;
      }));
      assert.equal(body.next_cursor, null);
      assert.equal(body.view, "all");
      const e = body.emails[0] as unknown as Record<string, unknown>;
      for (const key of ["account_id", "active_location", "provider_spam", "classification", "shadow_quarantine", "disagreement", "seen", "done", "open", "account"]) {
        assert.ok(Object.hasOwn(e, key), key);
      }
    } finally { cleanup(f); }
  });
});

describe("needs_my_reply once it is calibrated (injected reading)", () => {
  test("a positive reading opens a mail whatever its route says", () => {
    const f = fixture([{ id: 1, recv: day(20), route: "ignore", needs: 0.7, urgency: 1 }, { id: 2, recv: day(20), route: "ignore", needs: 0.2, urgency: 1 }]);
    try {
      const readNoul = (a: { key: string; value: unknown }) => (a.key === "needs_my_reply" ? ((a.value as number) >= 0.5 ? "positive" : "negative") : "unmapped");
      const res = listEmails(f.db, { view: "open", account: null, status: null, limit: 50, cursor: null, paged: true }, { readNoul: readNoul as never });
      assert.deepEqual(res.emails.map((e) => e.id), [1]);
      assert.equal(res.emails[0].needs_my_reply, "positive");
      assert.deepEqual(res.counts, { important: 2, open: 1, noise: 0, all: 2 });
    } finally { cleanup(f); }
  });
});

// ---- detail ------------------------------------------------------------------------------------------------------

async function detail(file: string, id: string) {
  const prev = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = file;
  try {
    const res = await detailRoute.GET(new Request(`http://x/api/emails/${id}`), { params: Promise.resolve({ id }) });
    const text = await res.text();
    return { res, text, body: JSON.parse(text) as Record<string, any> };
  } finally {
    if (prev === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = prev;
  }
}

describe("GET /api/emails/:id", () => {
  test("detail: answers with reading, threshold and calibration version, shadow, disagreement, status, tag", async () => {
    const f = fixture([{ id: 1, recv: day(20), category: "spam", route: "ignore", urgency: 1, importance: 2, seen: 1, done: 1 }]);
    f.db.prepare("INSERT INTO classification_answers (classification_id, question_key, type, answer_json) VALUES (1,'shadow_quarantine','derived',?)")
      .run(JSON.stringify({ candidate: true, decision: "pending_policy", applied_threshold: 0.9, inputs: { is_spam: 0.95, needs_my_reply: 0.1, is_assessable: 0.9, category: "spam" }, reason: "candidate" }));
    try {
      const { res, body, text } = await detail(f.file, "1");
      assert.equal(res.status, 200);
      assert.equal(body.id, 1);
      assert.deepEqual(body.account, { id: "a1", label: "Privat", color: "#112233" });
      assert.deepEqual([body.seen, body.done, body.open], [true, true, false]);
      assert.deepEqual(body.classification.answers.is_spam, { type: "noul", value: 0.95, reading: "positive", threshold: 0.8, calibration_version: "1" });
      assert.equal(body.classification.answers.category.value, "spam");
      assert.equal(body.classification.question_set_version, QV);
      assert.equal(body.shadow_quarantine.decision, "pending_policy");
      assert.equal(body.disagreement, "jev_spam_provider_not_spam");
      assert.equal(body.provider_spam, false);
      assert.equal(res.headers.get("cache-control"), "no-store");
      for (const bad of ["body", "excerpt", "snippet", "imap.", "secret-pw"]) assert.ok(!text.toLowerCase().includes(bad), bad);
    } finally { cleanup(f); }
  });

  test("folder history from audit folder_changed and the locations of the mail", async () => {
    const f = fixture([{ id: 1, recv: day(20), folder: "Junk" }]);
    f.db.prepare("INSERT INTO email_locations (email_id, account_id, folder, uid_validity, uid, is_active, first_seen_at, last_seen_at) VALUES (1,'a1','INBOX',1,500,0,?,?)").run("2026-10-20T09:00:00.000Z", T);
    f.db.prepare("INSERT INTO audit_log (occurred_at, trace_id, actor, action, account_id, email_id, details_json) VALUES (?,?,?,?,?,?,?)")
      .run("2026-10-20T10:00:00.000Z", "t1", "worker", "folder_changed", "a1", 1, JSON.stringify({ from: "INBOX", to: "Junk" }));
    f.db.prepare("INSERT INTO audit_log (occurred_at, trace_id, actor, action, account_id, email_id, details_json) VALUES (?,?,?,?,?,?,?)")
      .run("2026-10-20T11:00:00.000Z", "t2", "worker", "worker_connected", "a1", 1, "{}");
    f.db.prepare("INSERT INTO audit_log (occurred_at, trace_id, actor, action, account_id, email_id, details_json) VALUES (?,?,?,?,?,?,?)")
      .run("2026-10-19T10:00:00.000Z", "t0", "worker", "folder_changed", "a1", 1, JSON.stringify({ from: "Archive", to: "INBOX" }));
    try {
      const { body } = await detail(f.file, "1");
      assert.deepEqual(body.folder_history, [
        { at: "2026-10-19T10:00:00.000Z", from: "Archive", to: "INBOX" },
        { at: "2026-10-20T10:00:00.000Z", from: "INBOX", to: "Junk" },
      ]);
      assert.deepEqual(body.locations.map((l: { folder: string; is_active: boolean }) => [l.folder, l.is_active]), [["Junk", true], ["INBOX", false]]);
      assert.equal(body.provider_spam, true);
      assert.ok(!JSON.stringify(body.locations).includes("uid_validity"));
    } finally { cleanup(f); }
  });

  test("unknown or malformed ids: 404; a pending mail still has a detail with classification status", async () => {
    const f = fixture([{ id: 1, recv: day(20), status: "pending" }]);
    try {
      for (const id of ["2", "0", "-1", "abc", "1.5", "1e3", "99999999999999999999"]) {
        const { res, body } = await detail(f.file, id);
        assert.equal(res.status, 404, id);
        assert.deepEqual(body, { error: "not_found" });
      }
      const ok = await detail(f.file, "1");
      assert.equal(ok.res.status, 200);
      assert.equal(ok.body.classification.status, "pending");
      assert.deepEqual(ok.body.folder_history, []);
    } finally { cleanup(f); }
  });

  test("getEmailDetail is pure over the database and exports only GET on the route", () => {
    const f = fixture([{ id: 1, recv: day(20) }]);
    try {
      assert.equal(getEmailDetail(f.db, 1)?.id, 1);
      assert.equal(getEmailDetail(f.db, 2), null);
      assert.deepEqual(Object.keys(detailRoute).sort(), ["GET"]);
      assert.deepEqual(Object.keys(listRoute).sort(), ["GET"]);
    } finally { cleanup(f); }
  });
});
