// Push triggers (R6, ADR 0036). Two kinds:
//  - important_mail: hooked into the classification pipeline (onClassified, ids only). A fresh, classified, not-noise mail
//    that is urgent (>= 2) or open is remembered per user; at most one push per 10 minutes goes out, with the count of mails
//    that are STILL important at that moment (read or done mails drop out).
//  - briefing_ready: a daily job at 07:30 Europe/Berlin. It counts open mails from the database (no model call, no text
//    stored) and pushes "Dein Briefing ist bereit" when something is open. The briefing itself is still generated on open.
// State (last push per kind, pending mail ids, day of the last briefing push) lives in user_state under `push_state`:
// ids, counts and timestamps only. Work is serialised on one chain; errors are swallowed (a push problem must never
// break classification).
import type { DatabaseSync } from "node:sqlite";
import { listEmails, pushCandidate } from "./email-api.ts";
import { buildPayload, hasSubscribers, PUSH_MIN_INTERVAL_MS, sendToUser, type PushTransport, type SendSummary } from "./push.ts";
import type { VapidSigner } from "./push-crypto.ts";
import { emailUserId } from "./tenant.ts";
import { getUserState, setUserState } from "./user-state.ts";

export const PUSH_STATE_KEY = "push_state";
/** A mail counts as new for 60 minutes after it was first seen: an initial sync of old mail must not flood the phone. */
export const PUSH_FRESH_MS = 60 * 60_000;
export const PUSH_PENDING_MAX = 100;
export const PUSH_TICK_MS = 60_000;
/** Briefing push window in Europe/Berlin local time: from 07:30 until 11:00 (a server that was down at 07:30 still sends it). */
export const BRIEFING_PUSH_FROM_MINUTES = 7 * 60 + 30;
export const BRIEFING_PUSH_UNTIL_MINUTES = 11 * 60;
export const BRIEFING_TIME_ZONE = "Europe/Berlin";

interface KindState { last_sent_at: string | null; pending: number[] }
interface PushState { important_mail: KindState; briefing_day: string | null }

const emptyState = (): PushState => ({ important_mail: { last_sent_at: null, pending: [] }, briefing_day: null });

function readState(db: DatabaseSync, userId: number): PushState {
  const raw = getUserState(db, userId, PUSH_STATE_KEY);
  const out = emptyState();
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  const m = new Map(Object.entries(raw));
  const im = m.get("important_mail");
  if (typeof im === "object" && im !== null && !Array.isArray(im)) {
    const k = new Map(Object.entries(im));
    const last = k.get("last_sent_at");
    const pending = k.get("pending");
    out.important_mail = {
      last_sent_at: typeof last === "string" && Number.isFinite(Date.parse(last)) ? last : null,
      pending: Array.isArray(pending) ? pending.filter((n): n is number => Number.isInteger(n)).slice(-PUSH_PENDING_MAX) : [],
    };
  }
  const day = m.get("briefing_day");
  out.briefing_day = typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
  return out;
}

const writeState = (db: DatabaseSync, userId: number, s: PushState, now: Date) => setUserState(db, userId, PUSH_STATE_KEY, s, now.toISOString());

/** Local date (YYYY-MM-DD) and minutes since midnight in the briefing time zone. */
export function localClock(now: Date, timeZone: string = BRIEFING_TIME_ZONE): { day: string; minutes: number } {
  const parts = new Map(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(now).map((p) => [p.type, p.value] as const));
  return { day: `${parts.get("year")}-${parts.get("month")}-${parts.get("day")}`, minutes: Number(parts.get("hour")) * 60 + Number(parts.get("minute")) };
}

export interface PushNotifierOptions {
  db: DatabaseSync;
  /** undefined = feature off (no VAPID pair): every method is a no-op. */
  config: VapidSigner | undefined;
  transport: PushTransport;
  now?: () => Date;
  minIntervalMs?: number;
  tickMs?: number;
  log?: (message: string) => void;
}

export interface PushNotifier {
  /** Pipeline hook (ids only). Never throws. */
  onClassified(emailId: number): Promise<void>;
  /** Flushes pending important-mail pushes that became due and runs the daily briefing job. */
  tick(): Promise<void>;
  start(): void;
  stop(): void;
}

export function createPushNotifier(opts: PushNotifierOptions): PushNotifier {
  const { db, config } = opts;
  const now = opts.now ?? (() => new Date());
  const minInterval = opts.minIntervalMs ?? PUSH_MIN_INTERVAL_MS;
  const log = opts.log ?? (() => {});
  let chain: Promise<unknown> = Promise.resolve();
  let timer: ReturnType<typeof setInterval> | undefined;
  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = chain.then(fn);
    chain = p.then(() => {}, () => {});
    return p;
  };
  const deps = () => ({ db, config: config as VapidSigner, transport: opts.transport, now });
  const delivered = (s: SendSummary) => s.sent > 0;

  async function flushImportant(userId: number): Promise<void> {
    const state = readState(db, userId);
    const t = now();
    if (state.important_mail.pending.length === 0) return;
    const last = state.important_mail.last_sent_at;
    if (last !== null && t.getTime() - Date.parse(last) < minInterval) return; // later: the tick retries
    // Only mails that are still worth it now; read or done mails drop out.
    const still = state.important_mail.pending.filter((id) => pushCandidate(db, userId, id)?.important === true);
    if (still.length === 0) {
      state.important_mail.pending = [];
      writeState(db, userId, state, t);
      return;
    }
    const summary = await sendToUser(deps(), userId, buildPayload("important_mail", still.length), { urgency: "high" });
    if (delivered(summary)) {
      state.important_mail = { last_sent_at: t.toISOString(), pending: [] };
      writeState(db, userId, state, t);
    } else if (summary.sent + summary.retry_later + summary.skipped + summary.failed === 0) {
      // No device wants this kind (any more): forget the backlog instead of keeping it forever.
      state.important_mail.pending = [];
      writeState(db, userId, state, t);
    }
    // Otherwise the devices are in backoff: pending stays, the tick tries again.
  }

  async function classified(emailId: number): Promise<void> {
    if (!config) return;
    const userId = emailUserId(db, emailId);
    if (userId === null || !hasSubscribers(db, userId, "important_mail")) return;
    const c = pushCandidate(db, userId, emailId);
    const t = now();
    if (!c?.important || t.getTime() - Date.parse(c.firstSeenAt) > PUSH_FRESH_MS) return;
    const state = readState(db, userId);
    if (!state.important_mail.pending.includes(emailId)) {
      state.important_mail.pending = [...state.important_mail.pending, emailId].slice(-PUSH_PENDING_MAX);
      writeState(db, userId, state, t);
    }
    await flushImportant(userId);
  }

  async function briefingJob(): Promise<void> {
    const t = now();
    const clock = localClock(t);
    if (clock.minutes < BRIEFING_PUSH_FROM_MINUTES || clock.minutes >= BRIEFING_PUSH_UNTIL_MINUTES) return;
    const users = db.prepare("SELECT DISTINCT user_id FROM push_subscriptions WHERE briefing_ready = 1").all() as { user_id: number }[];
    for (const { user_id: userId } of users) {
      const state = readState(db, userId);
      if (state.briefing_day === clock.day) continue;
      const open = listEmails(db, userId, { view: "open", account: null, status: null, limit: 1, cursor: null }).counts.open;
      if (open > 0) {
        const summary = await sendToUser(deps(), userId, buildPayload("briefing_ready", open), { urgency: "normal" });
        // Devices in backoff: try again on the next tick (still inside the window); mark the day once something arrived.
        if (!delivered(summary) && summary.sent + summary.removed === 0 && summary.retry_later + summary.skipped > 0) continue;
      }
      state.briefing_day = clock.day;
      writeState(db, userId, state, t);
    }
  }

  async function tickNow(): Promise<void> {
    if (!config) return;
    const users = db.prepare("SELECT DISTINCT user_id FROM push_subscriptions WHERE important_mail = 1").all() as { user_id: number }[];
    for (const { user_id: userId } of users) await flushImportant(userId);
    await briefingJob();
  }

  const guarded = (fn: () => Promise<void>, what: string) => enqueue(fn).catch(() => log(`push ${what} failed`));
  return {
    onClassified: (emailId) => guarded(() => classified(emailId), "trigger"),
    tick: () => guarded(tickNow, "tick"),
    start() {
      if (!config || timer) return;
      timer = setInterval(() => void this.tick(), opts.tickMs ?? PUSH_TICK_MS);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
