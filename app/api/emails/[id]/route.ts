import { defaultAuthContext, requireUser } from "../../../../lib/auth-runtime.ts";
import { openDatabase } from "../../../../lib/db.ts";
import { validateDatabasePath } from "../../../../lib/accounts.ts";
import { PROJECT_ROOT } from "../../../../lib/constants.ts";
import { getEmailDetail } from "../../../../lib/email-api.ts";
import { parseEmailId } from "../../../../lib/email-status.ts";

// Veryfront passes the route params as the second argument (Context7 /websites/veryfront, api-routes).
export async function GET(request: Request, context: { params: Record<string, string> | Promise<Record<string, string>> }): Promise<Response> {
  const who = requireUser(request, defaultAuthContext());
  if (!who.ok) return who.response;
  const params = await context.params;
  const id = parseEmailId(params.id);
  if (id === null) return Response.json({ error: "not_found" }, { status: 404 });

  let db;
  try {
    db = openDatabase(validateDatabasePath(process.env, PROJECT_ROOT));
    const detail = getEmailDetail(db, who.userId, id);
    if (detail === null) return Response.json({ error: "not_found" }, { status: 404 });
    return Response.json(detail, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ error: "email_unavailable" }, { status: 500 });
  } finally {
    db?.close();
  }
}
