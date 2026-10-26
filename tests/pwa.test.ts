import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const root = join(import.meta.dirname, "..");
const pub = (p: string) => join(root, "public", p);

interface Icon { src: string; sizes: string; type: string; purpose?: string }

function pngSize(file: string): { w: number; h: number } {
  const b = readFileSync(file);
  assert.equal(b.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", `${file} is a PNG`);
  assert.equal(b.subarray(12, 16).toString("latin1"), "IHDR");
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

test("manifest is valid JSON with the required installable fields", () => {
  const m = JSON.parse(readFileSync(pub("manifest.webmanifest"), "utf8"));
  assert.equal(m.name, "E-Mail-Agent");
  assert.ok(typeof m.short_name === "string" && m.short_name.length > 0 && m.short_name.length <= 12);
  assert.equal(m.start_url, "/");
  assert.equal(m.display, "standalone");
  assert.match(m.theme_color, /^#[0-9a-f]{6}$/i);
  assert.match(m.background_color, /^#[0-9a-f]{6}$/i);
  const icons: Icon[] = m.icons;
  const has = (size: string, purpose: string) =>
    icons.some((i) => i.sizes === size && (i.purpose ?? "any").split(" ").includes(purpose));
  assert.ok(has("192x192", "any"), "192 any");
  assert.ok(has("512x512", "any"), "512 any");
  assert.ok(has("512x512", "maskable"), "512 maskable");
});

test("every referenced icon exists as PNG with the declared size", () => {
  const m = JSON.parse(readFileSync(pub("manifest.webmanifest"), "utf8"));
  for (const i of m.icons as Icon[]) {
    assert.equal(i.type, "image/png");
    assert.ok(i.src.startsWith("/"));
    const [w, h] = i.sizes.split("x").map(Number);
    assert.deepEqual(pngSize(pub(i.src.slice(1))), { w, h }, i.src);
  }
  assert.deepEqual(pngSize(pub("apple-touch-icon.png")), { w: 180, h: 180 });
});

test("layout declares manifest, theme colors, apple tags and viewport-fit=cover", () => {
  const src = readFileSync(join(root, "app/layout.tsx"), "utf8");
  assert.match(src, /rel="manifest"[^>]*href="\/manifest\.webmanifest"/);
  assert.match(src, /name="theme-color"[^>]*prefers-color-scheme: light/);
  assert.match(src, /name="theme-color"[^>]*prefers-color-scheme: dark/);
  assert.match(src, /rel="apple-touch-icon"[^>]*href="\/apple-touch-icon\.png"/);
  assert.match(src, /name="apple-mobile-web-app-capable"[^>]*content="yes"/);
  assert.match(src, /name="viewport"[^>]*viewport-fit=cover/);
  assert.match(src, /<RegisterServiceWorker \/>/, "layout mounts SW registration");
  const reg = readFileSync(join(root, "app/register-sw.tsx"), "utf8");
  assert.match(reg, /'serviceWorker' in navigator/);
  assert.match(reg, /register\('\/sw\.js'/);
});

// ---- service worker, executed in a sandbox with fake self/caches ----

type Handler = (e: unknown) => void;
function loadSw() {
  const handlers: Record<string, Handler> = {};
  const store = new Map<string, Map<string, Response>>();
  const puts: string[] = [];
  const fetched: string[] = [];
  const keyOf = (req: Request | string) => (typeof req === "string" ? new URL(req, "https://app.test").href : req.url);
  const cache = (name: string) => {
    if (!store.has(name)) store.set(name, new Map());
    const m = store.get(name)!;
    return {
      async addAll(urls: string[]) { for (const u of urls) { const k = keyOf(u); puts.push(k); m.set(k, new Response("x")); } },
      async add(u: string) { const k = keyOf(u); puts.push(k); m.set(k, new Response("x")); },
      async put(req: Request | string, res: Response) { const k = keyOf(req); puts.push(k); m.set(k, res); },
      async match(req: Request | string) { return m.get(keyOf(req)); },
    };
  };
  const caches = {
    open: async (n: string) => cache(n),
    keys: async () => [...store.keys()],
    delete: async (n: string) => store.delete(n),
    match: async (req: Request | string) => {
      for (const n of store.keys()) { const r = await cache(n).match(req); if (r) return r; }
      return undefined;
    },
  };
  const self = {
    addEventListener: (t: string, h: Handler) => { handlers[t] = h; },
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
    location: { origin: "https://app.test" },
  };
  const fakeFetch = async (r: Request | string) => {
    fetched.push(keyOf(r));
    return new Response("net", { status: 200 });
  };
  const ctx = vm.createContext({ self, caches, fetch: fakeFetch, Response, Request, URL, Promise, console });
  vm.runInContext(readFileSync(pub("sw.js"), "utf8"), ctx);
  return { handlers, puts, fetched };
}

async function install(handlers: Record<string, Handler>) {
  const waits: Promise<unknown>[] = [];
  handlers.install({ waitUntil: (p: Promise<unknown>) => { waits.push(p); } });
  await Promise.all(waits);
}

async function dispatch(
  handlers: Record<string, Handler>,
  url: string,
  opts: { mode?: string; method?: string; destination?: string } = {},
): Promise<boolean> {
  const req = new Request(url, { method: opts.method ?? "GET" });
  Object.defineProperty(req, "mode", { value: opts.mode ?? "cors" });
  Object.defineProperty(req, "destination", { value: opts.destination ?? "" });
  let responded: Promise<Response> | undefined;
  const waits: Promise<unknown>[] = [];
  handlers.fetch({
    request: req,
    respondWith: (p: Promise<Response>) => { responded = Promise.resolve(p); },
    waitUntil: (p: Promise<unknown>) => { waits.push(p); },
  });
  if (responded) await responded;
  await Promise.all(waits);
  return responded !== undefined;
}

test("service worker never intercepts, fetches or caches /api/ requests", async () => {
  const sw = loadSw();
  await install(sw.handlers);
  for (const path of ["/api/emails", "/api/emails?account=a", "/api/status", "/api/health", "/api/emails/1/feedback"]) {
    for (const opts of [{}, { mode: "navigate" }, { destination: "script" }, { destination: "image" }]) {
      const intercepted = await dispatch(sw.handlers, `https://app.test${path}`, opts);
      assert.equal(intercepted, false, `${path} ${JSON.stringify(opts)} must pass through`);
    }
  }
  assert.deepEqual(sw.puts.filter((u) => u.includes("/api/")), []);
  assert.deepEqual(sw.fetched.filter((u) => u.includes("/api/")), []);
});

test("service worker ignores non-GET and cross-origin requests", async () => {
  const sw = loadSw();
  await install(sw.handlers);
  assert.equal(await dispatch(sw.handlers, "https://app.test/", { method: "POST", mode: "navigate" }), false);
  assert.equal(await dispatch(sw.handlers, "https://other.test/x.js", { destination: "script" }), false);
});

test("service worker handles navigations and static assets and caches only the shell", async () => {
  const sw = loadSw();
  await install(sw.handlers);
  assert.equal(await dispatch(sw.handlers, "https://app.test/", { mode: "navigate" }), true);
  assert.equal(await dispatch(sw.handlers, "https://app.test/icon-192.png", { destination: "image" }), true);
  assert.equal(await dispatch(sw.handlers, "https://app.test/assets/app.js", { destination: "script" }), true);
  assert.ok(sw.puts.some((u) => u.endsWith("/icon-192.png")), "icon cached");
  assert.ok(sw.puts.some((u) => u === "https://app.test/"), "shell cached");
  for (const u of sw.puts) assert.ok(!u.includes("/api/"), u);
});
