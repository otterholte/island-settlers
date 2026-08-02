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
 *      The dock is also what hands the camera over. There is no settler to
 *      follow once the match is done, so raising it arms `systems/freecam.js`:
 *      from that moment the player can drag, pinch, orbit and walk the camera
 *      around the island they just played, in EITHER framing — the BOARD VIEW /
 *      CLOSE VIEW button now only chooses which preset the free camera starts
 *      from. Lowering the dock (a replay, or a restart) hands it straight back.
 *
 * Owner: UI agent.
 */

import { el, button, setText, toggle } from './dom.js';
import { icon } from './icons.js';
import { createFreeCam } from '../systems/freecam.js';

/* Enough paper that it reads as a shower rather than as a few stray pixels on
   a bright island. Three shapes, staggered starts, each with its own sway. */
const CONFETTI = 44;

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
        '--d': ((i * 137) % 1900) + 'ms',
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
    // Held until just short of the scoreboard (WIN.reveal, 6.0s) so the plate
    // and the last of the paper clear the frame a beat before the score lands.
    hideT = setTimeout(() => {
      bWrap.classList.remove('in');
      toggle(bWrap, 'hid', true);
    }, 5600);
  }

  /* -------------------------------------------------------------- the dock */

  let board = true;

  const viewLab = el('span', { class: 'sb-lab', text: 'Close View' });
  const viewIco = el('span', { class: 'sb-ico', html: icon('map', 20) });

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
    // Keep the flow's own idea of the framing in step — it is what the capture
    // rigs and the results panel read — then point the free camera at the
    // matching preset. The free pose wins inside camera.js, so this is a
    // "start from here", not a fight.
    const flow = game && game.flow;
    let told = false;
    if (flow && typeof flow.setEndView === 'function') {
      try { flow.setEndView(board ? 'board' : 'close'); told = true; } catch (e) { /* below */ }
    }
    const cam = game && game.camera;
    if (!told && cam && typeof cam.setOverview === 'function') {
      try { cam.setOverview(board); } catch (e) { /* optional */ }
    }
    const fc = cameraDriver();
    if (fc) { try { fc.setMode(board ? 'board' : 'close'); } catch (e) { /* optional */ } }
  }

  const dock = el('div', { class: 'endbar hid', 'data-ui': '' },
    el('span', { class: 'eb-tag', text: 'Match over' },),
    button('gold', { on: { click: () => game.restart && game.restart() } },
      el('span', { class: 'sb-ico', html: icon('restart', 20) }),
      el('span', { class: 'sb-lab', text: 'Play Again' })),
    button('cream', { on: { click: () => hooks.onResults && hooks.onResults() } },
      el('span', { class: 'sb-ico', html: icon('trophy', 20) }),
      el('span', { class: 'sb-lab', text: 'Results' })),
    button('blue', { on: { click: () => setView(!board) } }, viewIco, viewLab),
    // Two short words: at 667px this sits in a 92px box and anything longer
    // breaks to three ragged lines beside a 46px button.
    el('span', { class: 'eb-hint' },
      el('b', { class: 'tc-key', text: 'Enter' }),
      el('i', { text: 'for the score' })));
  root.appendChild(dock);

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
    if (on) { board = true; setText(viewLab, 'Close View'); }
    if (root && root.classList) toggle(root, 'endgame', !!on);
    if (on) {
      const flow = game && game.flow;
      if (flow && typeof flow.clearVictoryFlood === 'function') {
        try { flow.clearVictoryFlood(); } catch (e) { /* the flood is optional */ }
      }
    }
    const fc = cameraDriver();
    if (!fc) return;
    try {
      if (on) fc.arm('board');
      else fc.disarm();
    } catch (e) { /* the free camera is a nicety, never a dependency */ }
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
