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
 * Owner: UI agent.
 */

import { el, button, setText, toggle } from './dom.js';
import { icon } from './icons.js';

const CONFETTI = 26;

export function createEndgame(root, state, game, hooks = {}) {
  /* ------------------------------------------------------------ the moment */

  const paper = el('div', { class: 'ew-paper' });
  for (let i = 0; i < CONFETTI; i++) {
    paper.appendChild(el('i', {
      style: {
        '--x': (3 + (i * 97) % 94) + '%',
        '--d': ((i * 137) % 900) + 'ms',
        '--s': (0.7 + ((i * 53) % 60) / 100).toFixed(2),
        '--r': ((i * 71) % 360) + 'deg',
        '--t': (2.6 + ((i * 31) % 90) / 100).toFixed(2) + 's'
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
    hideT = setTimeout(() => {
      bWrap.classList.remove('in');
      toggle(bWrap, 'hid', true);
    }, 5200);
  }

  /* -------------------------------------------------------------- the dock */

  let board = true;

  const viewLab = el('span', { class: 'sb-lab', text: 'Close View' });
  const viewIco = el('span', { class: 'sb-ico', html: icon('map', 20) });

  function setView(next) {
    board = !!next;
    setText(viewLab, board ? 'Close View' : 'Board View');
    const flow = game && game.flow;
    if (flow && typeof flow.setEndView === 'function') {
      try { flow.setEndView(board ? 'board' : 'close'); return; } catch (e) { /* below */ }
    }
    const cam = game && game.camera;
    if (cam && typeof cam.setOverview === 'function') {
      try { cam.setOverview(board); } catch (e) { /* optional */ }
    }
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
    el('span', { class: 'eb-hint' },
      el('b', { class: 'tc-key', text: 'Enter' }),
      el('i', { text: 'brings the score back' })));
  root.appendChild(dock);

  /** Show or hide the bar, and mark the interface root so the HUD stands down. */
  function setDock(on) {
    toggle(dock, 'hid', !on);
    if (on) { board = true; setText(viewLab, 'Close View'); }
    if (root && root.classList) toggle(root, 'endgame', !!on);
  }

  return {
    banner,
    setDock,
    get dockOpen() { return !dock.classList.contains('hid'); },
    destroy() {
      if (hideT) clearTimeout(hideT);
      if (bWrap.parentNode) bWrap.parentNode.removeChild(bWrap);
      if (dock.parentNode) dock.parentNode.removeChild(dock);
    }
  };
}

export default createEndgame;
