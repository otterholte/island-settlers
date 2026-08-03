/**
 * Island Settlers — the connection.
 *
 *   createClient() -> { connect, close, req, fire, on, off, status, user, ... }
 *
 * One websocket, request/reply on top of it, automatic reconnection, and an
 * identity that survives all of that. Everything above this file — the room
 * screen, the lobby, the match — talks in promises and events and never learns
 * that a socket dropped.
 *
 * THE IDENTITY IS A DEVICE ID AND A NAME, AND BOTH LIVE HERE
 * ---------------------------------------------------------
 *   "Users can still add their name and it stays saved locally on the device."
 *
 * So there is no sign-in. The first time this file runs it invents a random
 * device id and keeps it in localStorage; the name is whatever the player last
 * typed, kept beside it. Both go up on `hello`, which is the entire handshake:
 * one round trip, no password, no token, nothing that can expire.
 *
 * That is also what makes a reconnect free. The old build re-sent a signed
 * token, and when the server's session secret changed — which it did on every
 * redeploy, because it was generated at boot and never configured — the resume
 * failed silently, the client reported `ready` with no user, and a player who
 * reloaded mid-match sat on a loading screen forever. A device id cannot
 * expire and the server cannot refuse it.
 *
 * Same idiom as `core/options.js` and `systems/difficulty.js`: a module
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
  PROTOCOL_VERSION, REQ, OK, ERR, E, errText, HEARTBEAT_MS,
  cleanName, nameProblem
} from './protocol.js';
import { serverCandidates } from './config.js';

const DEVICE_KEY = 'island-settlers.device';
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

/**
 * This browser's handle, invented once and kept forever.
 *
 * Not a secret and not an account — it is the answer to "is this the same
 * person who was sitting in seat 2 ninety seconds ago", which is a question the
 * server has to be able to answer across a page reload, because the match
 * begins with one. `crypto.randomUUID` where it exists, and a plain random
 * string where it does not (older iOS Safari, and any non-https origin, where
 * `crypto` is present but `randomUUID` is not).
 */
function deviceId() {
  let d = read(DEVICE_KEY);
  if (d && d.length >= 8) return d;
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') d = c.randomUUID();
  else d = 'd' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  d = d.replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 64);
  write(DEVICE_KEY, d);
  return d;
}

/** What to call yourself before you have said. Not shown as a prompt — it is
 *  a real, usable name, so somebody who never touches the field still plays. */
const DEFAULT_NAME = 'Settler';

export function createClient() {
  let ws = null;
  let url = null;
  let status = 'offline';     // offline | dialling | open | ready | failed
  let user = null;
  const device = deviceId();
  const stored = cleanName(read(NAME_KEY));
  /** Has this player ever actually said what to call them? The room screen
   *  leaves its field blank when they have not, so they see a placeholder
   *  rather than a name they never picked. */
  let named = !!stored && !nameProblem(stored);
  let myName = named ? stored : DEFAULT_NAME;
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
        /* ONE ROUND TRIP AND YOU ARE IN.
         *
         * The version check is fatal on purpose: a client that speaks a
         * different protocol should be told to reload, not be allowed to make
         * half-working requests until something confusing happens.
         *
         * Everything else about the session rides on the same message, so
         * there is no window in which the socket is `ready` and the server
         * does not know who is on it — which is what used to strand a
         * reconnecting player between a failed resume and a lobby. */
        const r = await rawReq(REQ.HELLO, {
          version: PROTOCOL_VERSION, device, name: myName
        });
        adoptSession(r);
      } catch (e) {
        setStatus('failed', e.code === E.VERSION ? 'stale-page' : 'handshake');
        close();
        return;
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
    if (r && r.you) {
      user = r.you;
      myName = user.name;
      write(NAME_KEY, myName);
    }
    emit('session', { user, name: myName });
    return user;
  }

  /**
   * Change your name.
   *
   * Saved locally FIRST and unconditionally, because that is what was asked
   * for — "it stays saved locally on the device" — and because a player who
   * types their name while the server is asleep should still be called that
   * when it wakes up. The server is told if it is listening; if it is not, the
   * next `hello` carries the new name anyway.
   */
  async function setName(name) {
    const nice = cleanName(name);
    const bad = nameProblem(nice);
    if (bad) { const e = new Error(errText(bad)); e.code = bad; throw e; }
    myName = nice;
    named = true;
    write(NAME_KEY, nice);
    emit('session', { user, name: myName });
    if (status !== 'ready') return { id: user && user.id, name: nice };
    return adoptSession(await req(REQ.SET_NAME, { name: nice }));
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
    setName, measurePing,
    get status() { return status; },
    get user() { return user; },
    get device() { return device; },
    /** The name this device plays under, whether or not a server has heard it
     *  yet. The room screen reads this to fill its field on first paint. */
    get name() { return myName; },
    /** False until the player has typed one — see DEFAULT_NAME. */
    get named() { return named; },
    get error() { return lastError; },
    get url() { return url; },
    get ping() { return ping; },
    get signedIn() { return !!user; },
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
