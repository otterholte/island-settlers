/**
 * Island Settlers — pooled world-space floating labels ("+2").
 *
 * Every label in flight is one instance of a single quad, so the whole system
 * is ONE draw call and 2 triangles per live label. Billboarding happens in the
 * vertex shader (the quad is offset in view space), so the CPU never touches a
 * quaternion and nothing is allocated per frame.
 *
 * Glyphs come from the canvas-painted atlas in paint.js: 8x8 cells, painted on
 * demand and cached by (text, resource).
 */

import * as THREE from 'three';

const VERT = /* glsl */`
  attribute vec3 iCenter;
  attribute vec2 iSize;
  attribute vec2 iCell;
  attribute float iAlpha;
  varying vec2 vUv;
  varying float vAlpha;
  void main() {
    vUv = uv * vec2(0.125, 0.125) + iCell;
    vAlpha = iAlpha;
    vec4 mv = modelViewMatrix * vec4(iCenter, 1.0);
    mv.xy += position.xy * iSize;
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */`
  uniform sampler2D uMap;
  uniform float uHasMap;
  varying vec2 vUv;
  varying float vAlpha;
  void main() {
    vec4 tex = uHasMap > 0.5 ? texture2D(uMap, vUv) : vec4(1.0);
    float a = tex.a * vAlpha;
    if (a < 0.01) discard;
    gl_FragColor = vec4(tex.rgb, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const F = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);

export function createLabelField(scene, atlas, capacity) {
  const CAP = Math.max(8, capacity | 0 || 48);

  const iCenter = new Float32Array(CAP * 3);
  const iSize = new Float32Array(CAP * 2);
  const iCell = new Float32Array(CAP * 2);
  const iAlpha = new Float32Array(CAP);

  // simulation-only
  const vel = new Float32Array(CAP * 3);
  const life = new Float32Array(CAP);
  const maxLife = new Float32Array(CAP);
  const baseW = new Float32Array(CAP);
  const baseH = new Float32Array(CAP);

  const geo = new THREE.InstancedBufferGeometry();
  const quad = new Float32Array([
    -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0
  ]);
  const uv = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
  geo.setAttribute('position', new THREE.BufferAttribute(quad, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex([0, 1, 2, 0, 2, 3]);

  const aCenter = new THREE.InstancedBufferAttribute(iCenter, 3);
  const aSize = new THREE.InstancedBufferAttribute(iSize, 2);
  const aCell = new THREE.InstancedBufferAttribute(iCell, 2);
  const aAlpha = new THREE.InstancedBufferAttribute(iAlpha, 1);
  aCenter.setUsage(THREE.DynamicDrawUsage);
  aSize.setUsage(THREE.DynamicDrawUsage);
  aCell.setUsage(THREE.DynamicDrawUsage);
  aAlpha.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('iCenter', aCenter);
  geo.setAttribute('iSize', aSize);
  geo.setAttribute('iCell', aCell);
  geo.setAttribute('iAlpha', aAlpha);
  geo.instanceCount = 0;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 400);

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: atlas ? atlas.texture : null },
      uHasMap: { value: atlas ? 1 : 0 }
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: false,          // gain numbers always read, never buried
    blending: THREE.NormalBlending
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 20;
  mesh.name = 'fx-labels';
  if (scene && scene.add) scene.add(mesh);

  let alive = 0;
  let peak = 0;

  function swap(a, b) {
    if (a === b) return;
    const a3 = a * 3, b3 = b * 3, a2 = a * 2, b2 = b * 2;
    let t;
    for (let k = 0; k < 3; k++) {
      t = iCenter[a3 + k]; iCenter[a3 + k] = iCenter[b3 + k]; iCenter[b3 + k] = t;
      t = vel[a3 + k]; vel[a3 + k] = vel[b3 + k]; vel[b3 + k] = t;
    }
    for (let k = 0; k < 2; k++) {
      t = iSize[a2 + k]; iSize[a2 + k] = iSize[b2 + k]; iSize[b2 + k] = t;
      t = iCell[a2 + k]; iCell[a2 + k] = iCell[b2 + k]; iCell[b2 + k] = t;
    }
    const arrs = [iAlpha, life, maxLife, baseW, baseH];
    for (let i = 0; i < arrs.length; i++) {
      const A = arrs[i];
      t = A[a]; A[a] = A[b]; A[b] = t;
    }
  }

  /**
   * Spawn a label. `cell` is an atlas cell index (0..63); the shader converts
   * it to a UV offset. Oldest label is recycled when the pool is full.
   */
  function spawn(o) {
    let i;
    if (alive >= CAP) {
      // recycle the label with the least life left
      let worst = 0;
      for (let k = 1; k < alive; k++) if (life[k] < life[worst]) worst = k;
      i = worst;
    } else {
      i = alive++;
      if (alive > peak) peak = alive;
    }
    const i3 = i * 3, i2 = i * 2;
    iCenter[i3] = F(o.x, 0);
    iCenter[i3 + 1] = F(o.y, 0);
    iCenter[i3 + 2] = F(o.z, 0);
    vel[i3] = F(o.vx, 0);
    vel[i3 + 1] = F(o.vy, 2.4);
    vel[i3 + 2] = F(o.vz, 0);
    const cell = Math.max(0, Math.min(63, F(o.cell, 0) | 0));
    iCell[i2] = (cell % 8) * 0.125;
    iCell[i2 + 1] = 1 - (((cell / 8) | 0) + 1) * 0.125;   // atlas row 0 on top
    baseW[i] = Math.max(0.05, F(o.w, 4.6));
    baseH[i] = Math.max(0.05, F(o.h, 2.3));
    iSize[i2] = baseW[i] * 0.35;
    iSize[i2 + 1] = baseH[i] * 0.35;
    iAlpha[i] = 0;
    const lf = Math.max(0.15, F(o.life, 1.25));
    life[i] = lf; maxLife[i] = lf;
    return i;
  }

  function update(dt) {
    const d = Math.min(Math.max(F(dt, 0), 0), 0.1);
    if (alive === 0) { geo.instanceCount = 0; return; }
    for (let i = 0; i < alive; i++) {
      life[i] -= d;
      if (life[i] <= 0) { alive--; swap(i, alive); i--; continue; }
      const i3 = i * 3, i2 = i * 2;
      vel[i3 + 1] += 1.1 * d;                    // gentle accelerating rise
      vel[i3] *= 1 - 0.9 * d;
      vel[i3 + 2] *= 1 - 0.9 * d;
      iCenter[i3] += vel[i3] * d;
      iCenter[i3 + 1] += vel[i3 + 1] * d;
      iCenter[i3 + 2] += vel[i3 + 2] * d;

      const age = maxLife[i] - life[i];
      const t = age / maxLife[i];
      // pop in, hold, fade out
      const pop = age < 0.12 ? 0.55 + 0.45 * (age / 0.12) : 1 + 0.06 * Math.sin(t * 9);
      iSize[i2] = baseW[i] * 0.5 * pop;
      iSize[i2 + 1] = baseH[i] * 0.5 * pop;
      let a = 1;
      if (age < 0.08) a = age / 0.08;
      else if (t > 0.62) a = 1 - (t - 0.62) / 0.38;
      iAlpha[i] = a < 0 ? 0 : a > 1 ? 1 : a;
    }
    geo.instanceCount = alive;
    aCenter.needsUpdate = true;
    aSize.needsUpdate = true;
    aCell.needsUpdate = true;
    aAlpha.needsUpdate = true;
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

export default createLabelField;
