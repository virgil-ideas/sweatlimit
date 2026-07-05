/* Service worker for the app shell.
 * Our own files are served NETWORK-FIRST (fall back to cache offline) so a
 * deploy is always picked up whole — a fresh HTML page can never end up paired
 * with a stale cached script. Third-party assets (fonts, map tiles) stay
 * cache-first since they rarely change and benefit from instant loads. */
const CACHE = 'can-i-sweat-v28';
const SHELL = [
  './',
  'index.html',
  'thermometer.css',
  'thermometer.js',
  'core.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'vendor/leaflet/leaflet.js',
  'vendor/leaflet/leaflet.css',
  'poster/',
  'poster/index.html',
  'poster/poster.css',
  'poster/poster.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // Never cache live weather/geocode API calls — always go to network.
  if (url.hostname.endsWith('open-meteo.com')) {
    event.respondWith(fetch(request).catch(() => new Response('', { status: 503 })));
    return;
  }

  // Our own files: network-first, refreshing the cache on every successful
  // fetch; fall back to the cached copy only when offline.
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(request, copy));
          }
          return res;
        })
        .catch(() => caches.match(request).then((c) => c || caches.match('./')))
    );
    return;
  }

  // Third-party assets (fonts, map tiles): cache-first, populate on first fetch.
  event.respondWith(
    caches.match(request).then((cached) =>
      cached ||
      fetch(request).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return res;
      })
    )
  );
});
