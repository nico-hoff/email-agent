import { resolveAgent, hasModelKey } from "../../../packages/core/src/agent-registry.ts";
import { validateDatabasePath } from "../../../packages/core/src/accounts.ts";
import { defaultAuthContext, createMutationLimiter } from "../../../packages/core/src/auth-runtime.ts";
import { createBriefingCache, handleBriefing, type BriefingAgent } from "../../../packages/core/src/briefing.ts";
import { PROJECT_ROOT } from "../../../packages/core/src/constants.ts";
import { openDatabase } from "../../../packages/core/src/db.ts";

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
