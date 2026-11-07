import { defaultApiDeps, handleHitlList } from "../../../../packages/core/src/senders-api.ts";

// Senders Jev judged as spam at least three times and Nico has not decided on yet (E7/E8).
export function GET(request: Request): Response {
  return handleHitlList(request, defaultApiDeps());
}
