/**
 * Island Settlers — the client-side mirror of an authoritative match.
 *
 *   createMirror(state, { yourPid, roster, order }) ->
 *     { applyEvents, applySnapshot, toLocal, toServer, seatOf, ... }
 *
 * Headless-safe: no DOM, no three.js. `tools/nettest.mjs` drives this exact
 * file, which is the point — the thing the tests exercise is the thing the
 * browser runs.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE IS FOR
 * ---------------------------------------------------------------------------
 * The server runs the real rules and streams what happened. This turns that
 * stream back into a `state` object identical to the one single player builds,
 * so that every single line of presentation code — `structures.spawnRoad`, the
 * HUD, the results table, the Knight card, the settler animations — works in a
 * networked match without being told there is a network. The netcode adds no
 * rendering, because it does not need any.
 *
 * ---------------------------------------------------------------------------
 * THE SEAT SWAP, WHICH IS THE WHOLE TRICK
 * ---------------------------------------------------------------------------
 * The browser build assumes the human is `state.players[0]`. Not loosely — it
 * is written into `hud.js` (`const me = state.players[0]`), into the player
 * controller, into `economy.js`, into `avatars[0]`, into two dozen calls that
 * pass a literal 0 as the player id. Making all of that configurable would
 * touch most of the interface for no gain.
 *
 * So the client renumbers. YOU ARE ALWAYS SEAT 0 LOCALLY, whatever seat the
 * server dealt you, and every player id crossing the wire is permuted on the
 * way in and on the way out.
 *
 *   server pid 2 (yours)  <->  local 0
 *   server pid 0          <->  local 1
 *   ...
 *
 * What does NOT get renumbered is identity. Colour and name travel with the
 * SERVER seat, so if you are the orange settler then everyone at the table
 * sees you as orange, including you — the permutation moves you to index zero
 * without moving you to blue. That is the difference between an implementation
 * detail and a lie.
 *
 * ---------------------------------------------------------------------------
 * WHY MUTATE STATE DIRECTLY AND NOT CALL THE RULES
 * ---------------------------------------------------------------------------
 * The tempting version of this file replays each event by calling the same
 * rules function the server called — `placeRoad(state, pid, id, true)`. It is
 * wrong, and subtly: those functions re-check legality against the CLIENT's
 * view, and the client's view is always a few tens of milliseconds behind. A
 * road that was legal when the server took it can be judged illegal here, and
 * the failure mode is not an error message — it is a board that is quietly
 * missing a road forever, diverging further with every event.
 *
 * The server already decided. This file's job is to agree, not to audit. So it
 * writes the maps and sets directly. The one thing it does re-derive is
 * anything that is a pure function of what it just wrote.
 *
 * Owner: net agent.
 */

import { RES, PLAYER_COLORS } from '../core/constants.js';
// A pure read over `state.roadOwner`, which this file writes itself. It
// decides nothing — see `onBuild` for why that distinction is the whole rule.
import { longestRoadFor } from '../core/rules.js';
import { items, collectItem, restoreTile, tileRegenSeconds } from '../board/nodes.js';
import { readSeat, SNAP_STRIDE } from './protocol.js';

export function createMirror(state, opts = {}) {
  const yourPid = Number.isInteger(opts.yourPid) ? opts.yourPid : 0;
  const roster = Array.isArray(opts.roster) ? opts.roster : [];
  const n = state.players.length;

  /* ------------------------------------------------------------ the swap
     A rotation, not an arbitrary shuffle: local 0 is your server seat and the
     rest keep their order around the table. Seating order is what the draft
     is built from, so preserving it means the snake still reads left to right
     the way everybody else sees it. */
  const loc2srv = new Array(n);
  const srv2loc = new Array(n);
  for (let i = 0; i < n; i++) {
    const srv = (yourPid + i) % n;
    loc2srv[i] = srv;
    srv2loc[srv] = i;
  }

  const toLocal = pid => (Number.isInteger(pid) && pid >= 0 && pid < n ? srv2loc[pid] : pid);
  const toServer = pid => (Number.isInteger(pid) && pid >= 0 && pid < n ? loc2srv[pid] : pid);

  /* Identity follows the SERVER seat. `PLAYER_COLORS` is indexed by seat, and
     the server's roster names the colour it dealt each one, so the local
     player object at index i wears server seat loc2srv[i]'s colours. */
  const colorByKey = {};
  for (const c of PLAYER_COLORS) colorByKey[c.key] = c;

  for (let i = 0; i < n; i++) {
    const srv = loc2srv[i];
    const seat = roster.find(s => s.pid === srv);
    const p = state.players[i];
    const color = (seat && colorByKey[seat.color]) || PLAYER_COLORS[srv] || PLAYER_COLORS[i];
    p.color = color;
    p.name = i === 0 ? 'You' : ((seat && seat.name) || color.name || `Player ${i + 1}`);
    // `isBot` is what the local bots module would filter on. Nothing local
    // drives anybody here — the server does — but the flag is read by the
    // results screen and by the draft strip, so it has to be honest.
    p.isBot = !!(seat && seat.kind !== 'human');
    p.netSeat = srv;
    p.netName = (seat && seat.name) || p.name;
    p.netState = (seat && seat.state) || 'live';
  }

  // The draft order arrives in server seats and every reader of it — the pip
  // strip, `setupCurrentPlayer`, the draft UI — thinks in local ones.
  if (Array.isArray(opts.order) && opts.order.length) {
    state.setupOrder = opts.order.map(toLocal);
  }
  state.setupIndex = 0;
  state.setupNeed = 'settlement';

  /* ------------------------------------------------------------ counters
     Cheap sanity, published on `stats` so the capture rig and the console can
     see whether a match is actually keeping up. */
  const stats = {
    events: 0, snaps: 0, unknown: 0, dropped: 0,
    lastTick: -1, lastMs: 0, gained: 0, builds: 0
  };

  /* =========================================================== the events */

  /**
   * Apply one server event.
   *
   * Returns the event REWRITTEN into local seat numbers, or null if it should
   * not be shown. The caller pushes what comes back onto `state.events`, which
   * is where `main.js`'s existing pump picks it up and renders it — that is
   * the seam that makes all the effects work for free.
   */
  function applyEvent(raw) {
    if (!raw || typeof raw !== 'object' || typeof raw.type !== 'string') return null;
    const ev = { ...raw };
    if (Number.isInteger(ev.player)) ev.player = toLocal(ev.player);

    switch (ev.type) {
      case 'gained': return onGained(ev);
      case 'exhausted': return ev;                  // the pickup already did it
      case 'restored': return onRestored(ev);
      case 'build': return onBuild(ev);
      case 'portUnlocked': return onPort(ev);
      case 'trade': return onTrade(ev);
      case 'cardDrawn': return onCard(ev);
      case 'knight': return onKnight(ev);
      case 'roadBuilding': return onRoadBuilding(ev);
      case 'award': return onAward(ev);
      case 'awardLost': return onAwardLost(ev);
      case 'blocked':
        // Only your own blocked pickups are worth a toast. In single player
        // nobody else's ever reach the pump; online everybody's do, and four
        // settlers walking a blocked hex would strobe the message.
        return ev.player === 0 ? ev : null;
      case 'victory': return onVictory(ev);
      case 'setupComplete':
        state.phase = 'play';
        return ev;
      default:
        stats.unknown++;
        return ev;
    }
  }

  function applyEvents(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const raw of list) {
      let ev = null;
      try {
        ev = applyEvent(raw);
      } catch (e) {
        // One malformed event must not take the match down. Count it, drop it,
        // carry on — the next snapshot re-asserts positions and resources, so
        // the damage is bounded to whatever that one event was going to draw.
        stats.dropped++;
        ev = null;
      }
      if (ev) out.push(ev);
      stats.events++;
    }
    return out;
  }

  /* -------------------------------------------------------------- pickups */

  function onGained(ev) {
    const p = state.players[ev.player];
    const it = items[ev.item];
    if (it && it.available) collectItem(it, state.time, ev.player);
    if (p) {
      p.res[ev.resource] = (p.res[ev.resource] | 0) + (ev.amount | 0);
      p.carried = (p.carried | 0) + 1;
      p.pickedAt = state.time;
      if (p.stats) p.stats.gathered++;
    }
    stats.gained++;
    return ev;
  }

  function onRestored(ev) {
    restoreTile(ev.tile);
    return ev;
  }

  /* --------------------------------------------------------------- builds
     Written straight into the maps. See the note at the top of the file about
     why this does not go through `placeRoad` and friends. */

  function onBuild(ev) {
    const p = state.players[ev.player];
    if (!p) return ev;
    if (ev.kind === 'road') {
      state.roadOwner.set(ev.at, ev.player);
      p.roads.add(ev.at);
      // Re-derived, not replayed: a length is a pure function of the map that
      // was just written, so working it out here cannot disagree with the
      // server. WHO HOLDS THE AWARD is a different question and stays the
      // server's — that arrives as an `award` event. Without this line the
      // HUD's award row read every player's road as 0 all match, because
      // nothing else on the client ever fills `longestRoadLen` in.
      p.longestRoadLen = longestRoadFor(state, ev.player);
    } else if (ev.kind === 'settlement') {
      state.buildings.set(ev.at, { owner: ev.player, type: 'settlement' });
      p.settlements.add(ev.at);
    } else if (ev.kind === 'city') {
      const b = state.buildings.get(ev.at);
      if (b) b.type = 'city';
      else state.buildings.set(ev.at, { owner: ev.player, type: 'city' });
      p.settlements.delete(ev.at);
      p.cities.add(ev.at);
    }
    if (p.stats) p.stats.built = (p.stats.built | 0) + 1;
    stats.builds++;
    // The opening draft advances on builds, and the draft strip reads the
    // cursor. During play `setupIndex` is finished and this is a no-op.
    if (state.phase === 'setup') advanceSetupCursor(ev);
    return ev;
  }

  /** Keep `setupIndex` / `setupNeed` walking in step with the server's, so the
   *  pip strip and "you pick 4th and 5th" line stay right. The server is the
   *  one that decides; this only follows what its builds imply. */
  function advanceSetupCursor(ev) {
    if (ev.kind === 'settlement') {
      state.setupNeed = 'road';
      state.setupAnchor = ev.at;
    } else if (ev.kind === 'road') {
      state.setupNeed = 'settlement';
      state.setupAnchor = -1;
      state.setupIndex++;
    }
  }

  function onPort(ev) {
    const p = state.players[ev.player];
    if (p && p.ports && typeof p.ports.add === 'function') p.ports.add(ev.port);
    return ev;
  }

  /* ---------------------------------------------------------------- goods */

  function onTrade(ev) {
    const p = state.players[ev.player];
    if (p) {
      p.res[ev.give] = Math.max(0, (p.res[ev.give] | 0) - (ev.ratio | 0));
      p.res[ev.get] = (p.res[ev.get] | 0) + 1;
      if (p.stats) p.stats.trades = (p.stats.trades | 0) + 1;
    }
    return ev;
  }

  function onCard(ev) {
    const p = state.players[ev.player];
    if (!p) return ev;
    if (ev.instant) p.vpCards = (p.vpCards | 0) + 1;
    // `ev.card` since the cardDrawn payload stopped overwriting its own event
    // type (see rules.drawCard); `ev.type` is what a server on the old build
    // sends, and costs one `||` to keep working.
    else p.cards.push({ type: ev.card || ev.type, id: `${ev.player}-${state.time.toFixed(2)}` });
    return ev;
  }

  function onKnight(ev) {
    const p = state.players[ev.player];
    state.robberTile = ev.tile;
    state.robberOwner = ev.player;
    if (p) {
      p.knightsPlayed = (p.knightsPlayed | 0) + 1;
      const i = p.cards.findIndex(c => c.type === 'knight');
      if (i >= 0) p.cards.splice(i, 1);
    }
    // The bill, rewritten into local seats. `hud-raid.js` reads it to decide
    // whether the card says "you lost" or "you took".
    const losses = [];
    for (const l of (ev.losses || [])) {
      const lp = toLocal(l.player);
      const o = state.players[lp];
      if (o) {
        for (const r of RES) o.res[r] = Math.max(0, (o.res[r] | 0) - ((l.lost && l.lost[r]) | 0));
        o.carried = 0;
      }
      losses.push({ ...l, player: lp });
    }
    ev.losses = losses;
    return ev;
  }

  function onRoadBuilding(ev) {
    const p = state.players[ev.player];
    if (p) {
      p.freeRoads = ev.free | 0;
      const i = p.cards.findIndex(c => c.type === 'roadBuilding');
      if (i >= 0) p.cards.splice(i, 1);
    }
    return ev;
  }

  /* ---------------------------------------------------------------- awards
   *
   * FIVE POINTS THAT WERE NOT ON THE BOARD.
   *
   *   "how many points it takes to win on play with friends mode, because it
   *    doesn't seem consistent with the rest of the game."
   *
   * Twelve, the same as everywhere else — `VICTORY_POINTS` is one constant and
   * the server imports the same one. What was inconsistent was the SCORE, not
   * the target. `rules.scoreOf` counts Longest Road and Largest Army off the
   * per-player flags `hasLongestRoad` / `hasLargestArmy`, and this pair of
   * handlers used to record only the holder id. So online, every award was
   * worth nothing on the client: the HUD track, the overview badges and the
   * results line all ran up to five points light, the trophy lit next to a
   * number that plainly was not counting it, and somebody won the match while
   * your corner still said 7 of 12.
   *
   * The flags are set from the event and only from the event. The server
   * decided; agreeing with it is this file's entire job.
   */

  function onAward(ev) {
    if (ev.kind === 'longestRoad') {
      state.longestRoadHolder = ev.player;
      for (const p of state.players) p.hasLongestRoad = p.id === ev.player;
      // The winning length rides along on the event. `onBuild` derives the
      // same number a moment earlier; taking it here too costs nothing and
      // covers a client that joined mid-match and missed those builds.
      const holder = state.players[ev.player];
      if (holder && Number.isFinite(ev.value)) holder.longestRoadLen = ev.value | 0;
    } else if (ev.kind === 'largestArmy') {
      state.largestArmyHolder = ev.player;
      for (const p of state.players) p.hasLargestArmy = p.id === ev.player;
    }
    return ev;
  }

  function onAwardLost(ev) {
    if (ev.kind === 'longestRoad') {
      state.longestRoadHolder = -1;
      for (const p of state.players) p.hasLongestRoad = false;
    } else if (ev.kind === 'largestArmy') {
      state.largestArmyHolder = -1;
      for (const p of state.players) p.hasLargestArmy = false;
    }
    return ev;
  }

  function onVictory(ev) {
    state.winner = ev.player;
    state.phase = 'over';
    return ev;
  }

  /* ========================================================== the snapshot
     Positions and the five counters, twenty times a second.

     THE LOCAL SETTLER IS TREATED DIFFERENTLY ON PURPOSE. Its position is
     predicted here and corrected toward the server, because snapping it to a
     value that is a network round trip old would make every step feel like it
     happened to somebody else. Everyone else is written straight in and the
     interpolation happens a layer up, in netmatch.js, which has the frame
     clock to do it against. */

  function applySnapshot(snap, opts2 = {}) {
    if (!snap || !Array.isArray(snap.p)) return null;
    // Out-of-order snapshots cannot happen on a websocket (TCP is ordered) but
    // a resumed session can deliver a stale one from before the gap.
    if (Number.isInteger(snap.k) && snap.k < stats.lastTick) { stats.dropped++; return null; }
    stats.lastTick = Number.isInteger(snap.k) ? snap.k : stats.lastTick;
    stats.lastMs = snap.ms | 0;
    stats.snaps++;

    const out = { time: (snap.ms | 0) / 1000, seats: [] };
    for (let srv = 0; srv < n; srv++) {
      const seat = readSeat(snap.p, srv);
      if (!seat) continue;
      const lp = srv2loc[srv];
      const p = state.players[lp];
      if (!p) continue;

      // Resources are always the server's. There is no prediction to protect
      // here — a counter that briefly reads one too high and then drops is
      // worse than one that lands a frame late.
      p.res.wood = seat.res.wood; p.res.brick = seat.res.brick;
      p.res.wool = seat.res.wool; p.res.wheat = seat.res.wheat;
      p.res.ore = seat.res.ore;

      out.seats.push({ local: lp, server: srv, ...seat });
      if (lp === 0 && opts2.keepLocalPosition) continue;
      p.x = seat.x; p.z = seat.z; p.facing = seat.facing; p.action = seat.action;
    }
    // The match clock is the server's, full stop. Everything timed off it —
    // hex regrowth, the soft cap, the HUD timer — has to agree across four
    // machines, and only one of them is allowed an opinion.
    state.time = out.time;
    return out;
  }

  return {
    applyEvent, applyEvents, applySnapshot,
    toLocal, toServer,
    get yourPid() { return yourPid; },
    get roster() { return roster; },
    seatOf: local => loc2srv[local],
    stats
  };
}

export default createMirror;
