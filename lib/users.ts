// Users, sessions and invitations (ADR 0022, 0029; docs/erd.md 006). Pure SQLite plus scrypt; no HTTP here.
// Nothing returned from this module contains a password hash. Tokens and invite codes are stored only as SHA-256.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { dummyHash, hashPassword, passwordProblem, verifyPassword } from "./user-password.ts";

/** The owner row created by migration 006. All data that existed before the migration belongs to it. */
export const OWNER_USER_ID = 1;
export const UNCLAIMED_EMAIL = "owner@unclaimed.invalid";
export const USER_ROLES = ["admin", "user"] as const;
export type UserRole = (typeof USER_ROLES)[number];
export type UserStatus = "unclaimed" | "active" | "disabled";

export const SESSION_TTL_DAYS = 30;
export const INVITE_DEFAULT_DAYS = 7;
export const INVITE_MAX_DAYS = 30;
/** `last_used_at` is refreshed at most this often (a write per request is not needed). */
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;
const EMAIL_MAX = 254;

export interface User {
  id: number;
  email: string;
  role: UserRole;
  status: UserStatus;
  created_at: string;
}

interface UserRowDb extends User { password_hash: string | null }

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
const USER_COLUMNS = "id, email, role, status, created_at";

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const e = raw.trim().toLowerCase();
  if (e.length < 3 || e.length > EMAIL_MAX || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return null;
  return e;
}

const toUser = (r: UserRowDb | User): User => ({ id: r.id, email: r.email, role: r.role, status: r.status, created_at: r.created_at });

export function getUser(db: DatabaseSync, id: number): User | null {
  const r = db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).get(id) as unknown as User | undefined;
  return r ? toUser(r) : null;
}

export function findUserByEmail(db: DatabaseSync, email: string): User | null {
  const e = normalizeEmail(email);
  if (e === null) return null;
  const r = db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE email = ?`).get(e) as unknown as User | undefined;
  return r ? toUser(r) : null;
}

export function isOwnerUnclaimed(db: DatabaseSync): boolean {
  const r = db.prepare("SELECT status FROM users WHERE id = ?").get(OWNER_USER_ID) as { status: UserStatus } | undefined;
  return r?.status === "unclaimed";
}

export type CreateUserResult =
  | { ok: true; user: User; claimed: boolean }
  | { ok: false; code: "invalid_email" | "weak_password" | "email_taken" | "invalid_role" };

function audit(db: DatabaseSync, action: string, ts: string, userId: number, details: Record<string, unknown>): void {
  db.prepare(
    `INSERT INTO audit_log (occurred_at, trace_id, actor, action, account_id, email_id, user_id, details_json)
     VALUES (?, ?, 'system', ?, NULL, NULL, ?, ?)`,
  ).run(ts, randomUUID(), action, userId, JSON.stringify(details));
}

/**
 * Creates a user. While the owner (id 1) is unclaimed and the role is admin, that row is claimed instead (email, hash,
 * status active), so the data that existed before the multi-user migration stays with the first admin.
 */
export async function createUser(
  db: DatabaseSync,
  i: { email: string; password: string; role?: UserRole; now?: Date },
): Promise<CreateUserResult> {
  const email = normalizeEmail(i.email);
  if (email === null) return { ok: false, code: "invalid_email" };
  if (passwordProblem(i.password) !== null) return { ok: false, code: "weak_password" };
  const role = i.role ?? "admin";
  if (!USER_ROLES.includes(role)) return { ok: false, code: "invalid_role" };
  const hash = await hashPassword(i.password);
  const ts = (i.now ?? new Date()).toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(email) !== undefined) {
      // Re-claiming with the very same address is not a claim: the owner row only claims while unclaimed.
      db.exec("ROLLBACK");
      return { ok: false, code: "email_taken" };
    }
    let id: number;
    let claimed = false;
    if (role === "admin" && isOwnerUnclaimed(db)) {
      db.prepare("UPDATE users SET email = ?, password_hash = ?, status = 'active', updated_at = ? WHERE id = ? AND status = 'unclaimed'")
        .run(email, hash, ts, OWNER_USER_ID);
      id = OWNER_USER_ID;
      claimed = true;
    } else {
      id = Number(db.prepare(
        "INSERT INTO users (email, password_hash, role, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)",
      ).run(email, hash, role, ts, ts).lastInsertRowid);
    }
    audit(db, "user_created", ts, id, { role, claimed });
    db.exec("COMMIT");
    return { ok: true, user: getUser(db, id)!, claimed };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/**
 * Checks email and password. Unknown, unclaimed and disabled users cost the same scrypt run as a wrong password
 * (dummy hash), and the result is one boolean-like shape: no hint which part was wrong.
 */
export async function verifyLogin(db: DatabaseSync, email: unknown, password: unknown): Promise<User | null> {
  const e = normalizeEmail(email);
  const row = e === null
    ? undefined
    : db.prepare(`SELECT ${USER_COLUMNS}, password_hash FROM users WHERE email = ?`).get(e) as unknown as UserRowDb | undefined;
  const usable = row !== undefined && row.status === "active" && row.password_hash !== null;
  const candidate = typeof password === "string" ? password : "";
  const ok = await verifyPassword(usable ? row.password_hash! : await dummyHash(), candidate);
  return usable && ok ? toUser(row) : null;
}

export function setUserStatus(db: DatabaseSync, id: number, status: "active" | "disabled", now: Date = new Date()): boolean {
  const res = db.prepare("UPDATE users SET status = ?, updated_at = ? WHERE id = ? AND status <> 'unclaimed'").run(status, now.toISOString(), id);
  if (status === "disabled") revokeAllSessions(db, id, now);
  return Number(res.changes) > 0;
}

// ---- sessions ----------------------------------------------------------------------------------------------------

export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function createSession(db: DatabaseSync, userId: number, now: Date = new Date(), ttlDays: number = SESSION_TTL_DAYS): { token: string; expiresAt: string } {
  const token = newSessionToken();
  const created = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlDays * 86_400_000).toISOString();
  db.prepare("INSERT INTO user_sessions (id, user_id, created_at, expires_at, last_used_at) VALUES (?, ?, ?, ?, ?)")
    .run(sha256(token), userId, created, expiresAt, created);
  // Housekeeping: rows that expired or were revoked more than a week ago are of no use.
  const cutoff = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  db.prepare("DELETE FROM user_sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)").run(cutoff, cutoff);
  return { token, expiresAt };
}

export interface SessionUser { user: User; sessionId: string }

/** The user of a live session (row exists, not revoked, not expired, user active), or null. Refreshes last_used_at sparingly. */
export function verifySessionToken(db: DatabaseSync, token: string, now: Date = new Date()): SessionUser | null {
  if (!TOKEN_PATTERN.test(token)) return null;
  const sessionId = sha256(token);
  const row = db.prepare(
    `SELECT u.id, u.email, u.role, u.status, u.created_at, s.expires_at, s.revoked_at, s.last_used_at
     FROM user_sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
  ).get(sessionId) as unknown as (User & { expires_at: string; revoked_at: string | null; last_used_at: string }) | undefined;
  if (!row || row.revoked_at !== null || row.status !== "active") return null;
  const t = now.getTime();
  if (Date.parse(row.expires_at) <= t) return null;
  if (t - Date.parse(row.last_used_at) > TOUCH_INTERVAL_MS) {
    db.prepare("UPDATE user_sessions SET last_used_at = ? WHERE id = ?").run(now.toISOString(), sessionId);
  }
  return { user: toUser(row), sessionId };
}

export function revokeSessionToken(db: DatabaseSync, token: string, now: Date = new Date()): boolean {
  if (!TOKEN_PATTERN.test(token)) return false;
  const res = db.prepare("UPDATE user_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now.toISOString(), sha256(token));
  return Number(res.changes) > 0;
}

/** Ends every session of a user ("auf allen Geräten abmelden"). Returns how many were live. */
export function revokeAllSessions(db: DatabaseSync, userId: number, now: Date = new Date()): number {
  return Number(db.prepare("UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").run(now.toISOString(), userId).changes);
}

export function countLiveSessions(db: DatabaseSync, userId: number, now: Date = new Date()): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM user_sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?").get(userId, now.toISOString()) as { n: number }).n;
}

// ---- invitations ---------------------------------------------------------------------------------------------------

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_GROUPS = 5;
const CODE_GROUP_LEN = 4;

/** `XXXX-XXXX-XXXX-XXXX-XXXX`: 20 characters of a 32-letter alphabet (100 bits), no look-alikes. */
export function newInviteCode(): string {
  const bytes = randomBytes(CODE_GROUPS * CODE_GROUP_LEN);
  const chars = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]);
  const groups: string[] = [];
  for (let g = 0; g < CODE_GROUPS; g++) groups.push(chars.slice(g * CODE_GROUP_LEN, (g + 1) * CODE_GROUP_LEN).join(""));
  return groups.join("-");
}

/** Canonical form of a typed code (case, dashes and spaces do not matter), or null when it cannot be a code. */
export function normalizeInviteCode(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 64) return null;
  const c = raw.toUpperCase().replace(/[\s-]+/g, "");
  if (c.length !== CODE_GROUPS * CODE_GROUP_LEN || ![...c].every((ch) => CODE_ALPHABET.includes(ch))) return null;
  return c.match(/.{4}/g)!.join("-");
}

export interface CreatedInvite { id: number; code: string; role: UserRole; created_at: string; expires_at: string }

export function createInvite(db: DatabaseSync, i: { createdBy: number; role?: UserRole; days?: number; now?: Date }): CreatedInvite {
  const role = i.role ?? "user";
  if (!USER_ROLES.includes(role)) throw new Error("invalid role");
  const days = i.days ?? INVITE_DEFAULT_DAYS;
  if (!Number.isFinite(days) || days <= 0 || days > INVITE_MAX_DAYS) throw new Error("invalid days");
  const now = i.now ?? new Date();
  const created = now.toISOString();
  const expires = new Date(now.getTime() + days * 86_400_000).toISOString();
  const code = newInviteCode();
  db.exec("BEGIN IMMEDIATE");
  try {
    const id = Number(db.prepare(
      "INSERT INTO invites (code_hash, role, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
    ).run(sha256(code), role, i.createdBy, created, expires).lastInsertRowid);
    audit(db, "invite_created", created, i.createdBy, { invite_id: id, role });
    db.exec("COMMIT");
    return { id, code, role, created_at: created, expires_at: expires };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export interface OpenInvite { id: number; role: UserRole; created_at: string; expires_at: string }

/** Unused, unexpired invitations; never the code (only its hash is stored). */
export function listOpenInvites(db: DatabaseSync, now: Date = new Date()): OpenInvite[] {
  return (db.prepare(
    "SELECT id, role, created_at, expires_at FROM invites WHERE used_at IS NULL AND expires_at > ? ORDER BY id DESC",
  ).all(now.toISOString()) as unknown as OpenInvite[]).map((r) => ({ id: r.id, role: r.role, created_at: r.created_at, expires_at: r.expires_at }));
}

export type RegisterResult =
  | { ok: true; user: User }
  | { ok: false; code: "invalid_invite" | "invalid_email" | "weak_password" | "email_taken" };

/**
 * Registration with an invitation. The invitation is consumed in the same IMMEDIATE transaction that inserts the user,
 * so a code can create at most one account, also under parallel requests; a failed insert (email taken) leaves it unused.
 * Wrong, used and expired codes are one and the same answer.
 */
export async function registerWithInvite(
  db: DatabaseSync,
  i: { code: unknown; email: unknown; password: unknown; now?: Date },
): Promise<RegisterResult> {
  const email = normalizeEmail(i.email);
  const code = normalizeInviteCode(i.code);
  if (typeof i.password !== "string" || passwordProblem(i.password) !== null) {
    return { ok: false, code: code === null ? "invalid_invite" : email === null ? "invalid_email" : "weak_password" };
  }
  const hash = await hashPassword(i.password);
  if (code === null) return { ok: false, code: "invalid_invite" };
  if (email === null) return { ok: false, code: "invalid_email" };
  const now = i.now ?? new Date();
  const ts = now.toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    const inv = db.prepare("SELECT id, role FROM invites WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?")
      .get(sha256(code), ts) as { id: number; role: UserRole } | undefined;
    if (!inv) {
      db.exec("ROLLBACK");
      return { ok: false, code: "invalid_invite" };
    }
    if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(email) !== undefined) {
      db.exec("ROLLBACK");
      return { ok: false, code: "email_taken" };
    }
    const id = Number(db.prepare(
      "INSERT INTO users (email, password_hash, role, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)",
    ).run(email, hash, inv.role, ts, ts).lastInsertRowid);
    const used = db.prepare("UPDATE invites SET used_at = ?, used_by = ? WHERE id = ? AND used_at IS NULL").run(ts, id, inv.id);
    if (Number(used.changes) !== 1) throw new Error("invite no longer open");
    audit(db, "user_created", ts, id, { role: inv.role, claimed: false });
    audit(db, "invite_used", ts, id, { invite_id: inv.id });
    db.exec("COMMIT");
    return { ok: true, user: getUser(db, id)! };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// ---- synthetic dev mode --------------------------------------------------------------------------------------------
/** The test user of the synthetic dev database (`npm run dev`). Synthetic data only; the password is public on purpose. */
export const DEV_USER_EMAIL = "dev@synthetic.invalid";
export const DEV_USER_PASSWORD = "dev-synthetic-password";

/** Claims the unclaimed owner row as the dev test user. A no-op once the owner is claimed (by anybody). */
export async function ensureDevUser(db: DatabaseSync, now?: Date): Promise<boolean> {
  if (!isOwnerUnclaimed(db)) return false;
  const r = await createUser(db, { email: DEV_USER_EMAIL, password: DEV_USER_PASSWORD, role: "admin", ...(now ? { now } : {}) });
  return r.ok;
}
