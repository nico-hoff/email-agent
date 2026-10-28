import { hasModelKey, resolveAgent } from "../../../../../lib/agent-registry.ts";
import { validateDatabasePath } from "../../../../../lib/accounts.ts";
import { createMutationLimiter, defaultAuthContext } from "../../../../../lib/auth-runtime.ts";
import { PROJECT_ROOT } from "../../../../../lib/constants.ts";
import { openDatabase } from "../../../../../lib/db.ts";
import type { DraftAgent } from "../../../../../lib/draft-reply.ts";
import { defaultPortFactory, handleDraft } from "../../../../../lib/draft-route.ts";

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
