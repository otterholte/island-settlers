/**
 * Island Settlers — procedural geometry toolkit for characters.
 *
 * Everything here is pure three.js primitive work plus a hand-rolled merge
 * (BufferGeometryUtils is deliberately not vendored). Merging lets a whole
 * limb — bone, sleeve, cuff, hand — collapse into ONE draw call while still
 * carrying per-piece colour through a vertex-colour attribute.
 *
 * Owner: Character agent.
 */

import * as THREE from 'three';

const _pos = new THREE.Vector3();
const _scl = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _eul = new THREE.Euler();
const _v = new THREE.Vector3();

/* ------------------------------------------------------------------ basics */

/** Compose a transform from plain arrays. `scl` may be a number. */
export function xform(pos = [0, 0, 0], rot = [0, 0, 0], scl = 1) {
  const m = new THREE.Matrix4();
  _pos.set(pos[0] || 0, pos[1] || 0, pos[2] || 0);
  _eul.set(rot[0] || 0, rot[1] || 0, rot[2] || 0);
  _quat.setFromEuler(_eul);
  if (typeof scl === 'number') _scl.set(scl, scl, scl);
  else _scl.set(scl[0] ?? 1, scl[1] ?? 1, scl[2] ?? 1);
  return m.compose(_pos, _quat, _scl);
}

/** One merge-ready piece: geometry + flat colour + local placement. */
export function part(geo, color, pos, rot, scl) {
  return { geo, color, matrix: xform(pos, rot, scl) };
}

/**
 * Merge pieces into a single non-indexed BufferGeometry carrying
 * position / normal / colour. Source geometries are disposed unless
 * `keep` is true (used for shared primitives).
 */
export function mergeParts(parts, keep = false) {
  const prepared = [];
  let total = 0;

  for (const p of parts) {
    if (!p || !p.geo) continue;
    let g = p.geo.index ? p.geo.toNonIndexed() : p.geo.clone();
    g.applyMatrix4(p.matrix || xform());
    if (!g.attributes.normal) g.computeVertexNormals();
    const c = new THREE.Color(p.color === undefined ? 0xffffff : p.color);
    total += g.attributes.position.count;
    prepared.push({ g, c });
    if (!keep && p.geo.index) p.geo.dispose();
  }

  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  const color = new Float32Array(total * 3);

  let o = 0;
  for (const { g, c } of prepared) {
    const n = g.attributes.position.count;
    position.set(g.attributes.position.array, o * 3);
    normal.set(g.attributes.normal.array, o * 3);
    for (let i = 0; i < n; i++) {
      color[(o + i) * 3 + 0] = c.r;
      color[(o + i) * 3 + 1] = c.g;
      color[(o + i) * 3 + 2] = c.b;
    }
    o += n;
    g.dispose();
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(position, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  out.setAttribute('color', new THREE.BufferAttribute(color, 3));
  out.computeBoundingSphere();
  return out;
}

/**
 * Weld already-merged bone geometries into ONE skinnable buffer.
 *
 * Each entry is `{ geometry, boneIndex, bindMatrix }` where `geometry` is
 * authored in that bone's local space and `bindMatrix` is the bone's world
 * matrix in the rest pose. The vertices are baked into bind space and given a
 * single hard weight on their bone, which reproduces a rigid transform rig
 * exactly — same silhouette, same animation, one draw call instead of twelve.
 *
 * Pair with `boneInverses[i] = inverse(bones[i].matrixWorld)` taken from the
 * same rest pose and `mesh.bind(skeleton, new THREE.Matrix4())`, so the shader
 * evaluates `bone.matrixWorld * vertexLocal` — literally what the old scene
 * graph was doing per mesh.
 */
export function skinCombine(pieces) {
  const live = pieces.filter(p => p && p.geometry && p.geometry.attributes.position);
  let total = 0;
  for (const p of live) total += p.geometry.attributes.position.count;

  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  const color = new Float32Array(total * 3);
  const skinIndex = new Uint16Array(total * 4);
  const skinWeight = new Float32Array(total * 4);

  const nm = new THREE.Matrix3();
  let o = 0;
  for (const p of live) {
    const g = p.geometry;
    const n = g.attributes.position.count;
    const pos = g.attributes.position.array;
    const nor = g.attributes.normal ? g.attributes.normal.array : null;
    const col = g.attributes.color ? g.attributes.color.array : null;
    nm.getNormalMatrix(p.bindMatrix);
    for (let i = 0; i < n; i++) {
      const j = (o + i) * 3;
      _v.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]).applyMatrix4(p.bindMatrix);
      position[j] = _v.x; position[j + 1] = _v.y; position[j + 2] = _v.z;
      if (nor) {
        _v.set(nor[i * 3], nor[i * 3 + 1], nor[i * 3 + 2]).applyMatrix3(nm).normalize();
        normal[j] = _v.x; normal[j + 1] = _v.y; normal[j + 2] = _v.z;
      }
      if (col) { color[j] = col[i * 3]; color[j + 1] = col[i * 3 + 1]; color[j + 2] = col[i * 3 + 2]; }
      else { color[j] = color[j + 1] = color[j + 2] = 1; }
      skinIndex[(o + i) * 4] = p.boneIndex;
      skinWeight[(o + i) * 4] = 1;
    }
    o += n;
    g.dispose();
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(position, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  out.setAttribute('color', new THREE.BufferAttribute(color, 3));
  out.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
  out.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
  out.computeBoundingSphere();
  return out;
}

/* -------------------------------------------------------------- primitives */

/**
 * Chunky rounded box — the workhorse shape for stylized mobile characters.
 * Built by pushing a unit sphere out onto a clamped box core (Minkowski
 * sum), which keeps the normals perfectly smooth on the fillets.
 */
export function roundedBox(w, h, d, r, wSeg = 14, hSeg = 8) {
  const g = new THREE.SphereGeometry(1, wSeg, hSeg);
  const pos = g.attributes.position;
  const nor = g.attributes.normal;
  const rr = Math.min(r, w / 2, h / 2, d / 2);
  const hx = Math.max(w / 2 - rr, 0);
  const hy = Math.max(h / 2 - rr, 0);
  const hz = Math.max(d / 2 - rr, 0);
  for (let i = 0; i < pos.count; i++) {
    _v.fromBufferAttribute(pos, i);
    if (_v.lengthSq() < 1e-9) _v.set(0, 1, 0); else _v.normalize();
    nor.setXYZ(i, _v.x, _v.y, _v.z);
    const cx = THREE.MathUtils.clamp(_v.x * w, -hx, hx);
    const cy = THREE.MathUtils.clamp(_v.y * h, -hy, hy);
    const cz = THREE.MathUtils.clamp(_v.z * d, -hz, hz);
    pos.setXYZ(i, cx + _v.x * rr, cy + _v.y * rr, cz + _v.z * rr);
  }
  pos.needsUpdate = true;
  nor.needsUpdate = true;
  g.computeBoundingSphere();
  return g;
}

export function capsule(radius, length, cap = 4, radial = 10) {
  return new THREE.CapsuleGeometry(radius, length, cap, radial);
}

export function ball(radius, wSeg = 12, hSeg = 8) {
  return new THREE.SphereGeometry(radius, wSeg, hSeg);
}

export function tube(rTop, rBot, h, seg = 12, open = false) {
  return new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, open);
}

export function rock(radius, detail = 0, lowPoly = false) {
  const g = lowPoly
    ? new THREE.OctahedronGeometry(radius, detail)
    : new THREE.IcosahedronGeometry(radius, detail);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    _v.fromBufferAttribute(pos, i);
    const k = 0.82 + 0.36 * fract(Math.sin(i * 12.9898) * 43758.5453);
    pos.setXYZ(i, _v.x * k, _v.y * k * 0.86, _v.z * k);
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

function fract(x) { return x - Math.floor(x); }

/* ---------------------------------------------------------------- textures */

function makeCanvas(w, h) {
  const c = (typeof document !== 'undefined' && document.createElement)
    ? document.createElement('canvas') : null;
  if (!c) return null;
  c.width = w; c.height = h;
  const ctx = c.getContext && c.getContext('2d');
  if (!ctx) return null;
  return { canvas: c, ctx };
}

/** Wrap a painted canvas as an sRGB texture; degrades to null headlessly. */
export function canvasTexture(w, h, paint, opts = {}) {
  const cc = makeCanvas(w, h);
  if (!cc) return null;
  try { paint(cc.ctx, w, h); } catch (e) { return null; }
  const tex = new THREE.CanvasTexture(cc.canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = opts.anisotropy || 4;
  tex.wrapS = opts.wrapS || THREE.ClampToEdgeWrapping;
  tex.wrapT = opts.wrapT || THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

export function hexCss(hex) {
  return '#' + (hex & 0xffffff).toString(16).padStart(6, '0');
}

/** Lighten / darken a packed hex colour. amt > 0 lightens. */
export function shade(hex, amt) {
  const c = new THREE.Color();
  c.setHex(hex, THREE.SRGBColorSpace);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl, THREE.SRGBColorSpace);
  c.setHSL(
    hsl.h,
    THREE.MathUtils.clamp(hsl.s * (amt < 0 ? 1.06 : 0.97), 0, 1),
    THREE.MathUtils.clamp(hsl.l + amt, 0.03, 0.97),
    THREE.SRGBColorSpace
  );
  return c.getHex(THREE.SRGBColorSpace);
}

/* ------------------------------------------------------------------ shared */

const bodyMaterials = new Map();

/** One shared standard material per tint-free body; vertex colours do the work. */
export function bodyMaterial(key = 'default') {
  if (!bodyMaterials.has(key)) {
    bodyMaterials.set(key, new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.72,
      metalness: 0.0
    }));
  }
  return bodyMaterials.get(key);
}

export function disposeGeometry(mesh) {
  if (mesh && mesh.geometry) mesh.geometry.dispose();
}
