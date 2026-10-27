import { defaultAuthContext, defaultMutationLimiter } from "../../../../../lib/auth-runtime.ts";
import { validateDatabasePath } from "../../../../../lib/accounts.ts";
import { PROJECT_ROOT } from "../../../../../lib/constants.ts";
import { openDatabase } from "../../../../../lib/db.ts";
import { defaultMailboxActions, handleUnread } from "../../../../../lib/email-unread.ts";

// Veryfront passes the route params as the second argument (Context7 /websites/veryfront, api-routes).
export async function POST(request: Request, context: { params: Record<string, string> | Promise<Record<string, string>> }): Promise<Response> {
  const params = await context.params;
  return handleUnread(request, params.id, {
    auth: defaultAuthContext(),
    limiter: defaultMutationLimiter(),
    openDb: () => openDatabase(validateDatabasePath(process.env, PROJECT_ROOT)),
    actions: (db) => defaultMailboxActions(db),
  });
}
