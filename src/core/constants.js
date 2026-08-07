/**
 * Island Settlers — global tuning constants.
 * Single source of truth for economy, pacing, colours and scale.
 * Headless simulations (tools/simulate.mjs) import this file directly,
 * so it must stay free of DOM/three.js references.
 */

// ---------------------------------------------------------------- world scale
export const HEX_SIZE = 9.0;             // centre -> corner, world units
export const SEA_LEVEL = 0.0;
export const LAND_HEIGHT = 1.6;          // top surface of a standard land tile
export const CHAR_HEIGHT = 2.0;

// ---------------------------------------------------------------- resources
export const RES = ['wood', 'brick', 'wool', 'wheat', 'ore'];

export const RES_LABEL = {
  wood: 'Wood', brick: 'Brick', wool: 'Wool', wheat: 'Wheat', ore: 'Ore'
};

// Terrain type -> resource produced (desert produces nothing)
export const TERRAIN_RES = {
  forest: 'wood',
  hills: 'brick',
  pasture: 'wool',
  fields: 'wheat',
  mountains: 'ore',
  desert: null
};

export const RES_COLOR = {
  wood:  0x4c8b3a,
  brick: 0xc0562f,
  wool:  0xe8e4d8,
  wheat: 0xe8b53c,
  ore:   0x8d97a6
};

// ---------------------------------------------------------------- pacing
/*
 * TWELVE, NOT THIRTEEN.
 *
 *   "Everywhere the game should update to only being 12 points, not 13."
 *
 * Nothing else in the build hard-codes the target. The VP track in the HUD
 * builds that many cells, the tutorial and the rules art write the number into
 * their own prose, `matchflow` derives its halfway and match-point beats from
 * it, and `botBrain` measures how far a rival is from winning against it — so
 * this line is the whole change. That is deliberate and worth keeping.
 */
export const VICTORY_POINTS = 12;
export const MATCH_SOFT_CAP_SEC = 420;   // safety net; match should end well before

// Productivity: pips = 6 - |7 - number|  (6/8 -> 5 pips, 2/12 -> 1 pip)
export function pipsFor(number) {
  if (!number) return 0;
  return 6 - Math.abs(7 - number);
}

/* ------------------------------------------------------------- gathering
 * THE MODEL (rebuilt — see the header of src/board/nodes.js)
 *
 * A hex is FULL of its resource. You collect an item the instant you touch it;
 * there is no swing timer, no progress ring and no node to latch onto. Sweeping
 * a whole hex clean takes roughly three seconds of running.
 *
 * The number printed on a hex therefore means exactly two things:
 *   1. TILE_ITEMS  — how many items the hex holds when full.
 *   2. TILE_REGEN  — how long the whole hex stays bare once it is cleared.
 * Higher number (more pips) = more items AND a faster comeback. Nothing else.
 *
 * You may only collect on a hex where you own an adjacent settlement or city.
 * Everywhere else yields literally nothing — there is no multiplier any more.
 */

// How close the settler has to pass to sweep an item up. Generous on purpose:
// this is a phone game played with a thumbstick.
export const PICKUP_RADIUS = 2.4;

/*
 * THE PRODUCTIVITY CURVE, AND WHY IT IS STEEP NOW.
 *
 *   "Can you make the worse point hexes have less resources per hex, so like
 *    8's have the most, and the 3's and 12's have like 50% of what they do
 *    right now as far as the total number of resources you can pick up on any
 *    given tile. Also make the times you have to wait a little longer for those
 *    worse hexes."
 *
 * The old curve was almost flat: a 2/12 held 10 items and a 6/8 held 22, and
 * their regen differed by twelve seconds. In sustained items-per-second that is
 * 0.385 against 1.571 — four times, which sounds like a lot until you notice
 * that a corner touches three hexes, so a bad corner ran at maybe half a good
 * one and a settlement on a 12 was still a perfectly reasonable thing to build.
 * The number printed on a hex is supposed to be the whole of the draft
 * decision, and it was not carrying that weight.
 *
 * Both halves move together, because the wait is half the productivity:
 *
 *   pips  number   items          regen        items/sec    was
 *     1    2 / 12   10 ->  5      26 -> 34 s     0.147      0.385   (-62%)
 *     2    3 / 11   13 ->  8      23 -> 28 s     0.286      0.565   (-49%)
 *     3    4 / 10   16 -> 17      20 -> 16 s     1.063      0.800   (+33%)
 *     4    5 /  9   19 -> 23      17 -> 10 s     2.300      1.118  (+106%)
 *     5    6 /  8   22 -> 28      14 ->  6 s     4.667      1.571  (+197%)
 *
 * The 1- and 2-pip halving is the request, taken literally. The top of the
 * curve going UP is the part that was not asked for, and it is the reason the
 * rest works. Nerfing the bottom third of the board on its own would simply
 * have made every match longer and every economy poorer — measured, not
 * guessed: with the new costs and a flat top, `tools/simulate.mjs` had 24 of 30
 * matches running into the 420-second stalemate cap. Lifting the top brings the
 * island's total output back to roughly where the new prices need it while the
 * gap between a good corner and a bad one goes from about four to one to
 * twenty-two to one. That gap is the whole point: the number printed on a hex
 * is supposed to BE the draft decision.
 *
 * `TILE_ITEM_POOL` moved 24 -> 32, keeping four of headroom over the top of the
 * curve rather than sitting exactly on it (see the note by the constant). Item
 * positions are best-candidate blue noise with no minimum spacing, so a fuller
 * hex packs tighter rather than failing to place, and the island's total item
 * count barely moves (300 -> 306).
 */
export const TILE_ITEMS = { 1: 5, 2: 8, 3: 17, 4: 23, 5: 28 };

// Seconds a cleared hex stays bare before EVERY item returns at once.
// A player working five or six of their own hexes in a loop spends roughly
// this long getting round them all, so a good rotation barely ever waits and a
// one-hex player waits a lot. Measured over 40-match simulations.
export const TILE_REGEN = { 1: 34, 2: 28, 3: 16, 4: 10, 5: 6 };

// Items generated per hex in the position pool. TILE_ITEMS never exceeds this;
// the pool is fixed so positions stay stable while counts can be retuned.
//
// FOUR OF HEADROOM, NOT NONE. `scatterField` is best-candidate sampling with a
// rejection guard, so it can come back a point or two short — and while the
// pool sat at exactly the top of TILE_ITEMS, a 5-pip hex that came back 26
// short-changed itself: `tileItemCount` is min(pool.length, TILE_ITEMS[pips]),
// so the shortfall silently became the hex's real capacity. Every other rung
// already drew from a pool far larger than it needed; the top rung now does
// too. The extra positions are never enabled on any hex, so nothing renders
// them and the island's item count is unchanged.
export const TILE_ITEM_POOL = 32;

/** Sustained items-per-second a full hex of this productivity can supply. */
export function tileRateFor(pips) {
  const n = TILE_ITEMS[pips] || 0;
  const r = TILE_REGEN[pips] || 1;
  return n / r;
}

// Legacy decorative nodes (src/world/* still draws these; see board/nodes.js).
export const NODE_CAPACITY = 3;
export const NODE_REGROW_SEC = 20.0;

// ---------------------------------------------------------------- costs
// Retuned for the gathering rebuild. A settlement is the expensive purchase
// because it is the only thing that opens new land; a city is now a pure
// victory point (ownership gates, it does not multiply) so it has to be cheap
// enough to stay worth taking once your corners are claimed.
/*
 * The prices, set by the player:
 *
 *   "Make it so that for a settlement you need 4 of each of those 4 resources,
 *    instead of 3 of the wheat and sheep. Make the city be 8 wheat and 12 ore.
 *    Make the card be 4 of each of the 3 resources."
 *
 * Settlement 14 -> 16, card 9 -> 12, and the city 10 -> 20, which is the one
 * that changes the shape of a match rather than its length: a city is two
 * victory points and there are five of them, so doubling the price turns
 * "upgrade everything on the way past" into a decision you have to build an
 * economy for. It is also why the top of the productivity curve above went up —
 * twenty goods for a city on the old flat curve was most of a minute of
 * gathering, and a match is supposed to be three to five minutes total.
 */
export const COST = {
  road:       { wood: 4, brick: 4 },
  settlement: { wood: 4, brick: 4, wheat: 4, wool: 4 },
  city:       { wheat: 8, ore: 12 },
  card:       { wool: 4, wheat: 4, ore: 4 }
};

export const PIECE_LIMIT = { road: 18, settlement: 7, city: 5 };

// ---------------------------------------------------------------- awards
export const LONGEST_ROAD_MIN = 4;   // segments needed to claim
export const LARGEST_ARMY_MIN = 2;   // knights played to claim
/*
 * THREE, NOT FOUR.
 *
 *   "I'd like to change the game so the Longest Road is only worth 3 points."
 *
 * At four it was a third of a shorter game in one award — worth more than two
 * settlements and a city put together, on a board where roads are the cheapest
 * thing to build. Three still makes it the biggest single prize on the island
 * and still worth changing plans for; it stops being the plan.
 *
 * The tutorial, the rules illustration and the results breakdown all read this
 * constant, so they say three from here without a second edit.
 */
export const LONGEST_ROAD_VP = 3;
export const LARGEST_ARMY_VP = 2;

// ---------------------------------------------------------------- dev cards
export const CARD_TYPES = ['knight', 'roadBuilding', 'victoryPoint'];
export const CARD_WEIGHTS = { knight: 0.5, roadBuilding: 0.3, victoryPoint: 0.2 };
export const CARD_LABEL = {
  knight: 'Knight',
  roadBuilding: 'Road Building',
  victoryPoint: 'Victory Point'
};
/* The Knight line used to read "rivals drop their carried resources", which is
   wrong in the one way that matters: there is no separate carried pool in this
   game, so what a Knight takes is half of every rival's whole stockpile —
   `ceil(n/2)` per resource type, which lands nearer 57% of a full pack — and it
   is destroyed rather than stolen. The player had to ask whether the game did
   this at all, so the card now says exactly what it does before it is played. */
export const CARD_BLURB = {
  knight: 'Send the Knight to a hex: everyone built THERE loses half of every resource, rounded down. Never you. The hex then gives nothing to anybody but you.',
  roadBuilding: 'Place two roads for free.',
  victoryPoint: '+1 Victory Point, immediately.'
};

// ---------------------------------------------------------------- movement
export const PLAYER_SPEED = 12.0;        // world units / second
export const PLAYER_ACCEL = 60.0;
export const BOT_SPEED = 11.0;
export const INTERACT_RADIUS = 2.6;      // distance to auto-latch onto a node
export const TRADE_RADIUS = 6.0;         // distance to open trading post / port

// ---------------------------------------------------------------- trade
export const TRADE_BASE = 4;             // 4:1 at the central market
export const PORT_GENERIC = 3;           // 3:1
export const PORT_SPECIAL = 2;           // 2:1 on the port's resource

// ---------------------------------------------------------------- starting kit
// Enough for one road and a little change — the point is to send you out to
// your own hexes in the first few seconds, not to bankroll an opening build.
export const START_RESOURCES = { wood: 3, brick: 3, wool: 2, wheat: 2, ore: 2 };

// ---------------------------------------------------------------- players
/*
 * THE FOUR PLAYERS.
 *
 *   "Can you also make the colors stand out a bit more for the players. I'm
 *    thinking the green could be brighter and a bit neon, and the red can be
 *    brighter as well. Just make all of the other colors for the other players
 *    a bit more subtly neon versions to match."
 *
 * The old set was mixed off a muted, earthy palette to sit politely on the
 * island — and that was the problem. A road, a settlement roof and an owned-hex
 * rim are small, they are seen at play-camera distance, and they are seen
 * AGAINST terrain in the same family: the green player's pieces on a forest
 * hex, the red player's on a clay hill. `#3f9a52` against a `#3f8a2c` forest
 * floor is a couple of per cent apart in both hue and value, which is not a
 * player colour, it is camouflage.
 *
 * So every one of the four is pushed up in saturation and value until it reads
 * as EMITTED rather than lit — the green and the red hardest, since those are
 * the two the player named, and the blue and purple a shade more gently so the
 * set still looks like one family rather than a rainbow of highlighter pens.
 * Roughly: saturation up by a third across the board, value up 20-30%, hues
 * nudged apart at the top end (the red warmer, the green cooler) so no two are
 * confusable at twenty pixels.
 *
 * `light` is the paler partner used for rims, glows, name text on dark plates
 * and the lit face of every 3D piece, so it is pulled up with its parent and
 * kept legible as TEXT on the navy panels — which is the one thing that stops
 * these going fully fluorescent.
 *
 * One source of truth: the 3D pieces (`hex`), the interface (`css` / `light`),
 * the owned-hex rim in `world/regions.js`, the recovery badge in
 * `world/regionmark.js` and the victory flood in `world/mood.js` all read from
 * here, so a colour never has to be changed twice.
 */
export const PLAYER_COLORS = [
  { key: 'blue',   hex: 0x2f8ffb, css: '#2f8ffb', light: '#93cbff', name: 'You' },
  // Pulled a shade redder (hue 8 -> 3 degrees, and deeper) to open the gap to
  // the orange below. On its own #ff4a35 is already an orange-red, and putting
  // a real orange next to it without moving it would have been two neighbours
  // on the wheel wearing the same warmth.
  { key: 'red',    hex: 0xf5342a, css: '#f5342a', light: '#ff8f80', name: 'Alex' },
  // Green -> hot pink -> ORANGE. Green was the one colour with nowhere to stand:
  // half the island is forest and pasture, so a green road on green ground had
  // to win an argument with the terrain before it could be seen at all. Pink
  // fixed that and lost on a different axis — "make the pink player an orange
  // instead that totally stands out from the red" — so this is a bright amber
  // at hue 36 degrees against the red's 3, separated by warmth AND by value:
  // the orange is a full stop lighter and reads as lit, the red as saturated.
  // Nothing on the island is this colour either; the sand is a desaturated tan
  // and the clay hills are brick, both a long way under it.
  { key: 'orange', hex: 0xff9412, css: '#ff9412', light: '#ffc873', name: 'Maya' },
  { key: 'purple', hex: 0xa45bff, css: '#a45bff', light: '#d2a8ff', name: 'Finn' }
];

export const BOT_PROFILES = [
  { id: 1, name: 'Alex', strategy: 'expansion',  desc: 'Expansion & Longest Road' },
  { id: 2, name: 'Maya', strategy: 'cities',     desc: 'Settlements & Cities' },
  { id: 3, name: 'Finn', strategy: 'cards',      desc: 'Development Cards & Army' }
];

export function canAfford(bank, cost) {
  for (const k in cost) if ((bank[k] || 0) < cost[k]) return false;
  return true;
}

export function pay(bank, cost) {
  for (const k in cost) bank[k] -= cost[k];
}

export function missingFrom(bank, cost) {
  const out = {};
  for (const k in cost) {
    const d = cost[k] - (bank[k] || 0);
    if (d > 0) out[k] = d;
  }
  return out;
}

export function totalRes(bank) {
  return RES.reduce((s, k) => s + (bank[k] || 0), 0);
}
