import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { createService } from "../server.ts";

const root = join(import.meta.dirname, "..");
const rootFiles = () => readdirSync(root);

// Regression (docker smoke, 2026-10-30): Veryfront loads a middleware.{ts,js,mjs} from the project root, transpiles it and
// writes .vf-middleware-<uuid>.mjs NEXT TO THE SOURCE (node_modules/veryfront/esm/src/server/dev-server/middleware.js,
// loadMiddlewareFile -> loadMiddlewareFromRealFS). In the hardened container (USER node, /app owned by root, read_only)
// that write fails with EACCES/EROFS and every request, even /api/health, answered 500. The session guard therefore runs
// as requestInterceptor in server.ts. No module may bring such a file back.
test("no middleware.{ts,js,mjs,mts,cjs} in the project root (Veryfront would write .vf-middleware-*.mjs next to it)", () => {
  const offenders = rootFiles().filter((f) => /^middleware\.(ts|js|mjs|mts|cjs)$/.test(f));
  assert.deepEqual(offenders, []);
});

// As root a chmod does not make a directory unwritable, so the real proof of "starts with a non-writable project
// directory" is scripts/docker-smoke.sh (USER node, --read-only). Here: production mode answers, and the run leaves no
// .vf-middleware-* file behind in the project root.
test("production mode serves health and the guard, and writes nothing next to the sources", async () => {
  const before = rootFiles().filter((f) => f.startsWith(".vf-middleware"));
  const svc = await createService({ mode: "production", port: 0, bindAddress: "127.0.0.1", workers: false, onSignal: () => {}, log: () => {} });
  try {
    const base = `http://127.0.0.1:${svc.port}`;
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    assert.equal((await fetch(`${base}/api/emails`)).status, 401);
    assert.equal((await fetch(`${base}/api/agents`)).status, 401);
    assert.equal((await fetch(`${base}/`, { redirect: "manual" })).status, 303);
    assert.equal((await fetch(`${base}/welcome`)).status, 200);
  } finally {
    await svc.stop();
  }
  assert.deepEqual(rootFiles().filter((f) => f.startsWith(".vf-middleware")), before);
});
