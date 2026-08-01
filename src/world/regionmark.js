/**
 * Island Settlers — the region badge.
 *
 *   buildMarkers(list, atlas) -> { mesh, geo, mat, quad, aPos, aData, aCol,
 *                                  aSize, aOwn, triangles }
 *   markerAtlas() -> THREE.CanvasTexture | null
 *
 * One shader-driven quad per hex, floating overhead on a pointer tail. The
 * board used to badge every region all the time and the screen turned into a
 * noticeboard, so a badge now appears only when it has something to say:
 *
 *   YOURS       cream face inside a thick rim in YOUR colour, an outer halo,
 *               a segmented ring showing what is still standing, and the
 *               ownership multiplier — x2 for a settlement, x3 for a city —
 *               painted big in the middle. This is the "these are your
 *               high-yield regions" read.
 *   WORKED OUT  ash face, oxblood rim, and an ember arc sweeping round as the
 *               region counts itself back in, with the SECONDS LEFT painted in
 *               the middle. Readable across the island.
 *   BLOCKED     the Raider has the region shut: ash face, a barred glyph.
 *   ANYTHING ELSE — silent. No badge at all.
 *
 * All nineteen ride ONE InstancedBufferGeometry — a plain Mesh, not an
 * InstancedMesh, because the badge billboards itself in view space and has no
 * use for an instanceMatrix. One draw call, 38 triangles, no shadow pass.
 *
 * Owner: World agent.
 */

import * as THREE from 'three';

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

const GRID = 5, CELL = 128;

/** Atlas cell indices the region layer asks for by name. */
export const GLYPH = { blocked: 21, sprout: 22, mult2: 23, mult3: 24 };

/** 0..20 as painted numerals, a barred glyph, a sprout, and x2 / x3. */
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
      ctx.strokeStyle = '#fff6dc'; ctx.lineWidth = 20;
      ctx.strokeText(label, 0, 3);
      ctx.fillStyle = '#241505';
      ctx.fillText(label, 0, 3);
    };

    for (let n = 0; n <= 20; n++) {
      const label = String(n);
      cell(n, () => stroked(label, label.length > 1 ? 82 : 100));
    }

    // 21 — barred: the Raider has this region shut
    cell(GLYPH.blocked, () => {
      ctx.strokeStyle = '#fff6dc'; ctx.lineWidth = 30; ctx.lineCap = 'round';
      for (const s of [-1, 1]) {
        ctx.beginPath(); ctx.moveTo(-36 * s, -36); ctx.lineTo(36 * s, 36); ctx.stroke();
      }
      ctx.strokeStyle = '#241505'; ctx.lineWidth = 17;
      for (const s of [-1, 1]) {
        ctx.beginPath(); ctx.moveTo(-36 * s, -36); ctx.lineTo(36 * s, 36); ctx.stroke();
      }
    });

    // 22 — a sprout: "this place still has something standing"
    cell(GLYPH.sprout, () => {
      ctx.translate(0, 12);
      ctx.strokeStyle = '#241505'; ctx.lineWidth = 13; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(0, 40); ctx.lineTo(0, -18); ctx.stroke();
      ctx.fillStyle = '#241505';
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(0, -6);
        ctx.quadraticCurveTo(s * 44, -22, s * 30, -50);
        ctx.quadraticCurveTo(s * 12, -40, 0, -22);
        ctx.closePath(); ctx.fill();
      }
    });

    // 23 / 24 — the ownership multiplier, the whole point of the owned badge
    cell(GLYPH.mult2, () => stroked('×2', 78));
    cell(GLYPH.mult3, () => stroked('×3', 78));
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
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 6, 0), 200);

  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, depthTest: false,
    uniforms: {
      uAtlas: { value: atlas },
      uHasAtlas: { value: atlas ? 1 : 0 },
      uOwn: { value: new THREE.Color(0x3b7fd4) },
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
      uniform float uHasAtlas, uTime;
      varying vec2 vQ;
      varying vec4 vData;
      varying vec3 vCol;
      varying float vOwn;
      const float TAU = 6.2831853;

      void main() {
        float alpha = vData.y;
        if (alpha < 0.005) discard;
        float spent = vData.z;
        float own = vOwn;
        // Disc in the top two thirds of the quad, a long pointer tail below it.
        // The tail is what ties the badge to the hex it is talking about: at
        // this camera pitch a floating disc on its own reads as belonging to
        // whichever tile happens to be behind it.
        vec2 q = vQ * 2.0 - 1.0;
        vec2 p = vec2(q.x, q.y - 0.30) / 0.66;

        vec3 col = vec3(0.0);
        float a = 0.0;
        float d = length(p);

        vec3 dark = mix(vec3(0.075, 0.048, 0.028), vec3(0.34, 0.09, 0.05), spent);
        dark = mix(dark, uOwn * 0.92, own);
        vec3 face = mix(vec3(0.965, 0.906, 0.776), vec3(0.615, 0.62, 0.65), spent);

        // ---- owner halo, outside the body
        if (own > 0.01) {
          float glow = smoothstep(1.30, 0.98, d) * (0.60 + 0.40 * sin(uTime * 2.2));
          col = uOwn;
          a = glow * 0.34 * own;
        }

        // ---- pointer tail
        float ty = (-q.y - 0.30) / 0.70;
        if (ty > 0.0 && ty < 1.0 && abs(q.x) < 0.19 * (1.0 - ty * ty * 0.85)) {
          col = mix(dark, dark * 1.6, ty);
          a = 1.0 - ty * 0.25;
        }

        // ---- badge body
        float body = smoothstep(1.00, 0.955, d);
        float inner = smoothstep(0.855, 0.815, d);
        col = mix(col, dark, body);
        a = max(a, body);
        col = mix(col, face, inner);

        // top bevel so it reads as a chunky physical tab
        float bev = inner * smoothstep(0.10, 0.60, p.y) * 0.30;
        col = mix(col, vec3(1.0), bev);

        // ---- the ring
        float ann = smoothstep(0.520, 0.560, d) * smoothstep(0.815, 0.775, d);
        if (ann > 0.001) {
          float t = fract(atan(p.x, p.y) / TAU);
          // The unlit track is always dark: a cream track under a mid-green
          // resource colour gave a segmented ring you could not count.
          vec3 track = mix(vec3(0.20, 0.15, 0.10), vec3(0.26, 0.20, 0.18), spent);
          if (spent > 0.5) {
            float lit = step(t, vData.x);
            float head = smoothstep(0.040, 0.0, abs(t - vData.x));
            col = mix(col, mix(mix(track, vCol, lit), vec3(1.0), head * 0.85), ann);
          } else {
            float fr = fract(t * 7.0);
            float gap = step(0.10, fr) * step(fr, 0.90);
            float lit = step(floor(t * 7.0) + 0.5, vData.x * 7.0) * gap;
            col = mix(col, mix(track, vCol, lit), ann * max(gap, 0.5));
          }
        }

        // ---- centre glyph
        if (uHasAtlas > 0.5) {
          vec2 g2 = p / 0.80 + 0.5;
          if (g2.x > 0.0 && g2.x < 1.0 && g2.y > 0.0 && g2.y < 1.0) {
            float cell = vData.w;
            vec2 c = vec2(mod(cell, 5.0), floor(cell / 5.0));
            vec2 uvv = vec2(c.x / 5.0, 1.0 - (c.y + 1.0) / 5.0) + g2 / 5.0;
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
  return { mesh, geo, mat, quad, aPos, aData, aCol, aSize, aOwn, triangles: n * 2 };
}

export default buildMarkers;
