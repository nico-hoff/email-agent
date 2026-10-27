import { defaultAuthContext, defaultLoginLimiter, handleLogin } from "../../../../lib/auth-runtime.ts";

export function POST(request: Request): Response {
  return handleLogin(request, defaultAuthContext(), defaultLoginLimiter());
}
