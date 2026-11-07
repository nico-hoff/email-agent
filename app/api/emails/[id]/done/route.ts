import { defaultAuthContext, defaultMutationLimiter } from "../../../../../packages/core/src/auth-runtime.ts";
import { validateDatabasePath } from "../../../../../packages/core/src/accounts.ts";
import { PROJECT_ROOT } from "../../../../../packages/core/src/constants.ts";
import { openDatabase } from "../../../../../packages/core/src/db.ts";
import { handleSetDone } from "../../../../../packages/core/src/email-done.ts";

// Veryfront passes the route params as the second argument (Context7 /websites/veryfront, api-routes).
export async function POST(request: Request, context: { params: Record<string, string> | Promise<Record<string, string>> }): Promise<Response> {
  const params = await context.params;
  return handleSetDone(request, params.id, true, {
    auth: defaultAuthContext(),
    limiter: defaultMutationLimiter(),
    openDb: () => openDatabase(validateDatabasePath(process.env, PROJECT_ROOT)),
  });
}
