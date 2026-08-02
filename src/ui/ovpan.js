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
 * the +/- keys zoom it about wherever the pointer is, and a home button puts it
 * back. The clamp is the promise: the CENTRE of the board is never allowed
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
 * `gesturing` is true only while a finger is down. overview.js uses it to skip
 * re-baking the nineteen-hex background mid-drag and blit the last bake through
 * a transform instead: sharp when still, cheap when moving.
 *
 * Owner: UI agent.
 */

import { HEX_SIZE } from '../core/constants.js';
import { BOUNDS } from '../board/layout.js';

const STYLE_ID = 'ovpan-style';

export const ZOOM_MIN = 0.90;
export const ZOOM_MAX = 3.20;
const ZOOM_STEP = 1.22;
/** The board centre must stay this far inside the frame, as a fraction of it. */
const KEEP_IN = 0.14;
/** Travel under which a pointer was a tap; overview.js owns taps. */
const DRAG_SLOP = 4;

const CSS = `
.ovz{position:absolute;display:flex;flex-direction:column;gap:5px;z-index:6;
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
.ovz-hint{position:absolute;display:flex;align-items:center;gap:6px;
  padding:4px 9px 5px;border-radius:11px;pointer-events:none;z-index:6;
  background:rgba(6,20,40,.78);border:1.5px solid rgba(255,201,60,.30);
  font:700 8px/1.2 var(--ff,system-ui);letter-spacing:.12em;text-transform:uppercase;
  color:rgba(206,226,246,.86);transition:opacity .3s ease}
.ovz-hint.off{opacity:0}
@media (max-height:400px){.ovz b{width:33px;height:30px}.ovz-hint{font-size:7px}}
`;

const SV = body =>
  `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">${body}</svg>`;
const P = (d, w = 2.3) =>
  `<path d="${d}" fill="none" stroke="#ffe0a0" stroke-width="${w}" ` +
  `stroke-linecap="round" stroke-linejoin="round"/>`;
const GLYPH = {
  plus: SV(P('M12 5.6v12.8M5.6 12h12.8')),
  minus: SV(P('M5.6 12h12.8')),
  home: SV(P('M4.4 11.4L12 4.6l7.6 6.8') + P('M6.8 10v9.4h10.4V10', 2))
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
  const view = { zoom: 1, px: 0, py: 0 };
  const base = { s: 1, ox: 0, oy: 0 };
  let gesturing = false;
  let moved = false;
  let touched = false;
  const stats = { drags: 0, zooms: 0, resets: 0 };

  /* ------------------------------------------------------------------ DOM */
  let pad = null, hint = null;
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
    pad = doc.createElement('div');
    pad.className = 'ovz';
    pad.appendChild(key(GLYPH.plus, 'Zoom in', () => zoomAt(ZOOM_STEP)));
    pad.appendChild(key(GLYPH.minus, 'Zoom out', () => zoomAt(1 / ZOOM_STEP)));
    const home = key(GLYPH.home, 'Fit the board', () => reset(true));
    home.className = 'ovz-home';
    pad.appendChild(home);
    host.appendChild(pad);

    hint = doc.createElement('div');
    hint.className = 'ovz-hint';
    hint.innerHTML = '<span>Drag to move</span><span>&middot;</span><span>Pinch to zoom</span>';
    host.appendChild(hint);
  }

  function markTouched() {
    if (touched) return;
    touched = true;
    if (hint) hint.classList.add('off');
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
    const c = centre();
    proj.ox = c.x - BOUNDS.cx * proj.s;
    proj.oy = c.y - BOUNDS.cz * proj.s;
    layout();
    return proj;
  }

  /** Park the buttons and the hint inside the frame, clear of the rail. */
  function layout() {
    if (!pad) return;
    const f = frame();
    pad.style.left = Math.round(f.x + 12) + 'px';
    pad.style.top = Math.round(f.y + f.h / 2 - 56) + 'px';
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

  function reset(byHand) {
    view.zoom = 1; view.px = 0; view.py = 0;
    if (byHand) stats.resets++;
    return true;
  }

  /* ------------------------------------------------------------- pointers */
  const live = new Map();
  let pinch = 0;
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
      if (pinch > 8 && d > 8) zoomAt(d / pinch, mx, my);
      pinch = d;
      nudge(dx / 2, dy / 2);
      moved = true;
      markTouched();
      if (ev.cancelable) ev.preventDefault();
      return;
    }
    if (travel < DRAG_SLOP) return;
    moved = true;
    markTouched();
    stats.drags++;
    nudge(dx, dy);
    if (ev.cancelable) ev.preventDefault();
  }

  function onUp(ev) {
    live.delete(ev.pointerId);
    if (live.size < 2) pinch = 0;
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

  /* Zoom keys only. Arrow keys and WASD belong to the settler for the whole
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
    apply, reset, zoomAt, nudge,
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
    setVisible(v) {
      if (pad) pad.style.display = v ? '' : 'none';
      if (hint) hint.style.display = v ? '' : 'none';
    },
    destroy() {
      for (const [t, type, fn, o] of bound) t.removeEventListener(type, fn, o);
      bound.length = 0;
      if (pad && pad.parentNode) pad.parentNode.removeChild(pad);
      if (hint && hint.parentNode) hint.parentNode.removeChild(hint);
    }
  };
}

export default createOvPan;
