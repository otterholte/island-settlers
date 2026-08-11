/**
 * Island Settlers — procedural canvas painting.
 *
 * Every texture in the world is drawn here at boot. No image files, no CDN,
 * no webfonts: system font stacks only.
 */

import * as THREE from 'three';
import { isHotNumber } from '../core/constants.js';

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

/*
 * TOKEN COLOURS ARE AUTHORED AS ALBEDO, NOT AS FINAL PIXELS.
 *
 * The tokens used to be their own private colour pipeline: an unlit shader
 * writing a NoColorSpace texel straight to the framebuffer with no tone map
 * and no output encode. Sampled with gl.readPixels, the painted face #f7efdc
 * arrived on screen as (246,239,221) — bit-for-bit the canvas value — while
 * every other surface in the frame went linear -> ACES -> sRGB and had its
 * highlights rolled off. The disc was the only thing in the scene allowed to
 * reach 250+, so it read as a glowing white sticker.
 *
 * The token shader now runs the standard pipeline (see island.js): sRGB decode
 * -> scene irradiance -> ACES at exposure 1.05 -> sRGB encode. That transform
 * is not a passthrough and it is not gentle. Under this scene's irradiance a
 * pure white albedo tops out at (223,213,199) on screen, and an albedo of
 * #f2e2bd — the "warm cream" you'd reach for instinctively — comes back out at
 * roughly #dedad2, i.e. still washed out.
 *
 * So each constant below was solved backwards through three's ACES RRT/ODT fit
 * for the screen colour we actually want, sampled off the reference art:
 *
 *   FACE     #dbc4a4 -> (210,183,140)  warm cream, well clear of the ceiling
 *   RIM      #5f544e -> ( 86, 60, 42)  dark brown ring
 *   INK      #323533 -> ( 30, 26, 18)  near-black numerals
 *   HOT      #bf4335 -> (198, 44, 29)  9 and 10, unmistakably red
 *
 * If the lighting rig in sky.js changes, these need re-solving.
 */
const HOT = '#bf4335';       // 9 and 10 — the island's two best hexes
const HOT_EDGE = '#642a24';  // outline that keeps a red glyph heavy
const INK = '#323533';
const FACE = '#dbc4a4';
const RIM = '#5f544e';
const TAU = Math.PI * 2;

/**
 * Fraction of an atlas cell taken up by the disc itself. The rest is headroom
 * for the drop shadow, which falls below and outside the disc. island.js sizes
 * its quads against this so the disc keeps its intended world size.
 */
export const DISC_FRAC = 0.86;

/*
 * NO DOTS UNDER THE NUMERAL ANY MORE.
 *
 *   "The pips/dots aren't necessary either."
 *
 * They were a probability read-out — one dot per way of rolling the number —
 * and this game rolls nothing. With the token now printing a plain 1..10 rank
 * (see the long note in core/constants.js) the row of dots said the same thing
 * as the numeral, in a second notation, at a size nobody could count at play
 * distance. The disc is the numeral and the numeral is the whole message, so
 * the glyph moves back to the centre of the face and grows into the room the
 * dots used to take.
 */
function paintToken(g, cx, cy, R, number) {
  const hot = isHotNumber(number);

  // ---- cast shadow: a squashed pool below the disc, not a halo around it.
  // A ring of shadow on every side made the token look like a cut-out sticker;
  // a pool underneath makes it read as standing on the tile.
  g.save();
  g.translate(cx, cy + R * 0.66);
  g.scale(1, 0.40);
  const sg = g.createRadialGradient(0, 0, R * 0.20, 0, 0, R * 1.02);
  sg.addColorStop(0.00, 'rgba(42,35,32,0.68)');
  sg.addColorStop(0.55, 'rgba(42,35,32,0.40)');
  sg.addColorStop(1.00, 'rgba(42,35,32,0)');
  g.fillStyle = sg;
  g.beginPath(); g.arc(0, 0, R * 1.02, 0, TAU); g.fill();
  g.restore();

  // ---- rim, then the cream face inside it
  disc(g, cx, cy, R, RIM);
  disc(g, cx, cy, R * 0.925, FACE);

  // ---- form: warm light off the top, earth bounce under the bottom. Kept
  // gentle — a hard white bevel is what crushed the numeral contrast before.
  const grd = g.createLinearGradient(cx, cy - R, cx, cy + R);
  grd.addColorStop(0.00, 'rgba(255,244,222,0.70)');
  grd.addColorStop(0.48, 'rgba(255,244,222,0.00)');
  grd.addColorStop(1.00, 'rgba(70,50,34,0.34)');
  g.save();
  g.beginPath(); g.arc(cx, cy, R * 0.925, 0, TAU); g.clip();
  g.fillStyle = grd; g.fillRect(cx - R, cy - R, R * 2, R * 2);
  g.restore();
  // seat the face into the rim
  ring(g, cx, cy, R * 0.915, R * 0.030, 'rgba(95,84,78,0.55)');

  // ------------------------------------------------------------- numeral
  const label = String(number);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  // Large, but leaving a clear cream margin inside the rim like the reference.
  // Both figures are up a notch from the pipped version: the dots are gone, so
  // the glyph owns the face instead of sharing it with a row underneath.
  const size = label.length > 1 ? R * 1.02 : R * 1.28;
  g.font = `900 ${size}px ${STACK}`;
  // Centred now, rather than lifted to clear a row of dots.
  const ny = cy + R * 0.015;
  g.lineJoin = 'round';
  g.lineCap = 'round';
  // a one-pixel warm lift under the glyph reads as engraving, not as a halo
  g.fillStyle = 'rgba(255,248,232,0.42)';
  g.fillText(label, cx, ny + R * 0.030);
  // stroke then fill: the stroke is the weight, the fill is the colour
  g.lineWidth = R * 0.055;
  g.strokeStyle = hot ? HOT_EDGE : INK;
  g.strokeText(label, cx, ny);
  g.fillStyle = hot ? HOT : INK;
  g.fillText(label, cx, ny);
}

/**
 * One atlas holding every number token. Returns { texture, cells } where
 * cells[i] = { u0, v0, u1, v1 } for tokens.length entries in the same order.
 *
 * The texture is sRGB, not raw: the sampler decodes it to linear so the token
 * shader can light and tone map it alongside the rest of the island.
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
      paintToken(g, cx, cy, CELL * DISC_FRAC * 0.5, s.number);
    });
  }, { aniso: 8 });
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
