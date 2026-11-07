import { defaultPushDeps, handlePushTest } from "../../../../packages/core/src/push-api.ts";

// Sends a test notification to the caller's own devices.
export function POST(request: Request): Promise<Response> {
  return handlePushTest(request, defaultPushDeps());
}
