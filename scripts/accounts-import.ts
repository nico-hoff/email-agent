// One-time import of the legacy accounts file into the database (R2, ADR 0023). Needs ACCOUNTS_ENCRYPTION_KEY.
//   npm run accounts:import
// Prints counts and codes only, never a value. The server does the same automatically at startup; afterwards the file is
// never read again (marker in user_state).
import { fileURLToPath } from "node:url";
import { validateDatabasePath } from "../lib/accounts.ts";
import { loadKeyring } from "../lib/account-secrets.ts";
import { PROJECT_ROOT } from "../lib/constants.ts";
import { openDatabase } from "../lib/db.ts";
import { importLegacyAccounts } from "../lib/mail-accounts.ts";

export interface CliDeps {
  env: Record<string, string | undefined>;
  projectRoot?: string;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

export function accountsImportMain(deps: CliDeps): number {
  const out = deps.out ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));
  const root = deps.projectRoot ?? PROJECT_ROOT;
  const keys = loadKeyring(deps.env);
  if (!keys.ok) {
    err("accounts:import: ACCOUNTS_ENCRYPTION_KEY is missing or invalid (32 bytes, base64; openssl rand -base64 32)");
    return 2;
  }
  const db = openDatabase(validateDatabasePath(deps.env, root));
  try {
    const r = importLegacyAccounts(db, { env: deps.env, projectRoot: root, keys });
    if (r.status === "imported") out(`accounts:import: imported ${r.count} account(s); the file is not read again`);
    else if (r.status === "already_imported") out("accounts:import: already imported, nothing to do");
    else out("accounts:import: no accounts file found, nothing to do");
    return 0;
  } catch (e) {
    err(`accounts:import: failed (${e instanceof Error ? e.name : "error"}); nothing was changed`);
    return 1;
  } finally {
    db.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(accountsImportMain({ env: process.env }));
