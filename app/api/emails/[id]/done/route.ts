import { defaultAuthContext, defaultMutationLimiter } from "../../../../../lib/auth-runtime.ts";
import { validateDatabasePath } from "../../../../../lib/accounts.ts";
import { PROJECT_ROOT } from "../../../../../lib/constants.ts";
import { openDatabase } from "../../../../../lib/db.ts";
import { handleSetDone } from "../../../../../lib/email-done.ts";

// Veryfront passes the route params as the second argument (Context7 /websites/veryfront, api-routes).
export async function POST(request: Request, context: { params: Record<string, string> | Promise<Record<string, string>> }): Promise<Response> {
  const params = await context.params;
  return handleSetDone(request, params.id, true, {
    auth: defaultAuthContext(),
    limiter: defaultMutationLimiter(),
    openDb: () => openDatabase(validateDatabasePath(process.env, PROJECT_ROOT)),
  });
}
