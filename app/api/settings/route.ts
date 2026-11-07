import { defaultSettingsDeps, handleSettingsGet } from "../../../packages/core/src/settings-api.ts";

// GET: the profile settings of the signed-in user (automatic mailbox actions, emergency stop, classifier model).
export function GET(request: Request): Response {
  return handleSettingsGet(request, defaultSettingsDeps());
}
