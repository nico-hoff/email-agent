// Pure helpers for the mobile review UI (T36): types of the /api/emails rows, view filters, German
// formulations and formatting. No React, no I/O, no mail content: the API exposes metadata only.
import { interpretNoul, type NoulReading, type NormalizedAnswer } from "./jev-response.ts";

export interface ApiAnswer {
  type: string;
  value: number | string | null;
  probabilities?: Record<string, number>;
}

export interface ApiShadow {
  candidate: boolean;
  decision: string;
  reason: string;
  applied_threshold: number;
}

export interface ApiEmail {
  id: number;
  account_id: string;
  sender: string;
  subject: string;
  received_at: string;
  active_location: { folder: string; uid: number } | null;
  provider_spam: boolean;
  classification: {
    status: string | null;
    failure_code?: string | null;
    answers: Record<string, ApiAnswer>;
  } | null;
  shadow_quarantine: ApiShadow | null;
  disagreement: string | null;
}

export type ViewId = "needs_reply" | "today" | "disagreements" | "all";
export type Interpreter = (answer: NormalizedAnswer) => NoulReading;

export const PAGE_SIZE = 50;
/** Upper bound of GET /api/emails (limit). Older mails need the cursor API (T35). */
export const API_MAX_LIMIT = 200;

export const VIEW_LABEL: Record<ViewId, string> = {
  needs_reply: "Braucht Antwort",
  today: "Heute",
  disagreements: "Abweichungen",
  all: "Alle",
};

const noulAnswer = (key: string, value: number): NormalizedAnswer => ({ key, type: "noul", value });

/** O4: "Braucht Antwort" exists only once needs_my_reply is calibrated (interpretNoul no longer fail-closed). */
export function isNeedsReplyCalibrated(interpret: Interpreter = interpretNoul): boolean {
  return [0, 0.5, 1].some((v) => interpret(noulAnswer("needs_my_reply", v)) !== "unmapped");
}

export function availableViews(interpret: Interpreter = interpretNoul): ViewId[] {
  const rest: ViewId[] = ["today", "disagreements", "all"];
  return isNeedsReplyCalibrated(interpret) ? ["needs_reply", ...rest] : rest;
}

export function defaultView(interpret: Interpreter = interpretNoul): ViewId {
  return availableViews(interpret)[0];
}

function dayKey(iso: string, timeZone?: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("sv-SE", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export function isSameDay(iso: string, now: Date, timeZone?: string): boolean {
  const a = dayKey(iso, timeZone);
  return a !== null && a === dayKey(now.toISOString(), timeZone);
}

export interface FilterOptions {
  now?: Date;
  timeZone?: string;
  interpret?: Interpreter;
}

/** Client-side view filter (the API has no view parameter yet, see T35). Keeps the API order. */
export function filterByView(emails: ApiEmail[], view: ViewId, o: FilterOptions = {}): ApiEmail[] {
  const now = o.now ?? new Date();
  switch (view) {
    case "all":
      return emails;
    case "today":
      return emails.filter((m) => isSameDay(m.received_at, now, o.timeZone));
    case "disagreements":
      return emails.filter((m) => m.disagreement !== null);
    case "needs_reply": {
      const interpret = o.interpret ?? interpretNoul;
      return emails.filter((m) => {
        const a = m.classification?.answers.needs_my_reply;
        return a !== undefined && typeof a.value === "number" &&
          interpret(noulAnswer("needs_my_reply", a.value)) === "positive";
      });
    }
  }
}

export const EMPTY_TITLE = "Keine Mails in dieser Ansicht";

export function emptyText(view: ViewId): string {
  switch (view) {
    case "today": return "Heute ist noch keine Mail eingegangen.";
    case "disagreements": return "Keine Abweichungen zwischen Provider und Jev.";
    case "needs_reply": return "Keine Mail braucht eine Antwort.";
    case "all": return "Noch keine Mails vorhanden.";
  }
}

// ---- Formatierung -------------------------------------------------------------------------------

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
  tone: "neutral" | "info" | "warn" | "danger" | "good" | "category";
  level?: number;
  /** category badges only: raw category key, drives the semantic colour. */
  category?: string;
}

const LEVEL_TONE: Badge["tone"][] = ["neutral", "info", "warn", "danger"];

/** Badges of a card: category, importance, urgency, shadow hint, disagreement, classification status. */
export function cardBadges(m: ApiEmail): Badge[] {
  const out: Badge[] = [];
  const a = m.classification?.answers ?? {};
  if (m.classification === null || m.classification.status !== "classified") {
    const s = m.classification?.status ?? null;
    out.push({
      key: "status",
      text: s === null ? "Nicht bewertet" : STATUS_LABEL[s] ?? "Nicht bewertet",
      tone: s === "failed" ? "danger" : "neutral",
    });
  } else {
    if (typeof a.category?.value === "string") out.push({ key: "category", text: categoryLabel(a.category.value), tone: "category", category: a.category.value });
    const imp = scoreLevel(a.importance?.value);
    if (imp !== null) out.push({ key: "importance", text: `Wichtig: ${IMPORTANCE_SHORT[imp]}`, tone: LEVEL_TONE[imp], level: imp });
    const urg = scoreLevel(a.urgency?.value);
    if (urg !== null) out.push({ key: "urgency", text: `Dringend: ${URGENCY_SHORT[urg]}`, tone: LEVEL_TONE[urg], level: urg });
  }
  if (m.shadow_quarantine?.candidate === true) out.push({ key: "shadow", text: "Shadow: Spam-Kandidat", tone: "warn" });
  if (m.disagreement !== null) {
    out.push({ key: "disagreement", text: DISAGREEMENT_LABEL[m.disagreement] ?? "Abweichung", tone: "danger" });
  }
  return out;
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
  /** noul only: raw value, bar fill (0..1) and whether the value is still uncalibrated. */
  bar?: { raw: number; fill: number; uncalibrated: boolean };
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

/** Translates the stored answers into question -> answer pairs. noul stays a raw value while interpretNoul is unmapped. */
export function describeAnswers(answers: Record<string, ApiAnswer>, interpret: Interpreter = interpretNoul): AnswerItem[] {
  const out: AnswerItem[] = [];
  for (const key of ANSWER_ORDER) {
    const a = answers[key];
    if (a === undefined || a.value === null) continue;
    const question = QUESTION_TEXT[key];
    if (a.type === "noul" && typeof a.value === "number") {
      const reading = interpret(noulAnswer(key, a.value));
      const uncalibrated = reading === "unmapped";
      out.push({
        key, kind: "noul", question,
        answer: uncalibrated ? `Rohwert ${formatNumber(a.value)}, noch unkalibriert` : reading === "positive" ? "Ja" : "Nein",
        bar: { raw: a.value, fill: Math.min(Math.max(a.value, 0), 1), uncalibrated },
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
