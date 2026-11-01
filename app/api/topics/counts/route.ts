import { defaultTopicsDeps, handleTopicCounts } from "../../../../lib/topics-api.ts";

// GET ?account=<id>: mails per topic (latest classification) for the folder view. Counts only, no mail data.
export function GET(request: Request): Response {
  return handleTopicCounts(request, defaultTopicsDeps());
}
