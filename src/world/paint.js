/**
 * Island Settlers — procedural canvas painting.
 *
 * Every texture in the world is drawn here at boot. No image files, no CDN,
 * no webfonts: system font stacks only.
 */

import * as THREE from 'three';

const STACK = '"Trebuchet MS","Arial Black",Impact,system-ui,sans-serif';

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

export function canvasTexture(w, h, draw, opts = {}) {
  const c = makeCanvas(w, h);
  const g = c.getContext('2d');
  if (g) draw(g, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = opts.raw ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = opts.wrap || THREE.ClampToEdgeWrapping;
  t.anisotropy = opts.aniso || 4;
  t.needsUpdate = true;
  return t;
}

/* ------------------------------------------------------------ hex helpers */

function disc(g, x, y, r, fill) {
  g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fillStyle = fill; g.fill();
}

function ring(g, x, y, r, w, stroke) {
  g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2);
  g.lineWidth = w; g.strokeStyle = stroke; g.stroke();
}

/* ------------------------------------------------------- number token atlas */

/* The gameplay-critical colour convention: 6 and 8 are RED, everything else
   is near-black. Both sit on a bone/cream disc with a single thin dark ring.
   The old art stacked a dark-brown ring, a mid-brown ring and a brown numeral
   on a cream face — brown on brown, illegible at gameplay size. */
const HOT = '#cf2a1e';
const HOT_DARK = '#8d1a11';
const INK = '#16110c';
const BONE = '#f7efdc';
const BONE_HI = '#fffaf0';
const RIM = '#33251a';

function paintToken(g, cx, cy, R, number, pips) {
  const hot = number === 6 || number === 8;

  // contact shadow under the disc
  g.save();
  g.globalAlpha = 0.30;
  disc(g, cx, cy + R * 0.085, R * 0.985, '#1d1207');
  g.restore();

  // ONE thin dark ring, then the bone face. Nothing else eats the disc.
  disc(g, cx, cy, R * 0.965, RIM);
  disc(g, cx, cy, R * 0.885, BONE);

  // gentle top bevel — kept subtle so the numeral keeps full contrast
  const grd = g.createLinearGradient(cx, cy - R, cx, cy + R);
  grd.addColorStop(0, 'rgba(255,255,255,0.75)');
  grd.addColorStop(0.45, 'rgba(255,255,255,0.06)');
  grd.addColorStop(1, 'rgba(150,116,74,0.22)');
  g.save();
  g.beginPath(); g.arc(cx, cy, R * 0.885, 0, Math.PI * 2); g.clip();
  g.fillStyle = grd; g.fillRect(cx - R, cy - R, R * 2, R * 2);
  g.restore();
  ring(g, cx, cy, R * 0.845, R * 0.022, 'rgba(51,37,26,0.30)');

  // ------------------------------------------------------------- numeral
  const label = String(number);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  // Big: the numeral is the whole point of the token.
  const size = label.length > 1 ? R * 1.12 : R * 1.34;
  g.font = `900 ${size}px ${STACK}`;
  const ny = cy - R * 0.13;
  g.lineJoin = 'round';
  g.lineWidth = R * 0.10;
  // a bone halo keeps the glyph readable over the bevel
  g.strokeStyle = BONE_HI;
  g.strokeText(label, cx, ny);
  g.lineWidth = R * 0.05;
  g.strokeStyle = hot ? HOT_DARK : INK;
  g.strokeText(label, cx, ny);
  g.fillStyle = hot ? HOT : INK;
  g.fillText(label, cx, ny);

  // ---------------------------------------------------------------- pips
  const pr = R * 0.072;
  const gap = pr * 2.9;
  const py = cy + R * 0.535;
  const x0 = cx - (pips - 1) * gap * 0.5;
  for (let i = 0; i < pips; i++) {
    disc(g, x0 + i * gap, py, pr, hot ? HOT : INK);
  }
}

/**
 * One atlas holding every number token. Returns { texture, cells } where
 * cells[i] = { u0, v0, u1, v1 } for tokens.length entries in the same order.
 */
export function tokenAtlas(specs) {
  const CELL = 256;
  const cols = 6;
  const rows = Math.max(1, Math.ceil(specs.length / cols));
  const w = cols * CELL, h = rows * CELL;
  const cells = [];
  const tex = canvasTexture(w, h, (g) => {
    g.clearRect(0, 0, w, h);
    specs.forEach((s, i) => {
      const cx = (i % cols) * CELL + CELL / 2;
      const cy = Math.floor(i / cols) * CELL + CELL / 2;
      paintToken(g, cx, cy, CELL * 0.46, s.number, s.pips);
    });
  }, { raw: true, aniso: 8 });
  specs.forEach((s, i) => {
    const cx = i % cols, cy = Math.floor(i / cols);
    cells.push({
      u0: cx / cols, u1: (cx + 1) / cols,
      v0: 1 - (cy + 1) / rows, v1: 1 - cy / rows
    });
  });
  return { texture: tex, cells };
}

/* ------------------------------------------------------------------ clouds */

export function cloudTexture() {
  return canvasTexture(256, 256, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    const puffs = [
      [128, 150, 62], [82, 158, 44], [176, 158, 46],
      [110, 122, 40], [156, 126, 36], [128, 108, 30]
    ];
    for (const [x, y, r] of puffs) {
      const grd = g.createRadialGradient(x, y - r * 0.25, r * 0.15, x, y, r);
      grd.addColorStop(0, 'rgba(255,255,255,1)');
      grd.addColorStop(0.55, 'rgba(252,250,248,0.92)');
      grd.addColorStop(1, 'rgba(226,236,246,0)');
      g.fillStyle = grd;
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
    // soft cool underside
    g.globalCompositeOperation = 'source-atop';
    const u = g.createLinearGradient(0, 96, 0, 210);
    u.addColorStop(0, 'rgba(255,255,255,0)');
    u.addColorStop(1, 'rgba(163,196,224,0.55)');
    g.fillStyle = u; g.fillRect(0, 0, w, h);
  });
}

/* ------------------------------------------------------------ terrain grain */

function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Tiling painterly grain — soft brush streaks around mid grey. Multiplied
 * over the terrain's vertex colours so the ground reads as painted, not
 * plastic. Kept low contrast so it never becomes noise.
 */
export function grainTexture(size = 256) {
  return canvasTexture(size, size, (g, w, h) => {
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, w, h);
    const rnd = seeded(20250731);
    g.lineCap = 'round';
    for (let i = 0; i < 900; i++) {
      const x = rnd() * w, y = rnd() * h;
      const a = rnd() * Math.PI;
      const len = 6 + rnd() * 26;
      const dark = rnd() < 0.5;
      g.strokeStyle = dark
        ? `rgba(120,116,104,${0.05 + rnd() * 0.07})`
        : `rgba(255,255,255,${0.05 + rnd() * 0.09})`;
      g.lineWidth = 1 + rnd() * 3.5;
      for (const [ox, oy] of [[0, 0], [w, 0], [-w, 0], [0, h], [0, -h]]) {
        g.beginPath();
        g.moveTo(x + ox, y + oy);
        g.lineTo(x + ox + Math.cos(a) * len, y + oy + Math.sin(a) * len);
        g.stroke();
      }
    }
    for (let i = 0; i < 2600; i++) {
      const x = rnd() * w, y = rnd() * h;
      g.fillStyle = `rgba(90,86,78,${0.02 + rnd() * 0.05})`;
      g.fillRect(x, y, 1 + rnd() * 2, 1 + rnd() * 2);
    }
  }, { wrap: THREE.RepeatWrapping, aniso: 8 });
}

/* -------------------------------------------------------------- water caustic */

/** Small tiling value-noise texture used for sparkle and foam breakup. */
export function noiseTexture(size = 128) {
  const data = new Uint8Array(size * size * 4);
  const rnd = seeded(915122);
  const base = new Float32Array(size * size);
  for (let i = 0; i < base.length; i++) base[i] = rnd();
  const at = (x, y) => base[((y % size) + size) % size * size + (((x % size) + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = 0, amp = 0.5, f = 1, n = 0;
      for (let o = 0; o < 4; o++) {
        const sx = x * f / 8, sy = y * f / 8;
        const ix = Math.floor(sx), iy = Math.floor(sy);
        const fx = sx - ix, fy = sy - iy;
        const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
        const a = at(ix, iy), b = at(ix + 1, iy), c = at(ix, iy + 1), d = at(ix + 1, iy + 1);
        v += amp * ((a + (b - a) * ux) * (1 - uy) + (c + (d - c) * ux) * uy);
        n += amp; amp *= 0.5; f *= 2;
      }
      const k = (v / n) * 255;
      const i4 = (y * size + x) * 4;
      data[i4] = k; data[i4 + 1] = k; data[i4 + 2] = k; data[i4 + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}
