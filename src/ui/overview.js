/**
 * Island Settlers — board overview.
 *
 *   createOverview(root, state, game) ->
 *     { open(mode, opts), close(), update(dt), isOpen }
 *
 * A painted 2D board map over the 3D scene. Far easier to read on a phone
 * than an orbit camera, and it doubles as the placement interface: every
 * legal target pulses, one tap arms it (also driving the 3D ghost), and a
 * second tap on the same target commits it through rules.js.
 *
 * Modes: 'view' | 'place-road' | 'place-settlement' | 'place-city'
 *      | 'place-robber' | 'draft-watch'
 *
 * ---------------------------------------------------------------------------
 * THE BUILD SHEET
 * ---------------------------------------------------------------------------
 * In ordinary play the three build modes are not a modal question any more,
 * they are a SHEET you stand in until you are done:
 *
 *   "If I want to build multiple roads, I shouldn't be stuck having to build
 *    one, then it closes then I click to open again, and click to build
 *    another. ... if I have enough resources for multiple, it stays open and
 *    updates when I place a road to show me the other available road placements
 *    I can do, until there are no more. But obviously I can press x at any
 *    time."
 *
 * Which is five behaviours, and each has one owner in this file:
 *
 *   ARM        one tap on a legal target -> `select()`, plus a line along the
 *              top saying what the next tap does.
 *   COMMIT     a second tap on the same target -> `commit()`. There is no
 *              Confirm button and no Cancel button any more.
 *   DISARM     a tap on anything that is not a target -> `select(null)`, and
 *              the sheet stays exactly where it was.
 *   STAY       `commit()` ends in `rearm()`, which re-reads the counts and the
 *              legal spots and keeps the panel up while another one is
 *              affordable — and closes it when it is not.
 *   SWITCH     four affordability chips along the foot (`createBuyBar` in
 *              hud-build.js) say how many roads / settlements / cities / cards
 *              you could buy right now, grey out at nought, and re-point the
 *              map at another piece when tapped.
 *
 * The draft, the Knight and the plain map are NOT build sheets — see
 * `buildKind()` — so they keep the old one-and-done behaviour and get the whole
 * panel for the board.
 *
 * `draft-watch` is the opening draft's spectator state: the same board, the
 * same framing, no targets and no foot. It exists so the snake draft
 * can be *one* uninterrupted view — matchflow.js reconfigures this panel in
 * place between every pick instead of closing and reopening it, which is what
 * used to snap the 3D camera back to third-person between a player's
 * settlement and their road. `open()` is therefore idempotent: called while
 * already open it re-dresses the panel and never touches the visibility
 * classes.
 *
 * All hex geometry comes from board/layout.js — nothing is re-derived here.
 * World (x, z) maps to canvas (x, y) with a single uniform scale, so the
 * pointy-top hexes stay pointy-top.
 *
 * The board also MOVES: `ovpan.js` owns drag / pinch / wheel / +- and writes
 * straight into `proj`, so the coast that lives under the title plate or the
 * player rail can be pulled into the open. Clamped so the middle of the island
 * can never leave the middle three quarters of the frame, and reset on a fresh
 * open so a placement mode always starts on the whole board.
 *
 * Painting lives in two siblings: ./ovmap.js draws the BOARD (sea, island,
 * tokens, docks, everybody's pieces) and ./ovtargets.js draws the PLACEMENT
 * LAYER over it (the corner rings you may claim, the road slabs you may build
 * along, the Knight marks, the confirm preview and the rival telegraph). This
 * file decides what is legal and what the finger touched; those two decide what
 * it looks like.
 *
 * Nothing writes text onto the hexes: the board
 * carries the terrain, the number tokens, the docks, everybody's pieces and a
 * single gold pin for where you are standing. Who the other settlers are, what
 * colour they play and how they are doing is the right-hand rail's job.
 *
 * Owner: UI agent.
 */

import { HEX_SIZE, TRADE_BASE, RES_LABEL } from '../core/constants.js';
import { tiles, intersections, edges, ports, BOUNDS } from '../board/layout.js';
import {
  legalRoads, legalSettlements, legalCities,
  placeRoad, placeSettlement, upgradeCity, playKnight, scoreOf
} from '../core/rules.js';
import { el, button, toggle, setText, clamp, onTap } from './dom.js';
import { icon, avatar, personPip } from './icons.js';
import { createPainter, pipRadius, dockOverhang } from './ovmap.js';
import { createTargets } from './ovtargets.js';
import { createOvPan } from './ovpan.js';
import { createMapKeys } from './ovkeys.js';
import { createBuyBar, buyCount } from './hud-build.js';
import { BUILD_KINDS } from './hud-guide.js';
import { netCommit } from '../systems/economy.js';

/* Every placement hint names the double-tap, because a route nobody is told
   about is a route nobody uses — see `onTap` below. */
const MODE_INFO = {
  'view':              { title: 'Island Map', hint: 'Drag the board · pinch to zoom' },
  'place-road':        { title: 'Place a Road', hint: 'Tap a glowing edge · tap it again to place' },
  'place-settlement':  { title: 'Place a Settlement', hint: 'Tap a glowing corner · tap it again to place' },
  'place-city':        { title: 'Upgrade to a City', hint: 'Tap one of your settlements · tap it again to upgrade' },
  'place-robber':      { title: 'Send the Knight', hint: 'Tap a region · tap it again to send' },
  /* The M key's overflow. Not a placement: nothing is built, and the "commit"
     is opening that dock's trade sheet. It borrows the whole target machine —
     arm, re-tap, arrow keys — because a dock and a corner are the same gesture
     from the player's side. See `openMaritime` in ui/hotkeys.js. */
  'pick-port':         { title: 'Your Docks', hint: 'Tap a dock · tap it again to trade' },
  'draft-watch':       { title: 'Opening Draft', hint: 'Watch the board' }
};

/*
 * THE LINE ALONG THE TOP, AND WHY IT IS THE ONLY WORDS LEFT ON THIS PANEL.
 *
 *   "I'd also like for the cancel and confirm buttons to actually be removed
 *    since the other logic is there already — maybe just add a small 'Click
 *    again to confirm' at the top of the screen when pending so that I have
 *    more visual space to work with on the bottom of the map here."
 *
 * `ARM_SAY` is that line: it exists only while a target is armed, it sits in
 * the top strip nobody is aiming at (the close key is in the top LEFT corner,
 * the zoom pad is on the left edge, the pip strip on the right), and it names
 * the verb of the mode it is in rather than saying "confirm" — you are not
 * confirming a form, you are building a road.
 *
 * `IDLE_SAY` is the same plate with nothing armed, and it is the standing
 * answer to a separate report:
 *
 *   "Let them know they can tap twice to build a road, instead of having to
 *    press confirm."
 *
 * The route existed and nothing on screen ever mentioned it: the sentence lived
 * in `MODE_INFO.hint`, which has been screen-reader-only since the title plate
 * came off the top of the board.
 *
 * IT USED TO TIME OUT AFTER 3.6 SECONDS AND IT NO LONGER DOES — on a build
 * sheet. A review of the first pass photographed four states and found the line
 * in one of them:
 *
 *   "Keep the hint pill present in EVERY open, non-pending state. It is missing
 *    in build-cancelled, build-stayed and build-switch, yet present in the
 *    state-identical build-open."
 *
 * Which is the right complaint and it cost nothing to be wrong about: those
 * three frames are the same sheet, nothing armed, waiting for the same tap, and
 * the only difference is how many seconds of wall clock had gone by. A caption
 * that is true for as long as the panel is up should be up for as long as the
 * panel is. The reason it was made to fade — that a permanent caption is what
 * the confirm bar was deleted for being — is answered instead by giving it
 * ROOM: `measure()` now reserves the line's height out of the board fit, so it
 * stands over the panel's own top strip and not over the island (see the
 * `padT` note there).
 *
 * The timeout survives for the panels that are NOT build sheets — a draft pick,
 * a Knight's region — because those close themselves after one commit and a
 * caption on a screen you are about to leave is furniture.
 *
 * `BUILT_SAY` is the fourth state, and it exists because of this:
 *
 *   "Add a positive build confirmation. The only feedback in build-stayed is
 *    one 10px digit changing 3 to 2 inside a 52x38 chip."
 *
 * It says what landed and what is left, holds for `BUILT_SAY_SEC`, and drops
 * back to the idle line — so the sheet always ends up saying the same thing it
 * says at rest.
 */
const ARM_SAY = {
  'place-road':       'Tap again to build',
  'place-settlement': 'Tap again to build',
  'place-city':       'Tap again to upgrade',
  'place-robber':     'Tap again to send',
  'pick-port':        'Tap again to trade here'
};
const IDLE_SAY = {
  'place-road':       'Tap an edge, then tap it again',
  'place-settlement': 'Tap a corner, then tap it again',
  'place-city':       'Tap a settlement, then tap it again',
  'place-robber':     'Tap a region, then tap it again',
  'pick-port':        'Pick one of your docks'
};
/** What a build sheet says for a beat after a piece goes down. */
const BUILT_NOUN = { road: 'road', settlement: 'settlement', city: 'city' };
/** Seconds the opening line stays up on a panel that is NOT a build sheet. */
const OPEN_SAY_SEC = 3.6;
/** Seconds the "built" line holds before the idle line comes back. */
const BUILT_SAY_SEC = 2.2;

/* The draft rail lives here rather than in ui.css. Scoped under `.ov`. */
const DRAFT_STYLE_ID = 'ov-draft-style';
const DRAFT_CSS = `
/* The draft narration lives in this plate, and the board's height is measured
   off its bottom edge — so a headline that wraps to two lines shrinks the map.
   Both lines are capped and clipped to one line each. */
/* Read by a screen reader, never painted. See the .ov-say note in overview.js
   for why the plate these two used to live in is gone. */
.ov .ov-say{position:absolute;width:1px;height:1px;overflow:hidden;
  clip-path:inset(50%);white-space:nowrap;pointer-events:none}
.ov .ov-dhead{font:800 8.5px/1 var(--ff);letter-spacing:.22em;text-transform:uppercase;
  color:rgba(255,231,154,.86);text-align:center;padding:1px 0 3px}
.ov .ov-dsub{font:800 10.5px/1.15 var(--ff);letter-spacing:.09em;text-transform:uppercase;
  color:#fff;text-align:center;padding-bottom:5px;text-shadow:0 1px 2px rgba(0,0,0,.65)}
.ov .ov-dr{position:relative;display:flex;align-items:center;gap:6px;
  padding:5px 6px 5px 11px;border-radius:10px;overflow:hidden;
  background:linear-gradient(90deg,var(--ct,rgba(59,127,212,.34)),rgba(255,255,255,.03) 66%),
             linear-gradient(180deg,rgba(255,255,255,.08),rgba(255,255,255,.02));
  box-shadow:inset 0 1px 0 rgba(255,255,255,.14),0 1px 2px rgba(0,0,0,.3);
  opacity:.55;transition:opacity .2s ease,box-shadow .2s ease,transform .2s ease}
.ov .ov-dr::before{content:'';position:absolute;left:0;top:0;bottom:0;width:6px;
  background:linear-gradient(180deg,var(--cl,#93cbff),var(--c,#2f8ffb) 55%);
  box-shadow:inset -1px 0 0 rgba(0,0,0,.45)}
.ov .ov-dr.done{opacity:.8}
.ov .ov-dr.you{opacity:.8;box-shadow:inset 0 0 0 1.5px rgba(255,201,60,.55),0 1px 2px rgba(0,0,0,.3)}
.ov .ov-dr.now{opacity:1;transform:translateX(3px);
  box-shadow:inset 0 0 0 2px var(--gold,#ffc93c),0 0 14px rgba(255,201,60,.42)}
.ov .ov-dn{flex:1 1 auto;min-width:0;font:800 11.5px/1 var(--ff);color:#fff;
  letter-spacing:.05em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  text-shadow:0 1px 2px rgba(0,0,0,.6)}
.ov .ov-dr.you .ov-dn{color:var(--gold-l,#ffe79a)}
.ov .ov-dp{display:flex;gap:3px;flex:0 0 auto}
.ov .ov-dp b{width:15px;height:15px;border-radius:5px;display:flex;
  align-items:center;justify-content:center;
  font:800 8.5px/1 var(--ff);color:rgba(226,238,250,.6);
  background:rgba(0,0,0,.34);box-shadow:inset 0 0 0 1px rgba(255,255,255,.13)}
.ov .ov-dp b.done{color:#08182c;
  background:linear-gradient(180deg,var(--cl,#93cbff),var(--c,#2f8ffb));
  box-shadow:inset 0 1px 0 rgba(255,255,255,.4)}
.ov .ov-dp b.now{color:#3a2208;background:linear-gradient(180deg,#ffe79a,#ffc93c);
  box-shadow:0 0 0 2px rgba(255,201,60,.6);animation:ovNow 1.1s ease-in-out infinite}
@keyframes ovNow{0%,100%{box-shadow:0 0 0 2px rgba(255,201,60,.6)}
  50%{box-shadow:0 0 0 3px rgba(255,201,60,1),0 0 12px rgba(255,201,60,.8)}}
.ov .ov-dtag{flex:0 0 auto;font:800 7.5px/1 var(--ff);letter-spacing:.14em;
  text-transform:uppercase;color:#3a2208;padding:3px 5px 4px;border-radius:6px;
  background:linear-gradient(180deg,#ffe79a,#ffc93c)}

/* ---------------------------------------------------------- the pip strip
 *
 *   "On the draft, hide the draft order popup on the right side of the screen
 *    so the game can be full screen. Maybe just show the little icons shaped
 *    like users, and each is the colour of the other user, and it's within the
 *    normal box where the map is, so those icons highlight in order to show
 *    you whose turn it is for picking places. Then you can have a button that
 *    opens or closes the full pick order popup if users want, but it defaults
 *    to closed. Same goes for the players box on the standard map view."
 *
 * The rail was 186px of a 667px-wide phone — better than a quarter of the map,
 * standing there to say four names. The strip is the same information at the
 * size the answer actually needs: one coloured person per seat, in draft
 * order, and the one that is lit is the one picking. It rides INSIDE the title
 * plate, so it is inside the map box the player named, and so the board's top
 * padding — measured off that plate's bottom edge — already accounts for it
 * without a second measurement.
 *
 * The rail is still one tap away and still says everything it always did.
 */
/* A column against the right edge, vertically centred: one pip per seat and
   the key that opens the rail. Off the board, out of the way, and the only
   thing between the player and the whole island. */
.ov .ov-strip{position:absolute;right:var(--gRn);top:50%;
  transform:translateY(-50%);z-index:6;
  display:flex;flex-direction:column;align-items:center;gap:6px;
  padding:6px 5px;border-radius:13px;
  background:linear-gradient(180deg,rgba(14,36,64,.86),rgba(6,18,36,.9));
  border:1.5px solid rgba(255,201,60,.26);
  box-shadow:0 4px 14px rgba(0,0,0,.45)}
.ov .ov-strip.hid{display:none}
.ov .ov-pips{display:flex;flex-direction:column;align-items:center;gap:5px}
.ov .ov-pip{position:relative;display:flex;flex-direction:column;align-items:center;
  gap:1px;padding:3px 4px;border-radius:9px;line-height:0;
  background:rgba(0,0,0,.28);box-shadow:inset 0 0 0 1px rgba(255,255,255,.1);
  opacity:.5;transition:opacity .18s ease,box-shadow .18s ease,transform .18s ease}
.ov .ov-pip.done{opacity:.78}
.ov .ov-pip.me{opacity:.8;box-shadow:inset 0 0 0 1.5px rgba(255,201,60,.6)}
/* Whose turn it is, and the whole point of the strip. Same gold pulse the rail
   pips use, so the two readings of the draft never disagree. */
.ov .ov-pip.now{opacity:1;transform:scale(1.06);
  background:rgba(255,201,60,.2);
  animation:ovNow 1.1s ease-in-out infinite}
.ov .ov-pip b{font:800 9px/1 var(--ff);color:#eaf2fb;
  text-shadow:0 1px 2px rgba(0,0,0,.7)}
.ov .ov-pip.me b{color:var(--gold-l,#ffe79a)}
.ov .ov-pip svg{display:block}
/* The way back to the full list. Deliberately quiet — it is an option, not an
   instruction — and it goes gold while the rail is up so the key doubles as
   the answer to "what is that panel and how do I get rid of it". */
.ov .ov-rk{min-width:26px;min-height:26px;width:26px;height:26px;padding:0;
  border-radius:8px;border:1.5px solid rgba(255,201,60,.34);
  background:linear-gradient(180deg,rgba(20,48,84,.94),rgba(7,22,44,.94));
  box-shadow:0 2px 6px rgba(0,0,0,.45);line-height:0}
.ov .ov-rk:active{transform:translateY(2px);box-shadow:0 1px 3px rgba(0,0,0,.45)}
.ov .ov-rk.on{border-color:rgba(255,201,60,.9);
  background:linear-gradient(180deg,rgba(255,201,60,.28),rgba(120,80,10,.5))}
.ov .ov-rk svg{display:block}
@media (max-height:500px),(max-width:1023px){
  .ov .ov-dr{padding:4px 5px 4px 10px}
  .ov .ov-dn{font-size:10.5px}
  .ov .ov-dp b{width:13px;height:13px;font-size:8px}
  .ov .ov-strip{gap:5px;padding:5px 4px}
  .ov .ov-pip{padding:2px 3px}
}
`;

/* Three stacked lines: "the list". */
const LIST_GLYPH =
  '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">' +
  '<path d="M5 7h14M5 12h14M5 17h14" fill="none" stroke="#ffe0a0" stroke-width="2.2" ' +
  'stroke-linecap="round"/></svg>';

function injectDraftStyle(doc) {
  if (!doc || !doc.head || !doc.createElement) return;
  if (doc.getElementById && doc.getElementById(DRAFT_STYLE_ID)) return;
  const s = doc.createElement('style');
  s.id = DRAFT_STYLE_ID;
  s.textContent = DRAFT_CSS;
  doc.head.appendChild(s);
}

/**
 * The build sheet's stylesheet, `./ui-build.css`.
 *
 * The other six sheets are registered by an `@import` block at the top of
 * ui.css, and one line there would have been the tidy answer — but ui.css is
 * being rewritten by another pair of hands this week and is off limits, so the
 * sheet is registered by the `<link>` in index.html beside ui.css instead.
 *
 * This function is the belt to that braces, and it is here rather than in
 * index.html's markup because a module that needs a stylesheet to be legible at
 * all should not be silently unstyled if a merge drops one line of HTML: it
 * adds the link ONLY when nothing is already serving it, and resolves the path
 * off `import.meta.url` so it is correct under the project subpath the game is
 * served from on Pages as well as from the root.
 */
const BUILD_CSS_ID = 'ui-build-css';
function injectBuildStyle(doc) {
  if (!doc || !doc.head || !doc.createElement) return;
  if (doc.getElementById && doc.getElementById(BUILD_CSS_ID)) return;
  try {
    const href = new URL('./ui-build.css', import.meta.url).href;
    const links = doc.querySelectorAll ? doc.querySelectorAll('link[rel="stylesheet"]') : [];
    for (const l of links) {
      if (l.href === href || /ui-build\.css(\?|$)/.test(l.getAttribute('href') || '')) return;
    }
    const link = doc.createElement('link');
    link.id = BUILD_CSS_ID;
    link.rel = 'stylesheet';
    link.href = href;
    doc.head.appendChild(link);
  } catch (e) { /* a document without URL support is a document without a map */ }
}

const ORDINAL = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th'];

export function createOverview(root, state, game) {
  injectDraftStyle(root && root.ownerDocument ? root.ownerDocument : document);
  injectBuildStyle(root && root.ownerDocument ? root.ownerDocument : document);

  /* ------------------------------------------------------------- scaffold */
  const cv = el('canvas', { class: 'ov-cv' });
  const titleEl = el('span', { class: 'ov-title', text: 'Island Map' });
  const hintEl = el('span', { class: 'ov-hint', text: '' });

  const closeBtn = button('cbtn small ghost ov-x', {
    'aria-label': 'Close map', on: { click: () => cancel() }
  }, el('span', { class: 'cb-ico', html: icon('close', 18) }));

  /* THE PANEL SAYS IT IS A PAUSE.
   *
   *   "make it a bit more clear that the game is paused when the map/paused
   *    popup is visible."
   *
   * The match has always stopped while this panel is up — main.js gates the
   * clock, the bots, the gathering and the settler on `isOpen`, and the PAUSE
   * key is only a label on that mechanism. What was missing was anything that
   * SAID so: `titleEl` has carried the word "Paused" since the plate across the
   * top of the board was removed, but it is off-screen furniture for a screen
   * reader. Raised by `opts.paused`, so a placement map or a draft — which stop
   * the match just as hard but are not a pause — do not claim to be one. */
  const pausedChip = el('div', { class: 'ov-paused hid' },
    el('i', {}), el('b', { text: 'Paused' }),
    el('span', { text: 'Nothing moves' }));

  const rail = el('div', { class: 'ov-rail plate lift' });

  /* The strip that replaces the rail on a phone, and the key that brings the
     rail back. They live in their own column against the right edge — see the
     .ov-strip note in DRAFT_CSS for why they are no longer over the board. */
  const pips = el('div', { class: 'ov-pips' });
  const railKey = button('ov-rk', {
    'aria-label': 'Show the player list',
    on: { click: () => setRail(!railOpen) }
  }, el('span', { html: LIST_GLYPH }));
  /* THE STRIP LIVES ON THE RIGHT EDGE, NOT OVER THE BOARD.
   *
   *   "I don't like that the sections on the top and bottom of the screen are
   *    covering valuable real estate of where I want to see visually the map.
   *    Can we move them... can the top and bottom middle boxes be somewhere
   *    else, like both minimal on the right side of the screen, but opens into
   *    a full sidebar with the expand button. I definitely don't need the
   *    boxes and the sidebar ever visible at the same time though, it's
   *    redundant."
   *
   * So: a narrow column against the right edge holding one coloured pip per
   * seat and the key that opens the rail — and the moment the rail is open the
   * column hides, because the rail says everything the pips do and more. Two
   * states, never both.
   *
   * The title plate that used to sit across the top centre is gone with it.
   * The board's top padding was measured off that plate's bottom edge, so
   * removing it is also most of "the map can start more zoomed in": there is
   * simply more frame now. */
  const strip = el('div', { class: 'ov-strip' }, pips, railKey);

  /* NO CANCEL BUTTON, NO CONFIRM BUTTON, NO RUNNING LABEL.
   *
   *   "I'd also like for the cancel and confirm buttons to actually be removed
   *    since the other logic is there already."
   *
   * They are removed, not hidden. What each of the three was for:
   *
   *   CONFIRM  is the second tap on the target itself, which has been the real
   *            route since the double-tap landed, and is now the ONLY route.
   *            `commit()` is unchanged and is still what a rig calls.
   *   CANCEL   is the close key in the corner ("but obviously I can press x at
   *            any time"), and — for a target chosen by mistake rather than a
   *            sheet opened by mistake — a tap on any empty water. See `onTap`.
   *   THE LABEL named the corner under the finger, in a panel where the corner
   *            under the finger is drawn at four times the size of the words.
   *
   * The foot of the board is now the affordability bar, which is the one thing
   * this panel could not say any other way.
   */
  const buyBar = createBuyBar(state, game, { onPick: kind => pickKind(kind) });
  const buyRow = buyBar.node;

  /* The armed / opening line. It is NOT tappable and must not be: it floats
     over the top of the board, and `#ui [data-ui] *{pointer-events:auto}` makes
     every descendant of the panel take touches unless it says otherwise, so a
     player aiming at a corner underneath it would hit a caption instead. The
     `pointer-events:none` that prevents that is in ui-build.css. */
  const sayTxt = el('b', { class: 'ovb-say-t', text: '' });
  const sayEl = el('div', { class: 'ovb-say plate hid' }, sayTxt);

  /* ONE BUTTON, WHEN THE PANEL IS NOT ASKING A QUESTION.
   *
   *   "Instead of still having me watch the draft happen I should just
   *    automatically see all of the locations that were chosen on the map
   *    overview, and just press start game as another button on the map screen
   *    once I've reviewed the board — giving me time to create my own plan of
   *    attack once the game starts."
   *
   * A placement sheet's foot carries the affordability chips, because the
   * question it is asking is "what else can I build". A review screen is not
   * asking anything; it has one thing to do. `opts.action` puts that one thing
   * here and stands the chips down for as long as it is up. */
  const actionBtn = button('green big ov-act', { on: { click: () => fireAction() } },
    el('span', { class: 'sb-lab', text: 'Start' }));
  /* IT GETS ITS OWN CONTAINER RATHER THAN SHARING THE OLD BAR.
   *
   * Every capture rig and trace tool in tools/ commits a placement with the
   * same two lines: find `.ov-bar .btn.green`, click it if it is there, and
   * fall back to `overview.commit()` if it is not. That fallback is what keeps
   * them working now that Confirm is gone — but only if the selector really
   * finds nothing. Leaving this green button inside the same bar would have it
   * matched instead, hidden or not, and clicked with no action attached: every
   * scripted placement in the test suite would silently stop placing anything.
   * A separate element is the difference between "no confirm button" and "a
   * confirm button that does nothing". */
  const actBar = el('div', { class: 'ov-actbar plate lift hid' }, actionBtn);

  /* ------------------------------------------------------ what a dock means
   *
   *   "If I click on the 2:1 or 3:1 in the map or the draft or anywhere for the
   *    ports, that it should have a popup that explains in better detail what
   *    that means."
   *
   * The signs are the densest thing on this board: `2:1` with a wheat dot is a
   * whole rule written in four characters, and until now the only place it was
   * spelled out was one line in the rules book, which is not where anybody is
   * standing when they wonder. So the sign became pressable, and it says the
   * one thing the number cannot: what it is a discount ON, and what it costs to
   * own it.
   *
   * Not in the 3D world — down there the dock IS the trade screen and tapping
   * it should open the post, which it already does. This is the map and the
   * draft, where the sign is information rather than a control. */
  const popTitle = el('b', { class: 'ovp-t', text: '' });
  const popRate = el('span', { class: 'ovp-rate', text: '' });
  const popBody = el('span', { class: 'ovp-b', text: '' });
  const popX = button('cream ovp-x', {
    'aria-label': 'Close', on: { click: () => showPortPop(null) }
  }, el('span', { class: 'sb-lab', text: 'OK' }));
  const portPop = el('div', { class: 'ov-portpop plate lift hid', 'data-ui': '' },
    el('div', { class: 'ovp-head' }, popTitle, popRate), popBody, popX);

  /**
   * Which harbour sign — or the market's own rate board — is under this point?
   * Both come from the painter's own rect functions, so the tap zone is the
   * plate that was actually drawn rather than a second guess at where it went.
   */
  function signAt(px, py) {
    if (!paint) return null;
    const rects = paint.portRects ? paint.portRects() : [];
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      if (Math.abs(px - r.x) <= r.w / 2 && Math.abs(py - r.y) <= r.h / 2) {
        return { kind: 'port', port: ports[i] };
      }
    }
    const m = paint.marketRect ? paint.marketRect() : null;
    if (m && Math.abs(px - m.x) <= m.w / 2 && Math.abs(py - m.y) <= m.h / 2) {
      return { kind: 'market' };
    }
    return null;
  }

  function showPortPop(hit) {
    if (!hit) { toggle(portPop, 'hid', true); return; }
    if (hit.kind === 'market') {
      setText(popTitle, 'The Trading Post');
      setText(popRate, `${TRADE_BASE}:1`);
      setText(popBody, `Anyone may use it: ${TRADE_BASE} of any one resource `
        + `for 1 of any other. Every harbour is a discount on this.`);
    } else {
      const p = hit.port;
      const owned = !!(state.players[0].ports && state.players[0].ports.has
        ? state.players[0].ports.has(p.id) : false);
      setText(popTitle, p.resource ? `${RES_LABEL[p.resource]} harbour` : 'Harbour');
      setText(popRate, p.label);
      /* SHORTER, AND BIGGER — see the `.ov-portpop` sizes in ui-build.css.
         "Make all of the text on the popup when i click the ports in the map
          view larger, its hard to read on a small screen and has a bit too much
          text." Two sentences: what it charges, and whether it is yours. The
         paragraph that used to spell out the 4:1 fallback is the same sentence
         the rate chip beside the title is already showing. */
      const res = p.resource ? RES_LABEL[p.resource].toLowerCase() : null;
      setText(popBody, (res
        ? `${p.ratio} ${res} for 1 of anything. Other resources still cost ${TRADE_BASE}.`
        : `${p.ratio} of any one resource for 1 of anything.`)
        + (owned ? ' Yours.' : ' Build a settlement on one of its two corners to unlock it.'));
    }
    toggle(portPop, 'hid', false);
  }

  let action = null;
  function fireAction() {
    const fn = action;
    if (typeof fn === 'function') { action = null; fn(); }
  }

  /* NO TITLE PLATE AND NO SUB-LINE.
   *
   *   "The map when players are placing settlements does NOT need subtitles
   *    (this goes for the computer version too). It's text no one is reading
   *    and commentary no one cares about, and it goes by so fast that it's just
   *    distracting."
   *
   * Both are gone from the layout. `titleEl` and `hintEl` are still written to
   * — by this file, matchflow.js and netmatch.js, all of which have a name for
   * what the panel is doing — and both are kept in the tree, off screen, as the
   * panel's accessible name and description. The plate they used to sit in was
   * a bar across the top centre of the board, which is the third of the screen
   * a player most wants to see. The rail says whose turn it is; the pips say it
   * without opening anything. */
  const label = el('div', { class: 'ov-say' }, titleEl, hintEl);
  const wrap = el('div', {
    class: 'ov hid', 'data-ui': '', role: 'dialog', 'aria-label': 'Island map'
  }, cv, label, strip, closeBtn, pausedChip, rail, sayEl, buyRow, actBar, portPop);
  root.appendChild(wrap);

  const ctx = (cv.getContext && cv.getContext('2d')) || null;

  /* ---------------------------------------------------------------- state */
  let openFlag = false;
  let mode = 'view';
  let opts = {};
  let targets = [];
  let sel = null;
  let hover = null;
  let hoverPulse = 0;
  let closeTimer = 0;
  let railRows = [];
  let railT = 0;
  let lastW = 0, lastH = 0, lastDpr = 0;

  /* ------------------------------------------------------ the build sheet
   *
   *   "If I want to build multiple roads, I shouldn't be stuck having to build
   *    one, then it closes then I click to open again, and click to build
   *    another. I'd prefer that if I can only build 1 based on the resources I
   *    have it still closes, but that if I have enough resources for multiple,
   *    it stays open and updates when I place a road to show me the other
   *    available road placements I can do, until there are no more."
   *
   * `buyT` paces the bar and the auto-close; `sayT` counts the opening line
   * down; `sent` is the one piece of bookkeeping the network forced.
   */
  let buyT = 0;
  let sayT = 0;
  /** Height the top line's band takes out of the board fit, once measured. */
  let sayBand = 0;
  /** Seconds of "you built a road" left to show, and the sentence itself. */
  let builtT = 0;
  let builtTxt = '';
  let boardSig = '';
  /**
   * Targets this sheet has already committed and is waiting on.
   *
   * ONLINE, A COMMITTED PLACEMENT CHANGES NOTHING LOCALLY. `netCommit` puts the
   * build on the wire and the piece appears when the server's own event comes
   * back, so for those sixty milliseconds the edge is still legal, still
   * pulsing, and still under the finger that just tapped it twice — and a third
   * tap would send a second road to the same edge. The sheet cannot assume the
   * build succeeded, so it assumes only this: an edge it has already asked for
   * is not a spot it may offer again. Cleared the moment the board changes
   * shape, which is when the truth arrives from wherever it was coming from.
   */
  const sent = new Set();

  /* THE RAIL STARTS OPEN EVERYWHERE.
   *
   *   "you can see that the players tab on the right side is defaulted to being
   *    minimized, i actually want it to start open seeing the full right side
   *    player section."
   *
   * It used to start closed on a phone, on the reasoning that a 186px column is
   * a lot of a 852px screen to spend on a list. That was the right trade when
   * the column left a strip of sea beside it and ran over the board; it is the
   * wrong one now that it runs to the glass and the board is fitted around
   * whatever it actually measures. Opening a match on the pips and having to
   * find the key is a worse first second than a narrower island.
   *
   * `compact()` stays because the tap-once-and-it-sticks behaviour below still
   * needs a screen size, and so does the re-fit on rotate. */
  const compact = () => {
    const w = globalThis.innerWidth || wrap.clientWidth || 1024;
    const h = globalThis.innerHeight || wrap.clientHeight || 768;
    return w <= 760 || h <= 400;
  };
  let railOpen = true;
  let railChosen = false;
  /* The tutorial's "paint no placement markers this step" switch — see the
     note at the draw call. Nothing in a real match ever sets it. */
  let targetsHidden = false;

  const proj = {
    s: 1, ox: 0, oy: 0, w: 0, h: 0,
    /* Fit scale before the user's pan/zoom. Mobile number discs use this so
       their labels remain a constant readable size while the board moves. */
    fitS: 1,
    /** Vertical squash, 1 flat. Owned by ovpan.js's two-finger tilt. */
    ky: 1,
    frame: { x: 0, y: 0, w: 0, h: 0 }
  };

  const paint = ctx ? createPainter(ctx, proj) : null;
  const PX = x => x * proj.s + proj.ox;
  const PY = z => z * proj.s + proj.oy;

  /* Drag / pinch / wheel / +- over the board; buttons and hint live in `wrap`. */
  /* The pad carries the HOME key as well as the zoom keys, because the map is
     the one panel that is up in every mode INCLUDING `draft-watch` — the state
     the player asked to be able to leave from, where the board is locked and
     there is otherwise no way back to the home screen. */
  const pan = createOvPan(cv, proj, {
    root: wrap,
    isOpen: () => openFlag,
    onLeave: typeof game.leaveMatch === 'function' ? () => game.leaveMatch() : null
  });

  /* The board itself — sea, island, tokens, docks, everyone's pieces — only
     changes when someone builds or the frame moves. Painting nineteen
     gradient-stacked hexes sixty times a second is a waste of a phone's
     battery, so it is baked once offscreen and blitted; only the pulsing
     targets and the moving settlers are redrawn per frame. */
  const bg = ctx && typeof document !== 'undefined' ? document.createElement('canvas') : null;
  const bgx = bg && bg.getContext ? bg.getContext('2d') : null;
  const bgPaint = bgx ? createPainter(bgx, proj) : null;
  let bgKey = '';
  /* The projection the bake was painted at. While a finger is down the board is
     blitted through the difference between this and the live one — one
     transformed drawImage, not nineteen gradient hexes a frame — and it re-bakes
     sharp the moment the gesture ends. */
  let bgS = 1, bgOX = 0, bgOY = 0, bgKY = 1, bgTilt = false;

  /**
   * What the baked board depends on. If two frames agree on this string the
   * bake is reused, which is the whole reason the map can be dragged at all.
   *
   * IT HAS TO COUNT CITIES SEPARATELY FROM BUILDINGS.
   *
   *   "When I build a city, it's not seemingly updating the icon/circle that
   *    represents a city right away, it still looks like a settlement."
   *
   * `state.buildings` is keyed by intersection, and an upgrade REPLACES the
   * entry at that corner rather than adding one — so `buildings.size` is
   * identical before and after, the key matched, the bake was reused, and the
   * map went on painting a settlement pip over a city until something else on
   * this list happened to move. The 3D island was right the whole time, which
   * is what made it look like a rendering delay rather than a cache that never
   * knew.
   *
   * Counted off the players' own sets rather than by walking `buildings`,
   * because this runs every frame the map is open.
   */
  function boardKey() {
    let unlocked = 0, cities = 0;
    for (const p of state.players) { unlocked += p.ports.size; cities += p.cities.size; }
    return `${cv.width}x${cv.height}|${proj.s.toFixed(3)}|${proj.ox.toFixed(1)}|` +
      `${proj.oy.toFixed(1)}|${state.buildings.size}|${cities}|${state.roadOwner.size}|` +
      `${state.robberTile}|${unlocked}|${(proj.ky || 1).toFixed(3)}`;
  }

  function bakeBoard() {
    const key = boardKey();
    if (key === bgKey) return;
    bgKey = key;
    bg.width = cv.width; bg.height = cv.height;
    const dpr = cv.width / Math.max(1, proj.w);
    bgx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bgx.clearRect(0, 0, proj.w, proj.h);
    /* THE BAKE IS TILTED, NOT THE BLIT.
     *
     * The offscreen canvas is exactly the size of the visible one, and a
     * tilted board is fitted at a LARGER world scale — so drawn flat it is
     * half as tall again as the canvas it is being baked into, and the bottom
     * two rows of hexes are clipped away before anything is blitted. Squashing
     * on the way IN is the only order that works. */
    // The water is not part of the board and is painted flat, edge to edge,
    // so the tilted bake has no unfilled band above and below it.
    bgPaint.drawSea();
    bgTilt = tiltIn(bgx);
    bgPaint.drawShelf();
    bgPaint.drawTiles();
    bgPaint.drawTokens();
    bgPaint.drawPorts(state);
    bgPaint.drawRoads(state);
    bgPaint.drawBuildings(state);
    bgPaint.drawRobber(state);
    if (bgTilt) bgx.restore();
    bgS = proj.s; bgOX = proj.ox; bgOY = proj.oy; bgKY = proj.ky;
  }

  /* ------------------------------------------------------- rail visibility
   *
   * `measure()` reserves the rail's width out of the map frame only when the
   * rail is up, so closing it does not leave a 186px column of dead sea — the
   * board is re-fitted into the whole panel on the very next frame. That is
   * the "so the game can be full screen" half of the request; the strip is the
   * other half.
   */
  function setRail(open) {
    railOpen = !!open;
    railChosen = true;
    applyRail();
    // The frame changed shape under the board: re-fit now rather than waiting
    // for a resize that may never come.
    measure();
  }

  function applyRail() {
    toggle(rail, 'hid', !railOpen);
    // Never both. The strip is the rail, collapsed.
    toggle(strip, 'hid', railOpen);
    toggle(railKey, 'on', railOpen);
    railKey.setAttribute('aria-label', railOpen ? 'Hide the player list' : 'Show the player list');
    railKey.setAttribute('aria-expanded', railOpen ? 'true' : 'false');
  }

  /* ------------------------------------------------------------ the strip
   * Rebuilt whole whenever its reading changes, which is at most five nodes
   * four times a second — cheaper than the bookkeeping to update it in place.
   */
  let pipSig = '';
  function buildPips(d) {
    const order = d
      ? (Array.isArray(d.order) && d.order.length ? d.order : (state.setupOrder || []))
      : null;
    const idx = d && Number.isFinite(d.index) ? d.index : 0;

    // Draft order during the draft, seating order otherwise. Each seat once.
    let seats = [];
    if (order && order.length) {
      for (const pid of order) if (seats.indexOf(pid) < 0) seats.push(pid);
    } else {
      seats = state.players.map(p => p.id);
    }

    const sig = seats.join(',') + '|' + (d
      ? `d${idx}.${d.pid}`
      : 'v' + state.players.map(p => scoreOf(state, p)).join('.'));
    if (sig === pipSig) return;
    pipSig = sig;

    while (pips.firstChild) pips.removeChild(pips.firstChild);
    for (const pid of seats) {
      const p = state.players[pid];
      if (!p) continue;
      let cls = 'ov-pip' + (pid === 0 ? ' me' : '');
      let badge = null;
      if (d) {
        if (pid === d.pid) cls += ' now';
        else {
          let last = -1;
          for (let i = 0; i < order.length; i++) if (order[i] === pid) last = i;
          if (last >= 0 && last < idx) cls += ' done';
        }
      } else {
        // Off the draft there is no "now", so the one number worth carrying is
        // the score — the rail's whole headline, in one glyph's worth of space.
        badge = el('b', { text: String(scoreOf(state, p)) });
      }
      pips.appendChild(el('span', {
        class: cls,
        title: pid === 0 ? 'You' : p.name,
        style: { '--c': p.color.css, '--cl': p.color.light }
      },
        el('span', { html: personPip(p.color.css, p.color.light, 18) }),
        badge));
    }
  }

  /* ------------------------------------------------------------ rail rows */
  function buildRail() {
    railOrder = '';
    while (rail.firstChild) rail.removeChild(rail.firstChild);
    rail.appendChild(el('div', { class: 'rail-head', text: 'Players' }));
    railRows = state.players.map(p => {
      const vp = el('b', { class: 'rr-vp', text: '0' });
      const stats = el('div', { class: 'rr-stats' });
      const h = p.color.hex;
      const rgb = `${(h >> 16) & 255},${(h >> 8) & 255},${h & 255}`;
      const row = el('div', {
        class: 'rr' + (p.id === 0 ? ' me' : ''),
        style: {
          '--c': p.color.css, '--cl': p.color.light,
          '--ct': `rgba(${rgb},.40)`, '--ct2': `rgba(${rgb},.68)`
        }
      },
        el('div', { class: 'rr-top' },
          el('span', { class: 'rr-av', html: avatar(p.color.css, p.color.light, 30) }),
          el('div', { class: 'rr-id' },
            el('span', { class: 'rr-name', text: p.id === 0 ? 'You' : p.name }),
            el('span', { class: 'rr-col', text: p.color.key })),
          vp),
        stats);
      if (p.id === 0) row.appendChild(el('span', { class: 'rr-you', text: 'You' }));
      rail.appendChild(row);
      // `row` is kept so `sortRail` can move it. Everything else here is a
      // handle on something inside it.
      return { p, row, vp, stats, last: '' };
    });
  }

  /**
   * During the draft the rail stops being a scoreboard — nobody has a score
   * yet — and becomes the draft board: who is picking, in what order, which
   * two slots are yours, and how far through the eight picks we are. It is the
   * one piece of chrome that answers "why am I watching" when the shuffle put
   * the player last.
   */
  function buildDraftRail(d) {
    railRows = [];
    while (rail.firstChild) rail.removeChild(rail.firstChild);
    const order = Array.isArray(d.order) && d.order.length ? d.order : (state.setupOrder || []);
    const idx = Number.isFinite(d.index) ? d.index : 0;
    const total = order.length || 8;

    rail.appendChild(el('div', { class: 'ov-dhead', text: 'Opening Draft' }));
    rail.appendChild(el('div', {
      class: 'ov-dsub',
      text: `Pick ${Math.min(idx + 1, total)} of ${total}`
    }));

    // Seats in draft order, not player order — the strip reads top to bottom
    // exactly the way the first round runs.
    const seats = [];
    for (const pid of order) if (seats.indexOf(pid) < 0) seats.push(pid);

    for (const pid of seats) {
      const p = state.players[pid];
      if (!p) continue;
      const h = p.color.hex;
      const rgb = `${(h >> 16) & 255},${(h >> 8) & 255},${h & 255}`;
      const slots = [];
      for (let i = 0; i < order.length; i++) if (order[i] === pid) slots.push(i);
      const pipRow = el('div', { class: 'ov-dp' }, slots.map(i => el('b', {
        class: (i === idx ? 'now' : (i < idx ? 'done' : '')),
        text: String(i + 1)
      })));
      const me = pid === 0;
      const cls = 'ov-dr' + (me ? ' you' : '')
        + (pid === d.pid ? ' now' : '')
        + (slots[slots.length - 1] < idx ? ' done' : '');
      rail.appendChild(el('div', {
        class: cls,
        style: { '--c': p.color.css, '--cl': p.color.light, '--ct': `rgba(${rgb},.44)` }
      },
        el('span', { class: 'ov-dn', text: me ? 'You' : p.name }),
        pipRow,
        pid === d.pid ? el('span', { class: 'ov-dtag', text: me ? 'Go' : 'Now' }) : null));
    }

    const mySlots = [];
    for (let i = 0; i < order.length; i++) if (order[i] === 0) mySlots.push(i);
    if (mySlots.length) {
      rail.appendChild(el('div', {
        class: 'ov-dhead',
        style: 'padding-top:6px',
        text: `You pick ${mySlots.map(i => ORDINAL[i] || (i + 1)).join(' & ')}`
      }));
    }

    /* THE LIVE COMMENTARY IS GONE.
     *
     *   "It's text no one is reading and commentary no one cares about, and it
     *    goes by so fast that it's just distracting."
     *
     * It said things like "Eyeing the southern grainfields" and changed every
     * couple of seconds through a draft that takes under a minute. The rail
     * above it already names every seat, marks the one picking, and numbers
     * the eight slots — which is the information; that was the flavour. */
  }

  /**
   * The rail is a SCOREBOARD, so it is in score order.
   *
   *   "In the map view, sometimes the players are out of order, It should
   *    always be the top is the highest score, going down to the lowest score on
   *    the bottom. Make sure the longest road and largest army and victory
   *    points are also accounted for in that total."
   *
   * It was built once in SEATING order and never resorted, which is why it
   * drifted out of agreement with the standings in the corner of the match —
   * those have always used `rankings`. All three of the things named are
   * already in the total: `scoreOf` in core/rules.js is settlements + 2x cities
   * + victory-point cards + the two awards, and it is the same function the
   * victory check uses, so a rail that disagreed with it would be a rail that
   * disagreed with who won.
   *
   * Reordered by moving the rows, not by rebuilding them: `railRows` holds live
   * nodes with their own paint state, and appendChild on an element already in
   * the parent MOVES it. Four rows, only touched when the order actually
   * changes, so a lead that holds costs one string compare a beat.
   */
  let railOrder = '';
  function sortRail() {
    if (!railRows.length) return;
    const ranked = railRows.slice().sort((a, b) =>
      scoreOf(state, b.p) - scoreOf(state, a.p)
      || (b.p.cities.size - a.p.cities.size)
      || (b.p.settlements.size - a.p.settlements.size)
      || (a.p.id - b.p.id));
    const sig = ranked.map(r => r.p.id).join(',');
    if (sig === railOrder) return;
    railOrder = sig;
    for (const r of ranked) rail.appendChild(r.row);
  }

  function refreshRail() {
    sortRail();
    for (const r of railRows) {
      setText(r.vp, scoreOf(state, r.p));
      const key = `${r.p.longestRoadLen}|${r.p.knightsPlayed}|${r.p.hasLongestRoad}|` +
        `${r.p.hasLargestArmy}|${r.p.settlements.size}|${r.p.cities.size}`;
      if (key === r.last) continue;
      r.last = key;
      let h = '';
      h += `<i title="Settlements">${icon('house', 20)}<em>${r.p.settlements.size}</em></i>`;
      h += `<i title="Cities">${icon('castle', 20)}<em>${r.p.cities.size}</em></i>`;
      h += `<i class="aw ${r.p.hasLongestRoad ? 'won' : ''}" title="Longest road">` +
        `${icon('road', 20)}<em>${r.p.longestRoadLen}</em></i>`;
      h += `<i class="aw ${r.p.hasLargestArmy ? 'won' : ''}" title="Knights">` +
        `${icon('knight', 20)}<em>${r.p.knightsPlayed}</em></i>`;
      r.stats.innerHTML = h;
    }
  }

  /* ---------------------------------------------------------- projection */
  /* The three CSS lengths `measure()` needs and cannot compute.
   *
   * `measure()` works in canvas pixels; `env()` and custom properties only
   * resolve in the used value of a real element. So a 1px probe is inserted,
   * measured and removed — and CACHED, because this runs inside the draw loop
   * and a layout flush per frame is a real cost. The key is everything that can
   * change the answer: the panel's size, and the `notch-left`/`notch-right`
   * class index.html writes on <html> when the phone is turned over. */
  let padKey = '';
  let padVal = { ov: 6, left: 0, right: 0 };
  function readPads() {
    const doc = wrap.ownerDocument || document;
    const root = doc.documentElement;
    const key = `${cv.clientWidth}x${cv.clientHeight}|${root ? root.className : ''}`;
    if (key === padKey) return padVal;
    padKey = key;
    const probe = doc.createElement('div');
    probe.style.cssText = 'position:absolute;left:0;top:0;height:1px;'
      + 'visibility:hidden;pointer-events:none;width:var(--ovpad,6px)';
    const pl = probe.cloneNode(false);
    pl.style.width = 'var(--saln,0px)';
    const pr = probe.cloneNode(false);
    pr.style.width = 'var(--sarn,0px)';
    wrap.appendChild(probe); wrap.appendChild(pl); wrap.appendChild(pr);
    padVal = {
      ov: Math.round(probe.getBoundingClientRect().width) || 6,
      left: Math.round(pl.getBoundingClientRect().width) || 0,
      right: Math.round(pr.getBoundingClientRect().width) || 0
    };
    wrap.removeChild(probe); wrap.removeChild(pl); wrap.removeChild(pr);
    return padVal;
  }

  function measure() {
    const w = cv.clientWidth || wrap.clientWidth || 800;
    const h = cv.clientHeight || wrap.clientHeight || 400;
    proj.w = w; proj.h = h;
    // The DPR is part of the cache key, not just the payload: a browser zoom
    // or a window dragged between a Retina and a non-Retina display changes it
    // without changing the CSS size, and the backing store then keeps the old
    // scale until something else moves.
    const dpr = clamp(globalThis.devicePixelRatio || 1, 1, 2);
    if (ctx && (w !== lastW || h !== lastH || dpr !== lastDpr)) {
      cv.width = Math.max(1, Math.round(w * dpr));
      cv.height = Math.max(1, Math.round(h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      lastW = w; lastH = h; lastDpr = dpr;
    }
    /* HOW MUCH OF THE RIGHT EDGE IS SPOKEN FOR — MEASURED, NEVER COUNTED.
     *
     *   "its also partially covering the map, instead of outside of the map
     *    section."
     *
     * This used to be `railW + 26`: the rail's declared width plus an
     * ALLOWANCE for its gutter, hard-coded at a number that was true on a
     * laptop. On a notched iPhone the gutter is the 44px safe-area inset, the
     * rail's real left edge is 27px further into the panel than the arithmetic
     * believed, and the board was fitted straight underneath it. The rail is
     * now full-bleed and its width carries the inset too (see `.ov-rail` in
     * ui.css), which is a second number this file has no business knowing.
     *
     * So it asks. One `getBoundingClientRect` per open panel per frame, which
     * is what the pip strip already cost, and the answer is right on every
     * device including the ones that do not exist yet. */
    const cvBox = cv.getBoundingClientRect ? cv.getBoundingClientRect() : null;
    /** How far a right-anchored panel reaches in from the canvas's right edge. */
    const reachIn = (node) => {
      if (!cvBox || !node || !node.getBoundingClientRect) return 0;
      const r = node.getBoundingClientRect();
      if (!r.width) return 0;
      return Math.max(0, Math.round(cvBox.right - r.left));
    };

    /* The rail used to vanish entirely under 560px, which was fine when this
       panel was only ever a map. It is now also the PAUSE screen — "pausing the
       game should still show me the full scores and board" — and a pause that
       drops the scores on a phone is half a feature. It gets narrower instead
       of going away (the three widths live in ui.css); the board keeps the
       rest.

       Closed, the rail costs nothing but the pip column still stands on the
       right edge, and the board must not run under that either. */
    const railW = railOpen ? reachIn(rail) : 0;
    const stripW = railOpen ? 0 : reachIn(strip);

    /* THE FRAMED MAP AREA: everything the board may occupy.
     *
     * Three separate things decide how far in each edge starts, and the frame
     * takes the largest of whichever apply.
     *
     *   THE ROUNDED CORNERS OF THE SCREEN. `--ovpad` — see the note on it in
     *   ui-base.css. 6px on a rectangular display, 16 on a phone or tablet,
     *   because a 16px-radius frame 6px inside a 55px screen arc pokes out
     *   through it: "the edges of the phone are curved and its actually cutting
     *   things off like the curved edges of the top left and bottom left".
     *
     *   THE SENSOR HOUSING, on whichever side it is actually on. The frame is
     *   decoration, but the DOCK LABELS hang off the coast inside it and the
     *   ones at half height on the housing's side were being covered. `--saln`
     *   and `--sarn` are zero on the side that is clear, so this costs nothing
     *   on the rotation and the devices where there is nothing to clear.
     *
     *   THE PLAYER RAIL, measured rather than counted — see `reachIn` above. */
    const pad = readPads();
    const fx = Math.max(pad.ov + pad.left, 6);
    const rightPanel = (railW || stripW) ? (railW || stripW) + 12 : 0;
    const fr = Math.max(6, pad.ov + pad.right, rightPanel);
    const f = proj.frame;
    f.x = fx; f.y = pad.ov;
    f.w = Math.max(80, w - fx - fr);
    f.h = Math.max(80, h - pad.ov * 2);

    // A foot only exists when something is standing in it; in plain view — and
    // now in a draft pick and a Knight's region too — the board gets that space
    // back so it fills the frame instead of floating in it.
    // The two paddings are read off the real elements rather than guessed:
    // the dock tags hang off the coast and were sliding under the title plate
    // at 375px tall, where a guessed constant is always wrong by a few pixels.
    /* THE BOARD STARTS BIGGER, because there is less on top of it.
     *
     *   "That way the map can start more zoomed in."
     *
     * `padT` used to be measured off the bottom edge of the title plate, which
     * meant a two-line headline shrank the island. There is no plate now, so
     * the only thing to clear at the top is the close key in the corner — and
     * that is a corner, not a band. 12 top, 10 bottom in view mode, and the
     * side padding halved: the same island, drawn about a fifth larger. */
    /* THE FOOT IS WHICHEVER OF THE TWO IS UP, OR NEITHER.
     *
     * There used to be exactly one bar down there and the question was only
     * whether it was hidden. There are two now — the affordability chips and
     * the single-action button of a review screen — and they are never up
     * together. When neither is (a Knight choosing a region, a draft pick, the
     * plain map) the board takes the whole panel back, which is a taller island
     * than any of those three modes has ever had. */
    /* AND THE LINE ALONG THE TOP IS CHROME TOO.
     *
     *   "Stop the pill occluding the board at 640x320 — it covers two 3:1 port
     *    badges at rows 10-41. Either reserve its height in the board's fit
     *    calculation, or float it over the sheet's gold header rail instead of
     *    over the map."
     *
     * Reserved, for the same reason the foot is: the pill no longer times out
     * on a build sheet, so "it is only up for a moment" stopped being an
     * excuse for standing on two harbours. Measured off the real element and
     * not guessed, because its height is a line of type in a face the player
     * may have scaled. */
    let padT = 12;
    const foot = !buyRow.classList.contains('hid') ? buyRow
      : (!actBar.classList.contains('hid') ? actBar : null);
    let padB = foot ? 54 : 10;
    const padX = 8;
    if (cv.getBoundingClientRect) {
      const base = cv.getBoundingClientRect();
      if (foot && foot.getBoundingClientRect) {
        const r = foot.getBoundingClientRect();
        if (r.height) padB = Math.max(padB, (f.y + f.h) - (r.top - base.top) + 8);
      }
      /* RESERVED WHETHER OR NOT IT IS SHOWING, WHICH IS THE WHOLE POINT.
       *
       * Measuring only the visible line makes the board's scale depend on the
       * line's visibility, and the line appears the instant a target is armed —
       * so on a panel where it is not permanent (a draft pick, a Knight's
       * region) the island would shrink under the finger on the arming tap and
       * grow back on the commit, which moves every target a few pixels between
       * the moment a rig reads a position and the moment it taps it. It moves
       * them under a thumb, too. So the height is remembered from the last time
       * it was up and kept reserved for as long as the mode has anything to
       * say, and the band never changes size while a panel is open. */
      if (!sayEl.classList.contains('hid') && sayEl.getBoundingClientRect) {
        const r = sayEl.getBoundingClientRect();
        if (r.height) sayBand = (r.bottom - base.top) - f.y + 8;
      }
      if (sayBand && IDLE_SAY[mode]) padT = Math.max(padT, sayBand);
    }
    const availW = Math.max(60, f.w - padX * 2);
    const availH = Math.max(60, f.h - padT - padB);
    /* THE BOARD IS BIGGER THAN THE ISLAND, AND THE FIT NOW KNOWS IT.
     *
     *   "RESERVE THE BAR'S HEIGHT IN THE BOARD FIT. There is a razor-straight
     *    cut at y=260 slicing the bottom ~40% off both bottom port badges,
     *    ratio text cut through, no fade or mask ... It also happens in
     *    build-draft where the sheet's own gold rail does the cutting, so fix
     *    the bottom inset generally, not only for the bar case."
     *
     * The cut was real and it was not a clip: `BOUNDS` is the box around the
     * fifty-four INTERSECTIONS, and the nine harbour signs are drawn hanging
     * off the coast well outside it — `len + signH * 1.12` past the mid-point
     * of a coastal edge, which at 640x320 is 36px against the 14px of slack
     * this fit was allowing. So the island fitted, the harbours did not, and
     * the chip bar (or, with no bar up, the panel's own gold rail) simply stood
     * on top of the overflow. Nothing was masking anything; the board was
     * bigger than the frame it had been fitted into and nobody had measured it.
     *
     * `dockOverhang` is that measurement, taken from `dockGeom`'s own numbers
     * so the two cannot drift. It is in CSS PIXELS, not world units, because
     * both of its terms have a px floor — `max(15, ...)` — so on a small screen
     * the harbours stop shrinking with the island and the slack has to grow as
     * a fraction of it. Which is exactly why a constant could never have been
     * right at both shipping sizes.
     *
     * A scale that depends on a margin that depends on the scale needs solving
     * rather than evaluating, so: fit as before, then twice re-fit against the
     * overhang the previous answer implies. Two passes is convergence to well
     * under a pixel — the floors mean the function is flat where it matters —
     * and it is bounded, which a `while` would not be. */
    const bw = BOUNDS.width;
    const bd = BOUNDS.depth;
    /* Fit against the TILTED height. Squashing the board to 55% and then
       still fitting it as if it were flat would waste exactly the space the
       tilt was asked for — the whole point is to see more of the island, not
       the same amount of it lower down. The harbour signs stand UP rather than
       leaning with the board (see `billboard` in ovmap.js), so their overhang
       is not squashed and is subtracted outside the `ky` term. */
    const ky = proj.ky || 1;
    let s = Math.min(availW / (bw + HEX_SIZE * 1.1), availH / ((bd + HEX_SIZE * 1.1) * ky));
    for (let i = 0; i < 2; i++) {
      const ov = dockOverhang(s);
      s = Math.min((availW - ov * 2) / bw, (availH - ov * 2) / (bd * ky));
      if (!(s > 0)) { s = Math.min(availW / bw, availH / (bd * ky)); break; }
    }
    proj.fitS = s;
    pan.apply({
      s,
      ox: f.x + padX + availW / 2 - BOUNDS.cx * s,
      oy: f.y + padT + availH / 2 - BOUNDS.cz * s
    });
    applyRail();
  }

  /* ------------------------------------------------------------ placement
   *
   * Every pixel of the placement layer — the corner rings, the road slabs, the
   * Knight marks, the confirm preview and the rival telegraph — is painted by
   * `./ovtargets.js`. It moved out when this file crossed the 900-line budget,
   * and the split fell where it should: this file decides WHAT is legal and
   * what the finger touched, that one decides what it looks like.
   */
  const tg = ctx ? createTargets(ctx, proj, paint, state) : null;
  const targetR = () => (tg ? tg.targetR() : 0);
  const roadPaintW = () => (tg ? tg.roadBodyW() : 0);
  const hitRadius = () => (tg ? tg.hitRadius() : 26);

  /** The frame's snapshot, handed to the painter. Allocated once. */
  const view = { mode, targets, sel, hover, pulse: 0, spotlight: null };
  function snapshot(pulse) {
    view.mode = mode;
    view.targets = targets;
    view.sel = sel;
    view.hover = hover;
    view.pulse = pulse;
    view.spotlight = opts.spotlight || null;
    return view;
  }


  /* THE TILT, APPLIED ONCE, HERE.
   *
   * Everything the painters draw goes through `proj`, so a vertical squash
   * could have been folded into their projection helpers — at the cost of
   * touching every hex vertex, token radius, dock and road slab in ovmap.js
   * and hoping none of them was missed. One canvas transform about the middle
   * of the frame does the same thing to all of it, atomically.
   *
   * The two things that must NOT be squashed bracket it: the sea (a flat fill
   * that has to reach the frame's edges however far the board is tilted) is
   * painted first, and the frame itself (a rounded rectangle, not part of the
   * board) is painted after. */
  /* Squashed about the BOARD's own centre, not the frame's. The fit in
     `measure()` places the island's middle at a known y and sizes it to the
     available height; squashing about any other line moves that middle and
     the arithmetic stops being true, which is a board that overflows the
     bottom of the frame by however far the two centres disagreed. */
  const tiltCentre = () => proj.oy + BOUNDS.cz * proj.s;

  function tiltIn(c) {
    const ky = proj.ky || 1;
    if (ky >= 0.999) return false;
    const cy = tiltCentre();
    c.save();
    c.translate(0, cy);
    c.scale(1, ky);
    c.translate(0, -cy);
    return true;
  }

  function draw(pulse) {
    if (!ctx) return;
    measure();
    ctx.clearRect(0, 0, proj.w, proj.h);
    /* EVERYTHING THAT IS THE BOARD STAYS INSIDE THE BOARD'S FRAME.
     *
     *   "Right now the map items when I zoom in are not staying within the
     *    confines of their border box for the draft/map."
     *
     * The frame was painted over the top of the board rather than around it, so
     * at rest it read as a window and under zoom it stopped: hexes, docks and
     * settlers ran straight out across the label strip and the chips. One clip,
     * pushed here and released just before `drawFrame` paints the moulding
     * itself — which has to be outside it, or it would clip away its own outer
     * keyline. See `clipToFrame` in ovmap.js for where the radius comes from. */
    const clipped = paint.clipToFrame(proj.frame);
    if (bgx) {
      /* Re-bake when the board is still, and ALWAYS when the tilt has moved:
         the ride-along blit is a uniform scale, which cannot express a change
         in the squash, and the tilt is the one gesture where the thing being
         changed is what you are looking at. */
      if (!pan.gesturing || !bgKey || bgKY !== proj.ky) bakeBoard();
      // Water first: once the board has been dragged the bake no longer
      // reaches the frame edge, and what it leaves behind is open ocean.
      paint.fillSea();
      const k = bgS > 0 ? proj.s / bgS : 1;
      ctx.save();
      ctx.translate(proj.ox - bgOX * k, proj.oy - bgOY * k);
      ctx.scale(k, k);
      ctx.drawImage(bg, 0, 0, proj.w, proj.h);
      ctx.restore();
    } else {
      paint.drawSea();
      const t = tiltIn(ctx);
      paint.drawShelf();
      paint.drawTiles();
      paint.drawTokens();
      paint.drawPorts(state);
      paint.drawRoads(state);
      paint.drawBuildings(state);
      paint.drawRobber(state);
      if (t) ctx.restore();
    }
    // The live layer rides the same squash as the board it sits on; the frame
    // is not part of the board and stays a rectangle.
    const tilted = tiltIn(ctx);
    const v = snapshot(pulse);
    tg.drawSpotlight(v);
    /*   "Remove the white glowing borders for where the user can place the
     *    roads — that's the focus of the NEXT step anyway."
     * A practice-run switch (see `setTargetsHidden` below): one lesson talks
     * about the pieces already on the board while the placement map is up, and
     * thirty breathing road slots were shouting over it. The targets stay in
     * `targets` — taps still land, metrics still report — they are simply not
     * painted this frame. */
    if (!targetsHidden) tg.drawTargets(v);
    paint.drawSettlers(state);
    if (tilted) ctx.restore();
    if (clipped) ctx.restore();
    paint.drawFrame(proj.frame);
  }

  /* -------------------------------------------------------------- picking
     Everything below works in FLAT board space, so a screen point has to come
     back out of the tilt before it is compared with anything. One place, and
     it is the inverse of `tiltIn`. */
  /** Flat board space -> the squashed canvas. The inverse of `unTilt`. */
  function tiltY(py) {
    const ky = proj.ky || 1;
    if (ky >= 0.999) return py;
    const cy = tiltCentre();
    return (py - cy) * ky + cy;
  }

  function unTilt(py) {
    const ky = proj.ky || 1;
    if (ky >= 0.999) return py;
    const cy = tiltCentre();
    return (py - cy) / ky + cy;
  }

  function pick(px, py) {
    if (!targets.length) return null;
    // >= 44px across at 667x375, and nearest-wins beyond that, so a fat finger
    // between two corners always lands on the closer one.
    const thresh = hitRadius();
    let best = null, bd = thresh * thresh;
    if (mode === 'place-robber') {
      bd = (HEX_SIZE * proj.s * 0.92) ** 2;
      for (const id of targets) {
        const t = tiles[id];
        const d = (PX(t.x) - px) ** 2 + (PY(t.z) - py) ** 2;
        if (d < bd) { bd = d; best = id; }
      }
      return best;
    }
    const src = targetSource();
    for (const id of targets) {
      const o = src[id];
      if (!o) continue;
      const d = (PX(o.x) - px) ** 2 + (PY(o.z) - py) ** 2;
      if (d < bd) { bd = d; best = id; }
    }
    return best;
  }

  /**
   * The array a target id indexes into, for whatever the panel is offering.
   * Everything that has to know where a target IS goes through here — the hit
   * test, the arrow keys and the target painter — so a new mode is one line.
   */
  function targetSource() {
    if (mode === 'place-road') return edges;
    if (mode === 'place-robber') return tiles;
    if (mode === 'pick-port') return ports;
    return intersections;
  }

  /**
   * A tap picks a spot. A SECOND TAP ON THE SAME SPOT PLACES IT.
   *
   *   "When I'm placing settlements, roads and cities, make it so I can double
   *    click if I want instead of needing to scroll and click Confirm."
   *
   * The board fills the panel and the confirm bar used to sit under it, so
   * choosing a corner and then committing it meant a trip from wherever the
   * finger already was, down to a button, on every single placement — and on a
   * phone, often a scroll to get there. It began as the shortcut for when the
   * player already knew where the piece was going; it is now the whole route,
   * and the button it was a shortcut past is gone.
   *
   * It is a RE-TAP, not a timed double-click: no window to hit, no difference
   * between a fast mouse double-click and two deliberate taps a second apart,
   * and it works the same under a finger as under a cursor. A tap on any OTHER
   * legal spot just moves the selection, and a tap on none of them takes the
   * choice back without closing the sheet — the two ways out of a wrong choice,
   * neither of which is a button.
   *
   * `commit()` is the call every rig and every trace tool makes, so every rule
   * check, payment and `onConfirm` hook is identical down both routes.
   *
   * A TAP ON OPEN WATER TAKES THE CHOICE BACK.
   *
   *   "If I press on the screen to place a road and haven't pressed to confirm
   *    yet, and I click somewhere else on the map (that isn't another open
   *    road), it cancels that placement for me but keeps that road building map
   *    open."
   *
   * Which is the last job the Cancel button was doing, and it was doing it
   * badly: Cancel threw away the SHEET, so taking back one mis-aimed tap cost a
   * trip back to the build cards and a fresh open. A tap that hits no target
   * now disarms and stays, and the way out of the sheet itself is the close key
   * — two different sizes of "no" that used to be the same button.
   *
   * It is deliberately not limited to the build sheet: a draft pick and a
   * Knight's region both used to need the bar for this, and neither has one now.
   */
  onTap(cv, e => {
    if (!openFlag) return;
    // A drag that moved the board is not a choice of anything.
    if (pan.moved) return;
    const r = cv.getBoundingClientRect ? cv.getBoundingClientRect() : { left: 0, top: 0 };
    const px = e.clientX - r.left, py = unTilt(e.clientY - r.top);
    const placing = mode !== 'view' && mode !== 'draft-watch';

    /* PLACEMENT FIRST, ALWAYS. A harbour sign stands out over open water and a
       target stands on the island, so the two almost never overlap — but when
       they do, the player mid-placement meant the corner. The sign is only
       consulted once the placement pick has missed. */
    const hit = placing ? pick(px, py) : null;
    if (hit === null || hit === undefined) {
      const sign = signAt(px, py);
      if (sign) { showPortPop(sign); return; }
      showPortPop(null);
      if (placing && sel !== null) select(null);
      return;
    }
    showPortPop(null);
    if (hit === sel) { commit(); return; }
    select(hit);
  });

  // Pointer hover is a desktop nicety; on touch the pointer never moves
  // without a tap, so `hover` simply tracks the finger and clears on lift.
  if (cv.addEventListener) {
    cv.addEventListener('pointermove', e => {
      if (!openFlag || !targets.length) { hover = null; return; }
      const r = cv.getBoundingClientRect ? cv.getBoundingClientRect() : { left: 0, top: 0 };
      hover = pick(e.clientX - r.left, unTilt(e.clientY - r.top));
    });
    cv.addEventListener('pointerleave', () => { hover = null; });
  }

  function select(id) {
    sel = id;
    // The chosen target is drawn on the board at the size of the piece it is
    // about to become, with a bobbing chevron over it — so the only thing left
    // to say in words is what the next tap does, and that is the top line's job.
    refreshSay();
    ghost();
  }

  /**
   * Is this a free-road placement, paid for by a Road Building card?
   *
   * `opts.free` is set by `economy.placeFreeRoads`, which is the only thing in
   * the game that opens the map on somebody else's money.
   */
  function freeRoadMode() {
    return mode === 'place-road' && !!opts.free && (state.players[0].freeRoads | 0) > 0;
  }

  /**
   * Dress the one line of text this panel still has.
   *
   * Four states, in the order they beat each other:
   *
   *   ARMED    gold, standing, "tap again to build" — the sentence that used to
   *            be a green button forty per cent of a screen from the finger.
   *   BUILT    green, for `BUILT_SAY_SEC`, naming what landed and what is left.
   *   IDLE     the double-tap reminder, up for as long as a BUILD SHEET is —
   *            see the IDLE_SAY note at the top of this file — and for
   *            `OPEN_SAY_SEC` on a panel that is not one.
   *   NOTHING  only ever on a non-sheet panel whose reminder has run out.
   *
   * A free-road sheet's idle line is its own sentence, because a screen that
   * looks exactly like an ordinary road build while spending a card's money is
   * the one state on this panel that can cost the player something they cannot
   * get back.
   */
  function refreshSay() {
    const armed = sel !== null && sel !== undefined && ARM_SAY[mode];
    const built = !armed && builtT > 0 && builtTxt;
    const sheet = !!buildKind();
    const idleOK = !armed && !built && IDLE_SAY[mode] && (sheet || sayT > 0);
    const free = freeRoadMode();
    let idle = '';
    if (idleOK) {
      const owed = state.players[0].freeRoads | 0;
      idle = free
        ? `${owed} free road${owed > 1 ? 's' : ''} — tap an edge, then tap it again`
        : IDLE_SAY[mode];
    }
    const txt = armed ? ARM_SAY[mode] : (built ? builtTxt : idle);
    toggle(sayEl, 'arm', !!armed);
    toggle(sayEl, 'done', !!built);
    toggle(sayEl, 'freeroad', !!(free && !built));
    if (!txt) {
      toggle(sayEl, 'on', false);
      // Long enough for the fade to run; `hid` is what actually takes it out of
      // the layout so it can never be measured as chrome over the board.
      setTimeout(() => toggle(sayEl, 'hid',
        sel === null && sayT <= 0 && builtT <= 0 && !buildKind()), 220);
      return;
    }
    setText(sayTxt, txt);
    toggle(sayEl, 'hid', false);
    /* Reading a layout property between un-hiding and un-fading is what makes
       the fade actually run: set both in one go and the browser collapses them
       into a single paint with no transition at all. It is the same trick
       `replay()` in dom.js uses, and it is a forced reflow rather than a
       `setTimeout` on purpose — a timer here is a timer that can be starved by
       a slow frame, and this line has to be up by the time the finger that
       armed the target has lifted. */
    void (sayEl.offsetWidth || 0);
    toggle(sayEl, 'on', true);
  }

  /**
   * Take the line down without asking `refreshSay` whether it should be up.
   *
   * `close()` cannot go through `refreshSay`: `buildKind()` is deliberately not
   * gated on `openFlag` (see its own note — a sheet that decided it was not a
   * sheet while `open()` was dressing it would come up with no bar), so on the
   * way OUT it still answers "road" for a panel that is already leaving, and
   * the line would stay lit over a fading map.
   */
  function hideSay() {
    toggle(sayEl, 'on', false);
    toggle(sayEl, 'arm', false);
    toggle(sayEl, 'done', false);
    toggle(sayEl, 'freeroad', false);
    setTimeout(() => { if (!openFlag) toggle(sayEl, 'hid', true); }, 220);
  }

  function ghost() {
    const st = game.world && game.world.structures;
    if (!st) return;
    try {
      if (sel === null) { if (st.clearGhost) st.clearGhost(); return; }
      if (mode === 'place-road') { if (st.ghostRoad) st.ghostRoad(sel, 0); }
      else if (mode === 'place-settlement' || mode === 'place-city') {
        if (st.ghostSettlement) st.ghostSettlement(sel, 0);
      }
      // 'pick-port' arms a dock that already exists — there is nothing to
      // preview, and asking for a settlement ghost at a PORT id would put a
      // translucent house on whichever corner happened to share that number.
    } catch (err) { /* the 3D preview is optional */ }
  }

  /* --------------------------------------------------------- build sheet */

  /**
   * Which of the four purchases this panel is currently offering, or null if it
   * is not a build sheet at all.
   *
   * The opening draft, a Knight's region and the plain map are all placement
   * panels that have nothing to do with affording anything: the draft's pieces
   * are free (`opts.setup`), and the Knight is spending a card that was already
   * paid for. None of them gets the chips, none of them stays open on a count,
   * and all of them therefore get the whole panel for the board — which is the
   * one part of this change that makes the draft better too.
   */
  function buildKind() {
    // Deliberately NOT gated on `openFlag`: `open()` dresses the panel before
    // it raises it, and a sheet that decided it was not a build sheet during
    // that window would come up with no bar and never grow one.
    if (opts.setup || opts.draft) return null;
    if (state.phase !== 'play') return null;
    if (mode === 'place-road') return 'road';
    if (mode === 'place-settlement') return 'settlement';
    if (mode === 'place-city') return 'city';
    return null;
  }

  /**
   * A chip was tapped: change what the map is offering.
   *
   *   "so I can build a road, click the settlement button and the screen
   *    switches to show possible settlement placements"
   *
   * This goes through `game.requestBuild`, which is the SAME call the HUD's
   * build cards make — economy.js re-points it at `buy()` on attach — rather
   * than reaching into `open()` directly. That matters for three reasons and
   * they are all correctness, not tidiness: `buy()` is what knows a road with
   * `freeRoads` in hand is free and routes it through the two-road placement
   * loop; it is what refuses politely, in words, when a race has just made the
   * purchase unaffordable between the paint and the tap; and online it is what
   * sends the purchase to the server instead of paying for it locally. `open()`
   * is then called from in there, sees this panel already up, and re-dresses it
   * in place — no close, no reopen, no camera trip, and the board stays exactly
   * where the player has dragged it.
   *
   * A CARD has nowhere to be placed, so nothing switches: it is bought on the
   * spot and the bar re-counts underneath the same map. That is not a special
   * case bolted on — it is what `buy('card')` does, and the sheet simply does
   * not close because nothing asked it to.
   */
  function pickKind(kind) {
    if (!openFlag) return false;
    /* NEVER SWITCH THE MAP TO A BOARD WITH NOTHING ON IT.
     *
     *   "If a mode has zero legal targets the chip must be DISABLED with a
     *    reason, never selected-and-empty."
     *
     * `buyCount` already counts legal spots as one of its three ceilings, so a
     * chip offering a mode with nowhere to put the piece is at nought and
     * `disabled` before a finger gets near it — this is the belt to that
     * braces, and it is not theoretical: the count is read on a quarter-second
     * tick and a rival's road can take the last legal corner in the gap
     * between the paint and the tap. Refuse, shake the chip, leave the map on
     * whatever it was already offering. */
    const kinds = { road: 'place-road', settlement: 'place-settlement', city: 'place-city' };
    if (kinds[kind] && !computeTargets(kinds[kind], {}).length) {
      buyBar.flash(kind);
      refreshBuy(true);
      return false;
    }
    if (sel !== null) select(null);
    let ok = false;
    try {
      ok = typeof game.requestBuild === 'function' ? game.requestBuild(kind) !== false : false;
    } catch (e) { ok = false; }
    if (!ok) buyBar.flash(kind);
    refreshBuy(true);
    return ok;
  }

  /* ========================================================== the keyboard
   *
   * `ui/ovkeys.js` owns the routing; this is the panel's half of it. Two
   * things live here because only this file can answer them — where a target
   * sits on screen, and what Tab should switch to next — and everything else
   * (nearest-in-direction, the wrap, the capture-phase listener) is over there.
   * See that file's header for why the cursor is scored on screen positions
   * rather than walked through the board graph.
   */

  /** Screen position of a target, tilt and all. */
  function targetXY(id) {
    const o = targetSource()[id];
    if (!o) return null;
    return { x: PX(o.x), y: tiltY(PY(o.z)) };
  }

  /** Tab: the next purchase there is anything to do with. */
  function cycleKind(back) {
    const kind = buildKind();
    if (!kind) return false;
    /* NEVER 'card'. It is in BUILD_KINDS because the chip bar shows it, but it
       has nowhere to be placed — `pickKind('card')` BUYS one on the spot. A key
       whose whole job is "show me the settlements instead" must not be able to
       spend four wool, four wheat and four ore on its way past, and holding Tab
       would have done it once per repeat. */
    const usable = BUILD_KINDS
      .map(b => b.kind)
      .filter(k => k !== 'card' && buyCount(state, k) > 0);
    if (usable.length < 2) return false;
    let at = usable.indexOf(kind);
    if (at < 0) at = 0;
    const next = usable[(at + (back ? -1 : 1) + usable.length) % usable.length];
    if (next === kind) return false;
    pickKind(next);
    return true;
  }

  /*
   * While the map is up the arrows belong to the map.
   *
   * Offline the frame loop is already frozen (see `mapPaused` in main.js), so
   * this changes nothing there; ONLINE nothing freezes, and without it every
   * press that moved the cursor would also have walked the settler somewhere.
   * The same handshake `ui/panels.js` uses, for the same reason.
   */
  let keysHeld = false;
  function grabKeys(on) {
    const want = !!on;
    if (want === keysHeld) return;
    keysHeld = want;
    const inp = game && game.input;
    if (inp && typeof inp.setKeyboardCapture === 'function') {
      try { inp.setKeyboardCapture(want, 'overview'); } catch (e) { /* optional */ }
    }
  }

  const mapKeys = createMapKeys({
    isOpen: () => openFlag,
    isPlacing: () => mode !== 'view' && mode !== 'draft-watch',
    targets: () => targets,
    selected: () => sel,
    xyOf: targetXY,
    select,
    commit: () => commit(),
    cycleKind,
    action: () => (action ? fireAction : null)
  });

  /** What the board looks like right now, cheaply. */
  function signature() {
    return `${state.buildings.size}|${state.roadOwner.size}|${state.phase}`;
  }

  /**
   * Re-read the counts, and re-offer the board after something changed.
   *
   * The board changing under an open sheet is not an edge case, it is the
   * normal networked path (your own build lands sixty milliseconds after you
   * asked for it) and the normal offline one (a rival lays a road while you are
   * deciding). Either way the set of legal spots is stale, so it is recomputed
   * and the armed choice is kept ONLY if it survived — you should never tap
   * twice on a corner somebody else took while you were looking at it.
   */
  function refreshBuy(force) {
    const kind = buildKind();
    toggle(buyRow, 'hid', !kind);
    if (!kind) return;
    const sig = signature();
    if (sig !== boardSig || force) {
      boardSig = sig;
      sent.clear();
      const next = computeTargets(mode, opts);
      targets = next;
      if (sel !== null && next.indexOf(sel) < 0) select(null);
    }
    buyBar.refresh(kind);
  }

  /**
   * A piece just went down and the sheet wants to stay. True if it may.
   *
   *   "it stays open and updates when I place a road to show me the other
   *    available road placements I can do, until there are no more."
   *
   * "No more" is either half of the sentence: nothing left to pay with, or
   * nowhere left to put it. Note what is NOT consulted — whether the build
   * actually succeeded. Online it has not happened yet and cannot be known, so
   * the count is the count before the server answers and the sheet stays up on
   * the strength of it; the answer arrives a frame or two later through
   * `refreshBuy`, and if it turns out to have been the last road the sheet
   * closes then. Guessing "closed" and being wrong costs the player the map
   * they were about to use; guessing "open" and being wrong costs them one tap
   * on the close key.
   */
  /**
   * After a build lands: can this sheet stay up, and pointing at what?
   *
   *   "If I opened the map for building by clicking the road button and I run
   *    out of resources to keep building roads but I do have enough resources to
   *    buy a development card or build a city, the build section should stay
   *    open. The same goes for if I open the other buttons. So if I click the
   *    settlement and I build one, and I can still build another settlement or
   *    even buy a card, or build a road with my remaining resources, it should
   *    stay open."
   *
   * The first version asked one question — can I still afford another of the
   * kind I am holding — and closed on the first no. That is the right question
   * for a sheet that is about roads; it is the wrong question for a sheet that
   * is about BUILDING, which is what the chip bar turned it into. Spending your
   * last brick on a road and being thrown out of a screen that is still offering
   * you a city and a card is the sheet arguing with its own bottom row.
   *
   * So: stay on the current kind while it still has somewhere to go, and
   * otherwise walk the bar for anything else that is affordable AND has a legal
   * target, in the order the chips are drawn so the move is predictable. Only
   * when the whole bar is dead does the sheet come down — which is the same
   * moment the bar would be four greyed chips, and there is nothing to stay open
   * for.
   *
   * `sent` is per-kind by construction: it holds target ids, and a road id and a
   * corner id never collide, so switching kinds cannot accidentally hide a spot.
   */
  function rearm(id) {
    const kind = buildKind();
    if (!kind) return false;
    if (id !== null && id !== undefined) sent.add(id);

    const stillHere = k => {
      if (buyCount(state, k) <= 0) return null;
      if (k === 'card') return [];            // a card needs no spot on the board
      const m = k === 'road' ? 'place-road'
        : k === 'settlement' ? 'place-settlement' : 'place-city';
      const next = computeTargets(m, opts).filter(t => !sent.has(t));
      return next.length ? next : null;
    };

    // The kind in hand first — switching under the player when they could have
    // carried on would be as surprising as closing under them.
    let use = kind, next = stillHere(kind);
    if (!next) {
      for (const { kind: k } of BUILD_KINDS) {
        if (k === kind) continue;
        const alt = stillHere(k);
        if (alt) { use = k; next = alt; break; }
      }
    }
    if (!next) return false;

    if (use !== kind) {
      // A card is bought, not placed: take it and let the bar re-count, but do
      // not leave the map pointing at a kind nothing can be done with.
      if (use === 'card') { buyBar.refresh(kind); return true; }
      pickKind(use);
      return true;
    }
    targets = next;
    select(null);
    buyBar.refresh(use);
    return true;
  }

  /* ------------------------------------------------------- open / commit */
  function computeTargets(m, o) {
    const setup = !!o.setup;
    const anchor = o.anchor === undefined ? -1 : o.anchor;
    if (m === 'place-road') return legalRoads(state, 0, setup, anchor);
    if (m === 'place-settlement') return legalSettlements(state, 0, setup);
    if (m === 'place-city') return legalCities(state, 0);
    if (m === 'place-robber') return tiles.filter(t => t.id !== state.robberTile).map(t => t.id);
    /* Every dock this player has unlocked. Port ids, not corner ids — the one
       mode whose targets index `ports` rather than the board graph. */
    if (m === 'pick-port') {
      const mine = state.players[0].ports;
      return ports.filter(p => mine.has(p.id)).map(p => p.id);
    }
    return [];
  }

  /**
   * Open — or, if we are already open, re-dress in place.
   *
   * The in-place path is what makes the opening draft one continuous view.
   * Nothing touches `hid` / `on` / `setOverview` while already open, so the
   * 3D camera never leaves the board framing and the panel never re-runs its
   * scale-in transition between two consecutive picks.
   */
  function open(m, o) {
    const wasOpen = openFlag;
    const nextMode = MODE_INFO[m] ? m : 'view';
    const nextOpts = o || {};
    const nextTargets = computeTargets(nextMode, nextOpts);

    if (nextMode !== 'view' && nextMode !== 'draft-watch' && !nextTargets.length) {
      // Nothing legal — leave whatever is on screen exactly as it was.
      if (game.toast) game.toast('No legal spot for that right now', 'warn');
      return false;
    }

    mode = nextMode;
    opts = nextOpts;
    targets = nextTargets;
    sel = null;
    hover = null;

    const info = MODE_INFO[mode];
    setText(titleEl, opts.title || info.title);
    setText(hintEl, opts.hint || info.hint);
    toggle(pausedChip, 'hid', !opts.paused);
    /* An action turns the bar into a single button in ANY mode, including the
       two that normally have no bar at all. */
    action = opts.action && typeof opts.action.onPress === 'function'
      ? opts.action.onPress : null;
    const acting = !!action;
    if (acting) setText(actionBtn.querySelector('.sb-lab'), opts.action.label || 'Start');
    toggle(actBar, 'hid', !acting);
    const canClose = !(mode !== 'view' && opts.cancellable === false);
    toggle(closeBtn, 'hid', !canClose);
    /* HOME is the alternative to the close key, never its neighbour — see
       `setHomeShown` in ovpan.js. It is up only in the state that has no close
       key, which is the locked draft the "let me leave mid-draft" request was
       about. */
    if (pan.setHomeShown) pan.setHomeShown(!canClose);
    // The chips and the review button are mutually exclusive: a screen with one
    // thing to do is not also a shop. `refreshBuy` decides the chips' own case.
    sent.clear();
    boardSig = signature();
    toggle(buyRow, 'hid', true);
    if (!acting) refreshBuy(true);
    /* The COUNTDOWN runs on a fresh open only, and only matters on a panel
       that is not a build sheet: a sheet's idle line no longer times out at
       all (see IDLE_SAY), so this is the draft pick's and the Knight's copy of
       it. Re-dressing in place happens between two halves of a draft pick,
       after every free road, and every time a chip switches the map to another
       piece — a reminder that restarted its clock on all of those would be a
       caption blinking at the player for no reason they can see. */
    sayT = (!wasOpen && IDLE_SAY[mode]) ? OPEN_SAY_SEC : 0;
    builtT = 0;
    builtTxt = '';
    /* THE X, WHEN THE ROADS ARE NOT YOURS.
     *
     *   "either disable the X or warn that closing forfeits the remaining free
     *    road."
     *
     * It warns rather than disabling, because economy.js DEFERS an unspent debt
     * rather than forfeiting it and main.js re-offers the map on the next clear
     * frame — so the road is not actually lost, and taking away the only way
     * out of a full-screen panel to protect something that is not at risk is a
     * worse trap than the one being closed. The line at the top carries the
     * same news in words a thumb can read; this is what a screen reader and a
     * long-press get. */
    closeBtn.setAttribute('aria-label', freeRoadMode()
      ? 'Close the map — your free roads are kept and offered again'
      : 'Close the map');
    select(null);
    if (opts.draft) buildDraftRail(opts.draft);
    else { buildRail(); refreshRail(); }
    // The strip reads the same source as the rail and is up whether or not the
    // rail is. A player who has not touched the key gets the default every time
    // the map opens — see the `railOpen` note above for why that is now OPEN at
    // every size rather than the viewport's answer.
    if (!railChosen) railOpen = true;
    pipSig = '';
    buildPips(opts.draft || null);

    openFlag = true;
    closeTimer = 0;
    showPortPop(null);
    /* NOTHING ELSE OVER THE BOARD WHILE THE BOARD IS THE SCREEN.
     *
     *   "Suppress the 'GATHER. BUILD. WIN. / FIRST TO 12 POINTS' intro banner
     *    while the build sheet is open, or dismiss it on open ... it covers
     *    board rows y=175-259 — 85px, 27% of a 320px screen — hiding the bottom
     *    hex row and its road targets, which is the exact space this rework was
     *    meant to free."
     *
     * The objective card lands on GO and fades after two and a half seconds,
     * which is right when the screen is third-person play and wrong the moment
     * a build card raises this panel over the top of it. It belongs to
     * matchflow.js and flowUI.js, which this agent does not own, so the class
     * goes on the interface root and one rule in ui-build.css fades the card
     * out for exactly as long as the map is up. Its own countdown keeps running
     * underneath, so it is usually gone by the time the map comes down. */
    toggle(root, 'ov-live', true);
    grabKeys(true);
    if (wasOpen) return true;

    // A fresh open starts on the whole board; re-dressing in place (the draft,
    // pick to pick) deliberately keeps whatever the player has pushed it to.
    pan.reset();
    toggle(wrap, 'hid', false);
    lastW = 0; lastH = 0;
    // Next frame so the transition actually runs.
    setTimeout(() => toggle(wrap, 'on', openFlag), 16);
    if (game.camera && game.camera.setOverview) game.camera.setOverview(true);
    return true;
  }

  function close() {
    if (!openFlag) return;
    openFlag = false;
    sel = null;
    hover = null;
    ghost();
    targets = [];
    opts = {};
    sent.clear();
    sayT = 0;
    builtT = 0;
    builtTxt = '';
    hideSay();
    toggle(buyRow, 'hid', true);
    toggle(wrap, 'on', false);
    // The objective card and anything else in the match-flow layer may have the
    // screen back. Paired with the `toggle(root, 'ov-live', true)` in `open`.
    toggle(root, 'ov-live', false);
    grabKeys(false);
    if (pan.disarm) pan.disarm();
    closeTimer = 0.26;
    if (game.camera && game.camera.setOverview) game.camera.setOverview(false);
  }

  function cancel() {
    if (opts.onCancel) { try { opts.onCancel(); } catch (e) { /* ignore */ } }
    close();
  }

  function commit() {
    if (sel === null) return false;
    const id = sel;
    /* A DOCK IS NOT A PLACEMENT. Nothing is built and nothing is paid: the
       "commit" is the trade sheet for that dock, and the map gets out of the
       way behind it. Handled before `onConfirm` so a caller cannot accidentally
       route a port id into `placeSettlement`. */
    if (mode === 'pick-port') {
      close();
      if (typeof game.openTrade === 'function') game.openTrade(id);
      return true;
    }
    let ok = false;
    if (typeof opts.onConfirm === 'function') {
      ok = opts.onConfirm(id) !== false;
    } else if (netCommit(mode, id)) {
      // ONLINE, THIS PANEL DOES NOT PLACE ANYTHING. With no onConfirm supplied
      // — which is the normal route for a HUD build card — the branches below
      // would write a piece onto the board that no server has agreed to yet.
      // netCommit sends it instead and the piece arrives with the server's
      // own `build` event, through the same handler that draws it offline.
      ok = true;
    } else if (mode === 'place-road') {
      ok = placeRoad(state, 0, id, !!opts.free, opts.anchor === undefined ? -1 : opts.anchor);
    } else if (mode === 'place-settlement') {
      ok = placeSettlement(state, 0, id, !!opts.free);
    } else if (mode === 'place-city') {
      ok = upgradeCity(state, 0, id, !!opts.free);
    } else if (mode === 'place-robber') {
      ok = playKnight(state, 0, id);
    }
    if (!ok) {
      if (game.toast) game.toast('You cannot build there', 'bad');
      select(null);
      return false;
    }
    // `keepOpen` belongs to the opening draft: the caller is about to hand the
    // very same panel its next job (settlement -> road, or the wait for the
    // next drafter), so closing here would be a visible round trip out to the
    // third-person camera and straight back.
    if (opts.keepOpen) { select(null); targets = []; return true; }
    /* SAY THAT IT WORKED, AND SAY WHAT IS LEFT.
     *
     *   "Add a positive build confirmation. The only feedback in build-stayed
     *    is one 10px digit changing 3 to 2 inside a 52x38 chip. A player with
     *    three rivals moving will not notice."
     *
     * Read BEFORE `rearm`, because `rearm` is what re-reads the counts and the
     * sentence wants the number the player is about to have, not the one they
     * had. Offline the piece is already down and `buyCount` is already one
     * lower; online it is not, and the count is the pre-server figure — the
     * same optimism `rearm` itself runs on, and wrong for at most a frame or
     * two before `refreshBuy` corrects it. */
    const noun = BUILT_NOUN[buildKind()];
    if (noun) {
      const left = buyCount(state, buildKind());
      builtTxt = left > 0
        ? `Built — ${left} ${noun}${left > 1 ? 's' : ''} left`
        : `Built — that was your last ${noun}`;
      builtT = BUILT_SAY_SEC;
    }
    /* AND THIS IS THE ONE THE OWNER ASKED FOR.
     *
     *   "I'd prefer that if I can only build 1 based on the resources I have it
     *    still closes, but that if I have enough resources for multiple, it
     *    stays open and updates when I place a road to show me the other
     *    available road placements I can do, until there are no more."
     *
     * Both halves are `rearm()`: it returns false when the count has run out or
     * the board has, and that is the close. Nothing about it is a mode the
     * player has to be in or get out of — build your last affordable road and
     * the map closes exactly as it always did.
     *
     * ...EXCEPT WHEN THE TUTORIAL IS ASKING FOR ONE.
     *
     *   "Override the rule that keeps the road builder map open if I have extra
     *    resources available in order to build a road. It should close right
     *    after I built one road in this instance."
     *
     * The practice run hands the player a pack with five roads in it so the
     * later steps never stall for materials, which turns the stay-open rule
     * against the lesson: the step after this one is written for a board with
     * the road ON it, and the player is instead left holding an armed map with
     * four more placements glowing and nothing telling them to stop. `opts.once`
     * is set only by the caller that means it, so nothing about a real match
     * changes. */
    if (!opts.once && rearm(id)) return true;
    close();
    return true;
  }

  /* ----------------------------------------------------------------- loop */
  function update(dt) {
    const d = Number.isFinite(dt) ? dt : 1 / 60;
    if (!openFlag) {
      if (closeTimer > 0) {
        closeTimer -= d;
        if (closeTimer <= 0) toggle(wrap, 'hid', true);
      }
      return;
    }
    hoverPulse += d;
    railT += d;
    if (railT > 0.25) { railT = 0; refreshRail(); buildPips(opts.draft || null); }

    // The opening reminder times itself out on a panel that is not a build
    // sheet; the armed line does not, because what it says is true for exactly
    // as long as a target is armed; and the "built" line hands back to the idle
    // line rather than to nothing.
    if (sayT > 0) {
      sayT -= d;
      if (sayT <= 0) { sayT = 0; refreshSay(); }
    }
    if (builtT > 0) {
      builtT -= d;
      if (builtT <= 0) { builtT = 0; builtTxt = ''; refreshSay(); }
    }

    /* THE SHEET KEEPS ITSELF HONEST FOUR TIMES A SECOND.
     *
     * Everything that can empty a build sheet happens to it from outside: a
     * Knight robs the pack, a rival takes the last legal corner, the server
     * confirms the road that spent the last of the brick. Recomputing on commit
     * alone would leave a bar reading `x2` over a board that can no longer
     * offer one — so the counts and the targets are re-read on a slow tick, and
     * the sheet stands down when there is nothing left to build.
     *
     * `sel === null` guards the close: a player who has already armed a target
     * gets to finish the tap they started, and the commit refuses on its own if
     * the money went. Yanking a panel out from under a finger mid-gesture is
     * the one failure that feels like a bug rather than a rule. */
    if (buildKind()) {
      buyT += d;
      if (buyT > 0.25) {
        buyT = 0;
        refreshBuy(false);
        if (!targets.length || (sel === null && buyCount(state, buildKind()) <= 0)) {
          close();
          return;
        }
      }
    }

    draw(hoverPulse);
  }

  return {
    open, close, update,
    get isOpen() { return openFlag; },
    get mode() { return mode; },
    /** False for a panel whose caller hid the X on purpose — the opening draft
     *  and the networked board, which must not be closable at all. Read by
     *  ui/hotkeys.js so Escape cannot do what the missing button cannot. */
    get closable() { return !(mode !== 'view' && opts.cancellable === false); },
    /** Pan / zoom of the board — pose, clamp box, and whether it is on screen. */
    get panInfo() { return pan.info; },
    /** Capture-rig hook: one notch out, so a rig can walk to the floor. */
    zoomOutForTest() { return pan.zoomAt(1 / 1.22); },
    /** Capture-rig hook: one notch in, paired with `zoomOutForTest`. */
    zoomInForTest() { return pan.zoomAt(1.22); },

    /**
     * Every size the placement layer paints at, in canvas css px.
     *
     * Nothing in the game reads this. It exists so a capture rig can REPORT
     * "the choose-a-spot ring is 8px across and the placed settlement is 22px
     * across at 667x375" rather than re-deriving the formulas and drifting from
     * them. Each field is produced by the same function the painter calls.
     */
    get metrics() {
      return {
        mode,
        s: +proj.s.toFixed(2),
        targets: targets.length,
        sel,
        /** where the chosen target sits on the canvas, so a rig can crop it */
        selXY: sel === null || sel === undefined ? null : (() => {
          const o = targetSource()[sel];
          return o ? [Math.round(PX(o.x)), Math.round(PY(o.z))] : null;
        })(),
        ids: targets.slice(0, 80),
        /**
         * WHERE EVERY LEGAL SPOT IS, IN CANVAS PIXELS.
         *
         *   "Darken the rest and just highlight the white sections for where I
         *    can place a road."
         *
         * The tutorial's wash works in screen pixels and has always got them by
         * projecting through the PLAY camera. This surface has its own
         * projection and its own tilt, so nothing outside overview.js can work
         * out where a target landed — and a lesson that points at the glowing
         * lines has to know. Same three lines `selXY` uses, for the whole list,
         * with the tilt applied because these are read against the screen and
         * not against flat board space.
         */
        targetsXY: targets.slice(0, 80).map(id => {
          // Via `targetSource()` so a new mode never has to be added here too —
          // 'pick-port' indexes `ports`, and reading it out of `intersections`
          // would report a corner that merely shares the dock's number.
          const o = targetSource()[id];
          return o ? [Math.round(PX(o.x)), Math.round(tiltY(PY(o.z)))] : null;
        }).filter(Boolean),
        /** ...and the player's own pieces, for the step that names them. */
        minePieceXY: (() => {
          const me0 = state.players[0]; const out = [];
          if (!me0) return out;
          for (const iid of me0.settlements) { const n = intersections[iid];
            if (n) out.push([Math.round(PX(n.x)), Math.round(tiltY(PY(n.z)))]); }
          for (const iid of me0.cities) { const n = intersections[iid];
            if (n) out.push([Math.round(PX(n.x)), Math.round(tiltY(PY(n.z)))]); }
          for (const eid of me0.roads) { const e = edges[eid];
            if (e) out.push([Math.round(PX(e.x)), Math.round(tiltY(PY(e.z)))]); }
          return out;
        })(),
        /**
         * THE HEXES A RIVAL IS ACTUALLY WORKING, for the Knight lesson.
         *
         *   "The steps here should explain that you should place it on the
         *    opponent's hex that is their best... use your best judgement on
         *    what sections should be highlighted and darkened."
         *
         * `targetsXY` in robber mode is every tile the Knight may legally go to,
         * which is nearly the whole island — a wash with eighteen holes in it is
         * not a hint. The sentence says "the hex a rival works hardest", so the
         * holes are the tiles with a rival settlement or city on a corner and
         * nothing else. Desert is dropped: nobody works it, and the Knight is
         * already standing there. Sorted by pips so the busiest hex is first,
         * which is the one the words are about.
         */
        rivalHexXY: (() => {
          const out = [];
          const owner = new Map();          // iid -> pid, rivals only
          for (let pid = 1; pid < state.players.length; pid++) {
            const p = state.players[pid];
            if (!p) continue;
            for (const iid of p.settlements) owner.set(iid, pid);
            for (const iid of p.cities) owner.set(iid, pid);
          }
          if (!owner.size) return out;
          for (const t of tiles) {
            // No pips is the desert, which nobody works and where the Knight
            // already stands — it is not a hex to aim at.
            if (!t || !t.pips) continue;
            let worked = false;
            for (const iid of (t.corners || [])) { if (owner.has(iid)) { worked = true; break; } }
            if (!worked) continue;
            out.push({ pips: t.pips || 0,
              xy: [Math.round(PX(t.x)), Math.round(tiltY(PY(t.z)))] });
          }
          out.sort((a, b) => b.pips - a.pips);
          return out.map(o => o.xy);
        })(),
        /** choose-a-spot ring radius */
        targetR: +targetR().toFixed(1),
        /** PLACED settlement pip radius at the current board scale */
        pipR: +pipRadius(proj).toFixed(1),
        /** Painted number-disc radius. Fixed across zoom on a phone. */
        tokenR: (() => {
          const rs = paint && paint.tokenRects ? paint.tokenRects() : [];
          return rs.length ? +(rs[0].w / 2.16).toFixed(1) : 0;
        })(),
        /** painted width of a road target's coloured core */
        roadPaintW: +roadPaintW().toFixed(1),
        /** the whole road slab, casing included */
        roadSlabW: +(roadPaintW() + 4.5).toFixed(1),
        /** how long an edge is on screen, for scale */
        roadEdgePx: +(HEX_SIZE * proj.s).toFixed(1),
        /** The vertical squash the tilt is applying, 1 flat. */
        ky: +(proj.ky || 1).toFixed(3),
        /** What the canvas was really scaled by while the board was drawn and
         *  while a number disc was — the board leans, the discs stand up. */
        /* The BAKE painter when there is one: that is the context the board
           and its tokens are actually drawn into, and reporting the live
           painter instead reports a code path that did not run. */
        scales: (bgx ? bgPaint : paint) ? (bgx ? bgPaint : paint).scales : null,
        /** width of the tap zone around a target, corner to corner */
        hitPx: +(2 * hitRadius()).toFixed(1),
        /**
         * THE PAINTED BOARD, harbour signs included, as [x0,y0,x1,y1] in canvas
         * px. Nothing in the game reads it; it exists so a capture rig can
         * assert that no piece of chrome — the chip bar, the top line, the
         * panel's own rail — is standing on any of it, which is the only way to
         * catch "the bottom 40% of two port badges is sliced off flat" without
         * a human squinting at a screenshot. Built from `portRects()`, the same
         * function the painter draws the signs from.
         */
        boardBox: (() => {
          let x0 = PX(BOUNDS.minX), x1 = PX(BOUNDS.maxX);
          let y0 = tiltY(PY(BOUNDS.minZ)), y1 = tiltY(PY(BOUNDS.maxZ));
          const rects = (paint && paint.portRects) ? paint.portRects() : [];
          for (const r of rects) {
            x0 = Math.min(x0, r.x - r.w / 2); x1 = Math.max(x1, r.x + r.w / 2);
            y0 = Math.min(y0, tiltY(r.y) - r.h / 2);
            y1 = Math.max(y1, tiltY(r.y) + r.h / 2);
          }
          return [Math.round(x0), Math.round(y0), Math.round(x1), Math.round(y1)];
        })(),
        /** The harbour margin the fit is reserving on every side, in css px. */
        dockOv: +dockOverhang(proj.s).toFixed(1)
      };
    },
    resetView() { return pan.reset(true); },
    /**
     * Open or close the player rail from outside.
     *
     * The practice run has a step whose whole subject is that rail — "on the
     * right side are the four settlers and the colour each one builds in" — and
     * on a compact screen the rail defaults CLOSED, so the step was pointing at
     * a 30px strip of pips that was not what it described. `setRail` was already
     * here for the rail's own key; this exposes it so a lesson can put the
     * surface into the state it is about to talk about. It sets `railChosen`
     * exactly as a tap does, which is right: the player is being shown the rail,
     * and it should stay shown afterwards.
     */
    setRail(open) { setRail(!!open); return railOpen; },
    get railOpen() { return railOpen; },
    /** The tutorial's marker switch; see the note beside `drawTargets`. */
    setTargetsHidden(v) { targetsHidden = !!v; },
    select, commit,
    destroy() {
      pan.destroy();
      grabKeys(false);
      mapKeys.destroy();
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
    }
  };
}

export default createOverview;
