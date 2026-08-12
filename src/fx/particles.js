/**
 * Island Settlers — pooled GPU particle field.
 *
 * One THREE.Points object == one draw call for every particle in the field,
 * however many are alive. All storage is preallocated at construction: the
 * hot path allocates nothing, and dead particles are swap-removed so the live
 * set stays contiguous and `setDrawRange` submits only what is on screen.
 *
 * Per-particle attributes (position, colour, size, alpha, atlas cell,
 * rotation) are the simulation arrays themselves, so integration writes
 * straight into the buffers that get uploaded.
 */

import * as THREE from 'three';

const G = typeof globalThis !== 'undefined' ? globalThis : {};

const VERT = /* glsl */`
  attribute vec3 pcolor;
  attribute float psize;
  attribute float palpha;
  attribute float pcell;
  attribute float prot;
  uniform float uScale;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vCell;
  varying float vRot;
  void main() {
    vColor = pcolor;
    vAlpha = palpha;
    vCell = pcell;
    vRot = prot;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float d = max(-mv.z, 0.1);
    gl_PointSize = clamp(psize * uScale / d, 1.0, 220.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */`
  uniform sampler2D uMap;
  uniform float uHasMap;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vCell;
  varying float vRot;
  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float c = cos(vRot), s = sin(vRot);
    uv = vec2(uv.x * c - uv.y * s, uv.x * s + uv.y * c) + 0.5;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;
    float a = vAlpha;
    vec3 rgb = vColor;
    if (uHasMap > 0.5) {
      // atlas row 0 is the TOP of the canvas, and CanvasTexture flips Y
      vec2 cell = vec2(mod(vCell, 2.0), 1.0 - floor(vCell * 0.5));
      vec4 tex = texture2D(uMap, uv * 0.5 + cell * 0.5);
      a *= tex.a;
      rgb *= mix(vec3(1.0), tex.rgb, 0.85);
    } else {
      a *= smoothstep(0.5, 0.18, length(uv - 0.5));
    }
    if (a < 0.012) discard;
    gl_FragColor = vec4(rgb, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const _bufSize = new THREE.Vector2();

/**
 * Physical-pixel scale factor for gl_PointSize, refreshed occasionally.
 *
 * ASK THE RENDERER HOW BIG THE FRAMEBUFFER IS. DO NOT GUESS FROM devicePixelRatio.
 *
 * `gl_PointSize` is in framebuffer pixels, so the correct scale is
 * `drawingBufferHeight / (2 * tan(fov/2))`. This used to compute the height as
 * `innerHeight * min(devicePixelRatio, 2)` — but the quality ladder pins the
 * pixel ratio to 1 on every phone, so the real buffer is `innerHeight * 1`
 * while this said `* 2`. Every point sprite came out twice as wide as
 * authored: four times the fragments, all of them alpha-blended and texture
 * sampled, on the most fill-rate-limited hardware the game runs on.
 *
 * That is not an edge case — `effects.burst()` fires a dozen-plus particles on
 * every single pickup, and picking things up is the game. It was wrong on
 * desktop too whenever the ratio budget clamped below the device's own.
 */
function viewScale() {
  let hPx = 0;
  let fov = 48;
  const I = G.__ISLAND__;
  if (I && I.camera && isFinite(I.camera.fov)) fov = I.camera.fov;
  if (I && I.renderer && I.renderer.getDrawingBufferSize) {
    // The truth, whatever the quality ladder has done to the pixel ratio.
    hPx = I.renderer.getDrawingBufferSize(_bufSize).y || 0;
  }
  if (!hPx) {
    // Before boot finishes there is no renderer to ask. viewScale() is re-read
    // twice a second, so this stands in for at most a frame or two.
    const h = (G.innerHeight && isFinite(G.innerHeight)) ? G.innerHeight : 800;
    const dpr = Math.min((G.devicePixelRatio && isFinite(G.devicePixelRatio))
      ? G.devicePixelRatio : 1, 2);
    hPx = h * dpr;
  }
  const t = Math.tan((fov * Math.PI) / 360) || 0.44;
  return hPx / (2 * t);
}

export function createParticleField(scene, opts) {
  const o = opts || {};
  const CAP = Math.max(16, o.capacity | 0 || 512);
  const additive = !!o.additive;

  const position = new Float32Array(CAP * 3);
  const pcolor = new Float32Array(CAP * 3);
  const psize = new Float32Array(CAP);
  const palpha = new Float32Array(CAP);
  const pcell = new Float32Array(CAP);
  const prot = new Float32Array(CAP);

  // simulation-only state
  const vel = new Float32Array(CAP * 3);
  const life = new Float32Array(CAP);
  const maxLife = new Float32Array(CAP);
  const size0 = new Float32Array(CAP);
  const size1 = new Float32Array(CAP);
  const spin = new Float32Array(CAP);
  const grav = new Float32Array(CAP);
  const drag = new Float32Array(CAP);
  const groundY = new Float32Array(CAP);
  const bounce = new Float32Array(CAP);
  const fadeIn = new Float32Array(CAP);

  const geo = new THREE.BufferGeometry();
  const aPos = new THREE.BufferAttribute(position, 3);
  const aCol = new THREE.BufferAttribute(pcolor, 3);
  const aSize = new THREE.BufferAttribute(psize, 1);
  const aAlpha = new THREE.BufferAttribute(palpha, 1);
  const aCell = new THREE.BufferAttribute(pcell, 1);
  const aRot = new THREE.BufferAttribute(prot, 1);
  aPos.setUsage(THREE.DynamicDrawUsage);
  aCol.setUsage(THREE.DynamicDrawUsage);
  aSize.setUsage(THREE.DynamicDrawUsage);
  aAlpha.setUsage(THREE.DynamicDrawUsage);
  aCell.setUsage(THREE.DynamicDrawUsage);
  aRot.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', aPos);
  geo.setAttribute('pcolor', aCol);
  geo.setAttribute('psize', aSize);
  geo.setAttribute('palpha', aAlpha);
  geo.setAttribute('pcell', aCell);
  geo.setAttribute('prot', aRot);
  geo.setDrawRange(0, 0);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 400);

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: o.atlas || null },
      uHasMap: { value: o.atlas ? 1 : 0 },
      uScale: { value: viewScale() }
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending
  });

  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = additive ? 12 : 10;
  points.name = o.name || (additive ? 'fx-sparks' : 'fx-matter');
  if (scene && scene.add) scene.add(points);

  let alive = 0;
  let peak = 0;
  let scaleTimer = 0;

  function swap(a, b) {
    if (a === b) return;
    const a3 = a * 3, b3 = b * 3;
    for (let k = 0; k < 3; k++) {
      let t = position[a3 + k]; position[a3 + k] = position[b3 + k]; position[b3 + k] = t;
      t = pcolor[a3 + k]; pcolor[a3 + k] = pcolor[b3 + k]; pcolor[b3 + k] = t;
      t = vel[a3 + k]; vel[a3 + k] = vel[b3 + k]; vel[b3 + k] = t;
    }
    const arrs = [psize, palpha, pcell, prot, life, maxLife,
                  size0, size1, spin, grav, drag, groundY, bounce, fadeIn];
    for (let i = 0; i < arrs.length; i++) {
      const A = arrs[i];
      const t = A[a]; A[a] = A[b]; A[b] = t;
    }
  }

  const F = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);

  /** Emit one particle. Silently drops when the pool is saturated. */
  function spawn(p) {
    if (alive >= CAP) return false;
    const i = alive++;
    if (alive > peak) peak = alive;
    const i3 = i * 3;
    position[i3] = F(p.x, 0);
    position[i3 + 1] = F(p.y, 0);
    position[i3 + 2] = F(p.z, 0);
    vel[i3] = F(p.vx, 0);
    vel[i3 + 1] = F(p.vy, 0);
    vel[i3 + 2] = F(p.vz, 0);
    pcolor[i3] = F(p.r, 1);
    pcolor[i3 + 1] = F(p.g, 1);
    pcolor[i3 + 2] = F(p.b, 1);
    const lf = Math.max(0.05, F(p.life, 0.8));
    life[i] = lf; maxLife[i] = lf;
    size0[i] = Math.max(0.001, F(p.size0, 1));
    size1[i] = Math.max(0.0, F(p.size1, size0[i] * 0.6));
    psize[i] = size0[i];
    palpha[i] = F(p.alpha, 1);
    pcell[i] = Math.min(3, Math.max(0, F(p.cell, 0) | 0));
    prot[i] = F(p.rot, 0);
    spin[i] = F(p.spin, 0);
    grav[i] = F(p.gravity, 26);
    drag[i] = Math.min(0.999, Math.max(0, F(p.drag, 0.12)));
    groundY[i] = F(p.groundY, -1e9);
    bounce[i] = Math.max(0, Math.min(0.9, F(p.bounce, 0)));
    fadeIn[i] = Math.max(0, F(p.fadeIn, 0));
    return true;
  }

  function update(dt) {
    const d = Math.min(Math.max(F(dt, 0), 0), 0.1);
    scaleTimer -= d;
    if (scaleTimer <= 0) { mat.uniforms.uScale.value = viewScale(); scaleTimer = 0.5; }
    if (alive === 0) {
      geo.setDrawRange(0, 0);
      return;
    }
    for (let i = 0; i < alive; i++) {
      life[i] -= d;
      if (life[i] <= 0) {
        alive--;
        swap(i, alive);
        i--;
        continue;
      }
      const i3 = i * 3;
      const damp = 1 - drag[i] * d * 6;
      const k = damp < 0 ? 0 : damp;
      vel[i3] *= k;
      vel[i3 + 2] *= k;
      vel[i3 + 1] = vel[i3 + 1] * k - grav[i] * d;
      position[i3] += vel[i3] * d;
      position[i3 + 1] += vel[i3 + 1] * d;
      position[i3 + 2] += vel[i3 + 2] * d;

      const gy = groundY[i];
      if (position[i3 + 1] < gy) {
        position[i3 + 1] = gy;
        if (bounce[i] > 0 && vel[i3 + 1] < -0.5) {
          vel[i3 + 1] = -vel[i3 + 1] * bounce[i];
          vel[i3] *= 0.55; vel[i3 + 2] *= 0.55;
          spin[i] *= 0.5;
          bounce[i] *= 0.55;
        } else {
          vel[i3] *= 0.7; vel[i3 + 1] = 0; vel[i3 + 2] *= 0.7;
          if (life[i] > 0.35) life[i] = 0.35;
        }
      }

      prot[i] += spin[i] * d;
      const t = 1 - life[i] / maxLife[i];              // 0 -> 1 over lifetime
      psize[i] = size0[i] + (size1[i] - size0[i]) * t;
      let a = life[i] / maxLife[i];
      a = a > 0.6 ? 1 : a / 0.6;                       // hold, then fade out
      if (fadeIn[i] > 0) {
        const age = maxLife[i] - life[i];
        if (age < fadeIn[i]) a *= age / fadeIn[i];
      }
      palpha[i] = a;
    }

    geo.setDrawRange(0, alive);
    aPos.needsUpdate = true;
    aCol.needsUpdate = true;
    aSize.needsUpdate = true;
    aAlpha.needsUpdate = true;
    aCell.needsUpdate = true;
    aRot.needsUpdate = true;
  }

  return {
    points, geometry: geo, material: mat, spawn, update,
    get alive() { return alive; },
    get peak() { return peak; },
    capacity: CAP,
    clear() { alive = 0; geo.setDrawRange(0, 0); },
    dispose() {
      if (scene && scene.remove) scene.remove(points);
      geo.dispose(); mat.dispose();
    }
  };
}

export default createParticleField;
