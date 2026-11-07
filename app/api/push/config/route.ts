import { defaultPushDeps, handlePushConfig } from "../../../../packages/core/src/push-api.ts";

// Is push available (VAPID configured) and the public VAPID key for PushManager.subscribe().
export function GET(request: Request): Response {
  return handlePushConfig(request, defaultPushDeps());
}
