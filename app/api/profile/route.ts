import { defaultProfileDeps, handleProfileGet } from "../../../lib/profile-api.ts";

// Who is signed in (email, role, live sessions). Users mode only has an account; the other modes answer managed:false.
export function GET(request: Request): Response {
  return handleProfileGet(request, defaultProfileDeps());
}
