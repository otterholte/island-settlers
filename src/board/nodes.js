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
 * Deterministic, and it has to be: a given board seed must produce the same
 * field in every browser and in the match worker, because the network replays
 * a pickup by ITEM ID and nothing else. The scatter is therefore seeded off
 * each hex's number token, and `refreshFieldsFromBoard()` (registered on
 * `onBoardChanged`) lays the whole field again whenever the board is re-dealt.
 * Positions move; ids, indices and object identity do not, so anything holding
 * an item reference stays valid across a re-deal.
 */

import { tiles, onBoardChanged } from './layout.js';
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

/*
 * ...AND ON TWO TERRAINS THE MARGIN IS WIDER, BECAUSE THE ITEM IS.
 *
 *   "At the bottom-right several cubes clip through and overhang the raised
 *    rim. At lower density the same hex is clear of the rim, so this is a
 *    max-fill placement problem ... enforce the same inner-margin inset the
 *    lower-density shot already respects."
 *
 * `RIM` is measured to an item's CENTRE, and it has always been one number for
 * all five terrains — which is only defensible while the five items are the
 * same size, and they have not been for three passes. At 2.05 the outermost
 * position a hex will hand out sits at hexFrac 0.737, and the painted lip of
 * the tile starts at ROAD_STRIP_INNER 0.81, so an item has 0.073 of hex — 0.57
 * world units — of body to spend before it is standing on the rim. A sheep is
 * 0.66 across at the fleece on a crowded hex and gets away with it. An ore
 * stack's cut blocks reach 1.02 and a brick stack's reach 0.85, so both of them
 * hang over the lip and both of them do it in hard right angles at ankle
 * height, where the intersection with the rim geometry is unmissable. (A tree
 * reaches further still and is left alone on purpose: a canopy overhanging a
 * path is a canopy overhanging a path, and it happens two units off the ground.)
 *
 * So the margin for those two terrains is the honest sum instead: 0.20 of hex
 * held back from the lip plus the widest block the item actually carries. That
 * puts every cube and every brick course inside hexFrac 0.79 at every item
 * count the board deals, including the 1-pip hexes where the stacks are full
 * size. It costs the mountain 22% of its plantable area and the hill 17%, which
 * on the crowded hexes is more than paid for by the density cap in
 * world/nodelife.js and on the sparse ones is absorbed by `orderForCount`
 * below, which was already pulling those few items toward the middle.
 *
 * Deterministic — it is a constant per terrain, nothing is sampled off it — so
 * `tools/boardsync.mjs` still sees one field from one seed in every process.
 * The other three terrains are byte-identical to what the last pass shipped.
 */
const RIM_BY_KIND = { orerock: 2.72, claypit: 2.52 };

/** Inside a pointy-top hex, shrunk by `margin` on every edge? */
function insideHex(lx, lz, margin) {
  const dx = Math.abs(lx), dz = Math.abs(lz);
  if (dx > INNER - margin) return false;
  if (dz > HEX_SIZE - margin) return false;
  // Distance to the two slanted edges.
  return HEX_SIZE * INNER - HEX_SIZE * 0.5 * dx - INNER * dz > INNER * margin * 1.15;
}

/* ------------------------------------------- the number token's screen shadow
 *
 *   "I don't ever want a resource to hide behind the little number floating
 *    tile above the hex. It can be partially covered, but never more than 30%
 *    of that resource that I'm running around to pick up can be hidden.
 *    Otherwise I get lost and can't find it."
 *
 * The token is a camera-facing billboard standing on the hex's own axis
 * (`buildTokens` in world/island.js), it is depth-tested like everything else,
 * and it writes depth — so anything standing BEHIND it is simply gone. That is
 * a placement problem, not a rendering one, and this is the only place in the
 * codebase that decides where a pickable thing stands. Hence the fix lives
 * here, in the scatter, and costs nothing at run time.
 *
 * THE ARITHMETIC, because every number below is derived rather than eyeballed.
 *
 * Disc geometry. `island.js` builds the quad at half-width R = APOTHEM*0.152 /
 * DISC_FRAC = 1.3776 world units and the painted disc fills DISC_FRAC = 0.86 of
 * it, so the disc's authored radius is 1.1847. The vertex stage multiplies the
 * quad by k = clamp((d/30)^0.62, 0.70, 1.55) for distance and divides its
 * height by lean = cos(view elevation) to undo the camera's squash — which
 * means that whatever the pitch, the disc lands on screen as a TRUE CIRCLE of
 * radius r = 1.1847*k measured in the screen plane. The play camera orbits at
 * 48..66 units, so k runs 1.30..1.55; take the worst, r = 1.836.
 *
 * Where things land on screen. With the camera pitched down by E, a point at
 * height y and horizontal offset u directly away from the camera projects to
 * screen height y*cos(E) + u*sin(E). The disc's centre sits at the token base
 * (ground + 1.15) plus R*k/lean, so its screen height above the hex floor is
 * 1.15*cos(E) + R*k = 2.87 at the play pitch of 50 degrees: a band running from
 * 1.04 to 4.71. Every item on the hex — a sheep tops out at 1.9 world units, a
 * tree at 4.8 — projects into some part of that band from somewhere on the hex,
 * so NO amount of raising or lowering the token gets the field out from behind
 * it. It would take a base lift of about 8.8 units, and a token floating three
 * storeys over the island is a worse bug than the one being fixed.
 *
 * Which half is at risk. Solving "is this item point further from the camera
 * than the disc pixel in front of it" reduces exactly to u > 0: the disc is a
 * vertical plane through the hex axis, so the near half of every hex draws OVER
 * the token and is never hidden at all. Only the far half needs anything.
 *
 * So the escape is sideways, and 30% is the budget. Integrating the disc circle
 * against each item's projected footprint over the full sweep of positions,
 * instance scales (SCALE * JITTER in world/nodelife.js) and camera pitches the
 * game uses — play 50, overview 55, celebration 38, free-look 16..78 — the
 * smallest lateral clearance that holds the hidden share at or under 30% is
 * 2.10 units at the play camera and 2.17 at the shallowest free-look pitch.
 * The sheep sets it: it is the shortest item, so it is the one the disc can
 * swallow whole. TOKEN_LANE_HALF is 2.25, which is that worst case plus a
 * little for the perspective spread this flat-projection model drops.
 *
 * The lane is left open all the way to the back edge of the hex rather than
 * stopping at the depth where items climb clear of the disc (u = 6.08 at the
 * play pitch, past the far rim at the shallowest free-look one), because that
 * costs nothing: the hex has already narrowed to a point by then. It also runs
 * TOKEN_LANE_FRONT = 0.8 units in FRONT of the axis, because an item is a
 * volume and a tree standing just short of the centre still has its back half
 * behind the plane.
 *
 * What it costs: 27% of the hex's plantable area, which sounds severe and is
 * the one thing here you cannot see. The lane is the token's own screen shadow
 * — from the camera the game actually plays at, the token is drawn on top of
 * it. The dressing in world/props.js is NOT excluded from it (grass and ferns
 * are not things you run at), so it fills with ground cover and reads as a
 * clearing under the sign rather than as a bald stripe.
 *
 * It is direction-dependent, and that is deliberate: PLAY_YAW in
 * systems/camera.js is 0, so the camera always sits on +Z and "away" is always
 * -Z. A radial keep-out cannot work — it was the first thing tried, and the
 * maths above says it would have to swallow the whole hex.
 */
const TOKEN_LANE_HALF = 2.25;
const TOKEN_LANE_FRONT = 0.80;

/** False for the strip of hex the number token covers from the play camera. */
function clearOfToken(lx, lz) {
  return lz >= TOKEN_LANE_FRONT || lx <= -TOKEN_LANE_HALF || lx >= TOKEN_LANE_HALF;
}

/**
 * Mitchell best-candidate scatter: for each new item, throw a handful of darts
 * and keep the one furthest from everything already placed. Gives an even,
 * blue-noise field with no clumps and no visible grid — which is what makes a
 * hex readable as "full" and sweepable in one pass.
 *
 * The dart budget went 40 -> 70 when the token lane above started rejecting
 * darts: a quarter of the hex is now off limits, and a candidate that runs out
 * of tries is a candidate that never gets placed, which would quietly shorten
 * the item pool below what a 5-pip hex asks for.
 *
 * THE CANDIDATE COUNT WENT 14 -> 26, and that is the "spread them" half of:
 *
 *   "~30 sheep shoulder-to-shoulder with almost no grass visible reads as a
 *    heap of white popcorn rather than a flock ... spread them and vary their
 *    scale so grass shows between them."
 *
 * Mitchell best-candidate converges on Poisson-disc spacing as the candidate
 * count rises, and 14 is not many when a twenty-eight item hex has already had
 * a quarter of its area taken away by the token lane: the WORST gap in the
 * field — which is the one the eye finds, because it is the pair of sheep that
 * are touching — is set by the unluckiest of twenty-eight draws, not by the
 * average. Measured over twelve boards, going to 26 lifts the tightest pair
 * on a 5-pip pasture from 1.25 units apart to 1.37 — about 10% — and costs a
 * few milliseconds once at boot. It cannot change how
 * many items land (every candidate is still accepted) and it stays perfectly
 * deterministic from the seed, which `tools/boardsync.mjs` checks: the same
 * board deals the same field in every browser and in the match worker, and a
 * pickup replayed by item id has to land on the same object everywhere.
 */
function scatterField(rng, count, margin = RIM) {
  const pts = [];
  for (let i = 0; i < count; i++) {
    let best = null, bestD = -1;
    for (let k = 0; k < 26; k++) {
      let lx = 0, lz = 0, guard = 0;
      do {
        lx = (rng() * 2 - 1) * INNER;
        lz = (rng() * 2 - 1) * HEX_SIZE;
      } while ((!insideHex(lx, lz, margin) || !clearOfToken(lx, lz)) && guard++ < 70);
      if (!insideHex(lx, lz, margin) || !clearOfToken(lx, lz)) continue;
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

/**
 * How much clear ground a point has between itself and the nearest edge of the
 * PLANTABLE hexagon — the tile hexagon shrunk by `RIM` on all six sides, which
 * is the region `insideHex(lx, lz, RIM)` accepts. Zero on the boundary,
 * about 5.74 at the centre.
 *
 * Straight out of the same three half-plane tests `insideHex` runs, divided
 * through by the length of each plane's normal so the answer is in world units:
 * the flat-to-flat planes are |lx| = INNER, and the slanted pair are
 * 0.5|lx| + (INNER/HEX_SIZE)|lz| = INNER.
 */
function edgeClear(lx, lz, margin = RIM) {
  const dx = Math.abs(lx), dz = Math.abs(lz);
  const a = INNER - dx;
  const b = INNER - 0.5 * dx - (INNER / HEX_SIZE) * dz;
  return (a < b ? a : b) - margin;
}

/**
 * Choose WHICH of the pool's positions a hex actually stands its items on.
 *
 *   "Forest hex 12 reads as failed to populate. It has 6 conifers, every one
 *    hugging the rim, with a completely bare interior. Your pass-two density
 *    compensation scaled the trees but did not fix the distribution. Enforce a
 *    minimum visual density for a stocked forest hex AND allow placement in the
 *    tile interior — the number token only occupies the top-centre, so the
 *    middle of the hex is available."
 *
 * The bare middle was not the token lane and it was not the count. It was the
 * SCATTER ORDER. `scatterField` lays a 32-point pool by Mitchell
 * best-candidate — each new point is the one of 26 darts furthest from
 * everything already down — and `tileItemCount` then draws the first
 * TILE_ITEMS[pips] of them, which is 5 on a 2/12 hex. The first point of a
 * farthest-point sequence is a uniform dart and every point after it is, by
 * construction, as far from its predecessors as the region allows: in a convex
 * region that means the CORNERS. Measured over twenty boards the first five
 * points of a pool average hexFrac 0.625 with the outermost at 0.72, against a
 * plantable maximum of about 0.74 — five trees in a ring round the rim with
 * nothing between them, which is exactly what "failed to populate" describes.
 * Sixteen points in the effect has washed out and a 4/5-pip hex is the even
 * blue-noise field it looks like; this only ever bit the hexes with the fewest
 * items, which are also the ones that can least afford it.
 *
 * The pool is left exactly as it was — it is good blue noise and the dense
 * hexes are built on it — and only the ORDER changes: greedy farthest-point
 * again, but scored against the tile's WALL as well as against the points
 * already chosen. A candidate is worth
 *
 *     min( distance to the nearest chosen point, WALL_PULL * edgeClear )
 *
 * so a position pressed up against the plantable boundary scores nothing at all
 * while there is open interior to be had, and the first item on a hex lands in
 * the middle rather than wherever the first dart fell. The two terms swap over
 * on their own as the count rises: on a five-item hex the spacing term is worth
 * five units and the wall term decides everything, while on a twenty-eight-item
 * hex the spacing term is down at two and every position more than a unit
 * inside the boundary is scored on spacing alone — which is why 28 of a 32-pool
 * comes out all but unchanged, minus the four most rim-hugging positions.
 *
 * WALL_PULL is 2.2 because that is where a 5-item hex settles onto a ring at
 * hexFrac 0.45: far enough out to spread over the tile, far enough in that the
 * canopy reads as standing ON the hex rather than around its edge.
 *
 * AND IT IS ONLY RUN ON THE HEXES THAT NEED IT, which is not caution, it is
 * arithmetic. A prefix of a Mitchell sequence is by construction the
 * best-SPREAD subset of that pool — every point after it went into a tighter
 * gap than the one before — so re-picking the subset by any other rule can only
 * cost nearest-neighbour distance. Measured over twenty boards, running this on
 * a 28-item pasture takes the tightest pair from 1.32 units to 1.20 and buys
 * nothing at all in return, because a 28-item hex was never rim-biased in the
 * first place: its mean radius is 0.553 either way. It fills the tile because
 * it has enough items to fill the tile. And "~30 sheep shoulder-to-shoulder
 * with almost no grass visible" is a complaint this build has already had once,
 * so a 9% cut in the worst gap for no gain is not a trade, it is a regression.
 *
 * Under half a pool it runs the other way and runs hard. On a 5-item hex the
 * mean radius drops from 0.625 to 0.403 and the outermost item comes in from
 * 0.72 to 0.52, while the tightest pair only falls from 4.35 units to 3.26 —
 * still more than a third of the hex between neighbours. That is the difference
 * between a ring of trees round a bald patch and a stand of trees on a hex, and
 * it costs spacing nobody could see. Everything from 17 items up is
 * byte-identical to what the last pass shipped.
 *
 * Deterministic — no rng is touched — so `tools/boardsync.mjs` still sees the
 * same field from the same seed in every process, which is what a pickup
 * replayed by item id depends on.
 */
const WALL_PULL = 2.2;

function orderForCount(pts, live, margin = RIM) {
  if (!(live > 0) || live * 2 > pts.length) return pts;
  const pool = pts.slice();
  const chosen = [];
  while (chosen.length < live && pool.length) {
    let pick = 0, bestScore = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const p = pool[i];
      let near = Infinity;
      for (const c of chosen) {
        const d = Math.hypot(c.lx - p.lx, c.lz - p.lz);
        if (d < near) near = d;
      }
      const wall = edgeClear(p.lx, p.lz, margin) * WALL_PULL;
      const score = near < wall ? near : wall;
      if (score > bestScore) { bestScore = score; pick = i; }
    }
    chosen.push(pool.splice(pick, 1)[0]);
  }
  // The unused tail keeps its pool order: nothing reads it, but a hex whose
  // pips were re-dealt upward has to find sane positions waiting for it.
  return chosen.concat(pool);
}

/* ==================================================================== items */

export const items = [];
export const itemsByTile = new Map();

/**
 * Lay one hex's field out, in place.
 *
 * THE SEED IS THE TILE'S NUMBER TOKEN, and that is the whole point: two
 * machines holding the same board hold the same numbers, so they scatter the
 * same 32 items to the same coordinates. It is also why this has to be re-run
 * when the board is re-dealt — see `relayField` below for the bug that lived
 * here for as long as multiplayer did.
 *
 * `pool` is the existing item objects for the tile when there are some, so ids,
 * indices and anything holding a reference survive a re-deal untouched. Only
 * the geometry moves.
 */
function layTile(tile, ti, pool) {
  const rng = mulberry32(90210 + ti * 7717 + tile.number * 313);
  const kind = ITEM_KIND[tile.terrain];
  // How far in from the tile edge this terrain's item may stand, which is a
  // function of how wide that item actually is. See `RIM_BY_KIND`.
  const margin = RIM_BY_KIND[kind] || RIM;
  // The pool is laid first and then re-ORDERED for the number of items this
  // hex actually stands up, so the live prefix is a spread of the whole tile
  // rather than a ring round its rim. See `orderForCount`.
  const pts = orderForCount(scatterField(rng, TILE_ITEM_POOL, margin),
    TILE_ITEMS[tile.pips] || 0, margin);
  const list = pool || [];
  pts.forEach((p, i) => {
    const it = list[i] || {
      id: -1,                       // assigned by the caller that first builds
      tile: tile.id,
      index: i,
      enabled: true,
      collected: false,
      available: true,
      takenBy: -1,
      takenAt: 0,
      legacyNode: -1
    };
    it.resource = tile.resource;
    it.kind = kind;
    it.x = tile.x + p.lx;
    it.z = tile.z + p.lz;
    it.rot = rng() * Math.PI * 2;
    it.scale = 0.86 + rng() * 0.36;
    it.variant = Math.floor(rng() * 3);
    if (!list[i]) list[i] = it;
  });
  return list;
}

tiles.forEach((tile, ti) => {
  if (!tile.resource) return;
  const list = [];
  layTile(tile, ti, list);
  for (const it of list) { it.id = items.length; items.push(it); }
  itemsByTile.set(tile.id, list);
});

/* --------------------------------------------------------------- fast lookup */

const CELL = 6.0;
const grid = new Map();
const cellKey = (x, z) => `${Math.floor(x / CELL)}:${Math.floor(z / CELL)}`;

/** Rebuilt whenever the field moves — a stale bucket is a pickup that misses. */
function rebuildGrid() {
  grid.clear();
  for (const it of items) {
    const k = cellKey(it.x, it.z);
    let bucket = grid.get(k);
    if (!bucket) { bucket = []; grid.set(k, bucket); }
    bucket.push(it);
  }
}
rebuildGrid();

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

/** The same in-place re-lay as `layTile`, for the deprecated prop anchors. */
function layNodes(tile, ti, pool) {
  const rng = mulberry32(1337 + ti * 9176 + tile.number * 131);
  const pts = legacyPoints(rng, NODES_PER_TILE);
  const kind = ITEM_KIND[tile.terrain];
  const list = pool || [];
  pts.forEach((p, i) => {
    const n = list[i] || {
      id: -1,
      tile: tile.id,
      remaining: NODE_CAPACITY,
      regrowAt: 0,
      justRegrew: false
    };
    n.resource = tile.resource;
    n.kind = kind;
    n.x = tile.x + p.lx;
    n.z = tile.z + p.lz;
    n.rot = rng() * Math.PI * 2;
    n.scale = 0.85 + rng() * 0.4;
    n.variant = Math.floor(rng() * 3);
    if (!list[i]) list[i] = n;
  });
  return list;
}

tiles.forEach((tile, ti) => {
  if (!tile.resource) return;
  const list = layNodes(tile, ti, null);
  for (const n of list) { n.id = nodes.length; nodes.push(n); }
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
// FX still fire on roughly the right prop. Re-run whenever either list moves.
function linkLegacy() {
  for (const it of items) {
    const list = nodesByTile.get(it.tile) || [];
    let best = -1, bd = Infinity;
    for (const n of list) {
      const d = (n.x - it.x) * (n.x - it.x) + (n.z - it.z) * (n.z - it.z);
      if (d < bd) { bd = d; best = n.id; }
    }
    it.legacyNode = best;
  }
}
linkLegacy();

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

/* ==================================================== board re-deal support */

/**
 * Re-lay the whole item field onto a freshly shuffled board.
 *
 * THIS USED TO ONLY RE-TAG, and that was the bug that broke multiplayer.
 *
 *   "It was clear it wasn't the same game — the roads and settlements were in
 *    different locations, and when one user built a road the other player
 *    didn't see it at all."
 *
 * The scatter is seeded off `tile.number` (see `layTile`), and every process
 * — every browser, and the match worker — deals a RANDOM board at module load
 * before anybody asks it for a specific one. So the positions were derived
 * from that throwaway board and then never recomputed: same terrain, same
 * numbers, same docks, and a completely different field of 576 trees, sheep
 * and ore on every screen. Running one seed in three processes gave three
 * different scatter hashes against one identical terrain hash.
 *
 * Which is worse than cosmetic. `mirror.js` replays a pickup by item id, so
 * one machine's item 412 was another machine's item 412 standing thirty metres
 * away: props vanished where nobody had been and stayed standing where someone
 * had just run through.
 *
 * So the field is laid again from the new numbers, the spatial grid is rebuilt
 * (a stale bucket is a pickup that misses), and the legacy prop links are
 * re-pointed. Item ids, indices, tile membership and object identity all
 * survive, so anything holding a reference stays valid — only geometry moves.
 *
 * Registered on `onBoardChanged` below, so `layout.reshuffle()` is all a caller
 * has to do. Safe to call directly too.
 */
export function refreshFieldsFromBoard() {
  tiles.forEach((tile, ti) => {
    if (!tile.resource) return;
    const pool = itemsByTile.get(tile.id);
    if (pool) layTile(tile, ti, pool);
    const anchors = nodesByTile.get(tile.id);
    if (anchors) layNodes(tile, ti, anchors);
  });
  // A hex that lost its resource entirely (the desert moving, if it ever does)
  // still has to stop claiming to grow something.
  for (const tile of tiles) {
    if (tile.resource) continue;
    for (const it of itemsByTile.get(tile.id) || []) { it.resource = null; it.kind = null; }
    for (const n of nodesByTile.get(tile.id) || []) { n.resource = null; n.kind = null; }
  }
  rebuildGrid();
  linkLegacy();
  resetNodes();
  return items.length;
}

onBoardChanged(refreshFieldsFromBoard);

/** The enabled (drawable, collectable) items on a tile. */
export function tileItems(tileId) {
  const pool = itemsByTile.get(tileId);
  if (!pool) return EMPTY;
  const n = tileItemCount(tileId);
  return n === pool.length ? pool : pool.slice(0, n);
}

export default items;
