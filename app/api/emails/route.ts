import { defaultAuthContext, requireUser } from "../../../packages/core/src/auth-runtime.ts";
import { openDatabase } from "../../../packages/core/src/db.ts";
import { validateDatabasePath } from "../../../packages/core/src/accounts.ts";
import { PROJECT_ROOT } from "../../../packages/core/src/constants.ts";
import { readAutoActionModes } from "../../../packages/core/src/account-modes.ts";
import { listEmails, parseListQuery } from "../../../packages/core/src/email-api.ts";

// Reads only from SQLite. Never exposes body/excerpt/raw data (none is stored) or account host/user.
// Query: view=important|open|noise|all, account, status, limit (<= 50), cursor (opaque). Without view: all. Sorted by urgency, importance, time.
export function GET(request: Request): Response {
  const who = requireUser(request, defaultAuthContext());
  if (!who.ok) return who.response;
  const parsed = parseListQuery(new URL(request.url));
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

  let db;
  try {
    db = openDatabase(validateDatabasePath(process.env, PROJECT_ROOT));
    return Response.json(listEmails(db, who.userId, parsed.query, { autoActionModes: readAutoActionModes(db, who.userId) }), { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ error: "emails_unavailable" }, { status: 500 });
  } finally {
    db?.close();
  }
}
