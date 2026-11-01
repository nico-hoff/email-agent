import { defaultSettingsDeps, handlePermission } from "../../../../lib/settings-api.ts";

// POST: an admin grants or revokes classifier_choice.
export function POST(request: Request): Promise<Response> {
  return handlePermission(request, defaultSettingsDeps());
}
