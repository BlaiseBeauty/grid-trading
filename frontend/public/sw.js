// GRID service worker.
// Bump CACHE_VERSION when the caching strategy changes; old caches are deleted on activate.
// (Built asset filenames are content-hashed by Vite, so they never go stale inside a version.)
const CACHE_VERSION = 'v2';
const SHELL_CACHE = `grid-shell-${CACHE_VERSION}`;
const ASSET_CACHE = `grid-assets-${CACHE_VERSION}`;
const MAX_ASSET_ENTRIES = 80;

// No skipWaiting() on install: a new worker waits until the page asks for it (SKIP_WAITING message,
// sent from the "New version - Reload" toast) so users are never switched mid-session.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.add('/'))
      .catch((err) => console.warn('[SW] shell precache failed:', err && err.message))
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('activate', (event) => {
  const keep = new Set([SHELL_CACHE, ASSET_CACHE]);
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !keep.has(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Oldest-first eviction (Cache.keys() returns entries in insertion order)
async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  const excess = keys.length - maxEntries;
  for (let i = 0; i < excess; i += 1) {
    await cache.delete(keys[i]);
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only GET, only same-origin. Never touch POST/PUT/DELETE, cross-origin, /api or /ws.
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/api' || url.pathname.startsWith('/ws')) return;

  // Navigation / index.html: network-first so a deploy is picked up immediately; cached shell when offline
  if (request.mode === 'navigate' || url.pathname === '/index.html') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(SHELL_CACHE).then((cache) => cache.put('/', copy));
          }
          return response;
        })
        .catch(() => caches.match('/').then((cached) => cached || Response.error()))
    );
    return;
  }

  // Hashed build assets: cache-first (immutable by filename)
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(ASSET_CACHE)
              .then((cache) => cache.put(request, copy))
              .then(() => trimCache(ASSET_CACHE, MAX_ASSET_ENTRIES));
          }
          return response;
        });
      })
    );
  }
  // Everything else (icons, manifest, ...) goes straight to the network
});
