import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { AccountConfig } from "../lib/accounts-config.ts";
import { IMAP_BACKOFF_MAX_MS, IMAP_BACKOFF_MIN_MS, POLL_INTERVAL_MS, WATCHDOG_STALE_MS } from "../lib/constants.ts";
import {
  advanceCheckpoint,
  createImapFlowPort,
  fetchNewMessages,
  type ImapPort,
  type MessageMeta,
  reconcileCheckpoint,
  type TransientInput,
} from "../lib/imap.ts";
import { refreshSeenFlags } from "../lib/email-status.ts";
import { ingestMail } from "../lib/ingest.ts";

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export type WorkerState = "connecting" | "connected" | "backoff" | "paused";

export interface ImapWorkersDeps {
  db: DatabaseSync;
  accounts: AccountConfig[];
  createPort?: (account: AccountConfig) => ImapPort;
  /** Called once for each NEW mail (not for re-seen locations). `input` is in-memory only. */
  onIngested?: (emailId: number, input: TransientInput) => void | Promise<void>;
  clock?: Clock;
  random?: () => number;
}

export interface ImapWorkers {
  start(): void;
  stop(): Promise<void>;
}

const STUB_META = (messageId: string): MessageMeta => ({
  messageId, sender: "", subject: "", receivedAt: new Date(0).toISOString(), spf: "unknown",
  dkim: "unknown", dmarc: "unknown", listUnsubscribePresent: false, replyToDiffersFromFrom: false,
});

function isAuthError(err: unknown): boolean {
  const e = err as { authenticationFailed?: boolean; code?: string } | null;
  return e?.authenticationFailed === true || e?.code === "imap_auth";
}

class AccountWorker {
  private readonly account: AccountConfig;
  private readonly deps: ImapWorkersDeps;
  private readonly clock: Clock;
  private readonly random: () => number;
  private generation = 0;
  private stopped = false;
  private port: ImapPort | null = null;
  private queue: Promise<void> = Promise.resolve();
  private timers = new Set<unknown>();
  private attempt = 0;
  private lastOkAt = 0;

  constructor(account: AccountConfig, deps: ImapWorkersDeps) {
    this.account = account;
    this.deps = deps;
    this.clock = deps.clock ?? realClock;
    this.random = deps.random ?? Math.random;
  }

  start(): void {
    void this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.teardown();
  }

  // ---- state & audit (codes only, never details) ----
  private setState(state: WorkerState, errorCode: string | null = null, touch?: "event" | "poll"): void {
    const ts = new Date(this.clock.now()).toISOString();
    this.deps.db.prepare(
      `UPDATE worker_status SET state = ?, error_code = ?, updated_at = ?,
         last_event_at = CASE WHEN ? = 'event' THEN ? ELSE last_event_at END,
         last_poll_at = CASE WHEN ? = 'poll' THEN ? ELSE last_poll_at END
       WHERE account_id = ?`,
    ).run(state, errorCode, ts, touch ?? "", ts, touch ?? "", ts, this.account.id);
  }
  private touch(kind: "event" | "poll"): void {
    const ts = new Date(this.clock.now()).toISOString();
    const col = kind === "event" ? "last_event_at" : "last_poll_at";
    this.deps.db.prepare(`UPDATE worker_status SET ${col} = ?, updated_at = ? WHERE account_id = ?`).run(
      ts, ts, this.account.id,
    );
  }
  private audit(action: string, details: Record<string, unknown> = {}): void {
    this.deps.db.prepare(
      `INSERT INTO audit_log (occurred_at, trace_id, actor, action, account_id, details_json)
       VALUES (?, ?, 'worker', ?, ?, ?)`,
    ).run(new Date(this.clock.now()).toISOString(), randomUUID(), action, this.account.id, JSON.stringify(details));
  }

  // ---- lifecycle ----
  private async teardown(): Promise<void> {
    this.generation++;
    for (const t of this.timers) this.clock.clearTimeout(t);
    this.timers.clear();
    const p = this.port;
    this.port = null;
    if (p) {
      try {
        await p.close();
      } catch {
        // already closed
      }
    }
  }

  private timer(fn: () => void, ms: number): void {
    const h = this.clock.setTimeout(() => {
      this.timers.delete(h);
      fn();
    }, ms);
    this.timers.add(h);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const gen = ++this.generation;
    this.setState("connecting");
    const port = (this.deps.createPort ?? defaultPort)(this.account);
    this.port = port;
    this.queue = Promise.resolve();
    port.on("exists", () => this.run(gen, async () => {
      this.touch("event");
      await this.syncInbox(port);
      await port.watch(this.account.mailbox);
      this.lastOkAt = this.clock.now();
    }));
    port.on("close", () => void this.fail(gen, "imap_closed"));
    port.on("error", (e) => {
      if (e.code === "imap_auth") void this.pause(gen);
      else void this.fail(gen, "imap_error");
    });
    try {
      await port.connect();
      if (gen !== this.generation) return;
      this.attempt = 0;
      this.lastOkAt = this.clock.now();
      this.setState("connected");
      this.audit("worker_connected");
      this.run(gen, async () => {
        await this.syncAll(port);
        await port.watch(this.account.mailbox);
        this.lastOkAt = this.clock.now();
      });
      this.schedulePoll(gen);
      this.scheduleWatchdog(gen);
    } catch (err) {
      await this.handleError(gen, err);
    }
  }

  /** Serial per-account execution. A stale generation's tasks are dropped. */
  private run(gen: number, fn: () => Promise<void>): void {
    this.queue = this.queue
      .then(() => (gen !== this.generation ? undefined : fn()))
      .catch((err) => this.handleError(gen, err));
  }

  private async handleError(gen: number, err: unknown): Promise<void> {
    if (isAuthError(err)) await this.pause(gen);
    else await this.fail(gen, "imap_error");
  }

  private async pause(gen: number): Promise<void> {
    if (gen !== this.generation || this.stopped) return;
    await this.teardown();
    this.setState("paused", "imap_auth");
    this.audit("worker_paused", { code: "imap_auth" });
  }

  private async fail(gen: number, code: string, auditAction = "worker_backoff"): Promise<void> {
    if (gen !== this.generation || this.stopped) return;
    await this.teardown();
    const base = Math.min(IMAP_BACKOFF_MAX_MS, IMAP_BACKOFF_MIN_MS * 2 ** this.attempt);
    const delay = Math.min(IMAP_BACKOFF_MAX_MS, Math.round(base * (0.5 + 0.5 * this.random())));
    this.attempt++;
    this.setState("backoff", code === "imap_closed" || code === "imap_error" ? code : "imap_error");
    this.audit(auditAction, { code, delay_ms: delay, attempt: this.attempt });
    this.timer(() => void this.connect(), delay);
  }

  private schedulePoll(gen: number): void {
    this.timer(() => {
      if (gen !== this.generation) return;
      const port = this.port;
      if (!port) return;
      this.run(gen, async () => {
        await this.syncAll(port);
        await port.watch(this.account.mailbox);
        this.lastOkAt = this.clock.now();
        this.touch("poll");
      });
      this.schedulePoll(gen);
    }, POLL_INTERVAL_MS);
  }

  private scheduleWatchdog(gen: number): void {
    this.timer(() => {
      if (gen !== this.generation) return;
      if (this.clock.now() - this.lastOkAt > WATCHDOG_STALE_MS) {
        void this.fail(gen, "watchdog_stale", "worker_reconnect_forced");
        return;
      }
      this.scheduleWatchdog(gen);
    }, POLL_INTERVAL_MS);
  }

  // ---- sync ----
  private async syncAll(port: ImapPort): Promise<void> {
    await this.syncInbox(port);
    if (this.account.spam_mailbox) await this.syncSpam(port, this.account.spam_mailbox);
    // Provider \Seen flags of known mails (read-only FETCH FLAGS); the app never writes them back.
    const now = new Date(this.clock.now());
    await refreshSeenFlags(port, this.deps.db, { accountId: this.account.id, folder: this.account.mailbox, now });
    if (this.account.spam_mailbox) {
      await refreshSeenFlags(port, this.deps.db, { accountId: this.account.id, folder: this.account.spam_mailbox, now });
    }
  }

  private async syncInbox(port: ImapPort): Promise<void> {
    const { db } = this.deps;
    const newIds = new Set<number>();
    const traceId = randomUUID();
    await fetchNewMessages(port, db, {
      accountId: this.account.id,
      folder: this.account.mailbox,
      now: new Date(this.clock.now()),
      traceId,
      writeMetadata: (meta, loc, flags) => {
        const r = ingestMail(db, { accountId: this.account.id, meta, loc, now: new Date(this.clock.now()), traceId, seen: flags.seen });
        if (r.isNew) newIds.add(r.emailId);
        return r.emailId;
      },
      onIngested: async (emailId, input) => {
        if (!newIds.delete(emailId) || !this.deps.onIngested) return;
        try {
          await this.deps.onIngested(emailId, input);
        } catch {
          // a consumer failure must not break the IMAP worker
        }
      },
    });
  }

  /** Spam folder: headers only; only message-ids of already known mails are matched (D8). */
  private async syncSpam(port: ImapPort, folder: string): Promise<void> {
    const { db } = this.deps;
    const now = new Date(this.clock.now());
    const traceId = randomUUID();
    const status = await port.mailboxStatus(folder);
    const cp = reconcileCheckpoint(db, this.account.id, folder, status, { now, traceId });
    if (cp.kind !== "continue") return;
    const headers = (await port.fetchHeadersSince(folder, cp.fromUid)).sort((a, b) => a.uid - b.uid);
    const known = db.prepare("SELECT 1 FROM emails WHERE account_id = ? AND message_id = ?");
    for (const h of headers) {
      if (h.messageId !== null && known.get(this.account.id, h.messageId)) {
        ingestMail(db, {
          accountId: this.account.id,
          meta: STUB_META(h.messageId),
          loc: { folder, uid: h.uid, uidValidity: status.uidValidity },
          now,
          traceId,
          seen: h.seen,
        });
      }
      advanceCheckpoint(db, this.account.id, folder, h.uid, now);
    }
  }
}

function defaultPort(a: AccountConfig): ImapPort {
  return createImapFlowPort({ host: a.host, port: a.port, tls: a.tls, user: a.user, password: a.password });
}

/** One independent worker (own client, queue, backoff) per enabled account. */
export function createImapWorkers(deps: ImapWorkersDeps): ImapWorkers {
  const workers = deps.accounts.filter((a) => a.enabled).map((a) => new AccountWorker(a, deps));
  return {
    start() {
      for (const w of workers) w.start();
    },
    async stop() {
      await Promise.all(workers.map((w) => w.stop()));
    },
  };
}
