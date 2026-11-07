import { defaultAuthContext, defaultMutationLimiter } from "../../../../../packages/core/src/auth-runtime.ts";
import { validateDatabasePath } from "../../../../../packages/core/src/accounts.ts";
import { PROJECT_ROOT } from "../../../../../packages/core/src/constants.ts";
import { openDatabase } from "../../../../../packages/core/src/db.ts";
import { handleActionUndo } from "../../../../../packages/core/src/action-undo.ts";
import { defaultMailboxActions } from "../../../../../packages/core/src/email-unread.ts";

// Veryfront passes the route params as the second argument (Context7 /websites/veryfront, api-routes).
export async function POST(request: Request, context: { params: Record<string, string> | Promise<Record<string, string>> }): Promise<Response> {
  const params = await context.params;
  return handleActionUndo(request, params.id, {
    auth: defaultAuthContext(),
    limiter: defaultMutationLimiter(),
    openDb: () => openDatabase(validateDatabasePath(process.env, PROJECT_ROOT)),
    actions: (db) => defaultMailboxActions(db),
  });
}
