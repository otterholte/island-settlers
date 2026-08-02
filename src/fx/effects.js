/**
 * Island Settlers — effects facade.
 *
 *   createEffects(scene) -> { burst, floatText, ring, shockwave, update, haptic }
 *
 * Everything is pooled and preallocated at construction. The whole system is
 * FIVE draw calls at most:
 *
 *   1. matter particles  (THREE.Points, normal blending)
 *   2. spark particles   (THREE.Points, additive)
 *   3. floating labels   (instanced quads, one atlas)
 *   4. ground rings      (instanced quads)
 *   5. vignette          (fullscreen quad, only while a shockwave is pulsing)
 *
 * Triangle cost is trivial (2 per live label / ring, points have none), so the
 * FX budget stays well under a rounding error of the 101k-triangle island.
 *
 * Everything sits on `heightAt(x, z)` from terrain.js — the ground is not at
 * y = 0. The import is guarded so a terrain failure degrades to a flat plane
 * instead of taking the effects system down.
 */

import * as THREE from 'three';
import { RES_COLOR, HEX_SIZE } from '../core/constants.js';
import { tiles } from '../board/layout.js';
import * as TERRAIN from '../world/terrain.js';
import { buildParticleAtlas, createLabelAtlas, CELL } from './paint.js';
import { createParticleField } from './particles.js';
import { createLabelField } from './labels.js';
import { createRingField } from './rings.js';
import { haptic, PATTERNS } from './haptics.js';

const G = typeof globalThis !== 'undefined' ? globalThis : {};
const F = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
const rnd = (a, b) => a + Math.random() * (b - a);

const FALLBACK_Y = 2.2;   // mid-range tile top, used only if terrain is gone

/* ---------------------------------------------------------- burst recipes */
/* Per resource: which atlas shape, which colours, how it flies. Colours are
   chosen to read as the material itself (wood chips are pale timber, not the
   green UI swatch) with the UI colour mixed in as an accent. */

const RECIPES = {
  wood: {
    cell: CELL.CHIP, count: 16, spark: 0,
    colors: [0xc79a5b, 0xa87840, 0xe0be86, 0x4c8b3a],
    weights: [0.4, 0.3, 0.2, 0.1],
    speed: [3.2, 7.0], up: [3.4, 7.4], gravity: 26, size: [0.34, 0.62],
    life: [0.55, 0.95], spin: 9, bounce: 0.3
  },
  brick: {
    cell: CELL.CHIP, count: 14, spark: 0,
    colors: [0xc0562f, 0x8f4425, 0xdc9257, 0x6d3a22],
    weights: [0.4, 0.28, 0.2, 0.12],
    speed: [2.6, 6.0], up: [3.0, 6.6], gravity: 30, size: [0.36, 0.7],
    life: [0.5, 0.9], spin: 7, bounce: 0.22
  },
  wool: {
    cell: CELL.TUFT, count: 15, spark: 0,
    colors: [0xe8e4d8, 0xf6f2e8, 0xd6d0c0],
    weights: [0.5, 0.3, 0.2],
    speed: [1.6, 3.6], up: [2.2, 4.4], gravity: 8.5, size: [0.55, 1.0],
    life: [0.9, 1.5], spin: 2.2, bounce: 0, drag: 0.5
  },
  wheat: {
    cell: CELL.SLIVER, count: 18, spark: 0,
    colors: [0xe8b53c, 0xf5dc86, 0xc79a3a, 0xb0862c],
    weights: [0.36, 0.28, 0.22, 0.14],
    speed: [2.4, 5.4], up: [3.0, 6.2], gravity: 15, size: [0.4, 0.78],
    life: [0.7, 1.2], spin: 12, bounce: 0, drag: 0.32
  },
  ore: {
    cell: CELL.CHIP, count: 12, spark: 10,
    colors: [0x8d97a6, 0x6b7480, 0xb0b7c1, 0x555c66],
    weights: [0.35, 0.3, 0.2, 0.15],
    speed: [2.8, 6.4], up: [3.2, 7.0], gravity: 32, size: [0.3, 0.58],
    life: [0.5, 0.9], spin: 8, bounce: 0.35,
    sparkColors: [0xfff0b0, 0xffc93c, 0xff9a3c]
  }
};
const DEFAULT_KIND = 'wood';

/* Ash + ember palette for the Knight shockwave. */
const ASH = [0x3a332c, 0x554c42, 0x241f1a, 0x6b6055];
const EMBER = [0xff7a2c, 0xffb347, 0xff4d1a];

function pickWeighted(colors, weights) {
  if (!weights) return colors[(Math.random() * colors.length) | 0];
  let r = Math.random(), i = 0;
  for (; i < weights.length - 1; i++) { r -= weights[i]; if (r <= 0) break; }
  return colors[Math.min(i, colors.length - 1)];
}

export function createEffects(scene, opts) {
  const options = opts || {};

  /* ---------------------------------------------------------- ground sampler */
  let sampler = null;
  if (typeof options.heightAt === 'function') sampler = options.heightAt;
  else if (TERRAIN && typeof TERRAIN.heightAt === 'function') sampler = TERRAIN.heightAt;

  function groundY(x, z) {
    if (!sampler) return FALLBACK_Y;
    let y;
    try { y = sampler(x, z); } catch (e) { sampler = null; return FALLBACK_Y; }
    return (typeof y === 'number' && isFinite(y)) ? y : FALLBACK_Y;
  }

  /* -------------------------------------------------------------- resources */
  let atlas = null, labelAtlas = null;
  try { atlas = buildParticleAtlas(); } catch (e) { atlas = null; }
  try { labelAtlas = createLabelAtlas(); } catch (e) { labelAtlas = null; }

  const matter = createParticleField(scene, {
    capacity: options.matterCapacity || 900, atlas, name: 'fx-matter'
  });
  const sparks = createParticleField(scene, {
    capacity: options.sparkCapacity || 380, atlas, additive: true, name: 'fx-sparks'
  });
  const labels = createLabelField(scene, labelAtlas, options.labelCapacity || 48);
  const rings = createRingField(scene, options.ringCapacity || 24);

  /* Pre-resolved linear colours — no THREE.Color churn while playing. */
  const colorCache = new Map();
  const scratch = new THREE.Color();
  function rgb(hex) {
    let c = colorCache.get(hex);
    if (!c) {
      scratch.setHex(hex, THREE.SRGBColorSpace);
      c = { r: scratch.r, g: scratch.g, b: scratch.b };
      colorCache.set(hex, c);
    }
    return c;
  }
  // warm the cache so the first burst allocates nothing
  for (const k in RECIPES) {
    RECIPES[k].colors.forEach(rgb);
    if (RECIPES[k].sparkColors) RECIPES[k].sparkColors.forEach(rgb);
  }
  ASH.forEach(rgb); EMBER.forEach(rgb);
  for (const k in RES_COLOR) rgb(RES_COLOR[k]);
  rgb(0xffc93c); rgb(0x1a1410); rgb(0x7a2c12); rgb(0xf6e7c6);

  /* --------------------------------------------------------------- vignette */
  const vig = (() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      -1, -1, 0, 3, -1, 0, -1, 3, 0
    ]), 3));
    const m = new THREE.ShaderMaterial({
      uniforms: {
        uAmount: { value: 0 },
        uColor: { value: new THREE.Color(0x120a06) }
      },
      vertexShader: /* glsl */`
        varying vec2 vNdc;
        void main() {
          vNdc = position.xy;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        uniform float uAmount;
        uniform vec3 uColor;
        varying vec2 vNdc;
        void main() {
          float d = length(vNdc * vec2(0.78, 1.0));
          float a = smoothstep(0.35, 1.25, d) * uAmount;
          if (a < 0.004) discard;
          gl_FragColor = vec4(uColor, a);
        }
      `,
      transparent: true,
      depthTest: false,
      depthWrite: false
    });
    const mesh = new THREE.Mesh(g, m);
    mesh.frustumCulled = false;
    mesh.renderOrder = 30;
    mesh.visible = false;
    mesh.name = 'fx-vignette';
    if (scene && scene.add) scene.add(mesh);
    return { mesh, mat: m, level: 0, decay: 1 };
  })();

  /* ------------------------------------------------------- listener helper */
  /** Is this world point close to the human settler? Gates haptics. */
  function nearPlayer(x, z, radius) {
    const I = G.__ISLAND__ || (G.window && G.window.__ISLAND__) || null;
    const p = I && I.state && I.state.players && I.state.players[0];
    if (!p || !isFinite(p.x) || !isFinite(p.z)) return false;
    const dx = p.x - x, dz = p.z - z;
    return dx * dx + dz * dz < radius * radius;
  }

  /* ------------------------------------------------------------------ burst */

  function burst(x, z, kind) {
    const px = F(x, 0), pz = F(z, 0);
    const rec = RECIPES[kind] || RECIPES[DEFAULT_KIND];
    const gy = groundY(px, pz);
    const base = gy + 0.75;

    // thin out when the pool is under pressure rather than dropping the burst
    const headroom = matter.capacity - matter.alive;
    const n = Math.max(4, Math.min(rec.count, headroom - 2));
    for (let i = 0; i < n; i++) {
      const a = rnd(0, Math.PI * 2);
      const sp = rnd(rec.speed[0], rec.speed[1]);
      const c = rgb(pickWeighted(rec.colors, rec.weights));
      const s = rnd(rec.size[0], rec.size[1]);
      matter.spawn({
        x: px + Math.cos(a) * rnd(0, 0.45),
        y: base + rnd(-0.2, 0.5),
        z: pz + Math.sin(a) * rnd(0, 0.45),
        vx: Math.cos(a) * sp,
        vy: rnd(rec.up[0], rec.up[1]),
        vz: Math.sin(a) * sp,
        r: c.r, g: c.g, b: c.b,
        cell: rec.cell,
        size0: s, size1: s * rnd(0.55, 0.9),
        life: rnd(rec.life[0], rec.life[1]),
        gravity: rec.gravity,
        drag: rec.drag === undefined ? 0.14 : rec.drag,
        rot: rnd(0, Math.PI * 2),
        spin: rnd(-rec.spin, rec.spin),
        groundY: gy + 0.06,
        bounce: rec.bounce || 0
      });
    }

    if (rec.spark) {
      const cols = rec.sparkColors || EMBER;
      const sn = Math.min(rec.spark, sparks.capacity - sparks.alive);
      for (let i = 0; i < sn; i++) {
        const a = rnd(0, Math.PI * 2);
        const sp = rnd(3.5, 9);
        const c = rgb(cols[(Math.random() * cols.length) | 0]);
        sparks.spawn({
          x: px, y: base + rnd(0, 0.3), z: pz,
          vx: Math.cos(a) * sp, vy: rnd(4, 9.5), vz: Math.sin(a) * sp,
          r: c.r, g: c.g, b: c.b,
          cell: CELL.SPARK,
          size0: rnd(0.22, 0.4), size1: 0.02,
          life: rnd(0.28, 0.55),
          gravity: 30, drag: 0.2,
          groundY: gy + 0.04
        });
      }
    }

    // a puff of dust where the tool met the ground
    const dust = rgb(0xd9bd86);
    for (let i = 0; i < 4; i++) {
      const a = rnd(0, Math.PI * 2);
      matter.spawn({
        x: px + Math.cos(a) * 0.3, y: gy + 0.2, z: pz + Math.sin(a) * 0.3,
        vx: Math.cos(a) * rnd(0.8, 2.2), vy: rnd(0.6, 1.8), vz: Math.sin(a) * rnd(0.8, 2.2),
        r: dust.r, g: dust.g, b: dust.b,
        cell: CELL.TUFT,
        size0: rnd(0.5, 0.9), size1: rnd(1.1, 1.8),
        life: rnd(0.35, 0.6), gravity: 1.5, drag: 0.8,
        alpha: 0.5, groundY: -1e9
      });
    }

    if (nearPlayer(px, pz, 7)) haptic(PATTERNS.gather);
  }

  /* -------------------------------------------------------------- floatText */

  function floatText(x, z, text, kind) {
    const px = F(x, 0), pz = F(z, 0);
    const label = text === undefined || text === null ? '+1' : String(text);
    const k = RES_COLOR[kind] !== undefined ? kind : DEFAULT_KIND;
    const cell = labelAtlas ? labelAtlas.cell(label, k) : 0;
    const gy = groundY(px, pz);
    labels.spawn({
      x: px + rnd(-0.4, 0.4),
      y: gy + 2.3,
      z: pz + rnd(-0.4, 0.4),
      vx: rnd(-0.5, 0.5), vy: rnd(2.3, 3.0), vz: rnd(-0.5, 0.5),
      cell,
      w: 4.4, h: 2.2,
      life: rnd(1.15, 1.4)
    });
    // a couple of glints riding up with the number
    const c = rgb(RES_COLOR[k]);
    for (let i = 0; i < 3; i++) {
      sparks.spawn({
        x: px + rnd(-0.6, 0.6), y: gy + rnd(1.2, 2.0), z: pz + rnd(-0.6, 0.6),
        vx: rnd(-0.6, 0.6), vy: rnd(1.6, 2.8), vz: rnd(-0.6, 0.6),
        r: c.r, g: c.g, b: c.b,
        cell: CELL.SPARK,
        size0: rnd(0.16, 0.3), size1: 0.02,
        life: rnd(0.4, 0.7), gravity: -1.2, drag: 0.5, groundY: -1e9
      });
    }
  }

  /* ------------------------------------------------------------------- ring */

  function ring(x, z, kind) {
    const px = F(x, 0), pz = F(z, 0);
    const hex = RES_COLOR[kind] !== undefined ? RES_COLOR[kind] : 0xffc93c;
    const c = rgb(hex);
    const gy = groundY(px, pz);
    rings.spawn({
      x: px, y: gy + 0.07, z: pz,
      r: c.r, g: c.g, b: c.b,
      r0: 0.7, r1: 3.4,
      width0: 0.55, width1: 0.16,
      alpha: 0.8, fill: 0.16,
      life: 0.72
    });
  }

  /* -------------------------------------------------------------- shockwave */

  function shockwave(tileId) {
    let tx = 0, tz = 0;
    if (tileId && typeof tileId === 'object') {
      tx = F(tileId.x, 0); tz = F(tileId.z, 0);
    } else {
      const t = tiles[F(tileId, -1) | 0];
      if (t) { tx = t.x; tz = t.z; }
    }
    const gy = groundY(tx, tz);
    const dark = rgb(0x1a1410);
    const fire = rgb(0x7a2c12);

    // the wave itself: a dark ring over the whole hex, then an ember echo
    rings.spawn({
      x: tx, y: gy + 0.09, z: tz,
      r: dark.r, g: dark.g, b: dark.b,
      r0: 1.2, r1: HEX_SIZE * 1.12,
      width0: 0.6, width1: 0.13,
      alpha: 0.92, fill: 0.55,
      life: 1.15
    });
    rings.spawn({
      x: tx, y: gy + 0.12, z: tz,
      r: fire.r, g: fire.g, b: fire.b,
      r0: 0.6, r1: HEX_SIZE * 0.9,
      width0: 0.45, width1: 0.1,
      alpha: 0.7, fill: 0.1,
      life: 0.85
    });

    // ash lifted off the ground across the whole tile
    const n = Math.min(70, matter.capacity - matter.alive);
    for (let i = 0; i < n; i++) {
      const a = rnd(0, Math.PI * 2);
      const rr = Math.sqrt(Math.random()) * HEX_SIZE * 0.95;
      const ax = tx + Math.cos(a) * rr;
      const az = tz + Math.sin(a) * rr;
      const c = rgb(ASH[(Math.random() * ASH.length) | 0]);
      const out = rnd(0.6, 2.6);
      matter.spawn({
        x: ax, y: groundY(ax, az) + rnd(0.1, 1.0), z: az,
        vx: Math.cos(a) * out, vy: rnd(1.6, 5.2), vz: Math.sin(a) * out,
        r: c.r, g: c.g, b: c.b,
        cell: CELL.TUFT,
        size0: rnd(0.6, 1.5), size1: rnd(1.6, 3.0),
        life: rnd(1.2, 2.4),
        gravity: rnd(-0.4, 1.6), drag: 0.55,
        alpha: 0.85, rot: rnd(0, 6.28), spin: rnd(-1.2, 1.2),
        fadeIn: 0.1, groundY: -1e9
      });
    }

    // embers riding the wave outward
    const en = Math.min(40, sparks.capacity - sparks.alive);
    for (let i = 0; i < en; i++) {
      const a = rnd(0, Math.PI * 2);
      const rr = Math.sqrt(Math.random()) * HEX_SIZE * 0.7;
      const ex = tx + Math.cos(a) * rr;
      const ez = tz + Math.sin(a) * rr;
      const c = rgb(EMBER[(Math.random() * EMBER.length) | 0]);
      sparks.spawn({
        x: ex, y: groundY(ex, ez) + rnd(0.2, 1.2), z: ez,
        vx: Math.cos(a) * rnd(1.5, 5), vy: rnd(2.5, 7), vz: Math.sin(a) * rnd(1.5, 5),
        r: c.r, g: c.g, b: c.b,
        cell: CELL.SPARK,
        size0: rnd(0.2, 0.45), size1: 0.03,
        life: rnd(0.5, 1.1),
        gravity: 6, drag: 0.35, groundY: -1e9
      });
    }

    // screen-space pulse
    vig.level = 0.85;
    vig.decay = 1.25;
    vig.mesh.visible = true;
    haptic(PATTERNS.heavy);
  }

  /* ----------------------------------------------------------------- update */

  function update(dt) {
    const d = Math.min(Math.max(F(dt, 0), 0), 0.1);
    matter.update(d);
    sparks.update(d);
    labels.update(d);
    rings.update(d);
    if (vig.level > 0) {
      vig.level -= vig.decay * d;
      if (vig.level <= 0) {
        vig.level = 0;
        vig.mesh.visible = false;
      }
      vig.mat.uniforms.uAmount.value = Math.max(0, vig.level * vig.level);
    }
  }

  /* -------------------------------------------------------------------- api */
  return {
    burst, floatText, ring, shockwave, update, haptic,
    /** Live/peak pool occupancy — used by the verification harness. */
    stats() {
      return {
        matter: matter.alive, matterPeak: matter.peak, matterCap: matter.capacity,
        sparks: sparks.alive, sparkPeak: sparks.peak, sparkCap: sparks.capacity,
        labels: labels.alive, labelPeak: labels.peak, labelCap: labels.capacity,
        rings: rings.alive, ringPeak: rings.peak, ringCap: rings.capacity,
        drawCalls: 4 + (vig.mesh.visible ? 1 : 0),
        triangles: labels.alive * 2 + rings.alive * 2 + (vig.mesh.visible ? 1 : 0)
      };
    },
    clear() {
      matter.clear(); sparks.clear(); labels.clear(); rings.clear();
      vig.level = 0; vig.mesh.visible = false;
    },
    dispose() {
      matter.dispose(); sparks.dispose(); labels.dispose(); rings.dispose();
      if (scene && scene.remove) scene.remove(vig.mesh);
      vig.mesh.geometry.dispose(); vig.mat.dispose();
      if (atlas) atlas.dispose();
      if (labelAtlas && labelAtlas.texture) labelAtlas.texture.dispose();
    }
  };
}

export default createEffects;
