// Account supervisor (R2): the server process owns the IMAP workers, route modules share no memory with it, so the
// database is the channel. Every few seconds it reads the accounts (enabled, decryptable, all users) and starts, stops
// or restarts one worker per account. Fail-closed: without a usable ACCOUNTS_ENCRYPTION_KEY no worker runs and every
// enabled account shows `paused / no_encryption_key`. An account whose secret cannot be decrypted shows
// `paused / secret_unreadable` and does not start. Logs carry counts and account ids only.
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AccountConfig } from "./accounts-config.ts";
import { loadKeyring } from "./account-secrets.ts";
import { loadWorkerAccounts, markDisabledWorkers, markWorkerConnecting, markWorkerPaused, markWorkersBlocked } from "./mail-accounts.ts";

export const SUPERVISOR_INTERVAL_MS = 15_000;

export interface SupervisedWorker { stop(): Promise<void> }

export interface SupervisorOptions {
  db: DatabaseSync;
  env: Record<string, string | undefined>;
  /**
   * The live account list the rest of the process reads (classification pipeline, mailbox actions). The supervisor keeps it
   * equal to the running accounts by mutating it in place; it never holds more than the accounts that run.
   */
  accounts: AccountConfig[];
  startWorker(account: AccountConfig): SupervisedWorker;
  intervalMs?: number;
  log?: (message: string) => void;
  now?: () => Date;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export interface Supervisor {
  /** Reads the database once and applies the difference; calls are serialised. */
  reconcile(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
  running(): string[];
}

/** Everything that requires a new connection when it changes (the secret enters as a hash, never as text). */
function fingerprint(a: AccountConfig): string {
  return createHash("sha256")
    .update(JSON.stringify([a.host, a.port, a.tls, a.user, a.password, a.mailbox, a.spam_mailbox ?? null]))
    .digest("hex");
}

export function createAccountSupervisor(o: SupervisorOptions): Supervisor {
  const log = o.log ?? (() => {});
  const now = o.now ?? (() => new Date());
  const workers = new Map<string, { print: string; worker: SupervisedWorker }>();
  const startTimer = o.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const stopTimer = o.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  let timer: unknown;
  let chain: Promise<void> = Promise.resolve();
  let stopped = false;

  const dropLive = (id: string): void => {
    const i = o.accounts.findIndex((a) => a.id === id);
    if (i >= 0) o.accounts.splice(i, 1);
  };
  async function stopOne(id: string): Promise<void> {
    const w = workers.get(id);
    workers.delete(id);
    dropLive(id);
    try {
      await w?.worker.stop();
    } catch {
      log(`worker stop failed: ${id}`);
    }
  }

  async function apply(): Promise<void> {
    if (stopped) return;
    const keys = loadKeyring(o.env);
    if (!keys.ok) {
      for (const id of [...workers.keys()]) await stopOne(id);
      markWorkersBlocked(o.db, keys.code, now());
      return;
    }
    const { accounts: desired, unreadable } = loadWorkerAccounts(o.db, keys.keyring);
    const want = new Set(desired.map((a) => a.id));
    for (const id of [...workers.keys()]) if (!want.has(id)) await stopOne(id);
    for (const id of unreadable) markWorkerPaused(o.db, id, "secret_unreadable", now());
    markDisabledWorkers(o.db, now());
    for (const a of desired) {
      const print = fingerprint(a);
      const have = workers.get(a.id);
      if (have && have.print === print) {
        // Same connection: settings that do not need a reconnect (context, threshold, mode, label) apply in place.
        const i = o.accounts.findIndex((x) => x.id === a.id);
        if (i >= 0) o.accounts[i] = a;
        continue;
      }
      if (have) await stopOne(a.id);
      markWorkerConnecting(o.db, a.id, now());
      o.accounts.push(a);
      try {
        workers.set(a.id, { print, worker: o.startWorker(a) });
        log(`worker started: ${a.id}`);
      } catch {
        dropLive(a.id);
        markWorkerPaused(o.db, a.id, "start_failed", now());
        log(`worker start failed: ${a.id}`);
      }
    }
  }

  const reconcile = (): Promise<void> => {
    chain = chain.then(apply).catch(() => log("account supervisor pass failed"));
    return chain;
  };

  return {
    reconcile,
    start() {
      void reconcile();
      timer = startTimer(() => void reconcile(), o.intervalMs ?? SUPERVISOR_INTERVAL_MS);
    },
    async stop() {
      stopped = true;
      if (timer !== undefined) stopTimer(timer);
      timer = undefined;
      await chain;
      for (const id of [...workers.keys()]) await stopOne(id);
    },
    running: () => [...workers.keys()],
  };
}
