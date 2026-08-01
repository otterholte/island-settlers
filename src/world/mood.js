/**
 * Island Settlers — the MOOD of every hex, and the one shader that paints it.
 *
 *   syncMood()                  poll + smooth the per-tile read (idempotent)
 *   MOOD[tileId]                { tone, own, spent, flash, exhausted, ... }
 *   applyMood(material)         inject the tint into any Lambert/standard mat
 *   moodAttrFromList(list)      per-INSTANCE aMood for an InstancedMesh
 *   moodAttrFromPositions(geo)  per-VERTEX aMood for a baked / ground mesh
 *   moodTint(tileId, out)       the same tint as a plain rgb multiplier
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * Twice now the player has said the same thing and twice been fobbed off with
 * a decal:
 *
 *   "It's still way too hard to tell which hexes I can use and which I can't.
 *    Make it much more drastic and clear."
 *
 * A translucent wash over the ground was never going to carry that, because the
 * thing that fills a hex is not the ground — it is four hundred trees, sheep and
 * rocks standing on it. So the separation is applied to the PIXELS THEMSELVES:
 * the terrain, the trees, the flock, the boulders, the wheat. A hex you may work
 * is saturated, warm and lit. A hex you may not is desaturated to near-monochrome
 * and dropped half a stop, cool and inert. There is no reading past it.
 *
 *   tone  +1  yours — collect here
 *   tone   0  neutral (the desert; nobody's crop)
 *   tone  -1  off limits — you own no corner of it, or the Raider has it shut
 *   spent  1  worked out; grey stubble and a countdown overhead
 *   flash  1  the moment it all comes back
 *
 * ---------------------------------------------------------------------------
 * HOW IT REACHES THE GPU
 * ---------------------------------------------------------------------------
 * A 19x1 RGBA byte texture, one texel per hex — updated for the price of 76
 * bytes a frame and shared by every material in the world. Each mesh carries an
 * `aMood` attribute of (tileIndex, influence): per-vertex on the baked ground,
 * per-instance on the four hundred instanced props. A mesh that has no `aMood`
 * gets the constant generic attribute (0, 0) and is simply left alone, which is
 * exactly the right default for boats, roads and buildings.
 *
 * Owner: World agent.
 */

import * as THREE from 'three';
import { tiles } from '../board/layout.js';
import {
  tileFraction, tileRecovery, isTileExhausted, tileItemsRemaining, tileItemCount
} from '../board/nodes.js';
import { playerOwnsTile, canGatherTile } from '../core/rules.js';
import { minFrac, nearestTile } from './terrain.js';

const N = tiles.length;
const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Read-only peek at the running match. Always optional. */
function match() {
  const g = typeof globalThis !== 'undefined' ? globalThis : null;
  return (g && g.__ISLAND__) || null;
}

/* ==================================================================== state */

export const MOOD = tiles.map(t => ({
  id: t.id,
  terrain: t.terrain,
  resource: t.resource || null,
  workable: !!t.resource,
  // Starts at the neutral middle so the opening flyover is not a dead island.
  own: 0.55, ownWant: 0.55,     // 0..1 — do I hold a corner of this hex
  spent: 0, spentWant: 0,       // 0..1 — worked out
  flash: 0,                     // 0..1 — the regrowth beat
  blocked: false,
  exhausted: false, wasExhausted: false,
  fraction: 1, seconds: 0, progress: 1,
  remaining: 0, capacity: 0,
  tone: 0
}));

/** Fired once when a hex refills, so the world can play a beat. */
const restoredHooks = [];
export function onRestored(fn) { restoredHooks.push(fn); }
const spentHooks = [];
export function onSpent(fn) { spentHooks.push(fn); }

/* ------------------------------------------------------------- the texture */

const data = new Uint8Array(N * 4);
export const moodTexture = new THREE.DataTexture(data, N, 1, THREE.RGBAFormat);
moodTexture.magFilter = THREE.NearestFilter;
moodTexture.minFilter = THREE.NearestFilter;
moodTexture.wrapS = THREE.ClampToEdgeWrapping;
moodTexture.wrapT = THREE.ClampToEdgeWrapping;
moodTexture.generateMipmaps = false;
moodTexture.needsUpdate = true;

const uMoodTex = { value: moodTexture };
const uMoodN = { value: N };
const uMoodTime = { value: 0 };

function writeTexture() {
  for (let i = 0; i < N; i++) {
    const m = MOOD[i];
    data[i * 4] = Math.round(clamp01((m.tone + 1) * 0.5) * 255);
    data[i * 4 + 1] = Math.round(clamp01(m.spent) * 255);
    data[i * 4 + 2] = Math.round(clamp01(m.flash) * 255);
    data[i * 4 + 3] = 255;
  }
  moodTexture.needsUpdate = true;
}

/* ==================================================================== poll */

let lastMs = -1;
let clock = 0;

/**
 * Re-sample the match and advance the smoothing. Safe to call from as many
 * places as you like in a frame — it does the work at most every 60ms and
 * measures its own elapsed time, so island.js and props.js can both ask.
 */
export function syncMood() {
  const now = (typeof performance !== 'undefined' && performance.now)
    ? performance.now() : Date.now();
  if (lastMs < 0) { lastMs = now; }
  const dt = Math.min(0.25, (now - lastMs) / 1000);
  if (dt < 0.016) return MOOD;
  lastMs = now;
  clock += dt;
  uMoodTime.value = clock;

  const I = match();
  const state = I && I.state;
  const playing = !!state && state.phase === 'play';
  const time = state ? state.time : 0;

  for (let i = 0; i < N; i++) {
    const m = MOOD[i];
    if (!m.workable) {
      m.tone = 0; m.spent = 0; m.flash = Math.max(0, m.flash - dt * 0.6);
      continue;
    }

    let owns = false, mayWork = false;
    if (state && state.buildings) {
      try {
        owns = playerOwnsTile(state, 0, m.id);
        mayWork = canGatherTile(state, 0, m.id);
      } catch (e) { owns = false; mayWork = false; }
    }
    m.blocked = owns && !mayWork;

    m.fraction = tileFraction(m.id);
    m.remaining = tileItemsRemaining(m.id);
    m.capacity = tileItemCount(m.id);
    m.exhausted = isTileExhausted(m.id);
    const rc = tileRecovery(m.id, time);
    m.seconds = rc.secondsLeft;
    m.progress = rc.progress;

    // Before the draft has finished nobody owns anything; showing fifteen dead
    // hexes during the opening flyover would be a lie about the board.
    m.ownWant = playing ? (mayWork ? 1 : 0) : 0.55;
    m.spentWant = m.exhausted ? 1 : 0;

    if (m.exhausted && !m.wasExhausted) {
      m.wasExhausted = true;
      for (const fn of spentHooks) { try { fn(m); } catch (e) { /* optional */ } }
    } else if (!m.exhausted && m.wasExhausted) {
      m.wasExhausted = false;
      m.flash = 1;
      for (const fn of restoredHooks) { try { fn(m); } catch (e) { /* optional */ } }
    }

    m.own += (m.ownWant - m.own) * Math.min(1, dt * 3.4);
    m.spent += (m.spentWant - m.spent) * Math.min(1, dt * (m.spentWant ? 3.2 : 2.4));
    if (m.flash > 0) m.flash = Math.max(0, m.flash - dt * 0.62);

    // Before play begins every hex sits at the neutral middle; once the match
    // is live the five you own go to +1 and the rest fall away to -1.
    m.tone = playing ? (m.own * 2 - 1) : (m.own - 0.55) * 2;
  }

  writeTexture();
  return MOOD;
}

export function moodOf(tileId) { return MOOD[tileId] || null; }

/* ============================================================== attributes */

/**
 * Per-instance aMood for an InstancedMesh whose instance list carries `.tile`.
 * A tile of -1 (the shoreline collar) gets zero influence and is never tinted.
 */
export function moodAttrFromList(list) {
  const arr = new Float32Array(list.length * 2);
  for (let i = 0; i < list.length; i++) {
    const t = list[i].tile;
    arr[i * 2] = t >= 0 ? t : 0;
    arr[i * 2 + 1] = t >= 0 ? 1 : 0;
  }
  return new THREE.InstancedBufferAttribute(arr, 2);
}

/**
 * Per-vertex aMood sampled straight off world positions. Influence fades out
 * across the tan road strip so the border, the cliffs and the beach keep their
 * own colour — the tint belongs to the hex TOP, which is the part you work.
 */
export function moodAttrFromPositions(geo, fade0 = 0.78, fade1 = 0.96) {
  const pos = geo.attributes.position;
  const n = pos.count;
  const arr = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const t = nearestTile(x, z);
    const f = minFrac(x, z);
    let k = 1 - (f - fade0) / (fade1 - fade0);
    k = k < 0 ? 0 : k > 1 ? 1 : k;
    arr[i * 2] = t ? t.id : 0;
    arr[i * 2 + 1] = k * k * (3 - 2 * k);
  }
  return new THREE.BufferAttribute(arr, 2);
}

/* ================================================================== shader */

const MOOD_PARS_VERT = /* glsl */`
attribute vec2 aMood;
uniform sampler2D uMoodTex;
uniform float uMoodN;
varying vec3 vMood;
`;

const MOOD_BODY_VERT = /* glsl */`
{
  vec4 md = texture2D(uMoodTex, vec2((aMood.x + 0.5) / uMoodN, 0.5));
  vMood = vec3(md.r * 2.0 - 1.0, md.g, md.b) * aMood.y;
}
`;

const MOOD_PARS_FRAG = /* glsl */`
varying vec3 vMood;
uniform float uMoodTime;
`;

/*
 * The whole "mine / not mine" read, in eight lines of arithmetic.
 *
 *  OFF LIMITS  crushed 85% of the way to luminance, tipped cool, and dropped to
 *              48% value. A forest you cannot chop stops being green.
 *  YOURS       pushed the other way: saturation up, a warm bias, and a lift in
 *              the shadows so the hex reads as sunlit rather than merely bright.
 *  SPENT       flat grey. Stubble, spoil and stumps, and nothing worth walking
 *              across until the clock overhead runs out.
 *  FLASH       one bright green beat as the whole hex comes back.
 */
const MOOD_BODY_FRAG = /* glsl */`
{
  float mTone = vMood.x, mSpent = vMood.y, mFlash = vMood.z;
  float mLum = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  if (mTone < -0.003) {
    // Far enough that the hex is plainly inert, but not so far that the board
    // stops being a board: you still have to be able to tell a forest from a
    // mountain when you are deciding where to put your next settlement.
    vec3 dead = mix(diffuseColor.rgb, vec3(mLum) * vec3(0.80, 0.87, 1.16), 0.74) * 0.64;
    diffuseColor.rgb = mix(diffuseColor.rgb, dead, -mTone);
  } else if (mTone > 0.003) {
    vec3 lit = clamp(diffuseColor.rgb * vec3(1.20, 1.12, 0.94)
                     + vec3(0.055, 0.042, 0.014), 0.0, 1.0);
    diffuseColor.rgb = mix(diffuseColor.rgb, lit, mTone);
  }
  if (mSpent > 0.003) {
    // "When it's out of resources it goes totally greyed out." Not darker —
    // GREY: pulled most of the way to a flat neutral so a cleared forest, a
    // cleared pasture and a cleared mountain all read as the same dead stone
    // colour, and the stumps left standing in it still catch a highlight.
    vec3 ash = mix(vec3(mLum * 0.90), vec3(0.345, 0.340, 0.330), 0.58);
    diffuseColor.rgb = mix(diffuseColor.rgb, ash, mSpent * 0.94);
  }
  if (mFlash > 0.003) {
    diffuseColor.rgb = mix(diffuseColor.rgb,
      clamp(diffuseColor.rgb * 1.85 + vec3(0.09, 0.24, 0.05), 0.0, 1.0), mFlash * 0.85);
  }
}
`;

/**
 * Inject the tint into a material. Composes with whatever `onBeforeCompile` the
 * material already had (the wind shaders in props.js), and extends its cache key
 * so the two never share a compiled program.
 */
export function applyMood(mat) {
  if (!mat || mat.userData.__mood) return mat;
  mat.userData.__mood = true;
  const prevCompile = mat.onBeforeCompile;
  const prevKey = mat.customProgramCacheKey;

  mat.onBeforeCompile = (sh, renderer) => {
    if (prevCompile) prevCompile.call(mat, sh, renderer);
    sh.uniforms.uMoodTex = uMoodTex;
    sh.uniforms.uMoodN = uMoodN;
    sh.uniforms.uMoodTime = uMoodTime;
    sh.vertexShader = MOOD_PARS_VERT + sh.vertexShader;
    sh.vertexShader = sh.vertexShader.replace(
      '#include <begin_vertex>', '#include <begin_vertex>\n' + MOOD_BODY_VERT);
    sh.fragmentShader = MOOD_PARS_FRAG + sh.fragmentShader;
    sh.fragmentShader = sh.fragmentShader.replace(
      '#include <color_fragment>', '#include <color_fragment>\n' + MOOD_BODY_FRAG);
  };
  mat.customProgramCacheKey = () =>
    'mood|' + (prevKey ? prevKey.call(mat) : (mat.type || ''));
  return mat;
}

/* ============================================================ cpu-side tint */

/* The same read as the shader, for the handful of things that are driven by an
   instanceColor multiplier instead of a fragment: the number tokens' halo, the
   badge accent, anything that has to agree with the ground it stands on. */
const OFF = [0.44, 0.47, 0.56];
const LIT = [1.10, 1.06, 0.96];
const ASH = [0.56, 0.56, 0.58];

export function moodTint(tileId, out = [1, 1, 1]) {
  const m = MOOD[tileId];
  out[0] = out[1] = out[2] = 1;
  if (!m) return out;
  const t = m.tone;
  if (t < 0) {
    const k = -t;
    for (let i = 0; i < 3; i++) out[i] = 1 + (OFF[i] - 1) * k;
  } else if (t > 0) {
    for (let i = 0; i < 3; i++) out[i] = 1 + (LIT[i] - 1) * t;
  }
  if (m.spent > 0) {
    for (let i = 0; i < 3; i++) out[i] *= 1 + (ASH[i] - 1) * m.spent;
  }
  return out;
}

/** How different two tints are — used to skip pointless attribute uploads. */
export function tintMoved(a, b, eps = 0.006) {
  return Math.abs(a[0] - b[0]) > eps
    || Math.abs(a[1] - b[1]) > eps
    || Math.abs(a[2] - b[2]) > eps;
}

export default MOOD;
