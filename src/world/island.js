/**
 * Island Settlers — the island body.
 *
 *   buildIsland(scene) -> {
 *     group, tileMeshes, heightAt, highlightTile(id, color, opacity),
 *     tokenAt(tileId), update(dt, camera)
 *   }
 *
 * One vertex-coloured ground mesh carries the whole island: chunky hex
 * plateaus, the tan border strip the roads run along, mountain peaks, the
 * rocky cliff face, the pale sand beach and the sea floor. Because every
 * vertex is sampled from the single global field in terrain.js, neighbouring
 * hexes share their rim heights exactly and the island is watertight.
 *
 * On top of that sit 19 hidden hex overlays used for tile highlighting and
 * one merged, GPU-billboarded mesh holding every number token.
 */

import * as THREE from 'three';
import { tiles, MARKET } from '../board/layout.js';
import {
  heightAt, minFrac, nearestTile, fbm2, vnoise2, smoothstep, topOf,
  APOTHEM, SHELF, CLIFF_W, BEACH_TOP, PALETTE, SHORE,
  ROAD_STRIP_INNER
} from './terrain.js';
import { grainTexture, tokenAtlas } from './paint.js';
import { hexBorderGeometry } from './borders.js';
import { merge, triCount } from './geo.js';
import { pipsFor } from '../core/constants.js';

const GRID_R = 54;       // ground mesh reaches this far from the island centre
const GRID_S = 1.0;      // vertex spacing
const GRAIN_TILE = 13;   // world units per grain texture repeat
/* Sea floor below this is never visible: the sea is opaque and its deepest
   wave trough is -0.78, so -1.25 leaves half a unit of margin. */
const DROWNED = -1.25;

/* --------------------------------------------------------------- colouring */

const _a = new THREE.Color();
const _b = new THREE.Color();

function paintVertex(x, z, h, out) {
  const tile = nearestTile(x, z);
  const P = PALETTE[tile.terrain];
  const f = minFrac(x, z);
  const sd = (f - 1) * APOTHEM;

  // --- painted tonal bands on the plateau top -------------------------------
  const n = fbm2(x * 0.115 + 3.1, z * 0.115 - 7.7, 3);
  const nb = vnoise2(x * 0.042 - 12.0, z * 0.042 + 5.0);
  const band = n * 0.68 + nb * 0.32;

  out.set(P.low);
  out.lerp(_a.set(P.mid), smoothstep(0.34, 0.50, band));
  out.lerp(_a.set(P.high), smoothstep(0.55, 0.74, band));
  out.lerp(_a.set(P.deep), smoothstep(0.36, 0.18, band));

  // terrain flavour --------------------------------------------------------
  if (tile.terrain === 'mountains') {
    // pale, near-snow caps on the pointed peaks
    out.lerp(_a.set(0xdde6ef), smoothstep(5.2, 6.8, h));
    // dark scree in the folds
    out.lerp(_a.set(0x4d545e), smoothstep(0.42, 0.24, nb) * 0.45);
  } else if (tile.terrain === 'hills') {
    // exposed clay strata
    const s = vnoise2(x * 0.09, h * 1.9);
    out.lerp(_a.set(0x8c4322), smoothstep(0.62, 0.82, s) * 0.55);
  } else if (tile.terrain === 'fields') {
    // ploughed rows
    const rows = Math.abs(Math.sin((x * 0.42 + z * 0.24)));
    out.lerp(_a.set(P.deep), smoothstep(0.86, 1.0, rows) * 0.35);
  } else if (tile.terrain === 'desert') {
    const dm = Math.hypot(x - MARKET.x, z - MARKET.z);
    const plaza = 1 - smoothstep(MARKET.radius * 0.9, MARKET.radius * 1.35, dm);
    out.lerp(_a.set(0xd8c49a), plaza * 0.85);
  }

  // --- tan border strip the roads run along --------------------------------
  const stripCol = _b.set(SHORE.strip).lerp(_a.set(SHORE.stripWarm), nb);
  const strip = smoothstep(ROAD_STRIP_INNER - 0.04, ROAD_STRIP_INNER + 0.10, f);
  out.lerp(stripCol, strip * 0.90);

  // --- rocky cliff face ----------------------------------------------------
  const strata = vnoise2(x * 0.24 + 41.0, h * 1.35);
  const cliffCol = _b.set(P.cliff).lerp(_a.set(P.cliffTop), strata * 0.85 + 0.1);
  cliffCol.lerp(_a.set(SHORE.rock), 0.35);
  out.lerp(cliffCol, smoothstep(SHELF - 0.55, SHELF + 0.85, sd));

  // --- pale sand beach -----------------------------------------------------
  const sandMix = vnoise2(x * 0.17 - 3.0, z * 0.17 + 9.0);
  const sandCol = _b.set(SHORE.sand).lerp(_a.set(SHORE.sandPale), sandMix);
  const sandMask = smoothstep(SHELF + CLIFF_W - 1.5, SHELF + CLIFF_W + 0.3, sd) *
                   (1 - smoothstep(BEACH_TOP - 0.28, BEACH_TOP + 1.05, h));
  out.lerp(sandCol, sandMask);

  // --- wet sand, then the sea floor ---------------------------------------
  out.lerp(_a.set(SHORE.wet), (1 - smoothstep(0.05, 0.46, h)) * 0.85);
  out.lerp(_a.set(SHORE.seabed), smoothstep(0.04, -1.0, h));
  out.lerp(_a.set(SHORE.seabedDeep), smoothstep(-1.1, -3.6, h));
}

/* ------------------------------------------------------------ ground mesh */

function buildGround() {
  const N = Math.ceil((GRID_R * 2) / GRID_S);
  const stride = N + 1;
  const count = stride * stride;
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  const live = new Uint8Array(count);
  const c = new THREE.Color();

  let k = 0;
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++, k++) {
      const edge = (i === 0 || j === 0 || i === N || j === N);
      let x = -GRID_R + i * GRID_S;
      let z = -GRID_R + j * GRID_S;
      if (!edge) {
        x += (vnoise2(i * 0.73 + 4.1, j * 1.31 - 2.7) - 0.5) * GRID_S * 0.62;
        z += (vnoise2(j * 0.91 - 8.3, i * 0.47 + 6.9) - 0.5) * GRID_S * 0.62;
      }
      const h = heightAt(x, z);
      pos[k * 3] = x; pos[k * 3 + 1] = h; pos[k * 3 + 2] = z;
      uv[k * 2] = x / GRAIN_TILE; uv[k * 2 + 1] = z / GRAIN_TILE;
      paintVertex(x, z, h, c);
      col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b;
      live[k] = Math.hypot(x, z) <= GRID_R ? 1 : 0;
    }
  }

  const idx = [];
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const a = j * stride + i, b = a + 1, cIdx = a + stride, d = cIdx + 1;
      if (!(live[a] && live[b] && live[cIdx] && live[d])) continue;
      // The sea is opaque, so any quad that sits well under the wave troughs
      // can never be seen. Dropping them saves ~4.5k triangles on the main
      // pass and the same again on the shadow pass, for zero visual change.
      const hA = pos[a * 3 + 1], hB = pos[b * 3 + 1];
      const hC = pos[cIdx * 3 + 1], hD = pos[d * 3 + 1];
      if (hA < DROWNED && hB < DROWNED && hC < DROWNED && hD < DROWNED) continue;
      if ((i + j) & 1) { idx.push(a, cIdx, b, b, cIdx, d); }
      else { idx.push(a, cIdx, d, a, d, b); }
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/* --------------------------------------------------------- tile overlays */

function overlayGeometry(tile) {
  const SEG = 30, RINGS = 3, OUT = 0.90;
  const pos = [], idx = [];
  pos.push(tile.x, heightAt(tile.x, tile.z) + 0.10, tile.z);
  for (let r = 1; r <= RINGS; r++) {
    const fr = (r / RINGS) * OUT;
    for (let s = 0; s < SEG; s++) {
      const a = (s / SEG) * Math.PI * 2;
      // hex-shaped ring: scale the unit circle out to the hex boundary
      const cx = Math.cos(a), cz = Math.sin(a);
      const m = Math.max(
        Math.abs(cx),
        Math.abs(0.5 * cx + 0.8660254 * cz),
        Math.abs(-0.5 * cx + 0.8660254 * cz)
      );
      const rad = (APOTHEM / m) * fr;
      const x = tile.x + cx * rad, z = tile.z + cz * rad;
      pos.push(x, heightAt(x, z) + 0.10, z);
    }
  }
  for (let s = 0; s < SEG; s++) {
    idx.push(0, 1 + s, 1 + (s + 1) % SEG);
  }
  for (let r = 0; r < RINGS - 1; r++) {
    const b0 = 1 + r * SEG, b1 = b0 + SEG;
    for (let s = 0; s < SEG; s++) {
      const s2 = (s + 1) % SEG;
      idx.push(b0 + s, b1 + s, b0 + s2, b0 + s2, b1 + s, b1 + s2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/* -------------------------------------------------------- number tokens */

/*
 * Number tokens.
 *
 * Two things were broken. First the disc was a plain world-space billboard, so
 * a token six units from the camera drew three times the screen area of one
 * thirty units away and the set stopped reading as a single UI system. The
 * vertex stage below compensates: the quad is scaled by (d / D0)^0.62, which
 * leaves apparent size varying as d^-0.38 instead of d^-1. Over the camera's
 * working range that collapses a 3x spread to about 1.35x, and the clamp caps
 * it either side. Second the disc was far too big and floated too high; the
 * reference keeps it near a fifth of the hex width, sitting ON the tile.
 */
const TOKEN_VERT = /* glsl */`
attribute vec3 aCenter;
attribute vec2 aLocal;
uniform vec3 uCam;
uniform float uTime;
uniform float uRefDist;
varying vec2 vUv;
void main() {
  vec3 up = vec3(0.0, 1.0, 0.0);
  vec3 look = uCam - aCenter;
  look.y = 0.0;
  float l = length(look);
  vec3 fwd = l > 0.0001 ? look / l : vec3(0.0, 0.0, 1.0);
  vec3 right = normalize(cross(up, fwd));

  float d = length(uCam - aCenter);
  float k = clamp(pow(max(d, 1.0) / uRefDist, 0.62), 0.70, 1.55);

  // aCenter is the BASE of the disc and aLocal.y runs 0..2R upward, so the
  // distance compensation grows the token off the ground instead of into it.
  vec3 c = aCenter;
  c.y += sin(uTime * 1.15 + aCenter.x * 0.27 + aCenter.z * 0.19) * 0.07;
  vec3 p = c + right * (aLocal.x * k) + up * (aLocal.y * k);
  vUv = uv;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;

const TOKEN_FRAG = /* glsl */`
uniform sampler2D uMap;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(uMap, vUv);
  if (c.a < 0.42) discard;
  gl_FragColor = vec4(c.rgb, 1.0);
}`;

function buildTokens(scene) {
  const specs = tiles.filter(t => t.number > 0)
    .map(t => ({ tile: t, number: t.number, pips: pipsFor(t.number) }));
  const atlas = tokenAtlas(specs);

  // Hex width (flat to flat) is 2 * APOTHEM = 15.59. At 1.85 the discs read as
  // giant floating coins; 0.175 of the apothem puts the disc at 2.7 across,
  // about a sixth of the hex, which is where the reference art keeps it.
  const R = APOTHEM * 0.175;
  const n = specs.length;
  const pos = new Float32Array(n * 4 * 3);
  const nrm = new Float32Array(n * 4 * 3);
  const cen = new Float32Array(n * 4 * 3);
  const loc = new Float32Array(n * 4 * 2);
  const uv = new Float32Array(n * 4 * 2);
  const idx = new Uint16Array(n * 6);
  const anchors = [];

  specs.forEach((s, i) => {
    const t = s.tile;
    // Base of the disc, a hair over whatever is actually under the tile centre
    // — the plateau on most tiles, the flank of a peak on the mountains.
    const ground = Math.max(heightAt(t.x, t.z), topOf(t));
    const base = ground + 0.34;
    const cell = atlas.cells[i];
    // aLocal.y runs 0 .. 2R so the shader can scale about the disc's base.
    const corners = [[-R, 0, cell.u0, cell.v0], [R, 0, cell.u1, cell.v0],
                     [R, 2 * R, cell.u1, cell.v1], [-R, 2 * R, cell.u0, cell.v1]];
    corners.forEach(([lx, ly, u, v], j) => {
      const k = i * 4 + j;
      pos[k * 3] = t.x; pos[k * 3 + 1] = base + ly; pos[k * 3 + 2] = t.z;
      nrm[k * 3] = 0; nrm[k * 3 + 1] = 0; nrm[k * 3 + 2] = 1;
      cen[k * 3] = t.x; cen[k * 3 + 1] = base; cen[k * 3 + 2] = t.z;
      loc[k * 2] = lx; loc[k * 2 + 1] = ly;
      uv[k * 2] = u; uv[k * 2 + 1] = v;
    });
    const b = i * 4;
    idx.set([b, b + 1, b + 2, b, b + 2, b + 3], i * 6);
    const y = base + R;
    anchors.push({
      tileId: t.id, number: t.number, pips: s.pips, radius: R,
      x: t.x, y, z: t.z, position: new THREE.Vector3(t.x, y, t.z)
    });
  });

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('aCenter', new THREE.BufferAttribute(cen, 3));
  g.setAttribute('aLocal', new THREE.BufferAttribute(loc, 2));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 4, 0), 90);

  const uniforms = {
    uMap: { value: atlas.texture },
    uCam: { value: new THREE.Vector3(0, 40, 60) },
    uTime: { value: 0 },
    // The follow camera orbits ~30 units out; that is the distance at which a
    // token draws at exactly its authored world size.
    uRefDist: { value: 30 }
  };
  const mat = new THREE.ShaderMaterial({
    vertexShader: TOKEN_VERT,
    fragmentShader: TOKEN_FRAG,
    uniforms,
    side: THREE.DoubleSide,
    fog: false,
    toneMapped: false,
    transparent: false
  });
  const mesh = new THREE.Mesh(g, mat);
  mesh.name = 'tokens';
  mesh.frustumCulled = false;
  mesh.renderOrder = 5;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  scene.add(mesh);

  const byTile = new Map(anchors.map(a => [a.tileId, a]));
  return { mesh, uniforms, anchors, byTile, atlas, material: mat };
}

/* -------------------------------------------------------------------- API */

export function buildIsland(scene) {
  const group = new THREE.Group();
  group.name = 'island';
  scene.add(group);

  const grain = grainTexture(256);
  // The hex-border beams and corner posts fold straight into the ground mesh:
  // same material, same planar UVs, zero extra draw calls.
  const groundGeo = merge([buildGround(), hexBorderGeometry()]);
  const groundMat = new THREE.MeshLambertMaterial({
    vertexColors: true,
    map: grain
  });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.name = 'ground';
  ground.castShadow = true;
  ground.receiveShadow = true;
  group.add(ground);

  /* ------------------------------------------------------- tile overlays */
  const tileMeshes = [];
  for (const t of tiles) {
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffe07a,
      transparent: true,
      opacity: 0.0,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending
    });
    const m = new THREE.Mesh(overlayGeometry(t), mat);
    m.name = `tile-${t.id}`;
    m.visible = false;
    m.renderOrder = 3;
    m.userData.tileId = t.id;
    m.userData.terrain = t.terrain;
    m.userData.number = t.number;
    group.add(m);
    tileMeshes.push(m);
  }

  /* ------------------------------------------------------------- tokens */
  const tokens = buildTokens(scene);

  let time = 0;
  const triangles =
    triCount(groundGeo) +
    tileMeshes.reduce((s, m) => s + triCount(m.geometry), 0) +
    triCount(tokens.mesh.geometry);

  return {
    group,
    ground,
    tileMeshes,
    tokens: tokens.mesh,
    heightAt,
    triangles,
    drawCalls: 2,   // ground + tokens (overlays are hidden until used)

    highlightTile(id, color = 0xffe07a, opacity = 0.42) {
      const m = tileMeshes[id];
      if (!m) return;
      if (!opacity) { m.visible = false; return; }
      m.material.color.set(color);
      m.material.opacity = opacity;
      m.visible = true;
    },

    clearHighlights() {
      for (const m of tileMeshes) m.visible = false;
    },

    tokenAt(tileId) {
      return tokens.byTile.get(tileId) || null;
    },

    update(dt, camera) {
      time += dt;
      tokens.uniforms.uTime.value = time;
      if (camera) tokens.uniforms.uCam.value.copy(camera.position);
    },

    dispose() {
      groundGeo.dispose(); groundMat.dispose(); grain.dispose();
      for (const m of tileMeshes) { m.geometry.dispose(); m.material.dispose(); }
      tokens.mesh.geometry.dispose();
      tokens.material.dispose();
      tokens.atlas.texture.dispose();
    }
  };
}

export { heightAt };
export default buildIsland;
