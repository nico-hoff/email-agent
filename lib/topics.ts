// Themen (ADR 0026): feste Alltagsthemen plus eigene Themen des Nutzers als Optionsliste fuer eine Jev-Choice-Frage.
// Rein und ohne I/O. Die Frage selbst (Fragenset v3) wird spaeter darauf aufgebaut; hier nur Optionen und Listenversion.
import { createHash } from "node:crypto";

export type FixedTopic = {
  /** Stable ASCII snake_case key; stored with classifications, never renamed. */
  key: string;
  /** German label shown in the app. */
  label: string;
  /** Short criteria text sent to Jev as the option description (English, like the other question sets). */
  criteria: string;
};

/** Order = frequency order (most frequent first); the probe takes prefixes of this list. */
export const FIXED_TOPICS: readonly FixedTopic[] = [
  { key: "finance", label: "Finanzen", criteria: "Money matters: bank, account statements, cards, payments, invoices to pay, insurance, taxes, investments." },
  { key: "shopping", label: "Einkäufe/Bestellungen", criteria: "Online shopping: order confirmations, shipping and delivery notices, returns, receipts for purchases." },
  { key: "work", label: "Arbeit", criteria: "Job and professional matters: colleagues, customers, projects, meetings, applications, employer." },
  { key: "travel", label: "Reisen", criteria: "Trips: flights, trains, hotels, bookings, tickets, itineraries, rental cars." },
  { key: "official", label: "Behörden/Verträge", criteria: "Authorities and contracts: government offices, courts, registration, permits, contract terms, utilities and phone contracts, cancellations." },
  { key: "health", label: "Gesundheit", criteria: "Health: doctor and dentist appointments, test results, pharmacy, health insurance, therapy, fitness." },
  { key: "family", label: "Familie/Freunde", criteria: "Private contact with family and friends: personal news, invitations, photos, greetings." },
  { key: "housing", label: "Wohnen", criteria: "Living: rent, landlord, property management, utilities of the home, repairs, furniture, moving." },
  { key: "newsletter", label: "Newsletter", criteria: "Newsletters and promotions sent to many recipients: news digests, marketing, offers, product updates." },
  { key: "education", label: "Bildung", criteria: "Education: school, university, courses, exams, certificates, learning platforms." },
  { key: "clubs", label: "Vereine/Hobbys", criteria: "Clubs, associations and hobbies: membership, club events, sports teams, communities." },
  { key: "other", label: "Sonstiges", criteria: "Anything that fits none of the other topics." },
] as const;

export const FALLBACK_TOPIC_KEY = "other";
export const MAX_CUSTOM_TOPICS = 8;
export const CUSTOM_LABEL_MIN = 2;
export const CUSTOM_LABEL_MAX = 40;
export const CUSTOM_HINT_MAX = 120;
export const CUSTOM_KEY_PREFIX = "custom_";
const CUSTOM_SLUG_MAX = 32;

export type CustomTopicInput = { label: string; hint?: string };

export type TopicOption = {
  key: string;
  label: string;
  criteria: string;
  kind: "fixed" | "custom";
};

export type TopicListError =
  | "too_many_custom"
  | "label_length"
  | "label_chars"
  | "hint_length"
  | "key_empty"
  | "duplicate";

export type TopicList =
  | { ok: true; options: TopicOption[]; criteria: Record<string, string>; version: string }
  | { ok: false; code: TopicListError; index?: number };

const TRANSLIT: ReadonlyMap<string, string> = new Map([["ä", "ae"], ["ö", "oe"], ["ü", "ue"], ["ß", "ss"]]);

/** Lowercase NFC label with collapsed whitespace; the basis for duplicate checks and the version hash. */
export function normalizeLabel(label: string): string {
  return label.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Deterministic ASCII key: `custom_` + transliterated slug (umlauts to ae/oe/ue/ss, other accents stripped). */
export function deriveCustomKey(label: string): string {
  const lowered = normalizeLabel(label);
  let out = "";
  for (const ch of lowered) out += TRANSLIT.get(ch) ?? ch;
  const slug = out
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, CUSTOM_SLUG_MAX)
    .replace(/_+$/g, "");
  return slug === "" ? "" : `${CUSTOM_KEY_PREFIX}${slug}`;
}

function customCriteria(label: string, hint: string | undefined): string {
  const base = `Mails about the user's own topic "${label}".`;
  return hint ? `${base} ${hint}` : base;
}

/** Hash of the normalized list (keys, normalized labels, criteria in order); changes whenever the sent options change. */
export function topicListVersion(options: readonly TopicOption[]): string {
  const canonical = JSON.stringify(options.map((o) => [o.key, normalizeLabel(o.label), o.criteria]));
  return `topics-${createHash("sha256").update(canonical).digest("hex").slice(0, 12)}`;
}

/**
 * Builds the per-user option list: fixed topics first (stable order), then the custom topics in the given order.
 * Custom topics are validated (count, label length and characters, hint length, derived key, no duplicates against
 * fixed labels/keys or each other). The result is deterministic; `version` is the hash of the normalized list.
 */
export function buildTopicList(custom: readonly CustomTopicInput[] = []): TopicList {
  if (custom.length > MAX_CUSTOM_TOPICS) return { ok: false, code: "too_many_custom" };
  const options: TopicOption[] = FIXED_TOPICS.map((t) => ({ ...t, kind: "fixed" as const }));
  const keys = new Set(options.map((o) => o.key));
  const labels = new Set(options.map((o) => normalizeLabel(o.label)));
  for (const [index, c] of custom.entries()) {
    const label = c.label.normalize("NFC").replace(/\s+/g, " ").trim();
    if (label.length < CUSTOM_LABEL_MIN || label.length > CUSTOM_LABEL_MAX) return { ok: false, code: "label_length", index };
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f<>"]/.test(label)) return { ok: false, code: "label_chars", index };
    const hint = c.hint?.replace(/\s+/g, " ").trim();
    if (hint !== undefined && hint.length > CUSTOM_HINT_MAX) return { ok: false, code: "hint_length", index };
    const key = deriveCustomKey(label);
    if (key === "") return { ok: false, code: "key_empty", index };
    const norm = normalizeLabel(label);
    if (keys.has(key) || labels.has(norm)) return { ok: false, code: "duplicate", index };
    keys.add(key);
    labels.add(norm);
    options.push({ key, label, criteria: customCriteria(label, hint || undefined), kind: "custom" });
  }
  return {
    ok: true,
    options,
    criteria: Object.fromEntries(options.map((o) => [o.key, o.criteria])),
    version: topicListVersion(options),
  };
}

/**
 * Subset of an already built list: the first `count` fixed topics (frequency order) with `other` always included,
 * then (if requested) the custom topics. Used by the live probe to vary the option count; not by the app.
 */
export function selectTopicOptions(list: Extract<TopicList, { ok: true }>, fixedCount: number, includeCustom: boolean): TopicOption[] {
  const fixed = list.options.filter((o) => o.kind === "fixed");
  const other = fixed.find((o) => o.key === FALLBACK_TOPIC_KEY);
  const head = fixed.filter((o) => o.key !== FALLBACK_TOPIC_KEY).slice(0, Math.max(0, fixedCount - 1));
  const picked = other ? [...head, other] : head;
  return includeCustom ? [...picked, ...list.options.filter((o) => o.kind === "custom")] : picked;
}
