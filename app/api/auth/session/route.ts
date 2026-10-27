import { defaultAuthContext, handleSession } from "../../../../lib/auth-runtime.ts";

export function GET(request: Request): Response {
  return handleSession(request, defaultAuthContext());
}
