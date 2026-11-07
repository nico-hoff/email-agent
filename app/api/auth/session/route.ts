import { defaultAuthContext, handleSession } from "../../../../packages/core/src/auth-runtime.ts";

export function GET(request: Request): Response {
  return handleSession(request, defaultAuthContext());
}
