import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildTopicList,
  CUSTOM_LABEL_MAX,
  deriveCustomKey,
  FIXED_TOPICS,
  MAX_CUSTOM_TOPICS,
  selectTopicOptions,
} from "../lib/topics.ts";

test("fixed topics: ADR 0026 set, stable ascii snake_case keys, unique, fallback present", () => {
  assert.equal(FIXED_TOPICS.length, 12);
  const keys = FIXED_TOPICS.map((t) => t.key);
  assert.equal(new Set(keys).size, 12);
  assert.equal(new Set(FIXED_TOPICS.map((t) => t.label)).size, 12);
  for (const t of FIXED_TOPICS) {
    assert.match(t.key, /^[a-z][a-z0-9_]*$/);
    assert.ok(t.criteria.length > 10 && t.criteria.length < 300);
  }
  assert.deepEqual(FIXED_TOPICS.map((t) => t.label).sort(), [
    "Arbeit", "Behörden/Verträge", "Bildung", "Einkäufe/Bestellungen", "Familie/Freunde", "Finanzen", "Gesundheit",
    "Newsletter", "Reisen", "Sonstiges", "Vereine/Hobbys", "Wohnen",
  ].sort());
  assert.equal(FIXED_TOPICS.at(-1)?.key, "other");
});

test("key derivation: umlauts, accents, spaces, punctuation", () => {
  assert.equal(deriveCustomKey("Segelverein"), "custom_segelverein");
  assert.equal(deriveCustomKey("  Größe & Maße "), "custom_groesse_masse");
  assert.equal(deriveCustomKey("Café Über"), "custom_cafe_ueber");
  assert.equal(deriveCustomKey("!!!"), "");
});

test("list without custom topics is deterministic and versioned", () => {
  const a = buildTopicList();
  const b = buildTopicList([]);
  assert.ok(a.ok && b.ok);
  assert.equal(a.version, b.version);
  assert.match(a.version, /^topics-[0-9a-f]{12}$/);
  assert.deepEqual(Object.keys(a.criteria), FIXED_TOPICS.map((t) => t.key));
});

test("custom topics are appended; label normalization does not change the version, other labels do", () => {
  const base = buildTopicList([{ label: "Segelverein" }]);
  const same = buildTopicList([{ label: "  Segelverein  " }]);
  const other = buildTopicList([{ label: "Hausbau" }]);
  const hint = buildTopicList([{ label: "Segelverein", hint: "Regatta, Boote" }]);
  assert.ok(base.ok && same.ok && other.ok && hint.ok);
  assert.equal(base.options.length, 13);
  assert.equal(base.options.at(-1)?.key, "custom_segelverein");
  assert.equal(base.options.at(-1)?.kind, "custom");
  assert.equal(base.version, same.version);
  assert.notEqual(base.version, other.version);
  assert.notEqual(base.version, hint.version);
  assert.notEqual(base.version, buildTopicList().ok && (buildTopicList() as { version: string }).version);
});

test("order of custom topics matters for the version", () => {
  const ab = buildTopicList([{ label: "A1" }, { label: "B1" }]);
  const ba = buildTopicList([{ label: "B1" }, { label: "A1" }]);
  assert.ok(ab.ok && ba.ok);
  assert.notEqual(ab.version, ba.version);
});

test("validation: count, label length, characters, hint, duplicates", () => {
  const many = Array.from({ length: MAX_CUSTOM_TOPICS + 1 }, (_, i) => ({ label: `Thema ${i}` }));
  assert.deepEqual(buildTopicList(many), { ok: false, code: "too_many_custom" });
  assert.deepEqual(buildTopicList(many.slice(0, MAX_CUSTOM_TOPICS)).ok, true);
  assert.deepEqual(buildTopicList([{ label: "x" }]), { ok: false, code: "label_length", index: 0 });
  assert.deepEqual(buildTopicList([{ label: "ab" }, { label: "y".repeat(CUSTOM_LABEL_MAX + 1) }]), { ok: false, code: "label_length", index: 1 });
  assert.deepEqual(buildTopicList([{ label: 'Say "hi"' }]), { ok: false, code: "label_chars", index: 0 });
  assert.deepEqual(buildTopicList([{ label: "Garten", hint: "x".repeat(121) }]), { ok: false, code: "hint_length", index: 0 });
  assert.deepEqual(buildTopicList([{ label: "!!" }]), { ok: false, code: "key_empty", index: 0 });
  assert.deepEqual(buildTopicList([{ label: "finanzen" }]), { ok: false, code: "duplicate", index: 0 });
  assert.deepEqual(buildTopicList([{ label: "Sonstiges" }]), { ok: false, code: "duplicate", index: 0 });
  assert.deepEqual(buildTopicList([{ label: "Garten" }, { label: "garten" }]), { ok: false, code: "duplicate", index: 1 });
  assert.deepEqual(buildTopicList([{ label: "Café" }, { label: "Cafe" }]), { ok: false, code: "duplicate", index: 1 });
});

test("selectTopicOptions: frequency prefix, fallback always included, custom on request", () => {
  const list = buildTopicList([{ label: "Segelverein" }, { label: "Hausbau" }]);
  assert.ok(list.ok);
  const six = selectTopicOptions(list, 6, false);
  assert.equal(six.length, 6);
  assert.equal(six.at(-1)?.key, "other");
  assert.deepEqual(six.slice(0, 2).map((o) => o.key), ["finance", "shopping"]);
  assert.equal(selectTopicOptions(list, 12, false).length, 12);
  assert.equal(selectTopicOptions(list, 12, true).length, 14);
});

test("synthetic topic fixture: >= 8 per fixed topic, custom cases, placeholder domains, known keys", () => {
  const rows = readFileSync(join(import.meta.dirname, "fixtures", "eval", "topics-synthetic.jsonl"), "utf8")
    .split("\n").filter(Boolean).map((l) => JSON.parse(l) as { id: string; sender_domain: string; subject: string; body: string; expected_topic: string; lang: string });
  const counts = new Map<string, number>();
  const ids = new Set<string>();
  for (const r of rows) {
    counts.set(r.expected_topic, (counts.get(r.expected_topic) ?? 0) + 1);
    assert.ok(!ids.has(r.id));
    ids.add(r.id);
    assert.match(r.sender_domain, /\.example\.test$/);
    assert.ok(r.subject.length > 0 && r.body.length > 0);
    assert.ok(r.lang === "de" || r.lang === "en");
  }
  for (const t of FIXED_TOPICS) assert.ok((counts.get(t.key) ?? 0) >= 8, t.key);
  for (const label of ["Segelverein", "Hausbau", "Steuerberater", "Auto"]) {
    assert.ok((counts.get(deriveCustomKey(label)) ?? 0) >= 6, label);
  }
  assert.equal(counts.size, 16);
});
