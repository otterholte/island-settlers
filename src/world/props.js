/**
 * Island Settlers — everything scattered on the island.
 *
 *   buildProps(scene) -> { group, update(dt), playHarvest(id), setDepleted(id, b) }
 *
 * This file owns the DRESSING: ground cover, a decorative crop, a few boulders
 * on the sand, a paddock fence, two bales on a wheat field, one clay quarry with
 * one shovel stuck in the ground beside it, and one mine portal — the backdrop
 * the harvestable field stands in.
 *
 * IT OWNS NOTHING THAT LOOKS LIKE A RESOURCE, and that is now a hard rule
 * rather than a preference:
 *
 *   "There should be no Phantom trees, only pickable resources, and the few
 *    subtle stumps when its empty waiting to recharge."
 *
 * A decorative conifer standing next to a harvestable one, a decorative boulder
 * standing next to a harvestable ore lump — each was a thing the player ran at
 * and got nothing from, and because the dressing answers the harvest through
 * `stand.js` each one also vanished the moment the last REAL item on its hex was
 * taken, which is what made them read as phantoms rather than as scenery. Every
 * kit on a resource hex is now either ground-height cover (grass, ferns, the
 * straw mat under the wheat) or a single unmistakable landmark far larger than
 * any item (the mine portal, the clay works). Nothing in between. If a new kit
 * would sit in the same size band and the same colour family as the item its hex
 * grows, it does not go on that hex.
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
import { tiles, MARKET, SPAWNS, cornerOffset } from '../board/layout.js';
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
  'crate', 'hay', 'deadwood', 'fence', 'shovel'
]);

/*
 * Kits that are GROUND rather than objects. Everything in here is ankle-high,
 * has no silhouette worth the name and is meant to be run over — so it is the
 * only dressing allowed inside the discs `makePlacer` reserves at the six
 * corners of every hex for the settlements, cities and banners the players may
 * build there. A road laid over grass reads as a road in a field; a road laid
 * over a hay bale reads as a bug, and has now been photographed as one twice.
 */
const GROUND_COVER = new Set(['grass', 'flower', 'wheat', 'undergrowth']);

/*
 * The corner keep-out a RELAXED placement pass falls back to, rather than
 * switching the corners off altogether.
 *
 * Every landmark on this island has a floor under its count — two fence panels
 * on a paddock, at least one bale on a wheat field — and every one of those
 * floors is held by a pass that gives something up in order to always land. The
 * hills' stones used to be on that list and are not any more; what stands there
 * now is one quarry and one shovel, both of them SCORED rather than sampled, so
 * both land on every hill by construction and neither needs a relaxed pass at
 * all. Giving up the corners
 * ENTIRELY was the first version of this and it is more than has to be given:
 * measured over forty boards it let a bale's body come within 2.57 units of a
 * hex vertex, which is inside the 2.72 curtain wall of a city built there. At
 * 3.00 the same fallback keeps the body 3.01 clear — outside the wall, just
 * inside the reach of the city's outermost banner — and costs almost nothing,
 * because the ground it gives back is the ground the relaxed pass wanted
 * anyway. Full keep-out first; this only when that came up short.
 */
const RELAX_CIVIC = 3.00;

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
  shovel:       { make: K.shovel,       mat: 'solid', cast: true },
  fence:        { make: K.fence,        mat: 'solid', cast: true },
  crate:        { make: K.crateStack,   mat: 'solid', cast: true },
  mine:         { make: K.mineEntrance, mat: 'solid', cast: true },
  cart:         { make: K.oreCart,      mat: 'solid', cast: true },
  rail:         { make: K.railSegment,  mat: 'solid', cast: false },
  timber:       { make: K.timberPile,   mat: 'solid', cast: true }
};

/* Per-tile dressing recipe. Counts are per tile of that terrain.
 *
 * THE RULE THIS LIST NOW OBEYS: on a hex that grows something, the dressing is
 * either ground you run over or one landmark you could never mistake for a
 * pickup. Nothing in the item's size band, nothing in the item's colour family,
 * nothing with the item's silhouette. "Every backdrop conifer you cannot chop is
 * a triangle spent lying to the player about what they are allowed to touch" has
 * been the note at the top of this block for a while; the counts below are the
 * first version that actually believes it, because thinning a lie does not make
 * it true. The forest lost all twenty-five of its decorative trees, the mountain
 * lost every stone and every brown offcut, the brick hill lost its crumbs, the
 * pasture lost ten of its thirteen fences.
 *
 * The OFF-TERRAIN entries stay culled. A clay hill with spruces on it, a
 * mountain with packing crates, a wheat field with a broadleaf: each was a
 * second silhouette competing with the one thing the hex is supposed to say.
 *
 * The four small item kits doubled in size, which changes what the dressing is
 * FOR on those hexes. A fields tile no longer needs ninety-two decorative wheat
 * tufts to read as gold — the harvestable plants do most of that on their own —
 * and every tuft standing between them is a triangle spent hiding the thing the
 * player came for.
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
  // A FOREST HEX HAS NO TREES ON IT EXCEPT THE ONES YOU CAN CHOP.
  //
  //   "The wood has Phantom trees, where there is visually a tree there, and I
  //    go to collect it and it doesn't exist, and then I find the real final
  //    tree that is a resource I'm able to collect, and once its collected the
  //    phantom tree then disappears. There should be no Phantom trees, only
  //    pickable resources, and the few subtle stumps when its empty waiting to
  //    recharge."
  //
  // That is a precise description of a real defect, and this line was the whole
  // of it. Twenty-five decorative conifers, short pines and broadleaves stood on
  // every forest hex alongside about twenty harvestable ones. They are stacked
  // cones on a trunk; so is `fieldTree`. The only difference between "runs at it
  // and gets wood" and "runs at it and gets nothing" was a slightly lighter
  // green — a tell worth nothing at all at play distance while the settler is
  // moving. And because the dressing is wired into `stand.js`, which spends the
  // whole decorative pool as the hex's fill fraction drops, the last real tree
  // taken is the frame every remaining fake one topples and vanishes. The
  // player's second sentence is not a coincidence, it is the mechanism.
  //
  // Deadwood goes with them: a stump with a fallen log beside it is tree-shaped,
  // it is brown, and on a hex whose resource is WOOD it is exactly the "is this
  // a thing I can take?" question we are trying to stop asking. The three loose
  // pebbles go too — three of anything that small is litter, not scenery.
  //
  // What is left is ground: ferns and grass, ankle-high, that nobody has ever
  // mistaken for a tree, and that crop down to a mat when the hex is worked out.
  // A cleared forest is then bare floor plus the handful of stumps
  // `nodelife.js` leaves, which is precisely what was asked for. The cost is
  // that a low-numbered forest hex now carries eight trees instead of thirty —
  // it reads as open woodland rather than as a canopy. That is the trade the
  // report demands, and honest sparseness beats a lie about what you can pick.
  forest:    { undergrowth: 9, grass: 22 },
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
  //
  // The two green grass tufts and the single small rock are gone. One pebble and
  // two blades on a whole hex is not scenery, it is the "crumbs" reading the
  // player used about the brick tile — too small to mean anything and just big
  // enough to make you look at it.
  // The two bales have moved out of this list and are placed by hand below,
  // for the reason the paddock's bale, the quarry, the mine portal and the
  // brick hill's stones all had to move out of it before them: a prop a report
  // COUNTS cannot be left to a rejection sampler.
  fields:    { wheat: 34 },
  // A PADDOCK IS A FEW BITS OF FENCE. THAT IS THE WHOLE OF IT.
  //
  //   "Just please remove the hay bales from the sheep hexes entirely."
  //
  // So the bale is gone — not moved, not shrunk, gone — and pasture dressing is
  // now two or three fence panels plus the grass and flowers below. Nothing
  // replaces it and nothing is added back to compensate: the note at the top of
  // this file is "I want it to be calming and cute, not overstimulating", and
  // the honest reading of an owner who has asked for LESS on four consecutive
  // passes is that an emptied paddock with three fence panels standing in the
  // grass is the picture he wants, not a paddock with a substitute prop in it.
  // The panels are large enough to carry it: each one is a three-rail ladder
  // 2.1 to 2.3 units long and 1.34 to 1.50 tall (see `fence()` in propkits.js
  // and `STYLE.fence` below), which is head and shoulders over the flock and
  // the tallest thing left on the hex once the sheep are taken.
  //
  // The `hay` kit itself stays alive because the WHEAT FIELD still hand-places
  // two of them; there is no orphaned code here to delete, only one placement
  // block below that has gone.
  //
  // The paragraphs below are the record of how the fences got to two or three.
  //
  //   "The sheep hexes have way too many fences that are just a visual mess —
  //    I think they should be more of like maybe 2 or 3 slightly larger fences,
  //    and a single bale of hay."
  //
  // There were THIRTEEN: nine laid on the arc below plus four more scattered by
  // the recipe, each a pair of near-black posts and a rail. The four loose ones
  // were the worst of it — a fence panel standing on its own in the middle of a
  // field is a mess in a way that a run of fence along the edge is not — so the
  // recipe's share is gone entirely and the arc is down to three, each one half
  // again as big (see `STYLE.fence`). Three larger panels on the rim read as an
  // enclosure at a glance; thirteen small ones read as scaffolding.
  //
  // The rest of the trim is the same principle: the flowers come down because a
  // pasture is grass with flowers IN it rather than a wildflower meadow, and the
  // three pebbles and six ferns go because neither of them was saying anything a
  // sheep hex needs said. The bale then went the same way, one pass later.
  pasture:   { grass: 32, flower: 8 },
  // THE BRICK HEX: GRASS, ONE QUARRY AND ONE SHOVEL.
  //
  //   "Also remove the small rocks from the brick hexes, instead have a small
  //    shovel."
  //
  // THE STONES ARE GONE. Not thinned from three to one — gone, the whole scored
  // ring and its two relaxed passes with them. They were the last survivors of
  // an older brief ("I want maybe a few simple stones") and three passes of
  // work went into making them land reliably; none of that is a reason to keep
  // something the owner has now asked twice to have taken off. A hill carries
  // the quarry as its landmark and that is enough weight for one hex.
  //
  // In their place, ONE small shovel — see `shovel()` in propkits.js for the
  // geometry and the block further down this file for where it stands. One,
  // because the owner has asked for less on every pass since this job started
  // and because two tools beside one pit is a toolshed rather than a detail.
  //
  // The crumbs this hex started with were eight `rockSmall` — a 0.36-unit
  // pebble, instanced eight times — plus two crates and a deadwood vignette,
  // which between them put thirteen small dark objects on a hex whose actual
  // resource is a stack of terracotta bricks. Every one of them was noise at the
  // exact size the thing you came for draws at, and the hex has been getting
  // quieter ever since.
  //
  // The grass comes down so the dug hillside shows through, and
  // then it comes down again by half:
  //
  //   "Remove the satellite shards parked beside the big stones (keep one clean
  //    stone each) and halve the ~15 olive grass sprigs."
  //
  // Fourteen tufts of green grass on a hex whose whole surface is wet terracotta
  // is fourteen small high-contrast marks on the one terrain that has no green
  // in it anywhere else — complementary hue, scattered at pebble size, which is
  // the "crumbs" reading arriving in a different colour. Seven is enough to say
  // the hillside is not sterile and few enough that the dug clay is what you
  // see. The shards beside the stones went with them, and then the stones went
  // too; seven sprigs is now the entire contents of this line.
  hills:     { grass: 7 },
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
  //
  // AND NOW IT IS BARE.
  //
  //   "The ore is similar. There are lots of phantom stones, and weird small
  //    miscellaneous items and brown pieces of something obscure. I'd prefer if
  //    the ore hex when empty just looked like a fully empty, slightly subtly
  //    textured grey hex, nothing else really on it."
  //
  // Every noun in that sentence maps to something on this line. The "phantom
  // stones" were the three boulders and five rubble pieces — grey lumps on a
  // grey hex whose resource is a grey lump, so the player ran at them and got
  // nothing, which is the wood complaint again in a different colour. The "weird
  // small miscellaneous items" were the three spires, tall enough to read as
  // objects and short enough not to read as landscape. The "brown pieces of
  // something obscure" were the timber pile of pit props and the ore cart on its
  // rails — 0.59 and 0.93 units tall, brown, and at play distance genuinely
  // unidentifiable. Halving all of it last time was the wrong move: the answer
  // was never a smaller number of the same objects.
  //
  // So the recipe is empty and the rails and cart below are gone with it. The
  // mine portal is the one thing kept, and only just: it is 3.4 units tall and
  // 5.3 wide, it stands at the hex rim rather than in the middle of the ground
  // you run over, it is the single object that says what this hex IS, and at
  // that size nobody has ever tried to pick it up. Everything the player named
  // is gone; worked out, the hex is bare grey rock with one portal on its edge,
  // which is "nothing else really on it" read as generously as it can be.
  mountains: { },
  // The desert holds the market, and `makePlacer` keeps an 11-unit circle clear
  // around it, so most of this hex was never going to grow anything anyway.
  // What did land on the rim was a lone conifer — a phantom tree by any
  // definition, on the one hex where a tree makes no sense at all — plus three
  // crates, two hay bales and a deadwood log competing with the island's
  // centrepiece from six units away. A few stones and some scrub is all a
  // desert needs to not be a blank tan disc.
  desert:    { rockSmall: 3, boulder: 2, grass: 6 }
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
  // HELD NEAR 1, and that is now load-bearing rather than taste. The quarry's
  // whole pass this time was landing its lip at about luma 92 against a
  // hillside of 79 — "ground+20-30%", to the number — and a +10% variant on top
  // of that puts one hill in three straight back over 100, which is the bright
  // ring the owner asked to have taken off. Three or four per cent of hue swing
  // is all the variation a kit that exists three times on a board needs.
  clayWorks:    [[1.00, 1.00, 1.00], [1.04, 0.99, 0.95], [0.96, 0.97, 0.99]],
  // Held near 1 for the same reason, and tighter still — but for a different
  // reason than it used to be. The shovel used to be deliberately duller than
  // the clay it is stuck in; the owner asked for "normal shovel colors", so it
  // is steel and wood now and it is MEANT to be the bright thing on a worked-out
  // hex. That makes the variation matter more, not less: a +8% swing on a steel
  // blade is a visibly different metal, and three of them on one island would
  // read as three different tools. Three per cent is all a kit that exists three
  // or four times on a whole board needs to stop looking stamped.
  shovel:       [[1.00, 1.00, 1.00], [1.03, 1.00, 0.96], [0.97, 0.98, 1.00]],
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
  // The bale grew by a third, so its exclusion disc grows with it — the half
  // extent of the kit is 0.68 and it is instanced up to 1.30, which is 0.88 of
  // actual bale plus a little collar so nothing ever stands inside one. It is
  // only ever asked for on a wheat field now; the paddock's bale is gone.
  undergrowth: 0.42, grass: 0.26, flower: 0.30, wheat: 0.24, hay: 0.96,
  // The pasture's three panels are hand-placed and reserve three small discs
  // along their own length instead of one fat one, so this entry is only the
  // fallback for a recipe that asks for loose fences. None does any more.
  // clayWorks is down from 1.75 with the kit itself: the widest course is 1.34
  // at unit scale and it is instanced at up to 1.06, so 1.42 is the real
  // footprint and 1.55 is that plus a hand's breadth. Asking for 1.75 of
  // clearance on a hex holding twenty-three brick stacks was a large part of
  // why this thing kept being pushed out onto the rim in the first place.
  // boulder is 0.88 rather than 0.92 because that is what the kit measures now
  // the satellite shard has been cut off the side of it (see `boulder()` in
  // propkits.js): the lead stone alone is 1.38 across at unit scale and is
  // instanced to at most 1.25, so 0.86 is its true half width.
  // `mine` comes down with the kit itself (see `mineEntrance` in propkits.js):
  // the portal is 1.62 across at unit scale and is instanced at 1.22, so 0.99
  // is its true half width and 1.30 is that plus a collar. It was 2.40 for a
  // frame nearly twice this wide. Nothing on a mountain reads it — the recipe
  // for that terrain is empty and this only ever keeps other PROPS off — but a
  // footprint that lies about a landmark's size is how the next pass over this
  // file gets its arithmetic wrong.
  // `shovel`'s footprint follows its instance scale, which the owner doubled.
  // The kit leans 0.42 radians off vertical, so at unit scale its grip end
  // reaches 0.54 sideways of the blade and the crossbar adds 0.14 on top: 0.68
  // of lean from the blade, halved about the piece's own middle is 0.34, and
  // 0.45 was that plus a collar. At the doubled scale that is 0.90, and it has
  // to be stated here rather than left at 0.45 — a footprint that lies about a
  // landmark's size is precisely how the scorer below ends up parking a tool
  // through a brick stack. It is still thin enough to find a spot beside the
  // quarry on a hex holding twenty-eight of them, which is why a tool rather
  // than another rock was the right thing to put here.
  rockSmall: 0.32, boulder: 0.88, spire: 0.90, clayWorks: 1.55, fence: 1.30,
  crate: 0.70, mine: 1.30, cart: 0.75, rail: 0.70, timber: 0.85, shovel: 0.90,
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
/*
 * ...and on a PASTURE it moved because the sheep did.
 *
 * `FOOT.item` is 1.12 and it is a generous keep-out rather than a measurement:
 * it was set so a tuft of grass never sprouts out of the top of a two-unit-wide
 * brick stack. The density compensation in `nodelife.js` has taken about 39% of
 * the fleece area off a 28-sheep hex, so 1.12 of exclusion around every one of
 * twenty-eight animals is now reserving a good deal of ground that has nothing
 * standing on it — and on the hex where space is tightest, that is the
 * difference between a paddock that can find two bearings for a fence panel and
 * one that can only find a single lone one. 0.95 is a shrunk sheep measured
 * across its fleece and halved, plus a little, which is what this number is
 * supposed to be rather than the blanket figure the brick stack set.
 */
/*
 * ...and on a BRICK HILL it moved because the hex is the most crowded one that
 * still has to find room for something the player is meant to look at.
 *
 * 0.92 is the honest measurement for what a brick stack actually occupies: the
 * spoil cone under it is 1.28 across and the widest course is 0.94, so 0.64 is
 * the real footprint and 0.92 leaves a quarter of a unit of collar on top of
 * it. 1.12 was never about the brick — it was about a tuft of GRASS sprouting
 * out of the top of one, and there are seven tufts left on a hill now instead
 * of fourteen.
 *
 * The stones this number was last tuned for are gone ("remove the small rocks
 * from the brick hexes"), and it is kept at 0.92 rather than being put back to
 * the blanket 1.12 because what is left on the hex needs it just as much: seven
 * grass sprigs go through `take`, and the shovel that replaced the stones is
 * scored against these same discs. An honest collar is what lets a small prop
 * stand on open clay instead of being pushed to the rim.
 */
const ITEM_FOOT = { fields: 0.92, pasture: 0.95, hills: 0.92 };

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
  // Up a third, because the kit under it grew and because a bale has to survive
  // the number token and a corner banner standing near it. At this scale a bale
  // is 1.43 to 1.77 units across and stands about 1.5 high — waist-high on the
  // settler, comfortably the biggest single object on an emptied wheat field,
  // and still nowhere near the 3.4-unit mine portal or the 2.8-unit clay working
  // that are the island's actual landmarks. The scale is unchanged now that the
  // paddock's bale is gone: the two that are left stand on ploughed ochre, where
  // the same size does the same job.
  hay:          { s: [1.05, 1.30], sink: 0.06, tilt: 0.30, yaw: true },
  rockSmall:    { s: [0.55, 1.35], sink: 0.12, tilt: 0.85, yaw: true },
  // The cap this used to sit under is gone, because the thing it was capped
  // against is gone: it was held to 0.62..1.10 so that it could never be
  // mistaken for the harvestable ore lump it shared a mountain with, and no
  // mountain carries a boulder any more. It was then grown to 0.85..1.25 for
  // the brick hill's "few simple stones", which is a hex it no longer stands on
  // either. What is left is the DESERT and the shoreline collar, and the size
  // suits both: a 0.79-to-1.16-high dome is a shape on a blank tan disc, and on
  // the waterline it is the lead rock of a cluster with `rockSmall` huddled
  // round it. Nothing on either of those grows anything, so there is nothing
  // for it to be confused with in the first place.
  boulder:      { s: [0.85, 1.25], sink: 0.20, tilt: 0.65, yaw: true },
  // SMALL, AND THE NUMBER IS THE POINT.
  //
  //   "Also remove the small rocks from the brick hexes, instead have a small
  //    shovel."
  //
  // "A small shovel" is the entire specification and the adjective is the half
  // that is easy to lose, because the thing being replaced was not small: the
  // stones ran 0.85 to 1.25 and the owner still called the pass before them
  // crumbs, so "bigger than a crumb" and "small" are both in the brief and only
  // one of them is written down. The tie-breaker is the quarry. A hills hex is
  // allowed exactly one landmark and it already has it, so whatever stands
  // beside it has to lose to it at a glance.
  //
  // The kit is 1.27 units tall at unit scale, so this band puts it at 1.07 to
  // 1.19 on the ground: about two fifths the width of the 2.6-to-3.0-unit
  // quarry it stands beside, and under the 1.5-to-2.3-unit brick stacks it
  // shares the hex with. The band is narrow on purpose — three or four hills on
  // a board should carry the same tool, not three sizes of it, which is the
  // argument the mine portal's fixed 1.22 already makes.
  //
  // `yaw: false` because the yaw is chosen for legibility rather than for
  // variety (see the hills block below), and `drop` is handed an explicit `sy`
  // so the shaft is never stretched: the kit's whole read is a straight stick at
  // a known angle, and a random 0.88..1.18 on Y bends that angle.
  //
  // Barely sunk. The blade is authored running 0.15 BELOW the kit's own origin
  // — it is driven into the clay, not resting on it — so sinking the instance on
  // top of that starts eating the tread, which is the one horizontal tick that
  // tells the lower half from the shaft. The tilt is small for the same reason
  // the portal's is: a tool stuck in the ground stands the way somebody left it,
  // not the way the hillside leans.
  /* DOUBLED. "Make the shovel 2x the size and normal shovel colors." The kit
     itself is untouched — the blade, tread, socket, shaft and grip were tuned
     against each other and doubling them here keeps every one of those ratios
     while making the whole tool read at play distance instead of at a walk-up.
     Its footprint doubles with it, below, or the placer would keep finding it
     spots that no longer fit. */
  shovel:       { s: [1.68, 1.88], sink: 0.02, tilt: 0.12, yaw: false },
  spire:        { s: [0.75, 1.60], sink: 0.20, tilt: 0.45, yaw: true },
  // The one landmark on a brick hex, so it has to be legible from across the
  // island and still not be a distraction. The kit is inherently flat — a spoil
  // bank thrown up round a two-step cut — so it is grown sideways rather than
  // upwards: at this scale it is a 2.6-to-3.0-unit working standing 0.45 to
  // 0.70 at its lip, against the 1.5-to-2.3-unit brick stacks it shares the hex
  // with. It reads as ground that has been DUG, which is exactly the right kind
  // of quiet for a thing that is not part of the game — and since the block of
  // cut clay came off it (see `clayWorks` in propkits.js) there is nothing left
  // on it a player could run at.
  //
  // The sink comes off with the block. The kit's own outer bank now runs half a
  // unit below its origin so the hillside's painted undulation cannot leave a
  // lit edge hanging in the air; sinking it on top of that would start eating
  // the lip.
  //
  // DOWN from 1.25..1.45, and that is a consequence of where it now stands
  // rather than of how it looks. The old scale put a 3.9-unit-wide kit on the
  // hex RIM, so a third of its footprint hung over the ramp into the tan border
  // strip and its base was buried in the raised edge — "its base buried in /
  // clipped by the raised hex rim". Inside the tile, on ground that is dead
  // flat out to hexFrac 0.80, nothing clips; but the interior is also where the
  // brick stacks are, so the kit has to be small enough that the placer can
  // find it a home there. 2.7 units is that size.
  clayWorks:    { s: [0.92, 1.06], sink: 0.02, tilt: 0.25, yaw: true },
  // "maybe 2 or 3 slightly larger fences". There are two or three of them now
  // instead of thirteen, so each one has to carry the whole idea of an
  // enclosure on its own — and after the reviewer's pass, each one is a
  // three-rail LADDER 2.1 units long and 1.34 tall rather than a single bar on
  // two knee-high posts (see `fence()` in propkits.js). At this scale that is a
  // 2.1-to-2.3-unit panel standing 1.34 to 1.50 high: shoulder height on the
  // settler, head and shoulders over the flock, and a good half again the mass
  // of the panel it replaces even though the multiplier came DOWN. The
  // multiplier had to come down, because the geometry grew and the panel still
  // has to find a bearing on a hex holding twenty-eight animals.
  fence:        { s: [1.00, 1.12], sink: 0.10, tilt: 0.40, yaw: true },
  crate:        { s: [0.78, 1.26], sink: 0.06, tilt: 0.40, yaw: true },
  // The band is a fallback only — the portal is hand-dropped below at a fixed
  // 1.22 so three mountains on one board are the same landmark and not three
  // sizes of it. At that scale the kit is 1.98 units wide and 1.68 tall, and it
  // photographs between 9% and 11% of the hex's flat-to-flat width depending on
  // which side of the hex it lands and how the peaks under it lift it toward
  // the lens — against the 19-20% the last version measured. "Just make the
  // large mine entrance on the ore hexes much smaller." Sunk a touch deeper
  // than before because the frame is shorter and the sill has less of its own
  // height to hide the ground in.
  mine:         { s: [1.15, 1.25], sink: 0.06, tilt: 0.10, yaw: false },
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
    blocked.push({ x: it.x, z: it.z, r: itemFoot, item: true });
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
  /* THE SIX CORNERS ARE NOT DRESSING GROUND. THEY BELONG TO THE PLAYERS.
   *
   *   "On hex 12 a hay bale at the bottom-left vertex is bisected by the purple
   *    road quad, with the bale poking out below it and a black banner pole
   *    passing vertically through its right side."
   *
   * That is the second time a bale has been photographed cut in half at a hex
   * vertex, and the last pass fixed the wrong half of it: it pulled the bale in
   * off the ROAD STRIP, which is a band along each EDGE and which the dressing
   * was already clear of. What actually stands at a vertex is a settlement, and
   * a settlement is not a strip — it is a 3.5-unit pad of cottages (SET_RADIUS
   * 1.78 in buildtown.js), or a 5.5-unit city (CITY_RADIUS 2.72) with a curtain
   * wall, two towers and three banners on it, and both of them fly a pole over
   * three units tall. None of that exists at build time, which is exactly why
   * this has to be geometric: WHERE those pieces can stand is fixed by the
   * board, even though whether they do is not.
   *
   * 3.55 is the city's outermost banner — its pole sits at CITY_RADIUS*0.94 and
   * the cloth hangs 0.57 past that, so 3.10 — plus a hand's breadth, and the
   * prop's own footprint is added on top of it by `clear`. A bale therefore
   * keeps 4.51 units between its centre and the corner, which at the play
   * camera's pitch puts its base a clear head above the roofline of anything
   * built there rather than tangled in it.
   *
   * It is NOT applied to ground cover, and that is deliberate rather than
   * lazy. Grass, ferns, flowers and the stubble mat are ankle-high things you
   * run over; a road laid across them or a village pad set down on them reads
   * as a road and a village standing in a field, which is correct. Six bald
   * discs at the corners of every hex would be a far louder defect than the one
   * being fixed. What has to stay clear is anything with a SILHOUETTE — a bale,
   * a stone, a fence panel, the quarry, the portal — because those are the
   * things that get cut in half.
   *
   * Nor is it applied by the last-resort passes below. Each of those exists
   * because some 5-pip hex has nowhere at all left to stand a landmark, and a
   * pasture with no fence or a hill with one stone is a worse picture than a
   * bale near a corner that may never be built on. Strict first, corners
   * respected; only if that comes up short does the civic ring come off. */
  const CIVIC_R = 3.55;
  for (let i = 0; i < 6; i++) {
    const c = cornerOffset(i);
    blocked.push({ x: tile.x + c.x, z: tile.z + c.z, r: CIVIC_R, civic: true });
  }
  /* Shared by `take` and by the hand-placed pieces (the pasture's fence arc and
     the hills' clay works), which used to skip the test entirely and could
     therefore stand a fence panel straight through a sheep. One predicate, one
     answer.

     `itemR` overrides the radius used for the ITEM discs only, and exists
     because those discs are a generous keep-out rather than a measurement:
     `FOOT.item` is 1.12 so that a tuft of grass never sprouts out of the top of
     a brick stack, while the widest sheep on the island is 1.42 across at its
     fleece. A thin fence panel riding the outer rim of a hex only has to miss
     the animal, not the animal's whole exclusion collar, and at 1.12 there is
     no bearing on a twenty-eight sheep pasture where a panel fits at all.

     `civicR` does the same for the six CORNER discs and works the same way: 0
     switches them off for ground cover, and the relaxed passes hand it 3.00 —
     a city's curtain wall plus a hand — so a landmark that could not be placed
     under the full keep-out still never ends up with its body inside a city
     pad. */
  function clear(x, z, foot, itemR, civicR) {
    for (const b of blocked) {
      let r = b.r;
      if (b.item && itemR !== undefined) r = itemR;
      else if (b.civic && civicR !== undefined) r = civicR;
      const dx = b.x - x, dz = b.z - z;
      const rad = r + foot;
      if (dx * dx + dz * dz < rad * rad) return false;
    }
    return true;
  }

  return {
    blocked,
    clear,
    /* `itemR` narrows the keep-out used for the ITEM discs only, exactly as in
       `clear` above, and exists so a kit that is not allowed to fail can have a
       second, tighter go at a hex the first pass found no room on. Nothing is
       ever allowed to overlap an item even then; what is given up is the collar
       of clear ground around it.

       `noLane` keeps the kit out of the strip the number token covers, and any
       prop the player is meant to SEE has to ask for it. The lane is item-free
       by construction (`clearOfToken` in board/nodes.js), which makes it the
       only wide open ground on a hex holding twenty-three of anything — so a
       uniform sampler, which is what this is, drops a disproportionate share of
       its accepted darts there and the prop ends up parked behind the token
       disc where nothing can be looked at. Ground cover does not care and does
       not ask; a decorative stone the report is counting cares a great deal.
       The test is the lane's own definition widened by the kit's radius, so the
       prop is not merely outside the strip, it is clear of it.

       `civicR` narrows the six corner discs — see the block that pushes them. */
    take(count, foot, maxF = PROP_MAX_FRAC, itemR, noLane = false, civicR) {
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
        if (noLane && z - tile.z < 0.80 + foot
          && Math.abs(x - tile.x) < 2.25 + foot) continue;
        if (!clear(x, z, foot, itemR, civicR)) continue;
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

    // The mine portal first, so it owns the best spot on a mountain — and it is
    // now the ONLY thing on a mountain, which changes where the best spot is.
    //
    //   "I'd prefer if the ore hex when empty just looked like a fully empty,
    //    slightly subtly textured grey hex, nothing else really on it."
    //
    // It used to stand at bearing `away` — pointing out of the island — and
    // face that way, on the theory that a mine is cut into a hillside and a
    // hillside faces the sea. Two things were wrong with that, and both of them
    // only became visible once every other prop came off the hex.
    //
    // IT SHOWED ITS BACK. `PLAY_YAW` in systems/camera.js is 0, so the camera
    // always sits on +Z. A portal on the far side of the island faces -Z, and
    // the back of this kit is two black boxes (the adit, which is meant to be
    // seen THROUGH the timber frame) with plain plank behind them. On a hex
    // that still had thirty other objects on it that was a detail; on an empty
    // grey hex it is a featureless black slab standing on the rim, and a black
    // slab is the last thing a hex that just got its value lifted out of the
    // floor needs. It faces +Z now, on every mountain, so what the player sees
    // is always the timbered mouth.
    //
    // IT STOOD WHERE THE ORE STANDS. Bearing `away` is a different bearing on
    // every mountain and about half of them put the portal on the near rim,
    // between the camera and the field. Held on the BACK of the hex it is
    // behind everything the player runs at, and it lands in the strip the
    // number token shadows — which `clearOfToken` in board/nodes.js keeps free
    // of items by construction, so the one place on the hex where a landmark
    // can never hide a pickup. Nudged off the hex's own axis by a radian,
    // alternating side by tile id — enough that the number token, whose painted
    // disc is about 1.8 world units across at the play camera, is not sitting in
    // the middle of a 5.3-unit portal, and enough that three mountains on one
    // board are not three identical photographs.
    //
    // AND IT CAME IN OFF THE RIM WITH THE KIT, 0.48/0.44 to 0.44/0.40. That is
    // about three quarters of a unit, and it buys two things at once. The
    // portal is half the size it was (see `mineEntrance` in propkits.js), so
    // parked out at 0.48 it read as something abandoned on the edge of the tile
    // rather than as a working cut into it; and 0.44/0.40 is what puts 5.14
    // units between it and the nearest hex vertex, which is more than the
    // 4.85 a city's outermost banner plus this kit's own footprint needs. The
    // portal is dropped by hand rather than through `take`, so it is the one
    // landmark on the island the corner discs in `makePlacer` cannot police for
    // us — it has to be placed clear by construction.
    if (tile.terrain === 'mountains') {
      const bear = -Math.PI / 2 + (tile.id % 2 ? 1.00 : -1.00);
      const mx = tile.x + Math.cos(bear) * HEX_SIZE * 0.44;
      const mz = tile.z + Math.sin(bear) * HEX_SIZE * 0.40;
      // ry = 0 leaves the model's local +Z pointing at world +Z, which is the
      // camera. The small skew is variety, not aim.
      const yaw = (tile.id % 2 ? -0.16 : 0.16);
      placer.blocked.push({ x: mx, z: mz, r: FOOT.mine });
      drop('mine', mx, mz, rng, { ry: yaw, s: 1.22, sy: 1.22 });
      // THE RAILS AND THE CART ARE GONE. They were the "brown pieces of
      // something obscure" by name: a 0.14-unit sleeper and a 0.93-unit tub,
      // laid in a line running from the portal into the middle of the ground
      // the player has to sweep. At play distance neither one resolved into
      // anything — they were three brown dashes and a brown box on grey rock —
      // and they sat exactly where the ore does, so they read as items that
      // could not be picked up. A mine portal on its own says mine perfectly
      // well; the railway was set dressing for a story nobody was reading.
    }

    // A paddock is three larger panels on the rim, not thirteen small ones.
    //
    //   "The sheep hexes have way too many fences that are just a visual mess."
    //
    // Nine on this arc plus four dropped loose by the recipe. Nine at 0.30
    // radians apart on a 5.0-unit radius is a panel every 1.5 units with a
    // 1.7-unit panel to fill it: a continuous wooden wall around three quarters
    // of the hex, in the darkest value on the tile, standing between the camera
    // and the sheep. Three at 0.78 radians is a panel every 3.9 units — three
    // distinct bits of fence with clear grass between them, which is how a
    // paddock actually reads, and how it stays a backdrop rather than a barrier.
    //
    // Two more things were wrong with the arc and both of them show up the
    // moment there are only three panels left to carry it.
    //
    // IT WAS NOT TANGENTIAL. `ry = a + PI/2` looks like the right yaw and is
    // not: a Y rotation of theta sends a model's local +X to world
    // (cos theta, -sin theta), so lining the panel up along the tangent
    // (-sin a, cos a) needs theta = -(a + PI/2). At the old yaw each panel sat
    // at an angle to the ring that changed with its bearing, so nine of them
    // came out as nine differently-skewed planks rather than as one fence —
    // which is a good part of what "just a visual mess" was describing.
    //
    // IT IGNORED THE FLOCK. The arc pushed straight into `blocked` without ever
    // testing it, so a panel could and did stand through a sheep. It is tested
    // now, and tested at three points along its own length rather than as one
    // fat disc at its centre: a fence is a 2.7-unit plank about a fifth of a
    // unit thick, and a circle big enough to contain it would refuse every
    // position on a hex holding twenty-eight items.
    //
    // Picked by FARTHEST-POINT, not by walking. A twenty-eight sheep pasture
    // only leaves a handful of bearings on the whole ring where a panel fits at
    // all, and they arrive in clumps — so "walk round and take the first three
    // that are 1.2 radians apart" placed ONE fence on a quarter of the pastures
    // measured over twelve boards. Collecting every bearing that fits and then
    // repeatedly taking the one furthest from what is already down turns that
    // into three fences on nine pastures out of ten and two on most of the rest,
    // spread as widely as the flock allows. `PANEL` is the panel's own half
    // length, so the three samples are its two ends and its middle.
    //
    // THE RINGS CAME IN OFF THE RIM, and that is the reviewer's note:
    //
    //   "Keep them off the hex rim where they merge with the border, and clamp
    //    the minimum to 2 panels so no pasture ever shows a single lone panel."
    //
    // They used to ride hexFrac 0.78 and 0.70. 0.78 is the outermost row the
    // prop zone allows and the tan road strip starts at 0.81, so a panel out
    // there stood with its posts a few centimetres from the border line, in a
    // dark plank colour, along the same direction the border runs — and at the
    // play camera's shallow pitch the two merged into one dark edge. Worse, the
    // tile top is only flat out to about 0.80 and starts ramping to the
    // neighbour after that, so the outer panel sat on the beginning of the
    // slope. 0.66 and 0.56 put both rings on flat green well inside the hex,
    // where a fence casts its own shadow onto grass and reads as a thing
    // standing IN a field. `hexFrac` is homogeneous in the offset, so one divide
    // lands the panel exactly on a ring whatever bearing it is on, and the ring
    // is an irregular hexagon rather than a circle — which is why this is not
    // simply `HEX_SIZE * k`.
    //
    // THE MINIMUM IS TWO. One panel on its own is not an enclosure, it is a
    // plank somebody dropped; and because the ring moved inward, where the
    // flock is denser, a lone panel became MORE likely rather than less. So if
    // the ordinary pass ends up with fewer than two, a relaxed pass runs: the
    // sheep collar drops from 1.22 to 1.02 (the widest sheep is 1.42 across at
    // its fleece, so 1.02 plus the panel's own 0.20 still clears an animal), two
    // more rings are offered, and the angular separation bar comes off. There is
    // always at least one bearing that works even then — the strip the number
    // token shadows (`clearOfToken` in board/nodes.js) is item-free by
    // construction and crosses every ring at the back of the hex — so the
    // relaxed pass cannot come up empty while the strict one found anything.
    if (tile.terrain === 'pasture') {
      const a0 = rng() * Math.PI * 2;
      const PANEL = 1.10;
      const chosen = [];
      const sweep = (rings, itemR, room2, foot = 0.20, steps = 72, civicR) => {
        const fit = [];
        for (const ring of rings) {
          for (let i = 0; i < steps; i++) {
            const a = a0 + i * (Math.PI * 2 / steps);
            const rad = ring / hexFrac(Math.cos(a), Math.sin(a));
            const fx = tile.x + Math.cos(a) * rad;
            const fz = tile.z + Math.sin(a) * rad;
            const tx = -Math.sin(a), tz = Math.cos(a);
            const pts = [-PANEL, 0, PANEL].map(o => [fx + tx * o, fz + tz * o]);
            if (pts.every(p => placer.clear(p[0], p[1], foot, itemR, civicR))) {
              fit.push({ a, fx, fz, pts });
            }
          }
        }
        while (fit.length && chosen.length < 3) {
          let best = null, bestD = -1;
          for (const c of fit) {
            let d = Math.PI;
            for (const k of chosen) {
              let da = Math.abs(c.a - k.a) % (Math.PI * 2);
              if (da > Math.PI) da = Math.PI * 2 - da;
              if (da < d) d = da;
            }
            if (d > bestD) { bestD = d; best = c; }
          }
          // Two panels closer than this read as one bent fence with a kink in
          // it, which is worse than two panels. The bar is lower for the SECOND
          // panel than for the third, because one lone panel does not read as a
          // paddock at all — two a little close together beats one on its own,
          // and three a little close together does not beat two well spread.
          const room = chosen.length >= 2 ? 0.62 : room2;
          if (!best || (chosen.length && bestD < room)) break;
          chosen.push(best);
          for (const p of best.pts) placer.blocked.push({ x: p[0], z: p[1], r: 0.55 });
          drop('fence', best.fx, best.fz, rng, { ry: -(best.a + Math.PI / 2) });
        }
      };
      // The strict pass keeps the panels clear of the corner discs; the two
      // relaxed passes below do not, because a pasture showing one lone plank
      // is a worse picture than a panel standing near a corner that may never
      // be built on. See the civic block in `makePlacer`.
      sweep([0.66, 0.56], 1.12, 0.45);
      if (chosen.length < 2) sweep([0.72, 0.62, 0.50, 0.40], 0.95, 0.20, 0.20, 72, RELAX_CIVIC);
      // Last resort, and it fires on about one pasture in fifty: a 5-pip hex
      // holding twenty-eight sheep that also sits inside the market's 11-unit
      // exclusion circle and carries a player spawn on its rim. Measured over
      // twelve boards, that combination is the only thing that beats the pass
      // above. Here the panel is measured against what a sheep ACTUALLY
      // occupies — 0.85 at the widest fleece the density compensation now
      // allows — plus a plank half-thickness of 0.10, on six rings at five
      // degrees. Nothing is allowed to overlap an animal even here; what is
      // given up is the collar of clear ground around it, which is a smaller
      // price than a paddock with one plank lying in it.
      if (chosen.length < 2) {
        sweep([0.76, 0.68, 0.60, 0.52, 0.44, 0.36], 0.86, 0.12, 0.10, 120, RELAX_CIVIC);
      }
    }

    // TWO BALES ON A WHEAT FIELD, BOTH OF THEM WHERE THEY CAN BE SEEN.
    //
    //   "A second hay bale is jammed at the bottom rim in
    //    sw-fields-3-cleared.png and the purple road ribbon cuts through it.
    //    Nudge it clear."
    //
    // The bales used to come out of `RECIPE.fields` through `take()`, which
    // throws darts at the whole prop zone out to hexFrac 0.78 and keeps
    // whatever fits. 0.78 is measured to a CENTRE: a bale is 1.43 to 1.77 units
    // across and reserves 0.96, so one dropped out there reaches 0.90, a third
    // of it standing on the ramp into the tan border strip at 0.81 with a road
    // drawn straight over the top of it. Held to 0.58 the far side lands at
    // 0.70 and the whole bale sits on the crop, where a bale belongs.
    //
    // And it is kept out of the number token's strip, which is the trap that
    // catches every uniform sampler on this island. `clearOfToken` in
    // board/nodes.js leaves that strip item-free by construction, so on a
    // twenty-eight sheaf field it is very nearly the only ground a 0.96-radius
    // disc can land on at all — both bales went behind the token disc and a
    // cleared wheat hex photographed as completely bare. Two relaxed passes
    // stand behind the strict one so the field never comes out with none: the
    // ring opens to 0.66 and then 0.70 and the sheaf's collar comes down toward
    // its true half width, but the bale is never allowed to overlap a sheaf and
    // never allowed into the token's shadow.
    //
    // AND IT IS KEPT OFF THE VERTICES, WHICH IS THE HALF THAT WAS MISSED.
    //
    //   "On hex 12 a hay bale at the bottom-left vertex is bisected by the
    //    purple road quad, with the bale poking out below it and a black banner
    //    pole passing vertically through its right side."
    //
    // Ring 0.58 is measured on `hexFrac`, which is a hexagon: along a CORNER
    // bearing that is 5.22 units out of 9.00, so the bale could stand 3.78 from
    // a vertex — inside a city's curtain wall (2.72) and well inside the reach
    // of a village's banner. The corner discs in `makePlacer` push it to 4.51,
    // which clears both. The two relaxed passes fall back to RELAX_CIVIC, which
    // still keeps the bale's body outside a city's curtain wall — a field with
    // one bale on it is a worse picture than a bale near a corner, but not so
    // much worse that the bale should be allowed inside the walls.
    if (tile.terrain === 'fields') {
      const bales = placer.take(2, FOOT.hay, 0.58, undefined, true);
      if (bales.length < 2) {
        for (const p of placer.take(2 - bales.length, FOOT.hay, 0.66, 0.74, true, RELAX_CIVIC)) {
          bales.push(p);
        }
      }
      if (bales.length < 2) {
        // Last resort on a 5-pip field: the sheaf's collar comes down to its
        // own half width. 0.58 plus the bale's 0.96 still clears an actual
        // sheaf; the ring does not move again, because 0.66 is already where a
        // 0.88-radius bale reaches 0.77 and the road strip starts at 0.81.
        for (const p of placer.take(2 - bales.length, FOOT.hay, 0.66, 0.58, true, RELAX_CIVIC)) {
          bales.push(p);
        }
      }
      // ...AND ON A 5-PIP FIELD ALL THREE OF THEM STILL COME BACK EMPTY.
      //
      // The block above claims "the field never comes out with none". It is not
      // true and never was: run over forty boards, a 5-pip fields hex gets two
      // bales 16% of the time, one 43% of the time, and NOTHING AT ALL the
      // other 41%. (Measured with the corner discs on and off — the numbers are
      // identical either way, so this is not something this pass caused. It is
      // something this pass's census in `tools/shoot.mjs` finally shows.)
      //
      // The reason is arithmetic and no amount of relaxing fixes it. Twenty-
      // eight sheaves blue-noise spaced about 2.1 apart leave gaps of roughly a
      // unit; a bale reserves 0.96 and a sheaf's own butt is 0.85 across at the
      // widest scale, so two of them cannot both stand in one gap however
      // generously the collars are trimmed. On the crowded hexes there is
      // honestly room for ONE bale, and the thing worth guaranteeing is one
      // rather than two — a cleared field with a bale on it reads as a farm and
      // a cleared field with nothing on it reads as a mud patch.
      //
      // So the floor drops to one and is placed the way every other landmark on
      // this island that is not allowed to fail is placed: scored over rings
      // instead of sampled, taking the roomiest bearing there is. Same three
      // terms as the paddock's bale — slack, a lean toward the camera, and the
      // token lane scored as disqualifying-unless-there-is-nothing-else — and
      // the same guarantee, which is that a scorer always returns something.
      if (!bales.length) {
        let best = null;
        for (const ring of [0.58, 0.48, 0.38]) {
          for (let i = 0; i < 48; i++) {
            const a = i * (Math.PI * 2 / 48);
            const rad = ring / hexFrac(Math.cos(a), Math.sin(a));
            const bx = tile.x + Math.cos(a) * rad;
            const bz = tile.z + Math.sin(a) * rad;
            let slack = Infinity;
            for (const b of placer.blocked) {
              // 0.66 is a sheaf measured across its own butt end and halved,
              // which is what the bale actually has to miss; ITEM_FOOT.fields
              // is 0.92 and is a collar of clear ground on top of that.
              const need = (b.item ? 0.66 : b.r) + FOOT.hay;
              const d = Math.hypot(b.x - bx, b.z - bz) - need;
              if (d < slack) slack = d;
            }
            const lx = bx - tile.x, lz = bz - tile.z;
            const inLane = lz < 0.80 + FOOT.hay && Math.abs(lx) < 2.25 + FOOT.hay;
            const score = Math.min(slack, 1.00) + (inLane ? -2.20 : 0)
              + Math.sin(a) * 0.60 + (ring === 0.58 ? 0.18 : 0);
            if (!best || score > best.score) best = { score, bx, bz };
          }
        }
        if (best) {
          placer.blocked.push({ x: best.bx, z: best.bz, r: FOOT.hay });
          bales.push({ x: best.bx, z: best.bz });
        }
      }
      for (const p of bales) drop('hay', p.x, p.z, rng);
    }

    // THE PADDOCK'S BALE USED TO BE PLACED HERE, AND IT IS GONE.
    //
    //   "Just please remove the hay bales from the sheep hexes entirely."
    //
    // What stood here was a scored ring placement — forty-eight bearings on two
    // rings, weighted by clearance, biased toward +Z so the number token and a
    // corner banner could not stand in front of it — put in specifically because
    // the rejection sampler kept parking the bale dead centre behind the tile
    // flag. It worked, and the owner still does not want a bale on a sheep hex,
    // which settles it: the whole block is deleted rather than tuned. A pasture
    // is its fence panels, its grass and its flock now.
    //
    // Nothing is put in its place. That is a decision and not an omission — the
    // standing note on this file is "I want it to be calming and cute, not
    // overstimulating", and swapping one waist-high prop for a different
    // waist-high prop would be answering "remove it" with "here is another one".
    // The one thing worth watching is whether an emptied paddock now reads as
    // BARE with only two or three fence panels on it; that is a judgement for a
    // photograph rather than for this comment, and the sweep captures it.
    //
    // The `hay` kit itself is still alive and still hand-placed — on the wheat
    // field, thirty lines above. There is no orphan here to sweep up.

    // ONE CLAY QUARRY, PLACED ON PURPOSE.
    //
    //   "something that is one item that looks like a clay quarry but not in a
    //    distracting visual way."
    //
    // It used to be three of them dropped by the rejection sampler wherever they
    // happened to fit, which is how you get three quarries in a huddle on one
    // side of a hill and none at all on the next hill along — the sampler needs
    // a 2.42-unit clearance for this kit and a twenty-three item brick hex does
    // not always have one. Three is a pattern and none is a missing landmark;
    // exactly one, on the rim, facing out of the island, is a landmark. Same
    // treatment the mine portal gets on a mountain, and for the same reason.
    // SCORED, not walked. "Try bearings in order and take the first that fits"
    // is how the mine portal is placed and it is wrong for this one, because
    // this one has no privileged spot to start from and no right to fail: a
    // brick hex with no quarry on it is a brick hex missing the thing the
    // player asked for. A hill holding twenty-three stacks, sitting one hex
    // from the market's 11-unit exclusion circle, with a player spawn on its
    // outer rim, has no bearing on any ring that satisfies a fixed clearance —
    // and on the boards measured, exactly one hill in thirty-six was like that.
    //
    // So every bearing on two rings is SCORED by how much room it has beyond
    // what the kit needs, that score is capped (past about a unit of slack more
    // room stops mattering), and a thumb goes on the scale. Where there is room
    // the quarry lands where the scoring wants it; where there is not, it lands
    // in the roomiest place there is. It always lands.
    //
    // AND THE THUMB NOW PUSHES THE OTHER WAY.
    //
    //   "Currently a small terracotta cone with its base buried in / clipped by
    //    the raised hex rim ... Move it into the tile interior."
    //
    // The rings were 0.72 and 0.60 with a +0.35 bonus for the outer one and
    // another +0.30 for facing off the island, which between them made "on the
    // rim, looking outward" win almost every time. That was a deliberate choice
    // and it was wrong on the geometry: `heightAt` holds a tile top dead flat
    // only out to about hexFrac 0.80 and then ramps down across the tan border
    // strip to the neighbour, and the raised painted lip of the hex sits right
    // in that band. A 3.9-unit-wide kit centred at 0.72 reaches 0.90 on its
    // outer side — over the lip, on the ramp — so its far edge sank into the
    // rim while its near edge stayed up on the flat. That is the clipping.
    //
    // 0.50 and 0.38 put the whole kit, at every bearing, inside the flat. The
    // outward-facing bonus goes with it: an object in the middle of a hex has
    // no "outward" that means anything, and pointing the block on its lip at the
    // sea was only ever a story about a quarry cut into a hillside — which this
    // is no longer, because it is a pit now and a pit has no facing. The yaw
    // comes from the bearing anyway, so the block still lands on a different
    // side of the pit on every hill.
    if (tile.terrain === 'hills') {
      const away = Math.atan2(tile.z, tile.x) || 0.3;
      let best = null;
      for (const ring of [0.50, 0.38]) {
        for (let i = 0; i < 36; i++) {
          const a = away + i * (Math.PI * 2 / 36);
          const rad = ring / hexFrac(Math.cos(a), Math.sin(a));
          const cx = tile.x + Math.cos(a) * rad;
          const cz = tile.z + Math.sin(a) * rad;
          let slack = Infinity;
          for (const b of placer.blocked) {
            // 1.05 rather than FOOT.item's 1.12 for the brick stacks: the works
            // is a flat cut step, not something that sprouts out of one.
            const need = (b.item ? 1.05 : b.r) + FOOT.clayWorks;
            const d = Math.hypot(b.x - cx, b.z - cz) - need;
            if (d < slack) slack = d;
          }
          // THE TOKEN'S SHADOW IS A TRAP FOR ANY SCORER THAT MAXIMISES ROOM.
          // The roomiest ground on every hex is the strip the number token
          // covers, because `clearOfToken` in board/nodes.js keeps items out of
          // it by construction — so a bare "most clearance wins" score put the
          // quarry directly behind the token disc on hill after hill, which is
          // the one place on the tile where a landmark cannot be looked at. A
          // smooth +Z lean was not enough on a 28-item hill, where every bearing
          // outside the lane scores negative slack and the lane still wins by a
          // length. So the lane is scored as what it is: disqualifying, unless
          // there is literally nothing else, in which case the penalty is
          // finite and something still lands. The test is the lane's own
          // definition widened by the kit's radius, so the quarry is not merely
          // out of the strip, it is clear of it.
          const lx = cx - tile.x, lz = cz - tile.z;
          const inLane = lz < 0.80 + FOOT.clayWorks
            && Math.abs(lx) < 2.25 + FOOT.clayWorks;
          const score = Math.min(slack, 1.20) + (inLane ? -2.20 : 0)
            + Math.sin(a) * 0.30 + (ring === 0.50 ? 0.25 : 0);
          if (!best || score > best.score) best = { score, a, cx, cz };
        }
      }
      let pitDisc = null;
      if (best) {
        pitDisc = { x: best.cx, z: best.cz, r: FOOT.clayWorks };
        placer.blocked.push(pitDisc);
        drop('clayWorks', best.cx, best.cz, rng, { ry: Math.PI / 2 - best.a });
      }

      // ONE SMALL SHOVEL, LEFT STUCK IN THE GROUND BESIDE THE QUARRY.
      //
      //   "Also remove the small rocks from the brick hexes, instead have a
      //    small shovel."
      //
      // Everything the stones used to be — a count, a floor under that count,
      // two relaxed passes to hold the floor, a per-hex size that shrank with
      // the crowding — is deleted. One prop needs none of it. What it needs is
      // the three things the quarry and the mine portal each needed, so this is
      // written the same way they are:
      //
      //   IT IS SCORED, NOT SAMPLED. A rejection sampler is allowed to come back
      //   with nothing, and the whole history of this hex is landmarks that came
      //   back with nothing on the 5-pip hills — the ones the player spends the
      //   most time on. Every bearing on two rings is scored and the best one
      //   wins, so a shovel lands on every hill on every board, by construction.
      //
      //   IT IS MEASURED FROM THE QUARRY, NOT FROM THE HEX. "As if left stuck in
      //   the ground beside the quarry" is a relationship between two objects,
      //   not a position on a tile, so the rings are radii about the PIT: 2.10
      //   is a fifth of a unit outside the quarry's own 1.55 disc plus the
      //   shovel's 0.45, which puts the blade about half a unit clear of the
      //   spoil bank — near enough to read as one scene, far enough that the
      //   two silhouettes do not merge. 2.45 is the fallback when the near ring
      //   is all brick. The quarry's own disc is skipped when the clearance is
      //   scored, because being close to it is the POINT here; every other disc
      //   on the hex still counts in full.
      //
      //   IT LEANS TOWARD THE CAMERA SIDE OF THE PIT. `sin(a)` biases the
      //   bearing to +Z, where `PLAY_YAW` in systems/camera.js puts the camera,
      //   so the quarry's spoil bank is never standing between the lens and the
      //   tool. The token lane is scored as disqualifying-unless-there-is-
      //   nothing-else for the same reason it is for the quarry: it is the
      //   roomiest ground on the hex and the one place a small prop cannot be
      //   looked at.
      //
      // hexFrac is checked as a hard skip rather than as a penalty. A shovel
      // 2.45 units out from a quarry that is itself at 0.50 can reach the ramp
      // into the tan border strip, and a tool half-sunk in the hex rim is the
      // defect the quarry itself was moved inboard to fix. 0.70 plus this kit's
      // 0.05 of hexFrac footprint is 0.75, clear of the 0.81 where the roads
      // start. Bearings pointing back toward the middle of the hex always pass,
      // so the skip can never empty the candidate list.
      if (pitDisc) {
        let tool = null;
        for (const ring of [2.10, 2.45]) {
          for (let i = 0; i < 48; i++) {
            const a = i * (Math.PI * 2 / 48);
            const sx = pitDisc.x + Math.cos(a) * ring;
            const sz = pitDisc.z + Math.sin(a) * ring;
            if (hexFrac(sx - tile.x, sz - tile.z) > 0.70) continue;
            let slack = Infinity;
            for (const b of placer.blocked) {
              if (b === pitDisc) continue;
              const d = Math.hypot(b.x - sx, b.z - sz) - (b.r + FOOT.shovel);
              if (d < slack) slack = d;
            }
            const lx = sx - tile.x, lz = sz - tile.z;
            const inLane = lz < 0.80 + FOOT.shovel
              && Math.abs(lx) < 2.25 + FOOT.shovel;
            const score = Math.min(slack, 0.90) + (inLane ? -2.20 : 0)
              + Math.sin(a) * 0.45 + (ring === 2.10 ? 0.30 : 0);
            if (!tool || score > tool.score) tool = { score, sx, sz };
          }
        }
        if (tool) {
          placer.blocked.push({ x: tool.sx, z: tool.sz, r: FOOT.shovel });
          // THE YAW IS CHOSEN FOR LEGIBILITY, NOT FOR VARIETY, and it is the
          // same argument the mine portal makes two hundred lines above — with
          // one term the portal did not need.
          //
          // The kit leans along its own local X and its blade is a flat plate
          // whose face is the local X-Y plane, so the yaw decides two things at
          // once: how much of the cant the camera sees, and how much light the
          // blade catches. `PLAY_YAW` in systems/camera.js is 0 and the camera
          // always sits on +Z, so a yaw near 0 shows the full lean and the full
          // plate — and that was the first version of this line, and it
          // photographed at luma 21-28 on a hillside of 62.
          //
          // The reason is the one `clayWorks` learned the hard way: "a
          // horizontal normal on the arc turned away from the key light catches
          // nothing at all". The blade's face normal IS horizontal — a Y
          // rotation cannot tip it — so all it has is its dot with the sun, and
          // `SUN_DIR` in world/sky.js is (-0.577, 0.707, 0.408). A blade facing
          // straight down +Z gets 0.408 of that at best and 0.19 once the small
          // skew is in; turned to (-0.577, 0, 0.816) it gets 0.67, which is
          // three and a half times the direct light for a plate that still
          // presents 0.82 of its area to the lens. So the blade is aimed BETWEEN
          // the camera and the sun, which is the only place a vertical plate can
          // be both seen and lit.
          //
          // -0.62 radians is that bearing. The mirrored variant is PI minus it:
          // the blade is a box, so the far face reads identically and the lean
          // flips to the other side, which is what keeps three hills on one
          // board from being three copies of the same photograph.
          const yaw = (tile.id % 2) ? -0.62 : Math.PI - 0.62;
          const ss = STYLE.shovel.s;
          const s = ss[0] + rng() * (ss[1] - ss[0]);
          // `sy` is pinned to `s` — see STYLE.shovel. A tool is a rigid object;
          // the free vertical jitter every other kit gets would bend the cant.
          drop('shovel', tool.sx, tool.sz, rng, { ry: yaw, s, sy: s });
        }
      }

      // THE STONES USED TO STAND HERE, AND THEY DO NOT ANY MORE.
      //
      //   "Also remove the small rocks from the brick hexes."
      //
      // What was deleted was a scored ring at hexFrac 0.62 with two relaxed
      // passes behind it, a floor of two, and a per-hex size that shrank with
      // the crowding so a 5-pip hill got smaller stones rather than fewer of
      // them. All of that machinery existed to make "a few simple stones"
      // actually be a few, and it worked; it is gone because the hex is not
      // supposed to have stones on it any longer, not because it failed. The
      // hills recipe above is now grass and nothing else, and everything with a
      // silhouette on this hex — the quarry and the shovel — is placed by the
      // two scorers above.
      //
      // `boulder` and `STYLE.boulder` survive because the desert and the
      // shoreline collar still use them. Nothing here is orphaned.
    }

    // biggest silhouettes claim their ground first, undergrowth fills the gaps
    const order = ['spire', 'clayWorks', 'boulder', 'broadleaf', 'deadwood',
      'conifer', 'coniferShort', 'timber', 'hay', 'crate', 'fence',
      'undergrowth', 'rockSmall', 'wheat', 'flower', 'grass'];
    for (const kit of order) {
      const n = recipe[kit];
      if (!n) continue;
      // Ground cover switches the corner discs off entirely; anything with a
      // silhouette keeps them. See `GROUND_COVER` at the top of this file.
      const g = GROUND_COVER.has(kit) ? 0 : undefined;
      for (const p of placer.take(n, FOOT[kit], PROP_MAX_FRAC, undefined, false, g)) {
        drop(kit, p.x, p.z, rng);
      }
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

    /* Build-time census of the dressing: kit -> how many pieces actually landed.
     * Worth publishing because the recipe is a REQUEST, not a result. `take()`
     * is a rejection sampler and the pasture's fence arc can decline every
     * bearing it tries, so "the recipe asks for three fences" and "three fences
     * are standing" are different claims — and the first version of the
     * three-fence paddock quietly placed nought of them, because the clearance
     * disc it was testing against was wider than any gap in a twenty-eight
     * sheep flock. A capture rig can read this and say so. */
    kitCounts: (() => {
      const c = {};
      for (const kit in bucket) c[kit] = bucket[kit].length;
      return c;
    })(),

    /* The same census cut per hex, which is the cut that actually answers the
     * question the reports ask. "Ten fences across four pastures" is a fine
     * number that can still mean one pasture with four panels round it and one
     * with none, and a pasture with none is a pasture that stopped being a
     * paddock. tileId -> { kit: count }; hexes with no dressing are absent. */
    tileCounts: (() => {
      const c = {};
      for (const kit in bucket) {
        for (const o of bucket[kit]) {
          if (o.tile < 0) continue;              // the shoreline collar
          (c[o.tile] || (c[o.tile] = {}))[kit] = ((c[o.tile] || {})[kit] || 0) + 1;
        }
      }
      return c;
    })(),

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
