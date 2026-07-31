/**
 * Island Settlers — sky dome, drifting clouds and the whole lighting rig.
 *
 *   buildSky(scene, renderer) -> { sun, update(t) }
 *
 * Warm key sun from the upper left at ~50 degrees, cool hemisphere fill, a
 * soft cool rim from behind, PCFSoft shadows on a 2048 map with an ortho
 * frustum fitted tight to the island. Fog and scene background are retuned to
 * the dome's horizon colour so the sea dissolves into the sky.
 */

import * as THREE from 'three';
import { cloudTexture } from './paint.js';

export const HORIZON = 0xcfe7ee;
export const HORIZON_WARM = 0xfbe4bd;
export const ZENITH = 0x2a86d4;
export const SUN_COLOR = 0xfff2d0;

/* Direction the light travels FROM (normalised, upper-left, ~50 elevation). */
const SUN_AZ = Math.atan2(0.58, -0.82);
const SUN_EL = 50 * Math.PI / 180;

export const SUN_DIR = new THREE.Vector3(
  Math.cos(SUN_EL) * Math.cos(SUN_AZ),
  Math.sin(SUN_EL),
  Math.cos(SUN_EL) * Math.sin(SUN_AZ)
).normalize();

const DOME_VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const DOME_FRAG = /* glsl */`
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uWarm;
uniform vec3 uSunDir;
uniform vec3 uSunTint;
varying vec3 vDir;

void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  float t = pow(clamp(h, 0.0, 1.0), 0.58);
  vec3 c = mix(uHorizon, uZenith, t);

  // warm haze hugging the horizon line
  float warm = exp(-max(h, 0.0) * 8.5);
  c = mix(c, uWarm, warm * 0.80);

  // a soft second band a little higher up keeps the gradient from banding
  c += uWarm * 0.10 * exp(-max(h - 0.06, 0.0) * 3.0);

  // below the horizon: hold the horizon tone so the sea edge never seams
  c = mix(c, uHorizon * 0.94, 1.0 - smoothstep(-0.30, 0.0, h));

  // sun disc + broad glow
  float s = max(dot(d, uSunDir), 0.0);
  c += uSunTint * pow(s, 220.0) * 1.6;
  c += uSunTint * pow(s, 14.0) * 0.32;
  c += uSunTint * pow(s, 3.0) * 0.09;

  gl_FragColor = vec4(c, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export function buildSky(scene, renderer) {
  const group = new THREE.Group();
  group.name = 'sky';
  scene.add(group);

  /* ------------------------------------------------------------ dome */
  const domeMat = new THREE.ShaderMaterial({
    vertexShader: DOME_VERT,
    fragmentShader: DOME_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uZenith: { value: new THREE.Color(ZENITH) },
      uHorizon: { value: new THREE.Color(HORIZON) },
      uWarm: { value: new THREE.Color(HORIZON_WARM) },
      uSunDir: { value: SUN_DIR.clone() },
      uSunTint: { value: new THREE.Color(SUN_COLOR) }
    }
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(430, 32, 20), domeMat);
  dome.name = 'sky-dome';
  dome.frustumCulled = false;
  dome.renderOrder = -1000;
  group.add(dome);

  /* ---------------------------------------------------------- clouds */
  const cloudTex = cloudTexture();
  const cloudMat = new THREE.MeshBasicMaterial({
    map: cloudTex,
    transparent: true,
    depthWrite: false,
    fog: false,
    opacity: 0.92,
    side: THREE.DoubleSide,
    toneMapped: false
  });
  const CLOUDS = 34;
  const clouds = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), cloudMat, CLOUDS);
  clouds.name = 'sky-clouds';
  clouds.frustumCulled = false;
  clouds.renderOrder = -900;
  clouds.castShadow = false;
  clouds.receiveShadow = false;
  group.add(clouds);

  const puffs = [];
  let seed = 424242;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < CLOUDS; i++) {
    const band = i < 12 ? 0 : (i < 24 ? 1 : 2);
    puffs.push({
      az: rnd() * Math.PI * 2,
      el: [0.055, 0.12, 0.21][band] + rnd() * 0.07,
      rad: [370, 330, 290][band],
      w: (58 + rnd() * 78) * [1.0, 0.85, 0.7][band],
      speed: (0.0026 + rnd() * 0.0034) * (band === 0 ? 0.6 : 1),
      squash: 0.40 + rnd() * 0.20,
      phase: rnd() * 100
    });
  }

  const _m = new THREE.Matrix4();
  const _p = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const _s = new THREE.Vector3();
  const _up = new THREE.Vector3(0, 1, 0);
  const _tgt = new THREE.Vector3(0, 0, 0);
  const _look = new THREE.Matrix4();

  function layoutClouds(t) {
    for (let i = 0; i < CLOUDS; i++) {
      const c = puffs[i];
      const az = c.az + t * c.speed;
      const el = c.el + Math.sin(t * 0.09 + c.phase) * 0.006;
      _p.set(
        Math.cos(az) * Math.cos(el) * c.rad,
        Math.sin(el) * c.rad,
        Math.sin(az) * Math.cos(el) * c.rad
      );
      _tgt.set(0, _p.y * 0.45, 0);
      _look.lookAt(_p, _tgt, _up);
      _q.setFromRotationMatrix(_look);
      _s.set(c.w, c.w * c.squash, 1);
      _m.compose(_p, _q, _s);
      clouds.setMatrixAt(i, _m);
    }
    clouds.instanceMatrix.needsUpdate = true;
  }
  layoutClouds(0);

  /* ----------------------------------------------------------- lights */
  /* r169 lambert/standard BRDFs divide irradiance by PI, so a "sunlit" look
     needs a key around 3. Sunlit ground lands near 1.15x albedo before ACES;
     shadow interiors keep about 0.45x, tinted by the cool hemisphere. */
  const sun = new THREE.DirectionalLight(SUN_COLOR, 2.80);
  sun.name = 'sun';
  sun.position.copy(SUN_DIR).multiplyScalar(150);
  sun.target.position.set(0, 1.8, 0);
  sun.castShadow = true;

  // Ortho frustum fitted tight to the island: 108 x 108 over a 2048 map is
  // 5.3 cm per texel, so a 2-unit-tall settler is ~38 texels wide.
  const S = 54;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -S;
  sun.shadow.camera.right = S;
  sun.shadow.camera.top = S;
  sun.shadow.camera.bottom = -S;
  sun.shadow.camera.near = 60;
  sun.shadow.camera.far = 260;
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.15;
  sun.shadow.camera.updateProjectionMatrix();
  scene.add(sun);
  scene.add(sun.target);

  // Cool sky / warm-earth fill.
  const hemi = new THREE.HemisphereLight(0xbfe4ff, 0x6b8f4a, 1.15);
  hemi.position.set(0, 60, 0);
  scene.add(hemi);

  // Cool rim from behind-right so silhouettes separate from the sea.
  const rim = new THREE.DirectionalLight(0xa9d4ff, 0.68);
  rim.position.set(72, 34, -96);
  rim.castShadow = false;
  scene.add(rim);

  // A whisper of bounce so shadow interiors keep their hue.
  const amb = new THREE.AmbientLight(0xdcefff, 0.24);
  scene.add(amb);

  /* -------------------------------------------------- background + fog */
  const horizon = new THREE.Color(HORIZON).lerp(new THREE.Color(HORIZON_WARM), 0.28);
  scene.background = horizon.clone();
  scene.fog = new THREE.Fog(horizon.clone(), 135, 385);

  if (renderer) {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  }

  return {
    sun,
    rim,
    hemi,
    group,
    dome,
    clouds,
    sunDir: SUN_DIR.clone(),
    horizon: horizon.clone(),
    update(t) {
      layoutClouds(t);
    },
    dispose() {
      dome.geometry.dispose(); domeMat.dispose();
      clouds.geometry.dispose(); cloudMat.dispose(); cloudTex.dispose();
    }
  };
}

export default buildSky;
