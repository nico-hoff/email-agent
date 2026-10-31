// GET /api/actions: read side for "Würde als gelesen markieren" (dry run) and the live action log (M7a).
// Reads only from SQLite and returns ids, codes and timestamps; no subject, sender or reason details.
import type { DatabaseSync } from "node:sqlite";

const MODES = ["dry_run", "live"] as const;
const STATUSES = ["planned", "done", "failed", "undone"] as const;
type Mode = (typeof MODES)[number];
type Status = (typeof STATUSES)[number];
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const CURSOR_MAX_CHARS = 200;

export interface ActionsQuery {
  mode: Mode | null;
  status: Status | null;
  limit: number;
  cursor: { createdAt: string; id: number } | null;
}

export type ParsedActionsQuery = { ok: true; query: ActionsQuery } | { ok: false; error: string };

export interface ActionItem {
  id: number;
  email_id: number;
  account: string;
  rule: string;
  action: string;
  mode: string;
  status: string;
  failure_code: string | null;
  created_at: string;
}

type StatusCounts = { planned: number; done: number; failed: number; undone: number };
export interface ActionsResult {
  actions: ActionItem[];
  next_cursor: string | null;
  counts: { dry_run: StatusCounts; live: StatusCounts };
}

function encodeCursor(createdAt: string, id: number): string {
  return Buffer.from(JSON.stringify([createdAt, id])).toString("base64url");
}

function decodeCursor(raw: string): { createdAt: string; id: number } | null {
  if (raw.length === 0 || raw.length > CURSOR_MAX_CHARS || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  let v: unknown;
  try {
    v = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!Array.isArray(v) || v.length !== 2) return null;
  const [createdAt, id] = v as unknown[];
  if (typeof createdAt !== "string" || createdAt.length === 0 || createdAt.length > 40) return null;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) return null;
  return { createdAt, id };
}

export function parseActionsQuery(url: URL): ParsedActionsQuery {
  const p = url.searchParams;
  const modeParam = p.get("mode");
  if (modeParam !== null && !(MODES as readonly string[]).includes(modeParam)) return { ok: false, error: "invalid_mode" };
  const statusParam = p.get("status");
  if (statusParam !== null && !(STATUSES as readonly string[]).includes(statusParam)) return { ok: false, error: "invalid_status" };
  let limit = DEFAULT_LIMIT;
  const limitParam = p.get("limit");
  if (limitParam !== null) {
    if (!/^\d+$/.test(limitParam)) return { ok: false, error: "invalid_limit" };
    limit = Math.min(Math.max(Number(limitParam), 1), MAX_LIMIT);
  }
  let cursor: ActionsQuery["cursor"] = null;
  const cursorParam = p.get("cursor");
  if (cursorParam !== null) {
    cursor = decodeCursor(cursorParam);
    if (cursor === null) return { ok: false, error: "invalid_cursor" };
  }
  return { ok: true, query: { mode: modeParam as Mode | null, status: statusParam as Status | null, limit, cursor } };
}

export function listActions(db: DatabaseSync, userId: number, q: ActionsQuery): ActionsResult {
  // Undo log entries (rule "undo") are internal: the undone action already carries status "undone".
  // Tenant scope: only actions on mails of this user's accounts (ADR 0033).
  const where: string[] = ["m.rule <> 'undo'", "a.user_id = ?"];
  const args: (string | number)[] = [userId];
  if (q.mode !== null) { where.push("m.mode = ?"); args.push(q.mode); }
  if (q.status !== null) { where.push("m.status = ?"); args.push(q.status); }
  if (q.cursor !== null) {
    where.push("(m.created_at < ? OR (m.created_at = ? AND m.id < ?))");
    args.push(q.cursor.createdAt, q.cursor.createdAt, q.cursor.id);
  }
  const rows = db.prepare(
    `SELECT m.id, m.email_id, e.account_id AS account, m.rule, m.action, m.mode, m.status, m.failure_code, m.created_at
     FROM mailbox_actions m JOIN emails e ON e.id = m.email_id JOIN accounts a ON a.id = e.account_id
     ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY m.created_at DESC, m.id DESC LIMIT ?`,
  ).all(...args, q.limit + 1) as unknown as ActionItem[];
  const page = rows.slice(0, q.limit).map((r) => ({
    id: r.id, email_id: r.email_id, account: r.account, rule: r.rule, action: r.action, mode: r.mode,
    status: r.status, failure_code: r.failure_code, created_at: r.created_at,
  }));
  const last = page.at(-1);
  const next_cursor = rows.length > q.limit && last ? encodeCursor(last.created_at, last.id) : null;

  const counts = { dry_run: { planned: 0, done: 0, failed: 0, undone: 0 }, live: { planned: 0, done: 0, failed: 0, undone: 0 } };
  const grouped = db.prepare(
    `SELECT m.mode, m.status, COUNT(*) AS n FROM mailbox_actions m JOIN emails e ON e.id = m.email_id JOIN accounts a ON a.id = e.account_id
     WHERE m.rule <> 'undo' AND a.user_id = ? GROUP BY m.mode, m.status`,
  ).all(userId) as unknown as { mode: Mode; status: Status; n: number }[];
  for (const g of grouped) {
    const target: StatusCounts = g.mode === "live" ? counts.live : counts.dry_run;
    if (g.status === "planned") target.planned = g.n;
    else if (g.status === "done") target.done = g.n;
    else if (g.status === "failed") target.failed = g.n;
    else if (g.status === "undone") target.undone = g.n;
  }
  return { actions: page, next_cursor, counts };
}
