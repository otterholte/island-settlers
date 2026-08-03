/**
 * Island Settlers — playing a match over the wire.
 *
 *   createNetMatch(state, game, client) ->
 *     { active, begin, update, draft, act, leave, ... }
 *
 * The browser half of the authoritative match. Owns four jobs and nothing else:
 *
 *   1. LOADING IN. The board is dealt at module-evaluation time and the whole
 *      3D world is built from it once, so an island cannot be re-dealt under a
 *      running scene — the terrain, the props and the docks would all still be
 *      the old one. So a match handoff goes through a page load: the seed is
 *      parked in sessionStorage, the page reloads, and `main.js` deals THAT
 *      island before it builds anything. It costs the cold open, which the
 *      player has seen before and which is exactly the right length for the
 *      server's load-in pause.
 *
 *   2. PREDICTION. Your own settler keeps being driven by the local controller
 *      at 60Hz, because waiting a round trip to move is not a game about
 *      running into things. The server's opinion arrives 20 times a second and
 *      is eased in, or snapped when the gap is too big to hide.
 *
 *   3. INTERPOLATION. Everybody else is drawn a fixed delay behind the newest
 *      snapshot, between the two that bracket that moment. A settler drawn at
 *      the newest snapshot has to stop dead every 50ms waiting for the next.
 *
 *   4. TRANSLATION. Everything the player does becomes a request instead of a
 *      local mutation, and everything the server says becomes an event the
 *      existing game already knows how to draw. `mirror.js` does the second
 *      half; `setNetAgent` in `economy.js` does the first.
 *
 * Owner: net agent.
 */

import { reshuffle } from '../board/layout.js';
import { PLAYER_SPEED } from '../core/constants.js';
import { createMirror } from './mirror.js';
import { REQ, PUSH, ACT, INPUT_HZ, INTERP_DELAY_MS, errText } from './protocol.js';

const HANDOFF_KEY = 'island-settlers.match';
/** A parked handoff older than this is stale — the page was closed and
 *  reopened much later, and that match is long gone. */
const HANDOFF_TTL_MS = 120000;

/** Position error we ease away; past this we stop pretending and snap. */
const EASE_LIMIT = 4.0;
/** How fast the easing closes the gap, in units of the gap per second. */
const EASE_RATE = 6.0;

const now = () => (typeof performance !== 'undefined' && performance.now
  ? performance.now() : Date.now());

/* ============================================================ the handoff */

function sess() {
  try { return typeof sessionStorage !== 'undefined' ? sessionStorage : null; }
  catch (e) { return null; }
}

/** What `main.js` reads at boot, before it builds a single mesh. */
export function pendingMatch() {
  const s = sess();
  if (!s) return null;
  let raw;
  try { raw = s.getItem(HANDOFF_KEY); } catch (e) { return null; }
  if (!raw) return null;
  let m;
  try { m = JSON.parse(raw); } catch (e) { clearPendingMatch(); return null; }
  if (!m || !m.matchId || !Number.isFinite(m.seed)) { clearPendingMatch(); return null; }
  if (Date.now() - (m.at || 0) > HANDOFF_TTL_MS) { clearPendingMatch(); return null; }
  return m;
}

export function parkMatch(msg) {
  const s = sess();
  if (!s) return false;
  try {
    s.setItem(HANDOFF_KEY, JSON.stringify({
      matchId: msg.matchId,
      seed: msg.seed >>> 0,
      seats: msg.seats,
      order: msg.order || null,
      yourPid: msg.yourPid,
      difficulty: msg.difficulty,
      knights: msg.knights,
      at: Date.now()
    }));
    return true;
  } catch (e) {
    return false;
  }
}

export function clearPendingMatch() {
  const s = sess();
  try { s && s.removeItem(HANDOFF_KEY); } catch (e) { /* nothing to clear */ }
}

/* ================================================================== match */

export function createNetMatch(state, game, client) {
  let mirror = null;
  let info = null;              // the begin message we are playing
  let active = false;
  let ended = null;             // { winner, reason, table }

  /* Snapshots waiting to be drawn. Two is the minimum for interpolation and
     four is plenty of slack for a hiccup; beyond that we are behind enough
     that catching up matters more than smoothness. */
  const buf = [];
  const MAX_BUF = 6;

  /* The draft, as matchflow's `draft` object. Same tiny surface as
     flowDraft.js so the stage machine does not know the difference. */
  const draftState = {
    pid: -1, need: 'loading', anchor: -1, deadline: 0,
    done: false, boardUp: false, holding: false, open: false
  };

  const listeners = [];
  const on = (t, fn) => listeners.push(client.on(t, fn));

  /* ------------------------------------------------------------- begin */

  /**
   * A match started. If this page has not loaded into it yet, park it and
   * reload — see the note at the top about why the island cannot change under
   * a live scene.
   */
  function begin(msg) {
    const parked = pendingMatch();
    if (!parked || parked.matchId !== msg.matchId) {
      // ONLY RELOAD IF THE MATCH WAS ACTUALLY PARKED. Reloading without
      // storing it means coming back to a page that finds nothing pending,
      // asks the server, is told about the same match, and reloads again —
      // an infinite loop, on exactly the browsers where storage is refused.
      const kept = parkMatch(msg);
      if (kept && typeof location !== 'undefined' && location.reload) {
        location.reload();
        return 'reloading';
      }
      // No storage, or no document to reload (the harness). Deal it in place
      // and carry on: the terrain will be the old island, which is wrong to
      // look at and right to play — every position, pickup and build comes
      // from the server and lands on the correct hex id regardless.
      reshuffle(msg.seed >>> 0);
    }
    return start(msg);
  }

  /** Take over a match whose island this page was already built for. */
  function start(msg) {
    info = msg;
    ended = null;
    buf.length = 0;
    mirror = createMirror(state, {
      yourPid: msg.yourPid,
      roster: msg.seats,
      order: msg.order
    });
    active = true;
    draftState.done = false;
    draftState.pid = -1;
    draftState.need = 'loading';

    // Bots are the server's business now. Locally there is nothing to run and
    // a local brain would fight the snapshots for control of a settler.
    // Wrapping the property is the only interception main.js's frame order
    // allows — the same trick `flowCountdown.js` uses, for the same reason.
    if (game.bots && typeof game.bots.update === 'function' && !game.bots.__net) {
      game.bots.__net = true;
      const original = game.bots.update;
      game.bots.update = function netGate(dt) {
        if (active) return;
        return original.call(game.bots, dt);
      };
    }

    // Every purchase, trade and card now goes down the wire instead of into
    // the local rules. economy.js keeps all of its gates — affordability,
    // piece caps, legal targets — and only the mutation moves.
    if (game.economy && game.economy.setNetAgent) game.economy.setNetAgent(agent);

    // The stage machine keeps running; it just asks a different draft whose
    // turn it is. matchflow.js does not otherwise know a server exists.
    if (game.flow && game.flow.useDraft) game.flow.useDraft(draft);
    if (game.flow && game.flow.skipIntro) game.flow.skipIntro();
    return 'started';
  }

  /** Hand the rules back to this machine. */
  function stand_down() {
    active = false;
    if (game.economy && game.economy.setNetAgent) game.economy.setNetAgent(null);
    if (game.flow && game.flow.useDraft) game.flow.useDraft(null);
  }

  /* ------------------------------------------------------------ the wire */

  on(PUSH.MATCH_BEGIN, msg => {
    if (active && info && info.matchId === msg.matchId) return;   // a resume echo
    begin(msg);
  });

  on(PUSH.MATCH_EV, msg => {
    if (!active || !mirror) return;
    const evs = mirror.applyEvents(msg.evs);
    // Straight onto the queue `main.js` drains. Every sound, particle,
    // structure and HUD flash in the game hangs off that one loop.
    for (const ev of evs) state.events.push(ev);
  });

  on(PUSH.MATCH_SNAP, msg => {
    if (!active || !mirror) return;
    const snap = mirror.applySnapshot(msg, { keepLocalPosition: true });
    if (!snap) return;
    buf.push({ at: now(), time: snap.time, seats: snap.seats });
    while (buf.length > MAX_BUF) buf.shift();
  });

  on(PUSH.MATCH_DRAFT, msg => {
    if (!active || !mirror) return;
    draftState.pid = msg.pid < 0 ? -1 : mirror.toLocal(msg.pid);
    draftState.need = msg.need;
    draftState.anchor = Number.isInteger(msg.anchor) ? msg.anchor : -1;
    draftState.deadline = msg.deadline || 0;
    if (msg.need === 'done') { draftState.done = true; closePick(); return; }
    if (draftState.pid === 0 && msg.need !== 'loading') openPick(msg);
    else closePick();
    notify('draft', { ...draftState });
  });

  on(PUSH.MATCH_GO, () => { draftState.done = true; });

  on(PUSH.MATCH_OVER, msg => {
    ended = msg;
    notify('over', msg);
  });

  on(PUSH.MATCH_END, msg => {
    // The match is gone — finished and reclaimed, or the server restarted.
    stand_down();
    clearPendingMatch();
    notify('end', msg);
  });

  on(PUSH.MATCH_PEER, msg => {
    if (!mirror) return;
    const local = mirror.toLocal(msg.pid);
    const p = state.players[local];
    if (p) p.netState = msg.state;
    notify('peer', { local, state: msg.state });
  });

  on('m.free', msg => {
    if (!mirror) return;
    const p = state.players[mirror.toLocal(msg.pid)];
    if (p) p.freeRoads = msg.left | 0;
  });

  /* --------------------------------------------------------------- picks
     The player's own draft turn. The board is already up in `draft-watch`;
     this hands it a set of targets and a confirm that goes to the server. */

  function openPick(msg) {
    if (!game.openOverview) return;
    const wantRoad = msg.need === 'road';
    const opened = game.openOverview(wantRoad ? 'place-road' : 'place-settlement', {
      free: true,
      setup: true,
      anchor: draftState.anchor,
      keepOpen: true,
      title: wantRoad ? 'Your Road' : 'Your Corner',
      hint: wantRoad ? 'Run a road off your new settlement' : 'Claim a corner',
      onConfirm: id => {
        // Optimistic: the panel closes and the server's build event puts the
        // piece down a moment later. Refusing here would mean holding the map
        // open for a round trip on every single pick.
        send(wantRoad ? ACT.DRAFT_ROAD : ACT.DRAFT_SETTLEMENT, { id });
        return true;
      }
    });
    draftState.open = opened !== false;
  }

  function closePick() {
    draftState.open = false;
  }

  /* --------------------------------------------------------------- input
     The stick, in world space, at INPUT_HZ. Sent on change or on a heartbeat,
     because a settler standing still needs no packets and a settler running
     in a straight line needs one occasionally in case a packet was the last
     one that mattered. */

  let lastSent = { x: 0, z: 0, at: 0 };
  let seq = 0;
  const SEND_EVERY = 1000 / INPUT_HZ;

  function sendInput() {
    if (!active || !info) return;
    const input = game.input;
    const cam = game.camera;
    let sx = 0, sy = 0;
    if (input && input.stick) {
      sx = Number.isFinite(input.stick.x) ? input.stick.x : 0;
      sy = Number.isFinite(input.stick.y) ? input.stick.y : 0;
    }
    let mag = Math.hypot(sx, sy);
    if (mag > 1) { sx /= mag; sy /= mag; mag = 1; }

    // Turn it by the camera here, not there. The server has no camera and no
    // business having one — two players facing different ways would need two.
    const yaw = cam && Number.isFinite(cam.yaw) ? cam.yaw : 0;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const rx = -fz, rz = fx;
    const dx = (rx * sx + fx * sy) * mag;
    const dz = (rz * sx + fz * sy) * mag;

    const t = now();
    const moved = Math.abs(dx - lastSent.x) > 0.02 || Math.abs(dz - lastSent.z) > 0.02;
    if (!moved && t - lastSent.at < 250) return;
    if (t - lastSent.at < SEND_EVERY) return;
    lastSent = { x: dx, z: dz, at: t };
    client.fire(REQ.MATCH_INPUT, { x: +dx.toFixed(3), z: +dz.toFixed(3), q: ++seq });
  }

  /* ----------------------------------------------------------- the frame */

  function update(dt) {
    if (!active || !mirror) return;
    sendInput();
    reconcile(dt);
    interpolate();
  }

  /**
   * Your settler: predicted locally, corrected toward the server.
   *
   * The correction is deliberately gentle inside EASE_LIMIT and brutal outside
   * it. Small disagreements are latency and drift and should be closed
   * invisibly; a large one means something happened you did not simulate — the
   * coastline stopped you, a Knight froze the match, the tab was asleep — and
   * easing across four world units of that would look like being dragged.
   */
  function reconcile(dt) {
    const last = buf[buf.length - 1];
    if (!last) return;
    const seat = last.seats.find(s => s.local === 0);
    if (!seat) return;
    const p = state.players[0];
    if (!p) return;

    const dx = seat.x - p.x, dz = seat.z - p.z;
    const gap = Math.hypot(dx, dz);
    if (gap < 0.02) return;
    if (gap > EASE_LIMIT) { p.x = seat.x; p.z = seat.z; p.vx = 0; p.vz = 0; return; }
    const k = Math.min(1, EASE_RATE * (Number.isFinite(dt) ? dt : 1 / 60));
    p.x += dx * k;
    p.z += dz * k;
  }

  /**
   * Everybody else: drawn INTERP_DELAY_MS behind the newest snapshot, between
   * the two that bracket that moment. The delay is the price of smoothness —
   * a tenth of a second of "where they were" instead of a stutter every 50ms.
   */
  function interpolate() {
    if (buf.length === 0) return;
    const target = now() - INTERP_DELAY_MS;

    let a = null, b = null;
    for (let i = buf.length - 1; i >= 0; i--) {
      if (buf[i].at <= target) { a = buf[i]; b = buf[i + 1] || null; break; }
    }
    if (!a) { a = buf[0]; b = buf[1] || null; }

    const span = b ? (b.at - a.at) : 0;
    const f = span > 0 ? Math.min(1, Math.max(0, (target - a.at) / span)) : 0;

    for (const seat of a.seats) {
      if (seat.local === 0) continue;               // you are predicted, not drawn
      const p = state.players[seat.local];
      if (!p) continue;
      const nb = b ? b.seats.find(s => s.local === seat.local) : null;
      if (nb) {
        p.x = seat.x + (nb.x - seat.x) * f;
        p.z = seat.z + (nb.z - seat.z) * f;
        p.facing = angleLerp(seat.facing, nb.facing, f);
      } else {
        p.x = seat.x; p.z = seat.z; p.facing = seat.facing;
      }
      p.action = seat.action;
      // The settler rig reads velocity for its run cycle, so give it one that
      // matches what it is actually doing rather than leaving it at zero.
      const spd = nb ? Math.hypot(nb.x - seat.x, nb.z - seat.z) / Math.max(span / 1000, 1e-3) : 0;
      const v = Math.min(spd, PLAYER_SPEED);
      p.vx = Math.cos(p.facing) * v;
      p.vz = Math.sin(p.facing) * v;
    }
  }

  function angleLerp(a, b, f) {
    let d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return a + d * f;
  }

  /* --------------------------------------------------------------- acts */

  async function send(kind, body = {}) {
    if (!active) return false;
    try {
      await client.req(REQ.MATCH_ACT, { kind, ...body });
      return true;
    } catch (e) {
      // The server said no. Say so plainly rather than leaving the player
      // wondering why their road did not appear.
      const msg = e.code === 'move.notyours'
        ? 'Not your turn yet'
        : (e.code ? errText(e.code) : 'The server refused that');
      if (game.toast) game.toast(msg, 'bad');
      notify('refused', { kind, code: e.code });
      return false;
    }
  }

  /** The single entry point `economy.js` routes every mutation through. */
  function agent(kind, body) {
    if (!active) return false;
    send(kind, body);
    return true;
  }

  async function leave() {
    stand_down();
    clearPendingMatch();
    try { await client.req(REQ.MATCH_LEAVE, {}); } catch (e) { /* going anyway */ }
  }

  /* ------------------------------------------------------------- events */

  const watchers = new Set();
  function notify(type, payload) {
    for (const fn of [...watchers]) {
      try { fn(type, payload); } catch (e) { /* one listener cannot stop the rest */ }
    }
  }

  /* ---------------------------------------------- the draft, for matchflow */

  const draft = {
    begin() { draftState.boardUp = true; },
    update() { return draftState.done; },
    reset() { draftState.boardUp = false; draftState.open = false; },
    get holding() { return draftState.open; },
    get done() { return draftState.done; },
    get boardUp() { return draftState.boardUp; },
    get pid() { return draftState.pid; },
    get need() { return draftState.need; },
    get deadline() { return draftState.deadline; }
  };

  return {
    begin, start, update, draft, agent, send, leave,
    onEvent: fn => { watchers.add(fn); return () => watchers.delete(fn); },
    get active() { return active; },
    get info() { return info; },
    get mirror() { return mirror; },
    get ended() { return ended; },
    get draftState() { return draftState; },
    get buffered() { return buf.length; },
    destroy() {
      stand_down();
      for (const offFn of listeners) { try { offFn(); } catch (e) { /* fine */ } }
      listeners.length = 0;
      watchers.clear();
    }
  };
}

export default createNetMatch;
