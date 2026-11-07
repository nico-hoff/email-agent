import { defaultAuthContext, handleLogout } from "../../../../packages/core/src/auth-runtime.ts";

export function POST(request: Request): Response {
  return handleLogout(request, defaultAuthContext());
}
