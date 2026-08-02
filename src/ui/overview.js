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
 * along, the Raider marks, the confirm preview and the rival telegraph). This
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
import { icon, avatar } from './icons.js';
import { createPainter, pipRadius } from './ovmap.js';
import { createTargets } from './ovtargets.js';
import { createOvPan } from './ovpan.js';

const MODE_INFO = {
  'view':              { title: 'Island Map', hint: 'Drag the board · pinch to zoom' },
  'place-road':        { title: 'Place a Road', hint: 'Tap a glowing edge' },
  'place-settlement':  { title: 'Place a Settlement', hint: 'Tap a glowing corner' },
  'place-city':        { title: 'Upgrade to a City', hint: 'Tap one of your settlements' },
  'place-robber':      { title: 'Send the Raider', hint: 'Tap a region to block' },
  'draft-watch':       { title: 'Opening Draft', hint: 'Watch the board' }
};

/* The draft rail lives here rather than in ui.css. Scoped under `.ov`. */
const DRAFT_STYLE_ID = 'ov-draft-style';
const DRAFT_CSS = `
/* The draft narration lives in this plate, and the board's height is measured
   off its bottom edge — so a headline that wraps to two lines shrinks the map.
   Both lines are capped and clipped to one line each. */
.ov .ov-title{max-width:min(46vw,360px);text-align:center;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ov .ov-hint{max-width:min(50vw,400px);text-align:center;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
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
  background:linear-gradient(180deg,var(--cl,#7fb2f0),var(--c,#3b7fd4) 55%);
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
  background:linear-gradient(180deg,var(--cl,#7fb2f0),var(--c,#3b7fd4));
  box-shadow:inset 0 1px 0 rgba(255,255,255,.4)}
.ov .ov-dp b.now{color:#3a2208;background:linear-gradient(180deg,#ffe79a,#ffc93c);
  box-shadow:0 0 0 2px rgba(255,201,60,.6);animation:ovNow 1.1s ease-in-out infinite}
@keyframes ovNow{0%,100%{box-shadow:0 0 0 2px rgba(255,201,60,.6)}
  50%{box-shadow:0 0 0 3px rgba(255,201,60,1),0 0 12px rgba(255,201,60,.8)}}
.ov .ov-dnote{margin-top:7px;padding:6px 8px 7px;border-radius:9px;
  background:rgba(0,0,0,.34);box-shadow:inset 0 1px 0 rgba(255,255,255,.1);
  font:700 9.5px/1.35 var(--ff);letter-spacing:.05em;
  color:rgba(232,242,252,.92);text-align:center}
.ov .ov-dtag{flex:0 0 auto;font:800 7.5px/1 var(--ff);letter-spacing:.14em;
  text-transform:uppercase;color:#3a2208;padding:3px 5px 4px;border-radius:6px;
  background:linear-gradient(180deg,#ffe79a,#ffc93c)}
@media (max-height:400px){
  .ov .ov-dr{padding:4px 5px 4px 10px}
  .ov .ov-dn{font-size:10.5px}
  .ov .ov-dp b{width:13px;height:13px;font-size:8px}
}
`;

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

  const selLabel = el('span', { class: 'ov-sel', text: 'Pick a spot' });
  const cancelBtn = button('stone', { on: { click: () => cancel() } }, 'Cancel');
  const confirmBtn = button('green off', { on: { click: () => commit() } },
    el('span', { class: 'sb-ico', html: icon('check', 18) }),
    el('span', { class: 'sb-lab', text: 'Confirm' }));
  const bar = el('div', { class: 'ov-bar plate lift hid' }, cancelBtn, selLabel, confirmBtn);

  const wrap = el('div', { class: 'ov hid', 'data-ui': '' },
    cv,
    el('div', { class: 'ov-top plate' }, titleEl, hintEl),
    closeBtn, rail, bar);
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
  let lastW = 0, lastH = 0;

  const proj = { s: 1, ox: 0, oy: 0, w: 0, h: 0, frame: { x: 0, y: 0, w: 0, h: 0 } };

  const paint = ctx ? createPainter(ctx, proj) : null;
  const PX = x => x * proj.s + proj.ox;
  const PY = z => z * proj.s + proj.oy;

  /* Drag / pinch / wheel / +- over the board; buttons and hint live in `wrap`. */
  const pan = createOvPan(cv, proj, { root: wrap, isOpen: () => openFlag });

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
  let bgS = 1, bgOX = 0, bgOY = 0;

  function boardKey() {
    let unlocked = 0;
    for (const p of state.players) unlocked += p.ports.size;
    return `${cv.width}x${cv.height}|${proj.s.toFixed(3)}|${proj.ox.toFixed(1)}|` +
      `${proj.oy.toFixed(1)}|${state.buildings.size}|${state.roadOwner.size}|` +
      `${state.robberTile}|${unlocked}`;
  }

  function bakeBoard() {
    const key = boardKey();
    if (key === bgKey) return;
    bgKey = key;
    bg.width = cv.width; bg.height = cv.height;
    const dpr = cv.width / Math.max(1, proj.w);
    bgx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bgx.clearRect(0, 0, proj.w, proj.h);
    bgPaint.drawSea();
    bgPaint.drawShelf();
    bgPaint.drawTiles();
    bgPaint.drawTokens();
    bgPaint.drawPorts(state);
    bgPaint.drawRoads(state);
    bgPaint.drawBuildings(state);
    bgPaint.drawRobber(state);
    bgS = proj.s; bgOX = proj.ox; bgOY = proj.oy;
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

    // The live commentary. ui.css hides `.ov-hint` entirely at 375px tall to
    // buy the board height back, so the sub-line that says what is actually
    // happening — "Eyeing the southern grainfields", "You are up next" — has
    // to live somewhere that survives the short viewport. This is it.
    if (d.note) rail.appendChild(el('div', { class: 'ov-dnote', text: d.note }));
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
    if (ctx && (w !== lastW || h !== lastH)) {
      const dpr = clamp(globalThis.devicePixelRatio || 1, 1, 2);
      cv.width = Math.max(1, Math.round(w * dpr));
      cv.height = Math.max(1, Math.round(h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      lastW = w; lastH = h;
    }
    // Matches the .ov-rail widths in ui.css (186px, 158px compact, 126px tiny).
    //
    // The rail used to vanish entirely under 560px, which was fine when this
    // panel was only ever a map. It is now also the PAUSE screen — "pausing the
    // game should still show me the full scores and board" — and a pause that
    // drops the scores on a phone is half a feature. It gets narrower instead
    // of going away; the board keeps the rest.
    const railW = w > 760 ? 186 : (w > 560 ? 158 : 126);

    // The framed map area: everything the board may occupy. The rail sits
    // outside it, so the frame never runs underneath the player list.
    const fx = 6;
    const fr = railW ? railW + 26 : 6;
    const f = proj.frame;
    f.x = fx; f.y = 6;
    f.w = Math.max(80, w - fx - fr);
    f.h = Math.max(80, h - 12);

    // The confirm bar only exists in a placement mode; in plain view the board
    // gets that space back so it fills the frame instead of floating in it.
    // The two paddings are read off the real elements rather than guessed:
    // the dock tags hang off the coast and were sliding under the title plate
    // at 375px tall, where a guessed constant is always wrong by a few pixels.
    let padT = 34;
    let padB = mode === 'view' ? 14 : 54;
    const padX = 16;
    if (cv.getBoundingClientRect) {
      const base = cv.getBoundingClientRect();
      const top = wrap.querySelector('.ov-top');
      if (top && top.getBoundingClientRect) {
        const r = top.getBoundingClientRect();
        if (r.height) padT = Math.max(padT, r.bottom - base.top + 8 - f.y);
      }
      if (mode !== 'view' && bar.getBoundingClientRect) {
        const r = bar.getBoundingClientRect();
        if (r.height) padB = Math.max(padB, (f.y + f.h) - (r.top - base.top) + 8);
      }
    }
    const availW = Math.max(60, f.w - padX * 2);
    const availH = Math.max(60, f.h - padT - padB);
    // Just enough slack for the dock tags that hang off the coast — any more
    // and the board starts floating in dead blue again.
    const bw = BOUNDS.width + HEX_SIZE * 1.35;
    const bd = BOUNDS.depth + HEX_SIZE * 1.35;
    // The fit-to-frame projection, unchanged — where the board sits with no
    // gesture on it. ovpan.js takes it from here and writes the live `proj`.
    const s = Math.min(availW / bw, availH / bd);
    pan.apply({
      s,
      ox: f.x + padX + availW / 2 - BOUNDS.cx * s,
      oy: f.y + padT + availH / 2 - BOUNDS.cz * s
    });
    toggle(rail, 'hid', false);
  }

  /* ------------------------------------------------------------ placement
   *
   * Every pixel of the placement layer — the corner rings, the road slabs, the
   * Raider marks, the confirm preview and the rival telegraph — is painted by
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


  function draw(pulse) {
    if (!ctx) return;
    measure();
    if (bgx) {
      // Re-bake when the board is still; ride the last bake while it moves.
      if (!pan.gesturing || !bgKey) bakeBoard();
      ctx.clearRect(0, 0, proj.w, proj.h);
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
      paint.drawShelf();
      paint.drawTiles();
      paint.drawTokens();
      paint.drawPorts(state);
      paint.drawRoads(state);
      paint.drawBuildings(state);
      paint.drawRobber(state);
    }
    const v = snapshot(pulse);
    tg.drawSpotlight(v);
    tg.drawTargets(v);
    paint.drawSettlers(state);
    paint.drawFrame(proj.frame);
  }

  /* -------------------------------------------------------------- picking */
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

  onTap(cv, e => {
    if (!openFlag || mode === 'view' || mode === 'draft-watch') return;
    // A drag that moved the board is not a choice of corner.
    if (pan.moved) return;
    const r = cv.getBoundingClientRect ? cv.getBoundingClientRect() : { left: 0, top: 0 };
    const hit = pick(e.clientX - r.left, e.clientY - r.top);
    if (hit === null || hit === undefined) return;
    select(hit === sel ? null : hit);
  });

  // Pointer hover is a desktop nicety; on touch the pointer never moves
  // without a tap, so `hover` simply tracks the finger and clears on lift.
  if (cv.addEventListener) {
    cv.addEventListener('pointermove', e => {
      if (!openFlag || !targets.length) { hover = null; return; }
      const r = cv.getBoundingClientRect ? cv.getBoundingClientRect() : { left: 0, top: 0 };
      hover = pick(e.clientX - r.left, e.clientY - r.top);
    });
    cv.addEventListener('pointerleave', () => { hover = null; });
  }

  function select(id) {
    sel = id;
    toggle(confirmBtn, 'off', sel === null);
    if (confirmBtn.disabled !== undefined) confirmBtn.disabled = sel === null;
    setText(selLabel, sel === null
      ? (opts.pickLabel || 'Pick a spot')
      : describe(sel));
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
    if (railT > 0.25) { railT = 0; refreshRail(); }
    draw(hoverPulse);
  }

  return {
    open, close, update,
    get isOpen() { return openFlag; },
    get mode() { return mode; },
    /** Pan / zoom of the board — pose, clamp box, and whether it is on screen. */
    get panInfo() { return pan.info; },

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
