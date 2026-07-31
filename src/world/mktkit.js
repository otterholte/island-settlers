/**
 * Island Settlers — the Great Market kit.
 *
 * Every piece of the island's centrepiece lives here so `market.js` stays a
 * thin assembly + runtime file. Local space: origin on the plaza floor, +Y up,
 * the trading house sits on -X and faces +X, which is also the approach.
 *
 * Everything returns vertex-coloured, indexed BufferGeometry that the caller
 * merges into exactly three meshes (solid / cloth / beacon) plus one instanced
 * crowd, so the whole landmark costs four draw calls.
 */

import * as THREE from 'three';
import { merge, place, tint, gradient, box, cyl, cone, ball, cards } from './geo.js';
import { canvasTexture } from './paint.js';
import { PAL, prism, decal, cloth, crate, barrel, sack, palmTree, stripePanel, rng } from './buildkit.js';

/* ------------------------------------------------------------------ palette */

export const MK = {
  stoneWarm: 0xc9b48c,
  stoneDeep: 0x9c8459,
  paveHi:    0xe3d2ae,
  paveLo:    0xbda882,
  plaster:   0xf0dcae,
  plasterLo: 0xc5a877,
  timber:    0x7a5230,
  timberLo:  0x5a3a1e,
  tile:      0xc0562f,
  tileLo:    0x8e3a1f,
  tileHi:    0xdd7a4a,
  // low blue + saturated red: the key `glowSolidMaterial` self-lights.
  glow:      0xffc866,
  glowDeep:  0xdfae70,
  gold:      0xe8b53c,
  goldDeep:  0xa87a1e
};

/* --------------------------------------------------------------- structures */

/**
 * True hip roof: a ridge of length `ridge` running along X, hipped down to
 * all four eaves. Six triangles, no underside.
 */
export function hipRoof(w, h, d, ridge, low, high) {
  const hw = w / 2, hd = d / 2, hr = Math.max(0.001, ridge / 2);
  const g = new THREE.BufferGeometry();
  const A = [-hw, 0, -hd], B = [hw, 0, -hd], C = [hw, 0, hd], D = [-hw, 0, hd];
  const R0 = [-hr, h, 0], R1 = [hr, h, 0];
  const pos = [];
  const tri = (a, b, c) => pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  tri(D, C, R1); tri(D, R1, R0);   // +Z slope
  tri(B, A, R0); tri(B, R0, R1);   // -Z slope
  tri(C, B, R1);                   // +X hip
  tri(A, D, R0);                   // -X hip
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.computeVertexNormals();
  return gradient(g, low, high);
}

/** Eaves + ridge trim that makes a roof read as tiled rather than as a wedge. */
function roofTrim(w, d, ridge, y) {
  return merge([
    place(box(w * 1.03, 0.13, d * 1.03, MK.tileHi, 0.05), 0, y + 0.05, 0),
    place(box(ridge + 0.34, 0.15, 0.22, MK.tileLo), 0, y, 0)
  ]);
}

/**
 * Shuttered window: dark reveal, warm lit pane, leaded mullions, and a painted
 * shutter each side. The mullions matter — without them a lit pane is just a
 * flat yellow rectangle stuck on a wall.
 */
function window3(w, h, sx, shutterCol = 0x3d6a86) {
  const f = 0.09 * sx, m = 0.115 * sx;
  return merge([
    place(box(0.13, h + 0.18, w + 0.18, MK.timberLo), 0, 0, 0),
    place(decal(w, h, MK.glow), f, 0, 0, 0, sx > 0 ? Math.PI / 2 : -Math.PI / 2, 0),
    place(box(0.05, h + 0.02, 0.05, 0x4a3520), m, 0, 0),
    place(box(0.05, 0.05, w + 0.02, 0x4a3520), m, 0, 0),
    place(box(0.09, h + 0.14, w * 0.50, shutterCol, 0.07), 0.10 * sx, 0, w * 0.79),
    place(box(0.09, h + 0.14, w * 0.50, shutterCol, 0.07), 0.10 * sx, 0, -w * 0.79),
    place(box(0.11, 0.06, w * 0.50, 0x2c4b60), 0.11 * sx, h * 0.22, w * 0.79),
    place(box(0.11, 0.06, w * 0.50, 0x2c4b60), 0.11 * sx, h * 0.22, -w * 0.79)
  ]);
}

/** Turned balustrade running along local Z. */
function railing(len, h, posts) {
  const parts = [
    place(box(0.11, 0.10, len, MK.timber), 0, h, 0),
    place(box(0.09, 0.07, len, MK.timberLo), 0, h * 0.45, 0)
  ];
  for (let i = 0; i < posts; i++) {
    const z = -len / 2 + (len / (posts - 1)) * i;
    parts.push(place(cyl(0.05, 0.065, h, 4, MK.timber, false, 0.05), 0, h / 2, z));
  }
  return merge(parts);
}

/**
 * The trading house: stone plinth, arcaded ground floor, jettied first floor
 * with a running balcony, tiled hip roof, dormer, open bell cupola and the
 * banner mast that carries the beacon. ~9.2 units to the finial.
 */
export function tradingHouse() {
  const W = 3.7, D = 4.3;          // ground floor: W along X, D along Z
  const W2 = W + 0.42, D2 = D + 0.42;
  const parts = [];

  // plinth + entrance steps on +X
  parts.push(place(gradient(new THREE.BoxGeometry(W + 0.6, 0.44, D + 0.6), MK.stoneDeep, MK.stoneWarm), 0, 0.22, 0));
  for (let i = 0; i < 3; i++) {
    parts.push(place(gradient(new THREE.BoxGeometry(0.36, 0.16, 2.5 - i * 0.28), MK.stoneDeep, MK.paveHi),
      W / 2 + 0.46 + i * 0.36, 0.36 - i * 0.155, 0));
  }

  // ground floor
  parts.push(place(gradient(new THREE.BoxGeometry(W, 2.12, D), MK.plasterLo, MK.plaster), 0, 1.50, 0));
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      parts.push(place(tint(new THREE.BoxGeometry(0.26, 2.14, 0.26), MK.timber, 0.05),
        sx * (W / 2 - 0.07), 1.50, sz * (D / 2 - 0.07)));
    }
  }
  // arcade posts across the frontage
  for (const z of [-1.42, 1.42]) {
    parts.push(place(tint(new THREE.BoxGeometry(0.22, 2.14, 0.22), MK.timber, 0.05), W / 2 - 0.07, 1.50, z));
  }

  // doorway: dark reveal, warm interior, and enough joinery across it that the
  // light reads as a room behind a door rather than as a blank cream panel
  parts.push(place(box(0.16, 1.78, 1.72, MK.timberLo, 0.05), W / 2 + 0.03, 1.33, 0));
  parts.push(place(decal(1.20, 1.42, MK.glow), W / 2 + 0.12, 1.26, 0, 0, Math.PI / 2, 0));
  for (const z of [-0.42, 0.42]) {
    parts.push(place(box(0.07, 1.44, 0.10, 0x4a3520), W / 2 + 0.15, 1.26, z));
  }
  parts.push(place(box(0.07, 0.10, 1.24, 0x4a3520), W / 2 + 0.15, 1.62, 0));
  parts.push(place(box(0.34, 0.12, 1.86, MK.timber), W / 2 + 0.12, 0.50, 0));
  parts.push(place(box(0.30, 0.16, 1.90, MK.timber), W / 2 + 0.14, 2.26, 0));
  // hanging shop sign over the threshold
  parts.push(place(box(0.52, 0.09, 0.09, MK.timberLo), W / 2 + 0.32, 2.14, 0.86));
  parts.push(place(box(0.05, 0.22, 0.05, PAL.rope), W / 2 + 0.52, 1.96, 0.86));
  parts.push(place(gradient(new THREE.BoxGeometry(0.07, 0.46, 0.62), MK.goldDeep, MK.gold),
    W / 2 + 0.52, 1.62, 0.86));
  // light spilling onto the paving
  parts.push(place(tint(new THREE.PlaneGeometry(2.30, 1.90), MK.glowDeep, 0.04),
    W / 2 + 1.35, 0.03, 0, -Math.PI / 2, 0, 0));

  // ground-floor windows
  parts.push(place(window3(0.62, 0.66, 1), W / 2 + 0.02, 1.62, -1.62));
  parts.push(place(window3(0.62, 0.66, 1), W / 2 + 0.02, 1.62, 1.62));
  parts.push(place(window3(0.62, 0.66, -1), -W / 2 - 0.02, 1.62, -1.10));
  parts.push(place(window3(0.62, 0.66, -1), -W / 2 - 0.02, 1.62, 1.10));

  // jetty band + first floor
  parts.push(place(gradient(new THREE.BoxGeometry(W2 + 0.16, 0.26, D2 + 0.16), 0x6f4a29, 0x9a6c3c), 0, 2.69, 0));
  parts.push(place(gradient(new THREE.BoxGeometry(W2, 1.74, D2), MK.plasterLo, MK.plaster), 0, 3.69, 0));
  // half-timbering
  for (const sz of [-1, 1]) {
    parts.push(place(tint(new THREE.BoxGeometry(W2 + 0.03, 0.16, 0.16), MK.timber), 0, 4.42, sz * (D2 / 2)));
    parts.push(place(tint(new THREE.BoxGeometry(W2 + 0.03, 0.14, 0.14), MK.timber), 0, 3.44, sz * (D2 / 2)));
  }
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      parts.push(place(tint(new THREE.BoxGeometry(0.20, 1.76, 0.20), MK.timber, 0.05),
        sx * (W2 / 2 - 0.05), 3.69, sz * (D2 / 2 - 0.05)));
    }
  }
  // upper windows
  parts.push(place(window3(0.54, 0.62, 1), W2 / 2 + 0.02, 3.78, 0));
  parts.push(place(window3(0.54, 0.62, 1), W2 / 2 + 0.02, 3.78, -1.52));
  parts.push(place(window3(0.54, 0.62, 1), W2 / 2 + 0.02, 3.78, 1.52));

  // balcony across the frontage
  const bx = W2 / 2 + 0.52;
  parts.push(place(gradient(new THREE.BoxGeometry(1.16, 0.16, D2 + 0.5), 0x6f4a29, 0xa9793f), bx, 2.86, 0));
  parts.push(place(railing(D2 + 0.5, 0.68, 7), bx + 0.50, 2.94, 0));
  for (const z of [-1.7, 0, 1.7]) {
    parts.push(place(tint(new THREE.BoxGeometry(0.72, 0.14, 0.14), MK.timber), bx - 0.10, 2.55, z, 0, 0, 0.55));
  }

  // roof
  parts.push(place(hipRoof(W2 + 1.10, 1.92, D2 + 1.10, 2.10, MK.tileLo, MK.tile), 0, 4.56, 0));
  parts.push(place(roofTrim(W2 + 1.10, D2 + 1.10, 2.10, 4.56), 0, 0, 0));
  parts.push(place(box(2.44, 0.16, 0.24, MK.tileHi), 0, 6.44, 0));
  // dormer looking out over the plaza
  parts.push(place(merge([
    place(gradient(new THREE.BoxGeometry(0.60, 0.72, 0.92), MK.plasterLo, MK.plaster), 0, 0.36, 0),
    place(prism(0.76, 0.36, 1.06, MK.tile, MK.tileLo), 0, 0.72, 0, 0, Math.PI / 2, 0),
    place(decal(0.44, 0.42, MK.glow), 0.31, 0.38, 0, 0, Math.PI / 2, 0)
  ]), 1.34, 5.10, 0));

  // bell cupola
  parts.push(place(gradient(new THREE.BoxGeometry(1.34, 1.00, 1.34), MK.plasterLo, MK.plaster), 0, 6.30, 0));
  parts.push(place(box(1.52, 0.14, 1.52, MK.timber), 0, 6.86, 0));
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      parts.push(place(tint(new THREE.BoxGeometry(0.15, 1.00, 0.15), MK.timber, 0.05),
        sx * 0.55, 7.43, sz * 0.55));
    }
  }
  parts.push(place(gradient(new THREE.CylinderGeometry(0.15, 0.30, 0.42, 6), MK.goldDeep, MK.gold), 0, 7.62, 0));
  parts.push(place(ball(0.10, 0, MK.goldDeep), 0, 7.36, 0));
  parts.push(place(box(1.44, 0.14, 1.44, MK.timberLo), 0, 8.00, 0));
  parts.push(place(cone(1.02, 1.05, 6, MK.tile, 0.05), 0, 8.58, 0));
  parts.push(place(ball(0.20, 0, MK.gold, 0.08), 0, 9.20, 0));

  // banner mast — carries the beacon and the pennants
  parts.push(place(cyl(0.07, 0.10, 3.60, 5, MK.timber, false, 0.04), 0, 11.05, 0));
  parts.push(place(box(0.10, 0.10, 2.30, MK.timberLo), 0, 11.90, 0));
  parts.push(place(ball(0.13, 0, MK.gold), 0, 12.90, 0));
  return merge(parts);
}

/* -------------------------------------------------------------------- goods */

/** Stacked logs — reads as WOOD. */
function goodsWood() {
  const log = (x, y) => place(merge([
    place(gradient(new THREE.CylinderGeometry(0.115, 0.115, 0.60, 6), 0x6a4526, 0x9a6c3c), 0, 0, 0),
    place(cyl(0.10, 0.10, 0.04, 6, 0xd8bb87, true), 0, 0.31, 0)
  ]), x, y, 0, Math.PI / 2, 0, 0);
  return merge([log(-0.13, 0.12), log(0.13, 0.12), log(0, 0.34)]);
}

/** Pallet of bricks — reads as BRICK. */
function goodsBrick() {
  const parts = [place(box(0.72, 0.06, 0.46, MK.timberLo), 0, 0.03, 0)];
  for (let r = 0; r < 2; r++) {
    for (let i = 0; i < 3; i++) {
      parts.push(place(box(0.20, 0.11, 0.38, r ? 0xd0673c : PAL.terra, 0.07),
        -0.23 + i * 0.23 + (r ? 0.05 : 0), 0.12 + r * 0.13, 0));
    }
  }
  return merge(parts);
}

/** Bales and a fleece — reads as WOOL. */
function goodsWool() {
  const bale = (x, z, y) => place(merge([
    place(gradient(new THREE.BoxGeometry(0.34, 0.28, 0.30), 0xdcd6c6, 0xf6f2e8), 0, 0, 0),
    place(box(0.36, 0.05, 0.05, 0x8a6338), 0, 0.02, 0)
  ]), x, y, z);
  return merge([bale(-0.18, 0, 0.15), bale(0.20, 0.02, 0.15), bale(0, -0.02, 0.44)]);
}

/** Grain sacks and a sheaf — reads as WHEAT. */
function goodsWheat() {
  return merge([
    place(sack(0.20, 0xe6d7b4), -0.20, 0.02, 0.04),
    place(sack(0.17, 0xd9c79c), 0.10, 0.02, -0.06),
    place(cards(0.30, 0.52, 2, 0xc99a2c, 0xf0cf62, 0.02), 0.26, 0.06, 0.14, 0, 0.4, 0.10)
  ]);
}

/** Basket of ore — reads as ORE. */
function goodsOre() {
  const parts = [
    place(gradient(new THREE.CylinderGeometry(0.24, 0.19, 0.26, 7), 0x6b4526, 0xa9793f), 0, 0.13, 0),
    place(cyl(0.25, 0.25, 0.05, 7, MK.timberLo, true), 0, 0.27, 0)
  ];
  for (const [x, z, r] of [[-0.09, 0.04, 0.11], [0.08, -0.03, 0.12], [0.01, 0.10, 0.09]]) {
    parts.push(place(tint(new THREE.OctahedronGeometry(r, 0), 0x9aa4b2, 0.14), x, 0.31, z));
  }
  return merge(parts);
}

/** Rolled carpets standing on end — the sixth stall trades cloth. */
function goodsCloth() {
  const parts = [];
  const cols = [0xb8452f, 0x2f6b8b, 0xc98a2c];
  cols.forEach((c, i) => {
    parts.push(place(merge([
      place(gradient(new THREE.CylinderGeometry(0.10, 0.11, 0.66, 6), 0x5a2a18, c), 0, 0, 0),
      place(cyl(0.115, 0.115, 0.06, 6, MK.gold, true), 0, 0.14, 0)
    ]), -0.24 + i * 0.24, 0.34, i % 2 ? 0.05 : -0.05, 0, 0, 0.10 - i * 0.06));
  });
  return merge(parts);
}

const GOODS = [goodsWood, goodsBrick, goodsWool, goodsWheat, goodsOre, goodsCloth];

/**
 * One market stall: plank counter, four posts, a back board, hanging lantern
 * and a load of goods that names the resource it deals in. The striped awning
 * belongs to the cloth mesh and is built separately.
 */
export function stall(kind, seed) {
  const r = rng(seed * 37 + 11);
  const parts = [
    // counter
    place(gradient(new THREE.BoxGeometry(1.94, 0.62, 0.86), 0x6f4a29, 0xa9793f), 0, 0.31, 0.05),
    place(box(2.06, 0.12, 1.00, 0xc9a463, 0.07), 0, 0.68, 0.05),
    place(box(2.06, 0.10, 0.10, MK.timberLo), 0, 0.60, 0.53),
    // posts
    place(tint(new THREE.BoxGeometry(0.13, 2.16, 0.13), MK.timber, 0.05), -0.94, 1.08, 0.46),
    place(tint(new THREE.BoxGeometry(0.13, 2.16, 0.13), MK.timber, 0.05), 0.94, 1.08, 0.46),
    place(tint(new THREE.BoxGeometry(0.13, 1.86, 0.13), MK.timber, 0.05), -0.94, 0.93, -0.52),
    place(tint(new THREE.BoxGeometry(0.13, 1.86, 0.13), MK.timber, 0.05), 0.94, 0.93, -0.52),
    place(box(2.00, 0.11, 0.11, MK.timberLo), 0, 2.10, 0.46),
    place(box(2.00, 0.11, 0.11, MK.timberLo), 0, 1.82, -0.52),
    // back board
    place(gradient(new THREE.BoxGeometry(1.94, 1.10, 0.09), 0x7f5c34, 0xa9793f), 0, 1.34, -0.52),
    // hanging lantern
    place(box(0.05, 0.26, 0.05, 0x3a2e1c), 0.80, 1.96, 0.46),
    place(cyl(0.09, 0.13, 0.22, 5, MK.glow, false, 0.04), 0.80, 1.72, 0.46),
    place(cone(0.15, 0.10, 5, PAL.iron), 0.80, 1.88, 0.46)
  ];
  // goods on the counter + a crate below
  parts.push(place(GOODS[kind % GOODS.length](), -0.30 + r() * 0.16, 0.74, 0.06));
  parts.push(place(GOODS[kind % GOODS.length](), 0.62, 0.74, 0.02, 0, r() * 3, 0, 0.8));
  parts.push(place(crate(0.46), -0.72, 0.02, 0.70, 0, r() * 2, 0));
  return merge(parts);
}

/* ---------------------------------------------------------------- dressing */

/** Plaza well with a shingled canopy and a bucket on a rope. */
export function plazaWell() {
  return merge([
    place(gradient(new THREE.CylinderGeometry(0.86, 0.96, 0.68, 9), MK.stoneDeep, MK.stoneWarm), 0, 0.34, 0),
    place(cyl(0.95, 0.95, 0.12, 9, MK.paveHi, true), 0, 0.72, 0),
    place(tint(new THREE.CircleGeometry(0.78, 9), 0x2f8fa8, 0.06), 0, 0.62, 0, -Math.PI / 2, 0, 0),
    place(tint(new THREE.BoxGeometry(0.14, 1.42, 0.14), MK.timber, 0.05), -0.74, 1.42, 0),
    place(tint(new THREE.BoxGeometry(0.14, 1.42, 0.14), MK.timber, 0.05), 0.74, 1.42, 0),
    place(prism(2.20, 0.52, 1.20, MK.tile, MK.tileLo), 0, 2.12, 0, 0, Math.PI / 2, 0),
    place(cyl(0.09, 0.09, 1.60, 5, MK.timberLo), 0, 2.04, 0, 0, 0, Math.PI / 2),
    place(gradient(new THREE.CylinderGeometry(0.16, 0.19, 0.26, 6), 0x53381d, 0x8a6338), 0.10, 1.52, 0)
  ]);
}

/** Tethered pack camel with a loaded saddle. */
export function packCamel(seed) {
  const r = rng(seed);
  const hide = [0xd9b478, 0xcfa96c, 0xe2c089][seed % 3];
  const leg = (x, z) => place(tint(new THREE.BoxGeometry(0.15, 0.80, 0.15), 0xb8945c, 0.05), x, 0.40, z);
  return merge([
    place(gradient(new THREE.BoxGeometry(1.32, 0.68, 0.62), 0xb8945c, hide), 0, 1.14, 0),
    place(prism(1.06, 0.40, 0.56, hide, 0xb8945c), 0, 1.46, 0, 0, Math.PI / 2, 0),
    place(tint(new THREE.BoxGeometry(0.24, 0.86, 0.24), hide, 0.05), 0.60, 1.62, 0, 0, 0, -0.26),
    place(tint(new THREE.BoxGeometry(0.50, 0.28, 0.28), hide, 0.05), 0.84, 1.98, 0),
    place(box(0.13, 0.11, 0.10, 0x6b4526), 0.62, 2.16, 0.09),
    leg(0.40, 0.22), leg(0.40, -0.22), leg(-0.46, 0.22), leg(-0.46, -0.22),
    place(box(0.60, 0.16, 0.74, 0xb8452f, 0.10), -0.16, 1.50, 0),
    place(crate(0.34), -0.16, 1.56, 0.30, 0, r() * 2, 0),
    place(cyl(0.03, 0.03, 1.10, 4, PAL.rope), 0.86, 1.30, 0, 0, 0, 0.9)
  ]);
}

/** Tidy stack of trade goods: crates, barrels, amphorae. */
export function goodsPile(seed) {
  const r = rng(seed);
  return merge([
    place(crate(0.62), 0, 0, 0, 0, r() * 2, 0),
    place(crate(0.48), 0.10, 0.62, -0.06, 0, r() * 2, 0),
    place(barrel(0.24, 0.50), 0.78, 0, 0.34),
    place(barrel(0.24, 0.50), 0.72, 0, -0.30),
    place(merge([
      place(gradient(new THREE.CylinderGeometry(0.15, 0.21, 0.46, 6), 0x8a5a3a, 0xc08a5c), 0, 0.23, 0),
      place(cyl(0.08, 0.12, 0.18, 5, 0xc08a5c, false, 0.05), 0, 0.54, 0)
    ]), -0.62, 0, 0.42)
  ]);
}

/* ------------------------------------------------------------------- cloth */

/** Striped awning panel, seven bands of flat-shaded canvas. */
export function stripedAwning(w, d, c1, c2, stripes = 7) {
  return stripePanel(w, d, stripes, c1, c2, { bulge: 0.11, rows: 2 });
}

/** Scalloped valance that hangs off the front edge of an awning. */
export function valance(w, h, c1, c2) {
  return stripePanel(w, h, 7, c1, c2, { bulge: 0.03, rows: 1, scallop: 0.45 });
}

/* ------------------------------------------------------------------ beacon */

const FONT = '"Trebuchet MS","Arial Black",Impact,system-ui,sans-serif';

/**
 * The trade beacon: one 256x256 canvas holding a soft warm halo, a gold-framed
 * banner and the five resources it deals in.
 *
 * Authored well below white on purpose. The banner is drawn by an unlit
 * MeshBasicMaterial which still runs ACES tone mapping, so a pure-white plate
 * would clip exactly the way the old additive light shaft did. The brightest
 * ink here is #f2e0b4.
 */
export function beaconTexture() {
  return canvasTexture(256, 256, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    const cx = w / 2;

    // soft halo so the banner never shows a hard cut against the sky
    const halo = g.createRadialGradient(cx, 128, 24, cx, 128, 124);
    halo.addColorStop(0.00, 'rgba(255,214,132,0.42)');
    halo.addColorStop(0.45, 'rgba(255,196,104,0.20)');
    halo.addColorStop(1.00, 'rgba(255,190,96,0)');
    g.fillStyle = halo;
    g.beginPath(); g.arc(cx, 128, 124, 0, Math.PI * 2); g.fill();

    // hanging bar
    g.strokeStyle = '#4a3520'; g.lineWidth = 12; g.lineCap = 'round';
    g.beginPath(); g.moveTo(38, 40); g.lineTo(218, 40); g.stroke();
    g.strokeStyle = '#8a6338'; g.lineWidth = 5;
    g.beginPath(); g.moveTo(38, 36); g.lineTo(218, 36); g.stroke();
    g.strokeStyle = '#6a4526'; g.lineWidth = 5;
    g.beginPath(); g.moveTo(66, 42); g.lineTo(66, 62); g.moveTo(190, 42); g.lineTo(190, 62); g.stroke();

    // banner body: heavy dark frame, cream field, swallow-tail hem
    const shape = (i) => {
      g.beginPath();
      g.moveTo(40 + i, 56 + i); g.lineTo(216 - i, 56 + i); g.lineTo(216 - i, 208 - i);
      g.lineTo(128, 176 - i); g.lineTo(40 + i, 208 - i); g.closePath();
    };
    shape(0); g.fillStyle = '#4a3520'; g.fill();
    shape(9); g.fillStyle = '#d9c69a'; g.fill();
    shape(9); g.lineWidth = 5; g.strokeStyle = '#a8763a'; g.lineJoin = 'round'; g.stroke();

    // the five resources this place deals in, across the top
    const cols = ['#3f7a2e', '#b74d27', '#e4ded0', '#dda824', '#7c8695'];
    cols.forEach((c, i) => {
      g.fillStyle = c;
      g.beginPath(); g.arc(56 + i * 36, 84, 13, 0, Math.PI * 2); g.fill();
      g.lineWidth = 3.5; g.strokeStyle = '#4a3520'; g.stroke();
    });

    // wordmark
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = `900 46px ${FONT}`;
    g.lineJoin = 'round'; g.lineWidth = 13; g.strokeStyle = '#4a3520';
    g.strokeText('TRADE', cx, 128);
    g.fillStyle = '#fff2d2';
    g.fillText('TRADE', cx, 128);

    // exchange arrows along the hem
    g.strokeStyle = '#8e4a22'; g.lineWidth = 10; g.lineCap = 'round';
    g.beginPath(); g.moveTo(84, 158); g.lineTo(170, 158); g.stroke();
    g.beginPath(); g.moveTo(154, 144); g.lineTo(172, 158); g.lineTo(154, 172); g.stroke();
  }, { aniso: 8 });
}

/**
 * A single camera-facing quad for the beacon. Position/normal are written in
 * world space by market.js; `aLocal` carries the corner offsets that the
 * billboard shader expands along the camera right/up axes.
 */
export function beaconQuad(size) {
  const hw = size / 2;
  const g = new THREE.BufferGeometry();
  const corners = [[-hw, -hw, 0, 0], [hw, -hw, 1, 0], [hw, hw, 1, 1], [-hw, hw, 0, 1]];
  const pos = new Float32Array(12);
  const nrm = new Float32Array(12);
  const loc = new Float32Array(8);
  const uv = new Float32Array(8);
  corners.forEach(([lx, ly, u, v], i) => {
    nrm[i * 3 + 2] = 1;
    loc[i * 2] = lx; loc[i * 2 + 1] = ly;
    uv[i * 2] = u; uv[i * 2 + 1] = v;
  });
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('aLocal', new THREE.BufferAttribute(loc, 2));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), size);
  return g;
}

/** Billboard material for the beacon quad. Normal blending, tone mapped. */
export function beaconMaterial(map) {
  const m = new THREE.MeshBasicMaterial({
    map, transparent: true, depthWrite: false, side: THREE.DoubleSide
  });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = 'attribute vec2 aLocal;\n' + sh.vertexShader;
    sh.vertexShader = sh.vertexShader.replace('#include <begin_vertex>', [
      'vec3 anchor = ( modelMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;',
      'vec3 look = cameraPosition - anchor;',
      'look.y = 0.0;',
      'float ll = length( look );',
      'vec3 fwd = ll > 0.0001 ? look / ll : vec3( 0.0, 0.0, 1.0 );',
      'vec3 rgt = normalize( cross( vec3( 0.0, 1.0, 0.0 ), fwd ) );',
      // modelMatrix is a pure translation here, so object space and world
      // space differ only by the anchor: the offset is the same in both.
      'vec3 transformed = rgt * aLocal.x + vec3( 0.0, aLocal.y, 0.0 );'
    ].join('\n'));
  };
  m.customProgramCacheKey = () => 'islandMarketBeacon';
  return m;
}

export { palmTree };
export default { tradingHouse, stall, plazaWell, packCamel, goodsPile, stripedAwning };
