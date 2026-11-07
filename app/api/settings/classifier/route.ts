import { defaultSettingsDeps, handleClassifierModel } from "../../../../packages/core/src/settings-api.ts";

// POST: the classifier model of the user (needs the permission classifier_choice).
export function POST(request: Request): Promise<Response> {
  return handleClassifierModel(request, defaultSettingsDeps());
}
