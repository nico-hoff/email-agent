// R3 settings API (tailnet identity = owner = admin). Synthetic data; no network.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { generateKey } from "../lib/account-secrets.ts";
import { handleAccountCreate, type AccountsApiDeps } from "../lib/accounts-api.ts";
import { createAuthContext, createLoginLimiter, createMutationLimiter, handleLogin, handleSession } from "../lib/auth-runtime.ts";
import { CSRF_HEADER } from "../lib/csrf.ts";
import { openDatabase } from "../lib/db.ts";
import {
  handleClassifierModel, handlePermission, handleQuarantineSettings, handleSettingsGet, handleSpamSeenMode, handleStop, type SettingsApiDeps,
} from "../lib/settings-api.ts";
import { LUNA_CLASSIFIER } from "../lib/classifier-models.ts";
import { isSelectableModel } from "../lib/user-settings.ts";

const ME = "nico@example.test";
const HOST = "mac.tail.ts.net";
const ORIGIN = `https://${HOST}`;
const NOW = new Date("2026-10-31T10:00:00.000Z");

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "set-api-"));
  chmodSync(dir, 0o700);
  mkdirSync(join(dir, "data"), { mode: 0o700 });
  writeFileSync(join(dir, "data", "auth-allowlist.json"), JSON.stringify({ logins: [ME] }));
  const auth = createAuthContext({ dataDir: join(dir, "data"), synthetic: false });
  const db = openDatabase(":memory:");
  const unclosable = { prepare: db.prepare.bind(db), exec: db.exec.bind(db), close() {} } as unknown as DatabaseSync;
  const killSwitchFile = join(dir, "data", "auto-actions.disabled");
  const deps: SettingsApiDeps = { auth, limiter: createMutationLimiter(), openDb: () => unclosable, killSwitchFile, now: () => NOW };
  const accDeps: AccountsApiDeps = {
    auth, limiter: createMutationLimiter(), testLimiter: createMutationLimiter(), openDb: () => unclosable, env: { ACCOUNTS_ENCRYPTION_KEY: generateKey() }, now: () => NOW,
  };
  const headers = { host: HOST, "tailscale-user-login": ME };
  const info = (await (await handleSession(new Request("http://127.0.0.1:3000/api/auth/session", { headers }), auth)).json()) as { csrfToken: string };
  const res = handleLogin(new Request("http://127.0.0.1:3000/api/auth/login", { method: "POST", headers: { ...headers, origin: ORIGIN, "sec-fetch-site": "same-origin", [CSRF_HEADER]: info.csrfToken } }), auth, createLoginLimiter());
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { db, deps, accDeps, cookie, csrf: info.csrfToken, killSwitchFile };
}
type S = Awaited<ReturnType<typeof setup>>;
const get = (s: S) => new Request("http://127.0.0.1:3000/api/settings", { headers: { host: HOST, cookie: s.cookie } });
const post = (s: S, path: string, body?: unknown, withSession = true) => new Request(`http://127.0.0.1:3000${path}`, {
  method: "POST", body: body === undefined ? undefined : JSON.stringify(body),
  headers: { host: HOST, ...(withSession ? { cookie: s.cookie } : {}), origin: ORIGIN, "sec-fetch-site": "same-origin", [CSRF_HEADER]: s.csrf, "content-type": "application/json" },
});
const mkAccount = async (s: S, label = "Privat") => {
  const r = await handleAccountCreate(post(s, "/api/accounts", { type: "imap", label, username: "me@example.test", password: "pw-synthetic-123", host: "imap.example.test", port: 993, tls: true, mailbox: "INBOX" }), s.accDeps);
  assert.equal(r.status, 201);
  return ((await r.json()) as { account: { id: string } }).account.id;
};
const settings = async (s: S) => (await handleSettingsGet(get(s), s.deps).json()) as {
  stop: { user_stopped_at: string | null; global_active: boolean; can_toggle_global: boolean };
  daily_limit: number; accounts: { id: string; spam_seen_mode: string | null; managed: boolean; actions_24h: number }[];
  classifier: { permitted: boolean; model?: string; models?: { id: string; selectable: boolean; relative_cost: number }[] };
  members?: { id: number; classifier_choice: boolean }[];
};
const audits = (s: S) => s.db.prepare("SELECT action, account_id, details_json, user_id FROM audit_log WHERE action NOT LIKE 'account_%' ORDER BY id").all().map((r) => ({ ...r }));

describe("settings API", () => {
  it("every route needs a session", async () => {
    const s = await setup();
    for (const h of [handleSpamSeenMode, handleStop, handleClassifierModel, handlePermission]) {
      assert.equal((await h(post(s, "/x", {}, false), s.deps)).status, 401);
    }
  });

  it("a new account starts with Spam gelesen = off; the limit and the counts are shown", async () => {
    const s = await setup();
    const id = await mkAccount(s);
    const d = await settings(s);
    assert.equal(d.daily_limit, 200);
    assert.deepEqual(d.accounts.map((a) => [a.id, a.spam_seen_mode, a.managed, a.actions_24h]), [[id, "off", true, 0]]);
    assert.deepEqual(d.stop, { user_stopped_at: null, global_active: false, can_toggle_global: true });
  });

  it("live only with an explicit confirmation; off and dry_run need none; audit has codes only", async () => {
    const s = await setup();
    const id = await mkAccount(s);
    const mode = async () => (await settings(s)).accounts[0]!.spam_seen_mode;
    assert.equal((await handleSpamSeenMode(post(s, "/x", { account_id: id, mode: "live" }), s.deps)).status, 400);
    assert.equal((await handleSpamSeenMode(post(s, "/x", { account_id: id, mode: "live", confirm: false }), s.deps)).status, 400);
    assert.equal(await mode(), "off");
    assert.equal((await handleSpamSeenMode(post(s, "/x", { account_id: id, mode: "dry_run" }), s.deps)).status, 200);
    assert.equal(await mode(), "dry_run");
    assert.equal((await handleSpamSeenMode(post(s, "/x", { account_id: id, mode: "live", confirm: true }), s.deps)).status, 200);
    assert.equal(await mode(), "live");
    assert.equal((await handleSpamSeenMode(post(s, "/x", { account_id: id, mode: "off" }), s.deps)).status, 200);
    assert.equal(await mode(), "off");
    assert.equal((await handleSpamSeenMode(post(s, "/x", { account_id: id, mode: "always" }), s.deps)).status, 400);
    assert.equal((await handleSpamSeenMode(post(s, "/x", { account_id: id, mode: "off", extra: 1 }), s.deps)).status, 400);
    const a = audits(s);
    assert.deepEqual(a.map((r) => r.action), Array(3).fill("spam_seen_mode_changed"));
    assert.deepEqual(a.map((r) => JSON.parse(r.details_json as string)), [{ from: "off", to: "dry_run" }, { from: "dry_run", to: "live" }, { from: "live", to: "off" }]);
  });

  it("unknown account 404; account without credentials 409", async () => {
    const s = await setup();
    assert.equal((await handleSpamSeenMode(post(s, "/x", { account_id: "nope", mode: "off" }), s.deps)).status, 404);
    s.db.exec("INSERT INTO accounts (id,label,host,port,mailbox,user_id) VALUES ('demo','D','h',993,'INBOX',1)");
    assert.equal((await handleSpamSeenMode(post(s, "/x", { account_id: "demo", mode: "dry_run" }), s.deps)).status, 409);
    const d = await settings(s);
    assert.deepEqual(d.accounts.map((a) => [a.id, a.managed, a.spam_seen_mode]), [["demo", false, null]]);
  });

  it("user stop and global stop (confirmation, admin file)", async () => {
    const s = await setup();
    assert.equal((await handleStop(post(s, "/x", { scope: "user", stopped: true }), s.deps)).status, 200);
    assert.equal((await settings(s)).stop.user_stopped_at, NOW.toISOString());
    assert.equal((await handleStop(post(s, "/x", { scope: "global", stopped: true }), s.deps)).status, 400);
    assert.equal(existsSync(s.killSwitchFile), false);
    assert.equal((await handleStop(post(s, "/x", { scope: "global", stopped: true, confirm: true }), s.deps)).status, 200);
    assert.equal(existsSync(s.killSwitchFile), true);
    assert.equal((await settings(s)).stop.global_active, true);
    assert.equal((await handleStop(post(s, "/x", { scope: "global", stopped: false, confirm: true }), s.deps)).status, 200);
    assert.equal(existsSync(s.killSwitchFile), false);
    assert.equal((await handleStop(post(s, "/x", { scope: "user", stopped: false }), s.deps)).status, 200);
    assert.equal((await settings(s)).stop.user_stopped_at, null);
    assert.deepEqual(audits(s).map((r) => r.action), ["user_stop_set", "global_stop_set", "global_stop_cleared", "user_stop_cleared"]);
  });

  it("classifier: hidden without the permission, admin grants, then the user chooses; calibration gates Luna", async () => {
    const s = await setup();
    assert.deepEqual((await settings(s)).classifier, { permitted: false });
    assert.equal((await handleClassifierModel(post(s, "/x", { model: LUNA_CLASSIFIER }), s.deps)).status, 403);
    assert.equal((await handlePermission(post(s, "/x", { user_id: 1, classifier_choice: true }), s.deps)).status, 200);
    const c = (await settings(s)).classifier;
    assert.equal(c.permitted, true);
    assert.equal(c.model, "typesafe/jev-1.13");
    assert.deepEqual(c.models?.map((m) => [m.id, m.selectable]), [["typesafe/jev-1.13", true], [LUNA_CLASSIFIER, isSelectableModel(LUNA_CLASSIFIER)]]);
    assert.equal((await handleClassifierModel(post(s, "/x", { model: "evil/model" }), s.deps)).status, 400);
    const luna = await handleClassifierModel(post(s, "/x", { model: LUNA_CLASSIFIER }), s.deps);
    assert.equal(luna.status, isSelectableModel(LUNA_CLASSIFIER) ? 200 : 409);
    assert.equal((await handleClassifierModel(post(s, "/x", { model: "typesafe/jev-1.13" }), s.deps)).status, 200);
    assert.equal((await handlePermission(post(s, "/x", { user_id: 99, classifier_choice: true }), s.deps)).status, 404);
    assert.equal((await handlePermission(post(s, "/x", { user_id: 1, classifier_choice: false }), s.deps)).status, 200);
    assert.deepEqual((await settings(s)).classifier, { permitted: false });
  });
});

describe("quarantine settings (R9, ADR 0025 Teil 2)", () => {
  const q = (s: S, body: unknown, withSession = true) => handleQuarantineSettings(post(s, "/api/settings/quarantine", body, withSession), s.deps);
  const view = async (s: S, id: string) => ((await settings(s)).accounts.find((a) => a.id === id) as unknown as { quarantine: { mode: string; days: number; yolo: boolean } }).quarantine;

  it("defaults are off, 14 days, no YOLO", async () => {
    const s = await setup();
    const id = await mkAccount(s);
    assert.deepEqual(await view(s, id), { mode: "off", days: 14, yolo: false });
  });

  it("dry_run needs no confirmation; live and YOLO need confirm: true", async () => {
    const s = await setup();
    const id = await mkAccount(s);
    assert.equal((await q(s, { account_id: id, mode: "dry_run" })).status, 200);
    assert.equal((await q(s, { account_id: id, mode: "live" })).status, 400);
    assert.equal((await q(s, { account_id: id, mode: "live", confirm: false })).status, 400);
    assert.equal((await view(s, id)).mode, "dry_run");
    assert.equal((await q(s, { account_id: id, yolo: true })).status, 400, "YOLO without confirm");
    assert.equal((await view(s, id)).yolo, false);
    assert.equal((await q(s, { account_id: id, yolo: true, confirm: true })).status, 200);
    assert.equal((await q(s, { account_id: id, mode: "live", confirm: true })).status, 200);
    assert.deepEqual(await view(s, id), { mode: "live", days: 14, yolo: true });
  });

  it("YOLO needs a mode other than off; switching off clears YOLO", async () => {
    const s = await setup();
    const id = await mkAccount(s);
    const r = await q(s, { account_id: id, yolo: true, confirm: true });
    assert.equal(r.status, 409);
    assert.equal(((await r.json()) as { error: string }).error, "quarantine_off");
    await q(s, { account_id: id, mode: "dry_run" });
    await q(s, { account_id: id, yolo: true, confirm: true });
    await q(s, { account_id: id, mode: "off" });
    assert.deepEqual(await view(s, id), { mode: "off", days: 14, yolo: false });
  });

  it("cleanup days: 1 to 90 only", async () => {
    const s = await setup();
    const id = await mkAccount(s);
    assert.equal((await q(s, { account_id: id, days: 30 })).status, 200);
    assert.equal((await view(s, id)).days, 30);
    for (const days of [0, 91, -1, 1.5, "7"]) assert.equal((await q(s, { account_id: id, days })).status, 400, String(days));
    assert.equal((await q(s, { account_id: id, days: 1 })).status, 200);
    assert.equal((await q(s, { account_id: id, days: 90 })).status, 200);
    assert.equal((await view(s, id)).days, 90);
  });

  it("unknown fields, an empty change, a missing session and a foreign account id are refused without a change", async () => {
    const s = await setup();
    const id = await mkAccount(s);
    assert.equal((await q(s, { account_id: id, mode: "dry_run", extra: 1 })).status, 400);
    assert.equal((await q(s, { account_id: id })).status, 400);
    assert.equal((await q(s, { account_id: id, mode: "on" })).status, 400);
    assert.equal((await q(s, { account_id: "nope", mode: "dry_run" })).status, 404);
    assert.equal((await q(s, { account_id: id, mode: "dry_run" }, false)).status, 401);
    assert.deepEqual(await view(s, id), { mode: "off", days: 14, yolo: false });
  });

  it("audit rows carry codes only", async () => {
    const s = await setup();
    const id = await mkAccount(s);
    await q(s, { account_id: id, mode: "dry_run" });
    await q(s, { account_id: id, days: 7 });
    await q(s, { account_id: id, yolo: true, confirm: true });
    assert.deepEqual(audits(s).map((a) => [a.action, a.details_json]), [
      ["quarantine_mode_changed", '{"from":"off","to":"dry_run"}'],
      ["quarantine_days_changed", '{"from":14,"to":7}'],
      ["quarantine_yolo_changed", '{"from":false,"to":true}'],
    ]);
  });
});
