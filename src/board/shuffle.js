/**
 * Island Settlers — per-match board shuffle.
 *
 * Pure data / pure math. No three.js, no DOM, no imports from the world layer,
 * so `tools/simulate.mjs` and `tools/verify.mjs` can drive it headlessly.
 *
 * =============================================================================
 * WHAT THIS DOES
 * =============================================================================
 * `board/layout.js` owns the *geometry* of the island — nineteen pointy-top
 * hexes at fixed axial coordinates, and the intersection/edge graph that falls
 * out of them. None of that ever changes: the coastline, the ports' berths, the
 * Great Market in the middle and the four spawn points are the same island
 * every match.
 *
 * What changes is the *dressing*: which terrain sits on each of those nineteen
 * positions, which number token it carries, and which dock trades which
 * resource. This module generates that assignment from a seed and rejects the
 * ones that would make a bad match.
 *
 * =============================================================================
 * THE FAIRNESS TEST  (stated in full — see `boardViolations`)
 * =============================================================================
 * A candidate board is accepted only if ALL of these hold.
 *
 *  1. COMPOSITION — exactly 4 forest, 4 fields, 4 pasture, 3 hills,
 *     3 mountains, 1 desert.
 *
 *  2. TOKENS — exactly the classic eighteen: one 2, one 12, and two each of
 *     3,4,5,6,8,9,10,11. There is no 7. The desert carries no token.
 *
 *  3. DESERT IN THE CENTRE — the desert is always the (0,0) hex. The Great
 *     Market is built on it and `MARKET` is derived from its position, so it
 *     may never move.
 *
 *  4. NO TOUCHING REDS — no two 5-pip tiles (a 6 or an 8) share a corner. This
 *     is the classic "no adjacent red numbers" rule. Because every trio of
 *     hexes that meets at a corner is mutually adjacent, testing corners tests
 *     adjacency exactly.
 *
 *  5. CORNER CEILING — no intersection's adjacent tiles may total more than
 *     `maxCornerPips` (13) pips. With rule 4 in force a three-tile corner can
 *     hold at most one 5-pip tile, so 5+4+4 = 13 is the strongest corner the
 *     rules can produce; anything above it means the generator is broken.
 *
 *  6. OPENING-SEAT BALANCE — the real dominance test. We replay the first
 *     round of the snake draft greedily: take the highest pip-sum corner, black
 *     out its three neighbours under the distance rule, repeat four times. That
 *     approximates the four corners the four seats will actually open on. The
 *     board is rejected if the best of those four beats the worst by more than
 *     `maxOpeningSpread` (4) pips — i.e. if one opening seat is meaningfully
 *     richer than the last one on the board. (The hand-authored board this
 *     replaces scores 13/11/10/10, a spread of 3.)
 *
 *  7. RESOURCE BALANCE — for each of the five resources, the total pips across
 *     its tiles must land inside [0.75, 1.35] x its fair share, where a fair
 *     share is `58 * tilesOfThatResource / 18` (58 is the total pip count of
 *     the eighteen tokens). This kills the boards where, say, all three
 *     mountains draw 2/3/12 and nobody can ever afford a city, or where all
 *     four reds land on forest and wood floods the island. It is the rule that
 *     matters most to pacing: loosening it to [0.60, 1.50] measurably fattened
 *     the tail of the match-length distribution in tools/simulate.mjs.
 *     (For reference the hand-authored board this replaces scored 0.85–1.24.)
 *
 * Generation is rejection sampling: shuffle, test, reshuffle. About 6% of raw
 * shuffles pass, so a board is found in ~16 tries; the `maxAttempts` cap of
 * 3000 exists only so a future rule change can never hang the boot. If the
 * sampler somehow cannot find a clean board inside it, the least bad candidate
 * is returned with `fair: false` set, so the game still starts.
 */

/* ------------------------------------------------------------------- rng */

/** Same generator as board/nodes.js — duplicated here to keep this module
 *  dependency-free and free of an import cycle. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(list, rng) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1)) % (i + 1);
    const t = out[i]; out[i] = out[j]; out[j] = t;
  }
  return out;
}

/* ----------------------------------------------------------------- bags */

/** The nineteen axial positions, in the order `layout.js` builds `tiles`.
 *  Row by row from the far side to the near side. Index 9 is the centre. */
export const TILE_POSITIONS = Object.freeze([
  { q: 0, r: -2 }, { q: 1, r: -2 }, { q: 2, r: -2 },
  { q: -1, r: -1 }, { q: 0, r: -1 }, { q: 1, r: -1 }, { q: 2, r: -1 },
  { q: -2, r: 0 }, { q: -1, r: 0 }, { q: 0, r: 0 }, { q: 1, r: 0 }, { q: 2, r: 0 },
  { q: -2, r: 1 }, { q: -1, r: 1 }, { q: 0, r: 1 }, { q: 1, r: 1 },
  { q: -2, r: 2 }, { q: -1, r: 2 }, { q: 0, r: 2 }
].map(Object.freeze));

/** Index of the centre hex — the desert, and therefore the Great Market. */
export const DESERT_INDEX =
  TILE_POSITIONS.findIndex(p => p.q === 0 && p.r === 0);

/** Terrain composition of the eighteen productive hexes. */
export const TERRAIN_BAG = Object.freeze([
  'forest', 'forest', 'forest', 'forest',
  'fields', 'fields', 'fields', 'fields',
  'pasture', 'pasture', 'pasture', 'pasture',
  'hills', 'hills', 'hills',
  'mountains', 'mountains', 'mountains'
]);

/** The classic eighteen number tokens. No 7; the desert takes none. */
export const TOKEN_BAG = Object.freeze([
  2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12
]);

/** Nine docks: four generic 3:1 and one 2:1 for each resource. The berths are
 *  geographic and never move — this bag decides which berth trades what. */
export const PORT_BAG = Object.freeze([
  { kind: 'generic', resource: null, ratio: 3 },
  { kind: 'generic', resource: null, ratio: 3 },
  { kind: 'generic', resource: null, ratio: 3 },
  { kind: 'generic', resource: null, ratio: 3 },
  { kind: 'special', resource: 'wood', ratio: 2 },
  { kind: 'special', resource: 'brick', ratio: 2 },
  { kind: 'special', resource: 'wool', ratio: 2 },
  { kind: 'special', resource: 'wheat', ratio: 2 },
  { kind: 'special', resource: 'ore', ratio: 2 }
].map(Object.freeze));

/** Terrain -> resource. Mirrors core/constants.js TERRAIN_RES; kept local so
 *  this module stays importable on its own. */
const RESOURCE_OF = Object.freeze({
  forest: 'wood', hills: 'brick', pasture: 'wool',
  fields: 'wheat', mountains: 'ore', desert: null
});

/** pips = 6 - |7 - number|, so 6/8 are worth 5 and 2/12 are worth 1. */
export function pipsOf(number) {
  if (!number) return 0;
  return 6 - Math.abs(7 - number);
}

/** Total pips on the board — 58, and the denominator of the balance test. */
export const TOTAL_PIPS = TOKEN_BAG.reduce((s, n) => s + pipsOf(n), 0);

/** Thresholds. Exported so verify.mjs asserts against the same numbers. */
export const FAIRNESS = {
  maxCornerPips: 13,       // rule 5 — implied ceiling once reds cannot touch
  maxOpeningSpread: 4,     // rule 6 — pips between the best and 4th-best opener
  minResourceShare: 0.75,  // rule 7
  maxResourceShare: 1.35,  // rule 7
  maxAttempts: 3000
};

/* ------------------------------------------------------------- topology */

/**
 * `layout.js` hands us the corner graph it built from the fixed positions:
 *
 *   { desertIndex, corners: [{ tiles: [tileId...], neighbors: [cornerId...] }] }
 *
 * Nothing in here needs world coordinates.
 */

/** Pip total of every tile touching a corner. */
function cornerPips(corner, pips) {
  let s = 0;
  for (let i = 0; i < corner.tiles.length; i++) s += pips[corner.tiles[i]];
  return s;
}

/**
 * Greedy replay of the first draft round: four seats each take the richest
 * corner still legal under the distance rule. Returns the four pip totals,
 * best first.
 */
export function openingPicks(topo, pips, seats = 4) {
  const order = topo.corners
    .map((c, id) => ({ id, sum: cornerPips(c, pips) }))
    .sort((a, b) => b.sum - a.sum || a.id - b.id);
  const taken = new Set();
  const out = [];
  for (const cand of order) {
    if (out.length >= seats) break;
    if (taken.has(cand.id)) continue;
    out.push(cand.sum);
    taken.add(cand.id);
    for (const nb of topo.corners[cand.id].neighbors) taken.add(nb);
  }
  return out;
}

/* ------------------------------------------------------- fairness test */

function tally(list) {
  const m = new Map();
  for (const v of list) m.set(v, (m.get(v) || 0) + 1);
  return m;
}

function sameTally(got, want) {
  if (got.size !== want.size) return false;
  for (const [k, v] of want) if (got.get(k) !== v) return false;
  return true;
}

const TERRAIN_WANT = tally(TERRAIN_BAG).set('desert', 1);
const TOKEN_WANT = tally(TOKEN_BAG);

/**
 * Every way this candidate board is unfair or malformed, as a list of
 * `{ rule, detail }`. An empty list means the board ships.
 *
 * @param {string[]} terrain  terrain per tile index
 * @param {number[]} numbers  token per tile index (0 on the desert)
 * @param {object}   topo     { desertIndex, corners }
 */
export function boardViolations(terrain, numbers, topo, cfg = FAIRNESS) {
  const bad = [];
  const add = (rule, detail) => bad.push({ rule, detail });
  const n = TILE_POSITIONS.length;

  if (terrain.length !== n || numbers.length !== n) {
    add('composition', `expected ${n} tiles, got ${terrain.length}/${numbers.length}`);
    return bad;
  }

  // 1. terrain composition
  if (!sameTally(tally(terrain), TERRAIN_WANT)) {
    add('composition', JSON.stringify(Object.fromEntries(tally(terrain))));
  }

  // 2. token distribution
  const tokens = numbers.filter((v, i) => i !== topo.desertIndex);
  if (tokens.length !== 18 || !sameTally(tally(tokens), TOKEN_WANT)) {
    add('tokens', JSON.stringify(Object.fromEntries(tally(tokens))));
  }

  // 3. desert dead centre, and carrying nothing
  if (terrain[topo.desertIndex] !== 'desert') {
    add('desert-centre', `centre is ${terrain[topo.desertIndex]}`);
  }
  if (numbers[topo.desertIndex] !== 0) {
    add('desert-centre', `desert carries ${numbers[topo.desertIndex]}`);
  }
  for (let i = 0; i < n; i++) {
    if (i !== topo.desertIndex && terrain[i] === 'desert') {
      add('desert-centre', `second desert at tile ${i}`);
    }
  }

  const pips = numbers.map(pipsOf);

  // 4. no two 5-pip tiles share a corner
  for (const c of topo.corners) {
    let reds = 0;
    for (const t of c.tiles) if (pips[t] === 5) reds++;
    if (reds > 1) { add('red-adjacency', `${reds} reds on one corner`); break; }
  }

  // 5. corner ceiling
  let worst = 0;
  for (const c of topo.corners) worst = Math.max(worst, cornerPips(c, pips));
  if (worst > cfg.maxCornerPips) {
    add('corner-cap', `${worst} pips > ${cfg.maxCornerPips}`);
  }

  // 6. opening-seat balance
  const picks = openingPicks(topo, pips);
  const spread = picks.length >= 4 ? picks[0] - picks[3] : 0;
  if (spread > cfg.maxOpeningSpread) {
    add('opening-spread', `${picks.join('/')} spread ${spread}`);
  }

  // 7. resource balance
  const pipsBy = {}, tilesBy = {};
  for (let i = 0; i < n; i++) {
    const res = RESOURCE_OF[terrain[i]];
    if (!res) continue;
    pipsBy[res] = (pipsBy[res] || 0) + pips[i];
    tilesBy[res] = (tilesBy[res] || 0) + 1;
  }
  for (const res of Object.keys(tilesBy)) {
    const fair = TOTAL_PIPS * tilesBy[res] / 18;
    const share = pipsBy[res] / fair;
    if (share < cfg.minResourceShare || share > cfg.maxResourceShare) {
      add('resource-balance', `${res} ${pipsBy[res]} pips = ${share.toFixed(2)}x fair`);
    }
  }

  return bad;
}

/** Convenience wrapper used by tools: does this assignment pass everything? */
export function isFairBoard(terrain, numbers, topo, cfg = FAIRNESS) {
  return boardViolations(terrain, numbers, topo, cfg).length === 0;
}

/* ---------------------------------------------------------- generation */

/**
 * Roll a board.
 *
 * @param {object} topo  { desertIndex, corners } from layout.js
 * @param {number} seed  32-bit unsigned; the same seed always gives the same board
 * @returns {{
 *   seed, terrain, numbers, ports, pips, attempts, fair, violations,
 *   openingPicks, openingSpread
 * }}
 */
export function generateBoard(topo, seed, cfg = FAIRNESS) {
  const rng = mulberry32(seed >>> 0);
  const n = TILE_POSITIONS.length;
  const slots = [];
  for (let i = 0; i < n; i++) if (i !== topo.desertIndex) slots.push(i);

  let best = null;
  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
    const terrainBag = shuffled(TERRAIN_BAG, rng);
    const tokenBag = shuffled(TOKEN_BAG, rng);

    const terrain = new Array(n);
    const numbers = new Array(n).fill(0);
    terrain[topo.desertIndex] = 'desert';
    slots.forEach((tileIndex, k) => {
      terrain[tileIndex] = terrainBag[k];
      numbers[tileIndex] = tokenBag[k];
    });

    const violations = boardViolations(terrain, numbers, topo, cfg);
    if (!violations.length || !best || violations.length < best.violations.length) {
      const pips = numbers.map(pipsOf);
      const picks = openingPicks(topo, pips);
      best = {
        seed: seed >>> 0,
        terrain, numbers, pips,
        ports: shuffled(PORT_BAG, rng),
        attempts: attempt,
        fair: violations.length === 0,
        violations,
        openingPicks: picks,
        openingSpread: picks.length >= 4 ? picks[0] - picks[3] : 0
      };
    }
    if (best.fair) return best;
  }
  return best;
}

export default generateBoard;
