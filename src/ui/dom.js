/**
 * Island Settlers — tiny DOM helpers shared by the interface layer.
 *
 * No framework, no dependencies. Everything the HUD, the board overview and
 * the panels need to build markup quickly and safely, plus a couple of
 * formatting utilities. Owner: UI agent.
 */

/**
 * el('div', { class:'x', text:'hi', on:{ click:fn } }, child, child...)
 * Any attribute not handled specially is passed to setAttribute, so
 * `{ 'data-kind':'road' }` and `{ 'aria-label':'Build' }` just work.
 */
export function el(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  if (attrs) {
    for (const k in attrs) {
      const v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class' || k === 'className') n.className = v;
      else if (k === 'text') n.textContent = String(v);
      else if (k === 'html') n.innerHTML = v;
      else if (k === 'style') {
        if (typeof v === 'string') n.setAttribute('style', v);
        else for (const p in v) setVar(n, p, v[p]);
      } else if (k === 'on') {
        for (const evt in v) n.addEventListener(evt, v[evt]);
      } else n.setAttribute(k, v === true ? '' : String(v));
    }
  }
  add(n, kids);
  return n;
}

function add(parent, kids) {
  for (const c of kids) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) { add(parent, c); continue; }
    parent.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
  return parent;
}

/**
 * How far a finger may travel and still have meant to press.
 *
 * Twelve pixels is the same figure `onTap` uses below and is about a
 * millimetre and a half of thumb — under it nobody is scrolling, over it
 * nobody is aiming.
 */
const TAP_SLOP = 12;

/**
 * A chunky game button. Always tagged data-ui so the joystick ignores it.
 *
 * A DRAG IS NOT A PRESS, EVEN WHEN IT ENDS ON THE BUTTON.
 *
 *   "I'd prefer that if it doesn't register an actual click of those buttons,
 *    but instead I'm just trying to scroll down, my finger would be able to
 *    touch the button while attempting to scroll."
 *
 * The CSS half of that is in ui-base.css: buttons inside a scrolling panel get
 * `touch-action: pan-y` so the browser is allowed to take the gesture at all.
 * When it does take it, it cancels the press and suppresses the click, and
 * nothing here is needed.
 *
 * This is the other half, for the case where the browser does NOT take it —
 * a short drag it judged too small to be a scroll, a mouse dragged across a
 * button, a panel that turned out to have nothing to scroll. The click still
 * fires, and firing it means a player who was reaching for the list has just
 * left the match. So the pointer is measured, and a press that travelled is
 * dropped. A press that did not travel behaves exactly as it always did.
 */
export function button(cls, attrs, ...kids) {
  const a = Object.assign({ type: 'button', 'data-ui': '' }, attrs || {});
  a.class = 'btn ' + (cls || '');
  const node = el('button', a, ...kids);
  guardTaps(node);
  return node;
}

/**
 * Drop a click that arrived at the end of a drag.
 *
 * Capture phase, so it runs before the handlers `el` attached — a click that
 * is stopped here never reaches them. Nothing is remembered between presses:
 * `moved` is set on the way down and only ever read for the click that follows.
 */
export function guardTaps(node) {
  if (!node || !node.addEventListener) return node;
  let sx = 0, sy = 0, moved = false;
  node.addEventListener('pointerdown', e => {
    sx = e.clientX; sy = e.clientY; moved = false;
  }, true);
  node.addEventListener('pointermove', e => {
    if (Math.abs(e.clientX - sx) > TAP_SLOP || Math.abs(e.clientY - sy) > TAP_SLOP) moved = true;
  }, true);
  node.addEventListener('click', e => {
    if (!moved) return;
    moved = false;
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    e.preventDefault();
  }, true);
  return node;
}

export function clear(node) {
  if (!node) return node;
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** Set a plain style property or a custom property (`--c`). */
export function setVar(node, prop, value) {
  if (!node || !node.style) return;
  if (prop.charCodeAt(0) === 45 /* - */) {
    if (node.style.setProperty) node.style.setProperty(prop, value);
  } else node.style[prop] = value;
}

export function setText(node, value) {
  if (!node) return;
  const s = String(value);
  if (node.textContent !== s) node.textContent = s;
}

export function toggle(node, cls, on) {
  if (!node || !node.classList) return;
  if (node.classList.toggle) node.classList.toggle(cls, !!on);
  else if (on) node.classList.add(cls); else node.classList.remove(cls);
}

/** Restart a CSS animation on an element. */
export function replay(node, cls, ms = 620) {
  if (!node || !node.classList) return;
  node.classList.remove(cls);
  // Reading a layout property forces the removal to take effect.
  void (node.offsetWidth || 0);
  node.classList.add(cls);
  if (node.__replayT) clearTimeout(node.__replayT);
  node.__replayT = setTimeout(() => node.classList.remove(cls), ms);
}

export function fmtTime(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;

/** Deterministic 0..1 hash — used for painterly jitter that never flickers. */
export function hash01(n) {
  let x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Fire `fn` on a real tap. Uses pointer events with a movement threshold so a
 * drag across the map never counts, and always calls preventDefault so the
 * 3D layer below never sees the touch.
 */
export function onTap(node, fn) {
  if (!node || !node.addEventListener) return;
  let id = -1, sx = 0, sy = 0, moved = false;
  node.addEventListener('pointerdown', e => {
    id = e.pointerId; sx = e.clientX; sy = e.clientY; moved = false;
    if (e.stopPropagation) e.stopPropagation();
  });
  node.addEventListener('pointermove', e => {
    if (e.pointerId !== id) return;
    if (Math.abs(e.clientX - sx) > 12 || Math.abs(e.clientY - sy) > 12) moved = true;
  });
  node.addEventListener('pointerup', e => {
    if (e.pointerId !== id) return;
    id = -1;
    if (e.stopPropagation) e.stopPropagation();
    if (!moved) fn(e);
  });
  node.addEventListener('pointercancel', () => { id = -1; });
}

export default { el, button, clear, clamp, lerp, fmtTime, hash01, onTap, guardTaps };
