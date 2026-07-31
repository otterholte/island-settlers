/**
 * Island Settlers — road, village, city, raider and ghost geometry.
 *
 * Every kit is authored in canonical local space so the runtime in
 * structures.js can drive it entirely through InstancedMesh matrices:
 *
 *   ROAD      +X is the direction of travel, deck top at y = +0.17, kerb
 *             footings reach y = -ROAD_SINK so the deck never floats over the
 *             rise and fall of the tan border strip.
 *   VILLAGE   origin at the centre of the pad, on the ground. The plinth
 *             sinks `SET_SKIRT` below the origin, which swallows the height
 *             difference between the three plateaus meeting at a hex corner.
 *   CITY      same convention, wider pad and a deeper skirt.
 *
 * Anything that must carry an owner's colour is authored pure white and gets
 * tinted per instance through InstancedMesh.setColorAt.
 */

import * as THREE from 'three';
import { merge, place, tint, gradient, box, cyl, cone } from './geo.js';
import {
  PAL, prism, decal, cloth, crate, cottage, roundTower, wallPanel,
  plinth, faceGeo, rng
} from './buildkit.js';

/* ------------------------------------------------------------------ scales */

/*
 * The skirt/sink numbers below are not guesses: the plateau blend in
 * terrain.js swings hard near a hex corner, so the ground under a 3.5-unit
 * village pad drops as much as 1.92 units and under a 5.5-unit city pad as
 * much as 3.07 (mountains meeting fields). The kerbs and plinths reach past
 * those worst cases, which is why nothing on the board can ever float.
 */
export const ROAD_W = 2.30;      // deck width, comfortably inside the 2.96 strip
export const ROAD_SEGS = 3;      // plank groups per edge — they drop in sequence
export const ROAD_DECK_Y = 0.17; // deck surface above the instance origin
export const ROAD_SINK = 1.25;   // kerb footing depth (worst edge spread 0.98)

export const SET_RADIUS = 1.78;  // village pad ~3.5 units across
export const SET_SKIRT = 2.45;   // plinth depth  (worst pad spread 1.92)
export const CITY_RADIUS = 2.72; // city pad ~5.5 units across
export const CITY_SKIRT = 3.55;  // plinth depth  (worst pad spread 3.07)

/* =================================================================== roads */

/**
 * Continuous bed for one edge: two stone kerbs and a buried sleeper that seals
 * the gap to the ground. `len` is the full edge length (9 units).
 */
export function roadBedGeo(len) {
  const kerbH = ROAD_SINK + 0.30;
  const parts = [
    // buried sleeper — dark, only its top lip is ever visible
    place(gradient(new THREE.BoxGeometry(len, ROAD_SINK + 0.24, ROAD_W * 0.80),
      0x4b3a22, 0x6d5531), 0, ROAD_DECK_Y - (ROAD_SINK + 0.24) / 2 - 0.02, 0),
    // stone kerbs
    place(gradient(new THREE.BoxGeometry(len, kerbH, 0.30), PAL.kerbDark, PAL.stoneLight),
      0, ROAD_DECK_Y + 0.13 - kerbH / 2, ROAD_W / 2 - 0.09),
    place(gradient(new THREE.BoxGeometry(len, kerbH, 0.30), PAL.kerbDark, PAL.stoneLight),
      0, ROAD_DECK_Y + 0.13 - kerbH / 2, -ROAD_W / 2 + 0.09)
  ];
  return merge(parts);
}

/**
 * One third of the decking: three cross planks plus the cross-beam they are
 * nailed to. Authored centred on its own origin so a bounce animation can
 * squash it without shearing the neighbours.
 */
export function roadPlankGeo(len) {
  const seg = len / ROAD_SEGS;
  const pw = seg / 3.35;
  const parts = [];
  const r = rng(4242);
  for (let i = 0; i < 3; i++) {
    const x = (i - 1) * (seg / 3.05);
    const hue = i % 2 ? PAL.plankAlt : PAL.plank;
    parts.push(place(
      tint(new THREE.BoxGeometry(pw, 0.115, ROAD_W - 0.30), hue, 0.13, 11 + i),
      x, ROAD_DECK_Y - 0.055, (r() - 0.5) * 0.05
    ));
  }
  // cross-beam under the planks, running across the road
  parts.push(place(tint(new THREE.BoxGeometry(seg * 0.94, 0.10, 0.20), PAL.beam, 0.08),
    0, ROAD_DECK_Y - 0.16, 0));
  return merge(parts);
}

/**
 * Owner-coloured dressing: a painted stripe capping each kerb plus a pennant
 * on a short staff. Pure white — the instance colour does the work.
 */
export function roadTrimGeo(len) {
  const parts = [
    place(box(len, 0.055, 0.17, 0xffffff), 0, ROAD_DECK_Y + 0.155, ROAD_W / 2 - 0.09),
    place(box(len, 0.055, 0.17, 0xffffff), 0, ROAD_DECK_Y + 0.155, -ROAD_W / 2 + 0.09)
  ];
  // pennant staff (neutral) + triangular flag (white)
  const h = 1.35;
  parts.push(place(tint(new THREE.BoxGeometry(0.07, h, 0.07), 0xdedede), len * 0.28, h / 2 + 0.1, ROAD_W / 2 - 0.08));
  const flag = faceGeo(null, [
    [[0, h, 0], [0.52, h - 0.13, 0], [0, h - 0.36, 0]],
    [[0, h, 0], [0, h - 0.36, 0], [0.52, h - 0.13, 0]]
  ]);
  tint(flag, 0xffffff);
  parts.push(place(flag, len * 0.28 + 0.03, 0.1, ROAD_W / 2 - 0.08));
  return merge(parts);
}

/* ================================================================= village */

function villageCottages() {
  const parts = [];
  const spec = [
    { a: 0.55, r: 1.02, w: 1.02, h: 0.80, d: 0.84, roof: PAL.terra },
    { a: 2.05, r: 1.05, w: 0.88, h: 0.68, d: 0.76, roof: PAL.terraLight },
    { a: 3.55, r: 1.00, w: 0.96, h: 0.74, d: 0.80, roof: PAL.terraDark },
    { a: 5.05, r: 1.08, w: 0.80, h: 0.62, d: 0.72, roof: PAL.terra }
  ];
  spec.forEach((s, i) => {
    const g = cottage(s.w, s.h, s.d, {
      roof: s.roof,
      body: i % 2 ? PAL.plaster : 0xe8d6b0,
      window: i < 3
    });
    place(g, Math.cos(s.a) * s.r, 0.22, Math.sin(s.a) * s.r, 0, -s.a + Math.PI / 2, 0);
    parts.push(g);
  });
  // chimney on the first cottage
  parts.push(place(tint(new THREE.BoxGeometry(0.17, 0.52, 0.17), PAL.stone, 0.08),
    Math.cos(0.55) * 1.02 + 0.26, 1.22, Math.sin(0.55) * 1.02 + 0.1));
  return parts;
}

function villageFence() {
  const parts = [];
  const total = 2.35;
  for (let i = 0; i <= 3; i++) {
    parts.push(place(tint(new THREE.BoxGeometry(0.10, 0.58, 0.10), PAL.wood, 0.09),
      -total / 2 + i * (total / 3), 0.29, 0));
  }
  parts.push(place(box(total, 0.07, 0.06, PAL.woodDark, 0.07), 0, 0.46, 0));
  parts.push(place(box(total, 0.07, 0.06, PAL.woodDark, 0.07), 0, 0.24, 0));
  return merge(parts);
}

function villageWell() {
  return merge([
    place(gradient(new THREE.CylinderGeometry(0.30, 0.33, 0.40, 6), PAL.stoneDark, PAL.stone), 0, 0.20, 0),
    place(tint(new THREE.BoxGeometry(0.07, 0.62, 0.07), PAL.wood), -0.26, 0.51, 0),
    place(tint(new THREE.BoxGeometry(0.07, 0.62, 0.07), PAL.wood), 0.26, 0.51, 0),
    place(prism(0.86, 0.28, 0.52, PAL.terra, PAL.terraDark), 0, 0.82, 0, 0, Math.PI / 2, 0)
  ]);
}

/** Village body: pad, four cottages, the well, a fence and stored goods. */
export function villageBaseGeo() {
  const parts = [plinth(SET_RADIUS, SET_SKIRT, 9, PAL.dirt, 0x8a7048)];
  parts.push(...villageCottages());
  parts.push(place(villageWell(), 0, 0.22, 0));
  parts.push(place(villageFence(), -0.05, 0.22, 1.42, 0, 0.18, 0));
  parts.push(place(crate(0.42), 1.32, 0.22, -0.62, 0, 0.4, 0));
  parts.push(place(gradient(new THREE.CylinderGeometry(0.19, 0.22, 0.40, 6), 0x6b4526, PAL.wood),
    1.05, 0.42, -0.98));
  return merge(parts);
}

/** Owner colour: the tall banner and painted roof ridges. */
export function villageTintGeo() {
  const h = 2.55;
  const parts = [
    place(tint(new THREE.BoxGeometry(0.10, h, 0.10), 0xffffff), -1.16, 0.22 + h / 2, 0.52),
    place(box(0.19, 0.19, 0.19, 0xffffff), -1.16, 0.22 + h + 0.06, 0.52)
  ];
  const flag = cloth(0.92, 1.30, 0xffffff, 0xe4e4e4, 0.10, 3);
  place(flag, -1.16 + 0.51, 0.22 + h - 0.72, 0.52);
  parts.push(flag);
  // painted ridge caps — the cap's long axis must follow the cottage ridge,
  // which runs along the cottage's local Z, hence yaw = cottageYaw - PI/2.
  parts.push(place(box(0.96, 0.08, 0.10, 0xffffff), Math.cos(0.55) * 1.02, 1.50, Math.sin(0.55) * 1.02, 0, -0.55, 0));
  parts.push(place(box(0.90, 0.08, 0.10, 0xffffff), Math.cos(3.55) * 1.00, 1.41, Math.sin(3.55) * 1.00, 0, -3.55, 0));
  return merge(parts);
}

/* ==================================================================== city */

function cityBuildings() {
  const parts = [];
  const spec = [
    { a: 0.35, r: 1.15, w: 1.20, h: 1.42, d: 1.00, roof: PAL.terra },
    { a: 1.40, r: 1.25, w: 1.00, h: 1.05, d: 0.92, roof: PAL.terraLight },
    { a: 2.55, r: 1.20, w: 1.10, h: 1.28, d: 0.96, roof: PAL.terraDark },
    { a: 3.70, r: 1.30, w: 0.94, h: 0.96, d: 0.88, roof: PAL.terra },
    { a: 4.85, r: 1.18, w: 1.06, h: 1.18, d: 0.94, roof: PAL.terraLight }
  ];
  spec.forEach((s, i) => {
    const g = cottage(s.w, s.h, s.d, {
      roof: s.roof,
      body: i % 2 ? PAL.plaster : 0xe6d3ab,
      pitch: s.h * 0.48
    });
    place(g, Math.cos(s.a) * s.r, 0.26, Math.sin(s.a) * s.r, 0, -s.a + Math.PI / 2, 0);
    parts.push(g);
  });
  // the spired hall in the middle
  parts.push(place(gradient(new THREE.BoxGeometry(1.05, 1.35, 1.05), 0xd9c8a4, PAL.plaster), 0, 0.94, 0));
  parts.push(place(gradient(new THREE.CylinderGeometry(0.34, 0.40, 1.20, 6), PAL.stoneDark, PAL.stoneLight), 0, 2.20, 0));
  parts.push(place(cone(0.50, 1.15, 6, 0x8e4a86, 0.07), 0, 3.35, 0));
  // chimneys
  parts.push(place(tint(new THREE.BoxGeometry(0.18, 0.5, 0.18), PAL.stone, 0.08),
    Math.cos(0.35) * 1.15 + 0.3, 2.00, Math.sin(0.35) * 1.15));
  parts.push(place(tint(new THREE.BoxGeometry(0.16, 0.44, 0.16), PAL.stone, 0.08),
    Math.cos(2.55) * 1.20 - 0.28, 1.82, Math.sin(2.55) * 1.20));
  return parts;
}

/** City body: pad, five houses and the spired hall. */
export function cityCoreGeo() {
  const parts = [plinth(CITY_RADIUS, CITY_SKIRT, 10, 0xa8916a, 0x7d6743)];
  parts.push(...cityBuildings());
  return merge(parts);
}

/**
 * Curtain wall: five crenellated panels around a decagon plus a gatehouse on
 * the +X face. Authored so scaleY animates it up out of the ground.
 */
export function cityWallGeo() {
  const parts = [];
  const R = CITY_RADIUS - 0.16;
  const H = 1.20;
  for (let i = 1; i <= 5; i++) {
    const a = (Math.PI * 2 / 6) * i;
    const len = 2 * R * Math.sin(Math.PI / 6) * 1.04;
    const p = wallPanel(len, H, 0.34, 2);
    place(p, Math.cos(a) * R * 0.94, 0.24, Math.sin(a) * R * 0.94, 0, -a + Math.PI / 2, 0);
    parts.push(p);
  }
  // gatehouse on the +X face
  const gx = R * 0.94;
  parts.push(place(gradient(new THREE.BoxGeometry(0.42, 1.55, 0.46), PAL.stoneDark, PAL.stone), gx, 1.02, 0.62));
  parts.push(place(gradient(new THREE.BoxGeometry(0.42, 1.55, 0.46), PAL.stoneDark, PAL.stone), gx, 1.02, -0.62));
  parts.push(place(gradient(new THREE.BoxGeometry(0.46, 0.46, 1.34), PAL.stone, PAL.stoneLight), gx, 1.62, 0));
  parts.push(place(prism(0.70, 0.42, 1.70, PAL.terraDark, 0x7a3018), gx, 1.85, 0));
  parts.push(place(decal(0.86, 0.92, PAL.woodDark), gx + 0.24, 0.70, 0, 0, Math.PI / 2, 0));
  return merge(parts);
}

/** One corner tower — instanced twice per city so they telescope up. */
export function cityTowerGeo() {
  return roundTower(0.52, 2.05, { roofH: 0.95, roof: 0x9b4023 });
}

/** Owner colour: three banners, on the towers and over the gate. */
export function cityTintGeo() {
  const parts = [];
  const mk = (x, y, z, w, hh) => {
    parts.push(place(tint(new THREE.BoxGeometry(0.07, hh, 0.07), 0xffffff), x, y + hh / 2, z));
    const f = cloth(w, hh * 0.62, 0xffffff, 0xe2e2e2, 0.08, 3);
    place(f, x + w / 2 + 0.03, y + hh * 0.66, z);
    parts.push(f);
  };
  mk(CITY_RADIUS * 0.94 - 0.02, 2.28, 0, 0.72, 1.05);
  mk(0, 4.45, 0, 0.80, 1.15);
  mk(-CITY_RADIUS * 0.62, 2.60, CITY_RADIUS * 0.55, 0.60, 0.90);
  return merge(parts);
}

/* ================================================================== raider */

/** Hooded figure with a torch, ~2.4 units tall, standing on a scorched rock. */
export function raiderGeo() {
  const parts = [
    // scorched stone underfoot
    place(gradient(new THREE.CylinderGeometry(0.72, 0.86, 0.26, 7), 0x2b2119, 0x4a3a2c), 0, 0.13, 0),
    // cloak
    place(gradient(new THREE.CylinderGeometry(0.30, 0.66, 1.52, 7), 0x141522, 0x33304a), 0, 1.02, 0),
    // shoulders / hood
    place(tint(new THREE.IcosahedronGeometry(0.36, 0), 0x24243a, 0.08), 0, 1.86, 0),
    place(cone(0.34, 0.46, 6, 0x1a1a2c, 0.08), 0, 2.12, 0),
    // the face is a void with two ember eyes
    place(decal(0.26, 0.16, 0x0a0a12), 0, 1.86, 0.30),
    place(box(0.055, 0.05, 0.03, 0xff5a2b), -0.07, 1.88, 0.325),
    place(box(0.055, 0.05, 0.03, 0xff5a2b), 0.07, 1.88, 0.325),
    // torch arm
    place(tint(new THREE.BoxGeometry(0.13, 0.13, 0.50), 0x2a2a3e), 0.34, 1.55, 0.16),
    place(cyl(0.055, 0.07, 1.10, 4, 0x4a3018), 0.46, 1.60, 0.36, 0.32, 0, 0.16),
    place(cone(0.20, 0.52, 5, 0xffb03a, 0.14), 0.62, 2.22, 0.52),
    place(tint(new THREE.IcosahedronGeometry(0.15, 0), 0xff7a1f, 0.12), 0.62, 2.06, 0.52)
  ];
  return merge(parts);
}

/** Red ground vignette over the blocked tile — one flat annulus with a fade. */
export function raiderVignetteGeo(radius) {
  const g = new THREE.RingGeometry(radius * 0.12, radius, 22, 2);
  const pos = g.attributes.position;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const d = Math.hypot(pos.getX(i), pos.getY(i)) / radius;
    const k = Math.min(1, Math.max(0, 1 - Math.abs(d - 0.72) / 0.62));
    col[i * 3] = 0.85 * (0.35 + k);
    col[i * 3 + 1] = 0.10 * (0.35 + k);
    col[i * 3 + 2] = 0.08 * (0.35 + k);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return place(g, 0, 0, 0, -Math.PI / 2, 0, 0);
}

/* ================================================================== ghosts */

/** Translucent preview of a road — deck silhouette only. */
export function ghostRoadGeo(len) {
  const parts = [
    place(box(len, 0.16, ROAD_W, 0xffffff), 0, ROAD_DECK_Y, 0),
    place(box(len, 0.34, 0.22, 0xffffff), 0, ROAD_DECK_Y + 0.12, ROAD_W / 2 - 0.09),
    place(box(len, 0.34, 0.22, 0xffffff), 0, ROAD_DECK_Y + 0.12, -ROAD_W / 2 + 0.09)
  ];
  for (let i = 0; i < 5; i++) {
    parts.push(place(box(len / 7.4, 0.20, ROAD_W - 0.34, 0xffffff),
      (i - 2) * (len / 5.6), ROAD_DECK_Y + 0.05, 0));
  }
  return merge(parts);
}

/** Translucent preview of a village — pad plus blocked-in massing. */
export function ghostSettlementGeo() {
  const parts = [
    place(gradient(new THREE.CylinderGeometry(SET_RADIUS, SET_RADIUS * 1.04, 0.34, 9), 0xffffff, 0xffffff), 0, 0.16, 0)
  ];
  const spec = [[0.55, 1.02, 1.02, 0.80], [2.05, 1.05, 0.88, 0.68],
                [3.55, 1.00, 0.96, 0.74], [5.05, 1.08, 0.80, 0.62]];
  for (const [a, r, w, h] of spec) {
    parts.push(place(box(w, h, w * 0.85, 0xffffff), Math.cos(a) * r, 0.33 + h / 2, Math.sin(a) * r, 0, -a, 0));
    parts.push(place(prism(w * 1.14, h * 0.6, w * 0.95, 0xffffff), Math.cos(a) * r, 0.33 + h, Math.sin(a) * r, 0, -a, 0));
  }
  const h = 2.5;
  parts.push(place(box(0.11, h, 0.11, 0xffffff), -1.16, 0.33 + h / 2, 0.52));
  return merge(parts);
}

export default {
  roadBedGeo, roadPlankGeo, roadTrimGeo,
  villageBaseGeo, villageTintGeo,
  cityCoreGeo, cityWallGeo, cityTowerGeo, cityTintGeo,
  raiderGeo, raiderVignetteGeo, ghostRoadGeo, ghostSettlementGeo
};
