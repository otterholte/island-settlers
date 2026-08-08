/**
 * Island Settlers — the tutorial controller.
 *
 *   createTutorial(state, game, deps) -> { openBook, startPractice, quit, destroy }
 *
 * Two things live here.
 *
 * 1. THE BOOK. TUTORIAL on the opening screen raises a `mf-tutorial` event on
 *    `document`; this module is what is listening. It builds the illustrated
 *    rules book (src/ui/tutorial.js) lazily, the first time anyone asks.
 *
 * 2. THE PRACTICE RUN. A real match, played slowly, with the game holding the
 *    player's hand:
 *
 *      - the opening draft is completed instantly, and the human is dealt the
 *        richest corner on the board rather than a random one;
 *      - the three rivals are FROZEN — `bots.update` is replaced with a no-op
 *        and their velocities are zeroed every tick, so nothing on the island
 *        moves except the player;
 *      - the match pacing beats and the stalemate cap are switched off through
 *        `deps.setPractice`, so no clock ever runs out under the player;
 *      - one instruction is on screen at a time, with a gold marker on exactly
 *        what it is talking about, and the step only advances when the player
 *        has really done the thing — but BACK and NEXT are always there, so the
 *        run cannot dead-end and cannot be failed.
 *
 * The script itself is in ./tutsteps.js. This file is the machinery: what the
 * badge is wearing, where it is standing, what the ring is on, which parts of
 * the heads-up display exist this step, and when a step is finished.
 *
 * ---------------------------------------------------------------------------
 * THE HUD IS DRESSED WITH CLASSES, NOT WITH AN API
 * ---------------------------------------------------------------------------
 *
 * Five of the owner's notes are about showing and hiding parts of the heads-up
 * display per step:
 *
 *   "remove the timer and the longest road / largest army sections of the
 *    screen for now. And even hide the resource counter that would've been in
 *    the top middle of the screen."
 *   "Have the build button start as collapsed."
 *   "add the pack/resources counter to the top middle of the screen again."
 *   "remove that pack/resource counter temporarily."
 *   "For step 11, add the scores on the right side of screen and hide the build
 *    cards."
 *   "Don't show that section until that step in the tutorial."
 *
 * Not one of them is done by reaching into src/ui/hud.js. The run puts classes
 * on the interface root — `tut-practice`, and then `tut-pack`, `tut-ranks`,
 * `tut-awards`, `tut-nobuild` — and the rules that hide, show and move the
 * existing clusters live in src/ui/tutorial.css beside the coach they are
 * dressing around. The HUD is not edited, is not told anything, and does not
 * know the tutorial exists; and because the whole wardrobe hangs off one root
 * class, `quit()` taking `tut-practice` off puts every cluster back exactly
 * where a real match has it. A tutorial that crashed halfway could not leave a
 * player with no resource pill.
 *
 * The one exception, and it is deliberately not an exception: the four build
 * cards start COLLAPSED by adding the same `hid` class the BUILD key itself
 * toggles. That is not a tutorial-only state — it is the state the player is in
 * every time they press that key — so the step that asks them to press it is
 * pressing the real control, not watching a class come off.
 *
 * Owner: Tutorial (flow) agent.
 */

import { HEX_SIZE, RES } from '../core/constants.js';
import { tiles, intersections, tileAt, DESERT, LAYOUT_SEED } from '../board/layout.js';
import {
  legalSettlements, legalRoads, setupCurrentPlayer,
  setupPlaceSettlement, setupPlaceRoad, canGatherTile,
  isTileExhausted, tileItemsRemaining
} from '../core/rules.js';
import { nearestItem } from '../board/nodes.js';
import { toggle } from '../ui/dom.js';
import { createBook, createCoach } from '../ui/tutorial.js';
import { createSpotlight } from '../ui/tutspot.js';
import { buildSteps } from './tutsteps.js';
import { TUTORIAL_EVENT } from './flowIntro.js';

const NOOP = () => {};

/* ============================================================ THE SET BOARD
 *
 *   "I want the tutorial to be preset, so that they have at least 1 of every
 *    resource hex, that way the tutorial flows better."
 *
 * 840, and it is a measured number rather than a nice one. Dealt through
 * `generateBoard` with the shipping fairness rules and drafted by
 * `completeDraft` below, it hands the human six workable hexes carrying all
 * five resources — wool 5 and 9, ore 6, brick 9, wheat 6, wood 5 — with no hex
 * under 4 pips and the Great Market 18 units from their nearer settlement. So
 * the market lesson has something real to trade, the card lesson can be paid
 * for out of the ground, and the recovery lesson is not run on a 1-pip hex
 * that takes 34 seconds to come back.
 *
 * WHY IT COSTS A RELOAD, which is the part worth defending.
 *
 * `reshuffle()` re-dresses `tiles` in place and re-lays the pickup fields, but
 * the WORLD does not poll: island.js, props.js, regions.js and ovmap.js bake
 * terrain, colour and prop geometry when they are constructed, and by the time
 * anybody presses PRACTICE RUN all four have been built from whatever board the
 * page booted on. Re-dealing at that point would give a hex that grows wheat in
 * the rules and looks like a mountain. Rebuilding the world layer live is a
 * real piece of work in four files this module does not own; a reload is two
 * seconds and is already what END PRACTICE does, so the practice run asks for
 * its board the only way that is honest — `?board=840&practice=1`, which
 * `defaultSeed()` in layout.js has always read — and comes back up on it.
 *
 * A player who is already on 840 (they took the run twice, or arrived by that
 * link) is started immediately, with no reload at all.
 */
export const TUTORIAL_SEED = 840;

/** `?practice=1` — this page was loaded in order to start the practice run. */
function practiceWanted() {
  try {
    return new URLSearchParams(location.search).get('practice') === '1';
  } catch (e) { return false; }
}

/**
 * This page's address with the practice run's own two parameters taken off.
 *
 * THE PARAMETERS ARE AN INSTRUCTION, NOT A PLACE, AND THEY HAVE TO BE SPENT.
 *
 *   "Right now, when I leave the match for a practice game, or go to End
 *    Practice, it just keeps reopening practice for me instead of going to the
 *    main menu."
 *
 * `?board=840&practice=1` means "deal the tutorial's island and start the run".
 * Every exit this game has — END PRACTICE, LEAVE MATCH, the home key, an
 * in-place restart — is a `location.reload()`, and a reload keeps the query
 * string. So the instruction was still sitting in the address bar when the page
 * came back up, `begin()` read it exactly as it was written to, and handed the
 * player back into the practice run they had just left. Forever. The same
 * parameter would also have pinned every future match on that tab to board 840.
 *
 * So the instruction is consumed the moment it is carried out — see the
 * `replaceState` in `startPractice` — and this is the address it is replaced
 * with. `board` goes with `practice` and only with it: somebody who typed
 * `?board=12345` themselves is asking for that island and should keep it, but
 * an 840 this module put there is scaffolding.
 */
function withoutPracticeParams() {
  try {
    const u = new URL(location.href);
    if (u.searchParams.get('practice') !== '1') return null;
    u.searchParams.delete('practice');
    u.searchParams.delete('board');
    return u.toString();
  } catch (e) { return null; }
}

/** Every class this module may put on `#ui`. Listed once so it can be undone. */
const HUD_FLAGS = ['tut-pack', 'tut-ranks', 'tut-awards', 'tut-nobuild',
  'tut-nokeys', 'tut-nokeys-sm', 'tut-norail', 'tut-sidepanel'];

function stub() {
  return {
    openBook: NOOP, startPractice: NOOP, quit: NOOP, destroy: NOOP,
    get running() { return false; }
  };
}

/**
 * World point -> normalised screen point, straight off the camera's two
 * matrices. Same trick src/ui/hud-trade.js uses, and for the same reason:
 * it keeps this file free of a three.js import.
 */
function project(cam, x, y, z) {
  const v = cam && cam.matrixWorldInverse && cam.matrixWorldInverse.elements;
  const p = cam && cam.projectionMatrix && cam.projectionMatrix.elements;
  if (!v || !p) return null;
  const ax = v[0] * x + v[4] * y + v[8] * z + v[12];
  const ay = v[1] * x + v[5] * y + v[9] * z + v[13];
  const az = v[2] * x + v[6] * y + v[10] * z + v[14];
  const aw = v[3] * x + v[7] * y + v[11] * z + v[15];
  const cx = p[0] * ax + p[4] * ay + p[8] * az + p[12] * aw;
  const cy = p[1] * ax + p[5] * ay + p[9] * az + p[13] * aw;
  const cw = p[3] * ax + p[7] * ay + p[11] * az + p[15] * aw;
  if (!(cw > 0.0001)) return null;
  return { x: (cx / cw) * 0.5 + 0.5, y: 0.5 - (cy / cw) * 0.5 };
}

/* ================================================================== module */

export function createTutorial(state, game, deps = {}) {
  if (typeof document === 'undefined' || !document.createElement) return stub();
  const g = game || {};
  const host = deps.host
    || document.getElementById('app')
    || document.body;
  if (!host || !host.appendChild) return stub();

  const me = state.players[0];

  let book = null;
  let coach = null;
  let spot = null;
  let running = false;
  let raf = 0;
  let idx = 0;
  /* 'brief' is the large explain-first half of a step; 'body' is the task.
     A step with no `brief` starts, and stays, in 'body'. */
  let phase = 'body';
  let steps = [];
  /*
   * BACK HAS TO ACTUALLY GO BACK.
   *
   *   "Make sure the back and next buttons work at any time during the
   *    tutorial, it seems to be stopping me from going back a lot of the time."
   *
   * It was not the key and it was not `canBack` — it was the auto-advance. A
   * step finishes when `check()` comes true, and `check()` is polled every
   * frame with no memory of when the player arrived. Half the checks in the
   * script are states rather than events: `standingOn(homeTile)`,
   * `isTileExhausted`, `buildRowOpen()`, `legalSettlements(...).length > 0`.
   * Every one of those is STILL TRUE after the thing has been done, so pressing
   * Back landed on a step whose condition was already satisfied and the very
   * next frame threw the player forward again. From the outside that is a Back
   * key that does nothing.
   *
   * `armed` is the fix and it is one line of state: a step may only auto-advance
   * on a check that was FALSE when the step came up. Arriving on an
   * already-satisfied step simply parks there and waits for Next, which is what
   * somebody re-reading a step wants. Going forward is untouched, because
   * `snapshot()` resets the counters the forward checks are measured against, so
   * those are false on arrival exactly as before.
   */
  let armed = false;
  /* Is NEXT dimmed right now because a `holdNext` step has not been done? */
  let heldNow = false;
  /*
   * SECONDS OF NOTHING BEFORE A STEP SPEAKS.
   *
   *   "Then close the tutorial steps, show the building of the road animation
   *    happen, and after it has you can show the next step."
   *
   * A step with `quiet: n` arrives with the badge hidden and raises it n seconds
   * later. The map is closing and the road is dropping into place over those two
   * seconds, and a card explaining the road on top of the road being built is
   * the one mistake this whole rework keeps being asked to stop making. Counted
   * in the frame loop rather than on a `setTimeout` so that leaving the run
   * mid-gap cannot raise a badge into a match that is no longer a tutorial.
   */
  let quietT = 0;
  /* Which steps the player has really completed this run, for `holdNext`. */
  const satisfied = new Set();
  let homeTile = -1;
  let walked = 0;
  let lastX = 0, lastZ = 0;
  let lastMs = 0;
  const base = {
    gathered: 0, roads: 0, settlements: 0, cities: 0, traded: 0, cards: 0
  };

  /* -------------------------------------------------------------- the book */

  function ensureBook() {
    if (book) return book;
    book = createBook(host, { onPractice: () => startPractice() });
    return book;
  }

  function openBook() {
    if (running) return;
    ensureBook().open();
  }

  const onAsk = () => openBook();
  document.addEventListener(TUTORIAL_EVENT, onAsk);

  /* ------------------------------------------------------------ the board */

  /**
   * The human's opening pick, and the SECOND one knows about the first.
   *
   *   "I want the tutorial to be preset, so that they have at least 1 of every
   *    resource hex, that way the tutorial flows better."
   *
   * A corner touches three hexes at most, so no single pick can ever see five
   * resources — the draft deals the human TWO settlements, and the pair is what
   * has to cover the set. The old rule scored both picks the same way, on total
   * pips and how many kinds that ONE corner touched, which meant the second
   * pick cheerfully landed on another rich corner growing the same three
   * things. Measured over 4000 boards it came out with all five resources 30%
   * of the time, and a run that reaches "walk to the market and trade for what
   * you are short of" with two of the five never in the pack is a run that has
   * to invent its own shortage.
   *
   * `have` carries what the first pick already reaches, and a resource the
   * player cannot otherwise get is worth more than any amount of production —
   * 14 against a pip's 2, which is more than the widest pip gap a legal corner
   * can offer, so freshness always outranks richness and richness breaks the
   * tie. Same 4000 boards: 88%.
   *
   * The other 12% is why there is a pinned seed as well; see `TUTORIAL_SEED`.
   * This function is what covers the boards that are not it — a player who
   * joined a friend's island, or anyone the reload could not be done for.
   */
  function bestCorner(list, have) {
    let best = list[0], bestScore = -Infinity;
    for (const iid of list) {
      const n = intersections[iid];
      if (!n) continue;
      let pips = 0;
      const kinds = new Set();
      for (const tid of n.tiles) {
        const t = tiles[tid];
        if (!t || !t.resource) continue;
        pips += t.pips || 0;
        kinds.add(t.resource);
      }
      let fresh = 0;
      if (have) for (const k of kinds) if (!have.has(k)) fresh++;
      const score = pips * 2 + kinds.size * 2 + fresh * 14;
      if (score > bestScore) { bestScore = score; best = iid; }
    }
    return best;
  }

  /** Run the whole opening draft now, through rules.js's own setup path. */
  function completeDraft() {
    let guard = 0;
    // What the human's picks already reach, so the second one can go looking
    // for what the first one is missing. See `bestCorner`.
    const have = new Set();
    while (state.phase === 'setup' && guard++ < 64) {
      const pid = setupCurrentPlayer(state);
      if (state.setupNeed === 'settlement') {
        const list = legalSettlements(state, pid, true);
        if (!list.length) break;
        const pick = pid === 0
          ? bestCorner(list, have)
          : list[Math.floor(list.length * (0.2 + pid * 0.22)) % list.length];
        if (pid === 0) {
          const n = intersections[pick];
          if (n) for (const tid of n.tiles) {
            const t = tiles[tid];
            if (t && t.resource) have.add(t.resource);
          }
        }
        setupPlaceSettlement(state, pid, pick);
      } else {
        const list = legalRoads(state, pid, true, state.setupAnchor);
        if (!list.length) break;
        setupPlaceRoad(state, pid, list[0]);
      }
    }
    // The Knight starts on the desert and, with the bots frozen, never moves.
    state.robberTile = DESERT.id;
    state.robberOwner = -1;
  }

  /**
   * Every hex the player may actually pick things up on, asked the same way the
   * island asks it.
   *
   * `canGatherTile` is the single source of the "yours / not yours" read: it is
   * what src/world/mood.js polls to decide which hexes get the warm sunlit lift
   * and the standing blue light wall from src/world/regions.js, and which ones
   * get the duotone mute. So the wash and the gold dots drawn over these hexes
   * are pointing at the glow the world is already drawing, and there is no way
   * for the two to disagree about which hexes those are.
   */
  function workable() {
    const out = [];
    for (const t of tiles) {
      if (!t.resource) continue;
      let ok = false;
      try { ok = canGatherTile(state, 0, t.id); } catch (e) { ok = false; }
      if (ok) out.push(t.id);
    }
    return out;
  }

  /** The fullest hex the player now owns — the one we teach on. */
  function pickHomeTile() {
    let best = -1, bestScore = -1;
    for (const tid of workable()) {
      const t = tiles[tid];
      if (!t) continue;
      const score = (t.pips || 0) + tileItemsRemaining(tid) * 0.1;
      if (score > bestScore) { bestScore = score; best = tid; }
    }
    return best;
  }

  function freezeRivals() {
    const bots = g.bots;
    if (bots && typeof bots.update === 'function' && !bots.__tutFrozen) {
      bots.__tutFrozen = true;
      bots.update = NOOP;
    }
  }

  function holdRivals() {
    for (let i = 1; i < state.players.length; i++) {
      const p = state.players[i];
      p.vx = 0; p.vz = 0;
      if (p.action === 'run') p.action = 'idle';
    }
  }

  /* ------------------------------------------------------------- materials */

  /**
   * SET the pack to exactly this, rather than topping it up to a floor.
   *
   *   "Make sure you give them a predetermined number of resources for this
   *    step — let's say they clear the resources they already collected, and
   *    you give them enough resources to build 5 roads and 3 settlements, but
   *    they have no ore, so they can't build a city."
   *
   * `topUp` could never do that, because it only ever raises a pile to a floor:
   * a player who had swept a mountain arrived at the road lesson with ore in
   * the pack and the CITY card lit up gold beside the ROAD card they were being
   * told to press. The lesson is easier to write when it knows exactly what is
   * in the pack — the cards that are affordable are a fact of the step, not of
   * how much the player happened to collect on the way here.
   *
   * Anything not named is set to ZERO. That is the whole point: the empty piles
   * are as scripted as the full ones, and the card that must not be affordable
   * has to be un-affordable on purpose.
   */
  function give(pack) {
    for (const r of RES) me.res[r] = Math.max(0, (pack && pack[r]) | 0);
    if (g.hud && g.hud.pulseResource) {
      for (const r of RES) {
        if (pack && pack[r]) { try { g.hud.pulseResource(r); } catch (e) { /* silent */ } }
      }
    }
  }

  /** Top the pack up to `cost`. Returns true if anything was handed over. */
  function topUp(cost) {
    let gave = false;
    for (const r of RES) {
      const need = cost[r] || 0;
      if (!need) continue;
      if ((me.res[r] | 0) < need) { me.res[r] = need; gave = true; }
    }
    if (gave && g.hud && g.hud.pulseResource) {
      for (const r of RES) if (cost[r]) { try { g.hud.pulseResource(r); } catch (e) { /* silent */ } }
    }
    return gave;
  }

  /* ----------------------------------------------------------- geometry */

  function tileCentre(tid) {
    const t = tiles[tid];
    if (!t) return null;
    return { x: t.x, z: t.z };
  }

  function itemOnHome() {
    const it = nearestItem(me.x, me.z, { tile: homeTile });
    if (it) return { x: it.x, z: it.z };
    return tileCentre(homeTile);
  }

  function standingOn(tid) {
    const t = tileAt(me.x, me.z);
    return !!t && t.id === tid;
  }

  /* ------------------------------------------------- ANY hex, not THE hex
   *
   *   "Just show up if they haven't cleared a single whole hex yet. As soon as
   *    they do clear a single whole hex we'll move to the next step."
   *
   * The sweep and recovery steps used to be pinned to `homeTile`, the one hex
   * the run picked to teach on. That is fine while the player does as they are
   * told and wrong the moment they wander: somebody who stripped a different
   * hex of their own has learned exactly the thing the step teaches and was
   * still being asked to go and do it again somewhere else. These three read
   * the whole owned set instead.
   */

  /** Has the player stripped any hex they own bare? */
  function sweptAny() {
    for (const tid of workable()) {
      try { if (isTileExhausted(tid)) return true; } catch (e) { /* silent */ }
    }
    return false;
  }

  /** The owned hex with the fewest things left standing — the one to finish. */
  function sweepTile() {
    let best = -1, fewest = Infinity;
    for (const tid of workable()) {
      const left = tileItemsRemaining(tid);
      if (left > 0 && left < fewest) { fewest = left; best = tid; }
    }
    return best >= 0 ? best : homeTile;
  }

  /* ------------------------------------------------------- the map's own state
   *
   * Three readings the map-open steps need, all of them off surfaces the
   * overview already publishes, so the tutorial never reaches into it.
   */

  /* Where the board was standing when the current step came up. See `mapMoved`. */
  let panBase = null;

  function panPose() {
    const i = g.overview && g.overview.panInfo;
    if (!i) return null;
    return { z: i.zoom, x: i.pan ? i.pan[0] : 0, y: i.pan ? i.pan[1] : 0 };
  }

  /**
   * How far the player has pushed the board around since this step began, as a
   * single 0..n figure.
   *
   *   "Say zoom in and zoom out with your fingers or click and drag to navigate
   *    the map. After a few seconds of them doing that, have another step."
   *
   * Read as MOVING rather than as WAITING. A timer would move somebody on
   * mid-sentence and hold somebody who already knows how a map works, and it
   * cannot tell the difference between the two. Zoom and pan are added together
   * so either one satisfies it: the zoom term is a ratio (a 25% change is 0.25)
   * and the pan term is in board units against the island's own width, so both
   * are on roughly the same scale whatever the viewport is doing.
   */
  function mapMoved() {
    const now = panPose();
    if (!now) return 0;
    if (!panBase) { panBase = now; return 0; }
    const dz = Math.abs(Math.log(Math.max(0.001, now.z / panBase.z)));
    const dp = (Math.abs(now.x - panBase.x) + Math.abs(now.y - panBase.y)) / 220;
    return dz * 1.6 + dp;
  }

  /** Is a road target chosen but not yet confirmed — the first of the two taps? */
  function roadArmed() {
    const m = g.overview && g.overview.metrics;
    return !!(m && m.mode === 'place-road' && m.sel !== null && m.sel !== undefined);
  }

  /* ------------------------------------------------- a board worth reading
   *
   *   "I want for this step to just choose random numbers — so even if the
   *    longest road and largest army haven't been claimed, we're artificially
   *    adding in numbers so you see that you have a 3 road streak and the
   *    longest is at 5 right now, and you've played 3 knights and that's the
   *    biggest right now. That way you can explain those numbers in the
   *    tutorial."
   *
   * The awards card is a readout, and in a practice run there is nothing in it:
   * the rivals are frozen, the player has laid two roads, and both lines say
   * `0 › —`. Teaching somebody to read a gauge with the needle at zero is the
   * problem the note is naming.
   *
   * So the numbers go into `state` rather than into the sentence, and the card
   * the player is taught is the real card doing its real job — the rival's name
   * is coloured off the real seat, YOURS appears because the real rule fired,
   * and the two lines are in the two DIFFERENT states the card has: one you are
   * chasing, one you already hold.
   *
   * `refreshAwards` in hud.js recomputes from these fields every tenth of a
   * second and `recomputeAwards` in rules.js would overwrite them the moment
   * anything is built — which is fine and is why this is only up for three
   * steps and is taken back off at the closing card.
   */
  const FAKE = { road: 5, mine: 3, knights: 3, rival: 1 };
  let fakedAwards = false;

  function fakeAwards() {
    const rival = state.players[FAKE.rival];
    if (!rival) return;
    fakedAwards = true;
    me.longestRoadLen = FAKE.mine;
    rival.longestRoadLen = FAKE.road;
    state.longestRoadHolder = FAKE.rival;
    me.knightsPlayed = FAKE.knights;
    for (let i = 1; i < state.players.length; i++) state.players[i].knightsPlayed = 0;
    state.largestArmyHolder = 0;
  }

  /** Put it back, so nothing invented survives into a real match. */
  function clearFakeAwards() {
    if (!fakedAwards) return;
    fakedAwards = false;
    for (const p of state.players) { p.longestRoadLen = 0; p.knightsPlayed = 0; }
    state.longestRoadHolder = -1;
    state.largestArmyHolder = -1;
  }

  /** Is a placement target chosen but not yet confirmed, in ANY mode? */
  function placeArmed() {
    const m = g.overview && g.overview.metrics;
    return !!(m && /^place-/.test(String(m.mode || ''))
      && m.sel !== null && m.sel !== undefined);
  }

  /* ------------------------------------------------- reading the trade sheet
   *
   *   "Walk them through clicking the up arrow on wheat, and then the down
   *    arrow on wood."
   *
   * A step that says "tap the up arrow over WHEAT" has to know when they have.
   * The sheet already writes its own state onto the columns as classes —
   * `.tr-col.getting` for a pile being asked for and `.tr-col.giving` for one
   * being paid out of — and the count is in the column's own numeral, so this
   * reads the sheet exactly as the player does rather than reaching into
   * trade.js for a number it would then have to keep in step with.
   */
  function tradeCount(res, cls) {
    let n = null;
    try {
      n = document.querySelector(
        `.sheet.trade:not(.hid) .tr-col.${cls}[data-res="${res}"] .tr-now`);
    } catch (e) { n = null; }
    if (!n) return 0;
    const v = parseInt((n.textContent || '').replace(/[^0-9]/g, ''), 10);
    return Number.isFinite(v) ? v : 0;
  }
  const tradeGetting = res => tradeCount(res, 'getting');
  const tradeGiving = res => tradeCount(res, 'giving');

  /**
   * Load the deck for the three card lessons.
   *
   *   "I want the order of these to be specific: first is a victory point ...
   *    the second is the road building ... the knight card would be the third."
   *
   * See `state.forcedCards` in core/rules.js. Emptied on the way out so a match
   * started after the run is dealt from the real weight table.
   */
  function scriptDeck() {
    state.forcedCards = ['victoryPoint', 'roadBuilding', 'knight'];
  }
  function clearDeck() { state.forcedCards = null; }

  /** Every corner and edge the player already owns, as world points. */
  function myPieces() {
    const out = [];
    for (const iid of me.settlements) {
      const n = intersections[iid];
      if (n) out.push({ x: n.x, z: n.z, r: 78 });
    }
    for (const iid of me.cities) {
      const n = intersections[iid];
      if (n) out.push({ x: n.x, z: n.z, r: 86 });
    }
    return out;
  }

  /** The owned hex that is actually resting, so the clock has something over it. */
  function restTile() {
    for (const tid of workable()) {
      try { if (isTileExhausted(tid)) return tid; } catch (e) { /* silent */ }
    }
    return sweepTile();
  }

  /* ----------------------------------------------------------- the toolkit
     Everything ./tutsteps.js is allowed to reach. Deliberately small: the
     script says WHAT to teach, this file knows how anything is measured. */
  const kit = {
    state, me, game: g, base,
    homeTile: () => homeTile,
    workable,
    walked: () => walked,
    topUp, give, tileCentre, itemOnHome, standingOn,
    sweptAny, sweepTile, restTile,
    mapMoved, roadArmed, placeArmed, myPieces,
    tradeGetting, tradeGiving, scriptDeck,
    fakeAwards, clearFakeAwards,
    restart: () => restart()
  };

  /* ---------------------------------------------------------- the marker */

  /** Screen position and size of whatever the current step is pointing at. */
  function markerFor(step) {
    const sel = typeof step.dom === 'function' ? step.dom() : step.dom;
    if (sel && sel.length) {
      for (const s of sel) {
        let n = null;
        try { n = document.querySelector(s); } catch (e) { n = null; }
        if (!n) continue;
        const r = n.getBoundingClientRect();
        if (r.width < 3 || r.height < 3) continue;
        return {
          x: r.left + r.width / 2, y: r.top + r.height / 2,
          w: r.width, h: r.height
        };
      }
    }
    if (step.world) {
      const w = step.world();
      if (!w) return null;
      const s = projectGround(w.x, w.z, 2.6);
      if (!s) return null;
      const W = host.clientWidth || window.innerWidth;
      const H = host.clientHeight || window.innerHeight;
      if (s.x < -140 || s.y < -140 || s.x > W + 140 || s.y > H + 140) return null;
      // Keep the ring on screen even when the target is at the very edge of
      // the frame: a marker half off the display points at nothing.
      return {
        x: Math.max(52, Math.min(W - 52, s.x)),
        y: Math.max(56, Math.min(H - 96, s.y)),
        w: 86, h: 86
      };
    }
    return null;
  }

  /** A point on the ground, in CSS pixels, or null if it is behind the camera. */
  function projectGround(x, z, lift) {
    const cam = g.camera && g.camera.camera;
    const y = (g.world && g.world.heightAt) ? g.world.heightAt(x, z) + (lift || 0) : 3;
    const s = project(cam, x, y, z);
    if (!s) return null;
    const W = host.clientWidth || window.innerWidth;
    const H = host.clientHeight || window.innerHeight;
    return { x: s.x * W, y: s.y * H };
  }

  /* ------------------------------------------------------------- the wash
   *
   * One hole per workable hex, and — on the step that asks for it — one gold
   * dot in the middle of each. The radius is measured rather than guessed: a
   * second point one hex-width away is projected as well, so the hole is the
   * size the hex really is on screen at whatever the camera is doing.
   */
  /**
   * The rectangle of a live HUD element, in CSS pixels, or null.
   * Used by `spotDom` — the steps that darken the screen around a real control
   * rather than around a hex.
   */
  function domRect(sel) {
    let n = null;
    try { n = document.querySelector(sel); } catch (e) { n = null; }
    if (!n || !n.getBoundingClientRect) return null;
    const r = n.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return null;
    return {
      x: r.left + r.width / 2, y: r.top + r.height / 2,
      w: r.width + 16, h: r.height + 14, r: 18
    };
  }

  function spotShape(step) {
    if (!step) return null;
    if (!step.spot && !step.spotDom && !step.spotMe
      && !step.spotWorld && !step.spotWorldMany) return null;
    const holes = [], pips = [], rects = [];

    /* ------------------------------------------------- holes on the INTERFACE
     *
     *   "Instead highlight the exact element for my pack, and darken the rest of
     *    the screen to bring attention to the correct place."
     *
     * A gold ring round the pack was the old answer and the owner asked for it
     * to go: a ring is a pointer, and a pointer on a control the player has not
     * been told the name of is a riddle. Turning everything else down names it
     * outright. Re-read every frame rather than measured once, because the pill
     * fades in on its own transition and the three keys move with the safe-area
     * gutters when a phone is rotated. */
    const domSel = typeof step.spotDom === 'function' ? step.spotDom() : step.spotDom;
    if (domSel) for (const s of domSel) { const r = domRect(s); if (r) rects.push(r); }

    /*
     * A HOLE HAS TO BE SOMEWHERE THE PLAYER CAN LOOK.
     *
     * `projectGround` will happily return a coordinate a hundred pixels above
     * the top of the frame, and a wash whose only hole is off-screen is a
     * screen that has gone dark for no reason — which is exactly what step 6
     * did when the camera left the recovery clock over the top edge. The hex
     * wash rejects those outright (it has five other hexes to light), but a
     * step with ONE thing to point at cannot afford to drop it, so this pulls
     * it back inside instead: the hole keeps its size and slides until half of
     * it is in the frame. `markerFor` clamps the gold ring for the same reason
     * and with the same arithmetic.
     */
    const nudge = (s, r) => {
      const W = host.clientWidth || window.innerWidth;
      const H = host.clientHeight || window.innerHeight;
      return {
        x: Math.max(r * 0.5, Math.min(W - r * 0.5, s.x)),
        y: Math.max(r * 0.5, Math.min(H - r * 0.5, s.y))
      };
    };

    /* ...and the player, so a step that darkens the screen around a HUD cluster
       still lets them see the settler they are running. */
    if (step.spotMe) {
      const s = projectGround(me.x, me.z, 1.6);
      if (s) { const p = nudge(s, 92); holes.push({ x: p.x, y: p.y, r: 92 }); }
    }

    /* ...and any world point a step nominates. Step 6 uses this for the
       recovery clock, which is an instanced shader quad over the hex
       (world/regionmark.js) and therefore has no selector to point a DOM
       highlight at — the only way to light it is to project where it floats. */
    const wp = typeof step.spotWorld === 'function' ? step.spotWorld() : null;
    if (wp) {
      const s = projectGround(wp.x, wp.z, wp.lift === undefined ? 6.2 : wp.lift);
      const r = wp.r || 96;
      if (s) { const p = nudge(s, r); holes.push({ x: p.x, y: p.y, r }); }
    }

    /* ...and a LIST of world points, for the step that lights everything the
       player already owns: "it highlights the blue roads and settlements that
       already exist on the map, showing that those are yours — without a yellow
       circle, but instead just darkening the rest of the map slightly again."
       Not clamped, unlike the single-point case: these come in a handful and one
       of them being off the edge is a hole that is genuinely elsewhere, not a
       step with nothing to light. */
    const many = typeof step.spotWorldMany === 'function' ? step.spotWorldMany() : null;
    if (many) for (const q of many) {
      const s = projectGround(q.x, q.z, q.lift === undefined ? 1.2 : q.lift);
      if (s) holes.push({ x: s.x, y: s.y, r: q.r || 84 });
    }

    if (!step.spot) {
      return (holes.length || rects.length) ? { holes, pips, rects } : null;
    }
    for (const tid of workable()) {
      const t = tiles[tid];
      const c = projectGround(t.x, t.z, 0.4);
      if (!c) continue;
      const edge = projectGround(t.x + HEX_SIZE, t.z, 0.4);
      const r = Math.max(46, Math.min(320,
        edge ? Math.hypot(edge.x - c.x, edge.y - c.y) * 1.28 : 96));
      /*
       * ONLY WHAT IS ACTUALLY ON SCREEN.
       *
       *   "Actually point out clearly and minimally to all three, while
       *    increasing the darkness level of the other hexes you can't pick up
       *    from."
       *
       * "All three" means all three the player can SEE. This runs from a close
       * third-person camera, and on a 375px-tall phone most of a player's own
       * land is behind them or past the edge of the frame — `projectGround`
       * happily returns a coordinate for a hex a hundred pixels off the left of
       * the screen, and a hole punched there erases nothing while its gold dot
       * is drawn on a pixel nobody will ever look at.
       *
       * Worse, it lies to anything reading the shape back: the capture rig
       * clamps a sample to the canvas edge, reads the wash at full strength and
       * reports the hole as never cut. That is what sent this pass looking for a
       * compositing bug that was not there.
       *
       * So a hole has to have some of itself inside the frame to count. The
       * margin is the hole's own radius, because a hex whose centre is just off
       * the edge still washes and lights a real part of the screen.
       */
      const onScreen = c.x > -r && c.x < innerWidth + r
        && c.y > -r && c.y < innerHeight + r;
      if (!onScreen) continue;
      holes.push({ x: c.x, y: c.y, r });
      if (step.spot === 'pips') pips.push({ x: c.x, y: c.y });
    }
    return (holes.length || rects.length) ? { holes, pips, rects } : null;
  }

  /* -------------------------------------------------------- dressing the HUD */

  function applyHud(step) {
    const want = (step && step.hud) || {};
    /* The build cards are hidden for every step before the BUILD key has been
       explained as well as for step 11, so that walking BACK through the run
       shows the same screen the player saw on the way down. */
    const nobuild = !!want.nobuild || idx < 7;
    /*
     * `nokeys` takes the three circular keys away as well, and only one step
     * asks for it:
     *
     *   "On mobile just hide the build map and pause buttons for this step as
     *    well, so the instruction box can actually sit on the bottom without
     *    covering it."
     *
     * It is scoped to the compact viewports in tutorial.css, because on a
     * laptop there is room for both and taking a control away that the player
     * can see no reason for is worse than a card sitting a little higher.
     */
    const nokeys = !!want.nokeys;
    // ...and the phone-only variant, for the step that only needs the room. 
    const nokeysSm = !!want.nokeysPhone;
    /* The map's player rail stands down for the steps that put the coach card
       in its column — see the SIDE band in tutorial.css. Driven off `onMap`
       rather than a separate flag, because a step that asked for the column and
       forgot to hide the rail would stack the two on top of each other. */
    const norail = !!want.norail
      || !!(step && step.onMap && step.onMap !== 'centre');
    const root = document.getElementById('ui');
    if (root) {
      toggle(root, 'tut-pack', !!want.pack);
      toggle(root, 'tut-ranks', !!want.ranks);
      toggle(root, 'tut-awards', !!want.awards);
      toggle(root, 'tut-nobuild', nobuild);
      toggle(root, 'tut-nokeys', nokeys);
      toggle(root, 'tut-nokeys-sm', nokeysSm);
      toggle(root, 'tut-norail', norail);
      /* The trade sheet narrows so the coach can stand beside it rather than
         over it — "a pop-out from the right side that resizes the trade screen
         temporarily". Driven off `onSheet` for the same reason `norail` is
         driven off `onMap`: a step cannot ask for the column and forget. */
      toggle(root, 'tut-sidepanel', !!want.sidepanel || !!(step && step.onSheet));
    }
    // The badge is not inside `#ui`, so it is dressed separately. See `wear`.
    if (coach && coach.wear) {
      coach.wear({
        pack: !!want.pack, nobuild, nokeys, nokeysSm, noquit: !!want.noquit
      });
    }
  }

  function clearHud() {
    const root = document.getElementById('ui');
    if (!root) return;
    for (const c of HUD_FLAGS) toggle(root, c, false);
    toggle(root, 'tut-practice', false);
    if (coach && coach.wear) coach.wear({});
  }

  /** Shut the four build cards the way the BUILD key itself would. */
  function collapseBuild() {
    const row = document.querySelector('.build-row');
    if (row && !row.classList.contains('hid')) toggle(row, 'hid', true);
  }

  /* ------------------------------------------------------------ stepping */

  const textOf = step => (typeof step.text === 'function' ? step.text() : step.text);

  /** Which size and place the badge should be in RIGHT NOW, step and screen. */
  function chromeFor(step) {
    let size = phase === 'brief' ? 'big' : (step.size || 'big');
    let place = step.place || 'bottom';
    // Still inside the step's own quiet gap: nothing on screen but the game.
    if (quietT > 0) return { size: 'gone', place };
    /*
     * A FULL-SCREEN SHEET OR THE PLACEMENT MAP TAKES THE WHOLE DISPLAY, so the
     * badge stands down to nothing but its ring.
     *
     *   "just keep the highlight of what they're supposed to click so that it
     *    doesn't cover the map and just get confusing"
     *   "hide / have a much smaller out-of-the-way but clear circles/highlights
     *    to follow so that you successfully make a trade without the tutorial in
     *    the way"
     *
     * There is no corner to hide in on either of them and it would be dishonest
     * to pretend otherwise: the trade sheet is 612px wide on a 640px screen,
     * and the placement map has its own close key top-left, its own arm line
     * top-centre and its own four chips along the whole bottom. Both surfaces
     * already carry the words this step would be repeating — the map says TAP
     * AGAIN TO BUILD the instant an edge is armed — so what the run adds is the
     * ring and nothing else, and the badge comes back the moment the sheet does
     * not own the screen any more.
     */
    const sheetUp = !!(g.panels && g.panels.isOpen);
    const mapUp = !!(g.overview && g.overview.isOpen);

    /*
     * ...UNLESS THE STEP HAS SOMEWHERE TO STAND ON IT.
     *
     *   "You can hide the players column on the right of the screen and put the
     *    instructions box for this step over there."
     *
     * That is the missing third option, and it is the honest one for a lesson
     * that is ABOUT the map rather than merely interrupted by it. The board map
     * already reserves a 186px column down its right edge for the player rail
     * (`.ov-rail` in ui.css) and fits the board to whatever is left, so a card
     * standing there covers nothing: the rail goes, the card takes its slot, and
     * the board is exactly the size it always was.
     *
     * `onMap` is opt-in per step for the same reason GONE is still the default.
     * A step that happens to have the map open under it — the player pressed
     * the map key mid-lesson — has nothing to say about it and should still get
     * out of the way. Only the steps written for the map ask for the column.
     */
    if (mapUp && step.onMap === 'centre') return { size: 'big', place: 'centre' };
    if (mapUp && step.onMap) return { size: step.onMap === 'slim' ? 'slim' : 'big', place: 'side' };
    if (sheetUp && step.onSheet) return { size: step.onSheet === 'slim' ? 'slim' : 'big', place: 'side' };
    if (sheetUp || mapUp) size = 'gone';
    return { size, place };
  }

  const safeCheck = step => {
    if (!step || !step.check) return false;
    try { return !!step.check(); } catch (e) { return false; }
  };

  /**
   * `dir` is which way the player is travelling: 1 forward, -1 backward, 0 a
   * re-present of the step already on screen. It matters for `skipIf` only —
   * see below.
   */
  function present(dir) {
    const step = steps[idx];
    if (!step) return;
    /*
     * A STEP WITH NOTHING TO TEACH TODAY IS SKIPPED FORWARD, AND ONLY FORWARD.
     *
     * `skipIf` used to run whichever way the player was going, so Back onto a
     * step that had nothing to say bounced them forward to the step they had
     * just left — the same dead end the `armed` note above describes, by a
     * different road. Travelling backward, a step with nothing to teach is
     * still a step the player asked to look at.
     */
    if (phase === 'body' && step.skipIf && (dir === undefined || dir > 0)) {
      let skip = false;
      try { skip = !!step.skipIf(); } catch (e) { skip = false; }
      if (skip) { advance(1, true); return; }
    }
    snapshot();
    // A fresh baseline for `mapMoved`: "has the player moved the board SINCE
    // this step came up", not "since the map opened".
    panBase = panPose();
    if (phase === 'body' && step.enter) {
      try { step.enter(); } catch (e) { /* silent */ }
    }
    applyHud(step);

    const brief = phase === 'brief' && step.brief;
    // Only a check that is false RIGHT NOW may carry this step. See `armed`.
    armed = phase === 'body' && !!step.check && !safeCheck(step);

    /*
     * NEXT IS HELD ON A STEP THE PLAYER HAS NOT DONE YET — ONCE.
     *
     *   "Let me go backwards, but if this is my first time on this step during
     *    this visit to the tutorial, don't let me press next until I've pressed
     *    build."
     *
     * `satisfied` remembers the steps whose check has really come true this
     * run, so the hold is a first-visit thing and not a wall: once BUILD has
     * been pressed, walking back through the run and forward again is free. Back
     * is never held, on this or any other step.
     */
    heldNow = !!step.holdNext && phase === 'body' && !satisfied.has(step.id);
    quietT = (phase === 'body' && step.quiet > 0) ? step.quiet : 0;

    const c = chromeFor(step);
    coach.show({
      n: idx + 1,
      of: steps.length,
      title: brief ? step.brief.title : step.title,
      text: brief ? step.brief.text : textOf(step),
      /* The brief's key is always OK — it is dismissing an explanation, not
         completing a task — and the body's is the step's own verb, if it has
         one. A step that waits on the player has no green key at all, which is
         what makes NEXT read as the way past it. */
      action: brief ? 'OK' : (step.action || null),
      onAction: brief
        ? () => { phase = 'body'; present(); }
        : (step.onAction || (() => advance(1))),
      onBack: () => back(),
      onNext: () => advance(1, true),
      canBack: idx > 0 || phase === 'brief',
      canNext: idx < steps.length - 1 && !heldNow,
      size: c.size, place: c.place,
      veil: !!step.veil
    });
    coach.progress(idx / Math.max(1, steps.length - 1));
  }

  function snapshot() {
    base.gathered = me.stats.gathered;
    base.roads = me.roads.size;
    base.settlements = me.settlements.size;
    base.cities = me.cities.size;
    base.traded = me.stats.traded;
    base.cards = me.cards.length + (me.vpCards | 0);
    walked = 0;
    lastX = me.x; lastZ = me.z;
  }

  function advance(n, quiet) {
    if (!running) return;
    if (!quiet) coach.good();
    idx = Math.min(steps.length - 1, idx + (n || 1));
    phase = steps[idx] && steps[idx].brief ? 'brief' : 'body';
    present(1);
  }

  /**
   * BACKWARD.
   *
   *   "For the tutorial let me go forward or backward in the steps instead of
   *    just saying skip all of the time."
   *
   * From the task half of a step with an explanation, Back goes to the
   * explanation rather than skipping over it — that is the thing somebody
   * pressing Back on the build-a-road step is trying to re-read. From anywhere
   * else it is the previous step, opened at its explanation if it has one.
   */
  function back() {
    if (!running) return;
    if (phase === 'body' && steps[idx] && steps[idx].brief) {
      phase = 'brief'; present(-1); return;
    }
    if (idx === 0) { present(0); return; }
    idx -= 1;
    phase = steps[idx] && steps[idx].brief ? 'brief' : 'body';
    present(-1);
  }

  /* ---------------------------------------------------------------- loop */

  function tick() {
    if (!running) return;
    raf = requestAnimationFrame(tick);
    holdRivals();

    const now = (typeof performance !== 'undefined' && performance.now)
      ? performance.now() : Date.now();
    const dt = lastMs ? Math.min(0.1, (now - lastMs) / 1000) : 1 / 60;
    lastMs = now;

    const dx = me.x - lastX, dz = me.z - lastZ;
    walked += Math.hypot(dx, dz);
    lastX = me.x; lastZ = me.z;

    const step = steps[idx];
    if (!step) return;

    if (quietT > 0) quietT = Math.max(0, quietT - dt);

    // The screen can change under a step — a sheet opens, the map closes — so
    // the badge re-reads what it should be wearing every frame. `chrome` is a
    // no-op when nothing moved.
    const c = chromeFor(step);
    coach.chrome(c.size, c.place);
    coach.mark(markerFor(step));
    if (spot) spot.set(spotShape(step), dt);
    if (step.live && phase === 'body') coach.say(textOf(step));

    if (phase === 'body' && step.check) {
      const ok = safeCheck(step);
      if (ok) satisfied.add(step.id);
      /* `armed` is what stops an already-satisfied step from throwing the
         player forward the instant they press Back — see the note by its
         declaration. A held step re-presents once so NEXT lights up. */
      if (ok && armed) { advance(1); return; }
      /* A held step that has just been done stays where it is — the player
         asked for it — but NEXT has to come back to life, so re-present once. */
      if (ok && heldNow) { heldNow = false; present(0); }
    }
  }

  /* ------------------------------------------------------------- lifecycle */

  /**
   * Reload onto the tutorial's own island, unless we are already standing on
   * it. Returns true if the page is on its way out, in which case the caller
   * must not start anything.
   */
  function ensureBoard() {
    if (LAYOUT_SEED === TUTORIAL_SEED) return false;
    if (typeof location === 'undefined' || !location.assign) return false;
    try {
      const u = new URL(location.href);
      u.searchParams.set('board', String(TUTORIAL_SEED));
      u.searchParams.set('practice', '1');
      location.assign(u.toString());
      return true;
    } catch (e) { return false; }
  }

  function startPractice() {
    if (running) return;
    // The set board, and the reload it takes to get there. See `TUTORIAL_SEED`.
    if (ensureBoard()) return;
    running = true;

    /* THE INSTRUCTION IS SPENT THE MOMENT IT IS CARRIED OUT.
     *
     * `?practice=1` asked for this run and it has now been given one, so it
     * comes out of the address bar before anything else happens. Every exit in
     * this game is a `location.reload()`, and a parameter left sitting there is
     * an exit that walks straight back in — which is exactly what END PRACTICE
     * and LEAVE MATCH were doing. See `withoutPracticeParams`.
     *
     * `replaceState` rather than `pushState`: this is not a place the player
     * navigated to and the Back button must not be able to return to it. The
     * board is already dealt, so taking the seed off the URL changes nothing
     * about the island underneath — `LAYOUT_SEED` was read at module load and
     * is what `ensureBoard` keeps checking. */
    const clean = withoutPracticeParams();
    if (clean && typeof history !== 'undefined' && history.replaceState) {
      try { history.replaceState(null, '', clean); } catch (e) { /* cosmetic */ }
    }

    if (book && book.isOpen) book.close();
    if (deps.ui && deps.ui.hideIntro) { try { deps.ui.hideIntro(); } catch (e) { /* silent */ } }
    if (deps.ui && deps.ui.hideObjective) { try { deps.ui.hideObjective(); } catch (e) { /* silent */ } }
    if (typeof deps.setPractice === 'function') deps.setPractice(true);

    freezeRivals();
    if (state.phase === 'setup') completeDraft();
    homeTile = pickHomeTile();

    const uiRoot = document.getElementById('ui');
    if (uiRoot) toggle(uiRoot, 'tut-practice', true);
    collapseBuild();

    coach = coach || createCoach(host);
    coach.onQuit(() => restart());
    spot = spot || createSpotlight(host);

    steps = buildSteps(kit);
    idx = 0;
    phase = steps[0] && steps[0].brief ? 'brief' : 'body';
    lastMs = 0;
    present();
    if (!raf) raf = requestAnimationFrame(tick);
  }

  /** Leave the practice and start a real match: a fresh island, fresh rivals. */
  function restart() {
    quit();
    /* Belt to `replaceState`'s braces. That call is the fix and it runs on
       every start, but it is the one line standing between END PRACTICE and an
       inescapable loop, and it is allowed to fail — a sandboxed frame throws on
       `replaceState`. If the parameter is somehow still there, leave by
       navigating to the address without it rather than by reloading the one
       that has it. */
    const clean = withoutPracticeParams();
    if (clean && typeof location !== 'undefined' && location.assign) {
      location.assign(clean); return;
    }
    if (typeof g.restart === 'function') { g.restart(); return; }
    if (typeof location !== 'undefined' && location.reload) location.reload();
  }

  function quit() {
    if (!running) return;
    running = false;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (coach) coach.hide();
    if (spot) spot.clear();
    if (typeof deps.setPractice === 'function') deps.setPractice(false);
    // Leaving from the awards slides must not hand the player a match that
    // thinks a frozen bot has a five-road line.
    clearFakeAwards();
    clearDeck();
    clearHud();
    // Whatever the run shut, the player gets back: leaving must never hand
    // somebody a match with no build cards in it.
    const row = document.querySelector('.build-row');
    if (row) toggle(row, 'hid', false);
  }

  function destroy() {
    document.removeEventListener(TUTORIAL_EVENT, onAsk);
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    running = false;
    if (coach) coach.destroy();
    if (spot) spot.destroy();
    if (book) book.destroy();
  }

  return {
    openBook, startPractice, quit, destroy,
    /* True when this page was loaded BY the practice run — the reload in
       `ensureBoard`. matchflow.js's `begin()` reads it and hands the opening
       straight over instead of playing the title cinematic to somebody who has
       already chosen what they want to do. */
    get pending() { return practiceWanted() && !running; },
    get running() { return running; },
    get step() { return steps[idx] ? steps[idx].id : null; },
    get stepIndex() { return idx; },
    get stepCount() { return steps.length; },
    get phase() { return phase; },
    /** Test hooks. `forceStep` is what the old Skip key did. */
    forceStep() { if (running) advance(1, true); },
    next() { if (running) advance(1, true); },
    back() { back(); },
    goTo(n) {
      if (!running) return;
      idx = Math.max(0, Math.min(steps.length - 1, n | 0));
      phase = steps[idx] && steps[idx].brief ? 'brief' : 'body';
      present();
    },
    /** Capture-rig hook: where the wash is punching holes this instant. */
    spotAt() { return running && steps[idx] ? spotShape(steps[idx]) : null; },
    /** Dismiss the large explain phase the way the OK key does. */
    ok() {
      if (!running) return false;
      if (phase !== 'brief') return false;
      phase = 'body'; present(); return true;
    },
    get coach() { return coach; }
  };
}

export default createTutorial;
