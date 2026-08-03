/**
 * Island Settlers — home-screen icon generator.
 *
 *   node tools/mkicons.mjs
 *
 * Writes icons/icon-192.png, icons/icon-512.png, icons/maskable-512.png and
 * icons/apple-touch-icon.png.
 *
 * WHY THIS EXISTS AS A SCRIPT
 * ---------------------------
 * The build has no images and no dependencies, and it is not about to grow
 * either for four squares of art. So the icons are DRAWN — a rounded plate of
 * deep water with a gold hex sitting on it — into an RGBA buffer here, and
 * encoded to PNG with nothing but `node:zlib`. The output is committed, so a
 * clone never has to run this; re-run it only when the art changes.
 *
 * Two shapes, not one. `icon-*.png` is the plate as drawn, corners and all,
 * for anywhere that shows an icon as-is. `maskable-512.png` is full-bleed with
 * the hex pulled into the middle 60%, because Android crops a maskable icon to
 * whatever shape the launcher fancies — a circle on most phones — and anything
 * outside that circle is gone. Shipping only the first gets you a gold hex
 * with its corners sliced off; shipping only the second gets you a square of
 * sea in every browser tab.
 *
 * Owner: UI agent.
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'icons');

/* ------------------------------------------------------------------- PNG */

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** RGBA8 -> PNG. One filter byte (0) per row; zlib does the rest. */
function encodePNG(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ------------------------------------------------------------------- art */

const mix = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t
];

const SEA_TOP = [23, 84, 140];
const SEA_BOT = [6, 28, 52];
const GOLD_TOP = [255, 231, 154];
const GOLD_BOT = [232, 160, 26];
const INK = [26, 16, 8];

/** Signed-ish test for a rounded square covering [0,1] in both axes. */
function inPlate(x, y, r) {
  const dx = Math.min(x, 1 - x), dy = Math.min(y, 1 - y);
  if (dx >= r || dy >= r) return dx >= 0 && dy >= 0;
  const cx = dx < r ? r - dx : 0;
  const cy = dy < r ? r - dy : 0;
  return Math.hypot(cx, cy) <= r;
}

/** Pointy-top hexagon, circumradius R, centred at (0.5, 0.5). */
function inHex(x, y, R) {
  const px = Math.abs(x - 0.5), py = Math.abs(y - 0.5);
  const w = R * Math.sqrt(3) / 2;          // half width
  if (px > w || py > R) return false;
  // The two slanted edges: |x|/w + |y|/R clipped against the flat sides.
  return py <= R - (px / w) * (R / 2);
}

const ROOF = [201, 83, 42];
const ROOF_L = [238, 138, 85];
const WALL = [246, 231, 198];

/**
 * A settlement, drawn about (0.5, 0.53) at `k` times its nominal size so the
 * same two functions give both the shape and its outline. A hex on its own is
 * a hex; a hex with a house on it is this game.
 */
function inRoof(x, y, R, k) {
  const w = R * 0.86 * k, h = R * 0.90 * k;
  const cx = 0.5, cy = 0.53;
  const top = cy - h / 2, eave = cy - h * 0.06;
  if (y < top || y > eave) return false;
  const t = (y - top) / (eave - top);
  return Math.abs(x - cx) <= (w / 2) * t;
}

function inBody(x, y, R, k) {
  const w = R * 0.86 * k, h = R * 0.90 * k;
  const cx = 0.5, cy = 0.53;
  const eave = cy - h * 0.06, foot = cy + h / 2;
  return y >= eave && y <= foot && Math.abs(x - cx) <= w * 0.31;
}

/**
 * One pixel of the icon, supersampled. `hexR` is the hex's circumradius as a
 * fraction of the plate; `plateR` is 0 for a full-bleed maskable icon.
 */
function shade(x, y, hexR, plateR) {
  if (plateR > 0 && !inPlate(x, y, plateR)) return null;

  const sea = mix(SEA_TOP, SEA_BOT, Math.min(1, Math.max(0, y * 1.06 - 0.03)));

  const ring = hexR * 0.955;
  const inner = hexR * 0.80;
  if (!inHex(x, y, hexR)) return sea;
  if (!inHex(x, y, ring)) return INK;

  // The token itself, lit from the top, with a soft crown highlight so a
  // 192px tile does not read as a flat gold blob.
  const t = Math.min(1, Math.max(0, (y - (0.5 - hexR)) / (hexR * 2)));
  const gold = mix(GOLD_TOP, GOLD_BOT, t * t * 0.9 + t * 0.1);

  const OUT = 1.14;                     // the ink line, as a scale factor
  if (inRoof(x, y, hexR, OUT) || inBody(x, y, hexR, OUT)) {
    if (inRoof(x, y, hexR, 1)) {
      const s = (y - (0.53 - hexR * 0.45)) / (hexR * 0.42);
      return mix(ROOF_L, ROOF, Math.min(1, Math.max(0, s)));
    }
    if (inBody(x, y, hexR, 1)) return WALL;
    return INK;
  }

  if (inHex(x, y, inner) && y < 0.5) {
    return mix(gold, [255, 252, 232], 0.30 * (1 - t * 1.6 > 0 ? 1 - t * 1.6 : 0));
  }
  return gold;
}

function render(size, hexR, plateR) {
  const px = Buffer.alloc(size * size * 4);
  const SS = 3;                       // 3x3 supersampling; plenty at these sizes
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = shade(
            (i + (sx + 0.5) / SS) / size,
            (j + (sy + 0.5) / SS) / size,
            hexR, plateR
          );
          if (!c) continue;
          r += c[0]; g += c[1]; b += c[2]; a += 255;
        }
      }
      const n = SS * SS;
      const o = (j * size + i) * 4;
      if (a > 0) {
        // Un-premultiply: the colour is the average of the covered samples.
        const cov = a / (n * 255);
        px[o] = Math.round(r / (n * cov));
        px[o + 1] = Math.round(g / (n * cov));
        px[o + 2] = Math.round(b / (n * cov));
      }
      px[o + 3] = Math.round(a / n);
    }
  }
  return encodePNG(size, size, px);
}

/* ------------------------------------------------------------------ main */

mkdirSync(OUT, { recursive: true });

const JOBS = [
  ['icon-192.png', 192, 0.34, 0.22],
  ['icon-512.png', 512, 0.34, 0.22],
  // Full bleed, hex inside the middle 60% — the launcher's crop circle.
  ['maskable-512.png', 512, 0.26, 0],
  // iOS composites its own rounded corners onto an opaque square.
  ['apple-touch-icon.png', 180, 0.34, 0]
];

for (const [name, size, hexR, plateR] of JOBS) {
  const buf = render(size, hexR, plateR);
  writeFileSync(join(OUT, name), buf);
  console.log(`${name.padEnd(22)} ${String(size).padStart(4)}px  ${String(buf.length).padStart(7)} bytes`);
}
