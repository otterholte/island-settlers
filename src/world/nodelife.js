/**
 * Island Settlers — the life of a gather node.
 *
 *   buildNodeLife(group, mats) -> {
 *     meshes, triangles, drawCalls,
 *     update(dt), playHarvest(id), setDepleted(id, on), nodeAnchor(id), dispose()
 *   }
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * A node used to be one object that shrank to nothing the instant its third and
 * final cycle landed. From the play camera that read as "something blinked", so
 * the player could not tell they were harvesting at all.
 *
 * A node is now THREE sub-units — three trees, three sheep, three sheaves,
 * three diggings, three ore chunks — one per `NODE_CAPACITY` cycle. Every
 * completed cycle consumes exactly one of them, with a real per-resource
 * animation, and leaves a per-resource residue behind:
 *
 *   tree     shakes, TOPPLES about its base with a dust puff, leaves a stump
 *   sheep    startles, bolts away from the settler and is gone from the field
 *   wheat    is cut down in stages, leaving stubble and one bound sheaf
 *   claypit  sinks, its spoil heap shrinking, leaving a dug scar
 *   orerock  cracks, breaks apart and the crystal glint dies
 *
 * Regrowth reverses it: saplings pop and grow, a new sheep trots in from the
 * field edge, sheaves spring back. All of it rides the SAME InstancedMeshes the
 * nodes always used — three times the instances, a third of the geometry each,
 * and not one extra draw call.
 *
 * Owner: World agent.
 */

import * as THREE from 'three';
import { NODE_CAPACITY } from '../core/constants.js';
import { tiles } from '../board/layout.js';
import { nodes, mulberry32, isTileExhausted } from '../board/nodes.js';
import { heightAt, hexFrac, APOTHEM } from './terrain.js';
import { instanced, setInstance, triCount } from './geo.js';
import * as K from './propkits.js';

const SUB = NODE_CAPACITY;             // sub-units per node == harvest cycles
const TAU = Math.PI * 2;
const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeOut = t => 1 - (1 - t) * (1 - t) * (1 - t);

const KIT = {
  tree:    { make: K.heroTree,   mat: 'tree',  cast: true },
  wheat:   { make: K.wheatSheaf, mat: 'wheat', cast: true },
  sheep:   { make: K.sheep,      mat: 'solid', cast: true },
  claypit: { make: K.clayPit,    mat: 'solid', cast: true },
  orerock: { make: K.oreRock,    mat: 'solid', cast: true }
};

/*
 * Node tints deliberately run LIGHTER and warmer than the dressing kits they
 * stand among. A forest tile carries thirty-six decorative spruces in the deep
 * 0x1a4524 needle green; the seven harvestable copses on it are sunlit, so the
 * eye separates "I can chop that" from "that is scenery" before the ground ring
 * even registers.
 */
const TINTS = {
  tree:    [[1.00, 1.02, 0.94], [1.10, 1.00, 0.82], [0.94, 1.06, 1.00], [1.14, 1.04, 0.88]],
  wheat:   [[1.00, 1.00, 1.00], [1.08, 0.99, 0.82], [0.90, 0.88, 0.76]],
  sheep:   [[1.00, 1.00, 1.00], [0.95, 0.94, 0.92], [1.03, 1.02, 0.99]],
  claypit: [[1.00, 1.00, 1.00], [1.08, 0.94, 0.86], [0.90, 0.86, 0.84]],
  orerock: [[1.00, 1.00, 1.00], [0.86, 0.89, 0.96], [1.08, 1.04, 0.98]]
};

/* How far the three sub-units of one node sit from its centre, their scale
   range, and how far each sinks into the ground. */
const SPREAD  = { tree: 1.15, wheat: 0.66, sheep: 1.25, claypit: 0.80, orerock: 0.68 };
/* Harvestable trees stand a head taller than the decorative spruces around
   them (which top out near 5 units) — a copse has to be findable. */
const SCALE   = { tree: [1.32, 1.72], wheat: [0.98, 1.24], sheep: [0.86, 1.08],
                  claypit: [0.94, 1.20], orerock: [0.92, 1.22] };
const SINK    = { tree: 0.10, wheat: 0.05, sheep: 0.03, claypit: 0.05, orerock: 0.12 };

/* Seconds a consume / regrow animation runs for. */
const DIE  = { tree: 1.55, wheat: 0.80, sheep: 1.45, claypit: 0.85, orerock: 0.90 };
const GROW = { tree: 1.25, wheat: 0.95, sheep: 1.75, claypit: 0.85, orerock: 0.85 };

/* What is left standing once a sub-unit has been worked out. Trees and sheep
   leave nothing (the stump mesh covers the tree); the rest leave a scar. */
/* A clear-cut is not just stumps: it is stumps AND the slash left lying beside
   them. One tree in every three stays down as a sawn trunk on the ground rather
   than fading out, so a worked-out forest tile reads as timber operation rather
   than as a lawn with posts in it. */
const LOG = { s: 0.62, sy: 0.44, dy: -0.18 };

const RESIDUE = {
  tree:    { s: 0.0001, sy: 0.0001, dy: 0 },
  sheep:   { s: 0.0001, sy: 0.0001, dy: 0 },
  wheat:   { s: 0.94,   sy: 0.13,   dy: 0 },
  claypit: { s: 1.14,   sy: 0.17,   dy: -0.05 },
  orerock: { s: 0.48,   sy: 0.42,   dy: -0.03 }
};

/* Read-only peek at the running match, used for the two things a prop system
   cannot know on its own: where the settlers are (sheep flee from them) and
   which effects pool to fire a dust puff into. Always optional. */
function match() {
  const g = typeof globalThis !== 'undefined' ? globalThis : null;
  return (g && g.__ISLAND__) || null;
}

export function buildNodeLife(group, mats) {
  const byKind = { tree: [], wheat: [], sheep: [], claypit: [], orerock: [] };
  for (const n of nodes) if (byKind[n.kind]) byKind[n.kind].push(n);

  const mesh = {};
  const geos = {};
  const slots = [];                       // every sub-unit, flat
  const byNode = new Map();               // node id -> slot[]
  const sheepSlots = [];
  const active = new Set();
  const dirty = new Set();
  let triangles = 0;
  let drawCalls = 0;

  /* -------------------------------------------------------------- build */

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
    const count = list.length * SUB;
    const m = instanced(geo, mats[spec.mat], count, spec.cast, true);
    m.name = `node-${kind}`;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    group.add(m);
    mesh[kind] = m;
    triangles += triCount(geo) * count;
    drawCalls++;

    const table = TINTS[kind];
    const tintArr = new Float32Array(count * 3);
    const spread = SPREAD[kind];
    const sc = SCALE[kind];

    list.forEach((n, ni) => {
      const rng = mulberry32(4242 + n.id * 7919);
      const tile = tiles[n.tile];
      const mine = [];
      for (let k = 0; k < SUB; k++) {
        const i = ni * SUB + k;
        // A tight triangle around the node centre, jittered so a copse never
        // reads as three objects on a compass rose.
        const a = n.rot + k * (TAU / SUB) + (rng() - 0.5) * 0.9;
        const r = spread * (0.45 + rng() * 0.62);
        let x = n.x + Math.cos(a) * r;
        let z = n.z + Math.sin(a) * r;
        if (hexFrac(x - tile.x, z - tile.z) > 0.76) { x = n.x; z = n.z; }
        const s = (sc[0] + rng() * (sc[1] - sc[0])) * (0.82 + (n.scale - 0.85) * 0.75);
        const sl = {
          node: n, kind, i, k,
          hx: x, hz: z,                    // home
          x, z, y: heightAt(x, z) - SINK[kind] * s,
          ry: rng() * TAU, s,
          alive: true, phase: 0, t: 0,     // phase 0 idle, 1 dying, 2 growing
          punch: 0, fallA: rng() * TAU, thudded: false,
          rng
        };
        if (kind === 'sheep') {
          sl.tx = x; sl.tz = z;
          sl.wait = rng() * 3;
          sl.bob = rng() * TAU;
        }
        slots.push(sl);
        mine.push(sl);
        if (kind === 'sheep') sheepSlots.push(sl);
        const v = table[variantOf(x, z, table.length)];
        tintArr[i * 3] = v[0]; tintArr[i * 3 + 1] = v[1]; tintArr[i * 3 + 2] = v[2];
        writeSlot(sl);
      }
      byNode.set(n.id, mine);
    });

    m.instanceColor = new THREE.InstancedBufferAttribute(tintArr, 3);
    m.instanceColor.needsUpdate = true;
    m.instanceMatrix.needsUpdate = true;
  }

  /* Stumps: one per tree sub-unit, hidden until that tree comes down. */
  let stumpMesh = null;
  {
    const treeSlots = slots.filter(s => s.kind === 'tree');
    if (treeSlots.length) {
      const geo = K.stump();
      geos.stump = geo;
      stumpMesh = instanced(geo, mats.solid, treeSlots.length, true, true);
      stumpMesh.name = 'node-stump';
      stumpMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      group.add(stumpMesh);
      triangles += triCount(geo) * treeSlots.length;
      drawCalls++;
      treeSlots.forEach((sl, i) => {
        sl.stump = i;
        sl.stumpS = 0;
        setInstance(stumpMesh, i, sl.x, sl.y, sl.z, sl.ry + 0.7, 0.0001, 0.0001);
      });
      stumpMesh.instanceMatrix.needsUpdate = true;
    }
  }

  /* --------------------------------------------------------------- write */

  function writeStump(sl) {
    if (!stumpMesh || sl.stump === undefined) return;
    const g = Math.max(0.0001, sl.s * sl.stumpS * 0.9);
    setInstance(stumpMesh, sl.stump, sl.hx, heightAt(sl.hx, sl.hz) - 0.06,
      sl.hz, sl.ry + 0.7, g, g);
    dirty.add('stump');
  }

  /**
   * Compose one sub-unit's instance matrix from its animation state. Everything
   * a resource does when it is harvested lives in this function.
   */
  function writeSlot(sl) {
    const m = mesh[sl.kind];
    if (!m) return;
    const res = RESIDUE[sl.kind];
    const punch = sl.punch;
    const shake = Math.sin(punch * 34) * 0.11 * punch;
    const punchS = 1 + Math.sin(punch * Math.PI) * 0.18;

    let x = sl.x, z = sl.z, y = sl.y;
    let ry = sl.ry + shake, rx = 0, rz = 0;
    let s = sl.s, sy = sl.s;

    if (sl.phase === 1) {
      /* ---------------------------------------------------------- dying */
      const u = clamp01(sl.t / DIE[sl.kind]);
      if (sl.kind === 'tree') {
        // wind up, then accelerate over like a real fall, land, settle, sink
        const fall = clamp01((u - 0.12) / 0.46);
        const ang = 1.62 * (fall * fall * (1.18 - 0.18 * fall));
        const kick = u < 0.12 ? -0.10 * Math.sin((u / 0.12) * Math.PI) : 0;
        const bounce = u > 0.58 ? Math.sin((u - 0.58) * 26) * 0.055 * (1 - clamp01((u - 0.58) / 0.22)) : 0;
        ry = sl.ry + sl.fallA + shake * 0.4;
        rz = ang + kick + bounce;
        const gone = clamp01((u - 0.78) / 0.22);
        if (sl.k === 0) {
          // this one is left lying where it fell — sawn slash, not vapour
          s = sl.s * (1 - gone * (1 - LOG.s));
          sy = sl.s * (1 - gone * (1 - LOG.sy));
          y = sl.y + gone * LOG.dy;
        } else {
          s = sl.s * (1 - gone);
          sy = s;
          y = sl.y - gone * 0.55;
        }
      } else if (sl.kind === 'sheep') {
        const hop = u < 0.16 ? Math.sin((u / 0.16) * Math.PI) : 0;
        y = sl.y + hop * 0.42;
        ry = sl.ry + shake;
        const gone = clamp01((u - 0.66) / 0.34);
        s = sl.s * (1 - gone * gone);
        sy = s * (1 + hop * 0.10);
        rx = 0; rz = -0.06 - hop * 0.30;
      } else if (sl.kind === 'wheat') {
        // cut in two quick bites, then the residue: stubble, or one bound
        // sheaf laid over on its side
        const cut = easeOut(u);
        const step = Math.min(1, Math.floor(u * 2.99) / 2 + cut * 0.34);
        s = sl.s * (1 + (res.s - 1) * step);
        sy = sl.s * (1 + (res.sy - 1) * step);
        ry = sl.ry + shake + step * 0.55;
        if (sl.k === 1) rz = step * 1.42;              // the bundle falls over
      } else if (sl.kind === 'claypit') {
        const dig = easeOut(u);
        s = sl.s * (1 + (res.s - 1) * dig);
        sy = sl.s * (1 + (res.sy - 1) * dig) * punchS;
        y = sl.y + res.dy * dig;
        ry = sl.ry + shake * 1.4;
      } else {
        // ore: shudder hard, crack apart, glint dies with the shrink
        const crack = u < 0.24 ? 0 : easeOut((u - 0.24) / 0.76);
        s = sl.s * (1 + (res.s - 1) * crack);
        sy = sl.s * (1 + (res.sy - 1) * crack);
        y = sl.y + res.dy * crack;
        rz = crack * 0.34;
        ry = sl.ry + shake * 1.6;
      }
    } else if (sl.phase === 2) {
      /* -------------------------------------------------------- growing */
      const u = clamp01(sl.t / GROW[sl.kind]);
      const pop = easeOut(u) * (1 + Math.sin(u * Math.PI) * 0.16);
      if (sl.kind === 'sheep') {
        // a new sheep trots in from off the node and settles into the flock
        const walk = easeOut(clamp01((u - 0.10) / 0.90));
        x = sl.ix + (sl.hx - sl.ix) * walk;
        z = sl.iz + (sl.hz - sl.iz) * walk;
        y = heightAt(x, z) - 0.03 + Math.abs(Math.sin(u * 22)) * 0.06 * (1 - walk);
        ry = Math.atan2(-(sl.hz - sl.iz), sl.hx - sl.ix);
        s = sl.s * clamp01(u / 0.18);
        sy = s;
      } else {
        s = sl.s * Math.max(0.04, pop);
        sy = sl.s * Math.max(0.04, pop * (1 + (1 - u) * 0.22));
        ry = sl.ry + (1 - u) * 0.6;
      }
    } else if (!sl.alive) {
      /* ------------------------------------------------------- worked out */
      if (sl.kind === 'tree' && sl.k === 0) {
        s = sl.s * LOG.s;
        sy = sl.s * LOG.sy;
        y = sl.y + LOG.dy;
        ry = sl.ry + sl.fallA;
        rz = 1.62;
      } else {
        s = sl.s * res.s;
        sy = sl.s * res.sy;
        y = sl.y + res.dy;
      }
      if (sl.kind === 'wheat' && sl.k === 1) rz = 1.42;
      if (sl.kind === 'orerock') rz = 0.34;
    } else {
      /* --------------------------------------------------------- standing */
      s = sl.s * punchS;
      sy = sl.s * (1 + (1 - punchS) * 0.7);
      if (sl.kind === 'tree') rz = shake * 0.55;
    }

    if (sl.kind === 'sheep' && sl.phase !== 2) {
      const graze = sl.alive && sl.wait > 0 ? 0.20 + Math.sin(sl.bob * 1.7) * 0.05 : 0.05;
      rz -= graze;
      y += Math.sin(sl.bob) * 0.045;
    }

    setInstance(m, sl.i, x, y, z, ry, Math.max(s, 0.0001), Math.max(sy, 0.0001), rx, rz);
    dirty.add(sl.kind);
  }

  /* ----------------------------------------------------------- behaviour */

  /** Which way should a startled sheep run? Away from the nearest settler. */
  function fleeAngle(sl) {
    const I = match();
    const ps = I && I.state && I.state.players;
    let bx = sl.x - sl.node.x, bz = sl.z - sl.node.z;
    if (ps) {
      let best = null, bd = 1e9;
      for (const p of ps) {
        const d = (p.x - sl.x) * (p.x - sl.x) + (p.z - sl.z) * (p.z - sl.z);
        if (d < bd) { bd = d; best = p; }
      }
      if (best && bd < 400) { bx = sl.x - best.x; bz = sl.z - best.z; }
    }
    if (Math.abs(bx) + Math.abs(bz) < 1e-4) { bx = Math.cos(sl.ry); bz = -Math.sin(sl.ry); }
    return Math.atan2(-bz, bx);
  }

  let lastThud = -99;

  function thud(sl) {
    const I = match();
    if (!I) return;
    const w = I.world;
    try {
      if (w && w.effects && w.effects.burst) w.effects.burst(sl.x, sl.z, 'wood');
      const p = I.state && I.state.players && I.state.players[0];
      if (!p || !w) return;
      const d = Math.hypot(p.x - sl.x, p.z - sl.z);
      if (d > 18) return;                       // a rival felling one, far away
      const near = 1 - d / 18;
      if (w.camera && w.camera.shake) w.camera.shake(0.18 * near * near);
      // Three trees can come down inside a second when a whole copse is worked
      // out; one thud is a landing, three at once is a landslide.
      if (w.audio && w.audio.sfx && clock - lastThud > 0.4) {
        lastThud = clock;
        w.audio.sfx('rumble', { gain: 0.30 * near * near });
      }
    } catch (e) { /* presentation is always optional */ }
  }

  function startDie(sl) {
    sl.alive = false;
    sl.phase = 1;
    sl.t = 0;
    sl.thudded = false;
    if (sl.kind === 'sheep') {
      sl.ry = fleeAngle(sl);
      sl.wait = 0;
    }
    active.add(sl);
  }

  function startGrow(sl, delay) {
    sl.alive = true;
    sl.phase = 2;
    sl.t = -(delay || 0);
    if (sl.kind === 'sheep') {
      const a = sl.rng() * TAU;
      sl.ix = sl.hx + Math.cos(a) * 6.5;
      sl.iz = sl.hz + Math.sin(a) * 6.5;
      sl.x = sl.ix; sl.z = sl.iz;
      sl.tx = sl.hx; sl.tz = sl.hz;
      sl.wait = 0.4;
    } else {
      sl.x = sl.hx; sl.z = sl.hz;
      sl.y = heightAt(sl.hx, sl.hz) - SINK[sl.kind] * sl.s;
    }
    active.add(sl);
  }

  /* ------------------------------------------------------- regrowth sweep
   *
   * Recovery is scoped to the whole region, so the whole region comes back in
   * the same instant. Popping 21 trees on one frame is a glitch; letting the
   * life run outward from the middle of the hex over half a second is a
   * moment. Each node carries its own delay, measured from the tile centre. */
  const nodeSweep = new Map();
  for (const n of nodes) {
    const t = tiles[n.tile];
    if (!t) continue;
    nodeSweep.set(n.id, Math.hypot(n.x - t.x, n.z - t.z) / APOTHEM * 0.78);
  }
  const wasSpent = new Map();
  const sweepAt = new Map();

  function sweepDelay(n) {
    const now = isTileExhausted(n.tile);
    const was = wasSpent.get(n.tile);
    if (was && !now) sweepAt.set(n.tile, clock);
    if (was !== now) wasSpent.set(n.tile, now);
    const at = sweepAt.get(n.tile);
    return at !== undefined && clock - at < 2.0 ? (nodeSweep.get(n.id) || 0) : 0;
  }

  /** Bring one node's three sub-units in line with `node.remaining`. */
  function reconcile(n, instant) {
    const list = byNode.get(n.id);
    if (!list) return;
    const left = Math.max(0, Math.min(SUB, n.remaining | 0));
    const sweep = instant ? 0 : sweepDelay(n);
    for (let k = 0; k < list.length; k++) {
      const sl = list[k];
      // sub-units are consumed front to back, so the last `left` survive
      const shouldLive = k >= SUB - left;
      if (shouldLive === sl.alive && sl.phase === 0) continue;
      if (shouldLive && !sl.alive) {
        if (instant) { sl.alive = true; sl.phase = 0; sl.t = 0; sl.stumpS = 0; writeSlot(sl); writeStump(sl); }
        else startGrow(sl, sweep + (SUB - 1 - k) * 0.22);
      } else if (!shouldLive && sl.alive) {
        if (instant) { sl.alive = false; sl.phase = 0; sl.t = 0; sl.stumpS = 1; writeSlot(sl); writeStump(sl); }
        else startDie(sl);
      }
    }
  }

  function moveSheep(sl, dt) {
    sl.bob += dt * (sl.wait > 0 ? 2.4 : 6.0);
    if (!sl.alive && sl.phase === 1) {
      // bolting: keep running along the flee heading while it shrinks away
      sl.x += Math.cos(sl.ry) * dt * 5.6;
      sl.z -= Math.sin(sl.ry) * dt * 5.6;
      sl.y = heightAt(sl.x, sl.z) - 0.03;
      return;
    }
    if (!sl.alive || sl.phase !== 0) return;
    if (sl.wait > 0) { sl.wait -= dt; return; }
    const dx = sl.tx - sl.x, dz = sl.tz - sl.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.22) {
      const tile = tiles[sl.node.tile];
      for (let g = 0; g < 14; g++) {
        const a = sl.rng() * TAU;
        const r = 0.9 + sl.rng() * 2.8;
        const nx = sl.hx + Math.cos(a) * r;
        const nz = sl.hz + Math.sin(a) * r;
        if (hexFrac(nx - tile.x, nz - tile.z) > 0.72) continue;
        sl.tx = nx; sl.tz = nz; break;
      }
      sl.wait = 1.4 + sl.rng() * 3.4;
      return;
    }
    const t = Math.min(1, (dt * 1.5) / d);
    sl.x += dx * t; sl.z += dz * t;
    sl.y = heightAt(sl.x, sl.z) - 0.03;
    const want = Math.atan2(-dz, dx);
    let diff = want - sl.ry;
    while (diff > Math.PI) diff -= TAU;
    while (diff < -Math.PI) diff += TAU;
    sl.ry += diff * Math.min(1, dt * 5);
  }

  /* ---------------------------------------------------------------- loop */

  let poll = 0;
  let clock = 0;

  function update(dt) {
    clock += dt;
    for (const sl of sheepSlots) { moveSheep(sl, dt); writeSlot(sl); }

    if (active.size) for (const sl of Array.from(active)) {
      sl.t += dt;
      let live = false;

      if (sl.phase === 1) {
        const D = DIE[sl.kind];
        if (sl.kind === 'tree') {
          if (!sl.thudded && sl.t >= D * 0.58) { sl.thudded = true; thud(sl); }
          sl.stumpS = clamp01((sl.t / D - 0.60) / 0.30);
        }
        if (sl.t >= D) { sl.phase = 0; sl.t = 0; } else live = true;
      } else if (sl.phase === 2) {
        if (sl.t < 0) live = true;                       // staggered start
        else {
          if (sl.kind === 'tree') sl.stumpS = Math.max(0, 1 - sl.t / (GROW.tree * 0.45));
          if (sl.t >= GROW[sl.kind]) {
            sl.phase = 0; sl.t = 0;
            if (sl.kind === 'sheep') { sl.x = sl.hx; sl.z = sl.hz; sl.tx = sl.hx; sl.tz = sl.hz; }
          } else live = true;
        }
      }

      if (sl.punch > 0) { sl.punch = Math.max(0, sl.punch - dt * 2.9); live = true; }
      if (sl.kind === 'tree') writeStump(sl);
      writeSlot(sl);
      if (!live) active.delete(sl);
    }

    // Catch regrowth (and anything that changed `remaining` behind our back).
    poll -= dt;
    if (poll <= 0) {
      poll = 0.2;
      for (const n of nodes) {
        const list = byNode.get(n.id);
        if (!list) continue;
        const left = Math.max(0, Math.min(SUB, n.remaining | 0));
        let seen = 0;
        for (const sl of list) if (sl.alive) seen++;
        if (seen !== left) reconcile(n, false);
      }
    }

    for (const kind of dirty) {
      if (kind === 'stump') { if (stumpMesh) stumpMesh.instanceMatrix.needsUpdate = true; }
      else if (mesh[kind]) mesh[kind].instanceMatrix.needsUpdate = true;
    }
    dirty.clear();
  }

  /* ----------------------------------------------------------------- api */

  function resolve(ref) {
    if (ref === null || ref === undefined) return null;
    const id = typeof ref === 'object' ? ref.id : ref;
    return nodes[id] && nodes[id].id === id ? nodes[id] : (nodes.find(n => n.id === id) || null);
  }

  /** The sub-unit a settler is currently working on — the next one to fall. */
  function frontSlot(n) {
    const list = byNode.get(n.id);
    if (!list) return null;
    for (const sl of list) if (sl.alive && sl.phase === 0) return sl;
    for (const sl of list) if (sl.alive) return sl;
    return list[list.length - 1];
  }

  return {
    meshes: mesh,
    stumpMesh,
    triangles,
    drawCalls,
    update,

    /** A cycle landed: shake the sub-unit that took the hit, then reconcile. */
    playHarvest(ref) {
      const n = resolve(ref);
      if (!n) return;
      const sl = frontSlot(n);
      if (sl) { sl.punch = 1; active.add(sl); }
      reconcile(n, false);
    },

    setDepleted(ref, on = true) {
      const n = resolve(ref);
      if (!n) return;
      // `remaining` is authoritative; `on` only disambiguates a hard reset.
      if (!on && n.remaining <= 0) return;
      reconcile(n, false);
    },

    /** Where the node's live geometry actually stands right now. */
    nodeAnchor(ref) {
      const n = resolve(ref);
      if (!n) return null;
      const sl = frontSlot(n);
      return sl ? { x: sl.x, y: sl.y, z: sl.z } : { x: n.x, y: heightAt(n.x, n.z), z: n.z };
    },

    dispose() {
      for (const k in geos) geos[k].dispose();
    }
  };
}

export default buildNodeLife;
