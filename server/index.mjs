/**
 * Island Settlers — server entry point.
 *
 *   node server/index.mjs            # port 8787, data in ./server/data
 *   PORT=3000 DATA=/data node server/index.mjs
 *
 * Serves three things:
 *   /ws        the websocket every client lives on
 *   /health    a JSON heartbeat, for Fly's checks and for looking at
 *   /          the game itself, if STATIC=1 — handy for running the whole
 *              thing on one machine; off by default because in production the
 *              game is on GitHub Pages and this box only does multiplayer.
 *
 * NO DEPENDENCIES. `node:http`, `node:crypto`, `node:fs`, `node:worker_threads`
 * and nothing else. Clone the repo, run the command, it works.
 *
 * Owner: net agent.
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { attachWebSocket } from './wsock.mjs';
import { openStore } from './store.mjs';
import { createUsers } from './users.mjs';
import { createRooms } from './rooms.mjs';
import { createMatchHost } from './matchhost.mjs';
import { createHub } from './hub.mjs';
import { sessionSecret } from './auth.mjs';
import { PROTOCOL_VERSION, HEARTBEAT_MS, DEAD_MS } from '../src/net/protocol.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const SERVE_STATIC = process.env.STATIC === '1';
const started = Date.now();

/**
 * Where the accounts live, and the one setting that silently ruins everything
 * if it is wrong.
 *
 * The store is a file. If it is written somewhere that is not the mounted
 * volume, it works perfectly — right up until the next deploy, when the
 * container is replaced and every account, every friendship and every session
 * goes with it. Nothing errors. Nobody finds out until somebody cannot sign in.
 *
 * So the volume is found rather than assumed. Railway publishes
 * RAILWAY_VOLUME_MOUNT_PATH at runtime whatever path you picked in the
 * dashboard, so honouring it means the mount cannot be mismatched by typing
 * `/data` in one place and `/app/data` in another. An explicit DATA still wins
 * — that is how fly.toml pins it — and a laptop with neither falls back to a
 * folder next to this file.
 *
 * `/health` reports which of the three it used and whether that path is on a
 * volume, because "are my accounts actually safe" should be answerable without
 * a redeploy to find out.
 */
const VOLUME = process.env.RAILWAY_VOLUME_MOUNT_PATH || '';
const DATA_SOURCE = process.env.DATA ? 'DATA'
  : VOLUME ? 'RAILWAY_VOLUME_MOUNT_PATH'
    : 'default';
const DATA = resolve(process.env.DATA || VOLUME || join(HERE, 'data'));
/** True when the data directory is inside a mount that survives a deploy. */
const DATA_PERSISTS = DATA_SOURCE !== 'default'
  && (!VOLUME || DATA === resolve(VOLUME) || DATA.startsWith(resolve(VOLUME) + '/'));

const store = openStore(join(DATA, 'island.json'));

/* Write once, at boot, before anybody has an account to lose.
 *
 * A volume that is mounted but not writable by the container user is a real
 * and common way to deploy this — and without this line the first anybody
 * would know is somebody signing up successfully and then not existing. The
 * store logs a failure here loudly, at boot, next to the path it tried, and
 * `/health` reports `writes: 0` forever after, which is the tell. */
if (!store.stats.loaded) store.flush();

const users = createUsers(store);
const rooms = createRooms();
const secret = sessionSecret();

const matches = createMatchHost({
  onMessage: (matchId, msg) => hub.fromMatch(matchId, msg),
  onExit: (matchId, reason) => hub.matchGone(matchId, reason)
});

const hub = createHub({ users, rooms, matches, secret });

/* ============================================================ static files
   Only on when STATIC=1. The path handling is the boring-but-correct kind:
   normalise, then refuse anything that still escapes the root. A game server
   that will hand out /etc/passwd because somebody typed ../.. is a bad game
   server even when it is only ever run on a laptop. */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

async function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === '/' || rel === '') rel = '/index.html';
  const full = resolve(ROOT, '.' + normalize(rel));
  if (!full.startsWith(ROOT)) return send(res, 403, 'text/plain', 'No');
  let info;
  try {
    info = await stat(full);
  } catch (e) {
    return send(res, 404, 'text/plain', 'Not found');
  }
  if (info.isDirectory()) return serveStatic(req, res, rel.replace(/\/*$/, '/index.html'));
  const body = await readFile(full);
  send(res, 200, MIME[extname(full).toLowerCase()] || 'application/octet-stream', body, {
    // The game is a pile of small modules with no content hashing, so caching
    // it is how you end up debugging a version that no longer exists.
    'Cache-Control': 'no-cache'
  });
}

function send(res, code, type, body, extra = {}) {
  res.writeHead(code, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(body),
    ...extra
  });
  res.end(body);
}

function json(res, code, obj) {
  send(res, code, 'application/json; charset=utf-8', JSON.stringify(obj), {
    // The health endpoint is read cross-origin by the game's own "is the
    // server awake" check before a socket is opened.
    'Access-Control-Allow-Origin': '*'
  });
}

/* =================================================================== http */

const server = createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];

  if (url === '/health' || url === '/healthz') {
    return json(res, 200, {
      ok: true,
      protocol: PROTOCOL_VERSION,
      uptimeSec: Math.round((Date.now() - started) / 1000),
      ...hub.stats,
      matchCap: matches.max,
      store: {
        loaded: store.stats.loaded,
        writes: store.stats.writes,
        path: store.stats.path,
        from: DATA_SOURCE,
        // The answer to "will my accounts survive the next deploy". False on a
        // host with no volume attached, which is a warning and not an error —
        // it is exactly right on a laptop.
        persists: DATA_PERSISTS,
        volume: VOLUME || null
      }
    });
  }

  if (SERVE_STATIC) {
    serveStatic(req, res, url).catch(e => {
      console.error('[http]', e && e.message);
      send(res, 500, 'text/plain', 'Server error');
    });
    return;
  }

  json(res, 404, { ok: false, error: 'not found' });
});

attachWebSocket(server, {
  path: '/ws',
  heartbeatMs: HEARTBEAT_MS,
  deadMs: DEAD_MS,
  onConnection: peer => hub.attach(peer)
});

server.listen(PORT, HOST, () => {
  console.log(`[server] Island Settlers multiplayer on http://${HOST}:${PORT}`);
  console.log(`[server] websocket  ws://${HOST}:${PORT}/ws   protocol v${PROTOCOL_VERSION}`);
  console.log(`[server] data       ${store.stats.path}  (${users.count} accounts, via ${DATA_SOURCE})`);
  if (!DATA_PERSISTS) {
    console.warn('[server] WARNING  that path is not on a mounted volume — accounts will be');
    console.warn('[server]          lost on the next deploy. Attach one and either mount it');
    console.warn('[server]          where DATA points, or unset DATA and let the platform say.');
  }
  console.log(`[server] matches    up to ${matches.max} at once`);
  if (SERVE_STATIC) console.log(`[server] static     serving the game from ${ROOT}`);
});

/* =============================================================== shutdown
   Fly sends SIGTERM and then waits. Use the wait: stop the matches, flush the
   accounts to disk, THEN exit. Losing an in-progress match on a deploy is
   unavoidable; losing somebody's account because the write was still on a
   400ms debounce is not. */
let closing = false;
function shutdown(sig) {
  if (closing) return;
  closing = true;
  console.log(`[server] ${sig} — shutting down`);
  try { matches.shutdown(); } catch (e) { /* going anyway */ }
  try { store.flush(); } catch (e) { console.error('[server] final flush failed', e); }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref?.();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', e => {
  console.error('[server] uncaught:', e && e.stack ? e.stack : e);
  // Keep serving. One bad frame from one client must not end everybody's
  // evening; anything genuinely fatal will fail again immediately and loudly.
});
process.on('unhandledRejection', e => {
  console.error('[server] unhandled rejection:', e && e.stack ? e.stack : e);
});
