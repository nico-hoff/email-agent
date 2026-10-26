import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../lib/db.ts";

const root = join(import.meta.dirname, "..");

test("/api/health, /api/status and /api/emails respond ok", async () => {
  const dir = mkdtempSync(join(tmpdir(), "routes-"));
  chmodSync(dir, 0o700);
  const file = join(dir, "t.sqlite");
  const prev = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = file;
  try {
    openDatabase(file).close();
    const health = await import("../app/api/health/route.ts");
    const status = await import("../app/api/status/route.ts");
    const emails = await import("../app/api/emails/route.ts");
    assert.equal(health.GET().status, 200);
    assert.equal((await status.GET()).status, 200);
    assert.equal((await emails.GET(new Request("http://localhost/api/emails"))).status, 200);
  } finally {
    if (prev === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = prev;
  }
});

test("starter workflow leftovers are gone", () => {
  for (const p of [
    "agents/researcher.ts",
    "agents/writer.ts",
    "tools/publish.ts",
    "workflows/content-pipeline.ts",
    "lib/workflows.ts",
    "app/api/workflows",
    "app/workflows",
  ]) assert.equal(existsSync(join(root, p)), false, p);
});
