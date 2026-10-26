import { openDatabase } from "../../../lib/db.ts";
import { validateDatabasePath } from "../../../lib/accounts.ts";
import { PROJECT_ROOT } from "../../../lib/constants.ts";

const CLASSIFICATION_STATES = ["pending", "retry_wait", "classified", "failed", "paused"] as const;

// Reads only from SQLite (own connection): route modules may not share memory with server.ts.
export function GET(): Response {
  let db;
  try {
    db = openDatabase(validateDatabasePath(process.env, PROJECT_ROOT));
    const workers = db.prepare(
      `SELECT account_id, state, last_event_at, last_poll_at, error_code
       FROM worker_status ORDER BY account_id`,
    ).all();
    const classifications: Record<string, number> = {};
    for (const s of CLASSIFICATION_STATES) classifications[s] = 0;
    const rows = db.prepare("SELECT status, COUNT(*) AS n FROM classifications GROUP BY status").all() as {
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
