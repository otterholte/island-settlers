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
import {
  merge, place, gradient, ensureAttrs, box, cyl, cone, ball, blob, rock, blade
} from './geo.js';

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
 * Silhouette-defining volumes (hero canopies, the sheep, the ore stack) keep
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
 * were. They are now built to stand between 1.5 and 3.9 world units — the wheat
 * plant carries the top of that range, having been grown twice — and, more
 * important than height — each one is re-silhouetted so it is identifiable from
 * its OUTLINE alone at the twenty-odd pixels it actually draws at:
 *
 *   brick  a stepped stack of five fat terracotta bricks on a spoil mound
 *   wheat  a bound SHEAF: a flared golden drum with a dark twine band round it
 *   ore    the same stack in cool cut GREY stone, on an apron of spoil
 *   sheep  a plump, lumpy fleece on a dark leg block with the head held clear
 *
 * Nothing is round-and-grey twice, nothing is a cone twice. The triangle budget
 * is still brutal — these run 44 to 80 faces each and there are three hundred of
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

/*
 * The crop's own ramp: deep honey at the butt, saturated gold up the bundle,
 * and the bright end spent entirely on the ears.
 *
 * This has now been mixed four times and the lesson each time was the same one.
 * A fields hex stands on SAND — pale, warm, and lit by the same key light as
 * the crop on top of it — so any wheat colour with a lot of white in it lands
 * within a few per cent of the ground it is standing on and the whole hex reads
 * as one flat tan wash. The leaves are kept two full stops darker and more
 * saturated than the sand and the ears alone carry the highlight, which is what
 * puts a lit top edge on the crop and a readable silhouette under it.
 */
const WH_LO = 0x6a4609;
const WH_MID = 0xc08a14;
const WH_HI = 0xefbe37;
const WH_TOP = 0xffdc74;

/* The STUBBLE ramp — deliberately not the crop's. See `wheatTuft`. */
const WH_STUB_LO = 0x9c7a2e;
const WH_STUB_HI = 0xcfa855;

/**
 * One BOUND SHEAF — a bundle of hay standing on its butt end.  (~80 tris)
 *
 * "THE WHEATS ARE STILL WAY TOO SMALL AND POINTY AND THIN. GIVE THEM A
 *  DIFFERENT APPEARANCE — MAKE IT LOOK MORE LIKE BUNDLES OF HAY SO IT'S A LOT
 *  EASIER TO TELL WHERE THEY ARE AND HOW MANY THERE ARE LEFT TO PICK UP. I'M
 *  HAVING A HARD TIME QUICKLY IDENTIFYING WHERE THEY ARE EVEN AS I'M RUNNING
 *  AROUND THE HEX."
 *
 * The version this replaces was a STANDING PLANT: a wire stalk with sixteen
 * flat leaf cards paired up it and a cone on top. Three things were wrong with
 * it and all three were the same thing.
 *
 *   * It had no VOLUME. Sixteen flat cards at a hundred different angles never
 *     resolve into a mass — half of them are edge-on from any given camera, so
 *     the plant is a different, thinner shape every step you take around it.
 *   * It had no SHADOW worth the name, because it rode the double-sided grass
 *     material with casting off. An object with no shadow does not sit on the
 *     ground; it hovers in front of it, and on sand-coloured ground that is the
 *     difference between seeing it and not.
 *   * It could not be COUNTED. Twenty-two feathery plants brushing each other
 *     merge into one continuous field, which was the old brief and is exactly
 *     wrong for "how many are left to pick up".
 *
 * So it is now a SOLID, CLOSED, SHADOW-CASTING BUNDLE: butt ends fanned on the
 * ground, a pinched waist, a dark twine band round it, shoulders flaring up and
 * out, and a crown of six fat ears splaying off the top. Every surface of it is
 * a real volume — there is not one flat card left — so it reads as the same
 * chunky object from every bearing, it drops a hard shadow that pins it to the
 * sand, and at 1.6 units across with clear ground between neighbours you can
 * count them at a glance from the far side of the hex.
 *
 * Silhouette check: trees are conical and green, the ore is a stack of grey
 * cubes, the brick is a stack of red ones, the sheep is a white lump. Nothing
 * else on the island is a flared golden drum with a dark band round its middle.
 */
export function fieldWheat() {
  const parts = [];
  const S = 7;                          // radial segments — nobody counts them

  // The butt: the cut ends of the stalks fanning out where they meet the
  // ground. Wide at the floor so the bundle plants itself instead of balancing.
  parts.push(gradient(place(cyl(0.44, 0.64, 0.46, S, WH_LO, true), 0, 0.23, 0),
    WH_LO, WH_MID));

  // The waist, pinched in under the tie.
  parts.push(gradient(place(cyl(0.40, 0.46, 0.60, S, WH_MID, true), 0, 0.72, 0),
    WH_MID, WH_HI));

  // The twine. One dark band is the whole reason this reads as BOUND rather
  // than as a pile, and it is the only dark thing on the object.
  parts.push(place(cyl(0.45, 0.45, 0.17, S, 0x5c3f12, true), 0, 0.99, 0));

  // The shoulders: flaring up and out, and CLOSED on top — an open tube reads
  // as a hole in the object from the play camera's downward pitch.
  parts.push(gradient(place(cyl(0.80, 0.42, 1.02, S, WH_HI), 0, 1.57, 0),
    WH_MID, WH_HI));

  // A crown of ears splaying off the top: the one feature that says GRAIN
  // rather than BARREL, and the brightest thing on the object.
  for (let i = 0; i < 6; i++) {
    const a = i * 1.047 + 0.35;
    const r = 0.34 + (i % 3) * 0.16;
    const tilt = 0.30 + (i % 2) * 0.17;
    const ear = cone(0.17, 0.58, 4, WH_HI, 0, true);
    place(ear, Math.cos(a) * r, 2.18, Math.sin(a) * r,
      Math.sin(a) * tilt, a, -Math.cos(a) * tilt);
    parts.push(gradient(ear, WH_HI, WH_TOP));
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
 * A chunky, rounded, hard-facetted STONE.  (20 tris)
 *
 * `geo.js`'s `rock()` is not this shape and cannot be made into it. It jitters
 * every vertex of an already non-indexed polyhedron independently, so the three
 * copies of each shared corner walk apart and the result is a shattered spiky
 * thing — which is right for rubble and quite wrong for a boulder. Here the
 * offset is cached per CORNER, so all twenty faces stay welded and the stone
 * reads as one convex mass with big flat planes on it.
 *
 * Two more things make it a boulder rather than a ball:
 *   * `squash` flattens it on Y, so it is wider than it is tall;
 *   * `flatten` shears the underside off against a plane, so it SITS on the
 *     ground with its weight on a face instead of balancing on a point.
 */
function facetStone(r, rough, seed, squash = 0.80, flatten = 0.34) {
  // PolyhedronGeometry is already non-indexed: 20 faces, 60 vertices, flat
  // shaded by construction, which is exactly the painted-stone look.
  const g = new THREE.IcosahedronGeometry(r, 0);
  const p = g.attributes.position;
  const cache = new Map();
  let s = (seed * 2654435761) >>> 0;
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const floor = -r * flatten;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const key = `${Math.round(x / r * 2000)},${Math.round(y / r * 2000)},${Math.round(z / r * 2000)}`;
    let k = cache.get(key);
    if (k === undefined) { k = 1 + (rnd() - 0.5) * rough * 2; cache.set(key, k); }
    let ny = y * k * squash;
    if (ny < floor) ny = floor;
    p.setXYZ(i, x * k, ny, z * k);
  }
  g.computeVertexNormals();
  return ensureAttrs(g);
}

/**
 * One CUT STACK of ore stone.  (66 tris)
 *
 * "PLEASE MAKE THE ORE SHAPED MORE LIKE LARGE CUBES. OR STACKS OF STONES LIKE
 *  THE BRICK DOES, BUT GREY."
 *
 * What this replaces was a long jagged oval — four welded, hard-displaced lumps
 * strung along one axis with glacial-blue seams broken across their facets. It
 * was a handsome object and it had one fatal problem on the hex it lives on: a
 * mountain is MADE of jagged grey lumps. Spires, scree, boulders, rubble — every
 * one of them a broken angular stone, and the one thing on the tile the player
 * is allowed to take was a broken angular stone too. Darkening it two stops and
 * painting veins on it was an attempt to win an argument the SHAPE was losing.
 *
 * So the ore stops trying to look like better rock and takes the brick's answer
 * instead: a hard-edged STACK OF CUT BLOCKS on a low spoil apron, five of them,
 * every course laid across the one under it. There is not a single right angle
 * anywhere else on a mountain hex, so a cuboid mass on one is unmistakable from
 * any distance and in any light — the same trick that made the clay legible,
 * run in grey.
 *
 * The greys run COOL (0x6f7783 -> 0xa9b2be) against the warm pale stone of the
 * scenery boulders (0x7d7768 -> 0xa39c8b), and each block carries its own dark
 * foot so a stack of five never flattens into one silhouette. No seams, no
 * glints, nothing extra: the whole point of this pass is that the mountain hex
 * has less on it, not more.
 */
export function fieldOre() {
  const parts = [];

  // A low apron of spoil, so the stack sits IN the ground rather than on it.
  parts.push(gradient(place(cone(0.88, 0.36, 6, C.stoneDark, 0, true), 0, 0.17, 0),
    0x3f444c, 0x6d737d));

  // Five cut blocks, each course laid across the one below. `gradient` gives
  // every one of them its own dark foot and lit top, which is what keeps the
  // courses reading as separate stones instead of as one grey box.
  const blk = (w, h, d, x, y, z, ry, hi) => parts.push(
    gradient(place(box(w, h, d, hi), x, y, z, 0, ry, 0), 0x363b43, hi));
  blk(1.02, 0.46, 0.64, -0.02, 0.44, -0.26, 0.07, 0x8b939f);
  blk(0.88, 0.46, 0.60, 0.10, 0.44, 0.34, -0.19, 0x6f7783);
  blk(0.64, 0.44, 0.62, -0.29, 0.88, 0.02, 0.54, 0x99a2ae);
  blk(0.60, 0.44, 0.56, 0.31, 0.88, 0.05, -0.35, 0x7b838f);
  blk(0.62, 0.42, 0.58, 0.02, 1.29, -0.02, 0.26, 0xa9b2be);

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
  // Lower and narrower than it was. A cleared hex is supposed to read as EMPTY,
  // and far fewer of these are handed out now (see `stand.js` / `nodelife.js`),
  // so the ones that survive are a quiet mark on the ground rather than a
  // knee-high post you have to look past.
  const g = cyl(0.28, 0.39, 0.38, 5, C.barkDark);
  place(g, 0, 0.19, 0);
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
 * STANDING CROP between the sheaves — and, once the hex is worked, the stubble
 * that is left on it.  (8 tris)
 *
 * "MAKE THE WHEAT/HAY HEXES MORE EMPTY AND YET LOOK LIKE NON VISUALLY
 *  OVERSTIMULATING FARM LAND WHEN EMPTY. RIGHT NOW IT'S TOO MANY CONTRASTING
 *  DARK LINES AND ITEMS EVEN AFTER THE WHEAT IS GONE TO KNOW WHAT I'M LOOKING
 *  AT. IT'S JUST DISTRACTING."
 *
 * This kit is what a fields hex is MADE of when everything takeable has been
 * carried off, so it is the single thing that decides whether a worked field
 * reads as calm farmland or as noise. It used to be a knee-high copy of the old
 * standing plant: three stalks, six leaf cards and three bright ear cones each,
 * eighty-four to a hex — two hundred and fifty little high-contrast spikes left
 * standing on the ground after the crop was gone.
 *
 * It is now four soft blades in a muted straw that sits CLOSE to the sand it
 * grows out of. No ears, no dark honey at the root, no third of a shade of
 * contrast anywhere in it. Full, it is a warm mat of colour under the sheaves;
 * cropped (`stand.js` takes it down to a tenth of its height) it is a flat
 * wash on the ground with nothing sticking up out of it at all — which is the
 * "empty but still obviously a farm" the player asked for.
 */
export function wheatTuft() {
  const parts = [];
  for (let i = 0; i < 4; i++) {
    const a = i * 1.61 + 0.3;
    const r = 0.13 + (i % 2) * 0.12;
    const h = 0.70 + (i % 3) * 0.15;
    // single-segment blades: 2 triangles each, and at this size the bend was
    // never visible anyway
    const st = blade(0.30, h, WH_STUB_LO, WH_STUB_HI, 0.20, 1);
    place(st, Math.cos(a) * r, 0, Math.sin(a) * r, 0, a, 0.10);
    parts.push(st);
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
  return rock(0.30, 0, C.stone, 0.50, seed, true);
}

/**
 * Decorative grey stone.  (28 tris)
 *
 * Deliberately SMALLER than it used to be (lead stone 0.88 -> 0.72), and now
 * deliberately SMOOTH. The harvestable ore is a long jagged lump; the one thing
 * a jagged item cannot afford is a hex full of jagged scenery, so the backdrop
 * stone is built with `facetStone` — the same welded construction at a fifth of
 * the roughness, which comes out as a rounded dome with a handful of big calm
 * planes on it. Pale, unveined, domed, and comfortably under the item it stands
 * next to: the exact opposite reading in every axis that matters.
 */
export function boulder(seed = 9) {
  const parts = [];
  const lead = facetStone(0.72, 0.13, seed, 0.86, 0.30);
  gradient(lead, C.stoneDark, C.stoneHi);
  parts.push(place(lead, 0, 0.42, 0, 0, seed * 0.7, 0));
  parts.push(place(rock(0.33, 0, C.stoneHi, 0.34, seed + 3, true), 0.64, 0.20, 0.26));
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
