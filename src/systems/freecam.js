/**
 * Island Settlers — the post-match free camera driver.
 *
 *   createFreeCam(game, { root }) ->
 *     { arm(mode), disarm(), setMode(mode), armed, mode, debug, destroy() }
 *
 * `systems/camera.js` holds and clamps the free pose; this file is everything
 * that PUSHES it — pointers, wheel and keys — plus the hint
 * that tells the player the view is theirs now.
 *
 * It exists at all because the end of a match leaves the player with an island
 * they have just won and no way to look at it:
 *
 *   "Let me navigate around the close view after the game has ended."
 *
 * Bindings
 * --------
 *   one finger / left drag   pan — the ground follows the finger
 *   two fingers              pinch to zoom, twist to turn
 *   right drag / shift drag  orbit (yaw and pitch)
 *   wheel                    zoom about the cursor
 *   W A S D / arrows         pan
 *   Q E                      turn        R F   tilt
 *   + - (and = _)            zoom        0     back to the preset framing
 *
 * WHAT IT MUST NEVER DO
 * ---------------------
 * Arrow keys and WASD drive the settler during play. Nothing here listens until
 * `arm()` is called, which only happens once the match is over and the results
 * panel has been dismissed (hud-end.js drives it off the review bar). Even then
 * the keyboard is dropped the moment `input.keyboardCaptured` goes true, so the
 * trade sheet's own arrow-key staging is never fought over. Pointer input is
 * ignored over anything inside `#ui` / `[data-ui]`, so every button on the
 * review bar still works.
 *
 * Owner: Character agent.
 */

const STYLE_ID = 'freecam-style';

/* ---------------------------------------------------------------- the rates
 *
 *   "When I'm reviewing the board game after it ends, make the camera movement
 *    go slower."
 *
 * Everything below used to be tuned for a fast look-around and it flew. A
 * review camera is not a flight camera: the player is reading a finished board,
 * so every axis is now roughly HALF the rate it was, on pointer and on keyboard
 * alike. The clamps in camera.js are untouched — the same range is reachable,
 * it simply takes a gesture and a half to cross it instead of a flick.
 *
 *   axis                     before        after
 *   orbit drag, yaw          0.0060 rad/px 0.0026 rad/px   (0.34 -> 0.15 deg/px)
 *   orbit drag, pitch        0.0042 rad/px 0.0018 rad/px   (0.24 -> 0.10 deg/px)
 *   pan drag                 1.00x ground  0.45x ground    (see camera.js)
 *   zoom, one press          x1.18         x1.07
 *   wheel                    0.0016/unit   0.00060/unit, capped e^0.5 not e^1.2
 *   pinch zoom               raw ratio     ratio^0.45
 *   pinch twist              1.00x         0.45x
 *   Q / E hold               1.60 rad/s    0.65 rad/s
 *   R / F hold               0.80 rad/s    0.34 rad/s
 *   W A S D hold             see camera.js freeStep (0.65 -> 0.28 of distance)
 */

/* Radians per pixel for an orbit drag, and per press of a turn / tilt key. */
const YAW_PER_PX = 0.0026;
const PITCH_PER_PX = 0.0018;
const YAW_STEP = 0.13;
const PITCH_STEP = 0.055;
const ZOOM_STEP = 1.07;
/** Radians per second while a turn / tilt key is held. */
const KEY_YAW_RATE = 0.65;
const KEY_PITCH_RATE = 0.34;
/*
 * Wheel: a multiplier per notch — gain, then a hard cap. Pinch: the raw finger
 * ratio raised to a power, and the twist scaled.
 *
 *   "Can you make the finger zooms zoom in and out a bit quicker though."
 *
 * All of these were cut hard at once, back when the free camera was shooting
 * off the moment it was touched. But the thing that ran away was the TURN,
 * which is driven by pixels of drag; the zoom was damped in the same pass for
 * company and never needed it. At 0.00060 a unit a two-finger scroll took a
 * long deliberate sweep to cross the useful range, and `ratio^0.45` meant
 * closing the fingers halfway barely moved the camera at all.
 *
 * Roughly doubled: wheel gain 0.00060 -> 0.00135 with the cap opened from
 * e^0.5 to e^0.85, and the pinch exponent 0.45 -> 0.78, which is most of the
 * way back to the raw finger ratio while keeping enough easing that a pinch
 * still reads as accelerating rather than snapping. The TWIST stays at 0.45x:
 * accidental rotation while pinching is what that damping was really for.
 */
const WHEEL_GAIN = 0.00135;
const WHEEL_CAP = 0.85;
const PINCH_POWER = 0.78;
const PINCH_TWIST = 0.45;
/** Below this much travel a pointer is a tap, not a drag. */
const DRAG_SLOP = 3;

const IGNORE_SEL = '#ui,[data-ui],#boot,#rotate-gate';

const CSS = `
/* Directly over the review bar, where the eye already is — never over the
   win plate at the top of the screen, which is still fading when this lands.

   THE LOOK PAD IS GONE.

     "Remove these buttons, I don't need them. I can just click and drag around,
      or do a two finger scroll up and down for the zoom."

   Seven 42px keys — turn, tilt, zoom, recentre — parked in the bottom-right
   corner of the one screen in the game whose entire purpose is looking at the
   island. Every one of them duplicated a gesture the player already had and
   preferred, and together they covered the corner of the board they were there
   to help inspect. Drag, wheel / two-finger scroll, pinch, twist and the whole
   keyboard set all still do exactly what they did; this only takes away the
   buttons. The hint below is what is left, and it names the gestures. */
.fcam-hint{position:absolute;left:50%;bottom:80px;transform:translateX(-50%);
  display:flex;align-items:center;gap:7px;z-index:8;pointer-events:none;
  padding:5px 11px 6px;border-radius:13px;
  background:linear-gradient(180deg,rgba(12,32,58,.86),rgba(6,20,40,.86));
  border:1.5px solid rgba(255,201,60,.36);
  box-shadow:0 5px 16px rgba(0,0,0,.5);
  font:700 9px/1.2 var(--ff,system-ui);letter-spacing:.12em;text-transform:uppercase;
  color:rgba(206,226,246,.9);opacity:0;transition:opacity .3s ease}
.fcam-hint.on{opacity:1}
.fcam-hint.hid{display:none}
.fcam-hint b{font:800 9px/1.2 var(--ff,system-ui);color:#0b1d33;
  background:linear-gradient(180deg,#ffe79a,#ffc93c);
  padding:3px 6px 4px;border-radius:6px;letter-spacing:.1em}
.fcam-hint i{font-style:normal}
@media (max-height:400px){
  .fcam-hint{font-size:8px;padding:4px 9px 5px;bottom:70px}
}
`;

function injectStyle(doc) {
  if (!doc || !doc.head || !doc.createElement) return;
  if (doc.getElementById && doc.getElementById(STYLE_ID)) return;
  const s = doc.createElement('style');
  s.id = STYLE_ID;
  s.textContent = CSS;
  doc.head.appendChild(s);
}

function overUI(el) {
  for (let n = el; n && n.nodeType === 1; n = n.parentNode) {
    if (typeof n.matches === 'function' && n.matches(IGNORE_SEL)) return true;
  }
  return false;
}

export function createFreeCam(game, opts = {}) {
  const doc = opts.doc
    || (opts.root && opts.root.ownerDocument)
    || (typeof document !== 'undefined' ? document : null);
  const win = (doc && doc.defaultView) || (typeof window !== 'undefined' ? window : null);
  const root = opts.root || (doc ? doc.getElementById('ui') : null) || (doc ? doc.body : null);
  const cam = () => (game && game.camera) || null;

  let armed = false;
  let mode = 'board';
  let raf = 0;
  let lastT = 0;
  let touched = false;              // the hint retires once they have used it

  const stats = { drags: 0, keys: 0, zooms: 0, turns: 0 };

  /* ------------------------------------------------------------------ DOM */
  /* One hint, and nothing else. The pad that used to live here is described in
     the CSS block above; every gesture it duplicated is still wired up below. */
  let hint = null;
  if (doc && root && doc.createElement) {
    injectStyle(doc);
    hint = doc.createElement('div');
    hint.className = 'fcam-hint hid';
    hint.innerHTML = '<b>Drag</b><i>to look around</i>'
      + '<b>Scroll</b><i>to zoom</i><b>WASD</b><i>to move</i>';
    root.appendChild(hint);
  }

  function markTouched() {
    if (touched) return;
    touched = true;
    if (hint) hint.classList.remove('on');
  }

  /* -------------------------------------------------------------- actions */
  function turn(dy, dp) {
    const c = cam();
    if (!armed || !c || !c.freeTurn) return;
    stats.turns++;
    c.freeTurn(dy, dp);
  }

  function zoom(k) {
    const c = cam();
    if (!armed || !c || !c.freeZoom) return;
    stats.zooms++;
    c.freeZoom(k);
  }

  function recentre() {
    const c = cam();
    if (!armed || !c || !c.freeRecentre) return;
    c.freeRecentre();
  }

  /* ------------------------------------------------------------- pointers */
  const live = new Map();           // pointerId -> { x, y }
  let orbiting = false;
  let pinchDist = 0, pinchAng = 0;
  let moved = 0;

  const viewH = () => (win && win.innerHeight) || 720;

  function onDown(ev) {
    if (!armed) return;
    if (overUI(ev.target)) return;
    live.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    moved = 0;
    if (live.size === 1) {
      orbiting = ev.pointerType === 'mouse' && (ev.button === 2 || ev.shiftKey);
    } else if (live.size === 2) {
      const [a, b] = [...live.values()];
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      pinchAng = Math.atan2(b.y - a.y, b.x - a.x);
    }
    if (ev.cancelable) ev.preventDefault();
  }

  function onMove(ev) {
    if (!armed || !live.has(ev.pointerId)) return;
    const c = cam();
    const prev = live.get(ev.pointerId);
    const dx = ev.clientX - prev.x;
    const dy = ev.clientY - prev.y;
    prev.x = ev.clientX; prev.y = ev.clientY;
    moved += Math.abs(dx) + Math.abs(dy);
    if (!c) return;

    if (live.size >= 2) {
      const [a, b] = [...live.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      if (pinchDist > 8 && d > 8) {
        // Fingers apart -> pull the camera in. The raw ratio is flattened
        // toward 1 so a pinch reads as easing in rather than as a jump cut.
        if (c.freeZoom) c.freeZoom(Math.pow(pinchDist / d, PINCH_POWER));
        stats.zooms++;
      }
      let dAng = ang - pinchAng;
      while (dAng > Math.PI) dAng -= Math.PI * 2;
      while (dAng < -Math.PI) dAng += Math.PI * 2;
      if (Math.abs(dAng) > 0.008 && c.freeTurn) {
        c.freeTurn(-dAng * PINCH_TWIST, 0); stats.turns++;
      }
      pinchDist = d; pinchAng = ang;
      markTouched();
      if (ev.cancelable) ev.preventDefault();
      return;
    }

    if (moved < DRAG_SLOP) return;
    markTouched();
    if (orbiting) {
      if (c.freeTurn) c.freeTurn(-dx * YAW_PER_PX, -dy * PITCH_PER_PX);
      stats.turns++;
    } else {
      if (c.freeDrag) c.freeDrag(dx, dy, viewH());
      stats.drags++;
    }
    if (ev.cancelable) ev.preventDefault();
  }

  function onUp(ev) {
    live.delete(ev.pointerId);
    if (live.size < 2) { pinchDist = 0; pinchAng = 0; }
    if (!live.size) orbiting = false;
  }

  function onWheel(ev) {
    if (!armed) return;
    if (overUI(ev.target)) return;
    const c = cam();
    if (!c || !c.freeZoom) return;
    const d = Number.isFinite(ev.deltaY) ? ev.deltaY : 0;
    if (!d) return;
    markTouched();
    c.freeZoom(Math.exp(Math.max(-WHEEL_CAP, Math.min(WHEEL_CAP, d * WHEEL_GAIN))));
    stats.zooms++;
    if (ev.cancelable) ev.preventDefault();
  }

  /* ------------------------------------------------------------- keyboard */
  const keys = new Set();
  const PAN_KEYS = new Set([
    'KeyW', 'KeyA', 'KeyS', 'KeyD',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'
  ]);
  const OWN_KEYS = new Set([
    'KeyQ', 'KeyE', 'KeyR', 'KeyF', 'Digit0', 'Numpad0',
    'Equal', 'Minus', 'NumpadAdd', 'NumpadSubtract', 'BracketLeft', 'BracketRight'
  ]);

  /** A modal panel owns the keyboard (the trade sheet stages with arrows). */
  const boardBusy = () => !!(game && game.input && game.input.keyboardCaptured);

  function onKeyDown(ev) {
    if (!armed || boardBusy()) return;
    const code = ev.code || ev.key;
    if (!code) return;
    if (!PAN_KEYS.has(code) && !OWN_KEYS.has(code)) return;
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (keys.has(code)) return;
    keys.add(code);
    markTouched();
    stats.keys++;
    if (code === 'Digit0' || code === 'Numpad0') recentre();
    if (code === 'Equal' || code === 'NumpadAdd') zoom(1 / ZOOM_STEP);
    if (code === 'Minus' || code === 'NumpadSubtract') zoom(ZOOM_STEP);
    if (ev.preventDefault) ev.preventDefault();
  }

  function onKeyUp(ev) {
    const code = ev.code || ev.key;
    if (code) keys.delete(code);
  }

  function onBlur() { keys.clear(); live.clear(); orbiting = false; }

  /* --------------------------------------------------------------- frame */
  function tick(now) {
    if (!armed) { raf = 0; return; }
    raf = win.requestAnimationFrame(tick);
    const dt = lastT ? Math.min(0.1, (now - lastT) / 1000) : 1 / 60;
    lastT = now;
    const c = cam();
    if (!c) return;
    if (boardBusy()) { keys.clear(); return; }

    let fwd = 0, right = 0;
    if (keys.has('KeyW') || keys.has('ArrowUp')) fwd += 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) fwd -= 1;
    if (keys.has('KeyD') || keys.has('ArrowRight')) right += 1;
    if (keys.has('KeyA') || keys.has('ArrowLeft')) right -= 1;
    if ((fwd || right) && c.freeStep) {
      const m = Math.hypot(fwd, right) || 1;
      c.freeStep(fwd / m, right / m, dt);
    }
    if (keys.has('KeyQ')) turn(-KEY_YAW_RATE * dt, 0);
    if (keys.has('KeyE')) turn(KEY_YAW_RATE * dt, 0);
    if (keys.has('KeyR')) turn(0, -KEY_PITCH_RATE * dt);
    if (keys.has('KeyF')) turn(0, KEY_PITCH_RATE * dt);
  }

  /* --------------------------------------------------------------- wiring */
  const bound = [];
  function on(target, type, fn, o) {
    if (!target || !target.addEventListener) return;
    target.addEventListener(type, fn, o);
    bound.push([target, type, fn, o]);
  }
  if (win) {
    on(win, 'pointerdown', onDown, { passive: false, capture: true });
    on(win, 'pointermove', onMove, { passive: false, capture: true });
    on(win, 'pointerup', onUp, { capture: true });
    on(win, 'pointercancel', onUp, { capture: true });
    on(win, 'wheel', onWheel, { passive: false, capture: true });
    on(win, 'keydown', onKeyDown);
    on(win, 'keyup', onKeyUp);
    on(win, 'blur', onBlur);
  }

  /* ------------------------------------------------------------------ api */
  function setMode(next) {
    mode = next === 'close' ? 'close' : 'board';
    const c = cam();
    if (armed && c && c.freeMode) c.freeMode(mode, false);
    return mode;
  }

  /** Hand the view to the player. Only ever called after the match is over. */
  function arm(next) {
    mode = next === 'close' ? 'close' : 'board';
    const c = cam();
    if (!c || !c.setFreeLook) return false;
    c.setFreeLook(true, mode);
    armed = true;
    keys.clear(); live.clear();
    if (hint) {
      hint.classList.remove('hid');
      if (!touched) {
        // Next frame, so the fade actually runs.
        if (win) win.setTimeout(() => { if (armed && !touched) hint.classList.add('on'); }, 32);
      }
    }
    if (win && !raf) { lastT = 0; raf = win.requestAnimationFrame(tick); }
    return true;
  }

  function disarm() {
    armed = false;
    keys.clear(); live.clear();
    const c = cam();
    if (c && c.setFreeLook) c.setFreeLook(false);
    if (hint) { hint.classList.remove('on'); hint.classList.add('hid'); }
    if (raf && win) { win.cancelAnimationFrame(raf); raf = 0; }
  }

  return {
    arm, disarm, setMode,
    get armed() { return armed; },
    get mode() { return mode; },
    /** Capture-rig hook: proves which route actually moved the camera. */
    get debug() {
      const c = cam();
      return { armed, mode, ...stats, cam: c && c.freeInfo ? c.freeInfo : null };
    },
    /** The tuned rates, so a trace can report them rather than re-derive them. */
    get rates() {
      return {
        yawPerPx: YAW_PER_PX, pitchPerPx: PITCH_PER_PX,
        yawStep: YAW_STEP, pitchStep: PITCH_STEP, zoomStep: ZOOM_STEP,
        keyYaw: KEY_YAW_RATE, keyPitch: KEY_PITCH_RATE,
        wheelGain: WHEEL_GAIN, wheelCap: WHEEL_CAP,
        pinchPower: PINCH_POWER, pinchTwist: PINCH_TWIST
      };
    },
    destroy() {
      disarm();
      for (const [t, type, fn, o] of bound) t.removeEventListener(type, fn, o);
      bound.length = 0;
      if (hint && hint.parentNode) hint.parentNode.removeChild(hint);
    }
  };
}

export default createFreeCam;
