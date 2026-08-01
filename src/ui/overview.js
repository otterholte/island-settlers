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
 * Modes: 'view' | 'place-road' | 'place-settlement' | 'place-city' | 'place-robber'
 *
 * All hex geometry comes from board/layout.js — nothing is re-derived here.
 * World (x, z) maps to canvas (x, y) with a single uniform scale, so the
 * pointy-top hexes stay pointy-top.
 *
 * Painting lives in ./ovmap.js; the name plates solve their own positions in
 * ./ovlabels.js so they can never sit on a number token.
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
import { createLabeller } from './ovlabels.js';

const MODE_INFO = {
  'view':              { title: 'Island Map', hint: 'Tap the map to look around' },
  'place-road':        { title: 'Place a Road', hint: 'Tap a glowing edge' },
  'place-settlement':  { title: 'Place a Settlement', hint: 'Tap a glowing corner' },
  'place-city':        { title: 'Upgrade to a City', hint: 'Tap one of your settlements' },
  'place-robber':      { title: 'Send the Raider', hint: 'Tap a region to block' }
};

export function createOverview(root, state, game) {
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
  let hoverPulse = 0;
  let closeTimer = 0;
  let railRows = [];
  let railT = 0;
  let lastW = 0, lastH = 0;

  const proj = { s: 1, ox: 0, oy: 0, w: 0, h: 0, frame: { x: 0, y: 0, w: 0, h: 0 } };

  const paint = ctx ? createPainter(ctx, proj) : null;
  const labels = ctx ? createLabeller(ctx, proj, paint) : null;
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
      ctx.save();
      if (mode === 'place-road') {
        const e = edges[id];
        const A = intersections[e.a], B = intersections[e.b];
        ctx.lineCap = 'round';
        ctx.globalAlpha = chosen ? 1 : 0.55 + 0.35 * beat;
        ctx.beginPath(); ctx.moveTo(PX(A.x), PY(A.z)); ctx.lineTo(PX(B.x), PY(B.z));
        ctx.lineWidth = Math.max(7, s * 0.9);
        ctx.strokeStyle = 'rgba(12,26,12,.55)';
        ctx.stroke();
        ctx.beginPath(); ctx.moveTo(PX(A.x), PY(A.z)); ctx.lineTo(PX(B.x), PY(B.z));
        ctx.lineWidth = Math.max(4.5, s * 0.62) * (chosen ? 1.25 : 1);
        ctx.strokeStyle = chosen ? state.players[0].color.light : '#ffd76a';
        ctx.shadowColor = '#ffc93c'; ctx.shadowBlur = s * 1.6;
        ctx.stroke();
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
        const r = Math.max(5, s * 0.5);

        if (!chosen) {
          ctx.globalAlpha = (1 - halo) * 0.55;
          ctx.beginPath(); ctx.arc(x, y, r * (1.05 + halo * 1.5), 0, Math.PI * 2);
          ctx.lineWidth = Math.max(1.3, r * 0.22);
          ctx.strokeStyle = '#ffe79a';
          ctx.stroke();
        }

        const rr = r * (chosen ? 1.7 : 1);
        ctx.globalAlpha = 1;
        if (chosen) {
          ctx.beginPath(); ctx.arc(x, y, rr, 0, Math.PI * 2);
          ctx.fillStyle = '#ffe79a'; ctx.fill();
        }
        ctx.beginPath(); ctx.arc(x, y, rr, 0, Math.PI * 2);
        ctx.lineWidth = Math.max(2, r * 0.46);
        ctx.strokeStyle = 'rgba(24,14,4,.5)'; ctx.stroke();
        ctx.beginPath(); ctx.arc(x, y, rr, 0, Math.PI * 2);
        ctx.lineWidth = Math.max(1.4, r * 0.3) * (0.85 + 0.3 * beat);
        ctx.strokeStyle = chosen ? '#fff4cf' : '#ffc93c';
        ctx.shadowColor = 'rgba(255,201,60,.85)'; ctx.shadowBlur = s * (chosen ? 2 : 0.8);
        ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.beginPath(); ctx.arc(x, y, Math.max(1.3, r * 0.26) * (0.7 + 0.45 * glow), 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,250,225,.95)'; ctx.fill();
      }
      ctx.restore();
    }

    if (sel !== null && mode !== 'place-robber' && mode !== 'place-road') {
      const n = intersections[sel];
      const r = Math.max(9.5, s * 0.9) * (mode === 'place-city' ? 1.22 : 1);
      ctx.save(); ctx.globalAlpha = 0.95;
      paint.ownerPip(PX(n.x), PY(n.z), r, state.players[0].color, mode === 'place-city', true);
      ctx.restore();
    }
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
    drawTargets(pulse);
    labels.draw(state, proj.frame,
      paint.tokenRects().concat(paint.portRects(), chromeRects()),
      { x: PX(BOUNDS.cx), y: PY(BOUNDS.cz) });
    paint.drawFrame(proj.frame);
  }

  /**
   * The interface furniture that floats over the canvas — the title plate, the
   * confirm bar, the draft strip the flow module parks bottom-left. Plates
   * dodge these too, otherwise a name disappears under a panel it has no way
   * of knowing about.
   */
  function chromeRects() {
    const out = [];
    if (!cv.getBoundingClientRect) return out;
    const base = cv.getBoundingClientRect();
    const add = (node, weight) => {
      if (!node || !node.getBoundingClientRect) return;
      const r = node.getBoundingClientRect();
      if (!r.width || !r.height) return;
      out.push({
        x: r.left - base.left + r.width / 2,
        y: r.top - base.top + r.height / 2,
        w: r.width + 6, h: r.height + 6, weight, kind: 'chrome'
      });
    };
    add(wrap.querySelector('.ov-top'), 40);
    add(closeBtn, 40);
    if (mode !== 'view') add(bar, 40);
    const doc = root.ownerDocument || (typeof document !== 'undefined' ? document : null);
    if (doc && doc.querySelector) {
      add(doc.querySelector('.mf-draft'), 40);
      add(doc.querySelector('.mf-obj'), 40);
    }
    return out;
  }

  /* -------------------------------------------------------------- picking */
  function pick(px, py) {
    if (!targets.length) return null;
    const thresh = Math.max(24, HEX_SIZE * proj.s * 0.44);
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
    if (!openFlag || mode === 'view') return;
    const r = cv.getBoundingClientRect ? cv.getBoundingClientRect() : { left: 0, top: 0 };
    const hit = pick(e.clientX - r.left, e.clientY - r.top);
    if (hit === null || hit === undefined) return;
    select(hit === sel ? null : hit);
  });

  function select(id) {
    sel = id;
    toggle(confirmBtn, 'off', sel === null);
    if (confirmBtn.disabled !== undefined) confirmBtn.disabled = sel === null;
    setText(selLabel, sel === null ? 'Pick a spot' : describe(sel));
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
  function computeTargets() {
    const setup = !!opts.setup;
    const anchor = opts.anchor === undefined ? -1 : opts.anchor;
    if (mode === 'place-road') return legalRoads(state, 0, setup, anchor);
    if (mode === 'place-settlement') return legalSettlements(state, 0, setup);
    if (mode === 'place-city') return legalCities(state, 0);
    if (mode === 'place-robber') return tiles.filter(t => t.id !== state.robberTile).map(t => t.id);
    return [];
  }

  function open(m, o) {
    mode = MODE_INFO[m] ? m : 'view';
    opts = o || {};
    targets = computeTargets();
    sel = null;

    if (mode !== 'view' && !targets.length) {
      if (game.toast) game.toast('No legal spot for that right now', 'warn');
      return false;
    }

    const info = MODE_INFO[mode];
    setText(titleEl, opts.title || info.title);
    setText(hintEl, opts.hint || info.hint);
    toggle(bar, 'hid', mode === 'view');
    toggle(closeBtn, 'hid', mode !== 'view' && opts.cancellable === false);
    toggle(cancelBtn, 'hid', opts.cancellable === false);
    select(null);
    buildRail();
    refreshRail();

    openFlag = true;
    closeTimer = 0;
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
    ghost();
    targets = [];
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
    /**
     * Measurement hook for tools/mapshot.mjs. Returns the name-plate
     * rectangles and every rectangle they were solved against, in canvas css
     * pixels, so "no plate covers a number" is a checked fact rather than a
     * claim. Costs nothing when nobody asks.
     */
    debugLabels() {
      if (!labels) return { plates: [], obstacles: [] };
      return { plates: labels.plateRects, obstacles: labels.obstacleRects };
    },
    destroy() { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); }
  };
}

export default createOverview;
