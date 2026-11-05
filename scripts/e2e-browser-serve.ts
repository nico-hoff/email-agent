// Server for the browser tests (Playwright, ADR 0047): the REAL service in users mode on a fresh TEMP database filled with
// the synthetic QA set (scripts/qa-serve.ts: simulated answers, no Jev call). No accounts file and no workers, so no IMAP,
// no model call, nothing touches a real mailbox. No env file is loaded: no API key reaches this process.
// Started by playwright.config.ts (webServer); the temp directory is removed on SIGTERM/SIGINT.
//
//   E2E_PORT=3300 (default)            port on 127.0.0.1
//   E2E_SERVER_MODE=development        for the TDD loop without `npm run build` (default: production, needs a build)
// Never prints mail data, passwords or tokens.
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createService } from "../server.ts";
import { openDatabase } from "../lib/db.ts";
import { PROJECT_ROOT } from "../lib/constants.ts";
import { ensureQaUser, QA_PASSWORD, QA_USER_EMAIL, seedQaDatabase } from "./qa-serve.ts";

export const E2E_DEFAULT_PORT = 3300;
export const E2E_USER_EMAIL = QA_USER_EMAIL;
export const E2E_PASSWORD = QA_PASSWORD;

/** Port from E2E_PORT (1024-65535), else the default. */
export function e2ePort(env: Record<string, string | undefined>): number {
  const raw = env.E2E_PORT;
  if (raw === undefined || raw === "") return E2E_DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("E2E_PORT must be 1024-65535");
  return port;
}

/**
 * Veryfront's local module cache for production mode (`npm start`, not used by the dev server). Seen 2026-11-05: an
 * entry from an older build kept serving a module without a newer export (page import failed with 500), so the browser
 * tests always start production mode with this cache empty. Only a cache; Veryfront rebuilds it on demand.
 */
export const PRODUCTION_MODULE_CACHE = join(PROJECT_ROOT, ".cache", "veryfront-mdx-esm", "email-agent", "preview-main");

export function e2eMode(env: Record<string, string | undefined>): "development" | "production" {
  return env.E2E_SERVER_MODE === "development" ? "development" : "production";
}

if (import.meta.main) {
  const port = e2ePort(process.env);
  const mode = e2eMode(process.env);
  if (mode === "production") rmSync(PRODUCTION_MODULE_CACHE, { recursive: true, force: true });
  const root = mkdtempSync(join(tmpdir(), "e2e-browser-"));
  chmodSync(root, 0o700);
  const file = join(root, "email-agent.sqlite");
  const cleanup = (): void => rmSync(root, { recursive: true, force: true });
  // Only what the service needs; the route modules read DATABASE_PATH and AUTH_MODE from process.env.
  process.env.DATABASE_PATH = file;
  process.env.AUTH_MODE = "users";
  delete process.env.APP_PASSWORD;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.ACCOUNTS_FILE;
  try {
    const db = openDatabase(file);
    try {
      const s = seedQaDatabase(db);
      await ensureQaUser(db, E2E_PASSWORD);
      console.log(`e2e-browser: ${s.cases} synthetic mails seeded`);
    } finally {
      db.close();
    }
    const svc = await createService({ mode, port, bindAddress: "127.0.0.1", workers: false, onSignal: () => {} });
    const stop = (): void => {
      void svc.stop().finally(() => {
        cleanup();
        process.exit(0);
      });
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    console.log(`e2e-browser: listening on 127.0.0.1:${svc.port} (${mode})`);
  } catch (err) {
    cleanup();
    console.error(`e2e-browser: start failed (${(err as Error).name})`);
    process.exit(1);
  }
}
