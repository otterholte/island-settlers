/**
 * Island Settlers — the life of a REGION.
 *
 *   buildRegions(group, dressing) -> {
 *     update(dt), drawCalls, triangles, dispose()
 *   }
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * The player said it plainly:
 *
 *   "What I need to be obvious is when you can no longer pick up resources
 *    from a specific tile, and when that timer resets, so I know when I can
 *    go back."
 *
 *   "When I collect all of the wood from a wood tile ... it disappears
 *    slightly for each section I walk over, until that tile has no more
 *    visible tree resources — they all look cut down."
 *
 * `board/nodes.js` now scopes recovery to the whole region: a felled node stays
 * down until every node on its tile is down, the tile then goes dormant for
 * TILE_REGROW_SEC and the whole region comes back at once. That gives a region
 * a real life cycle. This file is the READ on that cycle, at region scale:
 *
 *   1. WORKED GROUND. A terrain-conforming decal over each hex that churns up
 *      as the region is worked — patches of bare, dug, trampled earth spreading
 *      out from the nodes you have emptied. One merged mesh, one draw call.
 *
 *   2. THE DRESSING RESPONDS. The ~36 decorative spruces on a forest tile, the
 *      118 wheat tufts on a fields tile, the pasture grass: every one of them is
 *      assigned to its NEAREST gather node, and comes down / gets cropped / goes
 *      straw-coloured as THAT node is emptied. Walk the tile harvesting and it
 *      clears section by section under your feet. Nothing is ever deleted and no
 *      prop count changes — it is all instance matrices and instance colours,
 *      and it all reverses on regrowth.
 *
 *   3. THE MARKER (regionmark.js). One shader-driven instanced quad per tile.
 *      While a region still has stock it shows a quiet segmented ring in the
 *      resource colour — one lit segment per standing node. The moment the
 *      region is exhausted it turns ash and ember, and shows the SECONDS LEFT
 *      as a big number with a countdown arc sweeping around it. 19 markers,
 *      one draw call.
 *
 *   4. THE RECOVERY BEAT. When the region comes back the ground flashes green
 *      from the centre outward, the toppled dressing stands back up in a wave,
 *      rings pop over every node and the marker bursts and fades.
 *
 * Owner: World agent.
 */

import * as THREE from 'three';
import { NODE_CAPACITY, RES_COLOR } from '../core/constants.js';
import { tiles } from '../board/layout.js';
import {
  nodesByTile, tileRemaining, tileRecovery, isTileExhausted, TILE_REGROW_SEC
} from '../board/nodes.js';
import { heightAt, APOTHEM } from './terrain.js';
import { setInstance } from './geo.js';
import { buildMarkers, markerAtlas } from './regionmark.js';

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
  forest:    0x4a3524,   // duff, sawdust and root-torn soil
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

/* =========================================================== ground overlay */

const SEGS = 12;                       // hex corners land on 30 degree steps
const RINGS = [0.34, 0.66, 0.90];

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
  const state = new Float32Array(vtx * 3);

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
      // Lifted well clear of the tile top: the decal is a coarse 37-vertex fan
      // and the painted undulation under it runs +-0.19, so a tighter offset
      // sinks whole wedges of it below the ground and the depth test eats them.
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
        put(t.x + Math.cos(a) * d, t.z + Math.sin(a) * d, RINGS[r] / RINGS[RINGS.length - 1]);
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
  const stateAttr = new THREE.BufferAttribute(state, 3);
  stateAttr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aState', stateAttr);
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeBoundingSphere();

  const mat = new THREE.ShaderMaterial({
    // DoubleSide is not laziness: a fan wound counter-clockwise in (x, z) faces
    // AWAY from a camera looking down +y, because (x, z) is left-handed from
    // above. Front-side only and the whole decal is invisible.
    transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide,
    uniforms: { uTime: { value: 0 } },
    vertexShader: /* glsl */`
      attribute float aRim;
      attribute vec3 aWorn, aLive, aState;
      varying float vRim;
      varying vec3 vWorn, vLive, vState;
      varying vec2 vW;
      void main() {
        vRim = aRim; vWorn = aWorn; vLive = aLive; vState = aState;
        vW = position.xz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      uniform float uTime;
      varying float vRim;
      varying vec3 vWorn, vLive, vState;
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

      void main() {
        float work = vState.x, spent = vState.y, flash = vState.z;
        if (work < 0.004 && spent < 0.004 && flash < 0.004) discard;

        float edge = 1.0 - smoothstep(0.66, 1.0, vRim);
        float n = vn(vW * 0.62) * 0.62 + vn(vW * 1.9 + 7.3) * 0.38;

        // Churned patches spread out of the noise field as the work level
        // climbs, so a half-worked region looks blotchy rather than uniformly
        // tinted — it reads as ground somebody has actually walked over.
        // ('patch' is a reserved word in GLSL ES 3.00 — do not rename this back)
        float churn = smoothstep(0.0, 0.30, work * 1.42 - n * 0.82);
        float a = churn * (0.44 + 0.26 * work);

        vec3 col = vWorn;

        // Exhausted: the whole hex drops to ash. Mixing a neutral grey over the
        // painted terrain is literal desaturation, which is what we want.
        vec3 ash = vec3(0.60, 0.605, 0.625);
        col = mix(col, ash, spent * 0.80);
        a = mix(a, max(a, 0.50 + 0.12 * n), spent);

        // dug scars / drag marks, only once the place is spent
        float scar = smoothstep(0.52, 0.92, vn(vW * 1.05 + 21.0)) * spent;
        col = mix(col, vWorn * 0.48, scar * 0.65);
        a += scar * 0.14;

        a *= edge;

        if (flash > 0.004) {
          float ringR = (1.0 - flash) * 1.30;
          float band = smoothstep(0.30, 0.0, abs(vRim - ringR));
          float glow = flash * flash;
          col = mix(col, vLive, min(1.0, band + glow * 0.85));
          a = max(a * (1.0 - glow), (band * 0.92 + glow * 0.50) * edge);
        }

        if (a < 0.008) discard;
        gl_FragColor = vec4(col, min(a, 0.88));
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


/* ================================================================ dressing */
/*
 * How each dressing kit answers to the harvest, per terrain. `fell` topples the
 * prop flat (a spruce lying over is exactly what slash looks like), `crop` cuts
 * it down to stubble, `flatten` mashes it into the ground, `wilt` only changes
 * colour. Nothing is hidden, nothing is removed, and every one of them is a
 * pure instance-matrix / instance-colour change that reverses on regrowth.
 */
const ROLE = {
  forest: {
    conifer: 'fell', coniferShort: 'fell', broadleaf: 'fell',
    undergrowth: 'flatten', grass: 'crop', flower: 'crop', rockSmall: 'wilt'
  },
  fields: {
    wheat: 'crop', grass: 'crop', undergrowth: 'flatten',
    broadleaf: 'wilt', rockSmall: 'wilt', flower: 'crop'
  },
  pasture: {
    grass: 'crop', flower: 'crop', undergrowth: 'flatten',
    coniferShort: 'wilt', broadleaf: 'wilt', rockSmall: 'wilt'
  },
  hills: {
    grass: 'crop', undergrowth: 'flatten', coniferShort: 'fell',
    rockSmall: 'wilt', boulder: 'wilt', flower: 'crop'
  },
  mountains: {
    grass: 'crop', conifer: 'wilt', coniferShort: 'wilt',
    rockSmall: 'wilt', boulder: 'wilt'
  }
};

/* Vertical squash and horizontal pinch a `crop` leaves behind. */
const CROP = {
  wheat:  [0.90, 0.13],
  grass:  [0.94, 0.38],
  flower: [0.78, 0.22],
  undergrowth: [0.90, 0.26]
};

/* What a felled prop shrinks to. A whole spruce laid flat keeps its canopy
   pointing at the sun and reads BRIGHTER than it did standing — which is the
   opposite of the intent. Cut down to half and gone brown it reads as brash. */
const FELL = [0.56, 0.44];

/* instanceColor multiplier at full response — straw, dust and dead wood. */
const WORN_MUL = {
  conifer: [0.40, 0.33, 0.23], coniferShort: [0.40, 0.33, 0.23],
  broadleaf: [0.46, 0.38, 0.26], undergrowth: [0.62, 0.54, 0.38],
  grass: [0.80, 0.68, 0.40], flower: [0.74, 0.66, 0.46],
  wheat: [0.80, 0.70, 0.48], rockSmall: [0.76, 0.74, 0.72],
  boulder: [0.76, 0.74, 0.72]
};

const RATE = { fell: 2.3, crop: 1.9, flatten: 2.1, wilt: 1.5 };

/* ================================================================= factory */

export function buildRegions(group, dressing) {
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
      work: 0, spent: 0, flash: 0,
      fraction: 1, seconds: 0, progress: 1, exhausted: false,
      wasExhausted: false, alpha: 0, bob: (t.id * 0.7) % TAU,
      accent: RES_COLOR[t.resource] || 0xffc93c,
      vStart: 0, vCount: 0, sweep: 0,
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

  /* Two accents per badge: the resource colour while the region still has
     stock, and a hot ember while it is counting itself back in. */
  const _c = new THREE.Color();
  const EMBER = new THREE.Color().setHex(0xff9c2a, THREE.SRGBColorSpace);
  regions.forEach((r, i) => {
    _c.setHex(r.accent, THREE.SRGBColorSpace);
    r.rgb = [_c.r, _c.g, _c.b];
  });

  /* ------------------------------------------------------------ dressing */
  const items = [];
  const byNode = new Map();
  const kitMeshes = [];
  const kitDirty = new Set();

  if (dressing) {
    for (const kit in dressing) {
      const { mesh, list } = dressing[kit];
      if (!mesh || !list || !mesh.instanceColor) continue;
      let used = false;
      const base = mesh.instanceColor.array;
      for (let i = 0; i < list.length; i++) {
        const o = list[i];
        const reg = byTile.get(o.tile);
        if (!reg) continue;
        const role = (ROLE[reg.tile.terrain] || {})[kit];
        if (!role) continue;

        // Every prop belongs to the gather node it stands closest to, so the
        // region empties around the node you are actually working.
        let owner = null, bd = 1e9;
        for (const nd of reg.nodes) {
          const d = (nd.x - o.x) * (nd.x - o.x) + (nd.z - o.z) * (nd.z - o.z);
          if (d < bd) { bd = d; owner = nd; }
        }
        if (!owner) continue;

        const hash = ((o.x * 71.3 + o.z * 137.9) * 1000) | 0;
        const r01 = ((hash ^ (hash >>> 11)) >>> 0) % 997 / 997;
        const it = {
          kit, mesh, i, role, owner, reg,
          x: o.x, y: o.y, z: o.z, ry: o.ry, s: o.s, sy: o.sy,
          rx: o.rx || 0, rz: o.rz || 0,
          br: base[i * 3], bg: base[i * 3 + 1], bb: base[i * 3 + 2],
          cur: 0, tgt: 0, wait: 0,
          // discrete props come down one node-cycle at a time; continuous ones
          // (grass, wheat) just follow the level
          step: (role === 'fell' || role === 'flatten')
            ? (Math.floor(r01 * NODE_CAPACITY) + 1) / NODE_CAPACITY : 0,
          lean: (r01 < 0.5 ? -1 : 1) * (1.24 + r01 * 0.42),
          spin: (r01 - 0.5) * 0.9,
          d: Math.hypot(o.x - reg.tile.x, o.z - reg.tile.z) / APOTHEM
        };
        items.push(it);
        let arr = byNode.get(owner.id);
        if (!arr) byNode.set(owner.id, arr = []);
        arr.push(it);
        used = true;
      }
      if (used) {
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        kitMeshes.push(mesh);
      }
    }
  }

  const active = new Set();

  function writeItem(it) {
    const c = it.cur;
    let s = it.s, sy = it.sy, rz = it.rz, ry = it.ry, y = it.y;
    if (c > 0.0005) {
      if (it.role === 'fell') {
        rz += it.lean * c;
        ry += it.spin * c;
        y -= 0.10 * c;
        s = it.s * (1 + (FELL[0] - 1) * c);
        sy = it.sy * (1 + (FELL[1] - 1) * c);
      } else if (it.role === 'crop' || it.role === 'flatten') {
        const k = CROP[it.kit] || [0.9, 0.3];
        s = it.s * (1 + (k[0] - 1) * c);
        sy = it.sy * (1 + (k[1] - 1) * c);
        if (it.role === 'flatten') rz += it.lean * 0.35 * c;
      }
    }
    setInstance(it.mesh, it.i, it.x, y, it.z, ry, Math.max(s, 1e-4), Math.max(sy, 1e-4), it.rx, rz);

    const w = WORN_MUL[it.kit] || [0.8, 0.75, 0.6];
    const arr = it.mesh.instanceColor.array;
    arr[it.i * 3] = it.br * (1 + (w[0] - 1) * c);
    arr[it.i * 3 + 1] = it.bg * (1 + (w[1] - 1) * c);
    arr[it.i * 3 + 2] = it.bb * (1 + (w[2] - 1) * c);
    kitDirty.add(it.mesh);
  }

  function retarget(node, level, sweep) {
    const arr = byNode.get(node.id);
    if (!arr) return;
    for (const it of arr) {
      const want = it.step > 0 ? (level >= it.step - 1e-4 ? 1 : 0) : level;
      if (Math.abs(want - it.tgt) < 1e-3) continue;
      it.tgt = want;
      it.wait = sweep ? it.d * 0.62 + (it.step * 0.11) : 0;
      active.add(it);
    }
  }

  /* -------------------------------------------------------- recovery beat */

  function celebrate(rec) {
    const I = match();
    if (!I) return;
    const w = I.world;
    if (!w) return;
    try {
      const t = rec.tile;
      if (w.effects && w.effects.ring) {
        for (let k = 0; k < rec.nodes.length; k += 2) {
          const n = rec.nodes[k];
          w.effects.ring(n.x, n.z, n.resource);
        }
      }
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
  const lastLevel = new Map();

  function sample() {
    const I = match();
    const now = I && I.state ? I.state.time : clock;

    for (const rec of regions) {
      const rem = tileRemaining(rec.tile.id);
      const rc = tileRecovery(rec.tile.id, now);
      rec.fraction = rem.fraction;
      rec.exhausted = isTileExhausted(rec.tile.id);
      rec.seconds = rc.secondsLeft;
      rec.progress = rc.progress;

      if (rec.exhausted && !rec.wasExhausted) {
        rec.wasExhausted = true;
        announceSpent(rec);
      } else if (!rec.exhausted && rec.wasExhausted) {
        rec.wasExhausted = false;
        rec.flash = 1;
        rec.sweep = clock;
        celebrate(rec);
      }

      const sweeping = clock - rec.sweep < 2.4;
      for (const n of rec.nodes) {
        const level = 1 - clamp01(Math.max(0, n.remaining) / NODE_CAPACITY);
        if (lastLevel.get(n.id) === level) continue;
        lastLevel.set(n.id, level);
        retarget(n, level, sweeping && level === 0);
      }
    }
  }

  function update(dt) {
    clock += dt;
    ground.mat.uniforms.uTime.value = clock;
    marker.mat.uniforms.uTime.value = clock;

    if ((poll -= dt) <= 0) { poll = 0.12; sample(); }

    /* ---- dressing --------------------------------------------------- */
    if (active.size) {
      for (const it of Array.from(active)) {
        if (it.wait > 0) { it.wait -= dt; continue; }
        const k = Math.min(1, dt * (RATE[it.role] || 1.6));
        it.cur += (it.tgt - it.cur) * k;
        if (Math.abs(it.tgt - it.cur) < 0.004) { it.cur = it.tgt; active.delete(it); }
        writeItem(it);
      }
      for (const m of kitDirty) {
        m.instanceMatrix.needsUpdate = true;
        if (m.instanceColor) m.instanceColor.needsUpdate = true;
      }
      kitDirty.clear();
    }

    /* ---- ground + markers -------------------------------------------- */
    const st = ground.state;
    const md = marker.aData.array;
    const mp = marker.aPos.array;
    const ms = marker.aSize.array;
    let groundDirty = false;

    for (let i = 0; i < regions.length; i++) {
      const r = regions[i];

      // How worked-over the region looks: the standing stock drives it, and an
      // exhausted region is pinned at fully worked.
      const wantWork = r.exhausted ? 1 : clamp01(1 - r.fraction);
      const wantSpent = r.exhausted ? 1 : 0;
      const kw = Math.min(1, dt * (wantWork > r.work ? 3.0 : 2.2));
      r.work += (wantWork - r.work) * kw;
      r.spent += (wantSpent - r.spent) * Math.min(1, dt * (wantSpent ? 3.4 : 4.2));
      if (r.flash > 0) r.flash = Math.max(0, r.flash - dt * 0.52);

      // Per-node churn levels, smoothed, then splashed onto the vertices that
      // node owns. `r.work` acts as a floor so the hex still reads as a single
      // worked region rather than seven unrelated puddles.
      let moved = Math.abs(st[r.vStart * 3 + 1] - r.spent) > 0.0015
        || Math.abs(st[r.vStart * 3 + 2] - r.flash) > 0.0015;
      const floor = r.work * 0.42;
      for (let k = 0; k < r.nodes.length; k++) {
        const want = 1 - clamp01(Math.max(0, r.nodes[k].remaining) / NODE_CAPACITY);
        const cur = r.lvl[k] + (want - r.lvl[k]) * Math.min(1, dt * 2.6);
        if (Math.abs(cur - r.lvl[k]) > 0.0015) moved = true;
        r.lvl[k] = cur;
      }
      if (moved) {
        for (let v = 0; v < r.vCount; v++) {
          const o = (r.vStart + v) * 3;
          st[o] = Math.max(floor, r.lvl[r.vn[v]]);
          st[o + 1] = r.spent;
          st[o + 2] = r.flash;
        }
        groundDirty = true;
      }

      /* ---- the marker ---- */
      // Untouched regions stay silent; the board should only carry a badge
      // where there is something to say.
      // Quad size, not disc size: the disc is 0.66 of the quad and the rest is
      // the pointer tail.
      let wantA = 0, size = 4.4, fill = r.fraction, cell = 22, spent = 0;
      if (r.exhausted) {
        wantA = 1; size = 6.8; spent = 1;
        fill = clamp01(r.progress);
        cell = Math.max(0, Math.min(20, Math.ceil(r.seconds - 0.001)));
      } else if (r.fraction < 0.999) {
        wantA = 0.9; size = 4.6;
      } else if (r.flash > 0.01) {
        wantA = r.flash;
      }
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

      const mc = marker.aCol.array;
      const c = spent ? EMBER : null;
      mc[i * 3] = c ? c.r : r.rgb[0];
      mc[i * 3 + 1] = c ? c.g : r.rgb[1];
      mc[i * 3 + 2] = c ? c.b : r.rgb[2];
    }

    if (groundDirty) ground.stateAttr.needsUpdate = true;
    marker.aData.needsUpdate = true;
    marker.aPos.needsUpdate = true;
    marker.aSize.needsUpdate = true;
    marker.aCol.needsUpdate = true;
  }

  return {
    update,
    regions,
    drawCalls: 2,
    triangles: ground.triangles + marker.triangles,

    /** Debug / capture hook: how much dressing has answered the harvest. */
    debug(tileId) {
      let total = 0, moved = 0, mid = 0;
      const roles = {};
      for (const it of items) {
        if (tileId !== undefined && it.reg.tile.id !== tileId) continue;
        total++;
        roles[it.role] = (roles[it.role] || 0) + 1;
        if (it.cur > 0.8) moved++;
        else if (it.cur > 0.05) mid++;
      }
      return { total, moved, mid, active: active.size, roles };
    },

    /** Debug / capture hook: what the badge is currently saying. */
    readout() {
      return regions.map(r => ({
        tile: r.tile.id, terrain: r.tile.terrain,
        fraction: +r.fraction.toFixed(2),
        work: +r.work.toFixed(2), spent: +r.spent.toFixed(2),
        exhausted: r.exhausted, seconds: +r.seconds.toFixed(1)
      }));
    },

    dispose() {
      ground.geo.dispose(); ground.mat.dispose();
      marker.geo.dispose(); marker.quad.dispose(); marker.mat.dispose();
      if (atlas) atlas.dispose();
    }
  };
}

export default buildRegions;
