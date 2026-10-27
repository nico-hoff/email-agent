import type { MiddlewareHandler } from "veryfront/middleware";
import { defaultAuthContext, guardRequest } from "./lib/auth-runtime.ts";

// D16/O2a: every page and API route needs a valid session cookie, except health, the welcome screen, the auth
// routes (they check the tailnet identity themselves) and static assets (see isPublicPath).
const requireSession: MiddlewareHandler = async (c, next) => {
  const denied = guardRequest(c.request, defaultAuthContext());
  return denied ?? next();
};

export default requireSession;
