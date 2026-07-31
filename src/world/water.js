/**
 * Island Settlers — the sea.
 *
 *   buildWater(scene) -> { mesh, update(t) }
 *
 * One shader plane. Deep cobalt far out, turquoise where the sea floor climbs
 * toward the beach, a long rolling swell in the vertex stage, scrolling
 * sparkle in the fragment stage and an animated white foam ring that hugs the
 * coastline. Depth and foam both read from a small RG height field baked from
 * terrain.heightAt at boot, so the shoreline matches the island exactly.
 * A handful of distant sailboats keep the horizon from being empty.
 */

import * as THREE from 'three';
import { heightAt, WATER_COLORS } from './terrain.js';
import { noiseTexture } from './paint.js';
import { SUN_DIR, SUN_COLOR, HORIZON } from './sky.js';
import { merge, place, tint, box, cyl, triCount } from './geo.js';

const COVER = 72;          // field texture covers [-COVER, COVER] in x and z
const FIELD = 256;
const PLANE = 380;
const SEGS = 64;

/* Height encodings packed into the field texture. */
const R_LO = -3, R_HI = 3;      // near-surface detail: foam + shallows
const G_LO = -8, G_HI = 4;      // broad depth: colour fade

function buildField() {
  const data = new Uint8Array(FIELD * FIELD * 4);
  const step = (COVER * 2) / (FIELD - 1);
  for (let j = 0; j < FIELD; j++) {
    const z = -COVER + j * step;
    for (let i = 0; i < FIELD; i++) {
      const x = -COVER + i * step;
      const h = heightAt(x, z);
      const k = (j * FIELD + i) * 4;
      data[k] = Math.max(0, Math.min(255, ((h - R_LO) / (R_HI - R_LO)) * 255));
      data[k + 1] = Math.max(0, Math.min(255, ((h - G_LO) / (G_HI - G_LO)) * 255));
      data[k + 2] = 0;
      data[k + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, FIELD, FIELD, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

const VERT = /* glsl */`
uniform sampler2D uField;
uniform float uTime;
uniform float uCover;
varying vec2 vWorld;
varying vec3 vWPos;
varying float vShore;
#include <fog_pars_vertex>

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xz;

  vec2 fuv = wp.xz / (uCover * 2.0) + 0.5;
  float hNear = texture2D(uField, clamp(fuv, 0.0, 1.0)).r * 6.0 - 3.0;
  vShore = hNear;

  // damp the swell as the sea floor climbs so it never floods the beach
  float amp = 1.0 - smoothstep(-3.0, -0.35, hNear);

  float s = 0.0;
  s += sin(wp.x * 0.0470 + wp.z * 0.0270 + uTime * 0.78) * 0.36;
  s += sin(wp.x * -0.0310 + wp.z * 0.0660 + uTime * 0.55) * 0.27;
  s += sin(wp.x * 0.1180 - wp.z * 0.0940 + uTime * 1.28) * 0.10;
  s += sin(wp.x * 0.2100 + wp.z * 0.1900 + uTime * 1.90) * 0.045;
  wp.y += s * amp;

  vWPos = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const FRAG = /* glsl */`
uniform sampler2D uField;
uniform sampler2D uNoise;
uniform float uTime;
uniform float uCover;
uniform vec3 uDeep;
uniform vec3 uMid;
uniform vec3 uShallow;
uniform vec3 uFoam;
uniform vec3 uSky;
uniform vec3 uSunDir;
uniform vec3 uSunTint;
varying vec2 vWorld;
varying vec3 vWPos;
varying float vShore;
#include <fog_pars_fragment>

void main() {
  vec2 fuv = clamp(vWorld / (uCover * 2.0) + 0.5, 0.0, 1.0);
  vec4 F = texture2D(uField, fuv);
  float hNear = F.r * 6.0 - 3.0;
  float hDeep = F.g * 12.0 - 8.0;
  float depth = max(-hDeep, 0.0);

  // ------------------------------------------------------------ base colour
  vec3 col = mix(uMid, uDeep, smoothstep(2.2, 6.4, depth));
  col = mix(uShallow, col, smoothstep(0.05, 2.4, depth));

  // banded tonal steps keep it stylised rather than photoreal
  float band = texture2D(uNoise, vWorld * 0.013 + vec2(uTime * 0.004, uTime * 0.003)).r;
  col *= 0.94 + 0.12 * step(0.5, band);

  // ---------------------------------------------------------------- ripples
  vec2 n1 = texture2D(uNoise, vWorld * 0.0225 + vec2(uTime * 0.0090, uTime * 0.0055)).rg;
  vec2 n2 = texture2D(uNoise, vWorld * 0.0620 - vec2(uTime * 0.0170, uTime * 0.0110)).rg;
  vec2 rip = (n1 - 0.5) * 0.85 + (n2 - 0.5) * 0.55;
  vec3 nrm = normalize(vec3(rip.x, 1.0, rip.y));

  vec3 V = normalize(cameraPosition - vWPos);
  vec3 H = normalize(uSunDir + V);
  float spec = pow(max(dot(nrm, H), 0.0), 110.0);
  float glint = smoothstep(0.58, 0.95, n2.r * 0.75 + n1.g * 0.55);
  col += uSunTint * (spec * 1.35 + spec * glint * 3.2);

  float fres = pow(1.0 - max(dot(nrm, V), 0.0), 3.2);
  col = mix(col, uSky, fres * 0.26);

  // ------------------------------------------------------------------- foam
  float wob = texture2D(uNoise, vWorld * 0.085 + vec2(uTime * 0.020, -uTime * 0.014)).r;
  float fine = texture2D(uNoise, vWorld * 0.240 - vec2(uTime * 0.055, uTime * 0.040)).g;

  // surge: the whole ring breathes in and out along the shore
  float surge = 0.5 + 0.5 * sin(uTime * 0.75 + wob * 5.5 + vWorld.x * 0.02);
  float reach = 0.20 + 0.62 * surge;
  float ring = 1.0 - smoothstep(0.0, reach, abs(hNear + 0.16));
  float foam = smoothstep(0.30, 0.86, ring * (0.55 + 0.85 * fine));

  // crisp waterline lip that is always present
  foam += (1.0 - smoothstep(0.0, 0.20, abs(hNear + 0.03))) * 0.9;
  // faint outer wash streaks
  foam += (1.0 - smoothstep(0.5, 1.8, abs(hNear + 0.9))) * fine * 0.28;

  col = mix(col, uFoam, clamp(foam, 0.0, 1.0));

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

/* --------------------------------------------------------------- sailboats */

function boatGeometry() {
  const parts = [];
  const hull = new THREE.CylinderGeometry(0.62, 0.42, 3.1, 6, 1, false);
  tint(hull, 0xe9e2d2);
  place(hull, 0, 0.28, 0, Math.PI / 2, 0, 0, 1, 1, 0.55);
  parts.push(hull);
  const deck = box(1.05, 0.16, 2.4, 0x8c5a30);
  place(deck, 0, 0.52, 0);
  parts.push(deck);
  parts.push(place(cyl(0.055, 0.075, 3.0, 5, 0x6b4426), 0, 2.0, -0.1));
  // main sail
  const sail = new THREE.BufferGeometry();
  sail.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0.62, -0.15, 0, 3.42, -0.15, 0, 0.72, 1.62
  ], 3));
  sail.setIndex([0, 1, 2]);
  sail.computeVertexNormals();
  tint(sail, 0xfdf6e6);
  parts.push(sail);
  // jib
  const jib = new THREE.BufferGeometry();
  jib.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0.62, -0.2, 0, 2.85, -0.2, 0, 0.66, -1.42
  ], 3));
  jib.setIndex([0, 1, 2]);
  jib.computeVertexNormals();
  tint(jib, 0xf2dfc4);
  parts.push(jib);
  parts.push(place(box(0.5, 0.3, 0.04, 0xd0472f), 0.0, 3.36, 0.16));
  return merge(parts);
}

export function buildWater(scene) {
  const field = buildField();
  const noise = noiseTexture(128);

  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    {
      uField: { value: null },
      uNoise: { value: null },
      uTime: { value: 0 },
      uCover: { value: COVER },
      uDeep: { value: new THREE.Color(WATER_COLORS.deep) },
      uMid: { value: new THREE.Color(WATER_COLORS.mid) },
      uShallow: { value: new THREE.Color(WATER_COLORS.shallow) },
      uFoam: { value: new THREE.Color(WATER_COLORS.foam) },
      uSky: { value: new THREE.Color(HORIZON) },
      uSunDir: { value: SUN_DIR.clone() },
      uSunTint: { value: new THREE.Color(SUN_COLOR) }
    }
  ]);
  uniforms.uField.value = field;
  uniforms.uNoise.value = noise;

  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms,
    fog: true,
    side: THREE.FrontSide
  });

  const geo = new THREE.PlaneGeometry(PLANE, PLANE, SEGS, SEGS);
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'sea';
  mesh.position.y = 0;
  mesh.renderOrder = -10;
  mesh.frustumCulled = false;
  mesh.receiveShadow = false;
  mesh.castShadow = false;
  scene.add(mesh);

  /* ----------------------------------------------------------- sailboats */
  const BOATS = 5;
  const boatGeo = boatGeometry();
  const boatMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const boats = new THREE.InstancedMesh(boatGeo, boatMat, BOATS);
  boats.name = 'sailboats';
  boats.castShadow = false;
  boats.receiveShadow = false;
  boats.frustumCulled = false;
  scene.add(boats);

  const lanes = [];
  for (let i = 0; i < BOATS; i++) {
    lanes.push({
      r: 96 + i * 13 + (i % 2) * 9,
      a: (i / BOATS) * Math.PI * 2 + 0.4,
      w: (i % 2 ? -1 : 1) * (0.0085 + i * 0.0016),
      s: 1.5 + (i % 3) * 0.35
    });
  }

  const _m = new THREE.Matrix4();
  const _p = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const _e = new THREE.Euler();
  const _sc = new THREE.Vector3();

  function moveBoats(t) {
    for (let i = 0; i < BOATS; i++) {
      const L = lanes[i];
      const a = L.a + t * L.w;
      const bob = Math.sin(t * 1.1 + i * 2.1) * 0.22;
      _p.set(Math.cos(a) * L.r, -0.15 + bob, Math.sin(a) * L.r);
      // hull runs along local +Z; a yaw of -a points it along the lane tangent
      _e.set(
        Math.sin(t * 0.9 + i) * 0.06,
        -a + (L.w > 0 ? 0 : Math.PI),
        Math.sin(t * 1.3 + i * 1.7) * 0.09,
        'YXZ'
      );
      _q.setFromEuler(_e);
      _sc.setScalar(L.s);
      _m.compose(_p, _q, _sc);
      boats.setMatrixAt(i, _m);
    }
    boats.instanceMatrix.needsUpdate = true;
  }
  moveBoats(0);

  return {
    mesh,
    boats,
    material: mat,
    triangles: SEGS * SEGS * 2 + triCount(boatGeo) * BOATS,
    drawCalls: 2,
    update(t) {
      uniforms.uTime.value = t;
      moveBoats(t);
    },
    dispose() {
      geo.dispose(); mat.dispose(); field.dispose(); noise.dispose();
      boatGeo.dispose(); boatMat.dispose();
    }
  };
}

export default buildWater;
