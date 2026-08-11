/**
 * Island Settlers — the end of the match, before and after the scoreboard.
 *
 *   createEndgame(root, state, game, { onResults }) ->
 *     { banner(winnerId), setDock(on), destroy() }
 *
 * Two pieces, both deliberately kept out of panels.js so that file stays inside
 * its line budget:
 *
 *   1. `banner(wid)` — the end-game moment. A win/lose plate and a shower of
 *      paper over the *live* board: it never covers the middle of the screen and
 *      it takes no pointer events, so the player watches the island being won
 *      rather than a modal. matchflow.js fires it the instant the match freezes,
 *      several seconds before the results panel exists.
 *
 *   2. `setDock(on)` — the bar that appears once the player dismisses the
 *      results. Nothing traps them on the scoreboard: from here they can put it
 *      back, swap between the pulled-back board framing and the close
 *      third-person view, or start a fresh island. Every control is a real
 *      44px+ button and every one of them has a keyboard route too (panels.js
 *      owns Enter/Escape).
 *
 *      The dock is also what hands the island over, and the BOARD VIEW / CLOSE
 *      VIEW button now chooses between two genuinely different sets of hands.
 *      Walking is the default: the score comes down and you are standing on the
 *      island you just played, with the ordinary invisible joystick and the
 *      ordinary follow camera, free to run anywhere on it. Press BOARD VIEW and
 *      the settler is put down and `systems/freecam.js` is armed instead — drag,
 *      pinch, orbit and wheel over the whole island, which is the right verb
 *      when there is nobody to follow. Lowering the dock (a replay, or a
 *      restart) takes both away again.
 *
 * Owner: UI agent.
 */

import { el, button, setText, toggle } from './dom.js';
import { icon } from './icons.js';
import { createFreeCam } from '../systems/freecam.js';

/* Enough paper that it reads as a shower rather than as a few stray pixels on
   a bright island. Three shapes, staggered starts, each with its own sway.
   Up from 44 because the shower now runs three seconds longer (see `FALL_MS`):
   spreading the old count over the longer window turned it into a drizzle, and
   a celebration that thins out is worse than a short one. */
const CONFETTI = 72;

/*
 * THE SHOWER, AND HOW LONG IT LASTS.
 *
 *   "Then let the confetti flow an additional like 3 seconds as well."
 *
 * `FALL_MS` is the window new pieces keep STARTING in — each one picks its own
 * delay inside it — and `HOLD_MS` is when the plate and whatever paper is still
 * in the air are pulled. Both moved by three seconds together; move one without
 * the other and either the shower is cut off mid-fall or the last pieces never
 * get released. `HOLD_MS` is kept a quarter-second short of `WIN.reveal` in
 * matchflow.js (8.85s), so the frame is clear before the score lands on it.
 */
const FALL_MS = 4900;
const HOLD_MS = 8600;

export function createEndgame(root, state, game, hooks = {}) {
  /* ------------------------------------------------------------ the moment */

  const paper = el('div', { class: 'ew-paper' });
  for (let i = 0; i < CONFETTI; i++) {
    paper.appendChild(el('i', {
      class: 'p' + (i % 3),
      style: {
        '--x': (2 + (i * 61) % 96) + '%',
        // Staggered so the shower lasts the whole hold on the board (see WIN
        // in matchflow.js) rather than being over before the camera moves.
        '--d': ((i * 137) % FALL_MS) + 'ms',
        '--s': (0.7 + ((i * 53) % 60) / 100).toFixed(2),
        '--r': ((i * 71) % 360) + 'deg',
        '--sw': (((i * 43) % 66) - 33) + 'px',
        '--t': (3.2 + ((i * 31) % 160) / 100).toFixed(2) + 's'
      }
    }));
  }

  const bTitle = el('h2', { class: 'ew-title', text: 'Victory' });
  const bSub = el('p', { class: 'ew-sub', text: '' });
  const bPlate = el('div', { class: 'ew-plate' },
    el('span', { class: 'ew-ico', html: icon('trophy', 34) }),
    el('span', { class: 'ew-words' }, bTitle, bSub));

  const bWrap = el('div', { class: 'endwin hid' }, paper, bPlate);
  root.appendChild(bWrap);

  let hideT = null;

  /** The win/lose announcement, played over the board rather than across it. */
  function banner(winnerId) {
    const w = state.players[winnerId] || state.players[0];
    const iWon = w && w.id === 0;
    toggle(bWrap, 'lost', !iWon);
    setText(bTitle, iWon ? 'Victory' : `${w ? w.name : 'Rival'} Wins`);
    setText(bSub, iWon
      ? 'The island is yours — take a look at it'
      : 'Watch the island settle — the score follows');
    if (bWrap.style && w) {
      bWrap.style.setProperty('--wc', w.color.css);
      bWrap.style.setProperty('--wl', w.color.light);
    }
    toggle(bWrap, 'hid', false);
    bWrap.classList.remove('in');
    void bWrap.offsetWidth;
    bWrap.classList.add('in');
    if (hideT) clearTimeout(hideT);
    // Held until just short of the scoreboard (WIN.reveal, 8.85s) so the plate
    // and the last of the paper clear the frame a beat before the score lands.
    hideT = setTimeout(() => {
      bWrap.classList.remove('in');
      toggle(bWrap, 'hid', true);
    }, HOLD_MS);
  }

  /* -------------------------------------------------------------- the dock */

  /*
   * WHICH OF THE TWO REVIEWS YOU ARE IN — AND THE WALK IS THE DEFAULT NOW.
   *
   *   "When I'm reviewing the board after the game has ended, instead of having
   *    me use my finger to swipe up and down left and right, just let me use
   *    the normal invisible joystick and run around with my character."
   *
   * The free camera used to own BOTH framings, so the close view was a settler
   * standing still with a camera being dragged around behind them — the one
   * screen in the game where the controls the player had spent three minutes
   * learning stopped working. They are two different reviews and they want two
   * different sets of hands:
   *
   *   walking (default)  the ordinary third-person game. Drag anywhere to run,
   *                      arrow keys, the camera follows the settler. The free camera
   *                      is DISARMED, so nothing competes for the drag.
   *   board view         the whole island, pulled back, nobody to follow —
   *                      here dragging the view is the right verb, so the free
   *                      camera is armed and the settler is put down again.
   *
   * `board` is false on the way in: dismissing the score drops you onto the
   * island you just played, on foot.
   */
  let board = false;

  const viewLab = el('span', { class: 'sb-lab', text: 'Board View' });
  const viewIco = el('span', { class: 'sb-ico', html: icon('map', 20) });

  /* The bar's one line of teaching, and it changes with the mode — each names
     the gesture that does something in the mode you are actually in. */
  const hintKey = el('b', { class: 'tc-key', text: 'Drag' });
  const hintTxt = el('i', { text: 'to run' });

  /* The free camera. Built once, armed and disarmed with the dock — it adds no
     listeners of consequence while disarmed and never sees a key during play. */
  let freecam = null;
  function cameraDriver() {
    if (freecam) return freecam;
    try { freecam = createFreeCam(game, { root }); } catch (e) { freecam = null; }
    // Published so the capture rigs — and anything else that needs to know
    // whether the player owns the view — can find it without going through
    // panels.js, which does not otherwise know this object exists.
    if (freecam && game) game.freecam = freecam;
    return freecam;
  }

  function setView(next) {
    board = !!next;
    setText(viewLab, board ? 'Close View' : 'Board View');
    setText(hintTxt, board ? 'to look around' : 'to run');
    // Keep the flow's own idea of the framing in step — it is what the capture
    // rigs and the results panel read — then hand the island to whichever pair
    // of hands the mode wants.
    const flow = game && game.flow;
    let told = false;
    if (flow && typeof flow.setEndView === 'function') {
      try { flow.setEndView(board ? 'board' : 'close'); told = true; } catch (e) { /* below */ }
    }
    const cam = game && game.camera;
    if (!told && cam && typeof cam.setOverview === 'function') {
      try { cam.setOverview(board); } catch (e) { /* optional */ }
    }
    // Exactly one driver at a time. Walking arms the settler and stands the
    // free camera down; the board view does the reverse. Both are told in that
    // order, so there is never a frame with two things pushing the view.
    setWalk(!board);
    const fc = freecam;
    if (board) {
      const d = cameraDriver();
      if (d) { try { d.arm('board'); } catch (e) { /* optional */ } }
    } else if (fc) {
      try { fc.disarm(); } catch (e) { /* optional */ }
    }
  }

  /** Hand the stick back (or take it away). matchflow owns the actual lock. */
  function setWalk(on) {
    const flow = game && game.flow;
    if (flow && typeof flow.setRoam === 'function') {
      try { return flow.setRoam(!!on); } catch (e) { /* the walk is a nicety */ }
    }
    return false;
  }

  const dock = el('div', { class: 'endbar hid', 'data-ui': '' },
    el('span', { class: 'eb-tag', text: 'Match over' },),
    /* HOME, not PLAY AGAIN.
     *
     *   "Change everything that says Play Again to something like Home, since
     *    they go back to the homepage anyway if they want to play again."
     *
     * Which is exactly what it always did — `restart()` reloads the page and a
     * cold boot lands on the opening screen, so the button has been called one
     * thing and done another. Same route, honest label, and the icon follows. */
    button('gold', { on: { click: () => (game.leaveMatch || game.restart).call(game) } },
      el('span', { class: 'sb-ico', html: icon('home', 20) }),
      el('span', { class: 'sb-lab', text: 'Home' })),
    button('cream', { on: { click: () => hooks.onResults && hooks.onResults() } },
      el('span', { class: 'sb-ico', html: icon('trophy', 20) }),
      el('span', { class: 'sb-lab', text: 'Results' })),
    button('blue', { on: { click: () => setView(!board) } }, viewIco, viewLab),
    // Two short words: at 667px this sits in a 92px box and anything longer
    // breaks to three ragged lines beside a 46px button. It used to name the
    // Enter key — the score is one button to its left, and the thing worth a
    // line here is the gesture that changed.
    el('span', { class: 'eb-hint' }, hintKey, hintTxt));
  root.appendChild(dock);

  /* ------------------------------------------------ NOT a navigator scope
   *
   * The review bar is three buttons and it looks exactly like the screens
   * `ui/kbnav.js` was built for — and it must not be one, for two reasons that
   * both came out of trying it:
   *
   *   ARROWS ARE THE CAMERA HERE. Once the match is over the same keys walk the
   *   settler and swing the free camera (systems/freecam.js). A cursor stealing
   *   them would take away the island walk, which is the entire point of this
   *   bar existing.
   *
   *   ENTER ALREADY MEANS THE SCORE. `ui/panels.js` maps Enter to "bring the
   *   results back" for the whole of `phase === 'over'`, and the left-most
   *   button on this bar is HOME — which leaves the match. A cursor that parks
   *   itself there and then answers to Enter turns the score key into a quit
   *   key, which is the one keyboard mistake in this game that cannot be undone.
   *
   * So the bar keeps its pointer and its one documented key, and the hint on it
   * still names that key rather than a cursor.
   */

  /**
   * Show or hide the bar, and mark the interface root so the HUD stands down.
   *
   * Raising it is also the moment the island stops being a trophy and starts
   * being something to read:
   *
   *   "Also remove the color of all the tiles after I view the scoreboard, so
   *    that I can tell what the hexes' resources were."
   *
   * The score has been seen by definition — this bar only exists once the
   * results have been dismissed — so the winner's flood is told to drain off.
   * matchflow.js owns the fade; all we do is say when. Lowering the bar (a
   * replay) deliberately does NOT put the colour back.
   */
  function setDock(on) {
    toggle(dock, 'hid', !on);
    if (root && root.classList) toggle(root, 'endgame', !!on);
    if (on) {
      const flow = game && game.flow;
      if (flow && typeof flow.clearVictoryFlood === 'function') {
        try { flow.clearVictoryFlood(); } catch (e) { /* the flood is optional */ }
      }
      // Straight onto the island, on foot. setView does the whole handover:
      // the framing, the flow's idea of it, the stick and the free camera.
      setView(false);
      return;
    }
    setWalk(false);
    const fc = freecam;
    if (!fc) return;
    try { fc.disarm(); } catch (e) { /* the free camera is a nicety, never a dependency */ }
  }

  return {
    banner,
    setDock,
    get dockOpen() { return !dock.classList.contains('hid'); },
    /** Capture-rig hook — `game.panels.endFreeCam` reaches this. */
    get freeCam() { return freecam; },
    destroy() {
      if (hideT) clearTimeout(hideT);
      if (freecam) { try { freecam.destroy(); } catch (e) { /* ignore */ } freecam = null; }
      if (bWrap.parentNode) bWrap.parentNode.removeChild(bWrap);
      if (dock.parentNode) dock.parentNode.removeChild(dock);
    }
  };
}

export default createEndgame;
