import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CSRF_HEADER } from "../lib/csrf.ts";
import { appPasswordStatus, issueSession, isLoopbackBind, isLoopbackDirect, MIN_PASSWORD_CHARS, PASSWORD_IDENTITY, selectAuthMode, SESSION_COOKIE } from "../lib/auth.ts";
import { createPasswordVerifier } from "../lib/password.ts";
import {
  createAuthContext, createPasswordLimiter, guardRequest, handleLogin, handleLoginRequest, handleLogout, handleSession, interceptRequest,
} from "../lib/auth-runtime.ts";

// Unique marker: it must never show up in any response, header or log line.
const PW = "pw-MARKER-7f3a9c1e-correct-horse";
const HOST = "app.example.fly.dev";
const ORIGIN = `https://${HOST}`;
const ME = "nico@example.test";

interface Setup { root: string; ctx: ReturnType<typeof createAuthContext>; limiter: ReturnType<typeof createPasswordLimiter>; slept: number[]; clock: { t: number } }
function setup(o: { appPassword?: string | undefined; synthetic?: boolean; allowlist?: string[]; delay?: number; bindAddress?: string } = {}): Setup {
  const root = mkdtempSync(join(tmpdir(), "authpw-"));
  chmodSync(root, 0o700);
  mkdirSync(join(root, "data"), { mode: 0o700 });
  if (o.allowlist) writeFileSync(join(root, "data", "auth-allowlist.json"), JSON.stringify({ logins: o.allowlist }));
  const slept: number[] = [];
  const clock = { t: 1_800_000_000_000 };
  const ctx = createAuthContext({
    dataDir: join(root, "data"), synthetic: o.synthetic === true, now: () => clock.t,
    appPassword: "appPassword" in o ? o.appPassword : PW,
    sleep: async (ms) => { slept.push(ms); },
    failDelayMs: o.delay,
    bindAddress: o.bindAddress,
  });
  return { root, ctx, limiter: createPasswordLimiter(() => clock.t), slept, clock };
}
const get = (path: string, headers: Record<string, string> = {}) => new Request(`http://127.0.0.1:3000${path}`, { headers });
const pub = { host: HOST };
async function csrfToken(s: Setup, headers: Record<string, string> = pub): Promise<string> {
  const body = (await (await handleSession(get("/api/auth/session", headers), s.ctx)).json()) as { csrfToken?: string };
  return body.csrfToken ?? "";
}
async function tryLogin(s: Setup, password: unknown, o: { headers?: Record<string, string>; token?: string | null; raw?: string } = {}) {
  const token = o.token === undefined ? await csrfToken(s) : o.token;
  const headers: Record<string, string> = {
    host: HOST, origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/json", ...(o.headers ?? {}),
  };
  if (token !== null) headers[CSRF_HEADER] = token;
  const body = o.raw ?? JSON.stringify({ password });
  return handleLoginRequest(new Request("http://127.0.0.1:3000/api/auth/login", { method: "POST", headers, body }), s.ctx, s.limiter);
}
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0];

// --- mode selection (pure) ---------------------------------------------------------------------------------------
test("selectAuthMode: synthetic wins, then APP_PASSWORD (even empty or short), else tailnet", () => {
  assert.equal(selectAuthMode({ synthetic: true, appPassword: PW }), "synthetic");
  assert.equal(selectAuthMode({ synthetic: true, appPassword: undefined }), "synthetic");
  assert.equal(selectAuthMode({ synthetic: false, appPassword: PW }), "password");
  assert.equal(selectAuthMode({ synthetic: false, appPassword: "short" }), "password");
  assert.equal(selectAuthMode({ synthetic: false, appPassword: "" }), "password");
  assert.equal(selectAuthMode({ synthetic: false, appPassword: undefined }), "tailnet");
});

test("password rules: at least 16 characters, shorter or empty is misconfigured", () => {
  assert.equal(MIN_PASSWORD_CHARS, 16);
  assert.equal(appPasswordStatus(undefined), "unset");
  assert.equal(appPasswordStatus(""), "too_short");
  assert.equal(appPasswordStatus("x".repeat(15)), "too_short");
  assert.equal(appPasswordStatus("x".repeat(16)), "ok");
});

test("auth context: synthetic beats APP_PASSWORD, unset means tailnet", () => {
  assert.equal(setup({ synthetic: true }).ctx.mode, "synthetic");
  assert.equal(setup({ appPassword: undefined }).ctx.mode, "tailnet");
  assert.equal(setup().ctx.mode, "password");
});

// --- verifier --------------------------------------------------------------------------------------------------
test("verifier: right, wrong, empty, near-miss and oversized candidates", async () => {
  const v = createPasswordVerifier(PW);
  assert.equal(v.configured, true);
  assert.equal(await v.verify(PW), true);
  for (const bad of ["", "x", PW + "x", PW.slice(0, -1), PW.toUpperCase(), "a".repeat(100_000)]) assert.equal(await v.verify(bad), false);
  const tooShort = createPasswordVerifier("short");
  assert.equal(tooShort.configured, false);
  assert.equal(await tooShort.verify("short"), false, "a too short password never verifies, not even itself");
  assert.equal(await createPasswordVerifier(undefined).verify(""), false);
});

test("verifier compares derived keys with timingSafeEqual and never the plaintext", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "lib", "password.ts"), "utf8");
  assert.match(src, /timingSafeEqual/);
  assert.match(src, /scrypt/);
  assert.doesNotMatch(src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, ""), /===\s*(password|candidate)\b|\b(password|candidate)\s*===/);
});

// --- header is ignored in password mode ----------------------------------------------------------------------------
test("password mode ignores Tailscale-User-Login completely, even for an allow-listed login", async () => {
  const s = setup({ allowlist: [ME] });
  const forged = { host: HOST, "tailscale-user-login": ME };
  assert.equal(guardRequest(get("/api/emails", forged), s.ctx)?.status, 401);
  assert.equal(guardRequest(get("/", forged), s.ctx)?.status, 303);
  assert.equal(new URL(interceptRequest(get("/api/emails", forged), () => s.ctx).url).searchParams.get("k"), "api");
  const res = await handleSession(get("/api/auth/session", forged), s.ctx);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(res.status, 200);
  assert.equal(body.mode, "password");
  assert.equal(body.signedIn, false);
  assert.ok(!JSON.stringify(body).includes(ME), "the header value is never echoed");
  assert.equal("login" in body, false);
  // logging in with only the header (no password) fails, with a valid CSRF token
  assert.equal((await tryLogin(s, "", { headers: forged })).status, 401);
  assert.equal((await tryLogin(s, undefined, { headers: forged, raw: "{}" })).status, 401);
  // the tailnet login handler never issues a cookie in password mode
  const direct = handleLogin(new Request("http://127.0.0.1:3000/api/auth/login", { method: "POST", headers: forged }), s.ctx, s.limiter);
  assert.ok(direct.status === 401 || direct.status === 403);
  assert.equal(direct.headers.get("set-cookie"), null);
});

test("a session cookie from tailnet mode (same data dir and secret) is worthless in password mode", () => {
  const tail = setup({ appPassword: undefined, allowlist: [ME] });
  const keys = tail.ctx.keys();
  const forgedLogin = `${SESSION_COOKIE}=${issueSession(ME, keys.session, tail.clock.t)}`;
  assert.equal(guardRequest(get("/api/emails", { host: HOST, cookie: forgedLogin }), tail.ctx), undefined, "valid in tailnet mode");
  const pw = createAuthContext({ dataDir: join(tail.root, "data"), synthetic: false, now: () => tail.clock.t, appPassword: PW });
  assert.equal(guardRequest(get("/api/emails", { host: HOST, cookie: forgedLogin }), pw)?.status, 401);
  // ... and a password-user cookie is worthless in tailnet mode
  const asPw = `${SESSION_COOKIE}=${issueSession(PASSWORD_IDENTITY, keys.session, tail.clock.t)}`;
  assert.equal(guardRequest(get("/api/emails", { host: HOST, cookie: asPw }), tail.ctx)?.status, 401);
  assert.equal(guardRequest(get("/api/emails", { host: HOST, cookie: asPw }), pw), undefined);
});

// --- login ----------------------------------------------------------------------------------------------------
test("right password -> hardened cookie that opens guarded paths; no allowlist file needed", async () => {
  const s = setup();
  const res = await tryLogin(s, PW);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  const raw = res.headers.get("set-cookie") ?? "";
  assert.ok(raw.startsWith(`${SESSION_COOKIE}=`));
  for (const a of ["HttpOnly", "SameSite=Strict", "Secure", "Path=/"]) assert.ok(raw.includes(a), a);
  assert.equal(s.slept.length, 0, "no delay on success");
  assert.equal(guardRequest(get("/api/emails", { host: HOST, cookie: cookieOf(res) }), s.ctx), undefined);
  const info = (await (await handleSession(get("/api/auth/session", { host: HOST, cookie: cookieOf(res) }), s.ctx)).json()) as Record<string, unknown>;
  assert.equal(info.signedIn, true);
  assert.equal(info.mode, "password");
});

test("wrong, empty, malformed and non-string passwords -> 401 invalid_credentials, one uniform answer with a fixed delay", async () => {
  const s = setup();
  const answers = new Set<string>();
  let n = 0;
  const attempts: unknown[] = ["wrong-password-xxxxxxx", "", PW.slice(0, -1)];
  for (const attempt of attempts) {
    const res = await tryLogin(s, attempt);
    n++;
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("set-cookie"), null);
    answers.add(await res.text());
  }
  s.clock.t += 16 * 60 * 1000;
  for (const attempt of [PW + " ", 12345, null, ["a"]]) {
    const res = await tryLogin(s, attempt);
    n++;
    assert.equal(res.status, 401);
    answers.add(await res.text());
  }
  s.clock.t += 16 * 60 * 1000;
  for (const raw of ["not json", "", "[]", "null", '"x"', "{".repeat(10_000)]) {
    const res = await tryLogin(s, null, { raw });
    n++;
    assert.equal(res.status, 401, raw.slice(0, 10));
    answers.add(await res.text());
  }
  assert.deepEqual([...answers], ['{"error":"invalid_credentials"}']);
  assert.equal(s.slept.length, n);
  assert.ok(s.slept.every((ms) => ms === 500), "every failure waits the same fixed 500 ms");
});

test("too short or empty APP_PASSWORD is fail-closed: nobody can log in, session says unconfigured", async () => {
  for (const bad of ["", "short", "x".repeat(15)]) {
    const s = setup({ appPassword: bad });
    assert.equal(s.ctx.mode, "password");
    const info = (await (await handleSession(get("/api/auth/session", pub), s.ctx)).json()) as Record<string, unknown>;
    assert.deepEqual(info, { mode: "password", configured: false });
    for (const guess of [bad, "", PW]) {
      const res = await tryLogin(s, guess, { token: "x.y" });
      assert.equal(res.status, 503);
      assert.equal(res.headers.get("set-cookie"), null);
      assert.deepEqual(await res.json(), { error: "server_misconfigured" });
    }
    // even a correctly signed cookie (secret file is known to the test) is refused
    const forged = `${SESSION_COOKIE}=${issueSession(PASSWORD_IDENTITY, s.ctx.keys().session, s.clock.t)}`;
    assert.equal(guardRequest(get("/api/emails", { host: HOST, cookie: forged }), s.ctx)?.status, 401);
    assert.equal(guardRequest(get("/", { host: HOST, cookie: forged }), s.ctx)?.status, 303);
  }
});

// --- brute force ------------------------------------------------------------------------------------------------
test("global limiter: 10 failures in 15 minutes, then 429 with retry-after, even for the right password", async () => {
  const s = setup();
  const token = await csrfToken(s);
  for (let i = 0; i < 10; i++) assert.equal((await tryLogin(s, `wrong-${i}-xxxxxxxxxxxx`, { token })).status, 401, String(i));
  const blocked = await tryLogin(s, PW, { token });
  assert.equal(blocked.status, 429);
  assert.deepEqual(await blocked.json(), { error: "rate_limited" });
  const wait = Number(blocked.headers.get("retry-after"));
  assert.ok(wait > 0 && wait <= 15 * 60, String(wait));
  assert.equal(blocked.headers.get("set-cookie"), null);
  // not per identity: another header value does not help
  assert.equal((await tryLogin(s, PW, { headers: { "tailscale-user-login": "other@x.test" } })).status, 429);
  s.clock.t += 15 * 60 * 1000 + 1;
  assert.equal((await tryLogin(s, PW)).status, 200);
});

test("a successful login frees only its own slot: it does not reset the failures", async () => {
  const s = setup();
  for (let i = 0; i < 9; i++) await tryLogin(s, `wrong-${i}-xxxxxxxxxxxx`);
  assert.equal((await tryLogin(s, PW)).status, 200);
  assert.equal((await tryLogin(s, "wrong-again-xxxxxxxx")).status, 401); // the 10th failure
  assert.equal((await tryLogin(s, PW)).status, 429);
});

test("concurrent guesses cannot exceed the limit", async () => {
  const s = setup();
  const token = await csrfToken(s);
  const results = await Promise.all(Array.from({ length: 30 }, (_, i) => tryLogin(s, `wrong-${i}-xxxxxxxxxxxx`, { token })));
  assert.equal(results.filter((r) => r.status === 401).length, 10);
  assert.equal(results.filter((r) => r.status === 429).length, 20);
});

// --- CSRF -------------------------------------------------------------------------------------------------------
test("login CSRF: missing or wrong token, foreign origin, cross-site -> 403 and no attempt is counted", async () => {
  const s = setup();
  const token = await csrfToken(s);
  assert.equal((await tryLogin(s, PW, { token: null })).status, 403);
  assert.equal((await tryLogin(s, PW, { token: "abc.def" })).status, 403);
  assert.equal((await tryLogin(s, PW, { token, headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal((await tryLogin(s, PW, { token, headers: { "sec-fetch-site": "cross-site" } })).status, 403);
  const noOrigin = new Request("http://127.0.0.1:3000/api/auth/login", { method: "POST", headers: { host: HOST, [CSRF_HEADER]: token }, body: JSON.stringify({ password: PW }) });
  assert.equal((await handleLoginRequest(noOrigin, s.ctx, s.limiter)).status, 403);
  for (let i = 0; i < 30; i++) await tryLogin(s, PW, { token: "bad.token" });
  assert.equal((await tryLogin(s, PW, { token })).status, 200, "forged requests did not burn the limiter");
  assert.equal(s.slept.length, 0);
});

// --- cookie flags / Secure ---------------------------------------------------------------------------------------
test("Secure is always set in password mode, also over plain HTTP hints; only a direct loopback request may omit it", async () => {
  const s = setup();
  const secure = async (headers: Record<string, string>, origin: string) => {
    const token = await csrfToken(s, { host: headers.host });
    const res = await tryLogin(s, PW, { token, headers: { ...headers, origin } });
    assert.equal(res.status, 200);
    return (res.headers.get("set-cookie") ?? "").includes("; Secure");
  };
  assert.equal(await secure({ host: HOST, "x-forwarded-proto": "https" }, ORIGIN), true);
  assert.equal(await secure({ host: HOST, "x-forwarded-proto": "http" }, `http://${HOST}`), true, "a client cannot switch Secure off");
  assert.equal(await secure({ host: HOST }, ORIGIN), true);
  assert.equal(await secure({ host: "localhost:3000", "x-forwarded-proto": "http" }, "http://localhost:3000"), true, "loopback host behind a proxy is not local");
  assert.equal(await secure({ host: "127.0.0.1:3000", "fly-client-ip": "203.0.113.9" }, "http://127.0.0.1:3000"), true);
  assert.equal(await secure({ host: "127.0.0.1:3000" }, "http://127.0.0.1:3000"), false, "direct loopback test access");
  assert.equal(await secure({ host: "localhost:3000" }, "http://localhost:3000"), false);
  assert.equal(await secure({ host: "127.0.0.1.evil.test:3000" }, "http://127.0.0.1.evil.test:3000"), true);
});

test("on a public bind address (0.0.0.0, as on fly.io) Secure is unconditional, even for a loopback Host without proxy headers", async () => {
  const s = setup({ bindAddress: "0.0.0.0" });
  const token = await csrfToken(s, { host: "127.0.0.1:3000" });
  const res = await tryLogin(s, PW, { token, headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" } });
  assert.equal(res.status, 200);
  assert.ok((res.headers.get("set-cookie") ?? "").includes("; Secure"));
});

test("isLoopbackBind: unset or loopback only", () => {
  for (const ok of [undefined, "", "127.0.0.1", "127.1.2.3", "localhost", "::1", "[::1]"]) assert.equal(isLoopbackBind(ok), true, String(ok));
  for (const bad of ["0.0.0.0", "::", "10.0.0.5", "fly-local-6pn", "127.0.0.1.evil"]) assert.equal(isLoopbackBind(bad), false, bad);
});

test("isLoopbackDirect needs a loopback Host and no forwarding header", () => {
  const r = (headers: Record<string, string>) => new Request("http://127.0.0.1:3000/x", { headers });
  assert.equal(isLoopbackDirect(r({ host: "127.0.0.1:3000" })), true);
  assert.equal(isLoopbackDirect(r({ host: "[::1]:3000" })), true);
  assert.equal(isLoopbackDirect(r({ host: "example.com" })), false);
  assert.equal(isLoopbackDirect(r({})), false);
  assert.equal(isLoopbackDirect(r({ host: "127.0.0.1:3000" }), "0.0.0.0"), false);
  for (const h of ["x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "forwarded", "fly-client-ip", "fly-forwarded-proto"]) {
    assert.equal(isLoopbackDirect(r({ host: "127.0.0.1:3000", [h]: "1" })), false, h);
  }
});

// --- logout ---------------------------------------------------------------------------------------------------
test("logout in password mode needs session and CSRF, clears the cookie with Secure", async () => {
  const s = setup();
  const cookie = cookieOf(await tryLogin(s, PW));
  const token = await csrfToken(s, { host: HOST, cookie });
  const h = { host: HOST, cookie, origin: ORIGIN, "sec-fetch-site": "same-origin" };
  const post = (headers: Record<string, string>) => new Request("http://127.0.0.1:3000/api/auth/logout", { method: "POST", headers });
  assert.equal(handleLogout(post({ host: HOST, origin: ORIGIN, [CSRF_HEADER]: token }), s.ctx).status, 401);
  assert.equal(handleLogout(post({ ...h, [CSRF_HEADER]: "bad" }), s.ctx).status, 403);
  const out = handleLogout(post({ ...h, [CSRF_HEADER]: token }), s.ctx);
  assert.equal(out.status, 200);
  const raw = out.headers.get("set-cookie") ?? "";
  assert.ok(raw.includes("Max-Age=0") && raw.includes("; Secure"));
});

// --- secrecy -----------------------------------------------------------------------------------------------------
test("the password never appears in responses, headers, cookies or console output", async () => {
  const lines: string[] = [];
  const keep = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug };
  for (const k of Object.keys(keep) as (keyof typeof keep)[]) console[k] = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  const dump: string[] = [];
  try {
    const s = setup();
    const short = setup({ appPassword: PW.slice(0, 10) });
    const collect = async (res: Response) => { dump.push(JSON.stringify([...res.headers.entries()]), await res.text()); return res; };
    await collect(await handleSession(get("/api/auth/session", pub), s.ctx));
    await collect(await tryLogin(s, PW));
    await collect(await tryLogin(s, PW + "x"));
    await collect(await tryLogin(s, null, { raw: PW }));
    await collect(await tryLogin(short, PW));
    for (let i = 0; i < 12; i++) await collect(await tryLogin(s, PW + i));
    await collect(await handleSession(get("/api/auth/session", pub), short.ctx));
    await collect(guardRequest(get("/api/emails", pub), s.ctx)!);
  } finally {
    Object.assign(console, keep);
  }
  const all = dump.join("\n") + lines.join("\n");
  assert.ok(all.length > 100);
  assert.ok(!all.includes(PW), "password leaked");
  assert.ok(!all.includes("pw-MARKER"), "password prefix leaked");
});
