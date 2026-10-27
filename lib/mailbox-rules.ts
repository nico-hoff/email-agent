// Rule engine for automatic mailbox actions (Plan v5, 3.4). Pure function: no database, no IMAP, no clock.
// M7a knows one rule, "Spam gelesen" (E12): only \Seen, nothing is moved. Protection is checked first (H17).
import { interpretNoul, type NoulInterpreter, type NormalizedAnswer } from "./jev-response.ts";

/** Categories (Jev choice question `category`) that never get an automatic action. */
export const PROTECTED_CATEGORIES: readonly string[] = ["security_auth", "transactional"];

export type RuleReason =
  | "protected_category"
  | "allowlisted"
  | "already_seen"
  | "jev_spam"
  | "provider_spam"
  | "not_spam"
  | "no_signal";

export interface RuleDecision {
  action: "mark_seen" | "none";
  reason: RuleReason;
}

export interface RuleInput {
  /** Normalized answers of the latest classified run (may be empty or incomplete). */
  answers: NormalizedAnswer[];
  /** Question set version of that run; the calibration is looked up per version. */
  questionSetVersion: string;
  /** The mail's active location is the provider's spam folder (accounts.spam_mailbox). */
  inProviderSpam: boolean;
  /** Provider \Seen flag as last read. */
  seen: boolean;
  /** Placeholder for the sender allowlist (M5): a hit protects the mail. Until M5 the caller passes nothing. */
  allowlisted?: boolean;
  interpret?: NoulInterpreter;
}

/**
 * Order: protection (category, allowlist) -> already read -> Jev is_spam positive -> provider spam folder.
 *
 * Fail-closed: a missing or unmapped is_spam (no answer, unknown question set, not a finite number) never triggers
 * the Jev branch. The single documented exception is the provider spam folder: there the provider already judged the
 * mail, and anything but an explicit Jev "negative" (below the calibrated threshold) is enough. A missing category
 * cannot protect a mail; the protection only applies to a category that was actually answered.
 */
export function decideSpamSeen(i: RuleInput): RuleDecision {
  const category = i.answers.find((a) => a.key === "category" && a.type === "choice");
  if (category && typeof category.value === "string" && PROTECTED_CATEGORIES.includes(category.value)) {
    return { action: "none", reason: "protected_category" };
  }
  if (i.allowlisted === true) return { action: "none", reason: "allowlisted" };
  if (i.seen) return { action: "none", reason: "already_seen" };

  const interpret = i.interpret ?? interpretNoul;
  const spam = i.answers.find((a) => a.key === "is_spam");
  const reading = spam ? interpret(spam, i.questionSetVersion) : "unmapped";
  if (reading === "positive") return { action: "mark_seen", reason: "jev_spam" };
  if (reading === "negative") return { action: "none", reason: "not_spam" };
  if (i.inProviderSpam) return { action: "mark_seen", reason: "provider_spam" };
  return { action: "none", reason: "no_signal" };
}
