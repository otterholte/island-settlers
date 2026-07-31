/**
 * Island Settlers — settler body construction.
 *
 * Chunky heroic proportions, Clash-of-Clans flavoured: head is ~1/3.2 of the
 * 2.0-unit total height, torso is short, limbs are stubby, hands are big.
 *
 * Local space: feet at y = 0, character faces +Z.
 * (Board convention: facing = atan2(dz,dx) -> mesh.rotation.y = PI/2 - facing.)
 *
 * The rig is a real bone hierarchy — hips, torso, neck, two arm chains, two leg
 * chains, pack — but every bone's geometry is welded into ONE SkinnedMesh with
 * hard 1.0 weights. Rigid skinning reproduces a transform rig exactly, so the
 * animation in settler.js is untouched while a settler costs 2 draw calls for
 * its body (skin + textured head) instead of ten to fourteen.
 *
 * Bots additionally build at a reduced tessellation (`BOT_LOD`). They render at
 * 1.70 presence scale off in the middle distance; the fillet resolution that
 * the hero needs at 2.35 in the centre of frame is invisible on them.
 *
 * Owner: Character agent.
 */

import * as THREE from 'three';
import { CHAR_HEIGHT, PLAYER_COLORS } from '../core/constants.js';
import {
  part, mergeParts, skinCombine,
  roundedBox as _roundedBox, capsule as _capsule, ball as _ball, tube as _tube, rock,
  canvasTexture, hexCss, shade, bodyMaterial
} from './procgeo.js';

/* --------------------------------------------------------------- build LOD */

/** Tessellation multiplier applied while a rig is under construction. */
const BOT_LOD = 0.58;
let LOD = 1;

const seg = (n, min) => Math.max(min, Math.round(n * LOD));

function roundedBox(w, h, d, r, wSeg = 14, hSeg = 8) {
  return _roundedBox(w, h, d, r, seg(wSeg, 7), seg(hSeg, 5));
}
function capsule(radius, length, cap = 4, radial = 10) {
  return _capsule(radius, length, seg(cap, 2), seg(radial, 5));
}
function ball(radius, wSeg = 12, hSeg = 8) {
  return _ball(radius, seg(wSeg, 6), seg(hSeg, 4));
}
function tube(rTop, rBot, h, s = 12, open = false) {
  return _tube(rTop, rBot, h, seg(s, 6), open);
}

/* ------------------------------------------------------------- proportions */

const S = CHAR_HEIGHT / 2.0;          // everything below is authored at 2.0 tall

export const RIG = {
  hipY: 0.62 * S,
  waistY: 0.62 * S,
  shoulderY: 1.14 * S,
  shoulderX: 0.30 * S,
  hipX: 0.135 * S,
  headY: 1.61 * S,
  packY: 0.30 * S,
  packZ: -0.24 * S,
  upperArm: 0.24 * S,
  foreArm: 0.245 * S,
  thigh: 0.26 * S,
  shin: 0.20 * S
};

/* ----------------------------------------------------------------- palette */

const SKINS = [0xf6cda6, 0xe8ab7d, 0xc98a5c, 0x9c6742];
const HAIRS = [0x6b4226, 0x3b2418, 0x8d5c2c, 0x2f1d13];
const TROUSERS = [0x5d6b8a, 0x6b5a42, 0x4f5f4a, 0x5a4a63];
const LEATHER = 0x8a5f36;
const LEATHER_DARK = 0x60401f;
const BOOT = 0x4a3123;
const BOOT_SOLE = 0x2e1e14;
const GOLD = 0xffc93c;
const STEEL = 0xb9c6d2;
const STEEL_DARK = 0x7c8a99;
const WOODEN = 0x9a6b3c;

/** Push a packed colour toward full chroma without shifting its hue. */
function saturate(hex, amt) {
  const r = (hex >> 16) & 255, g = (hex >> 8) & 255, b = hex & 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const mid = (mx + mn) / 2;
  const k = 1 + amt;
  const f = c => Math.max(0, Math.min(255, Math.round(mid + (c - mid) * k)));
  return (f(r) << 16) | (f(g) << 8) | f(b);
}

export function paletteFor(colorHex, isHuman) {
  let idx = PLAYER_COLORS.findIndex(c => c.hex === colorHex);
  if (idx < 0) idx = 0;
  // The hero's tunic runs hotter than the HUD swatch so the silhouette holds
  // its own against grass and sand at gameplay distance.
  const tunic = isHuman ? saturate(colorHex >>> 0, 0.42) : (colorHex >>> 0);
  return {
    idx,
    tunic,
    tunicDark: shade(tunic, isHuman ? -0.24 : -0.13),
    tunicLight: shade(tunic, isHuman ? 0.26 : 0.14),
    skin: isHuman ? SKINS[0] : SKINS[idx % SKINS.length],
    skinDark: shade(isHuman ? SKINS[0] : SKINS[idx % SKINS.length], -0.1),
    hair: isHuman ? HAIRS[0] : HAIRS[idx % HAIRS.length],
    trousers: isHuman ? TROUSERS[0] : TROUSERS[idx % TROUSERS.length],
    isHuman
  };
}

/* ------------------------------------------------------------ face texture */

function paintFace(ctx, w, h, pal) {
  const skin = hexCss(pal.skin);
  ctx.fillStyle = skin;
  ctx.fillRect(0, 0, w, h);

  // Soft vertical form shading so the head is not a flat disc.
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0.0, 'rgba(255,255,255,0.16)');
  g.addColorStop(0.42, 'rgba(255,255,255,0.0)');
  g.addColorStop(1.0, 'rgba(60,25,10,0.20)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  const cx = w * 0.25;            // sphere UV: u = 0.25 faces +Z
  const eyeDX = w * 0.052;
  const eyeY = h * 0.44;
  const ink = '#2a1a12';

  // cheeks
  ctx.save();
  ctx.globalAlpha = 0.30;
  ctx.fillStyle = '#e2705c';
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(cx + s * eyeDX * 1.55, eyeY + h * 0.12, w * 0.030, h * 0.038, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  // brows — short, thick, friendly, slight upward tilt
  ctx.strokeStyle = hexCss(shade(pal.hair, -0.06));
  ctx.lineWidth = h * 0.032;
  ctx.lineCap = 'round';
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(cx + s * (eyeDX - w * 0.024), eyeY - h * 0.115);
    ctx.quadraticCurveTo(
      cx + s * eyeDX, eyeY - h * 0.155,
      cx + s * (eyeDX + w * 0.024), eyeY - h * 0.118
    );
    ctx.stroke();
  }

  // eyes — white almond, dark iris, specular dot
  for (const s of [-1, 1]) {
    const ex = cx + s * eyeDX;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.ellipse(ex, eyeY, w * 0.026, h * 0.062, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = ink;
    ctx.beginPath();
    ctx.ellipse(ex + s * w * 0.003, eyeY + h * 0.006, w * 0.017, h * 0.040, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.beginPath();
    ctx.ellipse(ex + s * w * 0.008, eyeY - h * 0.018, w * 0.006, h * 0.014, 0, 0, Math.PI * 2);
    ctx.fill();
    // lash line
    ctx.strokeStyle = ink;
    ctx.lineWidth = h * 0.012;
    ctx.beginPath();
    ctx.ellipse(ex, eyeY, w * 0.026, h * 0.062, 0, Math.PI * 1.05, Math.PI * 1.95);
    ctx.stroke();
  }

  // nose — a soft shaded bump, no outline
  ctx.save();
  ctx.globalAlpha = 0.24;
  ctx.fillStyle = '#a35b34';
  ctx.beginPath();
  ctx.ellipse(cx, eyeY + h * 0.10, w * 0.013, h * 0.024, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // smile
  ctx.strokeStyle = ink;
  ctx.lineWidth = h * 0.026;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx - w * 0.030, eyeY + h * 0.175);
  ctx.quadraticCurveTo(cx, eyeY + h * 0.245, cx + w * 0.030, eyeY + h * 0.175);
  ctx.stroke();
}

function makeHeadMaterial(pal) {
  const tex = canvasTexture(512, 256, (ctx, w, h) => paintFace(ctx, w, h, pal));
  const m = new THREE.MeshStandardMaterial({ roughness: 0.78, metalness: 0.0 });
  if (tex) m.map = tex;
  else m.color = new THREE.Color(pal.skin);
  return m;
}

/* -------------------------------------------------------------------- bones */

function torsoGeometry(pal) {
  const p = [];
  const t = pal.tunic;
  p.push(part(roundedBox(0.50 * S, 0.60 * S, 0.38 * S, 0.15 * S, 16, 10), t, [0, 0.28 * S, 0]));
  // flared hem
  p.push(part(tube(0.265 * S, 0.315 * S, 0.13 * S, 16), pal.tunicDark, [0, 0.03 * S, 0]));
  // placket + trim
  p.push(part(roundedBox(0.075 * S, 0.34 * S, 0.03 * S, 0.012 * S, 8, 6), pal.tunicLight,
    [0, 0.36 * S, 0.181 * S]));
  // collar
  p.push(part(tube(0.140 * S, 0.165 * S, 0.075 * S, 14), pal.tunicLight, [0, 0.596 * S, 0]));
  // neck
  p.push(part(capsule(0.082 * S, 0.05 * S, 4, 10), pal.skinDark, [0, 0.625 * S, 0]));
  // belt + buckle
  p.push(part(tube(0.272 * S, 0.278 * S, 0.085 * S, 18), LEATHER_DARK, [0, 0.095 * S, 0]));
  p.push(part(roundedBox(0.10 * S, 0.095 * S, 0.05 * S, 0.02 * S, 8, 6), GOLD,
    [0, 0.095 * S, 0.255 * S]));
  // satchel strap crossing the chest (front + back halves)
  p.push(part(roundedBox(0.075 * S, 0.62 * S, 0.05 * S, 0.022 * S, 8, 6), LEATHER,
    [0.055 * S, 0.33 * S, 0.183 * S], [0, 0, -0.30]));
  p.push(part(roundedBox(0.075 * S, 0.58 * S, 0.05 * S, 0.022 * S, 8, 6), LEATHER,
    [-0.05 * S, 0.33 * S, -0.183 * S], [0, 0, 0.28]));
  // pouch on the hip
  p.push(part(roundedBox(0.15 * S, 0.15 * S, 0.10 * S, 0.04 * S, 10, 8), LEATHER,
    [-0.25 * S, 0.10 * S, 0.06 * S], [0, 0, 0.12]));
  return mergeParts(p);
}

function headGeometry() {
  // roundedBox keeps the source sphere's UVs, so u = 0.25 still faces +Z.
  return roundedBox(0.70 * S, 0.63 * S, 0.64 * S, 0.27 * S, 22, 15);
}

function hairGeometry(pal) {
  const p = [];
  const h = pal.hair;
  const hl = shade(h, 0.10);
  // skullcap
  p.push(part(roundedBox(0.735 * S, 0.60 * S, 0.665 * S, 0.27 * S, 18, 12), h, [0, 0.075 * S, 0]));
  // fringe sweeping over the brow
  p.push(part(roundedBox(0.60 * S, 0.20 * S, 0.22 * S, 0.07 * S, 12, 7), h,
    [0.02 * S, 0.155 * S, 0.255 * S], [0.30, 0.06, 0.10]));
  p.push(part(roundedBox(0.24 * S, 0.15 * S, 0.16 * S, 0.05 * S, 12, 8), hl,
    [-0.16 * S, 0.20 * S, 0.245 * S], [0.24, 0, -0.4]));
  // nape
  p.push(part(roundedBox(0.56 * S, 0.28 * S, 0.20 * S, 0.08 * S, 12, 7), h,
    [0, -0.12 * S, -0.24 * S], [-0.15, 0, 0]));
  // sideburns
  for (const s of [-1, 1]) {
    p.push(part(roundedBox(0.12 * S, 0.24 * S, 0.20 * S, 0.05 * S, 8, 6), h,
      [s * 0.315 * S, -0.02 * S, 0.02 * S]));
  }
  // tousled tufts
  const tufts = [
    [0.06, 0.34, -0.02, 0.30, 0.5, -0.2],
    [-0.15, 0.31, 0.08, 0.24, -0.4, 0.3],
    [0.20, 0.29, 0.06, 0.21, 0.2, 0.5],
    [-0.04, 0.30, -0.20, 0.23, -0.6, -0.3]
  ];
  for (const [x, y, z, r, rx, rz] of tufts) {
    p.push(part(new THREE.ConeGeometry(r * 0.42 * S, r * 1.15 * S, seg(7, 4)), hl,
      [x * S, y * S, z * S], [rx, 0, rz]));
  }
  // Bots wear a colour-coded cap, merged into the hair mesh (no extra draw).
  if (!pal.isHuman) {
    p.push(part(tube(0.345 * S, 0.375 * S, 0.10 * S, 18), pal.tunic, [0, 0.155 * S, 0]));
    p.push(part(roundedBox(0.40 * S, 0.05 * S, 0.24 * S, 0.02 * S, 12, 6), pal.tunicDark,
      [0, 0.135 * S, 0.30 * S], [0.14, 0, 0]));
    p.push(part(ball(0.055 * S, 8, 6), pal.tunicLight, [0, 0.215 * S, 0]));
  } else {
    // The human gets a colour-coded headband instead.
    p.push(part(tube(0.352 * S, 0.352 * S, 0.075 * S, 18), pal.tunic, [0, 0.085 * S, 0]));
    p.push(part(roundedBox(0.06 * S, 0.06 * S, 0.05 * S, 0.02 * S, 8, 6), pal.tunicLight,
      [-0.30 * S, 0.085 * S, 0.17 * S]));
  }
  return mergeParts(p);
}

function armGeometry(pal, side, detailed) {
  // side: +1 = character's right (+X). Origin at the shoulder joint.
  const up = [];
  up.push(part(ball(0.135 * S, 10, 8), pal.tunic, [0, 0, 0]));
  up.push(part(capsule(0.098 * S, 0.15 * S, 4, 10), pal.tunic, [0, -0.115 * S, 0]));
  // rolled sleeve cuff
  up.push(part(tube(0.104 * S, 0.112 * S, 0.07 * S, 12), pal.tunicLight, [0, -0.215 * S, 0]));

  const lo = [];
  lo.push(part(capsule(0.083 * S, 0.13 * S, 4, 10), pal.skin, [0, -0.09 * S, 0]));
  lo.push(part(ball(0.118 * S, 10, 8), pal.skin, [0, -0.215 * S, 0.012 * S], [0, 0, 0],
    [1.0, 0.90, 0.95]));
  lo.push(part(ball(0.052 * S, 8, 6), pal.skin, [side * 0.085 * S, -0.185 * S, 0.045 * S]));

  if (detailed) {
    return { upper: mergeParts(up), lower: mergeParts(lo) };
  }
  // Simplified bots: elbow baked in, one draw call for the whole arm.
  const all = up.concat(lo.map(q => {
    q.matrix.premultiply(
      new THREE.Matrix4().makeTranslation(0, -RIG.upperArm, 0)
        .multiply(new THREE.Matrix4().makeRotationX(-0.22))
    );
    return q;
  }));
  return { upper: mergeParts(all), lower: null };
}

function legGeometry(pal, side, detailed) {
  const up = [];
  up.push(part(capsule(0.115 * S, 0.13 * S, 4, 10), pal.trousers, [0, -0.13 * S, 0]));

  const lo = [];
  lo.push(part(capsule(0.099 * S, 0.09 * S, 4, 10), pal.trousers, [0, -0.085 * S, 0]));
  lo.push(part(tube(0.108 * S, 0.115 * S, 0.06 * S, 12), LEATHER_DARK, [0, -0.15 * S, 0]));
  lo.push(part(roundedBox(0.20 * S, 0.17 * S, 0.30 * S, 0.07 * S, 10, 7), BOOT,
    [0, -0.275 * S, 0.05 * S]));
  lo.push(part(roundedBox(0.215 * S, 0.055 * S, 0.315 * S, 0.022 * S, 10, 5), BOOT_SOLE,
    [0, -0.345 * S, 0.05 * S]));

  if (detailed) {
    return { upper: mergeParts(up), lower: mergeParts(lo) };
  }
  const all = up.concat(lo.map(q => {
    q.matrix.premultiply(new THREE.Matrix4().makeTranslation(0, -RIG.thigh, 0));
    return q;
  }));
  void side;
  return { upper: mergeParts(all), lower: null };
}

function packGeometry(pal) {
  const p = [];
  p.push(part(roundedBox(0.36 * S, 0.32 * S, 0.22 * S, 0.09 * S, 12, 8), LEATHER, [0, 0, 0]));
  p.push(part(roundedBox(0.375 * S, 0.14 * S, 0.235 * S, 0.055 * S, 12, 7), LEATHER_DARK,
    [0, 0.115 * S, 0.005 * S]));
  for (const s of [-1, 1]) {
    p.push(part(roundedBox(0.045 * S, 0.20 * S, 0.045 * S, 0.015 * S, 8, 6), LEATHER_DARK,
      [s * 0.10 * S, 0.02 * S, 0.115 * S]));
    p.push(part(roundedBox(0.055 * S, 0.045 * S, 0.03 * S, 0.012 * S, 8, 6), GOLD,
      [s * 0.10 * S, -0.045 * S, 0.125 * S]));
  }
  // bedroll lashed under the flap
  p.push(part(new THREE.CylinderGeometry(0.055 * S, 0.055 * S, 0.34 * S, seg(10, 6)),
    pal.tunicDark, [0, -0.13 * S, 0.075 * S], [0, 0, Math.PI / 2]));
  return mergeParts(p);
}

/* -------------------------------------------------------------------- tools */

function toolAxe() {
  const p = [];
  p.push(part(capsule(0.028 * S, 0.42 * S, 3, 8), WOODEN, [0, 0.14 * S, 0]));
  p.push(part(tube(0.036 * S, 0.036 * S, 0.05 * S, 8), LEATHER_DARK, [0, 0.33 * S, 0]));
  p.push(part(roundedBox(0.055 * S, 0.19 * S, 0.075 * S, 0.02 * S, 8, 6), STEEL_DARK,
    [0, 0.375 * S, 0.02 * S]));
  p.push(part(roundedBox(0.05 * S, 0.20 * S, 0.19 * S, 0.025 * S, 8, 6), STEEL,
    [0, 0.375 * S, 0.115 * S], [0, 0, 0], [1, 1, 1]));
  p.push(part(roundedBox(0.052 * S, 0.215 * S, 0.05 * S, 0.012 * S, 8, 6), 0xe4edf4,
    [0, 0.375 * S, 0.195 * S]));
  return mergeParts(p);
}

function toolPickaxe() {
  const p = [];
  p.push(part(capsule(0.028 * S, 0.44 * S, 3, 8), WOODEN, [0, 0.15 * S, 0]));
  p.push(part(tube(0.038 * S, 0.038 * S, 0.06 * S, 8), LEATHER_DARK, [0, 0.35 * S, 0]));
  for (const s of [-1, 1]) {
    p.push(part(new THREE.ConeGeometry(0.045 * S, 0.26 * S, 7), STEEL,
      [0, 0.375 * S, s * 0.14 * S], [s * Math.PI / 2, 0, 0]));
  }
  p.push(part(roundedBox(0.05 * S, 0.07 * S, 0.12 * S, 0.02 * S, 8, 6), STEEL_DARK,
    [0, 0.375 * S, 0]));
  return mergeParts(p);
}

function toolSickle() {
  const p = [];
  p.push(part(capsule(0.030 * S, 0.20 * S, 3, 8), WOODEN, [0, 0.06 * S, 0]));
  p.push(part(tube(0.038 * S, 0.038 * S, 0.05 * S, 8), LEATHER_DARK, [0, 0.185 * S, 0]));
  p.push(part(new THREE.TorusGeometry(0.17 * S, 0.022 * S, 5, 16, Math.PI * 1.15), STEEL,
    [0, 0.23 * S, 0.14 * S], [Math.PI / 2, 0, -0.5]));
  p.push(part(new THREE.TorusGeometry(0.17 * S, 0.010 * S, 4, 16, Math.PI * 1.15), 0xeff5fa,
    [0, 0.245 * S, 0.14 * S], [Math.PI / 2, 0, -0.5]));
  return mergeParts(p);
}

function toolShears() {
  const p = [];
  for (const s of [-1, 1]) {
    p.push(part(capsule(0.024 * S, 0.16 * S, 3, 7), STEEL_DARK,
      [s * 0.035 * S, 0.06 * S, 0], [0, 0, -s * 0.16]));
    p.push(part(roundedBox(0.035 * S, 0.26 * S, 0.075 * S, 0.014 * S, 8, 6), STEEL,
      [s * 0.045 * S, 0.29 * S, 0.02 * S], [0, 0, -s * 0.12]));
  }
  p.push(part(new THREE.TorusGeometry(0.055 * S, 0.020 * S, 5, 12), STEEL_DARK,
    [0, -0.045 * S, 0], [Math.PI / 2, 0, 0]));
  p.push(part(ball(0.033 * S, 8, 6), GOLD, [0, 0.155 * S, 0]));
  return mergeParts(p);
}

function toolSpade() {
  const p = [];
  p.push(part(capsule(0.028 * S, 0.34 * S, 3, 8), WOODEN, [0, 0.11 * S, 0]));
  p.push(part(roundedBox(0.15 * S, 0.045 * S, 0.045 * S, 0.018 * S, 8, 6), WOODEN,
    [0, -0.09 * S, 0]));
  p.push(part(tube(0.038 * S, 0.038 * S, 0.05 * S, 8), LEATHER_DARK, [0, 0.30 * S, 0]));
  p.push(part(roundedBox(0.18 * S, 0.24 * S, 0.035 * S, 0.02 * S, 10, 8), STEEL,
    [0, 0.41 * S, 0.015 * S], [0.12, 0, 0]));
  p.push(part(roundedBox(0.16 * S, 0.05 * S, 0.045 * S, 0.014 * S, 8, 6), 0xe4edf4,
    [0, 0.525 * S, 0.03 * S], [0.12, 0, 0]));
  return mergeParts(p);
}

export const TOOL_BUILDERS = {
  axe: toolAxe, pickaxe: toolPickaxe, sickle: toolSickle,
  shears: toolShears, spade: toolSpade
};

/** resource OR node-kind -> tool name. */
export const TOOL_FOR = {
  wood: 'axe', tree: 'axe',
  ore: 'pickaxe', orerock: 'pickaxe', mountains: 'pickaxe',
  wheat: 'sickle', fields: 'sickle',
  wool: 'shears', sheep: 'shears', pasture: 'shears',
  brick: 'spade', claypit: 'spade', hills: 'spade'
};

/* ------------------------------------------------------------ contact blob */

const TAU2 = Math.PI * 2;
const blobTextures = new Map();

/**
 * Contact shadow, optionally with the player-marker ring painted into the very
 * same canvas — one texture, one mesh, one draw call for both jobs.
 *
 * @param ringHex  packed colour of the marker ring, or -1 for a plain blob
 * @param coreFrac shadow radius as a fraction of the texture's half-width
 */
function shadowTexture(ringHex, coreFrac) {
  const key = `${ringHex}|${coreFrac}`;
  if (blobTextures.has(key)) return blobTextures.get(key);
  const tex = canvasTexture(192, 192, (ctx, w, h) => {
    const cx = w / 2, cy = h / 2, R = w / 2;

    // Dense core so the character is unmistakably planted on the ground.
    const core = R * coreFrac;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, core);
    g.addColorStop(0.00, 'rgba(10,18,8,0.90)');
    g.addColorStop(0.34, 'rgba(10,18,8,0.78)');
    g.addColorStop(0.68, 'rgba(10,18,8,0.34)');
    g.addColorStop(1.00, 'rgba(10,18,8,0.00)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, core, 0, TAU2); ctx.fill();

    if (ringHex < 0) return;
    const lt = shade(ringHex, 0.30), dk = shade(ringHex, -0.18);
    const rgb = c => `${(c >> 16) & 255},${(c >> 8) & 255},${c & 255}`;
    const rg = ctx.createRadialGradient(cx, cy, R * 0.55, cx, cy, R);
    rg.addColorStop(0.00, `rgba(${rgb(dk)},0)`);
    rg.addColorStop(0.30, `rgba(${rgb(ringHex)},0.28)`);
    rg.addColorStop(0.62, `rgba(${rgb(ringHex)},0.92)`);
    rg.addColorStop(0.74, `rgba(${rgb(lt)},0.90)`);
    rg.addColorStop(0.86, `rgba(${rgb(ringHex)},0.48)`);
    rg.addColorStop(1.00, `rgba(${rgb(dk)},0)`);
    ctx.fillStyle = rg;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU2); ctx.fill();
  });
  blobTextures.set(key, tex);
  return tex;
}

/**
 * @param ringHex packed player colour to paint a marker ring, or undefined for
 *                the plain contact shadow the bots use.
 */
export function buildShadowBlob(ringHex) {
  const marked = Number.isFinite(ringHex);
  const size = marked ? 1.90 * S : 1.30 * S;
  // Keep the dark core the same world size in both variants.
  const tex = shadowTexture(marked ? (ringHex >>> 0) : -1, marked ? 0.54 : 0.90);
  const mat = new THREE.MeshBasicMaterial({
    transparent: true, depthWrite: false, opacity: 0.92,
    color: 0xffffff
  });
  if (tex) mat.map = tex;
  const g = new THREE.PlaneGeometry(size, size);
  g.rotateX(-Math.PI / 2);
  const m = new THREE.Mesh(g, mat);
  // The tessellated island can sit a couple of tenths above heightAt(), so the
  // decal needs real clearance or it vanishes into the ground. At a 50-degree
  // pitch this lift costs about two pixels of parallax.
  m.position.y = 0.17;
  m.renderOrder = 3;
  m.visible = !!tex;
  m.matrixAutoUpdate = true;
  return m;
}

/* --------------------------------------------------------------- assembly */

function mesh(geo, mat, castShadow = true) {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = castShadow;
  m.receiveShadow = false;
  return m;
}

/**
 * Build the full rig. `detailed` adds real elbow / knee joints and full
 * tessellation; bots run the baked-bend, reduced-segment variant.
 *
 * The returned handles (`hips`, `torso`, `neck`, `arms[].root`, `arms[].fore`,
 * `legs[].root`, `legs[].shin`, `pack`) are THREE.Bone instances, which are
 * plain Object3Ds — settler.js drives them with exactly the same position /
 * rotation / scale writes it always used. The difference is that they now feed
 * a Skeleton instead of each carrying their own Mesh.
 */
export function buildRig(pal, detailed) {
  LOD = detailed ? 1 : BOT_LOD;
  const bm = bodyMaterial();
  const root = new THREE.Group();          // yaw + bob + squash

  const bones = [];
  const pieces = [];                       // { geometry, bone } in bone-local space
  const boneOf = new Map();
  const addBone = (parent, x = 0, y = 0, z = 0) => {
    const b = new THREE.Bone();
    b.position.set(x, y, z);
    parent.add(b);
    boneOf.set(b, bones.length);
    bones.push(b);
    return b;
  };
  const skin = (bone, geometry) => { if (geometry) pieces.push({ bone, geometry }); };

  const hips = addBone(root, 0, RIG.hipY, 0);
  const torso = addBone(hips);
  skin(torso, torsoGeometry(pal));

  // head ---------------------------------------------------------------
  const neck = addBone(torso, 0, RIG.headY - RIG.hipY, 0);
  // The face is a painted canvas map, so the head is the one part that cannot
  // share the body's vertex-colour material. It rides the neck bone directly
  // as a plain child mesh — one extra call, and only one.
  const headMesh = mesh(headGeometry(), makeHeadMaterial(pal));
  neck.add(headMesh);
  skin(neck, hairGeometry(pal));

  // arms ---------------------------------------------------------------
  const arms = [];
  for (const side of [1, -1]) {           // +1 = right hand (holds the tool)
    const g = addBone(torso, side * RIG.shoulderX, RIG.shoulderY - RIG.hipY, 0);
    const built = armGeometry(pal, side, detailed);
    skin(g, built.upper);
    let fore = null;
    if (built.lower) {
      fore = addBone(g, 0, -RIG.upperArm, 0);
      skin(fore, built.lower);
    }
    const hand = new THREE.Group();
    hand.position.y = detailed ? -RIG.foreArm * 0.88 : -(RIG.upperArm + RIG.foreArm * 0.86);
    (fore || g).add(hand);
    arms.push({ side, root: g, fore, hand });
  }

  // legs ---------------------------------------------------------------
  const legs = [];
  for (const side of [1, -1]) {
    const g = addBone(hips, side * RIG.hipX, 0, 0);
    const built = legGeometry(pal, side, detailed);
    skin(g, built.upper);
    let shin = null;
    if (built.lower) {
      shin = addBone(g, 0, -RIG.thigh, 0);
      skin(shin, built.lower);
    }
    legs.push({ side, root: g, shin });
  }

  // pack ---------------------------------------------------------------
  const pack = addBone(torso, 0, RIG.packY, RIG.packZ);
  skin(pack, packGeometry(pal));

  // weld ---------------------------------------------------------------
  // Freeze the rest pose, bake every bone's geometry into bind space and hand
  // the inverses to a Skeleton. `root` has no parent yet, so matrixWorld here
  // is the rig-local bind transform; at runtime the avatar's presence scale and
  // the world placement cancel out of the skinning equation.
  root.updateMatrixWorld(true);
  const boneInverses = bones.map(b => b.matrixWorld.clone().invert());
  const bodyGeo = skinCombine(pieces.map(p => ({
    geometry: p.geometry,
    boneIndex: boneOf.get(p.bone),
    bindMatrix: p.bone.matrixWorld
  })));

  const body = new THREE.SkinnedMesh(bodyGeo, bm);
  body.castShadow = true;
  body.receiveShadow = false;
  body.frustumCulled = false;              // the bind-pose sphere lies once posed
  root.add(body);
  body.bind(new THREE.Skeleton(bones, boneInverses), new THREE.Matrix4());

  // tool ---------------------------------------------------------------
  const toolGeos = {};
  for (const k in TOOL_BUILDERS) toolGeos[k] = TOOL_BUILDERS[k]();
  const toolMesh = mesh(toolGeos.axe, bm);
  toolMesh.visible = false;
  const toolPivot = new THREE.Group();
  // The shaft continues the forearm line (tool +Y = hand -Y) so the head
  // leads through the whole swing arc: cocked behind, then down and forward.
  toolPivot.rotation.set(Math.PI - 0.28, 0, -0.18);
  toolPivot.position.set(0, -0.03 * S, 0.03 * S);
  toolPivot.add(toolMesh);
  arms[0].hand.add(toolPivot);

  LOD = 1;
  return {
    root, hips, torso, neck, arms, legs, pack,
    meshes: { body, headMesh },
    tool: { pivot: toolPivot, mesh: toolMesh, geos: toolGeos, current: 'axe' }
  };
}

export { S as UNIT, rock, LEATHER, LEATHER_DARK, GOLD, STEEL, WOODEN };
