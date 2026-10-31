// Fills the database of a PREVIEW app with the tiny built-in synthetic set (the one scripts/e2e-smoke.ts uses).
// No network, no Jev call, no model call, no IMAP. Opt-in: scripts/docker-entrypoint.sh runs it only when
// PREVIEW_SEED_SYNTHETIC=1 (set in fly.preview.toml, never in fly.toml).
//
// Safety:
// - On fly it refuses any app whose name does not start with `email-agent-preview-` (never seeds prod).
// - Refuses when an accounts file is configured or present (preview has no mailboxes).
// - Refuses a database that holds non-synthetic accounts (assertSyntheticDatabase).
// - Seeds only an EMPTY database (no emails yet); a restart on a filled database changes nothing.
// Output: one line, no mail data. Aufruf: node scripts/seed-preview.ts
import { existsSync } from "node:fs";
import { PROJECT_ROOT } from "../lib/constants.ts";
import { validateDatabasePath } from "../lib/accounts.ts";
import { openDatabase } from "../lib/db.ts";
import { importSyntheticCases } from "../lib/synthetic-dev-db.ts";
import { smokeItems } from "./e2e-smoke.ts";

export const PREVIEW_APP_PREFIX = "email-agent-preview-";

export type SeedResult = { status: "seeded"; cases: number } | { status: "skipped"; reason: "not-empty" };

export class PreviewSeedRefusedError extends Error {
  constructor(reason: string) {
    super(`preview seed refused: ${reason}`);
    this.name = "PreviewSeedRefusedError";
  }
}

/** Throws unless the environment is a preview app (or a local run with no fly app name) without mailboxes. */
export function assertPreviewEnv(env: Record<string, string | undefined>, exists: (p: string) => boolean = existsSync): void {
  const app = env.FLY_APP_NAME;
  if (app !== undefined && app !== "" && !app.startsWith(PREVIEW_APP_PREFIX)) throw new PreviewSeedRefusedError("not a preview app");
  if (env.ACCOUNTS_FILE !== undefined && env.ACCOUNTS_FILE !== "" && exists(env.ACCOUNTS_FILE)) throw new PreviewSeedRefusedError("accounts file present");
}

export function seedPreview(env: Record<string, string | undefined> = process.env, projectRoot: string = PROJECT_ROOT): SeedResult {
  assertPreviewEnv(env);
  const db = openDatabase(validateDatabasePath(env, projectRoot));
  try {
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM emails").get() as { n: number };
    if (n > 0) return { status: "skipped", reason: "not-empty" };
    const r = importSyntheticCases(db, smokeItems(), { now: new Date() });
    return { status: "seeded", cases: r.cases };
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  try {
    const r = seedPreview();
    console.log(r.status === "seeded" ? `preview seed: ${r.cases} synthetic mails (no Jev calls, no bodies stored)` : "preview seed: database not empty, nothing changed");
  } catch (e) {
    console.error(`preview seed failed (${e instanceof Error ? e.name : "unknown"})`);
    process.exit(1);
  }
}
