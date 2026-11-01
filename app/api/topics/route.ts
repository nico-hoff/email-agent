import { defaultTopicsDeps, handleTopicsGet, handleTopicsPost } from "../../../lib/topics-api.ts";

// GET: the user's topics (12 fixed + own custom topics), the switch `topics_enabled` and the limits.
// POST { action: "create" | "update" | "set_active" | "set_enabled", ... }: change custom topics or the switch.
export function GET(request: Request): Response {
  return handleTopicsGet(request, defaultTopicsDeps());
}

export function POST(request: Request): Promise<Response> {
  return handleTopicsPost(request, defaultTopicsDeps());
}
