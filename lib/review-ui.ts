// Pure helpers for the mobile review UI (T36, T48, T49, T64, T47): types of the /api/emails rows, view requests,
// grouping, optimistic done updates, swipe maths, German formulations and formatting. No React, no I/O, no mail
// content: the API exposes metadata only.
import type { NoulInterpreter, NoulReading, NormalizedAnswer } from "./jev-response.ts";

export interface ApiAnswer {
  type: string;
  value: number | string | null;
  probabilities?: Record<string, number>;
  /** noul only (GET /api/emails): reading under the calibration of the classification's question set. */
  reading?: NoulReading;
  threshold?: number | null;
  calibration_version?: string | null;
}

export interface ApiShadow {
  candidate: boolean;
  decision: string;
  reason: string;
  applied_threshold: number;
}

/** Account tag (T47): short name and color from the accounts file; never host or user. */
export interface ApiAccount {
  id: string;
  label: string;
  color: string;
}

export interface ApiEmail {
  id: number;
  account: ApiAccount;
  sender: string;
  subject: string;
  received_at: string;
  active_location: { folder: string; uid?: number | null } | null;
  provider_spam: boolean;
  /** Provider flag \Seen, read-only. */
  seen: boolean;
  /** Nico's decision in the app. */
  done: boolean;
  /** Call to action, neither seen nor done (Plan v5, 3.6). */
  open: boolean;
  category: string | null;
  route: string | null;
  urgency: number | null;
  importance: number | null;
  needs_my_reply: NoulReading | null;
  classification: {
    status: string | null;
    failure_code?: string | null;
    answers: Record<string, ApiAnswer>;
  } | null;
  shadow_quarantine: ApiShadow | null;
  disagreement: string | null;
}

export interface FolderMove {
  at: string;
  from: string | null;
  to: string | null;
}

/** GET /api/emails/:id */
export interface ApiEmailDetail extends ApiEmail {
  folder_history: FolderMove[];
  locations: { folder: string; is_active: boolean; first_seen_at: string; last_seen_at: string }[];
}

export interface ApiCounts {
  important: number;
  open: number;
  noise: number;
  all: number;
}

/** GET /api/emails */
export interface ListResponse {
  emails: ApiEmail[];
  next_cursor: string | null;
  counts: ApiCounts;
  accounts: ApiAccount[];
  view: string;
}

/** Segments of the head. "noise" is not a segment: it is the folded section under "Wichtig". */
export const VIEWS = ["important", "open", "all"] as const;
export type ViewId = (typeof VIEWS)[number];
export type Interpreter = NoulInterpreter;

export const DEFAULT_VIEW: ViewId = "important";
export const PAGE_SIZE = 30;

export const VIEW_LABEL: Record<ViewId, string> = {
  important: "Wichtig",
  open: "Offen",
  all: "Alle",
};

export const NOISE_TITLE = "Newsletter & Werbung / Aussortiert";

export function isViewId(v: unknown): v is ViewId {
  return typeof v === "string" && (VIEWS as readonly string[]).includes(v);
}

export interface ListRequest {
  view: ViewId | "noise";
  account?: string;
  cursor?: string | null;
  limit: number;
}

export function listUrl(r: ListRequest): string {
  const q = new URLSearchParams({ view: r.view, limit: String(r.limit) });
  if (r.account) q.set("account", r.account);
  if (r.cursor) q.set("cursor", r.cursor);
  return `/api/emails?${q}`;
}

export function formatCount(n: number): string {
  return n > 999 ? "999+" : String(n);
}

/**
 * Client code has no calibration (the config is read server-side only): the readings come from GET /api/emails
 * (`reading`). Without one, a noul answer stays unmapped, i.e. a raw value marked "unkalibriert".
 */
const apiReadingOnly: Interpreter = () => "unmapped";

const noulAnswer = (key: string, value: number): NormalizedAnswer => ({ key, type: "noul", value });

export const EMPTY_TITLE = "Keine Mails in dieser Ansicht";

export function emptyText(view: ViewId): string {
  switch (view) {
    case "important": return "Nichts Wichtiges. Alles ruhig.";
    case "open": return "Nichts offen. Alles erledigt.";
    case "all": return "Noch keine Mails vorhanden.";
  }
}

// ---- Gruppierung nach Dringlichkeit ------------------------------------------------------------------------------

export type UrgencyGroupKey = "now" | "soon" | "later";

export interface UrgencyGroup {
  key: UrgencyGroupKey;
  label: string;
  items: ApiEmail[];
}

const GROUP_LABEL: Record<UrgencyGroupKey, string> = { now: "Heute", soon: "In 48 Stunden", later: "Später" };

function groupKey(m: ApiEmail): UrgencyGroupKey {
  const level = scoreLevel(m.urgency);
  return level === 3 ? "now" : level === 2 ? "soon" : "later";
}

/** The API order is urgency first, so contiguous runs form the groups; the order itself is never changed. */
export function groupByUrgency(emails: ApiEmail[]): UrgencyGroup[] {
  const out: UrgencyGroup[] = [];
  for (const m of emails) {
    const key = groupKey(m);
    const last = out.at(-1);
    if (last && last.key === key) last.items.push(m);
    else out.push({ key, label: GROUP_LABEL[key], items: [m] });
  }
  return out;
}

// ---- Konto-Tag ----------------------------------------------------------------------------------------------------

const FALLBACK_COLOR = "#98a2b3";

/** The color goes into a style attribute: accept hex colors only. */
export function safeColor(c: string | null | undefined): string {
  return typeof c === "string" && /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : FALLBACK_COLOR;
}

// ---- Formatierung -------------------------------------------------------------------------------

function dayKey(iso: string, timeZone?: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("sv-SE", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export function isSameDay(iso: string, now: Date, timeZone?: string): boolean {
  const a = dayKey(iso, timeZone);
  return a !== null && a === dayKey(now.toISOString(), timeZone);
}

const WEEKDAYS: Record<string, string> = { Sun: "So", Mon: "Mo", Tue: "Di", Wed: "Mi", Thu: "Do", Fri: "Fr", Sat: "Sa" };

/** "14:05" today, "gestern 09:12", "Mo 14:05" within a week, else "12.10.". Invalid input yields "". */
export function formatTime(iso: string, now: Date, timeZone?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hm = new Intl.DateTimeFormat("de-DE", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
  if (isSameDay(iso, now, timeZone)) return hm;
  const diffDays = Math.round((Date.parse(`${dayKey(now.toISOString(), timeZone)}T00:00:00Z`) -
    Date.parse(`${dayKey(iso, timeZone)}T00:00:00Z`)) / 86_400_000);
  if (diffDays === 1) return `gestern ${hm}`;
  if (diffDays > 1 && diffDays < 7) {
    const wd = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(d);
    return `${WEEKDAYS[wd] ?? wd} ${hm}`;
  }
  return new Intl.DateTimeFormat("de-DE", {
    timeZone, day: "2-digit", month: "2-digit", year: diffDays < 0 || diffDays > 300 ? "2-digit" : undefined,
  }).format(d);
}

export function formatPercent(p: number): string {
  return `${Math.round(Math.min(Math.max(p, 0), 1) * 100)} %`;
}

export function formatNumber(n: number): string {
  return n.toLocaleString("de-DE", { maximumFractionDigits: 2 });
}

// ---- Bezeichnungen --------------------------------------------------------------------------------

export const CATEGORY_LABEL: Record<string, string> = {
  spam: "Spam",
  newsletter_promo: "Newsletter / Werbung",
  transactional: "Automatische Mail",
  security_auth: "Sicherheit / Login",
  personal: "Persönlich",
  business: "Geschäftlich",
  unclear: "Unklar",
};

export const ROUTE_LABEL: Record<string, string> = {
  ignore: "Ignorieren",
  digest: "In Zusammenfassung aufnehmen",
  notify: "Bald benachrichtigen",
  draft_reply: "Antwort vorbereiten",
};

export const IMPORTANCE_LABEL = [
  "Routine",
  "Nützlich, nicht kritisch",
  "Folgenreich (persönlich, finanziell, rechtlich)",
  "Kritisch (Sicherheit, Gesundheit, Recht)",
];
export const URGENCY_LABEL = ["Kann warten", "Diese Woche", "Innerhalb von 48 Stunden", "Heute oder blockierend"];
const IMPORTANCE_SHORT = ["Routine", "nützlich", "folgenreich", "kritisch"];
const URGENCY_SHORT = ["kann warten", "diese Woche", "48 Std.", "heute"];

export const DISAGREEMENT_LABEL: Record<string, string> = {
  provider_spam_jev_not_spam: "Provider: Spam, Jev: nicht Spam",
  jev_spam_provider_not_spam: "Jev: Spam, Provider: nicht Spam",
};

export const STATUS_LABEL: Record<string, string> = {
  pending: "Wartet auf Bewertung",
  retry_wait: "Neuer Versuch geplant",
  failed: "Bewertung fehlgeschlagen",
  paused: "Bewertung pausiert",
  classified: "Bewertet",
};

export const SHADOW_REASON_LABEL: Record<string, string> = {
  security_auth: "Sicherheits- und Login-Mails werden nie als Kandidat vorgeschlagen.",
  unmapped_answer: "Noch keine Entscheidung: Die Spam-, Antwort- und Lesbarkeits-Werte sind unkalibriert.",
  not_spam: "Jev hält die Mail nicht für Spam.",
  below_threshold: "Der Spam-Wert liegt unter der Schwelle des Kontos.",
  needs_reply: "Die Mail erwartet eine Antwort und wird deshalb nicht aussortiert.",
  not_assessable: "Der Inhalt ist nicht verlässlich beurteilbar.",
  candidate: "Spam-Kandidat. Es wird nichts verschoben, das ist nur eine Beobachtung.",
};

export function categoryLabel(value: unknown): string {
  return typeof value === "string" ? CATEGORY_LABEL[value] ?? value : "-";
}

/** Score answers are continuous in [0,3]; the level is the nearest anchor. */
export function scoreLevel(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(Math.max(Math.round(value), 0), 3);
}

export function importanceText(level: number): string {
  return IMPORTANCE_LABEL[level] ?? "";
}

export function urgencyText(level: number): string {
  return URGENCY_LABEL[level] ?? "";
}

export interface Badge {
  key: string;
  text: string;
  tone: "neutral" | "info" | "warn" | "danger" | "good" | "category" | "accent";
  level?: number;
  /** category badges only: raw category key, drives the semantic colour. */
  category?: string;
}

const LEVEL_TONE: Badge["tone"][] = ["neutral", "info", "warn", "danger"];

/** Value of a top-level field, else of the Jev answer (older rows). */
function answerNumber(m: ApiEmail, key: string): number | null {
  const v = key === "importance" ? m.importance : m.urgency;
  if (v !== null) return v;
  const a = m.classification?.answers[key]?.value;
  return typeof a === "number" ? a : null;
}

export function categoryOf(m: ApiEmail): string | null {
  if (m.category !== null) return m.category;
  const v = m.classification?.answers.category?.value;
  return typeof v === "string" ? v : null;
}

/** Badges of a card: Offen/Erledigt, category, importance, urgency, shadow hint, disagreement, classification status. */
export function cardBadges(m: ApiEmail): Badge[] {
  const out: Badge[] = [];
  if (m.done) out.push({ key: "done", text: "Erledigt", tone: "good" });
  else if (m.open) out.push({ key: "open", text: "Offen", tone: "accent" });
  if (m.classification === null || m.classification.status !== "classified") {
    const s = m.classification?.status ?? null;
    out.push({
      key: "status",
      text: s === null ? "Nicht bewertet" : STATUS_LABEL[s] ?? "Nicht bewertet",
      tone: s === "failed" ? "danger" : "neutral",
    });
  } else {
    const cat = categoryOf(m);
    if (cat !== null) out.push({ key: "category", text: categoryLabel(cat), tone: "category", category: cat });
    const imp = scoreLevel(answerNumber(m, "importance"));
    if (imp !== null) out.push({ key: "importance", text: `Wichtig: ${IMPORTANCE_SHORT[imp]}`, tone: LEVEL_TONE[imp], level: imp });
    const urg = scoreLevel(answerNumber(m, "urgency"));
    if (urg !== null) out.push({ key: "urgency", text: `Dringend: ${URGENCY_SHORT[urg]}`, tone: LEVEL_TONE[urg], level: urg });
  }
  if (m.shadow_quarantine?.candidate === true) out.push({ key: "shadow", text: "Shadow: Spam-Kandidat", tone: "warn" });
  if (m.disagreement !== null) {
    out.push({ key: "disagreement", text: DISAGREEMENT_LABEL[m.disagreement] ?? "Abweichung", tone: "danger" });
  }
  return out;
}

// ---- Detail ---------------------------------------------------------------------------------------------------------

export type WorkState = "open" | "done" | "seen" | "none";

export function workState(m: Pick<ApiEmail, "open" | "done" | "seen">): WorkState {
  return m.done ? "done" : m.open ? "open" : m.seen ? "seen" : "none";
}

export const WORK_LABEL: Record<WorkState, string> = {
  open: "Offen",
  done: "Erledigt",
  seen: "Gelesen",
  none: "Ungelesen",
};

export interface HistoryRow {
  key: string;
  when: string;
  text: string;
}

/** Provider-side moves, newest first. Folder names only, never content. */
export function folderHistoryRows(history: FolderMove[], now: Date, timeZone?: string): HistoryRow[] {
  return history
    .map((h, i) => ({
      key: String(i),
      at: h.at,
      when: formatTime(h.at, now, timeZone),
      text: `${h.from ?? "unbekannt"} → ${h.to ?? "unbekannt"}`,
    }))
    .reverse()
    .map(({ key, when, text }) => ({ key, when, text }));
}

// ---- Detail: Jev-Antworten verständlich ---------------------------------------------------------------

export interface ProbabilityRow {
  label: string;
  p: number;
  percent: string;
  selected: boolean;
}

export interface AnswerItem {
  key: string;
  kind: "noul" | "choice" | "score";
  question: string;
  answer: string;
  /**
   * noul only: raw value, bar fill (0..1), whether the value is still uncalibrated and, for calibrated
   * answers, the threshold and calibration version plus a ready-made detail line.
   */
  bar?: { raw: number; fill: number; uncalibrated: boolean; threshold?: number; calibrationVersion?: string; detail?: string };
  probabilities?: ProbabilityRow[];
}

const QUESTION_TEXT: Record<string, string> = {
  category: "Welche Art von Mail ist das?",
  route: "Wie sollte die Mail behandelt werden? (nur ein Vorschlag)",
  importance: "Wie wichtig ist die Mail für dich?",
  urgency: "Wie dringend ist die Mail?",
  is_spam: "Ist das unerwünschte Massen- oder Werbepost?",
  is_phishing_or_scam: "Versucht die Mail, an Zugangsdaten oder Geld zu kommen oder zum Klicken zu verleiten?",
  needs_my_reply: "Erwartet die Mail eine Antwort oder eine Handlung von dir?",
  addresses_an_ai: "Richtet sich der Text an eine KI (Hinweis auf Prompt-Injection)?",
  is_assessable: "Reicht der lesbare Inhalt für eine verlässliche Einschätzung?",
};

export const ANSWER_ORDER = [
  "category", "route", "importance", "urgency",
  "is_spam", "is_phishing_or_scam", "needs_my_reply", "addresses_an_ai", "is_assessable",
];

function probabilityRows(a: ApiAnswer, labelOf: (k: string) => string, selectedKey: string): ProbabilityRow[] | undefined {
  if (!a.probabilities) return undefined;
  return Object.entries(a.probabilities)
    .filter(([, p]) => typeof p === "number")
    .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
    .map(([k, p]) => ({ label: labelOf(k), p, percent: formatPercent(p), selected: k === selectedKey }));
}

/**
 * Translates the stored answers into question -> answer pairs. A noul answer shows Ja/Nein with threshold and
 * calibration version when the API (or the injected interpreter) maps it; otherwise it stays a raw value.
 */
export function describeAnswers(answers: Record<string, ApiAnswer>, interpret: Interpreter = apiReadingOnly): AnswerItem[] {
  const out: AnswerItem[] = [];
  for (const key of ANSWER_ORDER) {
    const a = answers[key];
    if (a === undefined || a.value === null) continue;
    const question = QUESTION_TEXT[key];
    if (a.type === "noul" && typeof a.value === "number") {
      const reading = a.reading ?? interpret(noulAnswer(key, a.value));
      const uncalibrated = reading === "unmapped";
      const bar: NonNullable<AnswerItem["bar"]> = { raw: a.value, fill: Math.min(Math.max(a.value, 0), 1), uncalibrated };
      if (!uncalibrated && typeof a.threshold === "number" && typeof a.calibration_version === "string") {
        bar.threshold = a.threshold;
        bar.calibrationVersion = a.calibration_version;
        bar.detail = `Rohwert ${formatNumber(a.value)}, Schwelle ${formatNumber(a.threshold)} (Kalibrierung Version ${a.calibration_version})`;
      }
      out.push({
        key, kind: "noul", question,
        answer: uncalibrated ? `Rohwert ${formatNumber(a.value)}, noch unkalibriert` : reading === "positive" ? "Ja" : "Nein",
        bar,
      });
    } else if (a.type === "choice" && typeof a.value === "string") {
      const labels = key === "route" ? ROUTE_LABEL : CATEGORY_LABEL;
      out.push({
        key, kind: "choice", question, answer: labels[a.value] ?? a.value,
        probabilities: probabilityRows(a, (k) => labels[k] ?? k, a.value),
      });
    } else if (a.type === "score" && typeof a.value === "number") {
      const level = scoreLevel(a.value) ?? 0;
      const labels = key === "importance" ? IMPORTANCE_LABEL : URGENCY_LABEL;
      out.push({
        key, kind: "score", question,
        answer: `Stufe ${level} von 3: ${labels[level]}`,
        probabilities: probabilityRows(a, (k) => labels[Number(k)] ?? k, String(level)),
      });
    }
  }
  return out;
}

export function shadowText(s: ApiShadow): string {
  const base = SHADOW_REASON_LABEL[s.reason] ?? "Keine Angabe.";
  return s.reason === "below_threshold" ? `${base} (Schwelle ${formatNumber(s.applied_threshold)})` : base;
}

export function locationText(m: ApiEmail): string {
  if (m.active_location === null) return "Ordner unbekannt";
  return m.provider_spam ? `${m.active_location.folder} (Spam-Ordner des Providers)` : m.active_location.folder;
}
