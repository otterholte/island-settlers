/**
 * Island Settlers — match state + rules engine.
 *
 * Headless-safe: no three.js, no DOM. The 3D game and the offline pacing
 * simulator run the *same* code so tuning numbers actually means something.
 *
 * Everything that changes the match goes through a function here. Renderers
 * subscribe to `state.events` and turn those into animation and sound.
 */

import {
  RES, COST, PIECE_LIMIT, VICTORY_POINTS, START_RESOURCES,
  LONGEST_ROAD_MIN, LARGEST_ARMY_MIN, LONGEST_ROAD_VP, LARGEST_ARMY_VP,
  CARD_WEIGHTS, PLAYER_COLORS, BOT_PROFILES, PICKUP_RADIUS,
  TRADE_BASE, canAfford, pay, totalRes
} from './constants.js';
import { knightsOn } from './options.js';

import {
  tiles, intersections, edges, ports, SPAWNS, DESERT, edgeBetween
} from '../board/layout.js';

import {
  resetNodes, tickNodes, mulberry32,
  itemsNear, collectItem, isTileExhausted, tileItemsRemaining,
  tileItemCount, tileRegenSeconds, tileRecovery
} from '../board/nodes.js';

/* ==================================================================== state */

export function createMatch(opts = {}) {
  const rng = mulberry32(opts.seed ?? (Date.now() & 0xffffffff));
  resetNodes();

  const players = PLAYER_COLORS.map((c, i) => {
    const bot = i > 0 ? BOT_PROFILES[i - 1] : null;
    return {
      id: i,
      name: i === 0 ? 'You' : bot.name,
      isBot: i > 0,
      strategy: bot ? bot.strategy : 'human',
      color: c,
      res: { ...START_RESOURCES },
      roads: new Set(),
      settlements: new Set(),
      cities: new Set(),
      cards: [],            // {type, playable, used}
      knightsPlayed: 0,
      vpCards: 0,
      longestRoadLen: 0,
      hasLongestRoad: false,
      hasLargestArmy: false,
      ports: new Set(),     // port ids unlocked
      // world presence
      x: SPAWNS[i].x, z: SPAWNS[i].z, facing: SPAWNS[i].facing,
      vx: 0, vz: 0,
      // activity — there is no 'gather' action any more; pickup is contact.
      action: 'idle',       // idle | run | trade | build
      carried: 0,
      sweptAt: -1,          // match time of this player's last pickup sweep
      pickedAt: -1,         // match time of the last item they actually took
      blockedTile: -1,      // last region we complained about
      blockedAt: -99,
      // deprecated fields, kept so older presentation code reads a sane value
      gatherNode: null,
      gatherProgress: 0,
      gatherTime: 0,
      stats: { gathered: 0, traded: 0, built: 0, cardsPlayed: 0, distance: 0 }
    };
  });

  const state = {
    rng,
    phase: 'setup',        // setup | play | over
    time: 0,               // seconds since match start (play phase)
    setupOrder: [],        // filled by beginSetup
    setupIndex: 0,
    setupNeed: 'settlement',
    players,
    buildings: new Map(),  // intersectionId -> {owner, type:'settlement'|'city'}
    roadOwner: new Map(),  // edgeId -> playerId
    robberTile: DESERT.id,
    robberOwner: -1,
    longestRoadHolder: -1,
    largestArmyHolder: -1,
    winner: -1,
    events: [],            // consumed each frame by the presentation layer
    log: []
  };

  buildSetupOrder(state);
  return state;
}

export function emit(state, type, data = {}) {
  state.events.push({ type, t: state.time, ...data });
  if (state.events.length > 400) state.events.splice(0, 200);
}

export function drainEvents(state) {
  const e = state.events;
  state.events = [];
  return e;
}

/* ================================================================== scoring */

export function scoreOf(state, p) {
  return p.settlements.size
    + p.cities.size * 2
    + p.vpCards
    + (p.hasLongestRoad ? LONGEST_ROAD_VP : 0)
    + (p.hasLargestArmy ? LARGEST_ARMY_VP : 0);
}

export function rankings(state) {
  return state.players
    .map(p => ({ p, vp: scoreOf(state, p) }))
    .sort((a, b) => b.vp - a.vp
      || (b.p.cities.size - a.p.cities.size)
      || (b.p.settlements.size - a.p.settlements.size));
}

export function checkVictory(state) {
  if (state.phase !== 'play') return;
  for (const p of state.players) {
    if (scoreOf(state, p) >= VICTORY_POINTS) {
      state.phase = 'over';
      state.winner = p.id;
      emit(state, 'victory', { player: p.id });
      return;
    }
  }
}

/* ============================================================ placement law */

export function occupant(state, iid) {
  return state.buildings.get(iid) || null;
}

/** Distance rule: no building on a corner adjacent to another building. */
export function settlementLegal(state, pid, iid, setup = false) {
  if (state.buildings.has(iid)) return false;
  const node = intersections[iid];
  for (const nb of node.neighbors) if (state.buildings.has(nb)) return false;
  if (setup) return true;
  // Must touch one of your own roads.
  return node.edges.some(eid => state.roadOwner.get(eid) === pid);
}

export function roadLegal(state, pid, eid, setup = false, setupAnchor = -1) {
  if (state.roadOwner.has(eid)) return false;
  const e = edges[eid];
  if (setup) {
    return e.a === setupAnchor || e.b === setupAnchor;
  }
  for (const end of [e.a, e.b]) {
    const b = state.buildings.get(end);
    if (b && b.owner === pid) return true;
    // Connect through your own road, unless a rival building severs the corner.
    if (b && b.owner !== pid) continue;
    for (const oe of intersections[end].edges) {
      if (oe !== eid && state.roadOwner.get(oe) === pid) return true;
    }
  }
  return false;
}

export function cityLegal(state, pid, iid) {
  const b = state.buildings.get(iid);
  return !!b && b.owner === pid && b.type === 'settlement';
}

export function legalSettlements(state, pid, setup = false) {
  const out = [];
  for (const n of intersections) if (settlementLegal(state, pid, n.id, setup)) out.push(n.id);
  return out;
}

export function legalRoads(state, pid, setup = false, anchor = -1) {
  const out = [];
  for (const e of edges) if (roadLegal(state, pid, e.id, setup, anchor)) out.push(e.id);
  return out;
}

export function legalCities(state, pid) {
  const p = state.players[pid];
  return [...p.settlements].filter(i => cityLegal(state, pid, i));
}

/* ============================================================ build actions */

function unlockPort(state, p, iid) {
  const pid = intersections[iid].port;
  if (pid !== null && pid !== undefined && !p.ports.has(pid)) {
    p.ports.add(pid);
    emit(state, 'portUnlocked', { player: p.id, port: pid });
  }
}

export function placeSettlement(state, pid, iid, free = false) {
  const p = state.players[pid];
  if (p.settlements.size + p.cities.size >= PIECE_LIMIT.settlement) return false;
  const setup = state.phase === 'setup';
  if (!settlementLegal(state, pid, iid, setup)) return false;
  if (!free && !setup) {
    if (!canAfford(p.res, COST.settlement)) return false;
    pay(p.res, COST.settlement);
  }
  state.buildings.set(iid, { owner: pid, type: 'settlement', builtAt: state.time });
  p.settlements.add(iid);
  p.stats.built++;
  unlockPort(state, p, iid);
  emit(state, 'build', { player: pid, kind: 'settlement', at: iid });
  recomputeAwards(state);
  checkVictory(state);
  return true;
}

export function placeRoad(state, pid, eid, free = false, setupAnchor = -1) {
  const p = state.players[pid];
  if (p.roads.size >= PIECE_LIMIT.road) return false;
  const setup = state.phase === 'setup';
  if (!roadLegal(state, pid, eid, setup, setupAnchor)) return false;
  if (!free && !setup) {
    if (!canAfford(p.res, COST.road)) return false;
    pay(p.res, COST.road);
  }
  state.roadOwner.set(eid, pid);
  p.roads.add(eid);
  p.stats.built++;
  emit(state, 'build', { player: pid, kind: 'road', at: eid });
  recomputeAwards(state);
  checkVictory(state);
  return true;
}

export function upgradeCity(state, pid, iid, free = false) {
  const p = state.players[pid];
  if (p.cities.size >= PIECE_LIMIT.city) return false;
  if (!cityLegal(state, pid, iid)) return false;
  if (!free) {
    if (!canAfford(p.res, COST.city)) return false;
    pay(p.res, COST.city);
  }
  state.buildings.set(iid, { owner: pid, type: 'city', builtAt: state.time });
  p.settlements.delete(iid);
  p.cities.add(iid);
  p.stats.built++;
  emit(state, 'build', { player: pid, kind: 'city', at: iid });
  checkVictory(state);
  return true;
}

/* ============================================================== longest road */

/** Longest simple path of a player's road network, honouring rival buildings
 *  which sever a chain at that corner. Depth-first over edges. */
export function longestRoadFor(state, pid) {
  const own = [...state.players[pid].roads];
  if (!own.length) return 0;
  const ownSet = new Set(own);

  const blocked = (iid) => {
    const b = state.buildings.get(iid);
    return !!b && b.owner !== pid;
  };

  let best = 0;
  const visit = (edgeId, atNode, used) => {
    if (used.size > best) best = used.size;
    if (blocked(atNode)) return;
    for (const nx of intersections[atNode].edges) {
      if (!ownSet.has(nx) || used.has(nx)) continue;
      const e = edges[nx];
      const far = e.a === atNode ? e.b : e.a;
      used.add(nx);
      visit(nx, far, used);
      used.delete(nx);
    }
  };

  for (const startEdge of own) {
    const e = edges[startEdge];
    for (const start of [e.a, e.b]) {
      const far = e.a === start ? e.b : e.a;
      const used = new Set([startEdge]);
      visit(startEdge, far, used);
    }
  }
  return best;
}

export function recomputeAwards(state) {
  // Longest Road
  let bestLen = LONGEST_ROAD_MIN - 1, bestPid = -1;
  for (const p of state.players) {
    p.longestRoadLen = longestRoadFor(state, p.id);
    if (p.longestRoadLen > bestLen) { bestLen = p.longestRoadLen; bestPid = p.id; }
  }
  // Incumbent keeps it on a tie.
  const cur = state.longestRoadHolder;
  if (cur >= 0 && state.players[cur].longestRoadLen >= bestLen) bestPid = cur;
  if (bestPid !== cur) {
    state.players.forEach(p => (p.hasLongestRoad = p.id === bestPid));
    state.longestRoadHolder = bestPid;
    if (bestPid >= 0) emit(state, 'award', { kind: 'longestRoad', player: bestPid, value: bestLen });
    else emit(state, 'awardLost', { kind: 'longestRoad' });
  }

  // Largest Army
  let bestArmy = LARGEST_ARMY_MIN - 1, armyPid = -1;
  for (const p of state.players) {
    if (p.knightsPlayed > bestArmy) { bestArmy = p.knightsPlayed; armyPid = p.id; }
  }
  const curA = state.largestArmyHolder;
  if (curA >= 0 && state.players[curA].knightsPlayed >= bestArmy) armyPid = curA;
  if (armyPid !== curA) {
    state.players.forEach(p => (p.hasLargestArmy = p.id === armyPid));
    state.largestArmyHolder = armyPid;
    if (armyPid >= 0) emit(state, 'award', { kind: 'largestArmy', player: armyPid, value: bestArmy });
  }
}

/* ================================================================ gathering
 *
 * Contact pickup. A settler standing within PICKUP_RADIUS of an item takes it
 * that frame — no timer, no latch, no state to get stuck in. The only gate is
 * ownership: you may work a hex if, and only if, you own a settlement or a city
 * on one of its corners. Anywhere else yields nothing at all.
 *
 * `sweepPickups` is the ONE way a resource enters a player's hand from the
 * ground, for the human and for the bots alike, so the simulator's conservation
 * audit has something honest to check.
 */

/** Does this player own a building on a corner of this hex? */
export function playerOwnsTile(state, pid, tileId) {
  const t = tiles[tileId];
  if (!t) return false;
  for (const c of t.corners) {
    const b = state.buildings.get(c);
    if (b && b.owner === pid) return true;
  }
  return false;
}

/** Every hex this player may work. */
export function ownedTiles(state, pid) {
  const out = new Set();
  const p = state.players[pid];
  for (const iid of p.settlements) for (const tid of intersections[iid].tiles) out.add(tid);
  for (const iid of p.cities) for (const tid of intersections[iid].tiles) out.add(tid);
  return out;
}

export function knightBlocks(state, pid, tileId) {
  // Switched off for this match: nothing blocks anything, whatever the board
  // happens to say. Belt and braces — with no Knights in the deck the Knight
  // never leaves the desert, and the desert yields nothing to anybody anyway —
  // but a restored or replayed match must not be able to strand a live block.
  if (!knightsOn()) return false;
  // The player who last moved the Knight may still work the blocked region.
  return state.robberTile === tileId && state.robberOwner !== pid;
}

/**
 * May this player collect on this hex at all? Ownership + the Knight.
 * Whether the hex currently HAS anything is `isTileExhausted` / the item flags.
 */
export function canGatherTile(state, pid, tileId) {
  const t = tiles[tileId];
  if (!t || !t.resource) return false;
  if (!playerOwnsTile(state, pid, tileId)) return false;
  return !knightBlocks(state, pid, tileId);
}

/** Rate-limited "you get nothing here" note, for the human only. */
function noteBlocked(state, pid, tileId) {
  if (pid !== 0) return;
  const p = state.players[pid];
  if (p.blockedTile === tileId && state.time - p.blockedAt < 2.5) return;
  p.blockedTile = tileId;
  p.blockedAt = state.time;
  emit(state, 'blocked', {
    player: pid, tile: tileId,
    reason: knightBlocks(state, pid, tileId) ? 'knight' : 'unowned'
  });
}

const _sweepBuf = [];

/**
 * Collect everything this settler is touching.
 *
 * Returns the number of items taken, or -1 if somebody already swept this
 * player at this exact instant — that is how `bots.js` knows to defer to
 * `systems/gathering.js` instead of double-collecting.
 */
export function sweepPickups(state, pid, radius = PICKUP_RADIUS) {
  const p = state.players[pid];
  if (!p || state.phase !== 'play') return 0;
  if (p.sweptAt === state.time) return -1;
  p.sweptAt = state.time;

  const near = itemsNear(p.x, p.z, radius, _sweepBuf);
  if (!near.length) return 0;

  let got = 0;
  for (let i = 0; i < near.length; i++) {
    const it = near[i];
    if (!it.available) continue;
    if (!canGatherTile(state, pid, it.tile)) { noteBlocked(state, pid, it.tile); continue; }
    const spent = collectItem(it, state.time, pid);
    p.res[it.resource] += 1;
    p.carried += 1;
    p.stats.gathered += 1;
    p.pickedAt = state.time;
    got++;
    emit(state, 'gained', {
      player: pid, resource: it.resource, amount: 1,
      x: it.x, z: it.z, item: it.id, tile: it.tile,
      node: it.legacyNode, depleted: spent
    });
    if (spent) {
      emit(state, 'exhausted', {
        tile: it.tile, player: pid, seconds: tileRegenSeconds(it.tile)
      });
    }
  }
  return got;
}

/**
 * @deprecated ownership no longer multiplies a yield — it gates it outright.
 * Returns 1 where this player may collect and 0 where they may not. Kept only
 * so `src/world/regions.js` keeps importing while the world layer is rebuilt;
 * delete it once nothing outside this file references it.
 */
export function ownershipMultiplier(state, pid, tileId) {
  return canGatherTile(state, pid, tileId) ? 1 : 0;
}

export { tileRecovery, tileItemsRemaining, tileItemCount, tileRegenSeconds, isTileExhausted };

/* ==================================================================== trade */

export function tradeRatio(state, pid, give) {
  const p = state.players[pid];
  let best = TRADE_BASE;
  for (const portId of p.ports) {
    const port = ports[portId];
    if (port.kind === 'generic') best = Math.min(best, port.ratio);
    else if (port.resource === give) best = Math.min(best, port.ratio);
  }
  return best;
}

/** Ratio available *right now*, which also depends on standing near a dock. */
export function activeTradeRatio(state, pid, give, atPort = null) {
  if (atPort !== null && atPort !== undefined) {
    const port = ports[atPort];
    if (!state.players[pid].ports.has(atPort)) return TRADE_BASE;
    if (port.kind === 'generic') return port.ratio;
    if (port.resource === give) return port.ratio;
    return TRADE_BASE;
  }
  return TRADE_BASE;
}

export function doTrade(state, pid, give, get, ratio) {
  const p = state.players[pid];
  if (give === get) return false;
  if ((p.res[give] || 0) < ratio) return false;
  p.res[give] -= ratio;
  p.res[get] = (p.res[get] || 0) + 1;
  p.stats.traded++;
  emit(state, 'trade', { player: pid, give, get, ratio });
  return true;
}

/* ============================================================== dev cards */

export function drawCard(state, pid, free = false) {
  const p = state.players[pid];
  if (!free) {
    if (!canAfford(p.res, COST.card)) return null;
    pay(p.res, COST.card);
  }
  /*
   * Pick a type from the weight table, over only the types this match is
   * actually playing.
   *
   * With Knights switched off (`core/options.js`) the Knight leaves the deck
   * entirely, and what is left is re-normalised — otherwise the 0.5 the Knight
   * held would be a hole in the distribution and every roll landing in it would
   * fall through to the loop's default. That default used to be the string
   * 'knight', which was already a latent bug: any float drift that left `acc`
   * short of 1 handed out a Knight for free. It is now the last surviving type,
   * and the roll is scaled to the real total, so neither can happen.
   */
  const table = [];
  let total = 0;
  for (const k in CARD_WEIGHTS) {
    if (k === 'knight' && !knightsOn()) continue;
    const w = CARD_WEIGHTS[k];
    if (!(w > 0)) continue;
    table.push([k, w]);
    total += w;
  }
  if (!table.length) return null;
  let roll = state.rng() * total;
  let type = table[table.length - 1][0];
  for (const [k, w] of table) {
    roll -= w;
    if (roll <= 0) { type = k; break; }
  }
  const card = { type, id: `${pid}-${state.time.toFixed(2)}-${Math.floor(state.rng() * 1e6)}` };
  /*
   * `card`, NOT `type`. `emit` builds `{ type, t, ...data }`, so a payload with
   * its own `type` overwrites the event's — and this one did. Every card draw
   * has therefore been emitted under the CARD's name rather than 'cardDrawn'
   * since the day it was written, which had two consequences nobody had chased:
   * no listener anywhere ever heard 'cardDrawn' (main.js has a case for it that
   * could not fire, and so the draw sound never played), and DRAWING a Knight
   * emitted `{type:'knight'}` — indistinguishable from PLAYING one, which is
   * how a card purchase could raise the raid card with no losses on it.
   *
   * The field is renamed rather than the emit re-ordered: `{...data, type}`
   * would fix this one and leave the same trap set for the next payload.
   */
  if (type === 'victoryPoint') {
    p.vpCards++;
    emit(state, 'cardDrawn', { player: pid, card: type, instant: true });
    checkVictory(state);
    return card;
  }
  p.cards.push(card);
  emit(state, 'cardDrawn', { player: pid, card: type, instant: false });
  return card;
}

export function playKnight(state, pid, targetTile) {
  const p = state.players[pid];
  const idx = p.cards.findIndex(c => c.type === 'knight');
  if (idx < 0) return false;
  p.cards.splice(idx, 1);
  p.knightsPlayed++;
  p.stats.cardsPlayed++;
  state.robberTile = targetTile;
  state.robberOwner = pid;

  const losses = [];
  for (const o of state.players) {
    if (o.id === pid) continue;
    const lost = {};
    let any = 0;
    for (const r of RES) {
      // Half of every resource type, ROUNDED UP, off every rival at once.
      //
      // The round-up lands on each of the five types independently, so the real
      // bite is a good deal more than "half": a rival holding 5 of everything
      // loses 3 of each and keeps 40%, and an odd single unit is always lost
      // whole. Destroyed, not stolen — nothing is credited to `p`. There is no
      // card-count threshold, and this is the ONLY mechanic in the game that
      // takes back a resource somebody has already banked.
      //
      // The per-player breakdown below rides out on the `knight` event and is
      // drawn by `ui/hud-raid.js`. For a long time nothing read it, and a bot
      // Knighting the human out of most of their pack arrived as a horn and
      // five counters quietly dropping — which left the player unsure the
      // mechanic existed at all.
      const drop = Math.min(o.res[r], Math.ceil(o.res[r] / 2));
      o.res[r] -= drop; any += drop; lost[r] = drop;
    }
    if (any) losses.push({ player: o.id, lost, total: any });
    o.carried = 0;
  }
  emit(state, 'knight', { player: pid, tile: targetTile, losses });
  recomputeAwards(state);
  checkVictory(state);
  return true;
}

export function playRoadBuilding(state, pid) {
  const p = state.players[pid];
  const idx = p.cards.findIndex(c => c.type === 'roadBuilding');
  if (idx < 0) return false;
  p.cards.splice(idx, 1);
  p.stats.cardsPlayed++;
  p.freeRoads = (p.freeRoads || 0) + 2;
  emit(state, 'roadBuilding', { player: pid, free: p.freeRoads });
  return true;
}

export function hasCard(p, type) { return p.cards.some(c => c.type === type); }

/* ==================================================================== setup */

/**
 * Seat the snake draft.
 *
 * The seating is shuffled every match, so `players[0]` — the human — drafts
 * from wherever the shuffle put them rather than always opening the board.
 * The structure is untouched: one forward pass, one reverse pass, two picks
 * each, `setupIndex >= players.length` still means "second round".
 *
 * Headless-safe: the only randomness is `state.rng` (mulberry32), so a seeded
 * match still replays identically and tools/simulate.mjs is unaffected.
 */
export function buildSetupOrder(state) {
  const n = state.players.length;
  const fwd = [...Array(n).keys()];
  const rnd = typeof state.rng === 'function' ? state.rng : Math.random;
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1)) % (i + 1);
    const t = fwd[i]; fwd[i] = fwd[j]; fwd[j] = t;
  }
  state.setupOrder = [...fwd, ...fwd.slice().reverse()];
  state.setupIndex = 0;
  state.setupNeed = 'settlement';
  state.setupAnchor = -1;
  return state.setupOrder;
}

/** Which pick numbers (0-based, into `setupOrder`) belong to a player. */
export function setupSlotsOf(state, pid) {
  const out = [];
  const order = state.setupOrder || [];
  for (let i = 0; i < order.length; i++) if (order[i] === pid) out.push(i);
  return out;
}

export function setupCurrentPlayer(state) {
  if (state.phase !== 'setup') return -1;
  return state.setupOrder[state.setupIndex] ?? -1;
}

/** Advance the snake draft. Returns true when setup has finished. */
export function setupAdvance(state) {
  if (state.setupNeed === 'settlement') {
    state.setupNeed = 'road';
    return false;
  }
  state.setupNeed = 'settlement';
  state.setupAnchor = -1;
  state.setupIndex++;
  if (state.setupIndex >= state.setupOrder.length) {
    state.phase = 'play';
    state.time = 0;
    emit(state, 'setupComplete', {});
    return true;
  }
  return false;
}

export function setupPlaceSettlement(state, pid, iid) {
  const second = state.setupIndex >= state.players.length;
  if (!placeSettlement(state, pid, iid, true)) return false;
  state.setupAnchor = iid;
  // The second placement grants its adjacent resources, as in the tabletop game.
  if (second) {
    const p = state.players[pid];
    for (const tid of intersections[iid].tiles) {
      const t = tiles[tid];
      if (t.resource) p.res[t.resource] += 1;
    }
  }
  setupAdvance(state);
  return true;
}

export function setupPlaceRoad(state, pid, eid) {
  if (!placeRoad(state, pid, eid, true, state.setupAnchor)) return false;
  setupAdvance(state);
  return true;
}

/* ============================================================== world tick */

export function tickWorld(state, dt) {
  if (state.phase !== 'play') return;
  state.time += dt;
  const back = tickNodes(state.time);
  for (let i = 0; i < back.length; i++) emit(state, 'restored', { tile: back[i] });
}

/* ================================================================ helpers */

export function affordable(state, pid, kind) {
  return canAfford(state.players[pid].res, COST[kind]);
}

export function playerAt(state, x, z, ignore = -1, radius = 2.0) {
  for (const p of state.players) {
    if (p.id === ignore) continue;
    if (Math.hypot(p.x - x, p.z - z) < radius) return p;
  }
  return null;
}

export function nearestPortFor(state, pid, x, z, radius) {
  const p = state.players[pid];
  let best = null, bd = radius * radius;
  for (const id of p.ports) {
    const port = ports[id];
    const d = (port.x - x) ** 2 + (port.z - z) ** 2;
    if (d < bd) { bd = d; best = port; }
  }
  return best;
}

export { RES, COST, VICTORY_POINTS, totalRes };
