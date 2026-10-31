import { defaultProfileDeps, handleInviteCreate, handleInvitesList } from "../../../lib/profile-api.ts";

// Admin only. GET: open invitations (no codes). POST { role?, days? }: creates one; the code is returned once.
export function GET(request: Request): Response {
  return handleInvitesList(request, defaultProfileDeps());
}

export function POST(request: Request): Promise<Response> {
  return handleInviteCreate(request, defaultProfileDeps());
}
