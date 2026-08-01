/**
 * Island Settlers — visible cargo on the settler's own back.
 *
 * Logs lashed across the backpack, brick bundles, wool rolls, wheat sheaves and
 * an ore basket. Small, close to the body, and part of the silhouette.
 *
 * ---------------------------------------------------------------------------
 * THE CART IS GONE
 * ---------------------------------------------------------------------------
 *   "I'm just getting distracted by the carts we're carrying around behind us.
 *    Just have it be the resources that count above us in those stacks — you
 *    can remove the cart visuals."
 *
 * There used to be a hand-cart that spawned past twelve goods and trailed the
 * settler on a spring, with its own body, wheels and a cargo heap that mirrored
 * the pack. It has been deleted outright — geometry, trailing state, wheel
 * spin, threshold and all — not merely hidden. `createCarry` no longer exposes
 * a `cart`, and `update()` no longer takes a ground height or a yaw, because
 * nothing in here lives in world space any more.
 *
 * What the player is carrying is now said in exactly ONE place: the overhead
 * columns in `carryColumns.js`. This module is what they are WEARING.
 *
 * Owner: Character agent.
 */

import * as THREE from 'three';
import { RES } from '../core/constants.js';
import {
  part, mergeParts,
  roundedBox as _roundedBox, tube as _tube, rock, bodyMaterial
} from './procgeo.js';
import { UNIT as S, LEATHER, LEATHER_DARK } from './settlerBody.js';

/* ------------------------------------------------------------------- LOD */
/*
 * All four settlers can be loaded at once mid-match, so the pack is built at
 * reduced tessellation for bots, and the log end-caps — a 12mm-thick disc that
 * used to be a closed 8-sided cylinder, 32 triangles for a face you see
 * edge-on — are flat discs.
 */
const BOT_LOD = 0.58;
let LOD = 1;
const seg = (n, min) => Math.max(min, Math.round(n * LOD));

function roundedBox(w, h, d, r, wSeg = 14, hSeg = 8) {
  return _roundedBox(w, h, d, r, seg(wSeg, 6), seg(hSeg, 4));
}
function tube(rTop, rBot, h, s = 12, open = false) {
  return _tube(rTop, rBot, h, seg(s, 5), open);
}
/** Flat cap facing local +Y, so a [0,0,±PI/2] part rotation aims it along ±X. */
function disc(r, s) {
  const g = new THREE.CircleGeometry(r, seg(s, 5));
  g.rotateX(-Math.PI / 2);
  return g;
}

const CAP = { wood: 4, brick: 4, wool: 3, wheat: 3, ore: 4 };

const LOG = 0x8b5a2b;
const LOG_END = 0xd8b17a;
const BRICK = 0xc0562f;
const BRICK_DARK = 0x9a4023;
const WOOL = 0xf1ece0;
const WOOL_TIE = 0xb9a37e;
const WHEAT = 0xe8b53c;
const WHEAT_DARK = 0xc38f1f;
const ORE = 0x8d97a6;
const ORE_LIGHT = 0xb6c0cc;

function clampCounts(res) {
  const out = {};
  let total = 0;
  for (const r of RES) {
    const v = Math.max(0, Math.floor(res && res[r] ? res[r] : 0));
    out[r] = Math.min(v, CAP[r]);
    total += v;
  }
  out.__total = total;
  return out;
}

function signature(c) {
  return RES.map(r => c[r]).join(',') + '|' + Math.min(40, c.__total);
}

/* --------------------------------------------------------------- backpack */

function stackParts(c) {
  const p = [];

  // logs strapped across the top of the pack
  for (let i = 0; i < c.wood; i++) {
    const row = i < 2 ? 0 : 1;
    const col = i % 2;
    const y = (0.20 + row * 0.115) * S;
    const z = (-0.05 - row * 0.045) * S;
    const x = (col === 0 ? -0.055 : 0.055) * S;
    p.push(part(tube(0.055 * S, 0.055 * S, 0.42 * S, 8), LOG,
      [x, y, z], [0, 0, Math.PI / 2]));
    for (const s of [-1, 1]) {
      p.push(part(disc(0.053 * S, 8), LOG_END,
        [x + s * 0.216 * S, y, z], [0, 0, -s * Math.PI / 2]));
    }
  }
  if (c.wood > 0) {
    p.push(part(roundedBox(0.05 * S, 0.07 * S, 0.30 * S, 0.015 * S, 6, 5), LEATHER_DARK,
      [0, 0.235 * S, -0.03 * S]));
  }

  // brick bundles stacked on the left flank
  for (let i = 0; i < c.brick; i++) {
    const y = (-0.06 + i * 0.085) * S;
    const tw = i % 2 === 0 ? 0 : 0.35;
    p.push(part(roundedBox(0.20 * S, 0.075 * S, 0.13 * S, 0.014 * S, 8, 6),
      i % 2 ? BRICK_DARK : BRICK, [-0.245 * S, y, -0.02 * S], [0, tw, 0]));
  }

  // wool rolls sitting on the pack shoulders
  for (let i = 0; i < c.wool; i++) {
    const x = (i - (c.wool - 1) / 2) * 0.17 * S;
    p.push(part(tube(0.082 * S, 0.082 * S, 0.16 * S, 9), WOOL,
      [x, 0.155 * S, -0.19 * S], [0, 0, Math.PI / 2]));
    p.push(part(tube(0.086 * S, 0.086 * S, 0.022 * S, 9), WOOL_TIE,
      [x, 0.155 * S, -0.19 * S], [0, 0, Math.PI / 2]));
  }

  // wheat sheaves poking up behind the shoulder
  for (let i = 0; i < c.wheat; i++) {
    const lean = (i - 1) * 0.16;
    const x = (0.22 + i * 0.02) * S;
    p.push(part(new THREE.CylinderGeometry(0.055 * S, 0.032 * S, 0.34 * S, seg(8, 5)), WHEAT,
      [x, 0.25 * S, -0.10 * S], [0.22, 0, lean - 0.28]));
    p.push(part(new THREE.ConeGeometry(0.072 * S, 0.14 * S, seg(8, 5)), WHEAT_DARK,
      [x + 0.07 * S, 0.42 * S, -0.06 * S], [0.22, 0, lean - 0.28]));
    p.push(part(tube(0.058 * S, 0.058 * S, 0.02 * S, 8), LEATHER,
      [x - 0.02 * S, 0.20 * S, -0.11 * S], [0.22, 0, lean - 0.28]));
  }

  // ore basket slung low
  if (c.ore > 0) {
    p.push(part(tube(0.115 * S, 0.095 * S, 0.14 * S, 12, true), LEATHER,
      [0.20 * S, -0.14 * S, -0.05 * S]));
    p.push(part(new THREE.TorusGeometry(0.115 * S, 0.014 * S, 3, seg(12, 7)), LEATHER_DARK,
      [0.20 * S, -0.075 * S, -0.05 * S], [Math.PI / 2, 0, 0]));
    for (let i = 0; i < c.ore; i++) {
      const a = i * 2.2;
      p.push(part(rock(0.052 * S, 0, true), i % 2 ? ORE_LIGHT : ORE,
        [(0.20 + Math.cos(a) * 0.045) * S,
         (-0.06 + (i % 2) * 0.035) * S,
         (-0.05 + Math.sin(a) * 0.045) * S],
        [a, a * 0.7, 0]));
    }
  }

  return p;
}

/* ---------------------------------------------------------------- factory */

/**
 * @param pal      settler palette (unused for now — the pack takes its colours
 *                 from the cargo, not from the wearer)
 * @param scale    presence scale of the owning avatar. Kept in the signature
 *                 because callers pass it; the pack rides inside the already
 *                 scaled rig, so nothing here has to apply it.
 * @param detailed hero tessellation. Bots build the reduced variant.
 */
export function createCarry(pal, scale = 1, detailed = true) {
  const bm = bodyMaterial();
  const lod = detailed ? 1 : BOT_LOD;
  void pal; void scale;

  const stack = new THREE.Mesh(new THREE.BufferGeometry(), bm);
  stack.castShadow = true;
  stack.visible = false;

  let sig = '';
  let counts = clampCounts({});
  let total = 0;

  function setCounts(res) {
    const c = clampCounts(res);
    const s = signature(c);
    if (s === sig) { counts = c; total = c.__total; return; }
    sig = s; counts = c; total = c.__total;

    LOD = lod;
    const sp = stackParts(c);
    stack.geometry.dispose();
    stack.geometry = sp.length ? mergeParts(sp) : new THREE.BufferGeometry();
    stack.visible = sp.length > 0;
    LOD = 1;
  }

  /** Nothing to integrate any more — kept so callers need not special-case it. */
  function update() { /* the pack is parented to the rig; the rig poses it */ }

  function dispose() {
    stack.geometry.dispose();
  }

  return {
    stack, setCounts, update, dispose,
    get total() { return total; },
    get counts() { return counts; }
  };
}
