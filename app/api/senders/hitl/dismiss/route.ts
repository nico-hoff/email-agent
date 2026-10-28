import { defaultApiDeps, handleHitlDismiss } from "../../../../../lib/senders-api.ts";

// POST { match, value }: "not now". The question returns only after further spam verdicts.
export function POST(request: Request): Promise<Response> {
  return handleHitlDismiss(request, defaultApiDeps());
}
