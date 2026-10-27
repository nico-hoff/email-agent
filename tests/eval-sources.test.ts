import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EXCERPT_MAX_CHARS } from "../lib/constants.ts";
import {
  contentHash,
  dedupeCases,
  EVAL_SOURCES,
  partitionOf,
  partitionOfKey,
  sampleCases,
  sampleCasesDetailed,
  strataKey,
  type EvalCase,
} from "../lib/eval-sources.ts";

const triage = EVAL_SOURCES.find((s) => s.short === "triage")!;
const sinabis = EVAL_SOURCES.find((s) => s.short === "sinabis")!;

const tri = (category: string, extra: Record<string, unknown> = {}) => ({
  subject: "Synthetic subject",
  body: "Synthetic body",
  category,
  priority: "low",
  action: "none",
  source_round: "r1",
  ...extra,
});

describe("eval source allowlist", () => {
  it("lists exactly the two synthetic, redistributable sources", () => {
    assert.deepEqual(EVAL_SOURCES.map((s) => s.id).sort(), [
      "sinabis-group/sinabis-1k-synthetic-emails",
      "weijianzhg/email-triage-action-seed",
    ]);
    for (const s of EVAL_SOURCES) {
      assert.equal(s.synthetic, true);
      assert.ok(s.license && s.attribution && s.config && s.split);
    }
    assert.equal(triage.license, "apache-2.0");
    assert.equal(sinabis.license, "cc-by-4.0");
  });
});

describe("triage mapper", () => {
  const exp = (cat: string) => triage.map(tri(cat), 7)!.expected;

  it("builds id, lang and a placeholder sender domain", () => {
    const c = triage.map(tri("spam"), 7)!;
    assert.equal(c.id, "triage-7");
    assert.equal(c.source, "triage");
    assert.equal(c.lang, "en");
    assert.match(c.sender_domain, /\.example\.test$/);
  });

  it("maps unambiguous categories", () => {
    assert.deepEqual(exp("spam"), { category: "spam", is_spam: true, is_phishing_or_scam: false });
    assert.deepEqual(exp("phishing"), { is_phishing_or_scam: true, is_spam: true });
    assert.deepEqual(exp("newsletter"), { category: "newsletter_promo", is_phishing_or_scam: false });
    assert.deepEqual(exp("promotion"), { category: "newsletter_promo", is_phishing_or_scam: false });
    assert.deepEqual(exp("personal"), { category: "personal" });
  });

  it("leaves ambiguous categories without any expected key", () => {
    for (const cat of ["finance", "meeting_request", "customer_support", "travel", "system_update", "unknown"]) {
      assert.deepEqual(exp(cat), {}, cat);
    }
    assert.ok(!("category" in exp("phishing")));
  });

  it("truncates the body to EXCERPT_MAX_CHARS", () => {
    const c = triage.map(tri("spam", { body: "x".repeat(EXCERPT_MAX_CHARS + 500) }), 0)!;
    assert.equal(c.body.length, EXCERPT_MAX_CHARS);
  });

  it("rejects malformed rows and ignores unknown categories", () => {
    assert.equal(triage.map({ subject: 1 }, 0), null);
    assert.equal(triage.map(null, 0), null);
    assert.deepEqual(exp("brand_new_category"), {});
  });
});

describe("sinabis mapper", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    lang: "de",
    subject: "Synthetischer Betreff",
    body: "Synthetischer Text",
    from: { name: "Muster, Erika", email: "erika.muster@sinabis-oil.com" },
    ...over,
  });

  it("maps to business with negative safety labels and takes lang and domain from data", () => {
    const c = sinabis.map(row(), 3)!;
    assert.equal(c.id, "sinabis-3");
    assert.equal(c.lang, "de");
    assert.equal(c.sender_domain, "sinabis-oil.com");
    assert.deepEqual(c.expected, {
      category: "business",
      is_spam: false,
      is_phishing_or_scam: false,
      addresses_an_ai: false,
    });
  });

  it("falls back for a missing sender and rejects unusable rows", () => {
    assert.match(sinabis.map(row({ from: null }), 0)!.sender_domain, /\.example\.test$/);
    assert.equal(sinabis.map(row({ body: undefined }), 0), null);
  });

  it("truncates the body", () => {
    assert.equal(sinabis.map(row({ body: "y".repeat(5000) }), 0)!.body.length, EXCERPT_MAX_CHARS);
  });
});

function mk(source: string, n: number, category: string | undefined): EvalCase[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${source}-${category ?? "none"}-${i}`,
    source,
    lang: "en",
    sender_domain: "a.example.test",
    subject: "s",
    body: "b",
    expected: category ? { category } : {},
  }));
}

describe("sampleCases", () => {
  const pool = [
    ...mk("triage", 40, "spam"),
    ...mk("triage", 40, "personal"),
    ...mk("triage", 40, undefined),
    ...mk("sinabis", 40, "business"),
  ];
  const ids = (cs: EvalCase[]) => cs.map((c) => c.id);

  it("is deterministic for the same seed, independent of input order", () => {
    const a = sampleCases(pool, { seed: 1, n: 20 });
    const b = sampleCases([...pool].reverse(), { seed: 1, n: 20 });
    assert.deepEqual(ids(a), ids(b));
    assert.equal(a.length, 20);
  });

  it("differs between seeds", () => {
    assert.notDeepEqual(ids(sampleCases(pool, { seed: 1, n: 20 })), ids(sampleCases(pool, { seed: 2, n: 20 })));
  });

  it("stratifies by source and expected category (missing category is its own stratum)", () => {
    const s = sampleCases(pool, { seed: 5, n: 20 });
    const count = (src: string, cat: string | undefined) =>
      s.filter((c) => c.source === src && c.expected.category === cat).length;
    assert.equal(count("triage", "spam"), 5);
    assert.equal(count("triage", "personal"), 5);
    assert.equal(count("triage", undefined), 5);
    assert.equal(count("sinabis", "business"), 5);
  });

  it("never exceeds n or the pool, never duplicates, and handles small strata", () => {
    const small = [...mk("triage", 2, "spam"), ...mk("sinabis", 30, "business")];
    const s = sampleCases(small, { seed: 3, n: 10 });
    assert.equal(s.length, 10);
    assert.equal(new Set(ids(s)).size, 10);
    assert.equal(s.filter((c) => c.source === "triage").length, 2);
    assert.equal(sampleCases(small, { seed: 3, n: 1000 }).length, 32);
    assert.deepEqual(sampleCases(small, { seed: 3, n: 0 }), []);
  });
});

describe("content hash and duplicates", () => {
  const c = (id: string, subject: string, body: string): EvalCase => ({
    id, source: "triage", lang: "en", sender_domain: "a.example.test", subject, body, expected: { category: "spam" },
  });

  it("normalizes case and whitespace but keeps different content apart", () => {
    assert.equal(contentHash(c("a", "Hello  World", "Body\n text")), contentHash(c("b", " hello world ", "body text")));
    assert.notEqual(contentHash(c("a", "Hello", "x")), contentHash(c("a", "Hello", "y")));
    assert.notEqual(contentHash(c("a", "ab", "c")), contentHash(c("a", "a", "bc")));
    assert.match(contentHash(c("a", "s", "b")), /^[0-9a-f]{64}$/);
  });

  it("removes exact duplicates, keeps the first occurrence and counts removals", () => {
    const r = dedupeCases([c("1", "s", "b"), c("2", "S", "b"), c("3", "other", "b"), c("4", "s", "b")]);
    assert.deepEqual(r.cases.map((x) => x.id), ["1", "3"]);
    assert.equal(r.removed, 2);
  });

  it("treats the same text in different sources as distinct", () => {
    const a = { ...c("1", "s", "b"), source: "triage" };
    const b = { ...c("2", "s", "b"), source: "sinabis" };
    assert.equal(dedupeCases([a, b]).removed, 0);
  });
});

describe("fixed calib/test partition", () => {
  it("is stable per key across calls and about 30/70 over many keys", () => {
    const keys = Array.from({ length: 10_000 }, (_, i) => `triage-${i}`);
    const first = keys.map((k) => partitionOfKey(k));
    assert.deepEqual(keys.map((k) => partitionOfKey(k)), first);
    const calib = first.filter((p) => p === "calib").length;
    assert.ok(calib > 2_800 && calib < 3_200, String(calib));
    assert.ok(first.every((p) => p === "calib" || p === "test"));
  });

  it("partitions a case by its content so duplicates never end up in different partitions", () => {
    const base = { lang: "en", sender_domain: "a.example.test", expected: {} } as const;
    for (let i = 0; i < 200; i++) {
      const a: EvalCase = { ...base, id: `triage-${i}`, source: "triage", subject: `Subject ${i}`, body: `Body ${i}` };
      const b: EvalCase = { ...a, id: `triage-${i + 100_000}`, subject: `subject  ${i}` };
      assert.equal(partitionOf(a), partitionOf(b));
    }
  });

  it("does not depend on the case id", () => {
    const x: EvalCase = { id: "triage-1", source: "triage", lang: "en", sender_domain: "d", subject: "s", body: "b", expected: {} };
    const renamed: EvalCase = { ...x, id: "triage-77" };
    assert.equal(partitionOf(x), partitionOf(renamed));
  });
});

function counts(cs: EvalCase[]): Record<string, number> {
  const o: Record<string, number> = {};
  for (const c of cs) o[strataKey(c)] = (o[strataKey(c)] ?? 0) + 1;
  return o;
}

describe("sampleCasesDetailed", () => {
  const pool = [
    ...mk("triage", 100, "spam"),
    ...mk("triage", 100, "personal"),
    ...mk("triage", 3, "business"),
    ...mk("sinabis", 50, "business"),
  ];

  it("balanced: equal share per stratum, small strata taken fully, the rest redistributed", () => {
    const r = sampleCasesDetailed(pool, { seed: 1, n: 40, strategy: "balanced" });
    assert.equal(r.cases.length, 40);
    const c = counts(r.cases);
    assert.equal(c["triage|business"], 3);
    const rest = [c["triage|spam"], c["triage|personal"], c["sinabis|business"]].sort();
    assert.deepEqual(rest, [12, 12, 13]);
    assert.deepEqual(r.shortStrata, ["triage|business"]);
    const info = Object.fromEntries(r.strata.map((s) => [s.key, s]));
    assert.equal(info["triage|business"].population, 3);
    assert.equal(info["triage|business"].sampled, 3);
    assert.equal(info["triage|spam"].population, 100);
    assert.equal(r.strata.reduce((a, s) => a + s.sampled, 0), 40);
  });

  it("balanced: exactly equal when n divides evenly and nothing is short", () => {
    const even = [...mk("triage", 50, "spam"), ...mk("sinabis", 50, "business")];
    const r = sampleCasesDetailed(even, { seed: 4, n: 20, strategy: "balanced" });
    assert.deepEqual(counts(r.cases), { "triage|spam": 10, "sinabis|business": 10 });
    assert.deepEqual(r.shortStrata, []);
  });

  it("balanced is the default strategy", () => {
    assert.deepEqual(
      sampleCases(pool, { seed: 2, n: 30 }).map((c) => c.id),
      sampleCases(pool, { seed: 2, n: 30, strategy: "balanced" }).map((c) => c.id),
    );
  });

  it("proportional: shares follow the population with largest-remainder rounding", () => {
    // population 100/100/3/50 = 253; n = 50 -> 19.76, 19.76, 0.59, 9.88; floors 19,19,0,9 (47); +1 for the 3 largest remainders
    const r = sampleCasesDetailed(pool, { seed: 1, n: 50, strategy: "proportional" });
    assert.equal(r.cases.length, 50);
    const c = counts(r.cases);
    assert.equal(c["triage|spam"], 20);
    assert.equal(c["triage|personal"], 20);
    assert.equal(c["sinabis|business"], 10);
    assert.equal(c["triage|business"] ?? 0, 0);
    assert.deepEqual(r.shortStrata, []);
  });

  it("proportional keeps the population ratios", () => {
    const skew = [...mk("triage", 300, "spam"), ...mk("sinabis", 100, "business")];
    const c = counts(sampleCasesDetailed(skew, { seed: 3, n: 40, strategy: "proportional" }).cases);
    assert.deepEqual(c, { "triage|spam": 30, "sinabis|business": 10 });
  });

  it("is deterministic per seed for both strategies and differs between seeds", () => {
    for (const strategy of ["balanced", "proportional"] as const) {
      const ids = (seed: number) => sampleCases(pool, { seed, n: 30, strategy }).map((c) => c.id);
      assert.deepEqual(ids(5), ids(5));
      assert.deepEqual(ids(5), sampleCases([...pool].reverse(), { seed: 5, n: 30, strategy }).map((c) => c.id));
      assert.notDeepEqual(ids(5), ids(6));
    }
  });

  it("never duplicates and caps at the population", () => {
    for (const strategy of ["balanced", "proportional"] as const) {
      const r = sampleCasesDetailed(pool, { seed: 1, n: 10_000, strategy });
      assert.equal(r.cases.length, pool.length);
      assert.equal(new Set(r.cases.map((c) => c.id)).size, pool.length);
    }
  });

  it("separates phishing (no category) into its own stratum", () => {
    const phishing: EvalCase = {
      id: "triage-p0", source: "triage", lang: "en", sender_domain: "a", subject: "s", body: "b",
      expected: { is_phishing_or_scam: true, is_spam: true },
    };
    assert.equal(strataKey(phishing), "triage|phishing");
    assert.equal(strataKey({ ...phishing, expected: {} }), "triage|(none)");
  });
});
