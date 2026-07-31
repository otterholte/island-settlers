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
export const VICTORY_POINTS = 12;
export const MATCH_SOFT_CAP_SEC = 420;   // safety net; match should end well before

// Productivity: pips = 6 - |7 - number|  (6/8 -> 5 pips, 2/12 -> 1 pip)
export function pipsFor(number) {
  if (!number) return 0;
  return 6 - Math.abs(7 - number);
}

// Seconds for one gather cycle, indexed by pips (1..5)
export const GATHER_TIME = { 1: 1.84, 2: 1.57, 3: 1.34, 4: 1.15, 5: 0.96 };
// Resources granted per completed cycle, indexed by pips.
// Flat by design: GATHER_TIME carries the productivity difference, which keeps
// the numbers on the tokens meaningful without making 6/8 tiles run away with
// the match. Measured over 100 simulated matches.
export const GATHER_YIELD = { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1 };

// Owning a building on a corner of the tile multiplies your yield there.
// This is what makes placement matter in a real-time game.
export const OWNERSHIP_MULT = { none: 1, settlement: 2, city: 3 };

// A node (tree / rock / sheep ...) depletes after this many cycles, then regrows.
export const NODE_CAPACITY = 3;
export const NODE_REGROW_SEC = 20.0;   // legacy per-node value; recovery is now tile-scoped (see board/nodes.js)

// ---------------------------------------------------------------- costs
export const COST = {
  road:       { wood: 2, brick: 2 },
  settlement: { wood: 2, brick: 2, wheat: 2, wool: 2 },
  city:       { wheat: 4, ore: 6 },
  card:       { wool: 2, wheat: 2, ore: 2 }
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
export const CARD_BLURB = {
  knight: 'Rivals drop their carried resources. Move the Raider to block a region.',
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
export const START_RESOURCES = { wood: 4, brick: 4, wool: 2, wheat: 2, ore: 2 };

// ---------------------------------------------------------------- players
export const PLAYER_COLORS = [
  { key: 'blue',   hex: 0x3b7fd4, css: '#3b7fd4', light: '#7fb2f0', name: 'You' },
  { key: 'red',    hex: 0xd0472f, css: '#d0472f', light: '#f08a75', name: 'Alex' },
  { key: 'green',  hex: 0x3f9a52, css: '#3f9a52', light: '#84d193', name: 'Maya' },
  { key: 'purple', hex: 0x8552c4, css: '#8552c4', light: '#bb96ea', name: 'Finn' }
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
