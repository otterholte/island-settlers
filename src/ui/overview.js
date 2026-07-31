/**
 * Island Settlers — board overview.
 *
 *   createOverview(root, state, game) ->
 *     { open(mode, opts), close(), update(dt), isOpen }
 *
 * A crisp 2D canvas map painted over the 3D scene. Far easier to read on a
 * phone than an orbit camera, and it doubles as the placement interface:
 * every legal target pulses, one tap previews it (also driving the 3D ghost),
 * and a confirm bar commits it through rules.js.
 *
 * Modes: 'view' | 'place-road' | 'place-settlement' | 'place-city' | 'place-robber'
 *
 * All hex geometry comes from board/layout.js — nothing is re-derived here.
 * World (x, z) maps to canvas (x, y) with a single uniform scale, so the
 * pointy-top hexes stay pointy-top.
 *
 * Owner: UI agent.
 */

import { HEX_SIZE, pipsFor } from '../core/constants.js';
import {
  tiles, intersections, edges, ports, BOUNDS, cornerOffset
} from '../board/layout.js';
import {
  legalRoads, legalSettlements, legalCities,
  placeRoad, placeSettlement, upgradeCity, playKnight, scoreOf
} from '../core/rules.js';
import { el, button, toggle, setText, clamp, hash01, onTap } from './dom.js';
import { icon, avatar } from './icons.js';

const TERRAIN = {
  forest:    { a: '#5aa03f', b: '#2f6a24', rim: '#20461a', motif: 'tree' },
  hills:     { a: '#cf7a44', b: '#9a4d24', rim: '#6d3417', motif: 'bump' },
  pasture:   { a: '#9ed15f', b: '#5f9c37', rim: '#3f6b23', motif: 'dot' },
  fields:    { a: '#f0cd57', b: '#c4972a', rim: '#8a6716', motif: 'stripe' },
  mountains: { a: '#a8b1bd', b: '#6c7684', rim: '#464e59', motif: 'peak' },
  desert:    { a: '#efdcae', b: '#cdb078', rim: '#8f7846', motif: 'speck' }
};

const MODE_INFO = {
  'view':              { title: 'Island Map', hint: 'Tap the map to look around' },
  'place-road':        { title: 'Place a Road', hint: 'Tap a glowing edge' },
  'place-settlement':  { title: 'Place a Settlement', hint: 'Tap a glowing corner' },
  'place-city':        { title: 'Upgrade to a City', hint: 'Tap one of your settlements' },
  'place-robber':      { title: 'Send the Raider', hint: 'Tap a region to block' }
};

const FONT = `'Trebuchet MS','Avenir Next Condensed','Segoe UI',system-ui,sans-serif`;
const f = (w, s) => `${w} ${s}px ${FONT}`;

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

  const proj = { s: 1, ox: 0, oy: 0, w: 0, h: 0 };

  /* ------------------------------------------------------------ rail rows */
  function buildRail() {
    while (rail.firstChild) rail.removeChild(rail.firstChild);
    rail.appendChild(el('div', { class: 'rail-head', text: 'Players' }));
    railRows = state.players.map(p => {
      const vp = el('b', { class: 'rr-vp', text: '0' });
      const stats = el('div', { class: 'rr-stats' });
      const row = el('div', {
        class: 'rr' + (p.id === 0 ? ' me' : ''),
        style: { '--c': p.color.css, '--cl': p.color.light }
      },
        el('div', { class: 'rr-top' },
          el('span', { class: 'rr-av', html: avatar(p.color.css, p.color.light, 30) }),
          el('span', { class: 'rr-name', text: p.name }),
          vp),
        stats);
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
    // The confirm bar only exists in a placement mode; in plain view the board
    // gets that space back so it fills the frame instead of floating in it.
    const padL = 14, padT = 44, padR = railW + 22;
    const padB = mode === 'view' ? 16 : 62;
    const availW = Math.max(60, w - padL - padR);
    const availH = Math.max(60, h - padT - padB);
    // Just enough slack for the dock tags that hang off the coast — any more
    // and the board starts floating in dead blue again.
    const bw = BOUNDS.width + HEX_SIZE * 1.3;
    const bd = BOUNDS.depth + HEX_SIZE * 1.3;
    proj.s = Math.min(availW / bw, availH / bd);
    proj.ox = padL + availW / 2 - BOUNDS.cx * proj.s;
    proj.oy = padT + availH / 2 - BOUNDS.cz * proj.s;
    toggle(rail, 'hid', railW === 0);
  }

  const PX = x => x * proj.s + proj.ox;
  const PY = z => z * proj.s + proj.oy;

  /* ------------------------------------------------------------- painting */
  function hexPath(t, inflate = 0, dy = 0) {
    const r = HEX_SIZE * proj.s;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const o = cornerOffset(i);
      const k = 1 + inflate;
      const x = PX(t.x) + o.x * proj.s * k;
      const y = PY(t.z) + o.z * proj.s * k + dy;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    return r;
  }

  function drawSea() {
    const g = ctx.createLinearGradient(0, 0, 0, proj.h);
    g.addColorStop(0, '#0b3f76');
    g.addColorStop(0.55, '#0e5fa8');
    g.addColorStop(1, '#1279b8');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, proj.w, proj.h);

    const cx = PX(BOUNDS.cx), cy = PY(BOUNDS.cz);
    const rr = (BOUNDS.radius + HEX_SIZE) * proj.s;
    const sg = ctx.createRadialGradient(cx, cy, rr * 0.62, cx, cy, rr * 1.22);
    sg.addColorStop(0, 'rgba(63,196,216,.75)');
    sg.addColorStop(1, 'rgba(63,196,216,0)');
    ctx.fillStyle = sg;
    ctx.beginPath(); ctx.arc(cx, cy, rr * 1.22, 0, Math.PI * 2); ctx.fill();

    ctx.strokeStyle = 'rgba(255,255,255,.16)';
    ctx.lineWidth = 1.4;
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.arc(cx, cy, rr * (1.06 + i * 0.09), 0.2 + i, 1.5 + i);
      ctx.stroke();
    }
  }

  /** Scatter dressing. Each element gets its own light and shade so the tile
      reads as painted terrain rather than a flat swatch. */
  function motif(t, kind, s) {
    const cx = PX(t.x), cy = PY(t.z);
    const n = kind === 'dot' || kind === 'speck' ? 12 : 9;
    for (let i = 0; i < n; i++) {
      const a = hash01(t.id * 31.7 + i * 5.3) * Math.PI * 2;
      const rr = (0.16 + hash01(t.id * 7.1 + i * 2.9) * 0.66) * HEX_SIZE * s;
      const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr * 0.9;
      const k = HEX_SIZE * s * (0.10 + hash01(i * 3.3 + t.id) * 0.06);
      ctx.save();
      if (kind === 'tree') {
        ctx.beginPath();
        ctx.ellipse(x, y + k * 0.9, k * 0.9, k * 0.34, 0, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(12,40,10,.34)'; ctx.fill();
        ctx.beginPath();
        ctx.moveTo(x, y - k * 1.8); ctx.lineTo(x + k * 0.95, y + k * 0.8);
        ctx.lineTo(x - k * 0.95, y + k * 0.8); ctx.closePath();
        ctx.fillStyle = '#1f5a18'; ctx.fill();
        ctx.beginPath();
        ctx.moveTo(x, y - k * 1.8); ctx.lineTo(x - k * 0.95, y + k * 0.8);
        ctx.lineTo(x - k * 0.1, y + k * 0.8); ctx.closePath();
        ctx.fillStyle = '#3d8a2c'; ctx.fill();
      } else if (kind === 'peak') {
        ctx.beginPath();
        ctx.moveTo(x, y - k * 1.9); ctx.lineTo(x + k * 1.15, y + k * 0.8);
        ctx.lineTo(x - k * 1.15, y + k * 0.8); ctx.closePath();
        ctx.fillStyle = '#6d7887'; ctx.fill();
        ctx.beginPath();
        ctx.moveTo(x, y - k * 1.9); ctx.lineTo(x - k * 1.15, y + k * 0.8);
        ctx.lineTo(x - k * 0.15, y + k * 0.8); ctx.closePath();
        ctx.fillStyle = '#e8eef6'; ctx.fill();
      } else if (kind === 'bump') {
        ctx.beginPath(); ctx.arc(x, y, k, Math.PI, 0); ctx.closePath();
        ctx.fillStyle = '#8f4620'; ctx.fill();
        ctx.beginPath(); ctx.arc(x - k * 0.28, y - k * 0.1, k * 0.5, Math.PI, 0);
        ctx.closePath(); ctx.fillStyle = '#c9713c'; ctx.fill();
      } else if (kind === 'stripe') {
        ctx.beginPath(); ctx.rect(x - k * 0.34, y - k * 1.5, k * 0.68, k * 3);
        ctx.fillStyle = '#b5871a'; ctx.fill();
        ctx.beginPath(); ctx.ellipse(x, y - k * 1.5, k * 0.5, k * 0.95, 0, 0, Math.PI * 2);
        ctx.fillStyle = '#ffdf82'; ctx.fill();
      } else if (kind === 'dot') {
        ctx.beginPath(); ctx.arc(x, y + k * 0.3, k * 0.85, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(30,70,20,.3)'; ctx.fill();
        ctx.beginPath(); ctx.arc(x, y, k * 0.85, 0, Math.PI * 2);
        ctx.fillStyle = '#fbf7ee'; ctx.fill();
      } else {
        ctx.beginPath(); ctx.arc(x, y, k * 0.42, 0, Math.PI * 2);
        ctx.fillStyle = '#bfa374'; ctx.fill();
      }
      ctx.restore();
    }
  }

  function drawTiles() {
    const s = proj.s;
    const lift = HEX_SIZE * s * 0.22;
    const R = HEX_SIZE * s;

    // Cliff face: the whole footprint pushed down, then the tops on top.
    ctx.save();
    ctx.fillStyle = 'rgba(4,20,40,.5)';
    for (const t of tiles) { hexPath(t, 0.04, lift * 2.3); ctx.fill(); }
    ctx.restore();

    for (const t of tiles) {
      const pal = TERRAIN[t.terrain] || TERRAIN.desert;
      hexPath(t, 0, lift);
      ctx.fillStyle = pal.rim;
      ctx.fill();
    }

    for (const t of tiles) {
      const pal = TERRAIN[t.terrain] || TERRAIN.desert;
      const cx = PX(t.x), cy = PY(t.z);
      hexPath(t, 0);
      ctx.save(); ctx.clip();

      const g = ctx.createLinearGradient(0, cy - R, 0, cy + R);
      g.addColorStop(0, pal.a);
      g.addColorStop(0.62, pal.b);
      g.addColorStop(1, pal.rim);
      ctx.fillStyle = g;
      ctx.fillRect(cx - R * 1.2, cy - R * 1.2, R * 2.4, R * 2.4);

      // Sun off the upper-left, the way the 3D scene is lit.
      const sun = ctx.createRadialGradient(
        cx - R * 0.34, cy - R * 0.42, R * 0.08, cx - R * 0.2, cy - R * 0.3, R * 1.25);
      sun.addColorStop(0, 'rgba(255,248,214,.34)');
      sun.addColorStop(1, 'rgba(255,248,214,0)');
      ctx.fillStyle = sun;
      ctx.fillRect(cx - R * 1.2, cy - R * 1.2, R * 2.4, R * 2.4);

      // Two soft patches so no two tiles look stamped from the same sheet.
      for (let i = 0; i < 2; i++) {
        const a = hash01(t.id * 12.3 + i * 4.1) * Math.PI * 2;
        const d = hash01(t.id * 5.9 + i) * R * 0.6;
        ctx.globalAlpha = 0.22;
        ctx.beginPath();
        ctx.ellipse(cx + Math.cos(a) * d, cy + Math.sin(a) * d,
          R * 0.5, R * 0.36, a, 0, Math.PI * 2);
        ctx.fillStyle = i ? pal.a : pal.rim;
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      motif(t, pal.motif, s);

      // Edge vignette, then a lit lip along the upper edge.
      const vig = ctx.createRadialGradient(cx, cy, R * 0.42, cx, cy, R * 1.06);
      vig.addColorStop(0, 'rgba(0,0,0,0)');
      vig.addColorStop(1, 'rgba(8,20,10,.40)');
      ctx.fillStyle = vig;
      ctx.fillRect(cx - R * 1.2, cy - R * 1.2, R * 2.4, R * 2.4);

      ctx.save();
      ctx.translate(0, R * 0.11);
      hexPath(t, 0);
      ctx.lineWidth = Math.max(2, s * 0.24);
      ctx.strokeStyle = 'rgba(255,252,228,.34)';
      ctx.stroke();
      ctx.restore();
      ctx.restore();

      hexPath(t, 0);
      ctx.lineWidth = Math.max(1.6, s * 0.13);
      ctx.strokeStyle = 'rgba(10,26,14,.62)';
      ctx.stroke();
    }
  }

  function drawToken(t) {
    if (!t.number) return;
    const s = proj.s;
    const r = Math.max(13, HEX_SIZE * s * 0.32);
    const cx = PX(t.x), cy = PY(t.z);
    const hot = t.number === 6 || t.number === 8;

    ctx.beginPath(); ctx.arc(cx, cy + r * 0.16, r * 1.04, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,.40)'; ctx.fill();
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
    const g = ctx.createLinearGradient(0, cy - r, 0, cy + r);
    g.addColorStop(0, '#fffaea'); g.addColorStop(0.55, '#f2e2bd'); g.addColorStop(1, '#d9c294');
    ctx.fillStyle = g; ctx.fill();
    ctx.beginPath(); ctx.arc(cx, cy - r * 0.16, r * 0.78, Math.PI * 1.12, Math.PI * 1.88);
    ctx.lineWidth = Math.max(1.4, r * 0.11);
    ctx.strokeStyle = 'rgba(255,255,255,.75)'; ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(1.8, r * 0.14);
    ctx.strokeStyle = '#4b2f16'; ctx.stroke();

    ctx.fillStyle = hot ? '#c0271b' : '#3a2208';
    ctx.font = f(800, Math.round(r * 1.16));
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(t.number), cx, cy - r * 0.14);

    const pips = pipsFor(t.number);
    const pr = Math.max(1.5, r * 0.115);
    for (let i = 0; i < pips; i++) {
      const x = cx + (i - (pips - 1) / 2) * pr * 2.9;
      ctx.beginPath(); ctx.arc(x, cy + r * 0.56, pr, 0, Math.PI * 2);
      ctx.fillStyle = hot ? '#c0271b' : '#5a3a1e'; ctx.fill();
    }
  }

  /** A rounded plate — the one shape every label on this map sits on. */
  function plate(x, y, w, h, fill, stroke, rad) {
    const r = rad === undefined ? Math.min(h / 2, 7) : rad;
    ctx.beginPath();
    ctx.moveTo(x - w / 2 + r, y - h / 2);
    ctx.arcTo(x + w / 2, y - h / 2, x + w / 2, y + h / 2, r);
    ctx.arcTo(x + w / 2, y + h / 2, x - w / 2, y + h / 2, r);
    ctx.arcTo(x - w / 2, y + h / 2, x - w / 2, y - h / 2, r);
    ctx.arcTo(x - w / 2, y - h / 2, x + w / 2, y - h / 2, r);
    ctx.closePath();
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = 7; ctx.shadowOffsetY = 3;
    ctx.fillStyle = fill; ctx.fill();
    ctx.restore();
    ctx.lineWidth = 2; ctx.strokeStyle = stroke; ctx.stroke();
  }

  /** Dock tags: full-opacity plated 2:1 / 3:1 markers on a mooring line. */
  function drawPorts() {
    const s = proj.s;
    const mine = state.players[0].ports;
    for (const p of ports) {
      const e = edges[p.edge];
      const unlocked = mine.has(p.id);
      const px = PX(p.x), py = PY(p.z);

      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(PX(e.x), PY(e.z)); ctx.lineTo(px, py);
      ctx.lineWidth = Math.max(3, s * 0.32);
      ctx.strokeStyle = 'rgba(12,26,44,.7)'; ctx.stroke();
      ctx.beginPath(); ctx.moveTo(PX(e.x), PY(e.z)); ctx.lineTo(px, py);
      ctx.lineWidth = Math.max(1.6, s * 0.18);
      ctx.strokeStyle = unlocked ? '#ffc93c' : '#c8b28a'; ctx.stroke();

      const w = 40, h = 24;
      plate(px, py, w, h,
        unlocked ? '#ffd764' : '#f2e6ca',
        unlocked ? '#7a4d06' : '#5a3a1e', 8);
      if (unlocked) {
        ctx.beginPath();
        ctx.rect(px - w / 2 + 3, py - h / 2 + 3, w - 6, 4);
        ctx.fillStyle = 'rgba(255,255,255,.6)'; ctx.fill();
      }
      ctx.fillStyle = '#3a2208';
      ctx.font = f(800, 14);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(p.label, px, py + 1);
    }
  }

  function drawRoads() {
    const s = proj.s;
    const w = Math.max(6, s * 0.66);
    for (const [eid, pid] of state.roadOwner) {
      const e = edges[eid];
      const A = intersections[e.a], B = intersections[e.b];
      const col = state.players[pid].color;
      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(PX(A.x), PY(A.z)); ctx.lineTo(PX(B.x), PY(B.z));
      ctx.lineWidth = w + Math.max(2, s * 0.22);
      ctx.strokeStyle = 'rgba(12,24,10,.62)';
      ctx.stroke();
      ctx.beginPath(); ctx.moveTo(PX(A.x), PY(A.z)); ctx.lineTo(PX(B.x), PY(B.z));
      ctx.lineWidth = w;
      ctx.strokeStyle = col.css;
      ctx.stroke();
      ctx.beginPath(); ctx.moveTo(PX(A.x), PY(A.z)); ctx.lineTo(PX(B.x), PY(B.z));
      ctx.lineWidth = w * 0.36;
      ctx.strokeStyle = col.light;
      ctx.stroke();
    }
  }

  function houseGlyph(x, y, k, col) {
    ctx.beginPath();
    ctx.moveTo(x, y - k * 1.35);
    ctx.lineTo(x + k, y - k * 0.25);
    ctx.lineTo(x + k * 0.72, y - k * 0.25);
    ctx.lineTo(x + k * 0.72, y + k);
    ctx.lineTo(x - k * 0.72, y + k);
    ctx.lineTo(x - k * 0.72, y - k * 0.25);
    ctx.lineTo(x - k, y - k * 0.25);
    ctx.closePath();
    ctx.fillStyle = col.css; ctx.fill();
    ctx.lineWidth = Math.max(1.1, k * 0.28);
    ctx.strokeStyle = 'rgba(10,20,32,.85)'; ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x, y - k * 1.25); ctx.lineTo(x + k * 0.7, y - k * 0.3);
    ctx.lineTo(x - k * 0.7, y - k * 0.3); ctx.closePath();
    ctx.fillStyle = col.light; ctx.fill();
  }

  function castleGlyph(x, y, k, col) {
    ctx.beginPath();
    ctx.moveTo(x - k * 1.25, y + k);
    ctx.lineTo(x - k * 1.25, y - k * 0.75);
    ctx.lineTo(x - k * 0.85, y - k * 0.75);
    ctx.lineTo(x - k * 0.85, y - k * 1.25);
    ctx.lineTo(x - k * 0.45, y - k * 1.25);
    ctx.lineTo(x - k * 0.45, y - k * 0.75);
    ctx.lineTo(x + k * 0.45, y - k * 0.75);
    ctx.lineTo(x + k * 0.45, y - k * 1.25);
    ctx.lineTo(x + k * 0.85, y - k * 1.25);
    ctx.lineTo(x + k * 0.85, y - k * 0.75);
    ctx.lineTo(x + k * 1.25, y - k * 0.75);
    ctx.lineTo(x + k * 1.25, y + k);
    ctx.closePath();
    ctx.fillStyle = col.css; ctx.fill();
    ctx.lineWidth = Math.max(1.1, k * 0.26);
    ctx.strokeStyle = 'rgba(10,20,32,.85)'; ctx.stroke();
    ctx.fillStyle = col.light;
    ctx.fillRect(x - k * 1.25, y - k * 0.75, k * 2.5, k * 0.34);
    ctx.fillStyle = 'rgba(10,20,32,.75)';
    ctx.fillRect(x - k * 0.3, y + k * 0.05, k * 0.6, k * 0.95);
  }

  /** Owner-coloured pip, at least 14px across, with the piece glyph on it. */
  function ownerPip(x, y, r, col, city) {
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = r * 0.8; ctx.shadowOffsetY = r * 0.34;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = col.css; ctx.fill();
    ctx.restore();
    ctx.beginPath(); ctx.arc(x, y - r * 0.22, r * 0.72, Math.PI * 1.1, Math.PI * 1.9);
    ctx.lineWidth = r * 0.24; ctx.strokeStyle = col.light; ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(2, r * 0.26);
    ctx.strokeStyle = city ? '#ffe79a' : 'rgba(8,18,30,.9)';
    ctx.stroke();
    const k = r * 0.56;
    if (city) castleGlyph(x, y + k * 0.1, k, { css: '#f4f8ff', light: '#ffffff' });
    else houseGlyph(x, y + k * 0.1, k, { css: '#f4f8ff', light: '#ffffff' });
  }

  function drawBuildings() {
    const r = Math.max(7.5, proj.s * 0.66);
    for (const [iid, b] of state.buildings) {
      const n = intersections[iid];
      const col = state.players[b.owner].color;
      ownerPip(PX(n.x), PY(n.z), b.type === 'city' ? r * 1.22 : r, col, b.type === 'city');
    }
  }

  function drawRobber() {
    const t = tiles[state.robberTile];
    if (!t) return;
    const s = proj.s;
    hexPath(t, 0);
    ctx.fillStyle = 'rgba(10,16,26,.42)'; ctx.fill();
    const x = PX(t.x), y = PY(t.z) - HEX_SIZE * s * 0.42;
    const k = Math.max(5, s * 0.9);
    ctx.beginPath();
    ctx.moveTo(x - k, y + k * 1.1);
    ctx.quadraticCurveTo(x - k * 0.9, y - k * 1.35, x, y - k * 1.35);
    ctx.quadraticCurveTo(x + k * 0.9, y - k * 1.35, x + k, y + k * 1.1);
    ctx.closePath();
    ctx.fillStyle = '#24303e'; ctx.fill();
    ctx.lineWidth = Math.max(1, k * 0.24);
    ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.stroke();
    ctx.fillStyle = '#ff5a3c';
    ctx.beginPath(); ctx.arc(x - k * 0.33, y - k * 0.25, k * 0.17, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(x + k * 0.33, y - k * 0.25, k * 0.17, 0, Math.PI * 2); ctx.fill();
  }

  /** Name plate: a real plated tag with an owner-colour bar, never bare text
      floating over terrain. Plates flip above/below the marker by which half
      of the island the settler is standing on, so rivals stop colliding. */
  function namePlate(x, y, name, col, mine) {
    const label = name.toUpperCase();
    ctx.font = f(800, 12);
    const tw = ctx.measureText(label).width;
    const w = tw + 24, h = 21;
    plate(x, y, w, h, mine ? '#123a66' : 'rgba(10,26,46,.94)',
      mine ? '#ffc93c' : 'rgba(2,8,16,.9)', 7);
    ctx.beginPath();
    ctx.moveTo(x - w / 2 + 2, y - h / 2 + 3);
    ctx.lineTo(x - w / 2 + 6, y - h / 2 + 3);
    ctx.lineTo(x - w / 2 + 6, y + h / 2 - 3);
    ctx.lineTo(x - w / 2 + 2, y + h / 2 - 3);
    ctx.closePath();
    ctx.fillStyle = col.css; ctx.fill();
    ctx.fillStyle = mine ? '#ffe79a' : '#e9f1fa';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(label, x + 3, y + 1);
  }

  function drawSettlers() {
    const s = proj.s;
    const marks = state.players.map(p => ({
      p, x: PX(p.x), y: PY(p.z), r: Math.max(6, s * (p.id === 0 ? 0.86 : 0.72))
    }));

    for (const m of marks) {
      const { x, y, r, p } = m;
      ctx.beginPath(); ctx.ellipse(x, y + r * 0.85, r * 0.95, r * 0.42, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.fill();
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = p.color.css; ctx.fill();
      ctx.beginPath(); ctx.arc(x, y - r * 0.22, r * 0.66, Math.PI * 1.1, Math.PI * 1.9);
      ctx.lineWidth = r * 0.26; ctx.strokeStyle = p.color.light; ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.lineWidth = Math.max(2, r * 0.32);
      ctx.strokeStyle = p.id === 0 ? '#ffc93c' : 'rgba(6,16,28,.9)';
      ctx.stroke();
    }

    // Plates last, and deconflicted: settlers cluster around the market at the
    // opening, and two overlapping name tags is exactly the failure this
    // replaced. Each plate steps away from the marker until it finds air.
    const placed = [];
    const H = 21;
    for (const m of marks) {
      ctx.font = f(800, 12);
      const w = ctx.measureText(m.p.name.toUpperCase()).width + 24;
      const dir = m.p.z <= BOUNDS.cz ? -1 : 1;
      let py = m.y + dir * (m.r + 15);
      for (let i = 0; i < 6; i++) {
        const clash = placed.some(q =>
          Math.abs(q.x - m.x) < (q.w + w) / 2 + 4 && Math.abs(q.y - py) < H + 4);
        if (!clash) break;
        py += dir * (H + 5);
      }
      placed.push({ x: m.x, y: py, w });
      namePlate(m.x, py, m.p.name, m.p.color, m.p.id === 0);
    }
  }

  function drawTargets(pulse) {
    if (!targets.length) return;
    const s = proj.s;
    const glow = 0.32 + 0.34 * (0.5 + 0.5 * Math.sin(pulse * 4.2));
    const grow = 1 + 0.10 * (0.5 + 0.5 * Math.sin(pulse * 4.2));

    for (const id of targets) {
      const chosen = id === sel;
      ctx.save();
      ctx.globalAlpha = chosen ? 1 : glow;
      if (mode === 'place-road') {
        const e = edges[id];
        const A = intersections[e.a], B = intersections[e.b];
        ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(PX(A.x), PY(A.z)); ctx.lineTo(PX(B.x), PY(B.z));
        ctx.lineWidth = Math.max(4, s * 0.62) * (chosen ? 1.2 : grow);
        ctx.strokeStyle = chosen ? state.players[0].color.css : '#ffd76a';
        ctx.shadowColor = '#ffc93c'; ctx.shadowBlur = s * 1.4;
        ctx.stroke();
      } else if (mode === 'place-robber') {
        const t = tiles[id];
        hexPath(t, chosen ? 0.02 : 0);
        ctx.fillStyle = chosen ? 'rgba(255,201,60,.42)' : 'rgba(255,201,60,.20)';
        ctx.fill();
        ctx.lineWidth = Math.max(2, s * 0.16);
        ctx.strokeStyle = chosen ? '#ffe79a' : '#ffc93c';
        ctx.shadowColor = '#ffc93c'; ctx.shadowBlur = s * 1.2;
        ctx.stroke();
      } else {
        const n = intersections[id];
        const r = Math.max(6, s * 0.95) * (chosen ? 1.25 : grow);
        ctx.beginPath(); ctx.arc(PX(n.x), PY(n.z), r, 0, Math.PI * 2);
        ctx.fillStyle = chosen ? 'rgba(255,231,154,.9)' : 'rgba(255,201,60,.55)';
        ctx.shadowColor = '#ffc93c'; ctx.shadowBlur = s * 1.4;
        ctx.fill();
        ctx.lineWidth = Math.max(1.4, r * 0.22);
        ctx.strokeStyle = '#8a5a12'; ctx.stroke();
      }
      ctx.restore();
    }

    if (sel !== null && mode !== 'place-robber' && mode !== 'place-road') {
      const n = intersections[sel];
      const r = Math.max(7.5, s * 0.66) * (mode === 'place-city' ? 1.22 : 1);
      ctx.save(); ctx.globalAlpha = 0.92;
      ownerPip(PX(n.x), PY(n.z), r, state.players[0].color, mode === 'place-city');
      ctx.restore();
    }
  }

  function draw(pulse) {
    if (!ctx) return;
    measure();
    drawSea();
    drawTiles();
    for (const t of tiles) drawToken(t);
    drawPorts();
    drawRoads();
    drawBuildings();
    drawRobber();
    drawTargets(pulse);
    drawSettlers();
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
    destroy() { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); }
  };
}

export default createOverview;
