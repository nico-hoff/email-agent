import { defaultAuthContext, requireUser } from "../../../packages/core/src/auth-runtime.ts";
import { openDatabase } from "../../../packages/core/src/db.ts";
import { validateDatabasePath } from "../../../packages/core/src/accounts.ts";
import { PROJECT_ROOT } from "../../../packages/core/src/constants.ts";
import { listActions, parseActionsQuery } from "../../../packages/core/src/actions-api.ts";

// Reads only from SQLite: ids, codes and timestamps of mailbox actions (dry run and live). No mail content.
// Query: mode=dry_run|live, status=planned|done|failed|undone, limit (<= 50), cursor (opaque).
export function GET(request: Request): Response {
  const who = requireUser(request, defaultAuthContext());
  if (!who.ok) return who.response;
  const parsed = parseActionsQuery(new URL(request.url));
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
  let db;
  try {
    db = openDatabase(validateDatabasePath(process.env, PROJECT_ROOT));
    return Response.json(listActions(db, who.userId, parsed.query), { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ error: "actions_unavailable" }, { status: 500 });
  } finally {
    db?.close();
  }
}
