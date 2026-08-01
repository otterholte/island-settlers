/**
 * Island Settlers — the standing stock of a region.
 *
 *   countFellable(bucket)          -> how many stump instances to reserve
 *   buildStand(group, dressing, stumps) -> { update(dt), debug(tileId), dispose() }
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * The player asked for a tile that IS the resource:
 *
 *   "the entire tree hex is made of trees ... the whole tile is split into
 *    individual trees. And if you walk into those trees on your tile, you pick
 *    them up / chop them down, and as soon as you walk over them, they're
 *    chopped up and you only see stumps."
 *
 * A forest tile carries 21 harvestable sub-units (nodelife.js) AND about 36
 * decorative conifers, 16 ferns, 34 grass tufts. If only the 21 answer to the
 * harvest, a "clear cut" is a full forest with 21 gaps in it. So the DRESSING
 * is part of the stand too: every responsive prop on the tile is a unit in one
 * pool, and the tile's 21 harvest events spend that whole pool.
 *
 * Two rules make it read:
 *
 *   1. PROXIMITY, NOT OWNERSHIP. When the region's standing count drops, the
 *      props that go are the ones nearest the settler who swung — so the stand
 *      clears along the path you actually walked, not in a ring around an
 *      abstract node you cannot see.
 *
 *   2. STUMPS, NOT SLASH. A felled conifer topples, then sinks away while a
 *      stump grows in its place. A whole spruce lying on its side keeps its
 *      canopy pointing at the sun and turns a clear-cut into green litter;
 *      a stump field still says "this was a forest" and says "there is nothing
 *      here to chop" at the same time. The stumps ride nodelife's own stump
 *      InstancedMesh (it reserves spares for us), so this costs no draw call.
 *
 * Everything here is instance matrices and instance colours. Nothing is created,
 * nothing is deleted, no count changes, and it all reverses when the region
 * grows back — sweeping outward from the middle of the hex.
 *
 * Owner: World agent.
 */

import * as THREE from 'three';
import { NODE_CAPACITY } from '../core/constants.js';
import { tiles } from '../board/layout.js';
import { nodesByTile } from '../board/nodes.js';
import { heightAt, APOTHEM } from './terrain.js';
import { setInstance } from './geo.js';

const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);

/*
 * How each dressing kit answers to the harvest, per terrain.
 *   fell     topples and is replaced by a stump
 *   crop     cut down to stubble
 *   flatten  mashed into the ground
 *   wilt     colour only — it was never the crop
 */
export const ROLE = {
  forest: {
    conifer: 'fell', coniferShort: 'fell', broadleaf: 'fell',
    undergrowth: 'flatten', grass: 'crop', flower: 'crop'
  },
  fields: {
    wheat: 'crop', grass: 'crop', undergrowth: 'flatten', flower: 'crop'
  },
  pasture: {
    grass: 'crop', flower: 'crop', undergrowth: 'flatten'
  },
  hills: {
    grass: 'crop', undergrowth: 'flatten', flower: 'crop', rockSmall: 'wilt'
  },
  mountains: {
    grass: 'crop', rockSmall: 'wilt', boulder: 'wilt'
  }
};

/* Vertical squash and horizontal pinch a `crop` leaves behind. */
/* A cropped field has to still LOOK like a field. Cut too far and a worked-out
   fields tile is bare mud with a fence round it, and the player loses the "you
   can still tell what this hex was" read they asked for. */
const CROP = {
  wheat:  [1.08, 0.26],
  grass:  [0.98, 0.34],
  flower: [0.85, 0.24],
  undergrowth: [0.95, 0.28]
};

/* How big a stump a felled dressing tree leaves, relative to its own scale. */
const STUMP_K = { conifer: 0.58, coniferShort: 0.54, broadleaf: 0.66 };

/* instanceColor multiplier at full response — straw, dust and dead wood. */
const WORN_MUL = {
  conifer: [0.52, 0.42, 0.30], coniferShort: [0.52, 0.42, 0.30],
  broadleaf: [0.56, 0.46, 0.32], undergrowth: [0.62, 0.54, 0.38],
  grass: [0.80, 0.68, 0.40], flower: [0.74, 0.66, 0.46],
  wheat: [0.80, 0.70, 0.48], rockSmall: [0.78, 0.76, 0.74],
  boulder: [0.78, 0.76, 0.74]
};

/* Chunky, not graceful. The player asked for "as soon as you walk over them,
   they're chopped up", so a struck prop is down inside a second. */
const RATE = { fell: 4.6, crop: 5.6, flatten: 5.6, wilt: 3.0 };

function match() {
  const g = typeof globalThis !== 'undefined' ? globalThis : null;
  return (g && g.__ISLAND__) || null;
}

/** How many stump instances the stand will need. Call before buildNodeLife. */
export function countFellable(bucket) {
  let n = 0;
  for (const kit in bucket) {
    for (const o of bucket[kit]) {
      const t = tiles[o.tile];
      if (!t) continue;
      if ((ROLE[t.terrain] || {})[kit] === 'fell') n++;
    }
  }
  return n;
}

/* ================================================================= factory */

export function buildStand(group, dressing, stumps) {
  const smesh = stumps && stumps.mesh ? stumps.mesh : null;
  const sbase = stumps ? stumps.base | 0 : 0;
  const scap = stumps ? stumps.count | 0 : 0;
  let snext = 0;
  let sdirty = false;

  /* ------------------------------------------------------- region records */
  const regions = [];
  const byTile = new Map();
  for (const t of tiles) {
    const list = nodesByTile.get(t.id);
    if (!list || !list.length) continue;
    const rec = {
      tile: t, nodes: list,
      maxUnits: list.length * NODE_CAPACITY,
      items: [], struck: 0
    };
    regions.push(rec);
    byTile.set(t.id, rec);
  }

  /* ------------------------------------------------------------ the pool */
  const kitMeshes = new Set();
  const kitDirty = new Set();

  if (dressing) {
    for (const kit in dressing) {
      const { mesh, list } = dressing[kit];
      if (!mesh || !list || !mesh.instanceColor) continue;
      let used = false;
      const base = mesh.instanceColor.array;
      for (let i = 0; i < list.length; i++) {
        const o = list[i];
        const reg = byTile.get(o.tile);
        if (!reg) continue;
        const role = (ROLE[reg.tile.terrain] || {})[kit];
        if (!role) continue;

        const hash = ((o.x * 71.3 + o.z * 137.9) * 1000) | 0;
        const r01 = ((hash ^ (hash >>> 11)) >>> 0) % 997 / 997;
        const it = {
          kit, mesh, i, role, reg,
          x: o.x, y: o.y, z: o.z, gy: heightAt(o.x, o.z) - 0.05,
          ry: o.ry, s: o.s, sy: o.sy,
          rx: o.rx || 0, rz: o.rz || 0,
          br: base[i * 3], bg: base[i * 3 + 1], bb: base[i * 3 + 2],
          cur: 0, tgt: 0, wait: 0, hit: false,
          stump: -1, stumpK: STUMP_K[kit] || 0.46,
          lean: (r01 < 0.5 ? -1 : 1) * (1.28 + r01 * 0.40),
          spin: (r01 - 0.5) * 0.9,
          d: Math.hypot(o.x - reg.tile.x, o.z - reg.tile.z) / APOTHEM
        };
        if (role === 'fell' && smesh && snext < scap) {
          it.stump = sbase + snext++;
        }
        reg.items.push(it);
        used = true;
      }
      if (used) {
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        kitMeshes.add(mesh);
      }
    }
  }

  /* Biggest silhouettes first inside a region: when three props are struck at
     once it should be the trees you notice going, not the grass. */
  const WEIGHT = { fell: 0, flatten: 1, crop: 2, wilt: 3 };
  for (const rec of regions) rec.items.sort((a, b) => WEIGHT[a.role] - WEIGHT[b.role]);

  const active = new Set();

  /* -------------------------------------------------------------- writing */

  function writeStump(it, g) {
    if (it.stump < 0 || !smesh) return;
    const k = Math.max(1e-4, it.s * it.stumpK * g);
    setInstance(smesh, it.stump, it.x, it.gy, it.z, it.ry + 0.7, k, k);
    sdirty = true;
  }

  function writeItem(it) {
    const c = it.cur;
    let s = it.s, sy = it.sy, rz = it.rz, ry = it.ry, y = it.y;

    if (it.role === 'fell') {
      // topple over the first half, sink away over the second while the stump
      // rises through it — the whole thing takes under half a second
      const drop = clamp01(c / 0.52);
      const gone = clamp01((c - 0.46) / 0.54);
      rz += it.lean * drop;
      ry += it.spin * drop;
      y -= 0.12 * drop;
      s = it.s * (1 - gone);
      sy = it.sy * (1 - gone);
      writeStump(it, clamp01((c - 0.40) / 0.34));
    } else if (c > 0.0005 && (it.role === 'crop' || it.role === 'flatten')) {
      const k = CROP[it.kit] || [0.9, 0.26];
      s = it.s * (1 + (k[0] - 1) * c);
      sy = it.sy * (1 + (k[1] - 1) * c);
      if (it.role === 'flatten') rz += it.lean * 0.35 * c;
    }

    setInstance(it.mesh, it.i, it.x, y, it.z, ry, Math.max(s, 1e-4), Math.max(sy, 1e-4), it.rx, rz);

    const w = WORN_MUL[it.kit] || [0.8, 0.75, 0.6];
    const arr = it.mesh.instanceColor.array;
    arr[it.i * 3] = it.br * (1 + (w[0] - 1) * c);
    arr[it.i * 3 + 1] = it.bg * (1 + (w[1] - 1) * c);
    arr[it.i * 3 + 2] = it.bb * (1 + (w[2] - 1) * c);
    kitDirty.add(it.mesh);
  }

  /* ------------------------------------------------------------ selection */

  /** Where the felling is happening: the settler working this region. */
  const _o = { x: 0, z: 0 };
  function origin(tile) {
    _o.x = tile.x; _o.z = tile.z;
    const I = match();
    const ps = I && I.state && I.state.players;
    if (!ps) return _o;
    let best = null, bd = 1e9;
    for (const p of ps) {
      if (p.gatherNode && p.gatherNode.tile === tile.id) { _o.x = p.x; _o.z = p.z; return _o; }
      const d = (p.x - tile.x) * (p.x - tile.x) + (p.z - tile.z) * (p.z - tile.z);
      if (d < bd) { bd = d; best = p; }
    }
    const R = APOTHEM * 1.55;
    if (best && bd < R * R) { _o.x = best.x; _o.z = best.z; }
    return _o;
  }

  const pick = [];

  function strike(rec, k) {
    const o = origin(rec.tile);
    const ox = o.x, oz = o.z;
    pick.length = 0;
    for (const it of rec.items) if (!it.hit) pick.push(it);
    pick.sort((a, b) =>
      ((a.x - ox) * (a.x - ox) + (a.z - oz) * (a.z - oz)) -
      ((b.x - ox) * (b.x - ox) + (b.z - oz) * (b.z - oz)));
    const n = Math.min(k, pick.length);
    for (let i = 0; i < n; i++) {
      const it = pick[i];
      it.hit = true;
      it.tgt = 1;
      // A hair of stagger so three trees never fall on the identical frame —
      // capped, because a bot draining a whole tile in one tick strikes
      // seventy props at once and a linear ramp would take five seconds.
      it.wait = Math.min(0.45, i * 0.05);
      active.add(it);
      rec.struck++;
    }
  }

  function release(rec, k) {
    pick.length = 0;
    for (const it of rec.items) if (it.hit) pick.push(it);
    pick.sort((a, b) => a.d - b.d);          // outward from the hex centre
    const n = Math.min(k, pick.length);
    for (let i = 0; i < n; i++) {
      const it = pick[i];
      it.hit = false;
      it.tgt = 0;
      it.wait = it.d * 0.68;
      active.add(it);
      rec.struck--;
    }
  }

  /* ------------------------------------------------------------------ loop */

  let poll = 0;

  function sample() {
    for (const rec of regions) {
      if (!rec.items.length) continue;
      let units = 0;
      for (const n of rec.nodes) units += Math.max(0, Math.min(NODE_CAPACITY, n.remaining | 0));
      const worked = 1 - units / rec.maxUnits;
      const want = Math.round(worked * rec.items.length);
      if (want > rec.struck) strike(rec, want - rec.struck);
      else if (want < rec.struck) release(rec, rec.struck - want);
    }
  }

  function update(dt) {
    if ((poll -= dt) <= 0) { poll = 0.10; sample(); }

    if (active.size) {
      for (const it of Array.from(active)) {
        if (it.wait > 0) { it.wait -= dt; continue; }
        const k = Math.min(1, dt * (RATE[it.role] || 2.0));
        it.cur += (it.tgt - it.cur) * k;
        if (Math.abs(it.tgt - it.cur) < 0.004) { it.cur = it.tgt; active.delete(it); }
        writeItem(it);
      }
      for (const m of kitDirty) {
        m.instanceMatrix.needsUpdate = true;
        if (m.instanceColor) m.instanceColor.needsUpdate = true;
      }
      kitDirty.clear();
      if (sdirty && smesh) { smesh.instanceMatrix.needsUpdate = true; sdirty = false; }
    }
  }

  return {
    update,
    regions,
    stumpsUsed: snext,

    /** Debug / capture hook: how much of the stand has answered the harvest. */
    debug(tileId) {
      let total = 0, moved = 0, mid = 0;
      const roles = {};
      for (const rec of regions) {
        if (tileId !== undefined && rec.tile.id !== tileId) continue;
        for (const it of rec.items) {
          total++;
          roles[it.role] = (roles[it.role] || 0) + 1;
          if (it.cur > 0.8) moved++;
          else if (it.cur > 0.05) mid++;
        }
      }
      return { total, moved, mid, active: active.size, roles };
    },

    dispose() { /* owns no geometry of its own */ }
  };
}

export default buildStand;
