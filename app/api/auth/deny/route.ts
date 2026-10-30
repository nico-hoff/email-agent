import { handleDeny } from "../../../../lib/auth-runtime.ts";

// Target of the request interceptor for denied requests (see interceptRequest). The answer depends only on ?k=.
const deny = (request: Request): Response => handleDeny(request);
export const GET = deny;
export const POST = deny;
export const PUT = deny;
export const PATCH = deny;
export const DELETE = deny;
export const HEAD = deny;
export const OPTIONS = deny;
