/**
 * Island Settlers — the Road Building card: announcing it, and handing over the
 * board.
 *
 *   createRoadCue(root, state, game) ->
 *     { update(dt), play(), destroy(), pending, autoPending, autoIn }
 *
 * ---------------------------------------------------------------------------
 * WHY
 * ---------------------------------------------------------------------------
 *   "The road building card, when you get one, is still not opening the map
 *    like the knight card does, so it just gets wasted. And nothing happens.
 *    Fix that."
 *
 * That is an exact description of what the code did. A Knight has owned a whole
 * module since the same complaint was made about it: `hud-knight.js` announces
 * the draw on the centre plate, raises a standing gold chip that does not go
 * away until the card is played, and — the part that actually fixed it — RAISES
 * THE BOARD BY ITSELF a beat later. Road Building had none of that. Drawing one
 * emitted a single fading toast reading "open CARDS to lay two roads free", and
 * if the player did not read it inside three seconds, or did not know that the
 * CARDS button held something tappable, the card sat in the hand for the rest of
 * the match doing nothing at all.
 *
 * There was no bug further down. `economy.useRoadBuilding()` plays the card,
 * credits `freeRoads = 2` and opens the placement map; main.js reconciles any
 * outstanding debt every frame. Everything worked the instant somebody called
 * it. NOTHING EVER CALLED IT. So this module is the Knight's twin, pointed at
 * the other card:
 *
 *   DISCOVERY  the draw takes the centre banner ("Road Building!"), rings the
 *              award chime, and raises a standing chip that stays up until the
 *              card is spent.
 *   USE        `AUTO_DELAY` after the card lands, the placement map comes up by
 *              itself with every legal edge lit and both roads already paid for.
 *
 * It is never a trap. The card is NOT spent until the map actually opens —
 * `economy.useRoadBuilding` asks `roadRoom` first and keeps the card if there is
 * nowhere legal to build — and cancelling out of the map keeps whatever roads
 * are still owed (economy.js defers rather than forfeits), with the chip still
 * on screen. The raise also waits politely for anything else that owns the
 * screen: a trade sheet, another placement map, the opening countdown, the
 * tutorial, or a Knight in the middle of its own raise.
 *
 * A RIVAL'S card can never reach any of this: the trigger is the human's own
 * hand growing a Road Building card, and `me` is `state.players[0]`. Bots
 * resolve theirs inside bots.js without ever touching this module.
 *
 * Styling rides the `.kn-*` classes injected by `hud-knight.js`, so the two
 * chips are the same object in two colours; the only thing added here is the
 * stacking offset that keeps them off each other when a player holds both.
 *
 * Owner: UI agent.
 */

import { hasCard, playRoadBuilding } from '../core/rules.js';
import { el, toggle, setText } from './dom.js';
import { icon } from './icons.js';

const STYLE_ID = 'hud-road-style';

/* The chip itself is `.kn-cue` from hud-knight.js. All this adds is where it
   sits: one chip-height above the Knight's slot, so holding both cards shows
   both calls to action rather than one on top of the other. */
const CSS = `
.rb-cue{bottom:calc(var(--gB,10px) + 92px + 58px)}
.rb-cue .kn-ico{background:linear-gradient(180deg,#ffe7c0,#e8a24a)}
@media (max-height:400px){
  .rb-cue{bottom:calc(var(--gB,10px) + 84px + 50px)}
}
`;

/**
 * Seconds between the card landing in the hand and the board raising itself.
 * Matches the Knight exactly: the centre plate holds for about a second, so
 * this lets it be read and then changes the screen while it is still being
 * looked at.
 */
const AUTO_DELAY = 1.05;

/** How long the raise keeps trying if something else owns the screen. */
const AUTO_PATIENCE = 25;

function injectStyle(doc) {
  if (!doc || !doc.head || !doc.createElement) return;
  if (doc.getElementById && doc.getElementById(STYLE_ID)) return;
  const s = doc.createElement('style');
  s.id = STYLE_ID;
  s.textContent = CSS;
  doc.head.appendChild(s);
}

const NOOP = () => {};

function stub() {
  return {
    update: NOOP, play: () => false, destroy: NOOP,
    get pending() { return 0; },
    get autoPending() { return false; }, get autoIn() { return -1; }
  };
}

export function createRoadCue(root, state, game) {
  const doc = (root && root.ownerDocument)
    || (typeof document !== 'undefined' ? document : null);
  if (!doc || !doc.createElement || !root || !root.appendChild) return stub();

  const me = state.players[0];
  const g = game || {};

  let cue, countEl;
  try {
    injectStyle(doc);
    countEl = el('i', { class: 'kn-n hid', text: '1' });
    cue = el('button', {
      class: 'kn-cue rb-cue hid', type: 'button', 'data-ui': '',
      'aria-label': 'Play your Road Building card',
      on: { click: () => play() }
    },
      el('span', { class: 'kn-ico', html: icon('road', 24) }),
      el('span', { class: 'kn-txt' },
        el('b', { text: 'Free Roads' }),
        el('span', { text: 'Tap · lay two roads' })),
      countEl);
    root.appendChild(cue);
  } catch (e) {
    if (cue && cue.parentNode) cue.parentNode.removeChild(cue);
    return stub();
  }

  /* ------------------------------------------------------------- utilities */

  const safe = fn => { try { return fn(); } catch (e) { return undefined; } };
  const say = (msg, kind) => safe(() => g.hud && g.hud.toast && g.hud.toast(msg, kind))
    ?? safe(() => g.toast && g.toast(msg, kind));
  const shout = (msg, color) => safe(() => g.hud && g.hud.announce && g.hud.announce(msg, color));
  const sfx = name => safe(() => g.audio && g.audio.sfx && g.audio.sfx(name));

  const cardsHeld = () =>
    me.cards.reduce((n, c) => n + (c.type === 'roadBuilding' ? 1 : 0), 0);
  const owed = () => Math.max(0, me.freeRoads | 0);

  /* ------------------------------------------------------------ the board */

  let autoWant = false;
  let autoT = 0;
  let autoLeft = 0;
  let autoFired = false;

  /** True while the flow is running ordinary third-person play. */
  function flowIsPlaying() {
    const f = g.flow;
    if (!f) return true;
    if (f.isWinSequence) return false;
    if (f.counting) return false;
    return f.stage === undefined || f.stage === 'play';
  }

  /**
   * May the board raise ITSELF right now? Everything here is "is somebody else
   * using the screen", never "is the card legal" — that is `play()`'s job.
   */
  function canAutoRaise() {
    if (!autoWant) return false;
    if (state.phase !== 'play') return false;
    if (!hasCard(me, 'roadBuilding')) return false;
    if (!flowIsPlaying()) return false;
    const ov = g.overview;
    if (!ov || ov.isOpen) return false;                 // a map is already up
    if (g.panels && g.panels.isOpen) return false;      // trade / cards / score
    // Roads already owed from an earlier play are re-offered by main.js on the
    // very next frame; spending a second card into that is how a player ends up
    // owing four roads with one map. Wait for the debt to clear.
    if (owed() > 0) return false;
    // And yield to a Knight that is mid-raise, for the same reason its own
    // gate yields to us: two maps fighting is worse than a short wait.
    const kn = g.knightCue;
    if (kn && kn.autoPending) return false;
    const tut = g.tutorial;
    if (tut && tut.running) return false;
    return true;
  }

  function disarmAuto() {
    autoWant = false;
    autoT = 0;
    autoLeft = 0;
  }

  /**
   * Play the card and go straight to placement.
   *
   * `economy.useRoadBuilding` is the whole path: it refuses (and KEEPS the card)
   * if there is nowhere legal to lay a road, otherwise it spends the card,
   * credits two free roads and opens the map on the first of them. The fallback
   * below only runs if economy.js failed to attach, and leans on the same
   * per-frame reconciler in main.js to raise the map.
   */
  function play(auto) {
    if (state.phase !== 'play') {
      if (!auto) say('The match is not running', 'warn');
      return false;
    }
    if (!hasCard(me, 'roadBuilding')) {
      if (!auto) say('No Road Building card in hand', 'warn');
      return false;
    }

    // The cards sheet, if it is what launched this, has to get out of the way
    // before the board comes up over it.
    safe(() => g.panels && g.panels.close && g.panels.close());

    const eco = g.economy;
    let ok;
    if (eco && typeof eco.useRoadBuilding === 'function') {
      ok = safe(() => eco.useRoadBuilding()) === true;
    } else {
      ok = playRoadBuilding(state, 0) === true;
      // Nothing else to do: main.js sees `freeRoads > 0` next frame and offers
      // the placement map itself.
    }
    if (!ok) {
      // useRoadBuilding has already said why, and the card is still in hand.
      // Stand down for this draw; the chip stays up and a tap will retry.
      disarmAuto();
      return false;
    }

    if (auto) {
      shout('Two Free Roads', '#ffc93c');
      say('The map is open — place both roads, nothing is paid', 'info');
    }
    disarmAuto();
    autoFired = !!auto;
    sfx('card');
    return true;
  }

  /* --------------------------------------------------------------- display */

  let held = cardsHeld();
  let shown = false;
  let pollT = 0;

  function refresh(force) {
    const n = cardsHeld();
    const playable = state.phase === 'play';
    if (n > held) {
      // The card just arrived. This is the moment that used to pass in silence.
      shout('Road Building!', '#ffc93c');
      say('Road Building — the map is about to open, lay two roads free', 'good');
      sfx('award');
      autoWant = true;
      autoT = AUTO_DELAY;
      autoLeft = AUTO_PATIENCE;
    }
    held = n;
    if (!n) disarmAuto();

    // The chip stands for "you have something to spend", which is true both of
    // an unplayed card and of a road still owed after a cancelled placement.
    const total = n + owed();
    const want = total > 0 && playable;
    if (want !== shown || force) {
      shown = want;
      if (want) {
        toggle(cue, 'hid', false);
        setTimeout(() => toggle(cue, 'on', shown), 16);
      } else {
        toggle(cue, 'on', false);
        setTimeout(() => toggle(cue, 'hid', !shown), 260);
      }
    }
    setText(cue.querySelector('.kn-txt b'),
      n > 0 ? 'Free Roads' : (owed() > 1 ? 'Roads Owed' : 'Road Owed'));
    toggle(countEl, 'hid', total < 2);
    if (total >= 2) setText(countEl, String(total));
  }

  function update(dt) {
    const d = Number.isFinite(dt) ? dt : 1 / 60;
    pollT += d;
    if (pollT < 0.15) return;
    const step = pollT;
    pollT = 0;
    refresh(false);

    if (!autoWant) return;
    if (autoT > 0) { autoT -= step; return; }
    autoLeft -= step;
    if (autoLeft <= 0) { disarmAuto(); return; }
    if (canAutoRaise()) play(true);
  }

  refresh(true);
  // A card already in hand at construction (a restored match) is the player's
  // business, not a surprise: no auto-raise, just the chip.
  disarmAuto();

  return {
    update, play,
    get pending() { return held; },
    /** True while a drawn card is still waiting to raise the board itself. */
    get autoPending() { return autoWant; },
    /** Seconds until the raise, -1 when none is armed. Capture-rig hook. */
    get autoIn() { return autoWant ? Math.max(0, autoT) : -1; },
    /** True when the board on screen was raised by the card, not by a tap. */
    get autoRaised() { return autoFired; },
    destroy() {
      if (cue && cue.parentNode) cue.parentNode.removeChild(cue);
    }
  };
}

export default createRoadCue;
