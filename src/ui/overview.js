/**
 * Island Settlers — board overview.
 *
 *   createOverview(root, state, game) ->
 *     { open(mode, opts), close(), update(dt), isOpen }
 *
 * A painted 2D board map over the 3D scene. Far easier to read on a phone
 * than an orbit camera, and it doubles as the placement interface: every
 * legal target pulses, one tap previews it (also driving the 3D ghost), and
 * a confirm bar commits it through rules.js.
 *
 * Modes: 'view' | 'place-road' | 'place-settlement' | 'place-city'
 *      | 'place-robber' | 'draft-watch'
 *
 * `draft-watch` is the opening draft's spectator state: the same board, the
 * same framing, no targets and no confirm bar. It exists so the snake draft
 * can be *one* uninterrupted view — matchflow.js reconfigures this panel in
 * place between every pick instead of closing and reopening it, which is what
 * used to snap the 3D camera back to third-person between a player's
 * settlement and their road. `open()` is therefore idempotent: called while
 * already open it re-dresses the panel and never touches the visibility
 * classes.
 *
 * All hex geometry comes from board/layout.js — nothing is re-derived here.
 * World (x, z) maps to canvas (x, y) with a single uniform scale, so the
 * pointy-top hexes stay pointy-top.
 *
 * The board also MOVES: `ovpan.js` owns drag / pinch / wheel / +- and writes
 * straight into `proj`, so the coast that lives under the title plate or the
 * player rail can be pulled into the open. Clamped so the middle of the island
 * can never leave the middle three quarters of the frame, and reset on a fresh
 * open so a placement mode always starts on the whole board.
 *
 * Painting lives in two siblings: ./ovmap.js draws the BOARD (sea, island,
 * tokens, docks, everybody's pieces) and ./ovtargets.js draws the PLACEMENT
 * LAYER over it (the corner rings you may claim, the road slabs you may build
 * along, the Knight marks, the confirm preview and the rival telegraph). This
 * file decides what is legal and what the finger touched; those two decide what
 * it looks like.
 *
 * Nothing writes text onto the hexes: the board
 * carries the terrain, the number tokens, the docks, everybody's pieces and a
 * single gold pin for where you are standing. Who the other settlers are, what
 * colour they play and how they are doing is the right-hand rail's job.
 *
 * Owner: UI agent.
 */

import { HEX_SIZE } from '../core/constants.js';
import { tiles, intersections, edges, BOUNDS } from '../board/layout.js';
import {
  legalRoads, legalSettlements, legalCities,
  placeRoad, placeSettlement, upgradeCity, playKnight, scoreOf
} from '../core/rules.js';
import { el, button, toggle, setText, clamp, onTap } from './dom.js';
import { icon, avatar, personPip } from './icons.js';
import { createPainter, pipRadius } from './ovmap.js';
import { createTargets } from './ovtargets.js';
import { createOvPan } from './ovpan.js';
import { netCommit } from '../systems/economy.js';

/* Every placement hint names the double-tap, because a route nobody is told
   about is a route nobody uses — see `onTap` below. */
const MODE_INFO = {
  'view':              { title: 'Island Map', hint: 'Drag the board · pinch to zoom' },
  'place-road':        { title: 'Place a Road', hint: 'Tap a glowing edge · tap it again to place' },
  'place-settlement':  { title: 'Place a Settlement', hint: 'Tap a glowing corner · tap it again to place' },
  'place-city':        { title: 'Upgrade to a City', hint: 'Tap one of your settlements · tap it again to upgrade' },
  'place-robber':      { title: 'Send the Knight', hint: 'Tap a region · tap it again to send' },
  'draft-watch':       { title: 'Opening Draft', hint: 'Watch the board' }
};

/* The draft rail lives here rather than in ui.css. Scoped under `.ov`. */
const DRAFT_STYLE_ID = 'ov-draft-style';
const DRAFT_CSS = `
/* The draft narration lives in this plate, and the board's height is measured
   off its bottom edge — so a headline that wraps to two lines shrinks the map.
   Both lines are capped and clipped to one line each. */
/* Read by a screen reader, never painted. See the .ov-say note in overview.js
   for why the plate these two used to live in is gone. */
.ov .ov-say{position:absolute;width:1px;height:1px;overflow:hidden;
  clip-path:inset(50%);white-space:nowrap;pointer-events:none}
.ov .ov-dhead{font:800 8.5px/1 var(--ff);letter-spacing:.22em;text-transform:uppercase;
  color:rgba(255,231,154,.86);text-align:center;padding:1px 0 3px}
.ov .ov-dsub{font:800 10.5px/1.15 var(--ff);letter-spacing:.09em;text-transform:uppercase;
  color:#fff;text-align:center;padding-bottom:5px;text-shadow:0 1px 2px rgba(0,0,0,.65)}
.ov .ov-dr{position:relative;display:flex;align-items:center;gap:6px;
  padding:5px 6px 5px 11px;border-radius:10px;overflow:hidden;
  background:linear-gradient(90deg,var(--ct,rgba(59,127,212,.34)),rgba(255,255,255,.03) 66%),
             linear-gradient(180deg,rgba(255,255,255,.08),rgba(255,255,255,.02));
  box-shadow:inset 0 1px 0 rgba(255,255,255,.14),0 1px 2px rgba(0,0,0,.3);
  opacity:.55;transition:opacity .2s ease,box-shadow .2s ease,transform .2s ease}
.ov .ov-dr::before{content:'';position:absolute;left:0;top:0;bottom:0;width:6px;
  background:linear-gradient(180deg,var(--cl,#93cbff),var(--c,#2f8ffb) 55%);
  box-shadow:inset -1px 0 0 rgba(0,0,0,.45)}
.ov .ov-dr.done{opacity:.8}
.ov .ov-dr.you{opacity:.8;box-shadow:inset 0 0 0 1.5px rgba(255,201,60,.55),0 1px 2px rgba(0,0,0,.3)}
.ov .ov-dr.now{opacity:1;transform:translateX(3px);
  box-shadow:inset 0 0 0 2px var(--gold,#ffc93c),0 0 14px rgba(255,201,60,.42)}
.ov .ov-dn{flex:1 1 auto;min-width:0;font:800 11.5px/1 var(--ff);color:#fff;
  letter-spacing:.05em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  text-shadow:0 1px 2px rgba(0,0,0,.6)}
.ov .ov-dr.you .ov-dn{color:var(--gold-l,#ffe79a)}
.ov .ov-dp{display:flex;gap:3px;flex:0 0 auto}
.ov .ov-dp b{width:15px;height:15px;border-radius:5px;display:flex;
  align-items:center;justify-content:center;
  font:800 8.5px/1 var(--ff);color:rgba(226,238,250,.6);
  background:rgba(0,0,0,.34);box-shadow:inset 0 0 0 1px rgba(255,255,255,.13)}
.ov .ov-dp b.done{color:#08182c;
  background:linear-gradient(180deg,var(--cl,#93cbff),var(--c,#2f8ffb));
  box-shadow:inset 0 1px 0 rgba(255,255,255,.4)}
.ov .ov-dp b.now{color:#3a2208;background:linear-gradient(180deg,#ffe79a,#ffc93c);
  box-shadow:0 0 0 2px rgba(255,201,60,.6);animation:ovNow 1.1s ease-in-out infinite}
@keyframes ovNow{0%,100%{box-shadow:0 0 0 2px rgba(255,201,60,.6)}
  50%{box-shadow:0 0 0 3px rgba(255,201,60,1),0 0 12px rgba(255,201,60,.8)}}
.ov .ov-dtag{flex:0 0 auto;font:800 7.5px/1 var(--ff);letter-spacing:.14em;
  text-transform:uppercase;color:#3a2208;padding:3px 5px 4px;border-radius:6px;
  background:linear-gradient(180deg,#ffe79a,#ffc93c)}

/* ---------------------------------------------------------- the pip strip
 *
 *   "On the draft, hide the draft order popup on the right side of the screen
 *    so the game can be full screen. Maybe just show the little icons shaped
 *    like users, and each is the colour of the other user, and it's within the
 *    normal box where the map is, so those icons highlight in order to show
 *    you whose turn it is for picking places. Then you can have a button that
 *    opens or closes the full pick order popup if users want, but it defaults
 *    to closed. Same goes for the players box on the standard map view."
 *
 * The rail was 186px of a 667px-wide phone — better than a quarter of the map,
 * standing there to say four names. The strip is the same information at the
 * size the answer actually needs: one coloured person per seat, in draft
 * order, and the one that is lit is the one picking. It rides INSIDE the title
 * plate, so it is inside the map box the player named, and so the board's top
 * padding — measured off that plate's bottom edge — already accounts for it
 * without a second measurement.
 *
 * The rail is still one tap away and still says everything it always did.
 */
/* A column against the right edge, vertically centred: one pip per seat and
   the key that opens the rail. Off the board, out of the way, and the only
   thing between the player and the whole island. */
.ov .ov-strip{position:absolute;right:var(--gR);top:50%;
  transform:translateY(-50%);z-index:6;
  display:flex;flex-direction:column;align-items:center;gap:6px;
  padding:6px 5px;border-radius:13px;
  background:linear-gradient(180deg,rgba(14,36,64,.86),rgba(6,18,36,.9));
  border:1.5px solid rgba(255,201,60,.26);
  box-shadow:0 4px 14px rgba(0,0,0,.45)}
.ov .ov-strip.hid{display:none}
.ov .ov-pips{display:flex;flex-direction:column;align-items:center;gap:5px}
.ov .ov-pip{position:relative;display:flex;flex-direction:column;align-items:center;
  gap:1px;padding:3px 4px;border-radius:9px;line-height:0;
  background:rgba(0,0,0,.28);box-shadow:inset 0 0 0 1px rgba(255,255,255,.1);
  opacity:.5;transition:opacity .18s ease,box-shadow .18s ease,transform .18s ease}
.ov .ov-pip.done{opacity:.78}
.ov .ov-pip.me{opacity:.8;box-shadow:inset 0 0 0 1.5px rgba(255,201,60,.6)}
/* Whose turn it is, and the whole point of the strip. Same gold pulse the rail
   pips use, so the two readings of the draft never disagree. */
.ov .ov-pip.now{opacity:1;transform:scale(1.06);
  background:rgba(255,201,60,.2);
  animation:ovNow 1.1s ease-in-out infinite}
.ov .ov-pip b{font:800 9px/1 var(--ff);color:#eaf2fb;
  text-shadow:0 1px 2px rgba(0,0,0,.7)}
.ov .ov-pip.me b{color:var(--gold-l,#ffe79a)}
.ov .ov-pip svg{display:block}
/* The way back to the full list. Deliberately quiet — it is an option, not an
   instruction — and it goes gold while the rail is up so the key doubles as
   the answer to "what is that panel and how do I get rid of it". */
.ov .ov-rk{min-width:26px;min-height:26px;width:26px;height:26px;padding:0;
  border-radius:8px;border:1.5px solid rgba(255,201,60,.34);
  background:linear-gradient(180deg,rgba(20,48,84,.94),rgba(7,22,44,.94));
  box-shadow:0 2px 6px rgba(0,0,0,.45);line-height:0}
.ov .ov-rk:active{transform:translateY(2px);box-shadow:0 1px 3px rgba(0,0,0,.45)}
.ov .ov-rk.on{border-color:rgba(255,201,60,.9);
  background:linear-gradient(180deg,rgba(255,201,60,.28),rgba(120,80,10,.5))}
.ov .ov-rk svg{display:block}
@media (max-height:500px),(max-width:1023px){
  .ov .ov-dr{padding:4px 5px 4px 10px}
  .ov .ov-dn{font-size:10.5px}
  .ov .ov-dp b{width:13px;height:13px;font-size:8px}
  .ov .ov-strip{gap:5px;padding:5px 4px}
  .ov .ov-pip{padding:2px 3px}
}
`;

/* Three stacked lines: "the list". */
const LIST_GLYPH =
  '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">' +
  '<path d="M5 7h14M5 12h14M5 17h14" fill="none" stroke="#ffe0a0" stroke-width="2.2" ' +
  'stroke-linecap="round"/></svg>';

function injectDraftStyle(doc) {
  if (!doc || !doc.head || !doc.createElement) return;
  if (doc.getElementById && doc.getElementById(DRAFT_STYLE_ID)) return;
  const s = doc.createElement('style');
  s.id = DRAFT_STYLE_ID;
  s.textContent = DRAFT_CSS;
  doc.head.appendChild(s);
}

const ORDINAL = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th'];

export function createOverview(root, state, game) {
  injectDraftStyle(root && root.ownerDocument ? root.ownerDocument : document);

  /* ------------------------------------------------------------- scaffold */
  const cv = el('canvas', { class: 'ov-cv' });
  const titleEl = el('span', { class: 'ov-title', text: 'Island Map' });
  const hintEl = el('span', { class: 'ov-hint', text: '' });

  const closeBtn = button('cbtn small ghost ov-x', {
    'aria-label': 'Close map', on: { click: () => cancel() }
  }, el('span', { class: 'cb-ico', html: icon('close', 18) }));

  const rail = el('div', { class: 'ov-rail plate lift' });

  /* The strip that replaces the rail on a phone, and the key that brings the
     rail back. They live in their own column against the right edge — see the
     .ov-strip note in DRAFT_CSS for why they are no longer over the board. */
  const pips = el('div', { class: 'ov-pips' });
  const railKey = button('ov-rk', {
    'aria-label': 'Show the player list',
    on: { click: () => setRail(!railOpen) }
  }, el('span', { html: LIST_GLYPH }));
  /* THE STRIP LIVES ON THE RIGHT EDGE, NOT OVER THE BOARD.
   *
   *   "I don't like that the sections on the top and bottom of the screen are
   *    covering valuable real estate of where I want to see visually the map.
   *    Can we move them... can the top and bottom middle boxes be somewhere
   *    else, like both minimal on the right side of the screen, but opens into
   *    a full sidebar with the expand button. I definitely don't need the
   *    boxes and the sidebar ever visible at the same time though, it's
   *    redundant."
   *
   * So: a narrow column against the right edge holding one coloured pip per
   * seat and the key that opens the rail — and the moment the rail is open the
   * column hides, because the rail says everything the pips do and more. Two
   * states, never both.
   *
   * The title plate that used to sit across the top centre is gone with it.
   * The board's top padding was measured off that plate's bottom edge, so
   * removing it is also most of "the map can start more zoomed in": there is
   * simply more frame now. */
  const strip = el('div', { class: 'ov-strip' }, pips, railKey);

  const selLabel = el('span', { class: 'ov-sel', text: 'Pick a spot' });
  const cancelBtn = button('stone', { on: { click: () => cancel() } }, 'Cancel');
  const confirmBtn = button('green off', { on: { click: () => commit() } },
    el('span', { class: 'sb-ico', html: icon('check', 18) }),
    el('span', { class: 'sb-lab', text: 'Confirm' }));
  const bar = el('div', { class: 'ov-bar plate lift hid' }, cancelBtn, selLabel, confirmBtn);

  /* NO TITLE PLATE AND NO SUB-LINE.
   *
   *   "The map when players are placing settlements does NOT need subtitles
   *    (this goes for the computer version too). It's text no one is reading
   *    and commentary no one cares about, and it goes by so fast that it's just
   *    distracting."
   *
   * Both are gone from the layout. `titleEl` and `hintEl` are still written to
   * — by this file, matchflow.js and netmatch.js, all of which have a name for
   * what the panel is doing — and both are kept in the tree, off screen, as the
   * panel's accessible name and description. The plate they used to sit in was
   * a bar across the top centre of the board, which is the third of the screen
   * a player most wants to see. The rail says whose turn it is; the pips say it
   * without opening anything. */
  const label = el('div', { class: 'ov-say' }, titleEl, hintEl);
  const wrap = el('div', {
    class: 'ov hid', 'data-ui': '', role: 'dialog', 'aria-label': 'Island map'
  }, cv, label, strip, closeBtn, rail, bar);
  root.appendChild(wrap);

  const ctx = (cv.getContext && cv.getContext('2d')) || null;

  /* ---------------------------------------------------------------- state */
  let openFlag = false;
  let mode = 'view';
  let opts = {};
  let targets = [];
  let sel = null;
  let hover = null;
  let hoverPulse = 0;
  let closeTimer = 0;
  let railRows = [];
  let railT = 0;
  let lastW = 0, lastH = 0, lastDpr = 0;

  /* The rail starts CLOSED on a phone and open on a desktop, and once the
     player has touched the key their answer stands for the rest of the match.
     760/400 is the same threshold ui-hud.css calls compact, so the map and the
     HUD agree about what a small screen is. */
  const compact = () => {
    const w = globalThis.innerWidth || wrap.clientWidth || 1024;
    const h = globalThis.innerHeight || wrap.clientHeight || 768;
    return w <= 760 || h <= 400;
  };
  let railOpen = !compact();
  let railChosen = false;

  const proj = {
    s: 1, ox: 0, oy: 0, w: 0, h: 0,
    /** Vertical squash, 1 flat. Owned by ovpan.js's two-finger tilt. */
    ky: 1,
    frame: { x: 0, y: 0, w: 0, h: 0 }
  };

  const paint = ctx ? createPainter(ctx, proj) : null;
  const PX = x => x * proj.s + proj.ox;
  const PY = z => z * proj.s + proj.oy;

  /* Drag / pinch / wheel / +- over the board; buttons and hint live in `wrap`. */
  /* The pad carries the HOME key as well as the zoom keys, because the map is
     the one panel that is up in every mode INCLUDING `draft-watch` — the state
     the player asked to be able to leave from, where the board is locked and
     there is otherwise no way back to the home screen. */
  const pan = createOvPan(cv, proj, {
    root: wrap,
    isOpen: () => openFlag,
    onLeave: typeof game.leaveMatch === 'function' ? () => game.leaveMatch() : null
  });

  /* The board itself — sea, island, tokens, docks, everyone's pieces — only
     changes when someone builds or the frame moves. Painting nineteen
     gradient-stacked hexes sixty times a second is a waste of a phone's
     battery, so it is baked once offscreen and blitted; only the pulsing
     targets and the moving settlers are redrawn per frame. */
  const bg = ctx && typeof document !== 'undefined' ? document.createElement('canvas') : null;
  const bgx = bg && bg.getContext ? bg.getContext('2d') : null;
  const bgPaint = bgx ? createPainter(bgx, proj) : null;
  let bgKey = '';
  /* The projection the bake was painted at. While a finger is down the board is
     blitted through the difference between this and the live one — one
     transformed drawImage, not nineteen gradient hexes a frame — and it re-bakes
     sharp the moment the gesture ends. */
  let bgS = 1, bgOX = 0, bgOY = 0, bgKY = 1, bgTilt = false;

  function boardKey() {
    let unlocked = 0;
    for (const p of state.players) unlocked += p.ports.size;
    return `${cv.width}x${cv.height}|${proj.s.toFixed(3)}|${proj.ox.toFixed(1)}|` +
      `${proj.oy.toFixed(1)}|${state.buildings.size}|${state.roadOwner.size}|` +
      `${state.robberTile}|${unlocked}|${(proj.ky || 1).toFixed(3)}`;
  }

  function bakeBoard() {
    const key = boardKey();
    if (key === bgKey) return;
    bgKey = key;
    bg.width = cv.width; bg.height = cv.height;
    const dpr = cv.width / Math.max(1, proj.w);
    bgx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bgx.clearRect(0, 0, proj.w, proj.h);
    /* THE BAKE IS TILTED, NOT THE BLIT.
     *
     * The offscreen canvas is exactly the size of the visible one, and a
     * tilted board is fitted at a LARGER world scale — so drawn flat it is
     * half as tall again as the canvas it is being baked into, and the bottom
     * two rows of hexes are clipped away before anything is blitted. Squashing
     * on the way IN is the only order that works. */
    // The water is not part of the board and is painted flat, edge to edge,
    // so the tilted bake has no unfilled band above and below it.
    bgPaint.drawSea();
    bgTilt = tiltIn(bgx);
    bgPaint.drawShelf();
    bgPaint.drawTiles();
    bgPaint.drawTokens();
    bgPaint.drawPorts(state);
    bgPaint.drawRoads(state);
    bgPaint.drawBuildings(state);
    bgPaint.drawRobber(state);
    if (bgTilt) bgx.restore();
    bgS = proj.s; bgOX = proj.ox; bgOY = proj.oy; bgKY = proj.ky;
  }

  /* ------------------------------------------------------- rail visibility
   *
   * `measure()` reserves the rail's width out of the map frame only when the
   * rail is up, so closing it does not leave a 186px column of dead sea — the
   * board is re-fitted into the whole panel on the very next frame. That is
   * the "so the game can be full screen" half of the request; the strip is the
   * other half.
   */
  function setRail(open) {
    railOpen = !!open;
    railChosen = true;
    applyRail();
    // The frame changed shape under the board: re-fit now rather than waiting
    // for a resize that may never come.
    measure();
  }

  function applyRail() {
    toggle(rail, 'hid', !railOpen);
    // Never both. The strip is the rail, collapsed.
    toggle(strip, 'hid', railOpen);
    toggle(railKey, 'on', railOpen);
    railKey.setAttribute('aria-label', railOpen ? 'Hide the player list' : 'Show the player list');
    railKey.setAttribute('aria-expanded', railOpen ? 'true' : 'false');
  }

  /* ------------------------------------------------------------ the strip
   * Rebuilt whole whenever its reading changes, which is at most five nodes
   * four times a second — cheaper than the bookkeeping to update it in place.
   */
  let pipSig = '';
  function buildPips(d) {
    const order = d
      ? (Array.isArray(d.order) && d.order.length ? d.order : (state.setupOrder || []))
      : null;
    const idx = d && Number.isFinite(d.index) ? d.index : 0;

    // Draft order during the draft, seating order otherwise. Each seat once.
    let seats = [];
    if (order && order.length) {
      for (const pid of order) if (seats.indexOf(pid) < 0) seats.push(pid);
    } else {
      seats = state.players.map(p => p.id);
    }

    const sig = seats.join(',') + '|' + (d
      ? `d${idx}.${d.pid}`
      : 'v' + state.players.map(p => scoreOf(state, p)).join('.'));
    if (sig === pipSig) return;
    pipSig = sig;

    while (pips.firstChild) pips.removeChild(pips.firstChild);
    for (const pid of seats) {
      const p = state.players[pid];
      if (!p) continue;
      let cls = 'ov-pip' + (pid === 0 ? ' me' : '');
      let badge = null;
      if (d) {
        if (pid === d.pid) cls += ' now';
        else {
          let last = -1;
          for (let i = 0; i < order.length; i++) if (order[i] === pid) last = i;
          if (last >= 0 && last < idx) cls += ' done';
        }
      } else {
        // Off the draft there is no "now", so the one number worth carrying is
        // the score — the rail's whole headline, in one glyph's worth of space.
        badge = el('b', { text: String(scoreOf(state, p)) });
      }
      pips.appendChild(el('span', {
        class: cls,
        title: pid === 0 ? 'You' : p.name,
        style: { '--c': p.color.css, '--cl': p.color.light }
      },
        el('span', { html: personPip(p.color.css, p.color.light, 18) }),
        badge));
    }
  }

  /* ------------------------------------------------------------ rail rows */
  function buildRail() {
    while (rail.firstChild) rail.removeChild(rail.firstChild);
    rail.appendChild(el('div', { class: 'rail-head', text: 'Players' }));
    railRows = state.players.map(p => {
      const vp = el('b', { class: 'rr-vp', text: '0' });
      const stats = el('div', { class: 'rr-stats' });
      const h = p.color.hex;
      const rgb = `${(h >> 16) & 255},${(h >> 8) & 255},${h & 255}`;
      const row = el('div', {
        class: 'rr' + (p.id === 0 ? ' me' : ''),
        style: {
          '--c': p.color.css, '--cl': p.color.light,
          '--ct': `rgba(${rgb},.40)`, '--ct2': `rgba(${rgb},.68)`
        }
      },
        el('div', { class: 'rr-top' },
          el('span', { class: 'rr-av', html: avatar(p.color.css, p.color.light, 30) }),
          el('div', { class: 'rr-id' },
            el('span', { class: 'rr-name', text: p.id === 0 ? 'You' : p.name }),
            el('span', { class: 'rr-col', text: p.color.key })),
          vp),
        stats);
      if (p.id === 0) row.appendChild(el('span', { class: 'rr-you', text: 'You' }));
      rail.appendChild(row);
      return { p, vp, stats, last: '' };
    });
  }

  /**
   * During the draft the rail stops being a scoreboard — nobody has a score
   * yet — and becomes the draft board: who is picking, in what order, which
   * two slots are yours, and how far through the eight picks we are. It is the
   * one piece of chrome that answers "why am I watching" when the shuffle put
   * the player last.
   */
  function buildDraftRail(d) {
    railRows = [];
    while (rail.firstChild) rail.removeChild(rail.firstChild);
    const order = Array.isArray(d.order) && d.order.length ? d.order : (state.setupOrder || []);
    const idx = Number.isFinite(d.index) ? d.index : 0;
    const total = order.length || 8;

    rail.appendChild(el('div', { class: 'ov-dhead', text: 'Opening Draft' }));
    rail.appendChild(el('div', {
      class: 'ov-dsub',
      text: `Pick ${Math.min(idx + 1, total)} of ${total}`
    }));

    // Seats in draft order, not player order — the strip reads top to bottom
    // exactly the way the first round runs.
    const seats = [];
    for (const pid of order) if (seats.indexOf(pid) < 0) seats.push(pid);

    for (const pid of seats) {
      const p = state.players[pid];
      if (!p) continue;
      const h = p.color.hex;
      const rgb = `${(h >> 16) & 255},${(h >> 8) & 255},${h & 255}`;
      const slots = [];
      for (let i = 0; i < order.length; i++) if (order[i] === pid) slots.push(i);
      const pipRow = el('div', { class: 'ov-dp' }, slots.map(i => el('b', {
        class: (i === idx ? 'now' : (i < idx ? 'done' : '')),
        text: String(i + 1)
      })));
      const me = pid === 0;
      const cls = 'ov-dr' + (me ? ' you' : '')
        + (pid === d.pid ? ' now' : '')
        + (slots[slots.length - 1] < idx ? ' done' : '');
      rail.appendChild(el('div', {
        class: cls,
        style: { '--c': p.color.css, '--cl': p.color.light, '--ct': `rgba(${rgb},.44)` }
      },
        el('span', { class: 'ov-dn', text: me ? 'You' : p.name }),
        pipRow,
        pid === d.pid ? el('span', { class: 'ov-dtag', text: me ? 'Go' : 'Now' }) : null));
    }

    const mySlots = [];
    for (let i = 0; i < order.length; i++) if (order[i] === 0) mySlots.push(i);
    if (mySlots.length) {
      rail.appendChild(el('div', {
        class: 'ov-dhead',
        style: 'padding-top:6px',
        text: `You pick ${mySlots.map(i => ORDINAL[i] || (i + 1)).join(' & ')}`
      }));
    }

    /* THE LIVE COMMENTARY IS GONE.
     *
     *   "It's text no one is reading and commentary no one cares about, and it
     *    goes by so fast that it's just distracting."
     *
     * It said things like "Eyeing the southern grainfields" and changed every
     * couple of seconds through a draft that takes under a minute. The rail
     * above it already names every seat, marks the one picking, and numbers
     * the eight slots — which is the information; that was the flavour. */
  }

  function refreshRail() {
    for (const r of railRows) {
      setText(r.vp, scoreOf(state, r.p));
      const key = `${r.p.longestRoadLen}|${r.p.knightsPlayed}|${r.p.hasLongestRoad}|` +
        `${r.p.hasLargestArmy}|${r.p.settlements.size}|${r.p.cities.size}`;
      if (key === r.last) continue;
      r.last = key;
      let h = '';
      h += `<i title="Settlements">${icon('house', 20)}<em>${r.p.settlements.size}</em></i>`;
      h += `<i title="Cities">${icon('castle', 20)}<em>${r.p.cities.size}</em></i>`;
      h += `<i class="aw ${r.p.hasLongestRoad ? 'won' : ''}" title="Longest road">` +
        `${icon('road', 20)}<em>${r.p.longestRoadLen}</em></i>`;
      h += `<i class="aw ${r.p.hasLargestArmy ? 'won' : ''}" title="Knights">` +
        `${icon('knight', 20)}<em>${r.p.knightsPlayed}</em></i>`;
      r.stats.innerHTML = h;
    }
  }

  /* ---------------------------------------------------------- projection */
  function measure() {
    const w = cv.clientWidth || wrap.clientWidth || 800;
    const h = cv.clientHeight || wrap.clientHeight || 400;
    proj.w = w; proj.h = h;
    // The DPR is part of the cache key, not just the payload: a browser zoom
    // or a window dragged between a Retina and a non-Retina display changes it
    // without changing the CSS size, and the backing store then keeps the old
    // scale until something else moves.
    const dpr = clamp(globalThis.devicePixelRatio || 1, 1, 2);
    if (ctx && (w !== lastW || h !== lastH || dpr !== lastDpr)) {
      cv.width = Math.max(1, Math.round(w * dpr));
      cv.height = Math.max(1, Math.round(h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      lastW = w; lastH = h; lastDpr = dpr;
    }
    // Matches the .ov-rail widths in ui.css (186px, 158px compact, 126px tiny).
    //
    // The rail used to vanish entirely under 560px, which was fine when this
    // panel was only ever a map. It is now also the PAUSE screen — "pausing the
    // game should still show me the full scores and board" — and a pause that
    // drops the scores on a phone is half a feature. It gets narrower instead
    // of going away; the board keeps the rest.
    //
    // Closed, it costs nothing: the frame runs the full width of the panel and
    // the pip strip carries the reading. Nothing is lost by that trade, which
    // is why the phone default is closed.
    const railW = railOpen ? (w > 760 ? 186 : (w > 560 ? 158 : 126)) : 0;
    /* Closed, the rail costs nothing but the pip column still stands on the
       right edge, and the board must not run under it. Measured rather than
       guessed — it is four pips tall and its width depends on whether the
       scores are showing. */
    let stripW = 0;
    if (!railOpen && strip && strip.getBoundingClientRect) {
      const sr = strip.getBoundingClientRect();
      if (sr.width) stripW = Math.round(sr.width) + 12;
    }

    // The framed map area: everything the board may occupy. The rail sits
    // outside it, so the frame never runs underneath the player list.
    const fx = 6;
    const fr = railW ? railW + 26 : Math.max(6, stripW);
    const f = proj.frame;
    f.x = fx; f.y = 6;
    f.w = Math.max(80, w - fx - fr);
    f.h = Math.max(80, h - 12);

    // The confirm bar only exists in a placement mode; in plain view the board
    // gets that space back so it fills the frame instead of floating in it.
    // The two paddings are read off the real elements rather than guessed:
    // the dock tags hang off the coast and were sliding under the title plate
    // at 375px tall, where a guessed constant is always wrong by a few pixels.
    /* THE BOARD STARTS BIGGER, because there is less on top of it.
     *
     *   "That way the map can start more zoomed in."
     *
     * `padT` used to be measured off the bottom edge of the title plate, which
     * meant a two-line headline shrank the island. There is no plate now, so
     * the only thing to clear at the top is the close key in the corner — and
     * that is a corner, not a band. 12 top, 10 bottom in view mode, and the
     * side padding halved: the same island, drawn about a fifth larger. */
    let padT = 12;
    let padB = mode === 'view' ? 10 : 54;
    const padX = 8;
    if (cv.getBoundingClientRect) {
      const base = cv.getBoundingClientRect();
      if (mode !== 'view' && bar.getBoundingClientRect) {
        const r = bar.getBoundingClientRect();
        if (r.height) padB = Math.max(padB, (f.y + f.h) - (r.top - base.top) + 8);
      }
    }
    const availW = Math.max(60, f.w - padX * 2);
    const availH = Math.max(60, f.h - padT - padB);
    // Just enough slack for the dock tags that hang off the coast — any more
    // and the board starts floating in dead blue again.
    const bw = BOUNDS.width + HEX_SIZE * 1.1;
    const bd = BOUNDS.depth + HEX_SIZE * 1.1;
    // The fit-to-frame projection, unchanged — where the board sits with no
    // gesture on it. ovpan.js takes it from here and writes the live `proj`.
    /* Fit against the TILTED height. Squashing the board to 55% and then
       still fitting it as if it were flat would waste exactly the space the
       tilt was asked for — the whole point is to see more of the island, not
       the same amount of it lower down. */
    const ky = proj.ky || 1;
    const s = Math.min(availW / bw, availH / (bd * ky));
    pan.apply({
      s,
      ox: f.x + padX + availW / 2 - BOUNDS.cx * s,
      oy: f.y + padT + availH / 2 - BOUNDS.cz * s
    });
    applyRail();
  }

  /* ------------------------------------------------------------ placement
   *
   * Every pixel of the placement layer — the corner rings, the road slabs, the
   * Knight marks, the confirm preview and the rival telegraph — is painted by
   * `./ovtargets.js`. It moved out when this file crossed the 900-line budget,
   * and the split fell where it should: this file decides WHAT is legal and
   * what the finger touched, that one decides what it looks like.
   */
  const tg = ctx ? createTargets(ctx, proj, paint, state) : null;
  const targetR = () => (tg ? tg.targetR() : 0);
  const roadPaintW = () => (tg ? tg.roadBodyW() : 0);
  const hitRadius = () => (tg ? tg.hitRadius() : 26);

  /** The frame's snapshot, handed to the painter. Allocated once. */
  const view = { mode, targets, sel, hover, pulse: 0, spotlight: null };
  function snapshot(pulse) {
    view.mode = mode;
    view.targets = targets;
    view.sel = sel;
    view.hover = hover;
    view.pulse = pulse;
    view.spotlight = opts.spotlight || null;
    return view;
  }


  /* THE TILT, APPLIED ONCE, HERE.
   *
   * Everything the painters draw goes through `proj`, so a vertical squash
   * could have been folded into their projection helpers — at the cost of
   * touching every hex vertex, token radius, dock and road slab in ovmap.js
   * and hoping none of them was missed. One canvas transform about the middle
   * of the frame does the same thing to all of it, atomically.
   *
   * The two things that must NOT be squashed bracket it: the sea (a flat fill
   * that has to reach the frame's edges however far the board is tilted) is
   * painted first, and the frame itself (a rounded rectangle, not part of the
   * board) is painted after. */
  /* Squashed about the BOARD's own centre, not the frame's. The fit in
     `measure()` places the island's middle at a known y and sizes it to the
     available height; squashing about any other line moves that middle and
     the arithmetic stops being true, which is a board that overflows the
     bottom of the frame by however far the two centres disagreed. */
  const tiltCentre = () => proj.oy + BOUNDS.cz * proj.s;

  function tiltIn(c) {
    const ky = proj.ky || 1;
    if (ky >= 0.999) return false;
    const cy = tiltCentre();
    c.save();
    c.translate(0, cy);
    c.scale(1, ky);
    c.translate(0, -cy);
    return true;
  }

  function draw(pulse) {
    if (!ctx) return;
    measure();
    ctx.clearRect(0, 0, proj.w, proj.h);
    if (bgx) {
      /* Re-bake when the board is still, and ALWAYS when the tilt has moved:
         the ride-along blit is a uniform scale, which cannot express a change
         in the squash, and the tilt is the one gesture where the thing being
         changed is what you are looking at. */
      if (!pan.gesturing || !bgKey || bgKY !== proj.ky) bakeBoard();
      // Water first: once the board has been dragged the bake no longer
      // reaches the frame edge, and what it leaves behind is open ocean.
      paint.fillSea();
      const k = bgS > 0 ? proj.s / bgS : 1;
      ctx.save();
      ctx.translate(proj.ox - bgOX * k, proj.oy - bgOY * k);
      ctx.scale(k, k);
      ctx.drawImage(bg, 0, 0, proj.w, proj.h);
      ctx.restore();
    } else {
      paint.drawSea();
      const t = tiltIn(ctx);
      paint.drawShelf();
      paint.drawTiles();
      paint.drawTokens();
      paint.drawPorts(state);
      paint.drawRoads(state);
      paint.drawBuildings(state);
      paint.drawRobber(state);
      if (t) ctx.restore();
    }
    // The live layer rides the same squash as the board it sits on; the frame
    // is not part of the board and stays a rectangle.
    const tilted = tiltIn(ctx);
    const v = snapshot(pulse);
    tg.drawSpotlight(v);
    tg.drawTargets(v);
    paint.drawSettlers(state);
    if (tilted) ctx.restore();
    paint.drawFrame(proj.frame);
  }

  /* -------------------------------------------------------------- picking
     Everything below works in FLAT board space, so a screen point has to come
     back out of the tilt before it is compared with anything. One place, and
     it is the inverse of `tiltIn`. */
  /** Flat board space -> the squashed canvas. The inverse of `unTilt`. */
  function tiltY(py) {
    const ky = proj.ky || 1;
    if (ky >= 0.999) return py;
    const cy = tiltCentre();
    return (py - cy) * ky + cy;
  }

  function unTilt(py) {
    const ky = proj.ky || 1;
    if (ky >= 0.999) return py;
    const cy = tiltCentre();
    return (py - cy) / ky + cy;
  }

  function pick(px, py) {
    if (!targets.length) return null;
    // >= 44px across at 667x375, and nearest-wins beyond that, so a fat finger
    // between two corners always lands on the closer one.
    const thresh = hitRadius();
    let best = null, bd = thresh * thresh;
    if (mode === 'place-robber') {
      bd = (HEX_SIZE * proj.s * 0.92) ** 2;
      for (const id of targets) {
        const t = tiles[id];
        const d = (PX(t.x) - px) ** 2 + (PY(t.z) - py) ** 2;
        if (d < bd) { bd = d; best = id; }
      }
      return best;
    }
    const src = mode === 'place-road' ? edges : intersections;
    for (const id of targets) {
      const o = src[id];
      const d = (PX(o.x) - px) ** 2 + (PY(o.z) - py) ** 2;
      if (d < bd) { bd = d; best = id; }
    }
    return best;
  }

  /**
   * A tap picks a spot. A SECOND TAP ON THE SAME SPOT PLACES IT.
   *
   *   "When I'm placing settlements, roads and cities, make it so I can double
   *    click if I want instead of needing to scroll and click Confirm."
   *
   * The board fills the panel and the confirm bar sits under it, so choosing a
   * corner and then committing it meant a trip from wherever the finger already
   * was, down to a button, on every single placement — and on a phone, often a
   * scroll to get there. The bar is still the whole truth (it names the spot,
   * and Cancel lives on it) and it still works exactly as before; this is the
   * shortcut for when the player already knows where the piece is going.
   *
   * It is a RE-TAP, not a timed double-click: no window to hit, no difference
   * between a fast mouse double-click and two deliberate taps a second apart,
   * and it works the same under a finger as under a cursor. A tap on any OTHER
   * legal spot just moves the selection, so the way out of a wrong choice is to
   * pick a different one or press Cancel — the same as it always was, minus the
   * old "tap it again to deselect", which nothing ever advertised and which
   * this replaces.
   *
   * `commit()` is the same call the Confirm button makes, so every rule check,
   * payment and `onConfirm` hook is identical down both routes.
   */
  onTap(cv, e => {
    if (!openFlag || mode === 'view' || mode === 'draft-watch') return;
    // A drag that moved the board is not a choice of corner.
    if (pan.moved) return;
    const r = cv.getBoundingClientRect ? cv.getBoundingClientRect() : { left: 0, top: 0 };
    const hit = pick(e.clientX - r.left, unTilt(e.clientY - r.top));
    if (hit === null || hit === undefined) return;
    if (hit === sel) { commit(); return; }
    select(hit);
  });

  // Pointer hover is a desktop nicety; on touch the pointer never moves
  // without a tap, so `hover` simply tracks the finger and clears on lift.
  if (cv.addEventListener) {
    cv.addEventListener('pointermove', e => {
      if (!openFlag || !targets.length) { hover = null; return; }
      const r = cv.getBoundingClientRect ? cv.getBoundingClientRect() : { left: 0, top: 0 };
      hover = pick(e.clientX - r.left, unTilt(e.clientY - r.top));
    });
    cv.addEventListener('pointerleave', () => { hover = null; });
  }

  function select(id) {
    sel = id;
    toggle(confirmBtn, 'off', sel === null);
    if (confirmBtn.disabled !== undefined) confirmBtn.disabled = sel === null;
    // `armed` turns the label gold once a spot is chosen, which is the cue that
    // the re-tap route is live: something is selected, so tapping it again
    // places it. The text still names the spot — the Confirm button beside it
    // is the other half of the same sentence.
    setText(selLabel, sel === null
      ? (opts.pickLabel || 'Pick a spot')
      : describe(sel));
    toggle(selLabel, 'armed', sel !== null);
    ghost();
  }

  function describe(id) {
    if (mode === 'place-robber') {
      const t = tiles[id];
      return `${t.terrain.toUpperCase()} ${t.number || ''}`.trim();
    }
    if (mode === 'place-road') return 'Road ready';
    if (mode === 'place-city') return 'Upgrade this settlement';
    const n = intersections[id];
    const kinds = n.tiles.map(t => tiles[t].terrain).join(' · ');
    return kinds.toUpperCase();
  }

  function ghost() {
    const st = game.world && game.world.structures;
    if (!st) return;
    try {
      if (sel === null) { if (st.clearGhost) st.clearGhost(); return; }
      if (mode === 'place-road') { if (st.ghostRoad) st.ghostRoad(sel, 0); }
      else if (mode === 'place-settlement' || mode === 'place-city') {
        if (st.ghostSettlement) st.ghostSettlement(sel, 0);
      }
    } catch (err) { /* the 3D preview is optional */ }
  }

  /* ------------------------------------------------------- open / commit */
  function computeTargets(m, o) {
    const setup = !!o.setup;
    const anchor = o.anchor === undefined ? -1 : o.anchor;
    if (m === 'place-road') return legalRoads(state, 0, setup, anchor);
    if (m === 'place-settlement') return legalSettlements(state, 0, setup);
    if (m === 'place-city') return legalCities(state, 0);
    if (m === 'place-robber') return tiles.filter(t => t.id !== state.robberTile).map(t => t.id);
    return [];
  }

  /**
   * Open — or, if we are already open, re-dress in place.
   *
   * The in-place path is what makes the opening draft one continuous view.
   * Nothing touches `hid` / `on` / `setOverview` while already open, so the
   * 3D camera never leaves the board framing and the panel never re-runs its
   * scale-in transition between two consecutive picks.
   */
  function open(m, o) {
    const wasOpen = openFlag;
    const nextMode = MODE_INFO[m] ? m : 'view';
    const nextOpts = o || {};
    const nextTargets = computeTargets(nextMode, nextOpts);

    if (nextMode !== 'view' && nextMode !== 'draft-watch' && !nextTargets.length) {
      // Nothing legal — leave whatever is on screen exactly as it was.
      if (game.toast) game.toast('No legal spot for that right now', 'warn');
      return false;
    }

    mode = nextMode;
    opts = nextOpts;
    targets = nextTargets;
    sel = null;
    hover = null;

    const info = MODE_INFO[mode];
    setText(titleEl, opts.title || info.title);
    setText(hintEl, opts.hint || info.hint);
    const barred = mode !== 'view' && mode !== 'draft-watch';
    toggle(bar, 'hid', !barred);
    toggle(closeBtn, 'hid', mode !== 'view' && opts.cancellable === false);
    toggle(cancelBtn, 'hid', opts.cancellable === false);
    select(null);
    if (opts.draft) buildDraftRail(opts.draft);
    else { buildRail(); refreshRail(); }
    // The strip reads the same source as the rail and is up whether or not the
    // rail is. A player who has not touched the key gets the current viewport's
    // answer every time the map opens, so rotating a phone is not a trap.
    if (!railChosen) railOpen = !compact();
    pipSig = '';
    buildPips(opts.draft || null);

    openFlag = true;
    closeTimer = 0;
    if (wasOpen) return true;

    // A fresh open starts on the whole board; re-dressing in place (the draft,
    // pick to pick) deliberately keeps whatever the player has pushed it to.
    pan.reset();
    toggle(wrap, 'hid', false);
    lastW = 0; lastH = 0;
    // Next frame so the transition actually runs.
    setTimeout(() => toggle(wrap, 'on', openFlag), 16);
    if (game.camera && game.camera.setOverview) game.camera.setOverview(true);
    return true;
  }

  function close() {
    if (!openFlag) return;
    openFlag = false;
    sel = null;
    hover = null;
    ghost();
    targets = [];
    opts = {};
    toggle(wrap, 'on', false);
    if (pan.disarm) pan.disarm();
    closeTimer = 0.26;
    if (game.camera && game.camera.setOverview) game.camera.setOverview(false);
  }

  function cancel() {
    if (opts.onCancel) { try { opts.onCancel(); } catch (e) { /* ignore */ } }
    close();
  }

  function commit() {
    if (sel === null) return false;
    const id = sel;
    let ok = false;
    if (typeof opts.onConfirm === 'function') {
      ok = opts.onConfirm(id) !== false;
    } else if (netCommit(mode, id)) {
      // ONLINE, THIS PANEL DOES NOT PLACE ANYTHING. With no onConfirm supplied
      // — which is the normal route for a HUD build card — the branches below
      // would write a piece onto the board that no server has agreed to yet.
      // netCommit sends it instead and the piece arrives with the server's
      // own `build` event, through the same handler that draws it offline.
      ok = true;
    } else if (mode === 'place-road') {
      ok = placeRoad(state, 0, id, !!opts.free, opts.anchor === undefined ? -1 : opts.anchor);
    } else if (mode === 'place-settlement') {
      ok = placeSettlement(state, 0, id, !!opts.free);
    } else if (mode === 'place-city') {
      ok = upgradeCity(state, 0, id, !!opts.free);
    } else if (mode === 'place-robber') {
      ok = playKnight(state, 0, id);
    }
    if (!ok) {
      if (game.toast) game.toast('You cannot build there', 'bad');
      select(null);
      return false;
    }
    // `keepOpen` belongs to the opening draft: the caller is about to hand the
    // very same panel its next job (settlement -> road, or the wait for the
    // next drafter), so closing here would be a visible round trip out to the
    // third-person camera and straight back.
    if (opts.keepOpen) { select(null); targets = []; return true; }
    close();
    return true;
  }

  /* ----------------------------------------------------------------- loop */
  function update(dt) {
    const d = Number.isFinite(dt) ? dt : 1 / 60;
    if (!openFlag) {
      if (closeTimer > 0) {
        closeTimer -= d;
        if (closeTimer <= 0) toggle(wrap, 'hid', true);
      }
      return;
    }
    hoverPulse += d;
    railT += d;
    if (railT > 0.25) { railT = 0; refreshRail(); buildPips(opts.draft || null); }
    draw(hoverPulse);
  }

  return {
    open, close, update,
    get isOpen() { return openFlag; },
    get mode() { return mode; },
    /** Pan / zoom of the board — pose, clamp box, and whether it is on screen. */
    get panInfo() { return pan.info; },
    /** Capture-rig hook: one notch out, so a rig can walk to the floor. */
    zoomOutForTest() { return pan.zoomAt(1 / 1.22); },

    /**
     * Every size the placement layer paints at, in canvas css px.
     *
     * Nothing in the game reads this. It exists so a capture rig can REPORT
     * "the choose-a-spot ring is 8px across and the placed settlement is 22px
     * across at 667x375" rather than re-deriving the formulas and drifting from
     * them. Each field is produced by the same function the painter calls.
     */
    get metrics() {
      return {
        mode,
        s: +proj.s.toFixed(2),
        targets: targets.length,
        sel,
        /** where the chosen target sits on the canvas, so a rig can crop it */
        selXY: sel === null || sel === undefined ? null : (() => {
          const o = mode === 'place-road' ? edges[sel]
            : (mode === 'place-robber' ? tiles[sel] : intersections[sel]);
          return o ? [Math.round(PX(o.x)), Math.round(PY(o.z))] : null;
        })(),
        ids: targets.slice(0, 80),
        /** choose-a-spot ring radius */
        targetR: +targetR().toFixed(1),
        /** PLACED settlement pip radius — deliberately unchanged */
        pipR: +pipRadius(proj).toFixed(1),
        /** painted width of a road target's coloured core */
        roadPaintW: +roadPaintW().toFixed(1),
        /** the whole road slab, casing included */
        roadSlabW: +(roadPaintW() + 4.5).toFixed(1),
        /** how long an edge is on screen, for scale */
        roadEdgePx: +(HEX_SIZE * proj.s).toFixed(1),
        /** The vertical squash the tilt is applying, 1 flat. */
        ky: +(proj.ky || 1).toFixed(3),
        /** What the canvas was really scaled by while the board was drawn and
         *  while a number disc was — the board leans, the discs stand up. */
        /* The BAKE painter when there is one: that is the context the board
           and its tokens are actually drawn into, and reporting the live
           painter instead reports a code path that did not run. */
        scales: (bgx ? bgPaint : paint) ? (bgx ? bgPaint : paint).scales : null,
        /** width of the tap zone around a target, corner to corner */
        hitPx: +(2 * hitRadius()).toFixed(1)
      };
    },
    resetView() { return pan.reset(true); },
    select, commit,
    destroy() {
      pan.destroy();
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
    }
  };
}

export default createOverview;
