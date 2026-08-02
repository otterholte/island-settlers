/**
 * Island Settlers — the RECOVERY CLOCK over a worked-out hex.
 *
 *   buildMarkers(list, atlas) -> { mesh, geo, mat, quad, aPos, aData, aCol,
 *                                  aSize, aOwn, triangles }
 *   markerAtlas() -> THREE.CanvasTexture | null
 *
 * One shader-driven quad per hex, floating overhead on a pointer tail. It is
 * silent almost all of the time. It has exactly two things to say:
 *
 *   WORKED OUT  ash face, oxblood rim, a THICK ember arc sweeping all the way
 *               round as the hex counts itself back in, and the seconds left
 *               painted across the middle in a numeral you can read from the
 *               far side of the island. This is the player's own brief:
 *
 *                 "it has a timer bar or circle above it, showing the visual of
 *                  when it will be restored ... if you cut all of the trees
 *                  down, you have to wait for them all to grow again."
 *
 *   BLOCKED     the Raider has the hex shut: ash face, a barred glyph.
 *
 * The x2 / x3 ownership badges are GONE. Ownership is a hard gate now, not a
 * multiplier, and the player asked for the badges to go with it — the hexes you
 * own are said by the ground and the light, not by a floating number.
 *
 * All nineteen ride ONE InstancedBufferGeometry — a plain Mesh, not an
 * InstancedMesh, because the badge billboards in view space and has no use for
 * an instanceMatrix. One draw call, 38 triangles, no shadow pass.
 *
 * Owner: World agent.
 */

import * as THREE from 'three';
import { PLAYER_COLORS } from '../core/constants.js';

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

/* The longest a hex ever stays bare is TILE_REGEN[1] = 64s, so the atlas holds
   0..64 as painted numerals with room to spare. 9x9 cells at 112px. */
const GRID = 9, CELL = 112;
const MAX_SEC = 64;

/** Atlas cell indices the region layer asks for by name. */
export const GLYPH = { blocked: 65, lock: 66, none: 67 };

export function markerAtlas() {
  return texture(CELL * GRID, CELL * GRID, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';

    const cell = (n, draw) => {
      const ox = (n % GRID) * CELL, oy = ((n / GRID) | 0) * CELL;
      ctx.save();
      ctx.translate(ox + CELL / 2, oy + CELL / 2);
      draw();
      ctx.restore();
    };

    const stroked = (label, size) => {
      ctx.font = `900 ${size}px system-ui, sans-serif`;
      ctx.strokeStyle = '#fff3d0'; ctx.lineWidth = 18;
      ctx.strokeText(label, 0, 2);
      ctx.fillStyle = '#1d1006';
      ctx.fillText(label, 0, 2);
    };

    for (let n = 0; n <= MAX_SEC; n++) {
      const label = String(n);
      cell(n, () => stroked(label, label.length > 1 ? 72 : 90));
    }

    // barred — the Raider has this hex shut
    cell(GLYPH.blocked, () => {
      ctx.lineCap = 'round';
      ctx.strokeStyle = '#fff3d0'; ctx.lineWidth = 28;
      for (const s of [-1, 1]) {
        ctx.beginPath(); ctx.moveTo(-30 * s, -30); ctx.lineTo(30 * s, 30); ctx.stroke();
      }
      ctx.strokeStyle = '#1d1006'; ctx.lineWidth = 16;
      for (const s of [-1, 1]) {
        ctx.beginPath(); ctx.moveTo(-30 * s, -30); ctx.lineTo(30 * s, 30); ctx.stroke();
      }
    });

    // a padlock — "you own no corner of this hex"
    cell(GLYPH.lock, () => {
      ctx.strokeStyle = '#1d1006'; ctx.lineWidth = 13; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.arc(0, -14, 20, Math.PI, 0); ctx.stroke();
      ctx.fillStyle = '#1d1006';
      ctx.beginPath(); ctx.rect(-28, -12, 56, 44); ctx.fill();
      ctx.fillStyle = '#fff3d0';
      ctx.beginPath(); ctx.arc(0, 8, 7, 0, Math.PI * 2); ctx.fill();
    });
  });
}

export function buildMarkers(list, atlas) {
  const n = list.length;
  const quad = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = quad.index;
  geo.setAttribute('position', quad.attributes.position);
  geo.setAttribute('uv', quad.attributes.uv);
  geo.instanceCount = n;

  const aPos = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
  const aData = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
  const aCol = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
  const aSize = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
  const aOwn = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
  [aPos, aData, aCol, aSize, aOwn].forEach(a => a.setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('aPos', aPos);
  geo.setAttribute('aData', aData);
  geo.setAttribute('aCol', aCol);
  geo.setAttribute('aSize', aSize);
  geo.setAttribute('aOwn', aOwn);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 6, 0), 220);

  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, depthTest: false,
    uniforms: {
      uAtlas: { value: atlas },
      uHasAtlas: { value: atlas ? 1 : 0 },
      uGrid: { value: GRID },
      // The human's own pale variant, read from PLAYER_COLORS so the badge's
      // halo tracks the player palette instead of drifting off it.
      uOwn: { value: new THREE.Color((PLAYER_COLORS[0] && PLAYER_COLORS[0].light) || '#93cbff') },
      uTime: { value: 0 }
    },
    vertexShader: /* glsl */`
      attribute vec3 aPos;
      attribute vec4 aData;
      attribute vec3 aCol;
      attribute float aSize;
      attribute float aOwn;
      varying vec2 vQ;
      varying vec4 vData;
      varying vec3 vCol;
      varying float vOwn;
      void main() {
        vQ = uv; vData = aData; vCol = aCol; vOwn = aOwn;
        vec4 mv = modelViewMatrix * vec4(aPos, 1.0);
        mv.xy += position.xy * aSize;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */`
      uniform sampler2D uAtlas;
      uniform vec3 uOwn;
      uniform float uHasAtlas, uTime, uGrid;
      varying vec2 vQ;
      varying vec4 vData;
      varying vec3 vCol;
      varying float vOwn;
      const float TAU = 6.2831853;

      void main() {
        float alpha = vData.y;
        if (alpha < 0.005) discard;
        float progress = vData.x;     // 0 = just cleared, 1 = back
        float spent = vData.z;
        float cell = vData.w;

        // Disc in the top two thirds of the quad, a long pointer tail below it.
        vec2 q = vQ * 2.0 - 1.0;
        vec2 p = vec2(q.x, q.y - 0.28) / 0.68;
        float d = length(p);

        vec3 col = vec3(0.0);
        float a = 0.0;

        vec3 dark = mix(vec3(0.075, 0.048, 0.028), vec3(0.30, 0.055, 0.035), spent);
        vec3 face = mix(vec3(0.955, 0.900, 0.760), vec3(0.365, 0.355, 0.360), spent);

        // ---- a breathing halo so a worked-out hex is findable across the board
        {
          float pulse = 0.62 + 0.38 * sin(uTime * 3.0);
          float glow = smoothstep(1.42, 1.00, d) * pulse;
          col = mix(uOwn, vCol, spent);
          a = glow * (0.20 + 0.34 * spent);
        }

        // ---- pointer tail
        float ty = (-q.y - 0.28) / 0.72;
        if (ty > 0.0 && ty < 1.0 && abs(q.x) < 0.17 * (1.0 - ty * ty * 0.85)) {
          col = mix(dark, dark * 1.7, ty);
          a = 1.0 - ty * 0.22;
        }

        // ---- badge body
        float body = smoothstep(1.00, 0.955, d);
        float inner = smoothstep(0.740, 0.700, d);
        col = mix(col, dark, body);
        a = max(a, body);
        col = mix(col, face, inner);
        float bev = inner * smoothstep(0.10, 0.60, p.y) * 0.26;
        col = mix(col, vec3(1.0), bev);

        // ---- THE CLOCK. A thick arc sweeping a full turn as the hex comes
        // back: the whole point of the badge, so it gets the whole annulus
        // between the face and the rim rather than a thin hairline.
        float ann = smoothstep(0.700, 0.735, d) * smoothstep(0.965, 0.930, d);
        if (ann > 0.001) {
          float t = fract(atan(p.x, p.y) / TAU);
          vec3 track = vec3(0.16, 0.12, 0.09);
          float lit = step(t, progress);
          float head = smoothstep(0.035, 0.0, abs(t - progress));
          vec3 arc = mix(track, vCol, lit);
          arc = mix(arc, vec3(1.0), head * 0.9);
          col = mix(col, arc, ann);
          a = max(a, ann * 0.98);
        }

        // ---- centre glyph: the seconds left, or the barred / locked mark
        if (uHasAtlas > 0.5 && cell >= 0.0) {
          vec2 g2 = p / 0.86 + 0.5;
          if (g2.x > 0.0 && g2.x < 1.0 && g2.y > 0.0 && g2.y < 1.0) {
            vec2 c = vec2(mod(cell, uGrid), floor(cell / uGrid));
            vec2 uvv = vec2(c.x / uGrid, 1.0 - (c.y + 1.0) / uGrid) + g2 / uGrid;
            vec4 g = texture2D(uAtlas, uvv);
            col = mix(col, g.rgb, g.a);
            a = max(a, g.a * body);
          }
        }

        a *= alpha;
        if (a < 0.006) discard;
        gl_FragColor = vec4(col, a);
      }
    `
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'region-marker';
  mesh.renderOrder = 18;
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return { mesh, geo, mat, quad, aPos, aData, aCol, aSize, aOwn, triangles: n * 2, MAX_SEC };
}

export { MAX_SEC };
export default buildMarkers;
