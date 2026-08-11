/**
 * Island Settlers — the board map's keyboard.
 *
 *   createMapKeys(hooks) -> { destroy() }
 *
 *   hooks = {
 *     isOpen()          is the panel up
 *     isPlacing()       is it offering targets (not 'view' / 'draft-watch')
 *     targets()         the live target id list
 *     selected()        the armed id, or null
 *     xyOf(id)          screen position of a target, tilt included, or null
 *     select(id)        arm a target
 *     commit()          take the armed one
 *     cycleKind(back)   Tab: switch to the next affordable piece; false if none
 *     action()          the single-button action, if this panel has one
 *   }
 *
 * =============================================================================
 * WHY IT IS ITS OWN FILE
 * =============================================================================
 *
 *   "Inside of the map when in the build phase, I can use the arrow keys to
 *    navigate to the right selection quickly. I also should be able to just
 *    press Tab from inside of that screen to tab between the types of items
 *    that I'm building."
 *
 * The map already had everything this needs and none of it was reachable
 * without a pointer, so the whole feature is about a hundred lines of key
 * routing over machinery that already exists — `select()` arms a target, lights
 * it on the board and drops a 3D ghost of the piece, and `commit()` is what a
 * second tap does. Kept out of `ui/overview.js` because that file is already
 * well past the contract's line budget and is edited by more than one agent;
 * everything here talks to it through the hooks above and knows nothing about
 * the board graph, the projection or the rules.
 *
 * =============================================================================
 * NEAREST IN DIRECTION, ON SCREEN — NOT IN THE BOARD GRAPH
 * =============================================================================
 * Walking the edge or corner graph sounds more principled and is worse in the
 * hand: the graph is a hex lattice with six directions and the keyboard has
 * four, so "up" from a corner is a coin toss between two neighbours and a run
 * of presses wanders. Scoring the projected screen positions makes Up mean up.
 *
 * `xyOf` is expected to return TILTED screen coordinates — the same squash the
 * player is looking at. Without it a press of Up near the top of the island
 * reaches for something that is visually beside it.
 *
 * Owner: UI agent.
 */

const ARROW_DIR = {
  ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]
};

/** Off-axis drift costs this much more than travel along the arrow. */
const OFF_AXIS = 2;

export function createMapKeys(hooks = {}) {
  const win = hooks.window || (typeof window !== 'undefined' ? window : null);
  if (!win || !win.addEventListener) return { destroy() {} };

  const isOpen = hooks.isOpen || (() => false);
  const isPlacing = hooks.isPlacing || (() => false);
  const targets = hooks.targets || (() => []);
  const selected = hooks.selected || (() => null);
  const xyOf = hooks.xyOf || (() => null);
  const select = hooks.select || (() => {});
  const commit = hooks.commit || (() => false);
  const cycleKind = hooks.cycleKind || (() => false);
  const action = hooks.action || (() => null);

  /**
   * The next target in `[dx, dy]` from the armed one.
   *
   * With nothing armed the cursor starts at whichever target is furthest INTO
   * the arrow's direction — press Left with nothing chosen and you land on the
   * leftmost, which is what a player expects from a first press.
   *
   * With something armed it is nearest-in-direction, and when there is nothing
   * that way it WRAPS to the furthest target the opposite way rather than
   * doing nothing: a dead key on a board that plainly has more spots on it
   * reads as broken, and a wrap is unambiguous the moment you see it happen.
   */
  function stepTarget(dx, dy) {
    const list = targets();
    if (!list || !list.length) return false;
    const sel = selected();

    if (sel === null || sel === undefined) {
      let best = null, bestScore = Infinity;
      for (const id of list) {
        const p = xyOf(id);
        if (!p) continue;
        const score = p.x * dx + p.y * dy;
        if (score < bestScore) { bestScore = score; best = id; }
      }
      if (best === null) return false;
      select(best);
      return true;
    }

    const from = xyOf(sel);
    if (!from) return false;
    let best = null, bestScore = Infinity;
    let wrap = null, wrapScore = -Infinity;
    for (const id of list) {
      if (id === sel) continue;
      const p = xyOf(id);
      if (!p) continue;
      const along = (p.x - from.x) * dx + (p.y - from.y) * dy;
      const off = Math.abs((p.x - from.x) * dy - (p.y - from.y) * dx);
      if (along > 1) {
        const score = along + off * OFF_AXIS;
        if (score < bestScore) { bestScore = score; best = id; }
      } else {
        const score = -along - off * OFF_AXIS;
        if (score > wrapScore) { wrapScore = score; wrap = id; }
      }
    }
    const next = best !== null ? best : wrap;
    if (next === null || next === undefined) return false;
    select(next);
    return true;
  }

  function onKey(ev) {
    if (!isOpen()) return;
    if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
    const code = ev.code || ev.key;
    const placing = isPlacing();

    /* TAB CYCLES THE PIECE. The hook routes it through the same call a tap on
       the chip makes, so a keyboard switch is byte-for-byte a tap: the same
       refusal, the same shake, the same free-road routing, the same server
       message online. Kinds nothing can be bought or placed for are skipped by
       the hook, because those chips are `disabled` and tabbing onto a dead one
       is how a shortcut teaches somebody that it is broken. */
    if (code === 'Tab') {
      if (!placing || !cycleKind(!!ev.shiftKey)) return;
      if (ev.preventDefault) ev.preventDefault();
      ev.stopImmediatePropagation();
      return;
    }

    if (code === 'Enter' || code === 'NumpadEnter') {
      // A panel with one button on it (the draft review) means that button.
      const act = action();
      if (typeof act === 'function') {
        if (ev.preventDefault) ev.preventDefault();
        ev.stopImmediatePropagation();
        act();
        return;
      }
      const sel = selected();
      if (!placing || sel === null || sel === undefined) return;
      if (ev.preventDefault) ev.preventDefault();
      ev.stopImmediatePropagation();
      commit();
      return;
    }

    const dir = ARROW_DIR[code];
    if (!dir || !placing) return;
    if (!stepTarget(dir[0], dir[1])) return;
    if (ev.preventDefault) ev.preventDefault();
    /* IMMEDIATE, because every keyboard owner in this game listens on `window`
       and plain `stopPropagation` does nothing between listeners on one node —
       so without this the settler would walk on every press that moved the
       cursor. See the note at the head of ui/hotkeys.js. */
    ev.stopImmediatePropagation();
  }

  // Capture phase, so the arrows are claimed before systems/input.js can read
  // them as movement or ui/panels.js as a trade.
  win.addEventListener('keydown', onKey, true);

  return {
    /** Exposed so a rig can move the cursor without synthesising a key. */
    step: stepTarget,
    destroy() { win.removeEventListener('keydown', onKey, true); }
  };
}

export default createMapKeys;
