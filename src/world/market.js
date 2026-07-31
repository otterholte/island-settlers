/**
 * Island Settlers — the Great Market and the nine ports.
 *
 *   buildMarket(scene) -> { group, update(dt) }
 *   buildPorts(scene, state) -> { group, update(dt), setUnlocked(portId, pid) }
 *
 * The market is the island's landmark and gets the biggest single geometry
 * budget on the board: a two-storey trading house with a balcony, a bell
 * cupola and a lit interior, a ring of six awninged stalls each laden with one
 * of the five trade goods, a well, palms, tethered pack camels and a crowd of
 * merchants working the plaza — plus a painted trade banner floating above the
 * mast that can be read from the far shore. Four draw calls: solid, cloth,
 * beacon, crowd.
 *
 * Each port is one instanced kit (see buildport.js) placed at the wet-sand
 * anchor found by walking outward along `port.bearing` until the ground drops
 * to the shoreline. Six draw calls cover all nine: base, ship, flag, sign,
 * crew, gulls.
 */

import * as THREE from 'three';
import { MARKET, ports, edges } from '../board/layout.js';
import { PLAYER_COLORS } from '../core/constants.js';
import { heightAt } from './terrain.js';
import { merge, place, tint, gradient, box, cyl, cone, instanced, setInstance, hideInstance, triCount } from './geo.js';
import { PAL, prism, cloth, crate, palmTree, villagerGeo, glowSolidMaterial, clothMaterial, rng } from './buildkit.js';
import * as MKT from './mktkit.js';
import * as P from './buildport.js';

const _c = new THREE.Color();
const MK = MKT.MK;

/* ======================================================== market geometry */

const PLAZA_R = 6.30;
/** Stall ring: angle (radians) and which trade good each stall deals in. */
const STALLS = [
  { a: 0.838, kind: 0 },   // 48deg  — timber
  { a: 1.571, kind: 1 },   // 90deg  — brick
  { a: 2.304, kind: 2 },   // 132deg — wool
  { a: -2.304, kind: 3 },  //        — grain
  { a: -1.571, kind: 4 },  //        — ore
  { a: -0.838, kind: 5 }   //        — cloth
];
const STALL_R = 4.95;
const AWNING = [
  [0xf6efe1, 0xc23f2c], [0xf6efe1, 0x2f7fa8], [0xf6e7c6, 0x3f8a3c],
  [0xfaf2e2, 0xd98b2b], [0xf6efe1, 0x8552c4], [0xf6e7c6, 0xc23f2c]
];

/** Paved apron: sunken slab, radial joints, kerb ring and the entrance steps. */
function plazaGeo() {
  const parts = [];
  parts.push(place(gradient(new THREE.CylinderGeometry(PLAZA_R, PLAZA_R + 0.34, 2.1, 12),
    0x8f7448, MK.paveLo), 0, -1.05, 0));
  parts.push(place(tint(new THREE.CircleGeometry(PLAZA_R - 0.22, 12), MK.paveHi, 0.045),
    0, 0.02, 0, -Math.PI / 2, 0, 0));
  for (let i = 0; i < 6; i++) {
    parts.push(place(box((PLAZA_R - 0.3) * 2, 0.05, 0.24, MK.paveLo, 0.05), 0, 0.05, 0, 0, (Math.PI / 6) * i, 0));
  }
  parts.push(place(tint(new THREE.RingGeometry(3.30, 3.62, 12, 1), MK.paveLo, 0.05),
    0, 0.06, 0, -Math.PI / 2, 0, 0));
  parts.push(place(tint(new THREE.RingGeometry(PLAZA_R - 0.86, PLAZA_R - 0.28, 12, 1), MK.stoneWarm, 0.05),
    0, 0.06, 0, -Math.PI / 2, 0, 0));
  // kerb blocks, with a gap left open at the +X entrance
  for (let i = 0; i < 16; i++) {
    const a = (Math.PI * 2 * i) / 16;
    if (Math.abs(Math.atan2(Math.sin(a), Math.cos(a))) < 0.30) continue;
    parts.push(place(gradient(new THREE.BoxGeometry(0.42, 0.40, 1.90), MK.stoneDeep, MK.stoneWarm),
      Math.cos(a) * (PLAZA_R + 0.05), 0.10, Math.sin(a) * (PLAZA_R + 0.05), 0, -a, 0));
  }
  // entrance steps down to the sand
  for (let i = 0; i < 3; i++) {
    parts.push(place(gradient(new THREE.BoxGeometry(0.44, 0.20, 3.6 - i * 0.5), MK.stoneDeep, MK.paveHi),
      PLAZA_R + 0.18 + i * 0.44, -0.08 - i * 0.20, 0));
  }
  return merge(parts);
}

/** Gate arch over the entrance, with a hitching rail for the pack animals. */
function gateGeo() {
  return merge([
    place(gradient(new THREE.BoxGeometry(0.52, 3.60, 0.52), MK.stoneDeep, MK.stoneWarm), 0, 1.80, 1.85),
    place(gradient(new THREE.BoxGeometry(0.52, 3.60, 0.52), MK.stoneDeep, MK.stoneWarm), 0, 1.80, -1.85),
    place(box(0.64, 0.56, 4.35, MK.stoneWarm, 0.05), 0, 3.85, 0),
    place(prism(0.92, 0.40, 4.60, MK.tile, MK.tileLo), 0, 4.13, 0),
    place(box(0.30, 0.26, 1.10, MK.timber), 0, 3.30, 1.20, 0, 0, 0.5),
    place(box(0.30, 0.26, 1.10, MK.timber), 0, 3.30, -1.20, 0, 0, -0.5)
  ]);
}

function benchGeo() {
  return merge([
    place(gradient(new THREE.BoxGeometry(1.40, 0.15, 0.46), 0x8a6338, 0xb2854b), 0, 0.46, 0),
    place(box(0.16, 0.40, 0.40, 0x6b4526, 0.05), -0.52, 0.20, 0),
    place(box(0.16, 0.40, 0.40, 0x6b4526, 0.05), 0.52, 0.20, 0)
  ]);
}

function marketSolidGeo() {
  const parts = [plazaGeo()];
  const r = rng(7717);

  parts.push(place(MKT.tradingHouse(), -2.20, 0, 0));

  // Stall local +Z is the counter front, so -a - PI/2 turns it to face the
  // middle of the plaza from anywhere on the ring.
  for (const s of STALLS) {
    parts.push(place(MKT.stall(s.kind, s.kind + 3),
      Math.cos(s.a) * STALL_R, 0, Math.sin(s.a) * STALL_R, 0, -s.a - Math.PI / 2, 0));
  }

  parts.push(place(MKT.plazaWell(), 2.45, 0, 2.35));
  for (const a of [-0.35, 0.95]) {
    parts.push(place(benchGeo(), 2.45 + Math.cos(a) * 1.85, 0, 2.35 + Math.sin(a) * 1.85, 0, -a + Math.PI / 2, 0));
  }

  parts.push(place(gateGeo(), PLAZA_R + 0.55, -0.20, 0));

  // palms in the gaps between the stalls
  for (const a of [1.20, 2.00, -1.20, -2.00]) {
    parts.push(place(palmTree(4.1 + (a > 0 ? 0.3 : 0), Math.round(Math.abs(a) * 7)),
      Math.cos(a) * 5.90, -0.05, Math.sin(a) * 5.90, 0, a * 1.7, 0));
  }

  // cargo waiting to be traded, kept in two tidy heaps
  parts.push(place(MKT.goodsPile(11), Math.cos(1.20) * 4.25, 0, Math.sin(1.20) * 4.25, 0, 0.6, 0));
  parts.push(place(MKT.goodsPile(29), Math.cos(-1.98) * 4.20, 0, Math.sin(-1.98) * 4.20, 0, -1.1, 0));

  // pack camels tied to the gate rail
  parts.push(place(MKT.packCamel(11), 5.05, 0, -2.55, 0, 1.9, 0, 0.94));
  parts.push(place(MKT.packCamel(23), 5.35, 0, -1.35, 0, 2.3, 0, 0.88));
  parts.push(place(merge([
    place(cyl(0.09, 0.11, 1.10, 5, MK.timber), -1.05, 0.55, 0),
    place(cyl(0.09, 0.11, 1.10, 5, MK.timber), 1.05, 0.55, 0),
    place(box(2.30, 0.10, 0.10, MK.timberLo), 0, 1.02, 0)
  ]), 4.35, 0, -2.05, 0, 1.25, 0));

  // laden hand cart parked by the timber stall
  parts.push(place(merge([
    place(gradient(new THREE.BoxGeometry(1.50, 0.48, 1.00), 0x7a5732, 0xa9793f), 0, 0.64, 0),
    place(box(1.56, 0.10, 0.10, PAL.woodDark), 0, 0.90, 0.48),
    place(box(1.56, 0.10, 0.10, PAL.woodDark), 0, 0.90, -0.48),
    place(gradient(new THREE.CylinderGeometry(0.42, 0.42, 0.13, 7), 0x4a3a24, 0x8a6338), -0.34, 0.42, 0.57, Math.PI / 2, 0, 0),
    place(gradient(new THREE.CylinderGeometry(0.42, 0.42, 0.13, 7), 0x4a3a24, 0x8a6338), -0.34, 0.42, -0.57, Math.PI / 2, 0, 0),
    place(box(1.30, 0.10, 0.10, 0x6b4526), 1.06, 0.58, 0.31, 0, 0, 0.14),
    place(box(1.30, 0.10, 0.10, 0x6b4526), 1.06, 0.58, -0.31, 0, 0, 0.14),
    place(crate(0.52), -0.14, 0.88, 0, 0, 0.4, 0),
    place(box(0.52, 0.32, 0.44, MK.tile, 0.12), 0.46, 1.04, 0.06)
  ]), 3.55, 0, 3.55, 0, -0.95, 0));

  // braziers flanking the trading-house steps
  for (const z of [2.35, -2.35]) {
    parts.push(place(merge([
      place(gradient(new THREE.CylinderGeometry(0.36, 0.24, 0.36, 6), 0x4a4038, 0x776a5c), 0, 0.96, 0),
      place(tint(new THREE.BoxGeometry(0.10, 1.00, 0.10), 0x4a4038), 0, 0.50, 0),
      place(cone(0.29, 0.56, 5, 0xffa03a, 0.14), 0, 1.36, 0)
    ]), 0.95, 0, z));
  }

  // banner poles — the pennants themselves belong to the cloth mesh
  for (const a of [0.38, -0.38, 1.92, -1.92]) {
    parts.push(place(cyl(0.07, 0.11, 5.10, 5, MK.timber, false, 0.04),
      Math.cos(a) * (PLAZA_R - 0.55), 2.55, Math.sin(a) * (PLAZA_R - 0.55)));
    parts.push(place(tint(new THREE.OctahedronGeometry(0.13, 0), MK.gold, 0.06),
      Math.cos(a) * (PLAZA_R - 0.55), 5.16, Math.sin(a) * (PLAZA_R - 0.55)));
  }

  // rolled carpets propped against the cloth stall
  for (let k = 0; k < 3; k++) {
    parts.push(place(gradient(new THREE.CylinderGeometry(0.13, 0.15, 1.35, 6),
      [0xb8452f, 0x2f6b8b, 0xc98a2c][k], 0x5a2a18),
      3.05 + k * 0.28, 0.74, -3.95 + k * 0.1, 0, 0.2, 0.32 + k * 0.05));
  }
  // a couple of loose crates by the well
  parts.push(place(crate(0.54), 0.95, 0, 3.95, 0, r() * 2, 0));
  parts.push(place(crate(0.42), 1.45, 0, 4.28, 0, r() * 2, 0));

  return merge(parts);
}

function marketClothGeo() {
  const parts = [];

  // stall awnings, angled forward over each counter
  STALLS.forEach((s, i) => {
    const c = AWNING[i % AWNING.length];
    const ry = -s.a - Math.PI / 2;
    const g = MKT.stripedAwning(2.24, 1.52, c[0], c[1]);
    place(g, 0, 2.24, 0.62, -0.98, 0, 0);
    place(g, Math.cos(s.a) * STALL_R, 0, Math.sin(s.a) * STALL_R, 0, ry, 0);
    parts.push(g);
    const v = MKT.valance(2.24, 0.36, c[0], c[1]);
    place(v, 0, 1.80, 1.24, -0.20, 0, 0);
    place(v, Math.cos(s.a) * STALL_R, 0, Math.sin(s.a) * STALL_R, 0, ry, 0);
    parts.push(v);
  });

  // pennants on the four poles
  for (const a of [0.38, -0.38, 1.92, -1.92]) {
    const f = cloth(1.15, 0.78, 0xffd45a, 0xd98b2b, 0.12, 3);
    place(f, 0.60, 4.66, 0);
    place(f, Math.cos(a) * (PLAZA_R - 0.55), 0, Math.sin(a) * (PLAZA_R - 0.55), 0, -a, 0);
    parts.push(f);
  }

  // twin pennants on the trading-house mast
  for (const s of [1, -1]) {
    const f = cloth(0.62, 1.35, s > 0 ? 0xc23f2c : 0x2f7fa8, 0xf2e0b4, 0.10, 2);
    place(f, 0, 11.28, s * 0.78);
    place(f, -2.20, 0, 0);
    parts.push(f);
  }

  // bunting strung around the stall ring
  const N = 20;
  for (let i = 0; i < N; i++) {
    const a = (Math.PI * 2 * i) / N + 0.16;
    const sag = Math.abs(Math.sin(a * N * 0.5)) * 0.0;
    const f = cloth(0.30, 0.40, [0xffd45a, 0xc23f2c, 0x3f8a3c, 0x2f7fa8][i % 4], 0xf6efe1, 0.05, 2);
    place(f, Math.cos(a) * (STALL_R + 0.42), 2.62 - Math.abs(Math.sin(i * 1.7)) * 0.18 - sag,
      Math.sin(a) * (STALL_R + 0.42), 0, -a, 0);
    parts.push(f);
  }

  // carpets hung to air off the trading-house balcony
  for (let i = 0; i < 2; i++) {
    const c = cloth(1.05, 1.25, [0xb8452f, 0x2f6b8b][i], 0x53291a, 0.10, 3);
    place(c, 0.36, 2.62, -1.35 + i * 2.60);
    place(c, -2.20, 0, 0);
    parts.push(c);
  }

  return merge(parts);
}

/* --------------------------------------------------------- cloth wind mat */

function windClothMaterial(amount) {
  const m = clothMaterial();
  m.userData.wind = { value: 0 };
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uWind = m.userData.wind;
    sh.uniforms.uAmp = { value: amount };
    sh.vertexShader = 'uniform float uWind;\nuniform float uAmp;\n' + sh.vertexShader;
    sh.vertexShader = sh.vertexShader.replace('#include <begin_vertex>', [
      '#include <begin_vertex>',
      'float ph = uWind * 2.05 + transformed.x * 0.62 + transformed.z * 0.44;',
      '#ifdef USE_INSTANCING',
      '  ph += instanceMatrix[ 3 ].x * 0.21 + instanceMatrix[ 3 ].z * 0.17;',
      '#endif',
      'float amp = uAmp * (0.55 + 0.45 * sin(transformed.y * 1.9));',
      'transformed.x += sin(ph) * amp;',
      'transformed.z += cos(ph * 0.87) * amp * 0.72;',
      'transformed.y += sin(ph * 1.31) * amp * 0.34;'
    ].join('\n'));
  };
  m.customProgramCacheKey = () => 'islandClothWind' + amount;
  return m;
}

/* ================================================================= market */

/** Where the crowd wants to be: stall fronts, the well, and the house door. */
function crowdSpots() {
  const spots = [];
  // facing = -a turns a villager's local +X out along the radius, i.e. toward
  // the stall they have stopped in front of.
  for (const s of STALLS) {
    spots.push([Math.cos(s.a) * (STALL_R - 1.45), Math.sin(s.a) * (STALL_R - 1.45), -s.a]);
  }
  spots.push([1.15, 2.30, 2.2], [1.30, -0.05, Math.PI], [3.30, 1.10, 3.0], [3.10, -1.65, 2.6]);
  return spots;
}

export function buildMarket(scene) {
  const group = new THREE.Group();
  group.name = 'market';
  if (scene) scene.add(group);

  // The plaza is deliberately flattened by terrain.js; sit on its high point.
  let baseY = heightAt(MARKET.x, MARKET.z);
  for (let i = 0; i < 24; i++) {
    const a = (Math.PI * 2 * i) / 24;
    for (const rr of [2.6, 4.6, 6.4]) {
      const h = heightAt(MARKET.x + Math.cos(a) * rr, MARKET.z + Math.sin(a) * rr);
      if (h > baseY) baseY = h;
    }
  }
  group.position.set(MARKET.x, baseY, MARKET.z);
  /*
   * Turn the whole plaza so the trading-house frontage, the balcony, the lit
   * doorway and the entrance gate all face into the key light. Built facing
   * +X, the landmark's best side sat in permanent shadow — the sun runs from
   * (-0.82, +0.58) in the XZ plane, so -atan2(0.58, -0.82) points the front
   * straight at it.
   */
  group.rotation.y = -Math.atan2(0.58, -0.82);

  const solid = glowSolidMaterial();
  const clothMat = windClothMaterial(0.070);

  const gSolid = marketSolidGeo();
  const gCloth = marketClothGeo();
  const gBeacon = MKT.beaconQuad(4.3);
  const gFolk = villagerGeo(true);
  const beaconTex = MKT.beaconTexture();

  const solidMesh = new THREE.Mesh(gSolid, solid);
  solidMesh.castShadow = true;
  solidMesh.receiveShadow = true;
  group.add(solidMesh);

  const clothMesh = new THREE.Mesh(gCloth, clothMat);
  clothMesh.castShadow = true;
  group.add(clothMesh);

  /*
   * The beacon is a single tone-mapped billboard, not a light shaft.
   *
   * An earlier version drew a 3.4-unit additive cone with depthWrite off, which
   * painted a hard wedge of pure 255,255,255 over the terrain and flared off the
   * top of every screenshot. Nothing here is additive and nothing is authored
   * above #f2e0b4, so the banner rolls off through ACES like the rest of the
   * frame instead of clipping.
   */
  const beaconMat = MKT.beaconMaterial(beaconTex);
  const beacon = new THREE.Mesh(gBeacon, beaconMat);
  beacon.position.set(-2.20, 14.3, 0);
  beacon.renderOrder = 5;
  beacon.frustumCulled = false;
  group.add(beacon);

  const CROWD = 12;
  const crowd = instanced(gFolk, solid, CROWD, true, false);
  crowd.instanceColor =
    new THREE.InstancedBufferAttribute(new Float32Array(CROWD * 3).fill(1), 3);
  group.add(crowd);

  const TONES = [0xd0472f, 0x3b7fd4, 0x3f9a52, 0x8552c4, 0xe0c27a, 0xdfe4ea];
  const SPOTS = crowdSpots();
  const folk = [];
  const r = rng(90210);
  for (let i = 0; i < CROWD; i++) {
    const s = SPOTS[i % SPOTS.length];
    const a = (Math.PI * 2 * i) / CROWD + 0.3;
    const rr = 1.9 + r() * 1.7;
    folk.push({
      x: s[0] + (r() - 0.5) * 0.8, z: s[1] + (r() - 0.5) * 0.8,
      tx: Math.cos(a) * rr, tz: Math.sin(a) * rr,
      ry: s[2], face: s[2], wait: r() * 3.0, phase: r() * 6.28,
      speed: 0.72 + r() * 0.6, scale: 0.94 + r() * 0.22
    });
    _c.set(TONES[i % TONES.length]).lerp(new THREE.Color(0xffffff), 0.28);
    crowd.instanceColor.setXYZ(i, _c.r, _c.g, _c.b);
  }
  crowd.instanceColor.needsUpdate = true;

  let t = 0;

  function update(dt) {
    if (!(dt > 0)) dt = 0;
    t += dt;
    clothMat.userData.wind.value = t;

    beacon.position.y = 14.3 + Math.sin(t * 0.72) * 0.28;
    beaconMat.opacity = 0.88 + Math.sin(t * 1.55) * 0.10;
    const bs = 1 + Math.sin(t * 1.55) * 0.035;
    beacon.scale.set(bs, bs, bs);

    for (let i = 0; i < folk.length; i++) {
      const f = folk[i];
      f.phase += dt * 3.6;
      let moving = false;
      if (f.wait > 0) {
        f.wait -= dt;
        // turn to face whatever they stopped at
        let diff = f.face - f.ry;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        f.ry += diff * Math.min(1, dt * 4);
      } else {
        const dx = f.tx - f.x, dz = f.tz - f.z;
        const d = Math.hypot(dx, dz);
        if (d < 0.16) {
          const s = SPOTS[(Math.random() * SPOTS.length) | 0];
          f.tx = s[0] + (Math.random() - 0.5) * 1.1;
          f.tz = s[1] + (Math.random() - 0.5) * 1.1;
          f.face = s[2] + (Math.random() - 0.5) * 0.5;
          f.wait = 0.9 + Math.random() * 3.4;
        } else {
          moving = true;
          const k = Math.min(1, (dt * f.speed) / d);
          f.x += dx * k; f.z += dz * k;
          const want = Math.atan2(-dz, dx);
          let diff = want - f.ry;
          while (diff > Math.PI) diff -= Math.PI * 2;
          while (diff < -Math.PI) diff += Math.PI * 2;
          f.ry += diff * Math.min(1, dt * 6);
        }
      }
      // walking bob, or a slow gesture while haggling at a stall
      const bob = moving ? Math.abs(Math.sin(f.phase)) * 0.09 : Math.sin(f.phase * 0.5) * 0.03;
      const lean = moving ? Math.sin(f.phase) * 0.13 : Math.sin(f.phase * 0.9) * 0.09;
      setInstance(crowd, i, f.x, 0.03 + bob, f.z, f.ry, f.scale, f.scale, 0, lean);
    }
    crowd.instanceMatrix.needsUpdate = true;
  }

  update(0);

  const triangles = triCount(gSolid) + triCount(gCloth) + 2 + CROWD * triCount(gFolk);

  return {
    group, solidMesh, clothMesh, beacon, crowd,
    baseY, triangles, drawCalls: 4,
    update,
    dispose() {
      gSolid.dispose(); gCloth.dispose(); gBeacon.dispose(); gFolk.dispose();
      solid.dispose(); clothMat.dispose(); beaconMat.dispose(); beaconTex.dispose();
    }
  };
}

/* ================================================================== ports */

/** Where the ship sits along the dock, in port-local X. */
const DOCK_MID = P.DOCK_TO - 2.4;

/**
 * Walk seaward from the coastal edge midpoint until the ground drops to the
 * waterline, then stand the shore station just past it so the platform is
 * partly over the shallows — exactly where a working harbour sits. The deck
 * height is then derived from the highest ground under the station, so no port
 * ever buries itself in the cliff or hangs over the sand.
 */
export function shoreAnchor(port) {
  const e = edges[port.edge];
  const dx = Math.cos(port.bearing), dz = Math.sin(port.bearing);
  let water = null;
  for (let d = 1.0; d <= 18; d += 0.2) {
    if (heightAt(e.x + dx * d, e.z + dz * d) <= 0.06) { water = d; break; }
  }
  if (water === null) water = 8.0;
  const d = water + 0.9;
  const x = e.x + dx * d, z = e.z + dz * d;
  let hi = -Infinity, lo = Infinity;
  for (let lx = -3.5; lx <= 0.4; lx += 0.35) {
    for (let lz = -1.9; lz <= 1.9; lz += 0.95) {
      const h = heightAt(x + lx * dx - lz * dz, z + lx * dz + lz * dx);
      if (h > hi) hi = h;
      if (h < lo) lo = h;
    }
  }
  const y = Math.min(Math.max(hi - 0.08, 0.26), 1.30);
  return { x, z, y, d, ground: heightAt(x, z), hi, lo };
}

export function buildPorts(scene, state) {
  const group = new THREE.Group();
  group.name = 'ports';
  if (scene) scene.add(group);

  const solid = glowSolidMaterial();
  // Sails, banners and gulls all share one two-sided material. The ship no
  // longer runs the wind vertex shader: it made the hull ripple like a rag.
  const clothMat = clothMaterial();

  const gBase = P.portBaseGeo();
  const gShip = P.portShipGeo();
  const gFlag = P.portFlagGeo();
  const gGull = P.seagullGeo();
  const gFolk = villagerGeo(false);

  const N = ports.length;
  const CREW = 3, GULLS = 2;

  const base = instanced(gBase, solid, N, true, true);
  const ship = instanced(gShip, clothMat, N, true, false);
  const flag = instanced(gFlag, clothMat, N, false, false);
  const crew = instanced(gFolk, solid, N * CREW, true, false);
  const gulls = instanced(gGull, clothMat, N * GULLS, false, false);
  for (const m of [base, ship, flag, crew, gulls]) group.add(m);

  const white = n => new THREE.InstancedBufferAttribute(new Float32Array(n * 3).fill(1), 3);
  base.instanceColor = white(N);
  ship.instanceColor = white(N);
  flag.instanceColor = white(N);
  crew.instanceColor = white(N * CREW);

  const anchors = ports.map(shoreAnchor);
  const sign = P.buildSignMesh(ports, anchors);
  group.add(sign.mesh);

  // Instance colour multiplies the baked vertex colour, so it can only ever
  // darken. A hard grey turned every shaded coastline into a black smear —
  // these are pale enough to read as weathered timber, not as a silhouette.
  const LOCKED = new THREE.Color(0x8d98a6);
  const WEATHERED = new THREE.Color(0x8d98a6);
  const LIT = new THREE.Color(0xffffff);

  const recs = ports.map((p, i) => {
    const a = anchors[i];
    const cb = Math.cos(p.bearing), sb = Math.sin(p.bearing);
    const toWorld = (lx, lz) => ({ x: a.x + lx * cb - lz * sb, z: a.z + lx * sb + lz * cb });
    const r = rng(1000 + i * 77);
    const crewList = [];
    for (let k = 0; k < CREW; k++) {
      const lx = -2.4 + k * 2.4, lz = (k % 2 ? 0.85 : -0.80);
      const w = toWorld(lx, lz);
      crewList.push({
        slot: i * CREW + k, lx, lz, tlx: lx, tlz: lz,
        x: w.x, z: w.z, ry: -p.bearing, wait: r() * 2, phase: r() * 6.28,
        speed: 0.6 + r() * 0.4
      });
      _c.set([0xe0d3b8, 0xcf9b62, 0xa8bcd0][k % 3]);
      crew.instanceColor.setXYZ(i * CREW + k, _c.r, _c.g, _c.b);
    }
    return {
      port: p, i, x: a.x, z: a.z, y: a.y, ry: -p.bearing, cb, sb, toWorld,
      lit: 0, want: 0, owner: -1, crew: crewList,
      bob: r() * 6.28, gull: r() * 6.28
    };
  });
  crew.instanceColor.needsUpdate = true;

  function writeStatic(rec) {
    setInstance(base, rec.i, rec.x, rec.y, rec.z, rec.ry, 1, 1);
    // owner banner off the warehouse gable — grows in as the port lights up
    const f = rec.toWorld(-2.60, 0);
    setInstance(flag, rec.i, f.x, rec.y + P.DECK_Y + 2.52, f.z, rec.ry, 1, Math.max(0.02, rec.lit));
    _c.copy(LOCKED).lerp(LIT, rec.lit);
    base.instanceColor.setXYZ(rec.i, _c.r, _c.g, _c.b);
    _c.copy(WEATHERED).lerp(LIT, rec.lit);
    ship.instanceColor.setXYZ(rec.i, _c.r, _c.g, _c.b);
    for (let v = 0; v < 4; v++) {
      sign.colors.setXYZ(rec.i * 4 + v,
        0.46 + 0.54 * rec.lit, 0.49 + 0.51 * rec.lit, 0.54 + 0.46 * rec.lit);
    }
    if (rec.owner >= 0) {
      const pc = PLAYER_COLORS[((rec.owner | 0) % PLAYER_COLORS.length + PLAYER_COLORS.length) % PLAYER_COLORS.length];
      _c.set(pc ? pc.hex : 0xffffff);
      flag.instanceColor.setXYZ(rec.i, _c.r, _c.g, _c.b);
    }
  }

  function markDirty() {
    base.instanceColor.needsUpdate = true;
    ship.instanceColor.needsUpdate = true;
    flag.instanceColor.needsUpdate = true;
    sign.colors.needsUpdate = true;
  }

  for (const rec of recs) writeStatic(rec);
  markDirty();

  function setUnlocked(portId, pid) {
    const rec = recs[portId];
    if (!rec) return;
    rec.want = 1;
    rec.owner = pid ?? 0;
    writeStatic(rec);
    markDirty();
  }

  // Pick up any ports the match already considers unlocked.
  if (state && state.players) {
    for (const p of state.players) {
      if (p.ports) {
        for (const id of p.ports) {
          const rr = recs[id];
          if (rr) { rr.want = 1; rr.lit = 1; rr.owner = p.id; writeStatic(rr); }
        }
      }
    }
    markDirty();
  }

  let t = 0;

  function update(dt) {
    if (!(dt > 0)) dt = 0;
    t += dt;

    let dirty = false;
    for (const rec of recs) {
      if (Math.abs(rec.lit - rec.want) > 0.001) {
        rec.lit += (rec.want - rec.lit) * Math.min(1, dt * 3.2);
        writeStatic(rec);
        dirty = true;
      }
      const active = rec.lit > 0.55;

      /*
       * A derelict berth has no ship in it.
       *
       * Greying the hull was not enough: multiplying warm timber by a cool
       * grey only ever nudges the colour, so a locked port and a working one
       * looked near identical in a screenshot. Removing the ship changes the
       * silhouette, which is what actually reads at a glance — and sailing one
       * in is a decent reward for claiming the dock.
       */
      const b = t * 1.15 + rec.bob;
      const sw = active ? 1 : 0;
      const sc = rec.lit < 0.10 ? 0 : 0.82 + 0.18 * rec.lit;
      const s = rec.toWorld(DOCK_MID, P.DOCK_W / 2 + 2.05);
      setInstance(ship, rec.i, s.x, 0.68 + Math.sin(b) * 0.14 * sw, s.z, rec.ry, sc, sc,
        Math.sin(b * 0.8) * 0.05 * sw, Math.cos(b * 1.1) * 0.07 * sw);

      // dock workers — off shift entirely while the port is derelict
      for (const c of rec.crew) {
        if (!active) { hideInstance(crew, c.slot); continue; }
        c.phase += dt * 3.4;
        if (c.wait > 0) c.wait -= dt;
        else {
          const dx = c.tlx - c.lx, dz = c.tlz - c.lz;
          const d = Math.hypot(dx, dz);
          if (d < 0.12) {
            c.tlx = -3.0 + Math.random() * 9.2;
            c.tlz = (Math.random() - 0.5) * 1.7;
            c.wait = 0.4 + Math.random() * 1.8;
          } else {
            const k = Math.min(1, (dt * c.speed) / d);
            c.lx += dx * k; c.lz += dz * k;
          }
        }
        const w = rec.toWorld(c.lx, c.lz);
        const moving = c.wait <= 0;
        const bob = moving ? Math.abs(Math.sin(c.phase)) * 0.07 : 0;
        setInstance(crew, c.slot, w.x, rec.y + P.DECK_Y + bob, w.z,
          rec.ry + (moving ? 0 : 0.5), 1, 1, 0, moving ? Math.sin(c.phase) * 0.12 : 0);
      }

      // gulls only wheel over a working harbour
      for (let k = 0; k < GULLS; k++) {
        if (!active) { hideInstance(gulls, rec.i * GULLS + k); continue; }
        const a = t * (0.66 + k * 0.2) + rec.gull + k * 2.6;
        const rr = 3.4 + k * 1.4;
        const w = rec.toWorld(DOCK_MID + Math.cos(a) * rr, Math.sin(a) * rr * 0.7);
        setInstance(gulls, rec.i * GULLS + k, w.x,
          rec.y + 4.1 + k * 0.8 + Math.sin(a * 1.7) * 0.32, w.z,
          rec.ry - a - Math.PI / 2, 0.82, 0.82, 0, Math.sin(a * 3.1) * 0.45);
      }
    }
    if (dirty) {
      markDirty();
      flag.instanceMatrix.needsUpdate = true;
      base.instanceMatrix.needsUpdate = true;
    }
    ship.instanceMatrix.needsUpdate = true;
    crew.instanceMatrix.needsUpdate = true;
    gulls.instanceMatrix.needsUpdate = true;
  }

  update(0);

  const triangles = N * (triCount(gBase) + triCount(gShip) + triCount(gFlag))
    + N * CREW * triCount(gFolk) + N * GULLS * triCount(gGull) + N * 2;

  return {
    group, anchors, meshes: { base, ship, flag, crew, gulls, sign: sign.mesh },
    triangles, drawCalls: 6,
    update, setUnlocked,
    dispose() {
      for (const g of [gBase, gShip, gFlag, gGull, gFolk, sign.geometry]) g.dispose();
      solid.dispose(); clothMat.dispose();
      sign.material.dispose(); sign.atlas.texture.dispose();
    }
  };
}

export default { buildMarket, buildPorts };
