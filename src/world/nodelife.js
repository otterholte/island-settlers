/**
 * Island Settlers — the harvestable FIELD.
 *
 *   buildField(group, mats, opts) -> {
 *     meshes, stumps, triangles, drawCalls, update(dt),
 *     onPick(fn), itemAnchor(id), nodeAnchor(ref), debug(tileId), dispose()
 *   }
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DRAWS
 * ---------------------------------------------------------------------------
 * `board/nodes.js` no longer hands out seven sparse nodes per hex. It hands out
 * a FIELD — ten to twenty-two items on every hex, blue-noise scattered so there
 * are no clumps and no gaps:
 *
 *   "The hex is FULL of each resource, so I can run around it in like 3 seconds
 *    and pick up everything there."
 *
 * So this file draws exactly that: `tileItems(tileId)`, one instance each, a
 * forest packed with trees, a pasture packed with sheep, a hillside packed with
 * clay heaps, a field packed with wheat, a mountain packed with ore. Three
 * hundred objects across eighteen hexes, five InstancedMeshes plus one stump
 * batch.
 *
 * ---------------------------------------------------------------------------
 * THE PICKUP
 * ---------------------------------------------------------------------------
 * There is no chopping, no swings, no progress ring and no toppling sequence.
 * Contact IS the harvest, and the visual has to land on the same frame:
 *
 *   "There should be SUPER CLEAR visual of exactly which sheep, or wood, or
 *    brick I picked up, and exactly where they are left in the hex."
 *
 * The moment an item's `available` flag drops, that instance punches up to 135%
 * and collapses to nothing inside a quarter of a second, with a burst and a
 * flying chip fired from `gatherfx.js` (see `onPick`). A felled tree leaves a
 * stump exactly where it stood, so the hex reads as "these are gone, those are
 * still there" with no ambiguity at all.
 *
 * Nothing here listens to an event. Every frame it compares each item's own
 * `available` flag against what is currently on screen, which means the human,
 * the bots, a restart and a whole-hex restore all animate through one path.
 *
 * Regrowth is whole-hex: every item returns together, sweeping outward from the
 * middle of the hex so it lands as one beat rather than twenty-two pops.
 *
 * The owned / off-limits / worked-out TINT is not here — it rides the shared
 * mood shader in `mood.js`, which paints the terrain and the props together.
 *
 * Owner: World agent.
 */

import * as THREE from 'three';
import { tiles } from '../board/layout.js';
import { tileItems, tileItemCount, mulberry32 } from '../board/nodes.js';
import { heightAt, APOTHEM } from './terrain.js';
import { instanced, setInstance, triCount } from './geo.js';
import { moodAttrFromList } from './mood.js';
import * as K from './propkits.js';

const TAU = Math.PI * 2;
const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeOut = t => 1 - (1 - t) * (1 - t) * (1 - t);

/* Wheat is a BOUND SHEAF: a closed, solid, tied bundle with no flat cards left
   in it. That changes two things about how it is drawn, and both of them are
   the reason the player could not find them.

     * It CASTS A SHADOW now. The standing plant rode the double-sided `grass`
       material with casting off, which is right for a leaf card and wrong for a
       volume: an object with no shadow does not sit on the ground, it hovers in
       front of it, and on sand-coloured ground that was the whole difference
       between seeing one and not.
     * It barely MOVES. `tree` sways 0.026 against `grass`'s 0.105 — a tied
       bundle should shift in the wind, not wave. Standing crop waves; this is
       cut, bound and stacked. */
const KIT = {
  tree:    { make: K.fieldTree,  mat: 'tree',  cast: true },
  wheat:   { make: K.fieldWheat, mat: 'tree',  cast: true },
  sheep:   { make: K.fieldSheep, mat: 'solid', cast: true },
  claypit: { make: K.fieldClay,  mat: 'solid', cast: true },
  orerock: { make: K.fieldOre,   mat: 'solid', cast: true }
};

/* Per-instance colour variation. Three or four readings per kind for free. */
const TINTS = {
  tree:    [[1.00, 1.02, 0.96], [1.09, 1.00, 0.84], [0.90, 1.04, 0.94], [1.14, 1.05, 0.90]],
  // Kept close to 1: a standing crop varies in HUE across a field, not in
  // brightness. The old 0.88/0.87/0.76 reading turned a third of every hex
  // olive, which is what made the gold look muddy at play distance.
  wheat:   [[1.00, 1.00, 1.00], [1.06, 1.01, 0.86], [0.95, 0.94, 0.88]],
  sheep:   [[1.00, 1.00, 1.00], [0.93, 0.92, 0.90], [1.05, 1.04, 1.00]],
  claypit: [[1.00, 1.00, 1.00], [1.10, 0.93, 0.84], [0.88, 0.84, 0.82]],
  orerock: [[1.00, 1.00, 1.00], [0.84, 0.88, 0.98], [1.04, 1.00, 0.94]]
};

/* How big each item stands, and how far it sinks into the ground. Deliberately
   chunky: an item you cannot see is an item you cannot decide to run at.
   The tree is untouched — the player likes the tree, it is the benchmark — and
   the other four have been walked up toward it until each one is a real
   two-unit object rather than a trinket in tall grass. */
/* BOTH ORE AND WHEAT WERE RESHAPED, so both instance scales are re-derived.

   ORE is now a 1.5-unit stack of cut grey blocks on a spoil apron rather than a
   3.5-unit jagged oval, so the scale goes back UP to put its world footprint in
   the same band as the brick stack it is modelled on. Still sunk deepest of the
   five — a stack of cut stone settles INTO the scree it was dug out of.

   WHEAT is now a bound sheaf: a 2.5-unit closed drum roughly 1.6 across, in
   place of a 2.7-unit feathery plant that was mostly air. The measured height
   barely changes — 2.4 to 3.1 world units against 2.8 to 3.9 — but the MASS at
   that height is several times what it was, which is the whole point:

     "The wheats are still way too small and pointy and thin ... I'm having a
      hard time quickly identifying where they are even as I'm running around
      the hex."

   Thin was the complaint, not short. A sheaf reads at a glance from any bearing,
   drops a hard shadow on the sand, and — because they now stand clear of each
   other rather than brushing at the leaves — can be COUNTED, which is the other
   half of what was asked for. Nothing about the item POSITIONS changed. */
const SCALE = {
  tree:    [1.10, 1.50],
  wheat:   [1.02, 1.16],
  sheep:   [1.12, 1.34],
  claypit: [1.14, 1.40],
  orerock: [1.18, 1.40]
};
const SINK = { tree: 0.10, wheat: 0.05, sheep: 0.02, claypit: 0.10, orerock: 0.09 };

/* ------------------------------------------------------- density compensation
 *
 * How big an item stands ALSO depends on how many of them the hex holds, and
 * the reviewer asked for this from both ends of the same problem:
 *
 *   "The hex at token 2 has 6-7 small pines on a large hex with a bare middle
 *    and reads as failed to populate. Floor it around 12-15, or scale trees up
 *    when the count is low so the hex still reads as woodland."
 *
 *   "~30 sheep shoulder-to-shoulder with almost no grass visible reads as a
 *    heap of white popcorn rather than a flock ... If the count cannot safely
 *    change, spread them and vary their scale instead so grass shows between
 *    them."
 *
 * The COUNT cannot safely change. `TILE_ITEMS` in core/constants.js maps a
 * hex's pips to how many items it holds — 5, 8, 17, 23, 28 — and that mapping
 * is the economy: it is what makes a 6/8 hex worth building on and a 2/12 hex
 * not, it is what the bot simulation is balanced against, and it is not this
 * file's to move. It is also not in this pass's scope. What IS in scope is how
 * big each of those items is drawn, and that is the same lever pointed at both
 * complaints:
 *
 *   a hex with FEW items grows them, so eight trees still close a canopy;
 *   a hex with MANY items shrinks them, so twenty-eight sheep still show grass.
 *
 * The curve is sqrt(REF / n), which is the honest one: item COVERAGE goes as
 * the square of linear scale, so a square-root law holds total coverage roughly
 * constant as the count changes, which is exactly the property "reads equally
 * full at every count" is asking for. REF is 17 — the three-pip hex, the
 * commonest on the board — so the middle of the range is left exactly where it
 * was and only the ends move.
 *
 * The clamps are per kind, and they are asymmetric on purpose.
 *
 *   TREE never shrinks. A packed forest is the one thing on this island nobody
 *   has ever complained about, so the 23 and 28 hexes are left alone entirely
 *   and only the sparse ones are grown. The ceiling was 1.26 and it did not
 *   carry a 1-pip hex:
 *
 *     "Forest hex 12 reads as failed to populate ... Enforce a minimum visual
 *      density for a stocked forest hex AND allow placement in the tile
 *      interior."
 *
 *   Two levers and both were needed. The DISTRIBUTION half is fixed in
 *   `orderForCount` in board/nodes.js — the five trees on a 1-pip hex used to
 *   be picked off the front of a farthest-point sequence, which put every one
 *   of them on the rim. This is the other half: five trees spread evenly over
 *   a hex are still only five trees, and 1.26 leaves a 5-item forest at 46% of
 *   the canopy coverage a 17-item one carries. 1.38 is the honest square-root
 *   answer for eight items and as far as five can usefully be pushed — a canopy
 *   2.8 to 3.6 units wide standing 4.0 to 6.6, against a mean nearest-neighbour
 *   gap of 3.3 units on those hexes, so the crowns touch and the hex reads as a
 *   stand of hero pines in open woodland. Past that the trees start reading as
 *   scenery scaled up rather than as trees, and a 1-pip hex is honestly sparse:
 *   it is a hex that grows five trees, and no amount of scale makes it a
 *   canopy.
 *
 *   SHEEP never grows past a little. A flock does not read as "one enormous
 *   sheep" and the player asked for these to be BIGGER not so long ago, so the
 *   ceiling is 1.12 and the work is done at the other end. On a 28-sheep hex
 *   0.78 takes the biggest animal from about 2.5 units across to about 2.0 and
 *   the smallest from 1.5 to 1.2, which is 39% of the fleece area gone off the
 *   hex — and since the plantable part of a hex is only about half of it once
 *   the road rim and the token lane are taken out, that is the difference
 *   between animals whose footprints genuinely overlap and animals with a
 *   collar of turf round each of them.
 *
 *   ORE AND BRICK SHRINK AND NEVER GROW, and that is new.
 *
 *     "The fully regrown ore hex is packed solid. Roughly 60 cubes cover the
 *      tile wall-to-wall with no ground visible at all ... At lower density the
 *      same hex is nicely spaced and clear of the rim, so this is a max-fill
 *      placement problem, not an art problem. Cap the density so ground shows
 *      through. Check the other terrains at max fill too."
 *
 *   Checked, and the brick hill is the same picture in terracotta: a 5-pip
 *   hills hex is twenty-eight stepped stacks with no floor left between them.
 *   The arithmetic says it has to be. A full-size ore stack covers about 3.3
 *   square units on the widest reading of its blocks; twenty-eight of them is
 *   92, against about 114 of plantable hexagon before the token lane takes its
 *   quarter — so the field is asking for more ground than the hex has, and what
 *   the eye sees is the overlap. The same sum at seventeen items comes to 56 on
 *   the same 114 and looks exactly as it should, which is why this only ever
 *   showed up on the 4- and 5-pip hexes.
 *
 *   So the same square-root law the flock uses runs on both, with the CEILING
 *   pinned at 1.00: a hex with fewer items never grows its stacks, because
 *   "make the bricks, wheat, ore and sheep all larger" is a note this build has
 *   already had and the sparse hexes are where it landed best. Only the crowded
 *   end moves — 0.78 at twenty-eight, 0.86 at twenty-three, untouched at
 *   seventeen and below. At 0.78 a stack still stands about 1.9 units tall,
 *   half again the height of a sheep, and thirty-nine per cent of the footprint
 *   comes off the tile, which is the difference between a solid pile and a hex
 *   with grey floor showing between its diggings.
 *
 *   The other half of that note — the cubes clipping through the raised rim —
 *   is not a scale problem and is not fixed here. It is the plantable margin,
 *   and it lives in `RIM_BY_KIND` in board/nodes.js.
 *
 *   Wheat is left alone. A 4-pip fields hex photographs with clear sand between
 *   every sheaf, because a bound sheaf is a 1.6-unit drum where an ore stack is
 *   a 2.8-unit apron, and the crop has already been through two size passes
 *   against the player's own words.
 */
const DENSITY_REF = 17;
const DENSITY = {
  tree: [1.00, 1.38], sheep: [0.78, 1.12],
  orerock: [0.78, 1.00], claypit: [0.78, 1.00]
};

function densityScale(kind, count) {
  const band = DENSITY[kind];
  if (!band || !count) return 1;
  const k = Math.sqrt(DENSITY_REF / count);
  return k < band[0] ? band[0] : k > band[1] ? band[1] : k;
}

/* Per-item size jitter, folded on top of SCALE. The board hands out
   `item.scale` in 0.86..1.22; at the old gain that spread a claypit across a
   0.86..1.18 band, and with items now twice as wide the biggest of them started
   colliding with their neighbours on a 22-item hex. Tightened to 0.92..1.14,
   which keeps the field from looking stamped without letting anything grow into
   the blue-noise gaps a settler runs down. */
const JITTER_MID = 0.92;
const JITTER_GAIN = 0.62;

/* Seconds. TAKE is short on purpose — the player asked to not wait for it. */
const TAKE = 0.26;
const GROW = 0.52;

/* How many of the harvestable trees leave a stump where they stood.
 *
 *   "There are a few too many stumps on the tree hexes when it's empty."
 *   "Cut stumps to 3-4 per hex maximum. Currently ~9-10."
 *
 * This was a SHARE and it should never have been one. A quarter of the trees on
 * a hex is a quarter of five on a 1-pip hex and a quarter of twenty-eight on a
 * 5-pip one, so the two ends of the board came out at one stump and seven — and
 * seven is not what "a few subtle stumps when its empty waiting to recharge"
 * describes, it is a stump field. Worse, a share is a share of the whole tile
 * with no idea where the trees are, so on a good day it left seven posts spread
 * out and on a bad one it left seven in a huddle with half the hex bare.
 *
 * It is a COUNT now, capped at four, and the trees that leave one are chosen by
 * FARTHEST-POINT from each other rather than by a hash: pick the tree nearest
 * the middle of the hex, then repeatedly pick whichever remaining tree is
 * furthest from every stump already chosen. Four marks spread to the corners of
 * the tile say "somebody logged this" from across the island; four marks in a
 * huddle say nothing at all and leave the rest of the hex looking untouched.
 *
 * Two on the smallest hexes, four on the biggest, three in between — the count
 * still tracks how much timber came off, it just does it inside a band the
 * player can look at. Everything here is derived from item POSITIONS, which are
 * deterministic from the board seed, so the same trees leave the same marks in
 * every browser and on every visit to the same hex; a stump that moved between
 * two visits would read as a new object appearing.
 *
 * NOTE the `stump` geometry changed with this (see `stump()` in propkits.js).
 * Four mud clods and four sawn stumps are not the same picture, and both halves
 * of the reviewer's note — how many, and what they look like — had to move
 * together for a cleared forest to read. */
/*
 * RAISED AGAIN, ON THE OWNER'S SECOND LOOK.
 *
 *   "Add a few more stumps to the empty tree hexes."
 *
 * Two and four were the answer to the opposite complaint — nine or ten posts
 * reading as a stump field — and they went too far the other way once every
 * DECORATIVE tree had also been deleted. A cleared forest with two marks on it
 * does not read as a forest that was logged; it reads as a hex that never had
 * anything on it, which is exactly the "failed to populate" note the wide shot
 * drew earlier for the same reason.
 *
 * Four to seven, still by farthest-point so they spread rather than huddle, and
 * still a count rather than a share so a 1-pip hex and a 5-pip hex both land
 * inside the band. Seven is where the last pass measured the complaint starting,
 * so the ceiling sits one under it.
 */
const STUMPS_MAX = 6;
const STUMPS_MIN = 4;

/** Which slots on one tile leave a mark: up to four, spread as widely as the
 *  trees on that tile allow. `slots` is that tile's tree slots, in item order. */
function pickStumps(slots) {
  const want = Math.max(STUMPS_MIN,
    Math.min(STUMPS_MAX, Math.round(slots.length * 0.30)));
  if (slots.length <= want) return slots.slice();
  const pool = slots.slice();
  const out = [];
  // Seed on the tree closest to the middle of its own group, so the first mark
  // is never a lone post out on the rim.
  let cx = 0, cz = 0;
  for (const s of pool) { cx += s.x; cz += s.z; }
  cx /= pool.length; cz /= pool.length;
  let bi = 0, bd = Infinity;
  for (let i = 0; i < pool.length; i++) {
    const d = (pool[i].x - cx) ** 2 + (pool[i].z - cz) ** 2;
    if (d < bd) { bd = d; bi = i; }
  }
  out.push(pool.splice(bi, 1)[0]);
  while (out.length < want && pool.length) {
    let best = 0, bestD = -1;
    for (let i = 0; i < pool.length; i++) {
      let d = Infinity;
      for (const o of out) {
        const dd = (pool[i].x - o.x) ** 2 + (pool[i].z - o.z) ** 2;
        if (dd < d) d = dd;
      }
      if (d > bestD) { bestD = d; best = i; }
    }
    out.push(pool.splice(best, 1)[0]);
  }
  return out;
}

export function buildField(group, mats, opts = {}) {
  const byKind = { tree: [], wheat: [], sheep: [], claypit: [], orerock: [] };

  /* Only the ENABLED items are ever drawable, so the instance batches are sized
     to exactly the 300 items the board actually holds rather than the 432-strong
     position pool. Thirty per cent of the field's triangles, saved by counting. */
  const drawable = [];
  for (const t of tiles) {
    if (!t.resource) continue;
    for (const it of tileItems(t.id)) drawable.push(it);
  }
  for (const it of drawable) if (byKind[it.kind]) byKind[it.kind].push(it);

  const mesh = {};
  const tintAttr = {};
  const geos = {};
  const slots = [];
  const byItem = new Map();
  const byTile = new Map();
  const active = new Set();
  const dirty = new Set();
  let triangles = 0;
  let drawCalls = 0;

  const pickHooks = [];

  /* ---------------------------------------------------------------- build */

  function variantOf(x, z, n) {
    let h = Math.imul((x * 73.7) | 0, 374761393) ^ Math.imul((z * 91.3) | 0, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) % n;
  }

  for (const kind in byKind) {
    const list = byKind[kind];
    if (!list.length) continue;
    const spec = KIT[kind];
    const geo = spec.make();
    geos[kind] = geo;
    const m = instanced(geo, mats[spec.mat], list.length, spec.cast, true);
    m.name = `field-${kind}`;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.geometry.setAttribute('aMood', moodAttrFromList(list));
    group.add(m);
    mesh[kind] = m;
    triangles += triCount(geo) * list.length;
    drawCalls++;

    const table = TINTS[kind];
    const tint = new Float32Array(list.length * 3);
    const sc = SCALE[kind];

    list.forEach((it, i) => {
      const rng = mulberry32(60013 + it.id * 7919);
      const tile = tiles[it.tile];
      let s = (sc[0] + rng() * (sc[1] - sc[0]))
        * (JITTER_MID + (it.scale - 0.86) * JITTER_GAIN)
        * densityScale(kind, tileItemCount(it.tile));
      // A FLOCK IS NOT A HERD OF CLONES. The board's own `it.scale` jitter is
      // deliberately tight (0.92..1.14, see JITTER_GAIN above) so that a field
      // of items can be counted at a glance, and for four of the five kinds
      // that is right. It is wrong for sheep, and it is a good part of why
      // twenty-eight of them read as "a heap of white popcorn": every animal
      // the same size in a regular blue-noise lattice is a TEXTURE, and a
      // texture is exactly the thing the eye stops resolving into objects.
      // Half again as much spread, on the item's own deterministic stream so
      // the same sheep is the same size in every browser — lambs among ewes,
      // which is what breaks the lattice and lets the grass through.
      if (kind === 'sheep') s *= 0.84 + rng() * 0.34;
      const v = table[variantOf(it.x, it.z, table.length)];
      const sl = {
        item: it, kind, i,
        x: it.x, z: it.z,
        y: heightAt(it.x, it.z) - SINK[kind] * s,
        ry: it.rot, s,
        alive: true, phase: 0, t: 0,
        stump: -1, stumpS: 0,
        bob: rng() * TAU, sway: 0.6 + rng() * 0.8,
        tdist: tile ? Math.hypot(it.x - tile.x, it.z - tile.z) / APOTHEM : 0,
        rng
      };
      slots.push(sl);
      byItem.set(it.id, sl);
      let bucket = byTile.get(it.tile);
      if (!bucket) byTile.set(it.tile, bucket = []);
      bucket.push(sl);
      tint[i * 3] = v[0]; tint[i * 3 + 1] = v[1]; tint[i * 3 + 2] = v[2];
      writeSlot(sl);
    });

    m.instanceColor = new THREE.InstancedBufferAttribute(tint, 3);
    m.instanceColor.needsUpdate = true;
    tintAttr[kind] = m.instanceColor;
    m.instanceMatrix.needsUpdate = true;
  }

  /* Stumps, and how few of them there now are.
   *
   *   "Make the empty hexes once the resources are gone look more empty and
   *    less busy. Right now it's too overstimulating."
   *
   * Every harvestable tree used to leave one, and every fellable decorative
   * conifer left one on top of that — fifty-odd posts standing in a hex that is
   * supposed to read as CLEARED. A stump field is not empty, it is a different
   * kind of busy. So only two to four trees PER HEX leave a mark now, chosen by
   * farthest-point so they land spread out (`pickStumps` above; the dressing
   * over in `stand.js` keeps its own smaller share for kits that can be felled,
   * of which the recipe currently drops none). That is enough to say "trees
   * stood here" and nowhere near enough to fill the hex back up. Shared mesh, so
   * it costs no extra call. */
  let stumpMesh = null;
  let stumpBase = 0;
  const stumpSpare = Math.max(0, opts.extraStumps | 0);
  {
    const perTile = new Map();
    for (const s of slots) {
      if (s.kind !== 'tree') continue;
      let b = perTile.get(s.item.tile);
      if (!b) perTile.set(s.item.tile, b = []);
      b.push(s);
    }
    const marked = new Set();
    for (const b of perTile.values()) for (const s of pickStumps(b)) marked.add(s);
    const treeSlots = slots.filter(s => marked.has(s));
    const total = treeSlots.length + stumpSpare;
    if (total) {
      const geo = K.stump();
      geos.stump = geo;
      stumpMesh = instanced(geo, mats.solid, total, false, true);
      stumpMesh.name = 'field-stump';
      stumpMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      const mood = new Float32Array(total * 2);
      treeSlots.forEach((sl, i) => {
        mood[i * 2] = sl.item.tile;
        mood[i * 2 + 1] = 1;
      });
      stumpMesh.geometry.setAttribute('aMood',
        new THREE.InstancedBufferAttribute(mood, 2));
      stumpMesh.userData.moodArray = mood;
      group.add(stumpMesh);
      triangles += triCount(geo) * total;
      drawCalls++;
      treeSlots.forEach((sl, i) => {
        sl.stump = i;
        setInstance(stumpMesh, i, sl.x, sl.y, sl.z, sl.ry + 0.7, 0.0001, 0.0001);
      });
      stumpBase = treeSlots.length;
      for (let i = stumpBase; i < total; i++) {
        setInstance(stumpMesh, i, 0, -60, 0, 0, 0.0001, 0.0001);
      }
      stumpMesh.instanceMatrix.needsUpdate = true;
    }
  }

  /* --------------------------------------------------------------- write */

  function writeStump(sl) {
    if (!stumpMesh || sl.stump < 0) return;
    const g = Math.max(0.0001, sl.s * sl.stumpS * 1.05);
    setInstance(stumpMesh, sl.stump, sl.x, heightAt(sl.x, sl.z) - 0.06, sl.z,
      sl.ry + 0.7, g, g);
    dirty.add('stump');
  }

  /**
   * One item's instance matrix. Everything a resource does when you run over it
   * lives in the `phase === 1` branch: a hard punch outward, then gone.
   */
  function writeSlot(sl) {
    const m = mesh[sl.kind];
    if (!m) return;
    let x = sl.x, z = sl.z, y = sl.y;
    let ry = sl.ry, rx = 0, rz = 0;
    let s = sl.s, sy = sl.s;

    if (sl.phase === 1) {
      /* -------------------------------------------------------- taken */
      const u = clamp01(sl.t / TAKE);
      // punch up hard, then collapse: it should feel like the item leapt into
      // your pack rather than faded out of the world
      const punch = Math.sin(Math.min(1, u / 0.34) * Math.PI * 0.5);
      const gone = clamp01((u - 0.30) / 0.70);
      const k = (1 + punch * 0.36) * (1 - gone * gone);
      s = sl.s * k;
      sy = sl.s * k * (1 + punch * 0.16);
      y = sl.y + u * 0.55;
      ry = sl.ry + u * 2.4;
      rz = u * 0.55;
      if (sl.kind === 'tree') sl.stumpS = clamp01(u / 0.42);
    } else if (sl.phase === 2) {
      /* ------------------------------------------------------ growing */
      const u = clamp01(sl.t / GROW);
      const pop = easeOut(u) * (1 + Math.sin(u * Math.PI) * 0.22);
      s = sl.s * Math.max(0.02, pop);
      sy = sl.s * Math.max(0.02, pop * (1 + (1 - u) * 0.26));
      ry = sl.ry + (1 - u) * 0.9;
      if (sl.kind === 'tree') sl.stumpS = Math.max(0, 1 - u * 2.2);
    } else if (!sl.alive) {
      /* ----------------------------------------------------- collected */
      s = 0.0001; sy = 0.0001;
    } else if (sl.kind === 'sheep') {
      // a standing flock is never quite still, but it never wanders either:
      // you have to be able to look away and still know which sheep is which
      y = sl.y + Math.sin(sl.bob) * 0.05;
      rz = -0.18 + Math.sin(sl.bob * 0.7) * 0.09;
      ry = sl.ry + Math.sin(sl.bob * 0.31) * 0.16;
    }

    setInstance(m, sl.i, x, y, z, ry, Math.max(s, 0.0001), Math.max(sy, 0.0001), rx, rz);
    dirty.add(sl.kind);
  }

  /* ----------------------------------------------------------- lifecycle */

  function startTake(sl) {
    sl.alive = false;
    sl.phase = 1;
    sl.t = 0;
    active.add(sl);
    const it = sl.item;
    for (const fn of pickHooks) {
      try { fn(it, it.takenBy, sl); } catch (e) { /* presentation is optional */ }
    }
  }

  function startGrow(sl, delay) {
    sl.alive = true;
    sl.phase = 2;
    sl.t = -(delay || 0);
    sl.stumpS = 1;
    active.add(sl);
  }

  /* ---------------------------------------------------------------- loop */

  let clock = 0;
  const sheepSlots = slots.filter(s => s.kind === 'sheep');

  function update(dt) {
    clock += dt;

    /* 1. reconcile against the truth. Three hundred flag comparisons; the
       whole point is that the human, the bots, a whole-hex restore and an
       in-place restart all animate down this one path. */
    for (let i = 0; i < slots.length; i++) {
      const sl = slots[i];
      const want = sl.item.available;
      if (want === sl.alive) continue;
      if (want) startGrow(sl, sl.tdist * 0.42 + sl.rng() * 0.08);
      else startTake(sl);
    }

    /* 2. the idle flock */
    for (const sl of sheepSlots) {
      if (!sl.alive || sl.phase !== 0) continue;
      sl.bob += dt * sl.sway;
      writeSlot(sl);
    }

    /* 3. anything mid-animation */
    if (active.size) for (const sl of Array.from(active)) {
      sl.t += dt;
      let live = false;
      if (sl.phase === 1) {
        if (sl.t >= TAKE) { sl.phase = 0; sl.t = 0; } else live = true;
      } else if (sl.phase === 2) {
        if (sl.t < 0) live = true;
        else if (sl.t >= GROW) { sl.phase = 0; sl.t = 0; sl.stumpS = 0; }
        else live = true;
      }
      if (sl.kind === 'tree') writeStump(sl);
      writeSlot(sl);
      if (!live) active.delete(sl);
    }

    for (const kind of dirty) {
      if (kind === 'stump') { if (stumpMesh) stumpMesh.instanceMatrix.needsUpdate = true; }
      else if (mesh[kind]) mesh[kind].instanceMatrix.needsUpdate = true;
    }
    dirty.clear();
  }

  /* ----------------------------------------------------------------- api */

  return {
    meshes: mesh,
    stumpMesh,
    /** Spare stump instances `stand.js` may drive for the decorative timber. */
    stumps: { mesh: stumpMesh, base: stumpBase, count: stumpSpare },
    triangles,
    drawCalls,
    update,
    items: drawable,

    /** Called the instant an item is taken: (item, playerId, slot). */
    onPick(fn) { if (typeof fn === 'function') pickHooks.push(fn); },

    /** Where an item's geometry actually stands. */
    itemAnchor(id) {
      const sl = byItem.get(id);
      if (!sl) return null;
      return { x: sl.x, y: sl.y + sl.s * 0.9, z: sl.z };
    },

    /** Compatibility shims for callers that still speak in legacy node ids. */
    playHarvest() { /* the field reconciles itself; nothing to schedule */ },
    setDepleted() { /* whole-hex recovery is polled off the item flags */ },
    nodeAnchor(ref) {
      if (!ref) return null;
      const x = ref.x !== undefined ? ref.x : 0;
      const z = ref.z !== undefined ? ref.z : 0;
      return { x, y: heightAt(x, z), z };
    },

    /** Debug / capture hook: how much of a hex is actually on screen. */
    debug(tileId) {
      const list = tileId === undefined ? slots : (byTile.get(tileId) || []);
      let standing = 0, going = 0;
      for (const sl of list) {
        if (sl.alive && sl.phase === 0) standing++;
        else if (sl.phase !== 0) going++;
      }
      return { units: list.length, standing, animating: going, active: active.size };
    },

    dispose() { for (const k in geos) geos[k].dispose(); }
  };
}

export const buildNodeLife = buildField;
export default buildField;
