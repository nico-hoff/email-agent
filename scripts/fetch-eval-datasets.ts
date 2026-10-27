// Laedt die allowlisted oeffentlichen synthetischen Datensets ueber die datasets-server-rows-API
// nach data/eval-datasets/<kurzname>/ (gitignored). Keine Env-Variable, keine Abhaengigkeit.
// Aufruf: node scripts/fetch-eval-datasets.ts [--max-rows N] [--source <kurzname>]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EVAL_SOURCES, type EvalSource } from "../lib/eval-sources.ts";

export const PAGE_SIZE = 100;
export const DEFAULT_MAX_ROWS = 2000;
const PAUSE_MS = 250;

export type DatasetManifest = {
  id: string;
  short: string;
  revision: string;
  license: string;
  rows: number;
  skipped_truncated: number;
  fetched_at: string;
};

export type FetchSourceInput = {
  source: EvalSource;
  fetchFn: typeof fetch;
  outRoot: string;
  maxRows: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  onProgress?: (done: number, target: number) => void;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

async function getJson(fetchFn: typeof fetch, url: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchFn(url);
  } catch {
    throw new Error("transport");
  }
  if (!res.ok) throw new Error(`http_${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new Error("invalid_json");
  }
}

// Die Datensets sind nach Kategorie sortiert: bei maxRows < total werden die Seiten gleichmaessig
// ueber das ganze Set verteilt statt nur den Anfang zu laden.
export function pagePlan(total: number, maxRows: number): Array<{ offset: number; length: number }> {
  const target = Math.min(total, maxRows);
  const pages = Math.ceil(target / PAGE_SIZE);
  const plan: Array<{ offset: number; length: number }> = [];
  const lastLen = target - (pages - 1) * PAGE_SIZE;
  const lenOf = (i: number) => (i === pages - 1 ? lastLen : PAGE_SIZE);
  if (target >= total || pages * PAGE_SIZE >= total) {
    for (let i = 0; i < pages; i++) plan.push({ offset: i * PAGE_SIZE, length: lenOf(i) });
    return plan;
  }
  const span = total - PAGE_SIZE;
  for (let i = 0; i < pages; i++) {
    const offset = pages === 1 ? Math.floor(span / 2) : Math.floor((i * span) / (pages - 1));
    plan.push({ offset, length: lenOf(i) });
  }
  return plan;
}

export async function fetchSource(input: FetchSourceInput): Promise<DatasetManifest> {
  const { source, fetchFn, outRoot, maxRows } = input;
  if (!Number.isInteger(maxRows) || maxRows < 1) throw new Error("max_rows_invalid");
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = input.now ?? (() => new Date());

  const meta = await getJson(fetchFn, `https://huggingface.co/api/datasets/${source.id}`);
  if (!isRecord(meta) || typeof meta.sha !== "string" || !/^[0-9a-f]{40}$/.test(meta.sha)) {
    throw new Error("revision_missing");
  }
  const card = isRecord(meta.cardData) ? meta.cardData : {};
  if (card.license !== source.license) throw new Error("license_mismatch");

  const base = new URL("https://datasets-server.huggingface.co/rows");
  base.searchParams.set("dataset", source.id);
  base.searchParams.set("config", source.config);
  base.searchParams.set("split", source.split);
  const pageUrl = (offset: number, length: number) => {
    const u = new URL(base);
    u.searchParams.set("offset", String(offset));
    u.searchParams.set("length", String(length));
    return u.toString();
  };

  const getPage = async (offset: number, length: number) => {
    const page = await getJson(fetchFn, pageUrl(offset, length));
    if (!isRecord(page) || !Array.isArray(page.rows) || typeof page.num_rows_total !== "number") {
      throw new Error("invalid_page");
    }
    return { rows: page.rows as unknown[], total: page.num_rows_total };
  };

  const lines: string[] = [];
  let skipped = 0;
  const firstLen = Math.min(PAGE_SIZE, maxRows);
  const firstPage = await getPage(0, firstLen);
  const plan = pagePlan(firstPage.total, maxRows);
  const target = Math.min(firstPage.total, maxRows);
  for (let i = 0; i < plan.length; i++) {
    const req = plan[i];
    let rows: unknown[];
    if (i === 0 && req.offset === 0 && req.length === firstLen) {
      rows = firstPage.rows;
    } else {
      await sleep(PAUSE_MS);
      rows = (await getPage(req.offset, req.length)).rows;
    }
    for (const r of rows) {
      if (!isRecord(r) || typeof r.row_idx !== "number" || !isRecord(r.row)) throw new Error("invalid_row");
      if (Array.isArray(r.truncated_cells) && r.truncated_cells.length > 0) {
        skipped++;
        continue;
      }
      lines.push(JSON.stringify({ row_idx: r.row_idx, row: r.row }));
    }
    input.onProgress?.(lines.length + skipped, target);
  }

  const dir = join(outRoot, source.short);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "rows.jsonl"), lines.length ? `${lines.join("\n")}\n` : "");
  const manifest: DatasetManifest = {
    id: source.id,
    short: source.short,
    revision: meta.sha,
    license: source.license,
    rows: lines.length,
    skipped_truncated: skipped,
    fetched_at: now().toISOString(),
  };
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function parseArgs(argv: string[]): { maxRows: number; only: string | null } | null {
  let maxRows = DEFAULT_MAX_ROWS;
  let only: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--max-rows") {
      maxRows = Number(argv[++i]);
    } else if (argv[i] === "--source") {
      only = argv[++i] ?? null;
    } else {
      return null;
    }
  }
  if (!Number.isInteger(maxRows) || maxRows < 1) return null;
  if (only !== null && !EVAL_SOURCES.some((s) => s.short === only)) return null;
  return { maxRows, only };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error("usage: eval:fetch [--max-rows N] [--source triage|sinabis]  (error: args_invalid)");
    process.exit(2);
  }
  const outRoot = join(import.meta.dirname, "..", "data", "eval-datasets");
  let failed = false;
  for (const source of EVAL_SOURCES) {
    if (args.only && source.short !== args.only) continue;
    try {
      const m = await fetchSource({ source, fetchFn: fetch, outRoot, maxRows: args.maxRows });
      console.log(
        `${source.short}: rows=${m.rows} skipped_truncated=${m.skipped_truncated} revision=${m.revision.slice(0, 12)} license=${m.license}`,
      );
    } catch (e) {
      failed = true;
      console.error(`${source.short}: failed (${e instanceof Error ? e.message : "unknown"})`);
    }
  }
  process.exit(failed ? 1 : 0);
}

if (import.meta.main) await main();
