/**
 * Island Settlers — bot evaluation brain.
 *
 * Pure logic: no three.js, no DOM, no mutation of match state except the
 * momentary, self-reverting probe inside `chooseRoad` (a road is added to a
 * Set, measured, and removed again before the function returns).
 *
 * Everything here answers *"what is this worth?"* questions. `bots.js` owns
 * the "when do I move and which rules call do I make" side.
 *
 * Owner: Bots agent.
 */

import {
  RES, COST, PIECE_LIMIT, VICTORY_POINTS,
  LONGEST_ROAD_MIN, LARGEST_ARMY_MIN,
  TRADE_BASE, BOT_SPEED, tileRateFor,
  missingFrom, canAfford
} from '../core/constants.js';

import {
  tiles, intersections, edges, ports, MARKET, tileAt
} from '../board/layout.js';

import {
  nearestItem, tileItemsRemaining, tileItemCount, tileRecovery
} from '../board/nodes.js';

import {
  legalSettlements, legalRoads, legalCities,
  longestRoadFor, scoreOf, canGatherTile, ownedTiles
} from '../core/rules.js';

import { difficultyParams } from './difficulty.js';

/**
 * Difficulty block in force for this call. Callers that know better (bots.js,
 * which may be running one brain on a different profile from the rest) pass
 * `ctx.d`; everyone else — the opening draft in flowDraft.js, for instance —
 * gets whatever the player picked on the title screen.
 */
const dOf = ctx => (ctx && ctx.d) || difficultyParams();

/* ---------------------------------------------------------------- gathering
 * Ownership is now a hard gate, so "how much land do I work" IS the economy.
 * Everything below scores land in items-per-second rather than pips, and a
 * corner that only re-covers hexes you already own is worth very little.
 */

/** Roughly how long it takes to run from one item to the next inside a hex. */
export const SWEEP_SEC = 0.24;

/** Sustained supply, per resource, from a set of tile ids. */
function rateOf(tileId) { return tileRateFor(tiles[tileId].pips); }

// Land scores are quoted on the old 1..5 "pips" scale so the rest of the
// heuristics keep their feel: a 5-pip hex rates ~1.2 items/s, a 1-pip hex ~0.33.
const RATE_TO_SCORE = 5.5;

/* ===================================================== strategic personality */

/** Per-strategy appetite for each resource, folded into placement scoring. */
export const AFFINITY = {
  expansion: { wood: 1.40, brick: 1.40, wheat: 1.00, wool: 1.00, ore: 0.80 },
  cities:    { wood: 0.88, brick: 0.88, wheat: 1.45, wool: 0.95, ore: 1.50 },
  cards:     { wood: 0.88, brick: 0.88, wheat: 1.25, wool: 1.35, ore: 1.35 },
  human:     { wood: 1, brick: 1, wheat: 1, wool: 1, ore: 1 }
};

/**
 * Per-strategy purchase priorities. Land is the economy now, so every identity
 * has to buy some — the difference is what they do with it. Alex sprawls and
 * chases the road trophy, Maya claims fewer, better corners and upgrades them,
 * Finn buys land to feed the card engine and raids whoever is ahead.
 */
export const WEIGHTS = {
  expansion: { settlement: 1.05, city: 0.95, road: 1.60, card: 0.62 },
  cities:    { settlement: 1.30, city: 1.55, road: 0.90, card: 0.58 },
  cards:     { settlement: 1.00, city: 0.92, road: 0.74, card: 1.32 },
  human:     { settlement: 1, city: 1, road: 1, card: 1 }
};

export const affinityOf = s => AFFINITY[s] || AFFINITY.human;
export const weightsOf = s => WEIGHTS[s] || WEIGHTS.human;

/* ============================================== standing spots (precomputed) */

/**
 * Walk from a known-land anchor toward `target` and return the furthest point
 * along that ray that is still on the island, pulled back by `back` units.
 * Used so a bot never has to stand in the sea to reach a corner or a dock.
 */
function landward(tx, tz, cx, cz, back) {
  const segLen = Math.hypot(tx - cx, tz - cz) || 1;
  let lo = 0, hi = 1;
  if (tileAt(tx, tz)) lo = 1;
  else {
    for (let i = 0; i < 26; i++) {
      const m = (lo + hi) / 2;
      if (tileAt(cx + (tx - cx) * m, cz + (tz - cz) * m)) lo = m; else hi = m;
    }
  }
  const t = Math.max(0, lo - back / segLen);
  return { x: cx + (tx - cx) * t, z: cz + (tz - cz) * t };
}

function nearestTileTo(x, z) {
  let best = tiles[0], bd = Infinity;
  for (const t of tiles) {
    const d = (t.x - x) * (t.x - x) + (t.z - z) * (t.z - z);
    if (d < bd) { bd = d; best = t; }
  }
  return best;
}

/** Where a settler stands to build on intersection `iid`. */
export const INTERSECTION_SPOT = intersections.map(n => {
  const t = nearestTileTo(n.x, n.z);
  return landward(n.x, n.z, t.x, t.z, 1.15);
});

/** Where a settler stands to lay road `eid`. */
export const EDGE_SPOT = edges.map(e => {
  const t = tiles[e.tiles[0]];
  return landward(e.x, e.z, t.x, t.z, 0.85);
});

/** Where a settler stands to use dock `portId` — inside TRADE_RADIUS of it. */
export const PORT_SPOT = ports.map(p => {
  const t = tiles[edges[p.edge].tiles[0]];
  return landward(p.x, p.z, t.x, t.z, 0.15);
});

export const MARKET_SPOT = { x: MARKET.x, z: MARKET.z };

/** Sanity data for the verifier / simulator. */
export const PORT_SPOT_REACH = ports.map((p, i) =>
  Math.hypot(PORT_SPOT[i].x - p.x, PORT_SPOT[i].z - p.z));

/* ============================================================= board reading */

/**
 * Sustained supply, in items per second, that this player can actually reach —
 * i.e. only from hexes they own a corner on. Duplicate corners on the same hex
 * add nothing, because a hex is not worked twice as fast for being touched
 * twice.
 */
export function productionOf(state, pid) {
  const out = { wood: 0, brick: 0, wool: 0, wheat: 0, ore: 0 };
  for (const tid of ownedTiles(state, pid)) {
    const t = tiles[tid];
    if (t.resource) out[t.resource] += rateOf(tid);
  }
  return out;
}

/**
 * How good is this corner for this player, right now?
 *
 * The dominant term is NEW LAND: hexes this corner would unlock that the player
 * cannot already work. Re-touching a hex you already own buys you nothing but a
 * shorter walk, so it is worth a fraction. Then diversity, scarcity of what it
 * supplies, port access, minus crowding.
 */
export function intersectionScore(state, pid, iid, prod, aff, owned = null) {
  const n = intersections[iid];
  const mine = owned || ownedTiles(state, pid);
  let s = 0;
  const kinds = new Set();
  let fresh = 0;
  for (const tid of n.tiles) {
    const t = tiles[tid];
    if (!t.resource) { s += 0.4; continue; }   // desert corner: market adjacency
    const isNew = !mine.has(tid);
    const have = prod[t.resource] || 0;
    // Nothing at all of this resource is a crisis: without a hex you can only
    // trade 4:1 for it.
    const scarce = have <= 0.001 ? 2.6 : have < 0.5 ? 1.35 : 0.9;
    const gain = rateOf(tid) * RATE_TO_SCORE * (aff[t.resource] || 1) * scarce;
    s += isNew ? gain : gain * 0.22;
    if (isNew) { fresh++; kinds.add(t.resource); }
  }
  s += kinds.size * 2.4;
  s += fresh * 1.6;
  if (n.tiles.length < 3) s -= 1.8;          // coastal corners work fewer hexes

  const pt = n.port;
  if (pt !== null && pt !== undefined) {
    const port = ports[pt];
    s += port.kind === 'generic' ? 2.2 : (kinds.has(port.resource) ? 3.8 : 1.3);
  }

  let rivals = 0;
  for (const tid of n.tiles) {
    for (const c of tiles[tid].corners) {
      const b = state.buildings.get(c);
      if (b && b.owner !== pid) rivals += b.type === 'city' ? 1.6 : 1.0;
    }
  }
  s -= rivals * 0.85;
  return s;
}

/**
 * Value of turning a settlement into a city. A city no longer gathers faster —
 * ownership is binary — so this is a pure victory-point play, sweetened a
 * little by holding good land against a rival Raider.
 */
export function cityScore(state, pid, iid, aff) {
  const n = intersections[iid];
  let s = 4;
  for (const tid of n.tiles) {
    const t = tiles[tid];
    if (!t.resource) continue;
    s += rateOf(tid) * RATE_TO_SCORE * 0.45 * (aff[t.resource] || 1);
  }
  return s;
}

/* ==================================================================== roads */

/**
 * Best legal road for this player: prefers segments that open a strong new
 * intersection, reach an unowned port, or extend the Longest Road.
 * Returns { id, score, len, spot } or null.
 */
export function chooseRoad(state, pid, fromX, fromZ, ctx = {}) {
  const p = state.players[pid];
  if (p.roads.size >= PIECE_LIMIT.road) return null;
  const legal = ctx.legalRoads || legalRoads(state, pid);
  if (!legal.length) return null;

  const aff = ctx.aff || affinityOf(p.strategy);
  const prod = ctx.prod || productionOf(state, pid);
  const owned = ctx.owned || ownedTiles(state, pid);
  const jitter = ctx.jitter || (() => 0);
  const awardK = dOf(ctx).award;
  const openSpot = (iid) => !state.buildings.has(iid)
    && !intersections[iid].neighbors.some(nb => state.buildings.has(nb));

  const prelim = [];
  for (const eid of legal) {
    const e = edges[eid];
    let best = 0;
    for (const end of [e.a, e.b]) {
      const other = end === e.a ? e.b : e.a;
      if (openSpot(end)) {
        best = Math.max(best, 9 + intersectionScore(state, pid, end, prod, aff, owned) * 0.55);
      } else {
        for (const nb of intersections[end].neighbors) {
          if (nb === other || state.buildings.has(nb)) continue;
          if (!openSpot(nb)) continue;
          best = Math.max(best, 2.4 + intersectionScore(state, pid, nb, prod, aff, owned) * 0.30);
        }
      }
      const pt = intersections[end].port;
      if (pt !== null && pt !== undefined && !p.ports.has(pt)) best += 1.3;
    }
    const dist = Math.hypot(e.x - fromX, e.z - fromZ);
    prelim.push({ id: eid, base: best - dist * 0.085 + jitter(1.2) });
  }

  prelim.sort((a, b) => b.base - a.base);
  const K = Math.min(10, prelim.length);
  const holder = state.longestRoadHolder;
  const holderLen = holder >= 0 ? state.players[holder].longestRoadLen : LONGEST_ROAD_MIN - 1;
  const roadW = weightsOf(p.strategy).road;
  let rivalBest = 0;
  for (const o of state.players) {
    if (o.id !== pid) rivalBest = Math.max(rivalBest, o.longestRoadLen);
  }

  let best = null;
  for (let i = 0; i < K; i++) {
    const c = prelim[i];
    p.roads.add(c.id);
    const len = longestRoadFor(state, pid);   // probe
    p.roads.delete(c.id);

    // The award chase is tracked separately so the caller can weigh it against
    // a settlement without the general "don't waste wood on roads" damping.
    let award = 0;
    if (len > p.longestRoadLen) {
      if (holder !== pid && len >= LONGEST_ROAD_MIN && len > holderLen) {
        award = 16 * roadW;                          // take the trophy now
      } else if (holder === pid) {
        // Defend: extend once a rival is within one segment of taking it.
        award = rivalBest >= p.longestRoadLen - 1 ? 8 * roadW : 1.2;
      } else {
        award = 3.0 * roadW * Math.min(len, LONGEST_ROAD_MIN) / LONGEST_ROAD_MIN
              + (len >= holderLen - 1 ? 5 * roadW : 0);   // closing in
      }
    }
    // An easier bot barely notices the trophies, so it spends its wood on
    // whatever is nearest instead of on a five-segment highway.
    award *= awardK;
    const s = c.base + award;
    if (!best || s > best.score) {
      best = { id: c.id, score: s, award, len, spot: EDGE_SPOT[c.id] };
    }
  }
  return best;
}

/* ================================================================ purchases */

/**
 * Which purchase is this bot working toward right now?
 * Returns { kind, target, score, spot } — target is an intersection or edge id
 * (null for a card).
 */
export function choosePurchase(state, pid, fromX, fromZ, ctx = {}) {
  const p = state.players[pid];
  const aff = ctx.aff || affinityOf(p.strategy);
  const W = weightsOf(p.strategy);
  const prod = ctx.prod || productionOf(state, pid);
  const owned = ctx.owned || ownedTiles(state, pid);
  const jitter = ctx.jitter || (() => 0);
  const d = dOf(ctx);
  const vp = scoreOf(state, p);
  const toWin = VICTORY_POINTS - vp;
  // Within one point of the trophy, take the shortest path to VP — unless this
  // bot is too green to notice it is about to win.
  const endgame = !d.endgame ? 1 : toWin <= 1 ? 1.9 : toWin <= 2 ? 1.25 : 1;

  const out = [];

  /* ---- settlement ---- */
  if (p.settlements.size + p.cities.size < PIECE_LIMIT.settlement) {
    const legal = legalSettlements(state, pid);
    let bi = -1, bs = -Infinity;
    for (const iid of legal) {
      const s = intersectionScore(state, pid, iid, prod, aff, owned)
        - Math.hypot(intersections[iid].x - fromX, intersections[iid].z - fromZ) * 0.05
        + jitter(1.5);
      if (s > bs) { bs = s; bi = iid; }
    }
    if (bi >= 0) {
      out.push({
        kind: 'settlement', target: bi, spot: INTERSECTION_SPOT[bi],
        score: (17 + bs * 0.5) * W.settlement * endgame
      });
    }
  }

  /* ---- city ---- */
  if (p.cities.size < PIECE_LIMIT.city) {
    const legal = ctx.legalCities || legalCities(state, pid);
    let bi = -1, bs = -Infinity;
    for (const iid of legal) {
      const s = cityScore(state, pid, iid, aff)
        - Math.hypot(intersections[iid].x - fromX, intersections[iid].z - fromZ) * 0.05
        + jitter(1.5);
      if (s > bs) { bs = s; bi = iid; }
    }
    if (bi >= 0) {
      out.push({
        kind: 'city', target: bi, spot: INTERSECTION_SPOT[bi],
        score: (16 + bs * 0.55) * W.city * endgame
      });
    }
  }

  /* ---- road ---- */
  const rd = chooseRoad(state, pid, fromX, fromZ, { aff, prod, owned, jitter, d });
  if (rd) {
    // A road is only worth buying when it opens something or chases the award;
    // otherwise it burns the wood/brick a settlement wants. Chasing Longest
    // Road is exempt from that damping — that trophy is worth the detour.
    const hasSpot = out.some(o => o.kind === 'settlement');
    const damp = hasSpot ? 0.6 : 1.25;
    out.push({
      kind: 'road', target: rd.id, spot: rd.spot,
      score: (rd.score - rd.award) * W.road * damp + rd.award * W.road
    });
  }

  /* ---- development card ---- */
  {
    const army = p.knightsPlayed;
    const armyHolder = state.largestArmyHolder;
    const armyLen = armyHolder >= 0 ? state.players[armyHolder].knightsPlayed : LARGEST_ARMY_MIN - 1;
    let s = 12;
    if (armyHolder !== pid && army + 1 > armyLen && army + 1 >= LARGEST_ARMY_MIN) s += 9 * d.award;
    else if (armyHolder !== pid && army + 2 >= LARGEST_ARMY_MIN) s += 4 * d.award;
    if (toWin <= 2 && d.endgame) s += 3;            // victory-point cards
    s += Math.hypot(MARKET.x - fromX, MARKET.z - fromZ) * -0.05;
    out.push({ kind: 'card', target: null, spot: MARKET_SPOT, score: (s + jitter(2)) * W.card });
  }

  if (!out.length) return null;
  out.sort((a, b) => b.score - a.score);
  const pick = out[0];
  pick.cost = COST[pick.kind];
  pick.options = out;
  return pick;
}

/* ================================================================== trading */

/** Ratio this player would actually get at a given venue (null = market). */
export function venueRatio(state, pid, give, portId) {
  if (portId === null || portId === undefined) return TRADE_BASE;
  const p = state.players[pid];
  if (!p.ports.has(portId)) return TRADE_BASE;
  const port = ports[portId];
  if (port.kind === 'generic') return port.ratio;
  return port.resource === give ? port.ratio : TRADE_BASE;
}

/** Greedily work out a sequence of swaps that completes `cost`. */
function simulateTrades(res, cost, ratioFn) {
  const bank = { ...res };
  const trades = [];
  for (let guard = 0; guard < 10; guard++) {
    const need = missingFrom(bank, cost);
    const keys = Object.keys(need);
    if (!keys.length) return trades;
    const get = keys[0];
    let give = null, ratio = 0, bestV = -Infinity;
    for (const r of RES) {
      if (r === get) continue;
      const rr = ratioFn(r);
      const spare = (bank[r] || 0) - (cost[r] || 0);
      if (spare < rr) continue;
      const v = (spare - rr) * 1.0 + (TRADE_BASE - rr) * 2.0;
      if (v > bestV) { bestV = v; give = r; ratio = rr; }
    }
    if (!give) return null;
    bank[give] -= ratio;
    bank[get] = (bank[get] || 0) + 1;
    trades.push({ give, get, ratio });
  }
  return null;
}

/**
 * Cheapest place to trade our way into `cost`, or null if we can't.
 * Returns { portId, x, z, trades, given, eta }.
 */
export function planTrade(state, pid, cost, fromX, fromZ) {
  const p = state.players[pid];
  if (canAfford(p.res, cost)) return null;

  // `x,z` is where the settler stands; `vx,vz` is the dock itself, which is
  // what TRADE_RADIUS is measured against.
  const venues = [{
    portId: null,
    x: MARKET_SPOT.x, z: MARKET_SPOT.z, vx: MARKET.x, vz: MARKET.z
  }];
  for (const id of p.ports) {
    venues.push({
      portId: id,
      x: PORT_SPOT[id].x, z: PORT_SPOT[id].z, vx: ports[id].x, vz: ports[id].z
    });
  }

  let best = null;
  for (const v of venues) {
    const trades = simulateTrades(p.res, cost, r => venueRatio(state, pid, r, v.portId));
    if (!trades || !trades.length) continue;
    const given = trades.reduce((s, t) => s + t.ratio, 0);
    const travel = Math.hypot(v.x - fromX, v.z - fromZ) / BOT_SPEED;
    // Resources burned count against the plan — 4:1 at the market is painful,
    // a 2:1 port on something we are drowning in usually is not.
    const eta = travel + trades.length * 0.3 + given * 0.5;
    if (!best || eta < best.eta) {
      best = { portId: v.portId, x: v.x, z: v.z, vx: v.vx, vz: v.vz, trades, given, eta };
    }
  }
  return best;
}

/* ================================================================ gathering */

/** Is a rival settler already sweeping this hex? */
function contested(state, pid, tileId) {
  for (const o of state.players) {
    if (o.id === pid) continue;
    const t = tileAt(o.x, o.z);
    if (t && t.id === tileId) return true;
  }
  return false;
}

/**
 * Which of MY hexes should I go and sweep?
 *
 * A hex is a field, not a node: once you are standing on it you scoop roughly
 * one item every SWEEP_SEC until it is bare. So the sum that matters is
 *   (useful items left) / (run there + sweep them up).
 *
 * With `includeExhausted` a bare hex of ours is still a candidate, valued by how
 * soon it comes back — which is how a bot learns to walk over and wait for the
 * forest to grow rather than standing in the market doing nothing.
 *
 * Returns { tile, items, x, z, eta, value, perSecond, wait } or null.
 */
export function chooseHarvestTile(state, pid, weights, fromX, fromZ,
                                  avoid = null, includeExhausted = false,
                                  opts = {}) {
  const slop = opts.slop || 0;
  const rand = opts.rand || Math.random;
  const pool = slop > 0 ? [] : null;
  let best = null, bestV = 0;
  for (const t of tiles) {
    if (!t.resource) continue;
    if (avoid && avoid.has(t.id)) continue;
    if (!canGatherTile(state, pid, t.id)) continue;
    const w = weights[t.resource] || 0;
    if (w <= 0) continue;

    const left = tileItemsRemaining(t.id);
    const travel = Math.hypot(t.x - fromX, t.z - fromZ) / BOT_SPEED;
    let wait = 0, count = left;
    if (left <= 0) {
      if (!includeExhausted) continue;
      wait = tileRecovery(t.id, state.time).secondsLeft;
      count = tileItemCount(t.id);
    }
    if (count <= 0) continue;

    const sweep = count * SWEEP_SEC;
    let v = (count * w) / (travel + Math.max(0, wait - travel) + sweep + 0.4);
    if (contested(state, pid, t.id)) v *= 0.55;
    const cand = { tile: t, left, wait, count, travel, sweep, v };
    if (pool) pool.push(cand);
    if (v > bestV) { bestV = v; best = cand; }
  }
  if (!best) return null;
  // Weaker bots do not always work their best land: they walk to whichever of
  // their hexes came to mind, which is often the wrong one.
  if (pool && pool.length > 1 && rand() < slop) {
    best = pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))];
    bestV = best.v;
  }

  const t = best.tile;
  // Head for the nearest item still standing; if the hex is bare, its centre.
  const it = nearestItem(fromX, fromZ, { tile: t.id });
  return {
    tile: t.id,
    items: best.left,
    x: it ? it.x : t.x,
    z: it ? it.z : t.z,
    wait: best.wait,
    perSecond: 1 / SWEEP_SEC,
    value: bestV,
    eta: best.travel + Math.max(0, best.wait - best.travel)
  };
}

/** Resource desire weights for the purchase we are chasing. */
export function needWeights(state, pid, cost) {
  const p = state.players[pid];
  const w = { wood: 0.16, brick: 0.16, wool: 0.16, wheat: 0.16, ore: 0.16 };
  if (!cost) return w;
  const miss = missingFrom(p.res, cost);
  for (const r in miss) w[r] = 1 + miss[r] * 0.55;
  return w;
}

/**
 * Rough seconds to gather everything still missing for `cost`, or null if some
 * part of it simply cannot be gathered — which, now that ownership is a hard
 * gate, is the normal case for a resource whose hexes you do not own. The
 * caller then falls through to trading or to buying more land.
 * Returns { eta, first } where `first` is the hex to head for now.
 */
export function planGather(state, pid, cost, fromX, fromZ, avoid, opts = {}) {
  const p = state.players[pid];
  const miss = cost ? missingFrom(p.res, cost) : {};
  const keys = Object.keys(miss);

  if (!keys.length) {
    const any = chooseHarvestTile(state, pid, needWeights(state, pid, null),
                                  fromX, fromZ, avoid, true, opts);
    return any ? { eta: any.eta, first: any } : null;
  }

  let total = 0, first = null, x = fromX, z = fromZ;
  for (const r of keys) {
    const w = { wood: 0, brick: 0, wool: 0, wheat: 0, ore: 0 };
    w[r] = 1;
    const pick = chooseHarvestTile(state, pid, w, x, z, avoid, true, opts);
    if (!pick) return null;
    total += pick.eta + miss[r] * SWEEP_SEC;
    if (!first) first = pick;
    x = pick.x; z = pick.z;
  }
  return { eta: total, first };
}

/** @deprecated nodes are gone; kept so nothing imports a missing symbol. */
export const chooseNode = chooseHarvestTile;

/* ================================================================== raiding */

/**
 * Knight target: the strongest hex belonging to the current VP leader.
 * Never blocks a hex we work ourselves, never re-blocks the same hex.
 *
 * The Raider bites much harder now — a blocked hex yields the owner nothing at
 * all rather than a reduced trickle — so this is the single most disruptive
 * thing a bot can do.
 */
export function knightTarget(state, pid, opts = {}) {
  const d = dOf(opts);
  const rand = opts.rand || Math.random;
  let leader = -1, bestVp = -Infinity;
  for (const o of state.players) {
    if (o.id === pid) continue;
    const vp = scoreOf(state, o);
    if (vp > bestVp) { bestVp = vp; leader = o.id; }
  }
  // A weaker raider does not read the scoreboard: it drops the Raider on
  // somebody, but not necessarily on whoever is running away with the match.
  if (rand() >= d.knightAim) {
    const rivals = state.players.filter(o => o.id !== pid);
    if (rivals.length) leader = rivals[Math.min(rivals.length - 1,
      Math.floor(rand() * rivals.length))].id;
  }
  let best = -1, bestS = -Infinity;
  for (const t of tiles) {
    if (!t.resource) continue;
    if (t.id === state.robberTile) continue;
    let mine = 0, theirs = 0, others = 0;
    for (const c of t.corners) {
      const b = state.buildings.get(c);
      if (!b) continue;
      const w = b.type === 'city' ? 2 : 1;
      if (b.owner === pid) mine += w;
      else if (b.owner === leader) theirs += w;
      else others += w;
    }
    if (mine > 0) continue;                       // never sabotage ourselves
    if (theirs <= 0 && others <= 0) continue;     // blocking nobody's land is free but useless
    const s = rateOf(t.id) * RATE_TO_SCORE * (theirs * 2.4 + others * 0.5 + 0.2)
      * (1 + (rand() - 0.5) * 0.22 * d.noise);
    if (s > bestS) { bestS = s; best = t.id; }
  }
  if (best < 0) {
    for (const t of tiles) if (t.resource && t.id !== state.robberTile) { best = t.id; break; }
  }
  return { tile: best, leader };
}

/**
 * Should we burn a Knight right now?
 * `sinceLast` is seconds since this bot's previous Knight — chaining raids
 * flattens everyone's economy and drags matches out, so it is rate limited.
 */
export function wantsKnight(state, pid, sinceLast = Infinity, opts = {}) {
  const p = state.players[pid];
  if (!p.cards.some(c => c.type === 'knight')) return false;
  const d = dOf(opts);
  const rand = opts.rand || Math.random;
  // Sitting on a playable Knight and not noticing is exactly what a weak
  // player does. The roll is per decision, so it delays rather than forbids.
  if (rand() >= d.knight) return false;

  const holder = state.largestArmyHolder;
  const need = holder >= 0 ? state.players[holder].knightsPlayed : LARGEST_ARMY_MIN - 1;
  // Seizing Largest Army is two victory points on the spot — always take it.
  if (holder !== pid && p.knightsPlayed + 1 > need
      && p.knightsPlayed + 1 >= LARGEST_ARMY_MIN && d.award >= 0.5) return true;

  // Otherwise the Knight is a disruption tool, spent on a clear leader only.
  const aggressive = p.strategy === 'cards';
  if (sinceLast < (aggressive ? 10 : 18) + d.knightGap) return false;
  const me = scoreOf(state, p);
  let lead = -Infinity;
  for (const o of state.players) if (o.id !== pid) lead = Math.max(lead, scoreOf(state, o));
  return lead >= me + (aggressive ? 1 : 2);
}

/* ============================================================= setup draft */

/**
 * Opening snake-draft settlement. These two corners are the whole opening
 * economy now: they are the only land you may work until you can afford to
 * expand, so the draft weighs raw supply rate hardest, then insists on covering
 * as many DIFFERENT resources as possible — a settler who opens with no wheat
 * corner cannot build a settlement without trading 4:1 for it.
 */
export function chooseSetupSettlement(state, pid, rand = Math.random, opts = {}) {
  const legal = legalSettlements(state, pid, true);
  if (!legal.length) return -1;
  const noiseK = dOf(opts).setupNoise;
  const p = state.players[pid];
  const aff = affinityOf(p.strategy);
  const prod = productionOf(state, pid);
  const owned = ownedTiles(state, pid);
  const own = [...p.settlements];
  const have = new Set();
  for (const tid of owned) if (tiles[tid].resource) have.add(tiles[tid].resource);

  let best = legal[0], bestS = -Infinity;
  for (const iid of legal) {
    const n = intersections[iid];
    let s = intersectionScore(state, pid, iid, prod, aff, owned);
    // Raw supply rate dominates the opening — the single biggest lever.
    let rate = 0, novel = 0;
    for (const tid of n.tiles) {
      const t = tiles[tid];
      if (!t.resource || owned.has(tid)) continue;
      rate += rateOf(tid);
      if (!have.has(t.resource)) novel++;
    }
    s += rate * RATE_TO_SCORE * 1.5;
    s += novel * 3.2;                     // cover five resources, not two
    // Second pick: spread out rather than double up on one region.
    for (const o of own) {
      const d = Math.hypot(intersections[o].x - n.x, intersections[o].z - n.z);
      if (d < 14) s -= (14 - d) * 0.55;
      else if (d > 46) s -= (d - 46) * 0.12;
    }
    s += (rand() - 0.5) * 2.4 * noiseK;
    if (s > bestS) { bestS = s; best = iid; }
  }
  return best;
}

/** Opening road: aim at the strongest reachable second-ring corner or a port. */
export function chooseSetupRoad(state, pid, anchorIid, rand = Math.random, opts = {}) {
  const legal = legalRoads(state, pid, true, anchorIid);
  if (!legal.length) return -1;
  const noiseK = dOf(opts).setupNoise;
  const p = state.players[pid];
  const aff = affinityOf(p.strategy);
  const prod = productionOf(state, pid);
  const owned = ownedTiles(state, pid);

  let best = legal[0], bestS = -Infinity;
  for (const eid of legal) {
    const e = edges[eid];
    const far = e.a === anchorIid ? e.b : e.a;
    let s = 0;
    for (const nb of intersections[far].neighbors) {
      if (nb === anchorIid || state.buildings.has(nb)) continue;
      if (intersections[nb].neighbors.some(x => state.buildings.has(x))) continue;
      s = Math.max(s, intersectionScore(state, pid, nb, prod, aff, owned));
    }
    const pt = intersections[far].port;
    if (pt !== null && pt !== undefined) s += ports[pt].kind === 'generic' ? 2.5 : 3.5;
    if (intersections[far].tiles.length < 3) s -= 2.0;    // don't road into the sea
    s += (rand() - 0.5) * 1.8 * noiseK;
    if (s > bestS) { bestS = s; best = eid; }
  }
  return best;
}

export default {
  chooseSetupSettlement, chooseSetupRoad, choosePurchase, chooseRoad,
  chooseHarvestTile, planGather, planTrade, knightTarget, wantsKnight
};
