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
import { tileItems, mulberry32 } from '../board/nodes.js';
import { heightAt, APOTHEM } from './terrain.js';
import { instanced, setInstance, triCount } from './geo.js';
import { moodAttrFromList } from './mood.js';
import * as K from './propkits.js';

const TAU = Math.PI * 2;
const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeOut = t => 1 - (1 - t) * (1 - t) * (1 - t);

const KIT = {
  tree:    { make: K.fieldTree,  mat: 'tree',  cast: true },
  wheat:   { make: K.fieldWheat, mat: 'wheat', cast: false },
  sheep:   { make: K.fieldSheep, mat: 'solid', cast: true },
  claypit: { make: K.fieldClay,  mat: 'solid', cast: true },
  orerock: { make: K.fieldOre,   mat: 'solid', cast: true }
};

/* Per-instance colour variation. Three or four readings per kind for free. */
const TINTS = {
  tree:    [[1.00, 1.02, 0.96], [1.09, 1.00, 0.84], [0.90, 1.04, 0.94], [1.14, 1.05, 0.90]],
  wheat:   [[1.00, 1.00, 1.00], [1.10, 0.99, 0.80], [0.88, 0.87, 0.76]],
  sheep:   [[1.00, 1.00, 1.00], [0.93, 0.92, 0.90], [1.05, 1.04, 1.00]],
  claypit: [[1.00, 1.00, 1.00], [1.10, 0.93, 0.84], [0.88, 0.84, 0.82]],
  orerock: [[1.00, 1.00, 1.00], [0.84, 0.88, 0.98], [1.10, 1.05, 0.98]]
};

/* How big each item stands, and how far it sinks into the ground. Deliberately
   chunky: an item you cannot see is an item you cannot decide to run at. */
const SCALE = {
  tree:    [1.10, 1.50],
  wheat:   [1.05, 1.40],
  sheep:   [1.06, 1.30],
  claypit: [1.00, 1.28],
  orerock: [1.00, 1.30]
};
const SINK = { tree: 0.10, wheat: 0.04, sheep: 0.02, claypit: 0.06, orerock: 0.10 };

/* Seconds. TAKE is short on purpose — the player asked to not wait for it. */
const TAKE = 0.26;
const GROW = 0.52;

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
      const s = (sc[0] + rng() * (sc[1] - sc[0])) * (0.86 + (it.scale - 0.86) * 0.9);
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

  /* Stumps. One per harvestable tree, plus however many spares `stand.js`
     asked for so the decorative timber can leave stumps on the SAME batch —
     which is what turns a cleared forest into a clear-cut instead of a forest
     with holes in it. Shared mesh, so it costs no extra draw call. */
  let stumpMesh = null;
  let stumpBase = 0;
  const stumpSpare = Math.max(0, opts.extraStumps | 0);
  {
    const treeSlots = slots.filter(s => s.kind === 'tree');
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
