/**
 * Island Settlers — the dressing answering to the harvest.
 *
 *   countFellable(bucket)               -> how many stump instances to reserve
 *   buildStand(group, dressing, stumps) -> { update(dt), debug(tileId), dispose() }
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * A forest hex carries about twenty harvestable trees (`nodelife.js`) AND about
 * twenty-eight decorative conifers, ferns and grass tufts on top of them. Take
 * every harvestable tree and, if only those twenty answer, a "clear cut" is a
 * full forest with twenty gaps in it — which is exactly the read the player
 * complained about. So the DRESSING is part of the stand too: every responsive
 * prop on a hex is a unit in one pool, and the hex's own fill fraction spends
 * that whole pool alongside the real items.
 *
 * Two rules make it read:
 *
 *   1. PROXIMITY, NOT ACCOUNTANCY. When the fill fraction drops, the props that
 *      go are the ones nearest the settler who is working the hex — so the
 *      stand clears along the path you actually walked.
 *
 *   2. STUMPS, NOT SLASH. A felled conifer topples, then sinks while a stump
 *      grows in its place. A whole spruce lying on its side keeps its canopy
 *      pointing at the sun and turns a clear-cut into green litter; a stump
 *      field still says "this was a forest" and "there is nothing here to take"
 *      at the same time. The stumps ride the field's own stump InstancedMesh
 *      (it reserves spares for us), so this costs no draw call.
 *
 * Everything here is instance matrices and instance colours. Nothing is created,
 * nothing is deleted, no count changes, and it all reverses when the hex fills
 * back up — sweeping outward from the middle.
 *
 * The owned / off-limits tint is NOT here. That rides the shared mood shader in
 * `mood.js`, which paints these same meshes and the terrain under them together.
 *
 * Owner: World agent.
 */

import * as THREE from 'three';
import { tiles } from '../board/layout.js';
import { heightAt, APOTHEM } from './terrain.js';
import { setInstance } from './geo.js';
import { MOOD } from './mood.js';

const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);

/*
 * How each dressing kit answers, per terrain.
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

/* Vertical squash and horizontal pinch a `crop` leaves behind.
 *
 *   "Make the empty hexes once the resources are gone look more empty and less
 *    busy. Right now it's too overstimulating."
 *
 * Cut a good deal closer to the ground than it was. A cropped field still has
 * to LOOK like the field it was — the stubble is the identity, and it keeps its
 * full footprint so the hex is not bare mud with a fence round it — but at a
 * fifth of its standing height it is a flat mat of colour rather than a hex
 * full of half-height twigs competing with the countdown badge overhead. */
const CROP = {
  wheat:  [1.10, 0.17],
  grass:  [1.00, 0.20],
  flower: [0.88, 0.14],
  undergrowth: [0.98, 0.16]
};

/* How big a stump a felled dressing tree leaves, relative to its own scale.
   Down a notch with the smaller stump geometry in `propkits.js`. */
const STUMP_K = { conifer: 0.62, coniferShort: 0.58, broadleaf: 0.70 };

/*
 * What share of the felled DRESSING leaves a stump behind — a quarter, against
 * 42% of the harvestable trees over in `nodelife.js`.
 *
 * A forest hex used to end up with about forty-five posts standing in it: one
 * for every tree you took plus one for every backdrop conifer that went down
 * with them. That is not an empty hex, it is a hex full of a different prop.
 * It is now nearer a dozen, spread over the whole tile, which still says
 * "somebody logged this" from the far side of the island and leaves the ground
 * between them genuinely bare.
 *
 * Deterministic on world position, and shared by `countFellable` (which sizes
 * the batch) and `buildStand` (which fills it), so the two can never disagree.
 */
const STUMP_SHARE = 0.25;

/** Stable 0..1 from a world position. */
export function propHash01(x, z) {
  const h = ((x * 71.3 + z * 137.9) * 1000) | 0;
  return ((h ^ (h >>> 11)) >>> 0) % 997 / 997;
}

/* instanceColor multiplier at full response — straw, dust and dead wood. */
const WORN_MUL = {
  conifer: [0.52, 0.42, 0.30], coniferShort: [0.52, 0.42, 0.30],
  broadleaf: [0.56, 0.46, 0.32], undergrowth: [0.62, 0.54, 0.38],
  grass: [0.80, 0.68, 0.40], flower: [0.74, 0.66, 0.46],
  wheat: [0.80, 0.70, 0.48], rockSmall: [0.78, 0.76, 0.74],
  boulder: [0.78, 0.76, 0.74]
};

/* Chunky, not graceful. Pickup is instant, so the world around it has to move
   at the same speed: a struck prop is down inside half a second. */
const RATE = { fell: 5.2, crop: 6.2, flatten: 6.2, wilt: 3.4 };

function match() {
  const g = typeof globalThis !== 'undefined' ? globalThis : null;
  return (g && g.__ISLAND__) || null;
}

/** How many stump instances the stand will need. Call before buildField. */
export function countFellable(bucket) {
  let n = 0;
  for (const kit in bucket) {
    for (const o of bucket[kit]) {
      const t = tiles[o.tile];
      if (!t) continue;
      if ((ROLE[t.terrain] || {})[kit] !== 'fell') continue;
      if (propHash01(o.x, o.z) >= STUMP_SHARE) continue;
      n++;
    }
  }
  return n;
}

/* ================================================================= factory */

export function buildStand(group, dressing, stumps) {
  const smesh = stumps && stumps.mesh ? stumps.mesh : null;
  const sbase = stumps ? stumps.base | 0 : 0;
  const scap = stumps ? stumps.count | 0 : 0;
  const smood = smesh && smesh.userData ? smesh.userData.moodArray : null;
  let snext = 0;
  let sdirty = false;

  /* ------------------------------------------------------- region records */
  const regions = [];
  const byTile = new Map();
  for (const t of tiles) {
    if (!t.resource) continue;
    const rec = { tile: t, mood: MOOD[t.id], items: [], struck: 0 };
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

        const r01 = propHash01(o.x, o.z);
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
        if (role === 'fell' && r01 < STUMP_SHARE && smesh && snext < scap) {
          it.stump = sbase + snext++;
          // the borrowed stump belongs to this hex, so it greys out with it
          if (smood) {
            smood[it.stump * 2] = reg.tile.id;
            smood[it.stump * 2 + 1] = 1;
          }
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
  if (smesh && smood && smesh.geometry.getAttribute('aMood')) {
    smesh.geometry.getAttribute('aMood').needsUpdate = true;
  }

  /* Biggest silhouettes first inside a hex: when three props go at once it
     should be the trees you notice, not the grass. */
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
      // rises through it
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

  /** Where the work is happening: the settler working this hex. */
  const _o = { x: 0, z: 0 };
  function origin(tile) {
    _o.x = tile.x; _o.z = tile.z;
    const I = match();
    const ps = I && I.state && I.state.players;
    if (!ps) return _o;
    let best = null, bd = 1e9;
    for (const p of ps) {
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
      // a hair of stagger, capped: a bot draining a whole hex in one tick
      // strikes seventy props at once and a linear ramp would take five seconds
      it.wait = Math.min(0.40, i * 0.045);
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
      it.wait = it.d * 0.55;
      active.add(it);
      rec.struck--;
    }
  }

  /* ------------------------------------------------------------------ loop */

  let poll = 0;

  function sample() {
    for (const rec of regions) {
      if (!rec.items.length) continue;
      const m = rec.mood;
      const worked = m.exhausted ? 1 : clamp01(1 - m.fraction);
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

    /** Debug / capture hook: how much of the dressing has answered. */
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
