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
  merge, place, tint, gradient, ensureAttrs, box, cyl, cone, ball, blob, rock, blade
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
 *   2. Filler volumes — the blob inside a fern, the rock in a deadwood
 *     vignette, a pebble at half a metre across — use the 8-face `blob` / low
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
  // Amber, not straw. A bale is the only prop left on a worked-out pasture and
  // it has to separate from 0x8fce56 turf; the old gold sat at the same value
  // as the grass and only a hue apart, which reads as nothing at all from the
  // play camera. See `hayBale`.
  hay:     0xd99a34, hayHi: 0xf6c96a,
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
 * What a felled tree leaves behind — a short barked trunk with a pale SAWN
 * FACE on top of it.  (36 tris)
 *
 * "THE STUMPS ARE FLAT BROWN PENTAGONAL LUMPS WITH NO CUT FACE, NO BARK AND NO
 *  TAPER, AND AT PLAY DISTANCE READ AS MUD CLODS."
 *
 * That is exactly what the old kit was, and every word of it follows from how
 * it was built: one five-sided cylinder 0.38 tall against 0.39 wide, painted
 * bark-dark at the bottom and bark-pale at the top by a vertical gradient. A
 * gradient cannot draw a cut face, because the top RIM of the cylinder and the
 * top CAP of it land on the same gradient value — so the disc you look straight
 * down on from a 50-degree camera was the same colour as the sides, and the
 * whole thing collapsed into one flat brown pentagon with nothing on it to say
 * which way was up. Wider than it was tall finished the job: a squat pentagon
 * lying on brown duff is a clod of earth.
 *
 * Three changes, and each one answers a clause of that sentence.
 *
 *   A CUT FACE. The pale sawn top is now its own piece of geometry — a shallow
 *   disc sitting proud of the trunk in end-grain cream — rather than the top
 *   end of a ramp. It is the brightest thing on the object by a wide margin and
 *   it is the face the play camera looks most directly at, so a stump now reads
 *   as a stump from the one angle the game actually shows it at.
 *
 *   BARK. The trunk keeps its own dark-to-mid ramp with the pale value spent
 *   entirely on the cut, so the sides stay woody and the top stays sawn. The
 *   two no longer average into one mid-brown.
 *
 *   TAPER AND HEIGHT. 0.24 at the cut against 0.34 at the root, standing 0.56
 *   rather than 0.38 — taller than it is wide, so it stands UP out of the
 *   ground instead of lying on it, and the flare at the foot reads as roots.
 *
 * Six radial segments rather than five: at the count these are handed out at
 * now (three or four a hex — see `nodelife.js`) the triangles are affordable,
 * and an odd-sided prism has a corner pointing at the camera, which is a good
 * part of why the old one looked like a lump rather than a log.
 */
export function stump() {
  const parts = [];
  // The trunk. Bottom cap dropped — it is buried, and nothing ever sees it.
  const trunk = cyl(0.24, 0.34, 0.56, 6, C.barkDark, true);
  place(trunk, 0, 0.28, 0);
  parts.push(gradient(trunk, 0x2c1d10, C.bark));
  // The sawn face: end grain, a clear step lighter and yellower than any bark
  // on the island, standing a fraction proud of the trunk so it catches its own
  // rim of light instead of being flush with the sides.
  const cut = cyl(0.25, 0.25, 0.07, 6, C.barkPale);
  place(cut, 0, 0.575, 0);
  parts.push(gradient(cut, 0xa8763f, 0xe0bb84));
  return merge(parts);
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

/**
 * One round bale lying on its side.  (44 tris)
 *
 * THIS KIT NO LONGER STANDS ON A PASTURE AT ALL.
 *
 *   "Just please remove the hay bales from the sheep hexes entirely."
 *
 * It lives on the WHEAT FIELD now and nowhere else — two of them, hand-placed in
 * `props.js` — which is the hex where a bale is the harvest rather than a thing
 * somebody carted in to feed the sheep. The size and the colour below were both
 * driven by the paddock, and they are kept exactly as they are: an amber drum
 * separates from ploughed ochre for the same reasons it separated from turf,
 * and a bale that survives the number token on one hex survives it on the other.
 * The paragraphs below are the record of how they were arrived at.
 *
 * "ENLARGE THE HAY BALE AND WARM ITS COLOUR SO IT SEPARATES FROM THE GRASS."
 *
 * The bale was, at the time, the only thing standing on an emptied pasture
 * besides two fence panels, so it carried the whole "this is a paddock" read on
 * its own — and at 1.04 across in a straw gold it was losing that job twice
 * over. It was too small to survive the flag and the number token that stand
 * near the middle of every hex, and 0xd6ae57 against the pasture's 0x8fce56 turf
 * is a hue shift of about thirty degrees at almost identical value, which is the
 * one kind of colour difference that vanishes at distance.
 *
 * The drum goes 1.04 to 1.24 across and 0.78 to 1.06 along its axis, and the
 * instance scale over in `props.js` goes 0.80..1.25 to 1.05..1.30 with it: on
 * the ground that is a bale 1.34 to 1.66 units tall where the old one ran 0.83
 * to 1.30, so the SMALL end of the range — which is where it kept disappearing
 * — is up by more than half.
 *
 * The gold is pushed a clear step toward AMBER — warmer, deeper and more
 * saturated, so it separates from yellow-green turf on value and chroma rather
 * than on hue alone. The binding band goes darker with it: two dark hoops round
 * a warm drum is the silhouette that says BALE and not, say, a boulder catching
 * the sun.
 */
export function hayBale() {
  const parts = [];
  const b = cyl(0.62, 0.62, 1.06, 8, C.hay);
  place(b, 0, 0.60, 0, 0, 0, Math.PI / 2);
  parts.push(gradient(b, C.hay, C.hayHi));
  parts.push(place(box(0.11, 1.28, 1.28, 0x6f4d1c), 0, 0.60, 0));
  return merge(parts);
}

/* ---------------------------------------------------------------- stone */

/** Pebble grade — 307 of them, none wider than half a metre.  (8 tris) */
export function smallRock(seed = 5) {
  return rock(0.30, 0, C.stone, 0.50, seed, true);
}

/**
 * Decorative grey stone.  (20 tris)
 *
 * IT NO LONGER STANDS ON A BRICK HILL, which is the hex the last three passes
 * shaped it for.
 *
 *   "Also remove the small rocks from the brick hexes, instead have a small
 *    shovel."
 *
 * The hills hex now carries grass, the quarry and one `shovel`, and nothing
 * else. This kit is kept because two other places still use it and neither is a
 * hex that grows anything: the DESERT, which holds the market and needs a
 * couple of shapes on it so it is not a blank tan disc, and the SHORELINE
 * COLLAR in `props.js`, where a lead boulder with a huddle of `smallRock`
 * around it is what breaks the dead-straight seam between the sand and the sea.
 * The geometry below is left exactly as the reviewer signed it off.
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
  // THE SATELLITE SHARD IS GONE.
  //
  //   "Remove the satellite shards parked beside the big stones — keep one
  //    clean stone each."
  //
  // Every stone on a brick hill came with a 0.33-unit chip welded to its side
  // at a fixed bearing, so four stones put four small jagged offcuts on the
  // ground as well, always in the same relationship to their parent. That is
  // the "crumbs" reading the player used about this hex arriving by the back
  // door: the four stones themselves were sized up until they read as scenery
  // (which the reviewer liked and this pass does not touch), and the chips
  // beside them stayed at pebble grade. One clean domed stone reads as a stone.
  // A stone with a chip beside it reads as debris, and it reads as debris four
  // times over on a hex that is supposed to be quiet.
  //
  // The shoreline collar in `props.js` scatters its own `rockSmall` around each
  // lead boulder, so the rock CLUSTERS on the waterline — which are supposed to
  // look like rubble — lose nothing at all here.
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

/**
 * A flat octagonal ANNULUS lying in the ground plane.
 *
 * `cyl` and `cone` between them cannot build a pit, and it took two passes to
 * see why. Every wall this toolkit makes is a closed tube whose faces point
 * OUTWARD, so from the play camera you only ever see its NEAR arc — the far
 * arc's normals point away from the lens and it is back-face culled. Three
 * nested open tubes are therefore not a terraced pit; they are three bright
 * crescents with the hex floor showing between them, which is precisely the
 * report on the last version:
 *
 *   "From ph-hills-2-empty.png the pit currently looks like a thin cream
 *    crescent rather than a dug pit."
 *
 * A pit needs two things a tube cannot give: horizontal SHELVES you look down
 * onto, and inner walls that face INWARD. This makes the shelves; `inward()`
 * below makes the walls.
 *
 * `hexOut` turns the shelf into a RADIAL RAMP, and it exists because of this:
 *
 *   "let the well on the brick hexes not have so much contrast, let it blend in
 *    a bit more."
 *
 * A ring plate flooded with one colour is a HARD BAND — it starts and stops on
 * a geometric edge, so however carefully the value is chosen the eye reads the
 * two edges before it reads the shelf. `gradient()` cannot help: every vertex
 * of this plate is at the same y, so a vertical ramp paints it flat. The
 * annulus's vertices sit on exact radii by construction, so ramping on radius
 * gives a shelf that is turned earth at the lip and hillside by the time it
 * reaches its own outer edge — which is what makes it read as ground somebody
 * has dug rather than as a painted ring laid on top of the hex.
 */
function ringPlate(rInner, rOuter, seg, hex, hexOut) {
  const g = new THREE.RingGeometry(rInner, rOuter, seg, 1);
  g.rotateX(-Math.PI / 2);
  ensureAttrs(g);
  if (hexOut === undefined) return tint(g, hex);
  const pos = g.attributes.position.array;
  const col = g.attributes.color.array;
  const a = new THREE.Color(hex), b = new THREE.Color(hexOut);
  const span = (rOuter - rInner) || 1;
  for (let i = 0; i < g.attributes.position.count; i++) {
    const r = Math.hypot(pos[i * 3], pos[i * 3 + 2]);
    const t = Math.min(1, Math.max(0, (r - rInner) / span));
    col[i * 3] = a.r + (b.r - a.r) * t;
    col[i * 3 + 1] = a.g + (b.g - a.g) * t;
    col[i * 3 + 2] = a.b + (b.b - a.b) * t;
  }
  g.attributes.color.needsUpdate = true;
  return g;
}

/**
 * Turn a tube inside out: reverse every triangle's winding and flip its
 * normals, so what the camera sees is the INSIDE of the wall. This is the only
 * way to look across a hole at the far bank of it and see lit clay rather than
 * straight through to the hex floor behind.
 */
function inward(g) {
  ensureAttrs(g);
  const idx = g.index.array;
  for (let i = 0; i < idx.length; i += 3) {
    const t = idx[i]; idx[i] = idx[i + 2]; idx[i + 2] = t;
  }
  const n = g.attributes.normal.array;
  for (let i = 0; i < n.length; i++) n[i] = -n[i];
  g.index.needsUpdate = true;
  g.attributes.normal.needsUpdate = true;
  return g;
}

/**
 * The clay quarry: a shallow terraced PIT dug into the hillside.  (64 tris)
 *
 * "IT READS AS A SANDCASTLE WITH TWO FLOATING FLOOR TILES. MAKE IT READ AS A
 *  SHALLOW CUT STEP OR TERRACED PIT WITH ONE CLAY BLOCK BESIDE IT, AND DELETE
 *  THE FLOATING SLABS."
 *
 * The sandcastle was a 0.55-unit terracotta CONE — the same seven-sided cone
 * the game uses for a conifer skirt and for the spoil apron under an ore stack
 * — sitting on a pallet disc. Read it as a landmark and it is a sandcastle;
 * read it as ground and it is a molehill. It was never going to be either of
 * the two things a quarry actually is: a hole, or a face cut into a slope.
 *
 * THE BLOCK OF DUG CLAY IS GONE, AND IT WAS THE WHOLE JOB IN A NEW PLACE.
 *
 *   "The quarry's decorative clay slab is the same salmon material, the same
 *    size and the same block silhouette as the pickable bricks sitting a few
 *    pixels away, and it is still standing after every collectable on the hex
 *    has been taken."
 *
 * That is the phantom-tree complaint word for word, in terracotta. The block
 * was a 0.70 x 0.46 x 0.52 cuboid painted 0x9d3f20 -> 0xef9264; a course of a
 * harvestable brick stack (`fieldClay`) is a 0.94 x 0.36 x 0.44 cuboid painted
 * C.brick -> C.brickHi. Same family, same size band, same hard right angle,
 * standing three units from twenty-three of the real thing — and because it is
 * baked scenery it was still there when the hex had nothing left to take. The
 * one cue that was supposed to tell them apart, "the brick stack is a tower and
 * this is a single block", is no cue at all when the tower's top course is
 * exactly this block seen against the same mud.
 *
 * Nothing replaces it. The report's own last option — "drop it entirely and let
 * the pit rim carry the read" — is the right one, because the pit can now carry
 * it: there is not one right angle, not one saturated red and nothing standing
 * more than 0.56 units off the ground anywhere in this kit. It is a hole. You
 * cannot pick up a hole.
 *
 * WHAT IT IS NOW. A spoil bank thrown up around a two-step cut: a bright ring
 * of dry turned earth at the lip, an inward-facing wall dropping away from it,
 * and a wide wet floor at the bottom that is by a distance the darkest value on
 * the hill. Read from above that is a bright ring, a shadowed bank and a dark
 * middle, which is what an eye reads as a hole.
 *
 * Rejected AGAIN: cutting the hole out of the terrain itself. The tile top
 * carries +-0.19 of painted undulation (`topNoise` in terrain.js), the kit is
 * placed by a scorer that cannot know the local gradient, and `heightAt` is the
 * shared field every other agent's roads and buildings sit on. Instead the
 * outer skirt now runs half a unit BELOW the kit's own origin, so whatever the
 * ground does under it the bank is buried into the hillside rather than sitting
 * on it with daylight along one edge — which is the other half of why the last
 * version photographed as a crescent.
 *
 * AND NOW IT IS QUIET.
 *
 *   "let the well on the brick hexes not have so much contrast, let it blend in
 *    a bit more."
 *
 * The pit worked and it worked far too loudly. Measured across the four clay
 * captures the lip peaked at luma 141-158 and the bore bottomed out at 5-15, on
 * a tile whose ground never leaves 60-79 — so one prop about a seventh of the
 * hex across carried the whole tonal range of the frame, twice over: 1.9x
 * brighter than the hillside at its rim and a fifth of it at its floor. From
 * the wide shot that is not a quarry, it is a black dot with a chalk ring drawn
 * round it. Every value below is re-derived against the ONE number that
 * matters, which is what the hillside itself prints at:
 *
 *   hillside beside the pit                   renders 60-69
 *   lip, was      albedo 0xdda173 (luma 174) -> rendered 141-158    2.2x ground
 *   lip, now      albedo 0xa85e35 (luma 111) -> renders  89-93      1.4x
 *   bore, was     albedo 0x2e1409 (luma  27) -> rendered 5-15       0.2x
 *   bore, now     albedo 0x714325 (luma  77) -> renders  36-42      0.6x
 *
 * Everything here is measured off a CLOSE framing of a worked-out hills hex
 * (`--stage=sweep --terrain=hills --phase=b --dist=13 --fov=30`), because at
 * the sweep's ordinary 22-unit distance the whole kit is fifty pixels across
 * and the lit arc of the lip never gets a pure pixel — antialiasing flatters it
 * by twenty luma either way and the numbers stop meaning anything. At the
 * ordinary distance this same build reads about 70 against a ground of 80,
 * which is the "blend in a bit more" the owner asked for.
 *
 * Three other things come down with the numbers.
 *
 *   THE LIP IS A RAMP, NOT A BAND. It is painted radially now (see
 *   `ringPlate`), from turned earth at the bore to the hillside's own value at
 *   its outer edge, so the shelf has no lit outer edge left to draw a circle
 *   with. That is the whole of "blend in a bit more": a hard band of ANY value
 *   is a drawn ring, and the eye finds the two edges before it finds the shelf.
 *
 *   THE BANK IS LOWER. 0.46 to 0.30, which takes a third off the height of the
 *   little drum the kit stands as and with it a third of the cast shadow that
 *   was ringing the outside of it.
 *
 *   IT IS TWELVE-SIDED, NOT EIGHT. "A crisp hard-edged octagonal ring" was in
 *   the report and it is fair: eight segments on a 2.7-unit object is a corner
 *   every 20 screen pixels, and a polygon you can count the sides of reads as a
 *   drawn shape rather than as dug ground. Twelve costs 32 triangles on a kit
 *   that exists three or four times on the whole island.
 */
export function clayWorks() {
  const parts = [];
  // The spoil bank, seen from outside the pit. It starts at -0.52 so terrain
  // undulation can never leave a lit edge hanging in the air on the downhill
  // side or swallow the bank on the uphill one. Its top now lands within a few
  // per cent of the hillside rather than a stop and a half over it, so the
  // outside of the pit no longer draws a bright circle on the tile.
  parts.push(gradient(place(cyl(1.20, 1.42, 0.82, 12, C.clay, true), 0, -0.11, 0),
    0x8a472a, 0xa85c33));
  // The lip: the shelf of dry turned earth you look down onto. Turned earth at
  // the bore, hillside by the time it reaches its own rim — a graded dirt ring
  // rather than a painted one. Widened inward from 0.96 to 0.86 so the ramp has
  // room to be a ramp.
  //
  // Both ends are set against what the HILLSIDE prints at rather than against
  // what a clay palette entry looks like on paper, and the two are a long way
  // apart: a prop's lit top face transfers about 0.87 of its albedo luma while
  // the terrain under it transfers about 0.46 of its own, so a kit painted "the
  // same colour as the ground" photographs nearly twice as bright as the
  // ground. That single fact is most of why every version of this thing has
  // come out shouting. 0xa85e35 lands the lit arc at 89-93 against a hillside
  // of 60-69 — the report's "luma ~85-95" — and 0x7c4527 lands the outer edge
  // at about 66, which is the hillside itself, so the shelf has no edge left to
  // draw a circle with.
  parts.push(place(ringPlate(0.86, 1.20, 12, 0xa85e35, 0x7c4527), 0, 0.30, 0));
  // The bank of the cut, facing INWARD so the far side of the pit is a lit
  // slope rather than a hole through to the hex floor.
  //
  // IT IS A BEVEL NOW AND NOT A WALL, and that is the last of the report's
  // "luma 5 to 158". A near-vertical inward face has a horizontal normal, and a
  // horizontal normal on the arc turned away from the key light catches nothing
  // at all: the old 0.30-tall wall photographed at luma 9-11 down one side
  // whatever it was painted, because 14% of an albedo is 14% of an albedo and
  // no colour available in this palette gets 14% of itself up to 35. Sloped at
  // 36 degrees off horizontal the same band is a shelf rather than a cliff, its
  // normal points mostly at the sky, and it lands in the same range as the
  // floor it runs down to. Shallower with it — 0.30 of drop becomes 0.18 —
  // which is the difference between a shaft and a scrape, and a scrape is what
  // "blend in a bit more" is asking for.
  parts.push(gradient(inward(place(cyl(0.86, 0.58, 0.18, 12, 0x8a4322, true), 0, 0.21, 0)),
    0x86502f, 0xa85f37));
  // The floor. Still the darkest value on the hill and no longer a hole punched
  // in it: 1.16 units across, a damp dug brown that renders at 36-42 against a
  // hillside of 60-69 — three fifths of the ground, where it used to be a
  // fifth.
  parts.push(place(ringPlate(0.0001, 0.58, 12, 0x714325), 0, 0.12, 0));
  return merge(parts);
}

/**
 * A small shovel left stuck in the ground beside the quarry.  (60 tris)
 *
 * "ALSO REMOVE THE SMALL ROCKS FROM THE BRICK HEXES, INSTEAD HAVE A SMALL
 *  SHOVEL."
 *
 * What it replaces is the two or three decorative stones, and the brief for what
 * takes their place is narrow enough to be worth writing down before the
 * geometry: it has to READ as a shovel at play distance, it has to be small
 * enough that the quarry is still obviously the landmark on the hex, and it has
 * to sit in the quarry's own muted earth palette so it blends into the dug
 * hillside instead of popping off it.
 *
 * THE SILHOUETTE. Three features and no more, because at the play camera's 22
 * units this whole kit is about thirty pixels tall and a fourth feature is just
 * a smudge: a BLADE half buried in the clay, a SHAFT, and a T-GRIP across the
 * top. The grip is what does the work — a bare stick in the ground is a stick,
 * and a stick with a crossbar on it is a tool — and the whole assembly is CANTED
 * 0.42 radians off vertical, which is the difference between something planted
 * and something left. Everything is built along that tilted axis rather than
 * built upright and rotated afterwards, so the blade meets the ground on the
 * slant and the shaft has no kink in it where the socket is.
 *
 * IT IS NOT A BRICK, AND THAT IS THE PART THAT IS NOT NEGOTIABLE.
 *
 *   "The quarry's decorative clay slab is the same salmon material, the same
 *    size and the same block silhouette as the pickable bricks sitting a few
 *    pixels away."
 *
 * That report is why the quarry's cut-clay block was deleted, and every line of
 * it applies to anything else put on this hex. So:
 *
 *   COLOUR — nothing here is in the terracotta family at all. The blade is a
 *   near-neutral weathered iron and the shaft is a drab olive-brown timber,
 *   against C.brick 0xc0562f / C.brickHi 0xdd7c4f, which are saturated red
 *   oranges. Muted, though, not grey-and-bright: the values below are set the
 *   same way the quarry's were, against what the HILLSIDE prints at rather than
 *   against how the swatch looks on paper. A prop's lit face transfers about
 *   0.87 of its albedo luma, so the blade's high stop 0x746e63 (luma 111) would
 *   land near 96 on a bare hillside of 60-69 — and that arithmetic is where the
 *   swatches came from, but it is NOT what the tool prints at, which is worth
 *   saying out loud rather than leaving as an assumption for the next pass to
 *   inherit. `mood.js` repaints every surface on a hex afterwards according to
 *   who owns it and whether it has been worked out, and on a spent hill it
 *   mixes the lot about 65% toward the terrain's own ink at each surface's own
 *   luminance. So the number was measured instead, off a close framing of a
 *   worked-out hill — `--stage=sweep --terrain=hills --phase=b --hud=0
 *   --park=1 --dist=13 --fov=30`, the same way the quarry's own values were
 *   taken, because at the sweep's ordinary 22 units this whole kit is thirty
 *   pixels tall and antialiasing decides the answer:
 *
 *     open hex floor beside it              median 75   (spread 56-104)
 *     the whole quarry, brightest pixel             72   0.96x the floor
 *     this shovel, brightest lit face               70   0.93x the floor
 *
 *   On a LIVE owned hill the same three faces read 98 to 125 against a hex floor
 *   of 160 to 180 — the ownership glow lifts the ground far more than it lifts
 *   the tool, so the gap is wider there, not narrower.
 *
 *   The bar was the quarry — "let the well on the brick hexes not have so much
 *   contrast, let it blend in a bit more" — and this sits a hair under it and a
 *   hair under the ground as well, in both moods. It is never the one thing a
 *   prop standing beside the hex's only landmark may not be, which is the
 *   brightest object on the hill.
 *
 *   SILHOUETTE — a brick stack is a stepped tower about a unit wide with a hard
 *   right angle on every course. This is a stick a fifth of a unit thick leaning
 *   over at 24 degrees. There is no framing in which one is the other.
 *
 *   SIZE — 1.27 units tall at unit scale and instanced at 0.84..0.94, so it
 *   stands about 1.1 on the ground. A brick stack is a 1.5-to-2.3-unit tower and
 *   the quarry is a 2.7-unit working; the shovel is under both, which is what
 *   "a SMALL shovel" has to mean in numbers on a hex that already has its one
 *   landmark. It is not smaller than the stones it replaces, though, and that is
 *   deliberate: those ran 0.85 to 1.25 and were called scenery rather than
 *   crumbs, so that band is the floor under "small" as well as the ceiling.
 *
 * One per hill, and placed against the quarry rather than scattered — see the
 * hills block in `props.js`.
 */
export function shovel() {
  /*
   * TWICE THE SIZE, AND ORDINARY SHOVEL COLOURS.
   *
   *   "Make the shovel 2x the size and normal shovel colors."
   *
   * The first version was built to a "small shovel" brief and to a rule this
   * file had been following all job — nothing on a resource hex may be brighter
   * than the ground it stands on — so it came out as a weathered-iron and drab
   * timber tick about seventeen pixels tall at the play camera. That is a
   * defensible object and it was the wrong one: at that size and that value it
   * reads as a smudge beside the quarry rather than as a tool somebody left
   * there, and the owner said so on sight.
   *
   * So the blade is steel and the handle is wood — the colours anyone would
   * draw if you asked them for a shovel — and the instance scale doubles in
   * `STYLE.shovel`. The low-contrast rule still governs the QUARRY, which is a
   * hole in the ground and belongs to the terrain; it does not govern a
   * man-made object lying on top of it, and the distinction is the point: the
   * steel is the only bright thing on a worked-out clay hex, which is exactly
   * what makes it findable without the hex becoming busy.
   *
   * The geometry below is unchanged. Doubling happens at the instance, not in
   * the kit, so the proportions the blade/tread/socket/shaft/grip were tuned to
   * are preserved and only `FOOT.shovel` had to follow (see props.js).
   */
  const parts = [];
  // The cant, and the axis it is measured along. A rotation of T about Z sends
  // the model's local +Y to (-sin T, cos T), so a piece whose centre sits `d`
  // along the shaft goes at (ax(d), ay(d)) carrying the same rz — which is how
  // the blade, the socket, the shaft and the grip end up on one straight line
  // instead of on a staircase.
  const T = 0.42;
  const ax = d => -Math.sin(T) * d;
  const ay = d => Math.cos(T) * d;

  // The blade, driven into the clay: its lower end runs to d = -0.16, which is
  // about 0.15 below the hex floor, so the shovel is IN the ground rather than
  // standing on it. Flat — 0.085 thick against 0.36 wide — because a blade with
  // any depth to it reads as a block, and a block is the one thing this hex may
  // not have another of.
  parts.push(gradient(place(box(0.36, 0.52, 0.085, 0xb9c0c8), ax(0.10), ay(0.10), 0, 0, 0, T),
    0x8f979f, 0xd2d8de));
  // The tread: the little flange along the blade's top edge you put a boot on.
  // Deeper than the blade and no wider, so from the play camera it is one extra
  // horizontal tick halfway down the tool — which is the cue that says the lower
  // half is a blade and not just the buried part of the stick.
  parts.push(place(box(0.34, 0.07, 0.155, 0xa2aab2), ax(0.35), ay(0.35), 0, 0, 0, T));
  // Socket and shaft, both open-ended: the socket's caps are inside the blade
  // and the shaft's are inside the socket and the grip, so twenty triangles of
  // the kit are faces no camera in this game can reach.
  parts.push(gradient(place(cyl(0.070, 0.105, 0.20, 6, 0x979fa7, true), ax(0.44), ay(0.44), 0, 0, 0, T),
    0x7d858d, 0xacb4bc));
  parts.push(gradient(place(cyl(0.050, 0.070, 0.84, 6, 0xc08a4e, true), ax(0.94), ay(0.94), 0, 0, 0, T),
    0x9a6b39, 0xd8a266));
  // The T-grip. 0.28 across against a 0.10 shaft — three times the width, which
  // is the least that still registers as a crossbar once the whole tool is
  // thirty pixels tall.
  parts.push(place(box(0.28, 0.075, 0.085, 0xb07f47), ax(1.34), ay(1.34), 0, 0, 0, T));
  return merge(parts);
}

/* ---------------------------------------------------------------- pasture */

/**
 * One panel of paddock fence: two posts and three rails.  (60 tris)
 *
 * "MAKE FENCE PANELS VISIBLY LARGER — TALLER POSTS, 3 RAILS RATHER THAN 2 —
 *  AND KEEP THEM OFF THE HEX RIM WHERE THEY MERGE WITH THE BORDER."
 *
 * There are only two or three of these on a whole pasture now (which the
 * reviewer liked and this pass keeps), and that is exactly why the panel itself
 * had to grow: two or three of anything have to be legible on their own,
 * because there is no run of them to read as a line. A 0.92 post with ONE rail
 * across it is a hurdle at a sheep's knee — from the play camera it is a single
 * horizontal dash, and a single dash lying along the tan border strip is
 * indistinguishable from the border.
 *
 * Posts go to 1.34 and thicken to 0.15, and the one rail becomes three at 0.40,
 * 0.78 and 1.16 — so the panel is a LADDER, which has an internal rhythm the
 * border strip does not, and it stands over the flock rather than under it. The
 * middle rail is a hair thinner than the top and bottom ones: three identical
 * bars read as a printed grille, and the small break in weight is what keeps it
 * looking built.
 *
 * Where it stands moved too, and that is in `props.js`: the panels used to ride
 * hexFrac 0.78 and 0.70, and 0.78 is the outermost row of the prop zone with
 * the tan road strip starting at 0.81 — a dark plank laid directly along a dark
 * border line at a shallow camera angle merges into it completely. They sit at
 * 0.66 and 0.56 now, on the green, where a fence casts its shadow onto the
 * pasture and reads as an enclosure standing IN the field.
 */
export function fence() {
  const parts = [];
  parts.push(place(box(0.15, 1.34, 0.15, C.plankDark), -0.90, 0.67, 0));
  parts.push(place(box(0.15, 1.34, 0.15, C.plankDark), 0.90, 0.67, 0));
  parts.push(place(box(1.94, 0.13, 0.09, C.plank), 0, 1.16, 0, 0, 0, 0.02));
  parts.push(place(box(1.94, 0.10, 0.08, C.plank), 0, 0.78, 0, 0, 0, -0.015));
  parts.push(place(box(1.94, 0.13, 0.09, C.plank), 0, 0.40, 0, 0, 0, 0.01));
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

/**
 * Timbered mine portal cut into the mountain rock.  (72 tris, 3 instances)
 *
 * THE THREE ROCKS THAT FLANKED IT ARE GONE.
 *
 *   "Delete the two residual boulders. They persist across both the cleared and
 *    countdown frames. An empty ore hex must have zero rock props."
 *
 * They were welded into this kit rather than dropped by the recipe, which is
 * why the last pass — which emptied `RECIPE.mountains` completely and believed
 * it had taken every stone off the mountain — left them standing. Two 0.85 and
 * 0.95 icosahedral lumps at x = -1.55 and +1.62 read at play distance as two
 * boulders sitting on the floor a metre and a half either side of the portal,
 * not as part of it; the third at (0.1, 2.6) rode above the lintel. Grey lumps
 * on a grey hex whose resource is a grey lump is the phantom-stone complaint
 * exactly, and the fact that they were technically one instance with the portal
 * changed nothing about what the player saw.
 *
 * What is left is only TIMBER: two posts, a lintel, a cap beam and the black of
 * the adit behind them. Not one piece of it is rock-shaped, so an emptied
 * mountain hex now has zero rock props on it, which is what was asked for — and
 * the portal still says MINE at 3.4 units tall from anywhere on the island.
 *
 * AND THE SIGN BOARD HAS GONE WITH THEM.
 *
 *   "Remove ... the small pale box tucked against the mine's right post."
 *
 * It was authored as a notice board — a 0.5 x 0.34 x 0.06 plate in 0xe8d3a0
 * hung off the right-hand post — and at the size a mountain hex draws at from
 * the play camera it never resolved into a sign. It resolved into a small pale
 * BOX, the brightest thing on an otherwise grey hex, floating clear of the
 * timber at about waist height on the frame. On a terrain whose whole brief is
 * "a fully empty, slightly subtly textured grey hex, nothing else really on it"
 * a bright unidentifiable object stuck to the one landmark is the opposite of
 * quiet, and there is no lettering on it for it ever to have been worth. The
 * portal reads as a mine from the timber alone.
 *
 * AND NOW IT IS A MINE SHAFT AND NOT A BARN DOOR.
 *
 *   "Just make the large mine entrance on the ore hexes much smaller."
 *
 * Measured off the captures it stood 82 x 74 pixels on a hex 408 pixels wide —
 * a fifth of the tile — and it stood there alone, on the one terrain whose
 * whole brief is that there is nothing on it, silhouetted against sky and open
 * water. Everything about that was too much at once: the size, the fact that it
 * is the only object left, and the fact that the adit inside it sampled luma 7
 * against a luma 122 tile. Seventeen to one is not a doorway, it is a hole cut
 * out of the frame, and on a hex the last pass spent its whole effort lifting
 * off the floor it was the darkest thing left by an enormous margin.
 *
 * SIZE. Every dimension is roughly halved — 2.90 wide and 2.52 tall becomes
 * 1.62 and 1.38, and at the instance scale `props.js` drops it at that
 * photographs 9-11% of the hex's width against the 19-20% measured before. The
 * timber does NOT halve with it: posts go 0.26 to 0.20 and the lintel 0.30 to
 * 0.19, which is about three quarters, because a frame drawn in two-pixel
 * sticks is a frame that dissolves at play distance. Chunkier timber round a
 * smaller mouth also happens to be what a real pit head looks like.
 *
 * VALUE. The adit was 0x120d09 over 0x060404 — as near black as the palette
 * goes — on the theory that a mine is dark. It is, and a dark hole photographs
 * as a void: no shape inside it, no depth, nothing but an absence. It is a
 * dusty warm STONE now, a clear step darker than the timber round it and about
 * a third of the value of the tile, with a second deeper plate set behind it so
 * looking in still goes somewhere. On the frames the report measured that lands
 * the opening near luma 35 instead of 7 — plainly the darkest thing on the hex,
 * and no longer a cut-out.
 *
 * The timber comes UP to meet it, and it has to: the posts were rendering at
 * about luma 36 on a worked-out hex, so an opening lifted into the thirties
 * against plankDark posts would have flattened the whole portal into one brown
 * blob. Measured on the re-shoot the frame now prints at 58 and the mouth at
 * 32, on a tile of 119 — so the opening is still by a distance the darkest
 * thing on the hex, at a third of the contrast it used to shout with (1:3.7
 * against the tile where it was 1:17), and the frame is a clear step above it.
 */
export function mineEntrance() {
  const parts = [];
  // The frame goes UP a step from C.plank's 0x8a5a30, and it has to. Measured
  // on the re-shoot, plank timber renders at luma 63 on a worked-out ore hex
  // and the lifted mouth lands at 35 — a step and a half apart, which is a
  // portal you can read. At the old plank value the two were within half a stop
  // of each other and the whole thing photographed as one brown slab, which is
  // the opposite defect to the one being fixed and no improvement at all.
  parts.push(place(box(0.20, 1.14, 0.24, 0x966840), -0.53, 0.57, 0));
  parts.push(place(box(0.20, 1.14, 0.24, 0x966840), 0.53, 0.57, 0));
  parts.push(place(box(1.40, 0.19, 0.30, 0x966840), 0, 1.17, 0));
  parts.push(place(box(1.62, 0.13, 0.20, 0x6d4526), 0, 1.31, -0.03, 0, 0, 0.03));
  // The mouth. Lit dry stone at the top of the opening falling away to a
  // deeper, colder cut at the bottom — the ramp is what gives a flat plate the
  // reading of a shaft going in and down. It is set back 0.15 from the frame,
  // which on a 50-degree downward camera exposes a wedge of hex floor under it:
  // that wedge is the adit's own FLOOR, and it does more for the reading of
  // depth than any amount of darkness ever did.
  parts.push(gradient(place(box(0.94, 1.10, 0.11, 0x51493f), 0, 0.55, -0.15),
    0x453e37, 0x5d554c));
  parts.push(place(box(0.80, 0.86, 0.09, 0x363029), 0, 0.44, -0.26));
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
