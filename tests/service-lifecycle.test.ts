import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createService } from "../server.ts";

function harness(legacyImport: unknown, opts: { startupError?: Error; workerStartThrows?: boolean } = {}) {
  const calls: string[] = [];
  const logs: string[] = [];
  const handlers = new Map<string, () => void>();
  const db = new DatabaseSync(":memory:");
  const base = {
    port: 0,
    bindAddress: "127.0.0.1",
    env: {},
    projectRoot: "/nonexistent",
    log: (m: string) => logs.push(m),
    onSignal: (sig: string, fn: () => void) => { handlers.set(sig, fn); },
    startup: () => {
      calls.push("startup");
      if (opts.startupError) throw opts.startupError;
      return { db, legacyImport } as never;
    },
    createWorkers: () => ({
      start: () => { calls.push("workers.start"); if (opts.workerStartThrows) throw new Error("boom"); },
      stop: async () => { calls.push("workers.stop"); },
    }),
    startHttp: async () => ({
      port: 4321, url: "http://127.0.0.1:4321",
      stop: async () => { calls.push("server.stop"); },
    }),
  };
  return { base, calls, logs, handlers };
}

test("workers always start in live mode (the supervisor waits for accounts created in the app)", async () => {
  const h = harness({ status: "no_file" });
  const svc = await createService(h.base as never);
  assert.equal(svc.workerStatus, "running");
  assert.ok(h.calls.includes("workers.start"));
  await svc.stop();
});

test("a legacy accounts file without key is reported, never read, and the app still starts", async () => {
  const h = harness({ status: "no_key" });
  const svc = await createService(h.base as never);
  assert.ok(h.logs.some((l) => /ACCOUNTS_ENCRYPTION_KEY is not set/.test(l)));
  await svc.stop();
});

test("an import is logged with a count only", async () => {
  const h = harness({ status: "imported", count: 2 });
  const svc = await createService(h.base as never);
  assert.ok(h.logs.some((l) => /imported: 2 account/.test(l)));
  await svc.stop();
});

test("startup errors reject clearly", async () => {
  const h = harness({ status: "no_file" }, { startupError: new Error("ACCOUNTS_FILE: file mode must not grant group/other access (use 0600)") });
  await assert.rejects(createService(h.base as never), /ACCOUNTS_FILE: file mode/);
  assert.ok(!h.calls.includes("workers.start"));
});

test("starts server and workers once; signals stop all and log shutdown complete once", async () => {
  const h = harness({ status: "no_file" });
  const svc = await createService(h.base as never);
  assert.equal(svc.workerStatus, "running");
  assert.deepEqual(h.calls.filter((c) => c === "workers.start" || c === "startup").length, 2);
  h.handlers.get("SIGINT")!();
  h.handlers.get("SIGTERM")!();
  await svc.stop();
  assert.equal(h.calls.filter((c) => c === "workers.stop").length, 1);
  assert.equal(h.calls.filter((c) => c === "server.stop").length, 1);
  assert.equal(h.logs.filter((l) => l === "shutdown complete").length, 1);
});

test("a worker failure does not abort the process", async () => {
  const h = harness({ status: "no_file" }, { workerStartThrows: true });
  const svc = await createService(h.base as never);
  assert.equal(svc.workerStatus, "failed");
  await svc.stop();
});

test("default signal handlers are removed again on stop", async () => {
  const h = harness({ status: "no_file" });
  const { onSignal: _injected, ...base } = h.base;
  const before = { int: process.listenerCount("SIGINT"), term: process.listenerCount("SIGTERM") };
  const svc = await createService(base as never);
  assert.equal(process.listenerCount("SIGINT"), before.int + 1);
  assert.equal(process.listenerCount("SIGTERM"), before.term + 1);
  await svc.stop();
  assert.equal(process.listenerCount("SIGINT"), before.int);
  assert.equal(process.listenerCount("SIGTERM"), before.term);
});
