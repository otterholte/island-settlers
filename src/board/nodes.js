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

export function resetNodes() {
  for (const n of nodes) { n.remaining = NODE_CAPACITY; n.regrowAt = 0; }
}

export function tickNodes(now) {
  for (const n of nodes) {
    if (n.remaining <= 0 && now >= n.regrowAt) {
      n.remaining = NODE_CAPACITY;
      n.justRegrew = true;
    }
  }
}

export function depleteNode(n, now) {
  n.remaining -= 1;
  if (n.remaining <= 0) n.regrowAt = now + NODE_REGROW_SEC;
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
