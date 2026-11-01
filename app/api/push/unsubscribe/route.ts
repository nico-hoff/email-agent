import { defaultPushDeps, handlePushUnsubscribe } from "../../../../lib/push-api.ts";

// POST { endpoint } or { id }: removes one of the caller's devices.
export function POST(request: Request): Promise<Response> {
  return handlePushUnsubscribe(request, defaultPushDeps());
}
