import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../lib/db.ts";
import { assertPreviewEnv, PreviewSeedRefusedError, seedPreview } from "../scripts/seed-preview.ts";
import { smokeItems } from "../scripts/e2e-smoke.ts";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "seed-preview-"));
  chmodSync(root, 0o700);
  return root;
}

test("seedPreview fills an empty database once, then leaves it alone", () => {
  const root = tmpRoot();
  try {
    const env = { DATABASE_PATH: join(root, "p.sqlite"), FLY_APP_NAME: "email-agent-preview-t1" };
    assert.deepEqual(seedPreview(env, root), { status: "seeded", cases: smokeItems().length });
    assert.deepEqual(seedPreview(env, root), { status: "skipped", reason: "not-empty" });
    const db = openDatabase(env.DATABASE_PATH);
    try {
      const mails = (db.prepare("SELECT COUNT(*) AS n FROM emails").get() as { n: number }).n;
      assert.equal(mails, smokeItems().length);
      const foreign = (db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE host <> 'synthetic.invalid'").get() as { n: number }).n;
      assert.equal(foreign, 0);
    } finally {
      db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("assertPreviewEnv refuses prod and any app that is not a preview, and an existing accounts file", () => {
  assert.throws(() => assertPreviewEnv({ FLY_APP_NAME: "email-agent" }), PreviewSeedRefusedError);
  assert.throws(() => assertPreviewEnv({ FLY_APP_NAME: "other-app" }), PreviewSeedRefusedError);
  assert.throws(() => assertPreviewEnv({ FLY_APP_NAME: "email-agent-preview-x", ACCOUNTS_FILE: "/data/accounts.json" }, () => true), PreviewSeedRefusedError);
  assert.doesNotThrow(() => assertPreviewEnv({ FLY_APP_NAME: "email-agent-preview-x", ACCOUNTS_FILE: "/data/accounts.json" }, () => false));
  assert.doesNotThrow(() => assertPreviewEnv({}));
});

test("seedPreview on prod name never opens a database", () => {
  assert.throws(() => seedPreview({ FLY_APP_NAME: "email-agent", DATABASE_PATH: "/nonexistent/x.sqlite" }, "/nonexistent"), PreviewSeedRefusedError);
});

test("the seed is opt-in: only the preview config and the entrypoint's PREVIEW_SEED_SYNTHETIC guard run it", () => {
  assert.doesNotMatch(read("fly.toml"), /PREVIEW_SEED_SYNTHETIC/);
  assert.match(read("fly.preview.toml"), /^\s*PREVIEW_SEED_SYNTHETIC = '1'$/m);
  const sh = read("scripts/docker-entrypoint.sh");
  const calls = sh.match(/seed-preview\.ts/g) ?? [];
  const guards = sh.match(/\[ "\$\{PREVIEW_SEED_SYNTHETIC:-\}" = "1" \]/g) ?? [];
  assert.equal(calls.length, 2);
  assert.equal(guards.length, 2);
  assert.match(sh, /setpriv --reuid=node --regid=node --init-groups -- node \/app\/scripts\/seed-preview\.ts/);
  assert.doesNotMatch(read("Dockerfile"), /PREVIEW_SEED_SYNTHETIC/);
});
