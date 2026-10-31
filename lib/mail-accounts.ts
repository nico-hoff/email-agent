// Mailboxes in the database (R2, ADR 0023): validation, create/update/enable/disable, the secret-free list view, the
// worker-side loader (decrypts) and the one-time import of the legacy accounts file.
// Every function that takes a `userId` is tenant-scoped (a foreign id is "not_found", ADR 0033). Secrets only ever
// leave this module as part of an AccountConfig for a worker; views carry `secret_set` and `secret_set_at`, nothing else.
// No dynamic `obj[key]` access: Veryfront's API loader rejects it in modules that routes import.
import { randomBytes, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { accountColor } from "./account-color.ts";
import { type KeyringResult, type Keyring, openSecret, sealSecret, SecretError, isValidSecret, resealSecret } from "./account-secrets.ts";
import {
  accountsFileExists, type AccountConfig, AUTO_ACTION_MODES, type AutoActionMode, DEFAULT_AUTO_ACTION_MODE, DEFAULT_SPAM_THRESHOLD,
  loadAccountsConfig,
} from "./accounts-config.ts";
import { OWNER_USER_ID } from "./users.ts";

export const ACCOUNT_TYPES = ["imap", "google"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const GOOGLE_PRESET = { host: "imap.gmail.com", port: 993, tls: true, mailbox: "INBOX", spam_mailbox: "[Gmail]/Spam" } as const;
export const LABEL_MAX = 40;
export const CONTEXT_MAX = 1000;
const CONTEXT_DB_MAX = 2000;
export const IMPORT_MARKER_KEY = "accounts_import";

// ---- validation -----------------------------------------------------------------------------------------------------

function ipv4Private(a: number, b: number): boolean {
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
}

function ipPrivate(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a = 0, b = 0] = ip.split(".").map(Number);
    return ipv4Private(a, b);
  }
  const v6 = ip.toLowerCase();
  const mapped = /^::ffff:(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(v6);
  if (mapped) return ipv4Private(Number(mapped[1]), Number(mapped[2]));
  return v6 === "::" || v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith("::ffff:");
}

export type HostProblem = "invalid_host" | "host_not_allowed";

/**
 * Host policy: a plain DNS name or a public IP literal. Refused: URLs, ports, whitespace, numeric shorthands, single-label
 * names, localhost / .local / .internal, and IP literals of loopback, private, link-local, CGNAT and ULA ranges (SSRF
 * protection: any signed-in user can make the server connect). ACCOUNTS_ALLOW_PRIVATE_HOSTS=1 lifts the range rule (a
 * mail bridge on the same machine). Names that resolve to private addresses are not checked (docs/accounts-contract.md).
 */
export function hostProblem(host: string, allowPrivate: boolean): HostProblem | null {
  if (host.length < 1 || host.length > 253) return "invalid_host";
  const bare = host.replace(/^\[(.*)\]$/, "$1");
  if (isIP(bare) !== 0) return !allowPrivate && ipPrivate(bare) ? "host_not_allowed" : null;
  if (/[\s/@:?#\\[\]]/.test(host)) return "invalid_host";
  if (host.toLowerCase() === "localhost") return allowPrivate ? null : "host_not_allowed";
  if (!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/i.test(host)) return "invalid_host";
  const lower = host.toLowerCase();
  if (!allowPrivate && (lower === "localhost" || /\.(localhost|local|internal|lan|home|corp|intranet)$/.test(lower))) return "host_not_allowed";
  return null;
}

const noControl = (s: string) => !/[\u0000-\u001f\u007f]/.test(s);
const folder = z.string().trim().min(1).max(255).refine(noControl);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/).transform((c) => c.toLowerCase());
const common = {
  label: z.string().trim().min(1).max(LABEL_MAX).refine(noControl),
  color: color.nullable().optional(),
  host: z.string().trim().max(253).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  tls: z.boolean().optional(),
  username: z.string().trim().min(1).max(254).refine(noControl),
  mailbox: folder.optional(),
  spam_mailbox: folder.nullable().optional(),
  context: z.string().max(CONTEXT_MAX).refine((s) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s)).optional(),
};
export const createAccountBody = z.strictObject({ type: z.enum(ACCOUNT_TYPES), password: z.string().min(1).max(2048), ...common });
export const updateAccountBody = z.strictObject({
  ...common,
  label: common.label.optional(),
  username: common.username.optional(),
  /** Absent or empty = keep the stored secret. */
  password: z.string().max(2048).optional(),
});
export type CreateAccountInput = z.infer<typeof createAccountBody>;
export type UpdateAccountInput = z.infer<typeof updateAccountBody>;

/** Google app passwords are shown in groups ("abcd efgh ijkl mnop"); the spaces are not part of the secret. */
export const normalizeSecret = (type: AccountType, raw: string): string => (type === "google" ? raw.replace(/\s+/g, "") : raw);

export type AccountError = "invalid_host" | "host_not_allowed" | "invalid_secret" | "not_found" | "not_managed" | "no_encryption_key";

export function allowPrivateHosts(env: Record<string, string | undefined>): boolean {
  return env.ACCOUNTS_ALLOW_PRIVATE_HOSTS === "1";
}

// ---- helpers --------------------------------------------------------------------------------------------------------

export const newAccountId = (): string => `a_${randomBytes(8).toString("hex")}`;
const blob = (v: unknown): Buffer => Buffer.from(v as Uint8Array);
const iso = (d: Date): string => d.toISOString();

function auditEvent(db: DatabaseSync, action: string, userId: number, accountId: string, now: Date, details: Record<string, unknown>): void {
  db.prepare(
    `INSERT INTO audit_log (occurred_at, trace_id, actor, action, account_id, details_json, user_id) VALUES (?, ?, 'system', ?, ?, ?, ?)`,
  ).run(iso(now), randomUUID(), action, accountId, JSON.stringify(details), userId);
}

function setWorkerState(db: DatabaseSync, accountId: string, state: "disabled" | "connecting" | "paused", code: string | null, now: Date): void {
  db.prepare(
    `INSERT INTO worker_status (account_id, state, error_code, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (account_id) DO UPDATE SET state = excluded.state, error_code = excluded.error_code, updated_at = excluded.updated_at`,
  ).run(accountId, state, code, iso(now));
}

// ---- views ----------------------------------------------------------------------------------------------------------

export interface AccountView {
  id: string;
  /** false: no credentials in the database (demo data or not yet imported); the UI shows it but cannot edit or test it. */
  managed: boolean;
  type: AccountType | null;
  label: string;
  color: string;
  host: string;
  port: number;
  tls: boolean | null;
  username: string | null;
  mailbox: string;
  spam_mailbox: string | null;
  enabled: boolean;
  context: string;
  secret_set: boolean;
  secret_set_at: string | null;
  last_test_at: string | null;
  last_test_code: string | null;
  spam_seen_mode: AutoActionMode | null;
  worker: { state: string; error_code: string | null; last_poll_at: string | null } | null;
}

interface ViewRow {
  id: string; label: string; color: string | null; host: string; port: number; mailbox: string; spam_mailbox: string | null; enabled: number;
  type: string | null; tls: number | null; username: string | null; secret_set_at: string | null; last_test_at: string | null;
  last_test_code: string | null; context: string | null; spam_seen_mode: string | null;
  w_state: string | null; w_error: string | null; w_poll: string | null;
}

const VIEW_SQL = `SELECT a.id, a.label, a.color, a.host, a.port, a.mailbox, a.spam_mailbox, a.enabled,
    m.type, m.tls, m.username, m.secret_set_at, m.last_test_at, m.last_test_code, m.context, m.spam_seen_mode,
    w.state AS w_state, w.error_code AS w_error, w.last_poll_at AS w_poll
  FROM accounts a
  LEFT JOIN mail_accounts m ON m.account_id = a.id AND m.user_id = a.user_id
  LEFT JOIN worker_status w ON w.account_id = a.id`;

function asView(r: ViewRow): AccountView {
  const mode = r.spam_seen_mode;
  return {
    id: r.id,
    managed: r.type !== null,
    type: r.type === "google" ? "google" : r.type === "imap" ? "imap" : null,
    label: r.label,
    color: accountColor(r.id, r.color),
    host: r.host,
    port: r.port,
    tls: r.tls === null ? null : r.tls === 1,
    username: r.username,
    mailbox: r.mailbox,
    spam_mailbox: r.spam_mailbox,
    enabled: r.enabled === 1,
    context: r.context ?? "",
    secret_set: r.secret_set_at !== null,
    secret_set_at: r.secret_set_at,
    last_test_at: r.last_test_at,
    last_test_code: r.last_test_code,
    spam_seen_mode: mode === "off" || mode === "dry_run" || mode === "live" ? mode : null,
    worker: r.w_state === null ? null : { state: r.w_state, error_code: r.w_error, last_poll_at: r.w_poll },
  };
}

export function listAccountViews(db: DatabaseSync, userId: number): AccountView[] {
  return (db.prepare(`${VIEW_SQL} WHERE a.user_id = ? ORDER BY a.rowid`).all(userId) as unknown as ViewRow[]).map(asView);
}

export function getAccountView(db: DatabaseSync, userId: number, accountId: string): AccountView | null {
  const r = db.prepare(`${VIEW_SQL} WHERE a.user_id = ? AND a.id = ?`).get(userId, accountId) as ViewRow | undefined;
  return r ? asView(r) : null;
}

// ---- create / update ------------------------------------------------------------------------------------------------

export type CreateResult = { ok: true; id: string } | { ok: false; code: AccountError };

export function createMailAccount(
  db: DatabaseSync,
  userId: number,
  keys: KeyringResult,
  input: CreateAccountInput,
  opts: { now?: Date; allowPrivate?: boolean; newId?: () => string } = {},
): CreateResult {
  if (!keys.ok) return { ok: false, code: "no_encryption_key" };
  const now = opts.now ?? new Date();
  const google = input.type === "google";
  const host = google ? GOOGLE_PRESET.host : (input.host ?? "");
  const hp = hostProblem(host, opts.allowPrivate === true);
  if (hp !== null) return { ok: false, code: hp };
  const secret = normalizeSecret(input.type, input.password);
  if (!isValidSecret(secret)) return { ok: false, code: "invalid_secret" };
  const id = (opts.newId ?? newAccountId)();
  const port = google ? GOOGLE_PRESET.port : (input.port ?? 993);
  const tls = google ? GOOGLE_PRESET.tls : (input.tls ?? true);
  const mailbox = input.mailbox ?? "INBOX";
  const spam = input.spam_mailbox === undefined ? (google ? GOOGLE_PRESET.spam_mailbox : null) : input.spam_mailbox;
  const sealed = sealSecret(keys.keyring, { accountId: id, userId }, secret);
  const ts = iso(now);
  db.exec("BEGIN");
  try {
    db.prepare(`INSERT INTO accounts (id, label, host, port, mailbox, spam_mailbox, enabled, color, user_id) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`)
      .run(id, input.label, host, port, mailbox, spam, input.color ?? null, userId);
    db.prepare(
      `INSERT INTO mail_accounts (account_id, user_id, type, tls, username, secret_ciphertext, secret_nonce, secret_tag, key_id, secret_set_at,
         context, spam_seen_mode, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'off', ?, ?)`,
    ).run(id, userId, input.type, tls ? 1 : 0, input.username, sealed.ciphertext, sealed.nonce, sealed.tag, sealed.keyId, ts, input.context ?? "", ts, ts);
    setWorkerState(db, id, "connecting", null, now);
    auditEvent(db, "account_created", userId, id, now, { type: input.type });
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return { ok: true, id };
}

export type UpdateResult = { ok: true; secretChanged: boolean } | { ok: false; code: AccountError };

export function updateMailAccount(
  db: DatabaseSync,
  userId: number,
  accountId: string,
  keys: KeyringResult,
  patch: UpdateAccountInput,
  opts: { now?: Date; allowPrivate?: boolean } = {},
): UpdateResult {
  const now = opts.now ?? new Date();
  const cur = db.prepare(
    `SELECT a.label, a.color, a.host, a.port, a.mailbox, a.spam_mailbox, m.type, m.tls, m.username, m.context
     FROM accounts a JOIN mail_accounts m ON m.account_id = a.id AND m.user_id = a.user_id WHERE a.id = ? AND a.user_id = ?`,
  ).get(accountId, userId) as
    | { label: string; color: string | null; host: string; port: number; mailbox: string; spam_mailbox: string | null; type: string; tls: number; username: string; context: string }
    | undefined;
  if (!cur) return { ok: false, code: ownsAny(db, userId, accountId) ? "not_managed" : "not_found" };
  const google = cur.type === "google";
  const host = google ? cur.host : (patch.host ?? cur.host);
  const hp = host === cur.host ? null : hostProblem(host, opts.allowPrivate === true);
  if (hp !== null) return { ok: false, code: hp };
  const wantsSecret = patch.password !== undefined && patch.password !== "";
  if (wantsSecret && !keys.ok) return { ok: false, code: "no_encryption_key" };
  const ts = iso(now);
  db.exec("BEGIN");
  try {
    db.prepare(`UPDATE accounts SET label = ?, color = ?, host = ?, port = ?, mailbox = ?, spam_mailbox = ? WHERE id = ? AND user_id = ?`).run(
      patch.label ?? cur.label,
      patch.color === undefined ? cur.color : patch.color,
      host,
      google ? cur.port : (patch.port ?? cur.port),
      patch.mailbox ?? cur.mailbox,
      patch.spam_mailbox === undefined ? cur.spam_mailbox : patch.spam_mailbox,
      accountId,
      userId,
    );
    db.prepare(`UPDATE mail_accounts SET tls = ?, username = ?, context = ?, updated_at = ? WHERE account_id = ? AND user_id = ?`).run(
      google ? 1 : patch.tls === undefined ? cur.tls : patch.tls ? 1 : 0,
      patch.username ?? cur.username,
      patch.context ?? cur.context,
      ts,
      accountId,
      userId,
    );
    if (wantsSecret && keys.ok) {
      const secret = normalizeSecret(google ? "google" : "imap", patch.password ?? "");
      if (!isValidSecret(secret)) {
        db.exec("ROLLBACK");
        return { ok: false, code: "invalid_secret" };
      }
      const sealed = sealSecret(keys.keyring, { accountId, userId }, secret);
      db.prepare(
        `UPDATE mail_accounts SET secret_ciphertext = ?, secret_nonce = ?, secret_tag = ?, key_id = ?, secret_set_at = ?, last_test_at = NULL, last_test_code = NULL
         WHERE account_id = ? AND user_id = ?`,
      ).run(sealed.ciphertext, sealed.nonce, sealed.tag, sealed.keyId, ts, accountId, userId);
    }
    auditEvent(db, "account_updated", userId, accountId, now, { secret_changed: wantsSecret });
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return { ok: true, secretChanged: wantsSecret };
}

function ownsAny(db: DatabaseSync, userId: number, accountId: string): boolean {
  return db.prepare("SELECT 1 FROM accounts WHERE id = ? AND user_id = ?").get(accountId, userId) !== undefined;
}

export function setAccountEnabled(db: DatabaseSync, userId: number, accountId: string, enabled: boolean, now: Date = new Date()): "ok" | "not_found" {
  db.exec("BEGIN");
  try {
    const r = db.prepare("UPDATE accounts SET enabled = ? WHERE id = ? AND user_id = ?").run(enabled ? 1 : 0, accountId, userId);
    if (Number(r.changes) === 0) {
      db.exec("ROLLBACK");
      return "not_found";
    }
    setWorkerState(db, accountId, enabled ? "connecting" : "disabled", null, now);
    auditEvent(db, enabled ? "account_enabled" : "account_disabled", userId, accountId, now, {});
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return "ok";
}

/** Short error class of the last connection test ("ok" or a code like auth_failed), never a server response. */
export function recordTestResult(db: DatabaseSync, userId: number, accountId: string, code: string, now: Date = new Date()): void {
  if (!/^[a-z_]{1,32}$/.test(code)) throw new Error("invalid test code");
  db.prepare("UPDATE mail_accounts SET last_test_at = ?, last_test_code = ? WHERE account_id = ? AND user_id = ?").run(iso(now), code, accountId, userId);
}

/** What a connection test needs: the stored settings plus the decrypted secret. Null = unknown, foreign or not managed. */
export function loadConnection(db: DatabaseSync, userId: number, accountId: string, ring: Keyring):
  | { host: string; port: number; tls: boolean; user: string; password: string; mailbox: string; spam_mailbox: string | null }
  | "unreadable"
  | null {
  const r = db.prepare(
    `SELECT a.host, a.port, a.mailbox, a.spam_mailbox, m.tls, m.username, m.secret_ciphertext, m.secret_nonce, m.secret_tag, m.key_id
     FROM accounts a JOIN mail_accounts m ON m.account_id = a.id AND m.user_id = a.user_id WHERE a.id = ? AND a.user_id = ?`,
  ).get(accountId, userId) as SecretRow | undefined;
  if (!r) return null;
  try {
    const password = openSecret(ring, { accountId, userId }, { ciphertext: blob(r.secret_ciphertext), nonce: blob(r.secret_nonce), tag: blob(r.secret_tag), keyId: r.key_id });
    return { host: r.host, port: r.port, tls: r.tls === 1, user: r.username, password, mailbox: r.mailbox, spam_mailbox: r.spam_mailbox };
  } catch (e) {
    if (e instanceof SecretError) return "unreadable";
    throw e;
  }
}

interface SecretRow {
  host: string; port: number; mailbox: string; spam_mailbox: string | null; tls: number; username: string;
  secret_ciphertext: unknown; secret_nonce: unknown; secret_tag: unknown; key_id: string;
}

// ---- worker side ----------------------------------------------------------------------------------------------------

export interface WorkerAccounts {
  accounts: AccountConfig[];
  /** Enabled accounts whose secret cannot be decrypted (unknown key, tampered): they do not start. */
  unreadable: string[];
}

/** Enabled, managed accounts of all users with a decryptable secret, in the shape the IMAP worker expects. */
export function loadWorkerAccounts(db: DatabaseSync, ring: Keyring): WorkerAccounts {
  const rows = db.prepare(
    `SELECT a.id, a.user_id, a.label, a.color, a.host, a.port, a.mailbox, a.spam_mailbox, a.enabled,
            m.tls, m.username, m.context, m.spam_threshold, m.spam_seen_mode, m.secret_ciphertext, m.secret_nonce, m.secret_tag, m.key_id
     FROM accounts a JOIN mail_accounts m ON m.account_id = a.id AND m.user_id = a.user_id
     WHERE a.enabled = 1 ORDER BY a.rowid`,
  ).all() as unknown as (SecretRow & {
    id: string; user_id: number; label: string; color: string | null; enabled: number; context: string; spam_threshold: number; spam_seen_mode: string;
  })[];
  const out: WorkerAccounts = { accounts: [], unreadable: [] };
  for (const r of rows) {
    let password: string;
    try {
      password = openSecret(ring, { accountId: r.id, userId: r.user_id }, { ciphertext: blob(r.secret_ciphertext), nonce: blob(r.secret_nonce), tag: blob(r.secret_tag), keyId: r.key_id });
    } catch {
      out.unreadable.push(r.id);
      continue;
    }
    const mode = AUTO_ACTION_MODES.find((m) => m === r.spam_seen_mode) ?? "off";
    out.accounts.push({
      id: r.id, label: r.label, ...(r.color ? { color: r.color } : {}), context: r.context, host: r.host, port: r.port, tls: r.tls === 1,
      user: r.username, password, mailbox: r.mailbox, ...(r.spam_mailbox ? { spam_mailbox: r.spam_mailbox } : {}),
      spam_threshold: r.spam_threshold, enabled: true, auto_actions: { spam_seen: mode },
    });
  }
  return out;
}

/** Re-encrypts every secret with the current key in one transaction (all or nothing). Returns the number of rows. */
export function rekeyAll(db: DatabaseSync, ring: Keyring): number {
  const rows = db.prepare(
    `SELECT account_id, user_id, secret_ciphertext, secret_nonce, secret_tag, key_id FROM mail_accounts ORDER BY account_id`,
  ).all() as unknown as { account_id: string; user_id: number; secret_ciphertext: unknown; secret_nonce: unknown; secret_tag: unknown; key_id: string }[];
  const upd = db.prepare("UPDATE mail_accounts SET secret_ciphertext = ?, secret_nonce = ?, secret_tag = ?, key_id = ? WHERE account_id = ?");
  db.exec("BEGIN");
  try {
    for (const r of rows) {
      const next = resealSecret(ring, { accountId: r.account_id, userId: r.user_id }, {
        ciphertext: blob(r.secret_ciphertext), nonce: blob(r.secret_nonce), tag: blob(r.secret_tag), keyId: r.key_id,
      });
      upd.run(next.ciphertext, next.nonce, next.tag, next.keyId, r.account_id);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return rows.length;
}

/** Marks the worker status of all enabled managed accounts (fail-closed without a usable key). Idempotent. */
export function markWorkersBlocked(db: DatabaseSync, code: string, now: Date = new Date()): void {
  db.prepare(
    `UPDATE worker_status SET state = 'paused', error_code = ?, updated_at = ?
     WHERE account_id IN (SELECT a.id FROM accounts a JOIN mail_accounts m ON m.account_id = a.id WHERE a.enabled = 1)
       AND NOT (state = 'paused' AND error_code = ?)`,
  ).run(code, iso(now), code);
}

export function markWorkerPaused(db: DatabaseSync, accountId: string, code: string, now: Date = new Date()): void {
  setWorkerState(db, accountId, "paused", code, now);
}

export function markDisabledWorkers(db: DatabaseSync, now: Date = new Date()): void {
  db.prepare(
    `UPDATE worker_status SET state = 'disabled', error_code = NULL, updated_at = ?
     WHERE state <> 'disabled' AND account_id IN (SELECT id FROM accounts WHERE enabled = 0)`,
  ).run(iso(now));
}

export function markWorkerConnecting(db: DatabaseSync, accountId: string, now: Date = new Date()): void {
  setWorkerState(db, accountId, "connecting", null, now);
}

// ---- legacy import --------------------------------------------------------------------------------------------------

export type LegacyImportResult =
  | { status: "no_file" }
  | { status: "already_imported" }
  | { status: "no_key" }
  | { status: "imported"; count: number };

export function legacyImportDone(db: DatabaseSync): boolean {
  return db.prepare("SELECT 1 FROM user_state WHERE user_id = ? AND key = ?").get(OWNER_USER_ID, IMPORT_MARKER_KEY) !== undefined;
}

/**
 * One-time import of the legacy accounts file into the database (owner user 1, secrets encrypted). The marker is written in
 * the same transaction; once it exists the file is never opened again. Prints nothing; messages carry no values.
 */
export function importLegacyAccounts(
  db: DatabaseSync,
  o: { env: Record<string, string | undefined>; projectRoot: string; keys: KeyringResult; now?: Date },
): LegacyImportResult {
  if (legacyImportDone(db)) return { status: "already_imported" };
  if (!accountsFileExists({ env: o.env, projectRoot: o.projectRoot })) return { status: "no_file" };
  if (!o.keys.ok) return { status: "no_key" };
  const cfg = loadAccountsConfig({ env: o.env, projectRoot: o.projectRoot });
  if (cfg.status !== "ok") return { status: "no_file" };
  const ring = o.keys.keyring;
  const now = o.now ?? new Date();
  const ts = iso(now);
  db.exec("BEGIN");
  try {
    for (const a of cfg.accounts) {
      const existing = db.prepare("SELECT user_id FROM accounts WHERE id = ?").get(a.id) as { user_id: number } | undefined;
      if (existing && existing.user_id !== OWNER_USER_ID) throw new Error("import: an account id belongs to another user");
      db.prepare(
        `INSERT INTO accounts (id, label, host, port, mailbox, spam_mailbox, enabled, color, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET label = excluded.label, host = excluded.host, port = excluded.port, mailbox = excluded.mailbox,
           spam_mailbox = excluded.spam_mailbox, enabled = excluded.enabled, color = excluded.color`,
      ).run(a.id, a.label, a.host, a.port, a.mailbox, a.spam_mailbox ?? null, a.enabled ? 1 : 0, a.color ?? null, OWNER_USER_ID);
      const sealed = sealSecret(ring, { accountId: a.id, userId: OWNER_USER_ID }, a.password);
      db.prepare(
        `INSERT INTO mail_accounts (account_id, user_id, type, tls, username, secret_ciphertext, secret_nonce, secret_tag, key_id, secret_set_at,
           context, spam_threshold, spam_seen_mode, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (account_id) DO NOTHING`,
      ).run(
        a.id, OWNER_USER_ID, a.host === GOOGLE_PRESET.host ? "google" : "imap", a.tls ? 1 : 0, a.user, sealed.ciphertext, sealed.nonce, sealed.tag, sealed.keyId, ts,
        a.context.slice(0, CONTEXT_DB_MAX), a.spam_threshold ?? DEFAULT_SPAM_THRESHOLD, a.auto_actions?.spam_seen ?? DEFAULT_AUTO_ACTION_MODE, ts, ts,
      );
      setWorkerState(db, a.id, a.enabled ? "connecting" : "disabled", null, now);
    }
    db.prepare("INSERT INTO user_state (user_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)")
      .run(OWNER_USER_ID, IMPORT_MARKER_KEY, JSON.stringify({ at: ts, count: cfg.accounts.length }), ts);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return { status: "imported", count: cfg.accounts.length };
}

/** Reads the modes of all accounts for the list header; a disabled or unmanaged account counts as off / unknown (dry_run in the API). */
export function readSpamSeenModes(db: DatabaseSync, userId: number): Map<string, AutoActionMode> {
  const rows = db.prepare(
    `SELECT a.id, a.enabled, m.spam_seen_mode FROM accounts a JOIN mail_accounts m ON m.account_id = a.id AND m.user_id = a.user_id WHERE a.user_id = ?`,
  ).all(userId) as { id: string; enabled: number; spam_seen_mode: string }[];
  return new Map(rows.map((r) => [r.id, r.enabled === 1 ? (AUTO_ACTION_MODES.find((m) => m === r.spam_seen_mode) ?? "off") : "off"] as const));
}
