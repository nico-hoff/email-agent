// Laedt die allowlisted oeffentlichen synthetischen Datensets ueber die datasets-server-rows-API
// nach data/eval-datasets/<kurzname>/ (gitignored). Keine Env-Variable, keine Abhaengigkeit.
// Standard: ALLE Zeilen jeder Quelle (Sicherheitsobergrenze DEFAULT_HARD_CAP, darueber Abbruch source_too_large).
// Exakte Dubletten (Inhalts-Hash) werden entfernt, bevor irgendetwas geschrieben wird.
// Aufruf: node scripts/fetch-eval-datasets.ts [--source <kurzname>] [--max-rows N  (nur Tests/Debug)]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classLabel, contentHash, EVAL_SOURCES, mulberry32, shuffle, type EvalSource } from "../lib/eval-sources.ts";

export const PAGE_SIZE = 100;
/** Sicherheitsobergrenze je Quelle fuer den vollstaendigen Download. */
export const DEFAULT_HARD_CAP = 20_000;
/** Fester Seed fuer die Seitenauswahl bei --max-rows (reproduzierbar). */
export const FETCH_SEED = 20_260_427;
const PAUSE_MS = 250;
const NO_CLASS = "(none)";
const UNMAPPABLE = "(unmappable)";

export type ClassDistribution = {
  /** Anzahl je Rohkategorie der Quelle (Spalte `category`, sonst "(none)"). */
  raw: Record<string, number>;
  /** Anzahl je gemapptem Label (erwartete Kategorie, "phishing" oder "(none)"). */
  mapped: Record<string, number>;
};

export type DatasetManifest = {
  id: string;
  short: string;
  revision: string;
  license: string;
  /** Zeilen der Quelle laut datasets-server. */
  total_rows: number;
  /** Geschriebene Zeilen (nach Entfernen von Truncated und Dubletten). */
  rows: number;
  skipped_truncated: number;
  duplicates_removed: number;
  /** null = vollstaendiger Download. */
  max_rows: number | null;
  class_distribution: ClassDistribution;
  fetched_at: string;
};

export type FetchSourceInput = {
  source: EvalSource;
  fetchFn: typeof fetch;
  outRoot: string;
  /** Nur Tests/Debug: gleichmaessige Zufallsauswahl von Seiten mit festem Seed. Ohne Angabe: alles. */
  maxRows?: number;
  hardCap?: number;
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

/** Seitenindizes (je PAGE_SIZE Zeilen), aufsteigend. Ohne/mit grossem maxRows alle; sonst Zufallsauswahl mit festem Seed. */
export function pageIndices(total: number, maxRows: number | null, seed: number = FETCH_SEED): number[] {
  const pages = Math.ceil(total / PAGE_SIZE);
  const all = Array.from({ length: pages }, (_, i) => i);
  if (maxRows === null) return all;
  const want = Math.ceil(maxRows / PAGE_SIZE);
  if (want >= pages) return all;
  return shuffle(all, mulberry32(seed)).slice(0, want).sort((a, b) => a - b);
}

type Row = { row_idx: number; row: Record<string, unknown> };

export async function fetchSource(input: FetchSourceInput): Promise<DatasetManifest> {
  const { source, fetchFn, outRoot } = input;
  const maxRows = input.maxRows ?? null;
  if (maxRows !== null && (!Number.isInteger(maxRows) || maxRows < 1)) throw new Error("max_rows_invalid");
  const hardCap = input.hardCap ?? DEFAULT_HARD_CAP;
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

  // Die erste Seite liefert auch die Gesamtzahl; sie wird wiederverwendet, wenn sie ohnehin gebraucht wird.
  const first = await getPage(0, PAGE_SIZE);
  const total = first.total;
  if (maxRows === null && total > hardCap) throw new Error("source_too_large");
  const plan = pageIndices(total, maxRows);

  const collected: Row[] = [];
  let skipped = 0;
  const target = maxRows === null ? total : Math.min(total, maxRows);
  let done = 0;
  const take = (rows: unknown[]) => {
    for (const r of rows) {
      if (!isRecord(r) || typeof r.row_idx !== "number" || !isRecord(r.row)) throw new Error("invalid_row");
      if (Array.isArray(r.truncated_cells) && r.truncated_cells.length > 0) {
        skipped++;
        continue;
      }
      collected.push({ row_idx: r.row_idx, row: r.row });
    }
  };
  for (let i = 0; i < plan.length; i++) {
    const page = plan[i];
    let rows: unknown[];
    if (page === 0) {
      rows = first.rows;
    } else {
      await sleep(PAUSE_MS);
      rows = (await getPage(page * PAGE_SIZE, PAGE_SIZE)).rows;
    }
    take(rows);
    done += rows.length;
    input.onProgress?.(Math.min(done, target), target);
  }

  collected.sort((a, b) => a.row_idx - b.row_idx);
  const limited = maxRows === null ? collected : collected.slice(0, maxRows);

  // Dubletten zuerst: gleicher normalisierter Betreff + Body; die Zeile mit dem kleinsten Index bleibt.
  const seen = new Set<string>();
  const kept: Row[] = [];
  const raw: Record<string, number> = {};
  const mapped: Record<string, number> = {};
  let duplicates = 0;
  for (const r of limited) {
    const c = source.map(r.row, r.row_idx);
    if (c) {
      const h = contentHash(c);
      if (seen.has(h)) {
        duplicates++;
        continue;
      }
      seen.add(h);
    }
    kept.push(r);
    const rawClass = typeof r.row.category === "string" ? r.row.category : NO_CLASS;
    raw[rawClass] = (raw[rawClass] ?? 0) + 1;
    const label = c ? classLabel(c) : UNMAPPABLE;
    mapped[label] = (mapped[label] ?? 0) + 1;
  }
  const sortKeys = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

  const lines = kept.map((r) => JSON.stringify({ row_idx: r.row_idx, row: r.row }));
  const dir = join(outRoot, source.short);
  // 0700: data/ also holds the dev database, whose parent directory must not grant group/other access.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "rows.jsonl"), lines.length ? `${lines.join("\n")}\n` : "");
  const manifest: DatasetManifest = {
    id: source.id,
    short: source.short,
    revision: meta.sha,
    license: source.license,
    total_rows: total,
    rows: kept.length,
    skipped_truncated: skipped,
    duplicates_removed: duplicates,
    max_rows: maxRows,
    class_distribution: { raw: sortKeys(raw), mapped: sortKeys(mapped) },
    fetched_at: now().toISOString(),
  };
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function parseArgs(argv: string[]): { maxRows: number | undefined; only: string | null } | null {
  let maxRows: number | undefined;
  let only: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--max-rows") {
      maxRows = Number(argv[++i]);
      if (!Number.isInteger(maxRows) || maxRows < 1) return null;
    } else if (argv[i] === "--source") {
      only = argv[++i] ?? null;
    } else {
      return null;
    }
  }
  if (only !== null && !EVAL_SOURCES.some((s) => s.short === only)) return null;
  return { maxRows, only };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error("usage: eval:fetch [--source triage|sinabis] [--max-rows N (tests/debug only)]  (error: args_invalid)");
    process.exit(2);
  }
  const outRoot = join(import.meta.dirname, "..", "data", "eval-datasets");
  let failed = false;
  for (const source of EVAL_SOURCES) {
    if (args.only && source.short !== args.only) continue;
    try {
      const m = await fetchSource({
        source,
        fetchFn: fetch,
        outRoot,
        ...(args.maxRows !== undefined ? { maxRows: args.maxRows } : {}),
      });
      console.log(
        `${source.short}: total=${m.total_rows} rows=${m.rows} duplicates_removed=${m.duplicates_removed} skipped_truncated=${m.skipped_truncated} revision=${m.revision.slice(0, 12)} license=${m.license}`,
      );
      console.log(`  raw classes: ${JSON.stringify(m.class_distribution.raw)}`);
      console.log(`  mapped labels: ${JSON.stringify(m.class_distribution.mapped)}`);
    } catch (e) {
      failed = true;
      console.error(`${source.short}: failed (${e instanceof Error ? e.message : "unknown"})`);
    }
  }
  process.exit(failed ? 1 : 0);
}

if (import.meta.main) await main();
