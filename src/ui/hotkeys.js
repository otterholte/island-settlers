/**
 * Island Settlers — the in-match keyboard.
 *
 *   createHotkeys(state, game) -> { destroy() }
 *
 * =============================================================================
 * WHAT THIS IS FOR
 * =============================================================================
 *
 *   "Can you also help me update the controls for making it easier to play
 *    without needing to use a mouse or trackpad on desktop."
 *
 * The game is a landscape phone game and everything in it is reachable with one
 * thumb. On a desktop that same design means a hand on the arrow keys and a
 * hand on the mouse, reaching for a 44px circle in the corner every time you
 * want to build.
 * These are the keys that make the second hand unnecessary:
 *
 *   Space   pause / resume
 *   B       show or hide the build cards
 *   R S C   build a road / a settlement / a city — opens the placement map
 *   D       buy a development card
 *   T       open the Trading Post
 *   M       open your dock — or, with more than one, pick it off the map
 *   Esc     back out of whatever is in front of you; settings when nothing is
 *   P       pause (kept: it is the key the pause hint has always named)
 *
 * =============================================================================
 * S AND D ARE FREE, BECAUSE MOVEMENT GAVE THEM UP
 * =============================================================================
 *
 *   "Maybe have shortcut keys inside of the game so like S opens the settlement
 *    map ... R opens the road map ... C does the same for cities, and D
 *    purchases a development card."
 *
 * The first pass could not have S and D: they were half of W A S D, this module
 * runs in the CAPTURE phase, and taking them would have deleted "walk back" and
 * "walk right" from the game. They went to H and V instead, and that was the
 * wrong trade — the player would rather lose the second movement set than the
 * mnemonic:
 *
 *   "Update the WASD, go back to what I originally requested, and don't use
 *    WASD as options for moving around. Just use the arrow keys."
 *
 * So `MOVE_KEYS` in systems/input.js is the four arrows and nothing else, every
 * letter on the keyboard is available here, and all four build shortcuts are
 * the ones that were asked for. Nothing in this file has to be defensive about
 * it: a letter cannot collide with a key that is no longer movement.
 *
 * =============================================================================
 * ESCAPE IS A LADDER, NOT A KEY
 * =============================================================================
 *
 *   "Esc should open the settings."
 *   "Esc in an active trade clears the trade, and esc a second time when no
 *    trade is active closes the trading post."
 *
 * Those two are only compatible if Escape means "undo the innermost thing",
 * which is what every other program means by it. Top to bottom:
 *
 *   1. a sheet with its own Escape (the rules, the trade sheet, a menu) —
 *      left alone entirely; `ui/kbnav.js` and `ui/panels.js` claim the key in
 *      the capture phase before this handler ever runs
 *   2. the board map, in any mode — cancel it
 *   3. the settings drawer — close it
 *   4. nothing in front of you — OPEN the settings
 *
 * Which is why this module exists at all rather than the ladder living in
 * `ui/hud.js`: step 1 is a question about the trade sheet, step 2 about the
 * overview, and the HUD has no business knowing either.
 *
 * =============================================================================
 * WHY CAPTURE PHASE, AND WHY IT STILL DEFERS
 * =============================================================================
 * `systems/input.js` binds its movement handler at the window in the BUBBLE
 * phase and never stops propagation, so a capture-phase listener here sees
 * every key first and can take one out of circulation with
 * `stopImmediatePropagation` — IMMEDIATE, because every other keyboard owner
 * here also listens on `window`, and the plain call would not stop any of them.
 * That matters for Space: input.js reads it as the (now vestigial) action
 * button and, more importantly, `preventDefault`s it game-wide, so leaving it
 * to bubble would mean the pause key also scrolled nothing very loudly.
 *
 * Deferring is done by asking, not by ordering: `busy()` below lists every
 * surface that owns the keyboard, and none of the letters fire while one is up.
 *
 * Owner: UI agent.
 */

import { ports, tiles, tileAt } from '../board/layout.js';

/** Letters that only ever mean something while a match is actually running. */
/** Every letter this module answers to. Used to stand the settings drawer down
 *  before one of them raises something over it. */
const LETTERS = new Set(['KeyB', 'KeyT', 'KeyM', 'KeyR', 'KeyS', 'KeyC', 'KeyD']);

const BUILD_KEYS = {
  KeyR: 'road',
  KeyS: 'settlement',
  KeyC: 'city',
  KeyD: 'card'
};

function isTyping(ev) {
  const t = ev && ev.target;
  if (!t || t.nodeType !== 1) return false;
  if (t.isContentEditable) return true;
  const tag = (t.tagName || '').toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  const type = (t.getAttribute('type') || 'text').toLowerCase();
  return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range'].includes(type);
}

export function createHotkeys(state, game, opts = {}) {
  const win = opts.window || (typeof window !== 'undefined' ? window : null);
  if (!win || !win.addEventListener) return { destroy() {} };

  const hud = () => game && game.hud;
  const panels = () => game && game.panels;
  const overview = () => game && game.overview;
  const eco = () => game && game.economy;

  const playing = () => state && state.phase === 'play';
  const mapOpen = () => !!(overview() && overview().isOpen);
  const sheetOpen = () => !!(panels() && panels().isOpen);
  const helpOpen = () => !!(hud() && hud().helpOpen);

  /** Something in front of the world owns the keyboard right now. */
  function busy() {
    return sheetOpen() || helpOpen() || mapOpen();
  }

  function toast(msg, kind) {
    if (game && typeof game.toast === 'function') game.toast(msg, kind || 'warn');
  }

  /* ------------------------------------------------------------- trading */

  /**
   * T — the Trading Post, from wherever you are standing.
   *
   *   "Make the T button always open the trading post."
   *
   * ALWAYS, in the literal sense: the sheet comes up whether or not the settler
   * has walked to the middle of the island. If they are standing at one of
   * their own docks the sheet opens at that dock's better rate, because that is
   * plainly what somebody standing on a dock meant; otherwise it opens at the
   * Trading Post's flat rate, which is the baseline every dock is a discount on.
   *
   * This is the one shortcut in the file that changes a RULE rather than saving
   * a press, and it is deliberate — a keyboard player was otherwise walking to
   * the market to do something the interface could hand them. Ports still have
   * to be owned, and they are still the only way to beat the flat rate.
   */
  function openTradingPost() {
    const spot = eco() && typeof eco().tradeSpot === 'function' ? eco().tradeSpot() : null;
    const portId = spot && spot.at === 'port' ? spot.portId : null;
    if (game && typeof game.openTrade === 'function') game.openTrade(portId);
  }

  /** The docks this player has unlocked, nearest first. */
  function myPorts() {
    const me = state && state.players && state.players[0];
    if (!me || !me.ports) return [];
    const out = [];
    for (const id of me.ports) {
      const port = ports[id];
      if (port) out.push(port);
    }
    out.sort((a, b) => {
      const da = (a.x - me.x) ** 2 + (a.z - me.z) ** 2;
      const db = (b.x - me.x) ** 2 + (b.z - me.z) ** 2;
      return da - db;
    });
    return out;
  }

  /** Docks whose berth the settler is actually standing on. */
  function portsUnderfoot() {
    const me = state && state.players && state.players[0];
    if (!me) return [];
    let here = null;
    try { here = tileAt(me.x, me.z); } catch (e) { here = null; }
    const near = [];
    for (const port of myPorts()) {
      const d = Math.hypot(port.x - me.x, port.z - me.z);
      // A berth sits just off its edge, so "on it" is generous on purpose.
      if (d <= 9.0) { near.push(port); continue; }
      if (here && tiles[here.id]) {
        const touches = (port.intersections || []).some(iid =>
          (tiles[here.id].corners || []).indexOf(iid) >= 0);
        if (touches && d <= 13.0) near.push(port);
      }
    }
    return near;
  }

  /**
   * M — your maritime docks.
   *
   *   "Maybe the M opens any maritime port you're on, but if you're on
   *    multiple, it opens the map, and highlights all of your maritime ports and
   *    lets you use the arrow keys to select the port you want quickly and press
   *    enter to open the port."
   *
   * Standing on exactly one goes straight in. Nought or several raises the map
   * in `pick-port` mode, which lights every dock this player owns and hands the
   * arrows to them — see the `pick-port` branch in ui/overview.js.
   */
  function openMaritime() {
    const mine = myPorts();
    if (!mine.length) {
      toast('Settle a corner of a dock to unlock it', 'warn');
      return;
    }
    const under = portsUnderfoot();
    if (under.length === 1) {
      if (game && typeof game.openTrade === 'function') game.openTrade(under[0].id);
      return;
    }
    if (mine.length === 1) {
      if (game && typeof game.openTrade === 'function') game.openTrade(mine[0].id);
      return;
    }
    if (game && typeof game.openOverview === 'function') {
      game.openOverview('pick-port', {
        title: 'Your Docks',
        hint: 'Arrows to choose · Enter to open'
      });
    }
  }

  /* -------------------------------------------------------------- escape */

  function onEscape(ev) {
    // 1. Anything with its own Escape has already claimed the key upstream.
    if (sheetOpen() || helpOpen()) return false;
    /* 2. The board map — a placement, a pause, a port pick. All cancel...
     *
     * ...EXCEPT THE ONES WITH NO WAY OUT ON PURPOSE. The opening draft and a
     * networked board are opened with `cancellable: false`, which hides the
     * panel's own X because there is nothing sensible to go back to: the draft
     * is waiting on this player and the server is waiting on the draft. Escape
     * must not be able to do what the missing button cannot, or a keyboard
     * player can strand their own match on its first pick. */
    if (mapOpen()) {
      const ov = overview();
      if (ov && ov.closable === false) return false;
      if (ev.preventDefault) ev.preventDefault();
      if (hud() && hud().isPaused) hud().togglePause(false);
      else if (game.closeOverview) game.closeOverview();
      return true;
    }
    if (!playing()) return false;
    // 3 & 4. The settings drawer: close it if it is down, open it if it is not.
    const h = hud();
    if (!h || typeof h.toggleSettings !== 'function') return false;
    if (ev.preventDefault) ev.preventDefault();
    h.toggleSettings(!h.settingsOpen);
    return true;
  }

  /* ---------------------------------------------------------------- keys */

  /* HELD IS NOT PRESSED AGAIN.
   *
   * The OS repeats a held key thirty times a second and every one arrives as a
   * fresh `keydown`. `systems/input.js` guards its own movement set with a
   * held-key Set for exactly this reason; nothing here is idempotent, so
   * leaning on V would have bought a development card per repeat until the
   * pack was empty. `ev.repeat` covers a real keyboard and the Set covers a
   * synthesised one (the DevTools protocol does not set the flag). */
  const held = new Set();
  function onKeyUp(ev) { held.delete(ev.code || ev.key); }

  function onKey(ev) {
    if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
    if (isTyping(ev)) return;
    const code = ev.code || ev.key;
    if (ev.repeat || held.has(code)) return;
    held.add(code);

    if (code === 'Escape') {
      if (onEscape(ev)) ev.stopImmediatePropagation();
      return;
    }

    /* SPACE IS PAUSE.
     *
     *   "The space bar pauses and plays the game."
     *
     * It used to set `input.actionPressed`, which nothing has read since
     * gathering became contact-based, so the key was free. Taken in the capture
     * phase so input.js never records it and the settler never twitches. */
    if (code === 'Space') {
      if (busy() && !(hud() && hud().isPaused)) return;
      if (!playing()) return;
      const h = hud();
      if (!h || typeof h.togglePause !== 'function') return;
      if (ev.preventDefault) ev.preventDefault();
      ev.stopImmediatePropagation();
      h.togglePause();
      return;
    }

    if (!playing()) return;
    // Everything below is a letter, and a letter never fires while a sheet,
    // the rules or the map is in front of the player. The map has its own keys.
    if (busy()) return;

    /* A shortcut is an instruction, and every one of them replaces whatever the
       settings drawer was going to be used for. Left open it would sit behind
       the sheet the key just raised and go on owning the arrow keys. */
    if (LETTERS.has(code)) {
      const h = hud();
      if (h && h.settingsOpen && typeof h.closeSettings === 'function') h.closeSettings();
    }

    if (code === 'KeyB') {
      const h = hud();
      if (!h || typeof h.toggleBuild !== 'function') return;
      if (ev.preventDefault) ev.preventDefault();
      ev.stopImmediatePropagation();
      h.toggleBuild();
      return;
    }

    if (code === 'KeyT') {
      if (ev.preventDefault) ev.preventDefault();
      ev.stopImmediatePropagation();
      openTradingPost();
      return;
    }

    if (code === 'KeyM') {
      if (ev.preventDefault) ev.preventDefault();
      ev.stopImmediatePropagation();
      openMaritime();
      return;
    }

    const kind = BUILD_KEYS[code];
    if (kind) {
      if (ev.preventDefault) ev.preventDefault();
      ev.stopImmediatePropagation();
      /* `requestBuild` is the same call the build card makes, so an
         unaffordable key press gets the same "Need 2 brick" toast and the same
         red flash on the card rather than silently doing nothing — which is the
         whole difference between a shortcut and a mystery. It opens the
         placement map itself for the three pieces, and buys the card outright. */
      if (typeof game.requestBuild === 'function') game.requestBuild(kind);
    }
  }

  win.addEventListener('keydown', onKey, true);
  win.addEventListener('keyup', onKeyUp, true);
  // A key held while the tab loses focus never sends its keyup.
  win.addEventListener('blur', () => held.clear());

  return {
    /* Exposed for tools/kbtrace.mjs and for anything that wants to drive a
       shortcut without synthesising a key event. */
    openTradingPost,
    openMaritime,
    destroy() {
      win.removeEventListener('keydown', onKey, true);
      win.removeEventListener('keyup', onKeyUp, true);
      held.clear();
    }
  };
}

export default createHotkeys;
