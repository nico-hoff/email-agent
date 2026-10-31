import { defaultAuthContext, defaultUsersLimits, handleRegister } from "../../../../lib/auth-runtime.ts";

// Users mode only: registration with an invitation code ({ code, email, password }). There is no open registration.
export function POST(request: Request): Promise<Response> {
  return handleRegister(request, defaultAuthContext(), defaultUsersLimits());
}
