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

import { reshuffle, BOUNDS } from '../board/layout.js';
import { legalRoads, legalSettlements } from '../core/rules.js';
import { chooseSetupSettlement, chooseSetupRoad } from '../systems/botBrain.js';
import { difficultyParams } from '../systems/difficulty.js';
import { autoDraft } from '../core/options.js';
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
      autoDraft: msg.autoDraft,
      at: Date.now()
    }));
    return true;
  } catch (e) {
    return false;
  }
}

/*
 * MATCHES THIS PAGE HAS WALKED OUT OF.
 *
 *   "When the users go back to the home page, right now for one user it was
 *    glitching and kept trying to reopen the game."
 *
 * That loop is exactly reproducible: leaving reloaded the page without telling
 * the server, so the server still had the player seated, and the moment the
 * fresh page connected it was sent MATCH_BEGIN for the match it had just left.
 * The client parked it and reloaded. Boot, connect, begin, park, reload, for
 * ever.
 *
 * The real fix is that leaving tells the server (see `leave` below, now called
 * by `game.leaveMatch`). This is the belt: a match id written here is one this
 * page has deliberately walked out of, and no MATCH_BEGIN for it will be
 * honoured again — however slow, retried or duplicated the server's push is.
 * Session-scoped, so a genuinely new match with a new id is unaffected and a
 * new tab starts with a clean slate.
 */
const LEFT_KEY = 'island-settlers.left';

function leftMatches() {
  const s = sess();
  if (!s) return [];
  try { return JSON.parse(s.getItem(LEFT_KEY) || '[]') || []; } catch (e) { return []; }
}

export function markLeft(matchId) {
  const s = sess();
  if (!s || !matchId) return false;
  try {
    const all = leftMatches().filter(id => id !== matchId);
    all.push(matchId);
    // Four is plenty: this only has to outlive one reload.
    s.setItem(LEFT_KEY, JSON.stringify(all.slice(-4)));
    return true;
  } catch (e) { return false; }
}

export function hasLeft(matchId) {
  return !!matchId && leftMatches().indexOf(matchId) >= 0;
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
    /*
     * AND REPAINT THE SETTLERS TO MATCH.
     *
     *   "The colours of the different players changed from one friend's screen
     *    to the next. The different players should be the same colours from one
     *    device to the other."
     *
     * They already were, in the standings — `createMirror` assigns every seat
     * the colour the SERVER gave it, so both devices agree on who is red. The
     * disagreement was three feet lower down: the 3D settlers are built at boot
     * from the default index colours, before any of this, and each device puts
     * itself in seat 0. So everyone saw themselves in the seat-0 colour and
     * everyone else shuffled.
     *
     * The palette is baked into geometry and a painted texture when a settler
     * is built, so this rebuilds the ones whose colour actually changed rather
     * than walking every mesh. It is the first frame of the match; nobody is
     * looking at a settler yet.
     */
    if (typeof game.recolorAvatars === 'function') {
      try { game.recolorAvatars(); } catch (e) { /* colours are cosmetic; the match is not */ }
    }
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
    if (autoT) { clearTimeout(autoT); autoT = 0; }
    if (game.economy && game.economy.setNetAgent) game.economy.setNetAgent(null);
    if (game.flow && game.flow.useDraft) game.flow.useDraft(null);
  }

  /* ------------------------------------------------------------ the wire */

  on(PUSH.MATCH_BEGIN, msg => {
    if (active && info && info.matchId === msg.matchId) return;   // a resume echo
    if (hasLeft(msg.matchId)) {
      // Walked out of this one. See markLeft: this is what stops the reload
      // loop even if the server is still convinced we are playing.
      try { client.req(REQ.MATCH_LEAVE, {}); } catch (e) { /* already going */ }
      return;
    }
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
    if (msg.need === 'done') { draftState.done = true; draftState.open = false; return; }
    // Yours: targets and a confirm. Anybody else's: the same board, re-dressed
    // to say whose turn it is. Never nothing — that was the bug.
    if (draftState.pid === 0 && msg.need !== 'loading') {
      /* THE ROOM DECIDES, NOT THE DEVICE.
       *
       *   "Whoever created the room should choose whether everyone does or
       *    doesn't draft."
       *
       * `autoDraft()` is a per-device preference and reading it here is what
       * produced the report: the host had it off and picked their corners,
       * the friend who joined had it on and never saw the board — from their
       * chair, the game simply would not let them play the draft. Online the
       * host's setting arrives in the begin message and is the answer for
       * everybody; the local preference is what single player uses. */
      const auto = info && typeof info.autoDraft === 'boolean'
        ? info.autoDraft : autoDraft();
      if (auto) { closePick(); autoPick(msg); }
      else openPick(msg);
    } else closePick();
    notify('draft', { ...draftState });
  });

  on(PUSH.MATCH_GO, () => { draftState.done = true; });

  on(PUSH.MATCH_OVER, msg => {
    ended = msg;
    notify('over', msg);
  });

  on(PUSH.MATCH_END, msg => {
    /* The match is gone — finished and reclaimed, or the server restarted.
     *
     * SAY SO. `stand_down` un-gates the local bots, hands the rules back to
     * `economy.js` and re-enables the local world tick, so a server that goes
     * away mid-match used to drop the player into a single-player game against
     * three bots, on the same island, mid-score, without a word. It looks
     * exactly like multiplayer right up until you notice nobody else's roads
     * are appearing — which is not a thing anyone should have to notice.
     *
     * A finished match is different and is left alone: `m.over` arrives first
     * and the results screen is already up, and yanking somebody off their own
     * victory screen would be its own bug. */
    const wasPlaying = active && !ended && state.phase !== 'over';
    stand_down();
    clearPendingMatch();
    notify('end', msg);
    if (!wasPlaying) return;
    const hud = game.hud;
    if (hud && typeof hud.announce === 'function') {
      hud.announce(msg && msg.reason === 'over' ? 'Match Over' : 'Match Ended', '#f5342a');
    }
    // Home, rather than a fake single-player match nobody asked for.
    if (typeof game.leaveMatch === 'function') setTimeout(() => game.leaveMatch(), 1400);
  });

  on(PUSH.MATCH_PEER, msg => {
    if (!mirror) return;
    const local = mirror.toLocal(msg.pid);
    const p = state.players[local];
    const was = p && p.netState;
    if (p) p.netState = msg.state;
    /*
     *   "When one friend leaves a game the other should get a notification for
     *    it."
     *
     * The peer push has always arrived and nothing has ever said it out loud.
     * Three states worth a sentence, and only on a CHANGE — a resume echo that
     * repeats 'live' at somebody who never went anywhere is not news.
     */
    if (p && was && was !== msg.state && local !== 0) {
      const who = p.netName || p.name;
      if (msg.state === 'left' || msg.state === 'bot') {
        /*
         * A DEPARTURE IS AN EVENT, NOT A TOAST.
         *
         *   "When one player left, the other player didn't see a popup showing
         *    them that their friend left."
         *
         * A toast in the corner is what this was, and a corner is where a
         * person watching their own settler never looks. The centre-screen
         * announcement is the same channel the game already uses for the
         * things you must not miss — a raid, a victory point — and losing the
         * only other person in the match belongs on it. The toast stays too,
         * a line lower, because it says what happens NEXT.
         */
        say(`${who} left the match`, '#f5a33c');
        hud('%s left — a bot is playing their settler', who, 'warn');
      } else if (msg.state === 'gone') hud('%s dropped out — holding their seat', who, 'warn');
      else if (msg.state === 'live' && was !== 'live') hud('%s is back', who, 'good');
    }
    notify('peer', { local, state: msg.state });
  });

  /** The centre-screen announcement, if there is a HUD to say it on. */
  function say(text, color) {
    const h = game && game.hud;
    if (!h || typeof h.announce !== 'function') return;
    try { h.announce(text, color); } catch (e) { /* cosmetic */ }
  }

  /** One line to the player, if there is a HUD to say it to. */
  function hud(fmt, who, kind) {
    const h = game && game.hud;
    if (!h || typeof h.toast !== 'function') return;
    try { h.toast(String(fmt).replace('%s', who), kind); } catch (e) { /* cosmetic */ }
  }

  on('m.free', msg => {
    if (!mirror) return;
    const p = state.players[mirror.toLocal(msg.pid)];
    if (p) p.freeRoads = msg.left | 0;
  });

  /* ------------------------------------------------------- watching the draft
   *
   *   "On mobile it was showing the second player as only seeing the close up
   *    of the board until it was their turn to pick, instead of showing the
   *    full map view and where other players were placing their roads and
   *    settlements."
   *
   * Exactly right, and it was one missing line. `matchflow` asks whichever
   * draft object is installed to `begin()`, and the LOCAL one (flowDraft.js)
   * puts the camera overhead and opens the board map in `draft-watch` for the
   * whole draft, re-dressing it on every pick. The networked one set a boolean
   * called `boardUp` that nothing read, and the only thing in this file that
   * ever opened the map was the branch for your OWN turn. So everybody watched
   * the 3D close-up until their name came up — and whoever drew the last seat
   * watched six other picks happen somewhere off screen.
   *
   * `showWatch` is the missing half. The board goes up when the draft begins
   * and STAYS up: `overview.open` is idempotent while already open, so calling
   * it again per turn re-dresses the title, the note and the pick-order strip
   * without the panel ever closing or the camera moving.
   */

  function draftInfo(note) {
    return {
      index: state.setupIndex | 0,
      order: state.setupOrder || [],
      pid: draftState.pid,
      note: note || ''
    };
  }

  /** Whose turn it is, in words, for the strip and the title plate. */
  function turnLine() {
    if (draftState.pid < 0) return 'Watching the board';
    if (draftState.pid === 0) return 'Your pick';
    const p = state.players[draftState.pid];
    const who = p ? p.name : 'A rival';
    return draftState.need === 'road' ? `${who} is laying a road` : `${who} is choosing a corner`;
  }

  function showWatch() {
    if (!game.openOverview) return false;
    const line = turnLine();
    const opened = game.openOverview('draft-watch', {
      setup: true,
      cancellable: false,
      keepOpen: true,
      title: 'Opening Draft',
      hint: line,
      draft: draftInfo(line)
    });
    draftState.boardUp = opened !== false;
    return draftState.boardUp;
  }

  /* ------------------------------------------------------ picked for you
   *
   * The same setting the single-player draft honours, honoured here — which is
   * most of why it is a per-device preference and not a room setting. Nobody
   * else in the lobby has to agree that you would rather be dealt a corner,
   * and nothing about it goes on the wire: this sends exactly the act a thumb
   * would have sent, through the same path, a beat later so the board has time
   * to show whose turn it is.
   *
   * `setupNoise: 0` for the same reason as offline — the rivals' difficulty is
   * about how well THEY play, and it must not quietly hand the player a worse
   * corner than they would have picked themselves.
   */
  const CLEAN_BRAIN = () => ({ d: { ...difficultyParams(), setupNoise: 0 } });
  let autoT = 0;

  let autoPicked = -1;                  // the setup index we last picked for

  function autoPick(msg) {
    /* An announcement can arrive twice for one turn: the server repeats it when
       a player comes back, so a client that reloaded across the original is
       told whose turn it is. Acting on the repeat would place twice for the
       same seat, and the second attempt is a refusal in the log at best. */
    const idx = Number.isInteger(msg.index) ? msg.index : -1;
    if (msg.resend && idx >= 0 && idx === autoPicked) return;
    autoPicked = idx;
    if (autoT) clearTimeout(autoT);
    autoT = setTimeout(() => {
      autoT = 0;
      // Still my turn, still needing the same thing? The clock may have run
      // out and the server may have placed for me while this was waiting.
      if (!active || draftState.pid !== 0 || draftState.need !== msg.need) return;
      const wantRoad = msg.need === 'road';
      let id = -1;
      try {
        id = wantRoad
          ? chooseSetupRoad(state, 0, draftState.anchor, Math.random, CLEAN_BRAIN())
          : chooseSetupSettlement(state, 0, Math.random, CLEAN_BRAIN());
      } catch (e) { id = -1; }
      const legal = wantRoad
        ? legalRoads(state, 0, true, draftState.anchor)
        : legalSettlements(state, 0, true);
      if (legal.indexOf(id) < 0) id = legal.length ? legal[0] : -1;
      if (id < 0) return;
      send(wantRoad ? ACT.DRAFT_ROAD : ACT.DRAFT_SETTLEMENT, { id });
    }, 900);
  }

  /* --------------------------------------------------------------- picks
     The player's own draft turn. The board is up in `draft-watch`; this hands
     it a set of targets and a confirm that goes to the server. */

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
      // The same pick-order strip the watch view carries, so the panel does
      // not lose track of the draft the moment it becomes yours.
      draft: draftInfo(wantRoad ? 'Your road' : 'Your corner'),
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

  /**
   * Your turn is over, or it was never yours.
   *
   * This used to set a boolean and nothing else — which left the panel from
   * your own pick standing there with the title "Your Road" and no targets on
   * it while somebody else picked. `openPick` passes `keepOpen`, so
   * `overview.commit` deliberately does not close the panel after a placement;
   * something has to take it back to the watch view, and this is that.
   */
  function closePick() {
    draftState.open = false;
    if (!draftState.done) showWatch();
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
    /*
     * A FINISHED MATCH IS NOBODY'S TO CORRECT.
     *
     * The review lets you walk the island you just played (see hud-end.js), and
     * the server's copy of you stopped moving the moment it froze the match —
     * so every frame of that walk is a "disagreement" the reconciler would drag
     * you back out of, one settler-width at a time. It is not a disagreement:
     * there is nothing left to be authoritative about. Input stops going up and
     * corrections stop coming down; the rivals are still eased between the last
     * snapshots so the island keeps whatever life it had. The one cost is that
     * peers do not watch you stroll, which is a fair price for being able to.
     */
    if (state.phase === 'over') { interpolate(); return; }
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
    if (info && info.matchId) markLeft(info.matchId);
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
    /* The board goes up for EVERYBODY, for the whole draft — not just for the
       player whose turn it is. See the showWatch note above. */
    begin() {
      const cam = game.camera;
      if (cam && typeof cam.setActive === 'function') cam.setActive(true);
      if (cam && typeof cam.overview === 'function') cam.overview(true);
      if (cam && typeof cam.snap === 'function') cam.snap(BOUNDS.cx, BOUNDS.cz);
      showWatch();
    },
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
