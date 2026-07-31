/**
 * Island Settlers — procedural geometry toolkit.
 *
 * BufferGeometryUtils is not vendored, so everything here merges by hand.
 * Every helper returns an indexed BufferGeometry carrying position / normal /
 * uv / color, which lets us merge anything with anything and drive the whole
 * world off a handful of vertex-coloured InstancedMeshes.
 */

import * as THREE from 'three';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _c = new THREE.Color();

/* ------------------------------------------------------------- attributes */

export function ensureAttrs(g) {
  const n = g.attributes.position.count;
  if (!g.index) {
    const idx = new Uint32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    g.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  if (!g.attributes.normal) g.computeVertexNormals();
  if (!g.attributes.uv) {
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  }
  if (!g.attributes.color) {
    const a = new Float32Array(n * 3).fill(1);
    g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  }
  return g;
}

/** Flood a geometry with one colour, optionally jittered per vertex. */
export function tint(g, hex, jitter = 0, seed = 1) {
  ensureAttrs(g);
  _c.set(hex);
  const arr = g.attributes.color.array;
  const n = g.attributes.position.count;
  let s = seed * 9781 + 1;
  for (let i = 0; i < n; i++) {
    let j = 0;
    if (jitter) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      j = ((s / 0x7fffffff) - 0.5) * jitter;
    }
    arr[i * 3] = Math.max(0, _c.r * (1 + j));
    arr[i * 3 + 1] = Math.max(0, _c.g * (1 + j));
    arr[i * 3 + 2] = Math.max(0, _c.b * (1 + j));
  }
  g.attributes.color.needsUpdate = true;
  return g;
}

/** Vertical two-tone gradient — cheap way to fake ambient occlusion. */
export function gradient(g, lowHex, highHex) {
  ensureAttrs(g);
  const pos = g.attributes.position.array;
  const col = g.attributes.color.array;
  const n = g.attributes.position.count;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) { const y = pos[i * 3 + 1]; if (y < lo) lo = y; if (y > hi) hi = y; }
  const span = (hi - lo) || 1;
  const a = new THREE.Color(lowHex), b = new THREE.Color(highHex);
  for (let i = 0; i < n; i++) {
    const t = (pos[i * 3 + 1] - lo) / span;
    col[i * 3] = a.r + (b.r - a.r) * t;
    col[i * 3 + 1] = a.g + (b.g - a.g) * t;
    col[i * 3 + 2] = a.b + (b.b - a.b) * t;
  }
  g.attributes.color.needsUpdate = true;
  return g;
}

/* --------------------------------------------------------------- transform */

export function place(g, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx) {
  _e.set(rx, ry, rz);
  _q.setFromEuler(_e);
  _m.compose(_v.set(x, y, z), _q, new THREE.Vector3(sx, sy, sz));
  g.applyMatrix4(_m);
  return g;
}

/* ------------------------------------------------------------------ merge */

export function merge(list) {
  const geos = list.filter(Boolean);
  if (!geos.length) return new THREE.BufferGeometry();
  let vtx = 0, idx = 0;
  for (const g of geos) {
    ensureAttrs(g);
    vtx += g.attributes.position.count;
    idx += g.index.count;
  }
  const pos = new Float32Array(vtx * 3);
  const nor = new Float32Array(vtx * 3);
  const uv = new Float32Array(vtx * 2);
  const col = new Float32Array(vtx * 3);
  const ind = vtx > 65535 ? new Uint32Array(idx) : new Uint16Array(idx);
  let vo = 0, io = 0;
  for (const g of geos) {
    const c = g.attributes.position.count;
    pos.set(g.attributes.position.array.subarray(0, c * 3), vo * 3);
    nor.set(g.attributes.normal.array.subarray(0, c * 3), vo * 3);
    uv.set(g.attributes.uv.array.subarray(0, c * 2), vo * 2);
    col.set(g.attributes.color.array.subarray(0, c * 3), vo * 3);
    const gi = g.index.array;
    for (let i = 0; i < gi.length; i++) ind[io + i] = gi[i] + vo;
    vo += c; io += gi.length;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setIndex(new THREE.BufferAttribute(ind, 1));
  out.computeBoundingSphere();
  return out;
}

/** Triangle count of a geometry. */
export function triCount(g) {
  return (g.index ? g.index.count : g.attributes.position.count) / 3;
}

/* ------------------------------------------------------------- primitives */

export function box(w, h, d, hex, jitter = 0) {
  return tint(new THREE.BoxGeometry(w, h, d), hex, jitter);
}

export function cyl(rt, rb, h, seg, hex, open = false, jitter = 0) {
  return tint(new THREE.CylinderGeometry(rt, rb, h, seg, 1, open), hex, jitter);
}

/**
 * `open` drops the base cap. The camera never gets below a cone's base plane
 * (50 degree downward pitch, and the sun that drives the shadow map is higher
 * still), so for stacked conifer skirts and wheat ears the cap is pure waste —
 * a third to a half of the kit's triangles for a face nobody can see.
 */
export function cone(r, h, seg, hex, jitter = 0, open = false) {
  return tint(new THREE.ConeGeometry(r, h, seg, 1, open), hex, jitter);
}

export function ball(r, det, hex, jitter = 0) {
  return tint(new THREE.IcosahedronGeometry(r, det), hex, jitter);
}

/** 8-face stand-in for `ball` — a fifth of the cost at half a metre wide. */
export function blob(r, hex, jitter = 0) {
  return tint(new THREE.OctahedronGeometry(r, 0), hex, jitter);
}

export function quad(w, h, hex) {
  return tint(new THREE.PlaneGeometry(w, h, 1, 1), hex);
}

/**
 * Chunky low-poly rock: an icosahedron with hashed, per-vertex radial noise.
 * `flat` welds nothing so the facets read hard-edged like painted stone.
 */
export function rock(r, det, hex, rough = 0.34, seed = 7, lowPoly = false) {
  const g = lowPoly
    ? new THREE.OctahedronGeometry(r, det)   // 8 faces — pebble grade
    : new THREE.IcosahedronGeometry(r, det); // 20 faces — hero grade
  const p = g.attributes.position;
  let s = seed * 2654435761 >>> 0;
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  for (let i = 0; i < p.count; i++) {
    const k = 1 + (rnd() - 0.5) * rough * 2;
    p.setXYZ(i, p.getX(i) * k, p.getY(i) * k * (0.72 + rnd() * 0.5), p.getZ(i) * k);
  }
  const flat = g.index ? g.toNonIndexed() : g;
  if (flat !== g) g.dispose();
  flat.computeVertexNormals();
  return tint(flat, hex, 0.09, seed);
}

/** N crossed vertical cards — the workhorse for grass, ferns and wheat. */
export function cards(w, h, n, hex, hex2 = hex, lift = 0) {
  const parts = [];
  for (let i = 0; i < n; i++) {
    const g = new THREE.PlaneGeometry(w, h, 1, 1);
    gradient(g, hex, hex2);
    place(g, 0, h / 2 + lift, 0, 0, (Math.PI / n) * i, 0);
    parts.push(g);
  }
  return merge(parts);
}

/** A tapered blade/leaf built from a 3-segment strip, bent by `bend`. */
export function blade(w, h, hex, hex2, bend = 0.25, seg = 3) {
  const g = new THREE.PlaneGeometry(w, h, 1, seg);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i) + h / 2;
    const t = y / h;
    p.setX(i, p.getX(i) * (1 - t * 0.85));
    p.setY(i, y);
    p.setZ(i, p.getZ(i) + bend * t * t * h);
  }
  g.computeVertexNormals();
  return gradient(g, hex, hex2);
}

/* -------------------------------------------------------------- instancing */

export function instanced(geo, material, count, castShadow = true, receiveShadow = true) {
  const m = new THREE.InstancedMesh(geo, material, count);
  m.castShadow = castShadow;
  m.receiveShadow = receiveShadow;
  m.frustumCulled = false;
  m.count = count;
  return m;
}

const _pos = new THREE.Vector3();
const _scl = new THREE.Vector3();

export function setInstance(mesh, i, x, y, z, ry, s, sy = s, rx = 0, rz = 0) {
  _e.set(rx, ry, rz, 'YXZ');
  _q.setFromEuler(_e);
  _pos.set(x, y, z);
  _scl.set(s, sy, s);
  _m.compose(_pos, _q, _scl);
  mesh.setMatrixAt(i, _m);
}

export function hideInstance(mesh, i) {
  _m.makeScale(0, 0, 0);
  mesh.setMatrixAt(i, _m);
}

/* ------------------------------------------------------------------ shared */

/** One material shared by every opaque vertex-coloured prop. */
export function propMaterial(opts = {}) {
  return new THREE.MeshLambertMaterial({
    vertexColors: true,
    ...opts
  });
}

export function foliageMaterial(opts = {}) {
  return new THREE.MeshLambertMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    ...opts
  });
}
