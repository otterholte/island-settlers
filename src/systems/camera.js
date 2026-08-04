/**
 * Island Settlers — game camera.
 *
 *   createGameCamera(renderer, scene) ->
 *     { camera, follow(x,z,dt), setOverview(on), celebrate(player),
 *       shake(amount), update(dt, state, overviewOpen), isOverview, yaw,
 *       setFreeLook(on, mode), freeMode(mode), freeDrag(dx,dy,h),
 *       freeTurn(dYaw,dPitch), freeZoom(k), freeStep(fwd,right,dt),
 *       freeRecentre(), freeInfo }
 *
 * Third-person, spring-damped, fixed yaw (0) so "stick up" is always away
 * from the camera — the controller reads `yaw` to map the joystick into world
 * space.
 *
 * FREE LOOK — after the match only
 * --------------------------------
 * Once the results panel has been dismissed there is no settler left to follow,
 * so the camera becomes the player's own. `setFreeLook(true, mode)` blends out
 * of whatever framing is on screen and into a pose the player drives directly:
 * a focus point on the ground, a yaw, a pitch and a distance. `systems/freecam.js`
 * owns the pointer, wheel and keyboard that push it; everything here does is
 * hold the pose, ease it and CLAMP it — the focus stays inside a disc around the
 * island, pitch stays between 16 and 78 degrees, the distance stays between a
 * shoulder-height framing and a little past the whole-island one, and the eye is
 * never allowed under the ground. There is no way to fly off into the void and
 * no way to end up under the sea looking up at it.
 *
 * Nothing about the in-match follow camera changes: `freeOn` is false for the
 * entire match, and while it is false not one line of this runs.
 *
 * Framing (art-director pass 2): pitch 50 degrees down with a long 36-degree
 * lens, dollied back so 4-5 hexes read around the settler and the ocean stays
 * on the frame edge near the coast. The long lens is what keeps number tokens
 * a uniform size front-to-back — a wide lens made near tokens 3x the far ones.
 * The look point is pushed away from the camera by a fraction of the distance
 * so the settler sits below frame centre and the island/horizon fills the top,
 * matching the reference board shots. Pulls back at speed, tightens while
 * gathering.
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

const FOV = 36;
const PLAY_PITCH = 50 * DEG;
const PLAY_YAW = 0;
const BASE_DIST = 56;
const SPEED_PULL = 10.0;
const GATHER_TIGHTEN = 8.0;

/** Height above the ground that the camera aims at (settler chest height). */
const FOCUS_LIFT = 2.0;
/** Look point is pushed this fraction of `dist` further from the camera, which
 *  tips the settler below frame centre and opens up horizon at the top. */
const LOOK_BIAS = 0.075;

const OVER_PITCH = 55 * DEG;
const OVER_MARGIN = 1.12;
const OVER_SEC = 0.55;

const CELEB_SEC = 1.4;
const CELEB_PITCH = 38 * DEG;
const CELEB_DIST = 50;

/* ---------------------------------------------------------------- free look */
/** Blend in / out of the free camera, seconds. */
const FREE_SEC = 0.5;
/** How far the focus point may wander from the middle of the board. The island
 *  itself runs to BOUNDS.radius; the extra 15% is the beach and a strip of
 *  water, which is as far out as anybody wants to stand. */
const FREE_RANGE = BOUNDS.radius * 1.15;
const FREE_PITCH_MIN = 16 * DEG;
const FREE_PITCH_MAX = 78 * DEG;
const FREE_DIST_MIN = 18;
/** Multiplier on the whole-island framing distance — the far end of the zoom. */
const FREE_DIST_MAX_K = 1.45;
/** Metres the eye is always kept above whatever ground is under it. */
const FREE_EYE_CLEAR = 3.5;
/**
 * The review camera runs slow on purpose.
 *
 *   "When I'm reviewing the board game after it ends, make the camera movement
 *    go slower."
 *
 * `FREE_PAN_GAIN` is metres of ground per pixel of drag as a fraction of the
 * true 1:1 projection — the ground no longer sticks to the finger exactly, it
 * trails it, which is what makes a slow drag readable. `FREE_STEP_K` is the
 * keyboard walk as a fraction of the framing distance, and `FREE_EASE` is how
 * hard the live pose chases the wanted one (it is what gives zoom and recentre
 * their glide). Every clamp above is untouched.
 *
 *   pan drag       1.00 -> 0.45 of ground metres per pixel
 *   keyboard pan   dist * 0.65 clamped 16..90 m/s -> dist * 0.28 clamped 7..34
 *   pose ease      9.0 -> 5.0 per second
 */
const FREE_PAN_GAIN = 0.45;
const FREE_STEP_K = 0.28;
const FREE_STEP_MIN = 7;
const FREE_STEP_MAX = 34;
const FREE_EASE = 5.0;

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

  /* ------------------------------------------------------------- free look */
  // `live` is what the camera is using this frame; `want` is where the player
  // has asked it to be. A drag writes both (so it tracks the finger exactly);
  // a mode change writes only `want` (so it eases across).
  const fLive = {
    x: BOUNDS.cx, z: BOUNDS.cz,
    yaw: PLAY_YAW, pitch: PLAY_PITCH, dist: BASE_DIST
  };
  const fWant = { ...fLive };
  let freeOn = false;
  let freeT = 0;
  let freeModeName = 'close';
  /** Set true by clampFree() whenever the player is pushing at a limit. */
  let freeAtLimit = '';

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
      focus.set(x, groundAt(x, z) + FOCUS_LIFT, z);
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
  /** End the victory orbit and hand the camera back to normal play. */
  function endCelebrate() {
    celebrating = false;
    celT = 0;
  }

  function celebrate(player) {
    // Only the end-of-match sequence may start this. Once running it takes the
    // camera over completely, so it must always have a way out — see update().
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

  /* ----------------------------------------------------------- free look */

  const freeDistMax = () => Math.max(FREE_DIST_MIN + 10, overviewDistance() * FREE_DIST_MAX_K);

  /** The one place a free pose is allowed to become legal. */
  function clampFree(p) {
    freeAtLimit = '';
    if (!Number.isFinite(p.x)) p.x = BOUNDS.cx;
    if (!Number.isFinite(p.z)) p.z = BOUNDS.cz;
    const dx = p.x - BOUNDS.cx, dz = p.z - BOUNDS.cz;
    const r = Math.hypot(dx, dz);
    if (r > FREE_RANGE) {
      const k = FREE_RANGE / r;
      p.x = BOUNDS.cx + dx * k;
      p.z = BOUNDS.cz + dz * k;
      freeAtLimit += 'range ';
    }
    if (!Number.isFinite(p.pitch)) p.pitch = PLAY_PITCH;
    if (p.pitch < FREE_PITCH_MIN) { p.pitch = FREE_PITCH_MIN; freeAtLimit += 'pitch-lo '; }
    if (p.pitch > FREE_PITCH_MAX) { p.pitch = FREE_PITCH_MAX; freeAtLimit += 'pitch-hi '; }
    if (!Number.isFinite(p.dist)) p.dist = BASE_DIST;
    const dmax = freeDistMax();
    if (p.dist < FREE_DIST_MIN) { p.dist = FREE_DIST_MIN; freeAtLimit += 'near '; }
    if (p.dist > dmax) { p.dist = dmax; freeAtLimit += 'far '; }
    // Yaw is free to wind, but keep it in a sane float range forever.
    if (!Number.isFinite(p.yaw)) p.yaw = PLAY_YAW;
    if (p.yaw > Math.PI * 8 || p.yaw < -Math.PI * 8) p.yaw %= Math.PI * 2;
    return p;
  }

  /** The two framings the end-of-match bar switches between. */
  function freeMode(mode, snap) {
    freeModeName = mode === 'board' ? 'board' : 'close';
    if (freeModeName === 'board') {
      fWant.x = BOUNDS.cx; fWant.z = BOUNDS.cz;
      fWant.yaw = 0;
      fWant.pitch = OVER_PITCH;
      fWant.dist = overviewDistance();
    } else {
      fWant.x = followX; fWant.z = followZ;
      fWant.yaw = PLAY_YAW;
      fWant.pitch = PLAY_PITCH;
      fWant.dist = BASE_DIST;
    }
    clampFree(fWant);
    if (snap) Object.assign(fLive, fWant);
    return freeModeName;
  }

  /**
   * Hand the camera to the player (or take it back). Called by hud-end.js once
   * the results panel has been dismissed — never during a match.
   */
  function setFreeLook(on, mode) {
    const next = !!on;
    if (next && !freeOn) {
      // Start from wherever we are so the blend has somewhere sensible to go.
      freeMode(mode || freeModeName, true);
    } else if (next && mode) {
      freeMode(mode, false);
    }
    freeOn = next;
    return freeOn;
  }

  /* Ground metres per screen pixel at the current framing. Horizontal and
     vertical differ because the ground is seen at a slant. */
  function metresPerPixel(hPx) {
    const h = Number.isFinite(hPx) && hPx > 1 ? hPx : ((dom && dom.clientHeight) || 720);
    return (2 * fLive.dist * Math.tan((FOV * DEG) / 2)) / h;
  }

  /** Drag the ground: the world trails the finger. Pixels in, metres out. */
  function freeDrag(dxPx, dyPx, hPx) {
    if (!freeOn) return false;
    const mpp = metresPerPixel(hPx) * FREE_PAN_GAIN;
    // A shallow pitch stretches vertical screen travel across a lot of ground;
    // the divisor is capped so a near-horizon drag does not teleport.
    const vert = mpp / Math.max(0.35, Math.sin(fLive.pitch));
    const fx = -Math.sin(fLive.yaw), fz = -Math.cos(fLive.yaw);   // away from camera
    const rx = -fz, rz = fx;                                      // screen right
    /*
     * THE VERTICAL SIGN, WHICH WAS BACKWARDS.
     *
     *   "In the board view after the game is over, dragging left and right is
     *    working, but dragging with my finger up and down is going the wrong
     *    direction."
     *
     * Both axes move the FOCUS, and the focus moves the rig, so the world goes
     * the opposite way to the focus on screen. Right on both counts horizontally
     * — drag right, focus goes left, ground goes right with the finger. But the
     * vertical had the same minus sign, and vertically it does not mean the same
     * thing: moving the focus BACKWARD (towards the camera) slides the ground UP
     * the screen, so a downward drag was pushing the island up and away.
     *
     * Drag down, focus goes FORWARD, ground comes down after the finger. It read
     * as correct in review because the only pan the trace rig ever measured was
     * a horizontal one — see the vertical assertion in uishot's results stage,
     * which now checks the sign of the focus travel along BOTH axes.
     */
    const mx = -dxPx * mpp, my = dyPx * vert;
    fWant.x = fLive.x + rx * mx + fx * my;
    fWant.z = fLive.z + rz * mx + fz * my;
    clampFree(fWant);
    fLive.x = fWant.x; fLive.z = fWant.z;
    return true;
  }

  /** Orbit. Radians in — the driver decides how many per pixel. */
  function freeTurn(dYaw, dPitch) {
    if (!freeOn) return false;
    fWant.yaw = fLive.yaw + (Number.isFinite(dYaw) ? dYaw : 0);
    fWant.pitch = fLive.pitch + (Number.isFinite(dPitch) ? dPitch : 0);
    clampFree(fWant);
    fLive.yaw = fWant.yaw; fLive.pitch = fWant.pitch;
    return true;
  }

  /** Multiplicative: < 1 pulls in, > 1 pushes out. */
  function freeZoom(k) {
    if (!freeOn || !Number.isFinite(k) || k <= 0) return false;
    fWant.dist = fLive.dist * k;
    clampFree(fWant);
    // Zoom eases rather than snapping — it is the one gesture that reads better
    // with a little weight behind it.
    return true;
  }

  /** Keyboard pan. `fwd` / `right` in -1..1, scaled by how far out we are. */
  function freeStep(fwd, right, dt) {
    if (!freeOn) return false;
    const f = Number.isFinite(fwd) ? clamp(fwd, -1, 1) : 0;
    const r = Number.isFinite(right) ? clamp(right, -1, 1) : 0;
    if (!f && !r) return false;
    const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.1) : 1 / 60;
    const speed = clamp(fLive.dist * FREE_STEP_K, FREE_STEP_MIN, FREE_STEP_MAX);
    const fx = -Math.sin(fLive.yaw), fz = -Math.cos(fLive.yaw);
    const rx = -fz, rz = fx;
    fWant.x = fLive.x + (fx * f + rx * r) * speed * step;
    fWant.z = fLive.z + (fz * f + rz * r) * speed * step;
    clampFree(fWant);
    fLive.x = fWant.x; fLive.z = fWant.z;
    return true;
  }

  /** Back to the preset for whichever framing we are in. */
  function freeRecentre() {
    if (!freeOn) return false;
    freeMode(freeModeName, false);
    return true;
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
    want.set(followX + ax, groundAt(followX, followZ) + FOCUS_LIFT, followZ + az);

    // Critically damped spring on the focus point.
    //
    // Explicit Euler on a stiffness-120 spring diverges once the step exceeds
    // ~0.09s, which a phone hitting a GC pause or a slow first frame will do.
    // Sub-step at a fixed 1/120s so the tuned feel survives any frame rate,
    // and keep a hard snap as a last resort.
    const stiff = 120, damping = 2 * Math.sqrt(stiff) * 0.98;
    const sub = 1 / 120;
    const n = Math.max(1, Math.min(16, Math.ceil(step / sub)));
    const h = step / n;
    for (let i = 0; i < n; i++) {
      for (const axis of ['x', 'y', 'z']) {
        const a = (want[axis] - focus[axis]) * stiff - focusVel[axis] * damping;
        focusVel[axis] += a * h;
        focus[axis] += focusVel[axis] * h;
      }
    }
    for (const axis of ['x', 'y', 'z']) {
      if (!Number.isFinite(focus[axis]) || Math.abs(focus[axis] - want[axis]) > 90) {
        focus[axis] = want[axis];
        focusVel[axis] = 0;
      }
      focusVel[axis] = clamp(focusVel[axis], -400, 400);
    }

    const wantDist = BASE_DIST + sp01 * SPEED_PULL - (gathering ? GATHER_TIGHTEN : 0);
    dist += (wantDist - dist) * (1 - Math.exp(-4.5 * step));

    const sy = Math.sin(PLAY_PITCH), cy = Math.cos(PLAY_PITCH);
    _pos.set(
      focus.x + Math.sin(PLAY_YAW) * dist * cy,
      focus.y + dist * sy,
      focus.z + Math.cos(PLAY_YAW) * dist * cy
    );
    // Bias the aim past the settler, along the camera's own forward vector on
    // the ground plane. Purely a framing shift: the settler drops below centre
    // and the extra headroom fills with island and sea instead of dirt.
    _look.set(
      focus.x - Math.sin(PLAY_YAW) * dist * LOOK_BIAS,
      focus.y,
      focus.z - Math.cos(PLAY_YAW) * dist * LOOK_BIAS
    );

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

    /* ---- celebration orbit --------------------------------------------
       Strictly for the end of a match. `celebrating` used to be set and never
       cleared, so `celAngle` kept winding on forever: any stray call left the
       camera slowly orbiting the island with no way for the player to stop it.
       It now runs only while the match is actually over, and releases itself
       the moment play resumes. */
    if (celebrating && state && state.phase !== 'over') endCelebrate();

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

    /* ---- free look -----------------------------------------------------
       Last, so it wins outright: after the match the player owns the view and
       nothing — not the overview blend, not a stray orbit — may argue with it.
       The pose eases toward whatever the driver has asked for, is clamped every
       frame (not only when a gesture writes it), and the eye is lifted clear of
       the ground so a low pitch on the coast cannot bury the camera in a cliff. */
    const freeTarget = freeOn ? 1 : 0;
    const freeRate = step / FREE_SEC;
    freeT = freeTarget > freeT ? Math.min(1, freeT + freeRate) : Math.max(0, freeT - freeRate);
    if (freeT > 0) {
      const kk = 1 - Math.exp(-FREE_EASE * step);
      fLive.x += (fWant.x - fLive.x) * kk;
      fLive.z += (fWant.z - fLive.z) * kk;
      fLive.yaw += (fWant.yaw - fLive.yaw) * kk;
      fLive.pitch += (fWant.pitch - fLive.pitch) * kk;
      fLive.dist += (fWant.dist - fLive.dist) * kk;
      clampFree(fLive);

      const gy = groundAt(fLive.x, fLive.z);
      const aimY = gy + FOCUS_LIFT;
      const cp = Math.cos(fLive.pitch), sp2 = Math.sin(fLive.pitch);
      _p2.set(
        fLive.x + Math.sin(fLive.yaw) * fLive.dist * cp,
        aimY + fLive.dist * sp2,
        fLive.z + Math.cos(fLive.yaw) * fLive.dist * cp
      );
      const floorY = groundAt(_p2.x, _p2.z) + FREE_EYE_CLEAR;
      if (_p2.y < floorY) _p2.y = floorY;
      _l2.set(fLive.x, aimY, fLive.z);
      const fk = easeIO(freeT);
      _pos.lerp(_p2, fk);
      _look.lerp(_l2, fk);
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
    endCelebrate,
    shake,
    update,

    /* ---- free look: driven by systems/freecam.js after the match ---- */
    setFreeLook, freeMode, freeDrag, freeTurn, freeZoom, freeStep, freeRecentre,
    get freeLook() { return freeOn; },
    /** Everything a trace needs to prove the camera moved and stayed bounded.
     *  `limit` lists the bounds the LIVE pose is currently resting against, so
     *  a capture can assert "pushed past the edge, stopped at the edge". */
    get freeInfo() {
      const dmax = freeDistMax();
      const r = Math.hypot(fLive.x - BOUNDS.cx, fLive.z - BOUNDS.cz);
      const lim = [];
      if (r >= FREE_RANGE - 0.08) lim.push('range');
      if (fLive.pitch <= FREE_PITCH_MIN + 1e-3) lim.push('pitch-lo');
      if (fLive.pitch >= FREE_PITCH_MAX - 1e-3) lim.push('pitch-hi');
      if (fLive.dist <= FREE_DIST_MIN + 0.02) lim.push('near');
      if (fLive.dist >= dmax - 0.02) lim.push('far');
      return {
        on: freeOn, mode: freeModeName, blend: +freeT.toFixed(3),
        x: +fLive.x.toFixed(2), z: +fLive.z.toFixed(2),
        r: +r.toFixed(2),
        yaw: +fLive.yaw.toFixed(3), pitch: +fLive.pitch.toFixed(3),
        dist: +fLive.dist.toFixed(2),
        limit: lim.join('+'),
        clamped: freeAtLimit.trim(),
        range: +FREE_RANGE.toFixed(2),
        pitchRange: [+FREE_PITCH_MIN.toFixed(3), +FREE_PITCH_MAX.toFixed(3)],
        distRange: [FREE_DIST_MIN, +dmax.toFixed(2)]
      };
    },

    /** The review camera's own rates, so a trace can report them verbatim. */
    get freeRates() {
      return {
        panGain: FREE_PAN_GAIN, stepK: FREE_STEP_K,
        stepClamp: [FREE_STEP_MIN, FREE_STEP_MAX], ease: FREE_EASE,
        blendSec: FREE_SEC
      };
    },

    /** Gameplay yaw — fixed, so joystick-up is always away from the camera. */
    get yaw() { return PLAY_YAW; },
    get isOverview() { return overviewOn; },
    get overviewBlend() { return ovT; },
    get focus() { return focus; },
    get distance() { return dist; }
  };
}

export default createGameCamera;
