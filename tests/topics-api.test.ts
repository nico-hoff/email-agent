// R8 topics API: GET/POST /api/topics, GET /api/topics/counts and the topic filter of /api/emails. Tailnet identity = owner.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createAuthContext, createLoginLimiter, createMutationLimiter, handleLogin, handleSession } from "../lib/auth-runtime.ts";
import { CSRF_HEADER } from "../lib/csrf.ts";
import { openDatabase } from "../lib/db.ts";
import { listEmails, parseListQuery, type ListQuery } from "../lib/email-api.ts";
import { handleTopicCounts, handleTopicsGet, handleTopicsPost, type TopicsApiDeps } from "../lib/topics-api.ts";
import { topicsEnabled } from "../lib/topics-store.ts";
import { QUESTION_SET_VERSION_V3 } from "../lib/constants.ts";

const ME = "nico@example.test";
const HOST = "mac.tail.ts.net";
const ORIGIN = `https://${HOST}`;
const NOW = new Date("2026-11-01T10:00:00.000Z");
const T = "2026-11-01T09:00:00.000Z";

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "topics-api-"));
  chmodSync(dir, 0o700);
  mkdirSync(join(dir, "data"), { mode: 0o700 });
  writeFileSync(join(dir, "data", "auth-allowlist.json"), JSON.stringify({ logins: [ME] }));
  const auth = createAuthContext({ dataDir: join(dir, "data"), synthetic: false });
  const db = openDatabase(":memory:");
  const unclosable = { prepare: db.prepare.bind(db), exec: db.exec.bind(db), close() {} } as unknown as DatabaseSync;
  const deps: TopicsApiDeps = { auth, limiter: createMutationLimiter(), openDb: () => unclosable, now: () => NOW };
  const headers = { host: HOST, "tailscale-user-login": ME };
  const info = (await (await handleSession(new Request("http://127.0.0.1:3000/api/auth/session", { headers }), auth)).json()) as { csrfToken: string };
  const res = handleLogin(new Request("http://127.0.0.1:3000/api/auth/login", { method: "POST", headers: { ...headers, origin: ORIGIN, "sec-fetch-site": "same-origin", [CSRF_HEADER]: info.csrfToken } }), auth, createLoginLimiter());
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { db, deps, cookie, csrf: info.csrfToken };
}
type S = Awaited<ReturnType<typeof setup>>;
const get = (s: S, path = "/api/topics", withSession = true) => new Request(`http://127.0.0.1:3000${path}`, { headers: { host: HOST, ...(withSession ? { cookie: s.cookie } : {}) } });
const post = (s: S, body?: unknown, o: { session?: boolean; csrf?: boolean } = {}) => new Request("http://127.0.0.1:3000/api/topics", {
  method: "POST", body: body === undefined ? undefined : JSON.stringify(body),
  headers: { host: HOST, ...(o.session === false ? {} : { cookie: s.cookie }), origin: ORIGIN, "sec-fetch-site": "same-origin", ...(o.csrf === false ? {} : { [CSRF_HEADER]: s.csrf }), "content-type": "application/json" },
});
type View = { enabled: boolean; list_version: string | null; limits: { active_custom_max: number }; topics: { key: string; label: string; kind: string; hint: string | null; active: boolean }[] };
const view = async (s: S) => (await handleTopicsGet(get(s), s.deps).json()) as View;

/** Account 1 of the owner plus mails with a classification and (optionally) a topic answer. */
function seedMails(s: S, topics: (string | null)[]): number[] {
  s.db.prepare("INSERT INTO accounts (id, label, host, port, mailbox, enabled, user_id) VALUES ('acc1', 'Privat', 'imap.example.test', 993, 'INBOX', 1, 1)").run();
  return topics.map((topic, i) => {
    const e = s.db.prepare("INSERT INTO emails (account_id, message_id, sender, subject, received_at, first_seen_at) VALUES ('acc1', ?, 'x@example.test', 'S', ?, ?)").run(`<m${i}@x>`, T, T);
    const id = Number(e.lastInsertRowid);
    const c = s.db.prepare("INSERT INTO classifications (email_id, question_set_version, model_requested, model_reported, status, attempts, created_at, updated_at) VALUES (?, ?, 'typesafe/jev-1.13', 'm', 'classified', 1, ?, ?)")
      .run(id, topic ? QUESTION_SET_VERSION_V3 : "email-classification-v2", T, T);
    if (topic) s.db.prepare("INSERT INTO classification_answers (classification_id, question_key, type, answer_json) VALUES (?, 'topic', 'choice', ?)").run(Number(c.lastInsertRowid), JSON.stringify({ value: topic }));
    return id;
  });
}

describe("topics API", () => {
  it("every route needs a session; writes also need the CSRF header", async () => {
    const s = await setup();
    // GET routes sit behind the interceptor in the transitional modes (401 in users mode: tests/tenant-isolation.test.ts).
    assert.equal((await handleTopicsPost(post(s, { action: "set_enabled", enabled: true }, { session: false }), s.deps)).status, 401);
    assert.equal((await handleTopicsPost(post(s, { action: "set_enabled", enabled: true }, { csrf: false }), s.deps)).status, 403);
    assert.equal(topicsEnabled(s.db, 1), false);
  });

  it("GET lists the 12 fixed topics, no custom ones, the switch off and the limits", async () => {
    const s = await setup();
    const v = await view(s);
    assert.equal(v.enabled, false);
    assert.equal(v.topics.length, 12);
    assert.ok(v.topics.every((t) => t.kind === "fixed" && t.active));
    assert.equal(v.limits.active_custom_max, 4);
    assert.match(v.list_version ?? "", /^topics-[a-f0-9]{12}$/);
    assert.ok(!JSON.stringify(v).includes("criteria"), "the English option texts stay internal");
  });

  it("create, update, deactivate and reactivate; the list version follows the active list", async () => {
    const s = await setup();
    const v0 = (await view(s)).list_version;
    const created = await handleTopicsPost(post(s, { action: "create", label: "Segelverein", hint: "Mails des Clubs" }), s.deps);
    assert.equal(created.status, 200);
    const c = (await created.json()) as View & { topic_key: string };
    assert.equal(c.topic_key, "custom_segelverein");
    assert.notEqual(c.list_version, v0);
    assert.deepEqual(c.topics.filter((t) => t.kind === "custom").map((t) => [t.key, t.label, t.hint, t.active]), [["custom_segelverein", "Segelverein", "Mails des Clubs", true]]);
    const upd = await handleTopicsPost(post(s, { action: "update", key: "custom_segelverein", label: "Segelclub", hint: null }), s.deps);
    assert.equal(upd.status, 200);
    assert.equal(((await upd.json()) as View).topics.find((t) => t.key === "custom_segelverein")?.label, "Segelclub");
    const off = (await (await handleTopicsPost(post(s, { action: "set_active", key: "custom_segelverein", active: false }), s.deps)).json()) as View;
    assert.equal(off.list_version, v0, "back to the fixed list: same version as before");
    assert.equal(off.topics.find((t) => t.key === "custom_segelverein")?.active, false);
    assert.equal((await handleTopicsPost(post(s, { action: "set_active", key: "custom_segelverein", active: true }), s.deps)).status, 200);
    const actions = s.db.prepare("SELECT action, details_json, user_id FROM audit_log WHERE action LIKE 'topic%' ORDER BY id").all().map((r) => ({ ...r }));
    assert.deepEqual(actions.map((a) => a.action), ["topic_created", "topic_updated", "topic_deactivated", "topic_reactivated"]);
    assert.ok(actions.every((a) => a.user_id === 1));
  });

  it("validation errors: 400 for bad bodies and labels, 409 for duplicates and the limit, 404 for unknown keys", async () => {
    const s = await setup();
    const status = async (b: unknown) => (await handleTopicsPost(post(s, b), s.deps)).status;
    assert.equal(await status({ action: "nope" }), 400);
    assert.equal(await status({ action: "create" }), 400);
    assert.equal(await status({ action: "create", label: "x" }), 400, "label too short");
    assert.equal(await status({ action: "create", label: "Gut", extra: 1 }), 400, "unknown field");
    assert.equal(await status({ action: "update", key: "finance", label: "Zzz" }), 400, "fixed keys are not editable");
    assert.equal(await status({ action: "create", label: "Finanzen" }), 409);
    assert.equal(await status({ action: "update", key: "custom_gibt_es_nicht", label: "Zzz" }), 404);
    assert.equal(await status({ action: "set_active", key: "custom_gibt_es_nicht", active: false }), 404);
    for (const l of ["Eins", "Zwei", "Drei", "Vier"]) assert.equal(await status({ action: "create", label: l }), 200);
    const full = await handleTopicsPost(post(s, { action: "create", label: "Fuenf" }), s.deps);
    assert.deepEqual([full.status, await full.json()], [409, { error: "too_many_active" }]);
    assert.equal((await handleTopicsPost(post(s, { action: "create", label: "Vier" }), s.deps)).status, 409);
    assert.equal(await status({ action: "create", label: "a".repeat(41) }), 400);
    assert.equal((await handleTopicsPost(new Request("http://127.0.0.1:3000/api/topics", { method: "POST", body: "{not json", headers: post(s, {}).headers }), s.deps)).status, 400);
  });

  it("set_enabled toggles the per-user switch and is audited", async () => {
    const s = await setup();
    const on = (await (await handleTopicsPost(post(s, { action: "set_enabled", enabled: true }), s.deps)).json()) as View;
    assert.equal(on.enabled, true);
    assert.equal(topicsEnabled(s.db, 1), true);
    const off = (await (await handleTopicsPost(post(s, { action: "set_enabled", enabled: false }), s.deps)).json()) as View;
    assert.equal(off.enabled, false);
    assert.deepEqual(s.db.prepare("SELECT action FROM audit_log WHERE action LIKE 'topics_%' ORDER BY id").all().map((r) => r.action), ["topics_enabled", "topics_disabled"]);
  });

  it("counts: per topic from the latest classification, deactivated topics only while mails carry them, none for v2 mails", async () => {
    const s = await setup();
    await handleTopicsPost(post(s, { action: "create", label: "Segelverein" }), s.deps);
    seedMails(s, ["finance", "finance", "custom_segelverein", null, "work"]);
    await handleTopicsPost(post(s, { action: "set_active", key: "custom_segelverein", active: false }), s.deps);
    const r = (await handleTopicCounts(get(s, "/api/topics/counts"), s.deps).json()) as { enabled: boolean; total: number; none: number; unlisted: number; topics: { key: string; count: number; active: boolean }[] };
    assert.equal(r.total, 5);
    assert.equal(r.none, 1);
    assert.equal(r.unlisted, 0);
    const byKey = new Map(r.topics.map((t) => [t.key, t]));
    assert.equal(byKey.get("finance")?.count, 2);
    assert.equal(byKey.get("work")?.count, 1);
    assert.equal(byKey.get("travel")?.count, 0);
    assert.deepEqual([byKey.get("custom_segelverein")?.count, byKey.get("custom_segelverein")?.active], [1, false]);
    // once nothing carries it, a deactivated topic is gone from the counts
    s.db.prepare("DELETE FROM classification_answers WHERE json_extract(answer_json, '$.value') = 'custom_segelverein'").run();
    const r2 = (await handleTopicCounts(get(s, "/api/topics/counts"), s.deps).json()) as { topics: { key: string }[] };
    assert.ok(!r2.topics.some((t) => t.key === "custom_segelverein"));
    assert.equal(handleTopicCounts(get(s, "/api/topics/counts?account=nope"), s.deps).status, 404);
    assert.equal(handleTopicCounts(get(s, "/api/topics/counts?account=acc1"), s.deps).status, 200);
  });

  it("the latest classification decides (an older v3 answer does not count after a newer v2 row)", async () => {
    const s = await setup();
    const [id] = seedMails(s, ["finance"]);
    s.db.prepare("INSERT INTO classifications (email_id, question_set_version, model_requested, model_reported, status, attempts, created_at, updated_at) VALUES (?, 'email-classification-v2', 'openai/gpt-6-luna-decisions', 'm', 'classified', 1, ?, ?)").run(id, T, T);
    const r = (await handleTopicCounts(get(s, "/api/topics/counts"), s.deps).json()) as { none: number; topics: { key: string; count: number }[] };
    assert.equal(r.none, 1);
    assert.equal(r.topics.find((t) => t.key === "finance")?.count, 0);
  });
});

describe("GET /api/emails?topic=", () => {
  const q = (over: Partial<ListQuery> = {}): ListQuery => ({ view: "all", account: null, status: null, limit: 50, cursor: null, ...over });

  it("parseListQuery accepts a topic key and rejects anything else", () => {
    const p = (qs: string) => parseListQuery(new URL(`http://x/api/emails?${qs}`));
    assert.deepEqual(p("topic=finance"), { ok: true, query: { view: "all", account: null, status: null, limit: 50, cursor: null, topic: "finance" } });
    assert.equal(p("topic=custom_segelverein").ok, true);
    assert.deepEqual(p("topic=Fin%20ance"), { ok: false, error: "invalid_topic" });
    assert.deepEqual(p("topic="), { ok: false, error: "invalid_topic" });
    assert.deepEqual(p("topic=%27%3B--"), { ok: false, error: "invalid_topic" });
    const none = p("view=open");
    assert.ok(none.ok && none.query.topic === null);
  });

  it("filters by the topic of the latest classification; items carry their topic; counts follow the filter", async () => {
    const s = await setup();
    const ids = seedMails(s, ["finance", "work", "finance", null]);
    const all = listEmails(s.db, 1, q());
    assert.equal(all.emails.length, 4);
    assert.deepEqual(new Map(all.emails.map((e) => [e.id, e.topic])).get(ids[3]), null);
    const fin = listEmails(s.db, 1, q({ topic: "finance" }));
    assert.deepEqual(fin.emails.map((e) => e.id).sort(), [ids[0], ids[2]].sort());
    assert.ok(fin.emails.every((e) => e.topic === "finance"));
    assert.equal(fin.counts.all, 2);
    assert.equal(listEmails(s.db, 1, q({ topic: "travel" })).emails.length, 0);
    assert.equal(listEmails(s.db, 1, q({ topic: null })).emails.length, 4);
    // injection attempts are plain values
    assert.equal(listEmails(s.db, 1, q({ topic: "finance' OR '1'='1" })).emails.length, 0);
  });
});
