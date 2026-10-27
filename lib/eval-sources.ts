// Allowlist oeffentlicher, synthetischer Email-Datensets fuer die Jev-Evals (docs/eval-datasets.md).
// Reine Mapper Rohzeile -> EvalCase und deterministische, geschichtete Stichprobe. Kein I/O.
import { EXCERPT_MAX_CHARS } from "./constants.ts";

export type EvalExpected = {
  category?: string;
  is_spam?: boolean;
  is_phishing_or_scam?: boolean;
  addresses_an_ai?: boolean;
  is_assessable?: boolean;
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

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], rnd: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function strataKey(c: EvalCase): string {
  return `${c.source ?? "-"}|${c.expected.category ?? "(none)"}`;
}

// Geschichtet nach Quelle x erwarteter Kategorie, reihum gleich viele je Schicht (kleine Schichten
// laufen frueher leer). Unabhaengig von der Eingabereihenfolge; gleicher Seed = gleiche Auswahl.
export function sampleCases(cases: EvalCase[], opts: { seed: number; n: number }): EvalCase[] {
  const rnd = mulberry32(opts.seed);
  const groups = new Map<string, EvalCase[]>();
  for (const c of [...cases].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const k = strataKey(c);
    const g = groups.get(k);
    if (g) g.push(c);
    else groups.set(k, [c]);
  }
  const keys = shuffle([...groups.keys()].sort(), rnd);
  const queues = keys.map((k) => shuffle(groups.get(k)!, rnd));
  const out: EvalCase[] = [];
  const limit = Math.max(0, opts.n);
  while (out.length < limit) {
    let took = false;
    for (const q of queues) {
      if (out.length >= limit) break;
      const next = q.shift();
      if (next) {
        out.push(next);
        took = true;
      }
    }
    if (!took) break;
  }
  return out;
}
