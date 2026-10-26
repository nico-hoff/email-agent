import net from "node:net";
import { startServer } from "veryfront/server";
import { register, tryResolve } from "veryfront/extensions/contracts";
import { EsbuildBundler, EsModuleLexer } from "@veryfront/ext-bundler-esbuild";

// Same contract registration the veryfront CLI performs before starting a server.
function ensureBundlerContracts(): void {
  if (!tryResolve("Bundler")) register("Bundler", new EsbuildBundler());
  if (!tryResolve("ModuleLexer")) register("ModuleLexer", new EsModuleLexer());
}

export interface CreateServiceOptions {
  port?: number;
  bindAddress?: string;
  mode?: "development" | "production";
  workers?: boolean;
}

export interface Service {
  port: number;
  url: string;
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

export async function createService(options: CreateServiceOptions = {}): Promise<Service> {
  ensureBundlerContracts();
  const bindAddress = resolveBindAddress(options.bindAddress);
  const requested = options.port ?? 3000;
  const port = requested === 0 ? await pickFreePort(bindAddress) : requested;
  const server = await startServer({
    mode: options.mode ?? "development",
    port,
    bindAddress,
    projectDir: process.cwd(),
  });
  await server.ready;
  return { port: server.port, url: server.url, stop: () => server.stop() };
}

if (import.meta.main) {
  const mode = process.argv.includes("--production") ? "production" : "development";
  const svc = await createService({
    port: process.env.PORT ? Number(process.env.PORT) : 3000,
    bindAddress: process.env.BIND_ADDRESS,
    mode,
  });
  console.log(`listening ${svc.url}`);
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await svc.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
