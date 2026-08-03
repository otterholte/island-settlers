/**
 * Island Settlers — per-match rules options.
 *
 *   knightsOn()                  -> boolean
 *   setKnights(on)               -> boolean actually in force
 *   getOption(key) / setOption(key, value)
 *   onOptionsChange(fn)          -> unsubscribe
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A MODULE AND NOT A FIELD ON `state`
 * ---------------------------------------------------------------------------
 * The player asked to be able to switch the Knight off before a match starts:
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
 * it — `drawCard` and `knightBlocks` are the two places the option actually
 * changes what is legal — and `core` may not import from `systems`.
 *
 * ---------------------------------------------------------------------------
 * WHAT "KNIGHTS OFF" ACTUALLY DOES
 * ---------------------------------------------------------------------------
 *   * No Knight is ever dealt. `drawCard` drops it from the weight table and
 *     re-normalises what is left, so the card deck becomes Road Building and
 *     Victory Point at 60/40 rather than 30/20 with a 50% hole in it.
 *   * Nothing can block a hex. `knightBlocks` returns false outright, so even a
 *     Knight left standing somewhere by a restored match costs nobody anything.
 *   * Bots do not look for a Knight to play (`wantsKnight`), the Knight is not
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
  /** Knight cards, the Knight, and Largest Army with them. */
  knights: true,

  /* ------------------------------------------------------- reach
   *
   *   "Have there be an actual joystick on the right side of the screen in the
   *    bottom right corner, maybe actually right above the map, cards, build
   *    buttons. I have some players who only have a right hand. Also in the
   *    settings, give them the option to switch that."
   *
   * Two independent sides rather than one four-way preset. Both on the right is
   * the default and is the one-handed layout; both on the left is its mirror;
   * and setting them differently gives the two-handed split the game used to
   * force on everybody. Four arrangements out of two switches, and neither
   * switch needs a word of explanation.
   *
   * These are 'left' or 'right'. They live here rather than on `state` for the
   * same reason `knights` does — see the note at the top of this file. */
  /* WHICH CORNER THE THREE ACTION KEYS SIT IN, and nothing else.
     There was a matching `stickSide` beside this. The joystick takes a drag
     from anywhere on the screen now, so there is no side for it to be on and
     no setting worth asking anybody about — "so it doesn't need a toggle". */
  buttonsSide: 'right',

  /* PICK MY OPENING FOR ME.
   *
   *   "Add a setting to the game setup page that lets me have a randomized
   *    settlement and road placement for the start of the game, instead of
   *    forcing them to spend the time picking where they want it. Don't give
   *    them really scrappy locations though — just have the bot choose for
   *    them too."
   *
   * A match is three and a half minutes and the draft is a minute of it, most
   * of which is watching. Somebody who wants to play rather than plan should be
   * able to skip straight to the running about.
   *
   * A PERSONAL preference, not a match setting: it is stored on the device
   * beside the name and the button side, so it holds across every match and
   * applies online without going on the wire — nobody else needs to know, or
   * needs to agree, that you would rather be dealt a corner. */
  autoDraft: false,
  /* HOW FAR THE BOARD MAP IS TILTED BACK, 0 (flat overhead) to 1 (as far as
     it goes). Set with two fingers dragged up or down on the map itself, and
     kept here so it survives the match:

       "Let me use two fingers and drag up and down on the map view to
        reposition my view so it's a bit more 3D, and have it save that view
        the next time I open the map, even during the next game. That way if I
        prefer it, I can keep that slightly 3D view and see all of the tiles a
        bit easier on one mobile screen."

     Which is the real reason it earns its place: tilting the board back
     squashes it vertically, so a 375px-tall phone fits the whole island
     without pinching. */
  mapTilt: 0
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
    // The option shipped as `raiders` before the whole mechanic was renamed to
    // KNIGHTS. Anyone who had already switched it off would silently get it
    // back on, which is the one thing a per-match setting must not do, so the
    // old key is still read when the new one is absent. It is never written
    // again: the next `setOption` stores the new shape and the legacy key is
    // simply left behind in whatever entry it was already part of.
    if (typeof got.knights !== 'boolean' && typeof got.raiders === 'boolean') {
      current.knights = got.raiders;
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

/** Are Knight cards, the Knight and Largest Army in play this match? */
export function knightsOn() { return current.knights !== false; }

const side = v => (v === 'left' ? 'left' : 'right');
export function buttonsSide() { return side(current.buttonsSide); }
export function setButtonsSide(v) { return setOption('buttonsSide', side(v)); }

export function autoDraft() { return !!current.autoDraft; }
export function setAutoDraft(v) { return setOption('autoDraft', !!v); }

const TILT_MAX = 1;
export function mapTilt() {
  const v = Number(current.mapTilt);
  return Number.isFinite(v) ? Math.min(TILT_MAX, Math.max(0, v)) : 0;
}
export function setMapTilt(v) {
  const n = Number(v);
  const clamped = Number.isFinite(n) ? Math.min(TILT_MAX, Math.max(0, n)) : 0;
  return setOption('mapTilt', Math.round(clamped * 1000) / 1000);
}

export function setKnights(on) { return setOption('knights', !!on) !== false; }

export default {
  getOption, setOption, onOptionsChange,
  knightsOn, setKnights, buttonsSide, setButtonsSide, mapTilt, setMapTilt,
  autoDraft, setAutoDraft
};
