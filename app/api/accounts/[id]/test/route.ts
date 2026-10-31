import { defaultAccountsDeps, handleAccountTest } from "../../../../../lib/accounts-api.ts";

// Veryfront passes the route params as the second argument (Context7 /websites/veryfront, api-routes).
type Ctx = { params: Record<string, string> | Promise<Record<string, string>> };

export async function POST(request: Request, context: Ctx): Promise<Response> {
  const params = await context.params;
  return handleAccountTest(request, params.id ?? "", defaultAccountsDeps());
}
