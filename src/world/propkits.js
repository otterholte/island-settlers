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
 * FIELD ITEMS — the things you actually pick up
 * ---------------------------------------------------------------------------
 * A hex is FULL of its resource: ten items on a 2/12 hex, twenty-two on a 6/8,
 * three hundred across the island. Every one of them is a separate instance you
 * can run at, take, and see missing afterwards.
 *
 * SIZE IS THE WHOLE POINT. The player's words:
 *
 *   "Make the bricks, wheat, ore and sheep all larger. I like how large the
 *    trees are. That's the idea. Right now they're so small it's like hard to
 *    tell it's even brick."
 *
 * The harvestable tree was the only item authored at hero scale; the other four
 * were half-metre trinkets sitting in grass that was nearly as tall as they
 * were. They are now built to stand between 1.5 and 2.5 world units, and — more
 * important than height — each one is re-silhouetted so it is identifiable from
 * its OUTLINE alone at the twenty-odd pixels it actually draws at:
 *
 *   brick  a stepped stack of five fat terracotta bricks on a spoil mound
 *   wheat  a bound sheaf, tied at the waist and flaring into a head of ears
 *   ore    a hero stone with three bright faceted crystals breaking out of it
 *   sheep  a plump, lumpy fleece on a dark leg block with the head held clear
 *
 * Nothing is round-and-grey twice, nothing is a cone twice. The triangle budget
 * is still brutal — these run 46 to 66 faces each and there are three hundred of
 * them — so every cap that faces away from a 50-degree downward camera is
 * dropped and filler volumes are 8-face octahedra.
 *
 * Every one stands on y = 0 with its mass centred on the origin, so an instance
 * matrix can punch it, spin it and collapse it about its own base.
 */

/**
 * One harvestable tree.  (19 tris)
 *
 * Painted a clear step LIGHTER and warmer than the decorative spruces it stands
 * among, so a hex of forty-five trees still separates into "the ones I can take"
 * and "the backdrop" at a glance.
 */
export function fieldTree() {
  const parts = [];
  parts.push(place(cyl(0.15, 0.24, 1.00, 4, C.barkPale, true), 0, 0.50, 0));
  parts.push(gradient(place(cone(0.86, 1.50, 6, C.needleMid, 0, true), 0, 1.34, 0),
    C.needleMid, C.needleHi));
  parts.push(gradient(place(cone(0.58, 1.20, 5, C.needleHi, 0, true), 0, 2.22, 0),
    C.needleHi, 0x86dc55));
  return merge(parts);
}

/**
 * One plump sheep of the flock.  (56 tris)
 *
 * Half again the size it used to be and a good deal rounder. The fleece is
 * three overlapping volumes rather than one, because a single smooth ellipsoid
 * reads as a white boulder and "exactly which sheep did I pick up" is not a
 * question a boulder can answer. The dark head is held out clear of the wool on
 * a short neck and the four legs are one dark block: at the size an item draws
 * at, a block under a white lump IS four legs, and it costs 12 faces instead of
 * 48.
 */
export function fieldSheep() {
  const parts = [];
  const body = ball(0.44, 0, C.wool);
  place(body, 0, 0.80, 0, 0, 0, 0, 1.24, 1.04, 1.10);
  parts.push(gradient(body, C.woolShade, C.wool));
  // rump and shoulder lumps break the outline into wool
  parts.push(gradient(place(blob(0.32, C.wool), -0.36, 0.90, 0.02, 0.3, 0.5, 0),
    C.woolShade, C.wool));
  parts.push(gradient(place(blob(0.27, C.wool), 0.28, 1.00, -0.02, 0, 0.9, 0.22),
    C.woolShade, C.wool));
  // a dark head held well clear of the fleece — the one feature that separates
  // a sheep from a rock at twenty pixels
  const head = blob(0.27, C.face);
  place(head, 0.62, 0.74, 0, 0, 0, 0.22, 1.18, 1.06, 0.86);
  parts.push(head);
  parts.push(place(box(0.68, 0.58, 0.42, C.face), 0.02, 0.30, 0));
  return merge(parts);
}

/**
 * One bound sheaf of wheat.  (46 tris)
 *
 * Not four loose blades any more — a STOOK: stalks gathered and tied at the
 * waist, flaring into a fat head of ears that is wider at the top than the
 * bundle is at the bottom. That hourglass is the silhouette, and it is the only
 * one in the field that gets wider as it goes up, so a wheat hex never reads as
 * anything else. Four loose ears break the crown so the outline is not a cone.
 */
export function fieldWheat() {
  const parts = [];
  // The bound stalks run a deep amber, not the bleached gold the ears wear:
  // a sheaf standing on pale sand needs its own dark value at the bottom or the
  // whole thing dissolves into the ground it grew out of.
  parts.push(gradient(place(cyl(0.38, 0.24, 1.02, 6, C.wheat, true), 0, 0.51, 0),
    0x7d5410, C.wheat));
  // the twine at the waist
  parts.push(gradient(place(cyl(0.30, 0.30, 0.18, 5, C.hay, true), 0, 0.32, 0),
    0x63481a, 0x9c7830));
  // The head of ears: a cone stood on its point, so the sheaf spreads as it
  // rises. Its cap now faces the sky and earns its six faces.
  const crown = cone(0.56, 1.02, 6, C.wheatHi);
  place(crown, 0, 1.50, 0, Math.PI, 0, 0);
  parts.push(gradient(crown, 0x9c6c17, C.wheatHi));
  for (let i = 0; i < 3; i++) {
    const a = i * 2.14 + 0.4;
    const ear = cone(0.17, 0.56, 3, C.wheatHi, 0, true);
    place(ear, Math.cos(a) * 0.30, 1.92, Math.sin(a) * 0.30, 0, a, (i % 2 ? 0.30 : -0.26));
    parts.push(gradient(ear, C.wheat, C.wheatHi));
  }
  return merge(parts);
}

/**
 * One stack of moulded bricks on its spoil heap.  (66 tris)
 *
 * The old kit was a 50cm mound with a pebble on it, and the player could not
 * tell it was brick at all. This is a chunky three-course STACK — five fat
 * terracotta blocks, every course laid across the one under it — standing on a
 * dug heap. Hard right-angled edges and a saturated red: the only cuboid mass
 * anywhere in the field, so it cannot be confused with an ore chunk or a sheep
 * even in silhouette.
 */
export function fieldClay() {
  const parts = [];
  parts.push(gradient(place(cone(0.64, 0.50, 6, C.clay, 0, true), 0, 0.24, 0),
    C.clay, C.clayHi));
  const brick = (x, y, z, ry, hi) => parts.push(
    place(box(0.94, 0.36, 0.44, hi ? C.brickHi : C.brick), x, y, z, 0, ry, 0));
  brick(0, 0.54, -0.25, 0, false);
  brick(0, 0.54, 0.25, 0, true);
  brick(-0.25, 0.90, 0, Math.PI / 2, true);
  brick(0.25, 0.90, 0, Math.PI / 2, false);
  brick(0.04, 1.26, 0.02, 0.24, true);
  return merge(parts);
}

/**
 * One crystal-bearing chunk of ore.  (52 tris)
 *
 * A hero stone at full 20-face resolution — it holds the silhouette and it is
 * twice the size it used to be — with a chip beside it and THREE tall faceted
 * crystals breaking out of the top in the bright glacial blue nothing else on
 * the island wears. The crystals are what say "ore" rather than "boulder": the
 * mountains are already full of grey rocks, and an item you cannot tell from
 * the scenery is an item you cannot decide to run at.
 */
export function fieldOre() {
  const parts = [];
  // A mountain hex is bare pale rock flour, so a mid-grey stone standing on it
  // is invisible. The seam runs a long way DARKER than the ground it sits on —
  // near-black at the base, gunmetal at the shoulder — which is what makes the
  // chunk a shape rather than a texture.
  // The ramp tops out at gunmetal, not at highlight grey: a mountain is looked
  // at from ABOVE, so the top of the chunk is the part that has to hold the
  // contrast, and the pale spires and boulders already dressing the hex are
  // exactly the thing it must not be mistaken for.
  parts.push(gradient(place(rock(0.62, 0, C.iron, 0.26, 41), 0, 0.54, 0),
    0x1e222a, 0x5a6472));
  parts.push(gradient(place(rock(0.38, 0, C.iron, 0.42, 47, true), 0.62, 0.24, 0.32),
    0x1e222a, 0x4a5260));
  const spike = (x, y, z, rx, ry, rz, r, tall) => {
    const g = new THREE.OctahedronGeometry(r, 0);
    tint(g, C.oreGlint);
    place(g, x, y, z, rx, ry, rz, 1, tall, 1);
    parts.push(gradient(g, 0x1f9ec4, 0xbdf4ff));
  };
  spike(-0.04, 1.12, 0.02, 0.10, 0.60, 0.14, 0.31, 2.35);
  spike(0.34, 0.96, -0.20, 0.26, 1.10, -0.42, 0.22, 2.10);
  spike(-0.36, 0.90, 0.24, -0.20, 0.30, 0.46, 0.18, 1.90);
  return merge(parts);
}

/**
 * What a felled tree leaves behind — a pale sawn top on a dark stump. (20 tris)
 *
 * There are now up to 224 of these (every harvestable sub-unit AND every
 * decorative tree that can be felled), so the radial segment count is down to
 * five: a worked-out forest tile carries fifty-odd of them at maybe fifteen
 * pixels across, and nobody has ever counted the sides of one.
 */
export function stump() {
  const g = cyl(0.34, 0.46, 0.54, 5, C.barkDark);
  place(g, 0, 0.27, 0);
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

/* ---------------------------------------------------------------- pasture */
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
  conifer, coniferShort, broadleaf, stump, deadwood,
  undergrowth, grassTuft, flowerTuft, wheatTuft, hayBale,
  smallRock, boulder, spire, clayWorks, fence,
  fieldTree, fieldSheep, fieldWheat, fieldClay, fieldOre,
  crateStack, mineEntrance, oreCart, railSegment, timberPile
};
