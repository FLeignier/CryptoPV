// Offline cache for the app shell. CoinGecko requests are never cached here (the app stores prices itself).
const VERSION = 'cryptopv-v2';
const SHELL = ['./', 'index.html', 'core.js', 'app.js', 'manifest.webmanifest', 'vendor/xlsx.full.min.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-512-maskable.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return; // API calls go straight to network
  // Cache first, then refresh the cache in the background when online
  e.respondWith(caches.open(VERSION).then((cache) => cache.match(e.request, { ignoreSearch: true }).then((hit) => {
    const net = fetch(e.request).then((res) => { if (res.ok) cache.put(e.request, res.clone()); return res; }).catch(() => hit);
    return hit || net;
  })));
});
