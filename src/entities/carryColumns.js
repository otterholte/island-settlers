/**
 * Island Settlers — the overhead carry columns.
 *
 *   createCarryColumns() -> { group, setCounts(res), update(dt, camera), dispose() }
 *
 * The pack on a settler's back is behind them, small, and at the play camera
 * (50 degree pitch, 36 degree lens, 56 units out) it is about nine pixels of
 * brown. Players could not tell what they were picking up. So the hero's stock
 * now stacks in FIVE COLUMNS FLOATING OVER THEIR HEAD — logs, bricks, wool
 * bales, wheat sheaves and ore chunks, the same visual language as the HUD
 * icons — and a freshly gathered unit flies up and lands on its column with a
 * bounce.
 *
 * Readability tricks that matter at this camera:
 *   - the whole rig yaws to face the camera every frame, so the five columns
 *     are always side by side across the screen and never occlude each other;
 *   - the columns sit ABOVE the head and are laid out symmetrically about it,
 *     so the body and the ground the player is walking onto stay clear;
 *   - a column caps at eight tokens and grows an "xN" tag instead of a tower.
 *
 * Cost: ONE lit mesh (rebuilt only when the counts change, ~800 triangles at a
 * full load) plus ONE unlit tag mesh that only exists while something is over
 * its cap. Bots get none of this on purpose — the player asked to stop tracking
 * rival activity in detail.
 *
 * Owner: Character agent.
 */

import * as THREE from 'three';
import { RES } from '../core/constants.js';

export const COL_CAP = 8;              // tokens drawn before a column tags out

/* Local units. The whole rig is then blown up by RIG_SCALE, because at the play
   camera one world unit is about twelve pixels: a token has to be the better
   part of a unit across before it is anything but a smudge. */
const COL_GAP = 0.92;                  // horizontal spacing between columns
const ROW_GAP = 0.46;                  // vertical spacing between tokens
const RIG_SCALE = 1.45;
const BASE_Y = 5.35;                   // above the hero's feet
const TAG_LIFT = 0.50;

const COLOR = {
  wood:  [0x8b5a2b, 0xd8b17a],
  brick: [0xa8431f, 0xdd7c4f],
  wool:  [0xd9d2bf, 0xfbf7ee],
  wheat: [0xc38f1f, 0xf3d268],
  ore:   [0x6f7783, 0xc2ccd8]
};

/* ------------------------------------------------------------- geometry */

const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v3 = new THREE.Vector3();
const _c = new THREE.Color();

function piece(geo, hex, pos, rot, scl) {
  _e.set(rot ? rot[0] : 0, rot ? rot[1] : 0, rot ? rot[2] : 0);
  _q.setFromEuler(_e);
  _v3.set(pos ? pos[0] : 0, pos ? pos[1] : 0, pos ? pos[2] : 0);
  const s = scl === undefined ? 1 : scl;
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.applyMatrix4(_m4.compose(_v3, _q, new THREE.Vector3(
    typeof s === 'number' ? s : s[0],
    typeof s === 'number' ? s : s[1],
    typeof s === 'number' ? s : s[2])));
  if (!g.attributes.normal) g.computeVertexNormals();
  return { g, hex };
}

/** One resource token, authored around its own origin. 12–24 triangles. */
function tokenParts(res) {
  const p = [];
  if (res.charCodeAt(0) === 33) {
    // "!<res>" — the dark tray each column stands on. It carries the column's
    // accent colour, so a column is identifiable even when it holds one token.
    const c = COLOR[res.slice(1)];
    p.push(piece(new THREE.BoxGeometry(0.82, 0.06, 0.50), 0x241608, [0, -0.03, 0]));
    p.push(piece(new THREE.BoxGeometry(0.70, 0.05, 0.40), c[1], [0, 0.02, 0]));
    return p;
  }
  const [dark, light] = COLOR[res];
  if (res === 'wood') {
    p.push(piece(new THREE.CylinderGeometry(0.17, 0.17, 0.52, 6, 1, true), dark,
      [0, 0, 0], [0, 0, Math.PI / 2]));
    for (const s of [-1, 1]) {
      const d = new THREE.CircleGeometry(0.17, 6);
      d.rotateY(Math.PI / 2);
      p.push(piece(d, light, [s * 0.26, 0, 0], [0, s > 0 ? 0 : Math.PI, 0]));
    }
  } else if (res === 'brick') {
    p.push(piece(new THREE.BoxGeometry(0.52, 0.24, 0.30), dark));
    p.push(piece(new THREE.BoxGeometry(0.54, 0.06, 0.32), light, [0, 0.10, 0]));
  } else if (res === 'wool') {
    p.push(piece(new THREE.IcosahedronGeometry(0.27, 0), light, [0, 0, 0], [0.4, 0.6, 0],
      [1.15, 0.92, 1.0]));
    p.push(piece(new THREE.BoxGeometry(0.58, 0.09, 0.09), dark, [0, 0, 0]));
  } else if (res === 'wheat') {
    p.push(piece(new THREE.ConeGeometry(0.24, 0.50, 5), light, [0, 0.03, 0]));
    p.push(piece(new THREE.CylinderGeometry(0.20, 0.20, 0.09, 5, 1, true), dark, [0, -0.10, 0]));
  } else {
    p.push(piece(new THREE.OctahedronGeometry(0.28, 0), dark, [0, -0.02, 0], [0.5, 0.8, 0.2],
      [1.0, 0.78, 1.0]));
    p.push(piece(new THREE.OctahedronGeometry(0.13, 0), light, [0.11, 0.13, 0.05], [0.9, 0.3, 0.4],
      [1.0, 1.5, 1.0]));
  }
  return p;
}

const TOKEN_CACHE = {};
function tokenOf(res) {
  if (!TOKEN_CACHE[res]) TOKEN_CACHE[res] = tokenParts(res);
  return TOKEN_CACHE[res];
}

/**
 * Weld a list of placed tokens into one buffer, carrying the two extra
 * attributes the pop shader needs: the token's own centre and its (column,row).
 */
function weld(tokens) {
  let total = 0;
  const prepared = [];
  for (const t of tokens) {
    for (const part of tokenOf(t.res)) {
      const g = part.g.clone();
      _e.set(0, t.spin || 0, 0);
      _q.setFromEuler(_e);
      _v3.set(t.x, t.y, 0);
      g.applyMatrix4(_m4.compose(_v3, _q, new THREE.Vector3(1, 1, 1)));
      total += g.attributes.position.count;
      prepared.push({ g, hex: part.hex, t });
    }
  }
  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  const color = new Float32Array(total * 3);
  const aCen = new Float32Array(total * 3);
  const aTok = new Float32Array(total * 2);
  let o = 0;
  for (const { g, hex, t } of prepared) {
    const n = g.attributes.position.count;
    position.set(g.attributes.position.array, o * 3);
    normal.set(g.attributes.normal.array, o * 3);
    _c.setHex(hex, THREE.SRGBColorSpace);
    for (let i = 0; i < n; i++) {
      const j = (o + i) * 3;
      color[j] = _c.r; color[j + 1] = _c.g; color[j + 2] = _c.b;
      aCen[j] = t.x; aCen[j + 1] = t.y; aCen[j + 2] = 0;
      aTok[(o + i) * 2] = t.col;
      aTok[(o + i) * 2 + 1] = t.row;
    }
    o += n;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(position, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  out.setAttribute('color', new THREE.BufferAttribute(color, 3));
  out.setAttribute('aCen', new THREE.BufferAttribute(aCen, 3));
  out.setAttribute('aTok', new THREE.BufferAttribute(aTok, 2));
  out.computeBoundingSphere();
  return out;
}

/* ---------------------------------------------------------------- the tag */

const TAG_COLS = 8, TAG_ROWS = 8, TAG_MAX = TAG_COLS * TAG_ROWS - 1;

function tagTexture() {
  if (typeof document === 'undefined' || !document.createElement) return null;
  const CW = 128, CH = 64;
  const c = document.createElement('canvas');
  c.width = CW * TAG_COLS; c.height = CH * TAG_ROWS;
  const ctx = c.getContext && c.getContext('2d');
  if (!ctx) return null;
  ctx.clearRect(0, 0, c.width, c.height);
  for (let i = 0; i <= TAG_MAX; i++) {
    const ox = (i % TAG_COLS) * CW, oy = ((i / TAG_COLS) | 0) * CH;
    ctx.save();
    ctx.translate(ox, oy);
    const label = i >= TAG_MAX ? `×${TAG_MAX}+` : `×${i}`;
    const x0 = 10, y0 = 8, x1 = CW - 10, y1 = CH - 8, r = 18;
    ctx.beginPath();
    ctx.moveTo(x0 + r, y0);
    ctx.arcTo(x1, y0, x1, y1, r); ctx.arcTo(x1, y1, x0, y1, r);
    ctx.arcTo(x0, y1, x0, y0, r); ctx.arcTo(x0, y0, x1, y0, r);
    ctx.closePath();
    ctx.fillStyle = 'rgba(14,26,44,0.92)';
    ctx.fill();
    ctx.strokeStyle = '#ffc93c'; ctx.lineWidth = 4; ctx.stroke();
    ctx.fillStyle = '#ffe79a';
    ctx.font = 'bold 34px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(label, CW / 2, CH / 2 + 2);
    ctx.restore();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

let sharedTag = null;
function tagTex() {
  if (sharedTag === null) sharedTag = tagTexture() || false;
  return sharedTag || null;
}

/** Quads for every capped column, pre-tilted to face the play camera. */
function tagGeometry(tags) {
  const W = 1.60, H = 0.80, TILT = -0.87;   // ~50 degrees, the play pitch
  const total = tags.length * 6;
  const position = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  const corner = [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]];
  const ct = Math.cos(TILT), st = Math.sin(TILT);
  tags.forEach((t, k) => {
    const cx = (t.n % TAG_COLS) / TAG_COLS;
    const cy = 1 - (((t.n / TAG_COLS) | 0) + 1) / TAG_ROWS;
    corner.forEach(([sx, sy], i) => {
      const o = (k * 6 + i);
      const lx = sx * W * 0.5, ly = sy * H * 0.5;
      position[o * 3] = t.x + lx;
      position[o * 3 + 1] = t.y + ly * ct;
      position[o * 3 + 2] = ly * st;
      uv[o * 2] = cx + ((sx + 1) / 2) / TAG_COLS;
      uv[o * 2 + 1] = cy + ((sy + 1) / 2) / TAG_ROWS;
    });
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(position, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/* ---------------------------------------------------------------- factory */

export function createCarryColumns() {
  const group = new THREE.Group();
  group.name = 'carryColumns';
  group.position.y = BASE_Y;
  group.scale.setScalar(RIG_SCALE);

  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  mat.userData.pop = { value: new THREE.Vector3(-1, 0, 1) };  // col, row, phase
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uPop = mat.userData.pop;
    sh.vertexShader =
      'attribute vec3 aCen;\nattribute vec2 aTok;\nuniform vec3 uPop;\n' + sh.vertexShader;
    sh.vertexShader = sh.vertexShader.replace('#include <begin_vertex>', [
      '#include <begin_vertex>',
      'if (abs(aTok.x - uPop.x) < 0.5 && abs(aTok.y - uPop.y) < 0.5 && uPop.z < 1.0) {',
      '  float u = clamp(uPop.z, 0.0, 1.0);',
      '  float k = 1.0 - u;',
      '  float sc = mix(0.30, 1.0, smoothstep(0.0, 0.5, u)) * (1.0 + sin(u * 3.1415927) * 0.22);',
      '  transformed = aCen + (transformed - aCen) * sc;',
      '  transformed.y += -2.9 * k * k + sin(u * 9.42) * 0.20 * k;',
      '  transformed.x += k * k * 0.9;',
      '}'
    ].join('\n'));
  };
  mat.customProgramCacheKey = () => 'carryColumnPop';

  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
  mesh.name = 'carryTokens';
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.visible = false;
  group.add(mesh);

  const tagMat = new THREE.MeshBasicMaterial({
    transparent: true, depthWrite: false, depthTest: false, color: 0xffffff
  });
  const tex = tagTex();
  if (tex) tagMat.map = tex;
  const tags = new THREE.Mesh(new THREE.BufferGeometry(), tagMat);
  tags.name = 'carryTags';
  tags.frustumCulled = false;
  /* UNDER THE COUNTDOWN BADGE, NOT OVER IT.
   *
   *   "the x42 is in front of the count down timer for how long it will take
   *    for a tile/hex to replenish, i actually want it to fall behind instead."
   *
   * Both of these draw with `depthTest:false` — they are overlays, and neither
   * is allowed to be swallowed by a hill — so the depth buffer has no say and
   * `renderOrder` decides the whole argument. The badge is 18 (regionmark.js),
   * this was 21, and 21 wins. 17 puts the pile count under it while still
   * keeping it clear of everything that is actually part of the world: rings at
   * 8, particles at 10 and 12, gather effects at 12. */
  tags.renderOrder = 17;
  tags.visible = false;
  group.add(tags);

  const counts = {};
  for (const r of RES) counts[r] = 0;
  let sig = '';
  let popT = 2;
  let popCol = -1, popRow = 0;
  let yaw = 0, yawReady = false;

  function rebuild() {
    const list = [];
    const tagList = [];
    RES.forEach((res, col) => {
      const n = counts[res];
      if (n <= 0) return;
      const x = (col - (RES.length - 1) / 2) * COL_GAP;
      const rows = Math.min(n, COL_CAP);
      list.push({ res: '!' + res, col, row: -1, x, y: -0.34, spin: 0 });
      for (let row = 0; row < rows; row++) {
        list.push({ res, col, row, x, y: row * ROW_GAP, spin: (col * 0.7 + row * 0.9) % 1.4 - 0.7 });
      }
      if (n > COL_CAP && tex) {
        tagList.push({ n: Math.min(n, TAG_MAX), x, y: rows * ROW_GAP + TAG_LIFT });
      }
    });

    mesh.geometry.dispose();
    if (list.length) {
      mesh.geometry = weld(list);
      mesh.visible = true;
    } else {
      mesh.geometry = new THREE.BufferGeometry();
      mesh.visible = false;
    }

    tags.geometry.dispose();
    if (tagList.length) {
      tags.geometry = tagGeometry(tagList);
      tags.visible = true;
    } else {
      tags.geometry = new THREE.BufferGeometry();
      tags.visible = false;
    }
  }

  /** @param res  a bank object keyed by resource. */
  function setCounts(res) {
    let s = '';
    let gainedCol = -1, gainedRow = 0;
    RES.forEach((r, col) => {
      const v = Math.max(0, Math.floor(res && res[r] ? res[r] : 0));
      if (v > counts[r] && gainedCol < 0) {
        gainedCol = col;
        gainedRow = Math.min(v, COL_CAP) - 1;
      }
      counts[r] = v;
      s += v + ',';
    });
    if (s === sig) return;
    sig = s;
    rebuild();
    if (gainedCol >= 0 && gainedRow >= 0) {
      popCol = gainedCol; popRow = gainedRow; popT = 0;
    }
  }

  /**
   * @param dt      seconds
   * @param camera  the play camera; the rig yaws to face it so the columns are
   *                always laid out across the screen rather than into it.
   */
  function update(dt, camera) {
    if (popT < 1) {
      popT = Math.min(1.0001, popT + dt * 3.1);
      mat.userData.pop.value.set(popCol, popRow, popT);
    } else if (mat.userData.pop.value.z < 1) {
      mat.userData.pop.value.set(-1, 0, 1);
    }
    if (!mesh.visible && !tags.visible) return;
    let want = yaw;
    if (camera && camera.position) {
      const w = group.parent;
      const dx = camera.position.x - (w ? w.position.x : 0);
      const dz = camera.position.z - (w ? w.position.z : 0);
      if (dx * dx + dz * dz > 1e-4) want = Math.atan2(dx, dz);
    }
    if (!yawReady) { yaw = want; yawReady = true; }
    let diff = want - yaw;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    yaw += diff * Math.min(1, dt * 6);
    group.rotation.y = yaw;
  }

  function dispose() {
    mesh.geometry.dispose();
    tags.geometry.dispose();
    mat.dispose();
    tagMat.dispose();
  }

  return { group, setCounts, update, dispose, get total() {
    let t = 0; for (const r of RES) t += counts[r]; return t;
  } };
}

export default createCarryColumns;
