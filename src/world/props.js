/**
 * Island Settlers — everything scattered on the island.
 *
 *   buildProps(scene) -> { group, update(dt), playHarvest(id), setDepleted(id, b) }
 *
 * This file owns the DRESSING: layered forests, undergrowth, fallen logs,
 * boulders, wheat fields, fences, hay, crates, clay works, rock spires, mine
 * portals, ore carts and rails — the backdrop the harvestable field stands in.
 *
 * The FIELD itself — the three hundred trees, sheep, clay heaps, wheat bundles
 * and ore chunks you actually run over and pick up — lives in `nodelife.js`,
 * and the hit that fires the instant one leaves the world lives in
 * `gatherfx.js`. The hex-scale read (whose hex is this, worked ground, the
 * dressing answering to the sweep, the recovery clock and the regrowth beat)
 * lives in `regions.js` / `regionmark.js` / `stand.js`, and the drastic
 * owned-versus-off-limits tint that paints all of them at once lives in
 * `mood.js`. All of it builds into this group and shares these materials.
 *
 * Everything is an InstancedMesh sharing four materials, so ~1500 instanced
 * dressing pieces plus a baked static batch plus the 300 field items plus the
 * whole region layer cost about twenty draw calls in total. Foliage sways in a
 * vertex-shader wind injected through onBeforeCompile; only the items currently
 * being taken and the dressing answering a sweep rewrite instance matrices.
 *
 * Placement rule: dressing is kept to hexFrac <= 0.78 so the tan border strip
 * (hexFrac 0.81 -> 1.00) stays clear for the structures agent's roads, and it
 * is kept clear of every field item so nothing sprouts through a sheep.
 */

import * as THREE from 'three';
import { HEX_SIZE } from '../core/constants.js';
import { tiles, MARKET, SPAWNS } from '../board/layout.js';
import { tileItems, mulberry32 } from '../board/nodes.js';
import { heightAt, hexFrac, normalAt, PROP_MAX_FRAC } from './terrain.js';
import { instanced, setInstance, triCount, merge } from './geo.js';
import * as K from './propkits.js';
import { buildField } from './nodelife.js';
import { buildPickupFX } from './gatherfx.js';
import { buildRegions } from './regions.js';
import { countFellable } from './stand.js';
import {
  applyMood, syncMood, moodAttrFromList, moodAttrFromPositions,
  startVictoryFlood, floodWinner, updateVictoryFlood, stopVictoryFlood,
  victoryFloodActive, floodProgress
} from './mood.js';

/*
 * Dressing kits that are part of the STAND, not scenery around it. Every
 * instance of these joins its region's harvest pool in `stand.js` and topples /
 * gets cropped / goes straw-coloured as the region is worked, choosing which
 * ones by how close they are to the settler who swept them. A forest tile
 * therefore clears along the path you actually walked and ends up as a stump
 * field, not as a full forest with twenty gaps in it where the harvestable
 * trees used to be. Nothing is deleted and no count changes — it is
 * instance matrices and instance colours only, and it all reverses when the
 * region grows back. Baked (STATIC_MERGE) kits cannot animate, which is why
 * fences, clay works and mine portals stay put: they are the works, not the
 * crop, and an empty paddock still has to read as a paddock.
 */
const RESPONSIVE = new Set([
  'conifer', 'coniferShort', 'broadleaf', 'undergrowth',
  'grass', 'flower', 'wheat', 'rockSmall', 'boulder'
]);

/*
 * Kits that never animate, always use the plain solid material and exist in
 * modest numbers get baked into ONE static merged mesh instead of one
 * InstancedMesh each. Triangle count is identical, but ten draw calls collapse
 * to one — and because renderer.info counts the shadow pass too, that is worth
 * roughly twenty calls a frame. Their per-instance tint variant is folded
 * straight into the baked vertex colours, so they keep their variation.
 */
const STATIC_MERGE = new Set([
  'mine', 'cart', 'rail', 'timber', 'clayWorks', 'spire',
  'crate', 'hay', 'deadwood', 'fence'
]);

/* ------------------------------------------------------------- materials */

function windMaterial(amount, opts = {}) {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, ...opts });
  m.userData.wind = { value: 0 };
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uWindTime = m.userData.wind;
    sh.uniforms.uSway = { value: amount };
    sh.vertexShader =
      'uniform float uWindTime;\nuniform float uSway;\n' + sh.vertexShader;
    sh.vertexShader = sh.vertexShader.replace('#include <begin_vertex>', [
      '#include <begin_vertex>',
      '#ifdef USE_INSTANCING',
      '  vec3 iOrigin = instanceMatrix[3].xyz;',
      '#else',
      '  vec3 iOrigin = vec3(0.0);',
      '#endif',
      'float swayH = max(transformed.y, 0.0);',
      'float phase = uWindTime * 1.65 + iOrigin.x * 0.23 + iOrigin.z * 0.19;',
      'float wsw = sin(phase) * 0.62 + sin(phase * 1.87 + 1.3) * 0.38;',
      'transformed.x += wsw * swayH * uSway;',
      'transformed.z += wsw * 0.62 * swayH * uSway;'
    ].join('\n'));
  };
  m.customProgramCacheKey = () => 'islandWind' + amount;
  return m;
}

/* ----------------------------------------------------------------- kits */

const STATIC_KITS = {
  conifer:      { make: K.conifer,      mat: 'tree',  cast: true },
  coniferShort: { make: K.coniferShort, mat: 'tree',  cast: true },
  broadleaf:    { make: K.broadleaf,    mat: 'tree',  cast: true },
  deadwood:     { make: K.deadwood,     mat: 'solid', cast: true },
  undergrowth:  { make: K.undergrowth,  mat: 'grass', cast: false },
  grass:        { make: K.grassTuft,    mat: 'grass', cast: false },
  flower:       { make: K.flowerTuft,   mat: 'grass', cast: false },
  wheat:        { make: K.wheatTuft,    mat: 'wheat', cast: false },
  hay:          { make: K.hayBale,      mat: 'solid', cast: true },
  rockSmall:    { make: K.smallRock,    mat: 'solid', cast: true },
  boulder:      { make: K.boulder,      mat: 'solid', cast: true },
  spire:        { make: K.spire,        mat: 'solid', cast: true },
  clayWorks:    { make: K.clayWorks,    mat: 'solid', cast: true },
  fence:        { make: K.fence,        mat: 'solid', cast: true },
  crate:        { make: K.crateStack,   mat: 'solid', cast: true },
  mine:         { make: K.mineEntrance, mat: 'solid', cast: true },
  cart:         { make: K.oreCart,      mat: 'solid', cast: true },
  rail:         { make: K.railSegment,  mat: 'solid', cast: false },
  timber:       { make: K.timberPile,   mat: 'solid', cast: true }
};

/* Per-tile dressing recipe. Counts are per tile of that terrain.
 *
 * These are all a third down on what they were, because the hex is no longer
 * seven sparse copses in a sea of scenery — it now carries ten to twenty-two
 * REAL, takeable items of its own. A forest tile stands about twenty
 * harvestable trees plus twenty-five decorative ones: still a solid canopy, but
 * the majority of it is now the thing you came for, which is the entire point.
 * Every backdrop conifer you cannot chop is a triangle spent lying to the
 * player about what they are allowed to touch.
 *
 * The OFF-TERRAIN entries stay culled. A clay hill with spruces on it, a
 * mountain with packing crates, a wheat field with a broadleaf: each was a
 * second silhouette competing with the one thing the hex is supposed to say.
 *
 * The four small item kits doubled in size, which changes what the dressing is
 * FOR on those hexes. A fields tile no longer needs ninety-two decorative wheat
 * tufts to read as gold — the harvestable plants do most of that on their own —
 * and every tuft standing between them is a triangle spent hiding the thing the
 * player came for. Wheat, pasture grass and mountain rubble are down
 * accordingly; the forest, which the player says already reads correctly, is
 * untouched.
 *
 * The one that moved AGAIN is wheat, and it has now moved twice. The item was a
 * squat sheaf, then a 2.2-unit standing plant, and is now a 2.8-to-3.9-unit one
 * — because "make the wheat resources much larger, they're too small" was the
 * complaint about the last version. A plant that tall and that broad in the leaf
 * covers a great deal more ground than the old one, so the decorative crop comes
 * back DOWN, 96 to 62, and each tuft is half again the size it was. The hex has
 * to read as a solid mass of gold from the play camera and still have ground you
 * can see to run down; the mass now comes mostly from the takeable plants, which
 * is the right way round — every tuft standing between them is a triangle spent
 * hiding the thing the player came for. The loose green grass stays almost
 * entirely gone: stubble under a gold crop was the one thing breaking the mass. */
const RECIPE = {
  forest:    { conifer: 13, coniferShort: 8, broadleaf: 4, deadwood: 3,
               undergrowth: 12, grass: 26, rockSmall: 3 },
  // A WHEAT FIELD IS THE CROP AND THE GROUND, AND NOTHING ELSE.
  //
  //   "Make the wheat/hay hexes more empty and yet look like non visually
  //    overstimulating farm land when empty. Right now it's too many
  //    contrasting dark lines and items even after the wheat is gone to know
  //    what I'm looking at. It's just distracting."
  //
  // The dark lines were literal: six FENCES a hex, each one two near-black
  // posts and a rail, plus two crates of the same dark plank, standing on pale
  // sand at maximum contrast — and none of them ever moved, because baked kits
  // cannot answer the harvest. Take the crop off a hex and what was left was a
  // stockade. All of it is gone; fences belong to the pasture, which is the hex
  // that has something to fence in.
  //
  // The decorative crop comes down hard with it, 84 -> 34, and each tuft is now
  // four soft blades in a muted straw instead of three spiky plants with bright
  // ear cones on them (see `wheatTuft`). Between the sheaves it is a warm mat
  // under the crop; worked out, `stand.js` crops it to a tenth of its height and
  // it becomes a flat wash on the ground with nothing standing up out of it.
  // Two hay bales stay: they are the one prop that says FARM without saying
  // anything else, and they read at any distance.
  fields:    { wheat: 34, hay: 2, grass: 2, rockSmall: 1 },
  pasture:   { grass: 44, flower: 12, fence: 4, undergrowth: 6, rockSmall: 3,
               hay: 2 },
  hills:     { clayWorks: 3, rockSmall: 8, boulder: 3, grass: 22,
               undergrowth: 5, crate: 2, deadwood: 1 },
  // A MOUNTAIN IS A MINING HILL. NOTHING TREE-SHAPED STANDS ON IT.
  //
  //   "Also remove the trees from the ore hex. I want it to look more like a
  //    mining hill."
  //
  // So the two conifers and two short pines are gone outright — not thinned,
  // gone — and with them the last silhouette on the hex that said "forest".
  // Nothing here is derived from a tree either: no deadwood (a stump and a
  // fallen log are tree-shaped), no undergrowth, no broadleaf. What is left is
  // rock and diggings — a skyline of spires, scree and rubble across the floor,
  // the timbered portal with its rails and carts (placed procedurally below),
  // stacked pit props, and a few tufts of scrub clinging on in the shale.
  //
  // AND NOW IT IS A QUIET ONE.
  //
  //   "The ore hexes still look too busy even when they're empty. Make it less
  //    visually distracting so I know what I'm looking at, but there's not
  //    really extra 3d shapes on the hex when it's empty."
  //
  // Removing the trees fixed the wrong SILHOUETTE and left the wrong COUNT: six
  // spires up to four units tall, five boulders, twelve loose stones, three pit
  // props and two crates is thirty standing objects on a hex whose whole job is
  // to hold ten to twenty-two takeable ones. Worked out, all thirty were still
  // there and none of them meant anything.
  //
  // Every count is roughly halved — spires 6 -> 3, boulders 5 -> 3, rubble
  // 12 -> 5, props 3 -> 1, crates gone — which leaves the portal, a short
  // skyline and enough scree to say "diggings" with a great deal of bare rock
  // floor between them. The loose rubble also SETTLES when the hex is worked out
  // now (`stand.js` crops it) instead of standing there for ever, so an empty
  // mountain genuinely loses shapes rather than just losing colour.
  //
  // The harvestable ore no longer has to fight any of this: it is a stack of
  // hard-edged cut CUBES, and there is not another right angle on the tile.
  mountains: { spire: 3, boulder: 3, rockSmall: 5, timber: 1, grass: 5 },
  desert:    { rockSmall: 8, boulder: 3, crate: 3, grass: 8, hay: 2,
               deadwood: 2, coniferShort: 1 }
};

/* ------------------------------------------------------------ tint variants
 *
 * Every instance used to be the identical mesh in the identical colour, so a
 * hundred spruces read as tiling rather than as a forest. instanceColor
 * multiplies the baked vertex colours per instance (r169 folds it into
 * <color_vertex> whenever vertexColors is on), which buys three or four
 * distinct colour readings per prop type for zero extra draw calls and zero
 * extra geometry. Values sit around 1.0 and shift hue as well as value.
 */
const TINTS = {
  conifer:      [[1.00, 1.00, 1.00], [0.80, 0.92, 0.82], [1.16, 1.06, 0.84], [0.68, 0.84, 0.90]],
  coniferShort: [[1.00, 1.00, 1.00], [0.84, 0.94, 0.80], [1.14, 1.08, 0.88], [0.72, 0.86, 0.86]],
  broadleaf:    [[1.00, 1.00, 1.00], [1.22, 1.08, 0.72], [0.82, 0.94, 0.80], [1.08, 0.92, 0.86]],
  undergrowth:  [[1.00, 1.00, 1.00], [0.84, 0.96, 0.82], [1.18, 1.08, 0.82]],
  grass:        [[1.00, 1.00, 1.00], [0.86, 0.96, 0.84], [1.14, 1.06, 0.86], [0.94, 1.02, 0.96]],
  flower:       [[1.00, 1.00, 1.00], [0.90, 0.98, 0.88], [1.10, 1.04, 0.90]],
  // Held near 1 for the same reason as the field crop in nodelife.js: a wheat
  // field varies in hue, not in value, and a drab quarter of it reads as dirt.
  wheat:        [[1.00, 1.00, 1.00], [1.06, 1.00, 0.86], [0.94, 0.93, 0.84], [1.03, 1.05, 0.94]],
  hay:          [[1.00, 1.00, 1.00], [1.06, 0.98, 0.84], [0.90, 0.88, 0.80]],
  rockSmall:    [[1.00, 1.00, 1.00], [0.84, 0.87, 0.94], [1.10, 1.04, 0.94], [0.70, 0.71, 0.74]],
  boulder:      [[1.00, 1.00, 1.00], [0.82, 0.86, 0.94], [1.12, 1.05, 0.93], [0.72, 0.73, 0.77]],
  spire:        [[1.00, 1.00, 1.00], [0.84, 0.88, 0.96], [1.10, 1.06, 1.00]],
  deadwood:     [[1.00, 1.00, 1.00], [0.88, 0.84, 0.78], [1.12, 1.06, 0.94]],
  clayWorks:    [[1.00, 1.00, 1.00], [1.10, 0.96, 0.88], [0.88, 0.84, 0.82]],
  crate:        [[1.00, 1.00, 1.00], [1.10, 1.00, 0.88], [0.86, 0.82, 0.78]],
  fence:        [[1.00, 1.00, 1.00], [1.12, 1.02, 0.90], [0.86, 0.82, 0.76]],
  timber:       [[1.00, 1.00, 1.00], [1.10, 1.00, 0.88], [0.88, 0.84, 0.80]]
};

/* Physical footprint radius. Two props may not overlap: the placement test is
   distance >= r(a) + r(b), so grass is free to grow right up under a spruce
   while two spruces still keep a respectful 1.4 units apart. */
/* Canopies are allowed to overlap now — a stand of trees IS overlapping
   canopies, and the old 1.24-unit minimum between two spruces is what made a
   forest tile read as scattered copses with lawn between them. */
const FOOT = {
  conifer: 0.54, coniferShort: 0.48, broadleaf: 0.72, deadwood: 0.85,
  undergrowth: 0.42, grass: 0.26, flower: 0.30, wheat: 0.24, hay: 0.62,
  rockSmall: 0.32, boulder: 0.95, spire: 0.90, clayWorks: 1.30, fence: 0.95,
  crate: 0.70, mine: 2.40, cart: 0.75, rail: 0.70, timber: 0.85,
  // Every field item reserves a disc so no backdrop prop ever sprouts through
  // a sheep or a tree you are supposed to be able to see and run at. There are
  // up to twenty-two of them per hex, blue-noise spaced about 2.3 apart, so
  // this is as wide as it can be without starving the placer. Widened with the
  // items themselves: a brick stack is now two units across and a tuft of grass
  // growing out of the top of it is the sort of thing that made them hard to
  // read in the first place.
  item: 1.12
};

/*
 * ...and on a FIELD the right answer has now moved back the other way.
 *
 * When the crop item was a feathery STANDING PLANT the brief was continuity: the
 * hex was supposed to read as one unbroken mass of gold, tall plants told apart
 * from short ones by height alone, so the exclusion disc came down to 0.55 and
 * the decorative crop was allowed to grow right in between the leaves.
 *
 * That is exactly what the player then could not read:
 *
 *   "I'm having a hard time quickly identifying where they are even as I'm
 *    running around the hex ... so it's a lot easier to tell where they are and
 *    how many there are left to pick up."
 *
 * You cannot count things that are touching. The takeable item is a chunky bound
 * SHEAF now, and every one of them gets a clear collar of ground so it stands on
 * its own with its own shadow — which is what turns "a field of wheat" into
 * "seven bundles left". Not so wide that the hex goes bare: at 0.92, with the
 * decorative crop down to 34 tufts, the ground between them still closes into a
 * warm straw mat rather than open beach.
 */
const ITEM_FOOT = { fields: 0.92 };

/* Scale ranges, ground sink and how far each kit tilts with the slope. */
const STYLE = {
  conifer:      { s: [0.95, 1.65], sink: 0.10, tilt: 0.16, yaw: true },
  coniferShort: { s: [0.90, 1.55], sink: 0.10, tilt: 0.18, yaw: true },
  broadleaf:    { s: [0.82, 1.52], sink: 0.10, tilt: 0.14, yaw: true },
  deadwood:     { s: [0.75, 1.35], sink: 0.08, tilt: 0.55, yaw: true },
  undergrowth:  { s: [0.75, 1.45], sink: 0.05, tilt: 0.35, yaw: true },
  grass:        { s: [0.70, 1.50], sink: 0.04, tilt: 0.35, yaw: true },
  flower:       { s: [0.75, 1.35], sink: 0.04, tilt: 0.35, yaw: true },
  // Ankle-high, and deliberately so. The takeable item is no longer a tall
  // plant that a tall tuft could be confused with — it is a bound sheaf with a
  // hard silhouette and its own shadow — so this kit's whole job is to be
  // GROUND. At 0.55 to 1.25 world units it is a straw mat the sheaves stand on
  // top of, and nothing in it ever competes for the eye.
  wheat:        { s: [0.80, 1.25], sink: 0.04, tilt: 0.25, yaw: true },
  hay:          { s: [0.80, 1.25], sink: 0.06, tilt: 0.35, yaw: true },
  rockSmall:    { s: [0.55, 1.35], sink: 0.12, tilt: 0.85, yaw: true },
  // Capped well under the harvestable ore lump, which runs 0.86..1.00 on a
  // geometry two and a half times longer than this one. Smooth dome versus
  // jagged oval does most of the separating; size does the rest.
  boulder:      { s: [0.62, 1.10], sink: 0.20, tilt: 0.65, yaw: true },
  spire:        { s: [0.75, 1.60], sink: 0.20, tilt: 0.45, yaw: true },
  clayWorks:    { s: [0.80, 1.25], sink: 0.08, tilt: 0.30, yaw: true },
  fence:        { s: [0.92, 1.12], sink: 0.10, tilt: 0.45, yaw: true },
  crate:        { s: [0.78, 1.26], sink: 0.06, tilt: 0.40, yaw: true },
  mine:         { s: [1.05, 1.25], sink: 0.10, tilt: 0.10, yaw: false },
  cart:         { s: [0.85, 1.00], sink: 0.06, tilt: 0.35, yaw: true },
  rail:         { s: [0.90, 1.05], sink: 0.05, tilt: 0.80, yaw: false },
  timber:       { s: [0.85, 1.20], sink: 0.06, tilt: 0.40, yaw: true }
};

/* ------------------------------------------------------------- placement */

function tiltAt(x, z, amount) {
  if (amount <= 0) return [0, 0];
  const n = normalAt(x, z, 0.7);
  return [Math.atan2(n.z, n.y) * amount, -Math.atan2(n.x, n.y) * amount];
}

/** Rejection sampler: non-overlapping discs inside one hex, off the road strip. */
function makePlacer(tile, rng) {
  const blocked = [];
  const itemFoot = ITEM_FOOT[tile.terrain] !== undefined
    ? ITEM_FOOT[tile.terrain] : FOOT.item;
  for (const it of tileItems(tile.id)) {
    blocked.push({ x: it.x, z: it.z, r: itemFoot });
  }
  // Keep the market clear — on EVERY tile, not just the desert it stands on.
  // The plaza floor reaches 6.6 and its steps 7.95, but the real problem was the
  // neighbours: at PROP_MAX_FRAC 0.78 with centres 15.59 apart, a conifer on the
  // next hex could stand 9.51 from the market and cut straight across the
  // pavilion at play pitch. 11.0 pushes the treeline back far enough that the
  // island's centrepiece is never occluded.
  blocked.push({ x: MARKET.x, z: MARKET.z, r: 11.0 });
  for (const s of SPAWNS) {
    if (Math.hypot(s.x - tile.x, s.z - tile.z) < HEX_SIZE * 1.1) {
      blocked.push({ x: s.x, z: s.z, r: 2.4 });
    }
  }
  return {
    blocked,
    take(count, foot, maxF = PROP_MAX_FRAC) {
      const out = [];
      const lim = HEX_SIZE * maxF;
      let guard = 0;
      // Generous: the gather-node discs got bigger when a node became a copse
      // of three, and at the old 130-tries-per-prop budget the sampler simply
      // gave up on the last few dozen grass tufts. Build-time only.
      const cap = 500 + count * 420;
      while (out.length < count && guard++ < cap) {
        const a = rng() * Math.PI * 2;
        const rr = Math.sqrt(rng());
        const x = tile.x + Math.cos(a) * rr * lim;
        const z = tile.z + Math.sin(a) * rr * lim;
        if (hexFrac(x - tile.x, z - tile.z) > maxF) continue;
        let clash = false;
        for (const b of blocked) {
          const dx = b.x - x, dz = b.z - z;
          const rad = b.r + foot;
          if (dx * dx + dz * dz < rad * rad) { clash = true; break; }
        }
        if (clash) continue;
        out.push({ x, z });
        blocked.push({ x, z, r: foot });
      }
      return out;
    }
  };
}

/* ------------------------------------------------------------------- API */

export function buildProps(scene) {
  const group = new THREE.Group();
  group.name = 'props';
  scene.add(group);

  const mats = {
    solid: new THREE.MeshLambertMaterial({ vertexColors: true }),
    tree:  windMaterial(0.026),
    grass: windMaterial(0.105, { side: THREE.DoubleSide }),
    wheat: windMaterial(0.145, { side: THREE.DoubleSide })
  };
  // Every prop in the world reads the shared per-hex mood: full colour on a hex
  // you may work, near-monochrome on one you may not, grey on one you have
  // cleared out. It is a per-fragment tint on four materials, so it costs
  // nothing and nothing can get out of step with anything else.
  for (const k in mats) applyMood(mats[k]);

  /* ------------------------------------------------- collect placements */
  const bucket = {};
  const push = (kit, o) => { (bucket[kit] || (bucket[kit] = [])).push(o); };

  // Which hex the piece currently being dropped belongs to. -1 for the
  // shoreline collar, which is nobody's region and never responds.
  let dropTile = -1;

  function drop(kit, x, z, rng, extra = {}) {
    const st = STYLE[kit];
    const s = st.s[0] + rng() * (st.s[1] - st.s[0]);
    const [rx, rz] = tiltAt(x, z, st.tilt);
    push(kit, {
      tile: dropTile,
      x, z,
      y: heightAt(x, z) - st.sink * s,
      ry: extra.ry !== undefined ? extra.ry : (st.yaw ? rng() * Math.PI * 2 : 0),
      s: extra.s !== undefined ? extra.s : s,
      sy: extra.sy !== undefined ? extra.sy : s * (0.88 + rng() * 0.30),
      rx, rz
    });
  }

  // ---- per tile dressing --------------------------------------------------
  tiles.forEach((tile, ti) => {
    const rng = mulberry32(50021 + ti * 3181 + tile.number * 977);
    const placer = makePlacer(tile, rng);
    const recipe = RECIPE[tile.terrain] || {};
    dropTile = tile.id;

    // mine portal first so it owns the best spot on a mountain
    if (tile.terrain === 'mountains') {
      const away = Math.atan2(tile.z, tile.x) || 0.3;
      // a Y rotation of (PI/2 - away) turns a model's local +Z to face `away`
      const yaw = Math.PI / 2 - away;
      const mx = tile.x + Math.cos(away) * HEX_SIZE * 0.40;
      const mz = tile.z + Math.sin(away) * HEX_SIZE * 0.40;
      placer.blocked.push({ x: mx, z: mz, r: FOOT.mine });
      drop('mine', mx, mz, rng, { ry: yaw, s: 1.1, sy: 1.1 });
      // Rails running out of the portal, and one cart on them. Both thinned
      // with the rest of the mountain dressing: five rail segments and two
      // carts was a working railway on a hex that is supposed to read at a
      // glance as "rock, a mine, and the ore you came for".
      for (let i = 0; i < 3; i++) {
        const d = HEX_SIZE * 0.40 - (2.2 + i * 2.05);
        const rx2 = tile.x + Math.cos(away) * d;
        const rz2 = tile.z + Math.sin(away) * d;
        if (hexFrac(rx2 - tile.x, rz2 - tile.z) > PROP_MAX_FRAC) continue;
        placer.blocked.push({ x: rx2, z: rz2, r: FOOT.rail });
        drop('rail', rx2, rz2, rng, { ry: yaw });
      }
      for (let i = 0; i < 1; i++) {
        const d = HEX_SIZE * 0.40 - (3.6 + i * 4.1);
        const cx = tile.x + Math.cos(away) * d;
        const cz = tile.z + Math.sin(away) * d;
        if (hexFrac(cx - tile.x, cz - tile.z) > PROP_MAX_FRAC) continue;
        placer.blocked.push({ x: cx, z: cz, r: FOOT.cart });
        drop('cart', cx, cz, rng, { ry: yaw });
      }
    }

    // pasture fences follow a lazy arc so they read as an enclosure
    if (tile.terrain === 'pasture') {
      const a0 = rng() * Math.PI * 2;
      const rad = HEX_SIZE * 0.56;
      for (let i = 0; i < 9; i++) {
        const a = a0 + i * 0.30;
        const fx = tile.x + Math.cos(a) * rad;
        const fz = tile.z + Math.sin(a) * rad;
        if (hexFrac(fx - tile.x, fz - tile.z) > PROP_MAX_FRAC) continue;
        placer.blocked.push({ x: fx, z: fz, r: FOOT.fence });
        drop('fence', fx, fz, rng, { ry: a + Math.PI / 2 });
      }
    }

    // biggest silhouettes claim their ground first, undergrowth fills the gaps
    const order = ['spire', 'clayWorks', 'boulder', 'broadleaf', 'deadwood',
      'conifer', 'coniferShort', 'timber', 'hay', 'crate', 'fence',
      'undergrowth', 'rockSmall', 'wheat', 'flower', 'grass'];
    for (const kit of order) {
      const n = recipe[kit];
      if (!n) continue;
      for (const p of placer.take(n, FOOT[kit])) drop(kit, p.x, p.z, rng);
    }
  });

  // ---- shoreline dressing -------------------------------------------------
  /*
   * The sand met the sea on a dead-straight seam with nothing standing in it.
   * The collar below scatters rock CLUSTERS across the waterline — a lead
   * boulder with two to four smaller stones huddled around it, half of them
   * sitting below y = 0 so the water shader's foam breaks over them. Reuses the
   * existing boulder / rockSmall instanced meshes, so it costs no draw calls.
   */
  {
    dropTile = -1;
    const rng = mulberry32(778811);
    const taken = [];
    const free = (x, z, foot) => {
      for (const t of taken) {
        const dx = t.x - x, dz = t.z - z;
        const rad = t.r + foot;
        if (dx * dx + dz * dz < rad * rad) return false;
      }
      return true;
    };
    const tryPlace = (kit, want, loH, hiH) => {
      const foot = FOOT[kit];
      let got = 0, guard = 0;
      while (got < want && guard++ < want * 300) {
        const a = rng() * Math.PI * 2;
        const r = 37 + rng() * 15;
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        const h = heightAt(x, z);
        if (h < loH || h > hiH) continue;
        if (!free(x, z, foot)) continue;
        taken.push({ x, z, r: foot });
        drop(kit, x, z, rng);
        got++;
      }
    };

    // rock clusters straddling the waterline
    let clusters = 0, guard = 0;
    while (clusters < 34 && guard++ < 4000) {
      const a = rng() * Math.PI * 2;
      const r = 38 + rng() * 13;
      const cx = Math.cos(a) * r, cz = Math.sin(a) * r;
      const h = heightAt(cx, cz);
      if (h < -0.85 || h > 1.15) continue;      // straddle the shoreline
      if (!free(cx, cz, 1.5)) continue;
      taken.push({ x: cx, z: cz, r: 1.15 });
      drop('boulder', cx, cz, rng);
      const n = 2 + ((rng() * 3) | 0);
      for (let k = 0; k < n; k++) {
        const ka = rng() * Math.PI * 2;
        const kr = 0.95 + rng() * 1.5;
        const sx = cx + Math.cos(ka) * kr, sz = cz + Math.sin(ka) * kr;
        if (heightAt(sx, sz) > 1.6) continue;
        if (!free(sx, sz, FOOT.rockSmall)) continue;
        taken.push({ x: sx, z: sz, r: FOOT.rockSmall });
        drop('rockSmall', sx, sz, rng);
      }
      clusters++;
    }

    // Thinned by a third from what it used to be. The clusters above already
    // break the seam; the loose scatter on top of them was pure litter on a
    // band of beach the play camera barely looks at, and it was costing more
    // triangles than the forests it was competing with.
    tryPlace('boulder', 16, 0.10, 1.7);
    tryPlace('deadwood', 8, 0.20, 1.2);
    tryPlace('rockSmall', 46, -0.35, 2.0);
    tryPlace('undergrowth', 12, 0.70, 2.0);
    tryPlace('grass', 40, 0.55, 2.0);
  }

  /* ------------------------------------------------------- build meshes */
  const meshes = {};
  const geos = {};
  let triangles = 0;
  let drawCalls = 0;

  /** Deterministic 0..1 from a world position — picks the tint variant. */
  function variantOf(x, z, n) {
    let h = Math.imul((x * 73.7) | 0, 374761393) ^ Math.imul((z * 91.3) | 0, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) % n;
  }

  /** Attach a per-instance colour palette to an InstancedMesh. */
  function paintVariants(mesh, list, table) {
    if (!table || table.length < 2) return;
    const arr = new Float32Array(list.length * 3);
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      const v = table[variantOf(o.x, o.z, table.length)];
      arr[i * 3] = v[0]; arr[i * 3 + 1] = v[1]; arr[i * 3 + 2] = v[2];
    }
    mesh.instanceColor = new THREE.InstancedBufferAttribute(arr, 3);
    mesh.instanceColor.needsUpdate = true;
  }

  /* ---- the baked static batch ------------------------------------------- */
  const _bm = new THREE.Matrix4();
  const _be = new THREE.Euler();
  const _bq = new THREE.Quaternion();
  const _bp = new THREE.Vector3();
  const _bs = new THREE.Vector3();
  const bakedParts = [];

  function bake(kit, geo, list) {
    const table = TINTS[kit];
    for (const o of list) {
      const g = geo.clone();
      if (table && table.length > 1) {
        const v = table[variantOf(o.x, o.z, table.length)];
        const col = g.attributes.color.array;
        for (let i = 0; i < col.length; i += 3) {
          col[i] *= v[0]; col[i + 1] *= v[1]; col[i + 2] *= v[2];
        }
      }
      _be.set(o.rx || 0, o.ry, o.rz || 0, 'YXZ');
      _bq.setFromEuler(_be);
      _bp.set(o.x, o.y, o.z);
      _bs.set(o.s, o.sy, o.s);
      _bm.compose(_bp, _bq, _bs);
      g.applyMatrix4(_bm);
      bakedParts.push(g);
    }
  }

  for (const kit in bucket) {
    const spec = STATIC_KITS[kit];
    const list = bucket[kit];
    if (!spec || !list.length) continue;
    const geo = spec.make();

    if (STATIC_MERGE.has(kit) && spec.mat === 'solid') {
      triangles += triCount(geo) * list.length;
      bake(kit, geo, list);
      geo.dispose();
      continue;
    }

    geos[kit] = geo;
    const mesh = instanced(geo, mats[spec.mat], list.length, spec.cast, true);
    mesh.name = `prop-${kit}`;
    mesh.geometry.setAttribute('aMood', moodAttrFromList(list));
    list.forEach((o, i) => setInstance(mesh, i, o.x, o.y, o.z, o.ry, o.s, o.sy, o.rx, o.rz));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    paintVariants(mesh, list, TINTS[kit]);
    group.add(mesh);
    meshes[kit] = mesh;
    triangles += triCount(geo) * list.length;
    drawCalls++;
  }

  if (bakedParts.length) {
    const bakedGeo = merge(bakedParts);
    // The baked batch has no instances to hang a mood on, so its hex is sampled
    // per vertex straight off the world positions instead.
    bakedGeo.setAttribute('aMood', moodAttrFromPositions(bakedGeo));
    geos['__baked'] = bakedGeo;
    const baked = new THREE.Mesh(bakedGeo, mats.solid);
    baked.name = 'prop-static';
    baked.castShadow = true;
    baked.receiveShadow = true;
    group.add(baked);
    meshes.__baked = baked;
    drawCalls++;
  }

  /* ------------------------------------------------------------- the field
   *
   * The three hundred items are not props — they are the game. Their geometry,
   * their instant pickup and their whole-hex regrowth live in nodelife.js; the
   * flash, burst and flying chip fire from gatherfx.js. Both build into this
   * same group and share these same materials.
   *
   * `extraStumps` is the deal that keeps a clear-cut free: the field sizes its
   * stump batch to cover the decorative timber as well as its own trees, and
   * hands the spare instances to the stand. Forty-five trees on a forest hex
   * become forty-five stumps without a second draw call.
   */
  const dressing = {};
  for (const kit in bucket) {
    if (!RESPONSIVE.has(kit)) continue;
    const mesh = meshes[kit];
    if (mesh) dressing[kit] = { mesh, list: bucket[kit] };
  }

  const field = buildField(group, mats, { extraStumps: countFellable(bucket) });
  triangles += field.triangles;
  drawCalls += field.drawCalls;

  const pickup = buildPickupFX(group);
  triangles += pickup.triangles;
  drawCalls += pickup.drawCalls;

  // The instant an item's `available` flag drops, the field animates it out and
  // tells us who took it. That is the whole wiring for "SUPER CLEAR visual of
  // exactly which sheep I picked up" — no event plumbing, no ordering worries,
  // and it fires identically for the human and for a bot across the island.
  field.onPick((item, player) => pickup.pop(item, player));

  /* --------------------------------------------------------- the regions
   *
   * Hex-scale legibility: whose hex is this, worked ground, the dressing
   * answering to the sweep, the recovery clock and the regrowth beat.
   * Two draw calls for all nineteen hexes.
   */
  const regions = buildRegions(group, dressing, field.stumps);
  triangles += regions.triangles;
  drawCalls += regions.drawCalls;

  /* --------------------------------------------------------- animation */

  let wind = 0;

  function update(dt) {
    wind += dt;
    mats.tree.userData.wind.value = wind;
    mats.grass.userData.wind.value = wind * 1.35;
    mats.wheat.userData.wind.value = wind * 1.2;
    // Advances the end-of-match colour wave if one has been started, and costs
    // a single boolean test if one never is.
    updateVictoryFlood(dt);
    syncMood();
    field.update(dt);
    pickup.update(dt);
    regions.update(dt);
  }

  return {
    group,
    meshes,
    field,
    nodeMesh: field.meshes,
    materials: mats,
    triangles,
    drawCalls,
    regions,
    pickup,

    /** Kept so main.js's `gained` handler keeps working. The field reconciles
     *  itself off the item flags, so both of these are now no-ops. */
    playHarvest(ref) { field.playHarvest(ref); },
    setDepleted(ref, on = true) { field.setDepleted(ref, on); },

    /** Where an item's visual currently stands — handy for FX anchoring. */
    itemAnchor(id) { return field.itemAnchor(id); },
    nodeAnchor(ref) { return field.nodeAnchor(ref); },

    /* ------------------------------------------------ THE VICTORY FLOOD
     *
     * Published here so `systems/matchflow.js` can sequence the end of a match
     * without knowing anything about the shader that draws it. Reachable as
     * `game.world.props.*` (main.js puts this object on `world.props`).
     *
     *   const secs = world.props.startVictoryFlood(winnerId);
     *       -> starts a wave that sweeps EVERY hex on the island to that
     *          player's colour, beginning on the hexes they hold and running
     *          outward. Terrain, trees, flock, boulders and stumps all turn
     *          together. Advances itself inside props.update(dt), which the
     *          frame loop already calls. Returns the total seconds it will
     *          take, so the celebration can be fired straight after.
     *          Optional second argument:
     *            { color, from: [tileIds], duration = 2.4, hold = 1.0 }
     *
     *   world.props.floodWinner(0xd0472f, 0.55);
     *       -> drive the same wave by hand: colour plus a 0..1 progress.
     *          Cancels the internal clock and takes over.
     *
     *   world.props.stopVictoryFlood();     back to normal colour at once
     *   world.props.victoryFloodActive();   bool
     *   world.props.floodProgress();        0..1
     *
     * All of it is optional. Call none of it and nothing changes.
     * Full contract: the header block in `src/world/mood.js`.
     */
    startVictoryFlood(pid, opts) { return startVictoryFlood(pid, opts); },
    floodWinner(colorHex, progress01) { floodWinner(colorHex, progress01); },
    stopVictoryFlood() { stopVictoryFlood(); },
    victoryFloodActive() { return victoryFloodActive(); },
    floodProgress() { return floodProgress(); },

    update,

    dispose() {
      for (const k in geos) geos[k].dispose();
      for (const k in mats) mats[k].dispose();
      field.dispose();
      pickup.dispose();
      regions.dispose();
    }
  };
}

export default buildProps;
