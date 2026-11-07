import { defaultPushDeps, handlePushList } from "../../../../packages/core/src/push-api.ts";

// The caller's own push devices: id, browser family, times, kinds. Never an endpoint or a key.
export function GET(request: Request): Promise<Response> | Response {
  return handlePushList(request, defaultPushDeps());
}
