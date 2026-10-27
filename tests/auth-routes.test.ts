import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CSRF_HEADER } from "../lib/csrf.ts";
import { SESSION_COOKIE, DEV_IDENTITY } from "../lib/auth.ts";
import {
  createAuthContext, createLoginLimiter, dataDirFromEnv, guardRequest, handleLogin, handleLogout, handleSession, isPublicPath, syntheticFromEnv,
} from "../lib/auth-runtime.ts";
import middleware from "../middleware.ts";

const ME = "nico@example.test";
const HOST = "mac.tail.ts.net";
const ORIGIN = `https://${HOST}`;

function setup(opts: { synthetic?: boolean; allowlist?: string[] | null; now?: () => number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "auth-"));
  chmodSync(root, 0o700);
  if (opts.allowlist !== null) {
    mkdirSync(join(root, "data"), { mode: 0o700 });
    writeFileSync(join(root, "data", "auth-allowlist.json"), JSON.stringify({ logins: opts.allowlist ?? [ME] }));
  }
  const ctx = createAuthContext({ dataDir: join(root, "data"), synthetic: opts.synthetic === true, now: opts.now });
  return { root, ctx, limiter: createLoginLimiter(opts.now) };
}
const tailnet = (login: string = ME): Record<string, string> => ({ host: HOST, "tailscale-user-login": login });
const get = (path: string, headers: Record<string, string> = {}) => new Request(`http://127.0.0.1:3000${path}`, { headers });
async function sessionInfo(ctx: ReturnType<typeof setup>["ctx"], headers = tailnet()) {
  const res = await handleSession(get("/api/auth/session", headers), ctx);
  return { res, body: (await res.json()) as { login?: string; csrfToken?: string; signedIn?: boolean } };
}
function post(path: string, headers: Record<string, string>) {
  return new Request(`http://127.0.0.1:3000${path}`, { method: "POST", headers });
}
async function login(s: ReturnType<typeof setup>, headers = tailnet()) {
  const { body } = await sessionInfo(s.ctx, headers);
  return handleLogin(post("/api/auth/login", { ...headers, origin: ORIGIN, "sec-fetch-site": "same-origin", [CSRF_HEADER]: body.csrfToken ?? "" }), s.ctx, s.limiter);
}
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0];

// --- H13: without identity -> 401 on every new route -------------------------------------------------------------
test("H13: /api/auth/session, login and logout answer 401 without identity", async () => {
  const s = setup();
  assert.equal((await handleSession(get("/api/auth/session", { host: HOST }), s.ctx)).status, 401);
  const noId = { host: HOST, origin: ORIGIN };
  assert.equal((await handleLogin(post("/api/auth/login", noId), s.ctx, s.limiter)).status, 401);
  assert.equal((await handleLogout(post("/api/auth/logout", noId), s.ctx)).status, 401);
});

test("foreign tailnet login -> 403 everywhere, empty/missing allowlist denies everybody", async () => {
  const s = setup();
  const evil = tailnet("evil@x.test");
  assert.equal((await handleSession(get("/api/auth/session", evil), s.ctx)).status, 403);
  assert.equal((await login(s, evil)).status, 403);
  const none = setup({ allowlist: null });
  assert.equal((await handleSession(get("/api/auth/session", tailnet()), none.ctx)).status, 403);
  assert.equal((await login(none)).status, 403);
});

test("allowed login sets a hardened session cookie that opens guarded paths", async () => {
  const s = setup();
  const res = await login(s);
  assert.equal(res.status, 200);
  const raw = res.headers.get("set-cookie") ?? "";
  assert.ok(raw.startsWith(`${SESSION_COOKIE}=`));
  for (const a of ["HttpOnly", "SameSite=Strict", "Secure", "Path=/"]) assert.ok(raw.includes(a), a);
  const withCookie = get("/api/emails", { host: HOST, cookie: cookieOf(res) });
  assert.equal(guardRequest(withCookie, s.ctx), undefined);
  const info = await sessionInfo(s.ctx, { ...tailnet(), cookie: cookieOf(res) });
  assert.equal(info.body.signedIn, true);
});

test("cookie without HTTPS hint is not Secure only in synthetic mode", async () => {
  const live = setup();
  assert.ok(((await login(live)).headers.get("set-cookie") ?? "").includes("Secure"));
  const dev = setup({ synthetic: true, allowlist: null });
  const h = { host: "127.0.0.1:3917" };
  const { body } = await sessionInfo(dev.ctx, h);
  const res = await handleLogin(post("/api/auth/login", { ...h, origin: "http://127.0.0.1:3917", "sec-fetch-site": "same-origin", [CSRF_HEADER]: body.csrfToken ?? "" }), dev.ctx, dev.limiter);
  assert.equal(res.status, 200);
  assert.ok(!(res.headers.get("set-cookie") ?? "").includes("Secure"));
});

test("tampered, forged, expired or revoked session cookie -> 401 / redirect", async () => {
  let t = 1_800_000_000_000;
  const s = setup({ now: () => t });
  const res = await login(s);
  const good = cookieOf(res);
  const mk = (cookie: string, path = "/api/emails") => get(path, { host: HOST, cookie });
  assert.equal(guardRequest(mk(good), s.ctx), undefined);
  assert.equal(guardRequest(mk(good.slice(0, -3) + "AAA"), s.ctx)?.status, 401);
  assert.equal(guardRequest(mk(`${SESSION_COOKIE}=nonsense`), s.ctx)?.status, 401);
  // another installation's secret
  const other = setup({ now: () => t });
  const foreign = cookieOf(await login(other));
  assert.equal(guardRequest(mk(foreign), s.ctx)?.status, 401);
  // allowlist revoked
  const revoked = setup({ allowlist: [ME], now: () => t });
  const rc = cookieOf(await login(revoked));
  writeFileSync(join(revoked.root, "data", "auth-allowlist.json"), JSON.stringify({ logins: ["someone@else.test"] }));
  assert.equal(guardRequest(mk(rc), revoked.ctx)?.status, 401);
  // expired
  t += 31 * 24 * 3600 * 1000;
  assert.equal(guardRequest(mk(good), s.ctx)?.status, 401);
});

test("pages without session redirect to /welcome, APIs answer 401, public paths pass", () => {
  const s = setup();
  const page = guardRequest(get("/", { host: HOST }), s.ctx);
  assert.equal(page?.status, 303);
  assert.equal(page?.headers.get("location"), "/welcome");
  assert.equal(guardRequest(get("/emails/1", { host: HOST }), s.ctx)?.status, 303);
  for (const p of ["/api/emails", "/api/status", "/api/emails/1", "/api/anything-new"]) {
    assert.equal(guardRequest(get(p, { host: HOST }), s.ctx)?.status, 401, p);
  }
  assert.equal(guardRequest(new Request("http://127.0.0.1:3000/api/emails", { method: "POST" }), s.ctx)?.status, 401);
  for (const p of ["/api/health", "/welcome", "/api/auth/session", "/api/auth/login", "/api/auth/logout", "/manifest.webmanifest", "/sw.js", "/favicon.svg",
    "/apple-touch-icon.png", "/icon-192.png", "/_vf_modules/app/welcome/page.js", "/_vf_styles/styles.css", "/_veryfront/hmr.js"]) {
    assert.equal(guardRequest(get(p, { host: HOST }), s.ctx), undefined, p);
    assert.equal(isPublicPath(p), true, p);
  }
  for (const p of ["/api/healthz", "/api/health/x", "/welcome/../api/emails", "/api/auth", "/api/authx/login", "/icon-192.png.php", "/%2e%2e/api/emails"]) {
    assert.equal(isPublicPath(p), false, p);
  }
});

test("every route under app/api is guarded except health and auth", async () => {
  const s = setup();
  const base = join(import.meta.dirname, "..", "app", "api");
  const routes: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name), `${rel}/${e.name.replace(/^\[(.+)\]$/, "1")}`);
      else if (e.name === "route.ts") routes.push(`/api${rel}`);
    }
  };
  walk(base, "");
  assert.ok(routes.length >= 5, routes.join(","));
  for (const p of routes) {
    const open = p === "/api/health" || p.startsWith("/api/auth/");
    assert.equal(guardRequest(get(p, { host: HOST }), s.ctx) === undefined, open, p);
  }
});

test("root middleware wires the guard (401 for API, redirect for pages, next() when public)", async () => {
  const c = (path: string) => ({ request: get(path, { host: HOST }) }) as never;
  let nexted = 0;
  const next = async () => { nexted++; return new Response("ok"); };
  const handler = (Array.isArray(middleware) ? middleware[0] : middleware) as (c: never, n: typeof next) => Promise<Response | undefined>;
  assert.equal((await handler(c("/api/emails"), next))?.status, 401);
  assert.equal((await handler(c("/"), next))?.status, 303);
  assert.equal(nexted, 0);
  assert.equal((await handler(c("/api/health"), next))?.status, 200);
  assert.equal(nexted, 1);
});

// --- CSRF and rate limit ------------------------------------------------------------------------------------------
test("login without or with a wrong CSRF token -> 403", async () => {
  const s = setup();
  const base = { ...tailnet(), origin: ORIGIN, "sec-fetch-site": "same-origin" };
  assert.equal((await handleLogin(post("/api/auth/login", base), s.ctx, s.limiter)).status, 403);
  assert.equal((await handleLogin(post("/api/auth/login", { ...base, [CSRF_HEADER]: "abc.def" }), s.ctx, s.limiter)).status, 403);
  const { body } = await sessionInfo(s.ctx);
  assert.equal((await handleLogin(post("/api/auth/login", { ...base, origin: "https://evil.example", [CSRF_HEADER]: body.csrfToken! }), s.ctx, s.limiter)).status, 403);
  assert.equal((await handleLogin(post("/api/auth/login", { ...base, "sec-fetch-site": "cross-site", [CSRF_HEADER]: body.csrfToken! }), s.ctx, s.limiter)).status, 403);
  // a token issued for another identity does not work either
  const other = setup({ allowlist: [ME, "b@x.test"] });
  const t2 = (await sessionInfo(other.ctx, tailnet("b@x.test"))).body.csrfToken!;
  assert.equal((await handleLogin(post("/api/auth/login", { ...base, [CSRF_HEADER]: t2 }), other.ctx, other.limiter)).status, 403);
});

test("login is rate limited per identity", async () => {
  const s = setup();
  const bad = { ...tailnet(), origin: ORIGIN, "sec-fetch-site": "same-origin", [CSRF_HEADER]: "x" };
  let last = 0;
  for (let i = 0; i < 20; i++) {
    last = (await handleLogin(post("/api/auth/login", bad), s.ctx, s.limiter)).status;
    if (last === 429) break;
  }
  assert.equal(last, 429);
});

test("logout needs a session and CSRF, then clears the cookie", async () => {
  const s = setup();
  const res = await login(s);
  const cookie = cookieOf(res);
  const token = (await sessionInfo(s.ctx, { ...tailnet(), cookie })).body.csrfToken!;
  const h = { host: HOST, cookie, origin: ORIGIN, "sec-fetch-site": "same-origin" };
  assert.equal((await handleLogout(post("/api/auth/logout", { ...h, [CSRF_HEADER]: "bad" }), s.ctx)).status, 403);
  const out = await handleLogout(post("/api/auth/logout", { ...h, [CSRF_HEADER]: token }), s.ctx);
  assert.equal(out.status, 200);
  assert.ok((out.headers.get("set-cookie") ?? "").includes("Max-Age=0"));
});

// --- synthetic dev mode ------------------------------------------------------------------------------------------
test("dev identity: login works without any header, only in synthetic mode", async () => {
  const dev = setup({ synthetic: true, allowlist: null });
  const h = { host: "127.0.0.1:3917" };
  const info = await sessionInfo(dev.ctx, h);
  assert.equal(info.res.status, 200);
  assert.equal(info.body.login, DEV_IDENTITY);
  const live = setup({ allowlist: [DEV_IDENTITY] });
  assert.equal((await handleSession(get("/api/auth/session", { host: "127.0.0.1:3917" }), live.ctx)).status, 401);
});

test("synthetic mode follows DATABASE_PATH set by server.ts --synthetic", () => {
  const root = "/srv/app";
  assert.equal(syntheticFromEnv({ DATABASE_PATH: "/srv/app/data/dev-synthetic.sqlite" }, root), true);
  assert.equal(syntheticFromEnv({ DATABASE_PATH: "/srv/app/data/email-agent.sqlite" }, root), false);
  assert.equal(syntheticFromEnv({}, root), false);
});

test("secret and allowlist directory follows DATABASE_PATH (the /data volume in Docker)", () => {
  assert.equal(dataDirFromEnv({ DATABASE_PATH: "/data/email-agent.sqlite" }, "/app"), "/data");
  assert.equal(dataDirFromEnv({}, "/srv/app"), "/srv/app/data");
});

// --- secret ---------------------------------------------------------------------------------------------------------
test("secret file is created 0600, persists, differs between live and synthetic, and never appears in output", async () => {
  const s = setup();
  const res = await login(s);
  const file = join(s.root, "data", "auth-secret");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const secret = readFileSync(file, "utf8").trim();
  assert.ok(secret.length >= 40);
  const dump = JSON.stringify([...res.headers.entries()]) + (await res.text()) + JSON.stringify((await sessionInfo(s.ctx)).body);
  assert.ok(!dump.includes(secret));
  // a second context on the same root reuses the secret: old cookie stays valid
  const again = createAuthContext({ dataDir: join(s.root, "data"), synthetic: false });
  assert.equal(guardRequest(get("/api/emails", { host: HOST, cookie: cookieOf(res) }), again), undefined);
  // synthetic uses its own file
  const dev = createAuthContext({ dataDir: join(s.root, "data"), synthetic: true });
  await handleSession(get("/api/auth/session", { host: "127.0.0.1:1" }), dev);
  const devFile = join(s.root, "data", "dev-synthetic-auth-secret");
  assert.equal(statSync(devFile).mode & 0o777, 0o600);
  assert.notEqual(readFileSync(devFile, "utf8").trim(), secret);
  assert.equal(guardRequest(get("/api/emails", { host: "127.0.0.1:1", cookie: cookieOf(res) }), dev)?.status, 401);
});

test("a secret file with group/other access is refused (fail-closed)", async () => {
  const s = setup();
  await login(s);
  chmodSync(join(s.root, "data", "auth-secret"), 0o644);
  const fresh = createAuthContext({ dataDir: join(s.root, "data"), synthetic: false });
  assert.equal((await handleSession(get("/api/auth/session", tailnet()), fresh)).status, 500);
  assert.equal(guardRequest(get("/api/emails", { host: HOST, cookie: `${SESSION_COOKIE}=x` }), fresh)?.status, 401);
});
