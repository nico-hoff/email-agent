import { resolveAgent, hasModelKey } from "../../../lib/agent-registry.ts";
import { validateDatabasePath } from "../../../lib/accounts.ts";
import { defaultAuthContext, createMutationLimiter } from "../../../lib/auth-runtime.ts";
import { createBriefingCache, handleBriefing, type BriefingAgent } from "../../../lib/briefing.ts";
import { PROJECT_ROOT } from "../../../lib/constants.ts";
import { openDatabase } from "../../../lib/db.ts";

// POST only: streams the briefing as Server-Sent Events (event types meta, delta, error, done; docs/agent-contract.md).
// Opening the app is cheap to repeat (5-minute cache), but each call can cost a model run, so the budget is small.
const limiter = createMutationLimiter(undefined, 30);
const cache = createBriefingCache();

export function POST(request: Request): Promise<Response> {
  return handleBriefing(request, {
    auth: defaultAuthContext(),
    limiter,
    cache,
    openDb: () => openDatabase(validateDatabasePath(process.env, PROJECT_ROOT)),
    agent: () => (hasModelKey() ? resolveAgent<BriefingAgent>("briefing") : undefined),
  });
}
