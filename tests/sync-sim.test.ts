// The initial-import simulation (scripts/sync-sim.ts): guards, no product path reaches it, the fake port is read-only and
// the fake verdicts pass the real response validation. Synthetic only.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { QUESTIONS } from "../lib/jev-questions.ts";
import { normalizeAnswers } from "../lib/jev-response.ts";
import { createSimJev, createSimPort, parseSimArgs, simGuard, simMessage, SIM_MAILS, SIM_OLD_MAILS, TEMPLATES } from "../scripts/sync-sim.ts";

const root = new URL("..", import.meta.url);
const zero = { connectMs: 0, fetchMs: 0, jevMs: 0 };

describe("sync-sim", () => {
  it("refuses to run on fly or in production; arguments are checked", () => {
    assert.equal(simGuard({}), null);
    assert.match(simGuard({ FLY_APP_NAME: "x" }) ?? "", /fly/);
    assert.match(simGuard({ FLY_MACHINE_ID: "x" }) ?? "", /fly/);
    assert.match(simGuard({ NODE_ENV: "production" }) ?? "", /production/);
    assert.deepEqual(parseSimArgs([]), { port: 3410, reset: false, delays: { connectMs: 2500, fetchMs: 150, jevMs: 900 } });
    assert.deepEqual(parseSimArgs(["--port", "3411", "--reset", "--jev-ms", "5"]), { port: 3411, reset: true, delays: { connectMs: 2500, fetchMs: 150, jevMs: 5 } });
    assert.ok("error" in parseSimArgs(["--port", "80"]));
    assert.ok("error" in parseSimArgs(["--bogus"]));
  });

  it("nothing of the product reaches the simulation", () => {
    for (const f of ["server.ts", "Dockerfile", "fly.toml", "fly.preview.toml", "compose.yaml", "scripts/docker-entrypoint.sh", "package.json"]) {
      assert.doesNotMatch(readFileSync(new URL(f, root), "utf8"), /sync-sim/, f);
    }
    for (const f of ["lib/initial-import.ts", "workers/imap-worker.ts", "lib/account-sync.ts", "lib/accounts-api.ts"]) {
      assert.doesNotMatch(readFileSync(new URL(f, root), "utf8"), /sync-sim|createSimPort|createSimJev/, f);
    }
  });

  it("the fake port is read-only and serves SIM_MAILS mails; the oldest ones are outside the window", async () => {
    const port = createSimPort(zero) as unknown as Record<string, unknown>;
    for (const m of ["addSeen", "moveToQuarantine", "moveToTrash", "append", "store", "expunge", "send"]) assert.equal(m in port, false, m);
    const p = createSimPort(zero);
    assert.deepEqual(await p.mailboxStatus("INBOX"), { uidValidity: 1, highestUid: SIM_MAILS });
    const found = await p.searchUids!("INBOX", { since: new Date(0), maxUid: SIM_MAILS });
    assert.equal(found.length, SIM_MAILS - SIM_OLD_MAILS);
    assert.ok(found.every((u) => u > SIM_OLD_MAILS));
    assert.equal((await p.searchUids!("INBOX", { since: new Date(0), maxUid: 30 })).at(-1), 30);
    const m = await p.fetchMessageByUid("INBOX", 12);
    assert.match(m?.source.toString() ?? "", /Subject: /);
  });

  it("every fake verdict passes the real response validation and follows the template", async () => {
    const jev = createSimJev(zero);
    for (const t of TEMPLATES) {
      const r = await jev.classify({ questions: QUESTIONS, state: { untrusted_subject: t.subject } });
      assert.ok(r.ok);
      if (!r.ok) continue;
      const n = normalizeAnswers(r.response.answers, QUESTIONS);
      assert.ok(n.ok, t.subject);
      if (n.ok) assert.equal(n.answers.find((a) => a.key === "category")?.value, t.category);
    }
    assert.ok(simMessage(3, new Date()).source.length > 0);
  });
});
