/**
 * Island Settlers — per-match rules options.
 *
 *   raidersOn()                  -> boolean
 *   setRaiders(on)               -> boolean actually in force
 *   getOption(key) / setOption(key, value)
 *   onOptionsChange(fn)          -> unsubscribe
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A MODULE AND NOT A FIELD ON `state`
 * ---------------------------------------------------------------------------
 * The player asked to be able to switch the Raider off before a match starts:
 *
 *   "Add a feature to turn off the robber/knight if you want, for that specific
 *    game, before the game started."
 *
 * The obvious home would be `createMatch(opts)` — except `createMatch` runs at
 * `main.js:42`, at module load, a long time before the opening screen that asks
 * the question even exists. So this follows the pattern `systems/difficulty.js`
 * already set for exactly the same reason: one module, one source of truth,
 * written by the opening screen and read at the handful of points that care.
 * It also means an in-place replay (`flowRestart.js`, which rebuilds `state`
 * field by field) cannot silently lose the setting, and a `location.reload()`
 * restart comes back with it intact.
 *
 * It lives in `core/` rather than `systems/` because the rules themselves read
 * it — `drawCard` and `raiderBlocks` are the two places the option actually
 * changes what is legal — and `core` may not import from `systems`.
 *
 * ---------------------------------------------------------------------------
 * WHAT "RAIDERS OFF" ACTUALLY DOES
 * ---------------------------------------------------------------------------
 *   * No Knight is ever dealt. `drawCard` drops it from the weight table and
 *     re-normalises what is left, so the card deck becomes Road Building and
 *     Victory Point at 60/40 rather than 30/20 with a 50% hole in it.
 *   * Nothing can block a hex. `raiderBlocks` returns false outright, so even a
 *     Raider left standing somewhere by a restored match costs nobody anything.
 *   * Bots do not look for a Knight to play (`wantsKnight`), the Raider is not
 *     drawn in the world or on the board map, and the HUD's Largest Army line
 *     reads OFF.
 *
 * The knock-on the toggle names on screen: LARGEST ARMY IS OFF TOO. It is won
 * by playing Knights and there are none, so those two victory points are out of
 * reach — for every player equally, which is why it is a fair switch rather
 * than a handicap.
 */

const STORE_KEY = 'island-settlers.options';

export const OPTION_DEFAULTS = Object.freeze({
  /** Knight cards, the Raider, and Largest Army with them. */
  raiders: true
});

const current = { ...OPTION_DEFAULTS };
const listeners = new Set();

function store() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch (e) {
    // Safari in private mode throws on the property access itself.
    return null;
  }
}

function readStored() {
  const s = store();
  if (!s) return;
  try {
    const raw = s.getItem(STORE_KEY);
    if (!raw) return;
    const got = JSON.parse(raw);
    if (!got || typeof got !== 'object') return;
    for (const k in OPTION_DEFAULTS) {
      if (typeof got[k] === typeof OPTION_DEFAULTS[k]) current[k] = got[k];
    }
  } catch (e) { /* a corrupt entry is not worth a crash */ }
}

function writeStored() {
  const s = store();
  if (!s) return;
  try { s.setItem(STORE_KEY, JSON.stringify(current)); } catch (e) { /* full or blocked */ }
}

readStored();

export function getOption(key) {
  return Object.prototype.hasOwnProperty.call(current, key)
    ? current[key] : undefined;
}

/** Set one option. Returns the value actually in force. */
export function setOption(key, value) {
  if (!Object.prototype.hasOwnProperty.call(OPTION_DEFAULTS, key)) return undefined;
  const want = typeof OPTION_DEFAULTS[key] === 'boolean' ? !!value : value;
  if (want === current[key]) return current[key];
  current[key] = want;
  writeStored();
  for (const fn of listeners) {
    try { fn(key, want, { ...current }); } catch (e) { /* a listener is not our problem */ }
  }
  return current[key];
}

export function onOptionsChange(fn) {
  if (typeof fn !== 'function') return () => {};
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/* ------------------------------------------------------------- shorthands */

/** Are Knight cards, the Raider and Largest Army in play this match? */
export function raidersOn() { return current.raiders !== false; }

export function setRaiders(on) { return setOption('raiders', !!on) !== false; }

export default { getOption, setOption, onOptionsChange, raidersOn, setRaiders };
