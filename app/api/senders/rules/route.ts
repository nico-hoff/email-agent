import { defaultApiDeps, handleRulesCreate, handleRulesList } from "../../../../lib/senders-api.ts";

// GET: active rules (?include_inactive=1 for all). POST { match, value, kind, account_id? }: permanent rule by Nico.
export function GET(request: Request): Response {
  return handleRulesList(request, defaultApiDeps());
}

export function POST(request: Request): Promise<Response> {
  return handleRulesCreate(request, defaultApiDeps());
}
