/**
 * Island Settlers — shared construction kit.
 *
 * Low-poly, hand-merged geometry for everything the Structures agent builds:
 * roads, villages, cities, the great market and the nine ports. Every helper
 * returns an indexed, vertex-coloured BufferGeometry in canonical local space
 * (origin on the ground, +Y up, "front" toward +X) so the callers can merge or
 * instance it freely.
 *
 * Nothing here touches the DOM or loads an asset. Colours are baked into the
 * vertex colour attribute; the runtime meshes use one shared
 * MeshLambertMaterial with `vertexColors: true`, and per-instance owner colour
 * arrives through InstancedMesh.setColorAt (which multiplies vColor).
 */

import * as THREE from 'three';
import { merge, place, tint, gradient, box, cyl, cone, ball } from './geo.js';
import { canvasTexture } from './paint.js';

/* ------------------------------------------------------------------ palette */

export const PAL = {
  plank:      0xa9793f,
  plankAlt:   0x96682f,
  plankDark:  0x7b5327,
  beam:       0x6b4526,
  woodDark:   0x5c3a1f,
  wood:       0x8a5b31,
  woodPale:   0xc09a63,
  kerb:       0x9aa0a8,
  kerbDark:   0x767d86,
  stone:      0xa9aeb5,
  stoneDark:  0x7b8188,
  stoneLight: 0xc6cad0,
  terra:      0xc0562f,
  terraDark:  0x9b4023,
  terraLight: 0xd9713f,
  plaster:    0xf1e3c3,
  plasterDim: 0xd8c49b,
  thatch:     0xd0a95a,
  clothWhite: 0xffffff,
  canvas:     0xf3e7d0,
  gold:       0xffc93c,
  leaf:       0x3f8a2c,
  leafDark:   0x2f6b26,
  skin:       0xe6c39a,
  dirt:       0xb59a6c,
  sand:       0xe0c790,
  iron:       0x545a63,
  rope:       0xcbb183,
  ember:      0xff8a2b,
  shadow:     0x4a3a24
};

/* ------------------------------------------------------------- raw builders */

/** Non-indexed geometry from an explicit quad + triangle soup. */
export function faceGeo(quads, tris) {
  const pos = [];
  const push = (a, b, c) => {
    pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  };
  if (quads) for (const q of quads) { push(q[0], q[1], q[2]); push(q[0], q[2], q[3]); }
  if (tris) for (const t of tris) push(t[0], t[1], t[2]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.computeVertexNormals();
  return g;
}

/**
 * Pitched roof: ridge runs along local Z, gables face +/-Z. Six triangles,
 * no underside (roofs always cap a solid body).
 */
export function prism(w, h, d, hex, hex2) {
  const hw = w / 2, hd = d / 2;
  const g = faceGeo([
    [[-hw, 0, -hd], [-hw, 0, hd], [0, h, hd], [0, h, -hd]],
    [[hw, 0, hd], [hw, 0, -hd], [0, h, -hd], [0, h, hd]]
  ], [
    [[-hw, 0, -hd], [0, h, -hd], [hw, 0, -hd]],
    [[hw, 0, hd], [0, h, hd], [-hw, 0, hd]]
  ]);
  return hex2 === undefined ? tint(g, hex, 0.05) : gradient(g, hex2, hex);
}

/** Four-sided pyramid roof, flat-faced. 8 triangles. */
export function pyramid(w, h, d, hex, hex2) {
  const hw = w / 2, hd = d / 2;
  const g = faceGeo(null, [
    [[-hw, 0, -hd], [0, h, 0], [hw, 0, -hd]],
    [[hw, 0, -hd], [0, h, 0], [hw, 0, hd]],
    [[hw, 0, hd], [0, h, 0], [-hw, 0, hd]],
    [[-hw, 0, hd], [0, h, 0], [-hw, 0, -hd]]
  ]);
  return hex2 === undefined ? tint(g, hex, 0.05) : gradient(g, hex2, hex);
}

/** A single-sided upright card (for doors, windows, painted signs). */
export function decal(w, h, hex) {
  const g = new THREE.PlaneGeometry(w, h, 1, 1);
  return tint(g, hex, 0.03);
}

/** Cloth panel that hangs from the top edge with a baked wave. */
export function cloth(w, h, hex, hex2, wave = 0.12, segs = 4) {
  const g = new THREE.PlaneGeometry(w, h, segs, 2);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const u = (p.getX(i) + w / 2) / w;
    const v = (p.getY(i) + h / 2) / h;
    p.setZ(i, Math.sin(u * 5.4) * wave * (0.35 + (1 - v) * 0.9));
    p.setY(i, p.getY(i) - Math.sin(u * 3.1) * h * 0.05 * (1 - v));
  }
  g.computeVertexNormals();
  return hex2 === undefined ? tint(g, hex, 0.05) : gradient(g, hex2, hex);
}

/**
 * Striped cloth panel — awnings, sails, valances.
 *
 * Stripes have to be built as separate flat-shaded quads. A subdivided
 * PlaneGeometry with alternating *vertex* colours just blends one colour into
 * the next across every quad, which is why the market awnings used to read as
 * washed-out grey sheets instead of striped canvas.
 *
 * The panel lies in the XY plane facing +Z, bulges toward the viewer, and its
 * top edge (+Y) is a touch darker so the cloth reads as hanging.
 *
 * `opts.scallop` gives the bottom edge a scalloped hem (for valances);
 * `opts.taper` pinches the far edge in (for sails).
 */
export function stripePanel(w, h, n, hexA, hexB, opts = {}) {
  const bulge = opts.bulge ?? 0.10;
  const rows = opts.rows ?? 2;
  const scallop = opts.scallop ?? 0;
  const taper = opts.taper ?? 0;
  const A = new THREE.Color(hexA), B = new THREE.Color(hexB);
  const pos = [], col = [];
  const at = (u, v) => {
    const k = 1 - taper * v;
    let y = -h / 2 + v * h;
    if (scallop && v < 0.001) y += Math.abs(Math.sin(u * Math.PI * n)) * h * scallop;
    return [(-w / 2 + u * w) * k, y,
      Math.sin(u * Math.PI) * bulge + Math.sin(v * Math.PI) * bulge * 0.35];
  };
  for (let i = 0; i < n; i++) {
    const c = i % 2 ? B : A;
    for (let r = 0; r < rows; r++) {
      const u0 = i / n, u1 = (i + 1) / n, v0 = r / rows, v1 = (r + 1) / rows;
      const q = [at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)];
      const shade = 1.02 - ((v0 + v1) / 2) * 0.20;
      for (const t of [[0, 1, 2], [0, 2, 3]]) {
        for (const j of t) {
          pos.push(q[j][0], q[j][1], q[j][2]);
          col.push(c.r * shade, c.g * shade, c.b * shade);
        }
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.computeVertexNormals();
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
  return g;
}

/* -------------------------------------------------------------- small props */

export function plank(len, w, t, hex, seed = 1) {
  return tint(new THREE.BoxGeometry(len, t, w), hex, 0.08, seed);
}

export function post(h, r, hex) {
  return place(cyl(r * 0.86, r, h, 5, hex, false, 0.06), 0, h / 2, 0);
}

export function crate(s = 0.6, hex = PAL.wood) {
  const b = s * 0.1;
  return place(merge([
    box(s, s, s, hex, 0.09),
    place(box(s * 1.03, b, s * 1.03, PAL.woodDark), 0, s * 0.3, 0)
  ]), 0, s / 2, 0);
}

export function barrel(r = 0.26, h = 0.52, hex = PAL.wood) {
  return place(merge([
    cyl(r * 0.9, r, h, 6, hex, false, 0.07),
    place(cyl(r * 1.04, r * 1.04, h * 0.13, 6, PAL.iron, true), 0, h * 0.16, 0)
  ]), 0, h / 2, 0);
}

export function sack(r = 0.24, hex = PAL.canvas) {
  const g = ball(r, 0, hex, 0.1);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    p.setY(i, p.getY(i) * 1.25 + r * 0.1);
    const k = 1 - Math.max(0, p.getY(i) / (r * 1.4)) * 0.45;
    p.setX(i, p.getX(i) * k); p.setZ(i, p.getZ(i) * k);
  }
  g.computeVertexNormals();
  return place(g, 0, r * 0.95, 0);
}

export function rolledCarpet(len = 0.9, r = 0.15, hex = 0xb8452f) {
  return place(merge([
    cyl(r, r, len, 6, hex, false, 0.08),
    place(cyl(r * 1.06, r * 1.06, len * 0.14, 6, PAL.gold, true), 0, 0, 0)
  ]), 0, r, 0, 0, 0, Math.PI / 2);
}

/** Post-and-rail run of `n` bays along local X, centred on the origin. */
export function fenceRun(n = 4, bay = 0.8, h = 0.6, hex = PAL.wood) {
  const parts = [];
  const total = n * bay;
  for (let i = 0; i <= n; i++) {
    parts.push(place(post(h, 0.055, hex), -total / 2 + i * bay, 0, 0));
  }
  parts.push(place(box(total, 0.06, 0.05, PAL.woodDark, 0.06), 0, h * 0.78, 0));
  parts.push(place(box(total, 0.06, 0.05, PAL.woodDark, 0.06), 0, h * 0.44, 0));
  return merge(parts);
}

/** Chimney with a soot cap. */
export function chimney(h = 0.55, r = 0.1, hex = PAL.stone) {
  return place(merge([
    box(r * 2, h, r * 2, hex, 0.08),
    place(box(r * 2.5, r * 0.5, r * 2.5, PAL.stoneDark), 0, h / 2, 0)
  ]), 0, h / 2, 0);
}

/** Tiny hanging lantern — warm, used on the market awnings and the ports. */
export function lantern(r = 0.13) {
  return place(merge([
    cyl(r * 0.62, r, r * 1.5, 5, 0xffdf9a, false, 0.06),
    place(cone(r * 0.95, r * 0.5, 5, PAL.iron), 0, r * 1.0, 0)
  ]), 0, r * 0.75, 0);
}

/* ------------------------------------------------------------------ people */

/**
 * A chibi villager, ~0.95 units tall. Body is pure white so InstancedMesh
 * colour tints the tunic; head and hands keep a warm skin tone that the
 * (deliberately pale) instance colours barely shift. 34 triangles.
 */
export function villagerGeo(hat = true) {
  const parts = [
    place(cyl(0.135, 0.235, 0.50, 6, 0xffffff, true), 0, 0.29, 0),
    place(tint(new THREE.OctahedronGeometry(0.155, 0), PAL.skin, 0.05), 0, 0.68, 0),
    place(box(0.30, 0.09, 0.19, 0xf0f0f0), 0, 0.545, 0)
  ];
  if (hat) parts.push(place(cone(0.20, 0.19, 5, 0xffffff, 0.08), 0, 0.86, 0));
  return merge(parts);
}

/* ------------------------------------------------------------------ plants */

/** Palm tree ~4.2 units tall — market plaza and port dressing. */
export function palmTree(h = 4.0, seed = 3) {
  const parts = [];
  const segs = 4;
  let x = 0, y = 0;
  const lean = 0.16 + (seed % 3) * 0.06;
  for (let i = 0; i < segs; i++) {
    const sh = h / segs;
    const r0 = 0.20 - i * 0.032;
    parts.push(place(cyl(r0 * 0.86, r0, sh * 1.05, 5, i % 2 ? PAL.wood : PAL.woodPale, false, 0.09),
      x + lean * i * 0.5, y + sh / 2, 0, 0, 0, -lean * 0.35));
    x += lean * 0.55; y += sh;
  }
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI * 2 / 6) * i + seed * 0.4;
    const frond = new THREE.PlaneGeometry(2.5, 0.62, 3, 1);
    const p = frond.attributes.position;
    for (let k = 0; k < p.count; k++) {
      const u = (p.getX(k) + 1.25) / 2.5;
      p.setY(k, p.getY(k) * (1 - u * 0.72));
      p.setZ(k, p.getZ(k) - u * u * 1.05);
    }
    frond.computeVertexNormals();
    gradient(frond, PAL.leafDark, PAL.leaf);
    place(frond, x + Math.cos(a) * 1.15, y + 0.16 - Math.abs(Math.sin(a)) * 0.1,
      Math.sin(a) * 1.15, 0, -a, 0.22);
    parts.push(frond);
  }
  parts.push(place(ball(0.22, 0, 0x8a6b2f, 0.1), x + 0.16, y - 0.1, 0.1));
  return merge(parts);
}

/* ------------------------------------------------------------- architecture */

/**
 * Generic cottage: plastered body, pitched terracotta roof with a ridge tile,
 * a door and a window. Ridge runs along local Z. ~24 triangles.
 */
export function cottage(w, h, d, opts = {}) {
  const body = opts.body ?? PAL.plaster;
  const roof = opts.roof ?? PAL.terra;
  const parts = [
    place(gradient(new THREE.BoxGeometry(w, h, d), opts.bodyDim ?? PAL.plasterDim, body), 0, h / 2, 0),
    place(prism(w * 1.16, opts.pitch ?? h * 0.62, d * 1.14, roof, opts.roofDim ?? PAL.terraDark), 0, h, 0)
  ];
  if (opts.door !== false) {
    parts.push(place(decal(w * 0.3, h * 0.55, PAL.woodDark), 0, h * 0.275, d / 2 + 0.012));
  }
  if (opts.window !== false) {
    parts.push(place(decal(w * 0.22, h * 0.24, 0x5f7c8c), w * 0.3, h * 0.66, d / 2 + 0.012));
  }
  return merge(parts);
}

/**
 * Round stone tower with a conical roof and a corbel band.
 * `body`/`bodyDark` let a caller author the stone pale, which is what a mesh
 * that will be multiplied by a per-instance owner colour needs.
 */
export function roundTower(r, h, opts = {}) {
  const roofH = opts.roofH ?? r * 1.5;
  return merge([
    place(gradient(new THREE.CylinderGeometry(r * 0.94, r, h, 8),
      opts.bodyDark ?? PAL.stoneDark, opts.body ?? PAL.stone), 0, h / 2, 0),
    place(cyl(r * 1.14, r * 1.14, h * 0.09, 8, opts.band ?? PAL.stoneLight, true), 0, h * 0.94, 0),
    place(cone(r * 1.2, roofH, 8, opts.roof ?? PAL.terra, 0.07), 0, h + roofH / 2, 0)
  ]);
}

/** Crenellated wall panel running along local X. Body + `merlons` merlons. */
export function wallPanel(len, h, thick, merlons = 2) {
  const parts = [
    place(gradient(new THREE.BoxGeometry(len, h, thick), PAL.stoneDark, PAL.stone), 0, h / 2, 0)
  ];
  const mw = len / (merlons * 2 - 0.4);
  for (let i = 0; i < merlons; i++) {
    const x = -len / 2 + mw * 0.8 + i * (len - mw * 1.6) / Math.max(1, merlons - 1);
    parts.push(place(box(mw, h * 0.26, thick * 1.05, PAL.stoneLight, 0.07), x, h + h * 0.13, 0));
  }
  return merge(parts);
}

/** Village well: stone drum, two posts, a little pitched shelter and a bucket. */
export function well(r = 0.42) {
  return merge([
    place(cyl(r, r * 1.05, 0.46, 7, PAL.stone, false, 0.09), 0, 0.23, 0),
    place(cyl(r * 1.1, r * 1.1, 0.08, 7, PAL.stoneLight, true), 0, 0.47, 0),
    place(box(0.07, 0.72, 0.07, PAL.wood), -r * 0.8, 0.82, 0),
    place(box(0.07, 0.72, 0.07, PAL.wood), r * 0.8, 0.82, 0),
    place(prism(r * 2.5, 0.32, r * 1.5, PAL.terra, PAL.terraDark), 0, 1.16, 0, 0, Math.PI / 2, 0),
    place(cyl(0.11, 0.13, 0.2, 5, PAL.woodDark), 0, 0.86, 0)
  ]);
}

/** Storehouse: taller barn body with a long shingle roof and loading doors. */
export function storehouse(w = 1.5, h = 1.1, d = 1.1) {
  return merge([
    place(gradient(new THREE.BoxGeometry(w, h, d), 0x8b6136, 0xa9793f), 0, h / 2, 0),
    place(prism(w * 1.2, h * 0.55, d * 1.22, 0x7d5b3a, 0x5f452b), 0, h, 0, 0, Math.PI / 2, 0),
    place(decal(w * 0.42, h * 0.62, PAL.woodDark), w / 2 + 0.012, h * 0.31, 0, 0, Math.PI / 2, 0),
    place(box(w * 0.46, 0.06, 0.05, PAL.woodDark), w / 2 + 0.03, h * 0.66, 0, 0, Math.PI / 2, 0)
  ]);
}

/* -------------------------------------------------------------- flags/poles */

/**
 * Banner pole with a hanging cloth. The cloth is pure white so the caller can
 * tint it to the owner's colour; the pole and finial stay neutral.
 * `flagW/flagH` describe the cloth; the pole runs from y=0 to y=h.
 */
export function bannerPole(h, flagW, flagH, opts = {}) {
  const parts = [
    place(cyl(0.045, 0.06, h, 5, opts.pole ?? PAL.wood, false, 0.05), 0, h / 2, 0),
    place(ball(0.085, 0, opts.finial ?? PAL.gold), 0, h + 0.04, 0)
  ];
  const c = cloth(flagW, flagH, 0xffffff, 0xdedede, 0.09, 3);
  place(c, flagW / 2 + 0.03, h - flagH / 2 - 0.08, 0);
  parts.push(c);
  return merge(parts);
}

/** Small triangular pennant on a short staff — used along the roads. */
export function pennant(h = 0.9, len = 0.42) {
  const flag = faceGeo(null, [
    [[0, h, 0], [len, h - 0.11, 0], [0, h - 0.30, 0]],
    [[0, h, 0], [0, h - 0.30, 0], [len, h - 0.11, 0]]
  ]);
  tint(flag, 0xffffff);
  return merge([
    place(cyl(0.028, 0.036, h, 4, PAL.woodDark), 0, h / 2, 0),
    flag
  ]);
}

/* ------------------------------------------------------------- ground pads */

/**
 * Chunky earth/stone plinth an N-gon wide. `skirt` is how far it sinks below
 * the origin, which is how village pads absorb the height difference across a
 * hex corner where three plateaus of different elevation meet.
 */
export function plinth(r, skirt, sides = 8, top = PAL.dirt, side = 0x8a7048) {
  const h = skirt + 0.22;
  const g = new THREE.CylinderGeometry(r, r * 1.05, h, sides);
  gradient(g, side, top);
  return place(g, 0, 0.11 - skirt / 2, 0);
}

/** Flat cobble ring that reads as a paved apron around a pad. */
export function cobbleRing(rIn, rOut, sides = 10, hex = 0xbfae8b) {
  const g = new THREE.RingGeometry(rIn, rOut, sides, 1);
  tint(g, hex, 0.09);
  return place(g, 0, 0, 0, -Math.PI / 2, 0, 0);
}

/* ---------------------------------------------------------- puff textures */

export function puffTexture() {
  return canvasTexture(64, 64, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    const grd = g.createRadialGradient(w / 2, h / 2, 1, w / 2, h / 2, w / 2);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.42, 'rgba(255,255,255,0.78)');
    grd.addColorStop(0.78, 'rgba(255,255,255,0.20)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.beginPath(); g.arc(w / 2, h / 2, w / 2, 0, Math.PI * 2); g.fill();
  });
}

/**
 * Camera-facing billboard + per-instance alpha, grafted onto a standard
 * MeshBasicMaterial so fog, tone mapping and colour space stay correct.
 */
export function puffMaterial(map) {
  const m = new THREE.MeshBasicMaterial({
    map, transparent: true, depthWrite: false, vertexColors: true
  });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = 'attribute float aAlpha;\nvarying float vAlpha;\n' + sh.vertexShader;
    sh.vertexShader = sh.vertexShader.replace('#include <begin_vertex>',
      '#include <begin_vertex>\nvAlpha = aAlpha;');
    sh.vertexShader = sh.vertexShader.replace('#include <project_vertex>', [
      'vec4 mvPosition = vec4( 0.0, 0.0, 0.0, 1.0 );',
      'float bbScale = 1.0;',
      '#ifdef USE_INSTANCING',
      '  mvPosition = instanceMatrix * mvPosition;',
      '  bbScale = length( instanceMatrix[ 0 ].xyz );',
      '#endif',
      'mvPosition = modelViewMatrix * mvPosition;',
      'mvPosition.xy += transformed.xy * bbScale;',
      'gl_Position = projectionMatrix * mvPosition;'
    ].join('\n'));
    sh.fragmentShader = 'varying float vAlpha;\n' + sh.fragmentShader;
    sh.fragmentShader = sh.fragmentShader.replace('#include <color_fragment>',
      '#include <color_fragment>\ndiffuseColor.a *= vAlpha;');
  };
  m.customProgramCacheKey = () => 'islandPuff';
  return m;
}

/* ----------------------------------------------------------------- utility */

/** Deterministic small RNG so every kit is stable across reloads. */
export function rng(seed) {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (Math.imul(a, 1664525) + 1013904223) >>> 0;
    return a / 4294967296;
  };
}

/** Shared opaque material for every structure mesh. */
export function solidMaterial(opts = {}) {
  return new THREE.MeshLambertMaterial({ vertexColors: true, ...opts });
}

/**
 * Solid material with self-lit warm surfaces.
 *
 * Lambert has one `emissive` uniform for the whole mesh, which is no use when
 * a single merged geometry holds a whole market. Instead the shader keys off
 * the vertex colour: anything authored strongly warm — lamp panes, lit
 * windows, brazier flames — adds its own light, everything else is untouched.
 *
 * Because `vColor` already carries the instance colour, a port whose kit is
 * tinted weathered grey has its lamps go out for free; unlocking it back to
 * white lights them again. The key deliberately requires a *low blue* and a
 * *near-saturated red*, so sand, plaster, canvas and skin never trip it.
 */
export function glowSolidMaterial(opts = {}) {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, ...opts });
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>', [
      '#include <emissivemap_fragment>',
      '#if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )',
      '  float warmKey = smoothstep( 0.56, 0.40, vColor.b ) * smoothstep( 0.88, 0.98, vColor.r );',
      '  totalEmissiveRadiance += diffuseColor.rgb * warmKey * 0.55;',
      '#endif'
    ].join('\n'));
  };
  m.customProgramCacheKey = () => 'islandWarmGlow';
  return m;
}

/** Shared two-sided material for cloth: sails, awnings, banners, flags. */
export function clothMaterial(opts = {}) {
  return new THREE.MeshLambertMaterial({
    vertexColors: true, side: THREE.DoubleSide, ...opts
  });
}

export default { PAL, prism, pyramid, cottage, roundTower, wallPanel, well };
