import { defaultAuthContext, requireUser } from "../../../lib/auth-runtime.ts";
import { openDatabase } from "../../../lib/db.ts";
import { validateDatabasePath } from "../../../lib/accounts.ts";
import { PROJECT_ROOT } from "../../../lib/constants.ts";

const CLASSIFICATION_STATES = ["pending", "retry_wait", "classified", "failed", "paused"] as const;

// Reads only from SQLite (own connection): route modules may not share memory with server.ts.
export function GET(request: Request): Response {
  const who = requireUser(request, defaultAuthContext());
  if (!who.ok) return who.response;
  let db;
  try {
    db = openDatabase(validateDatabasePath(process.env, PROJECT_ROOT));
    const workers = db.prepare(
      `SELECT w.account_id, w.state, w.last_event_at, w.last_poll_at, w.error_code
       FROM worker_status w JOIN accounts a ON a.id = w.account_id WHERE a.user_id = ? ORDER BY w.account_id`,
    ).all(who.userId);
    const classifications: Record<string, number> = {};
    for (const s of CLASSIFICATION_STATES) classifications[s] = 0;
    const rows = db.prepare(
      `SELECT c.status, COUNT(*) AS n FROM classifications c JOIN emails e ON e.id = c.email_id JOIN accounts a ON a.id = e.account_id
       WHERE a.user_id = ? GROUP BY c.status`,
    ).all(who.userId) as {
      status: string;
      n: number;
    }[];
    for (const r of rows) classifications[r.status] = r.n;
    return Response.json({ workers, classifications });
  } catch {
    return Response.json({ error: "status_unavailable" }, { status: 500 });
  } finally {
    db?.close();
  }
}
