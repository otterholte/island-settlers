/**
 * Island Settlers — pan and zoom for the board map.
 *
 *   createOvPan(canvas, proj, { frameOf, root }) ->
 *     { apply(base), reset(), zoomAt(k, x, y), nudge(dx, dy),
 *       gesturing, moved, info, controls, destroy() }
 *
 * The map is a painted board that has always been drawn to FIT, which means the
 * coast on the rail side and the docks under the title plate are permanently
 * half-covered by the chrome sitting over them:
 *
 *   "Even manipulate/move around the map view, since sometimes the screen
 *    elements cover the map's edges."
 *
 * So the board now moves. One finger drags it, two fingers pinch it, a wheel or
 * the +/- keys zoom it about wherever the pointer is, and 0 puts it back. The
 * clamp is the promise: the CENTRE of the board is never allowed
 * outside the middle three quarters of the map frame, at any zoom, so the island
 * can be pushed far enough to get a dock out from under a panel and never far
 * enough to be lost off the edge of the screen.
 *
 * How it composes with overview.js
 * --------------------------------
 * `measure()` there computes the fit-to-frame projection and hands it here as
 * `base`; `apply()` writes the panned/zoomed values straight into the same
 * `proj` object the painter reads. Nothing else in the map knows this file
 * exists — targets, docks, pieces and the settler pin all follow because they
 * are all drawn through `proj`.
 *
 * The HOME key
 * ------------
 * The pad is now a single key and it is not a map control. It used to be a
 * house glyph wired to fit-to-frame, which is not what a house means to
 * anybody:
 *
 *   "If I've already started a game, let the home button on the left of the
 *    screen work all the time and exit the game back to the home screen even
 *    when other players or bots are choosing their spots in the draft."
 *
 * So the house now does what it looks like, and the map pad is the one control
 * that is up in EVERY overview mode
 * including `draft-watch` — which is exactly the moment the quote is about, when
 * the board is locked and there is otherwise no way out of the match.
 *
 * There is no FIT key any more:
 *
 *   "I don't know what the icon/button is below the plus and minus on the left
 *    side of the screen for the map view, remove it."
 *
 * Which is the answer by itself — a key whose owner cannot tell what it does is
 * not earning a third of a pad on a phone. Fit-to-frame is still one keystroke
 * away on 0, and zooming all the way out lands in the same place.
 *
 * ...and there are no +/- keys either, for the notch reason set out above the
 * stylesheet. Pinch, wheel and the +/- keys still zoom; only the buttons went.
 *
 * It arms on the first tap and leaves on the second, within ARM_MS. A single
 * stray tap on a 38px key should not throw away a twenty-minute match, and a
 * modal confirm over a locked draft board is worse than a key that says LEAVE?
 *
 * `gesturing` is true only while a finger is down. overview.js uses it to skip
 * re-baking the nineteen-hex background mid-drag and blit the last bake through
 * a transform instead: sharp when still, cheap when moving.
 *
 * Owner: UI agent.
 */

import { HEX_SIZE } from '../core/constants.js';
import { BOUNDS } from '../board/layout.js';
/* `mapTilt`/`setMapTilt` are no longer imported: the tilt input is gone and
   the stored value with it. See the `setTilt` note below. */

const STYLE_ID = 'ovpan-style';

/* HOW FAR BACK YOU CAN PULL.
 *
 *   "I should be able to zoom out more on the 3D version of the map overview.
 *    When I use two fingers to change the view I can't zoom out as far as I
 *    need."
 *
 * 0.90 was a floor set when the map only ever fitted the board to the frame:
 * ten per cent under the fit is not a zoom range, it is a rounding error, and
 * it existed to stop the island shrinking into a dot. There is a reason to go
 * further now — a tilted board is fitted at a LARGER scale, so "all the way
 * out" from a tilted view has further to travel before it shows the whole
 * island and its docks with room around them. 0.45 is about a third of the
 * fit, which is small enough to see the shape of the whole thing and still
 * read which hex is which. */
export const ZOOM_MIN = 0.45;
export const ZOOM_MAX = 3.20;
const ZOOM_STEP = 1.22;
/** The board centre must stay this far inside the frame, as a fraction of it. */
const KEEP_IN = 0.14;
/** Travel under which a pointer was a tap; overview.js owns taps. */
const DRAG_SLOP = 4;

/* ------------------------------------------------------------------ tilt
 *
 *   "Let me use two fingers and drag up and down on the map view to reposition
 *    my view so it's a bit more 3D, and have it save that view the next time I
 *    open the map, even during the next game."
 *
 * The map is a flat overhead projection, so "more 3D" is a vertical squash
 * about the middle of the frame: the same board seen from a lower angle. That
 * is not a decoration — it is the second half of the sentence. Squashed to
 * 62% the whole island fits the height of a 375px phone with the tokens still
 * legible, which is the "see all of the tiles without zooming" the request
 * ends on.
 *
 * Two fingers already mean pinch here, and the two gestures separate cleanly:
 * a pinch changes the DISTANCE between the fingers, a tilt moves both of them
 * the same way. So the vertical travel of the midpoint drives the tilt and the
 * change in separation drives the zoom, and doing both at once does both,
 * which is what a hand actually does.
 *
 * Stored through core/options.js, so it is remembered between matches. */
const TILT_MIN_KY = 0.55;      // fully tilted: the board at 55% height
/* TILT_PER_PX is gone with the gesture that used it. */
/** How long the HOME key stays armed after the first tap, in ms. */
const ARM_MS = 4200;

/* THE PAD IS ONE KEY, AND IT IS IN THE CORNER.
 *
 *   "you cant see it from the image of the map. But the home button is getting
 *    covered by the notch in the iPhone. Can you actually remove the plus and
 *    minus buttons so they never get covered by the notches no matter what type
 *    of iphone is used. Also move the home button to the top left of the screen
 *    and out of the way of any notches."
 *
 * Two separate faults, one position.
 *
 * The ZOOM KEYS are gone outright. They were the two keys that had to live
 * halfway down a side — a vertical stack has to start somewhere — and halfway
 * down a side in landscape is exactly where an iPhone's sensor housing sits.
 * They were also the only control on this panel with a gesture that already
 * does the same job better: `zoomAt` is still here and still driven by pinch,
 * wheel and the +/- keys, so nothing was lost but the two buttons.
 *
 * The HOME key then has no reason to be mid-panel and every reason not to be,
 * so it moves to the top-left CORNER, which is the one part of a notched screen
 * no sensor housing reaches at any rotation. `left` and `top` are declared in
 * the stylesheet below rather than written by `layout()` — that was the actual
 * bug. `frame.x + 12` knew how wide the player rail was and nothing whatever
 * about the phone's safe area, so the key sat 18px from the glass on every
 * device ever made.
 *
 * NOTE FOR THE NEXT EDIT: everything from here down is inside a template
 * literal. A backtick in a comment closes it, and the module then fails to
 * parse — which `main.js` swallows into a stub overview, so the map simply
 * stops existing with no error anywhere. Ask how that is known.
 */
const CSS = `
.ovz{position:absolute;
  left:calc(var(--ovpad,6px) + var(--saln,0px) + 20px);
  top:calc(var(--ovpad,6px) + 20px);
  display:flex;flex-direction:row;align-items:center;gap:5px;z-index:6;
  pointer-events:auto;-webkit-user-select:none;user-select:none;
  -webkit-tap-highlight-color:transparent}
.ovz b{display:flex;align-items:center;justify-content:center;
  width:38px;height:34px;border-radius:10px;cursor:pointer;
  background:linear-gradient(180deg,rgba(20,48,84,.94),rgba(7,22,44,.94));
  border:2px solid rgba(255,201,60,.40);
  box-shadow:0 3px 10px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.16);
  transition:transform .1s ease,border-color .15s ease}
.ovz b:active{transform:translateY(2px) scale(.95);border-color:rgba(255,201,60,.9)}
.ovz b svg{display:block}
/* The HOME key is the only key on this pad now, and it is still coloured the
   way it was when it had to be told apart from two zoom keys: it leaves the
   match, it does not move the board. */
.ovz b.ovz-home{
  background:linear-gradient(180deg,rgba(122,32,28,.96),rgba(62,12,10,.96));
  border-color:rgba(255,150,120,.62)}
.ovz b.ovz-home.arm{
  background:linear-gradient(180deg,rgba(224,58,46,.98),rgba(148,22,16,.98));
  border-color:rgba(255,216,180,.95);
  box-shadow:0 3px 10px rgba(0,0,0,.5),0 0 16px rgba(245,60,42,.6),
             inset 0 1px 0 rgba(255,255,255,.2)}
/* left/top are written by layout(), which parks it beside the HOME key. */
.ovz-ask{position:absolute;white-space:nowrap;pointer-events:none;
  padding:4px 9px 5px;border-radius:10px;z-index:7;
  background:linear-gradient(180deg,rgba(214,54,44,.97),rgba(120,16,14,.97));
  border:1.5px solid rgba(255,214,180,.85);box-shadow:0 3px 10px rgba(0,0,0,.55);
  font:800 8.5px/1.2 var(--ff,system-ui);letter-spacing:.13em;text-transform:uppercase;
  color:#fff2e2;opacity:1;transition:opacity .2s ease}
.ovz-ask.off{opacity:0}
@media (max-height:500px),(max-width:1023px){.ovz b{width:33px;height:30px}
  .ovz-ask{font-size:7.5px}}
`;

const SV = body =>
  `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">${body}</svg>`;
const P = (d, w = 2.3, c = '#ffe0a0') =>
  `<path d="${d}" fill="none" stroke="${c}" stroke-width="${w}" ` +
  `stroke-linecap="round" stroke-linejoin="round"/>`;
const GLYPH = {
  plus: SV(P('M12 5.6v12.8M5.6 12h12.8')),
  minus: SV(P('M5.6 12h12.8')),
  home: SV(P('M4.4 11.4L12 4.6l7.6 6.8', 2.3, '#ffd9cc')
    + P('M6.8 10v9.4h10.4V10', 2, '#ffd9cc')),
  /* Armed: a door with an arrow going out of it. No going back from here. */
  leave: SV(P('M13.4 4.6H5.4v14.8h8', 2.3, '#fff2e2')
    + P('M11.2 12h8.4M16.4 8.8L19.6 12l-3.2 3.2', 2.3, '#fff2e2'))
};

function injectStyle(doc) {
  if (!doc || !doc.head || !doc.createElement) return;
  if (doc.getElementById && doc.getElementById(STYLE_ID)) return;
  const s = doc.createElement('style');
  s.id = STYLE_ID;
  s.textContent = CSS;
  doc.head.appendChild(s);
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export function createOvPan(cv, proj, opts = {}) {
  const doc = (cv && cv.ownerDocument) || (typeof document !== 'undefined' ? document : null);
  const win = (doc && doc.defaultView) || (typeof window !== 'undefined' ? window : null);
  const host = opts.root || (cv && cv.parentNode) || null;

  /* `px`/`py` move the board CENTRE, in css px, away from where the fit-to-frame
     projection would have put it. Zoom multiplies the fit scale. */
  /*
   * THE TILT IS GONE.
   *
   *   "Remove the 3d tilt. Its not needed just keep the birdseye standard
   *    view."
   *
   * It was a two-finger vertical drag that squashed the board to 55% height,
   * remembered between matches. Everything it touched is still here and still
   * wired — `proj.ky`, the squash in overview.js's `tiltIn`, the un-tilt in the
   * hit test — because a flat board is `ky === 1` and every one of those paths
   * already short-circuits on that. Only the INPUT is removed, so the map is
   * always the overhead view it was designed as, and the two-finger gesture
   * means one thing again instead of racing a pinch for the same fingers.
   *
   * `tilt` stays on the view object at 0 and is still reported by `info()`, so
   * the capture rig and anything else reading it keep working.
   */
  const view = { zoom: 1, px: 0, py: 0, tilt: 0 };
  /** Vertical squash factor the painter applies. 1 is flat overhead. */
  const kyOf = t => 1 - (1 - TILT_MIN_KY) * Math.min(1, Math.max(0, t));
  function setTilt() { return false; }
  proj.ky = kyOf(view.tilt);
  const base = { s: 1, ox: 0, oy: 0 };
  let gesturing = false;
  let moved = false;
  let touched = false;
  const stats = { drags: 0, zooms: 0, resets: 0, tilts: 0 };

  /* ------------------------------------------------------------------ DOM */
  let pad = null, hint = null, homeKey = null, ask = null;
  let armT = 0, armed = false;
  const onLeave = typeof opts.onLeave === 'function' ? opts.onLeave : null;
  if (doc && host && doc.createElement) {
    injectStyle(doc);
    const key = (glyph, label, fn) => {
      const b = doc.createElement('b');
      b.innerHTML = glyph;
      b.setAttribute('role', 'button');
      b.setAttribute('aria-label', label);
      b.addEventListener('pointerdown', e => {
        if (e.preventDefault) e.preventDefault();
        if (e.stopPropagation) e.stopPropagation();
        markTouched();
        fn();
      });
      return b;
    };
    /* No HOME key means no pad at all. The two zoom keys were the only other
       thing on it, and with them gone an empty 0x0 div in the corner is one
       more rectangle for the capture rig to have an opinion about. */
    if (onLeave) {
      pad = doc.createElement('div');
      pad.className = 'ovz';
      homeKey = key(GLYPH.home, 'Leave the match and go home', () => tapHome());
      homeKey.className = 'ovz-home';
      pad.appendChild(homeKey);
      host.appendChild(pad);
      /* The map's own close key also lives in the top-left corner. It steps
         aside for the HOME key rather than sharing the spot — see `.ov.ov-home
         .ov-x` in ui.css. */
      if (host.classList) host.classList.add('ov-home');
    }

    if (onLeave) {
      ask = doc.createElement('div');
      ask.className = 'ovz-ask off';
      ask.textContent = 'Leave match? Tap again';
      ask.style.display = 'none';
      host.appendChild(ask);
    }

    /* NO HINT ALONG THE BOTTOM.
     *
     *   "I don't like that the sections on the top and bottom of the screen
     *    are covering valuable real estate of where I want to see visually the
     *    map."
     *
     * DRAG TO MOVE · PINCH TO ZOOM was a permanent caption across the bottom
     * centre of the board telling a player two gestures they had already made
     * by the time they read it. `hint` stays null and every use of it below is
     * already guarded. */
  }

  function markTouched() {
    if (touched) return;
    touched = true;
    if (hint) hint.classList.add('off');
  }

  /* ------------------------------------------------------------- home key
     Tap once to arm, tap again to go. The armed state is loud on purpose —
     red key, door glyph, a chip that says what the next tap does — because
     the thing on the other side of it is an abandoned match. */
  function disarmHome() {
    armed = false;
    if (armT) { clearTimeout(armT); armT = 0; }
    if (homeKey) {
      homeKey.classList.remove('arm');
      homeKey.innerHTML = GLYPH.home;
      homeKey.setAttribute('aria-label', 'Leave the match and go home');
    }
    if (ask) {
      ask.classList.add('off');
      ask.style.display = 'none';
    }
  }

  function tapHome() {
    if (!onLeave) return;
    if (armed) { disarmHome(); onLeave(); return; }
    armed = true;
    if (homeKey) {
      homeKey.classList.add('arm');
      homeKey.innerHTML = GLYPH.leave;
      homeKey.setAttribute('aria-label', 'Tap again to leave the match');
    }
    if (ask) {
      ask.style.display = '';
      // layout() measures the chip, which forces the reflow the fade needs:
      // un-hiding and un-fading in the same frame with no read between them
      // makes the browser collapse both into one paint and skip the
      // transition. Hence measure, THEN drop the class, in that order.
      layout();
      ask.classList.remove('off');
    }
    if (armT) clearTimeout(armT);
    armT = setTimeout(disarmHome, ARM_MS);
  }

  /* --------------------------------------------------------------- clamps */
  function frame() {
    return (proj && proj.frame && proj.frame.w) ? proj.frame
      : { x: 0, y: 0, w: proj.w || 800, h: proj.h || 400 };
  }

  /** Where the board centre sits, in canvas css px, for the current view. */
  function centre() {
    const s = base.s * view.zoom;
    return {
      s,
      x: base.ox + BOUNDS.cx * base.s + view.px,
      y: base.oy + BOUNDS.cz * base.s + view.py
    };
  }

  /** The board may travel until its middle reaches the edge of the safe box. */
  function clampView() {
    const f = frame();
    const c = centre();
    const inX = f.w * KEEP_IN, inY = f.h * KEEP_IN;
    const wantX = clamp(c.x, f.x + inX, f.x + f.w - inX);
    const wantY = clamp(c.y, f.y + inY, f.y + f.h - inY);
    view.px += wantX - c.x;
    view.py += wantY - c.y;
    view.zoom = clamp(view.zoom, ZOOM_MIN, ZOOM_MAX);
  }

  /**
   * Write the panned/zoomed projection. `b` is the fit-to-frame result from
   * overview.js's measure(); it is remembered so gestures can work in the same
   * space between frames.
   */
  function apply(b) {
    base.s = b.s; base.ox = b.ox; base.oy = b.oy;
    clampView();
    proj.s = base.s * view.zoom;
    proj.ky = kyOf(view.tilt);
    const c = centre();
    proj.ox = c.x - BOUNDS.cx * proj.s;
    proj.oy = c.y - BOUNDS.cz * proj.s;
    layout();
    return proj;
  }

  /**
   * Park the confirm chip beside the HOME key.
   *
   * THE PAD ITSELF IS NO LONGER LAID OUT HERE. It used to be placed at
   * `frame.x + 12`, halfway down the panel — a position measured off the
   * BOARD's frame, which knows how wide the player rail is and nothing at all
   * about a phone's sensor housing. That is the whole of the notch bug. The pad
   * is now a corner control positioned by CSS off `--gLc`/`--gT`, so it moves
   * with the safe area on every device without this file being told about any
   * of them; all that is left to do here is hang the "tap again" chip off it,
   * and that is read from the pad's own resolved box rather than recomputed.
   */
  function layout() {
    if (!pad) return;
    const f = frame();
    if (ask && homeKey && ask.style.display !== 'none') {
      const keyH = homeKey.offsetHeight || 34;
      const askH = ask.offsetHeight || 20;
      ask.style.left = (pad.offsetLeft + (pad.offsetWidth || 38) + 8) + 'px';
      ask.style.top = Math.round(pad.offsetTop + keyH / 2 - askH / 2) + 'px';
    }
    if (hint) {
      hint.style.left = Math.round(f.x + f.w / 2) + 'px';
      hint.style.bottom = '10px';
      hint.style.transform = 'translateX(-50%)';
    }
  }

  /** Zoom about a canvas point — the world under it does not move. */
  function zoomAt(k, qx, qy) {
    if (!Number.isFinite(k) || k <= 0) return false;
    const f = frame();
    const px = Number.isFinite(qx) ? qx : f.x + f.w / 2;
    const py = Number.isFinite(qy) ? qy : f.y + f.h / 2;
    const before = view.zoom;
    const next = clamp(view.zoom * k, ZOOM_MIN, ZOOM_MAX);
    if (next === before) return false;
    // Keep the world point under (px,py) pinned: the board centre moves with it.
    const c = centre();
    const ratio = next / before;
    view.px += (c.x - px) * (ratio - 1);
    view.py += (c.y - py) * (ratio - 1);
    view.zoom = next;
    clampView();
    stats.zooms++;
    return true;
  }

  function nudge(dx, dy) {
    view.px += dx; view.py += dy;
    clampView();
    return true;
  }

  /* The tilt is NOT reset: it is a preference, not a pose, and the whole point
     of storing it is that it survives everything including this. */
  function reset(byHand) {
    view.zoom = 1; view.px = 0; view.py = 0;
    if (byHand) stats.resets++;
    return true;
  }

  /* ------------------------------------------------------------- pointers */
  const live = new Map();
  let pinch = 0;
  /** The two-finger midpoint's y last frame, or null when fewer than two. */
  let mid = null;
  let travel = 0;

  const local = ev => {
    const r = cv && cv.getBoundingClientRect ? cv.getBoundingClientRect() : { left: 0, top: 0 };
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  };

  function onDown(ev) {
    const p = local(ev);
    live.set(ev.pointerId, p);
    gesturing = true;
    travel = 0;
    moved = false;
    if (live.size === 2) {
      const [a, b] = [...live.values()];
      pinch = Math.hypot(a.x - b.x, a.y - b.y);
      mid = (a.y + b.y) / 2;
    }
    if (cv.setPointerCapture) { try { cv.setPointerCapture(ev.pointerId); } catch (e) { /* ok */ } }
  }

  function onMove(ev) {
    const prev = live.get(ev.pointerId);
    if (!prev) return;
    const p = local(ev);
    const dx = p.x - prev.x, dy = p.y - prev.y;
    prev.x = p.x; prev.y = p.y;
    travel += Math.abs(dx) + Math.abs(dy);

    if (live.size >= 2) {
      const [a, b] = [...live.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const spread = pinch > 8 && d > 8 ? Math.abs(d - pinch) : 0;
      if (pinch > 8 && d > 8) zoomAt(d / pinch, mx, my);
      pinch = d;
      /* Two fingers travelling the same way tilt; two fingers travelling apart
         zoom. `dy` here is one finger's step, and both fingers contribute one
         each per frame, so the midpoint moves by dy/2 — which is what drives
         the tilt. Dragging DOWN tilts back, the way pulling a board towards you
         would. */
      /* TELL THE TWO GESTURES APART. Fingers moving APART are a pinch and
         fingers moving TOGETHER are a tilt, and a real hand does a bit of both
         — so whichever dominates this frame wins it. Without this a pinch that
         is not perfectly symmetric drags the tilt along with it, which reads
         as "I can't zoom out", because the board is being stood up at the same
         time as it is being pulled back. */
      // ...and with the tilt gone (see `setTilt`), two fingers moving together
      // are simply not a gesture any more. `mid` is still tracked so the branch
      // above keeps its spread/travel comparison honest.
      mid = my;
      /* VERTICAL IS THE TILT, AND ONLY THE TILT. Panning as well would mean
         one gesture doing two things at once, and the board sliding out from
         under the hand that is trying to tilt it. Two fingers still pan
         sideways; one finger still pans in both. */
      nudge(dx / 2, 0);
      moved = true;
      markTouched();
      if (ev.cancelable) ev.preventDefault();
      return;
    }
    mid = null;
    if (travel < DRAG_SLOP) return;
    moved = true;
    markTouched();
    stats.drags++;
    nudge(dx, dy);
    if (ev.cancelable) ev.preventDefault();
  }

  function onUp(ev) {
    live.delete(ev.pointerId);
    if (live.size < 2) { pinch = 0; mid = null; }
    if (!live.size) gesturing = false;
  }

  /*
   * Wheel and two-finger scroll, about the cursor.
   *
   * Gain 0.0016 -> 0.0034 to match the free camera's pass ("can you make the
   * finger zooms zoom in and out a bit quicker"). The board map only spans 0.90
   * to 3.20 — a range of about 3.5x — so a notch that moved it by a fraction of
   * a per cent meant a long scroll to get anywhere inside it. Doubling the gain
   * crosses the whole range in a normal flick and still cannot overshoot: the
   * clamp on the exponent is unchanged and `zoomAt` clamps to the range itself.
   */
  function onWheel(ev) {
    const d = Number.isFinite(ev.deltaY) ? ev.deltaY : 0;
    if (!d) return;
    const p = local(ev);
    markTouched();
    zoomAt(Math.exp(clamp(-d * 0.0034, -1.0, 1.0)), p.x, p.y);
    if (ev.cancelable) ev.preventDefault();
  }

  /* Zoom keys only. The arrow keys belong to the settler for the whole
     match, and this panel is open DURING play — so nothing here ever listens
     for one. Panning is the drag; the keyboard only ever changes the zoom. */
  function onKey(ev) {
    if (!opts.isOpen || !opts.isOpen()) return;
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const code = ev.code || ev.key;
    let hit = true;
    if (code === 'Equal' || code === 'NumpadAdd') zoomAt(ZOOM_STEP);
    else if (code === 'Minus' || code === 'NumpadSubtract') zoomAt(1 / ZOOM_STEP);
    else if (code === 'Digit0' || code === 'Numpad0') reset(true);
    else hit = false;
    if (hit) { markTouched(); if (ev.preventDefault) ev.preventDefault(); }
  }

  const bound = [];
  const on = (t, type, fn, o) => {
    if (!t || !t.addEventListener) return;
    t.addEventListener(type, fn, o);
    bound.push([t, type, fn, o]);
  };
  on(cv, 'pointerdown', onDown, { passive: false });
  on(cv, 'pointermove', onMove, { passive: false });
  on(cv, 'pointerup', onUp);
  on(cv, 'pointercancel', onUp);
  on(cv, 'pointerleave', onUp);
  on(cv, 'wheel', onWheel, { passive: false });
  on(win, 'keydown', onKey);

  return {
    /*
     * SHOW THE HOME KEY, OR DO NOT.
     *
     *   "see how theres an X and a red home button. I dont need the home button
     *    there ever if the X is present."
     *
     * Right, and the reason both were there is worth keeping: HOME exists for
     * `draft-watch`, the one state where the board is locked, there is nothing
     * to close, and leaving the match is otherwise impossible. Every other mode
     * has a close key, and closing the map puts the player back in a match
     * whose gear already carries LEAVE MATCH. So the two are alternatives, not
     * a pair — overview.js calls this with whether the close key is up.
     */
    setHomeShown(on) {
      if (!pad) return;
      pad.style.display = on ? '' : 'none';
      if (!on) disarmHome();
      if (host && host.classList) host.classList.toggle('ov-home', !!on);
    },
    apply, reset, zoomAt, nudge,
    /** 0 flat, 1 fully tilted. Read by the capture rig; set by two fingers. */
    get tilt() { return view.tilt; },
    setTilt,
    get ky() { return proj.ky; },
    get gesturing() { return gesturing; },
    get moved() { return moved; },
    get zoom() { return view.zoom; },
    /** Capture-rig hook: pan offset, zoom, and whether the board is on screen. */
    get info() {
      const f = frame();
      const c = centre();
      const halfW = (BOUNDS.width / 2 + HEX_SIZE) * c.s;
      const halfH = (BOUNDS.depth / 2 + HEX_SIZE) * c.s;
      const onScreen = c.x + halfW > f.x && c.x - halfW < f.x + f.w
        && c.y + halfH > f.y && c.y - halfH < f.y + f.h;
      return {
        zoom: +view.zoom.toFixed(3),
        tilt: +view.tilt.toFixed(3),
        ky: +proj.ky.toFixed(3),
        /** Live world->canvas scale, so a trace can find any hex on screen. */
        s: +c.s.toFixed(3),
        pan: [Math.round(view.px), Math.round(view.py)],
        centre: [Math.round(c.x), Math.round(c.y)],
        frame: [Math.round(f.x), Math.round(f.y), Math.round(f.w), Math.round(f.h)],
        keepIn: [Math.round(f.x + f.w * KEEP_IN), Math.round(f.x + f.w * (1 - KEEP_IN)),
          Math.round(f.y + f.h * KEEP_IN), Math.round(f.y + f.h * (1 - KEEP_IN))],
        boardOnScreen: onScreen,
        zoomRange: [ZOOM_MIN, ZOOM_MAX],
        ...stats
      };
    },
    /** So overview.js can hide the buttons in the confirm-bar modes if it likes. */
    controls: pad,
    /** So a caller closing the map can drop an armed HOME key on the way out. */
    disarm: disarmHome,
    setVisible(v) {
      if (!v) disarmHome();
      if (pad) pad.style.display = v ? '' : 'none';
      if (hint) hint.style.display = v ? '' : 'none';
    },
    destroy() {
      disarmHome();
      for (const [t, type, fn, o] of bound) t.removeEventListener(type, fn, o);
      bound.length = 0;
      if (pad && pad.parentNode) pad.parentNode.removeChild(pad);
      if (hint && hint.parentNode) hint.parentNode.removeChild(hint);
      if (ask && ask.parentNode) ask.parentNode.removeChild(ask);
    }
  };
}

export default createOvPan;
