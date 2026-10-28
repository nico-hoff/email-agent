import { defaultApiDeps, handleHitlList } from "../../../../lib/senders-api.ts";

// Senders Jev judged as spam at least three times and Nico has not decided on yet (E7/E8).
export function GET(): Response {
  return handleHitlList(defaultApiDeps());
}
