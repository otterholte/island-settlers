/**
 * Island Settlers — everything scattered on the island.
 *
 *   buildProps(scene) -> { group, update(dt), playHarvest(id), setDepleted(id, b) }
 *
 * The 126 gather nodes from board/nodes.js get their own animated instances
 * (hero trees, wheat sheaves, wandering sheep, clay pits, ore seams). Around
 * them sits three to five times as much non-interactive dressing: layered
 * forests, undergrowth, fallen logs, boulders, wheat fields, fences, hay,
 * crates, clay works, rock spires, mine portals, ore carts and rails.
 *
 * Everything is an InstancedMesh sharing four materials, so ~1855 dressing
 * instances plus the 126 nodes cost 24 draw calls in total. Foliage sways in a
 * vertex-shader wind injected through onBeforeCompile; only the animated nodes
 * rewrite instance matrices per frame.
 *
 * Placement rule: dressing is kept to hexFrac <= 0.78 so the tan border strip
 * (hexFrac 0.81 -> 1.00) stays clear for the structures agent's roads.
 */

import * as THREE from 'three';
import { HEX_SIZE } from '../core/constants.js';
import { tiles, MARKET, SPAWNS } from '../board/layout.js';
import { nodes, nodesByTile, mulberry32 } from '../board/nodes.js';
import { heightAt, hexFrac, normalAt, PROP_MAX_FRAC } from './terrain.js';
import { instanced, setInstance, triCount } from './geo.js';
import * as K from './propkits.js';

/* ------------------------------------------------------------- materials */

function windMaterial(amount, opts = {}) {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, ...opts });
  m.userData.wind = { value: 0 };
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uWindTime = m.userData.wind;
    sh.uniforms.uSway = { value: amount };
    sh.vertexShader =
      'uniform float uWindTime;\nuniform float uSway;\n' + sh.vertexShader;
    sh.vertexShader = sh.vertexShader.replace('#include <begin_vertex>', [
      '#include <begin_vertex>',
      '#ifdef USE_INSTANCING',
      '  vec3 iOrigin = instanceMatrix[3].xyz;',
      '#else',
      '  vec3 iOrigin = vec3(0.0);',
      '#endif',
      'float swayH = max(transformed.y, 0.0);',
      'float phase = uWindTime * 1.65 + iOrigin.x * 0.23 + iOrigin.z * 0.19;',
      'float wsw = sin(phase) * 0.62 + sin(phase * 1.87 + 1.3) * 0.38;',
      'transformed.x += wsw * swayH * uSway;',
      'transformed.z += wsw * 0.62 * swayH * uSway;'
    ].join('\n'));
  };
  m.customProgramCacheKey = () => 'islandWind' + amount;
  return m;
}

/* ----------------------------------------------------------------- kits */

const STATIC_KITS = {
  conifer:      { make: K.conifer,      mat: 'tree',  cast: true },
  coniferShort: { make: K.coniferShort, mat: 'tree',  cast: true },
  broadleaf:    { make: K.broadleaf,    mat: 'tree',  cast: true },
  deadwood:     { make: K.deadwood,     mat: 'solid', cast: true },
  undergrowth:  { make: K.undergrowth,  mat: 'grass', cast: false },
  grass:        { make: K.grassTuft,    mat: 'grass', cast: false },
  flower:       { make: K.flowerTuft,   mat: 'grass', cast: false },
  wheat:        { make: K.wheatTuft,    mat: 'wheat', cast: false },
  hay:          { make: K.hayBale,      mat: 'solid', cast: true },
  rockSmall:    { make: K.smallRock,    mat: 'solid', cast: true },
  boulder:      { make: K.boulder,      mat: 'solid', cast: true },
  spire:        { make: K.spire,        mat: 'solid', cast: true },
  clayWorks:    { make: K.clayWorks,    mat: 'solid', cast: true },
  fence:        { make: K.fence,        mat: 'solid', cast: true },
  crate:        { make: K.crateStack,   mat: 'solid', cast: true },
  mine:         { make: K.mineEntrance, mat: 'solid', cast: true },
  cart:         { make: K.oreCart,      mat: 'solid', cast: true },
  rail:         { make: K.railSegment,  mat: 'solid', cast: false },
  timber:       { make: K.timberPile,   mat: 'solid', cast: true }
};

const NODE_KITS = {
  tree:    { make: K.heroTree,   mat: 'tree',  cast: true },
  stump:   { make: K.stump,      mat: 'solid', cast: true },
  wheat:   { make: K.wheatSheaf, mat: 'wheat', cast: true },
  sheep:   { make: K.sheep,      mat: 'solid', cast: true },
  claypit: { make: K.clayPit,    mat: 'solid', cast: true },
  orerock: { make: K.oreRock,    mat: 'solid', cast: true }
};

/* Per-tile dressing recipe. Counts are per tile of that terrain. A forest tile
   therefore carries 18 + 11 + 7 = 36 dressing trees on top of its 7 hero
   trees, plus undergrowth, deadwood, rocks and grass. */
const RECIPE = {
  forest:    { conifer: 18, coniferShort: 11, broadleaf: 7, deadwood: 5,
               undergrowth: 16, grass: 34, rockSmall: 7, flower: 4 },
  fields:    { wheat: 78, hay: 3, fence: 6, crate: 2, grass: 16,
               rockSmall: 5, broadleaf: 1, undergrowth: 3 },
  pasture:   { grass: 58, flower: 20, fence: 4, undergrowth: 8, rockSmall: 8,
               broadleaf: 3, coniferShort: 2, hay: 2 },
  hills:     { clayWorks: 5, rockSmall: 16, boulder: 7, grass: 24,
               undergrowth: 6, crate: 3, coniferShort: 3, fence: 4, deadwood: 2 },
  mountains: { spire: 7, boulder: 10, rockSmall: 18, conifer: 5, coniferShort: 4,
               grass: 14, crate: 2, timber: 3 },
  desert:    { rockSmall: 16, boulder: 4, crate: 6, grass: 12, hay: 2,
               deadwood: 2, coniferShort: 2 }
};

/* Physical footprint radius. Two props may not overlap: the placement test is
   distance >= r(a) + r(b), so grass is free to grow right up under a spruce
   while two spruces still keep a respectful 1.4 units apart. */
const FOOT = {
  conifer: 0.62, coniferShort: 0.58, broadleaf: 0.80, deadwood: 0.85,
  undergrowth: 0.42, grass: 0.26, flower: 0.30, wheat: 0.26, hay: 0.62,
  rockSmall: 0.32, boulder: 0.95, spire: 0.90, clayWorks: 1.30, fence: 0.95,
  crate: 0.70, mine: 2.40, cart: 0.75, rail: 0.70, timber: 0.85,
  node: 1.30
};

/* Scale ranges, ground sink and how far each kit tilts with the slope. */
const STYLE = {
  conifer:      { s: [0.95, 1.65], sink: 0.10, tilt: 0.16, yaw: true },
  coniferShort: { s: [0.90, 1.55], sink: 0.10, tilt: 0.18, yaw: true },
  broadleaf:    { s: [0.90, 1.45], sink: 0.10, tilt: 0.14, yaw: true },
  deadwood:     { s: [0.80, 1.30], sink: 0.08, tilt: 0.55, yaw: true },
  undergrowth:  { s: [0.75, 1.45], sink: 0.05, tilt: 0.35, yaw: true },
  grass:        { s: [0.70, 1.50], sink: 0.04, tilt: 0.35, yaw: true },
  flower:       { s: [0.80, 1.30], sink: 0.04, tilt: 0.35, yaw: true },
  wheat:        { s: [0.85, 1.35], sink: 0.05, tilt: 0.25, yaw: true },
  hay:          { s: [0.85, 1.15], sink: 0.06, tilt: 0.35, yaw: true },
  rockSmall:    { s: [0.55, 1.60], sink: 0.12, tilt: 0.85, yaw: true },
  boulder:      { s: [0.70, 1.45], sink: 0.18, tilt: 0.65, yaw: true },
  spire:        { s: [0.75, 1.60], sink: 0.20, tilt: 0.45, yaw: true },
  clayWorks:    { s: [0.85, 1.20], sink: 0.08, tilt: 0.30, yaw: true },
  fence:        { s: [0.90, 1.15], sink: 0.10, tilt: 0.45, yaw: true },
  crate:        { s: [0.80, 1.15], sink: 0.06, tilt: 0.40, yaw: true },
  mine:         { s: [1.05, 1.25], sink: 0.10, tilt: 0.10, yaw: false },
  cart:         { s: [0.85, 1.00], sink: 0.06, tilt: 0.35, yaw: true },
  rail:         { s: [0.90, 1.05], sink: 0.05, tilt: 0.80, yaw: false },
  timber:       { s: [0.85, 1.20], sink: 0.06, tilt: 0.40, yaw: true }
};

const NODE_STYLE = {
  tree:    { s: [0.95, 1.35], sink: 0.12 },
  wheat:   { s: [0.95, 1.25], sink: 0.06 },
  sheep:   { s: [0.95, 1.20], sink: 0.03 },
  claypit: { s: [1.00, 1.30], sink: 0.05 },
  orerock: { s: [0.95, 1.35], sink: 0.14 }
};

/* Depleted survivors: how much of the node is left once it is worked out. */
const DEPLETED_VIS = { tree: 0.0, wheat: 0.14, sheep: 0.0, claypit: 0.48, orerock: 0.42 };

/* ------------------------------------------------------------- placement */

function tiltAt(x, z, amount) {
  if (amount <= 0) return [0, 0];
  const n = normalAt(x, z, 0.7);
  return [Math.atan2(n.z, n.y) * amount, -Math.atan2(n.x, n.y) * amount];
}

/** Rejection sampler: non-overlapping discs inside one hex, off the road strip. */
function makePlacer(tile, rng) {
  const blocked = [];
  for (const n of (nodesByTile.get(tile.id) || [])) {
    blocked.push({ x: n.x, z: n.z, r: FOOT.node });
  }
  if (tile.terrain === 'desert') {
    // The plaza is nearly as wide as the prop zone; leave just the outer ring.
    blocked.push({ x: MARKET.x, z: MARKET.z, r: MARKET.radius * 1.08 });
  }
  for (const s of SPAWNS) {
    if (Math.hypot(s.x - tile.x, s.z - tile.z) < HEX_SIZE * 1.1) {
      blocked.push({ x: s.x, z: s.z, r: 2.4 });
    }
  }
  return {
    blocked,
    take(count, foot, maxF = PROP_MAX_FRAC) {
      const out = [];
      const lim = HEX_SIZE * maxF;
      let guard = 0;
      const cap = 220 + count * 130;
      while (out.length < count && guard++ < cap) {
        const a = rng() * Math.PI * 2;
        const rr = Math.sqrt(rng());
        const x = tile.x + Math.cos(a) * rr * lim;
        const z = tile.z + Math.sin(a) * rr * lim;
        if (hexFrac(x - tile.x, z - tile.z) > maxF) continue;
        let clash = false;
        for (const b of blocked) {
          const dx = b.x - x, dz = b.z - z;
          const rad = b.r + foot;
          if (dx * dx + dz * dz < rad * rad) { clash = true; break; }
        }
        if (clash) continue;
        out.push({ x, z });
        blocked.push({ x, z, r: foot });
      }
      return out;
    }
  };
}

/* ------------------------------------------------------------------- API */

export function buildProps(scene) {
  const group = new THREE.Group();
  group.name = 'props';
  scene.add(group);

  const mats = {
    solid: new THREE.MeshLambertMaterial({ vertexColors: true }),
    tree:  windMaterial(0.026),
    grass: windMaterial(0.105, { side: THREE.DoubleSide }),
    wheat: windMaterial(0.145, { side: THREE.DoubleSide })
  };

  /* ------------------------------------------------- collect placements */
  const bucket = {};
  const push = (kit, o) => { (bucket[kit] || (bucket[kit] = [])).push(o); };

  function drop(kit, x, z, rng, extra = {}) {
    const st = STYLE[kit];
    const s = st.s[0] + rng() * (st.s[1] - st.s[0]);
    const [rx, rz] = tiltAt(x, z, st.tilt);
    push(kit, {
      x, z,
      y: heightAt(x, z) - st.sink * s,
      ry: extra.ry !== undefined ? extra.ry : (st.yaw ? rng() * Math.PI * 2 : 0),
      s: extra.s !== undefined ? extra.s : s,
      sy: extra.sy !== undefined ? extra.sy : s * (0.88 + rng() * 0.30),
      rx, rz
    });
  }

  // ---- per tile dressing --------------------------------------------------
  tiles.forEach((tile, ti) => {
    const rng = mulberry32(50021 + ti * 3181 + tile.number * 977);
    const placer = makePlacer(tile, rng);
    const recipe = RECIPE[tile.terrain] || {};

    // mine portal first so it owns the best spot on a mountain
    if (tile.terrain === 'mountains') {
      const away = Math.atan2(tile.z, tile.x) || 0.3;
      // a Y rotation of (PI/2 - away) turns a model's local +Z to face `away`
      const yaw = Math.PI / 2 - away;
      const mx = tile.x + Math.cos(away) * HEX_SIZE * 0.40;
      const mz = tile.z + Math.sin(away) * HEX_SIZE * 0.40;
      placer.blocked.push({ x: mx, z: mz, r: FOOT.mine });
      drop('mine', mx, mz, rng, { ry: yaw, s: 1.1, sy: 1.1 });
      // rails running out of the portal, and a couple of carts on them
      for (let i = 0; i < 5; i++) {
        const d = HEX_SIZE * 0.40 - (2.2 + i * 2.05);
        const rx2 = tile.x + Math.cos(away) * d;
        const rz2 = tile.z + Math.sin(away) * d;
        if (hexFrac(rx2 - tile.x, rz2 - tile.z) > PROP_MAX_FRAC) continue;
        placer.blocked.push({ x: rx2, z: rz2, r: FOOT.rail });
        drop('rail', rx2, rz2, rng, { ry: yaw });
      }
      for (let i = 0; i < 2; i++) {
        const d = HEX_SIZE * 0.40 - (3.6 + i * 4.1);
        const cx = tile.x + Math.cos(away) * d;
        const cz = tile.z + Math.sin(away) * d;
        if (hexFrac(cx - tile.x, cz - tile.z) > PROP_MAX_FRAC) continue;
        placer.blocked.push({ x: cx, z: cz, r: FOOT.cart });
        drop('cart', cx, cz, rng, { ry: yaw });
      }
    }

    // pasture fences follow a lazy arc so they read as an enclosure
    if (tile.terrain === 'pasture') {
      const a0 = rng() * Math.PI * 2;
      const rad = HEX_SIZE * 0.56;
      for (let i = 0; i < 9; i++) {
        const a = a0 + i * 0.30;
        const fx = tile.x + Math.cos(a) * rad;
        const fz = tile.z + Math.sin(a) * rad;
        if (hexFrac(fx - tile.x, fz - tile.z) > PROP_MAX_FRAC) continue;
        placer.blocked.push({ x: fx, z: fz, r: FOOT.fence });
        drop('fence', fx, fz, rng, { ry: a + Math.PI / 2 });
      }
    }

    // biggest silhouettes claim their ground first, undergrowth fills the gaps
    const order = ['spire', 'clayWorks', 'boulder', 'broadleaf', 'deadwood',
      'conifer', 'coniferShort', 'timber', 'hay', 'crate', 'fence',
      'undergrowth', 'rockSmall', 'wheat', 'flower', 'grass'];
    for (const kit of order) {
      const n = recipe[kit];
      if (!n) continue;
      for (const p of placer.take(n, FOOT[kit])) drop(kit, p.x, p.z, rng);
    }
  });

  // ---- shoreline dressing -------------------------------------------------
  {
    const rng = mulberry32(778811);
    const taken = [];
    const tryPlace = (kit, want, loH, hiH) => {
      const foot = FOOT[kit];
      let got = 0, guard = 0;
      while (got < want && guard++ < want * 300) {
        const a = rng() * Math.PI * 2;
        const r = 37 + rng() * 15;
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        const h = heightAt(x, z);
        if (h < loH || h > hiH) continue;
        let clash = false;
        for (const t of taken) {
          const dx = t.x - x, dz = t.z - z;
          const rad = t.r + foot;
          if (dx * dx + dz * dz < rad * rad) { clash = true; break; }
        }
        if (clash) continue;
        taken.push({ x, z, r: foot });
        drop(kit, x, z, rng);
        got++;
      }
    };
    tryPlace('boulder', 26, 0.10, 1.7);
    tryPlace('deadwood', 10, 0.20, 1.2);
    tryPlace('rockSmall', 86, 0.02, 2.0);
    tryPlace('undergrowth', 18, 0.70, 2.0);
    tryPlace('grass', 58, 0.55, 2.0);
  }

  /* ------------------------------------------------------- build meshes */
  const meshes = {};
  const geos = {};
  let triangles = 0;
  let drawCalls = 0;

  for (const kit in bucket) {
    const spec = STATIC_KITS[kit];
    const list = bucket[kit];
    if (!spec || !list.length) continue;
    const geo = spec.make();
    geos[kit] = geo;
    const mesh = instanced(geo, mats[spec.mat], list.length, spec.cast, true);
    mesh.name = `prop-${kit}`;
    list.forEach((o, i) => setInstance(mesh, i, o.x, o.y, o.z, o.ry, o.s, o.sy, o.rx, o.rz));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    group.add(mesh);
    meshes[kit] = mesh;
    triangles += triCount(geo) * list.length;
    drawCalls++;
  }

  /* ----------------------------------------------------------- the nodes */
  const byKind = { tree: [], wheat: [], sheep: [], claypit: [], orerock: [] };
  for (const n of nodes) if (byKind[n.kind]) byKind[n.kind].push(n);

  const nodeMesh = {};
  const record = new Map();      // node id -> animation record
  const sheepList = [];
  const dirty = new Set();

  for (const kind in byKind) {
    const list = byKind[kind];
    if (!list.length) continue;
    const spec = NODE_KITS[kind];
    const geo = spec.make();
    geos['node-' + kind] = geo;
    const mesh = instanced(geo, mats[spec.mat], list.length, spec.cast, true);
    mesh.name = `node-${kind}`;
    group.add(mesh);
    nodeMesh[kind] = mesh;
    triangles += triCount(geo) * list.length;
    drawCalls++;

    const st = NODE_STYLE[kind];
    list.forEach((n, i) => {
      const rng = mulberry32(4242 + n.id * 7919);
      const s = st.s[0] + (n.scale - 0.85) / 0.4 * (st.s[1] - st.s[0]);
      const y = heightAt(n.x, n.z) - st.sink * s;
      const rec = {
        id: n.id, kind, i, node: n,
        x: n.x, z: n.z, y, ry: n.rot, s,
        punch: 0, vis: 1, want: 1, pop: 0
      };
      record.set(n.id, rec);
      if (kind === 'sheep') {
        rec.px = n.x; rec.pz = n.z;
        rec.tx = n.x; rec.tz = n.z;
        rec.wait = rng() * 3;
        rec.phase = rng() * 6.28;
        rec.rng = rng;
        sheepList.push(rec);
      }
      setInstance(mesh, i, rec.x, rec.y, rec.z, rec.ry, rec.s, rec.s);
    });
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceMatrix.needsUpdate = true;
  }

  // felled-tree stumps live in their own kit, hidden until a tree is worked out
  const treeList = byKind.tree;
  let stumpMesh = null;
  if (treeList.length) {
    const geo = K.stump();
    geos['node-stump'] = geo;
    stumpMesh = instanced(geo, mats.solid, treeList.length, true, true);
    stumpMesh.name = 'node-stump';
    group.add(stumpMesh);
    triangles += triCount(geo) * treeList.length;
    drawCalls++;
    treeList.forEach((n, i) => {
      const rec = record.get(n.id);
      rec.stumpIndex = i;
      setInstance(stumpMesh, i, rec.x, rec.y, rec.z, rec.ry + 0.7, 0.0001, 0.0001);
    });
    stumpMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    stumpMesh.instanceMatrix.needsUpdate = true;
  }

  /* --------------------------------------------------------- animation */

  function writeNode(rec) {
    const mesh = nodeMesh[rec.kind];
    if (!mesh) return;
    const punchS = 1 + Math.sin(rec.punch * Math.PI) * 0.20;
    const popS = 1 + Math.sin(rec.pop * Math.PI) * 0.28;
    const shake = Math.sin(rec.punch * 34) * 0.10 * rec.punch;
    const s = rec.s * rec.vis * punchS * popS;
    if (rec.kind === 'sheep') {
      const bob = Math.sin(rec.phase) * 0.045;
      const graze = rec.wait > 0 ? 0.20 + Math.sin(rec.phase * 1.7) * 0.05 : 0.04;
      setInstance(mesh, rec.i, rec.px, rec.y + bob, rec.pz,
        rec.ry + shake, Math.max(s, 0.0001), Math.max(s * (1 - bob * 0.4), 0.0001),
        0, -graze);
    } else {
      const lean = rec.kind === 'tree' ? shake * 0.5 : 0;
      setInstance(mesh, rec.i, rec.x, rec.y, rec.z, rec.ry + shake,
        Math.max(s, 0.0001), Math.max(s * (1 + (1 - punchS) * 0.6), 0.0001), 0, lean);
    }
    dirty.add(rec.kind);
    if (rec.kind === 'tree' && stumpMesh) {
      const g = rec.s * (1 - rec.vis) * 0.95;
      setInstance(stumpMesh, rec.stumpIndex, rec.x, rec.y, rec.z, rec.ry + 0.7,
        Math.max(g, 0.0001), Math.max(g, 0.0001));
      dirty.add('stump');
    }
  }

  const active = new Set();

  function moveSheep(rec, dt) {
    const speed = 1.5;
    rec.phase += dt * (rec.wait > 0 ? 2.4 : 6.0);
    if (rec.want < 0.99) {
      // fleeing: keep running along the current heading while it shrinks away
      rec.px += Math.cos(rec.ry) * dt * 4.2 * rec.vis;
      rec.pz -= Math.sin(rec.ry) * dt * 4.2 * rec.vis;
      rec.y = heightAt(rec.px, rec.pz) - 0.03;
      return;
    }
    if (rec.wait > 0) { rec.wait -= dt; return; }
    const dx = rec.tx - rec.px, dz = rec.tz - rec.pz;
    const d = Math.hypot(dx, dz);
    if (d < 0.22) {
      const tile = tiles[rec.node.tile];
      for (let k = 0; k < 20; k++) {
        const a = rec.rng() * Math.PI * 2;
        const r = 1.2 + rec.rng() * 3.4;
        const nx = rec.node.x + Math.cos(a) * r;
        const nz = rec.node.z + Math.sin(a) * r;
        if (hexFrac(nx - tile.x, nz - tile.z) > 0.72) continue;
        rec.tx = nx; rec.tz = nz; break;
      }
      rec.wait = 1.6 + rec.rng() * 3.6;
      return;
    }
    const k = Math.min(1, (dt * speed) / d);
    rec.px += dx * k; rec.pz += dz * k;
    rec.y = heightAt(rec.px, rec.pz) - 0.03;
    // the sheep's nose is along local +X, so heading -> yaw is atan2(-dz, dx)
    const want = Math.atan2(-dz, dx);
    let diff = want - rec.ry;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    rec.ry += diff * Math.min(1, dt * 5);
  }

  let wind = 0;
  let poll = 0;

  function update(dt) {
    wind += dt;
    mats.tree.userData.wind.value = wind;
    mats.grass.userData.wind.value = wind * 1.35;
    mats.wheat.userData.wind.value = wind * 1.2;

    for (const rec of sheepList) { moveSheep(rec, dt); writeNode(rec); }

    if (active.size) for (const rec of Array.from(active)) {
      let live = false;
      if (rec.punch > 0) { rec.punch = Math.max(0, rec.punch - dt * 2.9); live = true; }
      if (rec.pop > 0) { rec.pop = Math.max(0, rec.pop - dt * 2.4); live = true; }
      if (Math.abs(rec.vis - rec.want) > 0.001) {
        const k = Math.min(1, dt * (rec.want > rec.vis ? 6.5 : 4.2));
        rec.vis += (rec.want - rec.vis) * k;
        live = true;
      } else if (rec.vis !== rec.want) {
        rec.vis = rec.want; live = true;
      }
      writeNode(rec);
      if (!live) active.delete(rec);
    }

    // reconcile with the rules engine so regrown nodes pop back on their own
    poll -= dt;
    if (poll <= 0) {
      poll = 0.25;
      for (const rec of record.values()) {
        const alive = rec.node.remaining > 0;
        const want = alive ? 1 : DEPLETED_VIS[rec.kind];
        if (want !== rec.want) {
          rec.want = want;
          if (alive) {
            rec.pop = 1;
            if (rec.kind === 'sheep') { rec.px = rec.node.x; rec.pz = rec.node.z; }
          }
          active.add(rec);
        }
      }
    }

    for (const kind of dirty) {
      if (kind === 'stump') { if (stumpMesh) stumpMesh.instanceMatrix.needsUpdate = true; }
      else if (nodeMesh[kind]) nodeMesh[kind].instanceMatrix.needsUpdate = true;
    }
    dirty.clear();
  }

  function resolve(idOrNode) {
    if (idOrNode == null) return null;
    const id = typeof idOrNode === 'object' ? idOrNode.id : idOrNode;
    return record.get(id) || null;
  }

  return {
    group,
    meshes,
    nodeMesh,
    materials: mats,
    triangles,
    drawCalls,

    playHarvest(idOrNode) {
      const rec = resolve(idOrNode);
      if (!rec) return;
      rec.punch = 1;
      if (rec.kind === 'sheep') rec.wait = Math.max(rec.wait, 0.9);
      active.add(rec);
    },

    setDepleted(idOrNode, on = true) {
      const rec = resolve(idOrNode);
      if (!rec) return;
      const want = on ? DEPLETED_VIS[rec.kind] : 1;
      if (want === rec.want) return;
      rec.want = want;
      if (!on) {
        rec.pop = 1;
        if (rec.kind === 'sheep') { rec.px = rec.node.x; rec.pz = rec.node.z; }
      }
      active.add(rec);
    },

    /** Where a node's visual currently stands — handy for FX anchoring. */
    nodeAnchor(idOrNode) {
      const rec = resolve(idOrNode);
      if (!rec) return null;
      const x = rec.kind === 'sheep' ? rec.px : rec.x;
      const z = rec.kind === 'sheep' ? rec.pz : rec.z;
      return { x, y: rec.y, z };
    },

    update,

    dispose() {
      for (const k in geos) geos[k].dispose();
      for (const k in mats) mats[k].dispose();
    }
  };
}

export default buildProps;
