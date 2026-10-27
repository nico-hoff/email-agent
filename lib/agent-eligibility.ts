import { interpretNoul, type NoulInterpreter, type NormalizedAnswer } from "./jev-response.ts";

export type AgentBlockReason = "missing_answer" | "addresses_an_ai" | "security_auth" | "not_assessable";

export type AgentEligibility = { eligible: true } | { eligible: false; reasons: AgentBlockReason[] };

/**
 * D18/H11: the only gate in front of the reply agent. Pure, fail-closed.
 * Blocks unless addresses_an_ai is clearly negative (positive and unmapped both block),
 * when the top category is security_auth, when is_assessable is negative, and when
 * any of these three answers is missing. questionSetVersion is the one of the classification; without it the
 * default interpreter maps nothing and every mail is blocked.
 */
export function agentEligibility(
  answers: NormalizedAnswer[],
  interpret: NoulInterpreter = interpretNoul,
  questionSetVersion?: string,
): AgentEligibility {
  const by = new Map(answers.map((a) => [a.key, a]));
  const ai = by.get("addresses_an_ai");
  const assessable = by.get("is_assessable");
  const category = by.get("category");

  const reasons: AgentBlockReason[] = [];
  const isNoul = (a: NormalizedAnswer | undefined) => a !== undefined && a.type === "noul" && typeof a.value === "number";
  if (!isNoul(ai) || !isNoul(assessable) || category === undefined || category.type !== "choice") {
    reasons.push("missing_answer");
  }
  if (isNoul(ai) && interpret(ai!, questionSetVersion) !== "negative") reasons.push("addresses_an_ai");
  if (category?.type === "choice" && category.value === "security_auth") reasons.push("security_auth");
  if (isNoul(assessable) && interpret(assessable!, questionSetVersion) === "negative") reasons.push("not_assessable");

  return reasons.length === 0 ? { eligible: true } : { eligible: false, reasons };
}
