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

/** A chunky game button. Always tagged data-ui so the joystick ignores it. */
export function button(cls, attrs, ...kids) {
  const a = Object.assign({ type: 'button', 'data-ui': '' }, attrs || {});
  a.class = 'btn ' + (cls || '');
  return el('button', a, ...kids);
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

export default { el, button, clear, clamp, lerp, fmtTime, hash01, onTap };
