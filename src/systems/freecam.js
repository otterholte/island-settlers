/**
 * Island Settlers — the post-match free camera driver.
 *
 *   createFreeCam(game, { root }) ->
 *     { arm(mode), disarm(), setMode(mode), armed, mode, debug, destroy() }
 *
 * `systems/camera.js` holds and clamps the free pose; this file is everything
 * that PUSHES it — pointers, wheel, keys and a small touch pad — plus the hint
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
 *   pad turn, one press      0.30 rad      0.13 rad        (17.2 -> 7.4 deg)
 *   pad tilt, one press      0.13 rad      0.055 rad       (7.4 -> 3.2 deg)
 *   zoom, one press          x1.18         x1.07
 *   wheel                    0.0016/unit   0.00060/unit, capped e^0.5 not e^1.2
 *   pinch zoom               raw ratio     ratio^0.45
 *   pinch twist              1.00x         0.45x
 *   Q / E hold               1.60 rad/s    0.65 rad/s
 *   R / F hold               0.80 rad/s    0.34 rad/s
 *   W A S D hold             see camera.js freeStep (0.65 -> 0.28 of distance)
 */

/* Radians per pixel for an orbit drag, and per press of a pad button. */
const YAW_PER_PX = 0.0026;
const PITCH_PER_PX = 0.0018;
const YAW_STEP = 0.13;
const PITCH_STEP = 0.055;
const ZOOM_STEP = 1.07;
/** Radians per second while a turn / tilt key is held. */
const KEY_YAW_RATE = 0.65;
const KEY_PITCH_RATE = 0.34;
/** Wheel: radians-free, a multiplier per notch. Gain, then the hard cap. */
const WHEEL_GAIN = 0.00060;
const WHEEL_CAP = 0.5;
/** Pinch: the raw finger ratio raised to this power, and the twist scaled. */
const PINCH_POWER = 0.45;
const PINCH_TWIST = 0.45;
/** Below this much travel a pointer is a tap, not a drag. */
const DRAG_SLOP = 3;

const IGNORE_SEL = '#ui,[data-ui],#boot,#rotate-gate';

const CSS = `
/* Bottom right: clear of the player rail above it and of the review bar, which
   is centred. The three rows are 137px tall at 42px keys, so at the 352px-tall
   end of landscape the top of the pad still lands under the rail. */
.fcam{position:absolute;right:10px;bottom:74px;
  display:flex;flex-direction:column;gap:5px;z-index:8;pointer-events:auto;
  -webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent}
.fcam.hid{display:none}
.fcam-row{display:flex;gap:5px;justify-content:center}
.fcam b.fcam-k{display:flex;align-items:center;justify-content:center;
  width:42px;height:36px;border-radius:11px;cursor:pointer;
  background:linear-gradient(180deg,rgba(22,52,88,.92),rgba(8,24,46,.92));
  border:2px solid rgba(255,201,60,.42);
  box-shadow:0 4px 12px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.18);
  transition:transform .1s ease,border-color .15s ease,background .15s ease}
.fcam b.fcam-k:active{transform:translateY(2px) scale(.96);
  border-color:rgba(255,201,60,.9);background:linear-gradient(180deg,#1d4478,#0b2748)}
.fcam b.fcam-k svg{display:block}
.fcam .fcam-tag{font:800 8px/1.1 var(--ff,system-ui);letter-spacing:.16em;
  text-transform:uppercase;color:rgba(255,231,154,.72);text-align:center;
  text-shadow:0 1px 3px rgba(0,0,0,.8)}
/* Directly over the review bar, where the eye already is — never over the
   win plate at the top of the screen, which is still fading when this lands. */
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
  .fcam{bottom:66px;gap:4px}
  .fcam b.fcam-k{width:38px;height:32px}
  .fcam b.fcam-k svg{width:18px;height:18px}
  .fcam-hint{font-size:8px;padding:4px 9px 5px;bottom:70px}
}
`;

const SV = body =>
  `<svg viewBox="0 0 24 24" width="21" height="21" aria-hidden="true" focusable="false">${body}</svg>`;
const STROKE = (d, w = 2.2) =>
  `<path d="${d}" fill="none" stroke="#ffe0a0" stroke-width="${w}" ` +
  `stroke-linecap="round" stroke-linejoin="round"/>`;

const GLYPH = {
  // a curved arrow bending anticlockwise / clockwise: "turn the island"
  turnL: SV(STROKE('M18.4 14.6A7 7 0 1 1 16.3 6.6') + STROKE('M16.6 3.2v4.2h-4.2')),
  turnR: SV(STROKE('M5.6 14.6A7 7 0 1 0 7.7 6.6') + STROKE('M7.4 3.2v4.2h4.2')),
  tiltU: SV(STROKE('M12 4.4v11') + STROKE('M7.4 9L12 4.4 16.6 9')
    + STROKE('M4.6 19.6h14.8', 2)),
  tiltD: SV(STROKE('M12 19.6v-11') + STROKE('M7.4 15L12 19.6 16.6 15')
    + STROKE('M4.6 4.4h14.8', 2)),
  zoomIn: SV(`<circle cx="10.6" cy="10.6" r="6.2" fill="none" stroke="#ffe0a0" stroke-width="2.2"/>`
    + STROKE('M15.4 15.4l4.4 4.4') + STROKE('M10.6 7.8v5.6M7.8 10.6h5.6', 2)),
  zoomOut: SV(`<circle cx="10.6" cy="10.6" r="6.2" fill="none" stroke="#ffe0a0" stroke-width="2.2"/>`
    + STROKE('M15.4 15.4l4.4 4.4') + STROKE('M7.8 10.6h5.6', 2)),
  home: SV(STROKE('M4.4 11.4L12 4.6l7.6 6.8') + STROKE('M6.8 10v9.4h10.4V10'))
};

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
  let pad = null, hint = null;
  if (doc && root && doc.createElement) {
    injectStyle(doc);

    const key = (glyph, label, fn) => {
      const b = doc.createElement('b');
      b.className = 'fcam-k';
      b.innerHTML = glyph;
      b.setAttribute('role', 'button');
      b.setAttribute('aria-label', label);
      // pointerdown, not click: on a phone a 300ms click delay on a camera
      // control feels broken, and repeat-holding wants the down edge anyway.
      b.addEventListener('pointerdown', e => {
        if (e.preventDefault) e.preventDefault();
        if (e.stopPropagation) e.stopPropagation();
        markTouched();
        fn();
      });
      return b;
    };

    const row = (...kids) => {
      const r = doc.createElement('div');
      r.className = 'fcam-row';
      for (const k of kids) r.appendChild(k);
      return r;
    };

    pad = doc.createElement('div');
    pad.className = 'fcam hid';
    pad.setAttribute('data-ui', '');
    const tag = doc.createElement('span');
    tag.className = 'fcam-tag';
    tag.textContent = 'Look';
    pad.appendChild(tag);
    pad.appendChild(row(
      key(GLYPH.turnL, 'Turn left', () => turn(-YAW_STEP, 0)),
      key(GLYPH.tiltU, 'Tilt down', () => turn(0, PITCH_STEP)),
      key(GLYPH.turnR, 'Turn right', () => turn(YAW_STEP, 0))));
    pad.appendChild(row(
      key(GLYPH.zoomOut, 'Zoom out', () => zoom(ZOOM_STEP)),
      key(GLYPH.home, 'Recentre', () => recentre()),
      key(GLYPH.zoomIn, 'Zoom in', () => zoom(1 / ZOOM_STEP))));
    pad.appendChild(row(key(GLYPH.tiltD, 'Tilt up', () => turn(0, -PITCH_STEP))));
    root.appendChild(pad);

    hint = doc.createElement('div');
    hint.className = 'fcam-hint hid';
    hint.innerHTML = '<b>Drag</b><i>to look around</i><b>WASD</b><i>to move</i>';
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
    if (pad) pad.classList.remove('hid');
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
    if (pad) pad.classList.add('hid');
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
      if (pad && pad.parentNode) pad.parentNode.removeChild(pad);
      if (hint && hint.parentNode) hint.parentNode.removeChild(hint);
    }
  };
}

export default createFreeCam;
