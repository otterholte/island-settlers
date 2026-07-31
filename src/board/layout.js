/**
 * Island Settlers — fixed island layout + board graph.
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
 */

import { HEX_SIZE, TERRAIN_RES, pipsFor } from '../core/constants.js';

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
/* Hand-authored so the island always plays and reads the same way.
   Numbers follow the classic 18-token distribution (2,12 x1; 3-6,8-11 x2).
   No two 5-pip tiles (6 / 8) touch. Desert sits dead centre and hosts
   the great market. */

const TILE_SPEC = [
  // r = -2  (far side)
  { q: 0,  r: -2, terrain: 'mountains', number: 10 },
  { q: 1,  r: -2, terrain: 'pasture',   number: 2  },
  { q: 2,  r: -2, terrain: 'forest',    number: 9  },
  // r = -1
  { q: -1, r: -1, terrain: 'fields',    number: 12 },
  { q: 0,  r: -1, terrain: 'hills',     number: 6  },
  { q: 1,  r: -1, terrain: 'pasture',   number: 4  },
  { q: 2,  r: -1, terrain: 'mountains', number: 10 },
  // r = 0  (middle row)
  { q: -2, r: 0,  terrain: 'forest',    number: 9  },
  { q: -1, r: 0,  terrain: 'fields',    number: 11 },
  { q: 0,  r: 0,  terrain: 'desert',    number: 0  },
  { q: 1,  r: 0,  terrain: 'forest',    number: 3  },
  { q: 2,  r: 0,  terrain: 'hills',     number: 8  },
  // r = 1
  { q: -2, r: 1,  terrain: 'pasture',   number: 8  },
  { q: -1, r: 1,  terrain: 'mountains', number: 4  },
  { q: 0,  r: 1,  terrain: 'fields',    number: 5  },
  { q: 1,  r: 1,  terrain: 'pasture',   number: 11 },
  // r = 2  (near side)
  { q: -2, r: 2,  terrain: 'hills',     number: 3  },
  { q: -1, r: 2,  terrain: 'fields',    number: 6  },
  { q: 0,  r: 2,  terrain: 'forest',    number: 5  }
];

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

export const tiles = TILE_SPEC.map((t, i) => {
  const w = hexToWorld(t.q, t.r);
  return {
    id: i,
    q: t.q,
    r: t.r,
    terrain: t.terrain,
    number: t.number,
    resource: TERRAIN_RES[t.terrain],
    pips: pipsFor(t.number),
    elevation: TERRAIN_ELEVATION[t.terrain],
    x: w.x,
    z: w.z,
    corners: [],   // intersection ids, filled below
    edges: [],     // edge ids, filled below
    ring: Math.max(Math.abs(t.q), Math.abs(t.r), Math.abs(t.q + t.r))
  };
});

export const tileByAxial = new Map(tiles.map(t => [`${t.q},${t.r}`, t]));
export function getTile(q, r) { return tileByAxial.get(`${q},${r}`) || null; }
export const DESERT = tiles.find(t => t.terrain === 'desert');

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
   resource-specific 2:1. Chosen by sweeping the coastal edges by bearing so
   they are always legal and always evenly distributed. */

const PORT_KINDS = [
  { kind: 'generic', resource: null,    ratio: 3 },
  { kind: 'special', resource: 'wheat', ratio: 2 },
  { kind: 'generic', resource: null,    ratio: 3 },
  { kind: 'special', resource: 'ore',   ratio: 2 },
  { kind: 'special', resource: 'wool',  ratio: 2 },
  { kind: 'generic', resource: null,    ratio: 3 },
  { kind: 'special', resource: 'brick', ratio: 2 },
  { kind: 'generic', resource: null,    ratio: 3 },
  { kind: 'special', resource: 'wood',  ratio: 2 }
];

export const ports = [];
{
  const coastal = edges.filter(e => e.coastal)
    .map(e => ({ e, bearing: Math.atan2(e.z, e.x) }))
    .sort((p, q) => p.bearing - q.bearing);

  const want = PORT_KINDS.length;
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

  picked.forEach((p, i) => {
    const spec = PORT_KINDS[i % PORT_KINDS.length];
    const e = p.e;
    const land = tiles[e.tiles[0]];
    // Push the dock outward, away from the island centre.
    const outx = e.x - land.x, outz = e.z - land.z;
    const m = Math.hypot(outx, outz) || 1;
    const port = {
      id: ports.length,
      edge: e.id,
      intersections: [e.a, e.b],
      kind: spec.kind,
      resource: spec.resource,
      ratio: spec.ratio,
      x: e.x + (outx / m) * HEX_SIZE * 0.62,
      z: e.z + (outz / m) * HEX_SIZE * 0.62,
      bearing: Math.atan2(outz, outx),
      label: spec.kind === 'generic' ? '3:1' : `2:1`
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
  tiles, intersections, edges, ports, MARKET, SPAWNS, BOUNDS, DESERT
};

export default BOARD;
