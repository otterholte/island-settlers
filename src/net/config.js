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
 * SET THIS AFTER DEPLOYING.
 *
 * Fly gives the app a name and an https hostname; the websocket address is
 * that hostname with wss:// and /ws on the end. For an app called
 * `island-settlers` that is:
 *
 *   export const DEFAULT_SERVER = 'wss://island-settlers.fly.dev/ws';
 *
 * Left empty, the game falls back to this page's own origin, and the friends
 * screen offers a box to type an address into if that does not answer.
 */
export const DEFAULT_SERVER = '';

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

export function serverUrl() {
  return fromQuery()
    || normalizeServer(savedServer())
    || normalizeServer(DEFAULT_SERVER)
    || fromOrigin();
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

/** True when nobody has told us where the server is and there is no sensible
 *  guess — the friends screen shows its address box on this. */
export function serverUnknown() {
  return !serverUrl();
}

export default { DEFAULT_SERVER, serverUrl, savedServer, setServer, normalizeServer, serverUnknown };
