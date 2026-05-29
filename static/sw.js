// Service worker — caches the app shell so the UI loads instantly and works
// offline (the WebSocket of course still needs network). Updates on every
// /sw.js change because we re-fetch index.html on activate.

const CACHE = 'agentphone-shell-v51';

const SHELL = [
  './',
  './index.html',
  './app.js',
  './style.css',
  './manifest.webmanifest',
  './icon.svg',
  // Vendored render-critical libs (UX-BACKLOG #3) — precache so markdown,
  // code highlight, and QR onboarding work offline + inside the bundled APK.
  './vendor/marked.min.js',
  './vendor/highlight.min.js',
  './vendor/highlight-atom-one-dark.min.css',
  './vendor/jsQR.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Web Push handler ─────────────────────────────────────────
// Server's push.ts sends a JSON body { title, body, tag, url, sessionId }.
// We show a native OS notification; on click we focus an existing PWA
// window or open /launch in a new one. The sessionId is appended as a
// query param so the client can auto-select it post-focus.
self.addEventListener('push', (event) => {
  let payload = { title: 'agentphone', body: '', tag: undefined, url: '/launch', sessionId: undefined };
  if (event.data) {
    try { payload = { ...payload, ...event.data.json() }; }
    catch { payload.body = event.data.text(); }
  }
  const options = {
    body: payload.body,
    tag: payload.tag,
    icon: './icon.svg',
    badge: './icon.svg',
    data: { url: payload.url, sessionId: payload.sessionId },
    requireInteraction: false,
    silent: false,
  };
  event.waitUntil(self.registration.showNotification(payload.title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  let target = data.url || '/launch';
  if (data.sessionId) {
    target += (target.includes('?') ? '&' : '?') + 'session=' + encodeURIComponent(data.sessionId);
  }
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Try to focus an existing window first.
    for (const c of all) {
      try {
        await c.focus();
        c.postMessage({ kind: 'push-click', sessionId: data.sessionId });
        return;
      } catch { /* fall through */ }
    }
    await self.clients.openWindow(target);
  })());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never intercept WS, API, or /launch (the latter is a 302 redirect we
  // want to hit the server every time so the token stays fresh).
  if (url.pathname.startsWith('/ws') || url.pathname.startsWith('/api/') ||
      url.pathname === '/launch') return;

  // Static GET: network-first with cache fallback for shell pages; cache-first
  // for everything else so cold loads are fast.
  if (event.request.method !== 'GET') return;

  const isShell = SHELL.some((p) => url.pathname.endsWith(p.replace('./', '')) || url.pathname === '/');

  if (isShell) {
    event.respondWith(
      fetch(event.request)
        .then((resp) => {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy)).catch(() => {});
          return resp;
        })
        .catch(() => caches.match(event.request).then((m) => m || caches.match('./index.html')))
    );
  } else {
    event.respondWith(
      caches.match(event.request).then(
        (m) => m || fetch(event.request).then((resp) => {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy)).catch(() => {});
          return resp;
        })
      )
    );
  }
});
