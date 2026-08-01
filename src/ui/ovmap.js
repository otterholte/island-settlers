/**
 * Island Settlers — board map painting.
 *
 *   createPainter(ctx, proj) -> { ...draw fns, tokenRects(), portRects() }
 *
 * Everything that puts pixels on the overview canvas lives here so
 * `overview.js` can stay about interaction. The painter reads `proj`
 * live — overview.js mutates that object on resize — so no state is
 * cached across frames.
 *
 * The map is meant to read as a *board*: a painted sea with depth bands,
 * a carved outer frame, an island that sits on the water with a beach and
 * a shelf, hex plates with real thickness, and wooden number discs that
 * match the ones standing in the 3D world.
 *
 * Owner: UI agent.
 */

import { HEX_SIZE, pipsFor } from '../core/constants.js';
import { tiles, intersections, edges, ports, BOUNDS, cornerOffset } from '../board/layout.js';
import { hash01 } from './dom.js';

/** Five terrains plus desert, tuned for tonal separation at thumbnail size:
    dark green / light green / orange / gold / cool grey / pale sand. */
export const TERRAIN = {
  forest:    { a: '#57a63e', b: '#256b22', rim: '#123f16', motif: 'tree' },
  hills:     { a: '#e28a48', b: '#a4501f', rim: '#632d10', motif: 'bump' },
  pasture:   { a: '#aede63', b: '#65ab39', rim: '#3a6a20', motif: 'dot' },
  fields:    { a: '#f8d75e', b: '#cd9a20', rim: '#7f5b0d', motif: 'stripe' },
  mountains: { a: '#bcc6d3', b: '#6b7684', rim: '#3c4552', motif: 'peak' },
  desert:    { a: '#f2dfb2', b: '#d2b077', rim: '#8b7343', motif: 'speck' }
};

const FONT = `'Trebuchet MS','Avenir Next Condensed','Segoe UI',system-ui,sans-serif`;
export const f = (w, s) => `${w} ${s}px ${FONT}`;

export function createPainter(ctx, proj) {
  const PX = x => x * proj.s + proj.ox;
  const PY = z => z * proj.s + proj.oy;

  /* ------------------------------------------------------------- geometry */

  function hexPath(t, inflate = 0, dy = 0, begin = true) {
    if (begin) ctx.beginPath();
    const k = 1 + inflate;
    for (let i = 0; i < 6; i++) {
      const o = cornerOffset(i);
      const x = PX(t.x) + o.x * proj.s * k;
      const y = PY(t.z) + o.z * proj.s * k + dy;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  /** One path holding all 19 hexes. Wound identically, so a nonzero fill
      renders their union — that is what gives the island one silhouette
      instead of nineteen overlapping stamps. */
  function islandPath(inflate, dy) {
    ctx.beginPath();
    for (const t of tiles) hexPath(t, inflate, dy, false);
  }

  function rounded(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /** A rounded plate — the one shape every label on this map sits on. */
  function plate(x, y, w, h, fill, stroke, rad, lw) {
    rounded(x - w / 2, y - h / 2, w, h, rad === undefined ? Math.min(h / 2, 7) : rad);
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.55)'; ctx.shadowBlur = 8; ctx.shadowOffsetY = 3;
    ctx.fillStyle = fill; ctx.fill();
    ctx.restore();
    ctx.lineWidth = lw || 2; ctx.strokeStyle = stroke; ctx.stroke();
  }

  /* ------------------------------------------------------------------ sea */

  function drawSea() {
    const { w, h } = proj;
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#062a52');
    g.addColorStop(0.5, '#0b4b86');
    g.addColorStop(1, '#0a3a68');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    const cx = PX(BOUNDS.cx), cy = PY(BOUNDS.cz);
    const rr = (BOUNDS.radius + HEX_SIZE) * proj.s;

    // Depth bands: the water gets warmer and shallower toward the island.
    const bands = [
      [1.34, 'rgba(20,124,178,.42)'],
      [1.16, 'rgba(38,162,196,.44)'],
      [1.03, 'rgba(78,206,214,.40)']
    ];
    for (const [k, col] of bands) {
      ctx.beginPath(); ctx.arc(cx, cy, rr * k, 0, Math.PI * 2);
      ctx.fillStyle = col; ctx.fill();
    }

    // Swell lines — hand-drawn chart feel, never a mechanical ring.
    ctx.strokeStyle = 'rgba(226,248,255,.20)';
    ctx.lineCap = 'round';
    for (let i = 0; i < 5; i++) {
      const rad = rr * (1.10 + i * 0.085);
      const a0 = 0.35 + i * 1.24, a1 = a0 + 0.85 + hash01(i * 3.3) * 0.7;
      ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.arc(cx, cy, rad, a0, a1); ctx.stroke();
      ctx.lineWidth = 1.1;
      ctx.beginPath(); ctx.arc(cx, cy, rad + 5, a0 + 0.16, a1 - 0.2); ctx.stroke();
    }

    // Vignette — the map is lit at the middle and falls away at the frame.
    const vg = ctx.createRadialGradient(cx, cy, rr * 0.7, cx, cy, Math.max(w, h) * 0.82);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(2,10,22,.72)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, w, h);
  }

  /** The carved outer frame: a brass bead, a dark reveal and corner studs. */
  function drawFrame(fr) {
    const r = 16;
    ctx.save();
    rounded(fr.x + 1, fr.y + 1, fr.w - 2, fr.h - 2, r);
    ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(3,12,24,.85)'; ctx.stroke();

    rounded(fr.x + 3.5, fr.y + 3.5, fr.w - 7, fr.h - 7, r - 2);
    const bg = ctx.createLinearGradient(0, fr.y, 0, fr.y + fr.h);
    bg.addColorStop(0, '#ffe1a0');
    bg.addColorStop(0.45, '#c08a2c');
    bg.addColorStop(1, '#8a5c15');
    ctx.lineWidth = 3; ctx.strokeStyle = bg; ctx.stroke();

    rounded(fr.x + 7, fr.y + 7, fr.w - 14, fr.h - 14, r - 5);
    ctx.lineWidth = 1.4; ctx.strokeStyle = 'rgba(6,18,34,.6)'; ctx.stroke();

    const studs = [
      [fr.x + 13, fr.y + 13], [fr.x + fr.w - 13, fr.y + 13],
      [fr.x + 13, fr.y + fr.h - 13], [fr.x + fr.w - 13, fr.y + fr.h - 13]
    ];
    for (const [sx, sy] of studs) {
      ctx.beginPath(); ctx.arc(sx, sy, 3.6, 0, Math.PI * 2);
      const sg = ctx.createLinearGradient(sx, sy - 4, sx, sy + 4);
      sg.addColorStop(0, '#ffeec0'); sg.addColorStop(1, '#96661a');
      ctx.fillStyle = sg; ctx.fill();
      ctx.lineWidth = 1.2; ctx.strokeStyle = 'rgba(6,18,34,.8)'; ctx.stroke();
    }
    ctx.restore();
  }

  /* --------------------------------------------------------------- island */

  /** Scatter dressing. Each element gets its own light and shade so a tile
      reads as painted terrain rather than a flat swatch. */
  function motif(t, kind, s) {
    const cx = PX(t.x), cy = PY(t.z);
    const n = kind === 'dot' || kind === 'speck' ? 12 : 9;
    for (let i = 0; i < n; i++) {
      const a = hash01(t.id * 31.7 + i * 5.3) * Math.PI * 2;
      const rr = (0.16 + hash01(t.id * 7.1 + i * 2.9) * 0.66) * HEX_SIZE * s;
      const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr * 0.9;
      const k = HEX_SIZE * s * (0.10 + hash01(i * 3.3 + t.id) * 0.06);
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

  /** Sea shelf, beach and the drop shadow the island casts on the water. */
  function drawShelf() {
    const s = proj.s;
    const lift = HEX_SIZE * s * 0.24;

    islandPath(0.30, lift * 0.5);
    ctx.fillStyle = 'rgba(120,232,232,.34)'; ctx.fill();

    ctx.save();
    ctx.shadowColor = 'rgba(2,14,30,.62)'; ctx.shadowBlur = 18; ctx.shadowOffsetY = 9;
    islandPath(0.155, lift * 0.35);
    ctx.fillStyle = '#e9d3a1'; ctx.fill();
    ctx.restore();

    islandPath(0.155, lift * 0.35);
    ctx.lineWidth = Math.max(1.5, s * 0.1);
    ctx.strokeStyle = 'rgba(120,86,36,.5)'; ctx.stroke();

    // The rock the island stands on, pushed down so the plates have thickness.
    islandPath(0.045, lift * 2.35);
    ctx.fillStyle = '#3a2a18'; ctx.fill();
  }

  function drawTiles() {
    const s = proj.s;
    const lift = HEX_SIZE * s * 0.24;
    const R = HEX_SIZE * s;

    for (const t of tiles) {
      const pal = TERRAIN[t.terrain] || TERRAIN.desert;
      hexPath(t, 0.012, lift);
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
      g.addColorStop(0.6, pal.b);
      g.addColorStop(1, pal.rim);
      ctx.fillStyle = g;
      ctx.fillRect(cx - R * 1.2, cy - R * 1.2, R * 2.4, R * 2.4);

      // Sun off the upper-left, the way the 3D scene is lit.
      const sun = ctx.createRadialGradient(
        cx - R * 0.34, cy - R * 0.44, R * 0.08, cx - R * 0.2, cy - R * 0.3, R * 1.25);
      sun.addColorStop(0, 'rgba(255,250,220,.38)');
      sun.addColorStop(1, 'rgba(255,250,220,0)');
      ctx.fillStyle = sun;
      ctx.fillRect(cx - R * 1.2, cy - R * 1.2, R * 2.4, R * 2.4);

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

      const vig = ctx.createRadialGradient(cx, cy, R * 0.52, cx, cy, R * 1.06);
      vig.addColorStop(0, 'rgba(0,0,0,0)');
      vig.addColorStop(1, 'rgba(10,22,12,.34)');
      ctx.fillStyle = vig;
      ctx.fillRect(cx - R * 1.2, cy - R * 1.2, R * 2.4, R * 2.4);

      ctx.save();
      ctx.translate(0, R * 0.11);
      hexPath(t, 0);
      ctx.lineWidth = Math.max(2, s * 0.24);
      ctx.strokeStyle = 'rgba(255,252,228,.36)';
      ctx.stroke();
      ctx.restore();
      ctx.restore();

      hexPath(t, 0);
      ctx.lineWidth = Math.max(1.7, s * 0.14);
      ctx.strokeStyle = 'rgba(8,22,12,.66)';
      ctx.stroke();
    }
  }

  /* --------------------------------------------------------------- tokens */

  /* A third of the hex radius. The old floor of 13px was absolute, so on a
     667x375 phone the discs grew to the full radius of the hex they sat on and
     buried the terrain under them. */
  const tokenR = () => Math.max(10.5, HEX_SIZE * proj.s * 0.33);

  /** Where every number disc sits, in canvas css px. Label placement treats
      these as no-go zones — the numbers are what the player is reading. */
  function tokenRects() {
    const r = tokenR();
    const out = [];
    for (const t of tiles) {
      if (!t.number) continue;
      out.push({
        x: PX(t.x), y: PY(t.z),
        w: r * 2.16, h: r * 2.3, weight: 260, kind: 'token'
      });
    }
    return out;
  }

  function drawToken(t) {
    if (!t.number) return;
    const r = tokenR();
    const cx = PX(t.x), cy = PY(t.z);
    const hot = t.number === 6 || t.number === 8;

    ctx.beginPath(); ctx.arc(cx, cy + r * 0.2, r * 1.06, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,.42)'; ctx.fill();

    // Dark wooden rim, then the cream face inset into it.
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
    const rim = ctx.createLinearGradient(0, cy - r, 0, cy + r);
    rim.addColorStop(0, '#7a4f24'); rim.addColorStop(1, '#3a2210');
    ctx.fillStyle = rim; ctx.fill();

    ctx.beginPath(); ctx.arc(cx, cy, r * 0.86, 0, Math.PI * 2);
    const g = ctx.createLinearGradient(0, cy - r, 0, cy + r);
    g.addColorStop(0, '#fffaea'); g.addColorStop(0.52, '#f4e5c1'); g.addColorStop(1, '#d8c091');
    ctx.fillStyle = g; ctx.fill();

    ctx.beginPath(); ctx.arc(cx, cy - r * 0.16, r * 0.68, Math.PI * 1.14, Math.PI * 1.86);
    ctx.lineWidth = Math.max(1.3, r * 0.10);
    ctx.strokeStyle = 'rgba(255,255,255,.8)'; ctx.stroke();

    if (hot) {
      ctx.beginPath(); ctx.arc(cx, cy, r * 0.93, 0, Math.PI * 2);
      ctx.lineWidth = Math.max(1.4, r * 0.11);
      ctx.strokeStyle = 'rgba(192,39,27,.85)'; ctx.stroke();
    }

    ctx.fillStyle = hot ? '#bd2114' : '#33200a';
    ctx.font = f(800, Math.round(r * 1.18));
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(t.number), cx, cy - r * 0.15);

    const pips = pipsFor(t.number);
    const pr = Math.max(1.5, r * 0.115);
    for (let i = 0; i < pips; i++) {
      const x = cx + (i - (pips - 1) / 2) * pr * 2.9;
      ctx.beginPath(); ctx.arc(x, cy + r * 0.56, pr, 0, Math.PI * 2);
      ctx.fillStyle = hot ? '#bd2114' : '#523318'; ctx.fill();
    }
  }

  function drawTokens() { for (const t of tiles) drawToken(t); }

  /* ---------------------------------------------------------------- ports */

  const PORT_W = 42, PORT_H = 25;

  function portRects() {
    return ports.map(p => ({
      x: PX(p.x), y: PY(p.z), w: PORT_W + 6, h: PORT_H + 6, weight: 22, kind: 'port'
    }));
  }

  function drawPorts(state) {
    const s = proj.s;
    const mine = state.players[0].ports;
    for (const p of ports) {
      const e = edges[p.edge];
      const unlocked = mine.has(p.id);
      const px = PX(p.x), py = PY(p.z);

      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(PX(e.x), PY(e.z)); ctx.lineTo(px, py);
      ctx.lineWidth = Math.max(3.4, s * 0.34);
      ctx.strokeStyle = 'rgba(10,24,42,.75)'; ctx.stroke();
      ctx.beginPath(); ctx.moveTo(PX(e.x), PY(e.z)); ctx.lineTo(px, py);
      ctx.lineWidth = Math.max(1.7, s * 0.18);
      ctx.strokeStyle = unlocked ? '#ffc93c' : '#d3bd94'; ctx.stroke();

      plate(px, py, PORT_W, PORT_H,
        unlocked ? '#ffd764' : '#f5ead2',
        unlocked ? '#6f4505' : '#5a3a1e', 8, 2.2);
      ctx.beginPath();
      rounded(px - PORT_W / 2 + 3.5, py - PORT_H / 2 + 3, PORT_W - 7, 5, 2.5);
      ctx.fillStyle = 'rgba(255,255,255,.62)'; ctx.fill();

      ctx.fillStyle = '#3a2208';
      ctx.font = f(800, 14);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(p.label, px, py + 1.5);
    }
  }

  /* -------------------------------------------------------------- network */

  function drawRoads(state) {
    const s = proj.s;
    const w = Math.max(8, s * 1.3);
    for (const [eid, pid] of state.roadOwner) {
      const e = edges[eid];
      const A = intersections[e.a], B = intersections[e.b];
      const col = state.players[pid].color;
      const mine = pid === 0;
      const ax = PX(A.x), ay = PY(A.z), bx = PX(B.x), by = PY(B.z);
      ctx.lineCap = 'round';
      if (mine) {
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
        ctx.lineWidth = w + Math.max(5, s * 0.46);
        ctx.strokeStyle = 'rgba(255,201,60,.42)';
        ctx.stroke();
      }
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
      ctx.lineWidth = w + Math.max(2.4, s * 0.24);
      ctx.strokeStyle = 'rgba(8,18,10,.72)';
      ctx.stroke();
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
      ctx.lineWidth = w;
      ctx.strokeStyle = col.css;
      ctx.stroke();
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
      ctx.lineWidth = w * 0.34;
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

  /** Owner-coloured pip with the piece glyph on it. The human's pieces wear a
      gold ring so "which of these is mine" is never a question. */
  function ownerPip(x, y, r, col, city, mine) {
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
    if (city) castleGlyph(x, y + k * 0.1, k, { css: '#f4f8ff', light: '#ffffff' });
    else houseGlyph(x, y + k * 0.1, k, { css: '#f4f8ff', light: '#ffffff' });
  }

  function drawBuildings(state) {
    const r = Math.max(9.5, proj.s * 0.9);
    for (const [iid, b] of state.buildings) {
      const n = intersections[iid];
      const col = state.players[b.owner].color;
      const mine = b.owner === 0;
      ownerPip(PX(n.x), PY(n.z),
        (b.type === 'city' ? r * 1.22 : r) * (mine ? 1.1 : 1),
        col, b.type === 'city', mine);
    }
  }

  function drawRobber(state) {
    const t = tiles[state.robberTile];
    if (!t) return;
    const s = proj.s;
    hexPath(t, 0);
    ctx.fillStyle = 'rgba(8,14,24,.46)'; ctx.fill();
    const x = PX(t.x), y = PY(t.z) - HEX_SIZE * s * 0.42;
    const k = Math.max(5, s * 0.9);
    ctx.beginPath();
    ctx.moveTo(x - k, y + k * 1.1);
    ctx.quadraticCurveTo(x - k * 0.9, y - k * 1.35, x, y - k * 1.35);
    ctx.quadraticCurveTo(x + k * 0.9, y - k * 1.35, x + k, y + k * 1.1);
    ctx.closePath();
    ctx.fillStyle = '#232f3d'; ctx.fill();
    ctx.lineWidth = Math.max(1, k * 0.24);
    ctx.strokeStyle = 'rgba(255,255,255,.38)'; ctx.stroke();
    ctx.fillStyle = '#ff5a3c';
    ctx.beginPath(); ctx.arc(x - k * 0.33, y - k * 0.25, k * 0.17, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(x + k * 0.33, y - k * 0.25, k * 0.17, 0, Math.PI * 2); ctx.fill();
  }

  return {
    PX, PY, hexPath, plate, rounded,
    drawSea, drawFrame, drawShelf, drawTiles, drawTokens, tokenRects,
    drawPorts, portRects, drawRoads, drawBuildings, drawRobber, ownerPip
  };
}

export default createPainter;
