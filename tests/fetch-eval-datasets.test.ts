import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVAL_SOURCES } from "../lib/eval-sources.ts";
import { fetchSource } from "../scripts/fetch-eval-datasets.ts";

const source = EVAL_SOURCES.find((s) => s.short === "triage")!;
const SHA = "0123456789abcdef0123456789abcdef01234567";

type Call = { offset: number; length: number; url: string };

function fakeFetch(opts: { total: number; license?: string; failRows?: number; truncatedIdx?: number[] }) {
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
      rows.push({
        row_idx: i,
        row: { subject: `s${i}`, body: `b${i}`, category: "spam" },
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

describe("fetchSource", () => {
  it("paginates with length <= 100 and writes rows plus a manifest with the pinned revision", async () => {
    const out = tmp();
    const f = fakeFetch({ total: 250 });
    const m = await fetchSource({
      source, fetchFn: f.fn, outRoot: out, maxRows: 1000, sleep: noSleep, now: () => new Date("2026-01-02T03:04:05Z"),
    });
    assert.deepEqual(f.calls.map((c) => [c.offset, c.length]), [[0, 100], [100, 100], [200, 50]]);
    assert.ok(f.calls.every((c) => c.length <= 100));
    assert.deepEqual(m, {
      id: source.id,
      short: "triage",
      revision: SHA,
      license: "apache-2.0",
      rows: 250,
      skipped_truncated: 0,
      fetched_at: "2026-01-02T03:04:05.000Z",
    });
    assert.deepEqual(JSON.parse(readFileSync(join(out, "triage", "manifest.json"), "utf8")), m);
    const lines = readFileSync(join(out, "triage", "rows.jsonl"), "utf8").trim().split("\n");
    assert.equal(lines.length, 250);
    assert.equal(JSON.parse(lines[249]).row_idx, 249);
  });

  it("writes only rows.jsonl and manifest.json under <outRoot>/<short>", async () => {
    const out = tmp();
    await fetchSource({ source, fetchFn: fakeFetch({ total: 5 }).fn, outRoot: out, maxRows: 100, sleep: noSleep });
    assert.deepEqual(listFiles(out).sort(), [join("triage", "manifest.json"), join("triage", "rows.jsonl")]);
  });

  it("honours maxRows and spreads pages across the dataset without overlap", async () => {
    const out = tmp();
    const f = fakeFetch({ total: 3905 });
    const m = await fetchSource({ source, fetchFn: f.fn, outRoot: out, maxRows: 300, sleep: noSleep });
    assert.equal(m.rows, 300);
    assert.equal(f.calls.length, 3);
    const offsets = f.calls.map((c) => c.offset);
    assert.deepEqual(offsets, [...offsets].sort((a, b) => a - b));
    for (let i = 1; i < offsets.length; i++) assert.ok(offsets[i] - offsets[i - 1] >= 100);
    assert.ok(offsets[offsets.length - 1] > 1000);
  });

  it("trims the last page to maxRows", async () => {
    const f = fakeFetch({ total: 5000 });
    const m = await fetchSource({ source, fetchFn: f.fn, outRoot: tmp(), maxRows: 250, sleep: noSleep });
    assert.equal(m.rows, 250);
    assert.deepEqual(f.calls.map((c) => c.length), [100, 100, 50]);
  });

  it("skips rows with truncated cells and counts them", async () => {
    const out = tmp();
    const m = await fetchSource({
      source, fetchFn: fakeFetch({ total: 10, truncatedIdx: [2, 3] }).fn, outRoot: out, maxRows: 100, sleep: noSleep,
    });
    assert.equal(m.rows, 8);
    assert.equal(m.skipped_truncated, 2);
  });

  it("fails with a bare code (no body, no URL) on HTTP errors", async () => {
    await assert.rejects(
      fetchSource({ source, fetchFn: fakeFetch({ total: 10, failRows: 500 }).fn, outRoot: tmp(), maxRows: 100, sleep: noSleep }),
      (e: Error) => e.message === "http_500",
    );
  });

  it("refuses a license that differs from the allowlist", async () => {
    await assert.rejects(
      fetchSource({ source, fetchFn: fakeFetch({ total: 10, license: "mit" }).fn, outRoot: tmp(), maxRows: 100, sleep: noSleep }),
      (e: Error) => e.message === "license_mismatch",
    );
  });

  it("rejects a non-positive maxRows", async () => {
    await assert.rejects(
      fetchSource({ source, fetchFn: fakeFetch({ total: 10 }).fn, outRoot: tmp(), maxRows: 0, sleep: noSleep }),
      (e: Error) => e.message === "max_rows_invalid",
    );
  });
});
