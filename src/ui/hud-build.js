/**
 * Island Settlers — the four build cards, and the four build chips.
 *
 *   createBuildBar(state, game, { onBuy }) ->
 *     { node, refresh(), flash(kind), ready }
 *   createBuyBar(state, game, { onPick }) ->
 *     { node, refresh(activeKind), flash(kind), countOf(kind) }
 *   buyCount(state, kind) -> how many of `kind` you could buy RIGHT NOW
 *
 * The CARDS are the heads-up display's own bottom-centre row: a live progress
 * meter per purchase, filling from the bottom as `min(have/need)` climbs,
 * showing every required resource as have / need — GREEN-boxed where the pack
 * already covers it, RED-boxed where it does not — and snapping to an
 * unmistakable gold "affordable now" state the moment it is buyable. They are
 * the answer to "how close am I", and they are unchanged.
 *
 * The CHIPS are the new bottom bar of the placement map, and they answer a
 * different question:
 *
 *   "on the bottom of the screen I see a box that has grouped simple visuals
 *    showing in the most clear but visually simple straightforward way, that I
 *    can build for example 3 more roads, or 1 settlement, 0 cities greyed out,
 *    1 development card. And that little box updates, so I can build a road,
 *    click the settlement button and the screen switches to show possible
 *    settlement placements, but I can't click the city button since it's greyed
 *    out if I don't have enough resources."
 *
 * A meter is the wrong shape for that. Standing over the board with a road
 * half-placed, the player is not asking how close they are to a road — they are
 * asking HOW MANY they may still lay before the map has nothing left to offer,
 * and which of the other three they could switch to instead. So a chip is one
 * icon and one count — the name went, see the note where the chip is built —
 * and the count is a whole number of purchases: `x3` roads, `x1` settlement,
 * `x0` cities (hollow, inert, and saying why when asked).
 *
 * `buyCount` is the number behind all of it and is deliberately conservative in
 * three directions at once — resources, pieces left in the box, and somewhere
 * legal to actually put the thing — because a chip that promises three roads
 * and then refuses the second is worse than one that promised one.
 *
 * Owner: UI agent.
 */

import { RES, COST, PIECE_LIMIT } from '../core/constants.js';
import { legalRoads, legalSettlements, legalCities } from '../core/rules.js';
import { el, setText, toggle, replay, setVar, guardTaps } from './dom.js';
import { icon, resIcon } from './icons.js';
import { BUILD_KINDS, progressFor, pieceCapped, hasSomewhere } from './hud-guide.js';

/* Nothing in the interface may draw a resource object smaller than this. */
const COST_ICON_PX = 20;

export function createBuildBar(state, game, hooks = {}) {
  const me = state.players[0];
  const cards = {};
  const row = el('div', { class: 'build-row' });

  for (const b of BUILD_KINDS) {
    const costRow = el('span', { class: 'bc-cost' });
    const chips = {};
    for (const r of RES) {
      const n = COST[b.kind][r];
      if (!n) continue;
      const have = el('b', { text: '0' });
      const chip = el('i', { class: 'cc', 'data-res': r },
        el('span', { class: 'cc-ico', html: icon(resIcon(r), COST_ICON_PX) }),
        el('span', { class: 'ccn' }, have, el('em', { text: String(n) })));
      chips[r] = { node: chip, have, need: n };
      costRow.appendChild(chip);
    }

    const card = el('button', {
      class: 'bcard off', type: 'button', 'data-ui': '', 'data-kind': b.kind,
      'aria-label': b.label,
      on: { click: () => hooks.onBuy && hooks.onBuy(b.kind) }
    },
      el('span', { class: 'bc-fill' }),
      el('span', { class: 'bc-name', text: b.label }),
      el('span', { class: 'bc-row' },
        el('span', { class: 'bc-ico', html: icon(b.ico, 30) }),
        b.vp ? el('i', { class: 'bc-vp', text: '+' + b.vp }) : null),
      costRow,
      el('span', { class: 'bc-lip' })
    );

    cards[b.kind] = { def: b, node: card, chips, ok: null, p: -1 };
    row.appendChild(card);
  }

  /* ------------------------------------------------------------- refresh */
  let readyCount = 0;
  let chimeAt = -99;

  function refresh() {
    let ready = 0;
    const playing = state.phase === 'play';
    let becameReady = false;

    for (const b of BUILD_KINDS) {
      const c = cards[b.kind];
      const pr = progressFor(me.res, COST[b.kind]);
      const capped = pieceCapped(state, 0, b.kind);
      const where = pr.afford ? hasSomewhere(state, b.kind) : true;
      const ok = pr.afford && !capped && where && playing;
      if (ok) ready++;

      // The fill only ever reports affordability, never legality: a player
      // who is two wood short should watch it climb regardless.
      const p = Math.round(pr.p * 100) / 100;
      if (c.p !== p) { c.p = p; setVar(c.node, '--p', (p * 100).toFixed(1) + '%'); }

      if (c.ok !== ok) {
        if (ok && c.ok !== null) { replay(c.node, 'ready', 720); becameReady = true; }
        c.ok = ok;
        toggle(c.node, 'ok', ok);
        toggle(c.node, 'off', !ok);
      }
      toggle(c.node, 'cap', capped || (pr.afford && !where));

      /*
       * EVERY chip reports its own state, not just the worst one.
       *
       *   "I only see one red box around the resource I need ... instead of
       *    seeing the red box around all of the resources I need. ... Can you
       *    make there also be a green box around the resources I have enough."
       *
       * This used to paint `.block` on `pr.blocking` alone — the single
       * resource with the worst ratio — so a settlement with an empty pack put
       * a red box on one of four missing goods and left the other three
       * indistinguishable from goods already banked. Two classes now, applied
       * per chip: `miss` on anything short, `met` on anything covered. Reading
       * the price is reading the colours, with nothing left to infer.
       */
      for (const part of pr.parts) {
        const chip = c.chips[part.res];
        if (!chip) continue;
        /*
         * The `have` half of the fraction is CAPPED AT THE NEED.
         *
         * It is progress toward one purchase, not a bank statement — the
         * resource pill across the top of the screen is the bank statement, and
         * it is the most-read thing in the game. Once a part is covered, `4/4`
         * says the true thing ("this part is paid") and the chip is already
         * green; `12/4` says the same thing in two digits.
         *
         * Which matters because every cost is 1..4, so capping here makes the
         * numerator PERMANENTLY one digit. The number column then never widens,
         * and SETTLEMENT's four chips and CARD's three can never wrap an extra
         * line — which is what was intermittently pushing the cost strip off the
         * bottom of the viewport at both shipping sizes, depending only on
         * whether the player happened to be holding ten of something.
         */
        setText(chip.have, Math.min(part.have, part.need));
        toggle(chip.node, 'met', part.met);
        toggle(chip.node, 'miss', !part.met);
      }
    }

    // One short, quiet chime when something new becomes buildable — never a
    // stack of them, never more than twice in ten seconds.
    if (becameReady && playing && (state.time - chimeAt) > 5) {
      chimeAt = state.time;
      try { game.audio && game.audio.sfx && game.audio.sfx('blip', { gain: 0.55 }); } catch (e) { /* silent */ }
    }

    readyCount = ready;
    return ready;
  }

  /** Shake the card and flag every resource the player is short of. */
  function flash(kind) {
    const c = cards[kind];
    if (!c) return;
    replay(c.node, 'nope', 520);
    const pr = progressFor(me.res, COST[kind]);
    for (const part of pr.parts) {
      const chip = c.chips[part.res];
      if (chip) toggle(chip.node, 'short', !part.met);
    }
    setTimeout(() => {
      for (const r in c.chips) toggle(c.chips[r].node, 'short', false);
    }, 1400);
  }

  return {
    node: row,
    refresh,
    flash,
    cardFor: kind => (cards[kind] ? cards[kind].node : null),
    get ready() { return readyCount; }
  };
}

/* ========================================================== how many more?
 *
 * The one number the build sheet is built out of.
 *
 *   "that I can build for example 3 more roads, or 1 settlement, 0 cities
 *    greyed out, 1 development card"
 *
 * Three ceilings, and the answer is the lowest of them:
 *
 *   RESOURCES   floor(have / need) across every part of the cost, which for a
 *               ROAD is then topped up by `freeRoads`. Free roads are a
 *               SEPARATE CURRENCY, not a discount — a player holding two of
 *               them and not one stick of wood can still lay two roads, and a
 *               player holding two of them and eight wood and eight brick can
 *               lay four. Anything that multiplies or maxes instead of adding
 *               gets one of those two cases wrong.
 *   PIECES      what is physically left in the box: 18 roads, 7 settlements
 *               (cities count against the same seven, because a city is a
 *               settlement that grew), 5 cities.
 *   SOMEWHERE   how many legal spots exist for it this instant. This is what
 *               makes "0 cities" honest for a player who is rich in ore and
 *               wheat but owns no settlement to upgrade — the exact case the
 *               owner used as their example of a greyed chip.
 *
 * The SOMEWHERE cap can UNDER-count, and that is the direction to be wrong in:
 * laying a road usually opens two new edges, so a sheet showing `x1` on the
 * last legal edge may well show `x2` once that road is down. Better a number
 * that grows as the board opens up than one that promises a spot which does not
 * exist. Cards have no board at all, so only the first ceiling applies.
 */
export function buyCount(state, kind) {
  const cost = COST[kind];
  if (!state || !cost || !state.players || !state.players[0]) return 0;
  if (state.phase !== 'play') return 0;
  const p = state.players[0];

  let n = Infinity;
  for (const r of RES) {
    const need = cost[r];
    if (!need) continue;
    n = Math.min(n, Math.floor(Math.max(0, p.res[r] | 0) / need));
  }
  if (!Number.isFinite(n)) n = 0;
  if (kind === 'road') n += Math.max(0, p.freeRoads | 0);

  if (kind === 'card') return Math.max(0, n);

  let pieces = Infinity;
  if (kind === 'road') pieces = PIECE_LIMIT.road - p.roads.size;
  else if (kind === 'settlement') {
    pieces = PIECE_LIMIT.settlement - (p.settlements.size + p.cities.size);
  } else if (kind === 'city') pieces = PIECE_LIMIT.city - p.cities.size;

  let room = 0;
  if (n > 0 && pieces > 0) {
    room = kind === 'road' ? legalRoads(state, 0).length
      : kind === 'settlement' ? legalSettlements(state, 0).length
        : legalCities(state, 0).length;
  }

  return Math.max(0, Math.min(n, pieces, room));
}

/**
 * How many of a road's count are free, for the chip's own gold flag. Kept here
 * beside `buyCount` so the two can never disagree about what a free road is.
 */
export function freeRoadsOf(state) {
  const p = state && state.players && state.players[0];
  return p ? Math.max(0, p.freeRoads | 0) : 0;
}

/**
 * WHY a chip is at nought — in five words, for the chip's own accessible name
 * and its tooltip.
 *
 *   "If a mode has zero legal targets the chip must be DISABLED with a reason,
 *    never selected-and-empty."
 *
 * `buyCount` collapses three separate ceilings into one number, which is right
 * for the number and wrong for the player: "0 cities" because you are two ore
 * short is a shopping problem, and "0 cities" because you own no settlement to
 * upgrade is a board problem, and they are answered by completely different
 * next moves. This picks them apart again in the same order `buyCount` applies
 * them, so the reason it gives is always the ceiling that actually bit.
 */
export function whyNot(state, kind) {
  if (!state || !COST[kind]) return '';
  if (state.phase !== 'play') return 'not while the match is paused';
  const p = state.players && state.players[0];
  if (!p) return '';

  let afford = Infinity;
  for (const r of RES) {
    const need = COST[kind][r];
    if (!need) continue;
    afford = Math.min(afford, Math.floor(Math.max(0, p.res[r] | 0) / need));
  }
  if (!Number.isFinite(afford)) afford = 0;
  if (kind === 'road') afford += freeRoadsOf(state);
  if (afford <= 0) return 'not enough resources';
  if (kind === 'card') return 'no cards left in the deck';

  const pieces = kind === 'road' ? PIECE_LIMIT.road - p.roads.size
    : kind === 'settlement' ? PIECE_LIMIT.settlement - (p.settlements.size + p.cities.size)
      : PIECE_LIMIT.city - p.cities.size;
  if (pieces <= 0) return `no ${kind === 'city' ? 'cities' : kind + 's'} left in the box`;

  return kind === 'road' ? 'nowhere left to lay one'
    : kind === 'settlement' ? 'nowhere far enough from your own'
      : 'no settlement of yours to upgrade';
}

/* ================================================== the four chip silhouettes
 *
 *   "Redraw the four icons as flat silhouettes legible at 14px, and align them
 *    with the game's EXISTING HUD glyphs ... Currently at 12x zoom the ROAD
 *    glyph reads as a backpack or a beehive and CITY reads as a three-bar
 *    chart, not a castle. Test each by blurring at 1.6px — if it does not
 *    survive, it is not done."
 *
 * These are NOT the `icons.js` glyphs, and that is the point. Those are drawn
 * in a 48 box out of eight to sixteen filled paths each, with 2-3 unit ink
 * outlines, cast shadows, lit and shaded wall halves, window panes and a
 * doorknob — which is exactly right at the 30px the HUD build cards draw them
 * at, and turns to porridge at 16. Shrinking a detailed drawing does not make
 * a small drawing; it makes a smudge with the same outline.
 *
 * So each of these is two or three MASSES in a 24 box, no strokes, nothing
 * thinner than about 1.3 units, and the same READING as its HUD twin so a
 * player learns one vocabulary and not two: the road is a plank track running
 * away in perspective, the settlement is a blue-roofed cottage, the city is a
 * turreted keep flying a pennant, the card is a fanned pair with a red seal.
 *
 * The main mass is `currentColor` so a chip's whole state — ready, active,
 * spent — is one `color` on the tile, and the accents carry `data-a` so the
 * disabled rule can mute them without a filter (see ui-build.css).
 */
const ACC = { wood: '#e8a94e', roof: '#5fa8f5', flag: '#ffc93c', seal: '#e8574a' };

const CHIP_ICO = {
  /* Stone kerb, timber deck, three plank gaps. The TAPER is what makes it a
     road and not a ladder, and the RUNGS are what make it a road and not a
     traffic cone — one without the other has been mistaken for both. */
  road:
    '<path d="M7.2 2.6h9.6l3.6 18.8H3.6z" fill="currentColor" opacity=".5"/>' +
    `<path d="M9 4.4h6l2.7 15.2H6.3z" fill="${ACC.wood}" data-a=""/>` +
    '<path d="M8.36 8h7.28l.3 1.7H8.06z" fill="currentColor" opacity=".58"/>' +
    '<path d="M7.58 12.4h8.84l.32 1.8H7.26z" fill="currentColor" opacity=".58"/>' +
    '<path d="M6.8 16.8h10.4l.34 1.9H6.46z" fill="currentColor" opacity=".58"/>',

  /* Pitched roof over a lit box with a doorway. The roof overhangs the walls
     on both sides, which is what keeps it a cottage and not an arrow. */
  settlement:
    `<path d="M12 2.2 22 11.4H2z" fill="${ACC.roof}" data-a=""/>` +
    '<path d="M4.6 11.4h14.8v10.4H4.6z" fill="currentColor"/>' +
    '<path d="M10 15.1h4v6.7h-4z" fill="currentColor" opacity=".28"/>',

  /* Two crenellated towers standing proud of a lower keep, an arched gate
     under it and a pennant over it. Towers TALLER than the middle is what
     stops it reading as a bar chart — a chart never dips in the centre — and
     the gate and the flag settle it. */
  city:
    '<path d="M11.5 1.4h1.5v8.4h-1.5z" fill="currentColor"/>' +
    `<path d="M13 1.7 17.4 3.5 13 5.3z" fill="${ACC.flag}" data-a=""/>` +
    '<path d="M2.2 7.4h2.3V5.9h1.9v1.5h2.3V5.9h1.9v15.9H2.2z" fill="currentColor"/>' +
    '<path d="M13.4 7.4h2.3V5.9h1.9v1.5h2.3V5.9h1.9v15.9h-8.4z" fill="currentColor"/>' +
    /* The gate is a HOLE, not a darker shape: painting ink over a pale keep
       only ever made it paler, and there is no background colour this file is
       allowed to assume — the tile behind it is blue when the chip is ready
       and gold when it is the one the map is showing. `evenodd` cuts it. */
    '<path fill-rule="evenodd" fill="currentColor" opacity=".84" ' +
    'd="M8.4 10.6h1.8V9.2h1.9v1.4h1.8V9.2h1.9v12.6H8.4z' +
    'M10.75 21.8v-2.9a1.35 1.35 0 0 1 2.7 0v2.9z"/>',

  /* A fanned pair with a wax seal. Two overlapping rounded slabs at opposing
     tilts read as "a hand of cards" at any size a phone can show. */
  card:
    '<g transform="rotate(-13 12 13)">' +
    '<rect x="3.4" y="5.4" width="10.6" height="15" rx="1.9" ' +
    'fill="currentColor" opacity=".5"/></g>' +
    '<g transform="rotate(10 13 13)">' +
    '<rect x="9.2" y="3.6" width="11.6" height="16.4" rx="2" fill="currentColor"/>' +
    `<circle cx="15" cy="11.8" r="3.1" fill="${ACC.seal}" data-a=""/></g>`
};

/** The chip glyph, at whatever size the bar is drawing them. */
function chipIcon(kind, size) {
  const body = CHIP_ICO[kind] || '';
  return `<svg class="svg-ico" viewBox="0 0 24 24" width="${size}" height="${size}" ` +
    `aria-hidden="true" focusable="false">${body}</svg>`;
}

/* ================================================= the build sheet's chips */

/**
 * The bar that lives along the bottom of the placement map.
 *
 * WHAT IT REPLACED, and why it is not a second copy of the cards above.
 *
 *   "I'd also like for the cancel and confirm buttons to actually be removed
 *    since the other logic is there already ... so that I have more visual
 *    space to work with on the bottom of the map here."
 *
 * That space used to hold CANCEL, a running label naming the chosen spot, and
 * CONFIRM. All three are gone: the close key in the corner is the cancel, the
 * second tap on a target is the confirm, and the label was describing something
 * the player was already looking at. What stands there now is the only thing
 * the map could not otherwise say — what else you can afford, and how much of
 * it — and it doubles as the way to change what the map is offering.
 *
 * Deliberately NOT the `.bcard` meters: those are four progress bars with eight
 * resource fractions on them, which is a paragraph of reading laid over the
 * board a player is trying to plan on. Four icons and four whole numbers is the
 * same information at the moment of use. Nothing here animates on its own — the
 * map underneath is already breathing, and a bar that pulses in time with it is
 * the "overstimulating" this interface keeps being asked to stop being.
 */
export function createBuyBar(state, game, hooks = {}) {
  const chips = {};
  const row = el('div', { class: 'ovb plate lift hid' });

  for (const b of BUILD_KINDS) {
    const num = el('b', { class: 'ovb-n', text: '0' });
    /* NOT `button()` from dom.js.
     *
     * That helper stamps `.btn`, which is the game's chunky gold lozenge: a
     * 44px minimum, a 5px lip, a gradient and a press-down travel. Four of them
     * across the foot of a 640x320 board is the bar the owner just asked to
     * have taken away. So this is a plain <button> carrying the `data-ui`
     * marker itself — load-bearing, since `#ui *{pointer-events:none}` means
     * anything without it is not tappable at all — and `guardTaps`, which is
     * the other half of `button()`: a click that arrived at the end of a drag
     * across the board is a pan, not a purchase, and is dropped.
     */
    const node = el('button', {
      class: 'ovb-chip', type: 'button', 'data-ui': '', 'data-kind': b.kind,
      'aria-label': b.label,
      on: {
        click: () => {
          if (chips[b.kind].n <= 0) { flash(b.kind); return; }
          if (hooks.onPick) hooks.onPick(b.kind);
        }
      }
    },
      /* NO WORD UNDER THE GLYPH ANY MORE.
       *
       *   "Raise chip label cap height from 5px to about 8px, or drop the
       *    labels entirely and let a legible icon plus the count carry the
       *    chip. At 5px they are noise occupying the bottom third of every
       *    chip."
       *
       * Both roads out were open and they pull opposite ways. A label with an
       * 8px cap height needs an 11px face, which makes SETTLEMENT about 88px
       * of type and the bar a row of four tiles of three different widths —
       * more ink, more width, and less like "grouped simple visuals" than what
       * was there before. Taking the word away instead makes all four tiles
       * the SAME 60x46 square, which is the calmest shape this bar can be, and
       * spends every pixel it saves on the two things a player actually reads
       * at arm's length: a 22px glyph and a 17px number. The word survives
       * where a word is useful — `aria-label` and `title`, both of which say
       * the whole sentence including why a chip is dark.
       *
       * This only works if the glyph is unmistakable, which is why the four in
       * `CHIP_ICO` were redrawn as flat masses rather than shrunk. If a glyph
       * ever stops surviving a 1.6px blur, the label has to come back. */
      el('span', { class: 'ovb-ico', html: chipIcon(b.kind, 22) }),
      el('span', { class: 'ovb-c' }, el('i', { class: 'ovb-x', text: '×' }), num),
      /* Only ever on the road chip, only ever while a card has paid for one.
         See the free-roads note in `refresh`. */
      el('i', { class: 'ovb-flag hid' }));
    guardTaps(node);

    chips[b.kind] = { def: b, node, num, n: -1, on: null, active: null, free: null };
    row.appendChild(node);
  }

  /**
   * Re-read every count and re-dress every chip.
   *
   * `activeKind` is what the map is offering this second, and it gets a gold
   * outline: the bar is a set of four switches, and a switch bank with nothing
   * showing which one is thrown is a puzzle. Everything is compared against
   * what is already painted before it is written, because this runs four times
   * a second for as long as the sheet is up.
   */
  function refresh(activeKind) {
    for (const b of BUILD_KINDS) {
      const c = chips[b.kind];
      const n = buyCount(state, b.kind);
      const on = n > 0;
      const free = b.kind === 'road' && freeRoadsOf(state) > 0;
      const active = b.kind === activeKind;

      if (c.n !== n) {
        /* THE ONE MOMENT THIS BAR IS ALLOWED TO MOVE.
         *
         *   "Add a positive build confirmation. The only feedback in
         *    `build-stayed` is one 10px digit changing 3 to 2 inside a 52x38
         *    chip. A player with three rivals moving will not notice."
         *
         * A count that went DOWN is a purchase that landed, and it is the only
         * event in this interface with no other announcement — the piece
         * appears on a board the player is already looking at somewhere else,
         * and the resource pill is off at the top of the screen. So the tile
         * takes one short bounce with a gold wash under it. Only on the way
         * down: a count going UP is a rival's road opening an edge or a hex
         * coming back, neither of which is anything this player did, and a
         * bar that jumped at those would be the "overstimulating" the whole
         * sheet is built against. `c.n < 0` is the first paint. */
        if (c.n > n && c.n >= 0) replay(c.node, 'tick', 620);
        c.n = n;
        setText(c.num, String(n));
      }
      if (c.on !== on) {
        c.on = on;
        toggle(c.node, 'off', !on);
        // A greyed chip is not merely dim, it is inert: `disabled` is what
        // keeps a stray thumb from opening a map with nothing on it, and it is
        // what a screen reader reads as "unavailable".
        if (c.node.disabled !== undefined) c.node.disabled = !on;
      }
      if (c.active !== active) { c.active = active; toggle(c.node, 'on', active); }
      if (c.free !== free) {
        /* FREE ROADS ARE SAID, NOT HINTED.
         *
         *   "`build-freeroads-640x320.png` is visually identical to a normal
         *    road build despite the count being card-granted free roads. Say
         *    so."
         *
         * The gold number was the whole tell, and gold is also what the ACTIVE
         * chip is dressed in, so on the one screen where both are true — which
         * is every screen a Road Building card produces — the tell said
         * nothing. A word does. */
        c.free = free;
        toggle(c.node, 'free', free);
        const flag = c.node.querySelector('.ovb-flag');
        // The word is WRITTEN when it is true rather than hidden when it is
        // not: a hidden node still carries its text, and every rig that reads
        // a chip's `textContent` was getting "x3FREE" off a chip with no free
        // roads anywhere near it.
        setText(flag, free ? 'FREE' : '');
        toggle(flag, 'hid', !free);
      }

      // The whole sentence, because the chip itself is now one glyph and one
      // number: what it is, how many, and — the part a dark chip could not say
      // before — WHICH of the three ceilings is the one holding it at nought.
      const label = n === 0
        ? `${b.label} — ${whyNot(state, b.kind) || 'not available'}`
        : `Build ${b.label.toLowerCase()} — ${n} affordable${free ? ', free roads in hand' : ''}`;
      if (c.node.getAttribute('aria-label') !== label) {
        c.node.setAttribute('aria-label', label);
        c.node.setAttribute('title', label);
      }
    }
  }

  /** The refusal: a short shake, no sound, no toast. The chip is already grey. */
  function flash(kind) {
    const c = chips[kind];
    if (c) replay(c.node, 'nope', 420);
  }

  return {
    node: row,
    refresh,
    flash,
    countOf: kind => (chips[kind] ? chips[kind].n : 0),
    chipFor: kind => (chips[kind] ? chips[kind].node : null)
  };
}

export default createBuildBar;
