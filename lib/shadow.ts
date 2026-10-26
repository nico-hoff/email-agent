import { interpretNoul, type NoulReading, type NormalizedAnswer } from "./jev-response.ts";

export type ShadowReason =
  | "unmapped_answer"
  | "not_spam"
  | "below_threshold"
  | "needs_reply"
  | "not_assessable"
  | "candidate";

export interface ShadowInputs {
  is_spam: number | null;
  needs_my_reply: number | null;
  is_assessable: number | null;
  /** Raw category answer (D11): recorded, never used as a decision input. */
  category: string | null;
}

export interface ShadowQuarantine {
  candidate: boolean;
  decision: "pending_policy" | "no";
  applied_threshold: number;
  inputs: ShadowInputs;
  reason: ShadowReason;
}

type Interpreter = (answer: NormalizedAnswer) => NoulReading;

/**
 * Pure shadow rule. candidate = is_spam positive AND spam value >= threshold
 * AND needs_my_reply negative AND is_assessable positive. Any unmapped or missing
 * input yields candidate=false (unmapped_answer); no arbitrary cut-offs.
 * The threshold is the account's configured spam_threshold, never read from the DB.
 */
export function computeShadowQuarantine(
  answers: NormalizedAnswer[],
  spamThreshold: number,
  interpret: Interpreter = interpretNoul,
): ShadowQuarantine {
  const by = new Map(answers.map((a) => [a.key, a]));
  const num = (k: string): number | null => {
    const a = by.get(k);
    return a && a.type === "noul" && typeof a.value === "number" ? a.value : null;
  };
  const cat = by.get("category");
  const inputs: ShadowInputs = {
    is_spam: num("is_spam"),
    needs_my_reply: num("needs_my_reply"),
    is_assessable: num("is_assessable"),
    category: cat && typeof cat.value === "string" ? cat.value : null,
  };
  const out = (candidate: boolean, reason: ShadowReason): ShadowQuarantine => ({
    candidate, decision: candidate ? "pending_policy" : "no", applied_threshold: spamThreshold, inputs, reason,
  });

  const read = (k: string): NoulReading => {
    const a = by.get(k);
    return a && a.type === "noul" && inputs[k as "is_spam"] !== null ? interpret(a) : "unmapped";
  };
  const spam = read("is_spam");
  const reply = read("needs_my_reply");
  const assessable = read("is_assessable");
  if (spam === "unmapped" || reply === "unmapped" || assessable === "unmapped") return out(false, "unmapped_answer");
  if (spam !== "positive") return out(false, "not_spam");
  if ((inputs.is_spam as number) < spamThreshold) return out(false, "below_threshold");
  if (reply !== "negative") return out(false, "needs_reply");
  if (assessable !== "positive") return out(false, "not_assessable");
  return out(true, "candidate");
}
