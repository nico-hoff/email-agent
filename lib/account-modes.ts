// Mode of the automatic "Spam gelesen" rule per account, for the list header ("Postfach nur lesend" or not).
// Only the mode leaves this module: the accounts file is read at request time and its credentials are dropped at once.
import { type AccountConfig, type AutoActionMode, autoActionMode, loadAccountsConfig } from "./accounts-config.ts";
import { syntheticFromEnv } from "./auth-runtime.ts";
import { PROJECT_ROOT } from "./constants.ts";

export function autoActionModesOf(accounts: Pick<AccountConfig, "id" | "enabled" | "auto_actions">[]): Map<string, AutoActionMode> {
  return new Map(accounts.map((a) => [a.id, a.enabled ? autoActionMode(a, "spam_seen") : "off"] as const));
}

/**
 * Synthetic mode never has live accounts (empty map: the API then reports dry_run). An unusable accounts file also
 * yields an empty map, i.e. the conservative reading "nothing is written".
 */
export function readAutoActionModes(env: Record<string, string | undefined> = process.env): Map<string, AutoActionMode> {
  if (syntheticFromEnv(env, PROJECT_ROOT)) return new Map();
  try {
    const cfg = loadAccountsConfig({ env, projectRoot: PROJECT_ROOT });
    return cfg.status === "ok" ? autoActionModesOf(cfg.accounts) : new Map();
  } catch {
    return new Map();
  }
}
