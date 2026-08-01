/**
 * Island Settlers — cinematic camera driver for the match flow.
 *
 *   createFlowCamera(game) ->
 *     { capture(), release(), setActive(on), snap(x,z), look(x,z,ease),
 *       arc(a0,a1,r0,r1,dur), overview(on), shake(a), celebrate(p),
 *       endCelebrate(), update(dt), isActive, pos }
 *
 * `systems/camera.js` is owned by the Character agent and is deliberately
 * narrow: it follows a ground point, eases to a whole-island framing, orbits a
 * winner and shakes. That is everything a cinematic needs — the only problem is
 * that `playerController.js` calls `follow(player.x, player.z)` every fixed
 * step, *after* the flow updates, so the flow can never win an argument about
 * where the camera looks.
 *
 * Rather than fork the camera or race it, we borrow its `follow` entry point
 * for the duration of a cinematic: while `active`, every caller's follow target
 * is redirected to the flow's own point, and the real function is handed back
 * untouched on `release()`. No camera state is written directly, so the spring,
 * the overview blend and the celebration orbit all keep working exactly as the
 * Character agent tuned them.
 *
 * Owner: Flow agent.
 */

import { BOUNDS } from '../board/layout.js';

const easeIO = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const num = (v, d) => (Number.isFinite(v) ? v : d);

export function createFlowCamera(game) {
  const cam = game && game.camera ? game.camera : null;

  const cur = { x: BOUNDS.cx, z: BOUNDS.cz };
  const tgt = { x: BOUNDS.cx, z: BOUNDS.cz };

  let realFollow = null;
  let patched = false;
  let active = false;
  let ease = 2.4;

  // Parametric arc over the island — the establishing sweep.
  let arcT = 0, arcDur = 0;
  let a0 = 0, a1 = 0, r0 = 0, r1 = 0;

  /* ---------------------------------------------------------- borrow/return */

  function capture() {
    if (patched || !cam || typeof cam.follow !== 'function') return false;
    const original = cam.follow;
    realFollow = original;
    cam.follow = function flowFollow(x, z, dt) {
      if (active) return original.call(cam, cur.x, cur.z, dt);
      return original.call(cam, x, z, dt);
    };
    patched = true;
    return true;
  }

  function release() {
    active = false;
    arcDur = 0;
    if (!patched) return;
    cam.follow = realFollow;
    realFollow = null;
    patched = false;
  }

  function setActive(on) {
    active = !!on;
    if (active) capture();
    if (!active) arcDur = 0;
  }

  /* ----------------------------------------------------------------- aiming */

  function snap(x, z) {
    tgt.x = num(x, BOUNDS.cx); tgt.z = num(z, BOUNDS.cz);
    cur.x = tgt.x; cur.z = tgt.z;
    arcDur = 0;
  }

  /** Ease the cinematic focus toward a world point. Higher `k` = snappier. */
  function look(x, z, k) {
    tgt.x = num(x, tgt.x); tgt.z = num(z, tgt.z);
    if (Number.isFinite(k)) ease = k;
    arcDur = 0;
  }

  /**
   * Sweep the focus along an arc centred on the island.
   * Angles in radians, 0 = +x, measured toward +z.
   */
  function arc(fromA, toA, fromR, toR, dur) {
    a0 = num(fromA, 0); a1 = num(toA, 0);
    r0 = num(fromR, BOUNDS.radius * 0.5); r1 = num(toR, r0);
    arcDur = Math.max(0.001, num(dur, 4));
    arcT = 0;
    tgt.x = BOUNDS.cx + Math.cos(a0) * r0;
    tgt.z = BOUNDS.cz + Math.sin(a0) * r0;
    cur.x = tgt.x; cur.z = tgt.z;
  }

  /* ------------------------------------------------------- camera passthru */

  function overview(on) {
    if (cam && typeof cam.setOverview === 'function') {
      try { cam.setOverview(!!on); } catch (e) { /* optional */ }
    }
  }

  function shake(amount) {
    if (cam && typeof cam.shake === 'function') {
      try { cam.shake(amount); } catch (e) { /* optional */ }
    }
  }

  function celebrate(player) {
    if (cam && typeof cam.celebrate === 'function') {
      try { cam.celebrate(player); } catch (e) { /* optional */ }
    }
  }

  /**
   * Stop the victory orbit.
   *
   * The orbit blends to full over 1.4s and then owns the camera outright — it
   * is applied after the overview blend, so it wins. The end-of-match sequence
   * therefore has to be able to hand the camera back before it pulls out to the
   * whole-board framing, or the player never sees the finished island.
   */
  function endCelebrate() {
    if (cam && typeof cam.endCelebrate === 'function') {
      try { cam.endCelebrate(); } catch (e) { /* optional */ }
    }
  }

  /* ----------------------------------------------------------------- update */

  function update(dt) {
    const d = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.1) : 1 / 60;
    if (!active) return;

    if (arcDur > 0) {
      arcT = Math.min(arcDur, arcT + d);
      const k = easeIO(arcT / arcDur);
      const a = a0 + (a1 - a0) * k;
      const r = r0 + (r1 - r0) * k;
      tgt.x = BOUNDS.cx + Math.cos(a) * r;
      tgt.z = BOUNDS.cz + Math.sin(a) * r;
      if (arcT >= arcDur) arcDur = 0;
    }

    const k = 1 - Math.exp(-ease * d);
    cur.x += (tgt.x - cur.x) * k;
    cur.z += (tgt.z - cur.z) * k;
    if (!Number.isFinite(cur.x)) cur.x = BOUNDS.cx;
    if (!Number.isFinite(cur.z)) cur.z = BOUNDS.cz;
  }

  return {
    capture, release, setActive, snap, look, arc,
    overview, shake, celebrate, endCelebrate, update,
    get isActive() { return active; },
    get isPatched() { return patched; },
    get pos() { return cur; }
  };
}

export default createFlowCamera;
