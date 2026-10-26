import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const MIGRATIONS_DIR = join(import.meta.dirname, "..", "db", "migrations");

export function applyPragmas(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
}

interface MigrationFile {
  version: number;
  file: string;
}

export function listMigrations(dir: string): MigrationFile[] {
  const result: MigrationFile[] = [];
  for (const file of readdirSync(dir)) {
    const m = /^(\d+)_.+\.sql$/.exec(file);
    if (m) result.push({ version: Number(m[1]), file });
  }
  result.sort((a, b) => a.version - b.version);
  for (let i = 1; i < result.length; i++) {
    if (result[i].version === result[i - 1].version) {
      throw new Error(`duplicate migration version ${result[i].version}`);
    }
  }
  return result;
}

/** Applies pending migrations once, in numeric order. Returns applied versions. */
export function runMigrations(db: DatabaseSync, dir: string = MIGRATIONS_DIR): number[] {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const done = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as { version: number }[]).map((r) =>
      r.version
    ),
  );
  const applied: number[] = [];
  for (const { version, file } of listMigrations(dir)) {
    if (done.has(version)) continue;
    const sql = readFileSync(join(dir, file), "utf8");
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
        version,
        new Date().toISOString(),
      );
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    applied.push(version);
  }
  return applied;
}

export function openDatabase(path: string, migrationsDir: string = MIGRATIONS_DIR): DatabaseSync {
  const db = new DatabaseSync(path);
  applyPragmas(db);
  runMigrations(db, migrationsDir);
  return db;
}
