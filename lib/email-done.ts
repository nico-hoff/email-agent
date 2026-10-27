// POST /api/emails/:id/done and /undone: Nico's decision, stored in the app database only (never a mailbox).
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { type AuthContext, guardMutation } from "./auth-runtime.ts";
import { parseEmailId, readEmailStatus, setDone } from "./email-status.ts";
import type { RateLimiter } from "./rate-limit.ts";

export interface DoneDeps {
  auth: AuthContext;
  limiter: RateLimiter;
  openDb(): DatabaseSync;
  now?: () => Date;
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

/**
 * Order: session (401), rate limit (429), CSRF (403), id (404), then the write. Repeating a call is harmless and
 * leaves no second audit row. Audit rows carry ids only.
 */
export function handleSetDone(request: Request, rawId: unknown, done: boolean, deps: DoneDeps): Response {
  const gate = guardMutation(request, deps.auth, deps.limiter);
  if (!gate.ok) return gate.response;
  const id = parseEmailId(rawId);
  if (id === null) return json({ error: "not_found" }, 404);
  let db: DatabaseSync | undefined;
  try {
    db = deps.openDb();
    const mail = db.prepare("SELECT account_id FROM emails WHERE id = ?").get(id) as { account_id: string } | undefined;
    if (!mail) return json({ error: "not_found" }, 404);
    const ts = (deps.now?.() ?? new Date()).toISOString();
    db.exec("BEGIN IMMEDIATE");
    try {
      const { changed } = setDone(db, id, done, ts);
      if (changed) {
        db.prepare(
          `INSERT INTO audit_log (occurred_at, trace_id, actor, action, account_id, email_id, details_json)
           VALUES (?, ?, 'system', ?, ?, ?, '{}')`,
        ).run(ts, randomUUID(), done ? "email_done" : "email_undone", mail.account_id, id);
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    const status = readEmailStatus(db, id);
    return json({ ok: true, id, done: status.done, seen: status.seen });
  } catch {
    return json({ error: "status_unavailable" }, 500);
  } finally {
    db?.close();
  }
}
