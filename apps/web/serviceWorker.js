// Mise's service worker: keeps the app shell so Mise opens without a connection, and shows the
// household's notifications. The data comes over the WebSocket, which a service worker can't see, so
// the page keeps that itself (src/offline.ts).
// The build fills in SHELL (every file it emitted) and VERSION (a hash of them).

const SHELL = self.__SHELL__;
const CACHE = `mise-shell-${self.__VERSION__}`;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      // The page that is open already loaded its files, so the new shell can take over at once.
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  // The household's routes (tools, photos, uploads) always go to the network.
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/agents/")) return;

  if (request.mode === "navigate") {
    // The network first, so a deploy shows at once and an expired Access session still goes to sign-in;
    // the cached shell only when there is no connection. Every page is the one single-page app.
    event.respondWith(
      fetch(request).catch(() => caches.match("/", { cacheName: CACHE }).then((cached) => cached ?? Response.error())),
    );
    return;
  }
  if (SHELL.includes(url.pathname)) {
    event.respondWith(caches.match(request, { cacheName: CACHE }).then((cached) => cached ?? fetch(request)));
  }
});

// A notification from the household (apps/worker/src/push.ts): `{ kind, title, body, url }`. One of a
// kind replaces the last still showing. Safari stops sending to a page that shows nothing, so one always shows.
self.addEventListener("push", (event) => {
  let message = {};
  try {
    message = event.data?.json() ?? {};
  } catch {}
  event.waitUntil(
    self.registration.showNotification(message.title ?? "Mise", {
      body: message.body ?? "",
      tag: message.kind,
      renotify: Boolean(message.kind),
      icon: "/icons/icon-192.png",
      data: { url: typeof message.url === "string" && message.url.startsWith("/") ? message.url : "/" },
    }),
  );
});

// A tap opens the page the notification links to: in the Mise window this worker controls, if one is
// open, else in a new one. Anything that keeps it from moving that window opens a new one instead.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url ?? "/", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then(async (windows) => {
      const open = windows.find((client) => new URL(client.url).origin === self.location.origin);
      try {
        const moved = open && (await (await open.focus())?.navigate(url));
        if (moved) return moved;
      } catch {}
      return self.clients.openWindow(url);
    }),
  );
});
