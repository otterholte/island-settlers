/**
 * Island Settlers — the PICKUP.
 *
 *   buildPickupFX(group) -> {
 *     update(dt), pop(item, playerId), deny(x, z), drawCalls, triangles, dispose()
 *   }
 *
 * ---------------------------------------------------------------------------
 * WHAT IS NOT HERE ANY MORE
 * ---------------------------------------------------------------------------
 * The target ring and its radial progress sweep are gone, and so is the little
 * floating "WOOD" tab that hovered over whatever you were about to latch onto.
 * They described a mechanic that no longer exists:
 *
 *   "I shouldn't have to wait for the weird circle or to cut things down."
 *
 * Pickup is contact. There is nothing to aim at, nothing to wait for and no
 * progress to report. What replaces them is a hit — fired on the same frame the
 * item leaves the world:
 *
 *   1. FLASH   a bright ring snapping outward off the ground where it stood.
 *   2. BURST   six sparks in the resource's own colour, thrown up and out.
 *   3. THE CHIP a fat resource-coloured token that arcs off the item and flies
 *      into the settler who took it, landing on their carry columns. This is
 *      the bit that says WHICH one you got and WHO got it — a rival sweeping a
 *      hex across the island reads as their chips flying to them, not yours.
 *
 * Every particle in all three lives in ONE InstancedBufferGeometry — 168 quads,
 * one draw call, no shadow pass, positions integrated on the CPU because the
 * chip has to chase a settler who is still running.
 *
 * Owner: World agent.
 */

import * as THREE from 'three';
import { RES_COLOR } from '../core/constants.js';
import { heightAt } from './terrain.js';

const CAP = 168;
const SPARK = 0, CHIP = 1, FLASH = 2, DENY = 3;

function match() {
  const g = typeof globalThis !== 'undefined' ? globalThis : null;
  return (g && g.__ISLAND__) || null;
}

export function buildPickupFX(group) {
  /* ------------------------------------------------------------ geometry */
  const quad = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = quad.index;
  geo.setAttribute('position', quad.attributes.position);
  geo.setAttribute('uv', quad.attributes.uv);
  geo.instanceCount = CAP;

  const aPos = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 3), 3);
  const aCol = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 3), 3);
  // x = size, y = fade 0..1, z = kind, w = spin
  const aData = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 4), 4);
  [aPos, aCol, aData].forEach(a => a.setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('aPos', aPos);
  geo.setAttribute('aCol', aCol);
  geo.setAttribute('aData', aData);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 6, 0), 260);

  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, depthTest: true,
    blending: THREE.AdditiveBlending,
    uniforms: {},
    vertexShader: /* glsl */`
      attribute vec3 aPos;
      attribute vec3 aCol;
      attribute vec4 aData;
      varying vec2 vQ;
      varying vec3 vCol;
      varying vec2 vFK;
      void main() {
        vQ = uv * 2.0 - 1.0;
        vCol = aCol;
        vFK = aData.yz;
        float s = aData.x;
        float c = cos(aData.w), sn = sin(aData.w);
        vec2 p = vec2(position.x * c - position.y * sn, position.x * sn + position.y * c);
        vec4 mv = modelViewMatrix * vec4(aPos, 1.0);
        mv.xy += p * s;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */`
      varying vec2 vQ;
      varying vec3 vCol;
      varying vec2 vFK;
      void main() {
        float fade = vFK.x;
        float kind = vFK.y;
        if (fade < 0.004) discard;
        float d = length(vQ);
        float a = 0.0;
        vec3 col = vCol;

        if (kind < 0.5) {
          // spark — a soft round mote
          a = smoothstep(1.0, 0.15, d);
          a *= a;
          col = mix(vCol, vec3(1.0), 0.35);
        } else if (kind < 1.5) {
          // chip — a chunky rounded token with a bright core and a dark edge
          vec2 q = abs(vQ);
          float box = max(q.x, q.y) * 0.78 + length(q) * 0.22;
          a = smoothstep(1.0, 0.86, box);
          float core = smoothstep(0.80, 0.20, box);
          col = mix(vCol * 0.55, mix(vCol, vec3(1.0), 0.42), core);
        } else if (kind < 2.5) {
          // flash — a hard expanding ring
          a = smoothstep(0.16, 0.0, abs(d - 0.80)) * 0.95;
          a += smoothstep(0.85, 0.0, d) * 0.30;
          col = mix(vCol, vec3(1.0), 0.55);
        } else {
          // deny — a red bar, for a hex that is not yours
          a = smoothstep(0.22, 0.0, abs(d - 0.70));
          col = vec3(0.95, 0.24, 0.16);
        }

        a *= fade;
        if (a < 0.006) discard;
        gl_FragColor = vec4(col * (0.50 + fade * 0.45), min(a, 1.0));
      }
    `
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'pickup-fx';
  mesh.renderOrder = 12;
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  group.add(mesh);

  /* ---------------------------------------------------------- the pool */

  const P = [];
  for (let i = 0; i < CAP; i++) {
    P.push({
      live: false, kind: SPARK, t: 0, life: 1,
      x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
      size: 1, spin: 0, dspin: 0,
      fx: 0, fy: 0, fz: 0,        // chip origin
      target: -1, r: 1, g: 1, b: 1
    });
  }
  let cursor = 0;
  function take() {
    for (let k = 0; k < CAP; k++) {
      const p = P[cursor];
      cursor = (cursor + 1) % CAP;
      if (!p.live) return p;
    }
    const p = P[cursor];
    cursor = (cursor + 1) % CAP;
    return p;   // steal the oldest rather than drop the hit
  }

  const _c = new THREE.Color();
  function colorOf(resource) {
    _c.setHex(RES_COLOR[resource] || 0xffc93c, THREE.SRGBColorSpace);
    return _c;
  }

  /* --------------------------------------------------------------- spawn */

  /**
   * An item just left the world. `player` is who took it, so the chip knows
   * where to fly.
   */
  function pop(item, player = -1) {
    if (!item) return;
    const x = item.x, z = item.z;
    const gy = heightAt(x, z);
    const c = colorOf(item.resource);
    const cr = c.r, cg = c.g, cb = c.b;

    // 1 — the flash on the ground
    {
      const p = take();
      p.live = true; p.kind = FLASH; p.t = 0; p.life = 0.36;
      p.x = x; p.y = gy + 0.9; p.z = z;
      p.vx = p.vy = p.vz = 0;
      p.size = 1.1; p.spin = 0; p.dspin = 0;
      p.target = -1; p.r = cr; p.g = cg; p.b = cb;
    }

    // 2 — the burst
    for (let i = 0; i < 4; i++) {
      const p = take();
      const a = (i / 4) * Math.PI * 2 + Math.random() * 0.7;
      const sp = 2.6 + Math.random() * 3.4;
      p.live = true; p.kind = SPARK; p.t = 0; p.life = 0.44 + Math.random() * 0.22;
      p.x = x + Math.cos(a) * 0.25;
      p.y = gy + 0.75 + Math.random() * 0.8;
      p.z = z + Math.sin(a) * 0.25;
      p.vx = Math.cos(a) * sp; p.vz = Math.sin(a) * sp;
      p.vy = 3.4 + Math.random() * 3.0;
      p.size = 0.22 + Math.random() * 0.20;
      p.spin = 0; p.dspin = 0;
      p.target = -1; p.r = cr; p.g = cg; p.b = cb;
    }

    // 3 — the chip that flies to whoever took it
    {
      const p = take();
      p.live = true; p.kind = CHIP; p.t = 0; p.life = 0.50;
      p.x = p.fx = x; p.y = p.fy = gy + 1.15; p.z = p.fz = z;
      p.size = 0.92; p.spin = 0; p.dspin = 7.5;
      p.target = player;
      p.r = cr; p.g = cg; p.b = cb;
    }
  }

  /** "You get nothing here." Fired when a settler walks a hex they do not own. */
  function deny(x, z) {
    const p = take();
    p.live = true; p.kind = DENY; p.t = 0; p.life = 0.55;
    p.x = x; p.y = heightAt(x, z) + 1.0; p.z = z;
    p.vx = p.vy = p.vz = 0;
    p.size = 2.4; p.spin = 0; p.dspin = 0;
    p.target = -1; p.r = 0.95; p.g = 0.24; p.b = 0.16;
  }

  /* -------------------------------------------------------------- update */

  const pos = aPos.array, col = aCol.array, dat = aData.array;

  function update(dt) {
    const I = match();
    const players = I && I.state && I.state.players;
    let any = false;

    for (let i = 0; i < CAP; i++) {
      const p = P[i];
      if (!p.live) { dat[i * 4 + 1] = 0; continue; }
      any = true;
      p.t += dt;
      const u = p.t / p.life;
      if (u >= 1) {
        p.live = false;
        dat[i * 4 + 1] = 0;
        continue;
      }

      let size = p.size, fade = 1;

      if (p.kind === SPARK) {
        p.vy -= 17 * dt;
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
        p.vx *= 0.94; p.vz *= 0.94;
        fade = 1 - u * u;
        size = p.size * (1 - u * 0.55);
      } else if (p.kind === CHIP) {
        // arc from where the item stood into the settler's carry stack
        let tx = p.fx, ty = p.fy + 3.0, tz = p.fz;
        if (p.target >= 0 && players && players[p.target]) {
          const pl = players[p.target];
          tx = pl.x; tz = pl.z;
          ty = heightAt(pl.x, pl.z) + 3.2;
        }
        const e = u * u * (3 - 2 * u);
        p.x = p.fx + (tx - p.fx) * e;
        p.z = p.fz + (tz - p.fz) * e;
        p.y = p.fy + (ty - p.fy) * e + Math.sin(u * Math.PI) * 2.3;
        p.spin += p.dspin * dt;
        fade = u < 0.12 ? u / 0.12 : (u > 0.80 ? (1 - u) / 0.20 : 1);
        size = p.size * (1.25 - u * 0.45);
      } else if (p.kind === FLASH) {
        size = p.size * (1.0 + u * 4.2);
        fade = (1 - u) * (1 - u) * 0.75;
      } else {
        size = p.size * (1.0 + u * 0.5);
        fade = Math.sin(Math.min(1, u * 1.6) * Math.PI) * 0.9;
      }

      pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z;
      col[i * 3] = p.r; col[i * 3 + 1] = p.g; col[i * 3 + 2] = p.b;
      dat[i * 4] = size;
      dat[i * 4 + 1] = fade;
      dat[i * 4 + 2] = p.kind;
      dat[i * 4 + 3] = p.spin;
    }

    aPos.needsUpdate = true;
    aCol.needsUpdate = true;
    aData.needsUpdate = true;
    mesh.visible = any;
  }

  return {
    group, mesh, update, pop, deny,
    drawCalls: 1,
    triangles: CAP * 2,
    dispose() { geo.dispose(); quad.dispose(); mat.dispose(); }
  };
}

export const buildGatherFX = buildPickupFX;
export default buildPickupFX;
