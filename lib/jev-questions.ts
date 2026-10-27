import type {
  DecisionsChoiceQuestion,
  DecisionsNoulQuestion,
  DecisionsScoreQuestion,
} from "@openrouter/sdk/models";
import { EXCERPT_MAX_CHARS, QUESTION_SET_VERSION, QUESTION_SET_VERSION_V1, QUESTION_SET_VERSION_V2 } from "./constants.ts";

export { QUESTION_SET_VERSION };

export type JevQuestion = DecisionsNoulQuestion | DecisionsChoiceQuestion | DecisionsScoreQuestion;

function noul(instructions: string, falseText: string, trueText: string): DecisionsNoulQuestion {
  return { type: "noul", instructions, criteria: { false: falseText, true: trueText } };
}

/** Question set `email-classification-v1`. Frozen: stored v1 answers and the v1 calibration refer to these texts. */
const QUESTIONS_V1: Record<string, JevQuestion> = {
  is_spam: noul(
    "Is this an unsolicited mass or promotional mail or junk that the recipient never requested?",
    "The mail is wanted, personal, transactional or otherwise requested by the recipient.",
    "The mail is unsolicited bulk, advertising or junk the recipient did not ask for.",
  ),
  is_phishing_or_scam: noul(
    "Does the mail try to trick the recipient into giving up credentials, paying, or clicking (fake bank, parcel or account mails, invoice fraud, impersonation)?",
    "The mail shows no attempt to deceive the recipient about credentials, payment or links.",
    "The mail tries to deceive the recipient into revealing credentials, paying or clicking.",
  ),
  addresses_an_ai: noul(
    "Does the text address an AI assistant or agent, or contain instructions aimed at one (prompt injection indicator)?",
    "The text is written for a human recipient only.",
    "The text addresses an AI assistant or agent or contains instructions meant for one.",
  ),
  needs_my_reply: noul(
    "Does the mail expect a reply or action from the recipient (question, request, deadline, appointment)?",
    "No reply or action is expected from the recipient.",
    "A reply or action from the recipient is expected.",
  ),
  is_assessable: noul(
    "Is there enough readable content to judge this mail reliably?",
    "The content is empty, truncated, unreadable or in an unsupported language.",
    "The content is readable and sufficient for a reliable judgement.",
  ),
  category: {
    type: "choice",
    instructions: "Which category best describes this mail?",
    criteria: {
      spam: "Unsolicited junk or scam mail.",
      newsletter_promo: "Newsletters, marketing and promotions the sender distributes in bulk.",
      transactional: "Receipts, shipping notices, invoices and other automatic transaction mails.",
      security_auth: "Login codes, password resets and security warnings.",
      personal: "Personal correspondence from a private individual.",
      business: "Professional or business correspondence.",
      unclear: "Cannot be categorised reliably.",
    },
  },
  route: {
    type: "choice",
    instructions: "How should this mail be handled? This is only a suggestion.",
    criteria: {
      ignore: "Nothing to do; can be ignored.",
      digest: "Include in a periodic summary.",
      notify: "Notify the recipient soon.",
      draft_reply: "A reply should be prepared for the recipient.",
    },
  },
  urgency: {
    type: "score",
    instructions: "How urgent is this mail for the recipient?",
    criteria: [
      "No deadline, can wait",
      "This week",
      "Within 48 hours",
      "Today or blocking",
    ],
  },
  importance: {
    type: "score",
    instructions: "How important is this mail for the recipient?",
    criteria: [
      "Routine",
      "Useful, not critical",
      "Significant personal, financial or legal consequence",
      "Critical for security, health or legal matters",
    ],
  },
};

/**
 * Question set `email-classification-v2` (T26): same keys and types as v1, same categories (folders follow in M4),
 * but a sharper `needs_my_reply` (personal request, not marketing) and an `is_phishing_or_scam` that separates
 * legitimate security mails. No `is_personal_correspondence`: no consumer exists yet, category `personal` covers it,
 * and every extra noul question needs its own calibration. Not calibrated: all noul answers stay `unmapped`
 * (config/noul-calibration.ts is bound to v1).
 */
const QUESTIONS_V2: Record<string, JevQuestion> = {
  ...QUESTIONS_V1,
  is_phishing_or_scam: noul(
    "Does the mail try to trick the recipient into giving up credentials, paying, or clicking (fake bank, parcel or account mails, invoice fraud, impersonation)? " +
      "Legitimate security mails are not phishing: a login code or password reset the recipient requested, or a security notice that asks for neither payment nor a login through a link.",
    "The mail shows no attempt to deceive the recipient. This includes genuine security mails: a login code or password reset the recipient requested, or a security notice that asks for neither payment nor a login through a link.",
    "The mail tries to deceive the recipient into revealing credentials, paying or clicking, for example a fake login or parcel page, a fake or altered invoice, or impersonation.",
  ),
  needs_my_reply: noul(
    "Does a person, or an organisation the recipient has a genuine relationship with, address the recipient personally with a request, question or deadline that needs the recipient's own answer or action? " +
      "Marketing calls to action (\"reply now\", \"buy now\", \"subscribe\"), newsletter prompts and automatic notifications do not count.",
    "No personal request, question or deadline is directed at the recipient. Marketing calls to action, newsletter prompts, automatic notifications, receipts and purely informational mails do not need a reply.",
    "A person, or an organisation with a genuine relationship to the recipient, personally asks the recipient for an answer, a decision or an action, or sets a deadline.",
  ),
};

export const QUESTION_SET_VERSIONS = [QUESTION_SET_VERSION_V1, QUESTION_SET_VERSION_V2] as const;

/** Question set by explicit version. Unknown versions throw: callers never fall back silently. */
export function questionsFor(version: string): Record<string, JevQuestion> {
  // Map instead of obj[key]: the Veryfront API loader rejects reads with a dynamic key.
  const found = new Map<string, Record<string, JevQuestion>>([
    [QUESTION_SET_VERSION_V1, QUESTIONS_V1],
    [QUESTION_SET_VERSION_V2, QUESTIONS_V2],
  ]).get(version);
  if (!found) throw new Error("question_set_unknown");
  return found;
}

/** Question set for new classifications: follows QUESTION_SET_VERSION (v1 until the switch documented there). */
export const QUESTIONS: Record<string, JevQuestion> = questionsFor(QUESTION_SET_VERSION);

export const STATE_KEYS = [
  "account_context",
  "sender_domain",
  "spf",
  "dkim",
  "dmarc",
  "list_unsubscribe_present",
  "reply_to_differs_from_from",
  "sender_history",
  "untrusted_subject",
  "untrusted_body",
] as const;

const UNTRUSTED_KEYS = new Set<string>(["untrusted_subject", "untrusted_body"]);
const SENDER_HISTORY_KEYS = new Set<string>(["mails_seen_from_sender", "days_since_first_seen"]);
const SHORT_TEXT_MAX = 255;

export type JevStateInput = {
  account_context?: string;
  sender_domain?: string;
  spf?: string;
  dkim?: string;
  dmarc?: string;
  list_unsubscribe_present?: boolean;
  reply_to_differs_from_from?: boolean;
  sender_history?: { mails_seen_from_sender?: number; days_since_first_seen?: number };
  untrusted_subject?: string;
  untrusted_body?: string;
};

export function buildState(input: JevStateInput): Record<string, unknown> {
  const allowed = new Set<string>(STATE_KEYS);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!allowed.has(key)) throw new Error(`state key not allowed: ${key}`);
    if (value === undefined) continue;
    if (UNTRUSTED_KEYS.has(key)) {
      if (typeof value !== "string") throw new Error(`state value must be string: ${key}`);
      out[key] = value.slice(0, EXCERPT_MAX_CHARS);
    } else if (key === "sender_history") {
      if (typeof value !== "object" || value === null) throw new Error(`invalid state value: ${key}`);
      const hist: Record<string, number> = {};
      for (const [hk, hv] of Object.entries(value)) {
        if (!SENDER_HISTORY_KEYS.has(hk)) throw new Error(`sender_history key not allowed: ${hk}`);
        if (typeof hv !== "number" || !Number.isFinite(hv)) throw new Error(`sender_history value invalid: ${hk}`);
        hist[hk] = hv;
      }
      out[key] = hist;
    } else if (typeof value === "boolean") {
      out[key] = value;
    } else if (typeof value === "string" && value.length <= SHORT_TEXT_MAX) {
      out[key] = value;
    } else {
      throw new Error(`invalid state value: ${key}`);
    }
  }
  return out;
}
