/**
 * Island Settlers — visible cargo.
 *
 * What a settler is carrying has to read at a glance from a third-person
 * camera: logs lashed across the backpack, brick bundles, wool rolls, wheat
 * sheaves and an ore basket. Past ~12 total goods a little hand-cart spawns
 * and trails behind — purely cosmetic, it never touches movement.
 *
 * Owner: Character agent.
 */

import * as THREE from 'three';
import { RES } from '../core/constants.js';
import {
  part, mergeParts, roundedBox, ball, tube, rock, bodyMaterial
} from './procgeo.js';
import { UNIT as S, LEATHER, LEATHER_DARK, WOODEN } from './settlerBody.js';

export const CART_THRESHOLD = 12;

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
      p.push(part(tube(0.052 * S, 0.052 * S, 0.012 * S, 8), LOG_END,
        [x + s * 0.215 * S, y, z], [0, 0, Math.PI / 2]));
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
    p.push(part(new THREE.CylinderGeometry(0.055 * S, 0.032 * S, 0.34 * S, 8), WHEAT,
      [x, 0.25 * S, -0.10 * S], [0.22, 0, lean - 0.28]));
    p.push(part(new THREE.ConeGeometry(0.072 * S, 0.14 * S, 8), WHEAT_DARK,
      [x + 0.07 * S, 0.42 * S, -0.06 * S], [0.22, 0, lean - 0.28]));
    p.push(part(tube(0.058 * S, 0.058 * S, 0.02 * S, 8), LEATHER,
      [x - 0.02 * S, 0.20 * S, -0.11 * S], [0.22, 0, lean - 0.28]));
  }

  // ore basket slung low
  if (c.ore > 0) {
    p.push(part(tube(0.115 * S, 0.095 * S, 0.14 * S, 12, true), LEATHER,
      [0.20 * S, -0.14 * S, -0.05 * S]));
    p.push(part(new THREE.TorusGeometry(0.115 * S, 0.014 * S, 4, 12), LEATHER_DARK,
      [0.20 * S, -0.075 * S, -0.05 * S], [Math.PI / 2, 0, 0]));
    for (let i = 0; i < c.ore; i++) {
      const a = i * 2.2;
      p.push(part(rock(0.052 * S), i % 2 ? ORE_LIGHT : ORE,
        [(0.20 + Math.cos(a) * 0.045) * S,
         (-0.06 + (i % 2) * 0.035) * S,
         (-0.05 + Math.sin(a) * 0.045) * S],
        [a, a * 0.7, 0]));
    }
  }

  return p;
}

/* ------------------------------------------------------------------- cart */

function cartBodyParts(c) {
  const p = [];
  const w = 0.86 * S, d = 0.62 * S;
  p.push(part(roundedBox(w, 0.07 * S, d, 0.025 * S, 10, 6), WOODEN, [0, 0, 0]));
  for (const s of [-1, 1]) {
    p.push(part(roundedBox(w, 0.22 * S, 0.055 * S, 0.02 * S, 10, 6), LOG,
      [0, 0.13 * S, s * (d / 2 - 0.03 * S)]));
    p.push(part(roundedBox(0.055 * S, 0.22 * S, d, 0.02 * S, 8, 6), LOG,
      [s * (w / 2 - 0.03 * S), 0.13 * S, 0]));
  }
  // axle + shafts reaching toward the settler
  p.push(part(tube(0.035 * S, 0.035 * S, 0.72 * S, 8), LEATHER_DARK,
    [0, -0.10 * S, 0], [0, 0, Math.PI / 2]));
  for (const s of [-1, 1]) {
    p.push(part(roundedBox(0.045 * S, 0.045 * S, 0.52 * S, 0.018 * S, 6, 5), WOODEN,
      [s * 0.24 * S, 0.02 * S, 0.50 * S], [-0.14, 0, 0]));
  }

  // cargo pile — mirrors what the settler is hauling
  const heap = [];
  for (let i = 0; i < Math.min(3, c.wood); i++) {
    heap.push(part(tube(0.07 * S, 0.07 * S, 0.62 * S, 8), LOG,
      [(i - 1) * 0.16 * S, 0.20 * S, -0.10 * S], [0, 0, Math.PI / 2]));
  }
  for (let i = 0; i < Math.min(4, c.brick); i++) {
    heap.push(part(roundedBox(0.24 * S, 0.09 * S, 0.16 * S, 0.015 * S, 8, 6),
      i % 2 ? BRICK_DARK : BRICK,
      [-0.22 * S + (i % 2) * 0.02 * S, (0.10 + i * 0.09) * S, 0.14 * S]));
  }
  for (let i = 0; i < Math.min(3, c.wool); i++) {
    heap.push(part(ball(0.10 * S, 10, 8), WOOL,
      [(0.20 - i * 0.02) * S, (0.22 + i * 0.13) * S, (0.10 - i * 0.06) * S]));
  }
  for (let i = 0; i < Math.min(3, c.wheat); i++) {
    heap.push(part(new THREE.ConeGeometry(0.09 * S, 0.30 * S, 8), WHEAT,
      [(0.26 - i * 0.10) * S, 0.28 * S, -0.16 * S], [0.1, 0, (i - 1) * 0.2]));
  }
  for (let i = 0; i < Math.min(4, c.ore); i++) {
    heap.push(part(rock(0.075 * S), i % 2 ? ORE_LIGHT : ORE,
      [(-0.10 + (i % 2) * 0.18) * S, (0.13 + Math.floor(i / 2) * 0.11) * S, -0.02 * S],
      [i, i * 0.6, 0]));
  }
  return p.concat(heap);
}

function cartWheelParts() {
  const p = [];
  for (const s of [-1, 1]) {
    p.push(part(new THREE.TorusGeometry(0.20 * S, 0.045 * S, 6, 14), LEATHER_DARK,
      [s * 0.44 * S, 0, 0], [0, Math.PI / 2, 0]));
    p.push(part(tube(0.05 * S, 0.05 * S, 0.06 * S, 8), WOODEN,
      [s * 0.44 * S, 0, 0], [0, 0, Math.PI / 2]));
    for (let k = 0; k < 4; k++) {
      p.push(part(roundedBox(0.03 * S, 0.34 * S, 0.03 * S, 0.01 * S, 5, 4), WOODEN,
        [s * 0.44 * S, 0, 0], [0, Math.PI / 2, (k * Math.PI) / 4]));
    }
  }
  return p;
}

/* ---------------------------------------------------------------- factory */

/**
 * @param pal    settler palette
 * @param scale  presence scale of the owning avatar. The pack stack rides
 *               inside the scaled rig, but the cart hangs off the unscaled
 *               settler group (it trails in world space), so it scales itself.
 */
export function createCarry(pal, scale = 1) {
  const bm = bodyMaterial();
  const K = Number.isFinite(scale) && scale > 0 ? scale : 1;

  const stack = new THREE.Mesh(new THREE.BufferGeometry(), bm);
  stack.castShadow = true;
  stack.visible = false;

  const cart = new THREE.Group();
  cart.scale.setScalar(K);
  cart.visible = false;
  const cartBody = new THREE.Mesh(new THREE.BufferGeometry(), bm);
  cartBody.castShadow = true;
  const cartWheels = new THREE.Mesh(new THREE.BufferGeometry(), bm);
  cartWheels.castShadow = true;
  let cartBuilt = false;
  cartWheels.position.y = -0.10 * S;
  cart.add(cartBody, cartWheels);

  let sig = '';
  let counts = clampCounts({});
  let total = 0;

  // world-space trailing state for the cart
  const cartPos = new THREE.Vector3();
  let cartYaw = 0;
  let seeded = false;
  let wheelSpin = 0;

  function setCounts(res) {
    const c = clampCounts(res);
    const s = signature(c);
    if (s === sig) { counts = c; total = c.__total; return; }
    sig = s; counts = c; total = c.__total;

    const sp = stackParts(c);
    stack.geometry.dispose();
    stack.geometry = sp.length ? mergeParts(sp) : new THREE.BufferGeometry();
    stack.visible = sp.length > 0;

    // The cart is only ever built once someone actually hauls enough to need
    // it — most settlers never pay for that geometry at all.
    if (total >= CART_THRESHOLD) {
      if (!cartBuilt) {
        cartBuilt = true;
        cartWheels.geometry.dispose();
        cartWheels.geometry = mergeParts(cartWheelParts());
      }
      cartBody.geometry.dispose();
      cartBody.geometry = mergeParts(cartBodyParts(c));
    }
  }

  /**
   * @param dt        seconds
   * @param origin    settler world position (THREE.Vector3-like {x,y,z})
   * @param yaw       settler world yaw
   * @param groundY   ground height under the cart
   * @param moving    true when the settler is running
   */
  function update(dt, origin, yaw, groundY, moving) {
    const want = total >= CART_THRESHOLD;
    cart.visible = want;
    if (!want) { seeded = false; return; }

    const back = 1.35 * S * K;
    const tx = origin.x - Math.sin(yaw) * back;
    const tz = origin.z - Math.cos(yaw) * back;

    if (!seeded) { cartPos.set(tx, groundY, tz); cartYaw = yaw; seeded = true; }

    const k = 1 - Math.exp(-6.5 * dt);
    cartPos.x += (tx - cartPos.x) * k;
    cartPos.z += (tz - cartPos.z) * k;
    cartPos.y += (groundY - cartPos.y) * Math.min(1, dt * 10);

    // face the settler
    const dx = origin.x - cartPos.x, dz = origin.z - cartPos.z;
    const d = Math.hypot(dx, dz);
    if (d > 0.05) {
      const target = Math.atan2(dx, dz);
      let diff = target - cartYaw;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      cartYaw += diff * Math.min(1, dt * 8);
      wheelSpin += (moving ? d : 0) * dt * 6;
    }

    // cart lives at the settler's group level (unrotated), so offsets are world-ish
    cart.position.set(cartPos.x - origin.x, cartPos.y - origin.y, cartPos.z - origin.z);
    cart.rotation.y = cartYaw;
    cart.position.y += 0.30 * S * K;
    cartWheels.rotation.x = wheelSpin;
  }

  function dispose() {
    stack.geometry.dispose();
    cartBody.geometry.dispose();
    cartWheels.geometry.dispose();
  }

  return {
    stack, cart, setCounts, update, dispose,
    get total() { return total; },
    get counts() { return counts; }
  };
}
