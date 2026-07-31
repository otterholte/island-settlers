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

const HOT = '#c4372b';
const CREAM = '#f6e7c6';
const CREAM_HI = '#fdf6e2';
const BROWN = '#4a2c14';

function paintToken(g, cx, cy, R, number, pips) {
  const hot = number === 6 || number === 8;

  // cast shadow under the disc
  g.save();
  g.globalAlpha = 0.28;
  disc(g, cx, cy + R * 0.09, R * 0.99, '#241407');
  g.restore();

  // dark brown outer ring
  disc(g, cx, cy, R * 0.97, BROWN);
  disc(g, cx, cy, R * 0.90, '#7a4a22');
  // cream face
  disc(g, cx, cy, R * 0.83, CREAM);

  // top bevel highlight
  const grd = g.createLinearGradient(cx, cy - R, cx, cy + R);
  grd.addColorStop(0, 'rgba(255,255,255,0.85)');
  grd.addColorStop(0.42, 'rgba(255,255,255,0.10)');
  grd.addColorStop(1, 'rgba(120,80,40,0.20)');
  g.save();
  g.beginPath(); g.arc(cx, cy, R * 0.83, 0, Math.PI * 2); g.clip();
  g.fillStyle = grd; g.fillRect(cx - R, cy - R, R * 2, R * 2);
  g.restore();

  // inner keyline
  ring(g, cx, cy, R * 0.83, R * 0.035, 'rgba(74,44,20,0.55)');

  // number
  const label = String(number);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const size = label.length > 1 ? R * 0.92 : R * 1.06;
  g.font = `900 ${size}px ${STACK}`;
  const ny = cy - R * 0.12;
  g.lineJoin = 'round';
  g.lineWidth = R * 0.15;
  g.strokeStyle = hot ? '#5a140c' : BROWN;
  g.strokeText(label, cx, ny);
  g.fillStyle = hot ? HOT : '#3b2410';
  g.fillText(label, cx, ny);
  // glossy top half of the numeral
  g.save();
  g.beginPath();
  g.rect(cx - R, ny - size * 0.62, R * 2, size * 0.42);
  g.clip();
  g.fillStyle = hot ? '#e2695c' : '#6d4a26';
  g.fillText(label, cx, ny);
  g.restore();

  // pips
  const pr = R * 0.062;
  const gap = pr * 3.0;
  const py = cy + R * 0.50;
  const x0 = cx - (pips - 1) * gap * 0.5;
  for (let i = 0; i < pips; i++) {
    disc(g, x0 + i * gap, py + pr * 0.35, pr * 1.15, 'rgba(60,34,14,0.35)');
    disc(g, x0 + i * gap, py, pr, hot ? HOT : '#4a2c14');
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
