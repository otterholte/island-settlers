/**
 * Island Settlers — the centre notice, and the dark plate it now stands on.
 *
 *   createNotice(root) ->
 *     { node, show(text, color, glyph), hide(), update(dt), visible, destroy() }
 *
 * ---------------------------------------------------------------------------
 * WHY
 * ---------------------------------------------------------------------------
 *   "The road building, knight, and victory point notices when you buy a card
 *    are too hard to see. Can you give them a darker box behind them instead of
 *    just laying over the board, since it's really hard to see unless you know
 *    where to look."
 *
 * All three of those notices are the same object: the centre banner that
 * `hud.announce` raises. It has never been anything but LETTERING — gold type
 * with a text-shadow, floating over whatever the island happened to be showing
 * underneath it. Measured over a real board at 960x444 by tools/hudshot.mjs,
 * "Knight Card!" landed on the trading post and came out at 3.54:1 against what
 * was behind it, with the banner as a whole at 1.40:1 against the board beside
 * it — which is to say there was no plate at all, and whether the words could be
 * read was decided by which hex they happened to fall on. Gold on a sunlit
 * beach, gold on a wheat field, gold on the cream roof of the trading post: the
 * one message in the game that has to be read in the half-second it is up was
 * the one message with nothing behind it.
 *
 * So the banner became a real object. A dark, almost opaque plate with a gold
 * hairline and a drop shadow, in the same material language as every other
 * container in the game, and — when the caller names one — a gold disc carrying
 * the card's own glyph, so the Knight, the roads and the trophy are recognisable
 * before a single word has been read.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS ITS OWN FILE
 * ---------------------------------------------------------------------------
 * Three separate modules put a notice on this plate and none of them can see
 * each other: hud.js announces the Victory Point, hud-knight.js announces the
 * Knight, hud-road.js announces Road Building. They already share one entry
 * point — `hud.announce`, reached as `g.hud.announce` from the two cue modules —
 * so the plate belongs BEHIND that entry point rather than copied into each
 * caller. Lifting it out of hud.js and into here means the markup, the hold
 * timer and the fade all live in one place, and a caller that only wants to say
 * something still only has to call `announce(text, colour)`.
 *
 * The styling itself is `.announce` / `.ann-card` / `.ann-ico` / `.ann-txt` in
 * ui-hud.css, NOT injected from here the way hud-knight.js injects its chip.
 * That is deliberate and it is what makes the third caller free: hud-road.js is
 * owned by somebody else this week, and because the plate is a CSS class on the
 * element this module builds, Road Building's notice lands on the new plate with
 * no change to that file whatsoever. Naming its glyph is the only thing it would
 * gain from a line of its own.
 *
 * Nothing here knows anything about cards, the match, or the rules. It is a
 * place to put a sentence for two and a half seconds.
 *
 * Owner: UI agent.
 */

import { el, toggle, replay, setText } from './dom.js';
import { icon } from './icons.js';

/**
 * How long the notice holds before it starts to leave.
 *
 * 2.4 seconds of hold inside a 2.6 second animation, which is what the banner
 * has always done — the request was that it be SEEN, not that it stay up
 * longer, and a message that outlives its moment is the next complaint.
 */
const HOLD = 2.4;
const ANIM_MS = 2600;

/** The disc is 34px of gold; the glyph inside it is 24, like the card chips. */
const GLYPH_PX = 24;

/**
 * WHICH CARD THIS SENTENCE IS ABOUT, WORKED OUT FROM THE SENTENCE.
 *
 *   "hud-notice-road.png HAS NO ICON. Knight and victory point each carry a
 *    gold rounded-square icon badge at the left; Road Building is text only, so
 *    it visibly does not belong to the same family — and it is the notice where
 *    an icon would help most."
 *
 * Correct, and the reason it happened is that the glyph was something a CALLER
 * had to name. Two of the three callers are mine and both name it; the third —
 * hud-road.js — is owned by another agent this week and passes two arguments,
 * so Road Building alone arrived bare. So did the ONLINE victory point, which
 * systems/economy.js announces with two arguments as well, and which is a file
 * I may not edit either.
 *
 * The fix is to stop needing the caller. Every notice that is about a card says
 * that card's name in its own text — there is no other way to write "Road
 * Building!" — so the text is a perfectly good answer to "which card is this",
 * and matching it here fixes both un-editable callers at once with no change to
 * either file. An explicitly passed glyph still wins; this only fills a blank.
 *
 * Ordered, and `knight` is tested last on purpose: "Send the Knight" and
 * "Knight Sent" are Knight lines, but nothing else in the game contains the
 * words "road building" or "victory point", so those two are the sharper tests
 * and go first. Anything that matches nothing — "Settle the Island", "Final
 * Minute", a rival's news — gets no disc at all, which is right: those are
 * sentences, not cards.
 */
const GLYPH_BY_TEXT = [
  [/road building|free road/i, 'road'],
  [/victory point/i, 'trophy'],
  [/knight/i, 'knight']
];

function glyphFor(text) {
  for (const [re, name] of GLYPH_BY_TEXT) if (re.test(text)) return name;
  return '';
}

export function createNotice(root) {
  const txt = el('div', { class: 'ann-txt' });
  /* Built once and emptied rather than created per notice: `show` can be called
     twice in a second when a card lands on top of an award, and swapping
     `innerHTML` on a node that already exists is the cheap way to do that
     without the plate reflowing out from under its own animation. */
  const ico = el('span', { class: 'ann-ico hid' });
  const card = el('div', { class: 'ann-card' }, ico, txt);
  const node = el('div', { class: 'announce' }, card);
  if (root && root.appendChild) root.appendChild(node);

  let hold = 0;

  /**
   * Put a line on the plate.
   *
   * `glyph` is an icon name from icons.js — 'knight', 'road', 'trophy' — and is
   * optional: a caller that names nothing has the card read off its own text by
   * `glyphFor` above, which is what puts the road glyph on Road Building's
   * notice and the trophy on a networked Victory Point without either of those
   * two modules being touched.
   */
  function show(text, color, glyph) {
    if (!text) return;
    const line = String(text);
    setText(txt, line);
    if (color && txt.style) txt.style.setProperty('--ac', color);
    if (color && card.style) card.style.setProperty('--ac', color);

    const want = glyph ? String(glyph) : glyphFor(line);
    if (want) {
      // Only redraw when the card actually changed. A Knight drawn twice in a
      // row should not re-parse the same SVG.
      if (ico.__glyph !== want) { ico.innerHTML = icon(want, GLYPH_PX); ico.__glyph = want; }
      toggle(ico, 'hid', false);
    } else {
      toggle(ico, 'hid', true);
    }
    toggle(node, 'iconic', !!want);

    replay(node, 'show', ANIM_MS);
    hold = HOLD;
  }

  function hide() {
    hold = 0;
    toggle(node, 'show', false);
  }

  /* The hold is counted on the HUD's own clock rather than on a timer, so a
     match that is paused mid-notice does not have the notice expire behind the
     pause screen. This is the behaviour hud.js had before the plate existed and
     it is carried over unchanged. */
  function update(dt) {
    if (hold <= 0) return;
    hold -= Number.isFinite(dt) ? dt : 1 / 60;
    if (hold <= 0) toggle(node, 'show', false);
  }

  return {
    node,
    /* The plate itself, published for one caller: the victory-point trophy that
       now flies out of this notice and into the corner counter (see
       `celebrateVp` in hud.js) launches from the middle of THIS box, so that the
       thing the player is looking at is the thing that moves. `node` is the
       full-width centring wrapper and its middle is the middle of the screen,
       which is only the same point by coincidence. */
    get plate() { return card; },
    show, hide, update,
    get visible() { return hold > 0; },
    destroy() { if (node.parentNode) node.parentNode.removeChild(node); }
  };
}

export default createNotice;
