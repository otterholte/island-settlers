/**
 * Island Settlers — where the multiplayer server lives.
 *
 * The game itself is a static site and can be opened from anywhere: GitHub
 * Pages, a file on a laptop, a phone on the same wifi. The server is a
 * separate thing in a separate place, so the address cannot be inferred and
 * has to come from somewhere. In order of precedence:
 *
 *   1. ?server=wss://host/ws        in the URL — for testing a branch
 *   2. what the player typed        stored in localStorage, set from the
 *                                   friends screen when the default fails
 *   3. DEFAULT_SERVER below         edit this once after deploying
 *   4. this page's own origin       which is right whenever the server is
 *                                   serving the game too (STATIC=1)
 *
 * The fourth case is what makes `STATIC=1 node server/index.mjs` work with no
 * configuration at all, which is how you should try this locally.
 *
 * Owner: net agent.
 */

/**
 * THE LIVE SERVER.
 *
 * The websocket address is the deployment's https hostname with `wss://` in
 * front and `/ws` on the end. Change this line if the server ever moves; the
 * friends screen also has a box to type an address into, which overrides it
 * per browser and is how you would point one tab at a test deployment without
 * touching the build.
 *
 * Left empty, the game falls back to this page's own origin — which is what
 * makes `STATIC=1 node server/index.mjs` work locally with no configuration.
 * That fallback is still live for a page served from the server itself; this
 * constant only matters for the copy on GitHub Pages, which has no idea where
 * its multiplayer lives.
 */
export const DEFAULT_SERVER = 'wss://island-settlers-production.up.railway.app/ws';

const STORE_KEY = 'island-settlers.server';

function store() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch (e) {
    // Safari in private mode throws on the property access itself.
    return null;
  }
}

/** Turn anything a person might type into a websocket URL, or null. */
export function normalizeServer(input) {
  let s = String(input == null ? '' : input).trim();
  if (!s) return null;
  // `example.fly.dev` is what somebody will paste. Assume the secure scheme,
  // because every host that is not localhost needs it and a browser on an
  // https page refuses a plain ws:// socket anyway.
  if (!/^[a-z]+:\/\//i.test(s)) {
    const local = /^(localhost|127\.0\.0\.1|\[?::1\]?)(:|$)/i.test(s);
    s = (local ? 'ws://' : 'wss://') + s;
  }
  s = s.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
  let url;
  try {
    url = new URL(s);
  } catch (e) {
    return null;
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return null;
  if (url.pathname === '/' || url.pathname === '') url.pathname = '/ws';
  url.search = '';
  url.hash = '';
  return url.toString();
}

function fromQuery() {
  try {
    if (typeof location === 'undefined') return null;
    const q = new URLSearchParams(location.search).get('server');
    return q ? normalizeServer(q) : null;
  } catch (e) {
    return null;
  }
}

function fromOrigin() {
  try {
    if (typeof location === 'undefined' || !location.host) return null;
    // A file:// page has no host to fall back to, which is the one case where
    // the player has to be asked.
    const secure = location.protocol === 'https:';
    return `${secure ? 'wss' : 'ws'}://${location.host}/ws`;
  } catch (e) {
    return null;
  }
}

/** Is this page being served from a machine on the desk or on the wifi? */
function servedLocally() {
  try {
    if (typeof location === 'undefined') return false;
    return /^(localhost|127\.|\[?::1\]?|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i
      .test(location.hostname) || /\.local$/i.test(location.hostname);
  } catch (e) {
    return false;
  }
}

/**
 * EVERY address worth trying, best first.
 *
 * A list rather than a single answer, because the single answer was wrong in
 * both directions. Preferring the deployed server broke local development —
 * `STATIC=1 node server/index.mjs` would serve you the game and then send you
 * to production to play it, so no server change could be tried before it was
 * deployed. Preferring the page's own origin broke every other local setup:
 * open the game from a plain static server, or a dev server on another port,
 * and the origin has no websocket on it, so the friends screen asked the
 * player to go and find out their server's address. Nobody should ever be
 * asked that.
 *
 * So the client tries them in turn and keeps the one that answers. Local
 * origins come first when the page is local, because that is the case where
 * the origin genuinely is the server; the deployment is right behind it as the
 * fallback that makes the question unnecessary.
 */
export function serverCandidates() {
  const out = [];
  const push = u => { const n = normalizeServer(u); if (n && !out.includes(n)) out.push(n); };
  push(fromQuery());          // an explicit ?server= always wins
  push(savedServer());        // then whatever this browser was told to use
  if (servedLocally()) {
    push(fromOrigin());       // the page came off this machine; the server may be here
    push(DEFAULT_SERVER);
  } else {
    push(DEFAULT_SERVER);
    push(fromOrigin());       // and the origin, in case the server serves the game
  }
  return out;
}

/** The one to try first. Kept for callers that only want an address to show. */
export function serverUrl() {
  return serverCandidates()[0] || null;
}

export function savedServer() {
  const s = store();
  try { return (s && s.getItem(STORE_KEY)) || ''; } catch (e) { return ''; }
}

export function setServer(input) {
  const url = normalizeServer(input);
  const s = store();
  try {
    if (!url) { s && s.removeItem(STORE_KEY); return null; }
    s && s.setItem(STORE_KEY, url);
  } catch (e) { /* nothing to store into; the session still works */ }
  return url;
}

/** True when there is nowhere at all to try — a page opened from a file://
 *  with no DEFAULT_SERVER compiled in. Only then is the address box the first
 *  thing anybody sees. */
export function serverUnknown() {
  return serverCandidates().length === 0;
}

export default {
  DEFAULT_SERVER, serverUrl, serverCandidates, savedServer, setServer,
  normalizeServer, serverUnknown
};
