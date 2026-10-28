import { defaultApiDeps, handleFeedbackGet, handleFeedbackPost } from "../../../../../lib/senders-api.ts";

// POST { kind, value? }: Nico's feedback (T37). GET: the current answer per topic. App database only, never a mailbox.
export async function POST(request: Request, context: { params: Record<string, string> | Promise<Record<string, string>> }): Promise<Response> {
  const params = await context.params;
  return handleFeedbackPost(request, params.id, defaultApiDeps());
}

export async function GET(request: Request, context: { params: Record<string, string> | Promise<Record<string, string>> }): Promise<Response> {
  const params = await context.params;
  return handleFeedbackGet(params.id, defaultApiDeps());
}
