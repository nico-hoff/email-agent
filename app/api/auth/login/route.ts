import { defaultAuthContext, defaultLoginLimiter, handleLoginRequest } from "../../../../lib/auth-runtime.ts";

export function POST(request: Request): Response | Promise<Response> {
  const ctx = defaultAuthContext();
  return handleLoginRequest(request, ctx, defaultLoginLimiter(ctx.mode));
}
