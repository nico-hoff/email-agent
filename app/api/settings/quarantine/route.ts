import { defaultSettingsDeps, handleQuarantineSettings } from "../../../../packages/core/src/settings-api.ts";

// POST: Spam in Quarantäne (aus, Trockenlauf, an), Aufräumen nach X Tagen, YOLO for one own account; an and YOLO need confirm:true.
export function POST(request: Request): Promise<Response> {
  return handleQuarantineSettings(request, defaultSettingsDeps());
}
