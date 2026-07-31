/**
 * Island Settlers — procedural prop geometry.
 *
 * Every entry is a merged, vertex-coloured BufferGeometry meant to be driven
 * by a single InstancedMesh. Several kits deliberately bundle a little cluster
 * (stump + fallen log + rock) so one instance drops a whole vignette on the
 * ground: more density for the same draw call.
 *
 * Triangle counts are kept deliberately low — most kits are 12 to 70 triangles
 * — because they are instanced 20 to 600 times each.
 *
 * Local convention: the geometry sits on y = 0 and is roughly unit-ish, so
 * props.js can scale instances freely.
 */

import * as THREE from 'three';
import { merge, place, tint, gradient, box, cyl, cone, ball, blob, rock, blade } from './geo.js';

/*
 * Triangle discipline
 * -------------------
 * These kits are instanced 20 to 600 times each, so a single wasted face on a
 * conifer costs eighty-five faces in the frame. Two rules are applied
 * throughout:
 *
 *   1. Caps that face away from every camera the game ever uses are dropped.
 *     The play camera sits at a 50 degree downward pitch and the sun that
 *     drives the shadow map is higher still, so the underside of a conifer
 *     skirt, of a wheat ear, or of a trunk buried in the ground is never
 *     rasterised. `cone(..., open)` and `cyl(..., open)` remove them.
 *   2. Filler volumes — the blob inside a fern, the companion stone beside a
 *     boulder, a pebble at half a metre across — use the 8-face `blob` / low
 *     poly `rock` instead of the 20-face icosahedron. At their on-screen size
 *     the two are indistinguishable, and the flat shading is on-style.
 *
 * Silhouette-defining volumes (hero canopies, the sheep, the ore seam) keep
 * their original resolution.
 */

/* Canopies are deliberately DARKER than the grass and the forest floor they
   stand on. The build's greens used to be one acidic mid-tone across terrain,
   trees and tufts, so a forest read as a flat green field with bumps. The
   spread now runs roughly: canopy 0x1a4524 -> forest floor 0x3f8a2c ->
   pasture 0x8fce56 -> grass tuft highlight 0x9ada5e. */
export const C = {
  bark:    0x6b4a2a, barkDark: 0x402b18, barkPale: 0x8a6338,
  needle:  0x1a4524, needleMid: 0x2a6b2c, needleHi: 0x3e8c38,
  leaf:    0x2a6b23, leafHi: 0x4f9c34,
  grass:   0x4f9a30, grassHi: 0x9ada5e,
  // deeper, less bleached gold: at 0xf2d982 the ears blew out under the key
  // light and the fields read as pale twigs on pale sand
  wheat:   0xb07d1e, wheatHi: 0xe4c051,
  stone:   0x7d7768, stoneHi: 0xa39c8b, stoneDark: 0x5b564a,
  slate:   0x6e7683, slateHi: 0x99a1ae,
  clay:    0xb0562c, clayHi: 0xd47f45,
  brick:   0xc0562f, brickHi: 0xdd7c4f,
  plank:   0x8a5a30, plankDark: 0x5f3d20,
  hay:     0xd6ae57, hayHi: 0xf0d287,
  wool:    0xf2eee2, woolShade: 0xd9d2bf, face: 0x3d382f,
  iron:    0x4d5158, ironHi: 0x777d86,
  ore:     0x8f99a8, oreGlint: 0x9fe6ff, gold: 0xffc93c,
  petalA:  0xf7f3e6, petalB: 0xffd45c, petalC: 0xe8748a, petalD: 0xb98ce0,
  sand:    0xd9c395, dirt: 0x7a5c3a
};

/* -------------------------------------------------------------------- trees */

/** Tall stylised spruce: stacked cones on a chunky trunk.  (30 tris) */
export function conifer() {
  const parts = [];
  parts.push(place(cyl(0.10, 0.17, 1.05, 5, C.barkDark, true), 0, 0.52, 0));
  parts.push(gradient(place(cone(0.72, 1.35, 7, C.needle, 0, true), 0, 1.30, 0), C.needle, C.needleMid));
  parts.push(gradient(place(cone(0.56, 1.20, 7, C.needleMid, 0, true), 0, 2.02, 0), C.needleMid, C.needleHi));
  parts.push(gradient(place(cone(0.36, 0.98, 6, C.needleHi, 0, true), 0, 2.72, 0), C.needleMid, C.needleHi));
  return merge(parts);
}

/** Shorter, rounder pine for layering behind the spruces.  (22 tris) */
export function coniferShort() {
  const parts = [];
  parts.push(place(cyl(0.11, 0.16, 0.6, 5, C.bark, true), 0, 0.3, 0));
  parts.push(gradient(place(cone(0.78, 1.05, 6, C.needle, 0, true), 0, 0.92, 0), C.needle, C.needleMid));
  parts.push(gradient(place(cone(0.52, 0.86, 6, C.needleMid, 0, true), 0, 1.52, 0), C.needleMid, C.needleHi));
  return merge(parts);
}

/** Broadleaf: leaning trunk with two overlapping canopy blobs.  (38 tris) */
export function broadleaf() {
  const parts = [];
  const t = cyl(0.11, 0.19, 1.5, 5, C.bark, true);
  place(t, 0, 0.75, 0, 0, 0, 0.07);
  parts.push(t);
  // The lead canopy holds the silhouette and keeps its 20 faces; the smaller
  // one only breaks the outline, so 8 faces read the same at any distance.
  parts.push(gradient(place(ball(0.86, 0, C.leafHi), 0.06, 1.88, 0), C.leaf, C.leafHi));
  parts.push(gradient(place(blob(0.62, C.leaf), -0.58, 1.55, 0.22), C.leaf, C.leafHi));
  return merge(parts);
}

/*
 * ---------------------------------------------------------------------------
 * HARVEST SUB-UNITS
 * ---------------------------------------------------------------------------
 * A gather node holds NODE_CAPACITY (3) harvest cycles, and the player has to
 * SEE those three cycles come out of the ground. So a node is no longer one
 * object — it is three, and each cycle fells / shears / cuts / digs / cracks
 * exactly one of them. The kits below are therefore built at a third of the old
 * silhouette weight: three of them together read denser than the single hero
 * they replaced, for roughly the same triangles.
 *
 * Every one of them stands on y = 0 with its mass centred on the origin, so an
 * instance matrix can topple it about its own base.
 */

/**
 * One tree of a three-tree copse — the harvestable forest node.  (23 tris)
 *
 * Deliberately painted two full steps LIGHTER than the decorative spruces it
 * stands among (needleMid -> 0x76c94a rather than needle -> needleHi) and given
 * a pale trunk, because thirty-six dressing conifers per tile will otherwise
 * swallow the seven copses you are actually allowed to chop.
 */
export function heroTree() {
  const parts = [];
  parts.push(place(cyl(0.14, 0.24, 1.10, 5, C.barkPale, true), 0, 0.55, 0));
  parts.push(gradient(place(cone(0.84, 1.52, 7, C.needleMid, 0, true), 0, 1.42, 0),
    C.needleMid, C.needleHi));
  parts.push(gradient(place(cone(0.58, 1.26, 6, C.needleHi, 0, true), 0, 2.30, 0),
    C.needleHi, 0x76c94a));
  return merge(parts);
}

/** What a felled tree leaves behind — a pale sawn top on a dark stump. (24 tris) */
export function stump() {
  const g = cyl(0.30, 0.40, 0.44, 6, C.barkDark);
  place(g, 0, 0.22, 0);
  return gradient(g, C.barkDark, C.barkPale);
}

/** Stump + fallen log + a rock: a whole forest-floor vignette.  (68 tris) */
export function deadwood() {
  const parts = [];
  parts.push(place(cyl(0.24, 0.30, 0.42, 6, C.barkDark), 0, 0.21, 0));
  const log = cyl(0.20, 0.23, 1.7, 6, C.bark);
  place(log, 0.95, 0.21, 0.55, Math.PI / 2, 0.5, 0);
  parts.push(log);
  parts.push(place(rock(0.32, 0, C.stone, 0.44, 12, true), -0.55, 0.14, 0.35));
  return merge(parts);
}

/* -------------------------------------------------------------- undergrowth */

/** Fern fronds around a low bush.  (16 tris) */
export function undergrowth() {
  const parts = [];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    const b = blade(0.34, 0.76, C.leaf, C.leafHi, 0.42, 1);
    place(b, Math.cos(a) * 0.12, 0, Math.sin(a) * 0.12, 0, a, 0.22);
    parts.push(b);
  }
  // The bush is a 40cm lump behind four fronds; 8 faces is all it ever showed.
  parts.push(gradient(place(blob(0.42, C.leaf), 0.40, 0.26, -0.3, 0, 0.6, 0, 1, 0.82, 1),
    C.leaf, C.leafHi));
  return merge(parts);
}

/**
 * Three tapered grass blades — the densest kit in the world, so it is also the
 * one where a triangle costs the most. Single-segment blades: at 0.5 units tall
 * and thirty metres from the camera nobody has ever seen the bend.  (6 tris)
 */
export function grassTuft() {
  const parts = [];
  for (let i = 0; i < 3; i++) {
    const a = i * 1.9;
    const b = blade(0.18, 0.54 + (i % 2) * 0.18, C.grass, C.grassHi, 0.30, 1);
    place(b, Math.cos(a) * 0.06, 0, Math.sin(a) * 0.06, 0, a, 0.16);
    parts.push(b);
  }
  return merge(parts);
}

/** Grass with three painted flower heads.  (32 tris) */
export function flowerTuft() {
  const parts = [];
  const petals = [C.petalB, C.petalC, C.petalD, C.petalA];
  for (let i = 0; i < 3; i++) {
    const a = i * 2.3;
    const b = blade(0.15, 0.46, C.grass, C.grassHi, 0.24, 1);
    place(b, Math.cos(a) * 0.07, 0, Math.sin(a) * 0.07, 0, a, 0.12);
    parts.push(b);
  }
  for (let i = 0; i < 3; i++) {
    const a = i * 2.1 + 0.7;
    const x = Math.cos(a) * 0.17, z = Math.sin(a) * 0.17;
    const h = 0.34 + (i % 2) * 0.12;
    const st = blade(0.045, h, 0x6ea83c, 0x8dc855, 0.10, 1);
    place(st, x, 0, z, 0, a + 1.2, 0);
    parts.push(st);
    // Bell-shaped: the cone is flipped, so its cap is the face you look down
    // on. It stays. Dropping a radial segment is the free saving here.
    parts.push(place(cone(0.13, 0.14, 3, petals[i]), x, h + 0.04, z, Math.PI, 0, 0));
  }
  return merge(parts);
}

/* --------------------------------------------------------------- wheat */

/**
 * Dense wheat cluster: tapered stalks topped with fat ears.  (24 tris)
 *
 * Six stalks, four of them eared. Combined with a tight footprint in props.js
 * the fields tiles read as a solid gold mass instead of sparse twigs on bare
 * sand. This is the most-instanced kit in the game after grass (472 of them),
 * so the ears are open cones: their base points at the sky-facing stalk top and
 * is covered by it, and each cap was costing the frame 1,400 triangles.
 */
export function wheatTuft() {
  const parts = [];
  for (let i = 0; i < 6; i++) {
    const a = i * 1.08;
    const r = 0.09 + (i % 3) * 0.055;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const h = 0.78 + (i % 3) * 0.16;
    // single-segment blades: 2 triangles each instead of 4, and at this size
    // the bend was never visible anyway
    const b = blade(0.19, h, C.wheat, C.wheatHi, 0.16, 1);
    place(b, x, 0, z, 0, a, 0.11);
    parts.push(b);
    if (i % 3 !== 2) {
      const ear = cone(0.13, 0.40, 3, C.wheatHi, 0, true);
      place(ear, x + 0.02, h + 0.06, z, 0, a, 0.14);
      parts.push(gradient(ear, C.wheat, C.wheatHi));
    }
  }
  return merge(parts);
}

/** One standing sheaf of a three-sheaf wheat node.  (33 tris) */
export function wheatSheaf() {
  const parts = [];
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const st = cyl(0.06, 0.09, 1.18, 3, C.wheat, true);
    place(st, Math.cos(a) * 0.13, 0.59, Math.sin(a) * 0.13,
      Math.sin(a) * 0.17, 0, -Math.cos(a) * 0.17);
    parts.push(gradient(st, C.wheat, C.wheatHi));
  }
  parts.push(place(cyl(0.26, 0.23, 0.13, 5, 0x9c6f2c, true), 0, 0.52, 0));
  parts.push(gradient(place(cone(0.38, 0.56, 5, C.wheatHi, 0, true), 0, 1.30, 0), C.wheat, C.wheatHi));
  return merge(parts);
}

/** (44 tris) */
export function hayBale() {
  const parts = [];
  const b = cyl(0.52, 0.52, 0.78, 8, C.hay);
  place(b, 0, 0.52, 0, 0, 0, Math.PI / 2);
  parts.push(gradient(b, C.hay, C.hayHi));
  parts.push(place(box(0.08, 1.06, 1.06, 0x8a6a2c), 0, 0.52, 0));
  return merge(parts);
}

/* ---------------------------------------------------------------- stone */

/** Pebble grade — 307 of them, none wider than half a metre.  (8 tris) */
export function smallRock(seed = 5) {
  return rock(0.36, 0, C.stone, 0.50, seed, true);
}

/** (28 tris) */
export function boulder(seed = 9) {
  const parts = [];
  // Lead stone keeps its 20 faces — boulders are a metre across and sit on the
  // waterline where they catch the eye. The companion chip goes low poly.
  parts.push(place(rock(0.88, 0, C.stone, 0.30, seed), 0, 0.60, 0));
  parts.push(place(rock(0.40, 0, C.stoneHi, 0.46, seed + 3, true), 0.78, 0.24, 0.32));
  return merge(parts);
}

/** Tall shard of rock for the mountain skyline.  (28 tris) */
export function spire() {
  const parts = [];
  const s = cone(0.62, 2.6, 6, C.slate);
  place(s, 0, 1.28, 0, 0.05, 0.4, 0.07);
  parts.push(gradient(s, C.slate, C.slateHi));
  parts.push(place(rock(0.50, 0, C.slate, 0.42, 21, true), 0.5, 0.24, -0.32));
  parts.push(place(rock(0.32, 0, C.slateHi, 0.42, 33, true), -0.46, 0.16, 0.36));
  return merge(parts);
}

/** One crystal-bearing chunk of a three-chunk ore seam.  (32 tris) */
export function oreRock() {
  const parts = [];
  parts.push(place(rock(0.50, 0, C.slate, 0.32, 41, true), 0, 0.34, 0));
  parts.push(place(rock(0.28, 0, C.slateHi, 0.40, 47, true), 0.44, 0.18, -0.20));
  const crystal = (x, y, z, r, h, c) => {
    const g = new THREE.OctahedronGeometry(r, 0);
    tint(g, c);
    place(g, x, y, z, 0.2, 0.6, 0.25, 1, h / r, 1);
    parts.push(g);
  };
  crystal(0.02, 0.62, 0.08, 0.16, 0.40, C.oreGlint);
  crystal(-0.26, 0.44, -0.10, 0.11, 0.26, C.gold);
  return merge(parts);
}

/* ----------------------------------------------------------------- clay */

/** Hill-country clay works: dug mound, brick pallet, plank.  (~88 tris) */
export function clayWorks() {
  const parts = [];
  parts.push(gradient(place(cone(0.72, 0.55, 7, C.clay), 0, 0.27, 0), C.clay, C.clayHi));
  parts.push(place(cyl(0.86, 0.94, 0.12, 7, 0x8a4322, true), 0, 0.06, 0));
  for (let r = 0; r < 2; r++) {
    for (let i = 0; i < 2; i++) {
      parts.push(place(box(0.42, 0.16, 0.22, r % 2 ? C.brick : C.brickHi),
        1.15 + i * 0.02, 0.09 + r * 0.17, -0.28 + i * 0.26, 0, r * 0.12, 0));
    }
  }
  parts.push(place(box(1.1, 0.06, 0.24, C.plank), 0.55, 0.03, 0.62, 0, 0.4, 0));
  return merge(parts);
}

/** One working of a three-working clay pit: hollow, spoil heap, brick. (37 tris) */
export function clayPit() {
  const parts = [];
  parts.push(gradient(place(cyl(0.46, 0.62, 0.24, 5, 0x8a4322), 0, 0.12, 0), 0x6f3419, C.clay));
  parts.push(gradient(place(cone(0.34, 0.42, 5, C.clayHi, 0, true), 0.58, 0.20, 0.30), C.clay, C.clayHi));
  parts.push(place(box(0.30, 0.13, 0.18, C.brick), -0.48, 0.07, 0.30, 0, 0.5, 0));
  return merge(parts);
}

/* ---------------------------------------------------------------- pasture */

/**
 * One sheep of a three-sheep flock. Three per pasture node means twenty-one
 * animals on a pasture tile and one of them bolting away every harvest cycle,
 * which is the whole point. At the play camera a sheep is about ten pixels
 * tall, so the ears and the icosphere fleece the old model carried were paying
 * for detail nobody could resolve.  (60 tris)
 */
export function sheep() {
  const parts = [];
  const body = ball(0.42, 0, C.wool);
  place(body, 0, 0.50, 0, 0, 0, 0, 1.25, 0.95, 0.95);
  parts.push(gradient(body, C.woolShade, C.wool));
  parts.push(gradient(place(blob(0.26, C.wool), -0.30, 0.64, 0.04), C.woolShade, C.wool));
  const head = blob(0.20, C.face);
  place(head, 0.56, 0.58, 0, 0, 0, 0.2, 1.1, 0.95, 0.85);
  parts.push(head);
  for (const [x, z] of [[0.28, 0.17], [0.28, -0.17], [-0.22, 0.17], [-0.22, -0.17]]) {
    parts.push(place(cyl(0.05, 0.045, 0.32, 3, C.face, true), x, 0.16, z));
  }
  return merge(parts);
}

/** (36 tris) */
export function fence() {
  const parts = [];
  parts.push(place(box(0.12, 0.92, 0.12, C.plankDark), -0.85, 0.46, 0));
  parts.push(place(box(0.12, 0.92, 0.12, C.plankDark), 0.85, 0.46, 0));
  parts.push(place(box(1.82, 0.11, 0.08, C.plank), 0, 0.66, 0, 0, 0, 0.02));
  return merge(parts);
}

/* -------------------------------------------------------------- man-made */

/** (60 tris) */
export function crateStack() {
  const parts = [];
  parts.push(place(box(0.54, 0.50, 0.54, C.plank), 0, 0.25, 0));
  parts.push(place(box(0.58, 0.06, 0.06, C.plankDark), 0, 0.25, 0.28));
  parts.push(place(box(0.40, 0.36, 0.40, C.plank), 0.16, 0.68, -0.10, 0, 0.6, 0));
  const barrel = cyl(0.24, 0.26, 0.56, 6, 0x7a4f2a);
  place(barrel, -0.62, 0.28, 0.30);
  parts.push(gradient(barrel, 0x5f3d20, 0x8a5a30));
  return merge(parts);
}

/** Timbered mine portal cut into the mountain rock.  (~156 tris, 3 instances) */
export function mineEntrance() {
  const parts = [];
  parts.push(place(box(0.26, 2.05, 0.30, C.plankDark), -0.95, 1.02, 0));
  parts.push(place(box(0.26, 2.05, 0.30, C.plankDark), 0.95, 1.02, 0));
  parts.push(place(box(2.5, 0.30, 0.42, C.plank), 0, 2.16, 0));
  parts.push(place(box(2.9, 0.20, 0.26, C.plankDark), 0, 2.42, -0.05, 0, 0, 0.03));
  parts.push(place(box(1.7, 1.95, 0.14, 0x120d09), 0, 0.98, -0.24));
  parts.push(place(box(1.5, 1.55, 0.12, 0x060404), 0, 0.80, -0.42));
  parts.push(place(rock(0.85, 0, C.slate, 0.34, 61), -1.55, 0.6, 0.1));
  parts.push(place(rock(0.95, 0, C.slate, 0.34, 62), 1.62, 0.7, 0.05));
  parts.push(place(rock(0.70, 0, C.slateHi, 0.34, 63), 0.1, 2.6, -0.1));
  parts.push(place(box(0.5, 0.34, 0.06, 0xe8d3a0), 1.2, 1.55, 0.28, 0, 0, -0.12));
  return merge(parts);
}

/** (~92 tris) */
export function oreCart() {
  const parts = [];
  const body = box(0.86, 0.46, 0.62, C.iron);
  parts.push(gradient(place(body, 0, 0.44, 0), C.iron, C.ironHi));
  parts.push(place(box(0.90, 0.07, 0.66, C.ironHi), 0, 0.68, 0));
  parts.push(place(ball(0.22, 0, C.ore), -0.06, 0.74, 0.0));
  for (const [x, z] of [[0.30, 0.33], [-0.30, 0.33], [0.30, -0.33], [-0.30, -0.33]]) {
    parts.push(place(cyl(0.16, 0.16, 0.07, 6, C.plankDark, true), x, 0.17, z, Math.PI / 2, 0, 0));
  }
  return merge(parts);
}

/** (60 tris) */
export function railSegment() {
  const parts = [];
  parts.push(place(box(0.09, 0.07, 2.2, 0x5a5f66), -0.32, 0.11, 0));
  parts.push(place(box(0.09, 0.07, 2.2, 0x5a5f66), 0.32, 0.11, 0));
  for (let i = -1; i <= 1; i++) {
    parts.push(place(box(0.92, 0.09, 0.20, C.plankDark), 0, 0.05, i * 0.72));
  }
  return merge(parts);
}

/** Stacked pit props for the mountain tiles.  (~70 tris) */
export function timberPile() {
  const parts = [];
  for (let i = 0; i < 3; i++) {
    parts.push(place(cyl(0.11, 0.11, 1.3, 5, C.plank, true), 0, 0.11 + i * 0.19, i * 0.05,
      Math.PI / 2, 0.1 * i, 0));
  }
  for (let i = 0; i < 2; i++) {
    parts.push(place(cyl(0.11, 0.11, 1.3, 5, C.plankDark, true), 0.24, 0.30 + i * 0.19, 0.1,
      Math.PI / 2, 0.3, 0));
  }
  parts.push(place(rock(0.28, 0, C.stone, 0.44, 71, true), -0.7, 0.13, 0.35));
  return merge(parts);
}

export default {
  conifer, coniferShort, broadleaf, heroTree, stump, deadwood,
  undergrowth, grassTuft, flowerTuft, wheatTuft, wheatSheaf, hayBale,
  smallRock, boulder, spire, oreRock, clayWorks, clayPit,
  sheep, fence, crateStack, mineEntrance, oreCart, railSegment, timberPile
};
