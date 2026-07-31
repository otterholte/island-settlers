/**
 * Island Settlers — harbour kit.
 *
 * One canonical port, instanced nine times. Local space:
 *   +X  points out to sea (the port's `bearing`)
 *   y=0 sits on the wet sand at the shoreline
 *
 * The brief for this pass was "cleaner, not busier". The silhouette is now
 * four readable shapes and nothing else: a shingled warehouse on a timber
 * platform, a plank dock running out on pilings, a crane at the dock head, and
 * a moored sailing ship. The trade ratio hangs from a proper sign frame at the
 * landward end of the dock, big enough to read across the water.
 *
 * Everything that does not move lives in `portBaseGeo` and is tinted per
 * instance: weathered grey while the port is locked, full colour once
 * `setUnlocked` fires. The ship carries its own instance colour so a derelict
 * berth reads grey and still.
 */

import * as THREE from 'three';
import { merge, place, tint, gradient, box, cyl, cone } from './geo.js';
import { canvasTexture } from './paint.js';
import { PAL, prism, decal, cloth, crate, barrel, faceGeo, stripePanel, rng } from './buildkit.js';

export const DECK_Y = 0.62;      // dock surface above the shore anchor
export const DOCK_FROM = 0.9;    // dock starts here
export const DOCK_TO = 8.2;      // and reaches this far out to sea
export const DOCK_W = 2.60;

/**
 * Where the sign board hangs, in port-local space.
 *
 * It straddles the head of the dock like a harbour gate rather than standing
 * off to one side: the board then clears the warehouse roof and stays readable
 * whichever way the coast happens to face, which is the whole point of it.
 */
export const SIGN_LOCAL = {
  x: 1.65, y: DECK_Y + 2.72, z: 0, w: 2.50, h: 1.56
};

// slate-blue roof, as in the reference art: it separates the warehouse
// from the brown of the dock and the sand instead of merging with both.
const SHINGLE = 0x3f5a76;
const SHINGLE_HI = 0x6b8aa8;

/* ------------------------------------------------------------- shore works */

function platform() {
  const pile = (x, z) => place(tint(new THREE.BoxGeometry(0.28, 2.0, 0.28), 0x6a4526, 0.06), x, -0.42, z);
  return merge([
    place(gradient(new THREE.BoxGeometry(4.4, 0.34, 3.7), 0x7d5f38, 0xa88551), -1.70, DECK_Y - 0.17, 0),
    pile(-3.45, 1.50), pile(-3.45, -1.50), pile(-0.20, 1.50), pile(-0.20, -1.50),
    // ramp climbing back toward the cliff
    place(gradient(new THREE.BoxGeometry(3.1, 0.24, 1.7), 0x77592f, 0x96713f), -4.95, DECK_Y + 0.58, 0, 0, 0, 0.42)
  ]);
}

/** Warehouse: one clean gable mass, a loading door and a shingled roof. */
function warehouse() {
  const w = 2.30, h = 1.62, d = 2.00;
  return merge([
    place(gradient(new THREE.BoxGeometry(w, h, d), 0x7f5a32, 0xab7f4c), 0, h / 2, 0),
    // corner posts read the silhouette even at grey-out
    place(tint(new THREE.BoxGeometry(0.17, h, 0.17), 0x5c3a1f, 0.05), w / 2 - 0.06, h / 2, d / 2 - 0.06),
    place(tint(new THREE.BoxGeometry(0.17, h, 0.17), 0x5c3a1f, 0.05), w / 2 - 0.06, h / 2, -d / 2 + 0.06),
    place(tint(new THREE.BoxGeometry(0.17, h, 0.17), 0x5c3a1f, 0.05), -w / 2 + 0.06, h / 2, d / 2 - 0.06),
    place(tint(new THREE.BoxGeometry(0.17, h, 0.17), 0x5c3a1f, 0.05), -w / 2 + 0.06, h / 2, -d / 2 + 0.06),
    place(prism(w * 1.26, h * 0.62, d * 1.20, SHINGLE_HI, SHINGLE), 0, h, 0),
    place(box(w * 1.28, 0.10, 0.11, 0x3f3428), 0, h + 0.03, d * 0.60),
    place(box(w * 1.28, 0.10, 0.11, 0x3f3428), 0, h + 0.03, -d * 0.60),
    place(box(0.16, 0.16, d * 1.24, 0x3f3428), 0, h + h * 0.62, 0),
    // loading door facing the dock, with a lintel and a hoist beam above it
    place(box(0.10, h * 0.72, w * 0.60, 0x4b3722), w / 2 + 0.02, h * 0.36, 0),
    place(box(0.16, 0.10, w * 0.68, 0x9a6c3c), w / 2 + 0.04, h * 0.74, 0),
    place(box(0.62, 0.13, 0.13, 0x5c3a1f), w / 2 + 0.28, h * 1.16, 0),
    // shuttered side window
    place(decal(0.42, 0.40, 0x4b5f6b), 0, h * 0.62, d / 2 + 0.012)
  ]);
}

/** Dock crane: A-frame post, jib swung out over the berth, rope and hook. */
function crane() {
  return merge([
    place(tint(new THREE.BoxGeometry(0.28, 3.10, 0.28), 0x6f5330, 0.05), 0, 1.55, 0),
    place(tint(new THREE.BoxGeometry(0.20, 0.20, 2.40), 0x8a6338, 0.05), 0, 3.00, 1.00, -0.13, 0, 0),
    place(tint(new THREE.BoxGeometry(0.16, 0.16, 1.30), 0x6b4526), 0, 2.28, 0.55, 0.72, 0, 0),
    place(cyl(0.30, 0.30, 0.40, 6, 0x6b4526, false, 0.05), 0, 0.74, 0, 0, 0, Math.PI / 2),
    place(box(0.04, 1.45, 0.04, PAL.rope), 0, 2.28, 2.02),
    place(tint(new THREE.BoxGeometry(0.16, 0.28, 0.13), PAL.iron), 0, 1.48, 2.02)
  ]);
}

/** Plank dock on pilings, two bollards, and a lamp at the head. */
function dock() {
  const parts = [];
  const span = DOCK_TO - DOCK_FROM;
  const mid = (DOCK_FROM + DOCK_TO) / 2;
  parts.push(place(tint(new THREE.BoxGeometry(span, 0.17, 0.22), 0x6b4526, 0.05), mid, DECK_Y - 0.15, DOCK_W / 2 - 0.22));
  parts.push(place(tint(new THREE.BoxGeometry(span, 0.17, 0.22), 0x6b4526, 0.05), mid, DECK_Y - 0.15, -DOCK_W / 2 + 0.22));
  for (let i = 0; i < 5; i++) {
    const x = DOCK_FROM + (span / 5) * (i + 0.5);
    parts.push(place(tint(new THREE.BoxGeometry(span / 5.5, 0.12, DOCK_W), i % 2 ? PAL.plankAlt : PAL.plank, 0.10, 3 + i),
      x, DECK_Y - 0.05, 0));
  }
  for (let i = 0; i < 2; i++) {
    const x = DOCK_FROM + span * (0.34 + i * 0.54);
    for (const z of [DOCK_W / 2 - 0.22, -DOCK_W / 2 + 0.22]) {
      parts.push(place(tint(new THREE.BoxGeometry(0.28, 3.4, 0.28), 0x53381d, 0.05), x, DECK_Y - 1.78, z));
    }
  }
  parts.push(place(tint(new THREE.BoxGeometry(0.24, 0.48, 0.24), 0x4d3a22), DOCK_TO - 0.6, DECK_Y + 0.21, DOCK_W / 2 - 0.30));
  parts.push(place(tint(new THREE.BoxGeometry(0.24, 0.48, 0.24), 0x4d3a22), DOCK_TO - 2.8, DECK_Y + 0.21, DOCK_W / 2 - 0.30));
  // harbour lamp — the clearest single "this berth is open" cue
  parts.push(place(tint(new THREE.BoxGeometry(0.13, 2.05, 0.13), 0x4a4038, 0.04), DOCK_FROM + 0.55, DECK_Y + 1.02, -DOCK_W / 2 + 0.28));
  parts.push(place(cyl(0.13, 0.19, 0.30, 5, 0xffc866, false, 0.04), DOCK_FROM + 0.55, DECK_Y + 2.18, -DOCK_W / 2 + 0.28));
  parts.push(place(cone(0.24, 0.20, 5, PAL.iron), DOCK_FROM + 0.55, DECK_Y + 2.42, -DOCK_W / 2 + 0.28));
  return merge(parts);
}

/** One tidy stack of cargo on the platform. Deliberately small. */
function goods() {
  return merge([
    place(crate(0.62), -1.05, DECK_Y, 1.22),
    place(crate(0.48), -0.98, DECK_Y + 0.62, 1.18, 0, 0.4, 0),
    place(barrel(0.25, 0.54), -1.20, DECK_Y, -1.28),
    place(barrel(0.25, 0.54), -0.62, DECK_Y, -1.15)
  ]);
}

/** Gantry the painted board hangs from, straddling the head of the dock. */
function signFrame() {
  const { x } = SIGN_LOCAL;
  const top = DECK_Y + 3.86;
  const post = (z) => merge([
    place(tint(new THREE.BoxGeometry(0.20, 3.80, 0.20), 0x6b4526, 0.05), x, DECK_Y + 1.90, z),
    place(box(0.34, 0.16, 0.32, 0x8a6338), x, top - 0.26, z),
    place(cone(0.15, 0.26, 4, PAL.gold), x, top + 0.22, z),
    place(box(0.44, 0.14, 0.14, 0x8a6338), x + 0.16, DECK_Y + 3.44, z, 0, 0, 0.6)
  ]);
  return merge([
    post(1.22), post(-1.22),
    place(box(0.22, 0.22, 2.80, 0x53381d), x, top, 0),
    place(box(0.05, 0.42, 0.05, PAL.rope), x, top - 0.28, -0.72),
    place(box(0.05, 0.42, 0.05, PAL.rope), x, top - 0.28, 0.72)
  ]);
}

/** Everything that does not move: platform, warehouse, crane, dock, goods. */
export function portBaseGeo() {
  return merge([
    platform(),
    place(warehouse(), -2.60, DECK_Y, 0),
    place(crane(), DOCK_FROM + 4.7, DECK_Y, -DOCK_W / 2 + 0.35),
    dock(), goods(), signFrame()
  ]);
}

/* ------------------------------------------------------------------- ship */

/** V-hull: a keel line with a flared gunwale, 14 triangles. */
function hullGeo() {
  const L = 4.1, W = 1.42, H = 0.86;
  const hw = W / 2, bow = L * 0.56, aft = -L * 0.44;
  const KF = [bow * 0.80, -H, 0], KA = [aft * 0.88, -H * 0.86, 0];
  const tip = [bow, 0.12, 0];
  const sF = [bow * 0.42, 0, hw], sA = [aft * 0.55, 0, hw * 0.94];
  const sS = [aft, 0.06, hw * 0.60];
  const pF = [bow * 0.42, 0, -hw], pA = [aft * 0.55, 0, -hw * 0.94];
  const pS = [aft, 0.06, -hw * 0.60];
  const g = faceGeo([
    [KA, KF, sF, sA],          // starboard midships
    [pA, pF, KF, KA],          // port midships
    [KA, sA, sS, pS]           // transom skirt
  ], [
    [KF, tip, sF],             // starboard bow
    [KF, pF, tip],             // port bow
    [KA, sS, pS],              // stern under-run
    [tip, sF, sA], [tip, sA, sS],   // deck, starboard half
    [tip, pA, pF], [tip, pS, pA]    // deck, port half
  ]);
  gradient(g, 0x4f3520, 0x8b5f34);
  return merge([
    g,
    place(gradient(new THREE.BoxGeometry(L * 0.94, 0.66, W), 0x6a4526, 0x9a6c3c), 0.02, -0.32, 0),
    place(box(L * 0.9, 0.11, W * 1.06, 0xb98a4f, 0.07), 0.02, 0.03, 0),
    place(box(L * 0.9, 0.16, 0.11, 0xc23f2c), 0.02, 0.12, W * 0.53),
    place(box(L * 0.9, 0.16, 0.11, 0xc23f2c), 0.02, 0.12, -W * 0.53),
    // aft cabin + bowsprit
    place(gradient(new THREE.BoxGeometry(0.92, 0.50, 0.92), 0x7a5230, 0xa9793f), -1.32, 0.30, 0),
    place(prism(1.04, 0.30, 1.02, 0x8c4a2c, 0x6a3520), -1.32, 0.55, 0, 0, Math.PI / 2, 0),
    place(tint(new THREE.BoxGeometry(1.05, 0.10, 0.10), 0x6a4526), 2.55, 0.24, 0, 0, 0, 0.16)
  ]);
}

/** Moored sailing ship: hull, mast, boom, striped mainsail, two stays. */
export function portShipGeo() {
  const parts = [hullGeo()];
  parts.push(place(tint(new THREE.BoxGeometry(0.17, 3.40, 0.17), 0x7a5732, 0.04), 0.30, 1.78, 0));
  parts.push(place(tint(new THREE.BoxGeometry(1.80, 0.12, 0.12), 0x6a4526), 0.72, 0.80, 0));
  parts.push(place(cone(0.10, 0.24, 4, PAL.gold), 0.30, 3.58, 0));

  const sail = stripePanel(1.80, 2.02, 5, 0xf3e8cd, 0xc23f2c, { bulge: 0.16, rows: 2 });
  place(sail, 1.14, 2.10, 0, 0, Math.PI / 2, 0);
  parts.push(sail);

  const jib = cloth(0.95, 1.30, 0xeee3cc, 0xcdbc9c, 0.12, 3);
  place(jib, -0.52, 2.28, 0, 0, Math.PI / 2, 0);
  parts.push(jib);

  const line = (x1, y1, x2, y2) => {
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    return place(box(len, 0.04, 0.04, PAL.rope), (x1 + x2) / 2, (y1 + y2) / 2, 0, 0, 0, Math.atan2(dy, dx));
  };
  parts.push(line(0.30, 3.42, 2.52, 0.32));
  parts.push(line(0.30, 3.42, -1.55, 0.46));
  return merge(parts);
}

/* ------------------------------------------------------------------- flag */

/** Owner banner beside the warehouse — authored white for instance tinting. */
export function portFlagGeo() {
  const h = 2.05;
  const parts = [
    place(tint(new THREE.BoxGeometry(0.10, h, 0.10), 0xdcdcdc), 0, h / 2, 0),
    place(cone(0.10, 0.22, 4, 0xffffff), 0, h + 0.11, 0)
  ];
  const f = cloth(1.12, 0.78, 0xffffff, 0xe2e2e2, 0.10, 3);
  place(f, 0.60, h - 0.44, 0);
  parts.push(f);
  return merge(parts);
}

/* ---------------------------------------------------------------- seagull */

/**
 * Swept-wing gull, five triangles. The old one hung two rectangular planes off
 * a blob, which from any distance read as a scrap of paper blowing past rather
 * than as a bird; a proper dart silhouette does not.
 */
export function seagullGeo() {
  const tri = (a, b, c, hex) => tint(faceGeo(null, [[a, b, c]]), hex);
  return merge([
    place(tint(new THREE.OctahedronGeometry(0.12, 0), 0xf6f7f8, 0.04), 0, 0, 0, 0, 0, 0, 2.0, 0.72, 0.78),
    tri([0.06, 0.02, 0.05], [-0.20, 0.11, 0.56], [0.12, 0.01, 0.12], 0xeef1f4),
    tri([0.06, 0.02, -0.05], [0.12, 0.01, -0.12], [-0.20, 0.11, -0.56], 0xeef1f4),
    tri([-0.14, 0.01, 0.05], [-0.34, 0.04, 0.12], [-0.34, 0.04, -0.12], 0xe4e9ef),
    place(cone(0.05, 0.16, 3, 0xf5a63a), 0.23, 0, 0, 0, 0, -Math.PI / 2)
  ]);
}

/* ------------------------------------------------------------- sign atlas */

export const ICON = {
  wood(g, x, y, s) {
    g.fillStyle = '#3f7a2e';
    g.beginPath();
    g.moveTo(x, y - s); g.lineTo(x + s * 0.8, y + s * 0.25); g.lineTo(x - s * 0.8, y + s * 0.25);
    g.closePath(); g.fill();
    g.fillStyle = '#2b5f22';
    g.beginPath();
    g.moveTo(x, y - s * 0.45); g.lineTo(x + s * 0.62, y + s * 0.62); g.lineTo(x - s * 0.62, y + s * 0.62);
    g.closePath(); g.fill();
    g.fillStyle = '#5c3a1f';
    g.fillRect(x - s * 0.15, y + s * 0.52, s * 0.3, s * 0.5);
  },
  brick(g, x, y, s) {
    g.fillStyle = '#b74d27';
    g.fillRect(x - s * 0.9, y - s * 0.58, s * 1.8, s * 0.52);
    g.fillRect(x - s * 0.9, y + s * 0.06, s * 1.8, s * 0.52);
    g.strokeStyle = '#6d2812'; g.lineWidth = s * 0.11;
    g.strokeRect(x - s * 0.9, y - s * 0.58, s * 1.8, s * 0.52);
    g.strokeRect(x - s * 0.9, y + s * 0.06, s * 1.8, s * 0.52);
  },
  wool(g, x, y, s) {
    g.fillStyle = '#efe9dc';
    for (const [dx, dy, r] of [[-0.5, 0, 0.55], [0.35, -0.1, 0.6], [0, 0.35, 0.5], [0.6, 0.35, 0.4]]) {
      g.beginPath(); g.arc(x + dx * s, y + dy * s, r * s, 0, Math.PI * 2); g.fill();
    }
    g.strokeStyle = '#b8ac96'; g.lineWidth = s * 0.09;
    g.beginPath(); g.arc(x - 0.5 * s, y, 0.55 * s, 0, Math.PI * 2); g.stroke();
    g.fillStyle = '#33333b';
    g.beginPath(); g.arc(x + s * 0.85, y - s * 0.05, s * 0.3, 0, Math.PI * 2); g.fill();
  },
  wheat(g, x, y, s) {
    g.strokeStyle = '#b3871f'; g.lineWidth = s * 0.16; g.lineCap = 'round';
    for (const a of [-0.36, 0, 0.36]) {
      g.beginPath();
      g.moveTo(x + Math.sin(a) * s * 0.9, y + s * 0.95);
      g.lineTo(x + Math.sin(a) * s * 0.25, y - s * 0.85);
      g.stroke();
    }
    g.fillStyle = '#dda824';
    for (const a of [-0.36, 0, 0.36]) {
      for (let i = 0; i < 3; i++) {
        g.beginPath();
        g.ellipse(x + Math.sin(a) * (s * 0.3 + i * s * 0.1), y - s * 0.75 + i * s * 0.36,
          s * 0.22, s * 0.13, a, 0, Math.PI * 2);
        g.fill();
      }
    }
  },
  ore(g, x, y, s) {
    g.fillStyle = '#7c8695';
    g.beginPath();
    g.moveTo(x, y - s); g.lineTo(x + s * 0.75, y - s * 0.1);
    g.lineTo(x + s * 0.4, y + s * 0.85); g.lineTo(x - s * 0.45, y + s * 0.85);
    g.lineTo(x - s * 0.8, y - s * 0.15); g.closePath(); g.fill();
    g.fillStyle = '#b3bcc9';
    g.beginPath();
    g.moveTo(x, y - s); g.lineTo(x + s * 0.75, y - s * 0.1);
    g.lineTo(x + s * 0.1, y + s * 0.2); g.closePath(); g.fill();
    g.strokeStyle = '#4d545e'; g.lineWidth = s * 0.09;
    g.beginPath();
    g.moveTo(x, y - s); g.lineTo(x + s * 0.75, y - s * 0.1);
    g.lineTo(x + s * 0.4, y + s * 0.85); g.lineTo(x - s * 0.45, y + s * 0.85);
    g.lineTo(x - s * 0.8, y - s * 0.15); g.closePath(); g.stroke();
  },
  any(g, x, y, s) {
    const cols = ['#3f7a2e', '#b74d27', '#e4ded0', '#dda824', '#7c8695'];
    cols.forEach((c, i) => {
      const a = (Math.PI * 2 * i) / 5 - Math.PI / 2;
      g.fillStyle = c;
      g.beginPath();
      g.arc(x + Math.cos(a) * s * 0.58, y + Math.sin(a) * s * 0.58, s * 0.35, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = 'rgba(60,40,22,0.5)'; g.lineWidth = s * 0.07; g.stroke();
    });
  }
};

const FONT = '"Trebuchet MS","Arial Black",Impact,system-ui,sans-serif';

/**
 * One trade board: a cream canvas banner with a swallow-tail hem, laced to a
 * timber rod, carrying the resource icon and the exchange ratio.
 *
 * Drawn with `alphaTest` in mind — everything outside the banner shape stays
 * transparent so the sign keeps a cloth silhouette instead of a hard rectangle.
 */
function paintBoard(g, x0, y0, w, h, port, rand) {
  const pad = w * 0.055;
  const L = x0 + pad, R = x0 + w - pad;
  const T = y0 + h * 0.115, B = y0 + h * 0.945;
  const notch = h * 0.16;

  // hanging rod
  g.fillStyle = '#4a3520';
  g.fillRect(x0 + w * 0.015, y0 + h * 0.02, w * 0.97, h * 0.075);
  g.fillStyle = '#7a5836';
  g.fillRect(x0 + w * 0.015, y0 + h * 0.02, w * 0.97, h * 0.035);
  // laces
  g.strokeStyle = '#8a6f4a'; g.lineWidth = h * 0.022;
  for (const t of [0.2, 0.5, 0.8]) {
    const lx = L + (R - L) * t;
    g.beginPath(); g.moveTo(lx, y0 + h * 0.05); g.lineTo(lx, T + h * 0.02); g.stroke();
  }

  const banner = () => {
    g.beginPath();
    g.moveTo(L, T); g.lineTo(R, T); g.lineTo(R, B);
    g.lineTo((L + R) / 2, B - notch); g.lineTo(L, B);
    g.closePath();
  };
  // dark backing so the banner keeps a heavy outline at distance
  g.save();
  g.translate(0, h * 0.012);
  banner(); g.fillStyle = '#4a3520'; g.fill();
  g.restore();
  banner();
  g.fillStyle = '#d9c69a'; g.fill();
  g.lineWidth = h * 0.045; g.strokeStyle = '#4a3520'; g.lineJoin = 'round'; g.stroke();

  // weave
  g.save();
  banner(); g.clip();
  g.strokeStyle = 'rgba(120,96,60,0.16)'; g.lineWidth = h * 0.012;
  for (let i = 0; i < 16; i++) {
    const py = T + (B - T) * (i / 16) + rand() * 3;
    g.beginPath(); g.moveTo(L, py); g.lineTo(R, py); g.stroke();
  }
  const shade = g.createLinearGradient(L, T, R, B);
  shade.addColorStop(0, 'rgba(255,246,222,0.30)');
  shade.addColorStop(1, 'rgba(105,80,44,0.22)');
  g.fillStyle = shade; g.fillRect(L, T, R - L, B - T);
  g.restore();

  // inner rule
  g.strokeStyle = '#a8763a'; g.lineWidth = h * 0.018;
  g.strokeRect(L + w * 0.035, T + h * 0.045, (R - L) - w * 0.07, (B - T) - h * 0.20);

  // icon on the left third
  const icon = port.resource ? ICON[port.resource] : ICON.any;
  icon(g, L + (R - L) * 0.215, T + (B - T) * 0.40, h * 0.185);

  // ratio, as big as the board allows
  const label = `${port.ratio}:1`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `900 ${Math.round(h * 0.40)}px ${FONT}`;
  g.lineJoin = 'round';
  g.lineWidth = h * 0.085;
  g.strokeStyle = '#3b2410';
  g.strokeText(label, L + (R - L) * 0.635, T + (B - T) * 0.38);
  g.fillStyle = '#fff2d2';
  g.fillText(label, L + (R - L) * 0.635, T + (B - T) * 0.38);

  // sub-label along the hem
  g.font = `800 ${Math.round(h * 0.135)}px ${FONT}`;
  g.lineWidth = h * 0.05;
  g.strokeStyle = '#3b2410';
  const sub = port.resource ? String(port.resource).toUpperCase() : 'ANY GOODS';
  g.strokeText(sub, (L + R) / 2, T + (B - T) * 0.755);
  g.fillStyle = '#f3cf85';
  g.fillText(sub, (L + R) / 2, T + (B - T) * 0.755);
}

/**
 * One atlas holding all nine trade boards. Returns { texture, cells } with
 * cells[i] = { u0, v0, u1, v1 } in port order.
 */
export function portSignAtlas(portList) {
  const CW = 320, CH = 200, cols = 3;
  const rows = Math.max(1, Math.ceil(portList.length / cols));
  const w = cols * CW, h = rows * CH;
  const cells = [];
  const rand = rng(4242);
  const texture = canvasTexture(w, h, (g) => {
    g.clearRect(0, 0, w, h);
    portList.forEach((p, i) => {
      paintBoard(g, (i % cols) * CW, Math.floor(i / cols) * CH, CW, CH, p, rand);
    });
  }, { aniso: 8 });
  portList.forEach((p, i) => {
    const cx = i % cols, cy = Math.floor(i / cols);
    cells.push({
      u0: cx / cols, u1: (cx + 1) / cols,
      v0: 1 - (cy + 1) / rows, v1: 1 - cy / rows
    });
  });
  return { texture, cells };
}

/**
 * All nine sign boards in one mesh. Each quad is billboarded about Y around
 * its own hanging point in the shader, so the ratio faces the player from any
 * approach without the frame having to move.
 */
export function buildSignMesh(portList, anchors) {
  const atlas = portSignAtlas(portList);
  const n = portList.length;
  const pos = new Float32Array(n * 4 * 3);
  const cen = new Float32Array(n * 4 * 3);
  const loc = new Float32Array(n * 4 * 2);
  const uv = new Float32Array(n * 4 * 2);
  const col = new Float32Array(n * 4 * 3).fill(1);
  const idx = new Uint16Array(n * 6);
  const hw = SIGN_LOCAL.w / 2, hh = SIGN_LOCAL.h / 2;

  portList.forEach((p, i) => {
    const a = anchors[i];
    const cb = Math.cos(p.bearing), sb = Math.sin(p.bearing);
    const wx = a.x + SIGN_LOCAL.x * cb - SIGN_LOCAL.z * sb;
    const wz = a.z + SIGN_LOCAL.x * sb + SIGN_LOCAL.z * cb;
    const wy = a.y + SIGN_LOCAL.y;
    const cell = atlas.cells[i];
    const corners = [[-hw, -hh, cell.u0, cell.v0], [hw, -hh, cell.u1, cell.v0],
                     [hw, hh, cell.u1, cell.v1], [-hw, hh, cell.u0, cell.v1]];
    corners.forEach(([lx, ly, u, v], j) => {
      const k = i * 4 + j;
      pos[k * 3] = wx; pos[k * 3 + 1] = wy; pos[k * 3 + 2] = wz;
      cen[k * 3] = wx; cen[k * 3 + 1] = wy; cen[k * 3 + 2] = wz;
      loc[k * 2] = lx; loc[k * 2 + 1] = ly;
      uv[k * 2] = u; uv[k * 2 + 1] = v;
    });
    const b = i * 4;
    idx.set([b, b + 1, b + 2, b, b + 2, b + 3], i * 6);
  });

  const nrm = new Float32Array(n * 4 * 3);
  for (let i = 0; i < n * 4; i++) nrm[i * 3 + 2] = 1;

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('aCenter', new THREE.BufferAttribute(cen, 3));
  g.setAttribute('aLocal', new THREE.BufferAttribute(loc, 2));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 2, 0), 140);

  const mat = new THREE.MeshBasicMaterial({
    map: atlas.texture, vertexColors: true, side: THREE.DoubleSide,
    transparent: true, alphaTest: 0.42, depthWrite: true
  });
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = 'attribute vec3 aCenter;\nattribute vec2 aLocal;\n' + sh.vertexShader;
    sh.vertexShader = sh.vertexShader.replace('#include <begin_vertex>', [
      'vec3 look = cameraPosition - aCenter;',
      'look.y = 0.0;',
      'float ll = length( look );',
      'vec3 fwd = ll > 0.0001 ? look / ll : vec3( 0.0, 0.0, 1.0 );',
      'vec3 rgt = normalize( cross( vec3( 0.0, 1.0, 0.0 ), fwd ) );',
      'vec3 transformed = aCenter + rgt * aLocal.x + vec3( 0.0, aLocal.y, 0.0 );'
    ].join('\n'));
  };
  mat.customProgramCacheKey = () => 'islandPortSign2';

  const mesh = new THREE.Mesh(g, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 4;
  return { mesh, geometry: g, material: mat, atlas, colors: g.attributes.color };
}

export default {
  portBaseGeo, portShipGeo, portFlagGeo, seagullGeo, portSignAtlas, buildSignMesh
};
