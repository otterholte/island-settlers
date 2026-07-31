/**
 * Ground sampler shim.
 *
 * The World agent owns `src/world/terrain.js`. It may land after this module,
 * so we import it lazily and fall back to the documented approximation
 * (LAND_HEIGHT + elevation * 0.62) until it exists. Tile tops run ~1.76-3.71,
 * never y = 0.
 *
 * Owner: Character agent.
 */

import { LAND_HEIGHT } from '../core/constants.js';
import { tileAt, tiles } from '../board/layout.js';

let sampler = null;

export function fallbackHeight(x, z) {
  const t = tileAt(x, z);
  if (t) return LAND_HEIGHT + t.elevation * 0.62;
  // Off the island: blend down toward the shoreline.
  let best = tiles[0], bestD = Infinity;
  for (const q of tiles) {
    const d = (q.x - x) * (q.x - x) + (q.z - z) * (q.z - z);
    if (d < bestD) { bestD = d; best = q; }
  }
  return LAND_HEIGHT + best.elevation * 0.62;
}

export function groundAt(x, z) {
  if (sampler) {
    const y = sampler(x, z);
    if (Number.isFinite(y)) return y;
  }
  return fallbackHeight(x, z);
}

/** Let the host inject a sampler explicitly (main.js exposes world.heightAt). */
export function useHeightSampler(fn) {
  if (typeof fn === 'function') sampler = fn;
}

// Opportunistic: pick up the real terrain sampler the moment it exists.
(async () => {
  try {
    const m = await import('../world/terrain.js');
    if (m && typeof m.heightAt === 'function') sampler = m.heightAt;
  } catch (e) { /* terrain.js not landed yet — fallback stays in play */ }
})();
