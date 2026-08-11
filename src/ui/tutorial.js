/**
 * Island Settlers — the tutorial's two surfaces.
 *
 *   createBook(root, { onPractice, onClose })  -> { open, close, isOpen, destroy }
 *   createCoach(root)                          -> { show, mark, progress, hide, ... }
 *
 * THE BOOK is what TUTORIAL on the opening screen raises. It offers two routes
 * and makes both of them obvious: READ THE RULES, an illustrated pager, and
 * PRACTICE, the hand-held run. Both are one tap from the menu and one tap from
 * each other.
 *
 * The reading route is a PAGER on purpose. `ui-base.css` suppresses native
 * scrollbars everywhere — a full-screen game must never grow browser
 * furniture — so a long page is a design bug, not a scroll region. Ten pages,
 * one idea each, one picture each — eleven on a screen with a keyboard, where
 * the last one is the shortcut list. The route card counts them itself, so
 * neither number is written down anywhere.
 *
 * Every picture is drawn by src/systems/flowTutArt.js on a canvas in the
 * board map's own art language, or is the real inline-SVG icon from
 * src/ui/icons.js. Every number on a page is read out of core/constants.js
 * when the page is built, so the tutorial cannot drift from the game.
 *
 * THE COACH is the practice run's chrome: one instruction badge, in one of
 * three sizes, in one of three places on the screen, and one gold marker sized
 * to whatever the instruction is about. It owns no rules and it chooses
 * nothing; systems/tutorial.js drives every part of it. See the long note over
 * `createCoach` for why a tutorial card needs three sizes at all.
 *
 * Owner: Tutorial (flow) agent.
 */

import {
  RES_LABEL, COST, VICTORY_POINTS, TILE_ITEMS, TILE_REGEN,
  NUMBER_MIN, NUMBER_MAX,
  TRADE_BASE, PORT_GENERIC, PORT_SPECIAL, CARD_LABEL,
  LONGEST_ROAD_MIN, LONGEST_ROAD_VP, LARGEST_ARMY_MIN, LARGEST_ARMY_VP
} from '../core/constants.js';
import { el, button, clear, toggle, setText } from './dom.js';
import { icon, resIcon } from './icons.js';
import { paintScene } from '../systems/flowTutArt.js';
import { showKeysSlide } from './hud-help.js';

const lc = s => String(s).toLowerCase();

/** A cost as a row of real resource icons with their counts. */
function costRow(cost) {
  return el('div', { class: 'tut-costs' },
    Object.keys(cost).map(r => el('span', { class: 'tut-cost' },
      el('span', { class: 'ico', html: icon(resIcon(r), 18) }),
      el('b', { text: String(cost[r]) }),
      el('u', { text: RES_LABEL[r] }))));
}

/* ==================================================================== pages */

/**
 * Ten pages, in the order somebody who has never played would need them, plus
 * a keyboard page on a desktop-sized screen (see the note at the bottom).
 * `scene` names an illustration in flowTutArt.js; `extra()` may append live
 * markup (cost chips built from COST) under the prose.
 */
function buildPages() {
  const pages = [
    {
      scene: 'goal',
      title: 'The Goal',
      h: `First to ${VICTORY_POINTS} points`,
      body: [
        'You and three rivals settle one island at the same time. There are no turns — everybody plays at once, in real time.',
        `Every settlement you own is 1 point. Every city is 2. A victory card is 1. First to ${VICTORY_POINTS} takes the island.`
      ]
    },
    {
      scene: 'land',
      title: 'The Land',
      h: 'Five kinds of hex',
      body: [
        'The island is nineteen hexes. Five of them grow something you can carry away.',
        // "Remove the mention of the desert in the tutorial, since it's actually
        // the trading post." Quite right: the nineteenth hex carries the Great
        // Market, and calling it a desert that gives nothing describes a
        // tabletop rule this game does not have.
        'Forest gives wood. Clay hills give brick. Pasture gives wool. Fields give wheat. Mountains give ore. The nineteenth is the Trading Post, where you trade.'
      ]
    },
    {
      scene: 'number',
      title: 'The Number',
      h: 'What the number means',
      /* ONE TO TEN, AND NOTHING IS EVER ROLLED.
       *
       *   "Since the game isn't based on dice rolls and probabilities, I think
       *    [2-12 with pips] might be a bit confusing for new users."
       *
       * This page used to say "5-pip" and "1-pip", which is a term from a game
       * with dice in it and a row of dots that no longer exists. The disc now
       * prints a plain rank, so the page can too — and the two numbers it
       * quotes are still read out of `core/constants.js`, so the strongest and
       * weakest hex on the island can never be described wrongly here. */
      body: [
        `Every hex wears a wooden disc numbered ${NUMBER_MIN} to ${NUMBER_MAX}. Nothing is ever rolled — the number is just a rank, and it tells you two things.`,
        `How much the hex holds: a ${NUMBER_MAX} carries ${TILE_ITEMS[5]} things, a ${NUMBER_MIN} only ${TILE_ITEMS[1]}.`,
        `And how fast it comes back: ${TILE_REGEN[5]} seconds against ${TILE_REGEN[1]}. A higher number is simply a better hex, and the best two wear a red numeral.`
      ]
    },
    {
      scene: 'ownership',
      title: 'Your Land',
      h: 'You only collect on your own hexes',
      body: [
        'This is the one rule everybody misses.'
      ],
      key: 'You may only pick things up on a hex where you own a settlement or a city on one of its corners. Anywhere else you run straight through and collect nothing at all.',
      tail: 'So a new settlement is not just a point — it is new land to work.'
    },
    {
      scene: 'contact',
      title: 'Collecting',
      h: 'Just run over it',
      body: [
        'There is no tapping and no waiting. Touch a tree, a sheep, a clay pile — it is in your pack that instant.',
        // "Mention that you can click and drag anywhere with your finger to
        // move, not just the left side of the screen." The joystick stopped
        // being a left-half control a long time ago — systems/input.js takes a
        // drag from anywhere that is not already a button — and this page was
        // still teaching the old rule, which is worse than teaching nothing.
        'Press and drag ANYWHERE on the screen to walk — left side, right side, straight over the island. The stick appears under your thumb.'
      ]
    },
    {
      scene: 'recovery',
      title: 'Running Dry',
      h: 'A bare hex rests, then refills',
      body: [
        'Take the last thing off a hex and the whole hex goes bare and greys out. A countdown starts.',
        `When it ends, everything on it comes back at once — after ${TILE_REGEN[5]} to ${TILE_REGEN[1]} seconds, depending on its number.`,
        'The trick is to own several hexes and keep walking a loop around them.'
      ]
    },
    {
      scene: 'build',
      title: 'Building',
      h: 'Roads, settlements, cities',
      body: [
        'Tap BUILD, pick what you want, then tap a glowing spot on the map — and tap it again to place it. There is no confirm button.',
        // "Mention that the settlement has to be two roads away from any other
        // settlement, even your competitors'." It is the rule that decides
        // which corners glow, and the book never said it once.
        'A road joins two corners. A settlement sits on a corner your roads reach, and is worth 1 point. A city replaces a settlement you already own and is worth 2.',
        'Every settlement needs two roads of clear space between it and any other settlement on the island — your own and your rivals alike.'
      ],
      extra: () => el('div', { class: 'tut-costs' },
        el('span', { class: 'tut-cost' },
          el('span', { class: 'ico', html: icon('road', 18) }),
          el('u', { text: `${COST.road.wood} wood · ${COST.road.brick} brick` })),
        el('span', { class: 'tut-cost' },
          el('span', { class: 'ico', html: icon('house', 18) }),
          el('u', {
            text: `${COST.settlement.wood} wood · ${COST.settlement.brick} brick · ` +
              `${COST.settlement.wheat} wheat · ${COST.settlement.wool} wool`
          })),
        el('span', { class: 'tut-cost' },
          el('span', { class: 'ico', html: icon('castle', 18) }),
          el('u', { text: `${COST.city.wheat} wheat · ${COST.city.ore} ore` })))
    },
    {
      scene: 'trade',
      title: 'Trading',
      h: 'Swap what you have spare',
      body: [
        `Walk up to the Trading Post in the middle of the island and it will swap ${TRADE_BASE} of anything for 1 of what you need.`,
        `A dock you own does better: ${PORT_GENERIC} for 1, or ${PORT_SPECIAL} for 1 on the goods that dock deals in. You own a dock by settling one of its two corners.`
      ]
    },
    {
      scene: 'cards',
      title: 'Development Cards',
      h: 'Three cards, one price',
      body: [
        `${CARD_LABEL.knight}: land it on a hex and everyone with a settlement or city THERE loses half of every resource they hold, rounded down. Nobody else is touched, and you never pay it yourself.`,
        `${CARD_LABEL.roadBuilding}: two roads, free.`,
        `${CARD_LABEL.victoryPoint}: one point, straight away.`
      ],
      extra: () => costRow(COST.card)
    },
    {
      scene: 'awards',
      title: 'The Two Bonuses',
      h: 'Points you do not build',
      body: [
        `Longest Road goes to whoever has ${LONGEST_ROAD_MIN} or more segments in one unbroken line. It is worth ${LONGEST_ROAD_VP} points — as much as three settlements.`,
        `Largest Army goes to whoever has played ${LARGEST_ARMY_MIN} or more knights. It is worth ${LARGEST_ARMY_VP}.`,
        'Both can be taken off you the moment somebody beats your total.'
      ]
    }
  ];

  /*
   * ...AND ONE MORE PAGE, ON A SCREEN THAT HAS A KEYBOARD.
   *
   *   "Maybe add an additional slide in the tutorial written instructions for
   *    the keyboard shortcuts. Only add that slide for if the screen is larger
   *    than an iPad."
   *
   * `showKeysSlide()` lives in ui/hud-help.js and is shared with the in-match
   * rules sheet, so the two never disagree about what counts as a desktop —
   * and, more to the point, so the shortcut list itself exists in exactly one
   * place. Read at BUILD time rather than at open time, which is right for a
   * pager whose page count is baked into its dots: a browser window dragged
   * across a display boundary mid-read would otherwise renumber the book under
   * the reader.
   *
   * The page is appended rather than slotted in, because it is the only page
   * that is about the DEVICE rather than about the island, and a reader on a
   * phone has to be able to reach the end of the book without it.
   */
  if (showKeysSlide()) {
    pages.push({
      scene: 'goal',
      title: 'Keyboard',
      h: 'Playing without a mouse',
      body: [
        'The four arrow keys walk. Space pauses and resumes. B shows and hides the build cards.',
        'R starts a road, S a settlement, C a city, and D buys a development card. T opens the Trading Post and M opens your dock.',
        'In any map or menu the arrow keys move between choices and Enter takes one. Esc backs out — it clears a staged trade first, then closes the sheet.'
      ]
    });
  }

  return pages;
}

/* ===================================================================== book */

export function createBook(root, opts = {}) {
  if (!root || !root.appendChild || typeof document === 'undefined') {
    const noop = () => {};
    return { open: noop, close: noop, destroy: noop, get isOpen() { return false; } };
  }

  const pages = buildPages();
  let page = 0;
  let mode = 'menu';          // menu | read
  let open = false;

  /* ------------------------------------------------------------- scaffold */
  const titleEl = el('b', { class: 'tut-title', text: 'How to Play' });
  const countEl = el('span', { class: 'tut-count hid', text: '' });
  const closeBtn = button('cream tut-x', {
    'aria-label': 'Close the tutorial',
    on: { click: () => close() }
  }, el('span', { class: 'ico', html: icon('close', 20) }));

  const head = el('div', { class: 'tut-head' }, titleEl, countEl, closeBtn);

  /* --- routes ----------------------------------------------------------- */
  const artRow = names => el('span', {
    class: 'tr-art', html: names.map(n => icon(n, 40)).join('')
  });

  const readRoute = button('tut-route read', {
    'aria-label': 'Read the illustrated rules',
    on: { click: () => showRead(0) }
  },
    artRow(['log', 'house', 'trophy']),
    el('b', { class: 'tr-name', text: 'Read the Rules' }),
    el('span', {
      class: 'tr-sub',
      text: `${pages.length} short pages, one picture each. Two minutes.`
    }),
    el('span', {
      class: 'tr-tag',
      text: 'The goal · the land · collecting · building · trading'
    }));

  const playRoute = button('tut-route play', {
    'aria-label': 'Take the guided practice run',
    on: { click: () => { close(); if (opts.onPractice) opts.onPractice(); } }
  },
    artRow(['flag', 'road', 'castle']),
    el('b', { class: 'tr-name', text: 'Practice Run' }),
    el('span', {
      class: 'tr-sub',
      text: 'Play it slowly with me. One step at a time, nobody racing you.'
    }),
    el('span', {
      class: 'tr-tag',
      text: 'Walk · collect · build a road · settle · trade'
    }));

  const routes = el('div', { class: 'tut-routes' }, readRoute, playRoute);
  const routeNote = el('div', {
    class: 'tut-foot-note',
    text: 'Never played Catan? Read first, then practise.'
  });

  /* --- a page ----------------------------------------------------------- */
  const canvas = el('canvas', { 'aria-hidden': 'true' });
  const art = el('div', { class: 'tut-art' }, canvas);
  const copy = el('div', { class: 'tut-copy' });
  const pageBox = el('div', { class: 'tut-page hid' }, art, copy);

  const dots = el('div', { class: 'tut-dots' });
  const dotEls = pages.map(() => el('i'));
  dotEls.forEach(d => dots.appendChild(d));

  const backBtn = button('cream', { on: { click: () => step(-1) } },
    el('span', { class: 'sb-lab', text: 'Back' }));
  const nextBtn = button('gold', { on: { click: () => step(1) } },
    el('span', { class: 'sb-lab', text: 'Next' }));
  const nav = el('div', { class: 'tut-nav hid' }, backBtn, dots, nextBtn);

  const sheet = el('div', { class: 'tut-sheet' }, head, routes, routeNote, pageBox, nav);
  const layer = el('div', { class: 'tut hid', 'data-ui': '' },
    el('div', { class: 'tut-scrim', on: { click: () => close() } }), sheet);
  root.appendChild(layer);

  /* ---------------------------------------------------------------- paint */

  function repaint() {
    const box = art.getBoundingClientRect();
    const w = Math.max(40, Math.round(box.width));
    const h = Math.max(40, Math.round(box.height));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext && canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    paintScene(pages[page].scene, ctx, w, h);
  }

  function fillCopy() {
    const p = pages[page];
    clear(copy);
    copy.appendChild(el('div', { class: 'tut-h', text: p.h }));
    for (const line of p.body) copy.appendChild(el('p', { text: line }));
    if (p.key) copy.appendChild(el('p', { class: 'key', text: p.key }));
    if (p.tail) copy.appendChild(el('p', { text: p.tail }));
    if (p.extra) copy.appendChild(p.extra());
  }

  function paintPage() {
    const p = pages[page];
    setText(titleEl, p.title);
    setText(countEl, `${page + 1} / ${pages.length}`);
    dotEls.forEach((d, i) => toggle(d, 'on', i === page));
    fillCopy();
    setText(backBtn.querySelector('.sb-lab'),
      page === 0 ? 'Menu' : 'Back');
    const last = page === pages.length - 1;
    setText(nextBtn.querySelector('.sb-lab'), last ? 'Practice Run' : 'Next');
    toggle(nextBtn, 'gold', !last);
    toggle(nextBtn, 'green', last);
    // Two frames of layout have to land before the canvas box has a size.
    repaint();
    requestAnimationFrame(repaint);
  }

  function step(d) {
    if (d < 0 && page === 0) { showMenu(); return; }
    if (d > 0 && page === pages.length - 1) {
      close();
      if (opts.onPractice) opts.onPractice();
      return;
    }
    page = Math.max(0, Math.min(pages.length - 1, page + d));
    paintPage();
  }

  function showMenu() {
    mode = 'menu';
    setText(titleEl, 'How to Play');
    toggle(countEl, 'hid', true);
    toggle(routes, 'hid', false);
    toggle(routeNote, 'hid', false);
    toggle(pageBox, 'hid', true);
    toggle(nav, 'hid', true);
  }

  function showRead(at) {
    mode = 'read';
    page = Math.max(0, Math.min(pages.length - 1, at | 0));
    toggle(countEl, 'hid', false);
    toggle(routes, 'hid', true);
    toggle(routeNote, 'hid', true);
    toggle(pageBox, 'hid', false);
    toggle(nav, 'hid', false);
    paintPage();
  }

  /* ----------------------------------------------------------------- open */

  function onResize() { if (open && mode === 'read') repaint(); }
  window.addEventListener('resize', onResize);

  function show(route) {
    if (open) return;
    open = true;
    toggle(layer, 'hid', false);
    if (route === 'read') showRead(0); else showMenu();
    /*
     * A REFLOW, NOT A FRAME.
     *
     * `.tut` is opacity 0 and `pointer-events: none` until `.on` lands, and
     * `.on` was being set from a requestAnimationFrame callback — the usual
     * trick for making a CSS transition actually run instead of being collapsed
     * into the same style recalculation.
     *
     * It is the wrong trick on a slow machine, because rAF is the FRAME LOOP,
     * and this game already fights for frames on the hardware it was reported
     * from: measured under a software rasteriser, the book stayed invisible and
     * unclickable for seconds after PRACTICE RUN was pressed, and on the worst
     * runs never came up at all. A player would see the tutorial button do
     * nothing. Forcing a reflow gets the same guarantee — the browser has
     * committed opacity 0 before opacity 1 is asked for, so the transition still
     * plays — without making the interface's usability depend on the renderer
     * keeping up. `hud-end.js` uses `void offsetWidth` for the same reason.
     */
    void layer.offsetWidth;
    toggle(layer, 'on', open);
  }

  function close() {
    if (!open) return;
    open = false;
    toggle(layer, 'on', false);
    setTimeout(() => toggle(layer, 'hid', !open), 260);
    if (opts.onClose) { try { opts.onClose(); } catch (e) { /* ignore */ } }
  }

  function destroy() {
    window.removeEventListener('resize', onResize);
    if (layer.parentNode) layer.parentNode.removeChild(layer);
  }

  return {
    open: show, close, destroy,
    get isOpen() { return open; },
    get pageCount() { return pages.length; },
    goToPage: showRead,
    get node() { return layer; }
  };
}

/* ==================================================================== coach */

/**
 * The practice run's chrome. Nothing here knows a rule: `show()` is given the
 * words, `mark()` is given a rectangle on screen, and `progress()` a fraction.
 * systems/tutorial.js decides all three.
 *
 * THREE SIZES, BECAUSE THE BRIEF IS THAT THE LESSON MUST NOT COVER THE THING
 * IT IS TEACHING.
 *
 *   "On the step for building the road, show the popup for the tutorial
 *    larger, then they click okay, then just keep the highlight of what they're
 *    supposed to click so that it doesn't cover the map and just get
 *    confusing."
 *
 *   "For the trade at the market step, explain how the market works, then have
 *    them press okay, and hide / have a much smaller out-of-the-way but clear
 *    circles/highlights to follow so that you successfully make a trade without
 *    the tutorial in the way."
 *
 * Both of those are one shape asked for twice, so it is one mechanism:
 *
 *   BIG    the badge. Step number, title, two or three lines, and the nav row.
 *          This is the thing being read, and it is the only state that is
 *          allowed to be large.
 *   SLIM   one line and the nav keys, in the corner. What is left after OK: the
 *          player already knows what they are doing, and the gold ring is
 *          carrying the "where".
 *   GONE   nothing but the ring. Used the moment a full-screen sheet takes the
 *          display — the trade post — because there is no corner of a 640px
 *          screen a card can sit in without landing on the sheet the player is
 *          being walked through.
 *
 * AND THREE PLACES, for the same reason:
 *
 *   TOP    where the resource pill normally is. The opening lesson and the
 *          build-a-road lesson both live here, and both hide the pill while
 *          they do — see the `tut-pack` rules in tutorial.css.
 *   BOTTOM the band above the build cards, which is where this card has always
 *          lived and is measured to clear.
 *   LOW    the same band with the build cards taken away, so the badge drops
 *          another notch and the middle of the screen — the board, and the
 *          player standing on it — is clear.
 *
 * `size` and `place` arrive as plain names and become classes; the arithmetic
 * for each is in tutorial.css, next to the numbers it has to clear.
 */
export function createCoach(root) {
  if (!root || !root.appendChild || typeof document === 'undefined') {
    const noop = () => {};
    return {
      show: noop, say: noop, mark: noop, point: noop, progress: noop, hide: noop, good: noop,
      chrome: noop, wear: noop, allowNext: noop, destroy: noop, onQuit: noop,
      get isOpen() { return false; }, get node() { return null; }
    };
  }

  const stepNum = el('b', { text: '1' });
  const stepOf = el('u', { text: 'Step' });
  const stepBox = el('div', { class: 'coach-step' }, stepNum, stepOf);

  const headEl = el('div', { class: 'coach-h', text: '' });
  const textEl = el('div', { class: 'coach-t', text: '' });
  const body = el('div', { class: 'coach-body' }, headEl, textEl);
  const main = el('div', { class: 'coach-main' }, stepBox, body);

  let onAct = null, onAct2 = null, onBack = null, onNext = null, onQuit = null;

  /*
   * FORWARD AND BACKWARD, AND THEY ARE THE PAIR.
   *
   *   "For the tutorial let me go forward or backward in the steps instead of
   *    just saying skip all of the time."
   *
   * The old card carried one grey SKIP and nothing else, so the only way
   * through a run was onward and the only way to re-read a step was to start
   * again. BACK and NEXT are a matched pair sitting together at the end of the
   * card, and NEXT is also what SKIP used to be: on a step that is waiting for
   * the player to do something it moves on regardless, which is what the grey
   * key did and is why there is no longer a third one. The label a screen
   * reader gets says so; see `show`.
   *
   * The green key, when a step has one, is the step's own verb — START, GOT IT,
   * OK — and it sits between them because it is the thing to press.
   */
  const backBtn = button('cream coach-back', {
    'aria-label': 'Back to the previous step',
    on: { click: () => onBack && onBack() }
  }, el('span', { class: 'sb-lab', text: 'Back' }));

  const actBtn = button('green coach-act', { on: { click: () => onAct && onAct() } },
    el('span', { class: 'sb-lab', text: 'Got it' }));

  const nextBtn = button('gold coach-next', {
    'aria-label': 'Go on to the next step',
    on: { click: () => onNext && onNext() }
  }, el('span', { class: 'sb-lab', text: 'Next' }));

  /* A SECOND GREEN KEY, FOR THE ONE CARD THAT ENDS IN A CHOICE.
   *
   *   "Let them have the option, when the tutorial is done, to roam around on
   *    freeplay ... or to go to the menu to play a real game."
   *
   * Only the closing card ever shows it, and it is hidden the rest of the run,
   * so the nav row is BACK / verb / NEXT everywhere else exactly as before. */
  const act2Btn = button('cream coach-act2 hid', { on: { click: () => onAct2 && onAct2() } },
    el('span', { class: 'sb-lab', text: '' }));

  const acts = el('div', { class: 'coach-acts' }, backBtn, actBtn, act2Btn, nextBtn);

  const railFill = el('i');
  const rail = el('span', { class: 'coach-rail' }, railFill);

  const card = el('div', { class: 'coach-card big at-top', 'data-ui': '' },
    rail, main, acts);

  const mark = el('div', { class: 'coach-mark' });

  /*
   * A COMPASS, FOR A THING THAT IS NOT ON THE SCREEN.
   *
   *   "I don't want a circle on step 5e. I want just an arrow near the middle
   *    of the screen pointing and gesturing which direction I should go to see
   *    the city, if it's not already visible on the screen."
   *
   * The gold ring cannot do this and should not try. It is a HIGHLIGHT — it
   * says "this one" about something you can see — and `markerFor` clamps it
   * into the frame precisely so it never leaves, which turns it into a ring
   * sitting on the edge of the screen circling a patch of sea. What is wanted
   * when the subject is off-screen is the opposite kind of mark: not "here" but
   * "that way".
   *
   * So it is one element rotated about the middle of the screen, with the head
   * pushed out along its own axis — rotate the arm, the arrow swings round the
   * centre and keeps pointing outward. It is shown only while the target is
   * genuinely out of the frame; walk far enough that the city comes into view
   * and it takes itself away, which is the whole of its job.
   */
  const arrowHead = el('i', { class: 'coach-arrow-h' });
  const arrow = el('div', { class: 'coach-arrow' }, arrowHead);

  const quitBtn = button('cream coach-quit', {
    'aria-label': 'Leave the practice run',
    on: { click: () => onQuit && onQuit() }
  }, el('span', { class: 'sb-lab', text: 'End Practice' }));

  /*
   * THE VEIL — the whole screen turned down behind one card.
   *
   *   "For step 1 the popup should actually be in the middle of the screen (not
   *    like the other steps) and everything else should be darkened. Then I have
   *    to press okay."
   *
   * The first card is the only one that is not asking the player to look at
   * anything: there is no hex, no control, no ring — just a sentence about what
   * this run is. So it is the only one that may take the whole screen, and the
   * dark behind it is what makes "read this, then press Okay" the only thing on
   * offer. Every other step has to leave the island playable, which is why this
   * is a per-step flag and not the coach's normal state.
   *
   * It is a DOM layer rather than a hole-less `tut-spot` wash because it must
   * sit ABOVE the heads-up display, not behind it — the point is that nothing
   * else is available — and because it takes the taps that would otherwise
   * reach the joystick underneath.
   */
  const veil = el('div', { class: 'coach-veil' });

  const layer = el('div', { class: 'coach hid' }, veil, mark, arrow, card, quitBtn);
  root.appendChild(layer);

  let shown = false;
  let wantVeil = false;
  let size = 'big', place = 'top';

  /** Put the card in one of the three sizes and one of the three places. */
  function chrome(nextSize, nextPlace) {
    if (nextSize) size = nextSize;
    if (nextPlace) place = nextPlace;
    toggle(card, 'big', size === 'big');
    toggle(card, 'slim', size === 'slim');
    toggle(card, 'gone', size === 'gone');
    toggle(card, 'at-top', place === 'top');
    toggle(card, 'at-bottom', place === 'bottom');
    toggle(card, 'at-low', place === 'low');
    toggle(card, 'at-foot', place === 'foot');
    toggle(card, 'at-centre', place === 'centre');
    toggle(card, 'at-side', place === 'side');
    /* END PRACTICE lives in the top-right corner and stays there. The top
       badge is deliberately narrow enough to clear it — see `--tut-side` in
       tutorial.css, which reserves the same width on both sides of the screen
       — so the two never have to negotiate. It goes away only when the badge
       itself has, because a chip floating alone over a trade sheet is exactly
       the litter the GONE size exists to prevent. */
    toggle(quitBtn, 'on', shown && size !== 'gone'
      && !layer.classList.contains('tut-noquit'));
    /* THE VEIL GOES WITH THE CARD, ALWAYS.
     *
     *   "After I completed that bulk trade the trade popup is still there, but
     *    everything is dark and I can't press anything and I can't see the next
     *    step."
     *
     * That is this, exactly. The veil was raised in `show()` and the card was
     * hidden a moment later by `chrome()` — GONE is what a step wears while a
     * full-screen sheet owns the display — so the screen kept a black layer
     * that swallows taps with nothing on top of it to explain itself or to
     * dismiss it. A veil is the card's own backdrop and has no business
     * outliving it by even a frame. */
    toggle(veil, 'on', shown && wantVeil && size !== 'gone');
  }

  function show(info) {
    const o = info || {};
    toggle(layer, 'hid', false);
    toggle(card, 'good', false);
    /* "1a", "3d" — see CHAPTERS in tutsteps.js — with the chapter's short name
       under it instead of a running total. A count out of fifty tells a player
       how much is left and nothing about what they are doing. */
    setText(stepNum, String(o.label || o.n || 1));
    setText(stepOf, o.tag || (o.of ? `of ${o.of}` : 'Step'));
    setText(headEl, o.title || '');
    setText(textEl, o.text || '');

    onAct = typeof o.onAction === 'function' ? o.onAction : null;
    onAct2 = typeof o.onAction2 === 'function' ? o.onAction2 : null;
    onBack = typeof o.onBack === 'function' ? o.onBack : null;
    onNext = typeof o.onNext === 'function' ? o.onNext : null;

    toggle(actBtn, 'hid', !o.action);
    if (o.action) setText(actBtn.querySelector('.sb-lab'), o.action);
    toggle(act2Btn, 'hid', !o.action2);
    if (o.action2) setText(act2Btn.querySelector('.sb-lab'), o.action2);
    /* Four keys do not fit across a card that is laid out as a row: BACK, two
       verbs and NEXT leave the words about forty pixels wide. The card stacks
       instead — body over keys — for the one step that has two. */
    toggle(card, 'twoacts', !!o.action2);
    /* The closing card is not a step you can be part-way through, so it carries
       neither a number nor a way onward: "remove the next button from 9a — in
       fact remove the number 9a, since it's just letting me know the tutorial
       is over." */
    toggle(card, 'nostep', !!o.noBadge);
    toggle(nextBtn, 'hid', !!o.noNext);
    toggle(backBtn, 'off', !o.canBack);
    backBtn.disabled = !o.canBack;
    toggle(nextBtn, 'off', !o.canNext);
    nextBtn.disabled = !o.canNext;
    /* A step that is waiting on the player has no green key, so NEXT is also
       the skip — and it says so out loud where it costs nothing. */
    nextBtn.setAttribute('aria-label', o.action
      ? 'Go on to the next step'
      : 'Skip this step and go on');

    shown = true;
    wantVeil = !!o.veil;
    chrome(o.size, o.place);
    // Same reasoning as `show()` above: the coach card is the thing the player
    // reads on every step, and a step whose words arrive a frame late on a
    // machine that draws twice a second is a step that arrives half a second
    // late. Reflow, then class, so the fade still plays and the words do not
    // wait on the renderer.
    void card.offsetWidth;
    toggle(card, 'on', shown);
  }

  /**
   * Light or dim NEXT without rebuilding the card.
   *
   * A step that holds NEXT can stop being holdable — the player closed the map
   * it was about, or walked away from the post — and the key has to change
   * without `show()` running again, because `show()` is what re-applies a
   * step's `enter` and re-applies means re-dealing the pack in the middle of a
   * trade the player is halfway through.
   */
  function allowNext(on) {
    toggle(nextBtn, 'off', !on);
    nextBtn.disabled = !on;
  }

  /** Live edit of the running instruction — used by the countdown steps. */
  function say(text) { setText(textEl, text || ''); }

  function progress(p) {
    const v = Math.max(0, Math.min(1, Number(p) || 0));
    railFill.style.width = (v * 100).toFixed(1) + '%';
  }

  /**
   * `at` is `{ x, y, w, h }` in CSS pixels — the CENTRE of the thing being
   * pointed at and, optionally, how big it is — or null to clear the marker.
   *
   * The ring is sized to its target rather than coming in two fixed sizes. A
   * 64px ring around a trade sheet's up-arrow is a lasso; a 64px ring around a
   * build card is a belt. Fitting it to the box means the same control reads as
   * "this one" at every size the interface has, which is the whole job of a
   * highlight that is meant to be minimal.
   */
  function place2(at) {
    if (!at) { toggle(mark, 'on', false); return; }
    const span = Math.max(Number(at.w) || 0, Number(at.h) || 0);
    const d = Math.max(46, Math.min(158, span + 26));
    mark.style.width = d + 'px';
    mark.style.height = d + 'px';
    mark.style.margin = `${-d / 2}px 0 0 ${-d / 2}px`;
    mark.style.transform = `translate(${Math.round(at.x)}px,${Math.round(at.y)}px)`;
    toggle(mark, 'on', true);
  }

  /**
   * `at` is `{ angle }` in radians, measured from the middle of the screen the
   * way `Math.atan2` gives it, or null to take the arrow away.
   */
  function point(at) {
    if (!at || typeof at.angle !== 'number') { toggle(arrow, 'on', false); return; }
    arrow.style.transform = `translate(-50%,-50%) rotate(${at.angle}rad)`;
    toggle(arrow, 'on', true);
  }

  function good() {
    toggle(card, 'good', true);
    setTimeout(() => toggle(card, 'good', false), 700);
  }

  function hide() {
    shown = false;
    wantVeil = false;
    toggle(card, 'on', false);
    toggle(mark, 'on', false);
    toggle(arrow, 'on', false);
    toggle(veil, 'on', false);
    toggle(quitBtn, 'on', false);
    setTimeout(() => toggle(layer, 'hid', !shown), 320);
  }

  /**
   * Mirror the run's wardrobe flags onto the coach layer.
   *
   * The HUD wardrobe hangs off classes on `#ui` (see the note at the top of
   * systems/tutorial.js), but the badge is not inside `#ui` — it is a sibling —
   * so a rule like "sit lower on the step that hides the three keys" has no
   * selector that can reach it from there. Rather than move the coach into the
   * HUD, the same flags are written on both roots and tutorial.css matches
   * whichever one it needs.
   */
  function wear(flags) {
    const f = flags || {};
    toggle(layer, 'tut-nokeys', !!f.nokeys);
    toggle(layer, 'tut-nokeys-sm', !!f.nokeysSm);
    toggle(layer, 'tut-nobuild', !!f.nobuild);
    toggle(layer, 'tut-pack', !!f.pack);
    /* END PRACTICE is the coach's own chip, so this one is not a mirror of an
       `#ui` class — it is the only place it can be done.

         "Hide the End practice button for this step."

       Two steps ask: the score lesson, which lights the counter in the top
       right and cannot have a cream chip sitting next to it, and the map-open
       steps, where the chip would stand over the board. */
    toggle(layer, 'tut-noquit', !!f.noquit);
  }

  function destroy() {
    if (layer.parentNode) layer.parentNode.removeChild(layer);
  }

  return {
    show, say, progress, mark: place2, point, good, hide, chrome, wear, allowNext, destroy,
    onQuit(fn) { onQuit = fn; },
    get isOpen() { return shown; },
    get size() { return size; },
    get where() { return place; },
    get node() { return layer; },
    get card() { return card; }
  };
}

export default { createBook, createCoach };
