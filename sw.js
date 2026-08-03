/**
 * Island Settlers — service worker.
 *
 * The one job here is to make the game installable and survivable: an app on a
 * homescreen that shows a browser error page the first time a train goes into a
 * tunnel is not an app, it is a bookmark with delusions.
 *
 * NETWORK FIRST, ALWAYS.
 *
 * The usual advice for a game is cache-first — it is faster and the assets are
 * static. It is the wrong trade for THIS game. There is no build step, no
 * bundler and no content hashing in any filename: `src/main.js` is served under
 * that name forever. A cache-first worker would therefore pin whatever version
 * of the game a player first opened, permanently, and every fix pushed after
 * that would land on a device that never asks for it again. So the network is
 * always tried first and the cache only ever answers when the network cannot —
 * which costs nothing on a normal load and turns "no signal" into "the last
 * version you played" instead of a dinosaur.
 *
 * SCOPE. Only same-origin GETs are touched. The multiplayer server lives on
 * another origin entirely and its websocket never reaches a fetch handler, but
 * the origin check is what makes that a guarantee rather than a coincidence.
 *
 * VERSION. Bump CACHE to evict everything; the activate handler deletes every
 * cache that is not the current one.
 */

const CACHE = 'island-settlers-v1';

/* The shell: enough to boot the opening screen with no network at all. The
   rest of the module graph is added as it is fetched, because listing ~60 file
   paths here by hand is a list that goes stale the first time a module is
   renamed and then fails the whole install. */
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './src/ui/ui.css',
  './src/main.js',
  './vendor/three.module.js',
  './icons/icon-192.png'
];

self.addEventListener('install', ev => {
  ev.waitUntil(
    caches.open(CACHE)
      // Individually, so one 404 cannot fail the whole install.
      .then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', ev => {
  ev.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(k => (k === CACHE ? null : caches.delete(k)))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', ev => {
  if (ev && ev.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', ev => {
  const req = ev.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;

  ev.respondWith(
    fetch(req)
      .then(res => {
        // Opaque and error responses are not worth keeping; a 200 is.
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => null);
        }
        return res;
      })
      .catch(() => caches.match(req).then(hit => hit || (
        // A navigation with nothing cached for that exact URL still wants the
        // shell rather than a browser error.
        req.mode === 'navigate' ? caches.match('./index.html') : undefined
      )))
  );
});
