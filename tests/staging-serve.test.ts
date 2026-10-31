import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { QA_DATABASE_PATH, QA_NO_ACCOUNTS_FILE } from "../scripts/qa-serve.ts";
import { parseStagingArgs, STAGING_DATABASE_PATH, STAGING_DEFAULT_PORT, stagingServerEnv } from "../scripts/staging-serve.ts";

describe("staging-serve", () => {
  test("own database, separate from QA; default port 3200", () => {
    assert.notEqual(STAGING_DATABASE_PATH, QA_DATABASE_PATH);
    assert.equal(STAGING_DEFAULT_PORT, 3200);
  });

  test("server env: users mode, loopback, no accounts file, trusts the proxy's X-Forwarded-Proto", () => {
    const env = stagingServerEnv({ APP_PASSWORD: "x", DATABASE_PATH: "data/email-agent.sqlite" }, "/abs/data/staging.sqlite", 3200);
    assert.equal(env.AUTH_MODE, "users");
    assert.equal(env.DATABASE_PATH, "/abs/data/staging.sqlite");
    assert.equal(env.ACCOUNTS_FILE, QA_NO_ACCOUNTS_FILE);
    assert.equal(env.BIND_ADDRESS, "127.0.0.1");
    assert.equal(env.VERYFRONT_TRUST_FORWARDED_HEADERS, "1");
  });

  test("args", () => {
    assert.deepEqual(parseStagingArgs([]), { port: 3200 });
    assert.deepEqual(parseStagingArgs(["--port", "3300"]), { port: 3300 });
    assert.ok("error" in parseStagingArgs(["--port", "22"]));
    assert.ok("error" in parseStagingArgs(["--reset"]));
  });

  test("npm scripts point user creation at the staging database", () => {
    const scripts = (JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> }).scripts;
    assert.match(scripts["staging"], /scripts\/staging-serve\.ts/);
    assert.match(scripts["staging:user"], new RegExp(`DATABASE_PATH=${STAGING_DATABASE_PATH.replace(".", "\\.")} .*scripts/user-create\\.ts`));
  });
});
