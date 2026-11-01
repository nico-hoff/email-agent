import { defaultPushDeps, handlePushSubscribe } from "../../../../lib/push-api.ts";

// POST PushSubscription.toJSON() (+ optional kinds): registers or refreshes this device.
export function POST(request: Request): Promise<Response> {
  return handlePushSubscribe(request, defaultPushDeps());
}
