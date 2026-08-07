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
import { tiles, intersections, tileAt, DESERT } from '../board/layout.js';
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

/** Every class this module may put on `#ui`. Listed once so it can be undone. */
const HUD_FLAGS = ['tut-pack', 'tut-ranks', 'tut-awards', 'tut-nobuild'];

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

  /* ----------------------------------------------------------- the toolkit
     Everything ./tutsteps.js is allowed to reach. Deliberately small: the
     script says WHAT to teach, this file knows how anything is measured. */
  const kit = {
    state, me, game: g, base,
    homeTile: () => homeTile,
    workable,
    walked: () => walked,
    topUp, tileCentre, itemOnHome, standingOn,
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
  function spotShape(step) {
    if (!step || !step.spot) return null;
    const holes = [], pips = [];
    for (const tid of workable()) {
      const t = tiles[tid];
      const c = projectGround(t.x, t.z, 0.4);
      if (!c) continue;
      const edge = projectGround(t.x + HEX_SIZE, t.z, 0.4);
      const r = edge ? Math.hypot(edge.x - c.x, edge.y - c.y) * 1.28 : 96;
      holes.push({ x: c.x, y: c.y, r: Math.max(46, Math.min(320, r)) });
      if (step.spot === 'pips') pips.push({ x: c.x, y: c.y });
    }
    return holes.length ? { holes, pips } : null;
  }

  /* -------------------------------------------------------- dressing the HUD */

  function applyHud(step) {
    const root = document.getElementById('ui');
    if (!root) return;
    const want = (step && step.hud) || {};
    toggle(root, 'tut-pack', !!want.pack);
    toggle(root, 'tut-ranks', !!want.ranks);
    toggle(root, 'tut-awards', !!want.awards);
    /* The build cards are hidden for every step before the BUILD key has been
       explained as well as for step 11, so that walking BACK through the run
       shows the same screen the player saw on the way down. */
    toggle(root, 'tut-nobuild', !!want.nobuild || idx < 7);
  }

  function clearHud() {
    const root = document.getElementById('ui');
    if (!root) return;
    for (const c of HUD_FLAGS) toggle(root, c, false);
    toggle(root, 'tut-practice', false);
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
    if (sheetUp || mapUp) size = 'gone';
    return { size, place };
  }

  function present() {
    const step = steps[idx];
    if (!step) return;
    if (phase === 'body' && step.skipIf) {
      let skip = false;
      try { skip = !!step.skipIf(); } catch (e) { skip = false; }
      if (skip) { advance(1, true); return; }
    }
    snapshot();
    if (phase === 'body' && step.enter) {
      try { step.enter(); } catch (e) { /* silent */ }
    }
    applyHud(step);

    const brief = phase === 'brief' && step.brief;
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
      canNext: idx < steps.length - 1,
      size: c.size, place: c.place
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
    present();
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
      phase = 'brief'; present(); return;
    }
    if (idx === 0) { present(); return; }
    idx -= 1;
    phase = steps[idx] && steps[idx].brief ? 'brief' : 'body';
    present();
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

    // The screen can change under a step — a sheet opens, the map closes — so
    // the badge re-reads what it should be wearing every frame. `chrome` is a
    // no-op when nothing moved.
    const c = chromeFor(step);
    coach.chrome(c.size, c.place);
    coach.mark(markerFor(step));
    if (spot) spot.set(spotShape(step), dt);
    if (step.live && phase === 'body') coach.say(textOf(step));

    if (phase === 'body' && step.check) {
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
