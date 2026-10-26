import type { JevQuestion } from "./jev-questions.ts";

export type NormalizedAnswer = {
  key: string;
  type: "noul" | "choice" | "score";
  value: number | string;
  probabilities?: Record<string, number>;
};

export type NormalizedNoul = NormalizedAnswer & { type: "noul"; value: number };

export type NormalizeErrorCode =
  | "invalid_answers"
  | "missing_answer"
  | "unexpected_answer"
  | "type_mismatch"
  | "invalid_value";

export type NormalizeResult =
  | { ok: true; answers: NormalizedAnswer[] }
  | { ok: false; code: NormalizeErrorCode; key?: string };

export type NoulReading = "positive" | "negative" | "unmapped";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function probabilitiesFor(raw: unknown, options: string[]): Record<string, number> | undefined | null {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) return null;
  const keys = Object.keys(raw);
  if (keys.length !== options.length || !options.every((o) => Object.hasOwn(raw, o))) return null;
  const out: Record<string, number> = {};
  for (const k of options) {
    const p = raw[k];
    if (!isNum(p) || p < 0 || p > 1) return null;
    out[k] = p;
  }
  return out;
}

export function normalizeAnswers(
  answers: unknown,
  questions: Record<string, JevQuestion>,
): NormalizeResult {
  if (!isRecord(answers)) return { ok: false, code: "invalid_answers" };
  for (const key of Object.keys(answers)) {
    if (!Object.hasOwn(questions, key)) return { ok: false, code: "unexpected_answer", key };
  }
  const out: NormalizedAnswer[] = [];
  for (const [key, q] of Object.entries(questions)) {
    const a = answers[key];
    if (a === undefined) return { ok: false, code: "missing_answer", key };
    if (!isRecord(a) || a.type !== q.type) return { ok: false, code: "type_mismatch", key };
    if (q.type === "noul") {
      if (!isNum(a.noul)) return { ok: false, code: "invalid_value", key };
      out.push({ key, type: "noul", value: a.noul });
    } else if (q.type === "choice") {
      const options = Object.keys(q.criteria);
      if (typeof a.choice !== "string" || !options.includes(a.choice)) {
        return { ok: false, code: "invalid_value", key };
      }
      const probabilities = probabilitiesFor(a.probabilities, options);
      if (probabilities === null) return { ok: false, code: "invalid_value", key };
      const n: NormalizedAnswer = { key, type: "choice", value: a.choice };
      if (probabilities) n.probabilities = probabilities;
      out.push(n);
    } else if (q.type === "score") {
      const indices = q.criteria.map((_, i) => String(i));
      if (!isNum(a.score) || a.score < 0 || a.score > indices.length - 1) {
        return { ok: false, code: "invalid_value", key };
      }
      const probabilities = probabilitiesFor(a.probabilities, indices);
      if (probabilities === null) return { ok: false, code: "invalid_value", key };
      const n: NormalizedAnswer = { key, type: "score", value: a.score };
      if (probabilities) n.probabilities = probabilities;
      out.push(n);
    } else {
      return { ok: false, code: "type_mismatch", key };
    }
  }
  return { ok: true, answers: out };
}

// docs/jev-contract.md belegt weder Skala noch Schwelle fuer noul: fail-closed.
export function interpretNoul(_answer: NormalizedAnswer): NoulReading {
  return "unmapped";
}
