// Key rotation (R2): re-encrypts every stored mailbox password with the CURRENT key, in one transaction.
//   ACCOUNTS_ENCRYPTION_KEY=<new> ACCOUNTS_ENCRYPTION_KEY_OLD=<old> npm run accounts:rekey
// Afterwards ACCOUNTS_ENCRYPTION_KEY_OLD can be removed. All or nothing: one unreadable secret aborts and changes nothing.
import { fileURLToPath } from "node:url";
import { validateDatabasePath } from "../lib/accounts.ts";
import { loadKeyring } from "../lib/account-secrets.ts";
import { PROJECT_ROOT } from "../lib/constants.ts";
import { openDatabase } from "../lib/db.ts";
import { rekeyAll } from "../lib/mail-accounts.ts";
import type { CliDeps } from "./accounts-import.ts";

export function accountsRekeyMain(deps: CliDeps): number {
  const out = deps.out ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));
  const keys = loadKeyring(deps.env);
  if (!keys.ok) {
    err("accounts:rekey: ACCOUNTS_ENCRYPTION_KEY (and ACCOUNTS_ENCRYPTION_KEY_OLD, if set) must be valid: 32 bytes, base64");
    return 2;
  }
  const db = openDatabase(validateDatabasePath(deps.env, deps.projectRoot ?? PROJECT_ROOT));
  try {
    out(`accounts:rekey: re-encrypted ${rekeyAll(db, keys.keyring)} secret(s) with key ${keys.keyring.current.id}`);
    return 0;
  } catch {
    err("accounts:rekey: failed (a secret could not be decrypted with the given keys); nothing was changed");
    return 1;
  } finally {
    db.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(accountsRekeyMain({ env: process.env }));
