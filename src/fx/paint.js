/**
 * Island Settlers — canvas-painted FX textures.
 *
 * Two atlases, both painted to an offscreen <canvas> at construction:
 *
 *  1. PARTICLE ATLAS  256x256, 2x2 cells — chip / tuft / spark / sliver.
 *     Painted white so the shader can tint every particle individually.
 *  2. LABEL ATLAS     1024x512, 8x8 cells of 128x64 — floating "+2" labels
 *     with a resource glyph, painted on demand and cached by (text, kind).
 *
 * No image files, no webfonts. Everything degrades to null (and the shaders
 * to procedural shapes) if there is no DOM.
 */

import * as THREE from 'three';
import { RES_COLOR } from '../core/constants.js';

const G = typeof globalThis !== 'undefined' ? globalThis : {};

export function makeCanvas(w, h) {
  const doc = G.document;
  if (!doc || typeof doc.createElement !== 'function') return null;
  let c = null;
  try { c = doc.createElement('canvas'); } catch (e) { return null; }
  if (!c) return null;
  c.width = w; c.height = h;
  return c;
}

function ctxOf(canvas) {
  if (!canvas || typeof canvas.getContext !== 'function') return null;
  let g = null;
  try { g = canvas.getContext('2d'); } catch (e) { return null; }
  return g || null;
}

const hexCss = h => '#' + ('000000' + (h >>> 0).toString(16)).slice(-6);

/* --------------------------------------------------------- particle atlas */

export const CELL = { CHIP: 0, TUFT: 1, SPARK: 2, SLIVER: 3 };

function paintChip(g, s) {
  g.save();
  g.translate(s / 2, s / 2);
  g.beginPath();
  g.moveTo(-s * 0.30, -s * 0.20);
  g.lineTo(s * 0.32, -s * 0.30);
  g.lineTo(s * 0.28, s * 0.24);
  g.lineTo(-s * 0.26, s * 0.30);
  g.closePath();
  g.fillStyle = '#ffffff';
  g.fill();
  // a darker facet so chips read as solid volume, not flat confetti
  g.beginPath();
  g.moveTo(-s * 0.30, -s * 0.20);
  g.lineTo(s * 0.32, -s * 0.30);
  g.lineTo(s * 0.10, s * 0.02);
  g.closePath();
  g.fillStyle = 'rgba(255,255,255,0.55)';
  g.fill();
  g.restore();
}

function paintTuft(g, s) {
  const c = s / 2;
  const blobs = [
    [0, 0, 0.30], [-0.16, -0.10, 0.20], [0.17, -0.08, 0.19],
    [-0.10, 0.16, 0.18], [0.12, 0.17, 0.17]
  ];
  for (const b of blobs) {
    const r = b[2] * s;
    const x = c + b[0] * s, y = c + b[1] * s;
    let grad = null;
    try {
      grad = g.createRadialGradient(x, y, r * 0.1, x, y, r);
      grad.addColorStop(0, 'rgba(255,255,255,0.95)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
    } catch (e) { grad = null; }
    g.fillStyle = grad || 'rgba(255,255,255,0.55)';
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
}

function paintSpark(g, s) {
  const c = s / 2;
  let grad = null;
  try {
    grad = g.createRadialGradient(c, c, 0, c, c, s * 0.48);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.22, 'rgba(255,255,255,0.85)');
    grad.addColorStop(0.55, 'rgba(255,255,255,0.22)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
  } catch (e) { grad = null; }
  g.fillStyle = grad || 'rgba(255,255,255,0.8)';
  g.beginPath();
  g.arc(c, c, s * 0.48, 0, Math.PI * 2);
  g.fill();
  // four-point star flare
  g.strokeStyle = 'rgba(255,255,255,0.7)';
  g.lineWidth = Math.max(1, s * 0.035);
  g.beginPath();
  g.moveTo(c - s * 0.42, c); g.lineTo(c + s * 0.42, c);
  g.moveTo(c, c - s * 0.42); g.lineTo(c, c + s * 0.42);
  g.stroke();
}

function paintSliver(g, s) {
  g.save();
  g.translate(s / 2, s / 2);
  g.rotate(-0.5);
  g.beginPath();
  g.moveTo(-s * 0.36, 0);
  g.lineTo(0, -s * 0.09);
  g.lineTo(s * 0.36, 0);
  g.lineTo(0, s * 0.09);
  g.closePath();
  g.fillStyle = '#ffffff';
  g.fill();
  g.restore();
}

/** 2x2 white shape atlas used by both particle systems. */
export function buildParticleAtlas() {
  const S = 128;
  const canvas = makeCanvas(S * 2, S * 2);
  const g = ctxOf(canvas);
  if (!g) return null;
  g.clearRect(0, 0, S * 2, S * 2);
  const painters = [paintChip, paintTuft, paintSpark, paintSliver];
  for (let i = 0; i < 4; i++) {
    g.save();
    g.translate((i % 2) * S, ((i / 2) | 0) * S);
    painters[i](g, S);
    g.restore();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace;      // white masks, tinted in the shader
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/* ------------------------------------------------------------ label atlas */

const GLYPH = {
  wood(g, x, y, r) {                       // log end
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.arc(x, y, r * 0.5, 0, Math.PI * 2); g.stroke();
  },
  brick(g, x, y, r) {                      // brick
    g.beginPath();
    g.rect(x - r, y - r * 0.62, r * 2, r * 1.24);
    g.fill(); g.stroke();
  },
  wool(g, x, y, r) {                       // fleece
    g.beginPath();
    g.arc(x - r * 0.4, y, r * 0.62, 0, Math.PI * 2);
    g.arc(x + r * 0.4, y, r * 0.62, 0, Math.PI * 2);
    g.arc(x, y - r * 0.4, r * 0.6, 0, Math.PI * 2);
    g.fill();
  },
  wheat(g, x, y, r) {                      // sheaf
    g.beginPath();
    g.moveTo(x, y - r); g.lineTo(x + r * 0.55, y); g.lineTo(x, y + r);
    g.lineTo(x - r * 0.55, y); g.closePath();
    g.fill();
  },
  ore(g, x, y, r) {                        // crystal
    g.beginPath();
    g.moveTo(x, y - r); g.lineTo(x + r * 0.8, y - r * 0.15);
    g.lineTo(x + r * 0.45, y + r); g.lineTo(x - r * 0.45, y + r);
    g.lineTo(x - r * 0.8, y - r * 0.15); g.closePath();
    g.fill();
  }
};

/**
 * Lazily painted 8x8 atlas of world-space labels. Cells are recycled round
 * robin if the game ever asks for more than 64 distinct strings, which it
 * will not — a match uses a handful.
 */
export function createLabelAtlas() {
  const COLS = 8, ROWS = 8, CW = 128, CH = 64;
  const canvas = makeCanvas(COLS * CW, ROWS * CH);
  const g = ctxOf(canvas);
  if (!g) return null;
  g.clearRect(0, 0, COLS * CW, ROWS * CH);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;

  const map = new Map();
  let next = 0;

  function paintCell(idx, text, kind) {
    const cx = (idx % COLS) * CW;
    const cy = ((idx / COLS) | 0) * CH;
    g.save();
    g.clearRect(cx, cy, CW, CH);
    g.translate(cx, cy);

    const col = hexCss(RES_COLOR[kind] !== undefined ? RES_COLOR[kind] : 0xffffff);
    const hasGlyph = !!GLYPH[kind];
    const gx = 22, gy = CH * 0.5, gr = 13;
    const tx = hasGlyph ? 42 : CW * 0.5;

    g.lineJoin = 'round';
    g.miterLimit = 2;
    g.textBaseline = 'middle';
    g.textAlign = hasGlyph ? 'left' : 'center';
    g.font = '800 40px ui-sans-serif, system-ui, "Segoe UI", Roboto, Arial, sans-serif';

    // glyph: dark outline then flat colour, same recipe as the text
    if (hasGlyph) {
      g.strokeStyle = 'rgba(20,14,8,0.95)';
      g.lineWidth = 7;
      g.fillStyle = 'rgba(20,14,8,0.95)';
      GLYPH[kind](g, gx, gy, gr + 1.5);
      g.fillStyle = col;
      g.strokeStyle = 'rgba(20,14,8,0.0)';
      g.lineWidth = 0.001;
      GLYPH[kind](g, gx, gy, gr);
    }

    // text: heavy dark outline so it reads on grass and on rock
    g.strokeStyle = 'rgba(18,12,6,0.96)';
    g.lineWidth = 9;
    g.strokeText(text, tx, gy + 1);
    g.lineWidth = 5;
    g.strokeStyle = 'rgba(18,12,6,0.9)';
    g.strokeText(text, tx, gy + 1);
    g.fillStyle = '#ffffff';
    g.fillText(text, tx, gy - 1);
    g.fillStyle = col;
    g.globalAlpha = 0.55;
    g.fillText(text, tx, gy - 1);
    g.globalAlpha = 1;
    g.restore();
    tex.needsUpdate = true;
  }

  return {
    texture: tex,
    cols: COLS,
    rows: ROWS,
    /** Index of the atlas cell holding this label, painting it if needed. */
    cell(text, kind) {
      const key = text + '|' + kind;
      let idx = map.get(key);
      if (idx !== undefined) return idx;
      idx = next % (COLS * ROWS);
      next++;
      // evict whatever used to live in this cell
      if (map.size >= COLS * ROWS) {
        for (const [k, v] of map) { if (v === idx) { map.delete(k); break; } }
      }
      map.set(key, idx);
      paintCell(idx, String(text), kind);
      return idx;
    }
  };
}

export default { buildParticleAtlas, createLabelAtlas, makeCanvas, CELL };
