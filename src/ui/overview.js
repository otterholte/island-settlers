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
 * Painting lives in ./ovmap.js. Nothing writes text onto the hexes: the board
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
import { createPainter } from './ovmap.js';

const MODE_INFO = {
  'view':              { title: 'Island Map', hint: 'Tap the map to look around' },
  'place-road':        { title: 'Place a Road', hint: 'Tap a glowing edge' },
  'place-settlement':  { title: 'Place a Settlement', hint: 'Tap a glowing corner' },
  'place-city':        { title: 'Upgrade to a City', hint: 'Tap one of your settlements' },
  'place-robber':      { title: 'Send the Raider', hint: 'Tap a region to block' },
  'draft-watch':       { title: 'Opening Draft', hint: 'Watch the board' }
};

/* The draft rail lives here rather than in ui.css so the UI agent's stylesheet
   is never touched. Everything is scoped under `.ov`. */
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

  /* The board itself — sea, island, tokens, docks, everyone's pieces — only
     changes when someone builds or the frame is resized. Painting nineteen
     gradient-stacked hexes sixty times a second is a waste of a phone's
     battery, so it is baked once into an offscreen canvas and blitted. Only
     the pulsing targets and the moving settlers are redrawn per frame. */
  const bg = ctx && typeof document !== 'undefined' ? document.createElement('canvas') : null;
  const bgx = bg && bg.getContext ? bg.getContext('2d') : null;
  const bgPaint = bgx ? createPainter(bgx, proj) : null;
  let bgKey = '';

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
    // Matches the .ov-rail widths in ui.css (186px, 158px on compact phones).
    const railW = w > 560 ? (w <= 760 ? 158 : 186) : 0;

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
    proj.s = Math.min(availW / bw, availH / bd);
    proj.ox = f.x + padX + availW / 2 - BOUNDS.cx * proj.s;
    proj.oy = f.y + padT + availH / 2 - BOUNDS.cz * proj.s;
    toggle(rail, 'hid', railW === 0);
  }

  /* ------------------------------------------------------------ placement */

  /* A corner target is a ring rather than a disc, and stays hollow, because
     fifty-odd of them are legal at the opening of a draft and a field of solid
     discs hides the terrain the player is trying to judge.

     A previous pass roughly doubled these to 0.38 of the distance between
     neighbouring corners, which at 667x375 put a 22px ring on a 29px corner
     spacing — the rings all but touched and the board disappeared under them.
     0.21 puts them back to about half that, so there is real hex between two
     targets again. What the finger gets is unchanged: `pick()` below owns the
     hit test and still claims a 52px-wide zone around every corner, nearest
     wins, so shrinking the paint costs no tappability at all. */
  const targetR = () => Math.max(6.5, HEX_SIZE * proj.s * 0.21);

  /** Legal targets: unmistakable, inviting, and never mistakable for a piece
      that is already on the board. */
  function drawTargets(pulse) {
    if (!targets.length) return;
    const s = proj.s;
    const beat = 0.5 + 0.5 * Math.sin(pulse * 4.2);
    const glow = 0.5 + 0.5 * beat;
    const halo = (pulse * 0.9) % 1;

    for (const id of targets) {
      const chosen = id === sel;
      const warm = !chosen && id === hover;
      ctx.save();
      if (mode === 'place-road') {
        const e = edges[id];
        const A = intersections[e.a], B = intersections[e.b];
        ctx.lineCap = 'round';
        ctx.globalAlpha = chosen ? 1 : (warm ? 0.95 : 0.55 + 0.35 * beat);
        ctx.beginPath(); ctx.moveTo(PX(A.x), PY(A.z)); ctx.lineTo(PX(B.x), PY(B.z));
        ctx.lineWidth = Math.max(11, s * 1.5);
        ctx.strokeStyle = 'rgba(12,26,12,.55)';
        ctx.stroke();
        ctx.beginPath(); ctx.moveTo(PX(A.x), PY(A.z)); ctx.lineTo(PX(B.x), PY(B.z));
        ctx.lineWidth = Math.max(7, s * 1.0) * (chosen ? 1.35 : 1);
        ctx.strokeStyle = chosen ? state.players[0].color.light : '#ffd76a';
        ctx.shadowColor = '#ffc93c'; ctx.shadowBlur = s * 1.6;
        ctx.stroke();
        if (chosen) {
          // Chevrons along the chosen edge: "this way", unmistakably.
          const mx = (PX(A.x) + PX(B.x)) / 2, my = (PY(A.z) + PY(B.z)) / 2;
          ctx.shadowBlur = 0;
          ctx.beginPath();
          ctx.arc(mx, my, Math.max(7, s * 1.05) * (1.05 + 0.12 * beat), 0, Math.PI * 2);
          ctx.lineWidth = Math.max(2, s * 0.3);
          ctx.strokeStyle = '#fff4cf';
          ctx.stroke();
        }
      } else if (mode === 'place-robber') {
        const t = tiles[id];
        paint.hexPath(t, chosen ? 0.02 : 0);
        ctx.fillStyle = chosen ? 'rgba(255,201,60,.44)' : `rgba(255,201,60,${0.14 + 0.12 * beat})`;
        ctx.fill();
        ctx.lineWidth = Math.max(2, s * 0.16);
        ctx.strokeStyle = chosen ? '#ffe79a' : '#ffc93c';
        ctx.shadowColor = '#ffc93c'; ctx.shadowBlur = s * 1.2;
        ctx.stroke();
      } else {
        // Fifty-odd corners are legal at the opening of a draft. Solid discs
        // that big turn the island into a bead necklace and hide the terrain
        // the player is trying to judge, so a target is a ring: it reads as an
        // invitation, and you can still see straight through it.
        const n = intersections[id];
        const x = PX(n.x), y = PY(n.z);
        const r = targetR();

        if (warm) {
          // One expanding sonar ripple, on the one under the finger only, and
          // kept close to the ring it comes off: a wide ripple on a small
          // target is all ripple and no target.
          ctx.globalAlpha = (1 - halo) * 0.8;
          ctx.beginPath(); ctx.arc(x, y, r * (1.0 + halo * 0.45), 0, Math.PI * 2);
          ctx.lineWidth = Math.max(1.4, r * 0.16);
          ctx.strokeStyle = '#ffe79a';
          ctx.stroke();
        }

        const rr = r * (chosen ? 1.22 : (warm ? 1.1 : 1));
        // Fifty-four corners are legal on the opening pick. Held a touch back
        // from full strength, they read as an invitation over the board rather
        // than a lattice on top of it.
        ctx.globalAlpha = chosen || warm ? 1 : 0.82;
        // Hollow: the hex under the ring stays legible, which is the whole
        // reason a corner is worth choosing.
        if (chosen) {
          ctx.beginPath(); ctx.arc(x, y, rr, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255,238,190,.94)'; ctx.fill();
        }
        ctx.beginPath(); ctx.arc(x, y, rr, 0, Math.PI * 2);
        ctx.lineWidth = Math.max(1.5, r * 0.24);
        ctx.strokeStyle = 'rgba(20,12,4,.55)'; ctx.stroke();
        ctx.beginPath(); ctx.arc(x, y, rr, 0, Math.PI * 2);
        ctx.lineWidth = Math.max(1.4, r * 0.15) * (chosen ? 1.8 : 0.9 + 0.2 * beat);
        ctx.strokeStyle = chosen ? '#fff4cf' : (warm ? '#ffe79a' : '#ffc93c');
        if (chosen || warm) {
          ctx.shadowColor = 'rgba(255,201,60,.85)';
          ctx.shadowBlur = s * (chosen ? 2.4 : 1.2);
        }
        ctx.stroke();
        ctx.shadowBlur = 0;
        if (!chosen) {
          ctx.beginPath();
          ctx.arc(x, y, Math.max(1.3, r * 0.16) * (0.75 + 0.4 * glow), 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255,250,225,.9)'; ctx.fill();
        }
      }
      ctx.restore();
    }

    // The chosen corner: the piece itself, dropped on the spot, and one close
    // ring plus the chevron to say so. It used to sit inside a halo twice its
    // own width, which is what read as "several concentric gold rings"; the
    // pip is the same size as a placed building now and the ring hugs it.
    if (sel !== null && mode !== 'place-robber' && mode !== 'place-road') {
      const n = intersections[sel];
      const x = PX(n.x), y = PY(n.z);
      const r = Math.max(11, s * 1.05) * (mode === 'place-city' ? 1.22 : 1);
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, r * (1.4 + 0.09 * beat), 0, Math.PI * 2);
      ctx.lineWidth = Math.max(1.8, r * 0.15);
      ctx.strokeStyle = `rgba(255,201,60,${0.5 + 0.28 * beat})`;
      ctx.stroke();
      ctx.globalAlpha = 0.98;
      paint.ownerPip(x, y, r, state.players[0].color, mode === 'place-city', true);
      // A bobbing chevron right over the pin, so the eye lands on the choice
      // from anywhere on the board.
      const lift = r * (1.55 + 0.2 * beat);
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.moveTo(x, y - lift);
      ctx.lineTo(x - r * 0.62, y - lift - r * 0.8);
      ctx.lineTo(x + r * 0.62, y - lift - r * 0.8);
      ctx.closePath();
      ctx.fillStyle = '#ffd24a';
      ctx.fill();
      ctx.lineWidth = Math.max(1.4, r * 0.16);
      ctx.strokeStyle = 'rgba(24,14,4,.75)';
      ctx.stroke();
      ctx.restore();
    }
  }

  /**
   * The bot telegraph. While a rival is "thinking", matchflow.js hands us the
   * corner or edge it has already decided on and we point at it for a beat
   * before the piece appears. That beat is the whole reason a spectated draft
   * reads as a draft rather than as pieces popping into existence.
   */
  function drawSpotlight(pulse) {
    const sp = opts.spotlight;
    if (!sp || sp.id === undefined || sp.id === null || sp.id < 0) return;
    const s = proj.s;
    const col = sp.color || '#ffc93c';
    const beat = 0.5 + 0.5 * Math.sin(pulse * 3.4);
    const ring = (pulse * 0.85) % 1;
    let x, y;
    if (sp.kind === 'edge') {
      const e = edges[sp.id];
      if (!e) return;
      const A = intersections[e.a], B = intersections[e.b];
      x = (PX(A.x) + PX(B.x)) / 2; y = (PY(A.z) + PY(B.z)) / 2;
      ctx.save();
      ctx.lineCap = 'round';
      ctx.globalAlpha = sp.hot ? 0.95 : 0.55;
      ctx.beginPath(); ctx.moveTo(PX(A.x), PY(A.z)); ctx.lineTo(PX(B.x), PY(B.z));
      ctx.lineWidth = Math.max(8, s * 1.25);
      ctx.strokeStyle = col;
      ctx.setLineDash([Math.max(4, s * 0.7), Math.max(4, s * 0.7)]);
      ctx.lineDashOffset = -pulse * 26;
      ctx.stroke();
      ctx.restore();
    } else {
      const n = intersections[sp.id];
      if (!n) return;
      x = PX(n.x); y = PY(n.z);
    }

    const r = Math.max(12, HEX_SIZE * s * 0.5);
    ctx.save();
    // A dark backing disc, so the mark survives a bright wheat or sand hex.
    ctx.beginPath(); ctx.arc(x, y, r * 0.94, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(10,26,44,.5)'; ctx.fill();

    ctx.globalAlpha = (1 - ring) * (sp.hot ? 0.9 : 0.5);
    ctx.beginPath(); ctx.arc(x, y, r * (0.9 + ring * 1.7), 0, Math.PI * 2);
    ctx.lineWidth = Math.max(2, r * 0.22);
    ctx.strokeStyle = col;
    ctx.stroke();

    ctx.globalAlpha = 1;
    ctx.beginPath(); ctx.arc(x, y, r * (sp.hot ? 1.0 : 0.82), 0, Math.PI * 2);
    ctx.lineWidth = Math.max(2.8, r * 0.3) * (0.85 + 0.3 * beat);
    ctx.strokeStyle = col;
    ctx.setLineDash([Math.max(3, r * 0.45), Math.max(3, r * 0.42)]);
    ctx.lineDashOffset = -pulse * 22;
    ctx.shadowColor = col; ctx.shadowBlur = r * 1.1;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.shadowBlur = 0;

    // Crosshair ticks — a surveyor's mark, not a target reticle.
    ctx.lineWidth = Math.max(1.6, r * 0.18);
    ctx.strokeStyle = 'rgba(255,255,255,.9)';
    for (let i = 0; i < 4; i++) {
      const a = (Math.PI / 2) * i + Math.PI / 4;
      const c = Math.cos(a), sn = Math.sin(a);
      ctx.beginPath();
      ctx.moveTo(x + c * r * 1.18, y + sn * r * 1.18);
      ctx.lineTo(x + c * r * 1.62, y + sn * r * 1.62);
      ctx.stroke();
    }

    // A pennant in the rival's colour, bobbing above the mark. This is what
    // makes "Maya is about to build there" legible across the whole board.
    const lift = r * (1.9 + 0.16 * beat);
    const fh = r * 1.15;
    ctx.beginPath();
    ctx.moveTo(x, y - lift);
    ctx.lineTo(x, y - lift - fh);
    ctx.lineWidth = Math.max(1.6, r * 0.16);
    ctx.strokeStyle = 'rgba(16,26,40,.85)';
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x, y - lift - fh);
    ctx.lineTo(x + r * 1.1, y - lift - fh * 0.72);
    ctx.lineTo(x, y - lift - fh * 0.44);
    ctx.closePath();
    ctx.fillStyle = col;
    ctx.fill();
    ctx.lineWidth = Math.max(1.2, r * 0.13);
    ctx.strokeStyle = 'rgba(16,26,40,.85)';
    ctx.stroke();
    ctx.restore();
  }

  function draw(pulse) {
    if (!ctx) return;
    measure();
    if (bgx) {
      bakeBoard();
      ctx.clearRect(0, 0, proj.w, proj.h);
      ctx.drawImage(bg, 0, 0, proj.w, proj.h);
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
    drawSpotlight(pulse);
    drawTargets(pulse);
    paint.drawSettlers(state);
    paint.drawFrame(proj.frame);
  }

  /* -------------------------------------------------------------- picking */
  function pick(px, py) {
    if (!targets.length) return null;
    // >= 44px across at 667x375, and nearest-wins beyond that, so a fat finger
    // between two corners always lands on the closer one.
    const thresh = Math.max(26, HEX_SIZE * proj.s * 0.5);
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
    select, commit,
    destroy() { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); }
  };
}

export default createOverview;
