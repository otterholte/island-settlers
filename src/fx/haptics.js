/**
 * Island Settlers — haptics.
 *
 * `haptic(pattern)` buzzes the device when the platform supports it and
 * silently does nothing everywhere else (desktop, iOS Safari, blocked by
 * permissions policy, a throwing implementation...). Never throws.
 *
 * Patterns are either a duration in ms or a vibrate-style array.
 * A short cooldown stops a burst of gathers from turning into a constant hum.
 */

const G = typeof globalThis !== 'undefined' ? globalThis : {};

export const PATTERNS = {
  tap:     12,
  gather:  [0, 14],
  build:   [0, 22, 40, 16],
  upgrade: [0, 30, 50, 22, 40, 18],
  heavy:   [0, 40, 60, 90],
  deny:    [0, 18, 60, 18]
};

let last = 0;
const COOLDOWN = 55;   // ms
let enabled = true;

export function setHapticsEnabled(on) { enabled = !!on; }

export function haptic(pattern) {
  if (!enabled) return false;
  const nav = G.navigator;
  if (!nav || typeof nav.vibrate !== 'function') return false;

  const now = (G.performance && typeof G.performance.now === 'function')
    ? G.performance.now() : Date.now();
  if (now - last < COOLDOWN) return false;

  let p = pattern;
  if (typeof p === 'string') p = PATTERNS[p];
  if (p === undefined || p === null) p = PATTERNS.tap;
  if (typeof p === 'number') {
    if (!isFinite(p) || p <= 0) return false;
    p = Math.min(120, p | 0);
  } else if (Array.isArray(p)) {
    if (!p.length) return false;
    p = p.map(v => Math.max(0, Math.min(200, isFinite(v) ? v | 0 : 0)));
  } else return false;

  last = now;
  try { nav.vibrate(p); } catch (e) { return false; }
  return true;
}

export default haptic;
