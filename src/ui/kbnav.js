/**
 * Island Settlers — keyboard navigation for every menu in the game.
 *
 *   const nav = createKeyNav({ input });
 *   const off = nav.registerScope({ node, isOpen, priority, first, onEscape });
 *
 * =============================================================================
 * WHY THIS EXISTS
 * =============================================================================
 *
 *   "The up down left and right arrow keys all work to navigate any page I'm on
 *    to all of the different buttons on all of the different screens including
 *    the menus, settings, match setup, etc. And the enter button helps me switch
 *    toggles as well."
 *
 * The game was built thumb-first and every control in it is a real
 * `<button>` — so the browser would happily have given us Tab traversal for
 * free, except that `systems/input.js` swallows Tab game-wide (it is the board
 * map key) and a full-screen landscape game must never grow a focus order that
 * wanders off into browser furniture. What a player without a mouse actually
 * wants is not tab order anyway: it is the four arrow keys pointed at the thing
 * they can see.
 *
 * So this module does DIRECTIONAL navigation over whatever is on screen right
 * now, and nothing else. It never renders, never owns a control, and never
 * decides what a button does — pressing Enter on a focused `<button>` is the
 * browser's own click, which is why every toggle, switch and segmented control
 * in the build works through here without being told about it.
 *
 * =============================================================================
 * SCOPES
 * =============================================================================
 * A SCOPE is one screen or sheet: the home view, match setup, the settings
 * sheet, the friends panel, the rules popup, the end-of-match dock. Each one
 * registers itself and says when it is open. On every key we pick the OPEN
 * scope with the highest priority — that is the modal stack, expressed as a
 * number — and navigate inside it and nowhere else. A sheet over a screen
 * therefore traps the arrows without anybody writing a focus trap.
 *
 * `first` names where the cursor lands when a scope opens, which is the whole
 * of this request:
 *
 *   "On the home screen the Play button is already selected, so that if I press
 *    enter it presses play."
 *
 * A scope with no `first` uses `[data-kb-first]` inside it, then the first
 * control in DOM order.
 *
 * =============================================================================
 * WHAT IT DELIBERATELY DOES NOT DO
 * =============================================================================
 *  - It does not touch text inputs beyond letting them keep their own keys: if
 *    the cursor is in the name box or the room-code box, Left/Right and Enter
 *    belong to the field, and Up/Down leave it.
 *  - It does not fight `systems/input.js`. Scopes that sit over a live match
 *    ask for `captures: true` and we hand the keyboard to the sheet the same
 *    way `ui/panels.js` does, so the settler cannot run off while somebody is
 *    reading the rules.
 *  - It never calls `preventDefault` on a key it did not use.
 *
 * Owner: UI agent.
 */

const FOCUSABLE =
  'button:not([disabled]),input:not([disabled]),select:not([disabled]),' +
  '[tabindex]:not([tabindex="-1"])';

/** Perpendicular drift is worth this much more than travel along the arrow. */
const OFF_AXIS = 2.4;

/** Rects this thin are decoration that happens to be a button. */
const MIN_BOX = 4;

const DIRS = {
  ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]
};

function visible(node) {
  if (!node || !node.getClientRects) return false;
  const rects = node.getClientRects();
  if (!rects.length) return false;
  const r = rects[0];
  return r.width > MIN_BOX && r.height > MIN_BOX;
}

function isTextField(node) {
  if (!node || node.nodeType !== 1) return false;
  if (node.isContentEditable) return true;
  const tag = (node.tagName || '').toUpperCase();
  if (tag === 'TEXTAREA') return true;
  if (tag !== 'INPUT') return false;
  const type = (node.getAttribute('type') || 'text').toLowerCase();
  return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range'].includes(type);
}

function centreOf(node) {
  const r = node.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, r };
}

/**
 * The next control in direction `[dx, dy]` from `from`, or the wrap-around one
 * when there is nothing that way. Scored on the centres: distance along the
 * arrow plus a heavy penalty for drifting off it, which is what makes a row of
 * four difficulty buttons behave like a row and a column of rows like a column.
 */
function nextInDirection(list, from, dx, dy) {
  if (!list.length) return null;
  if (!from) return list[0];
  const a = centreOf(from);
  let best = null, bestScore = Infinity;
  let wrap = null, wrapScore = -Infinity;
  for (const node of list) {
    if (node === from) continue;
    const b = centreOf(node);
    const along = (b.x - a.x) * dx + (b.y - a.y) * dy;
    const off = Math.abs((b.x - a.x) * dy - (b.y - a.y) * dx);
    // A neighbour has to be genuinely that way, not merely beside us. The
    // threshold is half a control so two buttons on one line never count as
    // being above one another.
    if (along > 2) {
      const score = along + off * OFF_AXIS;
      if (score < bestScore) { bestScore = score; best = node; }
    } else {
      // Wrap candidates: the furthest thing in the OPPOSITE direction.
      const score = -along - off * OFF_AXIS;
      if (score > wrapScore) { wrapScore = score; wrap = node; }
    }
  }
  return best || wrap || null;
}

export function createKeyNav(opts = {}) {
  const win = opts.window
    || (typeof window !== 'undefined' ? window : null);
  const doc = opts.document
    || (win && win.document)
    || (typeof document !== 'undefined' ? document : null);
  if (!win || !doc) {
    const noop = () => {};
    return {
      registerScope: () => noop, focusTop: noop, sync: noop,
      setInput: noop, destroy: noop, get top() { return null; }
    };
  }

  const scopes = [];
  let lastTop = null;
  let captured = false;
  /* The navigator is built with the opening screen, long before `createInput`
     exists. Whoever makes the input hands it over later. */
  let input = opts.input || null;

  function setCapture(on) {
    if (on === captured) return;
    captured = on;
    if (input && typeof input.setKeyboardCapture === 'function') {
      /* A NAMED lock, not the boolean. `ui/panels.js` and `ui/overview.js` want
         the keyboard too and their sheets overlap ours — releasing a shared
         flag was handing the arrows back to the settler out from under an open
         trade sheet. See `setKeyboardCapture` in systems/input.js. */
      try { input.setKeyboardCapture(on, 'kbnav'); } catch (e) { /* optional */ }
    }
  }

  function openScopes() {
    const out = [];
    for (const s of scopes) {
      let live = true;
      if (typeof s.isOpen === 'function') {
        try { live = !!s.isOpen(); } catch (e) { live = false; }
      }
      if (live && visible(s.node)) out.push(s);
    }
    return out;
  }

  function topScope() {
    const live = openScopes();
    if (!live.length) return null;
    let best = live[0];
    for (const s of live) if ((s.priority || 0) >= (best.priority || 0)) best = s;
    return best;
  }

  function controlsIn(scope) {
    const list = [];
    const seen = new Set();
    const push = node => {
      if (!node || seen.has(node)) return;
      if (node.disabled) return;
      if (node.getAttribute && node.getAttribute('aria-hidden') === 'true') return;
      if (node.classList && node.classList.contains('kb-skip')) return;
      if (!visible(node)) return;
      seen.add(node); list.push(node);
    };
    if (scope.node.matches && scope.node.matches(FOCUSABLE)) push(scope.node);
    scope.node.querySelectorAll(FOCUSABLE).forEach(push);
    return list;
  }

  function defaultTarget(scope, list) {
    if (typeof scope.first === 'function') {
      let want = null;
      try { want = scope.first(); } catch (e) { want = null; }
      if (want && list.indexOf(want) >= 0) return want;
    }
    const marked = scope.node.querySelector && scope.node.querySelector('[data-kb-first]');
    if (marked && list.indexOf(marked) >= 0) return marked;
    return list[0] || null;
  }

  function focusNode(node) {
    if (!node || typeof node.focus !== 'function') return false;
    try { node.focus({ preventScroll: true }); } catch (e) { try { node.focus(); } catch (e2) { return false; } }
    if (node.classList) node.classList.add('kb-on');
    for (const other of doc.querySelectorAll('.kb-on')) {
      if (other !== node) other.classList.remove('kb-on');
    }
    return true;
  }

  /** Put the cursor on a scope's preferred control. Safe to call repeatedly. */
  function focusTop(force) {
    const scope = topScope();
    if (!scope) {
      setCapture(false);
      lastTop = null;
      return false;
    }
    setCapture(!!scope.captures);
    const list = controlsIn(scope);
    const active = doc.activeElement;
    const inside = active && active !== doc.body && scope.node.contains(active)
      && list.indexOf(active) >= 0;
    if (inside && !force) return true;
    return focusNode(defaultTarget(scope, list));
  }

  /* The only way to notice a screen opened is to look, because every screen in
     this build is shown by toggling a class on a node nobody else watches.
     Six times a second costs a handful of `getClientRects` calls and buys a
     cursor that is already on PLAY when the title lands. */
  function sync() {
    const scope = topScope();
    if (scope !== lastTop) {
      lastTop = scope;
      focusTop(true);
    } else if (scope) {
      // The friends panel rebuilds its whole body on every socket push, which
      // throws the focused node away. Put the cursor back rather than leaving
      // the player pressing keys at nothing.
      const active = doc.activeElement;
      if (!active || active === doc.body || !scope.node.contains(active)) focusTop(true);
    }
  }
  const timer = setInterval(sync, 160);

  function onKey(ev) {
    if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
    const code = ev.code || ev.key;
    const scope = topScope();
    if (!scope) return;

    const active = doc.activeElement;
    const typing = isTextField(active);

    if (code === 'Escape') {
      if (typeof scope.onEscape === 'function') {
        if (ev.preventDefault) ev.preventDefault();
        /* IMMEDIATE, not plain `stopPropagation`.
         *
         * Every keyboard owner in this game listens on `window`, and
         * `stopPropagation` does nothing to the OTHER listeners on the node the
         * event is currently at — so the plain call let `ui/hotkeys.js` see the
         * same Escape a frame later, find the settings sheet already closed by
         * this handler, and helpfully open it again. The drawer would not shut.
         */
        ev.stopImmediatePropagation();
        try { scope.onEscape(); } catch (e) { /* the sheet knows best */ }
        return;
      }
      return;
    }

    /*
     * ENTER PRESSES THE THING THE RING IS ON, AND WE DO IT OURSELVES.
     *
     *   "And the enter button helps me switch toggles as well."
     *
     * A focused `<button>` would normally be activated by the browser's own
     * default action on Enter or Space, and relying on that was the first thing
     * tried. It is not reliable here for two independent reasons, and both had
     * to be found the hard way:
     *
     *   - `systems/input.js` calls `preventDefault()` on the Space keydown
     *     game-wide, before any capture check, so Space could never activate
     *     anything;
     *   - a synthesised key (a `rawKeyDown` over the DevTools protocol, which
     *     is what `tools/kbtrace.mjs` drives the menus with) carries no default
     *     action at all, so the whole menu was untestable.
     *
     * Calling `.click()` fixes both and costs nothing: `dom.js`'s tap guard
     * only ever swallows a click that FOLLOWED a moved pointer, so a keyboard
     * click passes through it untouched.
     */
    if (code === 'Enter' || code === 'NumpadEnter' || code === 'Space') {
      if (typing) return;                       // the field keeps its own keys
      if (!active || !scope.node.contains(active)) return;
      /* ONLY WHAT THE RING IS ON.
       *
       * `.kb-on` is the drawn cursor, and it is removed on the first pointer
       * press (see `onPointer`). Requiring it means Enter can never press
       * something the player cannot see is selected — which matters because
       * other modules also claim Enter for their own jobs (panels.js maps it to
       * "bring the score back" for the whole of the end of a match), and a
       * silent, invisible focus quietly eating that key is a bug nobody can
       * describe. */
      if (!active.classList || !active.classList.contains('kb-on')) return;
      if (typeof active.click !== 'function') return;
      if (ev.preventDefault) ev.preventDefault();
      ev.stopImmediatePropagation();
      active.click();
      return;
    }

    const dir = DIRS[code];
    if (!dir) return;
    // A text field keeps Left/Right for its caret; Up/Down step out of it.
    if (typing && (code === 'ArrowLeft' || code === 'ArrowRight')) return;

    const list = controlsIn(scope);
    if (!list.length) return;
    const from = (active && list.indexOf(active) >= 0) ? active : null;
    const next = nextInDirection(list, from, dir[0], dir[1]);
    if (!next) return;
    if (ev.preventDefault) ev.preventDefault();
    ev.stopImmediatePropagation();
    focusNode(next);
  }

  /* Capture phase, so a scope's arrows are claimed before `systems/input.js`
     can read them as movement or `ui/panels.js` can read them as a trade. */
  win.addEventListener('keydown', onKey, true);

  /* A pointer press is the player saying they have a mouse after all. Drop the
     drawn cursor so a stale ring is not left glowing on a button they are not
     using; the next arrow key puts it back. */
  function onPointer() {
    for (const node of doc.querySelectorAll('.kb-on')) node.classList.remove('kb-on');
  }
  win.addEventListener('pointerdown', onPointer, true);

  return {
    /**
     * @param {object} spec
     *   node      the element the screen lives in
     *   isOpen()  optional — false hides the scope even while it is on screen
     *   priority  higher wins when two scopes are open (a sheet over a screen)
     *   first()   optional — the control the cursor lands on
     *   onEscape()optional — what Escape does here
     *   captures  take the keyboard off the settler while this scope is open
     * @returns {function} unregister
     */
    registerScope(spec) {
      if (!spec || !spec.node) return () => {};
      scopes.push(spec);
      return () => {
        const i = scopes.indexOf(spec);
        if (i >= 0) scopes.splice(i, 1);
        if (lastTop === spec) lastTop = null;
      };
    },
    focusTop,
    sync,
    /** The input layer arrives after the menus do; this is how it gets here. */
    setInput(next) { input = next || null; },
    get top() { return topScope(); },
    destroy() {
      clearInterval(timer);
      win.removeEventListener('keydown', onKey, true);
      win.removeEventListener('pointerdown', onPointer, true);
      scopes.length = 0;
      setCapture(false);
    }
  };
}

/* ------------------------------------------------------------------ shared */

/*
 * ONE NAVIGATOR FOR THE WHOLE PAGE.
 *
 * The menus are built by `systems/flowUI.js` before a match exists and the
 * in-match sheets by `ui/hud.js` after one does, and neither can hand the other
 * an object. They both ask for the navigator instead: it is created on first
 * use and every scope in the game ends up on the same modal stack, which is the
 * only way a settings sheet over a match can reliably out-rank the match.
 */
let shared = null;

export function keyNav(opts) {
  if (!shared) shared = createKeyNav(opts || {});
  else if (opts && opts.input) shared.setInput(opts.input);
  return shared;
}

export function resetKeyNav() {
  if (shared) shared.destroy();
  shared = null;
}

export default createKeyNav;
