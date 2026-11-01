// App-shell service worker. It only handles same-origin GET requests for the
// navigation document and static assets. /api/ is never intercepted, fetched
// or cached here, so mail metadata stays out of every browser cache.
//
// The shell "/" must never render mail data on the server: it is the only
// navigation response that gets cached. Data reaches the page only through
// /api/ calls made by the client. Every other navigation (e.g. /emails/:id)
// is network-only; if the network fails, the cached "/" shell is served.
//
// Web Push (ADR 0036): the push payload is {"v":1,"kind":"important_mail"|"briefing_ready"|"test","count":n} and nothing
// else. The German text is built here from kind and count; a subject, sender or body is never part of a push. Every push
// shows a notification (browsers, iOS in particular, revoke the subscription of a worker that stays silent).
const CACHE = "shell-v4";
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

// ---- Web Push ----------------------------------------------------------------------------------------------------------
const KINDS = ["important_mail", "briefing_ready", "test"];

/** Notification text for a payload; any unknown or broken payload still yields a neutral notification. */
function notificationFor(data) {
  const kind = data && typeof data === "object" && KINDS.includes(data.kind) ? data.kind : "unknown";
  const n = data && Number.isInteger(data.count) && data.count > 0 ? Math.min(data.count, 99) : 1;
  const opts = { icon: "/icon-192.png", tag: kind, renotify: true, data: { url: "/" } };
  if (kind === "important_mail") {
    return { title: n === 1 ? "Eine wichtige Mail" : n + " wichtige Mails", options: { ...opts, body: "Öffne den E-Mail-Agent, um sie zu sehen." } };
  }
  if (kind === "briefing_ready") {
    return { title: "Dein Briefing ist bereit", options: { ...opts, body: n === 1 ? "Eine Mail ist offen." : n + " Mails sind offen." } };
  }
  if (kind === "test") {
    return { title: "Test-Benachrichtigung", options: { ...opts, body: "Push funktioniert auf diesem Gerät." } };
  }
  return { title: "E-Mail-Agent", options: { ...opts, body: "Es gibt etwas Neues." } };
}

self.addEventListener("push", (event) => {
  let data = null;
  try {
    data = event.data ? event.data.json() : null;
  } catch (err) {
    data = null;
  }
  const n = notificationFor(data);
  event.waitUntil(self.registration.showNotification(n.title, n.options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (new URL(client.url).origin === self.location.origin && "focus" in client) return client.focus();
      }
      return self.clients.openWindow("/");
    }),
  );
});
