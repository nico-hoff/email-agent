// Versioned noul thresholds (O8/T25), version 1 of 2026-10-27. Documented in docs/jev-contract.md, section
// Kalibrierung; a test keeps both in sync. Any change of a value is a new version there and here.
// A TypeScript data module instead of JSON: Veryfront bundles tools and API routes in a temp directory (no
// usable import.meta.url, no JSON loader), a plain import works in Node, the Veryfront build and the client.
// Validated at import by lib/noul-calibration.ts (zod); erasable syntax only.
export default {
  version: "1",
  created: "2026-10-27",
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
};
