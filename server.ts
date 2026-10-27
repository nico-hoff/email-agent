import net from "node:net";
import { PROJECT_ROOT } from "./lib/constants.ts";
import { prepareSyntheticDevDatabase } from "./lib/synthetic-dev-db.ts";
import { startup as defaultStartup, type StartupResult } from "./lib/accounts.ts";
import { createImapWorkers, type ImapWorkers, type ImapWorkersDeps } from "./workers/imap-worker.ts";
import { fileURLToPath } from "node:url";
import { createClassificationPipeline, createPersistResponse } from "./lib/classification-pipeline.ts";
import { createJevClient, type JevClient } from "./lib/jev.ts";
import { createImapFlowPort } from "./lib/imap.ts";
import { DEFAULT_SPAM_THRESHOLD } from "./lib/accounts-config.ts";
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
  createWorkers?: (deps: { db: StartupResult["db"]; accounts: ImapWorkersDeps["accounts"] }) => ImapWorkers;
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
  const server = await startServer({ mode: o.mode, port: o.port, bindAddress: o.bindAddress, projectDir: fileURLToPath(new URL(".", import.meta.url)) });
  await server.ready;
  return { port: server.port, url: server.url, stop: () => server.stop() };
}

/** Imap workers plus the Jev classification pipeline (onIngested -> submit). Without OPENROUTER_API_KEY only ingestion runs. */
export function createWorkersWithPipeline(
  deps: { db: StartupResult["db"]; accounts: ImapWorkersDeps["accounts"] },
  o: {
    env?: Record<string, string | undefined>;
    log?: (message: string) => void;
    createJev?: (apiKey: string) => JevClient;
    createWorkers?: (d: ImapWorkersDeps) => ImapWorkers;
  } = {},
): ImapWorkers {
  const make = o.createWorkers ?? ((d) => createImapWorkers(d));
  const apiKey = (o.env ?? process.env).OPENROUTER_API_KEY;
  if (!apiKey) {
    (o.log ?? (() => {}))("classification disabled: OPENROUTER_API_KEY not set");
    return make({ db: deps.db, accounts: deps.accounts });
  }
  const byId = new Map(deps.accounts.map((a) => [a.id, a]));
  const pipeline = createClassificationPipeline({
    db: deps.db,
    jev: (o.createJev ?? ((key) => createJevClient({ apiKey: key })))(apiKey),
    portFactory: (accountId) => {
      const a = byId.get(accountId);
      if (!a) throw new Error("unknown account");
      return createImapFlowPort({ host: a.host, port: a.port, tls: a.tls, user: a.user, password: a.password });
    },
    accountContext: (id) => byId.get(id)?.context,
    persistResponse: createPersistResponse((id) => byId.get(id)?.spam_threshold ?? DEFAULT_SPAM_THRESHOLD),
  });
  const workers = make({
    db: deps.db,
    accounts: deps.accounts,
    onIngested: (emailId, input) => {
      const accountId = (deps.db.prepare("SELECT account_id FROM emails WHERE id = ?").get(emailId) as { account_id: string } | undefined)?.account_id;
      if (!accountId) return;
      return pipeline.submit({ emailId, accountId, input });
    },
  });
  return {
    start() {
      workers.start();
      void pipeline.start().catch(() => (o.log ?? (() => {}))("pipeline start failed"));
    },
    async stop() {
      pipeline.stop();
      await workers.stop();
    },
  };
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

  if (synthetic) {
    // The route modules read process.env.DATABASE_PATH themselves, so it is forced before anything listens.
    const prepared = prepareSyntheticDevDatabase(options.projectRoot ?? PROJECT_ROOT);
    process.env.DATABASE_PATH = prepared.path;
    if (!prepared.existed) log("synthetic dev database is empty: run `npm run eval:fetch && npm run dev:seed`");
  }

  // Startup errors (bad accounts file, DB path) reject before anything listens; messages carry no secrets.
  const started = useWorkers
    ? (options.startup ?? defaultStartup)({ env: options.env ?? process.env, projectRoot: options.projectRoot ?? PROJECT_ROOT })
    : undefined;

  let workers: ImapWorkers | undefined;
  let workerStatus: Service["workerStatus"] = "disabled";
  let http: HttpHandle;
  try {
    const port = requested === 0 && !options.startHttp ? await pickFreePort(bindAddress) : requested;
    http = await (options.startHttp ?? defaultStartHttp)({ port, bindAddress, mode: options.mode ?? "development" });
  } catch (err) {
    started?.db.close();
    throw err;
  }

  if (started && started.config.status === "ok") {
    try {
      workers = (options.createWorkers ?? ((d) => createWorkersWithPipeline(d, { env: options.env ?? process.env, log })))({ db: started.db, accounts: started.config.accounts });
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
