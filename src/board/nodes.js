/**
 * Gatherable resource nodes — the trees, clay pits, sheep, wheat stands and
 * ore seams the settlers actually run up to and harvest.
 *
 * Deterministic: the same island every match. Shared by the world renderer
 * (which draws props here), the gathering system and the bots (which path
 * to them), so positions must never diverge.
 */

import { tiles } from './layout.js';
import { HEX_SIZE, NODE_CAPACITY, NODE_REGROW_SEC } from '../core/constants.js';

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NODES_PER_TILE = 7;

/** Rejection-sample points inside a pointy-top hex, kept off the rim so
 *  props never poke through a road or a settlement. */
function samplePoints(tile, count, rng, inset = 0.62, minSep = 0.34) {
  const pts = [];
  const inner = HEX_SIZE * Math.sqrt(3) / 2;
  let guard = 0;
  while (pts.length < count && guard++ < 4000) {
    const rx = (rng() * 2 - 1) * inner * inset;
    const rz = (rng() * 2 - 1) * HEX_SIZE * inset;
    const dx = Math.abs(rx), dz = Math.abs(rz);
    if (dx > inner * inset) continue;
    if (dz > HEX_SIZE * inset) continue;
    if (HEX_SIZE * inner - HEX_SIZE * 0.5 * dx - inner * dz < HEX_SIZE * 1.6) continue;
    const sep = minSep * HEX_SIZE;
    if (pts.some(p => Math.hypot(p.lx - rx, p.lz - rz) < sep)) continue;
    pts.push({ lx: rx, lz: rz });
  }
  return pts;
}

/** Node visual archetype per terrain — the renderer switches on `kind`. */
const KIND = {
  forest: 'tree',
  hills: 'claypit',
  pasture: 'sheep',
  fields: 'wheat',
  mountains: 'orerock'
};

export const nodes = [];

tiles.forEach((tile, ti) => {
  if (!tile.resource) return;
  const rng = mulberry32(1337 + ti * 9176 + tile.number * 131);
  const pts = samplePoints(tile, NODES_PER_TILE, rng);
  pts.forEach((p, i) => {
    nodes.push({
      id: nodes.length,
      tile: tile.id,
      resource: tile.resource,
      kind: KIND[tile.terrain],
      x: tile.x + p.lx,
      z: tile.z + p.lz,
      rot: rng() * Math.PI * 2,
      scale: 0.85 + rng() * 0.4,
      variant: Math.floor(rng() * 3),
      // runtime state (reset by createMatch)
      remaining: NODE_CAPACITY,
      regrowAt: 0
    });
  });
});

export const nodesByTile = (() => {
  const m = new Map();
  for (const n of nodes) {
    if (!m.has(n.tile)) m.set(n.tile, []);
    m.get(n.tile).push(n);
  }
  return m;
})();

/* --------------------------------------------------------- tile recovery */
/**
 * Recovery is scoped to the whole REGION, not to individual nodes.
 *
 * With per-node regrowth the first trees you felled grew back before you had
 * finished walking the tile, so a region could never visibly empty and the
 * player had no way to read "this place is worked out". Now a depleted node
 * stays down until every node on its tile is down; the region then goes
 * dormant for a fixed spell and the whole thing comes back at once. That gives
 * a region a legible life cycle: full -> visibly thinning -> clear cut ->
 * counting down -> lush again.
 */
export const TILE_REGROW_SEC = 20.0;

const tileState = new Map();   // tileId -> { dormantUntil, exhaustedAt }

function stateFor(tileId) {
  let st = tileState.get(tileId);
  if (!st) { st = { dormantUntil: 0, exhaustedAt: 0 }; tileState.set(tileId, st); }
  return st;
}

export function resetNodes() {
  for (const n of nodes) { n.remaining = NODE_CAPACITY; n.regrowAt = 0; n.justRegrew = false; }
  tileState.clear();
}

export function tickNodes(now) {
  for (const [tileId, list] of nodesByTile) {
    const st = tileState.get(tileId);
    if (!st || !st.dormantUntil) continue;
    if (now >= st.dormantUntil) {
      for (const n of list) { n.remaining = NODE_CAPACITY; n.regrowAt = 0; n.justRegrew = true; }
      st.dormantUntil = 0;
      st.exhaustedAt = 0;
    }
  }
}

export function depleteNode(n, now) {
  n.remaining -= 1;
  if (n.remaining > 0) return;
  n.regrowAt = 0;
  const list = nodesByTile.get(n.tile) || [];
  if (list.every(x => x.remaining <= 0)) {
    const st = stateFor(n.tile);
    st.exhaustedAt = now;
    st.dormantUntil = now + TILE_REGROW_SEC;
  }
}

/** How much of a region is still standing — drives the "thinning out" read. */
export function tileRemaining(tileId) {
  const list = nodesByTile.get(tileId) || [];
  let live = 0, units = 0;
  for (const n of list) { if (n.remaining > 0) live++; units += Math.max(0, n.remaining); }
  const total = list.length;
  return {
    live, total, units,
    maxUnits: total * NODE_CAPACITY,
    fraction: total ? live / total : 0
  };
}

/** Recovery readout for the HUD and the in-world region marker. */
export function tileRecovery(tileId, now) {
  const st = tileState.get(tileId);
  if (!st || !st.dormantUntil) {
    return { exhausted: false, secondsLeft: 0, progress: 1, total: TILE_REGROW_SEC };
  }
  const left = Math.max(0, st.dormantUntil - now);
  return {
    exhausted: true,
    secondsLeft: left,
    progress: 1 - left / TILE_REGROW_SEC,
    total: TILE_REGROW_SEC
  };
}

export function isTileExhausted(tileId) {
  const st = tileState.get(tileId);
  return !!(st && st.dormantUntil);
}

/** Nearest live node of any kind (or a specific resource) to a point. */
export function nearestNode(x, z, resource = null, maxDist = Infinity, blockedTile = -1) {
  let best = null, bestD = maxDist * maxDist;
  for (const n of nodes) {
    if (n.remaining <= 0) continue;
    if (resource && n.resource !== resource) continue;
    if (n.tile === blockedTile) continue;
    const d = (n.x - x) * (n.x - x) + (n.z - z) * (n.z - z);
    if (d < bestD) { bestD = d; best = n; }
  }
  return best;
}

export default nodes;
