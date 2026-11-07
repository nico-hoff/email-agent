import { defaultAuthContext, defaultMutationLimiter, handleLogoutAll } from "../../../../packages/core/src/auth-runtime.ts";

// "Auf allen Geräten abmelden": revokes every session row of the signed-in user (users mode) and clears the cookie.
export function POST(request: Request): Response {
  return handleLogoutAll(request, defaultAuthContext(), defaultMutationLimiter());
}
