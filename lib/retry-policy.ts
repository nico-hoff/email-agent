import { JEV_RETRY_BACKOFF_MAX_MS, JEV_RETRY_BACKOFF_MIN_MS } from "./constants.ts";
import type { JevCallResult } from "./jev.ts";

export type FailureDecision =
  | { action: "retry"; failureCode: string }
  | { action: "fail"; failureCode: string }
  | { action: "pause"; failureCode: string };

/** Statuses that are expected to recover on their own. */
const TRANSIENT_STATUS: ReadonlySet<number> = new Set([429, 500, 502, 503, 524, 529]);
/** Credentials/credit problems: retrying cannot help and would burn calls; stop until manual restart. */
const PAUSE_STATUS: ReadonlySet<number> = new Set([401, 402]);

/**
 * Explicit rules:
 * - 401/402 -> pause; 429/500/502/503/524/529 -> retry; every other HTTP status -> fail (http_<status>).
 * - Transport failures (no HTTP status: network error, timeout, empty/invalid result) -> transient (retry),
 *   bounded by JEV_MAX_ATTEMPTS like every other retry.
 * This is the only retry layer: the SDK client is configured with { strategy: "none" }.
 */
export function classifyFailure(result: Extract<JevCallResult, { ok: false }>): FailureDecision {
  if (result.kind === "transport" || result.statusCode === undefined) {
    return { action: "retry", failureCode: "transport" };
  }
  const s = result.statusCode;
  if (PAUSE_STATUS.has(s)) return { action: "pause", failureCode: `http_${s}` };
  if (TRANSIENT_STATUS.has(s)) return { action: "retry", failureCode: `http_${s}` };
  return { action: "fail", failureCode: `http_${s}` };
}

/** Deterministic exponential backoff for the n-th failed attempt (n >= 1): 30 s, 60 s, ... capped at 900 s. */
export function backoffMs(failedAttempts: number): number {
  const exp = Math.max(0, failedAttempts - 1);
  return Math.min(JEV_RETRY_BACKOFF_MAX_MS, JEV_RETRY_BACKOFF_MIN_MS * 2 ** Math.min(exp, 30));
}
