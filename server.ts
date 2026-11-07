import net from "node:net";
import { KILL_SWITCH_FILE, PROJECT_ROOT } from "./packages/core/src/constants.ts";
import { prepareSyntheticDevDatabase } from "./packages/core/src/synthetic-dev-db.ts";
import { startup as defaultStartup, type StartupResult } from "./packages/core/src/accounts.ts";
import { createImapWorkers, type ImapWorkers, type ImapWorkersDeps } from "./workers/imap-worker.ts";
import { fileURLToPath } from "node:url";
import { createClassificationPipeline, createPersistResponse } from "./packages/core/src/classification-pipeline.ts";
import { topicListForUser, topicsEnabled } from "./packages/core/src/topics-store.ts";
import { createJevClient, type JevClient } from "./packages/core/src/jev.ts";
import { createDecisionsClient } from "./packages/core/src/decisions-client.ts";
import { LUNA_CLASSIFIER } from "./packages/core/src/classifier-models.ts";
import { classifierModelFor } from "./packages/core/src/user-settings.ts";
import { accountUserId } from "./packages/core/src/tenant.ts";
import { createImapFlowPort, type ImapPort } from "./packages/core/src/imap.ts";
import { applyOpenRouterEnv } from "./packages/core/src/openrouter-env.ts";
import { assertFlyAuthConfigured } from "./packages/core/src/fly-guard.ts";
import { findStyleScanHazards } from "./packages/core/src/dev-hazards.ts";
import { type AccountConfig, DEFAULT_SPAM_THRESHOLD } from "./packages/core/src/accounts-config.ts";
import { createAccountSupervisor } from "./packages/core/src/account-supervisor.ts";
import { dataDirFromEnv, interceptRequest } from "./packages/core/src/auth-runtime.ts";
import { appPasswordStatus, selectAuthMode } from "./packages/core/src/auth.ts";
import { openDatabase } from "./packages/core/src/db.ts";
import { ensureDevUser } from "./packages/core/src/users.ts";
import { createMailboxActions, type MailboxActions } from "./packages/core/src/mailbox-actions.ts";
import { createPushNotifier, type PushNotifier } from "./packages/core/src/push-notify.ts";
import { fetchTransport, loadPushConfig, type PushTransport } from "./packages/core/src/push.ts";
import { join } from "node:path";
import { startServer } from "veryfront/server";
import { register, tryResolve } from "veryfront/extensions/contracts";
import { EsbuildBundler, EsModuleLexer } from "@veryfront/ext-bundler-esbuild";

// Same contract registration the veryfront CLI performs before starting a server.
function ensureBundlerContracts(): void {
  if (!tryResolve("Bundler")) register("Bundler", new EsbuildBundler());
  if (!tryResolve("ModuleLexer")) register("ModuleLexer", new EsModuleLexer());
}

export interface HttpHandle {
  port: number;
  url: string;
  stop: () => Promise<void>;
}

export interface CreateServiceOptions {
  port?: number;
  bindAddress?: string;
  mode?: "development" | "production";
  /** false skips DB/accounts/worker wiring entirely (UI only). */
  workers?: boolean;
  /** Synthetic dev mode: routes read data/dev-synthetic.sqlite, no workers, regardless of the env (ACCOUNTS_FILE, DATABASE_PATH). */
  synthetic?: boolean;
  env?: Record<string, string | undefined>;
  projectRoot?: string;
  log?: (message: string) => void;
  // Injectable factories for tests.
  startup?: typeof defaultStartup;
  createWorkers?: (deps: { db: StartupResult["db"] }) => ImapWorkers;
  startHttp?: (o: { port: number; bindAddress: string; mode: "development" | "production" }) => Promise<HttpHandle>;
  /** Subscribes a shutdown handler; may return an unsubscribe function that stop() calls. */
  onSignal?: (signal: "SIGINT" | "SIGTERM", handler: () => void) => void | (() => void);
}

export interface Service {
  port: number;
  url: string;
  workerStatus: "disabled" | "running" | "failed";
  data: "live" | "synthetic";
  stop: () => Promise<void>;
}

export function resolveBindAddress(override: string | undefined): string {
  return override && override.length > 0 ? override : "127.0.0.1";
}

// startServer echoes the requested port back, so port 0 would not reveal the real one.
function pickFreePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, host, () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function defaultStartHttp(o: { port: number; bindAddress: string; mode: "development" | "production" }): Promise<HttpHandle> {
  ensureBundlerContracts();
  // The session guard runs as requestInterceptor (no root middleware.ts: see packages/core/src/auth-runtime.ts and docs/DEVIATIONS.md).
  const server = await startServer({
    mode: o.mode, port: o.port, bindAddress: o.bindAddress, projectDir: fileURLToPath(new URL(".", import.meta.url)),
    requestInterceptor: (request) => interceptRequest(request),
  });
  await server.ready;
  return { port: server.port, url: server.url, stop: () => server.stop() };
}

interface PipelineOptions {
  env?: Record<string, string | undefined>;
  log?: (message: string) => void;
  createJev?: (apiKey: string) => JevClient;
  /** Client of the Decisions models (Luna, ADR 0041); same key as Jev. */
  createDecisions?: (apiKey: string) => JevClient;
  createWorkers?: (d: ImapWorkersDeps) => ImapWorkers;
  /** Global kill switch file for automatic mailbox actions (default: data/auto-actions.disabled next to the database). */
  killSwitchFile?: string;
  mailboxActions?: MailboxActions;
  /** Test/QA seam: the read-only port a classification retry refetches with. Default: a real ImapFlow port of the account. */
  portFactory?: (accountId: string) => ImapPort;
  /** Test seam: replaces the push transport (never a real network call in tests). */
  pushTransport?: PushTransport;
  pushNotifier?: PushNotifier;
  /** Interval of the quarantine cleanup job (default 30 minutes). */
  cleanupIntervalMs?: number;
}

const CLEANUP_INTERVAL_MS = 30 * 60_000;

/** Periodic cleanup of Quarantäne -> trash (R9, ADR 0038). Every run honours the stops and limits itself; errors are swallowed. */
function cleanupTimer(actions: MailboxActions, intervalMs: number, log: (message: string) => void) {
  let timer: ReturnType<typeof setInterval> | undefined;
  const run = (): void => {
    void actions.cleanup().catch(() => log("quarantine cleanup failed"));
  };
  return {
    start(): void {
      if (timer !== undefined) return;
      timer = setInterval(run, intervalMs);
      timer.unref();
    },
    stop(): void {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
    run,
  };
}

/**
 * The classification pipeline and the mailbox-action rules around a LIVE account list. The list may change while the
 * process runs (account supervisor): everything looks accounts up by id at the moment it needs them.
 */
function wirePipeline(deps: { db: StartupResult["db"]; accounts: ImapWorkersDeps["accounts"] }, o: PipelineOptions) {
  const log = o.log ?? (() => {});
  const env = o.env ?? process.env;
  const find = (id: string) => deps.accounts.find((a) => a.id === id);
  // M7a: rule "Spam gelesen". Per-account mode comes from the database (mail_accounts.spam_seen_mode); the executor is the
  // only place that creates the IMAP write port. One bounded backfill at start covers already classified mails.
  const actions = o.mailboxActions ?? createMailboxActions({
    db: deps.db,
    accounts: deps.accounts,
    killSwitchFile: o.killSwitchFile ?? join(dataDirFromEnv(env, PROJECT_ROOT), KILL_SWITCH_FILE),
  });
  // R6: Web Push. Without a valid VAPID pair the notifier is a no-op (fail-closed); nothing about the keys is logged.
  const vapid = loadPushConfig(env);
  const push = o.pushNotifier ?? createPushNotifier({
    db: deps.db, config: vapid.ok ? vapid.config : undefined, transport: o.pushTransport ?? fetchTransport, log,
  });
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) {
    log("classification disabled: OPENROUTER_API_KEY not set");
    return { actions, push, pipeline: undefined, onIngested: undefined, cleanup: cleanupTimer(actions, o.cleanupIntervalMs ?? CLEANUP_INTERVAL_MS, log) };
  }
  const pipeline = createClassificationPipeline({
    db: deps.db,
    jev: (o.createJev ?? ((key) => createJevClient({ apiKey: key })))(apiKey),
    decisions: (o.createDecisions ?? ((key) => createDecisionsClient({ apiKey: key, model: LUNA_CLASSIFIER })))(apiKey),
    // The owner's choice (user_settings, needs the permission `classifier_choice`); anything else is Jev.
    modelFor: (accountId) => classifierModelFor(deps.db, accountUserId(deps.db, accountId)),
    // Topics (R8, ADR 0037): the question set v3 only for owners who switched topics_enabled on (default off).
    topicsEnabled: (accountId) => topicsEnabled(deps.db, accountUserId(deps.db, accountId)),
    topicList: (accountId) => topicListForUser(deps.db, accountUserId(deps.db, accountId)),
    portFactory: o.portFactory ?? ((accountId) => {
      const a = find(accountId);
      if (!a) throw new Error("unknown account");
      return createImapFlowPort({ host: a.host, port: a.port, tls: a.tls, user: a.user, password: a.password });
    }),
    accountContext: (id) => find(id)?.context,
    persistResponse: createPersistResponse((id) => find(id)?.spam_threshold ?? DEFAULT_SPAM_THRESHOLD),
    onClassified: async ({ emailId }) => {
      await actions.onClassified(emailId);
      void push.onClassified(emailId); // fire and forget: a slow push service must not hold up the pipeline (never rejects)
    },
  });
  const onIngested: ImapWorkersDeps["onIngested"] = (emailId, input) => {
    const accountId = (deps.db.prepare("SELECT account_id FROM emails WHERE id = ?").get(emailId) as { account_id: string } | undefined)?.account_id;
    if (!accountId) return;
    return pipeline.submit({ emailId, accountId, input });
  };
  return { actions, push, pipeline, onIngested, cleanup: cleanupTimer(actions, o.cleanupIntervalMs ?? CLEANUP_INTERVAL_MS, log) };
}

/** Imap workers for a fixed account list plus the Jev classification pipeline (onIngested -> submit). Without OPENROUTER_API_KEY only ingestion runs. */
export function createWorkersWithPipeline(
  deps: { db: StartupResult["db"]; accounts: ImapWorkersDeps["accounts"] },
  o: PipelineOptions = {},
): ImapWorkers {
  const make = o.createWorkers ?? ((d) => createImapWorkers(d));
  const log = o.log ?? (() => {});
  const w = wirePipeline(deps, o);
  const workers = make({ db: deps.db, accounts: deps.accounts, ...(w.onIngested ? { onIngested: w.onIngested } : {}) });
  return {
    start() {
      workers.start();
      w.push.start();
      void w.pipeline?.start().catch(() => log("pipeline start failed"));
      void w.actions.backfill().then(() => w.cleanup.run()).catch(() => log("mailbox action backfill failed"));
      w.cleanup.start();
    },
    async stop() {
      w.cleanup.stop();
      w.push.stop();
      w.pipeline?.stop();
      await workers.stop();
    },
  };
}

/**
 * Production workers (R2): accounts come from the database. The supervisor starts one IMAP worker per enabled account
 * with a decryptable secret and follows changes made through the API (packages/core/src/account-supervisor.ts).
 */
export function createSupervisedWorkers(
  deps: { db: StartupResult["db"] },
  o: PipelineOptions & { intervalMs?: number } = {},
): ImapWorkers {
  const make = o.createWorkers ?? ((d) => createImapWorkers(d));
  const log = o.log ?? (() => {});
  const live: AccountConfig[] = [];
  const w = wirePipeline({ db: deps.db, accounts: live }, o);
  const supervisor = createAccountSupervisor({
    db: deps.db,
    env: o.env ?? process.env,
    accounts: live,
    ...(o.intervalMs !== undefined ? { intervalMs: o.intervalMs } : {}),
    log,
    startWorker: (account) => {
      const worker = make({ db: deps.db, accounts: [account], ...(w.onIngested ? { onIngested: w.onIngested } : {}) });
      worker.start();
      return worker;
    },
  });
  return {
    start() {
      supervisor.start();
      w.push.start();
      void w.pipeline?.start().catch(() => log("pipeline start failed"));
      void supervisor.reconcile().then(() => w.actions.backfill()).then(() => w.cleanup.run()).catch(() => log("mailbox action backfill failed"));
      w.cleanup.start();
    },
    async stop() {
      w.cleanup.stop();
      w.push.stop();
      w.pipeline?.stop();
      await supervisor.stop();
    },
  };
}

/**
 * Synthetic dev mode (no real mailboxes): the rule engine runs over the synthetic database, but the mode is always
 * dry_run and no write port can be created. Gives the "Würde als gelesen markieren" view data to show.
 */
export async function planSyntheticActions(dbPath: string, projectRoot: string, log: (message: string) => void): Promise<void> {
  const db = openDatabase(dbPath);
  try {
    const actions = createMailboxActions({
      db, accounts: [], forceDryRun: true, killSwitchFile: join(dataDirFromEnv({ DATABASE_PATH: dbPath }, projectRoot), KILL_SWITCH_FILE),
      writePortFor: () => undefined,
    });
    const r = await actions.backfill();
    if (r.planned > 0) log(`synthetic dry run: ${r.planned} mark-as-read action(s) planned (nothing is written anywhere)`);
  } catch {
    log("synthetic dry run failed");
  } finally {
    db.close();
  }
}

/** The synthetic dev database gets its test user (docs/access-contract.md): the owner row, claimed as dev@synthetic.invalid. */
export async function ensureSyntheticDevUser(dbPath: string): Promise<void> {
  const db = openDatabase(dbPath);
  try {
    await ensureDevUser(db);
  } finally {
    db.close();
  }
}

export function formatListening(svc: Pick<Service, "url" | "workerStatus" | "data">): string {
  return `listening ${svc.url} workers=${svc.workerStatus}${svc.data === "synthetic" ? " data=synthetic" : ""}`;
}

export async function createService(options: CreateServiceOptions = {}): Promise<Service> {
  const bindAddress = resolveBindAddress(options.bindAddress);
  const requested = options.port ?? 3000;
  const log = options.log ?? ((m: string) => console.log(m));
  const synthetic = options.synthetic === true;
  const useWorkers = options.workers !== false && !synthetic;

  // Public deployment (fly.io) without a configured password must not start at all (docs/fly-deploy.md).
  assertFlyAuthConfigured(options.env ?? process.env);

  // O1a: the OpenAI provider of the reply agent talks to OpenRouter; derived from OPENROUTER_API_KEY, never overwritten.
  applyOpenRouterEnv(options.env ?? process.env);

  // Password mode (APP_PASSWORD set, e.g. on fly.io): a too short or empty value disables the login. Never log the value.
  if (!synthetic && selectAuthMode({ synthetic, appPassword: process.env.APP_PASSWORD, authMode: process.env.AUTH_MODE }) === "password" && appPasswordStatus(process.env.APP_PASSWORD) !== "ok") {
    log("warning: APP_PASSWORD too short, password login disabled");
  }

  if (synthetic) {
    // The route modules read process.env.DATABASE_PATH themselves, so it is forced before anything listens.
    const prepared = prepareSyntheticDevDatabase(options.projectRoot ?? PROJECT_ROOT);
    process.env.DATABASE_PATH = prepared.path;
    if (!prepared.existed) log("synthetic dev database is empty: run `npm run eval:fetch && npm run dev:seed`");
    await planSyntheticActions(prepared.path, options.projectRoot ?? PROJECT_ROOT, log);
    await ensureSyntheticDevUser(prepared.path);
  }

  // Startup errors (bad accounts file, DB path) reject before anything listens; messages carry no secrets.
  const started = useWorkers
    ? (options.startup ?? defaultStartup)({ env: options.env ?? process.env, projectRoot: options.projectRoot ?? PROJECT_ROOT })
    : undefined;

  let workers: ImapWorkers | undefined;
  let workerStatus: Service["workerStatus"] = "disabled";
  let http: HttpHandle;
  const mode = options.mode ?? "development";
  try {
    const port = requested === 0 && !options.startHttp ? await pickFreePort(bindAddress) : requested;
    http = await (options.startHttp ?? defaultStartHttp)({ port, bindAddress, mode });
  } catch (err) {
    started?.db.close();
    throw err;
  }

  if (mode === "development") {
    const hazards = findStyleScanHazards(options.projectRoot ?? PROJECT_ROOT);
    if (hazards.length > 0) {
      log(`warning: ${hazards.length} agent worktree(s) with node_modules under .claude/worktrees break Veryfront styles (CSS candidate limit); remove them with git worktree remove after checking for unsaved work`);
    }
  }

  if (started) {
    if (started.legacyImport.status === "imported") log(`legacy accounts file imported: ${started.legacyImport.count} account(s), the file is not read again`);
    if (started.legacyImport.status === "no_key") log("legacy accounts file found but ACCOUNTS_ENCRYPTION_KEY is not set: accounts are not imported and no worker starts");
    try {
      // Workers always run in live mode: with zero accounts the supervisor just waits for accounts created in the app.
      workers = (options.createWorkers ?? ((d) => createSupervisedWorkers(d, { env: options.env ?? process.env, log })))({ db: started.db });
      workers.start();
      workerStatus = "running";
    } catch {
      workerStatus = "failed";
      log("worker start failed");
    }
  }

  let stopping: Promise<void> | undefined;
  const unsubscribe: (() => void)[] = [];
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      for (const off of unsubscribe) off();
      try {
        await workers?.stop();
      } catch {
        log("worker stop failed");
      }
      try {
        await http.stop();
      } finally {
        started?.db.close();
      }
      log("shutdown complete");
    })();
    return stopping;
  };

  const onSignal = options.onSignal ?? ((sig, fn) => {
    process.on(sig, fn);
    return () => { process.off(sig, fn); };
  });
  const handler = () => {
    void stop().then(() => {
      if (!options.onSignal) process.exit(0);
    });
  };
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    const off = onSignal(sig, handler);
    if (typeof off === "function") unsubscribe.push(off);
  }

  return { port: http.port, url: http.url, workerStatus, data: synthetic ? "synthetic" : "live", stop };
}

if (import.meta.main) {
  const mode = process.argv.includes("--production") ? "production" : "development";
  const synthetic = process.argv.includes("--synthetic");
  if (synthetic && mode === "production") {
    console.error("--synthetic is for development only");
    process.exit(2);
  }
  const svc = await createService({
    port: process.env.PORT ? Number(process.env.PORT) : 3000,
    bindAddress: process.env.BIND_ADDRESS,
    mode,
    synthetic,
  });
  console.log(formatListening(svc));
}
