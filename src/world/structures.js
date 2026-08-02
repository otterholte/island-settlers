/**
 * Island Settlers — player-built structures.
 *
 *   buildStructures(scene, state) -> {
 *     group, syncFromState(), spawnRoad(edgeId, pid), spawnSettlement(iid, pid),
 *     upgradeCity(iid, pid), setRobber(tileId), ghostRoad(edgeId, pid),
 *     ghostSettlement(iid, pid), clearGhost(), update(dt)
 *   }
 *
 * Everything the players build shares fifteen meshes:
 *
 *   roads      bed (kerbs + sleeper) | three plank groups | OWNER DECK
 *   villages   plaster walls and yard | OWNER ROOFS + banner
 *   cities     walls and hall | curtain wall | OWNER TOWERS | OWNER ROOFS,
 *              steeple and banners
 *   ground     one pooled mesh of painted owner rings, terrain-following
 *   people     one villager InstancedMesh for every settlement and city
 *   fx         one billboarded puff pool for chimney smoke and build dust
 *   knight     hooded figure, red ground vignette
 *   ghost      one translucent preview mesh, geometry swapped per request
 *
 * OWNERSHIP IS THE SILHOUETTE, NOT A TRIM. The player could not find their own
 * pieces because the owner colour was a 5cm stripe on a brown plank and a
 * hand-sized flag. Now the owner's colour is the road's whole deck, every roof
 * on every building, the city's towers, and a painted band on the ground under
 * the pad — so a piece reads as *whose* before it reads as *what*. It still
 * costs nothing: all of that geometry is authored pure white and tinted
 * through InstancedMesh.setColorAt, one instance colour per piece.
 *
 * The human's pieces get a brighter, wider ground band than any rival's.
 *
 * Placement: a village/city pad sits on the HIGHEST ground under its footprint
 * and its plinth sinks far enough to swallow the drop to the lowest. Roads sit
 * on the highest ground along their edge with a buried sleeper doing the same
 * job. Nothing is ever placed at y = 0.
 */

import * as THREE from 'three';
import { HEX_SIZE, PLAYER_COLORS, PIECE_LIMIT } from '../core/constants.js';
import { knightsOn } from '../core/options.js';
import { tiles, intersections, edges } from '../board/layout.js';
import { heightAt, topOf } from './terrain.js';
import { instanced, setInstance, hideInstance, triCount } from './geo.js';
import {
  villagerGeo, solidMaterial, clothMaterial, puffTexture, puffMaterial
} from './buildkit.js';
import { createOwnerRings } from './ownring.js';
import * as T from './buildtown.js';

const ROAD_L = HEX_SIZE * 0.88;
/* Instance capacity, DERIVED from the rules rather than written down.
   These were once hard-coded for a 12/5/4 piece limit; when the limits were
   retuned to 18/7/5 the caps were missed, so on a long board every road past
   the 48th and every village past the 22nd silently failed to appear. Deriving
   them means the renderer can never fall behind the rules again.
   Capacity is only an allocation — an instance costs nothing to draw until a
   piece actually occupies it. */
const SEATS = PLAYER_COLORS.length;
const MAX_ROADS = SEATS * PIECE_LIMIT.road;              // 72
const MAX_BUILDINGS = SEATS * PIECE_LIMIT.settlement;    // 28
const MAX_CITIES = SEATS * PIECE_LIMIT.city;             // 20

const CAP = {
  bed: MAX_ROADS, plank: MAX_ROADS * 3, trim: MAX_ROADS,
  village: MAX_BUILDINGS, city: MAX_CITIES, tower: MAX_CITIES * 2,
  folk: MAX_BUILDINGS * 4, puff: 220
};

const _col = new THREE.Color();
const WHITE = new THREE.Color(0xffffff);

/** Owner colour, safe against a stray player id. */
function playerHex(pid) {
  const p = PLAYER_COLORS[((pid | 0) % PLAYER_COLORS.length + PLAYER_COLORS.length) % PLAYER_COLORS.length];
  return p ? p.hex : 0xffffff;
}

/* ------------------------------------------------------------- allocators */

/**
 * Compact slot allocator. `high()` is the live high-water mark and shrinks
 * again when the top slots are released, so InstancedMesh.count only ever
 * covers instances that are actually on the board.
 */
function allocator(cap) {
  const used = new Uint8Array(cap);
  const free = [];
  let next = 0, high = 0;
  return {
    cap,
    take() {
      let i;
      if (free.length) {
        // always reuse the LOWEST free slot so `high` stays packed
        let b = 0;
        for (let k = 1; k < free.length; k++) if (free[k] < free[b]) b = k;
        i = free[b];
        free.splice(b, 1);
      } else i = next++;
      if (i >= cap) return -1;
      used[i] = 1;
      if (i + 1 > high) high = i + 1;
      return i;
    },
    give(i) {
      if (i < 0 || i >= cap || !used[i]) return;
      used[i] = 0;
      free.push(i);
      while (high > 0 && !used[high - 1]) high--;
    },
    reset() { used.fill(0); free.length = 0; next = 0; high = 0; },
    high() { return high; }
  };
}

/* ------------------------------------------------------------ ground math */

/** Highest and lowest ground under a disc — how pads decide their sit height. */
function groundBand(x, z, r, rings = 2, spokes = 8) {
  let hi = heightAt(x, z), lo = hi;
  for (let k = 1; k <= rings; k++) {
    const rr = (r * k) / rings;
    for (let s = 0; s < spokes; s++) {
      const a = (Math.PI * 2 * s) / spokes + k * 0.4;
      const h = heightAt(x + Math.cos(a) * rr, z + Math.sin(a) * rr);
      if (h > hi) hi = h;
      if (h < lo) lo = h;
    }
  }
  return { hi, lo, spread: hi - lo };
}

/** Highest and lowest ground along an edge. */
function edgeBand(e, samples = 9) {
  const A = intersections[e.a], B = intersections[e.b];
  let hi = -Infinity, lo = Infinity;
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const h = heightAt(A.x + (B.x - A.x) * t, A.z + (B.z - A.z) * t);
    if (h > hi) hi = h;
    if (h < lo) lo = h;
  }
  return { hi, lo, spread: hi - lo };
}

/* --------------------------------------------------------------- easings */

const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeOutBack = p => {
  const c = 1.9;
  const q = p - 1;
  return 1 + (c + 1) * q * q * q + c * q * q;
};
const easeOutCubic = p => 1 - Math.pow(1 - p, 3);

/* ==================================================================== API */

export function buildStructures(scene, state) {
  const group = new THREE.Group();
  group.name = 'structures';
  if (scene) scene.add(group);

  const solid = solidMaterial();
  const banner = clothMaterial();

  /* ------------------------------------------------------------- geometry */
  const G = {
    bed: T.roadBedGeo(ROAD_L),
    plank: T.roadPlankGeo(ROAD_L),
    trim: T.roadTrimGeo(ROAD_L),
    village: T.villageBaseGeo(),
    villageTint: T.villageTintGeo(),
    cityCore: T.cityCoreGeo(),
    cityWall: T.cityWallGeo(),
    cityTower: T.cityTowerGeo(),
    cityTint: T.cityTintGeo(),
    folk: villagerGeo(true),
    knight: T.knightGeo(),
    vignette: T.knightVignetteGeo(HEX_SIZE * 0.94),
    ghostRoad: T.ghostRoadGeo(ROAD_L),
    ghostVillage: T.ghostSettlementGeo(),
    puff: new THREE.PlaneGeometry(1, 1, 1, 1)
  };
  // the puff quad rides on the shared vertex-colour convention
  G.puff.setAttribute('color',
    new THREE.BufferAttribute(new Float32Array(G.puff.attributes.position.count * 3).fill(1), 3));

  /* ---------------------------------------------------------------- meshes */
  const M = {
    bed: instanced(G.bed, solid, CAP.bed, false, true),
    // The planks no longer cast: the painted deck now covers them, a road lies
    // flat on the ground so its shadow was a hairline nobody could see, and the
    // shadow pass was costing more triangles than the whole road kit.
    plank: instanced(G.plank, solid, CAP.plank, false, true),
    trim: instanced(G.trim, banner, CAP.trim, false, false),
    village: instanced(G.village, solid, CAP.village, true, true),
    villageTint: instanced(G.villageTint, banner, CAP.village, false, false),
    cityCore: instanced(G.cityCore, solid, CAP.city, true, true),
    cityWall: instanced(G.cityWall, solid, CAP.city, true, true),
    cityTower: instanced(G.cityTower, solid, CAP.tower, true, true),
    cityTint: instanced(G.cityTint, banner, CAP.city, false, false),
    folk: instanced(G.folk, solid, CAP.folk, true, false)
  };
  for (const k in M) { M[k].count = 0; group.add(M[k]); }

  // Every instanced mesh that carries an owner colour needs its colour buffer
  // to exist up front, otherwise the first write reallocates mid-frame.
  const TINTED = {
    trim: CAP.trim, villageTint: CAP.village, cityTint: CAP.city,
    cityTower: CAP.tower, folk: CAP.folk
  };
  for (const k in TINTED) {
    M[k].instanceColor =
      new THREE.InstancedBufferAttribute(new Float32Array(TINTED[k] * 3).fill(1), 3);
  }

  /* Painted ground band under every village and city. One draw call, but the
     vertices are sampled off `heightAt` so the band creases with the ground
     instead of hovering over the low side of a hex corner. */
  const rings = createOwnerRings({ slots: CAP.village + 4 });
  group.add(rings.mesh);

  /* ------------------------------------------------------------------ puffs */
  const puffTex = puffTexture();
  const puffMat = puffMaterial(puffTex);
  const puffMesh = new THREE.InstancedMesh(G.puff, puffMat, CAP.puff);
  puffMesh.frustumCulled = false;
  puffMesh.renderOrder = 4;
  puffMesh.count = CAP.puff;
  const puffAlpha = new THREE.InstancedBufferAttribute(new Float32Array(CAP.puff), 1);
  G.puff.setAttribute('aAlpha', puffAlpha);
  puffMesh.instanceColor =
    new THREE.InstancedBufferAttribute(new Float32Array(CAP.puff * 3).fill(1), 3);
  group.add(puffMesh);

  const puffs = [];
  for (let i = 0; i < CAP.puff; i++) {
    puffs.push({ life: 0, max: 1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, s0: 0.3, s1: 1 });
    hideInstance(puffMesh, i);
    puffAlpha.array[i] = 0;
  }
  let puffCursor = 0;

  function emitPuff(x, y, z, opts = {}) {
    const slot = puffCursor;
    puffCursor = (puffCursor + 1) % CAP.puff;
    const p = puffs[slot];
    p.life = 0;
    p.max = opts.life ?? 1.4;
    p.x = x; p.y = y; p.z = z;
    p.vx = opts.vx ?? 0; p.vy = opts.vy ?? 0.55; p.vz = opts.vz ?? 0;
    p.s0 = opts.s0 ?? 0.35;
    p.s1 = opts.s1 ?? 1.5;
    p.a = opts.a ?? 0.72;
    _col.set(opts.color ?? 0xe9dcc2);
    puffMesh.instanceColor.setXYZ(slot, _col.r, _col.g, _col.b);
    puffMesh.instanceColor.needsUpdate = true;
  }

  function dustRing(x, y, z, r, n, opts = {}) {
    for (let i = 0; i < n; i++) {
      const a = (Math.PI * 2 * i) / n + Math.random() * 0.4;
      emitPuff(x + Math.cos(a) * r * 0.6, y + 0.1, z + Math.sin(a) * r * 0.6, {
        vx: Math.cos(a) * (opts.speed ?? 1.5),
        vz: Math.sin(a) * (opts.speed ?? 1.5),
        vy: 0.5 + Math.random() * 0.5,
        life: opts.life ?? 0.85,
        s0: opts.s0 ?? 0.5, s1: opts.s1 ?? (r * 0.9),
        a: opts.a ?? 0.62,
        color: opts.color ?? 0xd8c49a
      });
    }
  }

  /* ------------------------------------------------------------- allocators */
  // One allocator per *piece*, not per mesh: a village's body and its banner
  // share a slot index, and a city's core, wall, banners and its two towers
  // (slot*2, slot*2+1) all derive from the same number.
  const alloc = {
    bed: allocator(CAP.bed), plank: allocator(CAP.plank), trim: allocator(CAP.trim),
    village: allocator(CAP.village), city: allocator(CAP.city),
    folk: allocator(CAP.folk)
  };

  const roads = new Map();      // edgeId -> record
  const builds = new Map();     // intersectionId -> record
  const folks = [];             // villager records

  function syncCounts() {
    M.bed.count = alloc.bed.high();
    M.plank.count = alloc.plank.high();
    M.trim.count = alloc.trim.high();
    M.village.count = M.villageTint.count = alloc.village.high();
    M.cityCore.count = M.cityWall.count = M.cityTint.count = alloc.city.high();
    M.cityTower.count = alloc.city.high() * 2;
    M.folk.count = alloc.folk.high();
  }

  /* ------------------------------------------------------------- villagers */

  function addFolk(rec, count, padY) {
    for (let i = 0; i < count; i++) {
      const slot = alloc.folk.take();
      if (slot < 0) return;
      const a = (Math.PI * 2 * i) / count + rec.yaw;
      const r = rec.walkR * (0.4 + 0.5 * ((i * 7 % 5) / 5));
      const f = {
        slot, rec, padY,
        x: rec.x + Math.cos(a) * r, z: rec.z + Math.sin(a) * r,
        tx: rec.x + Math.cos(a) * r, tz: rec.z + Math.sin(a) * r,
        wait: 0.4 + i * 0.5, ry: -a, phase: i * 1.7,
        speed: 0.75 + (i % 3) * 0.18, vis: rec.anim ? 0 : 1
      };
      _col.set(playerHex(rec.pid)).lerp(new THREE.Color(0xffffff), 0.42 + (i % 3) * 0.12);
      M.folk.instanceColor.setXYZ(slot, _col.r, _col.g, _col.b);
      folks.push(f);
    }
    M.folk.instanceColor.needsUpdate = true;
  }

  function removeFolk(rec) {
    for (let i = folks.length - 1; i >= 0; i--) {
      if (folks[i].rec === rec) {
        hideInstance(M.folk, folks[i].slot);
        alloc.folk.give(folks[i].slot);
        folks.splice(i, 1);
      }
    }
    M.folk.instanceMatrix.needsUpdate = true;
  }

  function stepFolk(f, dt) {
    f.phase += dt * 3.4;
    if (f.wait > 0) { f.wait -= dt; }
    else {
      const dx = f.tx - f.x, dz = f.tz - f.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.12) {
        const a = Math.random() * Math.PI * 2;
        const r = f.rec.walkR * (0.25 + Math.random() * 0.75);
        f.tx = f.rec.x + Math.cos(a) * r;
        f.tz = f.rec.z + Math.sin(a) * r;
        f.wait = 0.5 + Math.random() * 2.2;
      } else {
        const k = Math.min(1, (dt * f.speed) / d);
        f.x += dx * k; f.z += dz * k;
        const want = Math.atan2(-dz, dx);
        let diff = want - f.ry;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        f.ry += diff * Math.min(1, dt * 6);
      }
    }
    const moving = f.wait <= 0;
    const bob = moving ? Math.abs(Math.sin(f.phase)) * 0.075 : Math.sin(f.phase * 0.3) * 0.012;
    const s = f.vis;
    setInstance(M.folk, f.slot, f.x, f.padY + bob, f.z, f.ry, s, s,
      0, moving ? Math.sin(f.phase) * 0.12 : 0);
  }

  /* ----------------------------------------------------------------- roads */

  function placeRoadRecord(eid, pid) {
    const e = edges[eid];
    const band = edgeBand(e);
    const rec = {
      eid, pid,
      x: e.x, z: e.z, ang: e.angle, y: band.hi,
      bed: alloc.bed.take(), trim: alloc.trim.take(),
      seg: [alloc.plank.take(), alloc.plank.take(), alloc.plank.take()],
      t: 0, anim: false, landed: [false, false, false],
      spread: band.spread
    };
    roads.set(eid, rec);
    _col.set(playerHex(pid));
    if (rec.trim >= 0) {
      M.trim.instanceColor.setXYZ(rec.trim, _col.r, _col.g, _col.b);
      M.trim.instanceColor.needsUpdate = true;
    }
    return rec;
  }

  function writeRoad(rec) {
    const ry = -rec.ang;
    const c = Math.cos(rec.ang), s = Math.sin(rec.ang);
    const t = rec.t;
    // bed rises out of the ground
    const bk = rec.anim ? clamp01(t / 0.24) : 1;
    if (rec.bed >= 0) setInstance(M.bed, rec.bed, rec.x, rec.y, rec.z, ry, 1, Math.max(0.02, bk));
    // plank groups drop in sequence
    for (let i = 0; i < 3; i++) {
      const slot = rec.seg[i];
      if (slot < 0) continue;
      const off = (i - 1) * (ROAD_L / 3);
      const px = rec.x + c * off, pz = rec.z + s * off;
      if (!rec.anim) { setInstance(M.plank, slot, px, rec.y, pz, ry, 1, 1); continue; }
      const d = t - (0.16 + i * 0.15);
      if (d < 0) { hideInstance(M.plank, slot); continue; }
      const p = clamp01(d / 0.24);
      const lift = 2.6 * (1 - p) * (1 - p);
      const q = clamp01((d - 0.24) / 0.30);
      const squash = 1 - 0.34 * Math.sin(Math.PI * q) * (1 - q * 0.5);
      if (p >= 1 && !rec.landed[i]) {
        rec.landed[i] = true;
        dustRing(px, rec.y, pz, 1.2, 4, { life: 0.62, s1: 1.1, speed: 1.1 });
      }
      setInstance(M.plank, slot, px, rec.y + lift, pz, ry, 1 + (1 - squash) * 0.35, squash);
    }
    // owner trim snaps on at the end
    if (rec.trim >= 0) {
      if (!rec.anim) setInstance(M.trim, rec.trim, rec.x, rec.y, rec.z, ry, 1, 1);
      else {
        const d = clamp01((t - 0.72) / 0.30);
        const s2 = d <= 0 ? 0 : easeOutBack(d);
        setInstance(M.trim, rec.trim, rec.x, rec.y, rec.z, ry, 1, Math.max(0.001, s2));
      }
    }
  }

  function spawnRoad(eid, pid, instant = false) {
    if (roads.has(eid)) return;
    if (!edges[eid]) return;
    const rec = placeRoadRecord(eid, pid);
    rec.anim = !instant;
    if (!instant) dustRing(rec.x, rec.y, rec.z, 2.2, 6, { life: 0.7, s1: 1.6 });
    writeRoad(rec);
    syncCounts();
    flagRoads();
  }

  function flagRoads() {
    M.bed.instanceMatrix.needsUpdate = true;
    M.plank.instanceMatrix.needsUpdate = true;
    M.trim.instanceMatrix.needsUpdate = true;
  }

  /* ------------------------------------------------------------- buildings */

  const SMOKE_LOCAL = {
    settlement: [[1.13, 1.58, 0.63]],
    city: [[1.38, 2.30, 0.39], [-1.28, 2.08, 0.67], [0.42, 2.10, -1.20]]
  };

  function baseRecord(iid, pid, type) {
    const n = intersections[iid];
    const radius = type === 'city' ? T.CITY_RADIUS : T.SET_RADIUS;
    const band = groundBand(n.x, n.z, radius * 0.94);
    return {
      iid, pid, type,
      x: n.x, z: n.z, y: band.hi,
      spread: band.spread,
      yaw: -Math.atan2(n.z, n.x),
      walkR: radius * 0.66,
      t: 0, anim: false, smoke: 0.2, smokeIdx: 0,
      slot: -1
    };
  }

  function tintSlotColor(mesh, slot, pid) {
    if (slot < 0) return;
    _col.set(playerHex(pid));
    mesh.instanceColor.setXYZ(slot, _col.r, _col.g, _col.b);
    mesh.instanceColor.needsUpdate = true;
  }

  /* The two corner towers take a slightly lifted owner colour: the tower kit is
     authored pale precisely so this lands on clean coloured stone. */
  function tintTowers(slot, pid) {
    if (slot < 0) return;
    _col.set(playerHex(pid)).lerp(WHITE, 0.20);
    M.cityTower.instanceColor.setXYZ(slot * 2, _col.r, _col.g, _col.b);
    M.cityTower.instanceColor.setXYZ(slot * 2 + 1, _col.r, _col.g, _col.b);
    M.cityTower.instanceColor.needsUpdate = true;
  }

  /** The painted ground band. The human's is brighter than any rival's. */
  function setRing(rec, instant) {
    const city = rec.type === 'city';
    const mine = rec.pid === 0;
    const r = city ? T.CITY_RADIUS : T.SET_RADIUS;
    rings.set(rec.iid, {
      x: rec.x, z: rec.z,
      rIn: r * (city ? 0.98 : 0.95),
      rOut: r * (city ? 1.64 : 1.72) * (mine ? 1.12 : 1),
      color: playerHex(rec.pid),
      emphasis: mine,
      instant
    });
  }

  function writeVillage(rec) {
    const t = rec.t;
    const p = rec.anim ? clamp01(t / 0.52) : 1;
    const s = rec.anim ? (p <= 0 ? 0.001 : easeOutBack(p)) : 1;
    const sy = rec.anim ? s * (1 + 0.16 * Math.sin(Math.PI * clamp01(t / 0.36))) : 1;
    if (rec.slot < 0) return;
    setInstance(M.village, rec.slot, rec.x, rec.y, rec.z, rec.yaw, s, sy);
    // The owner mesh is now the roofs, not a flag hung on afterwards, so it
    // rides the body's transform exactly instead of unfurling on its own clock.
    setInstance(M.villageTint, rec.slot, rec.x, rec.y, rec.z, rec.yaw,
      Math.max(0.001, s), Math.max(0.001, sy));
    M.village.instanceMatrix.needsUpdate = true;
    M.villageTint.instanceMatrix.needsUpdate = true;
  }

  function writeCity(rec) {
    if (rec.slot < 0) return;
    const t = rec.t;
    const A = rec.anim;
    // core rises and expands out of the old village footprint
    const cp = A ? clamp01((t - 0.18) / 0.62) : 1;
    const cs = A ? 0.52 + easeOutBack(cp) * 0.48 : 1;
    const cy = A ? -0.55 * (1 - easeOutCubic(cp)) : 0;
    setInstance(M.cityCore, rec.slot, rec.x, rec.y + cy, rec.z, rec.yaw, cs, cs);
    // curtain wall pushes up out of the ground
    const wp = A ? clamp01((t - 0.30) / 0.50) : 1;
    setInstance(M.cityWall, rec.slot, rec.x, rec.y, rec.z, rec.yaw, 1,
      Math.max(0.02, easeOutCubic(wp)));
    // towers telescope up out of the wall line
    const tr = T.CITY_RADIUS - 0.42;
    for (let i = 0; i < 2; i++) {
      const ang = (i === 0 ? 2.10 : -2.10) - rec.yaw;
      const tp = A ? clamp01((t - 0.48 - i * 0.10) / 0.48) : 1;
      setInstance(M.cityTower, rec.slot * 2 + i,
        rec.x + Math.cos(ang) * tr, rec.y + 0.22, rec.z + Math.sin(ang) * tr,
        rec.yaw, 1, Math.max(0.02, easeOutBack(tp)));
    }
    // roofs, steeple and banners all belong to the core mass now
    setInstance(M.cityTint, rec.slot, rec.x, rec.y + cy, rec.z, rec.yaw, cs, cs);
    M.cityCore.instanceMatrix.needsUpdate = true;
    M.cityWall.instanceMatrix.needsUpdate = true;
    M.cityTower.instanceMatrix.needsUpdate = true;
    M.cityTint.instanceMatrix.needsUpdate = true;
  }

  function releaseBuild(rec) {
    if (rec.slot >= 0) {
      if (rec.type === 'city') {
        hideInstance(M.cityCore, rec.slot);
        hideInstance(M.cityWall, rec.slot);
        hideInstance(M.cityTint, rec.slot);
        hideInstance(M.cityTower, rec.slot * 2);
        hideInstance(M.cityTower, rec.slot * 2 + 1);
        alloc.city.give(rec.slot);
      } else {
        hideInstance(M.village, rec.slot);
        hideInstance(M.villageTint, rec.slot);
        alloc.village.give(rec.slot);
      }
    }
    rec.slot = -1;
    rings.clear(rec.iid);
    removeFolk(rec);
  }

  function spawnSettlement(iid, pid, instant = false) {
    const old = builds.get(iid);
    if (old) { releaseBuild(old); builds.delete(iid); }
    if (!intersections[iid]) return null;
    const rec = baseRecord(iid, pid, 'settlement');
    rec.slot = alloc.village.take();
    rec.anim = !instant;
    builds.set(iid, rec);
    tintSlotColor(M.villageTint, rec.slot, pid);
    setRing(rec, instant);
    addFolk(rec, 2, rec.y + 0.22);
    syncCounts();
    if (!instant) dustRing(rec.x, rec.y, rec.z, T.SET_RADIUS * 1.5, 9, { life: 0.9, s1: 2.0 });
    writeVillage(rec);
    return rec;
  }

  function upgradeCity(iid, pid, instant = false) {
    const old = builds.get(iid);
    if (old && old.type === 'city') return old;
    if (old) { releaseBuild(old); builds.delete(iid); }
    if (!intersections[iid]) return null;
    const rec = baseRecord(iid, pid, 'city');
    rec.slot = alloc.city.take();
    rec.anim = !instant;
    builds.set(iid, rec);
    tintSlotColor(M.cityTint, rec.slot, pid);
    tintTowers(rec.slot, pid);
    setRing(rec, instant);
    addFolk(rec, 4, rec.y + 0.22);
    syncCounts();
    if (!instant) {
      dustRing(rec.x, rec.y, rec.z, T.CITY_RADIUS * 1.6, 14, { life: 1.25, s1: 2.9, speed: 2.4 });
    }
    writeCity(rec);
    return rec;
  }

  /* ---------------------------------------------------------------- knight
   *
   * A match with Knights switched off (`core/options.js`) has no Knight in the
   * deck, so the figure would stand on the desert for the whole match doing
   * nothing and telling the player something untrue. Both it and its ground
   * vignette stay hidden — checked once here and once more inside `setRobber`,
   * since that is the only thing that ever turns the vignette back on. */
  const knightsLive = knightsOn();

  const knight = new THREE.Mesh(G.knight, solid);
  knight.castShadow = true;
  knight.frustumCulled = false;
  knight.visible = knightsLive;
  group.add(knight);

  const vignetteMat = new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, opacity: 0.3,
    depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide
  });
  const vignette = new THREE.Mesh(G.vignette, vignetteMat);
  vignette.renderOrder = 3;
  vignette.frustumCulled = false;
  group.add(vignette);

  const rob = {
    tile: -1, x: 0, y: 0, z: 0, fx: 0, fz: 0, fy: 0,
    t: 1, dur: 0.75, smoke: 0, pulse: 0
  };

  function robberSpot(tileId) {
    const t = tiles[tileId] || tiles[0];
    const a = 1.45;
    const r = HEX_SIZE * 0.44;
    const x = t.x + Math.cos(a) * r, z = t.z + Math.sin(a) * r;
    return { x, z, y: heightAt(x, z), tile: t };
  }

  function setRobber(tileId, instant = false) {
    const s = robberSpot(tileId);
    rob.fx = rob.x; rob.fz = rob.z; rob.fy = rob.y;
    rob.tile = tileId;
    rob.x = s.x; rob.y = s.y; rob.z = s.z;
    rob.t = instant ? 1 : 0;
    if (rob.t >= 1) {
      knight.position.set(rob.x, rob.y, rob.z);
      knight.scale.set(1, 1, 1);
      knight.rotation.y = 0;
    }
    const t = s.tile;
    // the vignette is a flat annulus on the tile's plateau, not on the peaks
    vignette.position.set(t.x, topOf(t) + 0.07, t.z);
    vignette.visible = knightsLive;
  }

  function stepRobber(dt) {
    if (rob.t < 1) {
      rob.t = Math.min(1, rob.t + dt / rob.dur);
      const p = rob.t;
      const x = rob.fx + (rob.x - rob.fx) * p;
      const z = rob.fz + (rob.z - rob.fz) * p;
      const arc = Math.sin(Math.PI * p) * 6.5;
      const y = rob.fy + (rob.y - rob.fy) * p + arc;
      knight.position.set(x, y, z);
      const spin = (1 - p) * 6.0;
      knight.rotation.y = spin;
      const land = clamp01((p - 0.86) / 0.14);
      knight.scale.set(1 + land * 0.30, 1 - land * 0.26, 1 + land * 0.30);
      if (p >= 1) {
        knight.scale.set(1, 1, 1);
        knight.rotation.y = 0;
        dustRing(rob.x, rob.y, rob.z, 3.4, 12, {
          life: 1.0, s1: 2.6, speed: 3.4, color: 0x6b5f4d, a: 0.7
        });
      }
    }
    // swirling dark smoke around the figure
    rob.smoke -= dt;
    if (rob.smoke <= 0) {
      rob.smoke = 0.16;
      const a = Math.random() * Math.PI * 2;
      emitPuff(rob.x + Math.cos(a) * 0.75, rob.y + 0.4 + Math.random() * 0.6, rob.z + Math.sin(a) * 0.75, {
        vx: Math.cos(a + 1.6) * 0.7, vz: Math.sin(a + 1.6) * 0.7, vy: 0.85,
        life: 1.9, s0: 0.5, s1: 2.1, a: 0.5, color: 0x2c2a3a
      });
    }
    rob.pulse += dt * 2.4;
    vignetteMat.opacity = 0.24 + Math.sin(rob.pulse) * 0.09;
  }

  /* ---------------------------------------------------------------- ghosts */

  const ghostMat = new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, opacity: 0.4, depthWrite: false,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide
  });
  const ghost = new THREE.Mesh(G.ghostRoad, ghostMat);
  ghost.visible = false;
  ghost.renderOrder = 6;
  ghost.frustumCulled = false;
  group.add(ghost);
  let ghostT = 0;

  function ghostRoad(eid, pid) {
    const e = edges[eid];
    if (!e) return;
    const band = edgeBand(e);
    ghost.geometry = G.ghostRoad;
    ghost.position.set(e.x, band.hi, e.z);
    ghost.rotation.set(0, -e.angle, 0);
    ghostMat.color.set(playerHex(pid));
    ghost.visible = true;
    ghostT = 0;
  }

  function ghostSettlement(iid, pid) {
    const n = intersections[iid];
    if (!n) return;
    const band = groundBand(n.x, n.z, T.SET_RADIUS * 0.94);
    ghost.geometry = G.ghostVillage;
    ghost.position.set(n.x, band.hi, n.z);
    ghost.rotation.set(0, -Math.atan2(n.z, n.x), 0);
    ghostMat.color.set(playerHex(pid));
    ghost.visible = true;
    ghostT = 0;
  }

  function clearGhost() { ghost.visible = false; }

  /* ------------------------------------------------------------------ sync */

  function clearAll() {
    for (const rec of builds.values()) releaseBuild(rec);
    builds.clear();
    for (const rec of roads.values()) {
      if (rec.bed >= 0) { hideInstance(M.bed, rec.bed); alloc.bed.give(rec.bed); }
      if (rec.trim >= 0) { hideInstance(M.trim, rec.trim); alloc.trim.give(rec.trim); }
      for (const s of rec.seg) if (s >= 0) { hideInstance(M.plank, s); alloc.plank.give(s); }
    }
    roads.clear();
    rings.clearAll();
    for (const k in alloc) alloc[k].reset();
    syncCounts();
    flagRoads();
  }

  function syncFromState() {
    if (!state) return;
    clearAll();
    if (state.roadOwner) {
      for (const [eid, pid] of state.roadOwner) spawnRoad(eid, pid, true);
    }
    if (state.buildings) {
      for (const [iid, b] of state.buildings) {
        if (b.type === 'city') upgradeCity(iid, b.owner, true);
        else spawnSettlement(iid, b.owner, true);
      }
    }
    setRobber(state.robberTile ?? 0, true);
    for (const rec of roads.values()) writeRoad(rec);
    for (const rec of builds.values()) (rec.type === 'city' ? writeCity : writeVillage)(rec);
    flagRoads();
  }

  /* ----------------------------------------------------------------- frame */

  const _m = new THREE.Matrix4();
  const _p = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const _s = new THREE.Vector3();

  function stepPuffs(dt) {
    let live = false;
    for (let i = 0; i < CAP.puff; i++) {
      const p = puffs[i];
      if (p.life >= p.max) {
        if (puffAlpha.array[i] !== 0) { puffAlpha.array[i] = 0; hideInstance(puffMesh, i); live = true; }
        continue;
      }
      p.life += dt;
      const k = clamp01(p.life / p.max);
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      p.vx *= 1 - dt * 1.6; p.vz *= 1 - dt * 1.6; p.vy *= 1 - dt * 0.5;
      const size = p.s0 + (p.s1 - p.s0) * easeOutCubic(k);
      puffAlpha.array[i] = p.a * (1 - k) * Math.min(1, k * 6);
      _p.set(p.x, p.y, p.z); _s.set(size, size, size);
      _m.compose(_p, _q, _s);
      puffMesh.setMatrixAt(i, _m);
      live = true;
    }
    if (live) {
      puffMesh.instanceMatrix.needsUpdate = true;
      puffAlpha.needsUpdate = true;
    }
  }

  function stepSmoke(rec, dt) {
    rec.smoke -= dt;
    if (rec.smoke > 0) return;
    rec.smoke = rec.type === 'city' ? 0.42 : 0.62;
    const list = SMOKE_LOCAL[rec.type];
    const l = list[(rec.smokeIdx = ((rec.smokeIdx || 0) + 1) % list.length)];
    const c = Math.cos(-rec.yaw), s = Math.sin(-rec.yaw);
    const wx = rec.x + l[0] * c - l[2] * s;
    const wz = rec.z + l[0] * s + l[2] * c;
    emitPuff(wx, rec.y + l[1], wz, {
      vx: 0.16, vz: 0.10, vy: 0.75, life: 2.3,
      s0: 0.30, s1: 1.55, a: 0.42, color: 0xdcd6cc
    });
  }

  let time = 0;

  function update(dt) {
    if (!(dt > 0)) dt = 0;
    time += dt;

    // roads under construction
    let roadsDirty = false;
    for (const rec of roads.values()) {
      if (!rec.anim) continue;
      rec.t += dt;
      writeRoad(rec);
      roadsDirty = true;
      if (rec.t > 1.15) { rec.anim = false; rec.t = 0; writeRoad(rec); }
    }
    if (roadsDirty) flagRoads();

    // buildings
    for (const rec of builds.values()) {
      if (rec.anim) {
        rec.t += dt;
        if (rec.type === 'city') writeCity(rec); else writeVillage(rec);
        if (rec.t > (rec.type === 'city' ? 1.30 : 0.92)) {
          rec.anim = false; rec.t = 0;
          if (rec.type === 'city') writeCity(rec); else writeVillage(rec);
        }
      }
      stepSmoke(rec, dt);
    }

    // villagers
    for (const f of folks) {
      const target = f.rec.anim ? clamp01((f.rec.t - 0.42) / 0.34) : 1;
      f.vis += (target - f.vis) * Math.min(1, dt * 6);
      stepFolk(f, dt);
    }
    if (folks.length) M.folk.instanceMatrix.needsUpdate = true;

    stepRobber(dt);
    stepPuffs(dt);
    rings.update(dt);

    if (ghost.visible) {
      ghostT += dt;
      ghostMat.opacity = 0.30 + Math.sin(ghostT * 4.2) * 0.13;
      const k = 1 + Math.sin(ghostT * 4.2) * 0.018;
      ghost.scale.set(k, k, k);
    }
  }

  /* ------------------------------------------------------------- reporting */

  function stats() {
    const per = {
      bed: triCount(G.bed), plank: triCount(G.plank), trim: triCount(G.trim),
      village: triCount(G.village), villageTint: triCount(G.villageTint),
      cityCore: triCount(G.cityCore), cityWall: triCount(G.cityWall),
      cityTower: triCount(G.cityTower), cityTint: triCount(G.cityTint),
      folk: triCount(G.folk), knight: triCount(G.knight),
      vignette: triCount(G.vignette), puff: 2
    };
    const counts = {
      bed: M.bed.count, plank: M.plank.count, trim: M.trim.count,
      village: M.village.count, villageTint: M.villageTint.count,
      cityCore: M.cityCore.count, cityWall: M.cityWall.count,
      cityTower: M.cityTower.count, cityTint: M.cityTint.count,
      folk: M.folk.count, knight: 1, vignette: 1, puff: CAP.puff
    };
    let tris = 0;
    for (const k in counts) tris += counts[k] * per[k];
    tris += rings.triangles;
    return { per, counts, rings: rings.triangles, triangles: Math.round(tris), drawCalls: 15 };
  }

  syncFromState();

  return {
    group,
    meshes: M,
    puffMesh,
    knight,
    ghost,
    rings,
    materials: { solid, banner, ghostMat, vignetteMat, puffMat },
    geometries: G,
    drawCalls: 15,
    stats,

    syncFromState,
    spawnRoad: (eid, pid) => spawnRoad(eid, pid, false),
    spawnSettlement: (iid, pid) => spawnSettlement(iid, pid, false),
    upgradeCity: (iid, pid) => upgradeCity(iid, pid, false),
    setRobber: (tileId) => setRobber(tileId, false),
    ghostRoad,
    ghostSettlement,
    clearGhost,
    update,

    /** Where a piece's banner sits — handy for FX and camera framing. */
    anchorOf(iid) {
      const rec = builds.get(iid);
      if (!rec) return null;
      return { x: rec.x, y: rec.y + (rec.type === 'city' ? 3.4 : 2.4), z: rec.z };
    },

    dispose() {
      for (const k in G) G[k].dispose();
      rings.dispose();
      solid.dispose(); banner.dispose(); ghostMat.dispose();
      vignetteMat.dispose(); puffMat.dispose(); puffTex.dispose();
    }
  };
}

export default buildStructures;
