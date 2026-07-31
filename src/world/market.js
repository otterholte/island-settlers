/**
 * Island Settlers — the Great Market and the nine ports.
 *
 *   buildMarket(scene) -> { group, update(dt) }
 *   buildPorts(scene, state) -> { group, update(dt), setUnlocked(portId, pid) }
 *
 * The market is the island's landmark and gets the biggest single geometry
 * budget on the board: a two-storey trading house with a bell tower, eight
 * awninged stalls, a fountain, palms, tethered pack camels, stacked goods and
 * a crowd of merchants milling about, plus a floating trade beacon that can be
 * seen from the far shore. Four draw calls: solid, cloth, beacon, crowd.
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
import { merge, place, tint, gradient, box, cyl, cone, instanced, setInstance, triCount } from './geo.js';
import {
  PAL, prism, decal, cloth, crate, palmTree, villagerGeo,
  solidMaterial, clothMaterial, rng
} from './buildkit.js';
import * as P from './buildport.js';

const _c = new THREE.Color();

/* ======================================================== market geometry */

function tradingHouse() {
  const parts = [
    place(gradient(new THREE.BoxGeometry(3.05, 0.30, 2.65), 0x9b8358, 0xc4ab7a), 0, 0.15, 0),
    place(gradient(new THREE.BoxGeometry(2.70, 1.60, 2.30), 0xd9c69c, PAL.plaster), 0, 1.10, 0),
    place(gradient(new THREE.BoxGeometry(2.50, 1.30, 2.10), 0xe8d8b4, 0xfaeed2), 0, 2.55, 0),
    // balcony
    place(gradient(new THREE.BoxGeometry(3.00, 0.16, 2.60), 0x8a6338, 0xa9793f), 0, 1.96, 0),
    place(box(3.00, 0.30, 0.10, PAL.wood, 0.07), 0, 2.16, 1.28),
    place(box(3.00, 0.30, 0.10, PAL.wood, 0.07), 0, 2.16, -1.28),
    place(box(0.10, 0.30, 2.60, PAL.wood, 0.07), 1.48, 2.16, 0),
    // roof
    place(prism(3.10, 0.95, 2.70, PAL.terra, PAL.terraDark), 0, 3.20, 0),
    place(box(0.24, 0.16, 2.80, 0x8c3a1e), 0, 4.12, 0),
    // openings
    place(decal(0.80, 1.10, 0x5a3a1e), 0, 0.85, 1.16),
    place(decal(0.42, 0.42, 0x5f7c8c), -0.85, 1.35, 1.16),
    place(decal(0.42, 0.42, 0x5f7c8c), 0.85, 1.35, 1.16),
    place(decal(0.46, 0.60, 0x4c6a7a), -0.70, 2.60, 1.06),
    place(decal(0.46, 0.60, 0x4c6a7a), 0.70, 2.60, 1.06),
    // bell tower
    place(gradient(new THREE.BoxGeometry(0.95, 2.00, 0.95), 0xd9c69c, 0xf1e3c3), 0, 4.35, -0.20),
    place(cyl(0.58, 0.58, 0.62, 6, 0xe8d8b4, true), 0, 5.60, -0.20),
    place(box(0.86, 0.10, 0.86, 0x8a6338), 0, 5.30, -0.20),
    place(cone(0.78, 0.85, 6, PAL.terraDark, 0.06), 0, 6.30, -0.20),
    place(tint(new THREE.IcosahedronGeometry(0.24, 0), 0xd9a326, 0.08), 0, 5.55, -0.20),
    place(box(0.12, 0.12, 0.12, 0xffd76a), 0, 6.80, -0.20)
  ];
  return merge(parts);
}

function stall(seed) {
  const r = rng(seed);
  const parts = [
    place(gradient(new THREE.BoxGeometry(1.60, 0.62, 0.72), 0x8a6338, 0xb2854b), 0, 0.31, 0),
    place(box(1.70, 0.10, 0.82, 0xc9a463, 0.08), 0, 0.66, 0),
    place(tint(new THREE.BoxGeometry(0.10, 1.75, 0.10), PAL.wood, 0.06), -0.76, 0.88, -0.32),
    place(tint(new THREE.BoxGeometry(0.10, 1.75, 0.10), PAL.wood, 0.06), 0.76, 0.88, -0.32),
    place(box(1.62, 0.09, 0.09, PAL.woodDark), 0, 1.72, -0.32)
  ];
  const goodsCol = [0xc0562f, 0x4c8b3a, 0xe8b53c, 0x8d97a6, 0xe8e4d8][seed % 5];
  parts.push(place(box(0.42, 0.26, 0.38, goodsCol, 0.16), -0.42 + r() * 0.2, 0.84, 0.04));
  parts.push(place(tint(new THREE.IcosahedronGeometry(0.19, 0), goodsCol, 0.14), 0.36, 0.82, 0.02));
  return merge(parts);
}

function fountain() {
  return merge([
    place(gradient(new THREE.CylinderGeometry(1.35, 1.50, 0.52, 10), 0x8f9aa4, 0xc3ccd4), 0, 0.26, 0),
    place(cyl(1.42, 1.42, 0.14, 10, 0xdfe6ec, true), 0, 0.52, 0),
    place(tint(new THREE.CircleGeometry(1.28, 10), 0x37b3cf, 0.07), 0, 0.44, 0, -Math.PI / 2, 0, 0),
    place(gradient(new THREE.CylinderGeometry(0.24, 0.36, 1.15, 6), 0x9aa5af, 0xd2d9e0), 0, 1.05, 0),
    place(cone(0.62, 0.42, 6, 0xc3ccd4, 0.05), 0, 1.78, 0),
    place(cone(0.16, 0.55, 5, 0x7fdcef, 0.10), 0, 2.20, 0)
  ]);
}

function camel(seed) {
  const r = rng(seed);
  const body = 0xd9b478 + (seed % 3) * 0x060402;
  return merge([
    place(gradient(new THREE.BoxGeometry(1.35, 0.70, 0.62), 0xb8945c, body), 0, 1.05, 0),
    place(prism(1.10, 0.36, 0.56, body, 0xb8945c), 0, 1.38, 0, 0, Math.PI / 2, 0),
    place(tint(new THREE.BoxGeometry(0.26, 0.85, 0.26), body, 0.06), 0.62, 1.55, 0, 0, 0, -0.24),
    place(tint(new THREE.BoxGeometry(0.52, 0.28, 0.28), body, 0.06), 0.86, 1.92, 0),
    place(box(0.14, 0.12, 0.10, 0x6b4526), 0.62, 2.10, 0.10),
    place(tint(new THREE.BoxGeometry(0.14, 0.78, 0.14), 0xb8945c), 0.42, 0.39, 0.24),
    place(tint(new THREE.BoxGeometry(0.14, 0.78, 0.14), 0xb8945c), 0.42, 0.39, -0.24),
    place(tint(new THREE.BoxGeometry(0.14, 0.78, 0.14), 0xb8945c), -0.48, 0.39, 0.24),
    place(tint(new THREE.BoxGeometry(0.14, 0.78, 0.14), 0xb8945c), -0.48, 0.39, -0.24),
    place(box(0.62, 0.14, 0.70, 0xb8452f, 0.12), -0.15, 1.42, 0),
    place(tint(new THREE.BoxGeometry(0.10, 0.42, 0.10), 0x8a6338), -0.72, 1.20, 0, 0, 0, 0.5 + r() * 0.2)
  ]);
}

function marketGoods() {
  const parts = [];
  const r = rng(7717);
  const spots = [
    [3.55, 1.25], [3.95, 0.55], [-3.85, 1.95], [-3.35, 2.45],
    [1.65, 3.75], [-1.35, -3.95], [-2.15, -3.55], [2.85, -3.15]
  ];
  spots.forEach(([x, z], i) => {
    if (i % 3 === 0) {
      parts.push(place(crate(0.62 + r() * 0.12), x, 0.16, z, 0, r() * 2, 0));
      parts.push(place(crate(0.50), x + 0.08, 0.78, z - 0.05, 0, r() * 2, 0));
    } else if (i % 3 === 1) {
      parts.push(place(gradient(new THREE.CylinderGeometry(0.26, 0.30, 0.66, 6), 0x6b4526, PAL.wood),
        x, 0.49, z));
      parts.push(place(tint(new THREE.IcosahedronGeometry(0.30, 0), PAL.canvas, 0.10), x + 0.6, 0.42, z + 0.3));
    } else {
      // rolled carpets leaning on the stalls
      for (let k = 0; k < 3; k++) {
        parts.push(place(gradient(new THREE.CylinderGeometry(0.13, 0.15, 1.30, 6),
          [0xb8452f, 0x2f6b8b, 0xc98a2c][k], 0x5a2a18),
          x + k * 0.30, 0.72, z, 0, 0, 0.30 + k * 0.06));
      }
    }
  });
  return merge(parts);
}

function marketLanterns() {
  const parts = [];
  for (let i = 0; i < 8; i++) {
    const a = (Math.PI * 2 * i) / 8 + 0.4;
    const r = 3.6;
    parts.push(place(cyl(0.13, 0.19, 0.30, 5, 0xffe6a8, true), Math.cos(a) * r, 2.35, Math.sin(a) * r));
    parts.push(place(box(0.24, 0.08, 0.24, 0x4a3a24), Math.cos(a) * r, 2.55, Math.sin(a) * r));
    parts.push(place(box(0.05, 0.34, 0.05, 0x3a2e1c), Math.cos(a) * r, 2.76, Math.sin(a) * r));
  }
  return merge(parts);
}

function marketSolidGeo() {
  const parts = [];
  // plaza slab + paving accents
  parts.push(place(gradient(new THREE.CylinderGeometry(5.20, 5.35, 1.10, 12), 0x9c8459, 0xdcc496), 0, -0.39, 0));
  parts.push(place(tint(new THREE.CircleGeometry(4.55, 12), 0xe4d0a6, 0.05), 0, 0.17, 0, -Math.PI / 2, 0, 0));
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 6) * i;
    parts.push(place(box(9.6, 0.05, 0.28, 0xc9b184, 0.07), 0, 0.19, 0, 0, a, 0));
  }
  parts.push(place(tradingHouse(), -2.70, 0.16, -1.60, 0, 0.62, 0));
  // storehouse across the plaza
  parts.push(place(merge([
    place(gradient(new THREE.BoxGeometry(2.10, 1.25, 1.50), 0x8b6136, 0xa9793f), 0, 0.62, 0),
    place(prism(2.30, 0.62, 1.65, 0x7d5b3a, 0x5f452b), 0, 1.25, 0, 0, Math.PI / 2, 0),
    place(decal(0.70, 0.80, PAL.woodDark), 0, 0.42, 0.76),
    place(box(0.80, 0.08, 0.06, PAL.woodDark), 0, 0.88, 0.79)
  ]), 3.10, 0.16, -2.30, 0, -0.75, 0));
  // stalls ringing the plaza
  for (let i = 0; i < 8; i++) {
    const a = (Math.PI * 2 * i) / 8 + 0.22;
    if (i === 5 || i === 6) continue;              // leave the trading-house frontage clear
    parts.push(place(stall(i + 3), Math.cos(a) * 3.35, 0.16, Math.sin(a) * 3.35, 0, -a + Math.PI / 2, 0));
  }
  parts.push(place(fountain(), 0, 0.16, 1.55));
  parts.push(marketGoods());
  parts.push(marketLanterns());
  // palms around the rim
  for (let i = 0; i < 5; i++) {
    const a = (Math.PI * 2 * i) / 5 + 0.9;
    parts.push(place(palmTree(3.9 + (i % 3) * 0.35, i + 2), Math.cos(a) * 4.72, 0.12, Math.sin(a) * 4.72, 0, i * 1.1, 0));
  }
  // tethered camels
  parts.push(place(camel(11), -4.05, 0.16, 2.55, 0, 0.9, 0, 0.92));
  parts.push(place(camel(23), -3.35, 0.16, 3.35, 0, 1.4, 0, 0.86));
  // entrance arch on the +X side
  parts.push(place(merge([
    place(gradient(new THREE.BoxGeometry(0.42, 3.10, 0.42), 0x9c8459, 0xd0b98d), 0, 1.55, 1.55),
    place(gradient(new THREE.BoxGeometry(0.42, 3.10, 0.42), 0x9c8459, 0xd0b98d), 0, 1.55, -1.55),
    place(box(0.52, 0.50, 3.70, 0xd0b98d, 0.06), 0, 3.30, 0),
    place(prism(0.80, 0.34, 3.90, PAL.terra, PAL.terraDark), 0, 3.55, 0)
  ]), 4.65, 0.16, 0));
  // flag poles
  for (const a of [0.9, 2.4, 3.9, 5.4]) {
    parts.push(place(tint(new THREE.BoxGeometry(0.13, 4.30, 0.13), 0x7a5732, 0.05),
      Math.cos(a) * 4.15, 2.30, Math.sin(a) * 4.15));
  }
  // braziers
  for (const a of [1.7, 4.6]) {
    parts.push(place(merge([
      place(gradient(new THREE.CylinderGeometry(0.34, 0.24, 0.34, 6), 0x4a4038, 0x776a5c), 0, 0.92, 0),
      place(tint(new THREE.BoxGeometry(0.09, 0.95, 0.09), 0x4a4038), 0, 0.48, 0),
      place(cone(0.28, 0.52, 5, 0xffa03a, 0.14), 0, 1.32, 0)
    ]), Math.cos(a) * 4.30, 0.16, Math.sin(a) * 4.30));
  }
  // steps up to the trading house
  for (let i = 0; i < 3; i++) {
    parts.push(place(gradient(new THREE.BoxGeometry(2.20 - i * 0.2, 0.14, 0.34), 0xa89066, 0xd6bd8f),
      -1.62 + i * 0.30, 0.16 + i * 0.12, -0.55 - i * 0.02, 0, 0.62, 0));
  }
  // a laden market cart
  parts.push(place(merge([
    place(gradient(new THREE.BoxGeometry(1.45, 0.46, 0.95), 0x7a5732, 0xa9793f), 0, 0.62, 0),
    place(box(1.50, 0.09, 0.09, PAL.woodDark), 0, 0.86, 0.46),
    place(box(1.50, 0.09, 0.09, PAL.woodDark), 0, 0.86, -0.46),
    place(gradient(new THREE.CylinderGeometry(0.40, 0.40, 0.12, 6), 0x4a3a24, 0x8a6338), -0.32, 0.40, 0.54, Math.PI / 2, 0, 0),
    place(gradient(new THREE.CylinderGeometry(0.40, 0.40, 0.12, 6), 0x4a3a24, 0x8a6338), -0.32, 0.40, -0.54, Math.PI / 2, 0, 0),
    place(box(1.25, 0.09, 0.09, 0x6b4526), 1.02, 0.55, 0.30, 0, 0, 0.14),
    place(box(1.25, 0.09, 0.09, 0x6b4526), 1.02, 0.55, -0.30, 0, 0, 0.14),
    place(box(0.55, 0.34, 0.50, 0xc0562f, 0.14), -0.10, 1.02, 0),
    place(tint(new THREE.IcosahedronGeometry(0.24, 0), 0xe8b53c, 0.12), 0.42, 0.96, 0.10)
  ]), -2.90, 0.16, 3.30, 0, -0.55, 0));
  // amphorae stacked by the storehouse
  for (let i = 0; i < 4; i++) {
    const a = 5.15 + i * 0.16;
    parts.push(place(merge([
      place(gradient(new THREE.CylinderGeometry(0.17, 0.24, 0.52, 6), 0x8a5a3a, 0xc08a5c), 0, 0.26, 0),
      place(cyl(0.09, 0.14, 0.20, 5, 0xc08a5c, false, 0.06), 0, 0.60, 0)
    ]), Math.cos(a) * 4.05 + i * 0.1, 0.16, Math.sin(a) * 4.05 - i * 0.28));
  }
  // rope barrier along the market frontage
  for (let i = 0; i < 4; i++) {
    const a = -0.55 + i * 0.30;
    parts.push(place(tint(new THREE.BoxGeometry(0.12, 0.80, 0.12), 0x6b4526, 0.06),
      Math.cos(a) * 4.75, 0.56, Math.sin(a) * 4.75));
    if (i < 3) {
      parts.push(place(box(1.45, 0.06, 0.06, PAL.rope, 0.08),
        Math.cos(a + 0.15) * 4.75, 0.86, Math.sin(a + 0.15) * 4.75, 0, -(a + 0.15) + Math.PI / 2, 0));
    }
  }
  // gong on a frame — rung when a trade closes
  parts.push(place(merge([
    place(tint(new THREE.BoxGeometry(0.11, 1.55, 0.11), 0x6b4526), -0.55, 0.78, 0),
    place(tint(new THREE.BoxGeometry(0.11, 1.55, 0.11), 0x6b4526), 0.55, 0.78, 0),
    place(box(1.35, 0.11, 0.11, 0x53381d), 0, 1.55, 0),
    place(gradient(new THREE.CylinderGeometry(0.44, 0.44, 0.09, 8), 0xb98b2e, 0xffd76a), 0, 1.00, 0, Math.PI / 2, 0, 0)
  ]), 2.05, 0.16, 3.85, 0, -1.15, 0));
  // benches around the fountain
  for (const a of [0.55, 2.65, 4.75]) {
    parts.push(place(merge([
      place(gradient(new THREE.BoxGeometry(1.30, 0.14, 0.42), 0x8a6338, 0xb2854b), 0, 0.42, 0),
      place(box(1.10, 0.44, 0.10, 0x6b4526, 0.06), 0, 0.20, 0)
    ]), Math.cos(a) * 2.55, 0.16, Math.sin(a) * 2.55 + 1.55, 0, -a + Math.PI / 2, 0));
  }
  // water trough for the camels
  parts.push(place(merge([
    place(gradient(new THREE.BoxGeometry(1.60, 0.42, 0.60), 0x7a6a4e, 0xa89066), 0, 0.21, 0),
    place(tint(new THREE.PlaneGeometry(1.40, 0.44), 0x37b3cf), 0, 0.36, 0, -Math.PI / 2, 0, 0)
  ]), -4.30, 0.16, 1.35, 0, 0.5, 0));
  // two more palms on the trading-house side
  parts.push(place(palmTree(4.35, 9), -4.90, 0.10, -1.55, 0, 2.2, 0));
  parts.push(place(palmTree(3.70, 13), -1.05, 0.10, -4.75, 0, 0.7, 0));
  return merge(parts);
}

function stripedAwning(w, d, c1, c2) {
  const g = new THREE.PlaneGeometry(w, d, 6, 1);
  const pos = g.attributes.position;
  const col = new Float32Array(pos.count * 3);
  const a = new THREE.Color(c1), b = new THREE.Color(c2);
  for (let i = 0; i < pos.count; i++) {
    const u = (pos.getX(i) + w / 2) / w;
    const s = Math.floor(u * 6) % 2 ? b : a;
    col[i * 3] = s.r; col[i * 3 + 1] = s.g; col[i * 3 + 2] = s.b;
    pos.setZ(i, Math.sin(u * Math.PI) * 0.10);
  }
  g.computeVertexNormals();
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

function marketClothGeo() {
  const parts = [];
  const stripes = [[0xf4ece0, 0xc23f2c], [0xf4ece0, 0x2f7fa8], [0xf6e7c6, 0x3f8a3c],
                   [0xfaf2e2, 0xd98b2b], [0xf4ece0, 0x8552c4], [0xf6e7c6, 0xc23f2c]];
  let k = 0;
  for (let i = 0; i < 8; i++) {
    if (i === 5 || i === 6) continue;
    const a = (Math.PI * 2 * i) / 8 + 0.22;
    const s = stripes[k++ % stripes.length];
    const g = stripedAwning(1.85, 1.20, s[0], s[1]);
    place(g, 0, 1.92, 0.24, -1.05, 0, 0);
    place(g, Math.cos(a) * 3.35, 0.16, Math.sin(a) * 3.35, 0, -a + Math.PI / 2, 0);
    parts.push(g);
  }
  // pennants on the four poles
  for (const a of [0.9, 2.4, 3.9, 5.4]) {
    const f = cloth(1.05, 0.70, 0xffd45a, 0xd98b2b, 0.12, 3);
    place(f, 0.56, 3.95, 0);
    place(f, Math.cos(a) * 4.15, 0.16, Math.sin(a) * 4.15, 0, -a, 0);
    parts.push(f);
  }
  // carpets hanging off the storehouse
  for (let i = 0; i < 2; i++) {
    const c = cloth(1.05, 1.35, [0xb8452f, 0x2f6b8b][i], 0x53291a, 0.10, 3);
    place(c, 3.05 + i * 0.05, 1.55, -1.35 + i * 1.15, 0, -0.75, 0);
    parts.push(c);
  }
  // bunting between the arch and the trading house
  for (let i = 0; i < 7; i++) {
    const t = i / 6;
    const x = 4.4 - t * 6.6;
    const y = 3.3 - Math.sin(t * Math.PI) * 0.55;
    const f = cloth(0.34, 0.42, [0xffd45a, 0xc23f2c, 0x3f8a3c, 0x2f7fa8][i % 4], 0xffffff, 0.05, 2);
    place(f, x, y, 0.9 - t * 1.6);
    parts.push(f);
  }
  return merge(parts);
}

/*
 * BUG FIX (world pass 2) — this was the blown-out white polygon spike sitting
 * at top-centre of every third-person screenshot.
 *
 * The beacon used to carry a 3.4-unit downward cone. Drawn with additive
 * blending, depthWrite off and renderOrder 5, it painted a hard-edged wedge of
 * pure 255,255,255 straight over the terrain and the trees, apex-down, flaring
 * off the top of the frame. Nothing in the reference art has a light shaft over
 * the market. The cone is gone; what is left is a small floating orb and its
 * two halo rings, and market.js now blends it normally instead of additively.
 */
function beaconGeo() {
  const parts = [
    place(tint(new THREE.IcosahedronGeometry(0.72, 1), 0xffe08a), 0, 0, 0),
    place(tint(new THREE.RingGeometry(0.95, 1.35, 16, 1), 0xffd45a), 0, -0.30, 0, -Math.PI / 2, 0, 0),
    place(tint(new THREE.RingGeometry(1.30, 1.80, 16, 1), 0xffb64a), 0, -0.72, 0, -Math.PI / 2, 0, 0)
  ];
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

export function buildMarket(scene) {
  const group = new THREE.Group();
  group.name = 'market';
  if (scene) scene.add(group);

  // The plaza is deliberately flattened by terrain.js; sit on its high point.
  let baseY = heightAt(MARKET.x, MARKET.z);
  for (let i = 0; i < 24; i++) {
    const a = (Math.PI * 2 * i) / 24;
    for (const r of [2.6, 5.2]) {
      const h = heightAt(MARKET.x + Math.cos(a) * r, MARKET.z + Math.sin(a) * r);
      if (h > baseY) baseY = h;
    }
  }
  group.position.set(MARKET.x, baseY, MARKET.z);

  const solid = solidMaterial();
  const clothMat = windClothMaterial(0.075);

  const gSolid = marketSolidGeo();
  const gCloth = marketClothGeo();
  const gBeacon = beaconGeo();
  const gFolk = villagerGeo(true);

  const solidMesh = new THREE.Mesh(gSolid, solid);
  solidMesh.castShadow = true;
  solidMesh.receiveShadow = true;
  group.add(solidMesh);

  const clothMesh = new THREE.Mesh(gCloth, clothMat);
  clothMesh.castShadow = true;
  group.add(clothMesh);

  // Normal blending, not additive: additive over a bright sky clips to pure
  // white and nothing about it reads as a beacon any more.
  const beaconMat = new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, opacity: 0.42,
    depthWrite: false, side: THREE.DoubleSide
  });
  const beacon = new THREE.Mesh(gBeacon, beaconMat);
  beacon.position.set(0, 9.6, 0);
  beacon.renderOrder = 5;
  beacon.frustumCulled = false;
  group.add(beacon);

  const CROWD = 10;
  const crowd = instanced(gFolk, solid, CROWD, true, false);
  crowd.instanceColor =
    new THREE.InstancedBufferAttribute(new Float32Array(CROWD * 3).fill(1), 3);
  group.add(crowd);

  const TONES = [0xd0472f, 0x3b7fd4, 0x3f9a52, 0x8552c4, 0xe0c27a, 0xdfe4ea];
  const folk = [];
  const r = rng(90210);
  for (let i = 0; i < CROWD; i++) {
    const a = (Math.PI * 2 * i) / CROWD + 0.3;
    const rr = 2.0 + r() * 2.1;
    folk.push({
      x: Math.cos(a) * rr, z: Math.sin(a) * rr,
      tx: Math.cos(a) * rr, tz: Math.sin(a) * rr,
      ry: -a, wait: r() * 2.5, phase: r() * 6.28,
      speed: 0.7 + r() * 0.55, scale: 0.94 + r() * 0.2
    });
    _c.set(TONES[i % TONES.length]).lerp(new THREE.Color(0xffffff), 0.30);
    crowd.instanceColor.setXYZ(i, _c.r, _c.g, _c.b);
  }
  crowd.instanceColor.needsUpdate = true;

  let t = 0;

  function update(dt) {
    if (!(dt > 0)) dt = 0;
    t += dt;
    clothMat.userData.wind.value = t;

    beacon.position.y = 9.6 + Math.sin(t * 0.85) * 0.45;
    beacon.rotation.y = t * 0.35;
    const pulse = 0.34 + Math.sin(t * 1.9) * 0.12;
    beaconMat.opacity = pulse;
    const bs = 1 + Math.sin(t * 1.9) * 0.06;
    beacon.scale.set(bs, bs, bs);

    for (let i = 0; i < folk.length; i++) {
      const f = folk[i];
      f.phase += dt * 3.6;
      if (f.wait > 0) f.wait -= dt;
      else {
        const dx = f.tx - f.x, dz = f.tz - f.z;
        const d = Math.hypot(dx, dz);
        if (d < 0.14) {
          const a = Math.random() * Math.PI * 2;
          const rr = 1.9 + Math.random() * 2.4;
          f.tx = Math.cos(a) * rr; f.tz = Math.sin(a) * rr;
          f.wait = 0.6 + Math.random() * 2.6;
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
      const bob = moving ? Math.abs(Math.sin(f.phase)) * 0.08 : Math.sin(f.phase * 0.25) * 0.015;
      setInstance(crowd, i, f.x, 0.18 + bob, f.z, f.ry, f.scale, f.scale,
        0, moving ? Math.sin(f.phase) * 0.13 : 0);
    }
    crowd.instanceMatrix.needsUpdate = true;
  }

  update(0);

  const triangles = triCount(gSolid) + triCount(gCloth) + triCount(gBeacon) + CROWD * triCount(gFolk);

  return {
    group, solidMesh, clothMesh, beacon, crowd,
    baseY, triangles, drawCalls: 4,
    update,
    dispose() {
      gSolid.dispose(); gCloth.dispose(); gBeacon.dispose(); gFolk.dispose();
      solid.dispose(); clothMat.dispose(); beaconMat.dispose();
    }
  };
}

/* ================================================================== ports */

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
    for (let lz = -1.7; lz <= 1.7; lz += 0.85) {
      const h = heightAt(x + lx * dx - lz * dz, z + lx * dz + lz * dx);
      if (h > hi) hi = h;
      if (h < lo) lo = h;
    }
  }
  const y = Math.min(Math.max(hi - 0.08, 0.26), 1.30);
  return { x, z, y, d, ground: heightAt(x, z), hi, lo };
}

const SIGN_LOCAL = { x: -2.75, y: P.DECK_Y + 1.52, z: -1.55, w: 1.72, h: 0.86 };

function buildSignMesh(anchors) {
  const atlas = P.portSignAtlas(ports);
  const n = ports.length;
  const pos = new Float32Array(n * 4 * 3);
  const cen = new Float32Array(n * 4 * 3);
  const loc = new Float32Array(n * 4 * 2);
  const uv = new Float32Array(n * 4 * 2);
  const col = new Float32Array(n * 4 * 3).fill(1);
  const idx = new Uint16Array(n * 6);
  const hw = SIGN_LOCAL.w / 2, hh = SIGN_LOCAL.h / 2;

  ports.forEach((p, i) => {
    const a = anchors[i];
    const cb = Math.cos(p.bearing), sb = Math.sin(p.bearing);
    const wx = a.x + SIGN_LOCAL.x * cb - SIGN_LOCAL.z * sb;
    const wz = a.z + SIGN_LOCAL.x * sb + SIGN_LOCAL.z * cb;
    const wy = a.y + SIGN_LOCAL.y;
    const cell = atlas.cells[i];
    const corners = [[-hw, -hh, cell.u0, cell.v0], [hw, -hh, cell.u1, cell.v0],
                     [hw, hh, cell.u1, cell.v1], [-hw, hh, cell.u0, cell.v1]];
    corners.forEach(([lx, ly, u, v], j) => {
      const k = i * 4 + j;
      pos[k * 3] = wx; pos[k * 3 + 1] = wy; pos[k * 3 + 2] = wz;
      cen[k * 3] = wx; cen[k * 3 + 1] = wy; cen[k * 3 + 2] = wz;
      loc[k * 2] = lx; loc[k * 2 + 1] = ly;
      uv[k * 2] = u; uv[k * 2 + 1] = v;
    });
    const b = i * 4;
    idx.set([b, b + 1, b + 2, b, b + 2, b + 3], i * 6);
  });

  const nrm = new Float32Array(n * 4 * 3);
  for (let i = 0; i < n * 4; i++) nrm[i * 3 + 2] = 1;

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('aCenter', new THREE.BufferAttribute(cen, 3));
  g.setAttribute('aLocal', new THREE.BufferAttribute(loc, 2));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 2, 0), 120);

  const mat = new THREE.MeshBasicMaterial({
    map: atlas.texture, vertexColors: true, side: THREE.DoubleSide
  });
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = 'attribute vec3 aCenter;\nattribute vec2 aLocal;\n' + sh.vertexShader;
    sh.vertexShader = sh.vertexShader.replace('#include <begin_vertex>', [
      'vec3 look = cameraPosition - aCenter;',
      'look.y = 0.0;',
      'float ll = length( look );',
      'vec3 fwd = ll > 0.0001 ? look / ll : vec3( 0.0, 0.0, 1.0 );',
      'vec3 rgt = normalize( cross( vec3( 0.0, 1.0, 0.0 ), fwd ) );',
      'vec3 transformed = aCenter + rgt * aLocal.x + vec3( 0.0, aLocal.y, 0.0 );'
    ].join('\n'));
  };
  mat.customProgramCacheKey = () => 'islandPortSign';

  const mesh = new THREE.Mesh(g, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 4;
  return { mesh, geometry: g, material: mat, atlas, colors: g.attributes.color };
}

export function buildPorts(scene, state) {
  const group = new THREE.Group();
  group.name = 'ports';
  if (scene) scene.add(group);

  const solid = solidMaterial();
  const shipMat = windClothMaterial(0.035);
  const flagMat = clothMaterial();

  const gBase = P.portBaseGeo();
  const gShip = P.portShipGeo();
  const gFlag = P.portFlagGeo();
  const gGull = P.seagullGeo();
  const gFolk = villagerGeo(false);

  const N = ports.length;
  const CREW = 3, GULLS = 3;

  const base = instanced(gBase, solid, N, true, true);
  const ship = instanced(gShip, shipMat, N, true, false);
  const flag = instanced(gFlag, flagMat, N, false, false);
  const crew = instanced(gFolk, solid, N * CREW, true, false);
  const gulls = instanced(gGull, flagMat, N * GULLS, false, false);
  for (const m of [base, ship, flag, crew, gulls]) group.add(m);

  base.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(N * 3).fill(1), 3);
  flag.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(N * 3).fill(1), 3);
  crew.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(N * CREW * 3).fill(1), 3);

  const anchors = ports.map(shoreAnchor);
  const sign = buildSignMesh(anchors);
  group.add(sign.mesh);

  const LOCKED = new THREE.Color(0x77808c);
  const LIT = new THREE.Color(0xffffff);

  const recs = ports.map((p, i) => {
    const a = anchors[i];
    const cb = Math.cos(p.bearing), sb = Math.sin(p.bearing);
    const toWorld = (lx, lz) => ({ x: a.x + lx * cb - lz * sb, z: a.z + lx * sb + lz * cb });
    const r = rng(1000 + i * 77);
    const crewList = [];
    for (let k = 0; k < CREW; k++) {
      const lx = -2.6 + k * 1.9, lz = (k % 2 ? 0.9 : -0.85);
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
    const f = rec.toWorld(-1.75, -1.15);
    setInstance(flag, rec.i, f.x, rec.y + P.DECK_Y + 1.30, f.z, rec.ry, 1, Math.max(0.02, rec.lit));
    _c.copy(LOCKED).lerp(LIT, rec.lit);
    base.instanceColor.setXYZ(rec.i, _c.r, _c.g, _c.b);
    for (let v = 0; v < 4; v++) {
      sign.colors.setXYZ(rec.i * 4 + v, 0.52 + 0.48 * rec.lit, 0.55 + 0.45 * rec.lit, 0.60 + 0.40 * rec.lit);
    }
    if (rec.owner >= 0) {
      const pc = PLAYER_COLORS[((rec.owner | 0) % PLAYER_COLORS.length + PLAYER_COLORS.length) % PLAYER_COLORS.length];
      _c.set(pc ? pc.hex : 0xffffff);
      flag.instanceColor.setXYZ(rec.i, _c.r, _c.g, _c.b);
    }
  }

  for (const rec of recs) writeStatic(rec);
  base.instanceColor.needsUpdate = true;
  flag.instanceColor.needsUpdate = true;
  sign.colors.needsUpdate = true;

  function setUnlocked(portId, pid) {
    const rec = recs[portId];
    if (!rec) return;
    rec.want = 1;
    rec.owner = pid ?? 0;
    writeStatic(rec);
    base.instanceColor.needsUpdate = true;
    flag.instanceColor.needsUpdate = true;
    sign.colors.needsUpdate = true;
  }

  // Pick up any ports the match already considers unlocked.
  if (state && state.players) {
    for (const p of state.players) {
      if (p.ports) for (const id of p.ports) { const r = recs[id]; if (r) { r.want = 1; r.lit = 1; r.owner = p.id; writeStatic(r); } }
    }
    base.instanceColor.needsUpdate = true;
    flag.instanceColor.needsUpdate = true;
    sign.colors.needsUpdate = true;
  }

  let t = 0;

  function update(dt) {
    if (!(dt > 0)) dt = 0;
    t += dt;
    shipMat.userData.wind.value = t;

    let tint = false;
    for (const rec of recs) {
      if (Math.abs(rec.lit - rec.want) > 0.001) {
        rec.lit += (rec.want - rec.lit) * Math.min(1, dt * 3.2);
        writeStatic(rec);
        tint = true;
      }
      // ship bobs on the swell
      const b = t * 1.15 + rec.bob;
      const s = rec.toWorld(P.DOCK_TO - 2.55, P.DOCK_W / 2 + 1.55);
      setInstance(ship, rec.i, s.x, 0.16 + Math.sin(b) * 0.16, s.z, rec.ry, 1, 1,
        Math.sin(b * 0.8) * 0.05, Math.cos(b * 1.1) * 0.07);

      // dock workers — frozen while the port is derelict
      for (const c of rec.crew) {
        const active = rec.lit > 0.55;
        c.phase += dt * (active ? 3.4 : 0.4);
        if (active) {
          if (c.wait > 0) c.wait -= dt;
          else {
            const dx = c.tlx - c.lx, dz = c.tlz - c.lz;
            const d = Math.hypot(dx, dz);
            if (d < 0.12) {
              c.tlx = -3.0 + Math.random() * 8.6;
              c.tlz = (Math.random() - 0.5) * 1.7;
              c.wait = 0.4 + Math.random() * 1.8;
            } else {
              const k = Math.min(1, (dt * c.speed) / d);
              c.lx += dx * k; c.lz += dz * k;
            }
          }
        }
        const w = rec.toWorld(c.lx, c.lz);
        const moving = active && c.wait <= 0;
        const bob = moving ? Math.abs(Math.sin(c.phase)) * 0.07 : 0;
        setInstance(crew, c.slot, w.x, rec.y + P.DECK_Y + bob, w.z,
          rec.ry + (moving ? 0 : 0.5), 1, 1, 0, moving ? Math.sin(c.phase) * 0.12 : 0);
      }

      // gulls circling the mast
      for (let k = 0; k < GULLS; k++) {
        const a = t * (0.7 + k * 0.18) + rec.gull + k * 2.1;
        const rr = 3.0 + k * 1.1;
        const w = rec.toWorld(P.DOCK_TO - 3.2 + Math.cos(a) * rr, Math.sin(a) * rr * 0.7);
        setInstance(gulls, rec.i * GULLS + k, w.x,
          rec.y + 3.6 + k * 0.7 + Math.sin(a * 1.7) * 0.35, w.z,
          rec.ry - a - Math.PI / 2, 0.85, 0.85, 0, Math.sin(a * 3.1) * 0.5);
      }
    }
    if (tint) {
      base.instanceColor.needsUpdate = true;
      flag.instanceColor.needsUpdate = true;
      sign.colors.needsUpdate = true;
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
      solid.dispose(); shipMat.dispose(); flagMat.dispose();
      sign.material.dispose(); sign.atlas.texture.dispose();
    }
  };
}

export default { buildMarket, buildPorts };
