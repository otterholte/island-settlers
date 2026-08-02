/**
 * Island Settlers — the life of a REGION.
 *
 *   buildRegions(group, dressing, stumps) -> {
 *     update(dt), readout(), debug(tileId), drawCalls, triangles, dispose()
 *   }
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * The player has now said the same thing three times, and the last two answers
 * were not good enough:
 *
 *   "It's still way too hard to tell which hexes I can use and which I can't.
 *    Make it much more drastic and clear."
 *   "I should never be able to pick up resources from hexes I don't have a
 *    settlement or city next to — only my own."
 *
 * Ownership is a hard GATE now. There is no multiplier, no x2 badge, no "these
 * are your high-yield regions". A hex is either yours to work or it is scenery.
 * So the read is built in three layers, loudest first:
 *
 *   1. THE PIXELS (mood.js). Every hex you may not work — terrain, trees,
 *      flock, boulders, wheat — is printed as a flat DUOTONE in that terrain's
 *      own ink and dropped half a stop, so a forest you cannot chop is one dead
 *      green and a mountain you cannot mine is one dead slate: you can still
 *      read the board, and nothing on it looks alive. Every hex you may work
 *      keeps all of its colours and gains a warm lift. That is the layer that
 *      survives being covered in forty trees.
 *
 *   2. THIS DECAL. A terrain-conforming fan per hex: a bright rim in the
 *      player's blue and a soft inward bleed on a hex that is yours, a flat
 *      dead wash and a black border on one that is not, churned worked ground
 *      as you sweep it, ash when it is spent, and a green wave when it returns.
 *
 *   3. THE CLOCK (regionmark.js). A big countdown ring over a worked-out hex,
 *      and nothing at all otherwise.
 *
 * Two draw calls for all nineteen hexes.
 *
 * Owner: World agent.
 */

import * as THREE from 'three';
import { RES_COLOR, PLAYER_COLORS } from '../core/constants.js';
import { tiles } from '../board/layout.js';
import { heightAt, APOTHEM } from './terrain.js';
import {
  MOOD, syncMood, onRestored, onSpent, uMoodTime, GLOW_HZ,
  floodOf, victoryFloodActive
} from './mood.js';
import { buildMarkers, markerAtlas, GLYPH, MAX_SEC } from './regionmark.js';
import { buildStand } from './stand.js';

const TAU = Math.PI * 2;
const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);

function match() {
  const g = typeof globalThis !== 'undefined' ? globalThis : null;
  return (g && g.__ISLAND__) || null;
}

/* ------------------------------------------------------- worked-ground tone
 * What the bare floor of each terrain looks like once the crop is off it.
 * Deliberately a long way from the tile's own painted colour — a clear-cut has
 * to read as churned earth, not as slightly darker forest. */
const WORN = {
  forest:    0x5e4630,   // duff, sawdust and root-torn soil
  fields:    0xa98b3f,   // stubble and chaff
  pasture:   0x8a8b4a,   // cropped, trodden turf
  hills:     0x6b3216,   // spoil and wet clay
  mountains: 0x555b66,   // rubble and rock flour
  desert:    0xbc9256
};

/* The colour a hex flashes when it comes back. */
const LIVE = {
  forest:    0x8dff5e,
  fields:    0xfff2a0,
  pasture:   0xcaff8a,
  hills:     0xffbe72,
  mountains: 0xc2f4ff,
  desert:    0xffe9b8
};

const WARM = 0xffeec0;    // sunlit lift over a hex you own
const MUTE = 0x0a1120;    // the dead wash over one you do not

/* =========================================================== ground overlay */

const SEGS = 12;
const RINGS = [0.24, 0.46, 0.66, 0.775, 0.865];
const RIM_AT = 0.775;

/* THE LIGHT WALL.
 *
 * The single loudest change in this pass. On top of the terrain-conforming fan
 * the same mesh now grows a short vertical skirt around the edge of every hex
 * you may work: a band of the player's blue standing off the ground, brightest
 * at the base and fading out at the top, breathing on the shared mood clock.
 *
 * Why a wall and not a brighter decal. A ground decal is foreshortened to
 * nearly nothing at the play camera's 50-degree pitch and disappears entirely
 * behind a forest of three-unit trees — which is precisely why the last two
 * attempts at "make it obvious" did not read. A vertical band is seen face-on
 * from that camera, it stands ABOVE the grass, it survives being half occluded
 * by props, and at the edge of vision the eye catches it as motion rather than
 * as colour.
 *
 * It costs 24 triangles per hex and not one extra draw call — it is more
 * vertices on a buffer that was already being drawn.
 *
 * Placed at hexFrac 0.905, out in the tan border strip: the props stop at 0.78,
 * so the wall never grows through a tree, and the hex TOP the player runs
 * around stays completely clear. */
const WALL_AT = 0.905;
const WALL_H = 1.85;

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
  // fan: centre + the ground rings.  wall: a base ring and a lifted top ring.
  const perTile = 1 + RINGS.length * SEGS + SEGS * 2;
  const vtx = list.length * perTile;
  const pos = new Float32Array(vtx * 3);
  const rim = new Float32Array(vtx);
  const up = new Float32Array(vtx);
  const worn = new Float32Array(vtx * 3);
  const live = new Float32Array(vtx * 3);
  const state = new Float32Array(vtx * 4);

  const triPerTile = SEGS + (RINGS.length - 1) * SEGS * 2 + SEGS * 2;
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

    const put = (x, z, r, lift = 0, u = 0) => {
      // Lifted well clear of the tile top: the decal is a coarse fan and the
      // painted undulation under it runs +-0.19.
      pos[v * 3] = x; pos[v * 3 + 1] = heightAt(x, z) + 0.30 + lift; pos[v * 3 + 2] = z;
      rim[v] = r;
      up[v] = u;
      worn[v * 3] = cw.r; worn[v * 3 + 1] = cw.g; worn[v * 3 + 2] = cw.b;
      live[v * 3] = cl.r; live[v * 3 + 1] = cl.g; live[v * 3 + 2] = cl.b;
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
    // the light wall: same ring twice, once on the ground and once in the air
    const wallBase = v;
    for (let s = 0; s < SEGS; s++) {
      const a = (s / SEGS) * TAU;
      const d = WALL_AT * hexReach(a);
      put(t.x + Math.cos(a) * d, t.z + Math.sin(a) * d, WALL_AT, 0, 0);
    }
    for (let s = 0; s < SEGS; s++) {
      const a = (s / SEGS) * TAU;
      const d = WALL_AT * hexReach(a);
      put(t.x + Math.cos(a) * d, t.z + Math.sin(a) * d, WALL_AT, WALL_H, 1);
    }

    for (let s = 0; s < SEGS; s++) {
      idx[f++] = base;
      idx[f++] = base + 1 + s;
      idx[f++] = base + 1 + ((s + 1) % SEGS);
    }
    for (let r = 0; r < RINGS.length - 1; r++) {
      const a0 = base + 1 + r * SEGS;
      const b0 = a0 + SEGS;
      for (let s = 0; s < SEGS; s++) {
        const s1 = (s + 1) % SEGS;
        idx[f++] = a0 + s; idx[f++] = b0 + s; idx[f++] = b0 + s1;
        idx[f++] = a0 + s; idx[f++] = b0 + s1; idx[f++] = a0 + s1;
      }
    }
    for (let s = 0; s < SEGS; s++) {
      const s1 = (s + 1) % SEGS;
      const lo = wallBase, hi = wallBase + SEGS;
      idx[f++] = lo + s; idx[f++] = hi + s; idx[f++] = hi + s1;
      idx[f++] = lo + s; idx[f++] = hi + s1; idx[f++] = lo + s1;
    }
  });

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aRim', new THREE.BufferAttribute(rim, 1));
  geo.setAttribute('aUp', new THREE.BufferAttribute(up, 1));
  geo.setAttribute('aWorn', new THREE.BufferAttribute(worn, 3));
  geo.setAttribute('aLive', new THREE.BufferAttribute(live, 3));
  const stateAttr = new THREE.BufferAttribute(state, 4);
  stateAttr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aState', stateAttr);
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeBoundingSphere();

  const mat = new THREE.ShaderMaterial({
    // DoubleSide is not laziness: a fan wound counter-clockwise in (x, z) faces
    // AWAY from a camera looking down +y — and the light wall has to be lit from
    // both inside the hex and outside it.
    transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide,
    // PREMULTIPLIED. This is what makes the glow a glow. With premultiplied
    // alpha the blend is `src.rgb + dst * (1 - src.a)`, so a fragment is free to
    // emit MORE colour than its own alpha carries: the mute wash and the ash
    // still darken the ground exactly as before (they emit col * a), while the
    // owner's rim and the light wall add energy on top of whatever is behind
    // them. One material, one draw call, and no additive second pass.
    premultipliedAlpha: true,
    uniforms: {
      uTime: { value: 0 },
      // The shared ownership heartbeat, straight off mood.js — the same object
      // the trees and the terrain breathe on, so nothing can drift out of step.
      uPulse: uMoodTime,
      uRim:  { value: new THREE.Color(0x93cbff) },
      // Overwritten from PLAYER_COLORS[0].light the moment the mesh is built
      // (see `MINE` below); the literal is only the value the shader compiles
      // with, kept in step by hand so a glance at this file is not misleading.
      //
      // The ADDITIVE blue is a different, far more saturated colour than the
      // decal blue above, and it has to be. Adding the pale rim colour on top of
      // sunlit sand clips red and green long before blue and the whole rim goes
      // white — which is what "make it glow" must not turn into. This one is
      // nearly pure blue, so it stays unmistakably the PLAYER'S colour all the
      // way up to the few pixels at the base of the wall where it does blow out
      // to white, and that hot core is the part that carries across the island.
      uGlow: { value: new THREE.Color(0x1878ff) },
      uWarm: { value: new THREE.Color(WARM) },
      uMute: { value: new THREE.Color(MUTE) }
    },
    vertexShader: /* glsl */`
      attribute float aRim;
      attribute float aUp;
      attribute vec3 aWorn, aLive;
      attribute vec4 aState;
      varying float vRim, vUp;
      varying vec3 vWorn, vLive;
      varying vec4 vState;
      varying vec2 vW;
      void main() {
        vRim = aRim; vUp = aUp; vWorn = aWorn; vLive = aLive; vState = aState;
        vW = position.xz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      uniform float uTime, uPulse;
      uniform vec3 uRim, uGlow, uWarm, uMute;
      varying float vRim, vUp;
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

      /* Source-over composite, so the wash, the churn, the ash and the owner
         rim stack in a defined order instead of fighting for the same lerp. */
      void over(inout vec3 col, inout float a, vec3 c2, float a2) {
        if (a2 <= 0.0005) return;
        float o = a2 + a * (1.0 - a2);
        col = (c2 * a2 + col * a * (1.0 - a2)) / max(o, 1e-5);
        a = o;
      }

      void main() {
        float work = vState.x, spent = vState.y, flash = vState.z, tone = vState.w;
        // A hex you own but have cleared out is not "available" any more, so it
        // gives up its rim, its wall and its sunlight completely until the clock
        // runs out. The glow is the promise; an empty hex has nothing to
        // promise, and the moment it refills it lights straight back up.
        float own = max(tone, 0.0) * (1.0 - spent);
        float off = max(-tone, 0.0);

        // The one heartbeat. Terrain, props, rim and wall all ride this.
        float breath = 0.5 + 0.5 * sin(uPulse * ${GLOW_HZ.toFixed(2)});

        /* ---- THE LIGHT WALL -------------------------------------------- */
        if (vUp > 0.0001 || vRim > ${(WALL_AT - 0.001).toFixed(3)}) {
          if (own < 0.004) discard;
          // brightest where it meets the ground, gone by the top
          float fall = 1.0 - vUp;
          fall = fall * fall * (0.45 + 0.55 * fall);
          // a slow vertical shimmer so it never reads as a flat printed band
          float shim = 0.86 + 0.14 * sin(uPulse * 2.7 + vW.x * 0.34 + vW.y * 0.29);
          float amp = own * fall * shim * (0.55 + 0.45 * breath);
          // a hot core right at the base — this is what carries across the
          // board, and it is only a few pixels tall
          vec3 c = mix(uGlow, uRim, smoothstep(0.26, 0.0, vUp) * 0.42);
          gl_FragColor = vec4(c * amp * 1.62, 0.0);
          return;
        }

        // The wash fills the whole prop zone and stops at the tan road strip.
        float plate = 1.0 - smoothstep(0.72, 0.865, vRim);
        float rim = smoothstep(${(RIM_AT - 0.085).toFixed(3)}, ${RIM_AT.toFixed(3)}, vRim)
                  * (1.0 - smoothstep(${RIM_AT.toFixed(3)}, ${(RIM_AT + 0.078).toFixed(3)}, vRim));
        float n = vn(vW * 0.62) * 0.62 + vn(vW * 1.9 + 7.3) * 0.38;

        vec3 col = vec3(0.0);
        float a = 0.0;
        vec3 glow = vec3(0.0);      // additive energy, premultiplied output

        // ---- 1. OFF LIMITS. Flat, cold and inert, with a black border that
        // cuts the hex away from its neighbours.
        //
        // Both numbers went UP with the duotone pass in mood.js. An unowned
        // hex now keeps its terrain's hue instead of going neutral grey, which
        // is what makes the board readable again — but hue is warmth, and the
        // "you cannot work here" read had to be paid for somewhere else. It is
        // paid here, in the one place that costs nothing: a heavier cold wash
        // across the floor and a heavier black line around the edge, so the
        // boundary between a hex that is yours and one that is not stays the
        // hardest edge on the island.
        if (off > 0.004) {
          over(col, a, uMute, 0.22 * off * plate);
          over(col, a, uMute, rim * 0.74 * off);
        }

        // ---- 2. YOURS. Warm sunlight pooling in from the border. Pulled back
        // from what it was: the cream wash was the last thing still bleaching
        // the ground and the items standing on it, and the emissive rim below
        // now says "yours" far more loudly than a translucent cream plate ever
        // could. It survives only as a faint warmth under the rim.
        if (own > 0.004) {
          float lift = 0.03 + 0.11 * smoothstep(0.15, 0.80, vRim);
          over(col, a, uWarm, lift * own * plate);
        }

        // ---- 3. worked ground spreads out of the noise field as you sweep, so
        // a half-worked hex looks like ground you have walked over.
        //
        // Both the contrast and the amount are well down on what they were, and
        // the whole thing is faded out again as the hex goes fully spent:
        //
        //   "Make the empty hexes once the resources are gone look more empty
        //    and less busy. Right now it's too overstimulating."
        //
        // Churn belongs to the ACT of harvesting — it is the mud you are making
        // right now. A finished hex should have settled.
        float churn = smoothstep(0.06, 0.52, work * 1.20 - n * 0.44);
        over(col, a, vWorn, churn * (0.26 + 0.16 * work) * (1.0 - spent * 0.72) * plate);

        // ---- 4. worked out: ONE flat, even wash and nothing else.
        //
        // Gone from here: the noise-modulated grey plate, the streaked scar
        // layer on top of it, and the dashed amber warning band that rotated
        // around the boundary. Three separate treatments fighting each other on
        // the one hex the player is meant to simply glance at and walk away
        // from. What is left is a single quiet tone in the terrain's own worked
        // colour and a soft dark edge — so the loudest thing anywhere near a
        // spent hex is the countdown badge floating over it, which is the one
        // thing on it that is actually telling you something.
        if (spent > 0.004) {
          over(col, a, vWorn * 0.86, spent * 0.30 * plate);
          over(col, a, uMute, rim * 0.34 * spent);
        }

        // ---- 5. THE GLOW. The owner's rim is no longer a translucent stripe
        // laid over the grass — it is emitted, so it brightens whatever is
        // underneath instead of averaging with it, and it breathes. Three
        // layers: a hard luminous line on the boundary, a broad bloom bleeding
        // inward across the hex floor, and a faint inner ring that keeps the
        // shape reading even when the border is behind a stand of trees.
        if (own > 0.004) {
          float pulse = 0.62 + 0.38 * breath;
          float band2 = smoothstep(0.055, 0.0, abs(vRim - 0.640));
          glow += uGlow * (rim * rim) * own * pulse * 1.55;
          glow += uRim * rim * own * pulse * 0.42;
          // The inward bloom is deliberately held to the outer third of the
          // hex. Spread across the whole floor it tinted the grass teal, and a
          // pasture that is not green is exactly the "washed out" failure this
          // glow had to avoid; kept near the border it reads as light spilling
          // in off the rim and the middle of the hex keeps its own colour.
          glow += uGlow * smoothstep(0.34, 0.90, vRim) * plate * own * (0.06 + 0.08 * breath);
          glow += uGlow * band2 * own * pulse * 0.42;
        }

        // ---- 6. the recovery beat
        if (flash > 0.004) {
          float ringR = (1.0 - flash) * 1.10;
          float band = smoothstep(0.26, 0.0, abs(vRim - ringR));
          float g = flash * flash;
          glow += vLive * min(1.0, band * 1.20 + g * 0.75) * plate;
        }

        float aOut = min(a, 0.94);
        if (aOut < 0.008 && dot(glow, vec3(0.33)) < 0.004) discard;
        gl_FragColor = vec4(col * aOut + glow, aOut);
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
    if (!t.resource) continue;
    const rec = {
      tile: t,
      mood: MOOD[t.id],
      // Clear of the tallest trees, the mountain skyline and — the one that
      // actually bit — the hero's own carry columns, which stack to 5.3.
      y: heightAt(t.x, t.z) + (t.terrain === 'mountains' ? 9.4 : 8.5),
      work: 0, alpha: 0, bob: (t.id * 0.7) % TAU,
      accent: RES_COLOR[t.resource] || 0xffc93c,
      vStart: 0, vCount: 0, rgb: [1, 1, 1]
    };
    regions.push(rec);
    byTile.set(t.id, rec);
  }

  const ground = buildOverlay(regions);
  group.add(ground.mesh);

  const atlas = markerAtlas();
  const marker = buildMarkers(regions, atlas);
  group.add(marker.mesh);

  /* The human's LIGHT variant, not the base hex: a mid blue laid over grass and
     clay at 70% alpha reads as a smudge. The pale variant holds against every
     terrain, and it follows PLAYER_COLORS so the brighter palette carries here
     without a second edit. */
  const _c = new THREE.Color();
  const MINE = (PLAYER_COLORS[0] && PLAYER_COLORS[0].light) || '#93cbff';
  ground.mat.uniforms.uRim.value.set(MINE).convertSRGBToLinear();
  marker.mat.uniforms.uOwn.value.copy(ground.mat.uniforms.uRim.value);

  const EMBER = new THREE.Color().setHex(0xff9c2a, THREE.SRGBColorSpace);
  regions.forEach((r) => {
    _c.setHex(r.accent, THREE.SRGBColorSpace);
    r.rgb = [_c.r, _c.g, _c.b];
  });

  /* --------------------------------------------------------------- stand */
  const stand = buildStand(group, dressing, stumps);

  /* -------------------------------------------------------- the two beats */

  onRestored((m) => {
    const I = match();
    if (!I) return;
    const rec = byTile.get(m.id);
    if (!rec) return;
    try {
      const t = rec.tile;
      const w = I.world;
      if (w && w.effects && w.effects.burst) w.effects.burst(t.x, t.z, t.resource);
      const p = I.state && I.state.players && I.state.players[0];
      const d = p ? Math.hypot(p.x - t.x, p.z - t.z) : 999;
      if (w && w.audio && w.audio.sfx) {
        w.audio.sfx('upgrade', { gain: d < 34 ? 0.6 : 0.22, at: { x: t.x, z: t.z } });
      }
      if (d < 26 && w && w.camera && w.camera.shake) w.camera.shake(0.08);
      // Toast only for a hex you own AND are near. Eighteen hexes refilling on
      // their own clocks will otherwise stack the bottom-left rail high enough
      // to walk off the bottom of a 444-pixel phone screen.
      if (m.own > 0.4 && d < 30 && I.game && I.game.toast) {
        I.game.toast('Grown back — go again');
      }
    } catch (e) { /* presentation is always optional */ }
  });

  onSpent((m) => {
    const I = match();
    if (!I) return;
    const rec = byTile.get(m.id);
    if (!rec) return;
    try {
      const p = I.state && I.state.players && I.state.players[0];
      if (!p) return;
      if (Math.hypot(p.x - rec.tile.x, p.z - rec.tile.z) > 30) return;
      if (I.game && I.game.toast) {
        I.game.toast(`Cleared out — back in ${Math.round(m.seconds)}s`, 'warn');
      }
      if (I.world && I.world.audio && I.world.audio.sfx) {
        I.world.audio.sfx('deny', { gain: 0.45, at: { x: rec.tile.x, z: rec.tile.z } });
      }
    } catch (e) { /* optional */ }
  });

  /* ------------------------------------------------------------------ loop */

  let clock = 0;

  function update(dt) {
    clock += dt;
    ground.mat.uniforms.uTime.value = clock;
    marker.mat.uniforms.uTime.value = clock;

    syncMood();
    stand.update(dt);

    const st = ground.state;
    const md = marker.aData.array;
    const mp = marker.aPos.array;
    const ms = marker.aSize.array;
    const mo = marker.aOwn.array;
    const mc = marker.aCol.array;
    let groundDirty = false;

    /* Once the victory flood is running, this whole layer gets out of the way.
       The rims, the light walls, the worked ground and the countdown badges all
       belong to a match that is still being played; what the player is being
       shown now is the island turning the winner's colour, and it has to read
       as ONE thing. Each hex fades out exactly as the wave reaches it, so the
       overlay dissolves under the front rather than snapping off. */
    const flooding = victoryFloodActive();

    for (let i = 0; i < regions.length; i++) {
      const r = regions[i];
      const m = r.mood;
      const fade = flooding ? 1 - clamp01(floodOf(r.tile.id) * 1.6) : 1;

      // How worked-over the hex looks: how much of its field is still standing.
      const wantWork = m.exhausted ? 1 : clamp01(1 - m.fraction);
      const kw = Math.min(1, dt * (wantWork > r.work ? 3.4 : 2.4));
      r.work += (wantWork - r.work) * kw;

      const sWork = r.work * fade;
      const sSpent = m.spent * fade;
      const sFlash = m.flash * fade;
      const sTone = m.tone * fade;
      const o = r.vStart * 4;
      const moved = Math.abs(st[o] - sWork) > 0.0015
        || Math.abs(st[o + 1] - sSpent) > 0.0015
        || Math.abs(st[o + 2] - sFlash) > 0.0015
        || Math.abs(st[o + 3] - sTone) > 0.0015;
      if (moved) {
        for (let v = 0; v < r.vCount; v++) {
          const k = (r.vStart + v) * 4;
          st[k] = sWork;
          st[k + 1] = sSpent;
          st[k + 2] = sFlash;
          st[k + 3] = sTone;
        }
        groundDirty = true;
      }

      /* ---- the clock overhead ----
       * Silent unless it has something to say. Nineteen permanent tabs became
       * two or three, and the ones that are left are twice the size. */
      let wantA = 0, size = 6.4, fill = 1, cell = -1, spent = 0;
      let accent = r.rgb;
      if (m.exhausted) {
        // Bigger than it was. With the residue and the ground treatment under
        // it both pulled right back, the badge is now unambiguously the loudest
        // thing on a spent hex — which is what the player asked for.
        wantA = 1; size = 8.6; spent = 1;
        fill = clamp01(m.progress);
        cell = Math.max(0, Math.min(MAX_SEC, Math.ceil(m.seconds - 0.001)));
        accent = [EMBER.r, EMBER.g, EMBER.b];
      } else if (m.blocked) {
        wantA = 1; size = 6.4; spent = 1; fill = 0;
        cell = GLYPH.blocked;
        accent = [EMBER.r, EMBER.g, EMBER.b];
      }
      wantA *= fade;
      r.alpha += (wantA - r.alpha) * Math.min(1, dt * (wantA > r.alpha ? 8 : 3.6));

      r.bob += dt * 1.5;
      const pop = m.flash > 0.01 ? 1 + m.flash * 0.5 : 1;
      const pulse = spent ? 1 + Math.sin(clock * 3.6) * 0.05 : 1;
      mp[i * 3] = r.tile.x;
      mp[i * 3 + 1] = r.y + Math.sin(r.bob) * 0.28;
      mp[i * 3 + 2] = r.tile.z;
      ms[i] = size * pop * pulse * (0.45 + r.alpha * 0.55);
      md[i * 4] = fill;
      md[i * 4 + 1] = r.alpha;
      md[i * 4 + 2] = spent;
      md[i * 4 + 3] = cell;
      mo[i] = clamp01(m.tone);
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

    /** Debug / capture hook: how much of the dressing has answered. */
    debug(tileId) { return stand.debug(tileId); },

    /** Debug / capture hook: what every hex is currently saying. */
    readout() {
      return regions.map(r => {
        const m = r.mood;
        return {
          tile: r.tile.id, terrain: r.tile.terrain,
          fraction: +m.fraction.toFixed(2),
          remaining: m.remaining, capacity: m.capacity,
          work: +r.work.toFixed(2), spent: +m.spent.toFixed(2),
          tone: +m.tone.toFixed(2), own: +m.own.toFixed(2),
          blocked: m.blocked, exhausted: m.exhausted,
          seconds: +m.seconds.toFixed(1), progress: +m.progress.toFixed(2)
        };
      });
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
