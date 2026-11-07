// Sender rules (Plan v5, 3.3, docs/erd.md decision 17): Nico's permanent blacklist and allowlist per address or domain,
// optionally per account. Pure SQLite; nothing here touches a mailbox. Matching is exact (address or domain, no
// subdomains) so that a rule never reaches further than Nico typed it.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isFreemailDomain, splitSender } from "./senders.ts";

export const RULE_KINDS = ["blacklist", "allowlist"] as const;
export const RULE_MATCHES = ["address", "domain"] as const;
export type RuleKind = (typeof RULE_KINDS)[number];
export type RuleMatch = (typeof RULE_MATCHES)[number];

export interface SenderRule {
  id: number;
  kind: RuleKind;
  match: RuleMatch;
  value: string;
  account_id: string | null;
  source: "nico" | "suggested_confirmed";
  active: 0 | 1;
  created_at: string;
}

const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function isValidDomain(domain: string): boolean {
  return DOMAIN.test(domain);
}

/** Canonical rule value (lower case) or the reason it is refused. */
export function normalizeRuleValue(
  match: RuleMatch,
  raw: string,
): { ok: true; value: string } | { ok: false; code: "invalid_value" | "freemail_domain" } {
  const v = raw.trim().toLowerCase();
  if (match === "address") {
    const s = splitSender(v);
    return s && isValidDomain(s.domain) ? { ok: true, value: s.address } : { ok: false, code: "invalid_value" };
  }
  if (!isValidDomain(v)) return { ok: false, code: "invalid_value" };
  // A rule on "all of gmail.com" would reach millions of unrelated senders.
  if (isFreemailDomain(v)) return { ok: false, code: "freemail_domain" };
  return { ok: true, value: v };
}

const COLUMNS = "id, kind, match, value, account_id, source, active, created_at";

function audit(db: DatabaseSync, action: string, ts: string, userId: number, accountId: string | null, details: Record<string, unknown>): void {
  // `actor = 'nico'` needs a rebuild of the append-only audit_log; the origin is recorded in the details (docs/erd.md 18).
  db.prepare(
    `INSERT INTO audit_log (occurred_at, trace_id, actor, action, account_id, email_id, user_id, details_json)
     VALUES (?, ?, 'system', ?, ?, NULL, ?, ?)`,
  ).run(ts, randomUUID(), action, accountId, userId, JSON.stringify({ source: "nico", ...details }));
}

export type CreateRuleResult =
  | { ok: true; rule: SenderRule; changed: boolean; deactivated: number[] }
  | { ok: false; code: "invalid_value" | "freemail_domain" | "unknown_account" };

/**
 * Creates (or re-activates) a rule. One verdict per target: an active rule of the other kind for the same
 * match, value and account is switched off in the same transaction.
 */
export function createRule(
  db: DatabaseSync,
  userId: number,
  i: { kind: RuleKind; match: RuleMatch; value: string; accountId?: string | null | undefined; ts: string },
): CreateRuleResult {
  const norm = normalizeRuleValue(i.match, i.value);
  if (!norm.ok) return norm;
  const accountId = i.accountId ?? null;
  // An account of another user is "unknown" (same answer as a missing one); the composite FK backs this up in the schema.
  if (accountId !== null && db.prepare("SELECT 1 FROM accounts WHERE id = ? AND user_id = ?").get(accountId, userId) === undefined) {
    return { ok: false, code: "unknown_account" };
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    const find = (kind: RuleKind) =>
      db.prepare(
        `SELECT ${COLUMNS} FROM sender_rules WHERE user_id = ? AND kind = ? AND match = ? AND value = ? AND COALESCE(account_id, '') = ?`,
      ).get(userId, kind, i.match, norm.value, accountId ?? "") as SenderRule | undefined;
    const opposite = find(i.kind === "blacklist" ? "allowlist" : "blacklist");
    const deactivated: number[] = [];
    if (opposite && opposite.active === 1) {
      db.prepare("UPDATE sender_rules SET active = 0 WHERE id = ? AND user_id = ?").run(opposite.id, userId);
      audit(db, "sender_rule_deactivated", i.ts, userId, accountId, { rule_id: opposite.id, kind: opposite.kind, match: opposite.match, reason: "replaced" });
      deactivated.push(opposite.id);
    }
    const existing = find(i.kind);
    let changed = true;
    let id: number;
    if (existing) {
      id = existing.id;
      if (existing.active === 1) changed = false;
      else db.prepare("UPDATE sender_rules SET active = 1 WHERE id = ? AND user_id = ?").run(id, userId);
    } else {
      const res = db.prepare(
        `INSERT INTO sender_rules (user_id, kind, match, value, account_id, source, active, created_at) VALUES (?, ?, ?, ?, ?, 'nico', 1, ?)`,
      ).run(userId, i.kind, i.match, norm.value, accountId, i.ts);
      id = Number(res.lastInsertRowid);
    }
    if (changed) audit(db, "sender_rule_created", i.ts, userId, accountId, { rule_id: id, kind: i.kind, match: i.match });
    const rule = db.prepare(`SELECT ${COLUMNS} FROM sender_rules WHERE id = ? AND user_id = ?`).get(id, userId) as unknown as SenderRule;
    db.exec("COMMIT");
    return { ok: true, rule: { ...rule }, changed, deactivated };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export type DeactivateResult = { ok: true; rule: SenderRule; changed: boolean } | { ok: false; code: "not_found" };

export function deactivateRule(db: DatabaseSync, userId: number, id: number, ts: string): DeactivateResult {
  db.exec("BEGIN IMMEDIATE");
  try {
    // A rule of another user is "not_found" and stays untouched.
    const rule = db.prepare(`SELECT ${COLUMNS} FROM sender_rules WHERE id = ? AND user_id = ?`).get(id, userId) as SenderRule | undefined;
    if (!rule) {
      db.exec("ROLLBACK");
      return { ok: false, code: "not_found" };
    }
    let changed = false;
    if (rule.active === 1) {
      db.prepare("UPDATE sender_rules SET active = 0 WHERE id = ? AND user_id = ?").run(id, userId);
      audit(db, "sender_rule_deactivated", ts, userId, rule.account_id, { rule_id: id, kind: rule.kind, match: rule.match });
      changed = true;
    }
    const after = db.prepare(`SELECT ${COLUMNS} FROM sender_rules WHERE id = ? AND user_id = ?`).get(id, userId) as unknown as SenderRule;
    db.exec("COMMIT");
    return { ok: true, rule: { ...after }, changed };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function listRules(db: DatabaseSync, userId: number, o: { includeInactive?: boolean } = {}): SenderRule[] {
  const where = o.includeInactive ? "WHERE user_id = ?" : "WHERE user_id = ? AND active = 1";
  return (db.prepare(`SELECT ${COLUMNS} FROM sender_rules ${where} ORDER BY id`).all(userId) as unknown as SenderRule[]).map((r) => ({ ...r }));
}

export interface SenderRuleHit {
  allowlisted: boolean;
  blacklisted: boolean;
}

/** Active rules that apply to a mail from `sender` in `accountId`: exact address or exact domain; global or this account. */
export function senderRuleHit(db: DatabaseSync, userId: number, sender: string, accountId: string): SenderRuleHit {
  const s = splitSender(sender);
  const none = { allowlisted: false, blacklisted: false };
  if (!s) return none;
  const kinds = db.prepare(
    `SELECT DISTINCT kind FROM sender_rules
     WHERE user_id = ? AND active = 1 AND (account_id IS NULL OR account_id = ?)
       AND ((match = 'address' AND value = ?) OR (match = 'domain' AND value = ?))`,
  ).all(userId, accountId, s.address, s.domain) as { kind: RuleKind }[];
  return {
    allowlisted: kinds.some((k) => k.kind === "allowlist"),
    blacklisted: kinds.some((k) => k.kind === "blacklist"),
  };
}
