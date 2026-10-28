// Read side of the mobile API (T35, T64, T47): views, cursor pagination, detail. Reads only from SQLite and returns
// metadata, Jev answers and app state: never a body, excerpt, raw source or account host/user (H3).
// Module is reachable from API routes: no dynamic obj[key] reads (the Veryfront loader rejects them), Map instead.
import type { DatabaseSync } from "node:sqlite";
import { type AccountTag, accountTag } from "./account-color.ts";
import type { AutoActionMode } from "./accounts-config.ts";
import { interpretNoul, type NoulInterpreter, type NoulReading } from "./jev-response.ts";
import { NOUL_CALIBRATION, noulThreshold } from "./noul-calibration.ts";

export const VIEWS = ["important", "open", "noise", "all"] as const;
export type View = (typeof VIEWS)[number];
export const STATUSES = ["pending", "retry_wait", "classified", "failed", "paused"] as const;
export const PAGED_MAX_LIMIT = 50;
export const DEFAULT_LIMIT = 50;

/** Categories that make a mail "noise" (Plan v5, 3.1). */
const NOISE_CATEGORIES: ReadonlySet<string> = new Set(["spam", "newsletter_promo"]);
/** Jev routes that count as a call to action (Plan v5, 3.6). */
const CTA_ROUTES: ReadonlySet<string> = new Set(["draft_reply", "notify"]);

// ---- pure rules -------------------------------------------------------------------------------------------------

export interface OpenInput {
  /** Reading of the needs_my_reply answer under the calibration of its question set; null = no such answer. */
  needsMyReply: NoulReading | null;
  route: string | null;
  seen: boolean;
  done: boolean;
}

/**
 * Plan v5, 3.6: a mail is open if it has a call to action (needs_my_reply positive, or route draft_reply/notify)
 * and is neither read (provider \Seen) nor done (Nico, in the app). While needs_my_reply is uncalibrated
 * ("unmapped", docs/jev-contract.md) only the route can make a call to action.
 */
export function isOpen(i: OpenInput): boolean {
  const cta = i.needsMyReply === "positive" || (i.route !== null && CTA_ROUTES.has(i.route));
  return cta && !i.seen && !i.done;
}

/** Noise = category spam or newsletter_promo, or filed by the provider in its spam folder. Everything else is "important". */
export function isNoise(i: { category: string | null; providerSpam: boolean }): boolean {
  return i.providerSpam || (i.category !== null && NOISE_CATEGORIES.has(i.category));
}

// ---- sort keys and cursors ----------------------------------------------------------------------------------------

export interface SortKey {
  urgency: number | null;
  importance: number | null;
  receivedAt: string;
  id: number;
}

function descNullsLast(x: number | null, y: number | null): number {
  if (x === y) return 0;
  if (x === null) return 1;
  if (y === null) return -1;
  return y - x;
}

/** Negative when `a` comes first: urgency, importance, time, id; all descending, missing values last. */
export function compareSortKeys(a: SortKey, b: SortKey): number {
  return descNullsLast(a.urgency, b.urgency) || descNullsLast(a.importance, b.importance) ||
    (a.receivedAt < b.receivedAt ? 1 : a.receivedAt > b.receivedAt ? -1 : 0) || b.id - a.id;
}

const CURSOR_MAX_CHARS = 200;
const nullableNumber = (v: unknown): v is number | null => v === null || (typeof v === "number" && Number.isFinite(v));

/** Opaque to clients: base64url of [urgency, importance, received_at, id] of the last row on the page. */
export function encodeCursor(k: SortKey): string {
  return Buffer.from(JSON.stringify([k.urgency, k.importance, k.receivedAt, k.id])).toString("base64url");
}

export function decodeCursor(raw: string): SortKey | null {
  if (raw.length === 0 || raw.length > CURSOR_MAX_CHARS || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  let v: unknown;
  try {
    v = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!Array.isArray(v) || v.length !== 4) return null;
  const [urgency, importance, receivedAt, id] = v as unknown[];
  if (!nullableNumber(urgency) || !nullableNumber(importance)) return null;
  if (typeof receivedAt !== "string" || receivedAt.length === 0 || receivedAt.length > 40) return null;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) return null;
  return { urgency, importance, receivedAt, id };
}

// ---- query ------------------------------------------------------------------------------------------------------

export interface ListQuery {
  view: View;
  account: string | null;
  status: string | null;
  limit: number;
  cursor: SortKey | null;
}

export type ParsedQuery = { ok: true; query: ListQuery } | { ok: false; error: string };

export function parseListQuery(url: URL): ParsedQuery {
  const p = url.searchParams;
  const viewParam = p.get("view");
  const cursorParam = p.get("cursor");
  const max = PAGED_MAX_LIMIT;
  let limit = Math.min(DEFAULT_LIMIT, max);
  const limitParam = p.get("limit");
  if (limitParam !== null) {
    if (!/^\d+$/.test(limitParam)) return { ok: false, error: "invalid_limit" };
    limit = Math.min(Math.max(Number(limitParam), 1), max);
  }
  const status = p.get("status");
  if (status !== null && !(STATUSES as readonly string[]).includes(status)) return { ok: false, error: "invalid_status" };
  let view: View = "all";
  if (viewParam !== null) {
    if (!(VIEWS as readonly string[]).includes(viewParam)) return { ok: false, error: "invalid_view" };
    view = viewParam as View;
  }
  let cursor: SortKey | null = null;
  if (cursorParam !== null) {
    cursor = decodeCursor(cursorParam);
    if (cursor === null) return { ok: false, error: "invalid_cursor" };
  }
  return { ok: true, query: { view, account: p.get("account"), status, limit, cursor } };
}

// ---- rows -------------------------------------------------------------------------------------------------------

interface Row {
  id: number;
  account_id: string;
  account_label: string;
  account_color: string | null;
  spam_mailbox: string | null;
  sender: string;
  subject: string;
  received_at: string;
  first_seen_at: string;
  folder: string | null;
  uid: number | null;
  cls_id: number | null;
  question_set_version: string | null;
  model_requested: string | null;
  model_reported: string | null;
  status: string | null;
  failure_code: string | null;
  attempts: number | null;
  latency_ms: number | null;
  seen: number;
  done: number;
  category: unknown;
  route: unknown;
  urgency: unknown;
  importance: unknown;
  needs_my_reply: unknown;
}

const answerValue = (key: string) =>
  `(SELECT json_extract(answer_json, '$.value') FROM classification_answers WHERE classification_id = c.id AND question_key = '${key}')`;

const SELECT_ROWS = `
  SELECT e.id, e.account_id, a.label AS account_label, a.color AS account_color, a.spam_mailbox,
         e.sender, e.subject, e.received_at, e.first_seen_at, l.folder, l.uid,
         c.id AS cls_id, c.question_set_version, c.model_requested, c.model_reported,
         c.status, c.failure_code, c.attempts, c.latency_ms,
         COALESCE(s.seen, 0) AS seen, COALESCE(s.done, 0) AS done,
         ${answerValue("category")} AS category, ${answerValue("route")} AS route,
         ${answerValue("urgency")} AS urgency, ${answerValue("importance")} AS importance,
         ${answerValue("needs_my_reply")} AS needs_my_reply
  FROM emails e
  JOIN accounts a ON a.id = e.account_id
  LEFT JOIN email_locations l ON l.id = (
    SELECT MAX(id) FROM email_locations WHERE email_id = e.id AND is_active = 1)
  LEFT JOIN classifications c ON c.id = (
    SELECT MAX(id) FROM classifications WHERE email_id = e.id)
  LEFT JOIN email_status s ON s.email_id = e.id`;

interface Derived {
  row: Row;
  key: SortKey;
  category: string | null;
  route: string | null;
  needsReading: NoulReading | null;
  providerSpam: boolean;
  seen: boolean;
  done: boolean;
  open: boolean;
  noise: boolean;
}

export interface ApiDeps {
  /** Reading of noul answers; tests inject a calibrated needs_my_reply. Default: interpretNoul. */
  readNoul?: NoulInterpreter;
  /** Mode of the automatic rule per account id (list header); missing accounts count as dry_run. */
  autoActionModes?: ReadonlyMap<string, AutoActionMode>;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

function derive(row: Row, readNoul: NoulInterpreter): Derived {
  const category = str(row.category);
  const route = str(row.route);
  const needs = num(row.needs_my_reply);
  const needsReading = needs === null
    ? null
    : readNoul({ key: "needs_my_reply", type: "noul", value: needs }, row.question_set_version ?? undefined);
  const providerSpam = row.spam_mailbox !== null && row.folder !== null && row.folder === row.spam_mailbox;
  const seen = row.seen === 1;
  const done = row.done === 1;
  return {
    row,
    key: { urgency: num(row.urgency), importance: num(row.importance), receivedAt: row.received_at, id: row.id },
    category,
    route,
    needsReading,
    providerSpam,
    seen,
    done,
    open: isOpen({ needsMyReply: needsReading, route, seen, done }),
    noise: isNoise({ category, providerSpam }),
  };
}

type Disagreement = "provider_spam_jev_not_spam" | "jev_spam_provider_not_spam" | null;

/**
 * Disagreement rule (uses the category answer and the shadow candidate, not the calibrated is_spam reading):
 * provider_spam = active location folder equals the account's spam_mailbox.
 * jev_spam = category answer equals "spam" OR shadow_quarantine.candidate is true.
 * Only classified emails are compared.
 */
function disagreementOf(providerSpam: boolean, jevSpam: boolean): Disagreement {
  if (providerSpam && !jevSpam) return "provider_spam_jev_not_spam";
  if (!providerSpam && jevSpam) return "jev_spam_provider_not_spam";
  return null;
}

function parseJson(json: string | null): unknown {
  if (json === null) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export interface EmailItem {
  id: number;
  account_id: string;
  account: AccountTag;
  sender: string;
  subject: string;
  received_at: string;
  first_seen_at: string;
  active_location: { folder: string; uid: number | null } | null;
  provider_spam: boolean;
  seen: boolean;
  done: boolean;
  open: boolean;
  category: string | null;
  route: string | null;
  urgency: number | null;
  importance: number | null;
  needs_my_reply: NoulReading | null;
  classification: Record<string, unknown> | null;
  shadow_quarantine: Record<string, unknown> | null;
  disagreement: Disagreement;
}

function buildItem(db: DatabaseSync, d: Derived, readNoul: NoulInterpreter): EmailItem {
  const r = d.row;
  const answers = new Map<string, Record<string, unknown>>();
  let shadow: Record<string, unknown> | null = null;
  if (r.cls_id !== null) {
    const rows = db.prepare(
      "SELECT question_key, type, answer_json, probabilities_json FROM classification_answers WHERE classification_id = ? ORDER BY id",
    ).all(r.cls_id) as { question_key: string; type: string; answer_json: string; probabilities_json: string | null }[];
    for (const a of rows) {
      const parsed = parseJson(a.answer_json);
      const value = isRecord(parsed) ? new Map(Object.entries(parsed)).get("value") : undefined;
      if (a.question_key === "shadow_quarantine") {
        shadow = isRecord(parsed) ? parsed : null;
        continue;
      }
      const entry: Record<string, unknown> = { type: a.type, value: value ?? null };
      const p = parseJson(a.probabilities_json);
      if (p !== null) entry.probabilities = p;
      if (a.type === "noul" && typeof entry.value === "number") {
        // Metadata only: the reading under the calibration of this classification's question set.
        const version = r.question_set_version ?? undefined;
        const reading = readNoul({ key: a.question_key, type: "noul", value: entry.value }, version);
        entry.reading = reading;
        entry.threshold = reading === "unmapped" ? null : noulThreshold(a.question_key, version);
        entry.calibration_version = reading === "unmapped" ? null : NOUL_CALIBRATION.version;
      }
      answers.set(a.question_key, entry);
    }
  }
  const jevSpam = d.category?.toLowerCase() === "spam" || (shadow as { candidate?: unknown } | null)?.candidate === true;
  return {
    id: r.id,
    account_id: r.account_id,
    account: accountTag({ id: r.account_id, label: r.account_label, color: r.account_color }),
    sender: r.sender,
    subject: r.subject,
    received_at: r.received_at,
    first_seen_at: r.first_seen_at,
    active_location: r.folder === null ? null : { folder: r.folder, uid: r.uid },
    provider_spam: d.providerSpam,
    seen: d.seen,
    done: d.done,
    open: d.open,
    category: d.category,
    route: d.route,
    urgency: d.key.urgency,
    importance: d.key.importance,
    needs_my_reply: d.needsReading,
    classification: r.cls_id === null ? null : {
      status: r.status,
      question_set_version: r.question_set_version,
      model_requested: r.model_requested,
      model_reported: r.model_reported,
      failure_code: r.failure_code,
      attempts: r.attempts,
      latency_ms: r.latency_ms,
      answers: Object.fromEntries(answers),
    },
    shadow_quarantine: shadow,
    disagreement: r.status === "classified" ? disagreementOf(d.providerSpam, jevSpam) : null,
  };
}

// ---- list -------------------------------------------------------------------------------------------------------

export interface Counts {
  important: number;
  open: number;
  noise: number;
  all: number;
}

export interface ListResult {
  emails: EmailItem[];
  next_cursor: string | null;
  /** Badge numbers for every view, after the account and status filter, independent of the selected view and page. */
  counts: Counts;
  accounts: AccountTag[];
  /** Mode of "Spam gelesen" per account id: only the mode, nothing from the accounts file. */
  auto_actions: Record<string, AutoActionMode>;
  view: View;
}

function inView(view: View, d: Derived): boolean {
  switch (view) {
    case "important":
      return !d.noise;
    case "noise":
      return d.noise;
    case "open":
      return d.open;
    default:
      return true;
  }
}

export function listEmails(db: DatabaseSync, q: ListQuery, deps: ApiDeps = {}): ListResult {
  const readNoul = deps.readNoul ?? interpretNoul;
  const where: string[] = [];
  const params: string[] = [];
  if (q.account !== null) {
    where.push("e.account_id = ?");
    params.push(q.account);
  }
  if (q.status !== null) {
    where.push("c.status = ?");
    params.push(q.status);
  }
  const rows = db.prepare(`${SELECT_ROWS} ${where.length ? "WHERE " + where.join(" AND ") : ""}`).all(...params) as unknown as Row[];
  const all = rows.map((r) => derive(r, readNoul));

  const counts: Counts = { important: 0, open: 0, noise: 0, all: all.length };
  for (const d of all) {
    if (d.noise) counts.noise++;
    else counts.important++;
    if (d.open) counts.open++;
  }

  const view = q.view;
  let list = all.filter((d) => inView(view, d)).sort((a, b) => compareSortKeys(a.key, b.key));
  if (q.cursor !== null) {
    const after = q.cursor;
    const start = list.findIndex((d) => compareSortKeys(d.key, after) > 0);
    list = start < 0 ? [] : list.slice(start);
  }
  const page = list.slice(0, q.limit);
  const last = page.at(-1);
  const next_cursor = list.length > q.limit && last ? encodeCursor(last.key) : null;

  const accounts = (db.prepare("SELECT id, label, color FROM accounts ORDER BY id").all() as { id: string; label: string; color: string | null }[])
    .map(accountTag);
  const auto_actions = Object.fromEntries(accounts.map((a) => [a.id, deps.autoActionModes?.get(a.id) ?? "dry_run"] as const));
  return { emails: page.map((d) => buildItem(db, d, readNoul)), next_cursor, counts, accounts, auto_actions, view };
}

// ---- detail -----------------------------------------------------------------------------------------------------

/** The "Spam gelesen" action of a mail: codes and time only, never the reason details. */
export interface MailboxActionInfo {
  id: number;
  rule: string;
  action: string;
  mode: string;
  status: string;
  failure_code: string | null;
  created_at: string;
}

export interface EmailDetail extends EmailItem {
  /** Planned (dry run), executed, failed or undone action of the rule "spam_seen"; null if none exists. */
  mailbox_action: MailboxActionInfo | null;
  /** Provider-side moves seen by the worker (audit folder_changed), oldest first. */
  folder_history: { at: string; from: string | null; to: string | null }[];
  /** Every place the mail was seen in, oldest first. UIDs stay internal. */
  locations: { folder: string; is_active: boolean; first_seen_at: string; last_seen_at: string }[];
}

export function getEmailDetail(db: DatabaseSync, id: number, deps: ApiDeps = {}): EmailDetail | null {
  const readNoul = deps.readNoul ?? interpretNoul;
  const row = db.prepare(`${SELECT_ROWS} WHERE e.id = ?`).get(id) as unknown as Row | undefined;
  if (!row) return null;
  const item = buildItem(db, derive(row, readNoul), readNoul);
  const history = (db.prepare(
    "SELECT occurred_at, details_json FROM audit_log WHERE email_id = ? AND action = 'folder_changed' ORDER BY occurred_at, id",
  ).all(id) as { occurred_at: string; details_json: string }[]).map((h) => {
    const d = parseJson(h.details_json);
    const m = isRecord(d) ? new Map(Object.entries(d)) : new Map<string, unknown>();
    return { at: h.occurred_at, from: str(m.get("from")), to: str(m.get("to")) };
  });
  const locations = (db.prepare(
    "SELECT folder, is_active, first_seen_at, last_seen_at FROM email_locations WHERE email_id = ? ORDER BY id",
  ).all(id) as { folder: string; is_active: number; first_seen_at: string; last_seen_at: string }[]).map((l) => ({
    folder: l.folder,
    is_active: l.is_active === 1,
    first_seen_at: l.first_seen_at,
    last_seen_at: l.last_seen_at,
  }));
  const action = db.prepare(
    `SELECT id, rule, action, mode, status, failure_code, created_at FROM mailbox_actions
     WHERE email_id = ? AND rule = 'spam_seen' ORDER BY created_at DESC, id DESC LIMIT 1`,
  ).get(id) as unknown as MailboxActionInfo | undefined;
  const mailbox_action = action
    ? { id: action.id, rule: action.rule, action: action.action, mode: action.mode, status: action.status, failure_code: action.failure_code, created_at: action.created_at }
    : null;
  return { ...item, mailbox_action, folder_history: history, locations };
}
