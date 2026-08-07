/**
 * Island Settlers — server entry point.
 *
 *   node server/index.mjs            # port 8787
 *   PORT=3000 STATIC=1 node server/index.mjs
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
 * AND NO DISK. Rooms are five-character codes and a player is a device id and
 * a name their own browser remembers, so there is nothing here that should
 * outlive the process: a server that is not running holds no lobbies and no
 * matches for a persisted account to reattach to. That deleted the accounts
 * file, the volume it had to live on, the boot-time write probe that proved
 * the volume was writable, the root-then-drop-privileges dance that made it
 * writable, and the session secret whose absence silently signed everybody out
 * on every redeploy. None of it is missed.
 *
 * Owner: net agent.
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { attachWebSocket } from './wsock.mjs';
import { createPlayers } from './players.mjs';
import { createRooms } from './rooms.mjs';
import { createMatchHost } from './matchhost.mjs';
import { createHub } from './hub.mjs';
import { PROTOCOL_VERSION, HEARTBEAT_MS, DEAD_MS } from '../src/net/protocol.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const SERVE_STATIC = process.env.STATIC === '1';
const started = Date.now();

const players = createPlayers();
const rooms = createRooms();

const matches = createMatchHost({
  onMessage: (matchId, msg) => hub.fromMatch(matchId, msg),
  onExit: (matchId, reason) => hub.matchGone(matchId, reason)
});

const hub = createHub({ players, rooms, matches });

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
  '.webmanifest': 'application/manifest+json; charset=utf-8',
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
      /*
       * WHICH BUILD IS THIS?
       *
       *   "Can you fix it for me so if it doesn't already, Railway auto deploys
       *    when you commit changes."
       *
       * It already did. What was missing was any way to KNOW that: every time
       * the server changed, the answer to "has production got it yet" was an
       * inference from an uptime counter, and an uptime counter cannot tell a
       * fresh deploy of the right commit from a fresh restart of the wrong one.
       * That is how a redeploy ends up on somebody's to-do list for three
       * commits in a row.
       *
       * Railway injects these at build time from the GitHub connection, so they
       * are the platform's own record of what it checked out rather than
       * anything this repo asserts about itself. Absent locally and absent under
       * a plain `docker run`, which is the honest answer there — hence `null`
       * rather than a fake.
       */
      commit: (process.env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 7) || null,
      branch: process.env.RAILWAY_GIT_BRANCH || null,
      deployedAt: process.env.RAILWAY_DEPLOYMENT_ID ? new Date(started).toISOString() : null,
      uptimeSec: Math.round((Date.now() - started) / 1000),
      ...hub.stats,
      matchCap: matches.max,
      /* Nothing is stored, so there is nothing to report about a disk. What is
         worth reporting is the live shape of the server: how many people are
         connected and how many lobbies are open. */
      openRooms: rooms.all().filter(r => r.state === 'lobby').length,
      static: SERVE_STATIC
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
  console.log('[server] rooms      five-character codes, nothing stored on disk');
  console.log(`[server] matches    up to ${matches.max} at once`);
  if (SERVE_STATIC) console.log(`[server] static     serving the game from ${ROOT}`);
});

/* =============================================================== shutdown
   The platform sends SIGTERM and then waits. Stop the match workers first so
   they are not killed mid-frame, then close. There is no longer anything to
   flush: the only durable thing in this game is the name in each player's own
   localStorage, which is on their machine and not ours. */
let closing = false;
function shutdown(sig) {
  if (closing) return;
  closing = true;
  console.log(`[server] ${sig} — shutting down`);
  try { matches.shutdown(); } catch (e) { /* going anyway */ }
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
