// POST /api/emails/:id/unread ("wieder ungelesen"): the undo of "Spam gelesen" (H19).
// Live accounts remove \Seen on the server through the mailbox-actions module; dry-run accounts change the app status
// only. Errors leave as codes, never as server text.
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { type AccountConfig, loadAccountsConfig } from "./accounts-config.ts";
import { type AuthContext, dataDirFromEnv, guardMutation, syntheticFromEnv } from "./auth-runtime.ts";
import { KILL_SWITCH_FILE, PROJECT_ROOT } from "./constants.ts";
import { parseEmailId } from "./email-status.ts";
import { createMailboxActions, type MailboxActions } from "./mailbox-actions.ts";
import type { RateLimiter } from "./rate-limit.ts";

export interface UnreadDeps {
  auth: AuthContext;
  limiter: RateLimiter;
  openDb(): DatabaseSync;
  actions(db: DatabaseSync): MailboxActions;
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

const STATUS_BY_CODE = new Map<string, number>([["not_found", 404], ["kill_switch", 409], ["account_unavailable", 503]]);

/** Order: session (401), rate limit (429), CSRF (403), id (404), then the undo. */
export async function handleUnread(request: Request, rawId: unknown, deps: UnreadDeps): Promise<Response> {
  const gate = guardMutation(request, deps.auth, deps.limiter);
  if (!gate.ok) return gate.response;
  const id = parseEmailId(rawId);
  if (id === null) return json({ error: "not_found" }, 404);
  let db: DatabaseSync | undefined;
  try {
    db = deps.openDb();
    const r = await deps.actions(db).undoSeen(id);
    if (r.ok) return json({ ok: true, id, mode: r.mode, seen: false });
    return json({ error: r.code }, STATUS_BY_CODE.get(r.code) ?? 502);
  } catch {
    return json({ error: "status_unavailable" }, 500);
  } finally {
    db?.close();
  }
}

/**
 * Default wiring of the route: accounts file read at request time (credentials stay inside the executor), kill switch
 * file next to the database, synthetic mode never gets accounts and is forced to dry run.
 */
export function defaultMailboxActions(db: DatabaseSync, env: Record<string, string | undefined> = process.env): MailboxActions {
  const synthetic = syntheticFromEnv(env, PROJECT_ROOT);
  let accounts: AccountConfig[] = [];
  if (!synthetic) {
    try {
      const cfg = loadAccountsConfig({ env, projectRoot: PROJECT_ROOT });
      if (cfg.status === "ok") accounts = cfg.accounts;
    } catch {
      // an unusable accounts file: no account is live, a live undo then answers account_unavailable
    }
  }
  return createMailboxActions({
    db, accounts, forceDryRun: synthetic, killSwitchFile: join(dataDirFromEnv(env, PROJECT_ROOT), KILL_SWITCH_FILE),
  });
}
