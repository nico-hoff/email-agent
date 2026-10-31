import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../lib/constants.ts";
import { createService } from "../server.ts";
import { openDatabase } from "../lib/db.ts";

test("PROJECT_ROOT is the directory containing server.ts, independent of cwd", () => {
  assert.ok(existsSync(join(PROJECT_ROOT, "server.ts")));
  const prev = process.cwd();
  process.chdir("/");
  try {
    assert.ok(existsSync(join(PROJECT_ROOT, "server.ts")));
  } finally {
    process.chdir(prev);
  }
});

test("createService defaults projectRoot to PROJECT_ROOT, not process.cwd()", async () => {
  let seen: string | undefined;
  const prev = process.cwd();
  process.chdir("/");
  try {
    const svc = await createService({
      port: 0, env: {}, onSignal: () => {}, log: () => {},
      startup: (o) => { seen = o.projectRoot; return { db: openDatabase(":memory:"), legacyImport: { status: "no_file" } } as never; },
      startHttp: async () => ({ port: 1, url: "u", stop: async () => {} }),
    });
    await svc.stop();
  } finally {
    process.chdir(prev);
  }
  assert.equal(seen, PROJECT_ROOT);
});
