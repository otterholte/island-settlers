/**
 * Island Settlers — pooled ground-hugging highlight rings.
 *
 * One instanced quad per ring lying flat in XZ, expanded in the vertex shader
 * and shaped into a soft annulus in the fragment shader. The whole pool is ONE
 * draw call and 2 triangles per live ring; nothing is allocated per frame.
 *
 * Used for the gather highlight (`ring`) and for the Raider's arrival wave
 * (`shockwave`), which is the same primitive at hex scale with a dark fill.
 */

import * as THREE from 'three';

const VERT = /* glsl */`
  attribute vec3 iCenter;
  attribute float iRadius;
  attribute vec3 iColor;
  attribute float iAlpha;
  attribute float iWidth;
  attribute float iFill;
  varying vec2 vLocal;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vWidth;
  varying float vFill;
  void main() {
    vLocal = vec2(position.x, position.z);
    vColor = iColor;
    vAlpha = iAlpha;
    vWidth = iWidth;
    vFill = iFill;
    vec3 wp = iCenter + vec3(position.x * iRadius, 0.0, position.z * iRadius);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(wp, 1.0);
  }
`;

const FRAG = /* glsl */`
  varying vec2 vLocal;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vWidth;
  varying float vFill;
  void main() {
    float d = length(vLocal);
    if (d > 1.02) discard;
    float w = clamp(vWidth, 0.02, 0.9);
    // soft band hugging the outer edge
    float band = smoothstep(1.0 - w - 0.10, 1.0 - w * 0.55, d)
               * (1.0 - smoothstep(0.93, 1.0, d));
    float fill = vFill * (1.0 - smoothstep(0.0, 1.0 - w * 0.4, d)) * 0.9;
    float a = (band + fill) * vAlpha;
    if (a < 0.008) discard;
    gl_FragColor = vec4(vColor, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const F = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);

export function createRingField(scene, capacity) {
  const CAP = Math.max(4, capacity | 0 || 20);

  const iCenter = new Float32Array(CAP * 3);
  const iColor = new Float32Array(CAP * 3);
  const iRadius = new Float32Array(CAP);
  const iAlpha = new Float32Array(CAP);
  const iWidth = new Float32Array(CAP);
  const iFill = new Float32Array(CAP);

  // simulation-only
  const life = new Float32Array(CAP);
  const maxLife = new Float32Array(CAP);
  const r0 = new Float32Array(CAP);
  const r1 = new Float32Array(CAP);
  const a0 = new Float32Array(CAP);
  const w0 = new Float32Array(CAP);
  const w1 = new Float32Array(CAP);
  const f0 = new Float32Array(CAP);
  const rise = new Float32Array(CAP);

  const geo = new THREE.InstancedBufferGeometry();
  const quad = new Float32Array([
    -1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1
  ]);
  geo.setAttribute('position', new THREE.BufferAttribute(quad, 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);

  const aCenter = new THREE.InstancedBufferAttribute(iCenter, 3);
  const aColor = new THREE.InstancedBufferAttribute(iColor, 3);
  const aRadius = new THREE.InstancedBufferAttribute(iRadius, 1);
  const aAlpha = new THREE.InstancedBufferAttribute(iAlpha, 1);
  const aWidth = new THREE.InstancedBufferAttribute(iWidth, 1);
  const aFill = new THREE.InstancedBufferAttribute(iFill, 1);
  [aCenter, aColor, aRadius, aAlpha, aWidth, aFill].forEach(a =>
    a.setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('iCenter', aCenter);
  geo.setAttribute('iColor', aColor);
  geo.setAttribute('iRadius', aRadius);
  geo.setAttribute('iAlpha', aAlpha);
  geo.setAttribute('iWidth', aWidth);
  geo.setAttribute('iFill', aFill);
  geo.instanceCount = 0;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 400);

  const mat = new THREE.ShaderMaterial({
    uniforms: {},
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    blending: THREE.NormalBlending,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 8;
  mesh.name = 'fx-rings';
  if (scene && scene.add) scene.add(mesh);

  let alive = 0;
  let peak = 0;

  function swap(a, b) {
    if (a === b) return;
    const a3 = a * 3, b3 = b * 3;
    let t;
    for (let k = 0; k < 3; k++) {
      t = iCenter[a3 + k]; iCenter[a3 + k] = iCenter[b3 + k]; iCenter[b3 + k] = t;
      t = iColor[a3 + k]; iColor[a3 + k] = iColor[b3 + k]; iColor[b3 + k] = t;
    }
    const arrs = [iRadius, iAlpha, iWidth, iFill, life, maxLife,
                  r0, r1, a0, w0, w1, f0, rise];
    for (let i = 0; i < arrs.length; i++) {
      const A = arrs[i];
      t = A[a]; A[a] = A[b]; A[b] = t;
    }
  }

  function spawn(o) {
    let i;
    if (alive >= CAP) {
      let worst = 0;
      for (let k = 1; k < alive; k++) if (life[k] < life[worst]) worst = k;
      i = worst;
    } else {
      i = alive++;
      if (alive > peak) peak = alive;
    }
    const i3 = i * 3;
    iCenter[i3] = F(o.x, 0);
    iCenter[i3 + 1] = F(o.y, 0);
    iCenter[i3 + 2] = F(o.z, 0);
    iColor[i3] = F(o.r, 1);
    iColor[i3 + 1] = F(o.g, 1);
    iColor[i3 + 2] = F(o.b, 1);
    r0[i] = Math.max(0.01, F(o.r0, 0.5));
    r1[i] = Math.max(r0[i], F(o.r1, 3.5));
    a0[i] = Math.max(0, F(o.alpha, 0.8));
    w0[i] = Math.max(0.02, F(o.width0, 0.45));
    w1[i] = Math.max(0.02, F(o.width1, 0.14));
    f0[i] = Math.max(0, F(o.fill, 0));
    rise[i] = F(o.rise, 0);
    const lf = Math.max(0.08, F(o.life, 0.75));
    life[i] = lf; maxLife[i] = lf;
    iRadius[i] = r0[i];
    iAlpha[i] = a0[i];
    iWidth[i] = w0[i];
    iFill[i] = f0[i];
    return i;
  }

  function update(dt) {
    const d = Math.min(Math.max(F(dt, 0), 0), 0.1);
    if (alive === 0) { geo.instanceCount = 0; return; }
    for (let i = 0; i < alive; i++) {
      life[i] -= d;
      if (life[i] <= 0) { alive--; swap(i, alive); i--; continue; }
      const t = 1 - life[i] / maxLife[i];
      const e = 1 - (1 - t) * (1 - t) * (1 - t);        // ease-out cubic
      iRadius[i] = r0[i] + (r1[i] - r0[i]) * e;
      iWidth[i] = w0[i] + (w1[i] - w0[i]) * e;
      iFill[i] = f0[i] * (1 - t) * (1 - t);
      const fade = t < 0.12 ? t / 0.12 : 1 - (t - 0.12) / 0.88;
      iAlpha[i] = Math.max(0, a0[i] * fade);
      if (rise[i] !== 0) iCenter[i * 3 + 1] += rise[i] * d;
    }
    geo.instanceCount = alive;
    aCenter.needsUpdate = true;
    aColor.needsUpdate = true;
    aRadius.needsUpdate = true;
    aAlpha.needsUpdate = true;
    aWidth.needsUpdate = true;
    aFill.needsUpdate = true;
  }

  return {
    mesh, geometry: geo, material: mat, spawn, update,
    get alive() { return alive; },
    get peak() { return peak; },
    capacity: CAP,
    clear() { alive = 0; geo.instanceCount = 0; },
    dispose() {
      if (scene && scene.remove) scene.remove(mesh);
      geo.dispose(); mat.dispose();
    }
  };
}

export default createRingField;
