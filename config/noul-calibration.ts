// Versioned noul thresholds (O8/T25), one entry per (question set version, model) (R7, ADR 0041; entries 1 and 2 are Jev). Entry "1" (2026-10-27) is v1. Documented in docs/jev-contract.md, section
// Kalibrierung; a test keeps both in sync. Any change of a value is a new version there and here.
// A TypeScript data module instead of JSON: Veryfront bundles tools and API routes in a temp directory (no
// usable import.meta.url, no JSON loader), a plain import works in Node, the Veryfront build and the client.
// Validated at import by packages/core/src/noul-calibration.ts (zod); erasable syntax only.
export default [
  {
    version: "1",
    created: "2026-10-27",
    model: "typesafe/jev-1.13",
    question_set_version: "email-classification-v1",
    rule: "positive wenn Rohwert >= Schwelle, sonst negative; nicht aufgeführte Fragen bleiben unmapped",
    basis: [
      "HF-Evals 2026-10-27 (3 x 100, triage+sinabis, gemischter Split)",
      "Echtes Sample web2 2026-10-26 (153 Spam, 6 INBOX)",
    ],
    thresholds: {
      is_spam: 0.8,
      is_phishing_or_scam: 0.5,
      addresses_an_ai: 0.3,
    },
  },
  {
    version: "2",
    created: "2026-10-31",
    model: "typesafe/jev-1.13",
    question_set_version: "email-classification-v2",
    rule: "positive wenn Rohwert >= Schwelle, sonst negative; nicht aufgeführte Fragen bleiben unmapped",
    basis: [
      "HF-Evals R7 2026-10-31 (Seed 7, triage+sinabis): Schwellen auf calib (150 Aufrufe), Bericht auf test (200 Aufrufe)",
      "Festes synthetisches Set v2 (29 Aufrufe) und Echtes Sample web2 2026-10-26 (nur is_spam-Obergrenze 0.65, v1)",
    ],
    thresholds: {
      is_spam: 0.7,
      is_phishing_or_scam: 0.7,
      addresses_an_ai: 0.3,
      needs_my_reply: 0.5,
    },
  },
  {
    version: "3",
    created: "2026-11-01",
    model: "openai/gpt-6-luna-decisions",
    question_set_version: "email-classification-v2",
    rule: "positive wenn Rohwert >= Schwelle, sonst negative; nicht aufgeführte Fragen bleiben unmapped",
    basis: [
      "HF-Evals R3 2026-11-01 (Seed 7, triage+sinabis, gleiche Stichprobe wie Eintrag 2): Schwellen auf calib (150 Aufrufe), Bericht auf test (200 Aufrufe)",
      "Festes synthetisches Set v2 (29 Aufrufe) als Gegenprobe; Luna Decisions, Decisions-API, nur synthetische Inhalte (ADR 0028, 0041)",
    ],
    thresholds: {
      is_spam: 0.85,
      is_phishing_or_scam: 0.9,
      addresses_an_ai: 0.3,
      needs_my_reply: 0.5,
    },
  },
  {
    version: "4",
    created: "2026-11-01",
    model: "typesafe/jev-1.13",
    question_set_version: "email-classification-v3",
    rule: "positive wenn Rohwert >= Schwelle, sonst negative; nicht aufgeführte Fragen bleiben unmapped",
    basis: [
      "Schwellen von Eintrag 2 übernommen: v3 = v2 plus die Choice-Frage topic, die noul-Texte sind unverändert (ADR 0037)",
      "Live-Eval R8 2026-11-01 (HF test, v3 gegen v2 gepaart): noul-F1 nicht schlechter als v2, Zahlen in docs/insights-topics.md",
    ],
    thresholds: {
      is_spam: 0.7,
      is_phishing_or_scam: 0.7,
      addresses_an_ai: 0.3,
      needs_my_reply: 0.5,
    },
  },
  {
    version: "5",
    created: "2026-11-01",
    model: "openai/gpt-6-luna-decisions",
    question_set_version: "email-classification-v3",
    rule: "positive wenn Rohwert >= Schwelle, sonst negative; nicht aufgeführte Fragen bleiben unmapped",
    basis: [
      "Schwellen von Eintrag 3 übernommen: v3 = v2 plus die Choice-Frage topic, die noul-Texte sind unverändert (ADR 0037)",
      "Live-Eval R8 2026-11-01 (HF test, v3 gegen v2 gepaart): Zahlen in docs/insights-topics.md",
    ],
    thresholds: {
      is_spam: 0.85,
      is_phishing_or_scam: 0.9,
      addresses_an_ai: 0.3,
      needs_my_reply: 0.5,
    },
  },
];
