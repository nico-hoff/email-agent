// Browser side of the profile settings (R3). Types are repeated on purpose: the server modules use node:sqlite and must not be
// bundled into the browser. Only switches, counts, ids and short codes travel here; nothing from a mail.
import { commonReason, postApi, readJson, type CommonReason } from "./api-post.ts";
import type { MutationDeps } from "./mutate-client.ts";

export type SpamSeenMode = "off" | "dry_run" | "live";

export interface QuarantineSettings {
  mode: SpamSeenMode;
  /** Cleanup after this many days (1 to 90): Quarantäne -> Papierkorb. */
  days: number;
  /** Spam goes straight to the trash, skipping the quarantine. */
  yolo: boolean;
}

export interface SettingsAccount {
  id: string;
  label: string;
  color: string;
  enabled: boolean;
  /** false = no stored credentials (demo data): the mode cannot be set here. */
  managed: boolean;
  spam_seen_mode: SpamSeenMode | null;
  actions_24h: number;
  /** null = no stored credentials (demo data). */
  quarantine: QuarantineSettings | null;
}

export interface ModelOption {
  id: string;
  label: string;
  description: string;
  selectable: boolean;
  relative_cost: number;
  /** USD per 1 000 mails (static, docs/insights-models.md). */
  usd_per_1000: number;
}

export type ClassifierData = { permitted: false } | { permitted: true; model: string; models: ModelOption[] };

export interface Member { id: number; email: string | null; role: string; status: string; classifier_choice: boolean }

export interface StopData { user_stopped_at: string | null; global_active: boolean; can_toggle_global: boolean }

export interface SettingsData {
  stop: StopData;
  daily_limit: number;
  accounts: SettingsAccount[];
  classifier: ClassifierData;
  /** Admins only. */
  members: Member[] | null;
  synthetic: boolean;
}

export type SettingsReason = CommonReason | "confirmation_required" | "invalid_body" | "invalid_model" | "not_calibrated" | "not_managed" | "quarantine_off" | "invalid_days";

export const SETTINGS_ERROR_TEXT: Record<SettingsReason, string> = {
  rate_limited: "Zu viele Aktionen. Bitte kurz warten.",
  forbidden: "Dafür fehlt die Berechtigung oder die Anmeldung. Bitte die App neu öffnen.",
  not_found: "Das gibt es nicht mehr.",
  failed: "Das hat nicht geklappt. Bitte später erneut versuchen.",
  confirmation_required: "Bitte erst bestätigen.",
  invalid_body: "Ungültige Eingabe.",
  invalid_model: "Dieses Modell gibt es nicht.",
  not_calibrated: "Dieses Modell ist noch nicht kalibriert und lässt sich nicht wählen.",
  not_managed: "Dieses Konto hat keine gespeicherten Zugangsdaten. Hier lässt sich nichts einstellen.",
  quarantine_off: "YOLO gibt es nur, wenn „Spam in Quarantäne verschieben“ nicht aus ist.",
  invalid_days: "Die Frist muss zwischen 1 und 90 Tagen liegen.",
};

const KNOWN: ReadonlySet<string> = new Set(Object.keys(SETTINGS_ERROR_TEXT));
const asReason = (v: unknown): SettingsReason => (typeof v === "string" && KNOWN.has(v) ? (v as SettingsReason) : "failed");
const isMode = (v: unknown): v is SpamSeenMode => v === "off" || v === "dry_run" || v === "live";

function map(v: unknown): Map<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? new Map(Object.entries(v)) : null;
}
const str = (m: Map<string, unknown>, k: string): string | null => (typeof m.get(k) === "string" ? (m.get(k) as string) : null);

function parseQuarantine(raw: unknown): QuarantineSettings | null {
  const m = map(raw);
  if (!m) return null;
  const mode = m.get("mode");
  const days = m.get("days");
  if (!isMode(mode) || typeof days !== "number") return null;
  return { mode, days, yolo: m.get("yolo") === true };
}

function parseAccount(raw: unknown): SettingsAccount | null {
  const m = map(raw);
  if (!m) return null;
  const id = str(m, "id");
  const label = str(m, "label");
  if (id === null || label === null) return null;
  const mode = m.get("spam_seen_mode");
  const n = m.get("actions_24h");
  return {
    id, label, color: str(m, "color") ?? "#3b82f6", enabled: m.get("enabled") === true, managed: m.get("managed") === true,
    spam_seen_mode: isMode(mode) ? mode : null, actions_24h: typeof n === "number" ? n : 0, quarantine: parseQuarantine(m.get("quarantine")),
  };
}

function parseStop(raw: unknown): StopData {
  const m = map(raw) ?? new Map<string, unknown>();
  return { user_stopped_at: str(m, "user_stopped_at"), global_active: m.get("global_active") === true, can_toggle_global: m.get("can_toggle_global") === true };
}

function parseClassifier(raw: unknown): ClassifierData {
  const m = map(raw);
  if (!m || m.get("permitted") !== true) return { permitted: false };
  const list = Array.isArray(m.get("models")) ? (m.get("models") as unknown[]) : [];
  const models: ModelOption[] = [];
  for (const x of list) {
    const o = map(x);
    if (!o) continue;
    const id = str(o, "id");
    const label = str(o, "label");
    const rel = o.get("relative_cost");
    const usd = o.get("usd_per_1000");
    if (id === null || label === null) continue;
    models.push({ id, label, description: str(o, "description") ?? "", selectable: o.get("selectable") === true, relative_cost: typeof rel === "number" ? rel : 1, usd_per_1000: typeof usd === "number" ? usd : 0 });
  }
  return { permitted: true, model: str(m, "model") ?? "", models };
}

function parseMembers(raw: unknown): Member[] | null {
  if (!Array.isArray(raw)) return null;
  const out: Member[] = [];
  for (const x of raw) {
    const o = map(x);
    const id = o?.get("id");
    if (!o || typeof id !== "number") continue;
    out.push({ id, email: str(o, "email"), role: str(o, "role") ?? "user", status: str(o, "status") ?? "active", classifier_choice: o.get("classifier_choice") === true });
  }
  return out;
}

export async function fetchSettings(fetcher: typeof fetch): Promise<SettingsData> {
  const r = await fetcher("/api/settings", { cache: "no-store" });
  if (r.status === 401 || r.status === 403) throw new Error("session");
  if (!r.ok) throw new Error("unavailable");
  const b = await readJson(r);
  return {
    stop: parseStop(b.stop),
    daily_limit: typeof b.daily_limit === "number" ? b.daily_limit : 200,
    accounts: (Array.isArray(b.accounts) ? b.accounts : []).map(parseAccount).filter((a): a is SettingsAccount => a !== null),
    classifier: parseClassifier(b.classifier),
    members: parseMembers(b.members),
    synthetic: b.synthetic === true,
  };
}

export type SettingsResult = { ok: true } | { ok: false; reason: SettingsReason; retryAfterSeconds?: number };

async function post(path: string, body: unknown, deps: MutationDeps): Promise<SettingsResult> {
  const raw = await postApi(path, deps, { body });
  if (raw.kind === "forbidden") return { ok: false, reason: "forbidden" };
  if (raw.kind === "failed") return { ok: false, reason: "failed" };
  const r = raw.response;
  const common = commonReason(r);
  // 403 on the settings routes can also mean "missing permission"; the text covers both.
  if (common) return { ok: false, reason: common.reason, ...(common.retryAfterSeconds !== undefined ? { retryAfterSeconds: common.retryAfterSeconds } : {}) };
  if (!r.ok) return { ok: false, reason: asReason((await readJson(r)).error) };
  return { ok: true };
}

/** `confirm` is only sent for `live`, and only by the caller after the person confirmed the dialog. */
export const postSpamSeenMode = (accountId: string, mode: SpamSeenMode, confirmed: boolean, deps: MutationDeps): Promise<SettingsResult> =>
  post("/api/settings/spam-seen", { account_id: accountId, mode, ...(mode === "live" && confirmed ? { confirm: true } : {}) }, deps);

export type QuarantineChange = { mode: SpamSeenMode } | { days: number } | { yolo: boolean };

/** `confirm` is only sent for `live` and for YOLO on, and only by the caller after the person confirmed the dialog. */
export const postQuarantine = (accountId: string, change: QuarantineChange, confirmed: boolean, deps: MutationDeps): Promise<SettingsResult> => {
  const risky = ("mode" in change && change.mode === "live") || ("yolo" in change && change.yolo);
  return post("/api/settings/quarantine", { account_id: accountId, ...change, ...(risky && confirmed ? { confirm: true } : {}) }, deps);
};

export const postUserStop = (stopped: boolean, deps: MutationDeps): Promise<SettingsResult> =>
  post("/api/settings/stop", { scope: "user", stopped }, deps);

export const postGlobalStop = (stopped: boolean, deps: MutationDeps): Promise<SettingsResult> =>
  post("/api/settings/stop", { scope: "global", stopped, confirm: true }, deps);

export const postClassifierModel = (model: string, deps: MutationDeps): Promise<SettingsResult> =>
  post("/api/settings/classifier", { model }, deps);

export const postClassifierChoice = (userId: number, granted: boolean, deps: MutationDeps): Promise<SettingsResult> =>
  post("/api/settings/permissions", { user_id: userId, classifier_choice: granted }, deps);

export const MODE_LABEL: Record<SpamSeenMode, string> = { off: "Aus", dry_run: "Trockenlauf", live: "An" };

export function modeSummary(mode: SpamSeenMode | null): string {
  if (mode === "live") return "Spam wird auf dem Server als gelesen markiert.";
  if (mode === "dry_run") return "Trockenlauf: die App zeigt nur, was sie markieren würde. Auf dem Server ändert sich nichts.";
  if (mode === "off") return "Aus: nichts wird markiert oder vorgemerkt.";
  return "";
}

const usd = (n: number): string => n.toLocaleString("de-DE", { minimumFractionDigits: 3, maximumFractionDigits: 3 });

/** Relative price per 1 000 mails in words, from the static numbers (docs/insights-models.md, synthetic measurement). */
export function costText(m: Pick<ModelOption, "relative_cost" | "usd_per_1000">): string {
  const base = `${usd(m.usd_per_1000)} USD je 1 000 Mails`;
  if (m.relative_cost <= 1) return `Preis: Referenz (${base})`;
  return `Preis: ca. ${m.relative_cost.toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}-mal so hoch wie Jev (${base})`;
}

export function quarantineSummary(q: QuarantineSettings): string {
  if (q.mode === "off") return "Aus: Spam bleibt im Posteingang.";
  const where = q.yolo ? "direkt in den Papierkorb" : "in den Ordner „Quarantäne“";
  if (q.mode === "dry_run") return `Trockenlauf: die App zeigt nur, welchen Spam sie ${where} verschieben würde. Auf dem Server ändert sich nichts.`;
  return q.yolo
    ? "Spam wird sofort in den Papierkorb deines Anbieters verschoben, ohne Quarantäne."
    : `Spam wird in den Ordner „Quarantäne“ verschoben und nach ${q.days} ${q.days === 1 ? "Tag" : "Tagen"} in den Papierkorb.`;
}
