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
  GATHER_TIME, GATHER_YIELD,
  LONGEST_ROAD_MIN, LARGEST_ARMY_MIN,
  TRADE_BASE, BOT_SPEED,
  missingFrom, canAfford
} from '../core/constants.js';

import {
  tiles, intersections, edges, ports, MARKET, tileAt
} from '../board/layout.js';

import { nodes } from '../board/nodes.js';

import {
  legalSettlements, legalRoads, legalCities,
  longestRoadFor, scoreOf, ownershipMultiplier, canGatherTile
} from '../core/rules.js';

/* ===================================================== strategic personality */

/** Per-strategy appetite for each resource, folded into placement scoring. */
export const AFFINITY = {
  expansion: { wood: 1.40, brick: 1.40, wheat: 1.00, wool: 1.00, ore: 0.80 },
  cities:    { wood: 0.88, brick: 0.88, wheat: 1.45, wool: 0.95, ore: 1.50 },
  cards:     { wood: 0.88, brick: 0.88, wheat: 1.25, wool: 1.35, ore: 1.35 },
  human:     { wood: 1, brick: 1, wheat: 1, wool: 1, ore: 1 }
};

/** Per-strategy purchase priorities. */
export const WEIGHTS = {
  expansion: { settlement: 1.05, city: 0.95, road: 1.60, card: 0.62 },
  cities:    { settlement: 1.18, city: 1.50, road: 0.78, card: 0.58 },
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

/** Weighted pip production a player currently owns, per resource. */
export function productionOf(state, pid) {
  const out = { wood: 0, brick: 0, wool: 0, wheat: 0, ore: 0 };
  const p = state.players[pid];
  const add = (iid, mult) => {
    for (const tid of intersections[iid].tiles) {
      const t = tiles[tid];
      if (t.resource) out[t.resource] += t.pips * mult;
    }
  };
  for (const iid of p.settlements) add(iid, 2);
  for (const iid of p.cities) add(iid, 3);
  return out;
}

/**
 * How good is this corner for this player, right now?
 * Pips + diversity + scarcity of what it supplies + port access - crowding.
 */
export function intersectionScore(state, pid, iid, prod, aff) {
  const n = intersections[iid];
  let s = 0;
  const kinds = new Set();
  for (const tid of n.tiles) {
    const t = tiles[tid];
    if (!t.resource) { s += 0.4; continue; }   // desert corner: market adjacency
    const owned = prod[t.resource] || 0;
    const scarce = owned <= 0 ? 1.75 : owned < 6 ? 1.2 : 0.85;
    s += t.pips * (aff[t.resource] || 1) * scarce;
    kinds.add(t.resource);
  }
  s += kinds.size * 1.8;
  if (n.tiles.length < 3) s -= 1.4;          // coastal corners work fewer tiles

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

/** Value of turning an owned settlement into a city (yield 2x -> 3x). */
export function cityScore(state, pid, iid, aff) {
  const n = intersections[iid];
  let s = 0;
  for (const tid of n.tiles) {
    const t = tiles[tid];
    if (!t.resource) continue;
    s += t.pips * (aff[t.resource] || 1);
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
  const jitter = ctx.jitter || (() => 0);
  const openSpot = (iid) => !state.buildings.has(iid)
    && !intersections[iid].neighbors.some(nb => state.buildings.has(nb));

  const prelim = [];
  for (const eid of legal) {
    const e = edges[eid];
    let best = 0;
    for (const end of [e.a, e.b]) {
      const other = end === e.a ? e.b : e.a;
      if (openSpot(end)) {
        best = Math.max(best, 9 + intersectionScore(state, pid, end, prod, aff) * 0.55);
      } else {
        for (const nb of intersections[end].neighbors) {
          if (nb === other || state.buildings.has(nb)) continue;
          if (!openSpot(nb)) continue;
          best = Math.max(best, 2.4 + intersectionScore(state, pid, nb, prod, aff) * 0.30);
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
  const jitter = ctx.jitter || (() => 0);
  const vp = scoreOf(state, p);
  const toWin = VICTORY_POINTS - vp;
  // Within one point of the trophy, take the shortest path to VP.
  const endgame = toWin <= 1 ? 1.9 : toWin <= 2 ? 1.25 : 1;

  const out = [];

  /* ---- settlement ---- */
  if (p.settlements.size + p.cities.size < PIECE_LIMIT.settlement) {
    const legal = legalSettlements(state, pid);
    let bi = -1, bs = -Infinity;
    for (const iid of legal) {
      const s = intersectionScore(state, pid, iid, prod, aff)
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
  const rd = chooseRoad(state, pid, fromX, fromZ, { aff, prod, jitter });
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
    if (armyHolder !== pid && army + 1 > armyLen && army + 1 >= LARGEST_ARMY_MIN) s += 9;
    else if (armyHolder !== pid && army + 2 >= LARGEST_ARMY_MIN) s += 4;
    if (toWin <= 2) s += 3;                         // victory-point cards
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

/** Is another settler already working this node? */
function contested(state, pid, n) {
  for (const o of state.players) {
    if (o.id === pid) continue;
    if (o.action === 'gather' && o.gatherNode && o.gatherNode.id === n.id) return true;
  }
  return false;
}

/**
 * Pick the node with the best (useful yield) / (travel + harvest) ratio.
 * `weights` maps resource -> how badly we want it.
 * Returns { node, eta, value } or null.
 */
export function chooseNode(state, pid, weights, fromX, fromZ, avoid = null) {
  let best = null, bestV = 0;
  for (const n of nodes) {
    if (n.remaining <= 0) continue;
    if (avoid && avoid.has(n.id)) continue;
    if (!canGatherTile(state, pid, n.tile)) continue;
    const w = weights[n.resource] || 0;
    if (w <= 0) continue;
    const t = tiles[n.tile];
    const mult = ownershipMultiplier(state, pid, n.tile);
    const cycles = n.remaining;
    const yieldTotal = (GATHER_YIELD[t.pips] || 1) * mult * cycles;
    const harvest = (GATHER_TIME[t.pips] || 1) * cycles;
    const travel = Math.hypot(n.x - fromX, n.z - fromZ) / BOT_SPEED;
    let v = (yieldTotal * w) / (travel + harvest + 0.35);
    if (contested(state, pid, n)) v *= 0.35;
    if (v > bestV) { bestV = v; best = n; }
  }
  if (!best) return null;
  const t = tiles[best.tile];
  const mult = ownershipMultiplier(state, pid, best.tile);
  return {
    node: best,
    value: bestV,
    perCycle: (GATHER_YIELD[t.pips] || 1) * mult,
    cycleTime: GATHER_TIME[t.pips] || 1,
    eta: Math.hypot(best.x - fromX, best.z - fromZ) / BOT_SPEED
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
 * Rough seconds to gather everything still missing for `cost`.
 * Returns { eta, first } where `first` is the node to head for now.
 */
export function planGather(state, pid, cost, fromX, fromZ, avoid) {
  const p = state.players[pid];
  const miss = cost ? missingFrom(p.res, cost) : {};
  const keys = Object.keys(miss);

  if (!keys.length) {
    const any = chooseNode(state, pid, needWeights(state, pid, null), fromX, fromZ, avoid);
    return any ? { eta: any.eta, first: any } : null;
  }

  let total = 0, first = null, x = fromX, z = fromZ;
  for (const r of keys) {
    const w = { wood: 0, brick: 0, wool: 0, wheat: 0, ore: 0 };
    w[r] = 1;
    const pick = chooseNode(state, pid, w, x, z, avoid);
    if (!pick) return null;
    const cycles = Math.max(1, Math.ceil(miss[r] / Math.max(1, pick.perCycle)));
    total += pick.eta + cycles * pick.cycleTime;
    if (!first) first = pick;
    x = pick.node.x; z = pick.node.z;
  }
  return { eta: total, first };
}

/* ================================================================== raiding */

/**
 * Knight target: the strongest tile belonging to the current VP leader.
 * Never blocks a tile we work ourselves, never re-blocks the same tile.
 */
export function knightTarget(state, pid) {
  let leader = -1, bestVp = -Infinity;
  for (const o of state.players) {
    if (o.id === pid) continue;
    const vp = scoreOf(state, o);
    if (vp > bestVp) { bestVp = vp; leader = o.id; }
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
    const s = t.pips * (theirs * 2.4 + others * 0.5 + 0.2);
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
export function wantsKnight(state, pid, sinceLast = Infinity) {
  const p = state.players[pid];
  if (!p.cards.some(c => c.type === 'knight')) return false;

  const holder = state.largestArmyHolder;
  const need = holder >= 0 ? state.players[holder].knightsPlayed : LARGEST_ARMY_MIN - 1;
  // Seizing Largest Army is two victory points on the spot — always take it.
  if (holder !== pid && p.knightsPlayed + 1 > need
      && p.knightsPlayed + 1 >= LARGEST_ARMY_MIN) return true;

  // Otherwise the Knight is a disruption tool, spent on a clear leader only.
  const aggressive = p.strategy === 'cards';
  if (sinceLast < (aggressive ? 10 : 18)) return false;
  const me = scoreOf(state, p);
  let lead = -Infinity;
  for (const o of state.players) if (o.id !== pid) lead = Math.max(lead, scoreOf(state, o));
  return lead >= me + (aggressive ? 1 : 2);
}

/* ============================================================= setup draft */

/**
 * Opening snake-draft settlement. Maximises pip total across adjacent tiles,
 * rewards resource diversity and port access, and steers clear of corners
 * rivals are already clustered on.
 */
export function chooseSetupSettlement(state, pid, rand = Math.random) {
  const legal = legalSettlements(state, pid, true);
  if (!legal.length) return -1;
  const p = state.players[pid];
  const aff = affinityOf(p.strategy);
  const prod = productionOf(state, pid);
  const own = [...p.settlements];

  let best = legal[0], bestS = -Infinity;
  for (const iid of legal) {
    const n = intersections[iid];
    let s = intersectionScore(state, pid, iid, prod, aff);
    // Raw pip total dominates the opening — this is the single biggest lever.
    let pips = 0;
    for (const tid of n.tiles) pips += tiles[tid].pips;
    s += pips * 0.9;
    // Second pick: spread out rather than double up on one region.
    for (const o of own) {
      const d = Math.hypot(intersections[o].x - n.x, intersections[o].z - n.z);
      if (d < 14) s -= (14 - d) * 0.55;
      else if (d > 46) s -= (d - 46) * 0.12;
    }
    s += (rand() - 0.5) * 2.4;
    if (s > bestS) { bestS = s; best = iid; }
  }
  return best;
}

/** Opening road: aim at the strongest reachable second-ring corner or a port. */
export function chooseSetupRoad(state, pid, anchorIid, rand = Math.random) {
  const legal = legalRoads(state, pid, true, anchorIid);
  if (!legal.length) return -1;
  const p = state.players[pid];
  const aff = affinityOf(p.strategy);
  const prod = productionOf(state, pid);

  let best = legal[0], bestS = -Infinity;
  for (const eid of legal) {
    const e = edges[eid];
    const far = e.a === anchorIid ? e.b : e.a;
    let s = 0;
    for (const nb of intersections[far].neighbors) {
      if (nb === anchorIid || state.buildings.has(nb)) continue;
      if (intersections[nb].neighbors.some(x => state.buildings.has(x))) continue;
      s = Math.max(s, intersectionScore(state, pid, nb, prod, aff));
    }
    const pt = intersections[far].port;
    if (pt !== null && pt !== undefined) s += ports[pt].kind === 'generic' ? 2.5 : 3.5;
    if (intersections[far].tiles.length < 3) s -= 2.0;    // don't road into the sea
    s += (rand() - 0.5) * 1.8;
    if (s > bestS) { bestS = s; best = eid; }
  }
  return best;
}

export default {
  chooseSetupSettlement, chooseSetupRoad, choosePurchase, chooseRoad,
  chooseNode, planGather, planTrade, knightTarget, wantsKnight
};
