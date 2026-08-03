/**
 * Island Settlers — input.
 *
 *   createInput(domRoot) ->
 *     { stick:{x,y}, tapped, actionPressed, mapPressed, update() }
 *
 * Mobile-first: a virtual joystick parked in a fixed corner — the one
 * `core/options.js` names — which the thumb grabs from anywhere within reach
 * of it and which springs back to centre on release. The joystick lives in the
 * DOM (cheap, crisp, no draw calls) and is inserted BEFORE #ui at a lower
 * z-index so HUD panels always paint over it. Everything is
 * pointer-events:none except the knob itself.
 *
 * Keyboard fallback for desktop / headless testing:
 *   WASD + arrows -> stick, Space -> actionPressed, Tab -> mapPressed.
 *
 * While a modal panel owns the keyboard (the trade sheet drives its selection
 * with the arrow keys) the UI calls `setKeyboardCapture(true)`. Movement keys
 * are then swallowed here — preventDefault'd, but never recorded — so the
 * settler cannot run off while the player is picking a resource, and Tab cannot
 * throw the board map up behind an open sheet. Releasing capture clears the
 * held-key set, so a key pressed before the panel opened can never stay stuck.
 *
 * `stick` is normalised with magnitude clamped to 1; +y is "up the screen"
 * (away from the camera). Edge flags are true for exactly one update().
 *
 * AFTER THE MATCH the same keys drive the free camera instead (see
 * `systems/freecam.js`). Nothing changes here: freecam only ever listens once
 * the end-of-match bar has armed it, matchflow.js has already zeroed `stick`
 * every step by then, and freecam stands down the instant `keyboardCaptured`
 * goes true — so the trade sheet keeps its arrows and the settler never moves
 * on a key meant for the camera.
 *
 * Owner: Character agent.
 */

import { stickSide, onOptionsChange } from '../core/options.js';

/**
 * THE PAD IS A PLACE, NOT A GESTURE.
 *
 *   "Have there be an actual joystick on the right side of the screen in the
 *    bottom right corner, maybe actually right above the map, cards, build
 *    buttons. I have some players who only have a right hand."
 *
 * It used to be invisible: press anywhere in the left 45% of the screen and a
 * ring appeared under your thumb. That is elegant on a two-handed grip and
 * useless to somebody playing with one hand, because the hand holding the
 * phone is the hand that has to reach everything — so the controls have to be
 * in one corner, and you have to be able to find them without looking.
 *
 * So the ring is always drawn, parked above the action buttons on whichever
 * side `core/options.js` says, and the touch zone is a generous circle around
 * it rather than half the screen. Sitting on a fixed pad also means the game
 * can put the buttons on the OTHER side for anyone who wants the old
 * two-handed split — see `buttonsSide`.
 */
const RING_R = 66;          // css px — ring radius
/** How far from the pad's centre a touch still grabs the stick. */
const PAD_REACH = RING_R + 74;
/** Where the pad's centre sits, from its own corner, in css px. */
const PAD_INSET_X = 92;
const PAD_INSET_Y = 118;
const MAX_R = 52;           // knob travel
const DEAD = 0.16;          // fraction of MAX_R ignored
const TAP_MOVE = 14;
const TAP_MS = 320;

const IGNORE_SEL = '#ui,[data-ui],#boot,#rotate-gate';

const CSS = `
/* z-index:0 (not a positive value) so the layer paints in DOM order against
   #ui: inserted before it, it always sits under the HUD whatever ui.css does. */
#js-layer{position:absolute;inset:0;pointer-events:none;z-index:0;overflow:hidden;
  -webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent}
#gl{touch-action:none}
#js-ring{position:absolute;left:0;top:0;width:${RING_R * 2}px;height:${RING_R * 2}px;
  margin:${-RING_R}px 0 0 ${-RING_R}px;border-radius:50%;pointer-events:none;
  background:radial-gradient(circle at 50% 40%,rgba(255,255,255,.17),rgba(9,30,56,.34) 58%,rgba(9,30,56,.06) 74%);
  border:2px solid rgba(255,255,255,.40);
  box-shadow:0 0 26px rgba(70,180,255,.34),inset 0 0 22px rgba(130,205,255,.22),0 8px 20px rgba(0,0,0,.30);
  opacity:0;transform:scale(.68);
  transition:opacity .17s ease,transform .2s cubic-bezier(.2,1.5,.4,1);will-change:transform,opacity}
#js-ring::after{content:'';position:absolute;inset:15px;border-radius:50%;
  border:1.5px dashed rgba(255,255,255,.20)}
#js-ring::before{content:'';position:absolute;inset:-7px;border-radius:50%;
  background:conic-gradient(from -90deg,rgba(120,205,255,.0),rgba(120,205,255,.30),rgba(120,205,255,.0));
  filter:blur(6px);opacity:.85}
#js-ring.on{opacity:1;transform:scale(1)}
/* Resting. Still there, still findable without looking, but not competing with
   the board for attention — the whole point of a fixed pad is that you do not
   have to see it to use it. */
#js-ring.idle{opacity:.42}
#js-knob.idle{opacity:.62;transform:scale(.88)}
#js-knob{position:absolute;left:0;top:0;width:60px;height:60px;margin:-30px 0 0 -30px;
  border-radius:50%;pointer-events:auto;
  background:radial-gradient(circle at 36% 28%,#ffffff,#dbecff 34%,#7db2ea 72%,#2f6bb0 100%);
  border:2px solid rgba(255,255,255,.88);
  box-shadow:0 5px 15px rgba(0,0,0,.36),0 0 20px rgba(130,205,255,.55),
             inset 0 -5px 9px rgba(18,58,110,.36),inset 0 3px 6px rgba(255,255,255,.7);
  opacity:0;transform:scale(.6);
  transition:opacity .15s ease,transform .18s cubic-bezier(.2,1.5,.4,1);will-change:transform,opacity}
#js-knob.on{opacity:1;transform:scale(1)}
#js-knob i{position:absolute;inset:16px;border-radius:50%;
  border:2px solid rgba(255,255,255,.55);border-bottom-color:rgba(47,107,176,.5)}
`;

function injectStyle(doc) {
  if (!doc || !doc.head || doc.getElementById('js-style')) return;
  const el = doc.createElement('style');
  el.id = 'js-style';
  el.textContent = CSS;
  doc.head.appendChild(el);
}

function matchesIgnored(el) {
  for (let n = el; n && n.nodeType === 1; n = n.parentNode) {
    if (typeof n.matches === 'function' && n.matches(IGNORE_SEL)) return true;
  }
  return false;
}

export function createInput(domRoot) {
  const doc = (domRoot && domRoot.ownerDocument)
    || (typeof document !== 'undefined' ? document : null);
  const win = (doc && doc.defaultView) || (typeof window !== 'undefined' ? window : null);
  const root = domRoot || (doc ? doc.body : null);

  const stick = { x: 0, y: 0 };
  const api = {
    stick,
    tapped: false,
    actionPressed: false,
    mapPressed: false,
    frame: 0,
    active: false,
    update, dispose, setEnabled, setKeyboardCapture,
    get keyboardCaptured() { return keyCapture; }
  };

  /* ------------------------------------------------------------------ DOM */
  let layer = null, ring = null, knob = null;
  if (doc && root && doc.createElement) {
    injectStyle(doc);
    layer = doc.createElement('div');
    layer.id = 'js-layer';
    ring = doc.createElement('div');
    ring.id = 'js-ring';
    knob = doc.createElement('div');
    knob.id = 'js-knob';
    const inner = doc.createElement('i');
    knob.appendChild(inner);
    layer.appendChild(ring);
    layer.appendChild(knob);
    const ui = root.querySelector ? root.querySelector('#ui') : null;
    if (ui && ui.parentNode === root) root.insertBefore(layer, ui);
    else root.appendChild(layer);
  }

  /* ---------------------------------------------------------------- state */
  let enabled = true;
  let keyCapture = false;
  let stickId = null;
  let originX = 0, originY = 0;
  let curX = 0, curY = 0;
  let touchStick = false;

  /* Where the pad lives this frame. Recomputed on resize and whenever the
     side changes, so nothing here caches a stale corner. */
  let padX = 0, padY = 0;
  let side = 'right';

  let tapId = null, tapX = 0, tapY = 0, tapT = 0;
  let tapPending = false;
  let actionPending = false;
  let mapPending = false;

  const keys = new Set();

  const rect = () => {
    if (root && root.getBoundingClientRect) {
      const r = root.getBoundingClientRect();
      if (r && r.width) return r;
    }
    const w = (win && win.innerWidth) || 1280;
    const h = (win && win.innerHeight) || 720;
    return { left: 0, top: 0, width: w, height: h };
  };

  /** Park the pad in its corner and draw it resting. */
  function layoutPad() {
    const r = rect();
    side = stickSide();
    padX = side === 'left' ? PAD_INSET_X : r.width - PAD_INSET_X;
    padY = r.height - PAD_INSET_Y;
    if (!stickId) restPad();
  }

  /** The idle state: ring in its corner, knob centred in it. */
  function restPad() {
    if (!ring || !knob) return;
    ring.style.left = padX + 'px';
    ring.style.top = padY + 'px';
    knob.style.left = padX + 'px';
    knob.style.top = padY + 'px';
    ring.classList.add('on', 'idle');
    knob.classList.add('on', 'idle');
  }

  function placeRing(x, y) {
    if (!ring) return;
    ring.style.transform = 'scale(1)';
    ring.style.left = x + 'px';
    ring.style.top = y + 'px';
    ring.classList.add('on');
  }
  function placeKnob(x, y) {
    if (!knob) return;
    knob.style.left = x + 'px';
    knob.style.top = y + 'px';
    knob.classList.add('on');
  }
  /** Let go: the knob springs back to the middle of the pad, which stays. */
  function hideStick() {
    restPad();
  }

  /**
   * Grab the stick. The origin is the PAD, not the finger — that is what makes
   * it a fixed control: the same thumb position always means the same
   * direction, whatever part of the pad you happened to land on.
   */
  function beginStick(id, lx, ly) {
    stickId = id;
    touchStick = true;
    originX = padX; originY = padY;
    curX = padX; curY = padY;
    if (ring) ring.classList.remove('idle');
    if (knob) knob.classList.remove('idle');
    placeRing(padX, padY);
    placeKnob(padX, padY);
    moveStick(lx, ly);
    api.active = true;
  }

  function moveStick(lx, ly) {
    let dx = lx - originX;
    let dy = ly - originY;
    const m = Math.hypot(dx, dy);
    if (m > MAX_R) {
      // The ORIGIN NO LONGER MOVES. It used to slide after the finger so the
      // stick never felt pinned, which is right for a ring that materialised
      // under your thumb and wrong for one drawn in a fixed place: the pad
      // would walk out of its corner and never come back.
      dx = (dx / m) * MAX_R;
      dy = (dy / m) * MAX_R;
    }
    curX = originX + dx;
    curY = originY + dy;
    placeKnob(curX, curY);

    const mag = Math.hypot(dx, dy) / MAX_R;
    if (mag <= DEAD) { stick.x = 0; stick.y = 0; return; }
    const scaled = Math.min(1, (mag - DEAD) / (1 - DEAD));
    const inv = 1 / (Math.hypot(dx, dy) || 1);
    stick.x = dx * inv * scaled;
    stick.y = -dy * inv * scaled;      // screen y is down; stick y is up
  }

  function endStick() {
    stickId = null;
    touchStick = false;
    api.active = false;
    stick.x = 0; stick.y = 0;
    hideStick();
  }

  /* ------------------------------------------------------------- pointers */
  function onDown(ev) {
    if (!enabled) return;
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    const tgt = ev.target;
    if (tgt && tgt !== knob && matchesIgnored(tgt)) return;

    const r = rect();
    const lx = ev.clientX - r.left;
    const ly = ev.clientY - r.top;

    // Inside the pad's reach, this is the stick. Everywhere else it is a tap,
    // which is how the camera and the world still get their gestures.
    if (Math.hypot(lx - padX, ly - padY) <= PAD_REACH) {
      if (stickId !== null) return;             // multi-touch safe
      beginStick(ev.pointerId, lx, ly);
      if (ev.cancelable) ev.preventDefault();
    } else if (tapId === null) {
      tapId = ev.pointerId;
      tapX = ev.clientX; tapY = ev.clientY;
      tapT = (win && win.performance ? win.performance.now() : Date.now());
    }
  }

  function onMove(ev) {
    if (ev.pointerId === stickId) {
      const r = rect();
      moveStick(ev.clientX - r.left, ev.clientY - r.top);
      if (ev.cancelable) ev.preventDefault();
    } else if (ev.pointerId === tapId) {
      if (Math.hypot(ev.clientX - tapX, ev.clientY - tapY) > TAP_MOVE) tapId = null;
    }
  }

  function onUp(ev) {
    if (ev.pointerId === stickId) { endStick(); return; }
    if (ev.pointerId === tapId) {
      const now = (win && win.performance ? win.performance.now() : Date.now());
      const moved = Math.hypot(ev.clientX - tapX, ev.clientY - tapY);
      if (moved <= TAP_MOVE && now - tapT <= TAP_MS) tapPending = true;
      tapId = null;
    }
  }

  function onCancel(ev) {
    if (ev.pointerId === stickId) endStick();
    if (ev.pointerId === tapId) tapId = null;
  }

  function onBlur() { endStick(); keys.clear(); }

  /* ------------------------------------------------------------- keyboard */
  const MOVE_KEYS = new Set([
    'KeyW', 'KeyA', 'KeyS', 'KeyD',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'
  ]);

  /**
   * Is somebody typing into a field right now?
   *
   * If they are, every key is theirs and none of them are movement. This has
   * to be checked BEFORE the preventDefault calls below, not after: those run
   * unconditionally, so W, A, S, D, the arrows, Space and Tab were being eaten
   * out of every text input on the page. A name box that silently refuses four
   * of the commonest letters in English, the space bar, and the key you use to
   * reach the next field is not a name box.
   *
   * There was nothing to type into when this file was written. There is now —
   * the sign-in form on the friends screen.
   */
  function isTyping(ev) {
    const t = ev.target;
    if (!t || t.nodeType !== 1) return false;
    if (t.isContentEditable) return true;
    const tag = (t.tagName || '').toUpperCase();
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag !== 'INPUT') return false;
    // Checkboxes and buttons are controls, not text — Space belongs to them
    // as a press, and the game may still want the rest.
    const type = (t.getAttribute('type') || 'text').toLowerCase();
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range'].includes(type);
  }

  function onKeyDown(ev) {
    const code = ev.code || ev.key;
    if (!code) return;
    if (isTyping(ev)) return;
    if (code === 'Space' || code === 'Tab') { if (ev.preventDefault) ev.preventDefault(); }
    if (MOVE_KEYS.has(code) && ev.preventDefault) ev.preventDefault();
    // A panel owns the keyboard: the key is eaten here (so the browser does
    // nothing with it either) and never reaches the movement state.
    if (keyCapture) return;
    if (keys.has(code)) return;                  // ignore auto-repeat
    keys.add(code);
    if (code === 'Space') actionPending = true;
    if (code === 'Tab') mapPending = true;
  }

  function onKeyUp(ev) {
    const code = ev.code || ev.key;
    // Released keys are cleared even while typing. A key that went down before
    // the field was focused must still be able to come back up, or the settler
    // walks into the sea for as long as the form is open.
    if (code) keys.delete(code);
  }

  /* ------------------------------------------------------------- wire up */
  const bound = [];
  function on(target, type, fn, opts) {
    if (!target || !target.addEventListener) return;
    target.addEventListener(type, fn, opts);
    bound.push([target, type, fn, opts]);
  }
  if (root) on(root, 'pointerdown', onDown, { passive: false });
  if (win) {
    // CAPTURE PHASE, deliberately.
    //
    // UI controls call stopPropagation() on pointerup (see ui/dom.js onTap) so
    // that a tap on a button never leaks through to the 3D layer. In the bubble
    // phase that also swallowed the joystick's release: let go of the stick
    // anywhere over a button, card or panel and the stick stayed latched at its
    // last value, so the settler ran forever and slid around the coastline in
    // circles with no way to stop. Capture-phase listeners run before any UI
    // handler can cancel them, so a release is always seen.
    on(win, 'pointermove', onMove, { passive: false, capture: true });
    on(win, 'pointerup', onUp, { capture: true });
    on(win, 'pointercancel', onCancel, { capture: true });
    on(win, 'blur', onBlur);
    on(win, 'keydown', onKeyDown);
    on(win, 'keyup', onKeyUp);
    on(win, 'contextmenu', e => { if (e.preventDefault) e.preventDefault(); });
    // The pad is anchored to a corner, so a rotation or a keyboard opening
    // moves the corner. Re-park it rather than leave the ring stranded.
    on(win, 'resize', layoutPad);
    on(win, 'orientationchange', () => setTimeout(layoutPad, 140));

    // Belt and braces for the other ways a browser silently drops a pointer:
    // an OS gesture, an alt-tab, a phone call, a backgrounded tab.
    on(win, 'pointerleave', ev => { if (ev.target === win || !ev.relatedTarget) endStick(); });
    if (typeof document !== 'undefined') {
      on(document, 'visibilitychange', () => { if (document.hidden) onBlur(); });
    }
  }

  /* --------------------------------------------------------------- update */
  function update() {
    api.frame++;

    if (!touchStick) {
      let kx = 0, ky = 0;
      if (keys.has('KeyD') || keys.has('ArrowRight')) kx += 1;
      if (keys.has('KeyA') || keys.has('ArrowLeft')) kx -= 1;
      if (keys.has('KeyW') || keys.has('ArrowUp')) ky += 1;
      if (keys.has('KeyS') || keys.has('ArrowDown')) ky -= 1;
      const m = Math.hypot(kx, ky);
      if (m > 1) { kx /= m; ky /= m; }
      stick.x = kx; stick.y = ky;
    }

    // Safety: never hand out a magnitude above 1 or a NaN.
    if (!Number.isFinite(stick.x)) stick.x = 0;
    if (!Number.isFinite(stick.y)) stick.y = 0;
    const mag = Math.hypot(stick.x, stick.y);
    if (mag > 1) { stick.x /= mag; stick.y /= mag; }

    api.tapped = tapPending; tapPending = false;
    api.actionPressed = actionPending; actionPending = false;
    api.mapPressed = mapPending; mapPending = false;

    if (win && win.dispatchEvent && typeof CustomEvent === 'function') {
      if (api.actionPressed) win.dispatchEvent(new CustomEvent('island:action'));
      if (api.mapPressed) win.dispatchEvent(new CustomEvent('island:map'));
    }
  }

  function setEnabled(v) {
    enabled = !!v;
    if (!enabled) endStick();
  }

  /**
   * Hand the keyboard to a modal panel (and take it back).
   *
   * Both edges drop every held key and zero the stick: opening a sheet while
   * running must not leave a direction latched, and closing one must not
   * inherit a key whose keyup the panel swallowed.
   */
  function setKeyboardCapture(v) {
    const on = !!v;
    if (on === keyCapture) return;
    keyCapture = on;
    keys.clear();
    stick.x = 0; stick.y = 0;
    if (on) endStick();
  }

  /* Park it now, and again whenever the player changes which hand they play
     with. `onOptionsChange` fires for every option; layoutPad re-reads the one
     it cares about and is cheap enough not to bother filtering. */
  layoutPad();
  const stopWatchingOptions = onOptionsChange(() => layoutPad());

  function dispose() {
    try { stopWatchingOptions(); } catch (e) { /* already gone */ }
    for (const [t, type, fn, opts] of bound) t.removeEventListener(type, fn, opts);
    bound.length = 0;
    if (layer && layer.parentNode) layer.parentNode.removeChild(layer);
  }

  return api;
}

export default createInput;
