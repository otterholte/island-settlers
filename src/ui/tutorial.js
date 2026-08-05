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
 * one idea each, one picture each.
 *
 * Every picture is drawn by src/systems/flowTutArt.js on a canvas in the
 * board map's own art language, or is the real inline-SVG icon from
 * src/ui/icons.js. Every number on a page is read out of core/constants.js
 * when the page is built, so the tutorial cannot drift from the game.
 *
 * THE COACH is the practice run's chrome: one instruction card at the foot of
 * the screen and one gold marker on whatever the instruction is about. It owns
 * no rules; systems/tutorial.js drives it.
 *
 * Owner: Tutorial (flow) agent.
 */

import {
  RES_LABEL, COST, VICTORY_POINTS, TILE_ITEMS, TILE_REGEN,
  TRADE_BASE, PORT_GENERIC, PORT_SPECIAL, CARD_LABEL,
  LONGEST_ROAD_MIN, LONGEST_ROAD_VP, LARGEST_ARMY_MIN, LARGEST_ARMY_VP
} from '../core/constants.js';
import { el, button, clear, toggle, setText } from './dom.js';
import { icon, resIcon } from './icons.js';
import { paintScene } from '../systems/flowTutArt.js';

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
 * Ten pages, in the order somebody who has never played would need them.
 * `scene` names an illustration in flowTutArt.js; `extra()` may append live
 * markup (cost chips built from COST) under the prose.
 */
function buildPages() {
  return [
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
        'Forest gives wood. Clay hills give brick. Pasture gives wool. Fields give wheat. Mountains give ore. The nineteenth is the Great Market, where you trade.'
      ]
    },
    {
      scene: 'number',
      title: 'The Number',
      h: 'What the number means',
      body: [
        'Every hex wears a wooden number disc. It tells you two things, and only two.',
        `How much the hex holds: a 5-pip hex carries ${TILE_ITEMS[5]} things, a 1-pip hex only ${TILE_ITEMS[1]}.`,
        `And how fast it comes back: ${TILE_REGEN[5]} seconds against ${TILE_REGEN[1]}. A big number is simply a better hex.`
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
        'Drag anywhere on the left half of the screen to walk. Sweeping a whole hex clean takes about three seconds of running.'
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
        'Tap BUILD, pick what you want, then pick a glowing spot on the map.',
        'A road joins two corners. A settlement sits on a corner your roads reach, and is worth 1 point. A city replaces a settlement you already own and is worth 2.'
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
        `Walk up to the Great Market in the middle of the island and it will swap ${TRADE_BASE} of anything for 1 of what you need.`,
        `A dock you own does better: ${PORT_GENERIC} for 1, or ${PORT_SPECIAL} for 1 on the goods that dock deals in. You own a dock by settling one of its two corners.`
      ]
    },
    {
      scene: 'cards',
      title: 'Development Cards',
      h: 'Three cards, one price',
      body: [
        `${CARD_LABEL.knight}: every rival loses HALF of every resource they hold — gone, not stolen — and you move the Knight onto a hex to shut it down.`,
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
    requestAnimationFrame(() => toggle(layer, 'on', open));
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
 * words, `mark()` is given a place on screen, and `progress()` a fraction.
 *
 * The marker takes a viewport point in CSS pixels — systems/tutorial.js works
 * out whether that came from a DOM rectangle or from a point in the world.
 */
export function createCoach(root) {
  if (!root || !root.appendChild || typeof document === 'undefined') {
    const noop = () => {};
    return {
      show: noop, mark: noop, progress: noop, hide: noop, good: noop,
      destroy: noop, get isOpen() { return false; }
    };
  }

  const stepNum = el('b', { text: '1' });
  const stepBox = el('div', { class: 'coach-step' },
    stepNum, el('u', { text: 'Step' }));

  const headEl = el('div', { class: 'coach-h', text: '' });
  const textEl = el('div', { class: 'coach-t', text: '' });
  const body = el('div', { class: 'coach-body' }, headEl, textEl);

  let onAct = null, onSkip = null;

  const actBtn = button('green', { on: { click: () => onAct && onAct() } },
    el('span', { class: 'sb-lab', text: 'Got it' }));
  const skipBtn = button('cream coach-skip', {
    'aria-label': 'Skip this step',
    on: { click: () => onSkip && onSkip() }
  }, el('span', { class: 'sb-lab', text: 'Skip' }));
  const acts = el('div', { class: 'coach-acts' }, skipBtn, actBtn);

  const railFill = el('i');
  const rail = el('span', { class: 'coach-rail' }, railFill);

  const card = el('div', { class: 'coach-card', 'data-ui': '' },
    rail, stepBox, body, acts);

  const mark = el('div', { class: 'coach-mark' });

  let onQuit = null;
  const quitBtn = button('cream coach-quit', {
    'aria-label': 'Leave the practice run',
    on: { click: () => onQuit && onQuit() }
  }, el('span', { class: 'sb-lab', text: 'End Practice' }));

  const layer = el('div', { class: 'coach hid' }, mark, card, quitBtn);
  root.appendChild(layer);

  let shown = false;

  function show(info) {
    const o = info || {};
    toggle(layer, 'hid', false);
    toggle(card, 'good', false);
    setText(stepNum, String(o.n || 1));
    setText(headEl, o.title || '');
    setText(textEl, o.text || '');
    onAct = typeof o.onAction === 'function' ? o.onAction : null;
    onSkip = typeof o.onSkip === 'function' ? o.onSkip : null;
    toggle(actBtn, 'hid', !o.action);
    if (o.action) setText(actBtn.querySelector('.sb-lab'), o.action);
    toggle(skipBtn, 'hid', !o.onSkip);
    toggle(quitBtn, 'on', true);
    shown = true;
    requestAnimationFrame(() => toggle(card, 'on', shown));
  }

  /** Live edit of the running instruction — used by the countdown step. */
  function say(text) { setText(textEl, text || ''); }

  function progress(p) {
    const v = Math.max(0, Math.min(1, Number(p) || 0));
    railFill.style.width = (v * 100).toFixed(1) + '%';
  }

  /** `at` is { x, y, wide } in CSS pixels, or null to clear the marker. */
  function place(at) {
    if (!at) { toggle(mark, 'on', false); return; }
    mark.style.transform = `translate(${Math.round(at.x)}px,${Math.round(at.y)}px)`;
    toggle(mark, 'wide', !!at.wide);
    toggle(mark, 'on', true);
  }

  function good() {
    toggle(card, 'good', true);
    setTimeout(() => toggle(card, 'good', false), 700);
  }

  function hide() {
    shown = false;
    toggle(card, 'on', false);
    toggle(mark, 'on', false);
    toggle(quitBtn, 'on', false);
    setTimeout(() => toggle(layer, 'hid', !shown), 320);
  }

  function destroy() {
    if (layer.parentNode) layer.parentNode.removeChild(layer);
  }

  return {
    show, say, progress, mark: place, good, hide, destroy,
    onQuit(fn) { onQuit = fn; },
    get isOpen() { return shown; },
    get node() { return layer; }
  };
}

export default { createBook, createCoach };
