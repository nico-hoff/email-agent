import { openDatabase } from "../../../lib/db.ts";
import { validateDatabasePath } from "../../../lib/accounts.ts";
import { PROJECT_ROOT } from "../../../lib/constants.ts";
import { listEmails, parseListQuery } from "../../../lib/email-api.ts";

// Reads only from SQLite. Never exposes body/excerpt/raw data (none is stored) or account host/user.
// Query: view=important|open|noise|all, account, status, limit (<= 50 with view/cursor, else <= 200), cursor (opaque).
export function GET(request: Request): Response {
  const parsed = parseListQuery(new URL(request.url));
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

  let db;
  try {
    db = openDatabase(validateDatabasePath(process.env, PROJECT_ROOT));
    return Response.json(listEmails(db, parsed.query), { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ error: "emails_unavailable" }, { status: 500 });
  } finally {
    db?.close();
  }
}
