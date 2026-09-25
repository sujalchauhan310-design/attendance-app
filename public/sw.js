// Minimal service worker: caches the app shell (the page itself, styles, icon)
// so the form still loads even with no signal. It deliberately never caches
// /api/ requests — those always need to reach the real server, since that's
// where attendance is actually validated and saved.

const CACHE_NAME = 'attendance-shell-v3';
const SHELL_FILES = ['student.html', 'teacher.html', 'style.css', 'icon.svg', 'manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never cache API calls — attendance must always go to the live server.
  if (url.pathname.startsWith('/api/')) return;

  // Only GET requests can be cached (POST etc. would make cache.put throw).
  if (event.request.method !== 'GET') return;

  // For the app shell files: try the network first (so updates show up),
  // fall back to the cached copy if there's no connection.
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        // Only cache good responses — never save a 404/500 page as the offline copy.
        if (res && res.ok) {
          const resClone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, resClone)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
