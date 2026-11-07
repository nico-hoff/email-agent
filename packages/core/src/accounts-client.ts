// Browser side of "Konten verwalten" (R2). Types are repeated on purpose: the server modules use node:sqlite and must not be
// bundled into the browser. A password only travels in the POST body of a create/update and is never kept in a list or state
// beyond the open form.
import { commonReason, postApi, readJson, type CommonReason } from "./api-post.ts";
import { defaultLabel, imapHostForEmail, isGoogleHost } from "./mail-provider-hints.ts";
import type { MutationDeps } from "./mutate-client.ts";

export type AccountType = "imap" | "google";
export type SpamSeenMode = "off" | "dry_run" | "live";

export interface AccountItem {
  id: string;
  managed: boolean;
  type: AccountType | null;
  label: string;
  color: string;
  host: string;
  port: number;
  tls: boolean | null;
  username: string | null;
  mailbox: string;
  spam_mailbox: string | null;
  enabled: boolean;
  context: string;
  secret_set: boolean;
  secret_set_at: string | null;
  last_test_at: string | null;
  last_test_code: string | null;
  worker: { state: string; error_code: string | null; last_poll_at: string | null } | null;
}

export interface AccountsData { accounts: AccountItem[]; encryptionReady: boolean; synthetic: boolean }

export const GOOGLE_DEFAULTS = { host: "imap.gmail.com", port: 993, tls: true, mailbox: "INBOX", spam_mailbox: "[Gmail]/Spam" } as const;
export const COLOR_CHOICES: readonly string[] = ["#3b82f6", "#f97316", "#10b981", "#a855f7", "#ec4899", "#eab308", "#06b6d4", "#ef4444"];

export interface AccountForm {
  /** What the person types first; the username, the label and the server follow it until they are edited by hand. */
  email: string;
  label: string;
  color: string | null;
  host: string;
  port: string;
  tls: boolean;
  username: string;
  /** Never prefilled. Empty on edit = keep the stored password. */
  password: string;
  mailbox: string;
  /** Empty = detected during "Verbindung testen" (special-use \Junk). */
  spam_mailbox: string;
  context: string;
  /** Fields edited by hand are no longer derived from the e-mail address. */
  touched: { label: boolean; username: boolean; host: boolean };
}

export function emptyForm(): AccountForm {
  return {
    email: "", label: "", color: null, host: "", port: "993", tls: true, username: "", password: "", mailbox: "INBOX", spam_mailbox: "", context: "",
    touched: { label: false, username: false, host: false },
  };
}

export function formFromItem(a: AccountItem): AccountForm {
  return {
    email: a.username ?? "", label: a.label, color: a.color, host: a.host, port: String(a.port), tls: a.tls ?? true, username: a.username ?? "",
    password: "", mailbox: a.mailbox, spam_mailbox: a.spam_mailbox ?? "", context: a.context,
    touched: { label: true, username: true, host: true },
  };
}

/** Applies a field change and re-derives username, label and server from the address while those are untouched. */
export function applyPatch(f: AccountForm, patch: Partial<Omit<AccountForm, "touched">>): AccountForm {
  const next: AccountForm = { ...f, ...patch, touched: { ...f.touched } };
  if (patch.label !== undefined) next.touched.label = true;
  if (patch.username !== undefined) next.touched.username = true;
  if (patch.host !== undefined) next.touched.host = true;
  if (patch.email !== undefined) {
    const e = patch.email.trim();
    if (!next.touched.username) next.username = e;
    if (!next.touched.label) next.label = defaultLabel(e);
    if (!next.touched.host) next.host = imapHostForEmail(e) ?? "";
  }
  return next;
}

/** Gmail addresses (server imap.gmail.com) are the "Google" type: presets on the server plus the app-password hint. */
export const formType = (f: Pick<AccountForm, "host">): AccountType => (isGoogleHost(f.host) ? "google" : "imap");

export type AccountsReason = CommonReason | "no_encryption_key" | "invalid_host" | "host_not_allowed" | "invalid_secret" | "invalid_body" | "not_managed" | "secret_unreadable";

export const ACCOUNTS_ERROR_TEXT: Record<AccountsReason, string> = {
  rate_limited: "Zu viele Aktionen. Bitte kurz warten.",
  forbidden: "Nicht angemeldet. Bitte die App neu öffnen.",
  not_found: "Dieses Konto gibt es nicht mehr.",
  failed: "Das hat nicht geklappt. Bitte später erneut versuchen.",
  no_encryption_key: "Auf dem Server ist kein Schlüssel für Passwörter eingerichtet. Konten können erst nach der Einrichtung gespeichert werden.",
  invalid_host: "Der Servername ist ungültig. Bitte nur den Namen eintragen, zum Beispiel imap.example.com.",
  host_not_allowed: "Dieser Server ist nicht erlaubt (lokale oder private Adressen sind gesperrt).",
  invalid_secret: "Das Passwort ist ungültig (leer, zu lang oder mit Sonderzeichen wie Zeilenumbruch).",
  invalid_body: "Bitte die Angaben prüfen: Bezeichnung, Benutzername und Passwort sind nötig.",
  not_managed: "Dieses Konto hat keine gespeicherten Zugangsdaten und lässt sich hier nicht ändern.",
  secret_unreadable: "Das gespeicherte Passwort lässt sich nicht entschlüsseln. Bitte neu eintragen.",
};

export const TEST_RESULT_TEXT: Record<string, string> = {
  ok: "Verbindung erfolgreich. Die Ordner wurden gefunden.",
  auth_failed: "Anmeldung abgelehnt. Benutzername oder Passwort stimmen nicht.",
  tls_failed: "Sichere Verbindung fehlgeschlagen. Port und TLS prüfen.",
  host_unreachable: "Server nicht erreichbar. Servername und Port prüfen.",
  timeout: "Keine Antwort vom Server (Zeitüberschreitung).",
  mailbox_missing: "Verbunden, aber ein Ordner fehlt. Namen der Ordner prüfen.",
  connect_failed: "Verbindung fehlgeschlagen.",
  synthetic_no_network: "Im Demo-Modus gibt es keine echten Verbindungen.",
};

const KNOWN: ReadonlySet<string> = new Set(Object.keys(ACCOUNTS_ERROR_TEXT));
const asReason = (v: unknown): AccountsReason => (typeof v === "string" && KNOWN.has(v) ? (v as AccountsReason) : "failed");

function str(m: Map<string, unknown>, k: string): string | null {
  const v = m.get(k);
  return typeof v === "string" ? v : null;
}

function parseItem(raw: unknown): AccountItem | null {
  if (typeof raw !== "object" || raw === null) return null;
  const m = new Map(Object.entries(raw));
  const id = str(m, "id");
  const label = str(m, "label");
  const host = str(m, "host");
  const port = m.get("port");
  const mailbox = str(m, "mailbox");
  if (id === null || label === null || host === null || typeof port !== "number" || mailbox === null) return null;
  const type = m.get("type");
  const w = m.get("worker");
  let worker: AccountItem["worker"] = null;
  if (typeof w === "object" && w !== null) {
    const wm = new Map(Object.entries(w));
    const state = str(wm, "state");
    if (state !== null) worker = { state, error_code: str(wm, "error_code"), last_poll_at: str(wm, "last_poll_at") };
  }
  const tls = m.get("tls");
  return {
    id, managed: m.get("managed") === true, type: type === "google" ? "google" : type === "imap" ? "imap" : null, label,
    color: str(m, "color") ?? "#3b82f6", host, port, tls: typeof tls === "boolean" ? tls : null, username: str(m, "username"), mailbox,
    spam_mailbox: str(m, "spam_mailbox"), enabled: m.get("enabled") === true, context: str(m, "context") ?? "",
    secret_set: m.get("secret_set") === true, secret_set_at: str(m, "secret_set_at"), last_test_at: str(m, "last_test_at"),
    last_test_code: str(m, "last_test_code"), worker,
  };
}

export async function fetchAccounts(fetcher: typeof fetch): Promise<AccountsData> {
  const r = await fetcher("/api/accounts", { cache: "no-store" });
  if (r.status === 401 || r.status === 403) throw new Error("session");
  if (!r.ok) throw new Error("unavailable");
  const b = await readJson(r);
  const list = Array.isArray(b.accounts) ? b.accounts : [];
  const enc = typeof b.encryption === "object" && b.encryption !== null ? new Map(Object.entries(b.encryption)).get("ready") : false;
  return {
    accounts: list.map(parseItem).filter((a): a is AccountItem => a !== null),
    encryptionReady: enc === true,
    synthetic: b.synthetic === true,
  };
}

/** The JSON body for create/update. Google presets (server, port, TLS) are set by the server. */
export function bodyFromForm(f: AccountForm, mode: "create" | "update"): Record<string, unknown> {
  const port = Number(f.port);
  const type = formType(f);
  const username = (f.username.trim() || f.email.trim());
  const body: Record<string, unknown> = {
    label: (f.label.trim() || defaultLabel(f.email)), color: f.color, username, mailbox: f.mailbox.trim() || "INBOX", context: f.context,
  };
  const spam = f.spam_mailbox.trim();
  if (spam !== "") body.spam_mailbox = spam;
  else if (mode === "update") body.spam_mailbox = null;
  if (type === "imap") {
    body.host = f.host.trim();
    body.port = Number.isInteger(port) ? port : 0;
    body.tls = f.tls;
  }
  if (mode === "create") body.type = type;
  if (f.password !== "") body.password = f.password;
  return body;
}

export type AccountResult = { ok: true; account: AccountItem | null } | { ok: false; reason: AccountsReason; retryAfterSeconds?: number };

async function post(path: string, body: unknown, deps: MutationDeps): Promise<AccountResult> {
  const raw = await postApi(path, deps, body === undefined ? {} : { body });
  if (raw.kind === "forbidden") return { ok: false, reason: "forbidden" };
  if (raw.kind === "failed") return { ok: false, reason: "failed" };
  const r = raw.response;
  const common = commonReason(r);
  if (common) return { ok: false, reason: common.reason, ...(common.retryAfterSeconds !== undefined ? { retryAfterSeconds: common.retryAfterSeconds } : {}) };
  const b = await readJson(r);
  if (!r.ok) return { ok: false, reason: asReason(b.error) };
  return { ok: true, account: parseItem(b.account) };
}

export const postCreateAccount = (f: AccountForm, deps: MutationDeps): Promise<AccountResult> => post("/api/accounts", bodyFromForm(f, "create"), deps);
export const postUpdateAccount = (id: string, f: AccountForm, deps: MutationDeps): Promise<AccountResult> =>
  post(`/api/accounts/${encodeURIComponent(id)}`, bodyFromForm(f, "update"), deps);
export const postAccountEnabled = (id: string, enabled: boolean, deps: MutationDeps): Promise<AccountResult> =>
  post(`/api/accounts/${encodeURIComponent(id)}/${enabled ? "enable" : "disable"}`, undefined, deps);

export type TestResult = { ok: true; code: string; spamMailbox: string | null } | { ok: false; reason: AccountsReason; retryAfterSeconds?: number };

export async function postTestAccount(id: string, deps: MutationDeps): Promise<TestResult> {
  const raw = await postApi(`/api/accounts/${encodeURIComponent(id)}/test`, deps);
  if (raw.kind === "forbidden") return { ok: false, reason: "forbidden" };
  if (raw.kind === "failed") return { ok: false, reason: "failed" };
  const r = raw.response;
  const common = commonReason(r);
  if (common) return { ok: false, reason: common.reason, ...(common.retryAfterSeconds !== undefined ? { retryAfterSeconds: common.retryAfterSeconds } : {}) };
  const b = await readJson(r);
  if (!r.ok) return { ok: false, reason: asReason(b.error) };
  return { ok: true, code: typeof b.code === "string" ? b.code : "connect_failed", spamMailbox: typeof b.spam_mailbox === "string" ? b.spam_mailbox : null };
}

/** Worker state in words for the list. */
export function workerText(a: AccountItem): string {
  if (!a.enabled) return "Deaktiviert";
  const w = a.worker;
  if (w === null) return a.managed ? "Wird gestartet" : "Nur Anzeige";
  if (w.error_code === "no_encryption_key") return "Angehalten: Schlüssel fehlt";
  if (w.error_code === "secret_unreadable") return "Angehalten: Passwort nicht lesbar";
  if (w.error_code === "imap_auth") return "Angehalten: Anmeldung abgelehnt";
  switch (w.state) {
    case "connected": return "Verbunden";
    case "connecting": return "Verbindet …";
    case "backoff": return "Neuer Versuch folgt";
    case "paused": return "Angehalten";
    default: return "Deaktiviert";
  }
}
