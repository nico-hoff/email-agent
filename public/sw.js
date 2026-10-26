// App-shell service worker. It only handles same-origin GET requests for the
// navigation document and static assets. /api/ is never intercepted, fetched
// or cached here, so mail metadata stays out of every browser cache.
//
// The shell "/" must never render mail data on the server: it is the only
// navigation response that gets cached. Data reaches the page only through
// /api/ calls made by the client. Every other navigation (e.g. /emails/:id)
// is network-only; if the network fails, the cached "/" shell is served.
const CACHE = "shell-v2";
const SHELL = [
  "/",
  "/manifest.webmanifest",
  "/favicon.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-512.png",
  "/apple-touch-icon.png",
];
const STATIC_DESTINATIONS = ["style", "script", "font", "image"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

function cacheable(res) {
  if (!res.ok) return false;
  const cc = (res.headers.get("cache-control") || "").toLowerCase();
  return !cc.includes("no-store");
}

async function navigate(request) {
  const isShell = new URL(request.url).pathname === "/";
  try {
    const res = await fetch(request);
    if (isShell && cacheable(res)) {
      const cache = await caches.open(CACHE);
      await cache.put(request, res.clone());
    }
    return res;
  } catch (err) {
    const cache = await caches.open(CACHE);
    const shell = await cache.match("/");
    if (shell) return shell;
    throw err;
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  const refresh = fetch(request)
    .then((res) => {
      if (cacheable(res)) return cache.put(request, res.clone()).then(() => res);
      return res;
    })
    .catch((err) => {
      if (hit) return hit;
      throw err;
    });
  return hit || refresh;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(navigate(request));
    return;
  }
  if (STATIC_DESTINATIONS.includes(request.destination) || SHELL.includes(url.pathname)) {
    event.respondWith(staleWhileRevalidate(request));
  }
});
