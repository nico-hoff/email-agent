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
      const emails = await fetch(`http://127.0.0.1:${svc.port}/api/emails`);
      assert.equal(emails.status, 200);
      const body = (await emails.json()) as { emails: { account_id: string; active_location: { folder: string } }[] };
      assert.deepEqual(body.emails.map((e) => e.account_id).sort(), ["hf-sinabis", "hf-triage"]);
      assert.equal(body.emails.find((e) => e.account_id === "hf-triage")!.active_location.folder, "Junk");
      const status = await fetch(`http://127.0.0.1:${svc.port}/api/status`);
      assert.equal(status.status, 200);
      const s = (await status.json()) as { workers: { account_id: string; state: string }[] };
      assert.deepEqual(s.workers.map((w) => w.account_id).sort(), ["hf-sinabis", "hf-triage"]);
      assert.ok(s.workers.every((w) => w.state === "disabled"));
    } finally {
      await svc.stop();
    }
  });
});
