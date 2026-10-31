import { appPasswordStatus, selectAuthMode } from "./auth.ts";

/**
 * Start guard for fly.io: fly sets FLY_APP_NAME on every Machine (https://docs.fly.io/reference/runtime-environment).
 * There the app is public, and the Tailscale header must never be trusted. Anyone could set it. So on fly the server
 * only starts in password mode with a usable APP_PASSWORD; otherwise nobody could sign in safely and it refuses to
 * start (the deploy then fails its health check visibly). Outside fly (local, Compose behind Tailscale) nothing is
 * required. The message never contains a value.
 */
export class FlyAuthMissingError extends Error {
  constructor(reason: "unset" | "too_short") {
    super(`FLY_APP_NAME is set but APP_PASSWORD is ${reason === "unset" ? "missing" : "empty or too short"}: refusing to start outside password mode (fly secrets set APP_PASSWORD=<at least 16 characters>)`);
    this.name = "FlyAuthMissingError";
  }
}

export function assertFlyAuthConfigured(env: Record<string, string | undefined>): void {
  if ((env.FLY_APP_NAME ?? "").trim() === "") return;
  const mode = selectAuthMode({ synthetic: false, appPassword: env.APP_PASSWORD });
  if (mode !== "password") throw new FlyAuthMissingError("unset");
  if (appPasswordStatus(env.APP_PASSWORD) !== "ok") throw new FlyAuthMissingError("too_short");
}
