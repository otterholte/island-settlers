/**
 * Island Settlers — terrain height field, palettes and noise.
 *
 * PURE MODULE: no three.js, no DOM. Imported by island.js, props.js,
 * water.js, the structures agent, the character controller and headless
 * tools alike. Every object placed in the world sits on `heightAt(x, z)`.
 *
 * ---------------------------------------------------------------------------
 * THE MODEL
 *
 * Each hex is a chunky raised plateau. Its top sits at
 *     top = LAND_HEIGHT + tile.elevation * ELEV_SCALE      (1.755 .. 3.708)
 *
 * The whole island is ONE global scalar field, so adjacent tiles can never
 * disagree about a shared rim: the field is evaluated from world (x, z) and
 * knows nothing about "which tile am I in". Plateau heights are blended with
 * an inverse-power weight of each tile's normalised hex radius `f`, which is
 * exactly 1.0 on that tile's boundary. Two neighbours therefore carry equal
 * weight on the edge they share, and three neighbours carry equal weight at
 * the corner they share — watertight by construction.
 *
 * Outside the hex union the field runs a coast profile: a flat lip, a steep
 * rocky cliff, a pale sand beach and then the sea floor.
 *
 * ---------------------------------------------------------------------------
 * ROAD-STRIP CONVENTION (shared with the structures agent)
 *
 *   hexFrac(x, z) = max(|n0.d|, |n1.d|, |n2.d|) / APOTHEM      d = p - centre
 *   n0 = (1,0)  n1 = (.5,.866)  n2 = (-.5,.866)   APOTHEM = HEX_SIZE*sqrt(3)/2
 *
 *   f  = 0      tile centre
 *   f  = 1      tile boundary (hex edge / corner)
 *
 *   ROAD STRIP  = f in [0.81, 1.00]  -> painted tan/sand, kept clear of props.
 *   PROP ZONE   = f <= 0.78          -> all scattered dressing lives here.
 *   Coastal lip = the same strip continues outward to signed distance 1.15
 *                 before the cliff starts, so coastal roads and docks are flat.
 */

import { HEX_SIZE, LAND_HEIGHT } from '../core/constants.js';
import { tiles, MARKET } from '../board/layout.js';

/* ------------------------------------------------------------------ scale */

export const APOTHEM = HEX_SIZE * Math.sqrt(3) / 2;   // 7.7942
export const ELEV_SCALE = 0.62;                       // tops: 1.755 .. 3.708
export const BLEND_K = 12;                            // rim blend sharpness

export const SHELF = 1.15;      // flat lip beyond the hex union
export const CLIFF_W = 2.00;    // rocky cliff face width (chunky, near-vertical)
export const BEACH_W = 3.40;    // pale sand band width
export const BEACH_TOP = 0.40;  // height at the top of the beach
export const WATER_EDGE = 0.02; // height where the beach meets the sea
export const SEABED_DROP = 7.0;

export const ROAD_STRIP_INNER = 0.81;
export const ROAD_STRIP_OUTER = 1.00;
export const PROP_MAX_FRAC = 0.78;

/** Top surface height of a tile's plateau (before noise / peaks). */
export function topOf(tile) {
  return LAND_HEIGHT + tile.elevation * ELEV_SCALE;
}

export const TILE_TOP = tiles.map(topOf);

/* ------------------------------------------------------------------ noise */

function hash2i(ix, iz) {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iz | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise in [0,1]. */
export function vnoise2(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);
  const a = hash2i(ix, iz), b = hash2i(ix + 1, iz);
  const c = hash2i(ix, iz + 1), d = hash2i(ix + 1, iz + 1);
  return (a + (b - a) * ux) * (1 - uz) + (c + (d - c) * ux) * uz;
}

/** Fractal value noise in [0,1]. */
export function fbm2(x, z, oct = 3) {
  let amp = 0.5, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += amp * vnoise2(x * freq + i * 31.7, z * freq - i * 17.3);
    norm += amp;
    amp *= 0.5; freq *= 2.03;
  }
  return sum / norm;
}

export function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

export function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
export function lerp(a, b, t) { return a + (b - a) * t; }

/* ------------------------------------------------------------------- hexes */

const NX = [1, 0.5, -0.5];
const NZ = [0, 0.8660254037844386, 0.8660254037844386];

/** Normalised hex radius of a point relative to a hex centre. 1 == boundary. */
export function hexFrac(dx, dz) {
  const a = Math.abs(dx);
  const b = Math.abs(NX[1] * dx + NZ[1] * dz);
  const c = Math.abs(NX[2] * dx + NZ[2] * dz);
  return (a > b ? (a > c ? a : c) : (b > c ? b : c)) / APOTHEM;
}

/** Hex radius of (x,z) measured against one specific tile. */
export function fracOn(tile, x, z) { return hexFrac(x - tile.x, z - tile.z); }

const TX = tiles.map(t => t.x);
const TZ = tiles.map(t => t.z);
const NT = tiles.length;

/** Tile whose hex contains (x,z) — or the closest one when out at sea. */
export function nearestTile(x, z) {
  let best = 0, bf = Infinity;
  for (let i = 0; i < NT; i++) {
    const f = hexFrac(x - TX[i], z - TZ[i]);
    if (f < bf) { bf = f; best = i; }
  }
  return tiles[best];
}

/** Smallest hex radius over all tiles. <= 1 exactly on the island footprint. */
export function minFrac(x, z) {
  let bf = Infinity;
  for (let i = 0; i < NT; i++) {
    const f = hexFrac(x - TX[i], z - TZ[i]);
    if (f < bf) bf = f;
  }
  return bf;
}

/** Signed distance to the hex-union footprint. Negative = on the island. */
export function islandSD(x, z) { return (minFrac(x, z) - 1) * APOTHEM; }

/** Is this point inside the tan border strip the roads run along? */
export function onRoadStrip(x, z) {
  const f = minFrac(x, z);
  return f >= ROAD_STRIP_INNER && f <= ROAD_STRIP_OUTER;
}

/* ------------------------------------------------------- mountain skyline */
/* Real pointed peaks stacked on top of the 3.4 mountain elevation. Placed
   deterministically, kept inside f <= 0.86 so they never touch a road. */

function rngFrom(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const PEAKS = [];
tiles.forEach((t, i) => {
  if (t.terrain !== 'mountains') return;
  const rng = rngFrom(9901 + i * 7717);
  const spec = [
    { d: 1.6, h: 3.35, r: 4.4 },
    { d: 4.2, h: 2.15, r: 3.1 },
    { d: 4.6, h: 1.70, r: 2.6 },
    { d: 5.4, h: 1.15, r: 2.2 }
  ];
  const a0 = rng() * Math.PI * 2;
  spec.forEach((s, k) => {
    const a = a0 + k * 2.31 + rng() * 0.5;
    const px = t.x + Math.cos(a) * s.d;
    const pz = t.z + Math.sin(a) * s.d;
    PEAKS.push({
      x: px, z: pz, tile: t.id,
      h: s.h * (0.85 + rng() * 0.3),
      r: s.r * (0.9 + rng() * 0.2)
    });
  });
});

function peakHeight(x, z) {
  let h = 0;
  for (let i = 0; i < PEAKS.length; i++) {
    const p = PEAKS[i];
    const dx = x - p.x, dz = z - p.z;
    const d2 = dx * dx + dz * dz;
    if (d2 >= p.r * p.r) continue;
    const t = 1 - Math.sqrt(d2) / p.r;
    h += p.h * Math.pow(t, 1.55);
  }
  return h;
}

/** Extra height the mountain skyline adds at this point (0 elsewhere). */
export function peakAt(x, z) {
  return peakHeight(x, z) * (1 - smoothstep(0.2, 1.4, islandSD(x, z)));
}

/* --------------------------------------------------------------- the field */

const MKT_R = MARKET.radius;

/**
 * Blended plateau height — the "flat top" component of the island.
 * Weight = f^-12, evaluated by repeated squaring (BLEND_K is fixed at 12).
 * Two neighbours meet at f == 1 on their shared edge, so they carry identical
 * weight there: the rim height is the same no matter which side you ask from,
 * and three neighbours split a corner equally. Practically the top is dead
 * flat out to f ~ 0.80 (the whole prop zone) and then ramps down to the
 * neighbour across the tan border strip, which is where the roads run. Along
 * a shared edge the height is constant, so a road segment never tilts.
 * Steepest possible ramp = (K/2) * dTop / APOTHEM.
 */
export function plateauAt(x, z) {
  let sw = 0, sh = 0;
  for (let i = 0; i < NT; i++) {
    let f = hexFrac(x - TX[i], z - TZ[i]);
    if (f < 0.02) f = 0.02;
    const f2 = f * f, f4 = f2 * f2, f8 = f4 * f4;
    const w = 1 / (f8 * f4);                // f^-12
    sw += w; sh += w * TILE_TOP[i];
  }
  return sh / sw;
}

/** Gentle painted-looking undulation on the tile tops. */
function topNoise(x, z) {
  const n = fbm2(x * 0.085, z * 0.085, 3) - 0.5;
  const m = vnoise2(x * 0.31 + 5.5, z * 0.31 - 2.2) - 0.5;
  return n * 0.30 + m * 0.075;
}

/**
 * Exact ground height anywhere in the world: plateau tops, the tan border
 * ramps between tiles, the mountain peaks, the coastal lip, the cliff face,
 * the sand beach and the sea floor. Continuous everywhere.
 */
export function heightAt(x, z) {
  const f = minFrac(x, z);
  const sd = (f - 1) * APOTHEM;

  const base = plateauAt(x, z);
  const land = 1 - smoothstep(0.2, 1.5, sd);

  // Flatten the rim band so roads sit level, and the market plaza dead flat.
  const rimFlat = 1 - smoothstep(0.70, 0.95, f);
  const dm = Math.hypot(x - MARKET.x, z - MARKET.z);
  const plaza = 1 - smoothstep(MKT_R * 0.95, MKT_R * 1.55, dm);

  let h = base + topNoise(x, z) * land * rimFlat * (1 - plaza * 0.94);
  h += peakHeight(x, z) * land;

  // Organic shoreline: wobble the outward distance, but only well outside the
  // hex union so interior rims (sd == 0) are never disturbed.
  const wobMask = smoothstep(0.35, 1.7, sd);
  const wob = wobMask * ((fbm2(x * 0.045 + 11.1, z * 0.045 - 4.4, 2) - 0.5) * 3.1
                       + (vnoise2(x * 0.16, z * 0.16) - 0.5) * 0.9);

  const u = sd + wob - SHELF;
  if (u <= 0) return h;

  // Rocky texture on the cliff face only. The mask MUST be zero at u == 0 or
  // it would step the height right where the plateau lip meets the cliff.
  const cliffMask = smoothstep(0.0, 0.8, u) * (1 - smoothstep(CLIFF_W - 0.4, CLIFF_W + 1.1, u));
  const rock = (fbm2(x * 0.29 - 8.2, z * 0.29 + 3.7, 2) - 0.5) * 0.85 * cliffMask;

  if (u < CLIFF_W) {
    const t = u / CLIFF_W;
    return h + (BEACH_TOP - h) * (t * t * (3 - 2 * t)) + rock;
  }
  const u2 = u - CLIFF_W;
  if (u2 < BEACH_W) {
    const t = u2 / BEACH_W;
    return BEACH_TOP + (WATER_EDGE - BEACH_TOP) * (t * t * (3 - 2 * t)) + rock;
  }
  const u3 = u2 - BEACH_W;
  return WATER_EDGE - SEABED_DROP * (1 - Math.exp(-u3 * 0.17));
}

/** Surface normal, sampled by central difference. */
export function normalAt(x, z, e = 0.45) {
  const hx = heightAt(x + e, z) - heightAt(x - e, z);
  const hz = heightAt(x, z + e) - heightAt(x, z - e);
  const nx = -hx, ny = 2 * e, nz = -hz;
  const l = Math.hypot(nx, ny, nz) || 1;
  return { x: nx / l, y: ny / l, z: nz / l };
}

/** 0 = flat, 1 = vertical. Handy for props that should avoid steep ground. */
export function slopeAt(x, z, e = 0.6) {
  return 1 - normalAt(x, z, e).y;
}

/* ---------------------------------------------------------------- palettes */
/* Three tonal bands per terrain so the tops read as painted, plus the cliff
   and shoreline colours. All values are plain hex ints. */

/* The hue assignments are the ones the art direction wants — do not re-pick
   the families. What changed is VALUE SEPARATION: forest floor sits a good two
   steps darker than pasture so the two greens no longer read as one acidic
   mid-tone, and every terrain's low-to-high span is widened so the tonal
   banding in island.js has something to actually band between. */
export const PALETTE = {
  // shaded forest floor — the darkest green on the board
  forest:    { deep: 0x1e4a1c, low: 0x2c6a24, mid: 0x3f8a2c, high: 0x59a83c,
               cliff: 0x5c4d33, cliffTop: 0x836e4a },
  // ripe grain: richer than the sand it used to blend into
  fields:    { deep: 0x8c6519, low: 0xb68a24, mid: 0xd0ac3c, high: 0xe6c96a,
               cliff: 0x84693b, cliffTop: 0xac8b50 },
  // open pasture — the lightest green, so sheep tiles pop off the forest
  pasture:   { deep: 0x4a8c2c, low: 0x6cb63e, mid: 0x8fce56, high: 0xb6e57e,
               cliff: 0x6f6440, cliffTop: 0x8e8055 },
  hills:     { deep: 0x7a3319, low: 0xa64f26, mid: 0xc9743c, high: 0xe29c5f,
               cliff: 0x6d3c20, cliffTop: 0x9c5e34 },
  mountains: { deep: 0x4a515c, low: 0x6b7480, mid: 0x8f97a3, high: 0xbcc3cd,
               cliff: 0x474d57, cliffTop: 0x767d88 },
  desert:    { deep: 0xbc9256, low: 0xd6b075, mid: 0xeacf9b, high: 0xf9e9c4,
               cliff: 0x93764c, cliffTop: 0xc0a273 }
};

export const SHORE = {
  // The strip is the largest single area of the board after the hex tops, so
  // it cannot sit near white or it drags the whole frame's value up with it.
  strip:     0xc9a970,   // tan road/border strip between hexes
  stripWarm: 0xdcbe8c,
  sand:      0xe2caa0,
  sandPale:  0xf0e0bc,
  wet:       0xd2b98a,
  rock:       0x6f6858,
  rockLit:    0x8e8573,
  seabed:     0x1d6f96,
  seabedDeep: 0x0e4f7c
};

export const SKY_COLORS = {
  horizon: 0xbfe6f5,
  zenith:  0x2f8fd6,
  hazeLo:  0xfbe7c4,
  sunTint: 0xfff2d0
};

export const WATER_COLORS = {
  abyss:   0x073063,   // beyond the shelf — deep navy, reads almost black-blue
  deep:    0x0e5fa8,
  mid:     0x1a8fc4,
  shallow: 0x3fc4d8,
  shoal:   0x8fe6e4,   // the pale rim right over the wet sand
  foam:    0xf2fbff
};

export default {
  heightAt, islandSD, minFrac, hexFrac, PALETTE, SHORE,
  ROAD_STRIP_INNER, ROAD_STRIP_OUTER, PROP_MAX_FRAC
};
