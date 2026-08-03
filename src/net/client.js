/**
 * Island Settlers — the connection.
 *
 *   createClient() -> { connect, close, req, fire, on, off, status, user, ... }
 *
 * One websocket, request/reply on top of it, automatic reconnection, and a
 * signed-in identity that survives all of that. Everything above this file —
 * the friends screen, the lobby, the match — talks in promises and events and
 * never learns that a socket dropped.
 *
 * THE SESSION IS THE TOKEN, AND IT LIVES HERE
 * -------------------------------------------
 * Sign in once and the server hands back a token; it goes in localStorage and
 * comes back out on the next visit. Reconnecting re-sends it before anything
 * else, so a dropped socket costs a round trip and not a password prompt. The
 * same idiom as `core/options.js` and `systems/difficulty.js`: a module
 * singleton with a listener set, guarded storage, and defaults that work when
 * there is no storage at all.
 *
 * RECONNECTION IS NOT OPTIONAL
 * ----------------------------
 * This is a phone game. Phones change network in the middle of a match, sleep
 * with the tab open, and come back expecting to still be playing. The server
 * holds a seat for a while precisely so that this file can walk back in. The
 * backoff is exponential with a ceiling and a jitter, because four players
 * reconnecting to a server that just restarted should not all arrive on the
 * same millisecond.
 *
 * Owner: net agent.
 */

import {
  PROTOCOL_VERSION, REQ, OK, ERR, E, errText, HEARTBEAT_MS
} from './protocol.js';
import { serverCandidates } from './config.js';

const TOKEN_KEY = 'island-settlers.token';
const NAME_KEY = 'island-settlers.name';

/** Reconnect delays, in ms. The last is repeated forever. */
const BACKOFF = [400, 900, 2000, 4000, 8000, 15000];
/** A request that gets no answer in this long has lost its socket. */
const REQ_TIMEOUT_MS = 15000;

function store() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch (e) {
    return null;
  }
}

function read(key) {
  const s = store();
  try { return (s && s.getItem(key)) || ''; } catch (e) { return ''; }
}

function write(key, value) {
  const s = store();
  try {
    if (value) s && s.setItem(key, value);
    else s && s.removeItem(key);
  } catch (e) { /* private mode; the session still works for this tab */ }
}

export function createClient() {
  let ws = null;
  let url = null;
  let status = 'offline';     // offline | dialling | open | ready | failed
  let user = null;
  let token = read(TOKEN_KEY);
  let attempt = 0;
  let retry = 0;
  let wantOpen = false;
  let lastError = null;
  /* Addresses still worth trying this round, and where we are in them. The
     list is rebuilt each time we run off the end, so a server that comes back
     later is found without a reload. */
  let candidates = [];
  let candidateAt = 0;
  let everConnected = false;

  let nextId = 1;
  const waiting = new Map();
  const listeners = new Map();   // type -> Set(fn)

  /* ------------------------------------------------------------- events */

  function on(type, fn) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
    return () => off(type, fn);
  }

  function off(type, fn) {
    const set = listeners.get(type);
    if (set) set.delete(fn);
  }

  function emit(type, payload) {
    const set = listeners.get(type);
    if (set) for (const fn of [...set]) {
      // One bad listener must not stop the others, and must never stop the
      // message pump — a thrown error here would drop the rest of a snapshot
      // batch on the floor.
      try { fn(payload); } catch (e) { console.warn('[net] listener', type, e); }
    }
    const any = listeners.get('*');
    if (any) for (const fn of [...any]) {
      try { fn(type, payload); } catch (e) { /* as above */ }
    }
  }

  function setStatus(next, err) {
    if (status === next && !err) return;
    status = next;
    lastError = err || (next === 'ready' || next === 'open' ? null : lastError);
    emit('status', { status, error: lastError, user });
  }

  /* ------------------------------------------------------------- socket */

  function connect(force) {
    wantOpen = true;
    if (ws && (ws.readyState === 0 || ws.readyState === 1) && !force) return;
    if (!candidates.length || candidateAt >= candidates.length) {
      candidates = serverCandidates();
      candidateAt = 0;
    }
    url = candidates[candidateAt] || null;
    if (!url) { setStatus('failed', 'no-server'); return; }
    if (typeof WebSocket !== 'function') { setStatus('failed', 'no-websocket'); return; }

    clearTimeout(retry);
    setStatus('dialling');
    try {
      ws = new WebSocket(url);
    } catch (e) {
      setStatus('failed', 'bad-address');
      scheduleRetry();
      return;
    }

    ws.onopen = async () => {
      attempt = 0;
      everConnected = true;
      // This one answered. Stop shopping — every later reconnect goes straight
      // back here rather than walking the list again.
      candidates = [url];
      candidateAt = 0;
      setStatus('open');
      try {
        // The version check is first and is fatal: a client that speaks a
        // different protocol should be told to reload, not be allowed to make
        // half-working requests until something confusing happens.
        await rawReq(REQ.HELLO, { version: PROTOCOL_VERSION });
      } catch (e) {
        setStatus('failed', e.code === E.VERSION ? 'stale-page' : 'handshake');
        close();
        return;
      }
      if (token) {
        try {
          const r = await rawReq(REQ.RESUME, { token });
          adoptSession(r);
        } catch (e) {
          // An expired or revoked token is not an error to shout about; it
          // just means the sign-in form.
          token = ''; write(TOKEN_KEY, '');
          user = null;
        }
      }
      setStatus('ready');
    };

    ws.onmessage = m => {
      let msg;
      try { msg = JSON.parse(m.data); } catch (e) { return; }
      if (!msg || typeof msg !== 'object') return;

      if (msg.i !== undefined && waiting.has(msg.i)) {
        const w = waiting.get(msg.i);
        waiting.delete(msg.i);
        clearTimeout(w.timer);
        if (msg.t === ERR) {
          const err = new Error(errText(msg.code));
          err.code = msg.code;
          err.detail = msg;
          w.no(err);
        } else {
          w.ok(msg);
        }
        return;
      }
      if (typeof msg.t === 'string') emit(msg.t, msg);
    };

    ws.onerror = () => { /* onclose always follows; nothing useful here */ };

    ws.onclose = () => {
      const wasReady = status === 'ready';
      ws = null;
      // Everything in flight is now unanswerable. Reject rather than leak the
      // promises, so a caller's `catch` runs instead of its spinner spinning.
      for (const [, w] of waiting) {
        clearTimeout(w.timer);
        const err = new Error('The connection dropped.');
        err.code = 'net.closed';
        w.no(err);
      }
      waiting.clear();
      if (!wantOpen) { setStatus('offline'); return; }
      /* Never reached this one. Try the next address before backing off — a
         page served from a laptop whose origin has no websocket on it should
         land on the deployed server in a few hundred milliseconds, not ask
         the player where their server is. */
      if (!everConnected && candidateAt + 1 < candidates.length) {
        candidateAt++;
        setStatus('dialling');
        setTimeout(() => connect(true), 60);
        return;
      }
      setStatus(wasReady ? 'dialling' : 'failed', wasReady ? null : lastError);
      scheduleRetry();
    };
  }

  function scheduleRetry() {
    if (!wantOpen) return;
    // A fresh sweep next time: something that was down may be up.
    candidateAt = 0;
    candidates = [];
    const base = BACKOFF[Math.min(attempt, BACKOFF.length - 1)];
    attempt++;
    // Jitter, so that four clients knocked off by the same server restart do
    // not all come back on the same millisecond and knock it off again.
    const wait = base + Math.random() * base * 0.4;
    clearTimeout(retry);
    retry = setTimeout(() => connect(true), wait);
  }

  function close() {
    wantOpen = false;
    clearTimeout(retry);
    if (ws) { try { ws.close(); } catch (e) { /* fine */ } }
    ws = null;
    setStatus('offline');
  }

  /* ----------------------------------------------------------- requests */

  function rawReq(t, body = {}) {
    return new Promise((ok, no) => {
      if (!ws || ws.readyState !== 1) {
        const err = new Error('Not connected.');
        err.code = 'net.closed';
        return no(err);
      }
      const i = nextId++;
      const timer = setTimeout(() => {
        waiting.delete(i);
        const err = new Error('The server did not answer.');
        err.code = 'net.timeout';
        no(err);
      }, REQ_TIMEOUT_MS);
      waiting.set(i, { ok, no, timer, t });
      try {
        ws.send(JSON.stringify({ i, t, ...body }));
      } catch (e) {
        waiting.delete(i);
        clearTimeout(timer);
        const err = new Error('Could not send.');
        err.code = 'net.send';
        no(err);
      }
    });
  }

  /** A request that waits for the connection instead of failing on a blip. */
  async function req(t, body = {}, waitMs = 6000) {
    if (!ws || ws.readyState !== 1) {
      const gotThere = await waitFor(() => !!ws && ws.readyState === 1, waitMs);
      if (!gotThere) {
        const err = new Error('Not connected.');
        err.code = 'net.closed';
        throw err;
      }
    }
    return rawReq(t, body);
  }

  /** Fire and forget — movement, which is worthless a frame late anyway. */
  function fire(t, body = {}) {
    if (!ws || ws.readyState !== 1) return false;
    try { ws.send(JSON.stringify({ t, ...body })); return true; } catch (e) { return false; }
  }

  function waitFor(test, ms) {
    return new Promise(done => {
      if (test()) return done(true);
      const started = Date.now();
      const tick = setInterval(() => {
        if (test()) { clearInterval(tick); done(true); }
        else if (Date.now() - started > ms) { clearInterval(tick); done(false); }
      }, 80);
    });
  }

  /* ------------------------------------------------------------ session */

  function adoptSession(r) {
    if (r && r.token) { token = r.token; write(TOKEN_KEY, token); }
    if (r && r.user) {
      user = r.user;
      write(NAME_KEY, user.name);
    }
    emit('session', { user, token });
    return user;
  }

  async function register(name, pass) {
    return adoptSession(await req(REQ.REGISTER, { name, pass }));
  }

  async function login(name, pass) {
    return adoptSession(await req(REQ.LOGIN, { name, pass }));
  }

  async function logout() {
    try { await req(REQ.LOGOUT, {}); } catch (e) { /* going anyway */ }
    token = ''; user = null;
    write(TOKEN_KEY, '');
    emit('session', { user: null, token: '' });
  }

  /* Round-trip time, sampled rather than continuous. Shown on the lobby so a
     player can see whether the server is close before blaming the game. */
  let ping = -1;
  let pinger = 0;
  async function measurePing() {
    if (status !== 'ready') return;
    const at = Date.now();
    try {
      await req(REQ.PING, { c: at }, 2000);
      ping = Date.now() - at;
      emit('ping', { ping });
    } catch (e) { ping = -1; }
  }
  pinger = setInterval(measurePing, Math.max(4000, HEARTBEAT_MS / 3));
  if (pinger && typeof pinger === 'object' && pinger.unref) pinger.unref();

  return {
    connect, close, req, fire, on, off,
    register, login, logout, measurePing,
    get status() { return status; },
    get user() { return user; },
    get token() { return token; },
    get lastName() { return read(NAME_KEY); },
    get error() { return lastError; },
    get url() { return url; },
    get ping() { return ping; },
    get signedIn() { return !!user; },
    /** Forget the saved token without telling the server — used when the
     *  address changes, since a token from one server means nothing to another. */
    forget() {
      token = ''; user = null;
      write(TOKEN_KEY, '');
      emit('session', { user: null, token: '' });
    },
    /** Start the search again from the top — used when the address changes. */
    rediscover() {
      everConnected = false;
      candidates = [];
      candidateAt = 0;
    },
    get tried() { return candidates.slice(0, candidateAt + 1); }
  };
}

/** One connection per page. Everything shares it. */
let shared = null;
export function netClient() {
  if (!shared) shared = createClient();
  return shared;
}

export default netClient;
