// Browser tests (ADR 0047): Playwright against the real service in users mode on a temp database with synthetic mails
// only (scripts/e2e-browser-serve.ts). One worker, because all tests share that database; tests restore what they change.
// Run: npm run e2e:browser (after npm run build), or E2E_SERVER_MODE=development npm run e2e:browser for the TDD loop.
import { defineConfig, devices } from "@playwright/test";
import { e2ePort } from "./scripts/e2e-browser-serve.ts";

const port = e2ePort(process.env);
// 127.0.0.1, not localhost: Veryfront treats the host "localhost" as its own local domain and answers "/" in
// production mode with its project overview instead of the app.
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  globalTimeout: 5 * 60 * 1000,
  reporter: [["list"]],
  // Headroom for a busy machine; the first use of every page is warmed up in e2e/auth.setup.ts.
  expect: { timeout: 10_000 },
  use: { baseURL, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"], storageState: "test-results/.auth/user.json" }, dependencies: ["setup"] },
    // iPhone viewport, touch and user agent on Chromium. Real WebKit does not keep the app's `__Host-` (Secure) cookies
    // on plain http://127.0.0.1, so login and CSRF fail there; WebKit needs an HTTPS test server (ADR 0047, follow-up).
    { name: "iphone-viewport", use: { ...devices["iPhone 15"], browserName: "chromium", storageState: "test-results/.auth/user.json" }, dependencies: ["setup"] },
  ],
  webServer: {
    command: "node scripts/e2e-browser-serve.ts",
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 60 * 1000,
    stdout: "ignore",
    stderr: "pipe",
    gracefulShutdown: { signal: "SIGTERM", timeout: 2000 },
  },
});
