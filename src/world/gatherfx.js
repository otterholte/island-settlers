/**
 * Island Settlers — "you can pick that up" affordances.
 *
 *   buildGatherFX(group) -> { update(dt), drawCalls, triangles, dispose() }
 *
 * Three jobs, three draw calls, no shadows, no per-frame allocation:
 *
 *   1. IDLE GLINT — every live gather node wears a soft ground ring in its own
 *      resource colour, breathing slowly. Pure scenery has none, so the eye can
 *      separate "harvestable" from "dressing" without a tutorial. The ring dims
 *      and shrinks to a scar when the node is worked out and swells back as it
 *      regrows, and turns a dead charcoal-red on a region the Raider blocks.
 *      One InstancedMesh, 126 instances, 252 triangles.
 *
 *   2. TARGET RING — the node the human is about to latch onto (or is actively
 *      working) gets a fat animated ring with a radial progress sweep that
 *      fills over GATHER_TIME. One shader-driven disc.
 *
 *   3. PROMPT — a small painted tab floating over that node naming the
 *      resource, or warning that the Raider has the region shut.
 *
 * Rivals get none of this: the player asked to stop tracking bot activity in
 * detail, and the loud treatment is reserved for their own actions.
 *
 * Owner: World agent.
 */

import * as THREE from 'three';
import { RES_COLOR, RES_LABEL, INTERACT_RADIUS } from '../core/constants.js';
import { nodes, isTileExhausted } from '../board/nodes.js';
import { heightAt } from './terrain.js';
import { instanced, setInstance } from './geo.js';

const TAU = Math.PI * 2;
const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
const KINDS = ['wood', 'brick', 'wool', 'wheat', 'ore', 'blocked'];
const BLOCKED_RGB = [0.44, 0.16, 0.13];
/* An exhausted REGION is not the same statement as a single emptied node: the
   ring drops all its colour and shrinks to a cold scar, so the ground under a
   spent tile stops advertising a resource it cannot give you. */
const SPENT_RGB = [0.30, 0.30, 0.32];

function match() {
  const g = typeof globalThis !== 'undefined' ? globalThis : null;
  return (g && g.__ISLAND__) || null;
}

function canvas2d(w, h) {
  if (typeof document === 'undefined' || !document.createElement) return null;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext && c.getContext('2d');
  return ctx ? { c, ctx } : null;
}

function texture(w, h, paint) {
  const cc = canvas2d(w, h);
  if (!cc) return null;
  try { paint(cc.ctx, w, h); } catch (e) { return null; }
  const t = new THREE.CanvasTexture(cc.c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

/* -------------------------------------------------------------- the glint */

/** Soft double ring with a faint fill — reads as "worked ground" from above. */
function glintTexture() {
  return texture(128, 128, (ctx, w, h) => {
    const cx = w / 2, cy = h / 2, R = w / 2;
    ctx.clearRect(0, 0, w, h);
    const g = ctx.createRadialGradient(cx, cy, R * 0.10, cx, cy, R);
    g.addColorStop(0.00, 'rgba(255,255,255,0.26)');
    g.addColorStop(0.42, 'rgba(255,255,255,0.10)');
    g.addColorStop(0.60, 'rgba(255,255,255,0.62)');
    g.addColorStop(0.74, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.86, 'rgba(255,255,255,0.30)');
    g.addColorStop(1.00, 'rgba(255,255,255,0.00)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.fill();
    // four tick marks so it never reads as a plain shadow
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = w * 0.035;
    ctx.lineCap = 'round';
    for (let i = 0; i < 4; i++) {
      const a = i * (TAU / 4) + Math.PI / 4;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * R * 0.80, cy + Math.sin(a) * R * 0.80);
      ctx.lineTo(cx + Math.cos(a) * R * 0.96, cy + Math.sin(a) * R * 0.96);
      ctx.stroke();
    }
  });
}

/* ------------------------------------------------------------- the prompt */

function promptTexture() {
  const CW = 256, CH = 128;
  return texture(CW * 3, CH * 2, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    KINDS.forEach((kind, idx) => {
      const ox = (idx % 3) * CW, oy = ((idx / 3) | 0) * CH;
      const blocked = kind === 'blocked';
      const accent = blocked ? '#d0472f' : '#' + (RES_COLOR[kind] || 0xffc93c).toString(16).padStart(6, '0');
      ctx.save();
      ctx.translate(ox, oy);

      // chunky rounded tab: dark outline, cream face, coloured under-lip
      const pad = 14, r = 26;
      const x0 = pad, y0 = pad, x1 = CW - pad, y1 = CH - pad - 16;
      const round = (a, b, c, d, rr) => {
        ctx.beginPath();
        ctx.moveTo(a + rr, b);
        ctx.arcTo(c, b, c, d, rr); ctx.arcTo(c, d, a, d, rr);
        ctx.arcTo(a, d, a, b, rr); ctx.arcTo(a, b, c, b, rr);
        ctx.closePath();
      };
      ctx.fillStyle = 'rgba(20,12,6,0.92)';
      round(x0 - 5, y0 - 5, x1 + 5, y1 + 10, r + 5); ctx.fill();
      ctx.fillStyle = accent;
      round(x0, y0 + 8, x1, y1 + 6, r); ctx.fill();
      ctx.fillStyle = blocked ? '#f4dcd6' : '#f6e7c6';
      round(x0, y0, x1, y1, r); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      round(x0 + 6, y0 + 5, x1 - 6, y0 + 24, 10); ctx.fill();

      // little pointer down toward the node
      ctx.fillStyle = 'rgba(20,12,6,0.92)';
      ctx.beginPath();
      ctx.moveTo(CW / 2 - 20, y1 + 2); ctx.lineTo(CW / 2 + 20, y1 + 2);
      ctx.lineTo(CW / 2, y1 + 30); ctx.closePath(); ctx.fill();

      // colour chip + label
      ctx.fillStyle = accent;
      round(x0 + 16, y0 + 18, x0 + 52, y1 - 18, 10); ctx.fill();
      ctx.strokeStyle = 'rgba(20,12,6,0.9)'; ctx.lineWidth = 4; ctx.stroke();

      ctx.fillStyle = '#3a2410';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const label = blocked ? 'BLOCKED' : (RES_LABEL[kind] || kind).toUpperCase();
      const maxW = x1 - x0 - 80;
      let f = 48;
      ctx.font = `bold ${f}px system-ui, sans-serif`;
      while (f > 20 && ctx.measureText(label).width > maxW) {
        f -= 2;
        ctx.font = `bold ${f}px system-ui, sans-serif`;
      }
      ctx.fillText(label, x0 + 66, (y0 + y1) / 2 + 2);
      ctx.restore();
    });
  });
}

/* ---------------------------------------------------------------- factory */

export function buildGatherFX(group) {
  let drawCalls = 0;
  let triangles = 0;

  /* ---- 1. per-node idle glints ---------------------------------------- */
  const quad = new THREE.PlaneGeometry(1, 1);
  quad.rotateX(-Math.PI / 2);
  const glintTex = glintTexture();
  // Normal blending, not additive: an additive ring over the gold of a wheat
  // tile blew straight out to white and read as a lens flare.
  const glintMat = new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, depthWrite: false, opacity: 0.92
  });
  if (glintTex) glintMat.map = glintTex;

  const glints = instanced(quad, glintMat, nodes.length, false, false);
  glints.name = 'node-glint';
  glints.renderOrder = 2;
  glints.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  glints.visible = !!glintTex;
  const gcol = new Float32Array(nodes.length * 3);
  glints.instanceColor = new THREE.InstancedBufferAttribute(gcol, 3);
  group.add(glints);
  if (glintTex) { drawCalls++; triangles += nodes.length * 2; }

  const base = new THREE.Color();
  const glintRGB = nodes.map(n => {
    base.setHex(RES_COLOR[n.resource] || 0xffc93c, THREE.SRGBColorSpace);
    // lifted toward white so the ring holds against both dark forest floor and
    // pale sand without going neon
    return [base.r * 0.62 + 0.34, base.g * 0.62 + 0.34, base.b * 0.62 + 0.34];
  });
  const glintY = nodes.map(n => heightAt(n.x, n.z) + 0.14);
  /* A tree node is a copse with a canopy over it, so its ring has to reach out
     past the branches to be seen at all. */
  const glintR = nodes.map(n => (n.kind === 'tree' ? 3.35 : n.kind === 'sheep' ? 2.9 : 2.5));
  const glintAmp = nodes.map((n, i) => (i * 0.618) % 1);
  const shown = new Float32Array(nodes.length);

  /* ---- 2. the target ring --------------------------------------------- */
  const ringGeo = new THREE.CircleGeometry(1, 44);
  ringGeo.rotateX(-Math.PI / 2);
  const ringMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, depthTest: true,
    uniforms: {
      uColor:    { value: new THREE.Color(0xffc93c) },
      uProgress: { value: 0 },
      uTime:     { value: 0 },
      uFade:     { value: 0 },
      uWarn:     { value: 0 }
    },
    vertexShader: /* glsl */`
      varying vec2 vP;
      void main() {
        vP = position.xz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      uniform vec3 uColor;
      uniform float uProgress, uTime, uFade, uWarn;
      varying vec2 vP;
      void main() {
        float d = length(vP);
        if (d > 1.0) discard;

        // outer selection ring, gently breathing
        float rr = 0.80 + sin(uTime * 3.4) * 0.018;
        float ring = smoothstep(0.10, 0.0, abs(d - rr) - 0.045);

        // dashed inner guide so it never reads as a flat decal
        float ang = atan(vP.y, vP.x);
        float dash = step(0.42, fract((ang / 6.2831853) * 16.0 + uTime * 0.28));
        float guide = smoothstep(0.05, 0.0, abs(d - 0.60) - 0.018) * dash * 0.55;

        // radial progress sweep filling clockwise from straight ahead
        float t = fract((-ang + 1.5707963) / 6.2831853);
        float sweep = step(t, uProgress) * step(0.30, d) * step(d, 0.74);
        float head = smoothstep(0.055, 0.0, abs(t - uProgress)) * step(0.28, d) * step(d, 0.78);

        float fill = (1.0 - smoothstep(0.0, 0.86, d)) * 0.16;
        float a = (ring + guide + sweep * 0.55 + head * 0.9 + fill) * uFade;
        if (a < 0.006) discard;

        vec3 c = mix(uColor, vec3(1.0), head * 0.6 + sweep * 0.18);
        c = mix(c, vec3(0.86, 0.20, 0.14), uWarn);
        gl_FragColor = vec4(c, clamp(a, 0.0, 0.95));
      }
    `
  });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.name = 'gather-ring';
  ring.renderOrder = 4;
  ring.frustumCulled = false;
  ring.visible = false;
  group.add(ring);
  drawCalls++; triangles += 44;

  /* ---- 3. the floating prompt ----------------------------------------- */
  const promptTex = promptTexture();
  const promptMat = new THREE.MeshBasicMaterial({
    transparent: true, depthWrite: false, depthTest: false, opacity: 0
  });
  if (promptTex) {
    promptTex.repeat.set(1 / 3, 1 / 2);
    promptMat.map = promptTex;
  }
  const prompt = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 1.8), promptMat);
  prompt.name = 'gather-prompt';
  prompt.renderOrder = 20;
  prompt.frustumCulled = false;
  prompt.visible = false;
  group.add(prompt);
  if (promptTex) { drawCalls++; triangles += 2; }

  function setCell(idx) {
    if (!promptTex) return;
    promptTex.offset.set((idx % 3) / 3, 1 - (((idx / 3) | 0) + 1) / 2);
  }

  /* ------------------------------------------------------------- update */

  let clock = 0;
  let ringFade = 0;
  let promptFade = 0;
  let poll = 0;
  let robber = -1;
  let robberOwner = -1;

  function update(dt) {
    clock += dt;
    const I = match();
    const state = I && I.state;
    const cam = I && I.camera;

    if ((poll -= dt) <= 0) {
      poll = 0.25;
      if (state) { robber = state.robberTile; robberOwner = state.robberOwner; }
    }

    /* ---- glints ------------------------------------------------------- */
    if (glints.visible) {
      const blockAll = robberOwner === 0 ? -1 : robber;
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        const blocked = n.tile === blockAll;
        const spent = !blocked && n.remaining <= 0 && isTileExhausted(n.tile);
        const live = n.remaining > 0 && !blocked;
        const want = blocked ? 0.62 : (n.remaining > 0 ? 1 : (spent ? 0.34 : 0.22));
        const cur = shown[i] + (want - shown[i]) * Math.min(1, dt * 4.5);
        shown[i] = cur;
        if (cur < 0.02) { setInstance(glints, i, n.x, glintY[i], n.z, 0, 0.0001, 0.0001); continue; }
        const pulse = live
          ? 1 + Math.sin(clock * 1.9 + glintAmp[i] * TAU) * 0.085
          : (blocked ? 1 + Math.sin(clock * 1.15 + glintAmp[i] * TAU) * 0.03 : 0.86);
        const s = (blocked ? glintR[i] * 1.15 : spent ? glintR[i] * 0.68 : glintR[i]) * cur * pulse;
        setInstance(glints, i, n.x, glintY[i], n.z, glintAmp[i] * TAU, s, s);
        const c = blocked ? BLOCKED_RGB : spent ? SPENT_RGB : glintRGB[i];
        const k = cur * (live ? 1 : 0.75);
        gcol[i * 3] = c[0] * k; gcol[i * 3 + 1] = c[1] * k; gcol[i * 3 + 2] = c[2] * k;
      }
      glints.instanceMatrix.needsUpdate = true;
      glints.instanceColor.needsUpdate = true;
    }

    /* ---- target ring + prompt (human only) ---------------------------- */
    const me = state && state.players && state.players[0];
    let target = null, working = false, blockedTarget = false;
    if (me && state.phase === 'play') {
      if (me.action === 'gather' && me.gatherNode) { target = me.gatherNode; working = true; }
      else if (me.nearTarget) target = me.nearTarget;
      if (!target && robber >= 0 && robberOwner !== 0) {
        // standing in a shut region: say so rather than going silent
        let best = null, bd = INTERACT_RADIUS * INTERACT_RADIUS * 1.6;
        for (const n of nodes) {
          if (n.tile !== robber) continue;
          const d = (n.x - me.x) * (n.x - me.x) + (n.z - me.z) * (n.z - me.z);
          if (d < bd) { bd = d; best = n; }
        }
        if (best) { target = best; blockedTarget = true; }
      }
    }

    const wantRing = target ? 1 : 0;
    ringFade += (wantRing - ringFade) * Math.min(1, dt * (target ? 9 : 6));
    promptFade += (wantRing - promptFade) * Math.min(1, dt * (target ? 8 : 6));

    if (ringFade > 0.01 && target) {
      const anchor = (I && I.world && I.world.props && I.world.props.nodeAnchor)
        ? I.world.props.nodeAnchor(target) : null;
      const ax = anchor ? anchor.x : target.x;
      const az = anchor ? anchor.z : target.z;
      ring.visible = true;
      ring.position.set(ax, heightAt(ax, az) + 0.16, az);
      ring.scale.setScalar(2.5);
      ringMat.uniforms.uTime.value = clock;
      ringMat.uniforms.uFade.value = ringFade;
      ringMat.uniforms.uWarn.value = blockedTarget ? 1 : 0;
      ringMat.uniforms.uProgress.value = working ? clamp01(me.gatherProgress) : 0;
      ringMat.uniforms.uColor.value.setHex(
        blockedTarget ? 0xd0472f : (RES_COLOR[target.resource] || 0xffc93c),
        THREE.SRGBColorSpace);

      if (promptTex) {
        setCell(blockedTarget ? 5 : Math.max(0, KINDS.indexOf(target.resource)));
        prompt.visible = true;
        // Kept low: the hero's own carry columns start 5.3 units up, and a
        // prompt any higher than this disappears behind them.
        prompt.position.set(ax, heightAt(ax, az) + 3.15 + Math.sin(clock * 2.1) * 0.13, az);
        if (cam && cam.quaternion) prompt.quaternion.copy(cam.quaternion);
        const k = 0.55 + promptFade * 0.45;
        prompt.scale.set(k, k, k);
        promptMat.opacity = promptFade;
      }
    } else {
      ring.visible = ringFade > 0.01;
      if (!ring.visible) prompt.visible = false;
      promptMat.opacity = promptFade;
      if (promptFade < 0.02) prompt.visible = false;
    }
  }

  return {
    group, update, drawCalls, triangles,
    dispose() {
      quad.dispose(); ringGeo.dispose(); prompt.geometry.dispose();
      glintMat.dispose(); ringMat.dispose(); promptMat.dispose();
      if (glintTex) glintTex.dispose();
      if (promptTex) promptTex.dispose();
    }
  };
}

export default buildGatherFX;
