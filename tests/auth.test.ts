import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEV_IDENTITY, SESSION_COOKIE, SESSION_TTL_MS, clearCookieHeader, deriveKeys, isAllowed, issueSession, parseAllowlist,
  readCookie, readTailnetLogin, requestOrigins, resolveIdentity, sessionCookieHeader, verifySession,
} from "../lib/auth.ts";

const SECRET = Buffer.alloc(32, 9);
const KEYS = deriveKeys(SECRET);
const NOW = 1_800_000_000_000;
const ME = "nico@example.test";
const h = (o: Record<string, string>) => new Headers(o);

test("tailnet login is read from the Tailscale header and sanity checked", () => {
  assert.equal(readTailnetLogin(h({ "Tailscale-User-Login": ME })), ME);
  assert.equal(readTailnetLogin(h({})), null);
  assert.equal(readTailnetLogin(h({ "Tailscale-User-Login": "" })), null);
  assert.equal(readTailnetLogin(h({ "Tailscale-User-Login": "a b@x" })), null);
  assert.equal(readTailnetLogin(h({ "Tailscale-User-Login": "x".repeat(300) })), null);
});

test("allowlist parsing is fail-closed", () => {
  assert.deepEqual(parseAllowlist('{"logins":["Nico@Example.test"]}'), [ME]);
  assert.deepEqual(parseAllowlist("not json"), []);
  assert.deepEqual(parseAllowlist('{"logins":"x"}'), []);
  assert.deepEqual(parseAllowlist('{"logins":[1,"a@b"]}'), []);
  assert.equal(isAllowed("NICO@example.test", [ME]), true);
  assert.equal(isAllowed("other@example.test", [ME]), false);
  assert.equal(isAllowed(ME, []), false);
});

test("resolveIdentity: no header -> 401, foreign login -> 403, allowed -> ok", () => {
  const o = { allowlist: [ME], synthetic: false };
  assert.deepEqual(resolveIdentity(h({}), o), { ok: false, status: 401, code: "no_identity" });
  assert.deepEqual(resolveIdentity(h({ "tailscale-user-login": "evil@x.test" }), o), { ok: false, status: 403, code: "not_allowed" });
  assert.deepEqual(resolveIdentity(h({ "tailscale-user-login": ME }), o), { ok: true, login: ME, source: "tailnet" });
});

test("dev identity exists only in synthetic mode", () => {
  assert.deepEqual(resolveIdentity(h({}), { allowlist: [], synthetic: true }), { ok: true, login: DEV_IDENTITY, source: "dev" });
  assert.equal(resolveIdentity(h({}), { allowlist: [DEV_IDENTITY], synthetic: false }).ok, false);
  assert.equal(resolveIdentity(h({ "tailscale-user-login": "evil@x.test" }), { allowlist: [], synthetic: true }).ok, false);
});

test("session round trip, tampering, expiry, wrong secret", () => {
  const v = issueSession(ME, KEYS.session, NOW);
  assert.deepEqual(verifySession(v, KEYS.session, NOW + 1000), { ok: true, login: ME });
  const parts = v.split(".");
  const forged = [parts[0], parts[1], Buffer.from("evil@x.test").toString("base64url"), parts[3]].join(".");
  assert.equal(verifySession(forged, KEYS.session, NOW).ok, false);
  assert.equal(verifySession(v.slice(0, -2) + "AA", KEYS.session, NOW).ok, false);
  assert.equal(verifySession("garbage", KEYS.session, NOW).ok, false);
  assert.equal(verifySession(v, KEYS.session, NOW + SESSION_TTL_MS + 1).ok, false);
  assert.equal(verifySession(v, deriveKeys(Buffer.alloc(32, 1)).session, NOW).ok, false);
  assert.equal(verifySession(v, KEYS.session, NOW - 60_000).ok, false, "issued in the future");
});

test("session and csrf keys differ", () => {
  assert.notDeepEqual(KEYS.session, KEYS.csrf);
  assert.throws(() => deriveKeys(Buffer.alloc(8)));
});

test("cookie attributes", () => {
  const c = sessionCookieHeader("val", { secure: true });
  assert.match(c, new RegExp(`^${SESSION_COOKIE}=val;`));
  for (const a of ["HttpOnly", "SameSite=Strict", "Path=/", "Secure", `Max-Age=${SESSION_TTL_MS / 1000}`]) assert.ok(c.includes(a), a);
  assert.ok(!sessionCookieHeader("val", { secure: false }).includes("Secure"));
  const cleared = clearCookieHeader({ secure: true });
  assert.ok(cleared.includes("Max-Age=0") && cleared.includes("HttpOnly") && cleared.includes("SameSite=Strict"));
  assert.equal(readCookie(`a=1; ${SESSION_COOKIE}=xyz; b=2`, SESSION_COOKIE), "xyz");
  assert.equal(readCookie("a=1", SESSION_COOKIE), null);
  assert.equal(readCookie(null, SESSION_COOKIE), null);
});

test("request origins derive from Host, only localhost hosts in synthetic mode", () => {
  const r = (host: string) => new Request("http://127.0.0.1:3000/x", { headers: { host } });
  assert.deepEqual(requestOrigins(r("mac.tail.ts.net"), { synthetic: false }).sort(), ["http://mac.tail.ts.net", "https://mac.tail.ts.net"]);
  assert.deepEqual(requestOrigins(r("evil.example"), { synthetic: true }), []);
  assert.deepEqual(requestOrigins(r("127.0.0.1:3917"), { synthetic: true }).sort(), ["http://127.0.0.1:3917", "https://127.0.0.1:3917"]);
});
