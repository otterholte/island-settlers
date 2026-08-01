/**
 * Island Settlers — island layout + board graph.
 *
 * Pure data / pure math. No three.js, no DOM. Imported by the renderer,
 * the rules engine, the bots and the headless simulator alike.
 *
 * Coordinate system: pointy-top hexes on an axial (q, r) grid.
 *   x =  HEX_SIZE * sqrt(3) * (q + r/2)
 *   z =  HEX_SIZE * 1.5 * r
 * Corner i (0..5) sits at angle (60*i - 30) degrees.
 * Edge  i (0..5) spans corner i -> corner i+1 and faces angle 60*i,
 *   which corresponds to neighbour direction DIRS[i].
 *
 * =============================================================================
 * THE BOARD IS SHUFFLED EVERY MATCH
 * =============================================================================
 * The GEOMETRY is fixed forever: nineteen hexes at the axial positions in
 * `shuffle.js`, the 54 intersections and 72 edges that fall out of them, the
 * coastline, the nine dock berths, the Great Market on the centre hex and the
 * four spawn points around it. `MARKET`, `SPAWNS` and `BOUNDS` never move.
 *
 * The DRESSING is rolled fresh: which terrain sits on each position, which
 * number token it carries, and which resource each dock trades. That happens
 * once, at module load, *before any importer's body runs* — ES modules
 * guarantee this file is fully evaluated before `nodes.js`, `rules.js`,
 * `world/*` or the bots get a look at it. So every downstream module builds
 * itself from the shuffled board without knowing a shuffle happened, and a
 * page load is always a new island.
 *
 * The fairness rules the roll must satisfy are stated in full in the header of
 * `src/board/shuffle.js`.
 *
 * ORDER OF OPERATIONS if you need a *new* board without reloading the page:
 *
 *     reshuffle(seed?)          // 1. re-dresses `tiles` and `ports` IN PLACE
 *                               //    (never replaces the objects — every
 *                               //     module holds direct references)
 *                               // 2. fires the onBoardChanged listeners, which
 *                               //    is how nodes.js re-tags its item fields
 *     <rebuild the world layer>  // 3. YOUR JOB. island.js, props.js,
 *                               //    regions.js and ovmap.js bake terrain,
 *                               //    colour and prop geometry when they are
 *                               //    constructed; they do not poll. Anything
 *                               //    already built still shows the old board.
 *
 * The headless tools do steps 1-2 only (there is no world layer), which is why
 * `tools/simulate.mjs` can play thirty matches on thirty different islands.
 *
 * IN THE BROWSER nothing does step 3 today, so a *replay* needs a reload to get
 * a fresh island. `main.js`'s `game.restart()` currently prefers the in-place
 * path, which keeps the board:
 *
 *     restart() {
 *       if (game.flow && game.flow.restartInPlace && game.flow.restartInPlace()) return;
 *       location.reload();
 *     }
 *
 * Drop the fast path — `restart() { location.reload(); }` — and Play Again
 * deals a new island. That is the ONLY change outside this file's own area that
 * the shuffle needs. (The alternative, wiring `reshuffle()` + a world rebuild
 * into `systems/flowRestart.js`, keeps the reload away but is world-layer work.)
 *
 * PINNING A BOARD, for a screenshot or a bug repro:
 *   - browser:  index.html?board=123456789
 *   - browser:  globalThis.__ISLAND_LAYOUT_SEED__ = 123456789  (before boot)
 *   - node:     ISLAND_LAYOUT_SEED=123456789 node tools/…
 *   - anywhere: reshuffle(123456789)
 */

import { HEX_SIZE, TERRAIN_RES, pipsFor } from '../core/constants.js';
import {
  TILE_POSITIONS, DESERT_INDEX, FAIRNESS, generateBoard, boardViolations
} from './shuffle.js';

export const DIRS = [
  [1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]
];

const SQRT3 = Math.sqrt(3);

export function hexToWorld(q, r) {
  return {
    x: HEX_SIZE * SQRT3 * (q + r / 2),
    z: HEX_SIZE * 1.5 * r
  };
}

export function cornerOffset(i) {
  const a = (Math.PI / 180) * (60 * i - 30);
  return { x: HEX_SIZE * Math.cos(a), z: HEX_SIZE * Math.sin(a) };
}

/* ------------------------------------------------------------------ tiles */
/* Positions are fixed; terrain and numbers are dealt by shuffle.js further
   down (see `applyBoard`). The tiles start out blank so the intersection and
   edge graph — which depends only on geometry — can be built first and handed
   to the fairness test. */

/* Elevation profile: mountains stand tall, hills bump up, fields/pasture sit
   low. Gives the island real silhouette variation instead of a flat slab. */
const TERRAIN_ELEVATION = {
  mountains: 3.4,
  forest: 0.9,
  hills: 1.5,
  fields: 0.25,
  pasture: 0.45,
  desert: 0.6
};

export const tiles = TILE_POSITIONS.map((t, i) => {
  const w = hexToWorld(t.q, t.r);
  return {
    id: i,
    q: t.q,
    r: t.r,
    terrain: 'desert',   // dealt by applyBoard() before this module finishes
    number: 0,
    resource: null,
    pips: 0,
    elevation: TERRAIN_ELEVATION.desert,
    x: w.x,
    z: w.z,
    corners: [],   // intersection ids, filled below
    edges: [],     // edge ids, filled below
    ring: Math.max(Math.abs(t.q), Math.abs(t.r), Math.abs(t.q + t.r))
  };
});

export const tileByAxial = new Map(tiles.map(t => [`${t.q},${t.r}`, t]));
export function getTile(q, r) { return tileByAxial.get(`${q},${r}`) || null; }

/* The desert never moves: the Great Market is built on it and MARKET is derived
   from its position. It is always the centre (0,0) hex. */
export const DESERT = tiles[DESERT_INDEX];

/* ----------------------------------------------------- intersections/edges */

const KEY_PRECISION = 100;
const nodeKey = (x, z) =>
  `${Math.round(x * KEY_PRECISION)}:${Math.round(z * KEY_PRECISION)}`;

export const intersections = [];
const nodeIndex = new Map();

function addIntersection(x, z) {
  const k = nodeKey(x, z);
  if (nodeIndex.has(k)) return nodeIndex.get(k);
  const id = intersections.length;
  intersections.push({
    id, x, z,
    tiles: [],          // tile ids touching this corner
    neighbors: [],      // intersection ids one edge away
    edges: [],          // edge ids touching this corner
    port: null,         // port id if this corner serves one
    coastal: false
  });
  nodeIndex.set(k, id);
  return id;
}

export const edges = [];
const edgeIndex = new Map();

function addEdge(a, b) {
  const k = a < b ? `${a}_${b}` : `${b}_${a}`;
  if (edgeIndex.has(k)) return edgeIndex.get(k);
  const id = edges.length;
  const A = intersections[a], B = intersections[b];
  edges.push({
    id, a, b,
    x: (A.x + B.x) / 2,
    z: (A.z + B.z) / 2,
    angle: Math.atan2(B.z - A.z, B.x - A.x),
    length: Math.hypot(B.x - A.x, B.z - A.z),
    tiles: [],
    coastal: false,
    port: null
  });
  edgeIndex.set(k, id);
  return id;
}

// Build corners + edges from every tile.
for (const t of tiles) {
  const cs = [];
  for (let i = 0; i < 6; i++) {
    const o = cornerOffset(i);
    cs.push(addIntersection(t.x + o.x, t.z + o.z));
  }
  t.corners = cs;
  for (let i = 0; i < 6; i++) {
    const eid = addEdge(cs[i], cs[(i + 1) % 6]);
    t.edges.push(eid);
    if (!edges[eid].tiles.includes(t.id)) edges[eid].tiles.push(t.id);
  }
  for (const cid of cs) {
    if (!intersections[cid].tiles.includes(t.id)) intersections[cid].tiles.push(t.id);
  }
}

// Wire up intersection adjacency.
for (const e of edges) {
  intersections[e.a].neighbors.push(e.b);
  intersections[e.b].neighbors.push(e.a);
  intersections[e.a].edges.push(e.id);
  intersections[e.b].edges.push(e.id);
}

// Coastal = touches fewer than the full complement of tiles.
for (const e of edges) {
  e.coastal = e.tiles.length === 1;
  if (e.coastal) {
    intersections[e.a].coastal = true;
    intersections[e.b].coastal = true;
  }
}

/* ------------------------------------------------------------------ ports */
/* Nine ports spaced around the coastline: four generic 3:1 and five
   resource-specific 2:1. The BERTHS are geographic — chosen by sweeping the
   coastal edges by bearing so they are always legal and always evenly
   distributed — and they never move, because the coastline never changes.
   WHICH RESOURCE each berth trades is dealt by `applyBoard` below, so the same
   corner is not the wheat dock every match. */

const PORT_COUNT = 9;

export const ports = [];
{
  const coastal = edges.filter(e => e.coastal)
    .map(e => ({ e, bearing: Math.atan2(e.z, e.x) }))
    .sort((p, q) => p.bearing - q.bearing);

  const want = PORT_COUNT;
  const minGap = (Math.PI * 2) / want * 0.72;
  const picked = [];
  let cursor = 0;
  for (let attempt = 0; attempt < coastal.length && picked.length < want; attempt++) {
    const c = coastal[(cursor + attempt) % coastal.length];
    const ok = picked.every(p => {
      let d = Math.abs(p.bearing - c.bearing);
      if (d > Math.PI) d = Math.PI * 2 - d;
      return d >= minGap;
    });
    if (ok) picked.push(c);
  }
  // Fallback: if spacing was too strict, fill by even index stride.
  if (picked.length < want) {
    const stride = Math.max(1, Math.floor(coastal.length / want));
    picked.length = 0;
    for (let i = 0; picked.length < want && i < coastal.length; i += stride) {
      picked.push(coastal[i]);
    }
  }
  picked.sort((p, q) => p.bearing - q.bearing);

  picked.forEach((p) => {
    const e = p.e;
    const land = tiles[e.tiles[0]];
    // Push the dock outward, away from the island centre.
    const outx = e.x - land.x, outz = e.z - land.z;
    const m = Math.hypot(outx, outz) || 1;
    const port = {
      id: ports.length,
      edge: e.id,
      intersections: [e.a, e.b],
      kind: 'generic',      // dealt by applyBoard()
      resource: null,
      ratio: 3,
      x: e.x + (outx / m) * HEX_SIZE * 0.62,
      z: e.z + (outz / m) * HEX_SIZE * 0.62,
      bearing: Math.atan2(outz, outx),
      label: '3:1'
    };
    ports.push(port);
    e.port = port.id;
    intersections[e.a].port = port.id;
    intersections[e.b].port = port.id;
  });
}

/* -------------------------------------------------------------- landmarks */

export const MARKET = {
  x: DESERT.x,
  z: DESERT.z,
  radius: HEX_SIZE * 0.55,
  name: 'Great Market'
};

/* Where the four settlers stand at the opening of the match — spread around
   the desert so nobody starts with an unfair head start on the market. */
export const SPAWNS = [0, 1, 2, 3].map(i => {
  const a = (Math.PI / 2) * i + Math.PI / 4;
  return {
    x: MARKET.x + Math.cos(a) * HEX_SIZE * 1.35,
    z: MARKET.z + Math.sin(a) * HEX_SIZE * 1.35,
    facing: a + Math.PI
  };
});

/* ------------------------------------------------------------ board bounds */

export const BOUNDS = (() => {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const n of intersections) {
    minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
    minZ = Math.min(minZ, n.z); maxZ = Math.max(maxZ, n.z);
  }
  return {
    minX, maxX, minZ, maxZ,
    width: maxX - minX,
    depth: maxZ - minZ,
    cx: (minX + maxX) / 2,
    cz: (minZ + maxZ) / 2,
    radius: Math.max(maxX - minX, maxZ - minZ) / 2
  };
})();

/* =========================================================== board shuffle */

/**
 * The corner graph, reduced to what the fairness test needs. Geometry only —
 * it is valid before a single terrain has been dealt and never changes.
 */
export const TOPOLOGY = {
  desertIndex: DESERT_INDEX,
  corners: intersections.map(n => ({
    tiles: n.tiles.slice(),
    neighbors: n.neighbors.slice()
  }))
};

/** Seed of the board currently dealt. Live binding — read it after a
 *  `reshuffle()` to log or reproduce the island. */
export let LAYOUT_SEED = 0;

/** The full result from shuffle.js for the board on the table right now:
 *  `{ seed, terrain, numbers, pips, ports, attempts, fair, violations,
 *     openingPicks, openingSpread }`. */
export let LAYOUT = null;

const boardListeners = [];

/**
 * Subscribe to board re-deals. `nodes.js` uses this to re-tag its item fields;
 * anything else that caches per-tile data should too.
 * Returns an unsubscribe function. Listeners never fire for the initial deal —
 * at that point every module is still loading and builds from the new board
 * anyway.
 */
export function onBoardChanged(fn) {
  if (typeof fn !== 'function') return () => {};
  boardListeners.push(fn);
  return () => {
    const i = boardListeners.indexOf(fn);
    if (i >= 0) boardListeners.splice(i, 1);
  };
}

/**
 * Stamp a generated board onto the live `tiles` and `ports`.
 *
 * Mutates in place and never replaces an object: every module in the build —
 * rules.js, the bots, hud.js, the renderer — captured references to these exact
 * tile and port objects, so swapping them would point half the game at a dead
 * board.
 */
function applyBoard(board) {
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    t.terrain = board.terrain[i];
    t.number = board.numbers[i];
    t.resource = TERRAIN_RES[t.terrain];
    t.pips = pipsFor(t.number);
    t.elevation = TERRAIN_ELEVATION[t.terrain];
  }
  for (let i = 0; i < ports.length; i++) {
    const spec = board.ports[i % board.ports.length];
    const p = ports[i];
    p.kind = spec.kind;
    p.resource = spec.resource;
    p.ratio = spec.ratio;
    p.label = spec.kind === 'generic' ? '3:1' : '2:1';
  }
  LAYOUT = board;
  LAYOUT_SEED = board.seed;
  return board;
}

/** Where the opening seed comes from. `?board=` on the URL,
 *  `globalThis.__ISLAND_LAYOUT_SEED__` or the ISLAND_LAYOUT_SEED env var pin the
 *  island for a screenshot or a repro; otherwise every load deals a new one. */
function defaultSeed() {
  const g = typeof globalThis === 'undefined' ? {} : globalThis;
  let forced = g.__ISLAND_LAYOUT_SEED__;
  if (forced === undefined && g.location && typeof g.location.search === 'string') {
    const m = /[?&]board=([^&]+)/.exec(g.location.search);
    if (m) forced = decodeURIComponent(m[1]);
  }
  if (forced === undefined && typeof process !== 'undefined' && process.env) {
    forced = process.env.ISLAND_LAYOUT_SEED;
  }
  if (forced !== undefined && forced !== null && forced !== '' && Number.isFinite(Number(forced))) {
    return Number(forced) >>> 0;
  }
  return (Math.random() * 4294967296) >>> 0;
}

/**
 * Deal a fresh island.
 *
 * Re-dresses `tiles` and `ports` in place, then notifies `onBoardChanged`
 * listeners. Presentation code that baked geometry from the old board must be
 * rebuilt afterwards — see the ORDER OF OPERATIONS note at the top of the file.
 *
 * @param {number} [seed]  omit for a random island
 * @returns the generated board record (also on `LAYOUT`)
 */
export function reshuffle(seed) {
  const s = seed === undefined || seed === null ? defaultSeed() : (Number(seed) >>> 0);
  const board = applyBoard(generateBoard(TOPOLOGY, s, FAIRNESS));
  for (const fn of boardListeners.slice()) {
    try { fn(board); } catch (err) { /* a listener must never break the deal */ }
  }
  return board;
}

/** Re-run the fairness test against whatever is on the table. Empty = fair. */
export function currentViolations() {
  return boardViolations(
    tiles.map(t => t.terrain), tiles.map(t => t.number), TOPOLOGY, FAIRNESS
  );
}

// Deal the opening board. This runs while layout.js is still evaluating, which
// is before any importer's body has executed — so nodes.js, rules.js, the bots
// and the whole world layer all read an already-shuffled island.
applyBoard(generateBoard(TOPOLOGY, defaultSeed(), FAIRNESS));

export { FAIRNESS };

/* ------------------------------------------------------------- graph utils */

export function edgeBetween(a, b) {
  const k = a < b ? `${a}_${b}` : `${b}_${a}`;
  const id = edgeIndex.get(k);
  return id === undefined ? null : edges[id];
}

/** Is this land point inside the island footprint? Used to keep settlers
 *  from running into the sea. Returns the tile you are standing on, or null. */
export function tileAt(x, z) {
  let best = null, bestD = Infinity;
  for (const t of tiles) {
    const d = (t.x - x) * (t.x - x) + (t.z - z) * (t.z - z);
    if (d < bestD) { bestD = d; best = t; }
  }
  // Inside a pointy-top hex iff distance to centre along both axes fits.
  if (!best) return null;
  const dx = Math.abs(x - best.x), dz = Math.abs(z - best.z);
  const inner = HEX_SIZE * SQRT3 / 2;
  if (dx > inner) return null;
  if (dz > HEX_SIZE) return null;
  if (HEX_SIZE * inner - HEX_SIZE * 0.5 * dx - inner * dz < 0) return null;
  return best;
}

/** Clamp a point back onto the island if it has wandered into the water. */
export function clampToIsland(x, z) {
  if (tileAt(x, z)) return { x, z, clamped: false };
  // Walk back toward the nearest tile centre until we are on land again.
  let best = tiles[0], bestD = Infinity;
  for (const t of tiles) {
    const d = (t.x - x) * (t.x - x) + (t.z - z) * (t.z - z);
    if (d < bestD) { bestD = d; best = t; }
  }
  let lo = 0, hi = 1;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    const px = x + (best.x - x) * mid;
    const pz = z + (best.z - z) * mid;
    if (tileAt(px, pz)) hi = mid; else lo = mid;
  }
  const t2 = Math.min(1, hi + 0.02);
  return { x: x + (best.x - x) * t2, z: z + (best.z - z) * t2, clamped: true };
}

export const BOARD = {
  tiles, intersections, edges, ports, MARKET, SPAWNS, BOUNDS, DESERT,
  reshuffle, onBoardChanged,
  get seed() { return LAYOUT_SEED; },
  get layout() { return LAYOUT; }
};

export default BOARD;
