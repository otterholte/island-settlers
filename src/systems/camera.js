/**
 * Island Settlers — game camera.
 *
 *   createGameCamera(renderer, scene) ->
 *     { camera, follow(x,z,dt), setOverview(on), celebrate(player),
 *       shake(amount), update(dt, state, overviewOpen), isOverview, yaw }
 *
 * Third-person, spring-damped, fixed yaw (0) so "stick up" is always away
 * from the camera — the controller reads `yaw` to map the joystick into world
 * space. Pitch ~40 degrees down, fov 48, framed for roughly three hexes
 * around the settler. Pulls back at speed, tightens while gathering.
 *
 * Overview eases to a near-isometric framing that fits the whole island using
 * BOUNDS from layout.js. The `overviewOpen` argument of update() is
 * edge-triggered, so an explicit setOverview() still wins between edges.
 *
 * Owner: Character agent.
 */

import * as THREE from 'three';
import { BOUNDS, intersections } from '../board/layout.js';
import { PLAYER_SPEED } from '../core/constants.js';
import { groundAt } from '../entities/ground.js';

const DEG = Math.PI / 180;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const easeIO = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

const FOV = 48;
const PLAY_PITCH = 40 * DEG;
const PLAY_YAW = 0;
const BASE_DIST = 34;
const SPEED_PULL = 6.5;
const GATHER_TIGHTEN = 5.0;

const OVER_PITCH = 55 * DEG;
const OVER_MARGIN = 1.12;
const OVER_SEC = 0.55;

const CELEB_SEC = 1.4;
const CELEB_PITCH = 31 * DEG;
const CELEB_DIST = 33;

export function createGameCamera(renderer, scene) {
  const dom = renderer && renderer.domElement ? renderer.domElement : null;
  const w = (dom && dom.clientWidth) || (typeof innerWidth !== 'undefined' ? innerWidth : 1280);
  const h = (dom && dom.clientHeight) || (typeof innerHeight !== 'undefined' ? innerHeight : 720);

  const camera = new THREE.PerspectiveCamera(FOV, (w / h) || 1.78, 0.5, 900);
  camera.position.set(0, 24, 30);
  camera.lookAt(0, 2, 0);
  camera.name = 'gameCamera';
  if (scene && scene.add && !camera.parent) scene.add(camera);

  /* ---------------------------------------------------------------- state */
  const focus = new THREE.Vector3(BOUNDS.cx, 3, BOUNDS.cz);
  const focusVel = new THREE.Vector3();
  const want = new THREE.Vector3(BOUNDS.cx, 3, BOUNDS.cz);

  let followX = BOUNDS.cx, followZ = BOUNDS.cz;
  let seeded = false;
  let fvx = 0, fvz = 0;
  let lastFX = BOUNDS.cx, lastFZ = BOUNDS.cz;

  let dist = BASE_DIST;
  let overviewOn = false;
  let ovT = 0;
  let lastOverviewArg = false;

  let celebrating = false;
  let celT = 0, celAngle = 0;
  const celCenter = new THREE.Vector3(BOUNDS.cx, 3, BOUNDS.cz);

  let shakeAmt = 0, shakeT = 0;

  const _pos = new THREE.Vector3();
  const _look = new THREE.Vector3();
  const _p2 = new THREE.Vector3();
  const _l2 = new THREE.Vector3();

  /* --------------------------------------------------------------- follow */
  function follow(x, z, dt) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    followX = x; followZ = z;
    if (!seeded) {
      seeded = true;
      focus.set(x, groundAt(x, z) + 1.1, z);
      lastFX = x; lastFZ = z;
    }
    const step = Number.isFinite(dt) && dt > 1e-5 ? dt : 1 / 60;
    const k = 1 - Math.exp(-8 * step);
    fvx += ((x - lastFX) / step - fvx) * k;
    fvz += ((z - lastFZ) / step - fvz) * k;
    lastFX = x; lastFZ = z;
  }

  /* ------------------------------------------------------------- overview */
  function setOverview(on) {
    overviewOn = !!on;
  }

  function overviewDistance() {
    const aspect = camera.aspect || 1.78;
    const tanHalf = Math.tan((FOV * DEG) / 2);
    const halfD = (BOUNDS.depth / 2) + 8;
    const halfW = (BOUNDS.width / 2) + 8;
    const byDepth = (halfD * Math.sin(OVER_PITCH)) / tanHalf;
    const byWidth = halfW / (tanHalf * aspect);
    return Math.max(byDepth, byWidth) * OVER_MARGIN;
  }

  /* ------------------------------------------------------------ celebrate */
  function celebrate(player) {
    celebrating = true;
    celT = 0;
    let cx = 0, cz = 0, n = 0;
    if (player) {
      const ids = [];
      if (player.settlements) for (const i of player.settlements) ids.push(i);
      if (player.cities) for (const i of player.cities) ids.push(i);
      for (const i of ids) {
        const node = intersections[i];
        if (node) { cx += node.x; cz += node.z; n++; }
      }
      if (!n && Number.isFinite(player.x)) { cx = player.x; cz = player.z; n = 1; }
    }
    if (!n) { cx = BOUNDS.cx; cz = BOUNDS.cz; n = 1; }
    cx /= n; cz /= n;
    celCenter.set(cx, groundAt(cx, cz) + 2.2, cz);
    celAngle = Math.atan2(camera.position.x - cx, camera.position.z - cz);
  }

  /* ---------------------------------------------------------------- shake */
  function shake(amount) {
    const a = Number.isFinite(amount) ? amount : 0.3;
    shakeAmt = clamp(shakeAmt + Math.abs(a), 0, 1.4);
  }

  /* --------------------------------------------------------------- update */
  function update(dt, state, overviewOpen) {
    const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.1) : 1 / 60;

    // Edge-triggered: react only when the argument actually changes.
    const arg = !!overviewOpen;
    if (arg !== lastOverviewArg) { lastOverviewArg = arg; overviewOn = arg; }

    const p = state && state.players ? state.players[0] : null;
    if (p && !seeded && Number.isFinite(p.x)) follow(p.x, p.z, step);

    const vx = p && Number.isFinite(p.vx) ? p.vx : fvx;
    const vz = p && Number.isFinite(p.vz) ? p.vz : fvz;
    const spd = Math.hypot(vx, vz);
    const sp01 = clamp(spd / PLAYER_SPEED, 0, 1.1);
    const gathering = !!p && p.action === 'gather';

    /* ---- play framing ------------------------------------------------ */
    const lead = clamp(0.30, 0, 1);
    const ax = clamp(vx * lead, -4.5, 4.5);
    const az = clamp(vz * lead, -4.5, 4.5);
    want.set(followX + ax, groundAt(followX, followZ) + 1.15, followZ + az);

    // Critically damped spring on the focus point.
    const stiff = 120, damping = 2 * Math.sqrt(stiff) * 0.98;
    for (const axis of ['x', 'y', 'z']) {
      const a = (want[axis] - focus[axis]) * stiff - focusVel[axis] * damping;
      focusVel[axis] += a * step;
      focus[axis] += focusVel[axis] * step;
      if (!Number.isFinite(focus[axis])) { focus[axis] = want[axis]; focusVel[axis] = 0; }
    }

    const wantDist = BASE_DIST + sp01 * SPEED_PULL - (gathering ? GATHER_TIGHTEN : 0);
    dist += (wantDist - dist) * (1 - Math.exp(-4.5 * step));

    const sy = Math.sin(PLAY_PITCH), cy = Math.cos(PLAY_PITCH);
    _pos.set(
      focus.x + Math.sin(PLAY_YAW) * dist * cy,
      focus.y + dist * sy,
      focus.z + Math.cos(PLAY_YAW) * dist * cy
    );
    _look.copy(focus);

    /* ---- overview framing -------------------------------------------- */
    const ovTarget = overviewOn ? 1 : 0;
    const rate = step / OVER_SEC;
    ovT = ovTarget > ovT ? Math.min(1, ovT + rate) : Math.max(0, ovT - rate);
    if (ovT > 0) {
      const od = overviewDistance();
      const gy = groundAt(BOUNDS.cx, BOUNDS.cz);
      _p2.set(
        BOUNDS.cx,
        gy + od * Math.sin(OVER_PITCH),
        BOUNDS.cz + od * Math.cos(OVER_PITCH)
      );
      _l2.set(BOUNDS.cx, gy + 1.0, BOUNDS.cz);
      const k = easeIO(ovT);
      _pos.lerp(_p2, k);
      _look.lerp(_l2, k);
    }

    /* ---- celebration orbit -------------------------------------------- */
    if (celebrating) {
      celT = Math.min(CELEB_SEC, celT + step);
      celAngle += step * 0.24;
      const cd = CELEB_DIST;
      _p2.set(
        celCenter.x + Math.sin(celAngle) * cd * Math.cos(CELEB_PITCH),
        celCenter.y + cd * Math.sin(CELEB_PITCH),
        celCenter.z + Math.cos(celAngle) * cd * Math.cos(CELEB_PITCH)
      );
      _l2.copy(celCenter);
      const k = easeIO(celT / CELEB_SEC);
      _pos.lerp(_p2, k);
      _look.lerp(_l2, k);
    }

    /* ---- shake -------------------------------------------------------- */
    if (shakeAmt > 0.0005) {
      shakeT += step * 42;
      const m = shakeAmt * shakeAmt * 0.55;
      _pos.x += Math.sin(shakeT * 1.7) * m;
      _pos.y += Math.sin(shakeT * 2.3 + 1.1) * m * 0.8;
      _pos.z += Math.cos(shakeT * 1.9 + 0.4) * m;
      shakeAmt *= Math.exp(-7.5 * step);
    } else {
      shakeAmt = 0;
    }

    if (!Number.isFinite(_pos.x) || !Number.isFinite(_pos.y) || !Number.isFinite(_pos.z)) {
      _pos.set(BOUNDS.cx, 60, BOUNDS.cz + 60);
      _look.set(BOUNDS.cx, 2, BOUNDS.cz);
    }

    camera.position.copy(_pos);
    camera.lookAt(_look);
    camera.updateMatrixWorld();
  }

  return {
    camera,
    follow,
    setOverview,
    celebrate,
    shake,
    update,
    /** Gameplay yaw — fixed, so joystick-up is always away from the camera. */
    get yaw() { return PLAY_YAW; },
    get isOverview() { return overviewOn; },
    get overviewBlend() { return ovT; },
    get focus() { return focus; },
    get distance() { return dist; }
  };
}

export default createGameCamera;
