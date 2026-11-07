import { defaultApiDeps, handleHitlDismiss } from "../../../../../packages/core/src/senders-api.ts";

// POST { match, value }: "not now". The question returns only after further spam verdicts.
export function POST(request: Request): Promise<Response> {
  return handleHitlDismiss(request, defaultApiDeps());
}
