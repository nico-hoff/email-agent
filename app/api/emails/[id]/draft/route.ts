import { hasModelKey, resolveAgent } from "../../../../../packages/core/src/agent-registry.ts";
import { validateDatabasePath } from "../../../../../packages/core/src/accounts.ts";
import { createMutationLimiter, defaultAuthContext } from "../../../../../packages/core/src/auth-runtime.ts";
import { PROJECT_ROOT } from "../../../../../packages/core/src/constants.ts";
import { openDatabase } from "../../../../../packages/core/src/db.ts";
import type { DraftAgent } from "../../../../../packages/core/src/draft-reply.ts";
import { defaultPortFactory, handleDraft } from "../../../../../packages/core/src/draft-route.ts";

// Strict budget: every call is a model run plus an IMAP refetch (10 per 10 minutes and identity).
const limiter = createMutationLimiter(undefined, 10);

// Veryfront passes the route params as the second argument (Context7 /websites/veryfront, api-routes).
export async function POST(request: Request, context: { params: Record<string, string> | Promise<Record<string, string>> }): Promise<Response> {
  const params = await context.params;
  return handleDraft(request, params.id, {
    auth: defaultAuthContext(),
    limiter,
    openDb: () => openDatabase(validateDatabasePath(process.env, PROJECT_ROOT)),
    portFactory: defaultPortFactory(),
    agent: () => (hasModelKey() ? resolveAgent<DraftAgent>("replyDrafter") : undefined),
  });
}
