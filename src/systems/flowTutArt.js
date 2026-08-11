/**
 * Island Settlers — the tutorial's illustrations.
 *
 *   paintScene(name, ctx, w, h)
 *
 * Every picture in the rules book is drawn here, on a canvas, in the game's own
 * art language: the hex plates use `TERRAIN` straight out of src/ui/ovmap.js —
 * the same six palettes the board map paints with — and the number discs, the
 * roads, the settlement and city glyphs and the settler pin are the same
 * shapes, re-struck at diagram scale. Nothing here is a stock shape, an emoji
 * or an image file; the only other art the book uses is the real inline-SVG
 * icon set from src/ui/icons.js, which the page markup pulls in directly.
 *
 * Every number that appears in a picture is read out of core/constants.js at
 * paint time, so a tuning change moves the tutorial with it.
 *
 * Canvas coordinates are the CSS pixel box: the caller has already applied the
 * device-pixel-ratio transform.
 *
 * Owner: Tutorial (flow) agent.
 */

import {
  TILE_ITEMS, TILE_REGEN, COST, VICTORY_POINTS, isHotNumber,
  TRADE_BASE, PORT_GENERIC, PORT_SPECIAL,
  LONGEST_ROAD_MIN, LONGEST_ROAD_VP, LARGEST_ARMY_MIN, LARGEST_ARMY_VP
} from '../core/constants.js';
import { TERRAIN, f } from '../ui/ovmap.js';

/* The tutorial plates paint their own miniature boards, so they carry their
   own copies of the two player colours they use. Kept in step with
   PLAYER_COLORS by hand — importing constants here would drag the whole rules
   layer into an art module. */
const BLUE = { css: '#2f8ffb', light: '#93cbff' };
const RED = { css: '#f5342a', light: '#ff8f80' };

/** Deterministic 0..1 — the same trick ovmap.js uses for painterly jitter. */
function h01(n) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/* ==================================================================== hexes */

function hexPath(ctx, cx, cy, R, dy = 0) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 180) * (60 * i - 30);
    const x = cx + Math.cos(a) * R;
    const y = cy + Math.sin(a) * R + dy;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

/** Scatter dressing, shape for shape the same set the board map uses. */
function motif(ctx, cx, cy, R, kind, seed, density = 1) {
  const n = Math.round((kind === 'dot' || kind === 'speck' ? 12 : 9) * density);
  for (let i = 0; i < n; i++) {
    const a = h01(seed * 31.7 + i * 5.3) * Math.PI * 2;
    const rr = (0.16 + h01(seed * 7.1 + i * 2.9) * 0.62) * R;
    const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr * 0.9;
    const k = R * (0.10 + h01(i * 3.3 + seed) * 0.06);
    if (kind === 'tree') {
      ctx.beginPath();
      ctx.ellipse(x, y + k * 0.95, k * 0.9, k * 0.32, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(8,32,10,.38)'; ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x, y - k * 1.9); ctx.lineTo(x + k * 0.98, y + k * 0.85);
      ctx.lineTo(x - k * 0.98, y + k * 0.85); ctx.closePath();
      ctx.fillStyle = '#17470f'; ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x, y - k * 1.9); ctx.lineTo(x - k * 0.98, y + k * 0.85);
      ctx.lineTo(x - k * 0.08, y + k * 0.85); ctx.closePath();
      ctx.fillStyle = '#49a233'; ctx.fill();
    } else if (kind === 'peak') {
      ctx.beginPath();
      ctx.moveTo(x, y - k * 1.95); ctx.lineTo(x + k * 1.2, y + k * 0.85);
      ctx.lineTo(x - k * 1.2, y + k * 0.85); ctx.closePath();
      ctx.fillStyle = '#5d6875'; ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x, y - k * 1.95); ctx.lineTo(x - k * 1.2, y + k * 0.85);
      ctx.lineTo(x - k * 0.12, y + k * 0.85); ctx.closePath();
      ctx.fillStyle = '#eef4fb'; ctx.fill();
    } else if (kind === 'bump') {
      ctx.beginPath(); ctx.arc(x, y, k, Math.PI, 0); ctx.closePath();
      ctx.fillStyle = '#7d3a15'; ctx.fill();
      ctx.beginPath(); ctx.arc(x - k * 0.28, y - k * 0.1, k * 0.52, Math.PI, 0);
      ctx.closePath(); ctx.fillStyle = '#d87d3d'; ctx.fill();
    } else if (kind === 'stripe') {
      ctx.beginPath(); ctx.rect(x - k * 0.32, y - k * 1.5, k * 0.64, k * 3);
      ctx.fillStyle = '#a4770f'; ctx.fill();
      ctx.beginPath(); ctx.ellipse(x, y - k * 1.5, k * 0.5, k, 0, 0, Math.PI * 2);
      ctx.fillStyle = '#ffe89a'; ctx.fill();
    } else if (kind === 'dot') {
      ctx.beginPath(); ctx.arc(x, y + k * 0.34, k * 0.86, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(28,66,18,.32)'; ctx.fill();
      ctx.beginPath(); ctx.arc(x, y, k * 0.86, 0, Math.PI * 2);
      ctx.fillStyle = '#fdfaf3'; ctx.fill();
    } else {
      ctx.beginPath(); ctx.arc(x, y, k * 0.42, 0, Math.PI * 2);
      ctx.fillStyle = '#c3a778'; ctx.fill();
    }
  }
}

/**
 * A hex plate with real thickness: a rim pushed down under the face, a lit
 * gradient across it, the sun off the upper-left and a chunky dark edge.
 * `opt.bare` paints the plate with no crop standing on it; `opt.grey` washes
 * the whole thing out the way a spent region reads in play.
 */
function hexPlate(ctx, cx, cy, R, terrainKey, opt = {}) {
  const pal = TERRAIN[terrainKey] || TERRAIN.desert;
  const lift = R * 0.24;

  hexPath(ctx, cx, cy, R * 1.012, lift);
  ctx.fillStyle = pal.rim; ctx.fill();

  hexPath(ctx, cx, cy, R);
  ctx.save(); ctx.clip();
  const g = ctx.createLinearGradient(0, cy - R, 0, cy + R);
  g.addColorStop(0, pal.a); g.addColorStop(0.6, pal.b); g.addColorStop(1, pal.rim);
  ctx.fillStyle = g;
  ctx.fillRect(cx - R * 1.2, cy - R * 1.2, R * 2.4, R * 2.4);

  const sun = ctx.createRadialGradient(
    cx - R * 0.34, cy - R * 0.44, R * 0.08, cx - R * 0.2, cy - R * 0.3, R * 1.25);
  sun.addColorStop(0, 'rgba(255,250,220,.38)');
  sun.addColorStop(1, 'rgba(255,250,220,0)');
  ctx.fillStyle = sun;
  ctx.fillRect(cx - R * 1.2, cy - R * 1.2, R * 2.4, R * 2.4);

  if (!opt.bare) motif(ctx, cx, cy, R, pal.motif, opt.seed || 3, opt.density || 1);

  const vig = ctx.createRadialGradient(cx, cy, R * 0.52, cx, cy, R * 1.06);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(10,22,12,.34)');
  ctx.fillStyle = vig;
  ctx.fillRect(cx - R * 1.2, cy - R * 1.2, R * 2.4, R * 2.4);

  if (opt.grey) {
    ctx.fillStyle = 'rgba(30,38,46,.62)';
    ctx.fillRect(cx - R * 1.2, cy - R * 1.2, R * 2.4, R * 2.4);
  }

  ctx.save();
  ctx.translate(0, R * 0.11);
  hexPath(ctx, cx, cy, R);
  ctx.lineWidth = Math.max(2, R * 0.05);
  ctx.strokeStyle = 'rgba(255,252,228,.30)';
  ctx.stroke();
  ctx.restore();
  ctx.restore();

  hexPath(ctx, cx, cy, R);
  ctx.lineWidth = Math.max(1.7, R * 0.035);
  ctx.strokeStyle = 'rgba(8,22,12,.66)';
  ctx.stroke();
}

/** The wooden number disc — as drawn on the board map. */
function token(ctx, cx, cy, r, number) {
  const hot = isHotNumber(number);
  ctx.beginPath(); ctx.arc(cx, cy + r * 0.2, r * 1.06, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,.42)'; ctx.fill();

  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
  const rim = ctx.createLinearGradient(0, cy - r, 0, cy + r);
  rim.addColorStop(0, '#7a4f24'); rim.addColorStop(1, '#3a2210');
  ctx.fillStyle = rim; ctx.fill();

  ctx.beginPath(); ctx.arc(cx, cy, r * 0.86, 0, Math.PI * 2);
  const g = ctx.createLinearGradient(0, cy - r, 0, cy + r);
  g.addColorStop(0, '#fffaea'); g.addColorStop(0.52, '#f4e5c1'); g.addColorStop(1, '#d8c091');
  ctx.fillStyle = g; ctx.fill();

  if (hot) {
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.93, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(1.4, r * 0.11);
    ctx.strokeStyle = 'rgba(192,39,27,.85)'; ctx.stroke();
  }

  // The dot row is gone island-wide — see world/paint.js — so the numeral is
  // centred on the face and drawn a size larger.
  ctx.fillStyle = hot ? '#bd2114' : '#33200a';
  ctx.font = f(800, Math.round(r * 1.36));
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(String(number), cx, cy + r * 0.02);
}

/* ================================================================== pieces */

function roadSeg(ctx, ax, ay, bx, by, w, col) {
  ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
  ctx.lineWidth = w + 4; ctx.strokeStyle = 'rgba(8,18,10,.75)'; ctx.stroke();
  ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
  ctx.lineWidth = w; ctx.strokeStyle = col.css; ctx.stroke();
  ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
  ctx.lineWidth = w * 0.34; ctx.strokeStyle = col.light; ctx.stroke();
}

function houseGlyph(ctx, x, y, k, col) {
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

function castleGlyph(ctx, x, y, k, col) {
  const step = [
    [-1.25, 1], [-1.25, -0.75], [-0.85, -0.75], [-0.85, -1.25], [-0.45, -1.25],
    [-0.45, -0.75], [0.45, -0.75], [0.45, -1.25], [0.85, -1.25], [0.85, -0.75],
    [1.25, -0.75], [1.25, 1]
  ];
  ctx.beginPath();
  step.forEach(([a, b], i) => {
    const px = x + a * k, py = y + b * k;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  });
  ctx.closePath();
  ctx.fillStyle = col.css; ctx.fill();
  ctx.lineWidth = Math.max(1.1, k * 0.26);
  ctx.strokeStyle = 'rgba(10,20,32,.85)'; ctx.stroke();
  ctx.fillStyle = col.light;
  ctx.fillRect(x - k * 1.25, y - k * 0.75, k * 2.5, k * 0.34);
  ctx.fillStyle = 'rgba(10,20,32,.75)';
  ctx.fillRect(x - k * 0.3, y + k * 0.05, k * 0.6, k * 0.95);
}

/** Owner pip with a piece on it. `mine` gets the gold ring, as on the map. */
function ownerPip(ctx, x, y, r, col, city, mine) {
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,.55)'; ctx.shadowBlur = r * 0.9; ctx.shadowOffsetY = r * 0.34;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = col.css; ctx.fill();
  ctx.restore();
  ctx.beginPath(); ctx.arc(x, y - r * 0.22, r * 0.72, Math.PI * 1.1, Math.PI * 1.9);
  ctx.lineWidth = r * 0.24; ctx.strokeStyle = col.light; ctx.stroke();
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.lineWidth = Math.max(2, r * 0.26);
  ctx.strokeStyle = mine ? '#ffc93c' : 'rgba(8,18,30,.9)';
  ctx.stroke();
  if (mine) {
    ctx.beginPath(); ctx.arc(x, y, r * 1.28, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(1.4, r * 0.14);
    ctx.strokeStyle = 'rgba(255,201,60,.5)'; ctx.stroke();
  }
  const k = r * 0.56;
  const white = { css: '#f4f8ff', light: '#ffffff' };
  if (city) castleGlyph(ctx, x, y + k * 0.1, k, white);
  else houseGlyph(ctx, x, y + k * 0.1, k, white);
}

/** The player pin: the gold-ringed disc the board map paints for the human. */
function settlerPin(ctx, x, y, r) {
  ctx.beginPath(); ctx.ellipse(x, y + r * 0.9, r * 0.95, r * 0.4, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,.38)'; ctx.fill();
  ctx.beginPath(); ctx.arc(x, y, r * 1.75, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,201,60,.16)'; ctx.fill();
  ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,201,60,.55)'; ctx.stroke();
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = BLUE.css; ctx.fill();
  ctx.beginPath(); ctx.arc(x, y - r * 0.22, r * 0.66, Math.PI * 1.1, Math.PI * 1.9);
  ctx.lineWidth = r * 0.28; ctx.strokeStyle = BLUE.light; ctx.stroke();
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.lineWidth = Math.max(2, r * 0.34); ctx.strokeStyle = '#ffc93c'; ctx.stroke();
}

/* ================================================================ furniture */

/**
 * A caption. `maxW` is not optional in spirit: canvas has no line box, so a
 * label that does not fit simply overprints its neighbour — every caption here
 * is shrunk until it fits the column it belongs to.
 */
function label(ctx, x, y, text, size = 12, col = '#5a3a1e', maxW = 0, align = 'center') {
  let s = size;
  if (maxW > 0) {
    ctx.font = f(800, s);
    let w = ctx.measureText(text).width;
    while (w > maxW && s > 5.5) {
      s = Math.max(5.5, s * Math.min(0.94, maxW / w));
      ctx.font = f(800, s);
      w = ctx.measureText(text).width;
    }
  }
  ctx.font = f(800, s);
  ctx.textAlign = align; ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(255,255,255,.75)';
  ctx.fillText(text, x, y + 1.2);
  ctx.fillStyle = col;
  ctx.fillText(text, x, y);
}

function chip(ctx, cx, cy, text, size, fill, ink) {
  ctx.font = f(800, size);
  const w = ctx.measureText(text).width + size * 1.25;
  const h = size * 1.95;
  const r = h / 2;
  ctx.beginPath();
  ctx.moveTo(cx - w / 2 + r, cy - h / 2);
  ctx.arcTo(cx + w / 2, cy - h / 2, cx + w / 2, cy + h / 2, r);
  ctx.arcTo(cx + w / 2, cy + h / 2, cx - w / 2, cy + h / 2, r);
  ctx.arcTo(cx - w / 2, cy + h / 2, cx - w / 2, cy - h / 2, r);
  ctx.arcTo(cx - w / 2, cy - h / 2, cx + w / 2, cy - h / 2, r);
  ctx.closePath();
  ctx.fillStyle = fill; ctx.fill();
  ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(42,26,12,.85)'; ctx.stroke();
  ctx.fillStyle = ink;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, cx, cy + 0.5);
  return w;
}

/** A big green tick / red cross, drawn as strokes, never as a glyph font. */
function verdict(ctx, x, y, r, ok) {
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = ok ? 'rgba(46,132,62,.95)' : 'rgba(176,48,30,.95)';
  ctx.fill();
  ctx.lineWidth = Math.max(2, r * 0.2); ctx.strokeStyle = 'rgba(10,20,10,.8)'; ctx.stroke();
  ctx.lineWidth = Math.max(3, r * 0.28);
  ctx.strokeStyle = '#fff'; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath();
  if (ok) {
    ctx.moveTo(x - r * 0.46, y + r * 0.02);
    ctx.lineTo(x - r * 0.12, y + r * 0.38);
    ctx.lineTo(x + r * 0.5, y - r * 0.4);
  } else {
    ctx.moveTo(x - r * 0.38, y - r * 0.38); ctx.lineTo(x + r * 0.38, y + r * 0.38);
    ctx.moveTo(x + r * 0.38, y - r * 0.38); ctx.lineTo(x - r * 0.38, y + r * 0.38);
  }
  ctx.stroke();
}

function arrow(ctx, ax, ay, bx, by, col = '#c98f14', w = 4) {
  const a = Math.atan2(by - ay, bx - ax);
  const head = w * 3.1;
  ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(ax, ay);
  ctx.lineTo(bx - Math.cos(a) * head * 0.8, by - Math.sin(a) * head * 0.8);
  ctx.lineWidth = w; ctx.strokeStyle = col; ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(bx, by);
  ctx.lineTo(bx - Math.cos(a - 0.42) * head, by - Math.sin(a - 0.42) * head);
  ctx.lineTo(bx - Math.cos(a + 0.42) * head, by - Math.sin(a + 0.42) * head);
  ctx.closePath();
  ctx.fillStyle = col; ctx.fill();
}

/* =================================================================== scenes */

/** Point ledger: what each thing on the board is worth. */
function sceneGoal(ctx, w, h) {
  const cy = h * 0.36;
  const cols = [[1, 'SETTLEMENT'], [2, 'CITY'], [1, 'VP CARD'], [0, 'ROAD']];
  // Inset the columns: the widest point chip has to clear the frame, and a
  // plain w/4 grid puts the last one hard against it.
  const pad = w * 0.035;
  const step = (w - pad * 2) / cols.length;
  const disc = Math.min(step * 0.40, h * 0.20);
  const k = disc * 0.52;
  cols.forEach(([pts, name], i) => {
    const x = pad + step * (i + 0.5);
    ctx.beginPath(); ctx.arc(x, cy, disc, 0, Math.PI * 2);
    ctx.fillStyle = pts ? 'rgba(255,201,60,.22)' : 'rgba(90,58,30,.10)';
    ctx.fill();
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = pts ? 'rgba(201,143,20,.55)' : 'rgba(90,58,30,.24)';
    ctx.stroke();
    if (i === 0) houseGlyph(ctx, x, cy + k * 0.2, k, BLUE);
    else if (i === 1) castleGlyph(ctx, x, cy + k * 0.2, k, BLUE);
    else if (i === 2) {
      ctx.save(); ctx.translate(x, cy); ctx.rotate(-0.16);
      ctx.fillStyle = '#f4e5c1';
      ctx.fillRect(-k * 0.74, -k * 1.05, k * 1.48, k * 2.1);
      ctx.lineWidth = 2.4; ctx.strokeStyle = '#2a1a0c';
      ctx.strokeRect(-k * 0.74, -k * 1.05, k * 1.48, k * 2.1);
      ctx.beginPath();
      for (let s = 0; s < 10; s++) {
        const rr = s % 2 ? k * 0.2 : k * 0.5;
        const aa = (Math.PI * s) / 5 - Math.PI / 2;
        const px = Math.cos(aa) * rr, py = Math.sin(aa) * rr;
        if (s === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fillStyle = '#ffc93c'; ctx.fill();
      ctx.lineWidth = 1.8; ctx.strokeStyle = '#2a1a0c'; ctx.stroke();
      ctx.restore();
    } else {
      roadSeg(ctx, x - k * 1.15, cy + k * 0.6, x + k * 1.15, cy - k * 0.6, k * 0.6, BLUE);
    }
    label(ctx, x, cy + disc + Math.max(9, h * 0.055), name,
      Math.max(8, h * 0.048), '#7a5228', step * 0.92);
    chip(ctx, x, cy + disc + Math.max(24, h * 0.145),
      pts === 0 ? 'NO PTS' : (pts === 1 ? '1 PT' : pts + ' PTS'),
      Math.max(8.5, h * 0.052),
      pts ? '#ffc93c' : '#e2cd9c', '#3a2208');
  });
  label(ctx, w / 2, h * 0.93, `FIRST TO ${VICTORY_POINTS} POINTS WINS THE ISLAND`,
    Math.max(10, h * 0.062), '#5a3a1e', w * 0.94);
}

/** The five kinds of land, side by side. */
function sceneLand(ctx, w, h) {
  const kinds = [
    ['forest', 'WOOD'], ['hills', 'BRICK'], ['pasture', 'WOOL'],
    ['fields', 'WHEAT'], ['mountains', 'ORE']
  ];
  const step = w / kinds.length;
  const R = Math.min(step * 0.47, h * 0.33);
  const cy = h * 0.42;
  kinds.forEach(([k, name], i) => {
    const cx = step * (i + 0.5);
    hexPlate(ctx, cx, cy, R, k, { seed: i * 9 + 2 });
    label(ctx, cx, h * 0.88, name, Math.max(9, h * 0.058), '#5a3a1e', step * 0.94);
  });
}

/** What the number on a hex actually means: two hexes, two readouts. */
function sceneNumber(ctx, w, h) {
  const R = Math.min(w * 0.16, h * 0.30);
  const cy = h * 0.40;
  const pairs = [
    { x: w * 0.27, n: 10, pips: 5, terrain: 'forest' },
    { x: w * 0.73, n: 1, pips: 1, terrain: 'fields' }
  ];
  for (const p of pairs) {
    hexPlate(ctx, p.x, cy, R, p.terrain, { seed: p.n * 5, density: p.pips >= 4 ? 1.3 : 0.5 });
    token(ctx, p.x, cy, R * 0.36, p.n);
    label(ctx, p.x, cy + R * 1.45,
      `${TILE_ITEMS[p.pips]} THINGS ON IT`, Math.max(9, h * 0.056), '#5a3a1e', w * 0.44);
    label(ctx, p.x, cy + R * 1.45 + Math.max(13, h * 0.082),
      `BACK IN ${TILE_REGEN[p.pips]}s`, Math.max(9, h * 0.056), '#7a5228', w * 0.44);
  }
  label(ctx, w / 2, h * 0.93, '1 IS THE POOREST HEX \u00b7 10 IS THE RICHEST',
    Math.max(9, h * 0.055), '#5a3a1e', w * 0.94);
}

/** The rule nobody guesses: ownership gates collecting. */
function sceneOwnership(ctx, w, h) {
  const R = Math.min(w * 0.19, h * 0.27);
  const cy = h * 0.36;
  const left = w * 0.26, right = w * 0.74;
  const colW = w * 0.46;
  const line1 = cy + R * 1.5;
  const line2 = line1 + Math.max(13, h * 0.085);

  hexPlate(ctx, left, cy, R, 'forest', { seed: 4 });
  settlerPin(ctx, left + R * 0.18, cy + R * 0.28, R * 0.2);
  ownerPip(ctx, left - R * 0.86, cy - R * 0.5, R * 0.32, BLUE, false, true);
  verdict(ctx, left + R * 0.92, cy - R * 0.82, R * 0.30, true);
  label(ctx, left, line1, 'YOUR SETTLEMENT', Math.max(9, h * 0.056), '#2e6b32', colW);
  label(ctx, left, line2, 'YOU COLLECT', Math.max(10, h * 0.064), '#5a3a1e', colW);

  hexPlate(ctx, right, cy, R, 'pasture', { seed: 11 });
  settlerPin(ctx, right + R * 0.18, cy + R * 0.28, R * 0.2);
  ownerPip(ctx, right - R * 0.86, cy - R * 0.5, R * 0.32, RED, false, false);
  verdict(ctx, right + R * 0.92, cy - R * 0.82, R * 0.30, false);
  label(ctx, right, line1, 'SOMEBODY ELSE’S', Math.max(9, h * 0.056), '#a33a22', colW);
  label(ctx, right, line2, 'YOU GET NOTHING', Math.max(10, h * 0.064), '#5a3a1e', colW);

  label(ctx, w / 2, h * 0.93, 'SAME SETTLER · SAME RUN · DIFFERENT HEX',
    Math.max(8.5, h * 0.05), '#7a5228', w * 0.94);
}

/** Contact pickup: a path across the hex, things gone behind it. */
function sceneContact(ctx, w, h) {
  const R = Math.min(w * 0.26, h * 0.38);
  const cx = w * 0.34, cy = h * 0.46;
  hexPlate(ctx, cx, cy, R, 'forest', { seed: 6, density: 1.4 });

  // the run: a curve through the hex, with the swept side cleared
  ctx.save();
  hexPath(ctx, cx, cy, R); ctx.clip();
  ctx.beginPath();
  ctx.moveTo(cx - R * 0.95, cy + R * 0.55);
  ctx.quadraticCurveTo(cx - R * 0.1, cy - R * 0.75, cx + R * 0.85, cy - R * 0.1);
  ctx.lineWidth = R * 0.30; ctx.strokeStyle = 'rgba(255,201,60,.30)';
  ctx.lineCap = 'round'; ctx.stroke();
  ctx.lineWidth = R * 0.07; ctx.setLineDash([R * 0.11, R * 0.11]);
  ctx.strokeStyle = 'rgba(255,236,180,.95)'; ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();

  settlerPin(ctx, cx + R * 0.85, cy - R * 0.1, R * 0.16);

  // the pickups popping off the trail
  const pops = [[-0.55, 0.15], [0.05, -0.42], [0.5, -0.44]];
  for (const [dx, dy] of pops) {
    chip(ctx, cx + dx * R, cy + dy * R - R * 0.42, '+1',
      Math.max(9, h * 0.055), '#ffd863', '#3a2208');
  }
  const tx = w * 0.79, cw = w * 0.38;
  label(ctx, tx, cy - h * 0.20, 'RUN OVER IT', Math.max(10, h * 0.062), '#5a3a1e', cw);
  label(ctx, tx, cy - h * 0.20 + Math.max(14, h * 0.085), 'AND IT IS YOURS',
    Math.max(10, h * 0.062), '#5a3a1e', cw);
  label(ctx, tx, cy + h * 0.08, 'NO TAPPING', Math.max(9, h * 0.052), '#7a5228', cw);
  label(ctx, tx, cy + h * 0.08 + Math.max(12, h * 0.072), 'NO WAITING',
    Math.max(9, h * 0.052), '#7a5228', cw);
}

/** A hex emptied, greyed out, counting down, then back. */
function sceneRecovery(ctx, w, h) {
  const R = Math.min(w * 0.145, h * 0.28);
  const cy = h * 0.40;
  const xs = [w * 0.19, w * 0.5, w * 0.81];

  const cw = w * 0.29;
  hexPlate(ctx, xs[0], cy, R, 'fields', { seed: 2, density: 1.4 });
  label(ctx, xs[0], cy + R * 1.55, 'FULL', Math.max(9.5, h * 0.058), '#5a3a1e', cw);

  hexPlate(ctx, xs[1], cy, R, 'fields', { bare: true, grey: true });
  // countdown ring
  ctx.beginPath();
  ctx.arc(xs[1], cy, R * 0.52, -Math.PI / 2, -Math.PI / 2 + Math.PI * 1.15);
  ctx.lineWidth = Math.max(4, R * 0.16); ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(255,201,60,.95)'; ctx.stroke();
  ctx.beginPath();
  ctx.arc(xs[1], cy, R * 0.52, 0, Math.PI * 2);
  ctx.lineWidth = Math.max(2, R * 0.06); ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.stroke();
  label(ctx, xs[1], cy, `${TILE_REGEN[3]}s`, Math.max(12, R * 0.5), '#fff2cf', R * 1.1);
  label(ctx, xs[1], cy + R * 1.55, 'RESTING', Math.max(9.5, h * 0.058), '#5a3a1e', cw);

  hexPlate(ctx, xs[2], cy, R, 'fields', { seed: 2, density: 1.4 });
  label(ctx, xs[2], cy + R * 1.55, 'ALL BACK', Math.max(9.5, h * 0.058), '#5a3a1e', cw);

  const hw = R * 0.87;                    // hex half-WIDTH, not its radius
  arrow(ctx, xs[0] + hw + 3, cy, xs[1] - hw - 3, cy, '#c98f14', 3);
  arrow(ctx, xs[1] + hw + 3, cy, xs[2] - hw - 3, cy, '#c98f14', 3);
  label(ctx, w / 2, h * 0.94, 'SO KEEP A LOOP OF HEXES GOING',
    Math.max(9, h * 0.055), '#7a5228', w * 0.94);
}

/** Roads join corners; settlements sit on them; cities replace them. */
function sceneBuild(ctx, w, h) {
  const R = Math.min(w * 0.165, h * 0.32);
  const cy = h * 0.46;
  const cx = w * 0.5 - R * Math.sqrt(3) / 2;
  hexPlate(ctx, cx, cy, R, 'hills', { seed: 8, density: 0.7 });
  hexPlate(ctx, cx + R * Math.sqrt(3), cy, R, 'forest', { seed: 12, density: 0.7 });

  const corner = (i, ox) => {
    const a = (Math.PI / 180) * (60 * i - 30);
    return [cx + ox + Math.cos(a) * R, cy + Math.sin(a) * R];
  };
  const a = corner(4, 0), b = corner(5, 0), c = corner(0, 0);
  roadSeg(ctx, a[0], a[1], b[0], b[1], Math.max(6, R * 0.16), BLUE);
  roadSeg(ctx, b[0], b[1], c[0], c[1], Math.max(6, R * 0.16), BLUE);
  ownerPip(ctx, a[0], a[1], R * 0.24, BLUE, false, true);
  ownerPip(ctx, c[0], c[1], R * 0.28, BLUE, true, true);

  label(ctx, a[0], a[1] - R * 0.74, 'SETTLEMENT', Math.max(8.5, h * 0.05), '#5a3a1e', R * 1.5);
  label(ctx, c[0], c[1] - R * 0.78, 'CITY', Math.max(8.5, h * 0.05), '#5a3a1e', R * 1.2);
  label(ctx, (b[0] + c[0]) / 2, (b[1] + c[1]) / 2 + R * 0.46, 'ROAD',
    Math.max(8.5, h * 0.05), '#5a3a1e', R * 1.0);
  label(ctx, w * 0.5, h * 0.94, 'ROADS JOIN CORNERS · BUILD ON YOUR OWN NETWORK',
    Math.max(8.5, h * 0.05), '#7a5228', w * 0.94);
}

/** Trading: the market ratio against a dock's. */
function sceneTrade(ctx, w, h) {
  const cy = h * 0.42;
  const box = (x, title, give, sub, gold) => {
    const bw = w * 0.40, bh = h * 0.56;
    ctx.beginPath();
    const r = 14, x0 = x - bw / 2, y0 = cy - bh / 2;
    ctx.moveTo(x0 + r, y0);
    ctx.arcTo(x0 + bw, y0, x0 + bw, y0 + bh, r);
    ctx.arcTo(x0 + bw, y0 + bh, x0, y0 + bh, r);
    ctx.arcTo(x0, y0 + bh, x0, y0, r);
    ctx.arcTo(x0, y0, x0 + bw, y0, r);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, y0, 0, y0 + bh);
    g.addColorStop(0, gold ? '#ffeec0' : '#fffaee');
    g.addColorStop(1, gold ? '#e3ae4d' : '#e0cba0');
    ctx.fillStyle = g; ctx.fill();
    ctx.lineWidth = 2.5; ctx.strokeStyle = '#5a3a1e'; ctx.stroke();
    label(ctx, x, y0 + bh * 0.20, title, Math.max(9.5, h * 0.058), '#5a3a1e', bw * 0.9);
    ctx.font = f(800, Math.max(24, h * 0.20));
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#5a3a1e';
    ctx.fillText(give, x, y0 + bh * 0.52);
    label(ctx, x, y0 + bh * 0.82, sub, Math.max(8, h * 0.048), '#7a5228', bw * 0.92);
  };
  box(w * 0.26, 'THE GREAT MARKET', `${TRADE_BASE} : 1`,
    `ANY ${TRADE_BASE} FOR ANY 1`, false);
  box(w * 0.74, 'A DOCK YOU OWN', `${PORT_GENERIC} : 1`,
    `OR ${PORT_SPECIAL} : 1 ON ITS GOODS`, true);
  label(ctx, w / 2, h * 0.93, 'WALK UP TO IT, THEN TAP THE OFFER',
    Math.max(9, h * 0.055), '#5a3a1e', w * 0.94);
}

/** The three development cards. */
function sceneCards(ctx, w, h) {
  const names = ['KNIGHT', 'ROAD BUILDING', 'VICTORY POINT'];
  const step = w / 3;
  const cw = Math.min(step * 0.72, h * 0.44), ch = cw * 1.42;
  const cy = h * 0.42;
  names.forEach((n, i) => {
    const cx = step * (i + 0.5);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((i - 1) * 0.07);
    const g = ctx.createLinearGradient(0, -ch / 2, 0, ch / 2);
    g.addColorStop(0, '#fffaea'); g.addColorStop(1, '#e0cb9c');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.rect(-cw / 2, -ch / 2, cw, ch);
    ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = '#5a3a1e'; ctx.stroke();
    ctx.lineWidth = 1.4; ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(90,58,30,.4)';
    ctx.strokeRect(-cw / 2 + 5, -ch / 2 + 5, cw - 10, ch - 10);
    ctx.setLineDash([]);
    const k = cw * 0.22;
    if (i === 0) {
      // a helm
      ctx.beginPath();
      ctx.moveTo(0, -k * 1.5);
      ctx.bezierCurveTo(k * 1.1, -k * 1.5, k * 1.1, k * 0.5, 0, k * 1.5);
      ctx.bezierCurveTo(-k * 1.1, k * 0.5, -k * 1.1, -k * 1.5, 0, -k * 1.5);
      ctx.closePath();
      ctx.fillStyle = '#aeb8c6'; ctx.fill();
      ctx.lineWidth = 2.4; ctx.strokeStyle = '#2a1a0c'; ctx.stroke();
      ctx.fillStyle = '#24303e';
      ctx.fillRect(-k * 0.8, -k * 0.35, k * 1.6, k * 0.32);
      ctx.fillRect(-k * 0.66, k * 0.2, k * 1.32, k * 0.26);
    } else if (i === 1) {
      roadSeg(ctx, -k * 1.3, k * 0.9, k * 1.3, -k * 0.2, k * 0.5, BLUE);
      roadSeg(ctx, -k * 1.1, -k * 1.1, k * 1.4, -k * 1.4, k * 0.5, BLUE);
    } else {
      ctx.beginPath();
      for (let s = 0; s < 10; s++) {
        const rr = s % 2 ? k * 0.52 : k * 1.32;
        const aa = (Math.PI * s) / 5 - Math.PI / 2;
        const px = Math.cos(aa) * rr, py = Math.sin(aa) * rr;
        if (s === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fillStyle = '#ffc93c'; ctx.fill();
      ctx.lineWidth = 2.4; ctx.strokeStyle = '#2a1a0c'; ctx.stroke();
    }
    ctx.restore();
    label(ctx, cx, cy + ch * 0.64, n, Math.max(8.5, h * 0.05), '#5a3a1e', step * 0.88);
  });
  const c = COST.card;
  label(ctx, w / 2, h * 0.94,
    `EACH CARD COSTS ${c.wool} WOOL · ${c.wheat} WHEAT · ${c.ore} ORE`,
    Math.max(9, h * 0.055), '#7a5228', w * 0.94);
}

/** The two bonuses. */
function sceneAwards(ctx, w, h) {
  const cy = h * 0.38;
  const cw = w * 0.44;
  // Longest road: a chain of segments
  const lx = w * 0.25;
  const pts = [
    [lx - w * 0.15, cy + h * 0.10], [lx - w * 0.06, cy - h * 0.07],
    [lx + w * 0.04, cy + h * 0.02], [lx + w * 0.13, cy - h * 0.12],
    [lx + w * 0.19, cy + h * 0.05]
  ];
  for (let i = 0; i < pts.length - 1; i++) {
    roadSeg(ctx, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1],
      Math.max(6, h * 0.045), BLUE);
  }
  label(ctx, lx, cy + h * 0.30, 'LONGEST ROAD', Math.max(9, h * 0.056), '#5a3a1e', cw);
  label(ctx, lx, cy + h * 0.30 + Math.max(12, h * 0.072),
    `${LONGEST_ROAD_MIN}+ IN ONE LINE`, Math.max(8, h * 0.047), '#7a5228', cw);
  chip(ctx, lx, cy + h * 0.30 + Math.max(28, h * 0.17), `+${LONGEST_ROAD_VP} POINTS`,
    Math.max(9.5, h * 0.057), '#ffc93c', '#3a2208');

  // Largest army: knight shields, LARGEST_ARMY_MIN of them earned.
  const rx = w * 0.75;
  const k = Math.min(w * 0.05, h * 0.10);
  for (let i = 0; i < 3; i++) {
    const sx = rx + (i - 1) * k * 2.5;
    const on = i < LARGEST_ARMY_MIN;
    ctx.beginPath();
    ctx.moveTo(sx - k, cy - k * 1.2);
    ctx.lineTo(sx + k, cy - k * 1.2);
    ctx.lineTo(sx + k, cy + k * 0.2);
    ctx.quadraticCurveTo(sx + k * 0.9, cy + k * 1.25, sx, cy + k * 1.5);
    ctx.quadraticCurveTo(sx - k * 0.9, cy + k * 1.25, sx - k, cy + k * 0.2);
    ctx.closePath();
    ctx.fillStyle = on ? '#aeb8c6' : 'rgba(174,184,198,.28)';
    ctx.fill();
    if (on) {
      ctx.save(); ctx.clip();
      ctx.fillStyle = '#dde4ee';
      ctx.fillRect(sx - k, cy - k * 1.2, k, k * 2.8);
      ctx.restore();
      ctx.fillStyle = '#24303e';
      ctx.fillRect(sx - k * 0.62, cy - k * 0.4, k * 1.24, k * 0.3);
    }
    ctx.lineWidth = 2.4; ctx.strokeStyle = 'rgba(42,26,12,.85)'; ctx.stroke();
  }
  label(ctx, rx, cy + h * 0.30, 'LARGEST ARMY', Math.max(9, h * 0.056), '#5a3a1e', cw);
  label(ctx, rx, cy + h * 0.30 + Math.max(12, h * 0.072),
    `${LARGEST_ARMY_MIN}+ KNIGHTS PLAYED`, Math.max(8, h * 0.047), '#7a5228', cw);
  chip(ctx, rx, cy + h * 0.30 + Math.max(28, h * 0.17), `+${LARGEST_ARMY_VP} POINTS`,
    Math.max(9.5, h * 0.057), '#ffc93c', '#3a2208');
}

const SCENES = {
  goal: sceneGoal,
  land: sceneLand,
  number: sceneNumber,
  ownership: sceneOwnership,
  contact: sceneContact,
  recovery: sceneRecovery,
  build: sceneBuild,
  trade: sceneTrade,
  cards: sceneCards,
  awards: sceneAwards
};

export function hasScene(name) {
  return Object.prototype.hasOwnProperty.call(SCENES, name);
}

/** Paint one illustration into an already-scaled 2D context. */
export function paintScene(name, ctx, w, h) {
  const fn = SCENES[name];
  if (!fn || !ctx || !(w > 0) || !(h > 0)) return false;
  ctx.save();
  ctx.clearRect(0, 0, w, h);
  ctx.lineJoin = 'round';
  try { fn(ctx, w, h); } catch (e) { /* a diagram is never worth a crash */ }
  ctx.restore();
  return true;
}

export default paintScene;
