/**
 * Island Settlers — the life of a REGION.
 *
 *   buildRegions(group, dressing, stumps) -> {
 *     update(dt), drawCalls, triangles, dispose()
 *   }
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * The player said it plainly:
 *
 *   "I should be easily able to tell the specific hexes I'm allowed to get
 *    resources from. Right now they're all the same appearance. NOTHING is
 *    currently differentiating them."
 *
 * You can in fact work any region — owning a settlement or a city on one of its
 * corners MULTIPLIES what you get there (x2 / x3, `ownershipMultiplier` in
 * rules.js). So the honest read is not "locked out", it is "these are your
 * high-yield regions", and this file is what says it, at region scale:
 *
 *   1. TONAL GROUPING. One terrain-conforming decal per hex. A region you own
 *      gets a warm lift and a clean rim in YOUR colour; a region you do not
 *      gets a cool, quiet mute. That is the Whiteout Survival separation
 *      between active and inactive territory, and it holds with six hexes on
 *      screen at once.
 *
 *   2. WORKED GROUND. The same decal churns up as the region is worked —
 *      patches of bare, dug, trampled earth spreading out from where you have
 *      been standing — and drops to ash when the region is worked out.
 *
 *   3. THE BADGE (regionmark.js). Silent unless it has something to say:
 *      the multiplier on a region you own, the SECONDS LEFT on one that is
 *      worked out, a bar on one the Raider has shut. Nothing else.
 *
 *   4. THE STAND (stand.js). The trees, wheat, ferns and grass answering to
 *      the harvest, felled nearest the settler who swung.
 *
 *   5. THE RECOVERY BEAT. When the region comes back the ground flashes from
 *      the centre outward, the stand rises again in a wave and the badge fades.
 *
 * Two draw calls for all nineteen hexes.
 *
 * Owner: World agent.
 */

import * as THREE from 'three';
import { NODE_CAPACITY, RES_COLOR, PLAYER_COLORS } from '../core/constants.js';
import { tiles } from '../board/layout.js';
import {
  nodesByTile, tileRemaining, tileRecovery, isTileExhausted, TILE_REGROW_SEC
} from '../board/nodes.js';
import { ownershipMultiplier } from '../core/rules.js';
import { heightAt, APOTHEM } from './terrain.js';
import { buildMarkers, markerAtlas, GLYPH } from './regionmark.js';
import { buildStand } from './stand.js';

const TAU = Math.PI * 2;
const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);

function match() {
  const g = typeof globalThis !== 'undefined' ? globalThis : null;
  return (g && g.__ISLAND__) || null;
}

/* ------------------------------------------------------- worked-ground tone
 * What the bare, worked-out floor of each terrain looks like once the standing
 * crop is off it. Deliberately a long way from the tile's own painted colour —
 * a clear-cut has to read as churned earth, not as slightly darker forest. */
const WORN = {
  forest:    0x5e4630,   // duff, sawdust and root-torn soil
  fields:    0xa98b3f,   // stubble and chaff
  pasture:   0x8a8b4a,   // cropped, trodden turf
  hills:     0x6b3216,   // spoil and wet clay
  mountains: 0x555b66,   // rubble and rock flour
  desert:    0xbc9256
};

/* The colour a region flashes when it comes back. Deliberately a step or two
   brighter than the terrain it lands on — a recovery has to be a moment, and a
   wave the same value as the ground under it is not one. */
const LIVE = {
  forest:    0x8dff5e,
  fields:    0xfff2a0,
  pasture:   0xcaff8a,
  hills:     0xffbe72,
  mountains: 0xc2f4ff,
  desert:    0xffe9b8
};

/* The two tones that carry the whole "mine / not mine" read. */
const WARM = 0xffe9b0;    // sunlit lift over a region you own
const MUTE = 0x121b2c;    // cool, quiet dark over one you do not

/* =========================================================== ground overlay */

const SEGS = 12;                       // hex corners land on 30 degree steps
/* Absolute hex fractions, not normalised: the shader bands against them
   directly. 0.795 is the owner rim — just inside the tan road strip (0.81) so
   the glow reads as the hex being lit, never as paint on somebody's road. */
const RINGS = [0.24, 0.46, 0.66, 0.775, 0.865];
const RIM_AT = 0.775;

/** Distance from a hex centre to its boundary along `a`, in world units. */
function hexReach(a) {
  const c = Math.cos(a), s = Math.sin(a);
  const m = Math.max(
    Math.abs(c),
    Math.abs(0.5 * c + 0.8660254037844386 * s),
    Math.abs(-0.5 * c + 0.8660254037844386 * s)
  );
  return APOTHEM / Math.max(m, 1e-4);
}

function buildOverlay(list) {
  const perTile = 1 + RINGS.length * SEGS;
  const vtx = list.length * perTile;
  const pos = new Float32Array(vtx * 3);
  const rim = new Float32Array(vtx);
  const worn = new Float32Array(vtx * 3);
  const live = new Float32Array(vtx * 3);
  const state = new Float32Array(vtx * 4);

  const triPerTile = SEGS + (RINGS.length - 1) * SEGS * 2;
  const idx = new Uint16Array(list.length * triPerTile * 3);

  const cw = new THREE.Color(), cl = new THREE.Color();
  let v = 0, f = 0;

  list.forEach((rec) => {
    const t = rec.tile;
    cw.setHex(WORN[t.terrain] || 0x6a5a44, THREE.SRGBColorSpace);
    cl.setHex(LIVE[t.terrain] || 0x8fe06a, THREE.SRGBColorSpace);
    const base = v;
    rec.vStart = v;
    rec.vCount = perTile;

    // Which gather node owns this patch of ground. The churn is written PER
    // VERTEX from that node's own level, so bare dug earth appears exactly
    // where you have been working and spreads across the hex as you walk it,
    // instead of the whole region dimming uniformly.
    rec.vn = new Int32Array(perTile);

    const put = (x, z, r) => {
      // Lifted well clear of the tile top: the decal is a coarse fan and the
      // painted undulation under it runs +-0.19, so a tighter offset sinks
      // whole wedges of it below the ground and the depth test eats them.
      pos[v * 3] = x; pos[v * 3 + 1] = heightAt(x, z) + 0.30; pos[v * 3 + 2] = z;
      rim[v] = r;
      worn[v * 3] = cw.r; worn[v * 3 + 1] = cw.g; worn[v * 3 + 2] = cw.b;
      live[v * 3] = cl.r; live[v * 3 + 1] = cl.g; live[v * 3 + 2] = cl.b;
      let bi = 0, bd = 1e9;
      for (let k = 0; k < rec.nodes.length; k++) {
        const nd = rec.nodes[k];
        const dd = (nd.x - x) * (nd.x - x) + (nd.z - z) * (nd.z - z);
        if (dd < bd) { bd = dd; bi = k; }
      }
      rec.vn[v - base] = bi;
      v++;
    };

    put(t.x, t.z, 0);
    for (let r = 0; r < RINGS.length; r++) {
      for (let s = 0; s < SEGS; s++) {
        const a = (s / SEGS) * TAU;
        const d = RINGS[r] * hexReach(a);
        put(t.x + Math.cos(a) * d, t.z + Math.sin(a) * d, RINGS[r]);
      }
    }

    // centre fan
    for (let s = 0; s < SEGS; s++) {
      idx[f++] = base;
      idx[f++] = base + 1 + s;
      idx[f++] = base + 1 + ((s + 1) % SEGS);
    }
    // ring quads
    for (let r = 0; r < RINGS.length - 1; r++) {
      const a0 = base + 1 + r * SEGS;
      const b0 = a0 + SEGS;
      for (let s = 0; s < SEGS; s++) {
        const s1 = (s + 1) % SEGS;
        idx[f++] = a0 + s; idx[f++] = b0 + s; idx[f++] = b0 + s1;
        idx[f++] = a0 + s; idx[f++] = b0 + s1; idx[f++] = a0 + s1;
      }
    }
  });

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aRim', new THREE.BufferAttribute(rim, 1));
  geo.setAttribute('aWorn', new THREE.BufferAttribute(worn, 3));
  geo.setAttribute('aLive', new THREE.BufferAttribute(live, 3));
  const stateAttr = new THREE.BufferAttribute(state, 4);
  stateAttr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aState', stateAttr);
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeBoundingSphere();

  const mat = new THREE.ShaderMaterial({
    // DoubleSide is not laziness: a fan wound counter-clockwise in (x, z) faces
    // AWAY from a camera looking down +y, because (x, z) is left-handed from
    // above. Front-side only and the whole decal is invisible.
    transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uRim:  { value: new THREE.Color(0x3b7fd4) },
      uWarm: { value: new THREE.Color(WARM) },
      uMute: { value: new THREE.Color(MUTE) }
    },
    vertexShader: /* glsl */`
      attribute float aRim;
      attribute vec3 aWorn, aLive;
      attribute vec4 aState;
      varying float vRim;
      varying vec3 vWorn, vLive;
      varying vec4 vState;
      varying vec2 vW;
      void main() {
        vRim = aRim; vWorn = aWorn; vLive = aLive; vState = aState;
        vW = position.xz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      uniform float uTime;
      uniform vec3 uRim, uWarm, uMute;
      varying float vRim;
      varying vec3 vWorn, vLive;
      varying vec4 vState;
      varying vec2 vW;

      float h21(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
      }
      float vn(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        float a = h21(i), b = h21(i + vec2(1.0, 0.0));
        float c = h21(i + vec2(0.0, 1.0)), d = h21(i + vec2(1.0, 1.0));
        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
      }

      /* Standard source-over composite, so the tonal wash, the churn, the ash
         and the owner rim stack in a defined order instead of fighting for the
         same lerp. */
      void over(inout vec3 col, inout float a, vec3 c2, float a2) {
        if (a2 <= 0.0005) return;
        float o = a2 + a * (1.0 - a2);
        col = (c2 * a2 + col * a * (1.0 - a2)) / max(o, 1e-5);
        a = o;
      }

      void main() {
        float work = vState.x, spent = vState.y, flash = vState.z, own = vState.w;

        // The wash fills the whole prop zone and stops at the tan road strip.
        float plate = 1.0 - smoothstep(0.72, 0.865, vRim);
        float rim = smoothstep(${(RIM_AT - 0.075).toFixed(3)}, ${RIM_AT.toFixed(3)}, vRim)
                  * (1.0 - smoothstep(${RIM_AT.toFixed(3)}, ${(RIM_AT + 0.070).toFixed(3)}, vRim));
        float n = vn(vW * 0.62) * 0.62 + vn(vW * 1.9 + 7.3) * 0.38;

        vec3 col = vec3(0.0);
        float a = 0.0;

        // ---- 1. tonal grouping: is this region worth your time right now?
        if (own > 0.004) {
          // sunlit lift, strongest out toward the rim so the hex reads as lit
          // from its own border inward
          float lift = 0.065 + 0.15 * smoothstep(0.15, 0.80, vRim);
          over(col, a, uWarm, lift * own * plate);
        } else if (spent < 0.5) {
          // Deliberately restrained: fifteen of the eighteen regions are
          // unowned at any moment, so anything heavier here drags the whole
          // island out of its saturated tropical palette.
          float mute = 0.25 * (1.0 - 0.35 * work);
          over(col, a, uMute, mute * plate);
          // and the border goes dark, which is what actually separates two
          // neighbouring hexes at a glance
          over(col, a, uMute, rim * 0.34 * (1.0 - 0.5 * work));
        }

        // ---- 2. churned patches spread out of the noise field as the work
        // level climbs, so a half-worked region looks blotchy rather than
        // uniformly tinted — ground somebody has actually walked over.
        // ('patch' is a reserved word in GLSL ES 3.00 — do not rename to it)
        float churn = smoothstep(0.0, 0.30, work * 1.42 - n * 0.82);
        over(col, a, vWorn, churn * (0.54 + 0.30 * work) * plate);

        // ---- 3. worked out: desaturated and dug over. Kept deliberately
        // light on the grey — the hex still has to read as the FOREST it was,
        // and a full ash plate buries the duff, the slash and the stumps under
        // one flat slate tone.
        if (spent > 0.004) {
          over(col, a, vec3(0.58, 0.585, 0.60), spent * (0.20 + 0.10 * n) * plate);
          float scar = smoothstep(0.52, 0.92, vn(vW * 1.05 + 21.0)) * spent;
          over(col, a, vWorn * 0.52, scar * 0.42 * plate);
        }

        // ---- 4. the owner's rim, drawn last so nothing mutes it. This is the
        // loudest thing on the board that is not a number token, and it is the
        // one signal that survives a hex being completely covered in trees.
        if (own > 0.004) {
          float pulse = 0.86 + 0.14 * sin(uTime * 2.0);
          over(col, a, uRim, rim * rim * (0.62 + 0.32 * own) * pulse);
          // a soft inward bleed so the rim reads as light spilling into the
          // region, not as a decal someone stuck on the edge
          over(col, a, uRim, smoothstep(0.30, 0.775, vRim) * 0.17 * own * plate);
          if (own > 0.75) {
            float band2 = smoothstep(0.038, 0.0, abs(vRim - 0.640));
            over(col, a, uRim, band2 * 0.46 * pulse);
          }
        }

        // ---- 5. the recovery beat
        if (flash > 0.004) {
          float ringR = (1.0 - flash) * 1.10;
          float band = smoothstep(0.26, 0.0, abs(vRim - ringR));
          float glow = flash * flash;
          over(col, a, vLive, min(1.0, band * 0.92 + glow * 0.55) * plate);
        }

        if (a < 0.008) discard;
        gl_FragColor = vec4(col, min(a, 0.90));
      }
    `
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'region-ground';
  mesh.renderOrder = 1;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return { mesh, geo, mat, state, stateAttr, triangles: list.length * triPerTile };
}

/* ================================================================= factory */

export function buildRegions(group, dressing, stumps) {
  /* ------------------------------------------------------- region records */
  const regions = [];
  const byTile = new Map();
  for (const t of tiles) {
    const list = nodesByTile.get(t.id);
    if (!list || !list.length) continue;
    const rec = {
      tile: t, nodes: list,
      // Clear of the tallest trees, the mountain skyline and — the one that
      // actually bit — the hero's own carry columns, which stack to 5.3.
      y: heightAt(t.x, t.z) + (t.terrain === 'mountains' ? 10.6 : 9.9),
      work: 0, spent: 0, flash: 0, own: 0, ownWant: 0,
      mult: 1, blocked: false,
      fraction: 1, seconds: 0, progress: 1, exhausted: false,
      wasExhausted: false, alpha: 0, bob: (t.id * 0.7) % TAU,
      accent: RES_COLOR[t.resource] || 0xffc93c,
      vStart: 0, vCount: 0,
      lvl: new Float32Array(list.length)
    };
    regions.push(rec);
    byTile.set(t.id, rec);
  }

  const ground = buildOverlay(regions);
  group.add(ground.mesh);

  const atlas = markerAtlas();
  const marker = buildMarkers(regions, atlas);
  group.add(marker.mesh);

  /* The human's colour drives both the rim on the ground and the badge. */
  const _c = new THREE.Color();
  // The player's LIGHT variant, not the base hex: the base blue is a mid tone
  // and a mid tone laid over grass and clay at 60% alpha reads as a smudge.
  // #7fb2f0 holds against every terrain on the board and against the sea.
  const MINE = (PLAYER_COLORS[0] && PLAYER_COLORS[0].light) || '#7fb2f0';
  ground.mat.uniforms.uRim.value.set(MINE).convertSRGBToLinear();
  marker.mat.uniforms.uOwn.value.copy(ground.mat.uniforms.uRim.value);

  const EMBER = new THREE.Color().setHex(0xff9c2a, THREE.SRGBColorSpace);
  regions.forEach((r) => {
    _c.setHex(r.accent, THREE.SRGBColorSpace);
    r.rgb = [_c.r, _c.g, _c.b];
  });

  /* --------------------------------------------------------------- stand */
  const stand = buildStand(group, dressing, stumps);

  /* -------------------------------------------------------- recovery beat */

  function celebrate(rec) {
    const I = match();
    if (!I) return;
    const w = I.world;
    if (!w) return;
    try {
      const t = rec.tile;
      if (w.effects && w.effects.burst) w.effects.burst(t.x, t.z, t.resource);
      const p = I.state && I.state.players && I.state.players[0];
      const d = p ? Math.hypot(p.x - t.x, p.z - t.z) : 999;
      if (w.audio && w.audio.sfx) {
        w.audio.sfx('upgrade', { gain: d < 34 ? 0.6 : 0.22, at: { x: t.x, z: t.z } });
      }
      if (d < 24 && w.camera && w.camera.shake) w.camera.shake(0.07);
      if (d < 34 && I.game && I.game.toast) I.game.toast('The region has grown back');
    } catch (e) { /* presentation is always optional */ }
  }

  function announceSpent(rec) {
    const I = match();
    if (!I) return;
    try {
      const p = I.state && I.state.players && I.state.players[0];
      if (!p) return;
      if (Math.hypot(p.x - rec.tile.x, p.z - rec.tile.z) > 26) return;
      if (I.game && I.game.toast) {
        I.game.toast(`Region worked out — back in ${Math.round(TILE_REGROW_SEC)}s`, 'warn');
      }
      if (I.world && I.world.audio && I.world.audio.sfx) {
        I.world.audio.sfx('deny', { gain: 0.45, at: { x: rec.tile.x, z: rec.tile.z } });
      }
    } catch (e) { /* optional */ }
  }

  /* ------------------------------------------------------------------ loop */

  let clock = 0;
  let poll = 0;

  function sample() {
    const I = match();
    const state = I && I.state;
    const now = state ? state.time : clock;
    const playing = !!state && state.phase === 'play';
    const robber = state ? state.robberTile : -1;
    const robberMine = state ? state.robberOwner === 0 : false;

    for (const rec of regions) {
      const rem = tileRemaining(rec.tile.id);
      const rc = tileRecovery(rec.tile.id, now);
      rec.fraction = rem.fraction;
      rec.exhausted = isTileExhausted(rec.tile.id);
      rec.seconds = rc.secondsLeft;
      rec.progress = rc.progress;
      rec.blocked = playing && robber === rec.tile.id && !robberMine;

      // Ownership: settlement = x2, city = x3. Read-only, straight off the
      // frozen rule so the picture can never disagree with the payout.
      let mult = 1;
      if (state && state.buildings) {
        try { mult = ownershipMultiplier(state, 0, rec.tile.id); } catch (e) { mult = 1; }
      }
      rec.mult = mult;
      rec.ownWant = (playing && !rec.blocked && mult > 1) ? (mult >= 3 ? 1 : 0.62) : 0;

      if (rec.exhausted && !rec.wasExhausted) {
        rec.wasExhausted = true;
        announceSpent(rec);
      } else if (!rec.exhausted && rec.wasExhausted) {
        rec.wasExhausted = false;
        rec.flash = 1;
        celebrate(rec);
      }
    }
  }

  function update(dt) {
    clock += dt;
    ground.mat.uniforms.uTime.value = clock;
    marker.mat.uniforms.uTime.value = clock;

    if ((poll -= dt) <= 0) { poll = 0.12; sample(); }
    stand.update(dt);

    /* ---- ground + markers -------------------------------------------- */
    const st = ground.state;
    const md = marker.aData.array;
    const mp = marker.aPos.array;
    const ms = marker.aSize.array;
    const mo = marker.aOwn.array;
    const mc = marker.aCol.array;
    let groundDirty = false;

    for (let i = 0; i < regions.length; i++) {
      const r = regions[i];

      // How worked-over the region looks: the standing stock drives it, and an
      // exhausted region is pinned at fully worked.
      const wantWork = r.exhausted ? 1 : clamp01(1 - r.fraction);
      const wantSpent = r.exhausted || r.blocked ? 1 : 0;
      const kw = Math.min(1, dt * (wantWork > r.work ? 3.0 : 2.2));
      r.work += (wantWork - r.work) * kw;
      r.spent += (wantSpent - r.spent) * Math.min(1, dt * (wantSpent ? 3.4 : 4.2));
      r.own += (r.ownWant - r.own) * Math.min(1, dt * 3.2);
      if (r.flash > 0) r.flash = Math.max(0, r.flash - dt * 0.52);

      // Per-node churn levels, smoothed, then splashed onto the vertices that
      // node owns. `r.work` acts as a floor so the hex still reads as a single
      // worked region rather than seven unrelated puddles.
      const o0 = r.vStart * 4;
      let moved = Math.abs(st[o0 + 1] - r.spent) > 0.0015
        || Math.abs(st[o0 + 2] - r.flash) > 0.0015
        || Math.abs(st[o0 + 3] - r.own) > 0.0015;
      const floor = r.work * 0.42;
      for (let k = 0; k < r.nodes.length; k++) {
        const want = 1 - clamp01(Math.max(0, r.nodes[k].remaining) / NODE_CAPACITY);
        const cur = r.lvl[k] + (want - r.lvl[k]) * Math.min(1, dt * 2.6);
        if (Math.abs(cur - r.lvl[k]) > 0.0015) moved = true;
        r.lvl[k] = cur;
      }
      if (moved) {
        for (let v = 0; v < r.vCount; v++) {
          const o = (r.vStart + v) * 4;
          st[o] = Math.max(floor, r.lvl[r.vn[v]]);
          st[o + 1] = r.spent;
          st[o + 2] = r.flash;
          st[o + 3] = r.own;
        }
        groundDirty = true;
      }

      /* ---- the badge ----
       * Silent unless it has something to say. This is the single biggest cut
       * to on-screen clutter: nineteen permanent floating tabs became two or
       * three. */
      let wantA = 0, size = 5.0, fill = r.fraction, cell = GLYPH.sprout, spent = 0;
      let accent = r.rgb, own = 0;
      if (r.exhausted) {
        wantA = 1; size = 6.8; spent = 1;
        fill = clamp01(r.progress);
        cell = Math.max(0, Math.min(20, Math.ceil(r.seconds - 0.001)));
        accent = [EMBER.r, EMBER.g, EMBER.b];
      } else if (r.blocked) {
        wantA = 1; size = 6.0; spent = 1; fill = 0;
        cell = GLYPH.blocked;
        accent = [EMBER.r, EMBER.g, EMBER.b];
      } else if (r.mult > 1) {
        wantA = 1; size = 5.4 + (r.mult >= 3 ? 0.5 : 0);
        cell = r.mult >= 3 ? GLYPH.mult3 : GLYPH.mult2;
        own = r.own;
      }
      // A region that has simply grown back says so with the green wave on the
      // ground and a toast. It does not need a badge as well.
      r.alpha += (wantA - r.alpha) * Math.min(1, dt * (wantA > r.alpha ? 7 : 3.4));

      r.bob += dt * 1.5;
      const pop = r.flash > 0.01 ? 1 + r.flash * 0.55 : 1;
      const pulse = spent ? 1 + Math.sin(clock * 3.6) * 0.045 : 1;
      mp[i * 3] = r.tile.x;
      mp[i * 3 + 1] = r.y + Math.sin(r.bob) * 0.28;
      mp[i * 3 + 2] = r.tile.z;
      ms[i] = size * pop * pulse * (0.55 + r.alpha * 0.45);
      md[i * 4] = fill;
      md[i * 4 + 1] = r.alpha;
      md[i * 4 + 2] = spent;
      md[i * 4 + 3] = cell;
      mo[i] = own;
      mc[i * 3] = accent[0];
      mc[i * 3 + 1] = accent[1];
      mc[i * 3 + 2] = accent[2];
    }

    if (groundDirty) ground.stateAttr.needsUpdate = true;
    marker.aData.needsUpdate = true;
    marker.aPos.needsUpdate = true;
    marker.aSize.needsUpdate = true;
    marker.aCol.needsUpdate = true;
    marker.aOwn.needsUpdate = true;
  }

  return {
    update,
    regions,
    stand,
    drawCalls: 2,
    triangles: ground.triangles + marker.triangles,

    /** Debug / capture hook: how much of the stand has answered the harvest. */
    debug(tileId) { return stand.debug(tileId); },

    /** Debug / capture hook: what the badge is currently saying. */
    readout() {
      return regions.map(r => ({
        tile: r.tile.id, terrain: r.tile.terrain,
        fraction: +r.fraction.toFixed(2),
        work: +r.work.toFixed(2), spent: +r.spent.toFixed(2),
        own: +r.own.toFixed(2), mult: r.mult, blocked: r.blocked,
        exhausted: r.exhausted, seconds: +r.seconds.toFixed(1)
      }));
    },

    dispose() {
      ground.geo.dispose(); ground.mat.dispose();
      marker.geo.dispose(); marker.quad.dispose(); marker.mat.dispose();
      stand.dispose();
      if (atlas) atlas.dispose();
    }
  };
}

export default buildRegions;
