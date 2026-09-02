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
  PLAYER_SPEED, PLAYER_ACCEL, INTERACT_RADIUS, TRADE_RADIUS, PORT_RADIUS
} from '../core/constants.js';
import { clampToIsland, tileAt, MARKET } from '../board/layout.js';
import { nearestItem } from '../board/nodes.js';
import { nearestPortFor, canGatherTile } from '../core/rules.js';
import { useHeightSampler } from './ground.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

const RUN_THRESHOLD = 0.6;      // world units/sec before we call it running

/**
 * THE SHORE TURNS YOU. IT NEVER HOLDS YOU.
 *
 *   "There seem to be items that I can occasionally get stuck by running into
 *    with my character, like the settlements, or cities, or the little posts
 *    sticking out of the ground for where settlements can be built. I should
 *    never get stuck but always run through without an issue."
 *
 * Nothing a player builds has ever been solid. There is no collision anywhere
 * in this game against a settlement, a city, a road or one of the little posts
 * that marks a buildable corner — `moveWithSlide` below is the ONLY thing that
 * has ever refused a settler a step, and all it knows about is the water. So
 * the buildings in that report are innocent bystanders, and the temptation to
 * go hunting for a structure radius to delete would have found nothing.
 *
 * What the player is actually hitting is the coastline, at exactly the places
 * they named. The island is the union of nineteen hexes, so its outline is a
 * zigzag, and every corner of that zigzag is an INTERSECTION — which is to say
 * a settlement spot with a post standing on it, and later a settlement, and
 * later a city. Eighteen of them are the outward-pointing tip of a single hex,
 * where the land narrows to a 120-degree wedge with water on both sides of it.
 * Run at the post on one of those tips and you run into a funnel.
 *
 * The old slide could not get you out of a funnel. It tried the step, then the
 * step with the X kept and the Z dropped, then the X dropped and the Z kept —
 * three candidate directions, all axis-aligned — and when the wedge walls took
 * all three it fell through to "stay where you are and throw away nine tenths
 * of your speed". Hold the stick and it did that again the next step, and the
 * next: the settler stands in the corner vibrating while the player pushes.
 * That is the "stuck", and the reason it felt like the buildings' fault is that
 * a building is always standing on the exact spot where it happens.
 *
 * The replacement asks a much better question. Not "can I keep my X or my Z"
 * but "what is the smallest turn that lets me keep running at full speed" — a
 * fan of candidate headings either side of the one the stick asked for, tried
 * from the smallest deflection outwards. Against a straight shore the answer is
 * a few degrees and the settler hugs it; into a funnel the answer is a big turn
 * and the settler sweeps out along the wall it came in past. Both are motion.
 * There is no branch left that keeps a settler where it is while the stick is
 * pushing, which is the whole of the promise made above.
 *
 * Four degrees is fine enough that a hugged shore reads as smooth rather than
 * as a settler stepping between eight compass headings, and the fan runs to a
 * full half turn so that a settler somehow standing on the very point of a tip
 * can still walk back the way it came. Each magnitude is tried in a fixed order
 * — the positive rotation before its mirror image, always — because this file
 * runs twice, once in front of the player and once inside
 * `server/matchworker.mjs`, and the two copies have to take the same step from
 * the same input every time or the server will spend the match correcting a
 * prediction that was never wrong. The tie only comes up on an exactly head-on
 * approach to a straight shore, where the two answers are mirror images of each
 * other and the only thing that matters is that both machines pick the same one.
 */
const SLIDE_FAN = (() => {
  const fan = [];
  for (let deg = 4; deg <= 180; deg += 4) {
    const a = (deg * Math.PI) / 180;
    const c = Math.cos(a), s = Math.sin(a);
    fan.push(c, s);
    if (deg < 180) fan.push(c, -s);
  }
  return fan;
})();

/**
 * How far inside the water's edge a sliding settler is held, in world units.
 *
 * Sliding along the shore means running exactly parallel to it, and a step that
 * runs exactly parallel to a hex edge from a point exactly on that hex edge is
 * a coin toss in floating point: half the time the landing point rounds to the
 * water side and the fan rejects the one heading that was actually right. The
 * first version of this fix did exactly that and the settler still could not
 * get out of the wedge at a coastal post — it was refused the two headings that
 * run along the walls, took a heading most of a half turn away from the stick
 * instead, and spent every frame having that reversal fought back out of it by
 * the accelerator. Full speed on paper, a crawl in the hand, which is not what
 * was asked for.
 *
 * So a sliding step lands five centimetres inland of where it was aimed, along
 * the line to the middle of the hex the settler is standing on. A settler at
 * full pelt inside the fixed 60 Hz step this file is driven at covers 0.2 of a
 * unit, so the margin is a twentieth of one stride — far too small to see or to
 * feel through the stick — and it is comfortably more than the four-degree
 * fan can throw a stride sideways (0.014). The heading that hugs the coast is
 * chosen now for the honest reason that it is the smallest turn that works.
 */
const SHORE_MARGIN = 0.05;

/**
 * `opts.pid` names the seat this controller drives. It is 0 in the browser and
 * always will be — there is one human here and they are player zero.
 *
 * The online server is the reason it is a parameter at all: it runs this exact
 * file, headlessly, once per human in the match, so that a settler moves on the
 * server for precisely the same reasons it moves in front of the person
 * pushing it. A second implementation of "how fast does a settler accelerate"
 * is a second implementation that can disagree with the first, and the whole
 * point of an authoritative server is that it does not.
 */
export function createPlayerController(state, settler, gameCamera, input, world, opts = {}) {
  if (world && typeof world.heightAt === 'function') useHeightSampler(world.heightAt);

  /**
   * `opts.roam` — is the settler allowed to move even though the match is over?
   *
   *   "When I'm reviewing the board after the game has ended, instead of having
   *    me use my finger to swipe up and down left and right, just let me use
   *    the normal invisible joystick and run around with my character."
   *
   * A finished match is frozen and stays frozen: nothing here gathers, builds,
   * trades or scores after the last point lands. This unlocks the ONE thing
   * that was never a rule — walking — so the review is a lap of the island you
   * just played rather than a camera on a stick. `hud-end.js` raises it with
   * the review bar and drops it the moment the bar goes; the server passes
   * nothing, so a headless controller never roams.
   */
  const canRoam = typeof opts.roam === 'function' ? opts.roam : () => false;

  const pid = Number.isInteger(opts.pid) ? opts.pid : 0;
  const p = state && state.players ? state.players[pid] : null;
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
    // `tileAt` rather than `clampToIsland` for the test: they answer the same
    // question — is this point on the island — but the clamp also runs an
    // eighteen-step bisection back toward a tile centre to produce a landing
    // spot, and the fan below asks the question up to eighty-nine times in a
    // step it is about to reject anyway. We only want the bisection once, in
    // the fallback that never fires.
    if (tileAt(nx, nz)) { p.x = nx; p.z = nz; return; }

    const dx = nx - p.x, dz = nz - p.z;
    if (Math.abs(dx) < 1e-7 && Math.abs(dz) < 1e-7) return;

    // The hex the settler is standing on points inland: its middle is the one
    // direction from here that is unambiguously away from every edge of it, so
    // it is what SHORE_MARGIN leans the landing point along. If the settler is
    // somehow already off the island there is no such hex and the margin goes
    // to zero, which leaves the fan testing exactly the point it will move to —
    // still correct, just without the tie-break.
    const here = tileAt(p.x, p.z);
    let bx = 0, bz = 0;
    if (here) {
      const ix = here.x - p.x, iz = here.z - p.z;
      const il = Math.hypot(ix, iz);
      if (il > 1e-6) { bx = (ix / il) * SHORE_MARGIN; bz = (iz / il) * SHORE_MARGIN; }
    }

    // Turn, do not slow down. The step keeps its full length through the
    // rotation and the velocity is rotated with it, so a settler running along
    // the coast is running, not creeping: the old slide dropped the blocked
    // axis's speed to a quarter and the settler ground to a walk every time the
    // shore was anything other than square to the stick. The player's own words
    // for what they want here are "always run through without an issue", and a
    // settler that keeps its speed and changes its heading is the closest this
    // geometry can get to running through the corner it is standing in.
    for (let i = 0; i < SLIDE_FAN.length; i += 2) {
      const c = SLIDE_FAN[i], s = SLIDE_FAN[i + 1];
      const rx = dx * c - dz * s + bx, rz = dx * s + dz * c + bz;
      if (!tileAt(p.x + rx, p.z + rz)) continue;
      p.x += rx; p.z += rz;
      const vx = p.vx, vz = p.vz;
      p.vx = vx * c - vz * s;
      p.vz = vx * s + vz * c;
      return;
    }

    // Ninety directions and not one of them is land. Standing on the island
    // this cannot happen — the fan covers a full half turn either side, so at
    // worst the settler retraces the step that put it here — but a NaN stick, a
    // reshuffled board under a settler's feet or a teleport from the network
    // layer could all present a position that is already in the water, and the
    // one thing this file must never do is leave the settler with no way out.
    // So take the clamp's landing spot, and point the velocity at the direction
    // that move actually went (which is inland, toward a tile centre) instead of
    // leaving it aimed at the sea with a tenth of its speed the way the old
    // dead-stop branch did. Next step the settler is on land and running.
    const full = clampToIsland(nx, nz);
    const mx = full.x - p.x, mz = full.z - p.z;
    p.x = full.x; p.z = full.z;
    const m = Math.hypot(mx, mz);
    const spd = Math.hypot(p.vx, p.vz);
    if (m > 1e-7 && spd > 1e-7) { p.vx = (mx / m) * spd; p.vz = (mz / m) * spd; }
  }

  function updateIntent() {
    // --- the thing you are about to run over ----------------------------
    // Pickup is contact-based, so this is no longer a lease on a node: it is
    // purely "what is in front of me", and it stays live while running because
    // that is exactly when it is true. `nearTarget` is advisory — rules.js
    // sweeps by proximity and does not consult it.
    p.nearTarget = nearestItem(p.x, p.z, {
      maxDist: INTERACT_RADIUS,
      filter: it => canGatherTile(state, pid, it.tile)
    });

    // --- trading -------------------------------------------------------
    const dm = Math.hypot(p.x - MARKET.x, p.z - MARKET.z);
    if (dm < TRADE_RADIUS) {
      p.nearTrade = 'market';
    } else {
      /* PORT_RADIUS, not TRADE_RADIUS: a dock is a jetty you stand beside
         rather than a hex you stand on, and the prompt now reaches as far as
         the trade rule does. See PORT_RADIUS in core/constants.js. */
      const port = nearestPortFor(state, pid, p.x, p.z, PORT_RADIUS);
      p.nearTrade = port ? port.id : null;
    }
  }

  function update(dt) {
    if (!p) return;
    const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.1) : 1 / 60;

    // The board map still stops the settler dead — it is a modal over the
    // island and the stick under it belongs to the map. The end of the match
    // does not, once the review bar has handed the island back (`opts.roam`).
    const roaming = state.phase === 'over' && canRoam() === true;
    const locked = (state.phase === 'over' && !roaming)
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
    // Nothing to pick up and nowhere to trade once it is over: a roaming
    // settler that runs past the market must not raise a trade prompt on a
    // match that has already been scored.
    if (state.phase === 'over') { p.nearTarget = null; p.nearTrade = null; }
    else updateIntent();

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

  return {
    update,
    /**
     * Point at a different settler object for the same seat.
     *
     * A networked match rebuilds the settlers once the server has said what
     * colour each seat is (`recolorAvatars` in main.js), and the one thing this
     * file holds a direct reference for — the impact counter behind the camera
     * shake — would otherwise go on reading a settler that is no longer in the
     * scene, so bumping a tree would stop shaking anything. The count starts
     * again from the new object: a rebuild is not a collision.
     */
    setSettler(next) {
      if (!next || next === settler) return false;
      settler = next;
      lastImpacts = typeof next.impacts === 'number' ? next.impacts : 0;
      return true;
    }
  };
}

export default createPlayerController;
