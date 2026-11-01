import { defaultSettingsDeps, handleSpamSeenMode } from "../../../../lib/settings-api.ts";

// POST: mode of Spam als gelesen markieren (aus, Trockenlauf, an) for one own account; an needs confirm:true.
export function POST(request: Request): Promise<Response> {
  return handleSpamSeenMode(request, defaultSettingsDeps());
}
