import net from "node:net";
import { startup as defaultStartup, type StartupResult } from "./lib/accounts.ts";
import { createImapWorkers, type ImapWorkers } from "./workers/imap-worker.ts";
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
  env?: Record<string, string | undefined>;
  projectRoot?: string;
  log?: (message: string) => void;
  // Injectable factories for tests.
  startup?: typeof defaultStartup;
  createWorkers?: (deps: { db: StartupResult["db"]; accounts: Parameters<typeof createImapWorkers>[0]["accounts"] }) => ImapWorkers;
  startHttp?: (o: { port: number; bindAddress: string; mode: "development" | "production" }) => Promise<HttpHandle>;
  onSignal?: (signal: "SIGINT" | "SIGTERM", handler: () => void) => void;
}

export interface Service {
  port: number;
  url: string;
  workerStatus: "disabled" | "running" | "failed";
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
  const server = await startServer({ mode: o.mode, port: o.port, bindAddress: o.bindAddress, projectDir: process.cwd() });
  await server.ready;
  return { port: server.port, url: server.url, stop: () => server.stop() };
}

export async function createService(options: CreateServiceOptions = {}): Promise<Service> {
  const bindAddress = resolveBindAddress(options.bindAddress);
  const requested = options.port ?? 3000;
  const log = options.log ?? ((m: string) => console.log(m));
  const useWorkers = options.workers !== false;

  // Startup errors (bad accounts file, DB path) reject before anything listens; messages carry no secrets.
  const started = useWorkers
    ? (options.startup ?? defaultStartup)({ env: options.env ?? process.env, projectRoot: options.projectRoot ?? process.cwd() })
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
      workers = (options.createWorkers ?? ((d) => createImapWorkers(d)))({ db: started.db, accounts: started.config.accounts });
      workers.start();
      workerStatus = "running";
    } catch {
      workerStatus = "failed";
      log("worker start failed");
    }
  }

  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
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

  const onSignal = options.onSignal ?? ((sig, fn) => { process.on(sig, fn); });
  const handler = () => {
    void stop().then(() => {
      if (!options.onSignal) process.exit(0);
    });
  };
  onSignal("SIGINT", handler);
  onSignal("SIGTERM", handler);

  return { port: http.port, url: http.url, workerStatus, stop };
}

if (import.meta.main) {
  const mode = process.argv.includes("--production") ? "production" : "development";
  const svc = await createService({
    port: process.env.PORT ? Number(process.env.PORT) : 3000,
    bindAddress: process.env.BIND_ADDRESS,
    mode,
  });
  console.log(`listening ${svc.url} workers=${svc.workerStatus}`);
}
