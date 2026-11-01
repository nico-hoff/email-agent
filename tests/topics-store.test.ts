// R8 topics store (migration 011, ADR 0037): custom topics, stable keys, the list version and the per-user switch. Synthetic data.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../lib/db.ts";
import { createUser } from "../lib/users.ts";
import { buildTopicList, FIXED_TOPICS } from "../lib/topics.ts";
import {
  ACTIVE_CUSTOM_TOPICS_LIMIT, createCustomTopic, CUSTOM_TOPIC_ROWS_MAX, listCustomTopics, setCustomTopicActive, setTopicsEnabled,
  topicLabels, topicListForUser, topicsEnabled, updateCustomTopic,
} from "../lib/topics-store.ts";

const NOW = new Date("2026-11-01T10:00:00.000Z");
const later = (n: number) => new Date(NOW.getTime() + n * 1000);

async function setup(): Promise<{ db: DatabaseSync; A: number; B: number }> {
  const db = openDatabase(":memory:");
  assert.ok((await createUser(db, { email: "a@example.test", password: "synthetic-pass-1234", role: "admin" })).ok);
  assert.ok((await createUser(db, { email: "b@example.test", password: "synthetic-pass-1234", role: "user" })).ok);
  return { db, A: 1, B: 2 };
}

const versionOf = (db: DatabaseSync, u: number): string => {
  const l = topicListForUser(db, u);
  assert.ok(l.ok);
  return l.version;
};

describe("topics store", () => {
  it("the switch is off by default and per user", async () => {
    const { db, A, B } = await setup();
    assert.equal(topicsEnabled(db, A), false);
    setTopicsEnabled(db, A, true, NOW);
    assert.equal(topicsEnabled(db, A), true);
    assert.equal(topicsEnabled(db, B), false);
    setTopicsEnabled(db, A, false, NOW);
    assert.equal(topicsEnabled(db, A), false);
    assert.equal(topicsEnabled(db, 999), false, "unknown user: off");
  });

  it("without custom topics the list is the fixed list; its version equals buildTopicList([])", async () => {
    const { db, A } = await setup();
    const l = topicListForUser(db, A);
    assert.ok(l.ok);
    assert.equal(l.options.length, FIXED_TOPICS.length);
    const base = buildTopicList([]);
    assert.ok(base.ok);
    assert.equal(l.version, base.version);
  });

  it("create appends in order; the list version is stable for the same list and changes with every change", async () => {
    const { db, A } = await setup();
    const v0 = versionOf(db, A);
    const a = createCustomTopic(db, A, { label: "Segelverein", hint: "Mails des Segelvereins" }, NOW);
    assert.ok(a.ok);
    assert.equal(a.topic.key, "custom_segelverein");
    const v1 = versionOf(db, A);
    assert.notEqual(v1, v0);
    assert.equal(versionOf(db, A), v1, "same list, same version");
    const b = createCustomTopic(db, A, { label: "Hausbau" }, later(1));
    assert.ok(b.ok);
    assert.deepEqual(listCustomTopics(db, A).map((t) => t.key), ["custom_segelverein", "custom_hausbau"]);
    const v2 = versionOf(db, A);
    assert.notEqual(v2, v1);
    // the same custom list built by another user in the same order has the same version (the version depends on the list only)
    const l = topicListForUser(db, A);
    assert.ok(l.ok);
    const again = buildTopicList(listCustomTopics(db, A).map((t) => ({ key: t.key, label: t.label, ...(t.hint ? { hint: t.hint } : {}) })));
    assert.ok(again.ok);
    assert.equal(again.version, l.version);
  });

  it("validation: length, characters, duplicates against fixed and custom topics, empty keys", async () => {
    const { db, A } = await setup();
    const code = (label: string, hint?: string) => {
      const r = createCustomTopic(db, A, { label, ...(hint !== undefined ? { hint } : {}) }, NOW);
      return r.ok ? "ok" : r.code;
    };
    assert.equal(code("x"), "label_length");
    assert.equal(code("y".repeat(41)), "label_length");
    assert.equal(code('Mit "Anführung"'), "label_chars");
    assert.equal(code("Finanzen"), "duplicate", "fixed label");
    assert.equal(code("!!"), "key_empty");
    assert.equal(code("Auto", "h".repeat(121)), "hint_length");
    assert.equal(code("Auto"), "ok");
    assert.equal(code("auto"), "duplicate");
    assert.equal(code("  Auto  "), "duplicate");
  });

  it("at most 4 active custom topics; a deactivated one frees a slot and keeps its row", async () => {
    const { db, A } = await setup();
    for (const [i, l] of ["Eins", "Zwei", "Drei", "Vier"].entries()) assert.ok(createCustomTopic(db, A, { label: l }, later(i)).ok);
    assert.equal(ACTIVE_CUSTOM_TOPICS_LIMIT, 4);
    const fifth = createCustomTopic(db, A, { label: "Fuenf" }, NOW);
    assert.deepEqual(fifth, { ok: false, code: "too_many_active" });
    assert.ok(setCustomTopicActive(db, A, "custom_zwei", false, later(10)).ok);
    assert.ok(createCustomTopic(db, A, { label: "Fuenf" }, later(11)).ok);
    assert.equal(listCustomTopics(db, A).length, 5, "the deactivated row stays");
    const l = topicListForUser(db, A);
    assert.ok(l.ok);
    assert.ok(!l.options.some((o) => o.key === "custom_zwei"), "inactive topics are not in the list");
    assert.equal(setCustomTopicActive(db, A, "custom_zwei", true, later(12)).ok, false, "list full again");
  });

  it("deactivating and re-creating the same label brings the same key back; old answers keep their label", async () => {
    const { db, A } = await setup();
    assert.ok(createCustomTopic(db, A, { label: "Segeln" }, NOW).ok);
    const before = versionOf(db, A);
    assert.ok(setCustomTopicActive(db, A, "custom_segeln", false, later(1)).ok);
    assert.notEqual(versionOf(db, A), before);
    assert.equal(topicLabels(db, A).get("custom_segeln"), "Segeln", "label of a deactivated topic stays resolvable");
    const r = createCustomTopic(db, A, { label: "Segeln", hint: "Wassersport" }, later(2));
    assert.ok(r.ok);
    assert.equal(r.topic.key, "custom_segeln");
    assert.equal(listCustomTopics(db, A).length, 1, "reactivated, not duplicated");
    assert.equal(createCustomTopic(db, A, { label: "Segeln" }, later(3)).ok, false);
  });

  it("update keeps the key when the label changes; the version changes; inactive topics cannot be edited", async () => {
    const { db, A } = await setup();
    assert.ok(createCustomTopic(db, A, { label: "Segeln" }, NOW).ok);
    const v = versionOf(db, A);
    const u = updateCustomTopic(db, A, "custom_segeln", { label: "Segelverein", hint: "Der Club" }, later(1));
    assert.ok(u.ok);
    assert.equal(u.topic.key, "custom_segeln");
    assert.equal(u.topic.label, "Segelverein");
    assert.notEqual(versionOf(db, A), v);
    assert.deepEqual(updateCustomTopic(db, A, "custom_segeln", { label: "Finanzen" }, later(2)), { ok: false, code: "duplicate" });
    assert.deepEqual(updateCustomTopic(db, A, "custom_nope", { label: "Zzz" }, later(2)), { ok: false, code: "not_found" });
    assert.ok(setCustomTopicActive(db, A, "custom_segeln", false, later(3)).ok);
    assert.deepEqual(updateCustomTopic(db, A, "custom_segeln", { label: "Anders" }, later(4)), { ok: false, code: "inactive" });
    // clearing the hint
    assert.ok(setCustomTopicActive(db, A, "custom_segeln", true, later(5)).ok);
    const c = updateCustomTopic(db, A, "custom_segeln", { hint: null }, later(6));
    assert.ok(c.ok);
    assert.equal(c.topic.hint, null);
  });

  it("a key of another user is not found (tenant scope)", async () => {
    const { db, A, B } = await setup();
    assert.ok(createCustomTopic(db, A, { label: "Nur A" }, NOW).ok);
    assert.deepEqual(updateCustomTopic(db, B, "custom_nur_a", { label: "Hijack" }, NOW), { ok: false, code: "not_found" });
    assert.deepEqual(setCustomTopicActive(db, B, "custom_nur_a", false, NOW), { ok: false, code: "not_found" });
    assert.equal(listCustomTopics(db, B).length, 0);
    assert.equal(topicLabels(db, B).has("custom_nur_a"), false);
    assert.equal(listCustomTopics(db, A)[0]?.active, true);
    // B can use the same label for their own topic
    assert.ok(createCustomTopic(db, B, { label: "Nur A" }, NOW).ok);
  });

  it("the row cap counts deactivated rows", async () => {
    const { db, A } = await setup();
    for (let i = 0; i < CUSTOM_TOPIC_ROWS_MAX; i++) {
      assert.ok(createCustomTopic(db, A, { label: `Thema ${String.fromCharCode(97 + i)}` }, later(i)).ok || i >= ACTIVE_CUSTOM_TOPICS_LIMIT);
      if (i >= ACTIVE_CUSTOM_TOPICS_LIMIT - 1) break;
    }
    // fill with deactivated rows directly, then the cap blocks a new label
    const ts = NOW.toISOString();
    for (let i = listCustomTopics(db, A).length; i < CUSTOM_TOPIC_ROWS_MAX; i++) {
      db.prepare("INSERT INTO user_topics (user_id, key, label, hint, position, active, created_at, updated_at) VALUES (?,?,?,?,?,0,?,?)").run(A, `custom_x${i}`, `Alt ${i}`, null, i, ts, ts);
    }
    assert.deepEqual(createCustomTopic(db, A, { label: "Noch eins" }, NOW), { ok: false, code: "too_many_active" });
    assert.ok(setCustomTopicActive(db, A, "custom_thema_a", false, NOW).ok);
    assert.deepEqual(createCustomTopic(db, A, { label: "Noch eins" }, NOW), { ok: false, code: "too_many_rows" });
  });
});
