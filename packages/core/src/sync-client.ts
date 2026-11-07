// Browser side of the initial import (ADR 0043): the shape of GET /api/accounts/:id/sync, the stages of the live card and
// the texts. Types are repeated on purpose (server modules use node:sqlite and must not be bundled into the browser).
import { commonReason, postApi, readJson } from "./api-post.ts";
import type { MutationDeps } from "./mutate-client.ts";
import type { ApiEmail } from "./review-ui.ts";

export type SyncPhase = "queued" | "connecting" | "fetching" | "classifying" | "done" | "failed";
const PHASES: readonly string[] = ["queued", "connecting", "fetching", "classifying", "done", "failed"];

export interface SyncData {
  phase: SyncPhase;
  total: number;
  fetched: number;
  classified: number;
  failed: number;
  error_code: string | null;
  runs: number;
  started_at: string | null;
  updated_at: string;
  finished_at: string | null;
  feed: ApiEmail[];
}

/** Poll interval while an import is active (the card stops polling when it is done). */
export const SYNC_POLL_MS = 1500;
/** A finished import stays visible this long after it ended, even when the page did not see it running. */
export const SYNC_DONE_VISIBLE_MS = 30 * 60_000;

export const isActivePhase = (p: SyncPhase): boolean => p !== "done" && p !== "failed";

const num = (m: Map<string, unknown>, k: string): number => {
  const v = m.get(k);
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
};
const strOrNull = (m: Map<string, unknown>, k: string): string | null => {
  const v = m.get(k);
  return typeof v === "string" ? v : null;
};

export function parseSync(raw: unknown): SyncData | null {
  if (typeof raw !== "object" || raw === null) return null;
  const m = new Map(Object.entries(raw));
  const phase = m.get("phase");
  if (typeof phase !== "string" || !PHASES.includes(phase)) return null;
  const feed = m.get("feed");
  return {
    phase: phase as SyncPhase, total: num(m, "total"), fetched: num(m, "fetched"), classified: num(m, "classified"), failed: num(m, "failed"),
    error_code: strOrNull(m, "error_code"), runs: Math.max(1, num(m, "runs")), started_at: strOrNull(m, "started_at"),
    updated_at: strOrNull(m, "updated_at") ?? "", finished_at: strOrNull(m, "finished_at"),
    feed: Array.isArray(feed) ? (feed as ApiEmail[]) : [],
  };
}

/** null = no import for this account (demo data) or the account is gone. */
export async function fetchSync(fetcher: typeof fetch, accountId: string): Promise<SyncData | null> {
  const r = await fetcher(`/api/accounts/${encodeURIComponent(accountId)}/sync`, { cache: "no-store" });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("unavailable");
  const b = await readJson(r);
  return parseSync(b.sync);
}

export type RestartResult = { ok: true } | { ok: false; reason: "rate_limited" | "forbidden" | "not_restartable" | "failed"; retryAfterSeconds?: number };

export async function postSyncRestart(accountId: string, deps: MutationDeps): Promise<RestartResult> {
  const raw = await postApi(`/api/accounts/${encodeURIComponent(accountId)}/sync/restart`, deps);
  if (raw.kind === "forbidden") return { ok: false, reason: "forbidden" };
  if (raw.kind === "failed") return { ok: false, reason: "failed" };
  const r = raw.response;
  if (r.status === 409) return { ok: false, reason: "not_restartable" };
  const common = commonReason(r);
  if (common) {
    const reason = common.reason === "rate_limited" ? "rate_limited" : common.reason === "forbidden" ? "forbidden" : "failed";
    return { ok: false, reason, ...(common.retryAfterSeconds !== undefined ? { retryAfterSeconds: common.retryAfterSeconds } : {}) };
  }
  return r.ok ? { ok: true } : { ok: false, reason: "failed" };
}

export const RESTART_ERROR_TEXT: Record<"rate_limited" | "forbidden" | "not_restartable" | "failed", string> = {
  rate_limited: "Zu viele Neustarts. Bitte kurz warten.",
  forbidden: "Nicht angemeldet. Bitte die App neu öffnen.",
  not_restartable: "Der Import läuft gerade schon.",
  failed: "Das hat nicht geklappt. Bitte später erneut versuchen.",
};

// ---- stages ---------------------------------------------------------------------------------------------------------

export type StageState = "todo" | "active" | "done" | "failed";
export interface Stage {
  key: "connect" | "read" | "classify" | "done";
  label: string;
  state: StageState;
  /** Bar value and maximum; absent = no bar (connecting, finished). */
  value?: number;
  max?: number;
}

const pair = (a: number, b: number): string => `${a}/${b}`;

export function syncStages(s: SyncData): Stage[] {
  const total = s.total;
  const classifiedAll = s.classified + s.failed;
  const p = s.phase;
  const connect: Stage = { key: "connect", label: "Verbinde mit dem Postfach", state: "todo" };
  const read: Stage = { key: "read", label: total > 0 ? `Lese Mails (${pair(s.fetched, total)})` : "Lese Mails", state: "todo" };
  const classify: Stage = { key: "classify", label: total > 0 ? `System One klassifiziert (${pair(classifiedAll, total)})` : "System One klassifiziert", state: "todo" };
  const done: Stage = { key: "done", label: "Fertig", state: "todo" };
  if (total > 0) {
    read.value = s.fetched; read.max = total;
    classify.value = classifiedAll; classify.max = total;
  }
  switch (p) {
    case "queued":
    case "connecting":
      connect.state = "active";
      break;
    case "fetching":
      connect.state = "done"; read.state = "active";
      if (classifiedAll > 0) classify.state = "active";
      break;
    case "classifying":
      connect.state = "done"; read.state = "done"; classify.state = "active";
      break;
    case "done":
      connect.state = "done"; read.state = "done"; classify.state = "done"; done.state = "done";
      if (total > 0) { read.value = total; classify.value = total; }
      break;
    case "failed": {
      // The stage that was running when it stopped is the failed one; earlier ones count as done.
      const at = total === 0 ? "connect" : s.fetched < total ? "read" : "classify";
      const order: Stage["key"][] = ["connect", "read", "classify"];
      for (const st of [connect, read, classify]) {
        const i = order.indexOf(st.key as never);
        st.state = i < order.indexOf(at) ? "done" : i === order.indexOf(at) ? "failed" : "todo";
      }
      break;
    }
  }
  return [connect, read, classify, done];
}

export function syncHeadline(s: SyncData): string {
  switch (s.phase) {
    case "queued": return "Der Import startet gleich";
    case "connecting": return "Postfach wird verbunden";
    case "fetching": return "Mails werden gelesen";
    case "classifying": return "System One bewertet die Mails";
    case "done": return s.total === 0 ? "Nichts zu importieren" : "Erst-Import abgeschlossen";
    case "failed": return "Erst-Import angehalten";
  }
}

/** One calm sentence under the stages; null = nothing to add. */
export function syncNote(s: SyncData): string | null {
  const code = s.error_code;
  if (s.phase === "failed") {
    if (code === "imap_auth") return "Die Anmeldung wurde abgelehnt. Bitte das Passwort unter „Bearbeiten“ prüfen und den Import dann erneut starten.";
    return "Der Import konnte nicht abgeschlossen werden. Bereits gelesene Mails bleiben erhalten.";
  }
  if (code === "imap_error" && isActivePhase(s.phase)) return "Die Verbindung klappt gerade nicht. Ein neuer Versuch folgt automatisch.";
  if (s.phase === "queued") return "Das Konto wartet auf den Start des Hintergrunddienstes. Das dauert wenige Sekunden.";
  if (s.phase === "done") {
    if (code === "classify_timeout") return "System One braucht länger als erwartet. Der Rest wird im Hintergrund weiter bewertet.";
    if (code === "no_range") return "Der Posteingang konnte für den Import nicht gelesen werden. Neue Mails kommen trotzdem an.";
    if (s.total === 0) return "In den letzten 14 Tagen liegen keine Mails im Posteingang. Neue Mails kommen automatisch dazu.";
    const parts = [`${s.classified} von ${s.total} Mails bewertet`];
    if (s.failed > 0) parts.push(`${s.failed} nicht bewertbar`);
    return `${parts.join(", ")}. Die importierten Mails lösen keine automatischen Aktionen im Postfach aus.`;
  }
  if (s.phase === "classifying" || s.phase === "fetching") return "Es werden nur die neuesten Mails der letzten 14 Tage gelesen. Der Inhalt wird nicht gespeichert.";
  return null;
}

/** Should the card be shown? Active and failed always; a finished import while this page saw it run or shortly after. */
export function showSyncCard(s: SyncData | null | undefined, sawActive: boolean, now: number): boolean {
  if (!s) return false;
  if (s.phase === "failed" || isActivePhase(s.phase)) return true;
  if (sawActive) return true;
  const at = s.finished_at === null ? NaN : Date.parse(s.finished_at);
  return Number.isFinite(at) && now - at < SYNC_DONE_VISIBLE_MS;
}
