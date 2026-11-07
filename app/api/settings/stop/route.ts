import { defaultSettingsDeps, handleStop } from "../../../../packages/core/src/settings-api.ts";

// POST: emergency stop of the user, or the global stop file for admins.
export function POST(request: Request): Promise<Response> {
  return handleStop(request, defaultSettingsDeps());
}
