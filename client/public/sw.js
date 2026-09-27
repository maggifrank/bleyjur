/* Bleyjur service worker (hand-written, no build step).
 *
 * - /api/*            never cached, always network.
 * - /assets/*         hashed build output: cache-first.
 * - navigations and /index.html: network-first, falling back to the cached shell.
 * - other static files (icons, manifest): stale-while-revalidate.
 *
 * On install the shell and every asset referenced by index.html are precached,
 * so the app loads offline right after the first visit.
 */
const CACHE = 'bleyjur-shell-v1';
const STATIC = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
  '/favicon-32.png',
  '/favicon.ico',
];

function assetUrls(html) {
  const urls = new Set();
  const re = /(?:src|href)="(\/assets\/[^"]+)"/g;
  let m;
  while ((m = re.exec(html))) urls.add(m[1]);
  return [...urls];
}

/** Store a fresh index.html and make sure its assets are cached; drop stale assets. */
async function cacheShell(cache, response) {
  const html = await response.clone().text();
  await cache.put('/index.html', response.clone());
  await cache.put('/', response.clone());
  const wanted = assetUrls(html);
  await Promise.all(
    wanted.map(async (url) => {
      if (!(await cache.match(url))) {
        try {
          const r = await fetch(url);
          if (r.ok) await cache.put(url, r);
        } catch {
          /* offline: will be cached on first use */
        }
      }
    }),
  );
  const keys = await cache.keys();
  await Promise.all(
    keys
      .filter((req) => {
        const path = new URL(req.url).pathname;
        return path.startsWith('/assets/') && !wanted.includes(path);
      })
      .map((req) => cache.delete(req)),
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await Promise.all(
        STATIC.filter((u) => u !== '/' && u !== '/index.html').map((u) =>
          cache.add(u).catch(() => undefined),
        ),
      );
      const res = await fetch('/index.html', { cache: 'no-store' });
      if (res.ok) await cacheShell(cache, res);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // never cache API

  if (req.mode === 'navigate' || url.pathname === '/index.html') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        try {
          const res = await fetch(req.mode === 'navigate' ? '/index.html' : req, { cache: 'no-store' });
          if (res.ok) event.waitUntil(cacheShell(cache, res.clone()));
          return res;
        } catch {
          return (
            (await cache.match('/index.html')) ||
            (await cache.match('/')) ||
            new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } })
          );
        }
      })(),
    );
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) await cache.put(req, res.clone());
        return res;
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req);
      const refresh = fetch(req)
        .then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => undefined);
      if (hit) {
        event.waitUntil(refresh);
        return hit;
      }
      return (await refresh) || new Response('', { status: 504 });
    })(),
  );
});
