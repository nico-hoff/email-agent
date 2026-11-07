// Browser side of the sender routes (T54, E7/E8): open HITL questions, rules, create, dismiss, deactivate. Addresses,
// domains, counts and ids only. Types are repeated here on purpose: the server modules use node:sqlite and must not
// be bundled into the browser.
import { commonReason, postApi, readJson, type CommonReason } from "./api-post.ts";
import type { MutationDeps } from "./mutate-client.ts";

export type RuleMatch = "address" | "domain";
export type RuleKind = "blacklist" | "allowlist";

export interface HitlCandidate {
  key: string;
  match: RuleMatch;
  value: string;
  jev_spam_count: number;
  mails_seen: number;
  dmarc_pass_rate: number | null;
  sample_email_ids: number[];
}

export interface SenderRule {
  id: number;
  kind: RuleKind;
  match: RuleMatch;
  value: string;
  account_id: string | null;
  source: string;
  active: 0 | 1;
  created_at: string;
}

export type SenderReason = CommonReason | "freemail_domain" | "invalid_value" | "unknown_account";

export const SENDER_ERROR_TEXT: Record<SenderReason, string> = {
  rate_limited: "Zu viele Aktionen. Bitte kurz warten.",
  forbidden: "Nicht angemeldet. Bitte die App neu öffnen.",
  not_found: "Diese Regel gibt es nicht mehr.",
  failed: "Das konnte nicht gespeichert werden.",
  freemail_domain: "Für Freemail-Anbieter wie gmail.com oder web.de gibt es keine Domain-Regel, sie würde Millionen fremder Absender treffen. Bitte die einzelne Adresse eintragen.",
  invalid_value: "Das ist keine gültige Adresse oder Domain.",
  unknown_account: "Dieses Konto ist unbekannt.",
};

export const HITL_VISIBLE = 2;

export function hitlTitle(c: Pick<HitlCandidate, "match" | "value" | "jev_spam_count">): string {
  const who = c.match === "domain" ? `Die Domain ${c.value}` : `Der Absender ${c.value}`;
  return `${who} wurde ${c.jev_spam_count}× als Spam erkannt`;
}

/** A quiet hint on the card; null when no mail carried a DMARC result. */
export function dmarcText(rate: number | null): string | null {
  return rate === null || !Number.isFinite(rate) ? null : `DMARC bei ${Math.round(rate * 100)} % der Mails bestanden`;
}

export function splitCandidates<T>(list: readonly T[]): { shown: T[]; rest: T[] } {
  return { shown: list.slice(0, HITL_VISIBLE), rest: list.slice(HITL_VISIBLE) };
}

/** Free text in the rule form: an "@" means a single address, anything else a domain. */
export function guessMatch(input: string): RuleMatch {
  return input.includes("@") ? "address" : "domain";
}

export const KIND_LABEL: Record<RuleKind, string> = { blacklist: "Immer aussortieren", allowlist: "Nie aussortieren" };

async function getList(url: string, key: string, fetcher: typeof fetch): Promise<unknown[]> {
  const r = await fetcher(url, { cache: "no-store" });
  if (r.status === 401 || r.status === 403) throw new Error("session");
  if (!r.ok) throw new Error("unavailable");
  const list = (await readJson(r))[key];
  if (!Array.isArray(list)) throw new Error("unavailable");
  return list;
}

export async function fetchHitl(fetcher: typeof fetch = fetch): Promise<HitlCandidate[]> {
  return (await getList("/api/senders/hitl", "candidates", fetcher)) as HitlCandidate[];
}

export async function fetchRules(fetcher: typeof fetch = fetch): Promise<SenderRule[]> {
  return (await getList("/api/senders/rules", "rules", fetcher)) as SenderRule[];
}

export type SenderResult = { ok: true } | { ok: false; reason: SenderReason };

async function send(path: string, deps: MutationDeps, body?: unknown): Promise<SenderResult> {
  const raw = await postApi(path, deps, { body });
  if (raw.kind !== "response") return { ok: false, reason: raw.kind };
  const r = raw.response;
  const common = commonReason(r);
  if (common) return { ok: false, reason: common.reason };
  if (r.ok) return { ok: true };
  const code = (await readJson(r)).error;
  if (code === "freemail_domain" || code === "invalid_value" || code === "unknown_account") return { ok: false, reason: code };
  return { ok: false, reason: "failed" };
}

export function postRule(rule: { match: RuleMatch; value: string; kind: RuleKind; account_id?: string }, deps: MutationDeps): Promise<SenderResult> {
  return send("/api/senders/rules", deps, rule);
}

export function postDismiss(target: { match: RuleMatch; value: string }, deps: MutationDeps): Promise<SenderResult> {
  return send("/api/senders/hitl/dismiss", deps, { match: target.match, value: target.value });
}

export function postDeactivate(id: number, deps: MutationDeps): Promise<SenderResult> {
  return send(`/api/senders/rules/${id}/deactivate`, deps);
}
