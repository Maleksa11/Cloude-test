'use strict';

// The service worker caches the app shell only, so the app can open offline.
// It never touches /api/*, search results, video data or anything user-specific.
const CACHE_NAME = 'malek-tube-shell-v71';
const SHELL_FILES = ['./index.html', './app.js', './style.css', './manifest.webmanifest', './icon.svg'];
const SHELL_INDEX = new URL('./index.html', self.location.href).href;
// Only these navigations are the app shell. Any other page (for example privacy.html)
// must never be stored as the shell, or going offline would open the wrong page.
const SHELL_PAGES = new Set([
  new URL('./', self.location.href).pathname,
  new URL('./index.html', self.location.href).pathname
]);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key.startsWith('malek-tube-') && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    const isShellPage = SHELL_PAGES.has(url.pathname);
    event.respondWith((async () => {
      try {
        const response = await fetch(request, { cache: 'no-store' });
        if (isShellPage && response.ok) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(SHELL_INDEX, response.clone());
        }
        return response;
      } catch {
        return isShellPage ? ((await caches.match(SHELL_INDEX)) || Response.error()) : Response.error();
      }
    })());
    return;
  }

  const isShellFile = SHELL_FILES.some((path) =>
    new URL(path, self.location.href).pathname === url.pathname
  );
  if (isShellFile) {
    // Network first, so a new release is never hidden behind an old copy; the cache is
    // only the offline fallback. Page requests carry a ?v= suffix that the stored copies
    // do not, so the cache key is the bare path.
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const key = url.origin + url.pathname;
      try {
        const fresh = await fetch(request, { cache: 'no-store' });
        if (fresh.ok) await cache.put(key, fresh.clone());
        return fresh;
      } catch {
        return (await cache.match(key)) || Response.error();
      }
    })());
  }
});
