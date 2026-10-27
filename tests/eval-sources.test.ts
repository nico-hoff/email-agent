import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EXCERPT_MAX_CHARS } from "../lib/constants.ts";
import { EVAL_SOURCES, sampleCases, type EvalCase } from "../lib/eval-sources.ts";

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
