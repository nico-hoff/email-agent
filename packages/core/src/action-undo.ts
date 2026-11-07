// POST /api/actions/:id/undo: undo of one quarantine or trash action (R9, ADR 0025 Teil 2). Live actions move the mail back
// to the INBOX through the mailbox-actions module; planned (dry-run) actions are dropped without touching the server.
// Errors leave as codes, never as server text. Another user's action id is 404.
import type { DatabaseSync } from "node:sqlite";
import { type AuthContext, guardMutation } from "./auth-runtime.ts";
import type { MailboxActions } from "./mailbox-actions.ts";
import type { RateLimiter } from "./rate-limit.ts";

export interface ActionUndoDeps {
  auth: AuthContext;
  limiter: RateLimiter;
  openDb(): DatabaseSync;
  actions(db: DatabaseSync): MailboxActions;
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

const STATUS_BY_CODE = new Map<string, number>([
  ["not_found", 404], ["kill_switch", 409], ["user_stop", 409], ["not_undoable", 409], ["no_location", 409], ["account_unavailable", 503],
]);

export function parseActionId(raw: unknown): number | null {
  return typeof raw === "string" && /^[1-9]\d{0,12}$/.test(raw) ? Number(raw) : null;
}

/** Order: session (401), rate limit (429), CSRF (403), id (404), then the undo. */
export async function handleActionUndo(request: Request, rawId: unknown, deps: ActionUndoDeps): Promise<Response> {
  const gate = guardMutation(request, deps.auth, deps.limiter);
  if (!gate.ok) return gate.response;
  const id = parseActionId(rawId);
  if (id === null) return json({ error: "not_found" }, 404);
  let db: DatabaseSync | undefined;
  try {
    db = deps.openDb();
    const r = await deps.actions(db).undoMove(gate.userId, id);
    if (r.ok) return json({ ok: true, id, mode: r.mode });
    return json({ error: r.code }, STATUS_BY_CODE.get(r.code) ?? 502);
  } catch {
    return json({ error: "unavailable" }, 500);
  } finally {
    db?.close();
  }
}
