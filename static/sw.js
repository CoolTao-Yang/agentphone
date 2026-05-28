// Service worker — caches the app shell so the UI loads instantly and works
// offline (the WebSocket of course still needs network). Updates on every
// /sw.js change because we re-fetch index.html on activate.

const CACHE = 'agentphone-shell-v21';

const SHELL = [
  './',
  './index.html',
  './app.js',
  './style.css',
  './manifest.webmanifest',
  './icon.svg',
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
