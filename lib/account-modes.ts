// Mode of the automatic "Spam gelesen" rule per account, for the list header ("Postfach nur lesend" or not).
// Read from the database (mail_accounts.spam_seen_mode, R2); only the mode leaves this module. An account without
// credentials row (demo data) is absent from the map, which the API reports as dry_run.
import type { DatabaseSync } from "node:sqlite";
import type { AutoActionMode } from "./accounts-config.ts";
import { readSpamSeenModes } from "./mail-accounts.ts";

export function readAutoActionModes(db: DatabaseSync, userId: number): Map<string, AutoActionMode> {
  try {
    return readSpamSeenModes(db, userId);
  } catch {
    // Unreadable = the conservative reading: nothing is written.
    return new Map();
  }
}
