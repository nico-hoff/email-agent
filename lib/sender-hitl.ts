// Human-in-the-loop for senders (Plan v5, E7/E8): after three Jev spam verdicts for one sender the app asks Nico once
// whether to blacklist or allowlist it permanently, as a single address or as a whole domain. The decision itself is a
// row in sender_rules (lib/sender-rules.ts); this module only finds the questions. Numbers, addresses and ids only.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { QUESTION_SET_VERSION } from "./constants.ts";
import { interpretNoul } from "./jev-response.ts";
import { isValidDomain, type RuleMatch } from "./sender-rules.ts";
import { isFreemailDomain, splitSender } from "./senders.ts";

/** Jev spam verdicts (per address, or summed per domain) that trigger the question. */
export const HITL_MIN_SPAM = 3;
/** A domain is proposed instead of an address when the verdicts come from at least this many addresses of it. */
export const HITL_MIN_DOMAIN_ADDRESSES = 2;
export const HITL_SAMPLE_IDS = 3;

export interface HitlSender {
  address: string;
  domain: string;
  mails_seen: number;
  dmarc_pass: number;
  jev_spam_count: number;
  hitl_asked_count: number;
}

export interface HitlRule {
  kind: "blacklist" | "allowlist";
  match: RuleMatch;
  value: string;
}

export interface HitlCandidate {
  key: string;
  match: RuleMatch;
  value: string;
  jev_spam_count: number;
  mails_seen: number;
  /** Share of this sender's mails with DMARC pass (0..1), null when no mail was counted. */
  dmarc_pass_rate: number | null;
}

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

function candidate(match: RuleMatch, value: string, rows: readonly HitlSender[]): HitlCandidate {
  const seen = sum(rows.map((r) => r.mails_seen));
  return {
    key: `${match}:${value}`,
    match,
    value,
    jev_spam_count: sum(rows.map((r) => r.jev_spam_count)),
    mails_seen: seen,
    dmarc_pass_rate: seen === 0 ? null : sum(rows.map((r) => r.dmarc_pass)) / seen,
  };
}

/**
 * Pure. Senders already covered by an active rule (either kind, any account) are not asked about: neither the
 * address with its own rule nor any address of a ruled domain, and a ruled address no longer counts for its domain.
 * A sender or domain is asked again only after further verdicts since the last question (`hitl_asked_count`).
 */
export function hitlCandidates(senders: readonly HitlSender[], rules: readonly HitlRule[]): HitlCandidate[] {
  const ruledDomains = new Set(rules.filter((r) => r.match === "domain").map((r) => r.value));
  const ruledAddresses = new Set(rules.filter((r) => r.match === "address").map((r) => r.value));
  const byDomain = new Map<string, HitlSender[]>();
  for (const s of senders) {
    if (ruledDomains.has(s.domain) || ruledAddresses.has(s.address)) continue;
    byDomain.set(s.domain, [...(byDomain.get(s.domain) ?? []), s]);
  }
  const out: HitlCandidate[] = [];
  for (const [domain, group] of byDomain) {
    const spammers = group.filter((s) => s.jev_spam_count > 0);
    const total = sum(spammers.map((s) => s.jev_spam_count));
    if (!isFreemailDomain(domain) && spammers.length >= HITL_MIN_DOMAIN_ADDRESSES && total >= HITL_MIN_SPAM) {
      if (total > sum(spammers.map((s) => s.hitl_asked_count))) out.push(candidate("domain", domain, group));
      continue;
    }
    for (const s of spammers) {
      if (s.jev_spam_count >= HITL_MIN_SPAM && s.jev_spam_count > s.hitl_asked_count) out.push(candidate("address", s.address, [s]));
    }
  }
  return out.sort((a, b) => b.jev_spam_count - a.jev_spam_count || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export interface HitlItem extends HitlCandidate {
  sample_email_ids: number[];
}

/**
 * The newest mails of the sender or domain that Jev judged as spam (is_spam positive under the calibration), so that
 * Nico can open an example before deciding. Ids only.
 */
export function sampleEmailIds(db: DatabaseSync, userId: number, match: RuleMatch, value: string, limit = HITL_SAMPLE_IDS): number[] {
  const where = match === "address"
    ? "lower(e.sender) = ?"
    : "substr(lower(e.sender), instr(lower(e.sender), '@') + 1) = ?";
  const rows = db.prepare(
    `SELECT e.id AS id, c.question_set_version AS version, a.answer_json AS answer
     FROM emails e
     JOIN accounts acc ON acc.id = e.account_id
     JOIN classifications c ON c.id = (SELECT MAX(id) FROM classifications WHERE email_id = e.id AND status = 'classified')
     JOIN classification_answers a ON a.classification_id = c.id AND a.question_key = 'is_spam' AND a.type = 'noul'
     WHERE acc.user_id = ? AND ${where}
     ORDER BY e.received_at DESC, e.id DESC LIMIT 200`,
  ).all(userId, value) as { id: number; version: string; answer: string }[];
  const ids: number[] = [];
  for (const r of rows) {
    let v: unknown;
    try {
      v = (JSON.parse(r.answer) as { value?: unknown }).value;
    } catch {
      continue;
    }
    if (typeof v !== "number") continue;
    if (interpretNoul({ key: "is_spam", type: "noul", value: v }, r.version) === "positive") ids.push(r.id);
    if (ids.length >= limit) break;
  }
  return ids;
}

export function listHitl(db: DatabaseSync, userId: number): HitlItem[] {
  const senders = db.prepare(
    `SELECT address, domain, mails_seen, dmarc_pass, jev_spam_count, hitl_asked_count FROM senders
     WHERE user_id = ? AND domain IN (SELECT domain FROM senders WHERE user_id = ? AND jev_spam_count > 0)`,
  ).all(userId, userId) as unknown as HitlSender[];
  const rules = db.prepare("SELECT kind, match, value FROM sender_rules WHERE user_id = ? AND active = 1").all(userId) as unknown as HitlRule[];
  return hitlCandidates(senders.map((s) => ({ ...s })), rules.map((r) => ({ ...r })))
    .map((c) => ({ ...c, sample_email_ids: sampleEmailIds(db, userId, c.match, c.value) }));
}

export type DismissResult = { ok: true; changed: boolean } | { ok: false; code: "invalid_value" | "not_found" };

/** "Not now": remembers that Nico was asked at the current count. The question returns after further verdicts. */
export function dismissHitl(db: DatabaseSync, userId: number, match: RuleMatch, rawValue: string, ts: string): DismissResult {
  const value = rawValue.trim().toLowerCase();
  const key = match === "address" ? splitSender(value)?.address : isValidDomain(value) ? value : undefined;
  if (key === undefined) return { ok: false, code: "invalid_value" };
  const col = match === "address" ? "address = ?" : "domain = ?";
  // Only this user's sender rows are looked at and changed; another user's sender is "not_found".
  db.exec("BEGIN IMMEDIATE");
  try {
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM senders WHERE user_id = ? AND ${col}`).get(userId, key) as { n: number }).n;
    if (n === 0) {
      db.exec("ROLLBACK");
      return { ok: false, code: "not_found" };
    }
    const res = db.prepare(
      `UPDATE senders SET hitl_asked_at = ?, hitl_asked_count = jev_spam_count
       WHERE user_id = ? AND ${col} AND hitl_asked_count <> jev_spam_count`,
    ).run(ts, userId, key);
    const changed = Number(res.changes) > 0;
    if (changed) {
      db.prepare(
        `INSERT INTO audit_log (occurred_at, trace_id, actor, action, account_id, email_id, user_id, details_json)
         VALUES (?, ?, 'system', 'sender_hitl_dismissed', NULL, NULL, ?, ?)`,
      ).run(ts, randomUUID(), userId, JSON.stringify({ source: "nico", match }));
    }
    db.exec("COMMIT");
    return { ok: true, changed };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
