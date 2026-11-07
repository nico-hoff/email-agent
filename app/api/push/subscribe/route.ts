import { defaultPushDeps, handlePushSubscribe } from "../../../../packages/core/src/push-api.ts";

// POST PushSubscription.toJSON() (+ optional kinds): registers or refreshes this device.
export function POST(request: Request): Promise<Response> {
  return handlePushSubscribe(request, defaultPushDeps());
}
