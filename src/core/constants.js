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
export const VICTORY_POINTS = 13;
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

// Items on a full hex, indexed by pips (1..5). ~16 on an average hex, which a
// settler sweeps clean in about three and a half seconds.
export const TILE_ITEMS = { 1: 10, 2: 13, 3: 16, 4: 19, 5: 22 };

// Seconds a cleared hex stays bare before EVERY item returns at once.
// A player working five or six of their own hexes in a loop spends roughly
// this long getting round them all, so a good rotation barely ever waits and a
// one-hex player waits a lot. Measured over 40-match simulations.
export const TILE_REGEN = { 1: 26, 2: 23, 3: 20, 4: 17, 5: 14 };

// Items generated per hex in the position pool. TILE_ITEMS never exceeds this;
// the pool is fixed so positions stay stable while counts can be retuned.
export const TILE_ITEM_POOL = 24;

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
export const COST = {
  road:       { wood: 4, brick: 4 },
  settlement: { wood: 4, brick: 4, wheat: 3, wool: 3 },
  city:       { wheat: 4, ore: 6 },
  card:       { wool: 3, wheat: 3, ore: 3 }
};

export const PIECE_LIMIT = { road: 18, settlement: 7, city: 5 };

// ---------------------------------------------------------------- awards
export const LONGEST_ROAD_MIN = 4;   // segments needed to claim
export const LARGEST_ARMY_MIN = 2;   // knights played to claim
export const LONGEST_ROAD_VP = 4;
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
  knight: 'Takes HALF of every resource from every rival. Then move the Raider to shut down a region.',
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
  { key: 'red',    hex: 0xff4a35, css: '#ff4a35', light: '#ff9c88', name: 'Alex' },
  { key: 'green',  hex: 0x2fd45f, css: '#2fd45f', light: '#8bf5a8', name: 'Maya' },
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
