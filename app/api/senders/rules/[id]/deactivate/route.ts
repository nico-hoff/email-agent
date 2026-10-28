import { defaultApiDeps, handleRuleDeactivate } from "../../../../../../lib/senders-api.ts";

// POST: switches the rule off (the row is kept).
export async function POST(request: Request, context: { params: Record<string, string> | Promise<Record<string, string>> }): Promise<Response> {
  const params = await context.params;
  return handleRuleDeactivate(request, params.id, defaultApiDeps());
}
