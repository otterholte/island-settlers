/**
 * Island Settlers — difficulty levels.
 *
 *   getDifficulty() -> 'easy' | 'medium' | 'hard'
 *   setDifficulty(key) -> key            (persisted, notifies listeners)
 *   difficultyParams(key?) -> LEVEL      (the tuning block bots.js reads)
 *   onDifficultyChange(fn) -> off()
 *
 * One module, one source of truth. The opening screen writes the choice, the
 * bots read it every planning tick, and `flowRestart.js` re-applies it on a
 * replay. Nothing else in the build needs to know it exists.
 *
 * IMPORTANT — nothing here makes a bot cheat. Every knob degrades or sharpens
 * the *bot's own play*: how fast it runs, how long it dithers, how good its
 * choice is, how willing it is to trade or raid. Resources still only ever
 * arrive through a rules.js call, on a hex the bot owns.
 *
 * Headless-safe: no DOM, no three.js, no storage unless one happens to exist.
 *
 * Owner: Bots agent.
 */

/** Order the selector renders them in. `novice` is deliberately not listed. */
export const DIFFICULTY_ORDER = ['easy', 'medium', 'hard'];

export const DEFAULT_DIFFICULTY = 'easy';

/**
 * Every field, and what it costs a bot to have it turned down:
 *
 *   speed / accel   multiplies BOT_SPEED and BOT_ACCEL — the "too quick" fix
 *   replan          multiplies the re-plan interval; a slow thinker reacts late
 *   hesitate,pause  chance of, and length of, standing still on a new decision
 *   actDelay        seconds spent loitering on the spot before the build fires
 *   noise           multiplies the scoring jitter fed into every comparison
 *   secondBest      chance of buying the 2nd/3rd best thing instead of the best
 *   routeSlop       chance of running at a random item rather than the nearest
 *   tileSlop        chance of working a random hex of theirs, not the best one
 *   wander/wanderSec chance per plan of ambling off and achieving nothing
 *   hoard           chance of going back out to gather even though the thing
 *                   is already affordable — the beginner who keeps collecting
 *                   instead of spending, and the biggest single brake on how
 *                   relentlessly a rival expands
 *   trade           willingness to route a purchase through a dock at all
 *   knight/knightAim/knightGap  how often the Raider flies and how well aimed
 *   endgame         whether the "one point from winning" VP rush applies
 *   award           multiplies the Longest Road / Largest Army chase
 *   setupNoise      randomness in the opening draft picks
 *   desperate       seconds of no progress before the bot takes any quick win
 *   rampFrom        match time at which the SOFT anti-stall ramp in bots.js
 *                   starts. It only sharpens a rival's bookkeeping — dithering,
 *                   wandering, hoarding — and is weighted to leave run speed,
 *                   raiding and the trophy chase nearly untouched, so easing is
 *                   real for the whole match. The separate panic ramp, which is
 *                   on a fixed clock, is the last resort. See bots.js.
 *
 * The whole ladder was moved down a rung after playtesting: the level that used
 * to be Hard is gone, Hard is now roughly the old Medium, Medium is roughly the
 * old Easy, and Easy is a long way below anything that shipped before. Nobody
 * on this island is trying to win a tournament.
 */
export const LEVELS = {
  easy: {
    key: 'easy',
    label: 'Easy',
    blurb: 'Barely trying',
    // Half the run speed, a second of loitering before every build, and
    // roughly a third of their affordable purchases postponed in favour of yet
    // more gathering. A beginner still finding the thumbstick beats this field:
    // the novice stand-in wins 96% of simulated matches against it.
    speed: 0.52, accel: 0.60,
    replan: 2.80, hesitate: 0.62, pause: 1.45, actDelay: 0.95,
    noise: 3.8, secondBest: 0.48, routeSlop: 0.68, tileSlop: 0.58,
    wander: 0.22, wanderSec: 3.2,
    hoard: 0.30,
    trade: 0.28,
    knight: 0.14, knightAim: 0.10, knightGap: 32,
    endgame: false, award: 0.45, setupNoise: 3.0, desperate: 26,
    rampFrom: 210
  },
  medium: {
    key: 'medium',
    label: 'Medium',
    blurb: 'Slow and clumsy',
    // Where Easy used to sit.
    speed: 0.69, accel: 0.76,
    replan: 2.00, hesitate: 0.42, pause: 0.95, actDelay: 0.55,
    noise: 2.9, secondBest: 0.33, routeSlop: 0.52, tileSlop: 0.42,
    wander: 0.13, wanderSec: 2.4,
    hoard: 0.13,
    trade: 0.46,
    knight: 0.30, knightAim: 0.20, knightGap: 22,
    endgame: false, award: 0.70, setupNoise: 3.0, desperate: 23,
    rampFrom: 195
  },
  hard: {
    key: 'hard',
    label: 'Hard',
    blurb: 'An even contest',
    // Where Medium used to sit, shaded down a little further. Nothing in the
    // build is as strong as the old Hard any more.
    speed: 0.78, accel: 0.84,
    replan: 1.60, hesitate: 0.28, pause: 0.62, actDelay: 0.38,
    noise: 2.1, secondBest: 0.18, routeSlop: 0.28, tileSlop: 0.26,
    wander: 0.06, wanderSec: 1.8,
    hoard: 0.08,
    trade: 0.68,
    knight: 0.56, knightAim: 0.48, knightGap: 11,
    endgame: true, award: 0.80, setupNoise: 2.0, desperate: 20,
    rampFrom: 180
  },

  /**
   * NOT a difficulty the player can pick. This is the stand-in for a human of
   * modest skill, used by `tools/simulate.mjs` in seat 0 so "is Easy beatable?"
   * has a number attached to it. A learner moves nearly as fast as anyone —
   * they hold the stick down — but plans badly, dithers, forgets to trade and
   * never chases an award on purpose.
   */
  novice: {
    key: 'novice',
    label: 'Novice',
    blurb: 'A human still learning the game',
    // Movement is the one thing a beginner does at full strength: PLAYER_SPEED
    // is 12 against a bot's 11, and holding a thumbstick down takes no skill.
    // Everything downstream of "where should I go and why" is poor.
    speed: 1.05, accel: 1.05,
    replan: 2.40, hesitate: 0.45, pause: 1.00, actDelay: 0.55,
    noise: 3.0, secondBest: 0.30, routeSlop: 0.35, tileSlop: 0.30,
    wander: 0.14, wanderSec: 2.2,
    hoard: 0.22,
    trade: 0.30,
    knight: 0.35, knightAim: 0.30, knightGap: 18,
    // The HUD tells a human when they are one point away, so they do get the
    // endgame push; nobody tells them to chase Longest Road, so they do not.
    endgame: true, award: 0.40, setupNoise: 3.0, desperate: 24,
    rampFrom: 9999
  }
};

/**
 * NOT a difficulty either, and deliberately not in `LEVELS`: the profile the
 * anti-stall ramp in bots.js blends toward once a match has run so long it has
 * to be brought to an end. It is roughly the old Hard, and it is the only thing
 * in the build that still plays that sharply — a player never meets it unless
 * the clock is past five and a half minutes with nobody able to close.
 */
export const RAMP_CEILING = {
  key: 'ceiling',
  speed: 1.00, accel: 1.00,
  replan: 1.00, hesitate: 0.00, pause: 0.00, actDelay: 0.00,
  noise: 1.0, secondBest: 0.00, routeSlop: 0.00, tileSlop: 0.00,
  wander: 0.00, wanderSec: 0.0,
  hoard: 0.00,
  trade: 1.00,
  knight: 1.00, knightAim: 1.00, knightGap: 0,
  endgame: true, award: 1.00, setupNoise: 1.0, desperate: 14
};

export const DIFFICULTY_LABEL = {
  easy: LEVELS.easy.label, medium: LEVELS.medium.label, hard: LEVELS.hard.label
};

const STORE_KEY = 'island-settlers.difficulty';

function isLevel(key) {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(LEVELS, key);
}

function readStored() {
  try {
    const s = globalThis.localStorage;
    if (!s || typeof s.getItem !== 'function') return null;
    const v = s.getItem(STORE_KEY);
    return DIFFICULTY_ORDER.includes(v) ? v : null;
  } catch (e) { return null; }
}

function writeStored(key) {
  try {
    const s = globalThis.localStorage;
    if (s && typeof s.setItem === 'function') s.setItem(STORE_KEY, key);
  } catch (e) { /* private mode, file:// — the choice just does not persist */ }
}

let current = readStored() || DEFAULT_DIFFICULTY;
const listeners = new Set();

export function getDifficulty() { return current; }

/** Set the level. Returns the level actually in force. */
export function setDifficulty(key) {
  if (!DIFFICULTY_ORDER.includes(key)) return current;
  if (key === current) return current;
  current = key;
  writeStored(key);
  for (const fn of listeners) {
    try { fn(current, LEVELS[current]); } catch (e) { /* a listener is not our problem */ }
  }
  return current;
}

/** Subscribe to changes; returns an unsubscribe function. */
export function onDifficultyChange(fn) {
  if (typeof fn !== 'function') return () => {};
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The tuning block for `key`, or for the level currently in force. */
export function difficultyParams(key) {
  if (isLevel(key)) return LEVELS[key];
  return LEVELS[current] || LEVELS[DEFAULT_DIFFICULTY];
}

export default {
  DIFFICULTY_ORDER, LEVELS, RAMP_CEILING, getDifficulty, setDifficulty,
  onDifficultyChange, difficultyParams
};
