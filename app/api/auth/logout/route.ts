import { defaultAuthContext, handleLogout } from "../../../../lib/auth-runtime.ts";

export function POST(request: Request): Response {
  return handleLogout(request, defaultAuthContext());
}
