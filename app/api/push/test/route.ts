import { defaultPushDeps, handlePushTest } from "../../../../lib/push-api.ts";

// Sends a test notification to the caller's own devices.
export function POST(request: Request): Promise<Response> {
  return handlePushTest(request, defaultPushDeps());
}
