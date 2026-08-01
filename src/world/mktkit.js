/**
 * Island Settlers — the Great Market kit.
 *
 * The market is the island's landmark, and a landmark is a *silhouette*, not a
 * pile of props. This kit is deliberately spare: one hero trading pavilion, a
 * plain paved plaza, four identical stalls and one painted sign. Everything
 * that used to compete with the roof line — the bell cupola, the dormer, the
 * balcony, the gate arch, the well, the braziers, the banner poles, the
 * bunting, the camels, the cart, the carpets, the crates and the palms — is
 * gone on purpose. Negative space is the feature.
 *
 * Local space: origin on the plaza floor, +Y up, the trading house sits on -X
 * and faces +X, which is also the approach.
 *
 * Every builder returns vertex-coloured indexed BufferGeometry so `market.js`
 * can merge the whole landmark into ONE solid mesh, plus one painted-sign mesh
 * and one instanced crowd. Three objects.
 */

import * as THREE from 'three';
import { merge, place, tint, gradient, box, cyl, ball, cards } from './geo.js';
import { canvasTexture } from './paint.js';
import { PAL, decal, sack, stripePanel } from './buildkit.js';

/* ------------------------------------------------------------------ palette */

export const MK = {
  stoneWarm: 0xc9b48c,
  stoneDeep: 0x9c8459,
  paveHi:    0xe0cfab,
  paveLo:    0xbda882,
  paveEdge:  0xa89372,
  plaster:   0xf0dcae,
  plasterLo: 0xc5a877,
  timber:    0x7a5230,
  timberLo:  0x5a3a1e,
  tile:      0xc0562f,
  tileLo:    0x8e3a1f,
  tileHi:    0xdd7a4a,
  // low blue + saturated red: the key `glowSolidMaterial` self-lights.
  glow:      0xffc866,
  glowDeep:  0xdfae70,
  gold:      0xe8b53c,
  goldDeep:  0xa87a1e
};

/* -------------------------------------------------------------------- plaza */

/**
 * The paved apron: a shallow sunken slab, a swept floor, a single inlaid ring
 * and three entrance steps on +X. No kerb blocks, no radial joints — the whole
 * point of the plaza is that it is empty.
 */
export function plazaGeo(R, hub = 0) {
  const parts = [
    place(gradient(new THREE.CylinderGeometry(R, R + 0.26, 2.0, 16), 0x8a6f45, MK.paveEdge), 0, -1.00, 0),
    place(tint(new THREE.CircleGeometry(R - 0.30, 16), MK.paveHi, 0.030), 0, 0.02, 0, -Math.PI / 2, 0, 0),
    place(tint(new THREE.RingGeometry(R - 0.30, R - 0.02, 16, 1), MK.stoneWarm, 0.030), 0, 0.03, 0, -Math.PI / 2, 0, 0),
    place(tint(new THREE.RingGeometry(R - 2.55, R - 2.28, 16, 1), MK.paveLo, 0.030), 0, 0.035, 0, -Math.PI / 2, 0, 0),
    // an inlaid roundel where the open half of the plaza has its centre — the
    // one bit of ornament left, and it is flush with the paving
    place(tint(new THREE.CircleGeometry(1.55, 14), MK.stoneWarm, 0.025), hub, 0.038, 0, -Math.PI / 2, 0, 0),
    place(tint(new THREE.RingGeometry(1.55, 1.86, 14, 1), MK.stoneDeep, 0.025), hub, 0.040, 0, -Math.PI / 2, 0, 0)
  ];
  for (let i = 0; i < 3; i++) {
    parts.push(place(gradient(new THREE.BoxGeometry(0.46, 0.20, 4.20 - i * 0.55), MK.stoneDeep, MK.paveHi),
      R + 0.20 + i * 0.46, -0.06 - i * 0.15, 0));
  }
  return merge(parts);
}

/* --------------------------------------------------------------- structures */

/**
 * True hip roof: a ridge of length `ridge` running along X, hipped down to
 * all four eaves. Six triangles, no underside.
 */
export function hipRoof(w, h, d, ridge, low, high) {
  const hw = w / 2, hd = d / 2, hr = Math.max(0.001, ridge / 2);
  const g = new THREE.BufferGeometry();
  const A = [-hw, 0, -hd], B = [hw, 0, -hd], C = [hw, 0, hd], D = [-hw, 0, hd];
  const R0 = [-hr, h, 0], R1 = [hr, h, 0];
  const pos = [];
  const tri = (a, b, c) => pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  tri(D, C, R1); tri(D, R1, R0);   // +Z slope
  tri(B, A, R0); tri(B, R0, R1);   // -Z slope
  tri(C, B, R1);                   // +X hip
  tri(A, D, R0);                   // -X hip
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.computeVertexNormals();
  return gradient(g, low, high);
}

/** Cheap shuttered window: reveal, warm pane, one mullion. 26 triangles. */
function windowPane(w, h, sx) {
  return merge([
    place(box(0.14, h + 0.22, w + 0.22, MK.timberLo), 0, 0, 0),
    place(decal(w, h, MK.glow), 0.10 * sx, 0, 0, 0, sx > 0 ? Math.PI / 2 : -Math.PI / 2, 0),
    place(box(0.06, h + 0.04, 0.06, 0x4a3520), 0.115 * sx, 0, 0)
  ]);
}

/**
 * The trading pavilion — the only building on the plaza.
 *
 * One clean mass: stone plinth, plastered walls with corner timbers, a deep
 * covered porch across the whole frontage, one big tiled hip roof, and a single
 * mast on the ridge carrying the trade banner. 6.2 units to the ridge, 8.3 to
 * the finial. The frontage faces +X.
 */
export function tradingHouse() {
  const W = 4.6, D = 5.0, H = 3.60;
  const PLINTH = 0.46;
  const EAVE = PLINTH + H;                 // 4.06
  const parts = [];

  // plinth, stretched forward to carry the porch
  parts.push(place(gradient(new THREE.BoxGeometry(W + 2.6, PLINTH, D + 0.8), MK.stoneDeep, MK.stoneWarm),
    0.90, PLINTH / 2, 0));
  for (let i = 0; i < 3; i++) {
    parts.push(place(gradient(new THREE.BoxGeometry(0.38, 0.16, 3.0 - i * 0.34), MK.stoneDeep, MK.paveHi),
      W / 2 + 2.40 + i * 0.38, PLINTH - 0.06 - i * 0.145, 0));
  }

  // walls
  parts.push(place(gradient(new THREE.BoxGeometry(W, H, D), MK.plasterLo, MK.plaster), 0, PLINTH + H / 2, 0));
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      parts.push(place(tint(new THREE.BoxGeometry(0.26, H, 0.26), MK.timber, 0.05),
        sx * (W / 2 - 0.07), PLINTH + H / 2, sz * (D / 2 - 0.07)));
    }
  }
  // one sill band ties the frontage together
  parts.push(place(box(W + 0.06, 0.16, D + 0.06, MK.timber, 0.04), 0, PLINTH + 2.52, 0));

  // porch: two posts and a head beam, holding the roof out over the approach
  const px = W / 2 + 0.95;
  for (const sz of [-1, 1]) {
    parts.push(place(tint(new THREE.BoxGeometry(0.24, H + 0.06, 0.24), MK.timber, 0.05),
      px, PLINTH + (H + 0.06) / 2, sz * 2.05));
  }
  parts.push(place(box(0.26, 0.28, D + 0.9, MK.timberLo), px, EAVE + 0.19, 0));

  // doorway: dark reveal, warm room behind, a plain frame
  parts.push(place(box(0.16, 1.84, 1.66, MK.timberLo, 0.04), W / 2 + 0.03, PLINTH + 0.92, 0));
  parts.push(place(decal(1.24, 1.46, MK.glow), W / 2 + 0.12, PLINTH + 0.82, 0, 0, Math.PI / 2, 0));
  parts.push(place(box(0.08, 0.12, 1.34, 0x4a3520), W / 2 + 0.15, PLINTH + 1.56, 0));
  parts.push(place(box(0.34, 0.12, 1.86, MK.timber), W / 2 + 0.12, PLINTH + 0.06, 0));
  /*
   * No painted pool of lamplight on the porch floor. It was a hard-edged pale
   * rectangle, and with the crates and the carpets cleared away there is
   * nothing left to break it up — it read as a rug someone had forgotten.
   */

  // windows: one each side of the door, one on each flank
  for (const sz of [-1.62, 1.62]) parts.push(place(windowPane(0.60, 0.66, 1), W / 2 + 0.02, PLINTH + 1.66, sz));
  for (const sz of [-1, 1]) {
    parts.push(place(windowPane(0.60, 0.66, 1), 0, PLINTH + 1.66, sz * (D / 2 + 0.02), 0, sz > 0 ? -Math.PI / 2 : Math.PI / 2, 0));
  }

  // roof — one uninterrupted hip, deep eaves, a long ridge so the mass reads
  // as a building and not as a pyramid dropped on a box
  const RW = W + 2.4, RD = D + 1.2, RH = 2.10;
  parts.push(place(hipRoof(RW, RH, RD, 3.60, MK.tileLo, MK.tile), 0.45, EAVE, 0));
  parts.push(place(box(RW * 1.03, 0.14, RD * 1.03, MK.tileHi, 0.04), 0.45, EAVE + 0.06, 0));
  parts.push(place(box(3.94, 0.16, 0.26, MK.tileLo), 0.45, EAVE + RH, 0));

  // mast on the ridge — carries the trade banner
  parts.push(place(cyl(0.075, 0.11, 2.20, 5, MK.timber, false, 0.04), 0.45, EAVE + RH + 0.95, 0));
  parts.push(place(box(0.11, 0.11, 1.70, MK.timberLo), 0.45, EAVE + RH + 1.79, 0));
  parts.push(place(ball(0.17, 0, MK.gold, 0.05), 0.45, EAVE + RH + 2.14, 0));

  // two rods the hanging sign board swings from (the board itself is painted)
  for (const sz of [-0.94, 0.94]) {
    parts.push(place(box(0.06, 0.40, 0.06, 0x4a3520), px - 0.06, EAVE + 0.05, sz));
  }
  return merge(parts);
}

/* -------------------------------------------------------------------- goods */

/** Stacked logs — reads as WOOD. */
function goodsWood() {
  const log = (x, y) => place(merge([
    place(gradient(new THREE.CylinderGeometry(0.115, 0.115, 0.60, 6), 0x6a4526, 0x9a6c3c), 0, 0, 0),
    place(cyl(0.10, 0.10, 0.04, 6, 0xd8bb87, true), 0, 0.31, 0)
  ]), x, y, 0, Math.PI / 2, 0, 0);
  return merge([log(-0.13, 0.12), log(0.13, 0.12), log(0, 0.34)]);
}

/** Pallet of bricks — reads as BRICK. */
function goodsBrick() {
  const parts = [place(box(0.72, 0.06, 0.46, MK.timberLo), 0, 0.03, 0)];
  for (let r = 0; r < 2; r++) {
    for (let i = 0; i < 3; i++) {
      parts.push(place(box(0.20, 0.11, 0.38, r ? 0xd0673c : PAL.terra, 0.07),
        -0.23 + i * 0.23 + (r ? 0.05 : 0), 0.12 + r * 0.13, 0));
    }
  }
  return merge(parts);
}

/** Bales and a fleece — reads as WOOL. */
function goodsWool() {
  const bale = (x, z, y) => place(merge([
    place(gradient(new THREE.BoxGeometry(0.34, 0.28, 0.30), 0xdcd6c6, 0xf6f2e8), 0, 0, 0),
    place(box(0.36, 0.05, 0.05, 0x8a6338), 0, 0.02, 0)
  ]), x, y, z);
  return merge([bale(-0.18, 0, 0.15), bale(0.20, 0.02, 0.15), bale(0, -0.02, 0.44)]);
}

/** Grain sacks and a sheaf — reads as WHEAT. */
function goodsWheat() {
  return merge([
    place(sack(0.20, 0xe6d7b4), -0.20, 0.02, 0.04),
    place(sack(0.17, 0xd9c79c), 0.10, 0.02, -0.06),
    place(cards(0.30, 0.52, 2, 0xc99a2c, 0xf0cf62, 0.02), 0.26, 0.06, 0.14, 0, 0.4, 0.10)
  ]);
}

/** Basket of ore — reads as ORE. */
function goodsOre() {
  const parts = [
    place(gradient(new THREE.CylinderGeometry(0.24, 0.19, 0.26, 7), 0x6b4526, 0xa9793f), 0, 0.13, 0),
    place(cyl(0.25, 0.25, 0.05, 7, MK.timberLo, true), 0, 0.27, 0)
  ];
  for (const [x, z, r] of [[-0.09, 0.04, 0.11], [0.08, -0.03, 0.12], [0.01, 0.10, 0.09]]) {
    parts.push(place(tint(new THREE.OctahedronGeometry(r, 0), 0x9aa4b2, 0.14), x, 0.31, z));
  }
  return merge(parts);
}

export const GOODS = [goodsWood, goodsBrick, goodsWool, goodsWheat, goodsOre];

/* -------------------------------------------------------------------- stall */

/**
 * One market stall: a plank counter, four posts and a plain striped awning
 * sloping forward to shade the goods. No back board, no lantern, no valance,
 * no crate underneath — just enough to name the resource it deals in.
 *
 * Local +Z is the counter front. The awning is merged in here so the whole
 * landmark stays a single mesh.
 */
export function stall(kind, c1, c2) {
  const parts = [
    // counter
    place(gradient(new THREE.BoxGeometry(2.00, 0.64, 0.84), 0x6f4a29, 0xa9793f), 0, 0.32, 0.04),
    place(box(2.14, 0.12, 0.98, 0xc9a463, 0.05), 0, 0.70, 0.04),
    // posts: taller at the back so the canvas slopes forward
    place(tint(new THREE.BoxGeometry(0.12, 2.02, 0.12), MK.timber, 0.04), -1.00, 1.01, 0.44),
    place(tint(new THREE.BoxGeometry(0.12, 2.02, 0.12), MK.timber, 0.04), 1.00, 1.01, 0.44),
    place(tint(new THREE.BoxGeometry(0.12, 2.36, 0.12), MK.timber, 0.04), -1.00, 1.18, -0.50),
    place(tint(new THREE.BoxGeometry(0.12, 2.36, 0.12), MK.timber, 0.04), 1.00, 1.18, -0.50),
    place(box(2.10, 0.09, 0.09, MK.timberLo), 0, 1.96, 0.44),
    place(box(2.10, 0.09, 0.09, MK.timberLo), 0, 2.30, -0.50)
  ];
  // awning: five calm bands, sloping from the back rail out past the counter
  const a = stripePanel(2.34, 1.75, 5, c1, c2, { bulge: 0.07, rows: 2 });
  parts.push(place(a, 0, 2.04, 0.23, -1.224, 0, 0));
  parts.push(place(GOODS[kind % GOODS.length](), -0.34, 0.76, 0.02));
  return merge(parts);
}

/* --------------------------------------------------------------------- sign */

const FONT = '"Trebuchet MS","Arial Black",Impact,system-ui,sans-serif';

/*
 * One 256x512 atlas holds both painted boards.
 *
 *   top    256x256  -> the swallow-tailed banner that flies off the mast
 *   middle 256x128  -> the shop board hanging over the trading-house door
 *
 * Both are authored well below white on purpose: they are drawn by an unlit
 * MeshBasicMaterial that still runs ACES tone mapping, so a pure-white plate
 * would clip. The brightest ink here is #fff2d2 on a #d9c69a field.
 */
export const SIGN_UV = {
  banner: [0.02, 0.502, 0.98, 0.998],
  board:  [0.02, 0.252, 0.98, 0.498]
};

export function signTexture() {
  return canvasTexture(256, 512, (g, w) => {
    g.clearRect(0, 0, w, 512);
    const cx = w / 2;

    /* ---- banner, y 0..256 ---- */
    const halo = g.createRadialGradient(cx, 132, 26, cx, 132, 126);
    halo.addColorStop(0.00, 'rgba(255,214,132,0.34)');
    halo.addColorStop(0.50, 'rgba(255,196,104,0.15)');
    halo.addColorStop(1.00, 'rgba(255,190,96,0)');
    g.fillStyle = halo;
    g.beginPath(); g.arc(cx, 132, 126, 0, Math.PI * 2); g.fill();

    // hanging bar
    g.strokeStyle = '#4a3520'; g.lineWidth = 11; g.lineCap = 'round';
    g.beginPath(); g.moveTo(40, 34); g.lineTo(216, 34); g.stroke();
    g.strokeStyle = '#6a4526'; g.lineWidth = 5;
    g.beginPath(); g.moveTo(68, 36); g.lineTo(68, 58); g.moveTo(188, 36); g.lineTo(188, 58); g.stroke();

    const banner = (i) => {
      g.beginPath();
      g.moveTo(38 + i, 52 + i); g.lineTo(218 - i, 52 + i); g.lineTo(218 - i, 226 - i);
      g.lineTo(128, 190 - i); g.lineTo(38 + i, 226 - i); g.closePath();
    };
    banner(0); g.fillStyle = '#4a3520'; g.fill();
    banner(9); g.fillStyle = '#d9c69a'; g.fill();
    banner(9); g.lineWidth = 5; g.strokeStyle = '#a8763a'; g.lineJoin = 'round'; g.stroke();

    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineJoin = 'round';
    g.font = `900 44px ${FONT}`;
    g.lineWidth = 12; g.strokeStyle = '#4a3520';
    g.strokeText('TRADE', cx, 100);
    g.fillStyle = '#fff2d2'; g.fillText('TRADE', cx, 100);

    g.font = `900 52px ${FONT}`;
    g.lineWidth = 13; g.strokeStyle = '#4a3520';
    g.strokeText('4 : 1', cx, 156);
    g.fillStyle = '#f0b93f'; g.fillText('4 : 1', cx, 156);

    /* ---- shop board, y 256..384 ---- */
    const bx = 12, by = 268, bw = 232, bh = 104;
    const plate = (i) => {
      g.beginPath();
      g.moveTo(bx + i, by + i); g.lineTo(bx + bw - i, by + i);
      g.lineTo(bx + bw - i, by + bh - i); g.lineTo(bx + i, by + bh - i);
      g.closePath();
    };
    plate(0); g.fillStyle = '#4a3520'; g.fill();
    plate(7); g.fillStyle = '#e2d1a6'; g.fill();
    plate(7); g.lineWidth = 4; g.strokeStyle = '#a8763a'; g.stroke();

    /*
     * One line, not two: the porch eave crops the top fifth of this board at
     * any normal camera pitch, so anything stacked up there is never read.
     */
    g.font = `900 36px ${FONT}`;
    const a = 'TRADE ', b = '4:1';
    const wa = g.measureText(a).width, wb = g.measureText(b).width;
    let tx = cx - (wa + wb) / 2;
    const ty = by + bh * 0.60;
    g.textAlign = 'left';
    g.lineWidth = 10; g.strokeStyle = '#4a3520';
    g.strokeText(a, tx, ty); g.strokeText(b, tx + wa, ty);
    g.fillStyle = '#8a5424'; g.fillText(a, tx, ty);
    g.fillStyle = '#c0562f'; g.fillText(b, tx + wa, ty);
    g.textAlign = 'center';
  }, { aniso: 8 });
}

/**
 * Both painted boards in one geometry.
 *
 * `aFlag == 1` marks the four corners of the mast banner: their `position` is
 * the shared anchor and `aLocal` the corner offset, which the shader expands
 * along the camera's right/up axes. `aFlag == 0` marks the hanging shop board,
 * whose corners are ordinary object-space positions on the +X facing plane.
 */
export function signGeo(banner, board) {
  const pos = [], nrm = [], loc = [], uvs = [], flg = [], idx = [];
  const rect = (uv, u, v) => [uv[0] + (uv[2] - uv[0]) * u, uv[1] + (uv[3] - uv[1]) * v];

  // mast banner — billboard
  {
    const hw = banner.w / 2, hh = banner.h / 2;
    const c = [[-hw, -hh, 0, 0], [hw, -hh, 1, 0], [hw, hh, 1, 1], [-hw, hh, 0, 1]];
    for (const [lx, ly, u, v] of c) {
      pos.push(banner.x, banner.y, banner.z);
      nrm.push(0, 0, 1);
      loc.push(lx, ly);
      uvs.push(...rect(SIGN_UV.banner, u, v));
      flg.push(1);
    }
    idx.push(0, 1, 2, 0, 2, 3);
  }
  // shop board — fixed, facing +X
  {
    const hw = board.w / 2, hh = board.h / 2;
    const c = [[hw, -hh, 0, 0], [-hw, -hh, 1, 0], [-hw, hh, 1, 1], [hw, hh, 0, 1]];
    for (const [lz, ly, u, v] of c) {
      pos.push(board.x, board.y + ly, board.z + lz);
      nrm.push(1, 0, 0);
      loc.push(0, 0);
      uvs.push(...rect(SIGN_UV.board, u, v));
      flg.push(0);
    }
    idx.push(4, 5, 6, 4, 6, 7);
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nrm), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
  g.setAttribute('aLocal', new THREE.BufferAttribute(new Float32Array(loc), 2));
  g.setAttribute('aFlag', new THREE.BufferAttribute(new Float32Array(flg), 1));
  g.setIndex(new THREE.BufferAttribute(new Uint16Array(idx), 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(banner.x, banner.y * 0.5, banner.z),
    banner.y + banner.w);
  return g;
}

/**
 * Unlit material for the painted boards. The banner corners are expanded to
 * face the camera in the vertex shader; the shop board is left alone.
 *
 * `modelMatrix` here is translate * rotateY, so a world-space right vector has
 * to be pulled back into object space before it is added to `position` — that
 * is what the three dot products do. Without them the banner faces the camera
 * plus a constant 145 degrees, which is how the old beacon behaved.
 */
export function signMaterial(map) {
  const m = new THREE.MeshBasicMaterial({
    map, transparent: true, depthWrite: false, side: THREE.DoubleSide
  });
  m.userData.time = { value: 0 };
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uT = m.userData.time;
    sh.vertexShader = 'attribute vec2 aLocal;\nattribute float aFlag;\nuniform float uT;\n' + sh.vertexShader;
    sh.vertexShader = sh.vertexShader.replace('#include <begin_vertex>', [
      'vec3 transformed = position;',
      'if ( aFlag > 0.5 ) {',
      '  vec3 anchor = ( modelMatrix * vec4( position, 1.0 ) ).xyz;',
      '  vec3 look = cameraPosition - anchor;',
      '  look.y = 0.0;',
      '  float ll = length( look );',
      '  vec3 fwd = ll > 0.0001 ? look / ll : vec3( 0.0, 0.0, 1.0 );',
      '  vec3 rgt = normalize( cross( vec3( 0.0, 1.0, 0.0 ), fwd ) );',
      '  vec3 rgtObj = vec3( dot( rgt, modelMatrix[ 0 ].xyz ),',
      '                      dot( rgt, modelMatrix[ 1 ].xyz ),',
      '                      dot( rgt, modelMatrix[ 2 ].xyz ) );',
      '  transformed = position + rgtObj * aLocal.x',
      '              + vec3( 0.0, aLocal.y + sin( uT * 0.62 ) * 0.15, 0.0 );',
      '}'
    ].join('\n'));
  };
  m.customProgramCacheKey = () => 'islandMarketSign';
  return m;
}

export default { plazaGeo, tradingHouse, stall, signTexture, signGeo, signMaterial };
