import { openDatabase } from "../../../lib/db.ts";
import { validateDatabasePath } from "../../../lib/accounts.ts";
import { PROJECT_ROOT } from "../../../lib/constants.ts";
import { listActions, parseActionsQuery } from "../../../lib/actions-api.ts";

// Reads only from SQLite: ids, codes and timestamps of mailbox actions (dry run and live). No mail content.
// Query: mode=dry_run|live, status=planned|done|failed|undone, limit (<= 50), cursor (opaque).
export function GET(request: Request): Response {
  const parsed = parseActionsQuery(new URL(request.url));
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
  let db;
  try {
    db = openDatabase(validateDatabasePath(process.env, PROJECT_ROOT));
    return Response.json(listActions(db, parsed.query), { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ error: "actions_unavailable" }, { status: 500 });
  } finally {
    db?.close();
  }
}
