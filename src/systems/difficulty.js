/**
 * Island Settlers — difficulty levels.
 *
 *   getDifficulty() -> 'easy' | 'medium' | 'hard' | 'expert'
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
export const DIFFICULTY_ORDER = ['easy', 'medium', 'hard', 'expert'];

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
 *   knight/knightAim/knightGap  how often the Knight flies and how well aimed
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
 * THE WHOLE LADDER WAS RAISED. The rungs used to hold the novice stand-in to
 *
 *     easy 94.6%   medium 52.5%   hard 20.2%   expert 8.5%
 *
 * and they now measure (`tools/simulate.mjs --matches=60 --novice
 * --difficulty=…`, run against the current economy and a 12-point target):
 *
 *     easy 55%     medium 13%     hard 0%     expert 5%
 *
 * EASY WAS RETUNED AGAIN, AND ONLY EASY.
 *
 *   "I'd like for the easy level to be even easier. As a new player still
 *    learning, they seem to move really fast still. But keep the other levels
 *    of difficulty the same."
 *
 * Measured before touching it, the bottom rung was letting the novice stand-in
 * win 17% — the file said 49%, and the ladder had drifted a long way under it
 * as the economy and the target moved. Seventeen per cent is not a bottom rung;
 * it is the same cutscene as 95%, played the other way round.
 *
 * The retune below splits into two kinds of knob, because they do not cost the
 * same thing. Blunting a rival's JUDGEMENT — worse opening picks, the second
 * best purchase, the wrong hex, no trophy chase, no endgame rush — makes it
 * beatable without making the match longer. Slowing it DOWN does both, so the
 * pace knobs moved least: speed 0.78 -> 0.70, which against the player's 12 is
 * about 7.4 to their 12, comfortably behind rather than shoulder to shoulder.
 *
 * Match length was watched the whole way: the median finished match is 332s and
 * 4 of 60 reach the soft cap, against 299s and 3 of 60 before. An earlier pass
 * that got the win rate to 67% cost 12 of 60 running past seven minutes, which
 * is not a beginner's game, it is a long one.
 *
 * Hard reading 0% and Expert 5% is the floor talked about below, not Hard being
 * harder than Expert — under about 10% the stand-in is losing to variance.
 *
 * Two different complaints, one at each end. At the bottom, 95% is not a
 * difficulty, it is a cutscene — a beginner never lost and so never found out
 * what losing was caused by. At the top, "the novice loses 91% of the time"
 * turned out to say nothing about whether somebody who has LEARNED the game
 * loses, and the answer was no.
 *
 * Note what the expert figure can and cannot tell you. Below about 10% the
 * stand-in is losing to variance rather than to skill, so the metric floors out
 * and the last pass moved it 8.5% -> 7% while every knob moved a long way. It
 * is the knobs that a strong player meets. The 2% here is the second pass,
 * seven tenths of the way to flawless.
 *
 * Fewer than about 50 matches is not a measurement: the simulator is not
 * bit-reproducible, and a 25-match run swings ten points either way on its own.
 *
 * Each level's `blurb` describes what the rivals do — their pace, how quickly
 * they expand, how much pressure they apply. It is a description of the
 * opposition, not a comment on whoever picked it.
 */
export const LEVELS = {
  /*
   * THE WHOLE LADDER MOVED UP A RUNG.
   *
   *   "Right now, now that I know how to play, I keep winning on expert. And
   *    easy, they are really bad. Can you increase the difficulty for all of
   *    the levels, so that a beginner might lose if they have no idea what
   *    they're doing, but they learn as they go. And a good player might still
   *    lose on expert."
   *
   * The old ladder was built around a novice stand-in and measured 95 / 53 / 19
   * / 9 per cent win rates. Two things are wrong with that once the player is no
   * longer a novice. At the bottom, 95% is not a difficulty, it is a cutscene —
   * a beginner never loses and so never finds out what losing is caused by. At
   * the top, "the novice loses 91% of the time" says nothing at all about
   * whether somebody who has learned the game loses, and the answer turned out
   * to be no.
   *
   * So each rung takes the numbers of the rung above it, and Expert is new:
   *
   *   Easy    <- the old Medium
   *   Medium  <- the old Hard
   *   Hard    <- the old Expert
   *   Expert  <- halfway from the old Expert to RAMP_CEILING, which is flawless
   *              play. Half the remaining distance to perfect, in every knob.
   *
   * The bottom rung is the one to be careful with, and it is not careless: the
   * old Medium still loiters before every build, postpones a fifth of what it
   * can afford, wanders, and never plays for an award on purpose. A beginner
   * who does not know what a settlement is for will lose to it. A beginner who
   * works out that corners touching three hexes are better than corners
   * touching two will beat it inside a few matches, which is the point.
   */
  easy: {
    key: 'easy',
    label: 'Easy',
    blurb: 'Gentle pace, easy to get ahead of',
    /* Rivals that amble. They run at about 7.4 against the player's 12, take a
       breath before every build, take the second-best thing a third of the
       time, work the wrong hex nearly as often, never chase a trophy on purpose
       and have no endgame rush at all. The Knight goes out rarely and is badly
       aimed when it does.
       What is deliberately NOT turned off: they still expand, still trade
       sometimes, still take a corner you wanted. A rung that cannot beat you is
       not teaching you anything — this one wins about 45% of the time against
       somebody still learning the board. */
    speed: 0.70, accel: 0.78,
    replan: 1.85, hesitate: 0.34, pause: 0.80, actDelay: 0.52,
    noise: 3.1, secondBest: 0.36, routeSlop: 0.42, tileSlop: 0.42,
    wander: 0.11, wanderSec: 2.3,
    hoard: 0.16,
    trade: 0.46,
    knight: 0.26, knightAim: 0.22, knightGap: 22,
    endgame: false, award: 0.42, setupNoise: 3.3, desperate: 28,
    rampFrom: 300
  },
  medium: {
    key: 'medium',
    label: 'Medium',
    blurb: 'Fast pace, constant pressure',
    // The old Hard.
    speed: 0.83, accel: 0.88,
    replan: 1.45, hesitate: 0.22, pause: 0.50, actDelay: 0.30,
    noise: 1.85, secondBest: 0.14, routeSlop: 0.22, tileSlop: 0.20,
    wander: 0.04, wanderSec: 1.6,
    hoard: 0.05,
    trade: 0.74,
    knight: 0.63, knightAim: 0.55, knightGap: 10,
    endgame: true, award: 0.85, setupNoise: 1.7, desperate: 19,
    rampFrom: 175
  },
  hard: {
    key: 'hard',
    label: 'Hard',
    blurb: 'Sharp, and quicker than you',
    // The old Expert, unchanged — including the thing that made it bite: at
    // speed 1.20 these rivals run at 12.3-13.2 against the player's 12, so they
    // are not conceding the movement race that decides how fast a pack fills.
    speed: 1.20, accel: 1.12,
    replan: 1.05, hesitate: 0.03, pause: 0.07, actDelay: 0.04,
    noise: 1.10, secondBest: 0.02, routeSlop: 0.03, tileSlop: 0.03,
    wander: 0.005, wanderSec: 0.2,
    hoard: 0.005,
    trade: 0.97,
    knight: 0.96, knightAim: 0.95, knightGap: 1,
    endgame: true, award: 0.98, setupNoise: 1.06, desperate: 15,
    rampFrom: 100
  },
  expert: {
    key: 'expert',
    label: 'Expert',
    blurb: 'Flawless, and faster than you',
    /*
     * ABOVE THE OLD TOP RUNG, WHICH IS NOW `hard`.
     *
     *   "The bots aren't good enough, they all need to be shifted up a step in
     *    difficulty level. I keep regularly winning on expert."
     *
     * Every knob that models a MISTAKE is already at zero here — there is no
     * hesitation left to remove, no dithering, no wandering, no second-best
     * pick, no hoarding, no bad route, no badly aimed Knight. `RAMP_CEILING`,
     * the profile the anti-stall ramp blends toward and the sharpest play this
     * codebase can express, is what those fields now read.
     *
     * So the only honest way up was the one lever a perfect decision-maker
     * still cannot use: SPEED. Gathering in this game is a movement problem —
     * the whole economy is "who gets to the wood first" — and the player runs
     * at PLAYER_SPEED 12. The old top rung ran at 1.20 x BOT_SPEED (11) through
     * a 0.93-1.00 per-bot scale, so 12.3-13.2: a whisker ahead. This one runs
     * at 1.40, so 14.3-15.4, and accelerates at 1.25 x 55 = 69 against the
     * human's 60.
     *
     * MEASURED, because "faster" is not a difficulty on its own. Against a
     * stand-in built to play like somebody who knows the game — the old
     * Expert's decision-making at human running speed, which is `hard` now —
     * 80 matches per point:
     *
     *   speed 1.30   the stand-in wins 18% (14/78)
     *   speed 1.40   the stand-in wins 10% (8/79)
     *   speed 1.50   the stand-in wins 10% (8/80)
     *
     * So 1.40 halves it and 1.50 buys nothing: past that the limit is the board
     * and the clock, not the running. 1.40 is also the last step before the one
     * the previous pass rejected on sight — 1.45, 16 units/s, a rival that
     * visibly teleports round the island. Losing to Expert should feel unfair;
     * it should not look broken.
     *
     * Every other field is already at RAMP_CEILING, so this rung has nowhere
     * further to go without changing what the bots are allowed to KNOW — which
     * is the line this file has never crossed and will not.
     *
     * `rampFrom` 60: the anti-stall ramp is not an anti-stall measure at this
     * level, it is the rest of the match.
     */
    speed: 1.40, accel: 1.25,
    replan: 1.00, hesitate: 0.00, pause: 0.00, actDelay: 0.00,
    noise: 1.00, secondBest: 0.00, routeSlop: 0.00, tileSlop: 0.00,
    wander: 0.00, wanderSec: 0.0,
    hoard: 0.00,
    trade: 1.00,
    knight: 1.00, knightAim: 1.00, knightGap: 1,
    endgame: true, award: 1.00, setupNoise: 1.00, desperate: 12,
    rampFrom: 60
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
 * to be brought to an end. It is flawless play, well above Expert — a player
 * never meets it unless the clock is past five and a half minutes with nobody
 * able to close.
 *
 * bots.js also uses it as the compass for "which way is sharper?" when it works
 * out whether a soft-ramp blend would strengthen a level or weaken it, so every
 * numeric knob in LEVELS needs an entry here.
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

/** Derived, so a new rung in DIFFICULTY_ORDER never leaves a label behind. */
export const DIFFICULTY_LABEL = Object.fromEntries(
  DIFFICULTY_ORDER.map(k => [k, LEVELS[k].label]));

/** Same, for anywhere that wants the one-line description of the rivals. */
export const DIFFICULTY_BLURB = Object.fromEntries(
  DIFFICULTY_ORDER.map(k => [k, LEVELS[k].blurb]));

const STORE_KEY = 'island-settlers.difficulty';

function isLevel(key) {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(LEVELS, key);
}

/**
 * Every key this game has ever written to storage — easy, medium and hard —
 * is still a level, so a returning player keeps their choice when Expert
 * appears above it. Anything else (a hand-edited value, a key from a future
 * build someone rolled back from) is not guessed at: it falls through to
 * DEFAULT_DIFFICULTY rather than dropping someone onto a rung they never
 * asked for.
 */
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
  DIFFICULTY_ORDER, DIFFICULTY_LABEL, DIFFICULTY_BLURB, LEVELS, RAMP_CEILING,
  getDifficulty, setDifficulty, onDifficultyChange, difficultyParams
};
