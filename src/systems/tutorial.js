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
 *        has really done the thing. Every step also carries a Skip, so the run
 *        cannot dead-end — the player cannot fail.
 *
 * Nothing here reaches past a public entry point: placements go through
 * rules.js's setup functions, and progress is read off `state`. The one thing
 * it does grant is materials — at a build step the player's pack is topped up
 * to the real COST so the lesson is "how do I build", not "go and grind".
 * That is stated on the card rather than done behind their back.
 *
 * Owner: Tutorial (flow) agent.
 */

import {
  COST, TRADE_BASE, VICTORY_POINTS, RES, RES_LABEL, TILE_REGEN
} from '../core/constants.js';
import { tiles, intersections, MARKET, tileAt, DESERT } from '../board/layout.js';
import {
  legalSettlements, legalRoads, setupCurrentPlayer,
  setupPlaceSettlement, setupPlaceRoad, scoreOf,
  isTileExhausted, tileRecovery, tileItemsRemaining
} from '../core/rules.js';
import { nearestItem } from '../board/nodes.js';
import { toggle } from '../ui/dom.js';
import { createBook, createCoach } from '../ui/tutorial.js';
import { TUTORIAL_EVENT } from './flowIntro.js';

const NOOP = () => {};

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
  let running = false;
  let raf = 0;
  let idx = 0;
  let steps = [];
  let homeTile = -1;
  let walked = 0;
  let lastX = 0, lastZ = 0;
  const base = { gathered: 0, roads: 0, settlements: 0, traded: 0 };

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
   * The richest corner still legal, judged the way a good opening pick is:
   * total pips first, distinct resources second. The human gets it; the bots
   * get whatever is left, spread across the list so the board looks played-in.
   */
  function bestCorner(list) {
    let best = list[0], bestScore = -1;
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
      const score = pips * 2 + kinds.size * 3;
      if (score > bestScore) { bestScore = score; best = iid; }
    }
    return best;
  }

  /** Run the whole opening draft now, through rules.js's own setup path. */
  function completeDraft() {
    let guard = 0;
    while (state.phase === 'setup' && guard++ < 64) {
      const pid = setupCurrentPlayer(state);
      if (state.setupNeed === 'settlement') {
        const list = legalSettlements(state, pid, true);
        if (!list.length) break;
        const pick = pid === 0
          ? bestCorner(list)
          : list[Math.floor(list.length * (0.2 + pid * 0.22)) % list.length];
        setupPlaceSettlement(state, pid, pick);
      } else {
        const list = legalRoads(state, pid, true, state.setupAnchor);
        if (!list.length) break;
        setupPlaceRoad(state, pid, list[0]);
      }
    }
    // The Raider starts on the desert and, with the bots frozen, never moves.
    state.robberTile = DESERT.id;
    state.robberOwner = -1;
  }

  /** The fullest resource hex the player now owns — the one we teach on. */
  function pickHomeTile() {
    let best = -1, bestScore = -1;
    for (const iid of me.settlements) {
      const n = intersections[iid];
      if (!n) continue;
      for (const tid of n.tiles) {
        const t = tiles[tid];
        if (!t || !t.resource) continue;
        const score = (t.pips || 0) + tileItemsRemaining(tid) * 0.1;
        if (score > bestScore) { bestScore = score; best = tid; }
      }
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

  /* =================================================================== steps
     Each step is: what to say, where to point, and how we know it happened.
     `check` is polled on every animation frame; `action` turns the card's
     green button on for a step that is simply read rather than done. */

  function buildSteps() {
    const homeName = () => {
      const t = tiles[homeTile];
      return t && t.resource ? RES_LABEL[t.resource].toLowerCase() : 'your';
    };
    const regenOf = () => {
      const t = tiles[homeTile];
      return t ? (TILE_REGEN[t.pips] || TILE_REGEN[3]) : TILE_REGEN[3];
    };

    return [
      {
        id: 'hello',
        title: 'A slow run-through',
        text: 'I will ask for one thing at a time and wait for you. Nothing here can go wrong, and the other settlers are standing still.',
        action: 'Start'
      },
      {
        id: 'walk',
        title: 'Walk',
        text: 'Press and drag anywhere on the LEFT half of the screen. Your settler follows your thumb.',
        check: () => walked > 6
      },
      {
        id: 'home',
        title: 'Go to your own land',
        text: () => `The gold ring is on a hex you own — the ${homeName()}. Walk onto it.`,
        world: () => tileCentre(homeTile),
        wide: true,
        check: () => {
          const t = tileAt(me.x, me.z);
          return !!t && t.id === homeTile;
        }
      },
      {
        id: 'collect',
        title: 'Run things over',
        text: 'Everything growing here is yours. Just walk over it — no tapping, no waiting. Collect six things.',
        world: () => itemOnHome(),
        check: () => me.stats.gathered - base.gathered >= 6
      },
      {
        id: 'sweep',
        title: 'Clear the whole hex',
        text: () => `Keep running until nothing is left. ${tileItemsRemaining(homeTile)} still standing.`,
        world: () => itemOnHome(),
        check: () => isTileExhausted(homeTile),
        skipBy: 2
      },
      {
        id: 'rest',
        title: 'It comes back',
        text: () => {
          const rc = tileRecovery(homeTile, state.time || 0);
          return rc && rc.exhausted
            ? `The hex is bare and resting. Everything on it returns at once in ${Math.ceil(rc.secondsLeft)} seconds. Own several hexes and walk a loop around them.`
            : `A hex you have cleared rests for about ${regenOf()} seconds, then everything on it returns at once. Own several hexes and walk a loop around them.`;
        },
        live: true,
        world: () => tileCentre(homeTile),
        wide: true,
        action: 'Got it'
      },
      {
        id: 'bag',
        title: 'Your pack',
        text: 'Up at the top is everything you are carrying: wood, brick, wool, wheat and ore. That is what you spend.',
        dom: ['.resbar'],
        action: 'Got it'
      },
      {
        id: 'road',
        title: 'Build a road',
        text: 'I have topped your pack up. Tap BUILD, choose ROAD, then pick one of the glowing lines on the map.',
        enter: () => topUp(COST.road),
        dom: ['.bcard[data-kind="road"]', '.hud-bc'],
        check: () => me.roads.size > base.roads
      },
      {
        id: 'reach',
        title: 'One more road',
        text: 'Your network has to reach a free corner before you can settle it. Build one more road, further out.',
        enter: () => topUp(COST.road),
        skipIf: () => legalSettlements(state, 0).length > 0,
        dom: ['.bcard[data-kind="road"]', '.hud-bc'],
        check: () => legalSettlements(state, 0).length > 0
      },
      {
        id: 'settle',
        title: 'Build a settlement',
        text: 'Topped up again. Tap BUILD, choose SETTLEMENT, then pick a glowing corner. It is worth 1 point — and it opens the hexes it touches for collecting.',
        enter: () => topUp(COST.settlement),
        dom: ['.bcard[data-kind="settlement"]', '.hud-bc'],
        check: () => me.settlements.size > base.settlements
      },
      {
        id: 'points',
        title: 'That is a point',
        text: () => `You are on ${scoreOf(state, me)} points. A city is worth 2, and the first settler to ${VICTORY_POINTS} takes the island.`,
        live: true,
        dom: ['.idcard'],
        action: 'Got it'
      },
      {
        id: 'market',
        title: 'Trade at the market',
        text: () => (me.nearTrade
          ? `You are at the market. Tap the offer, give ${TRADE_BASE} of something you have plenty of, and take the one you need.`
          : `Walk to the Great Market in the middle of the island. It swaps ${TRADE_BASE} of anything for 1 of what you need.`),
        live: true,
        enter: () => { me.res.wood = Math.max(me.res.wood | 0, TRADE_BASE + 1); },
        dom: ['.tradecue:not(.hid) .tc-card'],
        world: () => ({ x: MARKET.x, z: MARKET.z }),
        wide: true,
        check: () => me.stats.traded > base.traded
      },
      {
        id: 'done',
        title: 'That is the whole game',
        text: 'Collect on land you own, build roads to reach more of it, turn corners into settlements and cities, and trade for whatever you are short of. Go and win one.',
        action: 'Play a Real Match',
        onAction: () => restart()
      }
    ];
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

  /* ---------------------------------------------------------- the marker */

  function markerFor(step) {
    if (step.dom) {
      for (const sel of step.dom) {
        let n = null;
        try { n = document.querySelector(sel); } catch (e) { n = null; }
        if (!n) continue;
        const r = n.getBoundingClientRect();
        if (r.width < 3 || r.height < 3) continue;
        return {
          x: r.left + r.width / 2, y: r.top + r.height / 2,
          wide: r.width > 110 || r.height > 90
        };
      }
    }
    if (step.world) {
      const w = step.world();
      if (!w) return null;
      const cam = g.camera && g.camera.camera;
      const y = (g.world && g.world.heightAt) ? g.world.heightAt(w.x, w.z) + 2.6 : 3;
      const s = project(cam, w.x, y, w.z);
      if (!s) return null;
      const W = host.clientWidth || window.innerWidth;
      const H = host.clientHeight || window.innerHeight;
      let px = s.x * W, py = s.y * H;
      if (px < -140 || py < -140 || px > W + 140 || py > H + 140) return null;
      // Keep the ring on screen even when the target is at the very edge of
      // the frame: a marker half off the display points at nothing.
      px = Math.max(44, Math.min(W - 44, px));
      py = Math.max(48, Math.min(H - 92, py));
      return { x: px, y: py, wide: !!step.wide };
    }
    return null;
  }

  /* ------------------------------------------------------------ stepping */

  function textOf(step) {
    return typeof step.text === 'function' ? step.text() : step.text;
  }

  function present() {
    const step = steps[idx];
    if (!step) return;
    if (step.skipIf && step.skipIf()) { advance(1, true); return; }
    snapshot();
    if (step.enter) { try { step.enter(); } catch (e) { /* silent */ } }
    coach.show({
      n: idx + 1,
      title: step.title,
      text: textOf(step),
      action: step.action || null,
      onAction: step.onAction || (() => advance(1)),
      // A step that is simply read already has its own button; only a step
      // that waits on the player needs a way past it.
      onSkip: (step.action || step.id === 'done')
        ? null : (() => advance(step.skipBy || 1, true))
    });
    coach.progress(idx / Math.max(1, steps.length - 1));
  }

  function snapshot() {
    base.gathered = me.stats.gathered;
    base.roads = me.roads.size;
    base.settlements = me.settlements.size;
    base.traded = me.stats.traded;
    walked = 0;
    lastX = me.x; lastZ = me.z;
  }

  function advance(n, quiet) {
    if (!running) return;
    if (!quiet) coach.good();
    idx = Math.min(steps.length - 1, idx + (n || 1));
    present();
  }

  /* ---------------------------------------------------------------- loop */

  function tick() {
    if (!running) return;
    raf = requestAnimationFrame(tick);
    holdRivals();

    const dx = me.x - lastX, dz = me.z - lastZ;
    walked += Math.hypot(dx, dz);
    lastX = me.x; lastZ = me.z;

    const step = steps[idx];
    if (!step) return;
    coach.mark(markerFor(step));
    if (step.live) coach.say(textOf(step));
    if (step.check) {
      let ok = false;
      try { ok = !!step.check(); } catch (e) { ok = false; }
      if (ok) advance(1);
    }
  }

  /* ------------------------------------------------------------- lifecycle */

  function startPractice() {
    if (running) return;
    running = true;

    if (book && book.isOpen) book.close();
    if (deps.ui && deps.ui.hideIntro) { try { deps.ui.hideIntro(); } catch (e) { /* silent */ } }
    if (deps.ui && deps.ui.hideObjective) { try { deps.ui.hideObjective(); } catch (e) { /* silent */ } }
    if (typeof deps.setPractice === 'function') deps.setPractice(true);

    freezeRivals();
    if (state.phase === 'setup') completeDraft();
    homeTile = pickHomeTile();

    const uiRoot = document.getElementById('ui');
    if (uiRoot) toggle(uiRoot, 'tut-practice', true);

    coach = coach || createCoach(host);
    coach.onQuit(() => restart());

    steps = buildSteps();
    idx = 0;
    present();
    if (!raf) raf = requestAnimationFrame(tick);
  }

  /** Leave the practice and start a real match: a fresh island, fresh rivals. */
  function restart() {
    quit();
    if (typeof g.restart === 'function') { g.restart(); return; }
    if (typeof location !== 'undefined' && location.reload) location.reload();
  }

  function quit() {
    if (!running) return;
    running = false;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (coach) coach.hide();
    if (typeof deps.setPractice === 'function') deps.setPractice(false);
    const uiRoot = document.getElementById('ui');
    if (uiRoot) toggle(uiRoot, 'tut-practice', false);
  }

  function destroy() {
    document.removeEventListener(TUTORIAL_EVENT, onAsk);
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    running = false;
    if (coach) coach.destroy();
    if (book) book.destroy();
  }

  return {
    openBook, startPractice, quit, destroy,
    get running() { return running; },
    get step() { return steps[idx] ? steps[idx].id : null; },
    get stepIndex() { return idx; },
    get stepCount() { return steps.length; },
    /** Test hook: complete the current step the way the Skip button would. */
    forceStep() { if (running) advance(steps[idx] && steps[idx].skipBy || 1, true); }
  };
}

export default createTutorial;
