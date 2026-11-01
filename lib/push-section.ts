// State of the profile section "Benachrichtigungen" (R6), derived from what the browser and the server report. Pure.
import type { PushConfigInfo, PushDevice, PushSupport } from "./push-client.ts";

export type PushSectionState =
  | "loading"            // config not loaded yet
  | "server_unavailable" // the server has no (valid) VAPID keys
  | "unsupported"        // browser without Push/Notification/ServiceWorker
  | "needs_install"      // iOS Safari tab: the PWA must be on the home screen and opened from there
  | "permission_denied"  // the person (or the system) blocked notifications
  | "off"                // can be switched on with a tap
  | "on";                // this device is subscribed

export interface PushStateInput {
  config: PushConfigInfo | null;
  support: PushSupport;
  permission: "default" | "granted" | "denied";
  /** This browser holds a push subscription. */
  subscribed: boolean;
}

export function pushSectionState(i: PushStateInput): PushSectionState {
  if (i.config === null) return "loading";
  if (!i.config.available) return "server_unavailable";
  if (i.support === "needs_install") return "needs_install";
  if (i.support === "unsupported") return "unsupported";
  if (i.subscribed && i.permission === "granted") return "on";
  if (i.permission === "denied") return "permission_denied";
  return "off";
}

export const REASON_TEXT: ReadonlyMap<string, string> = new Map([
  ["vapid_invalid", "Die Push-Schlüssel auf dem Server sind ungültig."],
  ["vapid_subject_missing", "Auf dem Server fehlt die Kontaktadresse für Push (VAPID_SUBJECT)."],
]);

/** One line per device for the list: "iOS Safari". The family is a coarse browser name, never a user agent string. */
export const kindsSummary = (d: PushDevice): string => {
  const on = [d.kinds.important_mail ? "wichtige Mail" : null, d.kinds.briefing_ready ? "Briefing bereit" : null].filter((x): x is string => x !== null);
  return on.length === 0 ? "keine Benachrichtigungsart an" : on.join(", ");
};
