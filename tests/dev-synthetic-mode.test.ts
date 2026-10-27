import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createService, formatListening } from "../server.ts";
import { DEV_SYNTHETIC_DATABASE_PATH } from "../lib/constants.ts";
import { importSyntheticCases, openSyntheticDevDatabase } from "../lib/synthetic-dev-db.ts";

const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as { scripts: Record<string, string> };
const savedDb = process.env.DATABASE_PATH;
afterEach(() => {
  if (savedDb === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = savedDb;
});

function root(): string {
  const r = mkdtempSync(join(tmpdir(), "devmode-"));
  chmodSync(r, 0o700);
  return r;
}

const fakeHttp = async () => ({ port: 1, url: "http://127.0.0.1:1", stop: async () => {} });

describe("npm scripts", () => {
  it("dev is synthetic, dev:live keeps the previous behavior, start is unchanged", () => {
    assert.match(pkg.scripts.dev, /server\.ts --development --synthetic$/);
    assert.equal(pkg.scripts["dev:live"], "node --env-file-if-exists=.env.local server.ts --development");
    assert.equal(pkg.scripts.start, "node --env-file-if-exists=.env.local server.ts --production");
    assert.match(pkg.scripts["dev:seed"], /scripts\/seed-dev-db\.ts/);
  });
});

describe("synthetic mode of createService", () => {
  it("points DATABASE_PATH at the dev database and starts no workers, even if ACCOUNTS_FILE is set", async () => {
    const r = root();
    let startupCalled = false;
    let workersCalled = false;
    const svc = await createService({
      synthetic: true, projectRoot: r, port: 5, startHttp: fakeHttp, onSignal: () => {}, log: () => {},
      env: { ACCOUNTS_FILE: "/definitely/real/accounts.json", DATABASE_PATH: "/real/email-agent.sqlite" },
      startup: (() => { startupCalled = true; throw new Error("must not run"); }) as never,
      createWorkers: (() => { workersCalled = true; throw new Error("must not run"); }) as never,
    });
    assert.equal(process.env.DATABASE_PATH, join(r, DEV_SYNTHETIC_DATABASE_PATH));
    assert.equal(svc.workerStatus, "disabled");
    assert.equal(svc.data, "synthetic");
    assert.equal(startupCalled, false);
    assert.equal(workersCalled, false);
    assert.equal(formatListening(svc), "listening http://127.0.0.1:1 workers=disabled data=synthetic");
    await svc.stop();
  });

  it("logs the seeding hint when the dev database does not exist yet, and creates it empty", async () => {
    const r = root();
    const logs: string[] = [];
    const svc = await createService({ synthetic: true, projectRoot: r, startHttp: fakeHttp, onSignal: () => {}, log: (m) => logs.push(m) });
    assert.ok(logs.some((l) => l.includes("npm run eval:fetch && npm run dev:seed")));
    const db = openSyntheticDevDatabase(r);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM emails").get() as { n: number }).n, 0);
    db.close();
    await svc.stop();
  });

  it("does not log the hint when the dev database exists", async () => {
    const r = root();
    openSyntheticDevDatabase(r).close();
    const logs: string[] = [];
    const svc = await createService({ synthetic: true, projectRoot: r, startHttp: fakeHttp, onSignal: () => {}, log: (m) => logs.push(m) });
    assert.ok(!logs.some((l) => l.includes("dev:seed")));
    await svc.stop();
  });

  it("live mode output is unchanged", async () => {
    const svc = await createService({ workers: false, startHttp: fakeHttp, onSignal: () => {}, log: () => {} });
    assert.equal(svc.data, "live");
    assert.equal(formatListening(svc), "listening http://127.0.0.1:1 workers=disabled");
    await svc.stop();
  });

  it("the real routes read the dev database", async () => {
    const r = root();
    const db = openSyntheticDevDatabase(r);
    importSyntheticCases(db, [
      { case: { id: "triage-1", source: "triage", lang: "en", sender_domain: "a.example.test", subject: "ZZSUBJECT one", body: "ZZMARKER-BODY", expected: { is_spam: true } } },
      { case: { id: "sinabis-1", source: "sinabis", lang: "de", sender_domain: "b.example.test", subject: "ZZSUBJECT two", body: "ZZMARKER-BODY", expected: { category: "business" } } },
    ], { now: new Date() });
    db.close();
    const svc = await createService({
      synthetic: true, projectRoot: r, port: 0, bindAddress: "127.0.0.1", onSignal: () => {}, log: () => {},
      env: { ACCOUNTS_FILE: "/definitely/real/accounts.json", DATABASE_PATH: "/real/email-agent.sqlite" },
    });
    try {
      const base = `http://127.0.0.1:${svc.port}`;
      assert.equal((await fetch(`${base}/api/emails`)).status, 401, "guarded without a session");
      // Real login through the running server: Veryfront double-submit cookie plus the app CSRF token (dev identity).
      const welcome = await fetch(`${base}/welcome`, { headers: { accept: "text/html" } });
      const vf = /__Host-vf_csrf=([^;]+)/.exec(welcome.headers.get("set-cookie") ?? "")![1];
      const info = (await (await fetch(`${base}/api/auth/session`)).json()) as { csrfToken: string };
      const login = await fetch(`${base}/api/auth/login`, {
        method: "POST",
        headers: { origin: base, "sec-fetch-site": "same-origin", "x-csrf-token": vf, cookie: `__Host-vf_csrf=${vf}`, "x-app-csrf": info.csrfToken },
      });
      assert.equal(login.status, 200);
      const session = (login.headers.get("set-cookie") ?? "").split(";")[0];
      const emails = await fetch(`${base}/api/emails`, { headers: { cookie: session } });
      assert.equal(emails.status, 200);
      const body = (await emails.json()) as { emails: { account_id: string; active_location: { folder: string } }[] };
      assert.deepEqual(body.emails.map((e) => e.account_id).sort(), ["hf-sinabis", "hf-triage"]);
      assert.equal(body.emails.find((e) => e.account_id === "hf-triage")!.active_location.folder, "Junk");
      // T35/T64/T47 through the real server (Veryfront loader, dynamic route, CSRF, middleware).
      const paged = await fetch(`${base}/api/emails?view=important&limit=5`, { headers: { cookie: session } });
      assert.equal(paged.status, 200);
      const page = (await paged.json()) as { emails: { id: number; open: boolean; done: boolean; account: { id: string; label: string; color: string } }[]; counts: Record<string, number>; next_cursor: string | null };
      assert.deepEqual(Object.keys(page.counts).sort(), ["all", "important", "noise", "open"]);
      assert.equal(page.counts.all, 2);
      assert.match(page.emails[0].account.color, /^#[0-9a-f]{6}$/);
      const first = page.emails[0].id;
      const one = await fetch(`${base}/api/emails/${first}`, { headers: { cookie: session } });
      assert.equal(one.status, 200);
      assert.equal(((await one.json()) as { id: number }).id, first);
      assert.equal((await fetch(`${base}/api/emails/999999`, { headers: { cookie: session } })).status, 404);
      assert.equal((await fetch(`${base}/api/emails/${first}/done`, { method: "POST" })).status, 401, "no session");
      const mutation = {
        origin: base, "sec-fetch-site": "same-origin", "x-csrf-token": vf, cookie: `__Host-vf_csrf=${vf}; ${session}`, "x-app-csrf": info.csrfToken,
      };
      const marked = await fetch(`${base}/api/emails/${first}/done`, { method: "POST", headers: mutation });
      assert.equal(marked.status, 200);
      assert.deepEqual(await marked.json(), { ok: true, id: first, done: true, seen: false });
      const after = (await (await fetch(`${base}/api/emails/${first}`, { headers: { cookie: session } })).json()) as { done: boolean };
      assert.equal(after.done, true);
      const undone = await fetch(`${base}/api/emails/${first}/undone`, { method: "POST", headers: mutation });
      assert.deepEqual(await undone.json(), { ok: true, id: first, done: false, seen: false });
      const status = await fetch(`${base}/api/status`, { headers: { cookie: session } });
      assert.equal(status.status, 200);
      const s = (await status.json()) as { workers: { account_id: string; state: string }[] };
      assert.deepEqual(s.workers.map((w) => w.account_id).sort(), ["hf-sinabis", "hf-triage"]);
      assert.ok(s.workers.every((w) => w.state === "disabled"));
    } finally {
      await svc.stop();
    }
  });
});
