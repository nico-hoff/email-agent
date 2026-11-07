import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { PROJECT_ROOT } from "../packages/core/src/constants.ts";
import { E2E_DEFAULT_PORT, E2E_PASSWORD, E2E_USER_EMAIL, e2eMode, e2ePort, PRODUCTION_MODULE_CACHE } from "../scripts/e2e-browser-serve.ts";
import { QA_PASSWORD, QA_USER_EMAIL } from "../scripts/qa-serve.ts";

const read = (p: string): string => readFileSync(join(PROJECT_ROOT, p), "utf8");

describe("browser tests (ADR 0047)", () => {
  it("port: default, valid override, invalid values rejected", () => {
    assert.equal(e2ePort({}), E2E_DEFAULT_PORT);
    assert.equal(e2ePort({ E2E_PORT: "" }), E2E_DEFAULT_PORT);
    assert.equal(e2ePort({ E2E_PORT: "4123" }), 4123);
    for (const bad of ["80", "70000", "abc", "3300.5"]) assert.throws(() => e2ePort({ E2E_PORT: bad }));
  });

  it("mode: production unless development is asked for", () => {
    assert.equal(e2eMode({}), "production");
    assert.equal(e2eMode({ E2E_SERVER_MODE: "development" }), "development");
    assert.equal(e2eMode({ E2E_SERVER_MODE: "prod" }), "production");
  });

  it("uses the synthetic QA user and only clears the production module cache inside the project", () => {
    assert.equal(E2E_USER_EMAIL, QA_USER_EMAIL);
    assert.equal(E2E_PASSWORD, QA_PASSWORD);
    assert.ok(E2E_USER_EMAIL.endsWith(".invalid"));
    assert.ok(PRODUCTION_MODULE_CACHE.startsWith(join(PROJECT_ROOT, ".cache", "veryfront-mdx-esm")));
    assert.ok(PRODUCTION_MODULE_CACHE.endsWith("preview-main"));
  });

  it("server script: temp database, users mode, no workers, no env file, no API key", () => {
    const src = read("scripts/e2e-browser-serve.ts");
    assert.match(src, /mkdtempSync\(join\(tmpdir\(\)/);
    assert.match(src, /AUTH_MODE = "users"/);
    assert.match(src, /workers: false/);
    assert.match(src, /delete process\.env\.OPENROUTER_API_KEY/);
    assert.match(src, /delete process\.env\.ACCOUNTS_FILE/);
    assert.doesNotMatch(src, /env-file/);
    assert.match(src, /bindAddress: "127\.0\.0\.1"/);
  });

  it("config: 127.0.0.1 (not localhost), one worker, server started by the config, no reuse", () => {
    const cfg = read("playwright.config.ts");
    assert.match(cfg, /http:\/\/127\.0\.0\.1:\$\{port\}/);
    assert.doesNotMatch(cfg, /http:\/\/localhost/);
    assert.match(cfg, /workers: 1/);
    assert.match(cfg, /command: "node scripts\/e2e-browser-serve\.ts"/);
    assert.match(cfg, /reuseExistingServer: false/);
    assert.match(cfg, /testDir: "e2e"/);
  });

  it("wiring: npm script, pinned dependency, CI step, gitignored output", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string>; devDependencies: Record<string, string> };
    assert.equal(pkg.scripts["e2e:browser"], "playwright test");
    assert.match(pkg.devDependencies["@playwright/test"] ?? "", /^\d+\.\d+\.\d+$/);
    const ci = read(".github/workflows/ci.yml");
    assert.match(ci, /npx playwright install --with-deps chromium/);
    assert.match(ci, /npm run e2e:browser/);
    const ignore = read(".gitignore");
    assert.match(ignore, /^test-results\/$/m);
    assert.match(ignore, /^playwright-report\/$/m);
  });
});
