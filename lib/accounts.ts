import { lstatSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { type AccountConfig, type AccountsConfigResult, loadAccountsConfig } from "./accounts-config.ts";
import { DEFAULT_DATABASE_PATH } from "./constants.ts";
import { openDatabase } from "./db.ts";
import { OWNER_USER_ID } from "./users.ts";

export class DatabasePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabasePathError";
  }
}

/** Resolves DATABASE_PATH against the project root and ensures a private (0700) parent directory. */
export function validateDatabasePath(
  env: Record<string, string | undefined>,
  projectRoot: string,
): string {
  const configured = env.DATABASE_PATH;
  const file = resolve(
    projectRoot,
    configured === undefined || configured === "" ? DEFAULT_DATABASE_PATH : configured,
  );
  const parent = dirname(file);
  let st;
  try {
    st = lstatSync(parent);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new DatabasePathError("DATABASE_PATH: parent directory cannot be inspected");
    }
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    st = lstatSync(parent);
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new DatabasePathError("DATABASE_PATH: parent must be a regular directory");
  }
  if ((st.mode & 0o077) !== 0) {
    throw new DatabasePathError("DATABASE_PATH: parent directory must not grant group/other access (use 0700)");
  }
  if (!isAbsolute(file)) throw new DatabasePathError("DATABASE_PATH: could not be resolved");
  return file;
}

/** Stores account metadata only (accounts from the accounts file belong to the owner, id 1; ADR 0033; label, tag color, folders; no credentials, no threshold). Accounts of that owner absent from the config are disabled, never deleted. */
export function syncAccounts(db: DatabaseSync, accounts: AccountConfig[], now: Date = new Date(), ownerUserId: number = OWNER_USER_ID): void {
  const ts = now.toISOString();
  const upsert = db.prepare(
    `INSERT INTO accounts (id, label, host, port, mailbox, spam_mailbox, enabled, color, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET label = excluded.label, color = excluded.color, host = excluded.host,
       port = excluded.port, mailbox = excluded.mailbox, spam_mailbox = excluded.spam_mailbox,
       enabled = excluded.enabled`,
  );
  const status = db.prepare(
    `INSERT INTO worker_status (account_id, state, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (account_id) DO UPDATE SET
       state = CASE WHEN excluded.state = 'disabled' THEN 'disabled'
                    WHEN worker_status.state = 'disabled' THEN 'connecting'
                    ELSE worker_status.state END,
       updated_at = excluded.updated_at`,
  );
  db.exec("BEGIN");
  try {
    const ids = new Set(accounts.map((a) => a.id));
    for (const a of accounts) {
      upsert.run(a.id, a.label, a.host, a.port, a.mailbox, a.spam_mailbox ?? null, a.enabled ? 1 : 0, a.color ?? null, ownerUserId);
      status.run(a.id, a.enabled ? "connecting" : "disabled", ts);
    }
    // Only the owner's accounts are compared with the file; accounts of other users are never touched by this sync.
    const known = db.prepare("SELECT id FROM accounts WHERE user_id = ?").all(ownerUserId) as { id: string }[];
    for (const { id } of known) {
      if (ids.has(id)) continue;
      db.prepare("UPDATE accounts SET enabled = 0 WHERE id = ?").run(id);
      status.run(id, "disabled", ts);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export interface StartupResult {
  db: DatabaseSync;
  config: AccountsConfigResult;
}

/** Start sequence: validate DB path, migrate, then load and register accounts. */
export function startup(opts: { env: Record<string, string | undefined>; projectRoot: string }): StartupResult {
  const dbPath = validateDatabasePath(opts.env, opts.projectRoot);
  const db = openDatabase(dbPath);
  try {
    const config = loadAccountsConfig(opts);
    syncAccounts(db, config.status === "ok" ? config.accounts : []);
    return { db, config };
  } catch (err) {
    db.close();
    throw err;
  }
}
