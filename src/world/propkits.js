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
 *   wheat  a tall standing plant: one stalk, five pairs of leaves, an ear on top
 *   ore    a large, low, dark BOULDER with a bright seam of metal across it
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

/*
 * The crop's own ramp, warmer and a good deal brighter than `C.wheat`, which
 * was mixed for the ears of a bound sheaf against pale sand. A field of standing
 * plants is seen almost edge-on — near-vertical leaf cards, so the key light
 * grazes them — and at that angle the old amber came back as olive-brown. These
 * four are the ramp the reference actually shows: dark honey at the root, warm
 * gold through the leaves, near-cream on the ear.
 */
const WH_LO = 0xba8720;
const WH_MID = 0xeab033;
const WH_HI = 0xffe89c;
const WH_TOP = 0xfff6d2;

/**
 * One STANDING WHEAT PLANT.  (36 tris)
 *
 * The reference the player attached is a hex of tall, upright, densely packed
 * golden wheat: every plant a straight central stalk with symmetrical pairs of
 * leaves stepping up it and tapering toward the top — little golden ferns —
 * standing well clear of the ground, and the hex reading as one solid mass of
 * gold rather than as a scatter of objects on sand.
 *
 * What this replaced was a bound sheaf: stalks tied at the waist flaring into a
 * cone of ears. A sheaf is CUT wheat. It is a fine shape, but it says "harvest
 * already happened" and it is squat, so a full hex of them read as a row of
 * bollards. This is the crop still growing.
 *
 * The build:
 *   * one tapered central stalk running the full height, dark amber at the root
 *     and pale gold at the top, so a plant has its own value range and a hex of
 *     them has depth instead of being one flat yellow;
 *   * five leaf pairs stepping up it, each pair shorter and tighter than the one
 *     below so the plant narrows as it rises, and each pair given its own
 *     bearing so twenty-two of them are never a grid;
 *   * a slim ear on top — the one thing that reads at twenty pixels and says
 *     grain rather than grass.
 *
 * Silhouette check: trees are conical and round, the ore is a low wide boulder,
 * the brick is a cuboid stack, the sheep is a white lump. Nothing else on the
 * island is a narrow vertical spine with paired arms, and nothing else is this
 * colour. The dressing tuft below is a knee-high version of the same plant, so a
 * fields hex is one crop at two heights rather than two different species.
 *
 * Leaves are flat cards, so the field batch rides the double-sided `grass`
 * material (see `nodelife.js`) — which also gives the crop a real breeze.
 */
export function fieldWheat() {
  const parts = [];
  const H = 1.72;                       // stalk height, before the ear
  const PAIRS = 6;

  // The stalk. Deliberately thin: the leaves carry the mass, and a fat stalk
  // reads as a post. Open-ended — you never see either cap.
  parts.push(gradient(place(cyl(0.028, 0.062, H, 4, WH_LO, true), 0, H / 2, 0),
    WH_LO, WH_HI));

  for (let i = 0; i < PAIRS; i++) {
    const t = i / (PAIRS - 1);          // 0 at the ground, 1 at the top
    const y = 0.20 + t * (H - 0.46);
    const len = 0.70 - t * 0.36;        // longest at the bottom
    const wid = 0.20 - t * 0.10;
    const a = i * 1.07 + 0.3;           // the pair's own bearing
    for (const side of [1, -1]) {
      const leaf = blade(wid, len, WH_MID, WH_HI, 0.34, 1);
      // Two steps, so the tilt happens in the leaf's own frame first and the
      // bearing is applied to the finished pair: a clean, symmetrical V.
      place(leaf, 0, 0, 0, 0, 0, side * (1.15 - t * 0.26));
      place(leaf, 0, y, 0, 0, a, 0);
      parts.push(leaf);
    }
  }

  // The ear: narrow, upright, and the brightest thing on the plant.
  const ear = cone(0.085, 0.46, 4, WH_HI, 0, true);
  place(ear, 0, H + 0.17, 0, 0, 0.6, 0.05);
  parts.push(gradient(ear, WH_MID, WH_TOP));
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
 * Paint a metallic SEAM across a rock's vertex colours.  (0 tris)
 *
 * The band is a plane slab in the geometry's own local space: every vertex
 * whose signed distance to the plane falls inside `width` is pulled toward the
 * seam colour, hardest at the centre of the band. `rock()` returns non-indexed
 * flat-shaded geometry, so a triangle whose three corners land in the slab goes
 * bright as a whole FACET — which is what an exposed vein of metal in a broken
 * stone actually looks like, and it costs not one extra triangle.
 */
function seam(g, hex, nx, ny, nz, at, width, strength = 1) {
  const pos = g.attributes.position.array;
  const col = g.attributes.color.array;
  const n = g.attributes.position.count;
  const c = new THREE.Color(hex);
  const inv = 1 / Math.max(width, 1e-4);
  // Per FACE, not per vertex. A twenty-face stone has its corners a long way
  // apart, so a per-vertex falloff smears the vein into a soft gradient that
  // reads as nothing at all at forty pixels. Testing the face CENTROID and
  // flooding all three of its corners instead gives whole bright PLANES of
  // metal — which is both what exposed ore looks like and the only version of
  // it that survives being twenty pixels across on a phone.
  for (let f = 0; f + 2 < n; f += 3) {
    const a = f * 3, b = (f + 1) * 3, e = (f + 2) * 3;
    const cx = (pos[a] + pos[b] + pos[e]) / 3;
    const cy = (pos[a + 1] + pos[b + 1] + pos[e + 1]) / 3;
    const cz = (pos[a + 2] + pos[b + 2] + pos[e + 2]) / 3;
    const d = cx * nx + cy * ny + cz * nz - at;
    const k = 1 - Math.min(1, Math.abs(d) * inv);
    if (k <= 0) continue;
    const t = Math.min(1, k * 1.7) * strength;
    for (const i of [a, b, e]) {
      col[i] += (c.r - col[i]) * t;
      col[i + 1] += (c.g - col[i + 1]) * t;
      col[i + 2] += (c.b - col[i + 2]) * t;
    }
  }
  g.attributes.color.needsUpdate = true;
  return g;
}

/**
 * One ore-bearing BOULDER.  (36 tris)
 *
 * The player's words: "Can you make the ore look more like large boulders."
 *
 * What this replaced was a stone the size of a football with three tall glacial
 * crystals growing out of it — a crystal cluster, not a rock. So the crystals
 * are gone and the mass has taken their place. This is now the biggest and by a
 * long way the heaviest-looking thing on the board: a wide, squat block of
 * stone about two and a half units across and barely a metre and a half tall,
 * sunk into the ground so the bottom of it disappears, built from a lead
 * icosahedron at LOW roughness (0.19) so its twenty faces read as a handful of
 * big flat facets instead of a lumpy potato. A second mass on the shoulder and
 * a split-off chip at the base keep the outline from being one symmetrical
 * dome — a boulder that has been worked is a boulder with a corner off it.
 *
 * It is still obviously ORE. Two seams of glacial blue run across the facets
 * (see `seam` above), bright against the near-black stone and in a colour
 * nothing else on the island wears, so "the metal is IN this rock" is said
 * without a single spire breaking the silhouette.
 *
 * And it must not be confused with the scenery: the decorative boulders and
 * spires on a mountain hex have been cut back in both number and size in
 * `props.js` / `boulder()` below, so this shape — low, wide, dark, veined —
 * belongs to the harvestable item alone.
 */
export function fieldOre() {
  const parts = [];
  // A mountain hex is bare PALE rock flour and the decorative stones on it are
  // paler still, so the whole read here is VALUE: this thing is near-black at
  // the bottom and never gets past a dull gunmetal at the top, which is two
  // full stops below anything else on the hex. A mountain is looked at from
  // above, so it is the top facets that have to hold that contrast — the ramp
  // deliberately stops short of highlight grey.
  const main = facetStone(1.05, 0.16, 41, 0.74, 0.38);
  gradient(main, 0x0d0f14, 0x3f4855);
  seam(main, 0x8fd6ee, 0.30, 0.88, 0.36, 0.36, 0.13, 0.54);
  place(main, 0, 0.44, 0, 0, 0.5, 0, 1.06, 1.00, 1.00);
  parts.push(main);

  // A second mass welded onto the shoulder, overlapping the lead stone rather
  // than sitting beside it: one boulder that has broken, not two rocks.
  const shoulder = facetStone(0.66, 0.20, 47, 0.76, 0.34);
  gradient(shoulder, 0x0b0d11, 0x374050);
  seam(shoulder, 0x8fd6ee, 0.24, 0.86, -0.44, 0.20, 0.10, 0.46);
  place(shoulder, -0.66, 0.34, 0.20, 0, 0.9, 0, 1.10, 1.00, 1.04);
  parts.push(shoulder);

  // A slab split off at the base, lying flat. Reads as weight, and keeps the
  // footprint from being a circle.
  const chip = facetStone(0.46, 0.24, 53, 0.42, 0.40);
  gradient(chip, 0x0b0d11, 0x333b46);
  place(chip, 0.80, 0.13, -0.34, 0, 1.6, 0, 1.08, 1.00, 1.08);
  parts.push(chip);

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
 * Three young wheat plants — the crop between the crop.  (27 tris)
 *
 * The same plant as `fieldWheat` at knee height: a stalk, one low leaf pair and
 * an ear. It exists to close the blue-noise gaps the harvestable plants leave,
 * so a fields hex reads as a FIELD and not as twenty-two ornaments on sand —
 * and because it is the same silhouette at a smaller size, filling those gaps
 * costs the hex none of its legibility. Nothing here is takeable; the tall ones
 * are, and the height difference is what says so at a glance.
 *
 * This is the most-instanced kit in the game after grass, so the ear is an open
 * cone: its base points at the sky-facing stalk top and is covered by it.
 */
export function wheatTuft() {
  const parts = [];
  for (let i = 0; i < 3; i++) {
    const a = i * 2.11 + 0.3;
    const r = 0.10 + (i % 2) * 0.07;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const h = 0.66 + (i % 3) * 0.13;
    // single-segment blades: 2 triangles each, and at this size the bend was
    // never visible anyway
    const st = blade(0.10, h, WH_LO, WH_HI, 0.12, 1);
    place(st, x, 0, z, 0, a, 0.07);
    parts.push(st);
    for (const side of [1, -1]) {
      const leaf = blade(0.135, 0.34, WH_MID, WH_HI, 0.32, 1);
      place(leaf, 0, 0, 0, 0, 0, side * 1.12);
      place(leaf, x, h * 0.30, z, 0, a, 0);
      parts.push(leaf);
    }
    const ear = cone(0.075, 0.30, 3, WH_HI, 0, true);
    place(ear, x, h + 0.09, z, 0, a, 0.06);
    parts.push(gradient(ear, WH_MID, WH_TOP));
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
 * Deliberately SMALLER than it used to be (lead stone 0.88 -> 0.72). The
 * harvestable ore is a boulder now, and the one thing a boulder-shaped item
 * cannot afford is a hex full of boulder-shaped scenery. This is the backdrop
 * stone: pale, unveined and comfortably under the item it stands next to.
 */
export function boulder(seed = 9) {
  const parts = [];
  // Lead stone keeps its 20 faces — these sit on the waterline where they catch
  // the eye. The companion chip goes low poly.
  parts.push(place(rock(0.72, 0, C.stone, 0.30, seed), 0, 0.48, 0));
  parts.push(place(rock(0.33, 0, C.stoneHi, 0.46, seed + 3, true), 0.64, 0.20, 0.26));
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
