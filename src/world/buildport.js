/**
 * Island Settlers — harbour kit.
 *
 * One canonical port, instanced nine times. Local space:
 *   +X  points out to sea (the port's `bearing`)
 *   y=0 sits on the wet sand at the shoreline
 *
 * The shore station (warehouse, crates, crane, sign, ramp) stands on a timber
 * platform whose piles sink 1.35 below the origin, which absorbs the shoreline
 * wobble; the dock runs seaward on pilings that reach 2.83 below the origin,
 * comfortably under the water plane, so no port ever floats.
 *
 * The moored ship lives in its own mesh so it can bob on the swell without
 * dragging the dock with it.
 */

import * as THREE from 'three';
import { merge, place, tint, gradient, box, cyl, cone } from './geo.js';
import { canvasTexture } from './paint.js';
import { PAL, prism, decal, cloth, crate, faceGeo } from './buildkit.js';

export const DECK_Y = 0.62;      // dock surface above the shore anchor
export const DOCK_FROM = 0.9;    // dock starts here
export const DOCK_TO = 8.2;      // and reaches this far out to sea
export const DOCK_W = 2.60;

/* ------------------------------------------------------------- shore works */

function platform() {
  return merge([
    place(gradient(new THREE.BoxGeometry(3.5, 0.30, 3.4), 0x7a5a34, 0xa07c4a), -1.6, DECK_Y - 0.15, 0),
    // piles that sink into the sand
    place(tint(new THREE.BoxGeometry(0.26, 1.9, 0.26), PAL.woodDark, 0.06), -3.0, -0.4, 1.35),
    place(tint(new THREE.BoxGeometry(0.26, 1.9, 0.26), PAL.woodDark, 0.06), -3.0, -0.4, -1.35),
    place(tint(new THREE.BoxGeometry(0.26, 1.9, 0.26), PAL.woodDark, 0.06), -0.4, -0.4, 1.35),
    place(tint(new THREE.BoxGeometry(0.26, 1.9, 0.26), PAL.woodDark, 0.06), -0.4, -0.4, -1.35),
    // ramp climbing back toward the cliff
    place(gradient(new THREE.BoxGeometry(3.0, 0.22, 1.5), 0x6f5330, 0x8f6b3f), -4.6, DECK_Y + 0.55, 0, 0, 0, 0.42)
  ]);
}

function warehouse() {
  const w = 2.10, h = 1.45, d = 1.70;
  return merge([
    place(gradient(new THREE.BoxGeometry(w, h, d), 0x8a6338, 0xab7f4c), 0, h / 2, 0),
    place(prism(w * 1.22, h * 0.56, d * 1.28, 0x6f5b45, 0x4d3f2f), 0, h, 0, 0, Math.PI / 2, 0),
    place(decal(w * 0.44, h * 0.66, PAL.woodDark), 0, h * 0.33, d / 2 + 0.012),
    place(box(w * 0.5, 0.07, 0.06, PAL.woodDark), 0, h * 0.70, d / 2 + 0.02),
    // shingle courses picked out along the eaves
    place(box(w * 1.24, 0.07, 0.08, 0x3f3428), 0, h + 0.02, d * 0.64),
    place(box(w * 1.24, 0.07, 0.08, 0x3f3428), 0, h + 0.02, -d * 0.64),
    // awning over the loading door
    place(gradient(new THREE.BoxGeometry(1.4, 0.08, 0.9), 0xe0e6ea, 0xc2593d), 0, h * 0.86, d / 2 + 0.45, -0.22, 0, 0)
  ]);
}

function crane() {
  return merge([
    place(tint(new THREE.BoxGeometry(0.26, 2.90, 0.26), 0x7a5732, 0.06), 0, 1.45, 0),
    place(tint(new THREE.BoxGeometry(2.30, 0.20, 0.20), 0x8a6338, 0.06), 0.95, 2.80, 0, 0, 0, -0.13),
    place(tint(new THREE.BoxGeometry(1.25, 0.16, 0.16), 0x6b4526), 0.52, 2.10, 0, 0, 0, 0.72),
    place(cyl(0.32, 0.32, 0.42, 6, 0x6b4526, false, 0.05), -0.02, 0.72, 0, 0, 0, Math.PI / 2),
    // rope + hook
    place(box(0.05, 1.55, 0.05, PAL.rope), 1.94, 1.98, 0),
    place(tint(new THREE.BoxGeometry(0.18, 0.30, 0.14), PAL.iron), 1.94, 1.10, 0)
  ]);
}

function dock() {
  const parts = [];
  const span = DOCK_TO - DOCK_FROM;
  // stringers
  parts.push(place(tint(new THREE.BoxGeometry(span, 0.16, 0.20), 0x6b4526, 0.06),
    (DOCK_FROM + DOCK_TO) / 2, DECK_Y - 0.14, DOCK_W / 2 - 0.22));
  parts.push(place(tint(new THREE.BoxGeometry(span, 0.16, 0.20), 0x6b4526, 0.06),
    (DOCK_FROM + DOCK_TO) / 2, DECK_Y - 0.14, -DOCK_W / 2 + 0.22));
  // deck planks
  for (let i = 0; i < 6; i++) {
    const x = DOCK_FROM + (span / 6) * (i + 0.5);
    parts.push(place(tint(new THREE.BoxGeometry(span / 6.6, 0.11, DOCK_W), i % 2 ? PAL.plankAlt : PAL.plank, 0.12, 3 + i),
      x, DECK_Y - 0.05, 0));
  }
  // pilings into the water
  for (let i = 0; i < 2; i++) {
    const x = DOCK_FROM + span * (0.32 + i * 0.55);
    parts.push(place(tint(new THREE.BoxGeometry(0.26, 3.4, 0.26), 0x53381d, 0.06), x, DECK_Y - 1.75, DOCK_W / 2 - 0.2));
    parts.push(place(tint(new THREE.BoxGeometry(0.26, 3.4, 0.26), 0x53381d, 0.06), x, DECK_Y - 1.75, -DOCK_W / 2 + 0.2));
  }
  // bollards at the seaward end
  parts.push(place(tint(new THREE.BoxGeometry(0.22, 0.46, 0.22), 0x4d3a22), DOCK_TO - 0.5, DECK_Y + 0.2, DOCK_W / 2 - 0.28));
  parts.push(place(tint(new THREE.BoxGeometry(0.22, 0.46, 0.22), 0x4d3a22), DOCK_TO - 2.4, DECK_Y + 0.2, DOCK_W / 2 - 0.28));
  return merge(parts);
}

function goods() {
  return merge([
    place(crate(0.66), -2.35, DECK_Y, 1.05),
    place(crate(0.52), -2.30, DECK_Y + 0.66, 1.02),
    place(crate(0.58), -1.55, DECK_Y, 1.20),
    place(gradient(new THREE.CylinderGeometry(0.22, 0.26, 0.55, 6), 0x6b4526, PAL.wood), -2.90, DECK_Y + 0.28, -1.05),
    place(gradient(new THREE.CylinderGeometry(0.22, 0.26, 0.55, 6), 0x6b4526, PAL.wood), -2.35, DECK_Y + 0.28, -1.20),
    place(tint(new THREE.IcosahedronGeometry(0.26, 0), PAL.canvas, 0.09), -1.30, DECK_Y + 0.24, -1.15)
  ]);
}

/** Twin-post sign frame. The painted board itself is a billboarded quad. */
function signFrame() {
  return merge([
    place(tint(new THREE.BoxGeometry(0.14, 2.10, 0.14), 0x6b4526, 0.05), -3.35, DECK_Y + 1.05, -1.55),
    place(tint(new THREE.BoxGeometry(0.14, 2.10, 0.14), 0x6b4526, 0.05), -2.15, DECK_Y + 1.05, -1.55),
    place(box(1.55, 0.13, 0.13, 0x53381d), -2.75, DECK_Y + 2.05, -1.55)
  ]);
}

/** Everything that does not move: platform, warehouse, crane, dock, goods. */
export function portBaseGeo() {
  return merge([platform(), place(warehouse(), -1.75, DECK_Y, 0), place(crane(), 1.45, DECK_Y, -0.9),
    dock(), goods(), signFrame()]);
}

/* ------------------------------------------------------------------- ship */

/** V-hull: a keel line with a flared gunwale, 14 triangles. */
function hullGeo() {
  const L = 3.9, W = 1.34, H = 0.82;
  const hw = W / 2, bow = L * 0.56, aft = -L * 0.44;
  const KF = [bow * 0.80, -H, 0], KA = [aft * 0.88, -H * 0.86, 0];
  const tip = [bow, 0.10, 0];
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
  gradient(g, 0x5b3d22, 0x8b5f34);
  return merge([
    g,
    // gunwales + deck
    place(gradient(new THREE.BoxGeometry(L * 0.94, 0.62, W), 0x6a4526, 0x9a6c3c), 0.02, -0.30, 0),
    place(box(L * 0.9, 0.10, W * 1.06, 0xb98a4f, 0.08), 0.02, 0.02, 0),
    place(box(L * 0.9, 0.14, 0.10, 0xc23f2c), 0.02, 0.10, W * 0.53),
    place(box(L * 0.9, 0.14, 0.10, 0xc23f2c), 0.02, 0.10, -W * 0.53),
    // cabin + bowsprit
    place(gradient(new THREE.BoxGeometry(0.85, 0.46, 0.85), 0x7a5230, 0xa9793f), -1.25, 0.28, 0),
    place(prism(0.95, 0.26, 0.95, 0x8c4a2c, 0x6a3520), -1.25, 0.51, 0, 0, Math.PI / 2, 0),
    place(tint(new THREE.BoxGeometry(1.0, 0.09, 0.09), 0x6a4526), 2.45, 0.20, 0, 0, 0, 0.16)
  ]);
}

/** Moored sailing ship: hull, mast, boom, sail and rigging. Bobs on the swell. */
export function portShipGeo() {
  const parts = [hullGeo()];
  parts.push(place(tint(new THREE.BoxGeometry(0.16, 3.60, 0.16), 0x7a5732, 0.05), 0.25, 1.85, 0));
  parts.push(place(tint(new THREE.BoxGeometry(1.90, 0.11, 0.11), 0x6a4526), 0.75, 0.72, 0));
  // main sail
  const sail = cloth(2.05, 2.35, 0xf3ead6, 0xd6c7a6, 0.20, 4);
  place(sail, 1.28, 2.12, 0, 0, Math.PI / 2, 0);
  parts.push(sail);
  // red band across the sail
  const band = cloth(2.05, 0.42, 0xc23f2c, 0x9c3020, 0.20, 4);
  place(band, 1.28, 1.62, 0.02, 0, Math.PI / 2, 0);
  parts.push(band);
  // jib
  const jib = cloth(1.10, 1.45, 0xeee3cc, 0xcdbc9c, 0.14, 3);
  place(jib, -0.62, 2.35, 0, 0, Math.PI / 2, 0);
  parts.push(jib);
  // rigging lines
  const line = (x1, y1, x2, y2) => {
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    return place(box(len, 0.035, 0.035, PAL.rope), (x1 + x2) / 2, (y1 + y2) / 2, 0, 0, 0, Math.atan2(dy, dx));
  };
  parts.push(line(0.25, 3.60, 2.40, 0.30));
  parts.push(line(0.25, 3.60, -1.60, 0.42));
  parts.push(line(0.25, 2.10, 1.10, 0.16));
  return merge(parts);
}

/* ------------------------------------------------------------------- flag */

/** Owner flag on the warehouse gable — authored white for instance tinting. */
export function portFlagGeo() {
  const h = 2.20;
  const parts = [
    place(tint(new THREE.BoxGeometry(0.09, h, 0.09), 0xdcdcdc), 0, h / 2, 0),
    place(box(0.17, 0.17, 0.17, 0xffffff), 0, h + 0.06, 0)
  ];
  const f = cloth(0.95, 0.66, 0xffffff, 0xe0e0e0, 0.10, 3);
  place(f, 0.52, h - 0.42, 0);
  parts.push(f);
  return merge(parts);
}

/* ---------------------------------------------------------------- seagull */

export function seagullGeo() {
  return merge([
    place(tint(new THREE.OctahedronGeometry(0.17, 0), 0xf6f7f8, 0.05), 0, 0, 0, 0, 0, 0, 1.7, 0.7, 0.7),
    place(tint(new THREE.PlaneGeometry(0.30, 0.62, 1, 1), 0xeef1f4), 0, 0.05, 0.32, -Math.PI / 2, 0, 0.35),
    place(tint(new THREE.PlaneGeometry(0.30, 0.62, 1, 1), 0xeef1f4), 0, 0.05, -0.32, -Math.PI / 2, 0, -0.35),
    place(cone(0.06, 0.20, 3, 0xf5a63a), 0.26, 0, 0, 0, 0, -Math.PI / 2)
  ]);
}

/* ------------------------------------------------------------- sign atlas */

const ICON = {
  wood(g, x, y, s) {
    g.fillStyle = '#4c8b3a';
    g.beginPath();
    g.moveTo(x, y - s); g.lineTo(x + s * 0.8, y + s * 0.25); g.lineTo(x - s * 0.8, y + s * 0.25);
    g.closePath(); g.fill();
    g.fillStyle = '#2f6b26';
    g.beginPath();
    g.moveTo(x, y - s * 0.45); g.lineTo(x + s * 0.62, y + s * 0.62); g.lineTo(x - s * 0.62, y + s * 0.62);
    g.closePath(); g.fill();
    g.fillStyle = '#6b4526';
    g.fillRect(x - s * 0.14, y + s * 0.5, s * 0.28, s * 0.5);
  },
  brick(g, x, y, s) {
    g.fillStyle = '#c0562f';
    g.fillRect(x - s * 0.9, y - s * 0.55, s * 1.8, s * 0.5);
    g.fillRect(x - s * 0.9, y + s * 0.08, s * 1.8, s * 0.5);
    g.strokeStyle = '#7d3018'; g.lineWidth = s * 0.1;
    g.strokeRect(x - s * 0.9, y - s * 0.55, s * 1.8, s * 0.5);
    g.strokeRect(x - s * 0.9, y + s * 0.08, s * 1.8, s * 0.5);
  },
  wool(g, x, y, s) {
    g.fillStyle = '#f4f1ea';
    for (const [dx, dy, r] of [[-0.5, 0, 0.55], [0.35, -0.1, 0.6], [0, 0.35, 0.5], [0.6, 0.35, 0.4]]) {
      g.beginPath(); g.arc(x + dx * s, y + dy * s, r * s, 0, Math.PI * 2); g.fill();
    }
    g.fillStyle = '#3a3a42';
    g.beginPath(); g.arc(x + s * 0.85, y - s * 0.05, s * 0.3, 0, Math.PI * 2); g.fill();
  },
  wheat(g, x, y, s) {
    g.strokeStyle = '#c99a2c'; g.lineWidth = s * 0.16; g.lineCap = 'round';
    for (const a of [-0.36, 0, 0.36]) {
      g.beginPath();
      g.moveTo(x + Math.sin(a) * s * 0.9, y + s * 0.95);
      g.lineTo(x + Math.sin(a) * s * 0.25, y - s * 0.85);
      g.stroke();
    }
    g.fillStyle = '#e8b53c';
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
    g.fillStyle = '#8d97a6';
    g.beginPath();
    g.moveTo(x, y - s); g.lineTo(x + s * 0.75, y - s * 0.1);
    g.lineTo(x + s * 0.4, y + s * 0.85); g.lineTo(x - s * 0.45, y + s * 0.85);
    g.lineTo(x - s * 0.8, y - s * 0.15); g.closePath(); g.fill();
    g.fillStyle = '#c3cbd6';
    g.beginPath();
    g.moveTo(x, y - s); g.lineTo(x + s * 0.75, y - s * 0.1);
    g.lineTo(x + s * 0.1, y + s * 0.2); g.closePath(); g.fill();
  },
  any(g, x, y, s) {
    const cols = ['#4c8b3a', '#c0562f', '#e8e4d8', '#e8b53c', '#8d97a6'];
    cols.forEach((c, i) => {
      const a = (Math.PI * 2 * i) / 5 - Math.PI / 2;
      g.fillStyle = c;
      g.beginPath();
      g.arc(x + Math.cos(a) * s * 0.55, y + Math.sin(a) * s * 0.55, s * 0.34, 0, Math.PI * 2);
      g.fill();
    });
  }
};

const FONT = '"Trebuchet MS","Arial Black",Impact,system-ui,sans-serif';

function paintBoard(g, x0, y0, w, h, port) {
  // plank board with a dark frame
  g.fillStyle = '#4a2c14';
  g.fillRect(x0 + 4, y0 + 4, w - 8, h - 8);
  for (let i = 0; i < 4; i++) {
    const py = y0 + 12 + i * ((h - 24) / 4);
    g.fillStyle = i % 2 ? '#b9884d' : '#c69a5c';
    g.fillRect(x0 + 12, py, w - 24, (h - 24) / 4 - 2);
  }
  // grain
  g.strokeStyle = 'rgba(90,58,30,0.28)';
  g.lineWidth = 2;
  for (let i = 0; i < 22; i++) {
    const py = y0 + 14 + Math.random() * (h - 28);
    g.beginPath();
    g.moveTo(x0 + 14, py);
    g.lineTo(x0 + w - 14, py + (Math.random() - 0.5) * 6);
    g.stroke();
  }
  // iron studs
  g.fillStyle = '#3a3f47';
  for (const [sx, sy] of [[x0 + 20, y0 + 20], [x0 + w - 20, y0 + 20],
                          [x0 + 20, y0 + h - 20], [x0 + w - 20, y0 + h - 20]]) {
    g.beginPath(); g.arc(sx, sy, 6, 0, Math.PI * 2); g.fill();
  }
  // icon
  const icon = port.resource ? ICON[port.resource] : ICON.any;
  icon(g, x0 + w * 0.26, y0 + h * 0.5, h * 0.26);
  // ratio
  const label = `${port.ratio}:1`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `900 ${Math.round(h * 0.46)}px ${FONT}`;
  g.lineJoin = 'round';
  g.lineWidth = h * 0.10;
  g.strokeStyle = '#3b2410';
  g.strokeText(label, x0 + w * 0.63, y0 + h * 0.46);
  g.fillStyle = '#fdf0cf';
  g.fillText(label, x0 + w * 0.63, y0 + h * 0.46);
  // sub-label
  g.font = `700 ${Math.round(h * 0.15)}px ${FONT}`;
  g.strokeStyle = '#3b2410';
  g.lineWidth = h * 0.05;
  const sub = port.resource ? String(port.resource).toUpperCase() : 'ANY GOODS';
  g.strokeText(sub, x0 + w * 0.63, y0 + h * 0.80);
  g.fillStyle = '#ffd98a';
  g.fillText(sub, x0 + w * 0.63, y0 + h * 0.80);
}

/**
 * One atlas holding all nine trade boards. Returns { texture, cells } with
 * cells[i] = { u0, v0, u1, v1 } in port order.
 */
export function portSignAtlas(ports) {
  const CW = 256, CH = 128, cols = 3;
  const rows = Math.max(1, Math.ceil(ports.length / cols));
  const w = cols * CW, h = rows * CH;
  const cells = [];
  const texture = canvasTexture(w, h, (g) => {
    g.clearRect(0, 0, w, h);
    ports.forEach((p, i) => {
      paintBoard(g, (i % cols) * CW, Math.floor(i / cols) * CH, CW, CH, p);
    });
  }, { raw: true, aniso: 8 });
  ports.forEach((p, i) => {
    const cx = i % cols, cy = Math.floor(i / cols);
    cells.push({
      u0: cx / cols, u1: (cx + 1) / cols,
      v0: 1 - (cy + 1) / rows, v1: 1 - cy / rows
    });
  });
  return { texture, cells };
}

export default { portBaseGeo, portShipGeo, portFlagGeo, seagullGeo, portSignAtlas };
