/**
 * Island Settlers — the Knight card: announcing it, and handing over the board.
 *
 *   createKnightCue(root, state, game) ->
 *     { update(dt), play(), destroy(), pending, open }
 *
 * ---------------------------------------------------------------------------
 * WHY
 * ---------------------------------------------------------------------------
 *   "Make it more clear if I win a knight card, that it happened, and how to
 *    use it. Like show the map overview in full so I can select where I want
 *    it."
 *
 * A Knight used to arrive as a three-word toast that shared the corner with
 * every gather message in the game, and the only way to play it was to guess
 * that the CARDS button held something tappable. Two problems, two fixes:
 *
 *   DISCOVERY  drawing one takes the centre banner ("Knight Card!"), rings the
 *              horn, and leaves a standing gold call-to-action on screen that
 *              says what it does. It does not go away until the Knight is
 *              played, so there is no way to end up holding one without
 *              knowing it.
 *   USE        tapping it (or the card in the hand) opens the FULL BOARD MAP in
 *              Raider mode. overview.js already lights every legal region and
 *              carries a Confirm bar; all this adds is the plain instruction
 *              ("Choose a region to block"), the commit through rules.js, and
 *              the beat afterwards where the map stays up long enough to watch
 *              the Raider land on the hex you picked before it hands the board
 *              back to third-person play.
 *
 * Nothing here mutates the match directly: the placement is committed by
 * `economy.playKnightAt` (or `rules.playKnight` if economy is absent), which is
 * the same call the overview's own default Confirm makes.
 *
 * Owner: UI agent.
 */

import { hasCard, playKnight } from '../core/rules.js';
import { tiles } from '../board/layout.js';
import { el, toggle, setText } from './dom.js';
import { icon } from './icons.js';

const STYLE_ID = 'hud-knight-style';

/* Scoped under .kn-* and injected from here, so ui.css — owned by another
   agent — is never touched. Matches the cream/brown card language. */
const CSS = `
.kn-cue{
  position:absolute;right:var(--gR,18px);bottom:calc(var(--gB,10px) + 92px);
  display:flex;align-items:center;gap:9px;
  padding:7px 13px 8px 9px;border-radius:14px;
  background:linear-gradient(180deg,#fdf5e2 0%,#f6e7c6 44%,#e6d6b2 100%);
  border:2px solid var(--brown,#5a3a1e);
  box-shadow:0 5px 0 rgba(90,58,30,.55),0 10px 20px rgba(0,0,0,.45),
             inset 0 2px 0 rgba(255,255,255,.72);
  cursor:pointer;touch-action:manipulation;text-align:left;
  max-width:min(46vw,270px);
  opacity:0;transform:translateY(12px) scale(.94);
  transition:opacity .28s ease,transform .28s cubic-bezier(.2,1.2,.35,1);
}
.kn-cue.on{opacity:1;transform:none;animation:knPulse 2.1s ease-in-out infinite}
/* The hid class is applied a beat later so the fade-out can run. Until it lands
   the chip is already invisible, so it must also already be untappable — an
   invisible button sitting over the map is worse than no button. */
.kn-cue:not(.on){pointer-events:none}
.kn-cue.hid{display:none}
.kn-cue:active{transform:translateY(3px);box-shadow:0 2px 0 rgba(90,58,30,.55),
  0 6px 12px rgba(0,0,0,.4),inset 0 2px 0 rgba(255,255,255,.72)}
.kn-ico{flex:0 0 auto;display:flex;width:34px;height:34px;border-radius:10px;
  align-items:center;justify-content:center;
  background:linear-gradient(180deg,#ffe79a,#ffc93c);
  border:1.5px solid rgba(90,58,30,.85);
  box-shadow:inset 0 2px 0 rgba(255,255,255,.55)}
.kn-ico svg{width:24px;height:24px}
.kn-txt{display:flex;flex-direction:column;gap:2px;min-width:0}
.kn-txt b{font:800 12px/1 var(--ff);letter-spacing:.10em;text-transform:uppercase;
  color:#3a2208;white-space:nowrap}
.kn-txt span{font:700 9px/1.2 var(--ff);letter-spacing:.06em;text-transform:uppercase;
  color:#7a5228}
.kn-n{position:absolute;top:-7px;left:-7px;min-width:19px;height:19px;padding:0 4px;
  border-radius:10px;display:flex;align-items:center;justify-content:center;
  font:800 11px/1 var(--ff);color:#3a2208;
  background:linear-gradient(180deg,#fff,#ffd76a);
  border:1.5px solid rgba(90,58,30,.9);box-shadow:0 2px 4px rgba(0,0,0,.4)}
.kn-n.hid{display:none}
@keyframes knPulse{
  0%,100%{box-shadow:0 5px 0 rgba(90,58,30,.55),0 10px 20px rgba(0,0,0,.45),
    0 0 0 0 rgba(255,201,60,.55),inset 0 2px 0 rgba(255,255,255,.72)}
  50%{box-shadow:0 5px 0 rgba(90,58,30,.55),0 10px 20px rgba(0,0,0,.45),
    0 0 22px 5px rgba(255,201,60,.5),inset 0 2px 0 rgba(255,255,255,.72)}
}
@media (max-height:400px){
  .kn-cue{padding:5px 10px 6px 7px;gap:7px;bottom:calc(var(--gB,10px) + 84px);
    max-width:min(42vw,224px)}
  .kn-ico{width:29px;height:29px}
  .kn-ico svg{width:20px;height:20px}
  .kn-txt b{font-size:11px}
  .kn-txt span{font-size:8px}
}
`;

/** How long the board stays up after Confirm so the Raider can be seen landing. */
const WATCH_MS = 1150;

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
    get pending() { return 0; }, get open() { return false; }
  };
}

/** "the WHEAT FIELD on 8" — a place a player can point at, not a tile index. */
export function regionName(tileId) {
  const t = tiles[tileId];
  if (!t) return 'that region';
  const kind = String(t.terrain || 'region').toUpperCase();
  return t.number ? `the ${kind} on ${t.number}` : `the ${kind}`;
}

export function createKnightCue(root, state, game) {
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
      class: 'kn-cue hid', type: 'button', 'data-ui': '',
      'aria-label': 'Play your Knight card',
      on: { click: () => play() }
    },
      el('span', { class: 'kn-ico', html: icon('knight', 24) }),
      el('span', { class: 'kn-txt' },
        el('b', { text: 'Knight Ready' }),
        el('span', { text: 'Tap · block a region' })),
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

  const knightsHeld = () => me.cards.reduce((n, c) => n + (c.type === 'knight' ? 1 : 0), 0);

  /* ------------------------------------------------------------ the board */

  let watching = 0;

  function overview() {
    return g.overview && typeof g.overview.open === 'function' ? g.overview : null;
  }

  /**
   * Open the FULL board map in Raider mode. overview.js computes the legal
   * regions (every hex but the one the Raider already sits on) and pulses each
   * of them; we supply the plain instruction and the commit.
   */
  function play() {
    if (state.phase !== 'play') { say('The match is not running', 'warn'); return false; }
    if (!hasCard(me, 'knight')) { say('No Knight in hand', 'warn'); return false; }

    // The cards sheet, if it is what launched this, has to get out of the way
    // before the board comes up over it.
    safe(() => g.panels && g.panels.close && g.panels.close());

    const ov = overview();
    if (!ov) {
      say('The map is unavailable', 'warn');
      return false;
    }

    const opened = safe(() => ov.open('place-robber', {
      title: 'Send the Raider',
      hint: 'Choose a region to block',
      pickLabel: 'Choose a region',
      cancellable: true,
      keepOpen: true,          // stay up long enough to watch the Raider land
      onConfirm: tile => land(tile),
      onCancel() { say('Knight kept in hand', 'info'); }
    }));
    if (opened === false) { say('No region left to block', 'warn'); return false; }
    say('Pick the region to shut down', 'info');
    return true;
  }

  /** Commit through the rules, then hold the board on the result for a beat. */
  function land(tile) {
    const eco = g.economy;
    const ok = eco && typeof eco.playKnightAt === 'function'
      ? eco.playKnightAt(tile)
      : playKnight(state, 0, tile);
    if (!ok) { say('That region cannot be blocked', 'bad'); return false; }

    const where = regionName(tile);
    shout('Raider Sent', '#ffc93c');
    say(`The Raider shuts down ${where}`, 'good');
    safe(() => g.camera && g.camera.shake && g.camera.shake(0.35));
    refresh(true);

    // Re-dress the same open panel as a plain view so the freshly baked board —
    // Raider now sitting on the hex the player chose — is what they look at.
    // `keepOpen` has to be carried over: overview.commit() re-reads `opts`
    // AFTER this callback returns, and without it the panel we just re-dressed
    // would be closed out from under the beat it exists for.
    const ov = overview();
    safe(() => ov && ov.open('view', {
      keepOpen: true,
      title: 'The Raider Lands',
      hint: `Blocking ${where}`
    }));
    watching = WATCH_MS / 1000;
    return true;
  }

  /* --------------------------------------------------------------- display */

  let held = knightsHeld();
  let shown = false;
  let pollT = 0;

  function refresh(force) {
    const n = knightsHeld();
    const playable = state.phase === 'play';
    if (n > held) {
      // A Knight just arrived. This is the moment the player said they missed.
      shout('Knight Card!', '#ffc93c');
      say('Knight — send the Raider onto a rival region', 'good');
      sfx('award');
    }
    held = n;

    const want = n > 0 && playable;
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
    toggle(countEl, 'hid', n < 2);
    if (n >= 2) setText(countEl, String(n));
  }

  function update(dt) {
    const d = Number.isFinite(dt) ? dt : 1 / 60;
    if (watching > 0) {
      watching -= d;
      if (watching <= 0) {
        watching = 0;
        safe(() => g.overview && g.overview.close && g.overview.close());
      }
    }
    pollT += d;
    if (pollT < 0.15) return;
    pollT = 0;
    refresh(false);
  }

  refresh(true);

  return {
    update, play,
    get pending() { return held; },
    get open() { return watching > 0; },
    destroy() {
      if (cue && cue.parentNode) cue.parentNode.removeChild(cue);
    }
  };
}

export default createKnightCue;
