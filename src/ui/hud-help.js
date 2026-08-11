/**
 * Island Settlers — HOW TO PLAY, as a paused sheet in the middle of the screen.
 *
 *   createHelp(root, state, game) ->
 *     { open(), close(), toggle(), get isOpen, update(), destroy() }
 *
 * =============================================================================
 * WHY IT IS NOT A DROP-DOWN ANY MORE
 * =============================================================================
 *
 *   "Can you please make the How to Play button within the settings dropdown
 *    within the game itself, as actually instead, it should be a larger popup
 *    in the middle of the screen, where the game technically pauses in the
 *    background (but without the map showing up), and the same text that's
 *    currently in the How to Play button is in this new popup, but it's split
 *    into a handful of easy to navigate back and forth slides. And it's obvious
 *    how to escape the instructions, and also obvious that the game is paused
 *    in the background."
 *
 * What it replaced was eleven paragraphs unfolded inside a 250px settings sheet
 * that already had to scroll to reach LEAVE MATCH on a 444px-tall phone. Every
 * word of the rules was in there and none of it was readable: a player looking
 * something up mid-match had to keep the settler alive with one thumb while
 * scrolling a column of body text with the other.
 *
 * So the same words come out of the drawer and go into the middle of the
 * screen, six or seven at a time, with:
 *
 *   THE MATCH ACTUALLY STOPPED. Not "the bots politely wait" — the frame loop
 *     skips its whole fixed step while this is up. `main.js` reads
 *     `hud.helpOpen`; see the note by `mapPaused` there. It is the same freeze
 *     the board map does, WITHOUT the board map, which is the point: the
 *     player asked for the rules, not for the island.
 *   A PAUSED BADGE, on the sheet, saying so in as many words.
 *   TWO WAYS OUT that are both visible without scrolling: the cross in the
 *     corner and CLOSE on the nav row. Escape and the gear work too.
 *   SLIDES, not a scroll. `ui-base.css` suppresses scrollbars game-wide, so a
 *     column of text longer than the sheet is a design bug rather than a
 *     scroll region — the same reasoning the tutorial book is built on.
 *
 * Online, nothing can be paused (the server does not stop for one player), so
 * the badge says so instead of lying.
 *
 * =============================================================================
 * THE KEYBOARD SLIDE
 * =============================================================================
 *
 *   "Maybe add an additional slide in the tutorial written instructions for the
 *    keyboard shortcuts. Only add that slide for if the screen is larger than
 *    an iPad."
 *
 * `showKeysSlide()` is that test, and it is deliberately two tests: a screen
 * bigger than a 1024-point iPad in landscape AND a device that is not a
 * handheld. A phone held sideways in a browser that reports a huge CSS pixel
 * count would otherwise be told about a keyboard it does not have.
 *
 * Owner: UI agent.
 */

import {
  COST, VICTORY_POINTS, TILE_ITEMS, TILE_REGEN,
  TRADE_BASE, PORT_GENERIC, PORT_SPECIAL,
  LONGEST_ROAD_MIN, LONGEST_ROAD_VP, LARGEST_ARMY_MIN, LARGEST_ARMY_VP,
  NUMBER_MIN, NUMBER_MAX
} from '../core/constants.js';
import { knightsOn } from '../core/options.js';
import { el, button, clear, toggle, setText } from './dom.js';
import { icon } from './icons.js';
import { keyNav } from './kbnav.js';

/**
 * Bigger than an iPad, and holding a keyboard.
 *
 *   "Only add that slide for if the screen is larger than an iPad."
 *
 * Two tests, because the size on its own is not the question being asked. An
 * iPad in landscape is 1024 points across, so "larger than an iPad" is a long
 * edge over 1024 — but the 12.9-inch iPad Pro is 1366 across and still has no
 * keyboard, and a page of keyboard shortcuts on a tablet is a page of
 * instructions for hardware the reader does not own. So a COARSE pointer with
 * no fine one available disqualifies a screen however big it is.
 *
 * `handheld()` from dom.js is deliberately NOT used: it treats `hover: none` on
 * its own as handheld, which is true of a good many desktop browsers (and of
 * headless Chrome, which is how this was found), and it caps at 1400 so a
 * desktop monitor answers false for the opposite reason.
 */
export function showKeysSlide(win) {
  const w = win || (typeof window !== 'undefined' ? window : null);
  if (!w) return false;
  const long = Math.max(w.innerWidth || 0, w.innerHeight || 0);
  const short = Math.min(w.innerWidth || 0, w.innerHeight || 0);
  if (long <= 1024 || short < 380) return false;
  const mm = typeof w.matchMedia === 'function' ? q => w.matchMedia(q).matches : null;
  if (mm && mm('(pointer: coarse)') && !mm('(any-pointer: fine)')) return false;
  return true;
}

/* ------------------------------------------------------------------ slides */

/**
 * A handful of slides, one subject each, in the order somebody stuck mid-match
 * would want them. Every number is read out of `core/constants.js` when the
 * sheet is built, so the rules card can never quietly drift from the game.
 */
function buildSlides() {
  const knights = knightsOn();
  const cost = c => Object.keys(c).map(r => `${c[r]} ${r}`).join(' · ');

  const slides = [
    {
      title: 'Moving & Collecting',
      icon: 'log',
      rows: [
        ['Move', 'Drag anywhere on the screen to run — no need to find anything, the stick appears under your thumb. On a keyboard, the four arrow keys walk.'],
        ['Gather', 'Run straight over a tree, a sheep, a clay pile — it is yours the moment you touch it. No holding, no waiting.'],
        ['Your land', 'You may only pick things up on a hex where you own a settlement or a city. Everywhere else you run through and collect nothing.']
      ]
    },
    {
      title: 'The Numbers',
      icon: 'trophy',
      rows: [
        ['One to ten', `Every hex wears a wooden disc numbered ${NUMBER_MIN} to ${NUMBER_MAX}. Nothing is ever rolled — the number is simply a rank. ${NUMBER_MAX} is the richest hex on the island and ${NUMBER_MIN} is the poorest.`],
        ['How much', `A ${NUMBER_MAX} carries ${TILE_ITEMS[5]} things to pick up. A ${NUMBER_MIN} carries ${TILE_ITEMS[1]}.`],
        ['How fast', `Sweep a hex clean and it rests, then everything comes back at once — ${TILE_REGEN[5]} seconds on a ${NUMBER_MAX}, ${TILE_REGEN[1]} on a ${NUMBER_MIN}. The two best hexes wear a red numeral and never touch each other.`],
        ['Regions', 'The bars under the resource pill show what is still standing across the island, and the clock over a bare hex says when it is back.']
      ]
    },
    {
      title: 'Building',
      icon: 'house',
      rows: [
        ['Build', 'Each card fills as you gather. When it glows gold you can afford it — press it, then pick a glowing spot on the map and press it again.'],
        ['Room to build', 'Every settlement needs two roads of clear space between it and any other settlement on the island — yours and your rivals alike.'],
        ['Prices', `Road ${cost(COST.road)} · Settlement ${cost(COST.settlement)} · City ${cost(COST.city)} · Card ${cost(COST.card)}.`],
        ['Score', `Settlement 1 point, city 2, victory card 1. First to ${VICTORY_POINTS} wins.`]
      ]
    },
    {
      title: 'Trading',
      icon: 'swap',
      rows: [
        ['The Trading Post', `The hex in the middle of the island swaps ${TRADE_BASE} of anything for 1 of what you need.`],
        ['Your docks', `A dock you own does better: ${PORT_GENERIC} for 1, or ${PORT_SPECIAL} for 1 on the goods that dock deals in. You own a dock by settling one of its two corners.`],
        ['How', 'Press the arrows to stage what you want, press a card in the middle to pay for it in one go, then press TRADE.']
      ]
    },
    {
      title: 'Cards & Awards',
      icon: 'cards',
      rows: knights
        ? [
          ['Cards', 'A Knight opens the whole board so you can pick the region it shuts down. Road Building opens the map and lays two roads for nothing. A Victory Point scores the moment you draw it.'],
          ['The Knight', 'Send it to a hex and everyone with a settlement or city THERE loses half of every resource they hold, rounded down and gone rather than stolen. Nobody else pays, and nor do you. The hex then gives nothing to anybody but you.'],
          ['Awards', `Longest Road goes to ${LONGEST_ROAD_MIN}+ segments in one unbroken line and is worth ${LONGEST_ROAD_VP} points. Largest Army goes to ${LARGEST_ARMY_MIN}+ knights played and is worth ${LARGEST_ARMY_VP}. Both can be taken off you.`]
        ]
        : [
          ['Cards', 'Road Building opens the map and lays two roads for nothing. A Victory Point scores the moment you draw it.'],
          ['No Knights', 'Knights were switched off before the draft, so there are no Knight cards, nothing ever blocks a region, and Largest Army is out of play for everyone.'],
          ['Awards', `Longest Road goes to ${LONGEST_ROAD_MIN}+ segments in one unbroken line and is worth ${LONGEST_ROAD_VP} points. It can be taken off you the moment somebody beats it.`]
        ]
    }
  ];

  if (showKeysSlide()) {
    slides.push({
      title: 'Keyboard Shortcuts',
      icon: 'help',
      keys: [
        ['Arrows', 'Walk'],
        ['Space', 'Pause and resume'],
        ['B', 'Show or hide the build cards'],
        ['R', 'Build a road'],
        ['S', 'Build a settlement'],
        ['C', 'Upgrade to a city'],
        ['D', 'Buy a development card'],
        ['T', 'Open the Trading Post'],
        ['M', 'Open your dock — or pick one on the map'],
        ['Tab', 'Board map · in the map, cycle what you are building'],
        ['Arrows', 'In any map or menu, move between choices'],
        ['Enter', 'Take the highlighted choice'],
        ['Esc', 'Back out — clears a trade, closes a sheet, opens settings']
      ]
    });
  }

  return slides;
}

/* ======================================================================= UI */

export function createHelp(root, state, game) {
  if (!root || !root.appendChild || typeof document === 'undefined') {
    const noop = () => {};
    return {
      open: noop, close: noop, toggle: noop, update: noop, destroy: noop,
      get isOpen() { return false; }, get node() { return null; }
    };
  }

  let slides = buildSlides();
  let page = 0;
  let openFlag = false;

  const online = () => !!(game && game.net && game.net.active);

  /* ---------------------------------------------------------------- chrome */
  const iconEl_ = el('span', { class: 'hh-ico', html: icon('help', 22) });
  const titleEl = el('b', { class: 'hh-title', text: 'How to Play' });
  const countEl = el('span', { class: 'hh-count', text: '' });
  const pausedEl = el('span', { class: 'hh-paused' },
    el('i'), el('u', { text: 'Paused' }));

  const closeBtn = button('cream hh-x', {
    'aria-label': 'Close the rules and resume',
    on: { click: () => close() }
  }, el('span', { class: 'ico', html: icon('close', 20) }));

  const head = el('div', { class: 'hh-head' },
    iconEl_, titleEl, countEl, pausedEl, closeBtn);

  const bodyEl = el('div', { class: 'hh-body' });

  const dots = el('div', { class: 'hh-dots' });
  let dotEls = [];

  const backBtn = button('cream hh-nav', {
    'aria-label': 'Previous page', on: { click: () => step(-1) }
  }, el('span', { class: 'sb-lab', text: 'Back' }));

  const nextBtn = button('gold hh-nav', {
    'aria-label': 'Next page', on: { click: () => step(1) }
  }, el('span', { class: 'sb-lab', text: 'Next' }));

  /* THE SECOND WAY OUT, and the one a player who has read to the end will use.
     "It's obvious how to escape the instructions" is not served by a 40px
     cross in a corner on its own. */
  const doneBtn = button('green hh-done', {
    'aria-label': 'Close the rules and resume the match',
    on: { click: () => close() }
  }, el('span', { class: 'sb-lab', text: 'Close' }));

  const nav = el('div', { class: 'hh-nav-row' }, backBtn, dots, nextBtn, doneBtn);

  const sheet = el('div', { class: 'hh-sheet plate lift' }, head, bodyEl, nav);
  const layer = el('div', { class: 'hh hid', 'data-ui': '', role: 'dialog',
    'aria-label': 'How to play' },
    el('div', { class: 'hh-scrim', on: { click: () => close() } }), sheet);
  root.appendChild(layer);

  /* ----------------------------------------------------------------- paint */

  function buildDots() {
    clear(dots);
    dotEls = slides.map(() => el('i'));
    dotEls.forEach(d => dots.appendChild(d));
  }

  function row(k, v) {
    return el('p', { class: 'hh-row' },
      el('b', { text: k }), el('span', { text: v }));
  }

  function keyRow(k, v) {
    return el('p', { class: 'hh-key' },
      el('kbd', { text: k }), el('span', { text: v }));
  }

  function paint() {
    const s = slides[page];
    iconEl_.innerHTML = icon(s.icon || 'help', 22);
    setText(titleEl, s.title);
    setText(countEl, `${page + 1} / ${slides.length}`);
    dotEls.forEach((d, i) => toggle(d, 'on', i === page));
    clear(bodyEl);
    toggle(bodyEl, 'keys', !!s.keys);
    if (s.keys) for (const [k, v] of s.keys) bodyEl.appendChild(keyRow(k, v));
    else for (const [k, v] of s.rows) bodyEl.appendChild(row(k, v));
    toggle(backBtn, 'off', page === 0);
    toggle(nextBtn, 'off', page === slides.length - 1);
    setText(pausedEl.querySelector('u'),
      online() ? 'Match still running' : 'Paused');
    toggle(pausedEl, 'live', online());
  }

  function step(d) {
    const next = Math.max(0, Math.min(slides.length - 1, page + d));
    if (next === page) return;
    page = next;
    paint();
  }

  /* ------------------------------------------------------------ open/close */

  function open() {
    if (openFlag) return;
    // Rebuilt on every open: the Knights option and the window size can both
    // have changed since the last time somebody looked.
    slides = buildSlides();
    if (page >= slides.length) page = 0;
    buildDots();
    openFlag = true;
    paint();
    toggle(layer, 'hid', false);
    // A reflow rather than a frame — see the same note in ui/tutorial.js. This
    // sheet is raised while the renderer is already struggling often enough
    // that waiting for rAF is how it ends up appearing seconds late.
    void layer.offsetWidth;
    toggle(layer, 'on', true);
    nav_.focusTop(true);
  }

  let hideT = null;
  function close() {
    if (!openFlag) return;
    openFlag = false;
    toggle(layer, 'on', false);
    if (hideT) clearTimeout(hideT);
    hideT = setTimeout(() => { hideT = null; toggle(layer, 'hid', !openFlag); }, 220);
  }

  function toggleOpen(force) {
    const want = force === undefined ? !openFlag : !!force;
    if (want) open(); else close();
  }

  /* Arrow keys page the sheet as well as walking its buttons: Left/Right on a
     nav button already lands on its neighbour, but a player who has arrowed
     into the body expects the same keys to turn the page. */
  const nav_ = keyNav();
  const offScope = nav_.registerScope({
    node: sheet,
    priority: 80,
    captures: true,
    isOpen: () => openFlag,
    first: () => nextBtn,
    onEscape: () => close()
  });

  return {
    open, close,
    toggle: toggleOpen,
    goTo(i) { page = Math.max(0, Math.min(slides.length - 1, i | 0)); if (openFlag) paint(); },
    update() { if (openFlag) paint(); },
    get isOpen() { return openFlag; },
    get pageCount() { return slides.length; },
    get node() { return layer; },
    destroy() {
      if (hideT) { clearTimeout(hideT); hideT = null; }
      try { offScope(); } catch (e) { /* already gone */ }
      if (layer.parentNode) layer.parentNode.removeChild(layer);
    }
  };
}

export default createHelp;
