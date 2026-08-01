/**
 * Island Settlers — the harvestable field on every hex.
 *
 * =============================================================================
 * THE MODEL  (read this before touching the renderer)
 * =============================================================================
 *
 * A hex is not seven sparse nodes any more. It is a FIELD, dense with its own
 * resource — a forest packed with trees, a pasture packed with sheep, a hillside
 * packed with clay piles. Each one of those things is an ITEM.
 *
 *   * Pickup is INSTANT and CONTACT-BASED. Run the settler over an item and it
 *     is yours that frame. No progress circle, no swing timer, no latching, no
 *     `action === 'gather'` state to get stuck in.
 *   * Sweeping a whole hex clean takes roughly three seconds of running.
 *   * The number on the hex means exactly two things: how MANY items it holds
 *     (`tileItemCount`) and how FAST they all come back (`tileRegenSeconds`).
 *   * You may only collect on a hex you own — `canGatherTile` in core/rules.js.
 *     Everywhere else yields nothing at all. There is no multiplier.
 *   * Recovery is WHOLE-HEX. Take the last item and the region is spent: it
 *     greys out and counts down, then every item returns at once.
 *
 * -----------------------------------------------------------------------------
 * API FOR THE WORLD LAYER
 * -----------------------------------------------------------------------------
 *
 *   items                       flat array of every item, stable order & ids
 *   itemsByTile: Map            tileId -> that tile's full item pool
 *   tileItems(tileId)           the ENABLED items on a tile (what to draw)
 *
 *   item = {
 *     id,          // stable, unique, index into `items`
 *     tile,        // tile id
 *     index,       // 0..n-1 within the tile (stable)
 *     resource,    // 'wood' | 'brick' | 'wool' | 'wheat' | 'ore'
 *     kind,        // 'tree' | 'claypit' | 'sheep' | 'wheat' | 'orerock'
 *     x, z,        // world position (ground height comes from world/terrain.js)
 *     rot, scale, variant,     // deterministic dressing
 *     enabled,     // part of the live field at this tile's item count
 *     collected,   // true once somebody has picked it up
 *     available,   // enabled && !collected — the flag to draw against
 *     takenBy,     // player id who took it (-1 if standing)
 *     takenAt,     // match time it was taken
 *     legacyNode   // nearest id in the deprecated `nodes` array (see bottom)
 *   }
 *
 *   tileRecovery(tileId, now)   -> { exhausted, secondsLeft, progress, total }
 *   tileItemsRemaining(tileId)  -> items still standing
 *   tileItemCount(tileId)       -> items on a full hex
 *   tileRegenSeconds(tileId)    -> seconds a cleared hex stays bare
 *   tileFraction(tileId)        -> 0..1 how full the hex is right now
 *   isTileExhausted(tileId)     -> bool
 *   itemsNear(x, z, r, out?)    -> items within r (spatial grid, allocation free)
 *   nearestItem(x, z, opts)     -> { resource, tile, exclude, maxDist }
 *
 * Ownership questions live in core/rules.js, not here:
 *   playerOwnsTile(state, pid, tileId)
 *   canGatherTile(state, pid, tileId)
 *
 * EVENTS (emitted by core/rules.js, drained with `drainEvents`)
 *   gained     { player, resource, amount, x, z, item, tile, node, depleted }
 *   exhausted  { tile, player, seconds }
 *   restored   { tile }
 *
 * -----------------------------------------------------------------------------
 * Deterministic: the same island every match. Never mutate positions.
 */

import { tiles } from './layout.js';
import {
  HEX_SIZE, NODE_CAPACITY, TILE_ITEMS, TILE_REGEN, TILE_ITEM_POOL, PICKUP_RADIUS
} from '../core/constants.js';

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Item visual archetype per terrain — the renderer switches on `kind`. */
export const ITEM_KIND = {
  forest: 'tree',
  hills: 'claypit',
  pasture: 'sheep',
  fields: 'wheat',
  mountains: 'orerock'
};

/* ============================================================ field sampling */

const INNER = HEX_SIZE * Math.sqrt(3) / 2;   // centre -> edge
const RIM = 2.05;                            // keep clear of roads / buildings

/** Inside a pointy-top hex, shrunk by `margin` on every edge? */
function insideHex(lx, lz, margin) {
  const dx = Math.abs(lx), dz = Math.abs(lz);
  if (dx > INNER - margin) return false;
  if (dz > HEX_SIZE - margin) return false;
  // Distance to the two slanted edges.
  return HEX_SIZE * INNER - HEX_SIZE * 0.5 * dx - INNER * dz > INNER * margin * 1.15;
}

/**
 * Mitchell best-candidate scatter: for each new item, throw a handful of darts
 * and keep the one furthest from everything already placed. Gives an even,
 * blue-noise field with no clumps and no visible grid — which is what makes a
 * hex readable as "full" and sweepable in one pass.
 */
function scatterField(rng, count) {
  const pts = [];
  for (let i = 0; i < count; i++) {
    let best = null, bestD = -1;
    for (let k = 0; k < 14; k++) {
      let lx = 0, lz = 0, guard = 0;
      do {
        lx = (rng() * 2 - 1) * INNER;
        lz = (rng() * 2 - 1) * HEX_SIZE;
      } while (!insideHex(lx, lz, RIM) && guard++ < 40);
      if (!insideHex(lx, lz, RIM)) continue;
      let d = Infinity;
      for (const p of pts) {
        const dd = (p.lx - lx) * (p.lx - lx) + (p.lz - lz) * (p.lz - lz);
        if (dd < d) d = dd;
      }
      if (d > bestD) { bestD = d; best = { lx, lz }; }
    }
    if (best) pts.push(best);
  }
  return pts;
}

/* ==================================================================== items */

export const items = [];
export const itemsByTile = new Map();

tiles.forEach((tile, ti) => {
  if (!tile.resource) return;
  const rng = mulberry32(90210 + ti * 7717 + tile.number * 313);
  const pts = scatterField(rng, TILE_ITEM_POOL);
  const list = [];
  pts.forEach((p, i) => {
    const it = {
      id: items.length,
      tile: tile.id,
      index: i,
      resource: tile.resource,
      kind: ITEM_KIND[tile.terrain],
      x: tile.x + p.lx,
      z: tile.z + p.lz,
      rot: rng() * Math.PI * 2,
      scale: 0.86 + rng() * 0.36,
      variant: Math.floor(rng() * 3),
      enabled: true,
      collected: false,
      available: true,
      takenBy: -1,
      takenAt: 0,
      legacyNode: -1
    };
    items.push(it);
    list.push(it);
  });
  itemsByTile.set(tile.id, list);
});

/* --------------------------------------------------------------- fast lookup */

const CELL = 6.0;
const grid = new Map();
const cellKey = (x, z) => `${Math.floor(x / CELL)}:${Math.floor(z / CELL)}`;

for (const it of items) {
  const k = cellKey(it.x, it.z);
  let bucket = grid.get(k);
  if (!bucket) { bucket = []; grid.set(k, bucket); }
  bucket.push(it);
}

/**
 * Every item within `r` of a point. Pass `out` to reuse an array — the pickup
 * sweep runs for four settlers every fixed step and must not allocate.
 */
export function itemsNear(x, z, r = PICKUP_RADIUS, out = []) {
  out.length = 0;
  const r2 = r * r;
  const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
  const span = Math.ceil(r / CELL);
  for (let gx = cx - span; gx <= cx + span; gx++) {
    for (let gz = cz - span; gz <= cz + span; gz++) {
      const bucket = grid.get(`${gx}:${gz}`);
      if (!bucket) continue;
      for (const it of bucket) {
        const dx = it.x - x, dz = it.z - z;
        if (dx * dx + dz * dz <= r2) out.push(it);
      }
    }
  }
  return out;
}

/** Closest standing item, optionally filtered. Used by bots and the HUD. */
export function nearestItem(x, z, opts = {}) {
  const { resource = null, tile = -1, maxDist = Infinity, filter = null } = opts;
  const pool = tile >= 0 ? (itemsByTile.get(tile) || []) : items;
  let best = null, bestD = maxDist * maxDist;
  for (const it of pool) {
    if (!it.available) continue;
    if (resource && it.resource !== resource) continue;
    if (filter && !filter(it)) continue;
    const d = (it.x - x) * (it.x - x) + (it.z - z) * (it.z - z);
    if (d < bestD) { bestD = d; best = it; }
  }
  return best;
}

/* ================================================================= recovery */

/**
 * Recovery is scoped to the WHOLE HEX. Take the last item and the region is
 * spent: it greys out, shows a countdown, and then everything returns in one
 * go. "If you cut all of the trees down, you have to wait for them all to grow
 * again before you can go back."
 */

// Representative value kept for older world code that wants one number.
export const TILE_REGROW_SEC = TILE_REGEN[3];

const tileState = new Map();   // tileId -> { exhausted, exhaustedAt, restoreAt }

function stateFor(tileId) {
  let st = tileState.get(tileId);
  if (!st) {
    st = { exhausted: false, exhaustedAt: 0, restoreAt: 0 };
    tileState.set(tileId, st);
  }
  return st;
}

const liveCount = new Map();   // tileId -> items still standing

export function tileItemCount(tileId) {
  const t = tiles[tileId];
  if (!t || !t.resource) return 0;
  const pool = itemsByTile.get(tileId);
  if (!pool) return 0;
  return Math.min(pool.length, TILE_ITEMS[t.pips] || 0);
}

export function tileRegenSeconds(tileId) {
  const t = tiles[tileId];
  if (!t || !t.resource) return 0;
  return TILE_REGEN[t.pips] || TILE_REGROW_SEC;
}

export function tileItemsRemaining(tileId) {
  return liveCount.get(tileId) || 0;
}

export function tileFraction(tileId) {
  const total = tileItemCount(tileId);
  return total ? tileItemsRemaining(tileId) / total : 0;
}

export function isTileExhausted(tileId) {
  const st = tileState.get(tileId);
  return !!(st && st.exhausted);
}

/** Recovery readout for the greyed-out hex and its countdown ring. */
export function tileRecovery(tileId, now = 0) {
  const total = tileRegenSeconds(tileId);
  const st = tileState.get(tileId);
  if (!st || !st.exhausted) {
    return { exhausted: false, secondsLeft: 0, progress: 1, total };
  }
  const left = Math.max(0, st.restoreAt - now);
  return {
    exhausted: true,
    secondsLeft: left,
    progress: total > 0 ? 1 - left / total : 1,
    total
  };
}

/* ------------------------------------------------------------- mutation */

/** Fill a hex back up. Returns true if anything actually changed. */
export function restoreTile(tileId) {
  const pool = itemsByTile.get(tileId);
  if (!pool) return false;
  const want = tileItemCount(tileId);
  for (let i = 0; i < pool.length; i++) {
    const it = pool[i];
    it.enabled = i < want;
    it.collected = false;
    it.available = it.enabled;
    it.takenBy = -1;
    it.takenAt = 0;
  }
  liveCount.set(tileId, want);
  const st = stateFor(tileId);
  const was = st.exhausted;
  st.exhausted = false;
  st.exhaustedAt = 0;
  st.restoreAt = 0;
  syncLegacy(tileId);
  return was || true;
}

/**
 * Take one item. Returns true when that was the last one and the hex has just
 * gone dormant. `core/rules.js` is the only caller — it owns the events.
 */
export function collectItem(item, now = 0, pid = -1) {
  if (!item || !item.available) return false;
  item.collected = true;
  item.available = false;
  item.takenBy = pid;
  item.takenAt = now;
  const left = Math.max(0, (liveCount.get(item.tile) || 0) - 1);
  liveCount.set(item.tile, left);
  syncLegacy(item.tile);
  if (left > 0) return false;
  const st = stateFor(item.tile);
  if (st.exhausted) return false;
  st.exhausted = true;
  st.exhaustedAt = now;
  st.restoreAt = now + tileRegenSeconds(item.tile);
  return true;
}

/** Advance every dormant hex. Returns the ids that just came back. */
export function tickNodes(now) {
  let restored = null;
  for (const [tileId, st] of tileState) {
    if (!st.exhausted || now < st.restoreAt) continue;
    restoreTile(tileId);
    (restored || (restored = [])).push(tileId);
  }
  return restored || EMPTY;
}
const EMPTY = [];

/** Put the whole island back to full. */
export function restoreAll() {
  for (const tileId of itemsByTile.keys()) restoreTile(tileId);
  return items.length;
}

/** Called by createMatch() and the in-place restart. */
export function resetNodes() {
  tileState.clear();
  restoreAll();
}

export const resetItems = resetNodes;

/* =========================================================================
 * DEPRECATED — the old 7-nodes-per-tile array.
 * =========================================================================
 * `src/world/*` still builds its stands and props from this list. It is kept at
 * exactly its historical positions and length (126) so nothing has to change at
 * once, but it is no longer the game: `remaining` is now derived from how full
 * the hex is, so an old renderer thins out and clear-cuts along with the real
 * field. New code must use `items` / `tileItems` instead.
 */

const NODES_PER_TILE = 7;

function legacyPoints(rng, count, inset = 0.62, minSep = 0.34) {
  const pts = [];
  let guard = 0;
  while (pts.length < count && guard++ < 4000) {
    const rx = (rng() * 2 - 1) * INNER * inset;
    const rz = (rng() * 2 - 1) * HEX_SIZE * inset;
    const dx = Math.abs(rx), dz = Math.abs(rz);
    if (dx > INNER * inset) continue;
    if (dz > HEX_SIZE * inset) continue;
    if (HEX_SIZE * INNER - HEX_SIZE * 0.5 * dx - INNER * dz < HEX_SIZE * 1.6) continue;
    const sep = minSep * HEX_SIZE;
    if (pts.some(p => Math.hypot(p.lx - rx, p.lz - rz) < sep)) continue;
    pts.push({ lx: rx, lz: rz });
  }
  return pts;
}

export const nodes = [];

tiles.forEach((tile, ti) => {
  if (!tile.resource) return;
  const rng = mulberry32(1337 + ti * 9176 + tile.number * 131);
  const pts = legacyPoints(rng, NODES_PER_TILE);
  pts.forEach((p) => {
    nodes.push({
      id: nodes.length,
      tile: tile.id,
      resource: tile.resource,
      kind: ITEM_KIND[tile.terrain],
      x: tile.x + p.lx,
      z: tile.z + p.lz,
      rot: rng() * Math.PI * 2,
      scale: 0.85 + rng() * 0.4,
      variant: Math.floor(rng() * 3),
      remaining: NODE_CAPACITY,
      regrowAt: 0,
      justRegrew: false
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

// Each real item points at the legacy node nearest to it, so the old harvest
// FX still fire on roughly the right prop.
for (const it of items) {
  const list = nodesByTile.get(it.tile) || [];
  let best = -1, bd = Infinity;
  for (const n of list) {
    const d = (n.x - it.x) * (n.x - it.x) + (n.z - it.z) * (n.z - it.z);
    if (d < bd) { bd = d; best = n.id; }
  }
  it.legacyNode = best;
}

/** Mirror the hex's fill fraction onto the deprecated node list. */
function syncLegacy(tileId) {
  const list = nodesByTile.get(tileId);
  if (!list || !list.length) return;
  const live = Math.ceil(tileFraction(tileId) * list.length);
  for (let i = 0; i < list.length; i++) {
    const n = list[i];
    const want = i < live ? NODE_CAPACITY : 0;
    if (want > 0 && n.remaining <= 0) n.justRegrew = true;
    n.remaining = want;
  }
}

/** @deprecated use tileItemsRemaining / tileFraction. */
export function tileRemaining(tileId) {
  const list = nodesByTile.get(tileId) || [];
  const total = list.length;
  const frac = tileFraction(tileId);
  const live = Math.ceil(frac * total);
  return {
    live, total,
    units: tileItemsRemaining(tileId),
    maxUnits: tileItemCount(tileId),
    fraction: frac
  };
}

/** @deprecated contact pickup does not use nodes. Kept for old callers. */
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

/** @deprecated nodes no longer deplete individually. */
export function depleteNode() { return false; }

// Prime the live counts.
restoreAll();

/** The enabled (drawable, collectable) items on a tile. */
export function tileItems(tileId) {
  const pool = itemsByTile.get(tileId);
  if (!pool) return EMPTY;
  const n = tileItemCount(tileId);
  return n === pool.length ? pool : pool.slice(0, n);
}

export default items;
