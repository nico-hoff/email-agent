import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVAL_SOURCES } from "../lib/eval-sources.ts";
import { DEFAULT_HARD_CAP, fetchSource, pageIndices } from "../scripts/fetch-eval-datasets.ts";

const source = EVAL_SOURCES.find((s) => s.short === "triage")!;
const SHA = "0123456789abcdef0123456789abcdef01234567";

type Call = { offset: number; length: number; url: string };

function fakeFetch(opts: {
  total: number;
  license?: string;
  failRows?: number;
  truncatedIdx?: number[];
  categoryOf?: (i: number) => string;
  sameAs?: Record<number, number>;
}) {
  const calls: Call[] = [];
  const urls: string[] = [];
  const fn = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    if (url.startsWith("https://huggingface.co/api/datasets/")) {
      return Response.json({ id: source.id, sha: SHA, cardData: { license: opts.license ?? source.license } });
    }
    const u = new URL(url);
    assert.equal(u.origin, "https://datasets-server.huggingface.co");
    assert.equal(u.pathname, "/rows");
    assert.equal(u.searchParams.get("dataset"), source.id);
    assert.equal(u.searchParams.get("config"), source.config);
    assert.equal(u.searchParams.get("split"), source.split);
    const offset = Number(u.searchParams.get("offset"));
    const length = Number(u.searchParams.get("length"));
    calls.push({ offset, length, url });
    if (opts.failRows) return new Response("secret detail", { status: opts.failRows });
    const rows = [];
    for (let i = offset; i < Math.min(offset + length, opts.total); i++) {
      const c = opts.sameAs?.[i] ?? i;
      rows.push({
        row_idx: i,
        row: { subject: `s${c}`, body: `b${c}`, category: opts.categoryOf ? opts.categoryOf(i) : "spam" },
        truncated_cells: opts.truncatedIdx?.includes(i) ? ["body"] : [],
      });
    }
    return Response.json({ rows, num_rows_total: opts.total, partial: false });
  }) as typeof fetch;
  return { fn, calls, urls };
}

function tmp() {
  return mkdtempSync(join(tmpdir(), "eval-fetch-"));
}

function listFiles(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? listFiles(p, base) : [p.slice(base.length + 1)];
  });
}

const noSleep = async () => {};

describe("fetchSource: full download", () => {
  it("loads every row by default (pages of <= 100) and writes a manifest with revision and counts", async () => {
    const out = tmp();
    const f = fakeFetch({ total: 250 });
    const m = await fetchSource({
      source, fetchFn: f.fn, outRoot: out, sleep: noSleep, now: () => new Date("2026-01-02T03:04:05Z"),
    });
    assert.deepEqual(f.calls.map((c) => [c.offset, c.length]), [[0, 100], [100, 100], [200, 100]]);
    assert.ok(f.calls.every((c) => c.length <= 100));
    assert.equal(m.id, source.id);
    assert.equal(m.short, "triage");
    assert.equal(m.revision, SHA);
    assert.equal(m.license, "apache-2.0");
    assert.equal(m.total_rows, 250);
    assert.equal(m.rows, 250);
    assert.equal(m.skipped_truncated, 0);
    assert.equal(m.duplicates_removed, 0);
    assert.equal(m.max_rows, null);
    assert.equal(m.fetched_at, "2026-01-02T03:04:05.000Z");
    assert.deepEqual(JSON.parse(readFileSync(join(out, "triage", "manifest.json"), "utf8")), m);
    const lines = readFileSync(join(out, "triage", "rows.jsonl"), "utf8").trim().split("\n");
    assert.equal(lines.length, 250);
    assert.equal(JSON.parse(lines[249]).row_idx, 249);
  });

  it("downloads a set larger than the old default of 2000 completely", async () => {
    const f = fakeFetch({ total: 3905 });
    const m = await fetchSource({ source, fetchFn: f.fn, outRoot: tmp(), sleep: noSleep });
    assert.equal(m.rows, 3905);
    assert.equal(f.calls.length, 40);
  });

  it("aborts with a code above the safety cap, before downloading further pages", async () => {
    const f = fakeFetch({ total: 250 });
    await assert.rejects(
      fetchSource({ source, fetchFn: f.fn, outRoot: tmp(), sleep: noSleep, hardCap: 200 }),
      (e: Error) => e.message === "source_too_large",
    );
    assert.ok(f.calls.length <= 1);
    assert.equal(DEFAULT_HARD_CAP, 20_000);
  });

  it("writes only rows.jsonl and manifest.json under <outRoot>/<short>", async () => {
    const out = tmp();
    await fetchSource({ source, fetchFn: fakeFetch({ total: 5 }).fn, outRoot: out, sleep: noSleep });
    assert.deepEqual(listFiles(out).sort(), [join("triage", "manifest.json"), join("triage", "rows.jsonl")]);
  });

  it("records the class distribution (raw category and mapped label) in the manifest", async () => {
    const cats = ["spam", "phishing", "personal", "finance"];
    const m = await fetchSource({
      source, fetchFn: fakeFetch({ total: 40, categoryOf: (i) => cats[i % 4] }).fn, outRoot: tmp(), sleep: noSleep,
    });
    assert.deepEqual(m.class_distribution.raw, { finance: 10, personal: 10, phishing: 10, spam: 10 });
    // finance has no expected category ("(none)"), phishing is its own label
    assert.deepEqual(m.class_distribution.mapped, { "(none)": 10, personal: 10, phishing: 10, spam: 10 });
  });

  it("removes exact duplicates before anything else, keeps the first row and counts them", async () => {
    const out = tmp();
    // rows 5 and 7 repeat the content of row 1; row 9 repeats row 2
    const m = await fetchSource({
      source, fetchFn: fakeFetch({ total: 12, sameAs: { 5: 1, 7: 1, 9: 2 } }).fn, outRoot: out, sleep: noSleep,
    });
    assert.equal(m.total_rows, 12);
    assert.equal(m.duplicates_removed, 3);
    assert.equal(m.rows, 9);
    const idx = readFileSync(join(out, "triage", "rows.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).row_idx);
    assert.deepEqual(idx, [0, 1, 2, 3, 4, 6, 8, 10, 11]);
    assert.equal(Object.values(m.class_distribution.raw).reduce((a, b) => a + b, 0), 9);
  });

  it("skips rows with truncated cells and counts them", async () => {
    const out = tmp();
    const m = await fetchSource({
      source, fetchFn: fakeFetch({ total: 10, truncatedIdx: [2, 3] }).fn, outRoot: out, sleep: noSleep,
    });
    assert.equal(m.rows, 8);
    assert.equal(m.skipped_truncated, 2);
  });

  it("fails with a bare code (no body, no URL) on HTTP errors", async () => {
    await assert.rejects(
      fetchSource({ source, fetchFn: fakeFetch({ total: 10, failRows: 500 }).fn, outRoot: tmp(), sleep: noSleep }),
      (e: Error) => e.message === "http_500",
    );
  });

  it("refuses a license that differs from the allowlist", async () => {
    await assert.rejects(
      fetchSource({ source, fetchFn: fakeFetch({ total: 10, license: "mit" }).fn, outRoot: tmp(), sleep: noSleep }),
      (e: Error) => e.message === "license_mismatch",
    );
  });
});

describe("fetchSource: --max-rows (tests and debugging only)", () => {
  it("draws a seeded uniform random selection of distinct pages, deterministic across calls", async () => {
    const run = async () => {
      const f = fakeFetch({ total: 3905 });
      const m = await fetchSource({ source, fetchFn: f.fn, outRoot: tmp(), maxRows: 300, sleep: noSleep });
      return { m, offsets: f.calls.map((c) => c.offset) };
    };
    const a = await run();
    const b = await run();
    assert.equal(a.m.rows, 300);
    assert.equal(a.m.max_rows, 300);
    assert.equal(a.m.total_rows, 3905);
    assert.deepEqual(a.offsets, b.offsets);
    assert.ok(a.offsets.every((o) => o % 100 === 0 && o >= 0 && o < 3905));
    assert.equal(new Set(a.offsets).size, a.offsets.length);
  });

  it("trims to maxRows", async () => {
    const m = await fetchSource({ source, fetchFn: fakeFetch({ total: 5000 }).fn, outRoot: tmp(), maxRows: 250, sleep: noSleep });
    assert.equal(m.rows, 250);
  });

  it("does not apply the safety cap to a bounded debug fetch", async () => {
    const m = await fetchSource({
      source, fetchFn: fakeFetch({ total: 500 }).fn, outRoot: tmp(), maxRows: 100, hardCap: 200, sleep: noSleep,
    });
    assert.equal(m.rows, 100);
  });

  it("rejects a non-positive maxRows", async () => {
    await assert.rejects(
      fetchSource({ source, fetchFn: fakeFetch({ total: 10 }).fn, outRoot: tmp(), maxRows: 0, sleep: noSleep }),
      (e: Error) => e.message === "max_rows_invalid",
    );
  });
});

describe("pageIndices", () => {
  it("returns all pages ascending when everything is requested", () => {
    assert.deepEqual(pageIndices(250, null), [0, 1, 2]);
    assert.deepEqual(pageIndices(250, 1000), [0, 1, 2]);
  });
  it("returns ceil(maxRows/100) distinct sorted pages for a smaller request, same seed same pages", () => {
    const p = pageIndices(3905, 300);
    assert.equal(p.length, 3);
    assert.deepEqual(p, [...p].sort((x, y) => x - y));
    assert.equal(new Set(p).size, 3);
    assert.ok(p.every((i) => i >= 0 && i < 40));
    assert.deepEqual(pageIndices(3905, 300), p);
  });
});
