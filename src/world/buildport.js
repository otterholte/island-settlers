/**
 * Island Settlers — harbour kit.
 *
 * One canonical port, instanced nine times. Local space:
 *   +X  points out to sea (the port's `bearing`)
 *   y=0 sits on the wet sand at the shoreline
 *
 * The brief for this pass was the same one the market answered: cleaner, not
 * busier. A harbour is now THREE shapes and a sign — a shingled warehouse on a
 * timber platform, a plank dock running out on pilings, a moored sailing ship,
 * and the trade ratio hung from a plain gate at the head of the dock, big
 * enough to read across the water.
 *
 * What used to be here and is not any more: the dock crane with its jib, brace,
 * winch drum, rope and hook (six pieces standing directly in front of the sign);
 * the harbour lamp and its post; four of the warehouse's corner posts, both
 * eave boards, the door lintel and the hoist beam; the sign gantry's two
 * capitals, two gold finials and two braces; half the cargo; the ship's jib
 * sail, both stays and its masthead finial; and both seagulls per berth — which
 * were the only thing left flying across the one object on the whole structure
 * the player actually has to read. Nine harbours went from 9,729 triangles in
 * six draw calls to 5,625 in five.
 *
 * Everything that does not move lives in `portBaseGeo` and is tinted per
 * instance: weathered grey while the port is locked, full colour once
 * `setUnlocked` fires. The ship carries its own instance colour so a derelict
 * berth reads grey and still.
 */

import * as THREE from 'three';
import { merge, place, tint, gradient, box, cone } from './geo.js';
import { canvasTexture } from './paint.js';
import { PAL, prism, decal, cloth, crate, barrel, faceGeo, stripePanel } from './buildkit.js';

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
 *
 * With the crane gone there is nothing left standing in front of it, so the
 * board grew — 2.50x1.56 to 2.90x1.81 — and went up a little. It is the one
 * thing on a harbour that carries information, so it gets the room.
 */
export const SIGN_LOCAL = {
  x: 1.55, y: DECK_Y + 2.94, z: 0, w: 2.90, h: 1.81
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

/**
 * Warehouse: one gable mass, one ridge, one door, one window.
 *
 * The four corner posts were here to "read the silhouette even at grey-out",
 * and the two eave boards, the lintel and the hoist beam were here to make it
 * look worked-in. What they actually did was cover a 2.3-unit shed in eleven
 * dark stripes. The slate roof carries the silhouette on its own.
 */
function warehouse() {
  const w = 2.30, h = 1.62, d = 2.00;
  return merge([
    place(gradient(new THREE.BoxGeometry(w, h, d), 0x7f5a32, 0xab7f4c), 0, h / 2, 0),
    place(prism(w * 1.26, h * 0.62, d * 1.20, SHINGLE_HI, SHINGLE), 0, h, 0),
    place(box(0.16, 0.16, d * 1.24, 0x3f3428), 0, h + h * 0.62, 0),
    // loading door facing the dock
    place(box(0.10, h * 0.72, w * 0.60, 0x4b3722), w / 2 + 0.02, h * 0.36, 0),
    // shuttered side window
    place(decal(0.42, 0.40, 0x4b5f6b), 0, h * 0.62, d / 2 + 0.012)
  ]);
}

/** Plank dock on pilings, with two bollards. */
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
  return merge(parts);
}

/**
 * Cargo. One crate and one barrel, on the quay, well clear of the gate.
 *
 * Four pieces stacked two-high sat exactly where the eye lands coming off the
 * sign, and every one of them was another dark brown box in a picture already
 * made of dark brown boxes.
 */
function goods() {
  return merge([
    place(crate(0.66), -1.10, DECK_Y, 1.26),
    place(barrel(0.27, 0.58), -1.05, DECK_Y, -1.30)
  ]);
}

/**
 * The gate the painted board hangs from, straddling the head of the dock.
 *
 * Two posts, one beam, two rope droppers — nothing else. It used to carry two
 * capitals, two gold finials and two diagonal braces as well, which turned the
 * frame around the sign into more of an object than the sign itself.
 */
function signFrame() {
  const { x } = SIGN_LOCAL;
  const top = DECK_Y + 4.16;
  return merge([
    place(tint(new THREE.BoxGeometry(0.22, top - DECK_Y, 0.22), 0x6b4526, 0.05), x, DECK_Y + (top - DECK_Y) / 2, 1.58),
    place(tint(new THREE.BoxGeometry(0.22, top - DECK_Y, 0.22), 0x6b4526, 0.05), x, DECK_Y + (top - DECK_Y) / 2, -1.58),
    place(box(0.24, 0.24, 3.40, 0x53381d), x, top, 0),
    place(box(0.05, 0.36, 0.05, PAL.rope), x, top - 0.26, -0.86),
    place(box(0.05, 0.36, 0.05, PAL.rope), x, top - 0.26, 0.86)
  ]);
}

/** Everything that does not move: platform, warehouse, dock, cargo, gate. */
export function portBaseGeo() {
  return merge([
    platform(),
    place(warehouse(), -2.60, DECK_Y, 0),
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

/**
 * Moored sailing ship: hull, mast, boom and one striped mainsail.
 *
 * The jib, the two rigging stays and the gold masthead finial are gone. At the
 * distance the ship is actually seen from, four hairlines crossing the sail
 * read as dirt on the lens, and a second cream sail behind the first only made
 * the striped one harder to pick out.
 */
export function portShipGeo() {
  const parts = [hullGeo()];
  parts.push(place(tint(new THREE.BoxGeometry(0.17, 3.40, 0.17), 0x7a5732, 0.04), 0.30, 1.78, 0));
  parts.push(place(tint(new THREE.BoxGeometry(1.80, 0.12, 0.12), 0x6a4526), 0.72, 0.80, 0));

  const sail = stripePanel(1.92, 2.16, 5, 0xf3e8cd, 0xc23f2c, { bulge: 0.16, rows: 2 });
  place(sail, 1.14, 2.12, 0, 0, Math.PI / 2, 0);
  parts.push(sail);

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
 * One trade board: a cream canvas banner with a swallow-tail hem, carrying the
 * resource icon and the exchange ratio.
 *
 * Drawn with `alphaTest` in mind — everything outside the banner shape stays
 * transparent so the sign keeps a cloth silhouette instead of a hard rectangle.
 *
 * Simplified with the rest of the harbour. The painted lacing, the woven weft,
 * the diagonal shade wash and the inner rule were all detail at a scale nobody
 * ever sees; what is left is three things — icon, ratio, resource — and the
 * ratio is now half the height of the board, because reading it from across the
 * water is the only job this sign has.
 */
function paintBoard(g, x0, y0, w, h, port) {
  const pad = w * 0.05;
  const L = x0 + pad, R = x0 + w - pad;
  const T = y0 + h * 0.085, B = y0 + h * 0.955;
  const notch = h * 0.15;

  // hanging rod
  g.fillStyle = '#4a3520';
  g.fillRect(x0 + w * 0.02, y0 + h * 0.012, w * 0.96, h * 0.062);

  const banner = () => {
    g.beginPath();
    g.moveTo(L, T); g.lineTo(R, T); g.lineTo(R, B);
    g.lineTo((L + R) / 2, B - notch); g.lineTo(L, B);
    g.closePath();
  };
  // dark backing so the banner keeps a heavy outline at distance
  g.save();
  g.translate(0, h * 0.014);
  banner(); g.fillStyle = '#4a3520'; g.fill();
  g.restore();
  banner();
  g.fillStyle = '#e2d0a4'; g.fill();
  g.lineWidth = h * 0.048; g.strokeStyle = '#4a3520'; g.lineJoin = 'round'; g.stroke();

  const cx = (L + R) / 2, cy = T + (B - T) * 0.42;

  // icon on the left, ratio on the right — one line, nothing above or beside it
  const icon = port.resource ? ICON[port.resource] : ICON.any;
  icon(g, L + (R - L) * 0.215, cy, h * 0.215);

  const label = `${port.ratio}:1`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `900 ${Math.round(h * 0.50)}px ${FONT}`;
  g.lineJoin = 'round';
  g.lineWidth = h * 0.10;
  g.strokeStyle = '#3b2410';
  g.strokeText(label, L + (R - L) * 0.645, cy);
  g.fillStyle = '#fff6de';
  g.fillText(label, L + (R - L) * 0.645, cy);

  // what it takes, along the hem
  g.font = `800 ${Math.round(h * 0.145)}px ${FONT}`;
  g.lineWidth = h * 0.055;
  g.strokeStyle = '#3b2410';
  const sub = port.resource ? String(port.resource).toUpperCase() : 'ANY GOODS';
  g.strokeText(sub, cx, T + (B - T) * 0.795);
  g.fillStyle = '#f3cf85';
  g.fillText(sub, cx, T + (B - T) * 0.795);
}

/**
 * One atlas holding all nine trade boards. Returns { texture, cells } with
 * cells[i] = { u0, v0, u1, v1 } in port order.
 */
export function portSignAtlas(portList) {
  const CW = 384, CH = 240, cols = 3;
  const rows = Math.max(1, Math.ceil(portList.length / cols));
  const w = cols * CW, h = rows * CH;
  const cells = [];
  const texture = canvasTexture(w, h, (g) => {
    g.clearRect(0, 0, w, h);
    portList.forEach((p, i) => {
      paintBoard(g, (i % cols) * CW, Math.floor(i / cols) * CH, CW, CH, p);
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
  portBaseGeo, portShipGeo, portFlagGeo, portSignAtlas, buildSignMesh
};
