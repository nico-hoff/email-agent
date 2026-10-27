// Allowlist oeffentlicher, synthetischer Email-Datensets fuer die Jev-Evals (docs/eval-datasets.md).
// Reine Mapper Rohzeile -> EvalCase und deterministische, geschichtete Stichprobe. Kein I/O.
import { createHash } from "node:crypto";
import { EXCERPT_MAX_CHARS } from "./constants.ts";

export type EvalExpected = {
  category?: string;
  is_spam?: boolean;
  is_phishing_or_scam?: boolean;
  addresses_an_ai?: boolean;
  is_assessable?: boolean;
  /** Only set in the question set v2 eval set (T26); the public datasets cannot give it. */
  needs_my_reply?: boolean;
};

export type EvalCase = {
  id: string;
  source?: string;
  lang: string;
  sender_domain: string;
  subject: string;
  body: string;
  expected: EvalExpected;
};

export type EvalSource = {
  short: string;
  id: string;
  config: string;
  split: string;
  license: string;
  attribution: string;
  synthetic: true;
  map(row: unknown, rowIndex: number): EvalCase | null;
};

const PLACEHOLDER_DOMAIN = "unknown.example.test";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Nur Schluessel setzen, die die Quelle eindeutig hergibt; sonst fehlt der Schluessel.
const TRIAGE_EXPECTED: Record<string, EvalExpected> = {
  spam: { category: "spam", is_spam: true, is_phishing_or_scam: false },
  phishing: { is_phishing_or_scam: true, is_spam: true },
  newsletter: { category: "newsletter_promo", is_phishing_or_scam: false },
  promotion: { category: "newsletter_promo", is_phishing_or_scam: false },
  personal: { category: "personal" },
};

function mapTriage(row: unknown, rowIndex: number): EvalCase | null {
  if (!isRecord(row)) return null;
  const { subject, body, category } = row;
  if (typeof subject !== "string" || typeof body !== "string" || typeof category !== "string") return null;
  const expected = Object.hasOwn(TRIAGE_EXPECTED, category) ? { ...TRIAGE_EXPECTED[category] } : {};
  return {
    id: `triage-${rowIndex}`,
    source: "triage",
    lang: "en",
    sender_domain: PLACEHOLDER_DOMAIN,
    subject,
    body: body.slice(0, EXCERPT_MAX_CHARS),
    expected,
  };
}

function mapSinabis(row: unknown, rowIndex: number): EvalCase | null {
  if (!isRecord(row)) return null;
  const { subject, body, lang, from } = row;
  if (typeof subject !== "string" || typeof body !== "string" || typeof lang !== "string") return null;
  let domain = PLACEHOLDER_DOMAIN;
  if (isRecord(from) && typeof from.email === "string") {
    const d = from.email.split("@")[1];
    if (d) domain = d.toLowerCase();
  }
  return {
    id: `sinabis-${rowIndex}`,
    source: "sinabis",
    lang,
    sender_domain: domain,
    subject,
    body: body.slice(0, EXCERPT_MAX_CHARS),
    expected: { category: "business", is_spam: false, is_phishing_or_scam: false, addresses_an_ai: false },
  };
}

export const EVAL_SOURCES: readonly EvalSource[] = [
  {
    short: "triage",
    id: "weijianzhg/email-triage-action-seed",
    config: "default",
    split: "train",
    license: "apache-2.0",
    attribution: "weijianzhg/email-triage-action-seed (Apache-2.0), synthetic English emails",
    synthetic: true,
    map: mapTriage,
  },
  {
    short: "sinabis",
    id: "sinabis-group/sinabis-1k-synthetic-emails",
    config: "default",
    split: "train",
    license: "cc-by-4.0",
    attribution: "sinabis-group/sinabis-1k-synthetic-emails (CC BY 4.0), synthetic DE/EN/FR/IT business emails",
    synthetic: true,
    map: mapSinabis,
  },
];


// ---- Duplikate und feste Aufteilung (kein Leakage) ----

function normalizeText(s: string): string {
  return s.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
}

/** SHA-256 ueber normalisierten Betreff und Body (Gross-/Kleinschreibung und Leerraum egal). */
export function contentHash(c: Pick<EvalCase, "subject" | "body">): string {
  return createHash("sha256").update(`${normalizeText(c.subject)}\u0000${normalizeText(c.body)}`).digest("hex");
}

/** Exakte Dubletten je Quelle entfernen; die erste Fundstelle bleibt. */
export function dedupeCases(cases: readonly EvalCase[]): { cases: EvalCase[]; removed: number } {
  const seen = new Set<string>();
  const out: EvalCase[] = [];
  for (const c of cases) {
    const key = `${c.source ?? "-"}\u0000${contentHash(c)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return { cases: out, removed: cases.length - out.length };
}

export type EvalSplit = "calib" | "test";
export const SPLITS: readonly EvalSplit[] = ["calib", "test"];
/** Anteil der Partition `calib`; der Rest ist `test`. Aenderung wuerde alle Zuordnungen verschieben. */
export const CALIB_SHARE = 0.3;
const SPLIT_SALT = "email-agent-eval-split-v1";

/** Deterministisch: derselbe Schluessel liegt immer in derselben Partition (unabhaengig von Lauf und Download). */
export function partitionOfKey(key: string): EvalSplit {
  const h = createHash("sha256").update(`${SPLIT_SALT}\u0000${key}`).digest();
  return h.readUInt32BE(0) / 4294967296 < CALIB_SHARE ? "calib" : "test";
}

/** Partition nach Inhalt (nicht nach ID), damit Dubletten nie getrennt werden und IDs sich verschieben duerfen. */
export function partitionOf(c: Pick<EvalCase, "subject" | "body">): EvalSplit {
  return partitionOfKey(contentHash(c));
}

// ---- Geschichtete Stichprobe ----

export type SampleStrategy = "balanced" | "proportional";
export const SAMPLE_STRATEGIES: readonly SampleStrategy[] = ["balanced", "proportional"];

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(items: T[], rnd: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Erwartete Klasse fuer die Schichtung: Kategorie, sonst "phishing" (Betrugslabel ohne Kategorie), sonst "(none)". */
export function classLabel(c: EvalCase): string {
  if (c.expected.category !== undefined) return c.expected.category;
  return c.expected.is_phishing_or_scam === true ? "phishing" : "(none)";
}

export function strataKey(c: EvalCase): string {
  return `${c.source ?? "-"}|${classLabel(c)}`;
}

export type StratumSample = { key: string; population: number; sampled: number };
export type SampleResult = {
  cases: EvalCase[];
  strata: StratumSample[];
  /** Schichten, die kleiner als ihr Anteil waren: vollstaendig genommen, der Rest ging an die anderen. */
  shortStrata: string[];
};

function balancedQuotas(keys: string[], pop: Map<string, number>, n: number, rnd: () => number): Map<string, number> {
  const quota = new Map<string, number>(keys.map((k) => [k, 0]));
  let remaining = n;
  let active = keys.filter((k) => (pop.get(k) ?? 0) > 0);
  while (remaining > 0 && active.length > 0) {
    const share = Math.floor(remaining / active.length);
    if (share === 0) {
      // Weniger Plaetze als Schichten: reihum fair per Zufall, je eine.
      for (const k of shuffle(active, rnd).slice(0, remaining)) quota.set(k, quota.get(k)! + 1);
      break;
    }
    const next: string[] = [];
    for (const k of active) {
      const take = Math.min(share, pop.get(k)! - quota.get(k)!);
      quota.set(k, quota.get(k)! + take);
      remaining -= take;
      if (quota.get(k)! < pop.get(k)!) next.push(k);
    }
    active = next;
  }
  return quota;
}

function proportionalQuotas(keys: string[], pop: Map<string, number>, n: number): Map<string, number> {
  const total = keys.reduce((a, k) => a + pop.get(k)!, 0);
  const quota = new Map<string, number>();
  if (n >= total) return new Map(keys.map((k) => [k, pop.get(k)!]));
  const frac: Array<{ key: string; rem: number }> = [];
  let used = 0;
  for (const k of keys) {
    const exact = (n * pop.get(k)!) / total;
    const base = Math.floor(exact);
    quota.set(k, base);
    used += base;
    frac.push({ key: k, rem: exact - base });
  }
  // Largest remainder; Gleichstand nach Schluessel (keys sind sortiert, sort ist stabil).
  frac.sort((a, b) => b.rem - a.rem);
  for (let i = 0; i < n - used; i++) quota.set(frac[i].key, quota.get(frac[i].key)! + 1);
  return quota;
}

/**
 * Geschichtet nach Quelle x erwartete Klasse, ohne Zuruecklegen, deterministisch je Seed und unabhaengig von der
 * Eingabereihenfolge. balanced: gleich viele je Schicht (zu kleine Schichten vollstaendig, Rest umverteilt);
 * proportional: Anteile der Population (Largest-Remainder).
 */
export function sampleCasesDetailed(
  cases: EvalCase[],
  opts: { seed: number; n: number; strategy?: SampleStrategy },
): SampleResult {
  const strategy = opts.strategy ?? "balanced";
  const rnd = mulberry32(opts.seed);
  const groups = new Map<string, EvalCase[]>();
  for (const c of [...cases].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const k = strataKey(c);
    const g = groups.get(k);
    if (g) g.push(c);
    else groups.set(k, [c]);
  }
  const limit = Math.max(0, Math.min(Math.floor(opts.n), cases.length));
  const sortedKeys = [...groups.keys()].sort();
  const pop = new Map(sortedKeys.map((k) => [k, groups.get(k)!.length]));
  const quota =
    strategy === "balanced" ? balancedQuotas(sortedKeys, pop, limit, rnd) : proportionalQuotas(sortedKeys, pop, limit);

  const order = shuffle(sortedKeys, rnd);
  const queues = order.map((k) => shuffle(groups.get(k)!, rnd).slice(0, quota.get(k) ?? 0));
  const out: EvalCase[] = [];
  for (let progress = true; progress; ) {
    progress = false;
    for (const q of queues) {
      const next = q.shift();
      if (next) {
        out.push(next);
        progress = true;
      }
    }
  }
  const nominal = sortedKeys.length === 0 ? 0 : limit / sortedKeys.length;
  return {
    cases: out,
    strata: sortedKeys.map((k) => ({ key: k, population: pop.get(k)!, sampled: quota.get(k) ?? 0 })),
    shortStrata:
      strategy === "balanced" && opts.n < cases.length
        ? sortedKeys.filter((k) => pop.get(k)! < nominal && quota.get(k) === pop.get(k))
        : [],
  };
}

export function sampleCases(
  cases: EvalCase[],
  opts: { seed: number; n: number; strategy?: SampleStrategy },
): EvalCase[] {
  return sampleCasesDetailed(cases, opts).cases;
}
