/**
 * Island Settlers — HUD guidance model.
 *
 * Pure logic, no DOM. Answers two questions the player kept asking:
 *
 *   "How close am I to a road / settlement / city / card?"  -> progressFor()
 *   "Where can I still pick resources up, and when do they
 *    come back?"                                            -> regionReport()
 *
 * Everything here reads state; nothing here mutates it.
 *
 * Owner: UI agent.
 */

import { RES, PIECE_LIMIT } from '../core/constants.js';

import {
  legalRoads, legalSettlements, legalCities,
  playerOwnsTile, canGatherTile
} from '../core/rules.js';
import { tiles, tileAt } from '../board/layout.js';
import {
  tileItemsRemaining, tileItemCount, tileRecovery, nearestItem
} from '../board/nodes.js';

/* The four purchases, in the order the build bar shows them. */
export const BUILD_KINDS = [
  { kind: 'road',       label: 'Road',       ico: 'road',   vp: 0 },
  { kind: 'settlement', label: 'Settlement', ico: 'house',  vp: 1 },
  { kind: 'city',       label: 'City',       ico: 'castle', vp: 1 },
  { kind: 'card',       label: 'Card',       ico: 'cards',  vp: 0 }
];

/** Plain-English name for the terrain that yields each resource. */
export const REGION_OF = {
  wood: 'forests', brick: 'clay hills', wool: 'pastures',
  wheat: 'wheat fields', ore: 'mountains'
};

/** The same, for the one hex you are standing on. */
export const REGION_ONE = {
  wood: 'forest', brick: 'clay hill', wool: 'pasture',
  wheat: 'wheat field', ore: 'mountain'
};

/* ------------------------------------------------------------- purchases */

/**
 * How close `bank` is to paying `cost`.
 *
 *   p        0..1, min(have/need) across the cost — you cannot buy until it is 1
 *   blocking the single resource furthest from met (what to go and get)
 *   parts    [{ res, have, need, met }] in RES order
 */
export function progressFor(bank, cost) {
  const parts = [];
  let p = 1, blocking = null, worst = Infinity, worstGap = 0;
  for (const r of RES) {
    const need = cost && cost[r] ? cost[r] : 0;
    if (!need) continue;
    const have = Math.max(0, bank[r] | 0);
    const ratio = Math.min(1, have / need);
    parts.push({ res: r, have, need, met: have >= need });
    if (ratio < p) p = ratio;
    const gap = need - have;
    if (gap > 0 && (ratio < worst || (ratio === worst && gap > worstGap))) {
      worst = ratio; worstGap = gap; blocking = r;
    }
  }
  return { p, blocking, parts, afford: blocking === null };
}

export function pieceCapped(state, pid, kind) {
  const p = state.players[pid];
  if (kind === 'road') return p.roads.size >= PIECE_LIMIT.road;
  if (kind === 'settlement') return p.settlements.size + p.cities.size >= PIECE_LIMIT.settlement;
  if (kind === 'city') return p.cities.size >= PIECE_LIMIT.city;
  return false;
}

/** Somewhere legal to put this piece? Cards are always placeable. */
export function hasSomewhere(state, kind) {
  if (kind === 'card') return true;
  if (kind === 'road') return legalRoads(state, 0).length > 0;
  if (kind === 'settlement') return legalSettlements(state, 0).length > 0;
  return legalCities(state, 0).length > 0;
}

/* --------------------------------------------------------------- regions */

const RES_TILES = (() => {
  const m = {};
  for (const r of RES) m[r] = [];
  for (const t of tiles) if (t.resource) m[t.resource].push(t);
  return m;
})();

/**
 * Island-wide availability per resource. Counted in ITEMS, which is the only
 * unit the field has left — a hex is full, part-swept, or spent and counting
 * down as a whole.
 *   live/total  regions still carrying something
 *   stock       0..1 share of the standing crop across those regions
 *   recovery    0..1 progress of the soonest region on its way back (dry only)
 *   soonest     seconds until the next region returns (dry only)
 */
export function regionReport(state) {
  const now = state.time || 0;
  const out = {};
  for (const r of RES) {
    const list = RES_TILES[r] || [];
    let live = 0, units = 0, maxUnits = 0, soonest = Infinity, rec = 0;
    for (const t of list) {
      const left = tileItemsRemaining(t.id);
      units += left; maxUnits += tileItemCount(t.id);
      if (left > 0) { live++; continue; }
      const rc = tileRecovery(t.id, now);
      if (rc.exhausted && rc.secondsLeft < soonest) {
        soonest = rc.secondsLeft; rec = rc.progress;
      }
    }
    out[r] = {
      live, total: list.length,
      stock: maxUnits ? units / maxUnits : 0,
      recovery: live ? 1 : (soonest === Infinity ? 1 : rec),
      soonest: soonest === Infinity ? 0 : soonest
    };
  }
  return out;
}

/**
 * The hex the player is standing on: what it grows, how much of it is still
 * standing, whether this player may take any of it, and — if the hex has been
 * swept clean — how long until the whole field returns.
 *
 * `mine` and `blocked` are the two reasons the ground can be giving you
 * nothing while it plainly still has things on it.
 */
export function standingRegion(state, p, pid = 0) {
  const t = tileAt(p.x, p.z);
  if (!t || !t.resource) return null;
  const units = tileItemsRemaining(t.id);
  const total = tileItemCount(t.id);
  const rc = tileRecovery(t.id, state.time || 0);
  const mine = playerOwnsTile(state, pid, t.id);
  return {
    tile: t, resource: t.resource,
    units, total,
    live: units,                       // legacy alias: items, not sub-nodes
    fraction: total ? units / total : 0,
    mine,
    blocked: mine && !canGatherTile(state, pid, t.id),
    workable: mine && !rc.exhausted && units > 0 && canGatherTile(state, pid, t.id),
    exhausted: rc.exhausted,
    secondsLeft: rc.secondsLeft,
    recovery: rc.progress,
    total_sec: rc.total
  };
}

/** Nearest still-standing item of a resource, and which way it lies. */
export function nearestLive(p, resource) {
  return nearestItem(p.x, p.z, resource ? { resource } : {});
}

/**
 * Screen-relative bearing. The play camera has a fixed yaw, so -z is always
 * up-screen: these four words never lie and never need a compass rose.
 */
export function bearingWord(p, target) {
  if (!target) return '';
  const dx = target.x - p.x, dz = target.z - p.z;
  if (Math.abs(dx) > Math.abs(dz)) return dx > 0 ? 'right' : 'left';
  return dz < 0 ? 'ahead' : 'behind';
}

/* ----------------------------------------------------------------- guide */

const lower = s => String(s).toLowerCase();

/*
 * `createGuide` used to live here — the running "what should I be doing right
 * now" line under the resource pill. It is gone with the line it fed:
 *
 *   "During the game I don't need the little popups telling me what to do
 *    below my resource counter at the top middle of the page."
 *
 * `nearestLive` and `bearingWord` above were its two helpers and are kept: they
 * are small, general and the only place in the codebase that turns a bearing
 * into a word, which is the sort of thing that gets rewritten badly when it is
 * needed again and cannot be found.
 */

export default { regionReport, standingRegion, progressFor };
