import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createService } from "../server.ts";

// Production mode with APP_PASSWORD set (test value, only in this process): real HTTP, empty database.
const PW = "smoke-MARKER-0c5e1d77-password";
const FORGED = "nico@example.test";
const saved = { db: process.env.DATABASE_PATH, pw: process.env.APP_PASSWORD, bind: process.env.BIND_ADDRESS };
afterEach(() => {
  for (const [k, v] of [["DATABASE_PATH", saved.db], ["APP_PASSWORD", saved.pw], ["BIND_ADDRESS", saved.bind]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

function tempEnv(password: string | undefined): void {
  delete process.env.BIND_ADDRESS;
  const dir = mkdtempSync(join(tmpdir(), "pwsrv-"));
  chmodSync(dir, 0o700);
  process.env.DATABASE_PATH = join(dir, "email-agent.sqlite");
  if (password === undefined) delete process.env.APP_PASSWORD; else process.env.APP_PASSWORD = password;
}

describe("password mode in production", () => {
  it("login with the password opens the API; no session or a forged Tailscale header does not", async () => {
    tempEnv(PW);
    const logs: string[] = [];
    const svc = await createService({ mode: "production", port: 0, bindAddress: "127.0.0.1", workers: false, onSignal: () => {}, log: (m) => logs.push(m) });
    try {
      const base = `http://127.0.0.1:${svc.port}`;
      const forged = { "tailscale-user-login": FORGED };
      assert.equal((await fetch(`${base}/api/health`)).status, 200);
      assert.equal((await fetch(`${base}/api/emails`)).status, 401);
      assert.equal((await fetch(`${base}/api/emails`, { headers: forged })).status, 401);
      assert.equal((await fetch(`${base}/`, { redirect: "manual", headers: forged })).status, 303);

      const welcome = await fetch(`${base}/welcome`, { headers: { accept: "text/html" } });
      assert.equal(welcome.status, 200);
      const vf = /__Host-vf_csrf=([^;]+)/.exec(welcome.headers.get("set-cookie") ?? "")?.[1] ?? "";
      assert.ok(vf);
      const info = (await (await fetch(`${base}/api/auth/session`, { headers: forged })).json()) as Record<string, unknown>;
      assert.equal(info.mode, "password");
      assert.equal(info.signedIn, false);
      assert.equal("login" in info, false);
      const headers = { origin: base, "sec-fetch-site": "same-origin", "x-csrf-token": vf, cookie: `__Host-vf_csrf=${vf}`, "x-app-csrf": String(info.csrfToken), "content-type": "application/json" };

      const bad = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { ...headers, ...forged }, body: JSON.stringify({ password: "nope-nope-nope-nope" }) });
      assert.equal(bad.status, 401);
      assert.deepEqual(await bad.json(), { error: "invalid_credentials" });
      const noCsrf = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: PW }) });
      assert.equal(noCsrf.status, 403);

      const ok = await fetch(`${base}/api/auth/login`, { method: "POST", headers, body: JSON.stringify({ password: PW }) });
      assert.equal(ok.status, 200);
      const setCookie = ok.headers.get("set-cookie") ?? "";
      assert.match(setCookie, /HttpOnly/);
      assert.match(setCookie, /SameSite=Strict/);
      assert.ok(!/; Secure/.test(setCookie), "plain loopback test access is the one exception");
      const session = setCookie.split(";")[0];
      const emails = await fetch(`${base}/api/emails`, { headers: { cookie: session } });
      assert.equal(emails.status, 200);
      const page = await fetch(`${base}/`, { redirect: "manual", headers: { cookie: session } });
      assert.notEqual(page.status, 303);
      // On a public bind address (BIND_ADDRESS=0.0.0.0, as on fly.io) the same login always gets Secure. The Veryfront
      // server strips x-forwarded-* before our routes run, so headers cannot be the signal.
      process.env.BIND_ADDRESS = "0.0.0.0";
      const proxied = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { ...headers, "x-forwarded-proto": "https" }, body: JSON.stringify({ password: PW }) });
      assert.equal(proxied.status, 200);
      assert.match(proxied.headers.get("set-cookie") ?? "", /; Secure/);
    } finally {
      await svc.stop();
    }
    assert.ok(!logs.join("\n").includes(PW));
    assert.ok(!logs.some((l) => l.includes("APP_PASSWORD")), "no warning for a valid password");
  });

  it("a too short APP_PASSWORD logs one warning without the value and nobody can log in", async () => {
    const SHORT = "short-MARK-12";
    tempEnv(SHORT);
    const logs: string[] = [];
    const svc = await createService({ mode: "production", port: 0, bindAddress: "127.0.0.1", workers: false, onSignal: () => {}, log: (m) => logs.push(m) });
    try {
      const base = `http://127.0.0.1:${svc.port}`;
      const welcome = await fetch(`${base}/welcome`, { headers: { accept: "text/html" } });
      const vf = /__Host-vf_csrf=([^;]+)/.exec(welcome.headers.get("set-cookie") ?? "")?.[1] ?? "";
      const info = (await (await fetch(`${base}/api/auth/session`)).json()) as Record<string, unknown>;
      assert.deepEqual(info, { mode: "password", configured: false });
      const r = await fetch(`${base}/api/auth/login`, {
        method: "POST", body: JSON.stringify({ password: SHORT }),
        headers: { origin: base, "sec-fetch-site": "same-origin", "x-csrf-token": vf, cookie: `__Host-vf_csrf=${vf}`, "x-app-csrf": "a.b", "content-type": "application/json" },
      });
      assert.equal(r.status, 503);
      assert.equal((await fetch(`${base}/api/emails`)).status, 401);
    } finally {
      await svc.stop();
    }
    assert.deepEqual(logs.filter((l) => l.includes("APP_PASSWORD")), ["warning: APP_PASSWORD too short, password login disabled"]);
    assert.ok(!logs.join("\n").includes(SHORT));
  });

  it("without APP_PASSWORD the tailnet mode starts without any password warning", async () => {
    tempEnv(undefined);
    const logs: string[] = [];
    const svc = await createService({ mode: "production", port: 0, bindAddress: "127.0.0.1", workers: false, onSignal: () => {}, log: (m) => logs.push(m) });
    try {
      const info = (await (await fetch(`http://127.0.0.1:${svc.port}/api/auth/session`)).json()) as Record<string, unknown>;
      assert.equal(info.mode, "tailnet");
    } finally {
      await svc.stop();
    }
    assert.ok(!logs.some((l) => l.includes("APP_PASSWORD")));
  });
});
