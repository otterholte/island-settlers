/**
 * Island Settlers — human player controller.
 *
 *   createPlayerController(state, settler, gameCamera, input, world) ->
 *     { update(dt) }
 *
 * Owns exactly three things:
 *   1. Movement — smooth accel / decel toward the joystick direction, mapped
 *      through the camera yaw, clamped to the island with coastline sliding.
 *   2. Contextual intent — writes `nearTarget` / `nearTrade` onto player 0 so
 *      the economy and interface can act on them. It never gathers or trades
 *      itself; pickup is contact-based and belongs to rules.sweepPickups.
 *   3. Driving the camera (follow + impact shake).
 *
 * Runs inside main.js's fixed 60 Hz step, up to 4 times per rendered frame.
 *
 * Owner: Character agent.
 */

import {
  PLAYER_SPEED, PLAYER_ACCEL, INTERACT_RADIUS, TRADE_RADIUS
} from '../core/constants.js';
import { clampToIsland, MARKET } from '../board/layout.js';
import { nearestItem } from '../board/nodes.js';
import { nearestPortFor, canGatherTile } from '../core/rules.js';
import { useHeightSampler } from './ground.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

const RUN_THRESHOLD = 0.6;      // world units/sec before we call it running

export function createPlayerController(state, settler, gameCamera, input, world) {
  if (world && typeof world.heightAt === 'function') useHeightSampler(world.heightAt);

  const p = state && state.players ? state.players[0] : null;
  if (p) {
    if (p.nearTarget === undefined) p.nearTarget = null;
    if (p.nearTrade === undefined) p.nearTrade = null;
  }

  let lastImpacts = settler && typeof settler.impacts === 'number' ? settler.impacts : 0;

  function readStick() {
    const s = input && input.stick ? input.stick : null;
    let sx = s && Number.isFinite(s.x) ? s.x : 0;
    let sy = s && Number.isFinite(s.y) ? s.y : 0;
    let mag = Math.hypot(sx, sy);
    if (mag > 1) { sx /= mag; sy /= mag; mag = 1; }
    if (mag < 0.02) return { x: 0, z: 0, mag: 0 };

    const yaw = gameCamera && Number.isFinite(gameCamera.yaw) ? gameCamera.yaw : 0;
    // Camera sits at (sin yaw, cos yaw) from the focus, so "away from camera"
    // — joystick up — is the negative of that. Right is its perpendicular.
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const rx = -fz, rz = fx;
    return { x: rx * sx + fx * sy, z: rz * sx + fz * sy, mag };
  }

  function moveWithSlide(nx, nz) {
    const full = clampToIsland(nx, nz);
    if (!full.clamped) { p.x = nx; p.z = nz; return; }

    const dx = nx - p.x, dz = nz - p.z;
    const ax = Math.abs(dx) > 1e-7 ? clampToIsland(nx, p.z) : null;
    const az = Math.abs(dz) > 1e-7 ? clampToIsland(p.x, nz) : null;
    const okX = ax && !ax.clamped;
    const okZ = az && !az.clamped;

    if (okX && okZ) {
      if (Math.abs(dx) >= Math.abs(dz)) { p.x = nx; p.vz *= 0.25; }
      else { p.z = nz; p.vx *= 0.25; }
    } else if (okX) {
      p.x = nx; p.vz *= 0.25;
    } else if (okZ) {
      p.z = nz; p.vx *= 0.25;
    } else {
      p.x = full.x; p.z = full.z;
      p.vx *= 0.1; p.vz *= 0.1;
    }
  }

  function updateIntent() {
    // --- the thing you are about to run over ----------------------------
    // Pickup is contact-based, so this is no longer a lease on a node: it is
    // purely "what is in front of me", and it stays live while running because
    // that is exactly when it is true. `nearTarget` is advisory — rules.js
    // sweeps by proximity and does not consult it.
    p.nearTarget = nearestItem(p.x, p.z, {
      maxDist: INTERACT_RADIUS,
      filter: it => canGatherTile(state, 0, it.tile)
    });

    // --- trading -------------------------------------------------------
    const dm = Math.hypot(p.x - MARKET.x, p.z - MARKET.z);
    if (dm < TRADE_RADIUS) {
      p.nearTrade = 'market';
    } else {
      const port = nearestPortFor(state, 0, p.x, p.z, TRADE_RADIUS);
      p.nearTrade = port ? port.id : null;
    }
  }

  function update(dt) {
    if (!p) return;
    const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.1) : 1 / 60;

    const locked = state.phase === 'over'
      || (gameCamera && gameCamera.isOverview === true);
    const dir = locked ? { x: 0, z: 0, mag: 0 } : readStick();

    /* --------------------------------------------------------- velocity */
    const tvx = dir.x * PLAYER_SPEED * dir.mag;
    const tvz = dir.z * PLAYER_SPEED * dir.mag;
    if (!Number.isFinite(p.vx)) p.vx = 0;
    if (!Number.isFinite(p.vz)) p.vz = 0;

    const dvx = tvx - p.vx, dvz = tvz - p.vz;
    const dm = Math.hypot(dvx, dvz);
    // Decelerate harder than we accelerate — snappy stops feel good on touch.
    const maxDelta = PLAYER_ACCEL * step * (dir.mag > 0.02 ? 1 : 1.7);
    if (dm > maxDelta && dm > 1e-6) {
      p.vx += (dvx / dm) * maxDelta;
      p.vz += (dvz / dm) * maxDelta;
    } else {
      p.vx = tvx; p.vz = tvz;
    }

    /* --------------------------------------------------------- position */
    const beforeX = p.x, beforeZ = p.z;
    const nx = p.x + p.vx * step;
    const nz = p.z + p.vz * step;
    if (Number.isFinite(nx) && Number.isFinite(nz)) moveWithSlide(nx, nz);

    // Hard safety: never leave the island, never hold a NaN.
    if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) { p.x = MARKET.x; p.z = MARKET.z; }
    const safe = clampToIsland(p.x, p.z);
    p.x = safe.x; p.z = safe.z;

    const moved = Math.hypot(p.x - beforeX, p.z - beforeZ);
    if (p.stats) p.stats.distance += moved;

    const spd = Math.hypot(p.vx, p.vz);

    /* ---------------------------------------------------------- facing */
    if (spd > 0.35) p.facing = Math.atan2(p.vz, p.vx);
    if (!Number.isFinite(p.facing)) p.facing = 0;

    /* ---------------------------------------------------------- action */
    // Two states, and only two: running or standing. There is no 'gather'
    // action left to clear — collecting is a side effect of moving.
    if (spd > RUN_THRESHOLD && moved > 1e-5) p.action = 'run';
    else if (p.action === 'run') p.action = 'idle';

    /* ---------------------------------------------------------- intent */
    updateIntent();

    /* ---------------------------------------------------------- camera */
    if (gameCamera) {
      if (gameCamera.follow) gameCamera.follow(p.x, p.z, step);
      if (gameCamera.shake && settler && typeof settler.impacts === 'number') {
        const n = settler.impacts - lastImpacts;
        if (n > 0) {
          lastImpacts = settler.impacts;
          gameCamera.shake(clamp(0.34 * n, 0, 0.7));
        }
      }
    }
  }

  return { update };
}

export default createPlayerController;
