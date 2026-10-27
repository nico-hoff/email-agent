import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoActionMode, loadAccountsConfig } from "../lib/accounts-config.ts";

const repoRoot = join(import.meta.dirname, "..");
let tmp: string; // simulated project root
let outside: string; // directory outside the project root
let n = 0;

const SECRET = "pw-SECRET-VALUE-123";
function account(over: Record<string, unknown> = {}) {
  return {
    id: "a1",
    label: "Test",
    context: "synthetic context",
    host: "imap.example.test",
    port: 993,
    tls: true,
    user: "user@example.test",
    password: SECRET,
    mailbox: "INBOX",
    enabled: true,
    ...over,
  };
}
function write(dir: string, content: unknown, mode = 0o600): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `acc${n++}.json`);
  writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content));
  chmodSync(p, mode);
  return p;
}
function load(file: string | undefined) {
  const env: Record<string, string | undefined> = file === undefined ? {} : { ACCOUNTS_FILE: file };
  return () => loadAccountsConfig({ env, projectRoot: tmp });
}
function rejects(file: string, pattern: RegExp) {
  assert.throws(load(file), (e: Error) => {
    assert.match(e.message, pattern);
    assert.ok(!e.message.includes(SECRET), "message must not contain values");
    return true;
  });
}

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "email-agent-acc-root-"));
  outside = mkdtempSync(join(tmpdir(), "email-agent-acc-out-"));
});
after(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("accounts-config", () => {
  test("accepts a valid array and applies defaults", () => {
    const res = loadAccountsConfig({
      env: { ACCOUNTS_FILE: write(outside, [account(), account({ id: "a2", spam_mailbox: "Junk", spam_threshold: 0.8 })]) },
      projectRoot: tmp,
    });
    assert.equal(res.status, "ok");
    if (res.status !== "ok") return;
    assert.equal(res.accounts.length, 2);
    assert.equal(res.accounts[0].spam_threshold, 0.95);
    assert.equal(res.accounts[0].spam_mailbox, undefined);
    assert.equal(res.accounts[1].spam_threshold, 0.8);
  });

  test("auto_actions.spam_seen defaults to dry_run (H18); live must be written out", () => {
    const res = loadAccountsConfig({
      env: { ACCOUNTS_FILE: write(outside, [
        account(),
        account({ id: "a2", auto_actions: {} }),
        account({ id: "a3", auto_actions: { spam_seen: "live" } }),
        account({ id: "a4", auto_actions: { spam_seen: "off" } }),
        account({ id: "a5", auto_actions: { spam_seen: "dry_run" } }),
      ]) },
      projectRoot: tmp,
    });
    assert.equal(res.status, "ok");
    if (res.status !== "ok") return;
    assert.deepEqual(res.accounts.map((a) => autoActionMode(a, "spam_seen")), ["dry_run", "dry_run", "live", "off", "dry_run"]);
    for (const bad of [{ spam_seen: "on" }, { spam_seen: true }, { move: "live" }, "live"]) {
      rejects(write(outside, [account({ auto_actions: bad })]), /auto_actions/);
    }
  });

  test("color is optional, must be #rrggbb, and is normalised to lower case", () => {
    const ok = loadAccountsConfig({
      env: { ACCOUNTS_FILE: write(outside, [account({ color: "#1A2b3C" }), account({ id: "a2" })]) },
      projectRoot: tmp,
    });
    assert.equal(ok.status, "ok");
    if (ok.status !== "ok") return;
    assert.equal(ok.accounts[0].color, "#1a2b3c");
    assert.equal(ok.accounts[1].color, undefined);
    for (const bad of ["red", "#fff", "1a2b3c", "#1a2b3g", "#1a2b3c4d", "", 5]) {
      rejects(write(outside, [account({ color: bad })]), /color/);
    }
  });
  test("docs/accounts.example.json is valid and shows a color", () => {
    const dir = mkdtempSync(join(tmpdir(), "email-agent-acc-example-"));
    const file = join(dir, "accounts.json");
    writeFileSync(file, readFileSync(join(repoRoot, "docs", "accounts.example.json")), { mode: 0o600 });
    const res = loadAccountsConfig({ env: { ACCOUNTS_FILE: file }, projectRoot: tmp });
    assert.equal(res.status, "ok");
    if (res.status === "ok") {
      assert.ok(res.accounts.some((a) => a.color !== undefined));
      assert.ok(res.accounts.some((a) => a.auto_actions?.spam_seen === "dry_run"), "the example shows auto_actions");
      assert.ok(res.accounts.every((a) => autoActionMode(a, "spam_seen") !== "live"), "the example never ships a live account");
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test("rejects invalid port, naming the field only", () => {
    rejects(write(outside, [account({ port: 70000 })]), /port/);
    rejects(write(outside, [account({ port: "993" })]), /port/);
  });
  test("rejects missing password", () => {
    const { password: _p, ...rest } = account();
    rejects(write(outside, [rest]), /password/);
  });
  test("rejects empty host", () => rejects(write(outside, [account({ host: "" })]), /host/));
  test("rejects missing fields", () => {
    const { label: _l, tls: _t, ...rest } = account();
    rejects(write(outside, [rest]), /label[\s\S]*tls|tls[\s\S]*label/);
  });
  test("rejects spam_threshold out of range", () => {
    rejects(write(outside, [account({ spam_threshold: 1.5 })]), /spam_threshold/);
  });
  test("rejects duplicate id", () => {
    rejects(write(outside, [account(), account()]), /id/);
  });
  test("rejects non-JSON without leaking content", () => {
    rejects(write(outside, `{ ${SECRET}`), /JSON/);
  });
  test("rejects path in repo outside data/", () => {
    rejects(write(join(tmp, "config"), [account()]), /data\//);
  });
  test("accepts path under data/ of the project root", () => {
    const res = loadAccountsConfig({
      env: { ACCOUNTS_FILE: write(join(tmp, "data"), [account()]) },
      projectRoot: tmp,
    });
    assert.equal(res.status, "ok");
  });
  test("rejects relative path", () => {
    rejects("data/accounts.json", /relative|absolut/i);
  });
  test("rejects symlink", () => {
    const target = write(outside, [account()]);
    const link = join(outside, `link${n++}.json`);
    symlinkSync(target, link);
    rejects(link, /symlink|regular/i);
  });
  test("rejects group/other-readable mode", () => {
    rejects(write(outside, [account()], 0o640), /mode|permission/i);
    rejects(write(outside, [account()], 0o604), /mode|permission/i);
  });
  test("default path data/accounts.json is found without ACCOUNTS_FILE", () => {
    mkdirSync(join(tmp, "data"), { recursive: true });
    const p = join(tmp, "data", "accounts.json");
    writeFileSync(p, JSON.stringify([account()]));
    chmodSync(p, 0o600);
    const res = load(undefined)();
    assert.equal(res.status, "ok");
  });
  test("missing file means disabled, not an error", () => {
    const res = loadAccountsConfig({ env: {}, projectRoot: join(tmp, "nonexistent") });
    assert.deepEqual(res, { status: "disabled" });
    const res2 = loadAccountsConfig({ env: { ACCOUNTS_FILE: join(outside, "nope.json") }, projectRoot: tmp });
    assert.deepEqual(res2, { status: "disabled" });
  });
});

describe("git ignore", () => {
  const ignored = (path: string) => execFileSync("git", ["check-ignore", "-q", path], { cwd: repoRoot });
  test("default account and database paths are ignored", () => {
    ignored("data/accounts.json");
    ignored("data/email-agent.sqlite");
  });
  test(".env files and sqlite variants are ignored", () => {
    for (const p of [".env", ".env.local", "data/x.sqlite-wal", "data/x.sqlite-shm"]) ignored(p);
  });
});
