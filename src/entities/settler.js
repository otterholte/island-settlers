/**
 * Island Settlers — the settler avatar.
 *
 *   createSettler(colorHex, isHuman) ->
 *     { group, setPose(player, timeSec), playChop(resourceOrKind),
 *       setCarry(resCounts), celebrate() }
 *
 * All animation is procedural: no clips, no skinning, just a hand-built bone
 * hierarchy driven from `player.action` + `player.vx/vz`. The rig is authored
 * facing +Z; the board's facing convention (atan2(dz,dx)) is applied as
 * rotation.y = PI/2 - facing.
 *
 * main.js positions `group` on the terrain every frame and calls setPose with
 * wall-clock seconds, so dt is derived internally.
 *
 * Owner: Character agent.
 */

import * as THREE from 'three';
import { PLAYER_SPEED, CHAR_HEIGHT } from '../core/constants.js';
import { buildRig, buildShadowBlob, paletteFor, RIG, TOOL_FOR, UNIT as S } from './settlerBody.js';
import { createCarry } from './settlerCarry.js';
import { createCarryColumns } from './carryColumns.js';

/* ---------------------------------------------------------------- presence */
/**
 * CHAR_HEIGHT is a frozen 2.0 world units, which renders as a ~20px speck at
 * the pass-2 camera distance. The rig is authored at that height and then the
 * whole avatar is scaled here so the hero reads at roughly 9% of frame height
 * (the reference sits near 15%, but that board is far more stylised than ours
 * and a 5-unit settler would tower over the props).
 *
 * Bots run smaller so the human is unambiguously the one you drive.
 */
export const PLAYER_SCALE = 2.35;
export const BOT_SCALE = 1.70;

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const easeOut = t => 1 - Math.pow(1 - t, 3);
const easeIn = t => t * t * t;
const easeIO = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const approach = (dt, rate) => 1 - Math.exp(-rate * dt);

function wrapPi(a) {
  while (a > Math.PI) a -= TAU;
  while (a < -Math.PI) a += TAU;
  return a;
}

/* ------------------------------------------------------------ swing timing */

const SWING_DUR = 0.62;
const SWING_IMPACT = 0.48;
const SWING_REST = 0.18;
const SWING_UP = 2.30;
const SWING_DOWN = -0.85;

function swingAngle(u) {
  if (u < 0.30) return lerp(SWING_REST, SWING_UP, easeOut(u / 0.30));
  if (u < SWING_IMPACT) return lerp(SWING_UP, SWING_DOWN, easeIn((u - 0.30) / (SWING_IMPACT - 0.30)));
  return lerp(SWING_DOWN, SWING_REST, easeIO((u - SWING_IMPACT) / (1 - SWING_IMPACT)));
}

/* ------------------------------------------------------------------ factory */

export function createSettler(colorHex = 0x3b7fd4, isHuman = false) {
  const pal = paletteFor(colorHex >>> 0, !!isHuman);
  const detailed = !!isHuman;

  const scale = detailed ? PLAYER_SCALE : BOT_SCALE;

  const group = new THREE.Group();
  group.name = 'settler';

  // `group` stays at world scale 1 so the overhead carry columns can be
  // authored in plain world units and billboard against the play camera;
  // everything body-shaped hangs off `avatar`, which carries the presence scale.
  const avatar = new THREE.Group();
  avatar.name = 'settlerAvatar';
  avatar.scale.setScalar(scale);
  group.add(avatar);

  const rig = buildRig(pal, detailed);
  avatar.add(rig.root);

  const blob = buildShadowBlob(detailed ? pal.tunic : undefined);
  avatar.add(blob);

  const carry = createCarry(pal, scale, detailed);
  rig.pack.add(carry.stack);

  // THE TRAILING CART IS GONE, for the hero and for the bots alike:
  //
  //   "I'm just getting distracted by the carts we're carrying around behind
  //    us. Just have it be the resources that count above us in those stacks."
  //
  // Nothing hangs off `group` behind the settler any more. What they are
  // carrying is said in exactly one place — the overhead columns — and the
  // small pack on their back is silhouette, not a second readout. Rivals get
  // no columns either; the player asked for less noise from the other three.
  const columns = detailed ? createCarryColumns() : null;
  if (columns) group.add(columns.group);

  const armR = rig.arms[0];   // +X, holds the tool
  const armL = rig.arms[1];
  const legR = rig.legs[0];
  const legL = rig.legs[1];

  /* --------------------------------------------------------------- state */
  const seed = (pal.idx * 2.399) + 0.7;
  let lastT = -1;
  let yaw = 0, yawReady = false;
  let runPhase = seed;
  let runW = 0, gatherW = 0;
  let swingT = -1;
  let impacts = 0, impactArmed = false;
  let squash = 0;
  let celebrating = false, celebT = 0;
  let headTurn = 0;
  let packLag = 0, packLagVel = 0;
  let prevX = null, prevZ = null, measured = 0;
  let toolW = 0;
  let disposed = false;

  function setTool(name) {
    const g = rig.tool.geos[name];
    if (!g || rig.tool.current === name) return;
    rig.tool.current = name;
    rig.tool.mesh.geometry = g;
  }

  /* ----------------------------------------------------------- public api */

  function playChop(kindOrResource) {
    const tool = TOOL_FOR[kindOrResource] || 'axe';
    setTool(tool);
    swingT = 0;
    impactArmed = true;
  }

  function setCarry(resCounts) {
    carry.setCounts(resCounts || {});
    if (columns) columns.setCounts(resCounts || {});
  }

  function celebrate() {
    celebrating = true;
    celebT = 0;
  }

  /* -------------------------------------------------------------- posing */

  function setPose(player, timeSec) {
    if (disposed) return;
    const p = player || {};

    const now = Number.isFinite(timeSec) ? timeSec : (lastT < 0 ? 0 : lastT + 1 / 60);
    let dt = lastT < 0 ? 1 / 60 : now - lastT;
    if (!(dt > 0) || dt > 0.25) dt = 1 / 60;
    lastT = now;

    const px = Number.isFinite(p.x) ? p.x : 0;
    const pz = Number.isFinite(p.z) ? p.z : 0;

    // Velocity: prefer the authoritative vx/vz, fall back to measured motion
    // so bots animate even before their controller writes velocity.
    if (prevX === null) { prevX = px; prevZ = pz; }
    const moved = Math.hypot(px - prevX, pz - prevZ) / dt;
    prevX = px; prevZ = pz;
    measured += (Math.min(moved, 30) - measured) * approach(dt, 12);

    const vx = Number.isFinite(p.vx) ? p.vx : 0;
    const vz = Number.isFinite(p.vz) ? p.vz : 0;
    const spd = Math.max(Math.hypot(vx, vz), measured);
    const sp01 = clamp(spd / PLAYER_SPEED, 0, 1.15);

    const action = celebrating ? 'celebrate' : (p.action || 'idle');
    const isRun = action === 'run' && spd > 0.4;
    const isGather = action === 'gather' || swingT >= 0;

    runW += (( isRun ? 1 : 0) - runW) * approach(dt, 11);
    gatherW += ((isGather ? 1 : 0) - gatherW) * approach(dt, 9);

    /* ------------------------------------------------------------- yaw */
    let facing = Number.isFinite(p.facing) ? p.facing : 0;
    if (!Number.isFinite(p.facing) && spd > 0.5) facing = Math.atan2(vz, vx);
    const targetYaw = Math.PI / 2 - facing;
    if (!yawReady) { yaw = targetYaw; yawReady = true; }
    yaw += wrapPi(targetYaw - yaw) * approach(dt, 12);
    rig.root.rotation.y = yaw;

    /* ------------------------------------------------------- run cycle */
    const strideHz = Math.min(3.2, 0.85 + spd * 0.30);
    runPhase += dt * strideHz * TAU * (0.25 + 0.75 * runW);
    if (runPhase > 1e6) runPhase -= 1e6;
    const s1 = Math.sin(runPhase);

    /* ----------------------------------------------------------- swing */
    let swing = SWING_REST;
    let swingBlend = 0;
    if (swingT >= 0) {
      swingT += dt;
      const u = swingT / SWING_DUR;
      if (u >= 1) { swingT = -1; swing = SWING_REST; }
      else {
        swing = swingAngle(u);
        swingBlend = 1;
        if (impactArmed && u >= SWING_IMPACT) {
          impactArmed = false;
          impacts++;
          squash = 1;
        }
      }
    }
    squash *= Math.exp(-9 * dt);

    /* ------------------------------------------------------ idle layer */
    const breathe = Math.sin(now * 1.65 + seed);
    const sway = Math.sin(now * 0.83 + seed * 1.7);
    const idleArm = Math.sin(now * 0.9 + seed) * 0.06;

    // Occasional head turn: a slow gate opening every ~30s of phase.
    const gate = clamp((Math.sin(now * 0.16 + seed * 2.1) - 0.45) / 0.35, 0, 1);
    const headTarget = Math.sin(now * 0.55 + seed * 3.3) * 0.85 * gate * (1 - runW);
    headTurn += (headTarget - headTurn) * approach(dt, 3.2);

    /* -------------------------------------------------------- compose */
    // hips
    const runBob = Math.abs(s1) * 0.055 * S;
    const crouch = gatherW * 0.05 * S + runW * 0.02 * S;
    rig.hips.position.y = RIG.hipY + runBob * runW + breathe * 0.008 * S * (1 - runW) - crouch;
    rig.hips.rotation.y = -s1 * 0.11 * runW;
    rig.hips.rotation.z = sway * 0.02 * (1 - runW);

    // torso
    const leanRun = 0.05 + 0.20 * sp01;
    const gatherTwist = swingBlend
      ? lerp(0.34, -0.30, clamp((swingT / SWING_DUR - 0.18) / 0.36, 0, 1))
      : 0;
    const gatherPitch = swingBlend
      ? lerp(-0.12, 0.34, clamp((swingT / SWING_DUR - 0.22) / 0.30, 0, 1))
      : 0.16;
    rig.torso.rotation.x =
      lerp(-0.02 + breathe * 0.015, leanRun, runW) + gatherW * gatherPitch;
    rig.torso.rotation.y = s1 * 0.15 * runW + gatherW * gatherTwist;
    rig.torso.rotation.z = sway * 0.028 * (1 - runW) - gatherW * gatherTwist * 0.25;
    rig.torso.scale.set(
      1 + squash * 0.07,
      1 + breathe * 0.012 * (1 - runW) - squash * 0.10,
      1 + squash * 0.07
    );

    // head — stays level, counter-rotating the torso
    rig.neck.rotation.x = -rig.torso.rotation.x * 0.75 + Math.sin(runPhase * 2) * 0.02 * runW;
    rig.neck.rotation.y = headTurn - rig.torso.rotation.y * 0.55;
    rig.neck.rotation.z = -rig.torso.rotation.z * 0.4;

    // arms
    for (const arm of rig.arms) {
      const sd = arm.side;                       // +1 right, -1 left
      const cyc = -s1 * sd * 0.78;               // counter-rotate against legs
      let rx = lerp(0.10 + idleArm * sd, cyc, runW);
      let rz = sd * (0.17 + 0.05 * runW + breathe * 0.02 * (1 - runW));
      let ry = 0;

      if (sd > 0 && gatherW > 0.01) {
        rx = lerp(rx, swingBlend ? swing : 0.55, gatherW);
        rz = lerp(rz, 0.28, gatherW);
        ry = lerp(0, -0.25, gatherW);
      } else if (sd < 0 && gatherW > 0.01) {
        rx = lerp(rx, swingBlend ? swing * 0.55 + 0.2 : 0.45, gatherW);
        rz = lerp(rz, -0.34, gatherW);
      }

      arm.root.rotation.set(rx, ry, rz);
      if (arm.fore) {
        const elbowRun = -(0.30 + 0.42 * Math.max(0, -s1 * sd));
        let ex = lerp(-0.22, elbowRun, runW);
        if (gatherW > 0.01) {
          // Elbow is cocked at the top of the windup and snaps straight
          // through the strike, so the tool head leads the arc.
          const wind = clamp((swing - SWING_DOWN) / (SWING_UP - SWING_DOWN), 0, 1);
          const g = swingBlend ? -(0.14 + 0.78 * wind) : -0.55;
          ex = lerp(ex, g, gatherW);
        }
        arm.fore.rotation.x = ex;
      }
    }

    // legs
    for (const leg of rig.legs) {
      const sd = leg.side;
      const ph = runPhase + (sd > 0 ? 0 : Math.PI);
      const sw = Math.sin(ph);
      const idleSplay = sd * 0.035;
      let rx = lerp(0, sw * 0.82, runW);
      if (gatherW > 0.01) rx = lerp(rx, (sd > 0 ? -0.24 : 0.18), gatherW);
      leg.root.rotation.set(rx, 0, idleSplay + (sd * 0.04 * runW));
      if (leg.shin) {
        const knee = Math.max(0, -Math.sin(ph + 0.85)) * 1.15;
        leg.shin.rotation.x = lerp(0.04, knee, runW) + gatherW * 0.24;
      }
    }

    // backpack jiggle — a lightly damped spring chasing the hip bob
    const packDrive = (runBob * runW) * 26 + (swingBlend ? -swing * 0.4 : 0);
    packLagVel += (packDrive - packLag) * 42 * dt;
    packLagVel *= Math.exp(-9 * dt);
    packLag += packLagVel * dt;
    packLag = clamp(packLag, -0.6, 0.6);
    rig.pack.rotation.x = -packLag * 0.22;
    rig.pack.position.y = RIG.packY - packLag * 0.012 * S;

    /* ------------------------------------------------------- celebrate */
    if (celebrating) {
      celebT += dt;
      const hop = Math.abs(Math.sin(celebT * 3.0));
      const air = Math.pow(hop, 0.7) * 0.42 * S;
      rig.root.position.y = air;
      rig.root.rotation.y = yaw + celebT * 0.9;
      const up = 2.45 + Math.sin(celebT * 6.0) * 0.18;
      for (const arm of rig.arms) {
        arm.root.rotation.set(-0.25, 0, arm.side * up);
        if (arm.fore) arm.fore.rotation.x = -0.35;
      }
      for (const leg of rig.legs) {
        leg.root.rotation.x = -0.55 * hop;
        if (leg.shin) leg.shin.rotation.x = 0.85 * hop;
      }
      rig.torso.rotation.set(-0.12, 0, 0);
      rig.neck.rotation.set(0.18, Math.sin(celebT * 2.2) * 0.25, 0);
      rig.hips.position.y = RIG.hipY;
    } else {
      rig.root.position.y = 0;
    }

    /* ------------------------------------------------------------ tool */
    // The hero keeps a tool in hand at all times — it is a big part of what
    // makes the silhouette read as "person" rather than "coloured pill".
    const wantTool = gatherW > 0.06 || detailed;
    toolW += ((wantTool ? 1 : 0) - toolW) * approach(dt, 14);
    rig.tool.mesh.visible = toolW > 0.05 && !celebrating;
    rig.tool.mesh.scale.setScalar(clamp(toolW, 0.001, 1));

    /* ------------------------------------------------------ shadow blob */
    const lift = clamp(rig.root.position.y / (0.45 * S), 0, 1);
    const blobK = (1 - lift * 0.45) * (1 + runBob * runW * 0.6);
    blob.scale.set(blobK, 1, blobK * 1.06);
    blob.material.opacity = 0.85 * (1 - lift * 0.55);

    /* ------------------------------------------------- overhead columns */
    if (columns) {
      const I = typeof globalThis !== 'undefined' ? globalThis.__ISLAND__ : null;
      columns.update(dt, I ? I.camera : null);
    }
  }

  /* ------------------------------------------------------------- disposal */
  function dispose() {
    disposed = true;
    group.traverse(o => { if (o.isMesh && o.geometry) o.geometry.dispose(); });
    carry.dispose();
    if (columns) columns.dispose();
  }

  /** Live mesh count (draw calls) — a hidden subtree costs nothing to render. */
  function meshCount(onlyVisible = false) {
    let n = 0;
    group.traverse(o => {
      if (!o.isMesh) return;
      if (onlyVisible) {
        for (let q = o; q && q !== group.parent; q = q.parent) if (!q.visible) return;
      }
      n++;
    });
    return n;
  }

  return {
    group,
    setPose,
    playChop,
    setCarry,
    celebrate,
    dispose,
    meshCount,
    palette: pal,
    /** Presence scale applied to the avatar sub-group. */
    scale,
    height: CHAR_HEIGHT * scale,
    /** Monotonic count of gather strikes — the controller feeds camera.shake. */
    get impacts() { return impacts; },
    get swinging() { return swingT >= 0; },
    get carriedTotal() { return carry.total; },
    get yaw() { return yaw; }
  };
}

export default createSettler;
