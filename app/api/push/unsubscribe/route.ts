import { defaultPushDeps, handlePushUnsubscribe } from "../../../../packages/core/src/push-api.ts";

// POST { endpoint } or { id }: removes one of the caller's devices.
export function POST(request: Request): Promise<Response> {
  return handlePushUnsubscribe(request, defaultPushDeps());
}
