/**
 * Island Settlers — the maritime trade sheet.
 *
 *   createTradeSheet(state, game, { onClose }) ->
 *     { node, open(portId), sync(), key(code), close, get ready }
 *
 * ---------------------------------------------------------------------------
 * WHAT YOU WANT SITS ON TOP, AND UP MEANS "INTO MY PACK"
 * ---------------------------------------------------------------------------
 *
 *   "I think the 'you give' and 'you receive' should swap sides, with the 'you
 *    receive' on the top. Since basically how many resources I have is in the
 *    middle, so if I click the up arrow, that should mean that I'm adding that
 *    many resources to my stockpile."
 *
 * The row of five cards is unchanged and so is the shape of it — an arrow above
 * each card, an arrow below — but both lanes have swapped ends, and with them
 * the meaning of every arrow on the sheet. YOU RECEIVE is the green band across
 * the top now and YOU GIVE the brown band along the bottom, so the sheet reads
 * the way the sentence in the owner's head reads: this is what I want, and this
 * is what it costs me.
 *
 * That is not decoration. The number in the middle of a card is HOW MANY YOU
 * HOLD, and the old sheet had the up arrow above that number taking cards away
 * from it — an arrow pointing up, out of your own pile, standing for a loss.
 * Every single tap had to be translated. Now the arrow that points up at the
 * green band adds to the pile it is sitting on and the arrow that points down
 * at the brown band takes from it, which is what the geometry was saying all
 * along.
 *
 * And the pile ANSWERS. Press up four times on brick and the brick card reads
 * `0 -> 4`; tap wood to pay for it and the wood card reads `40 -> 24`. The two
 * numbers that define the deal are the two biggest numbers on the sheet, in the
 * slot the eye was already resting on. They used to be 11px badges riding the
 * arrows — smaller than the five inert counts they were competing with — which
 * is the review that killed that arrangement:
 *
 *   "The two numbers that define the trade are the SMALLEST type on the sheet,
 *    smaller than five inert 8s. Show the ask in the card's primary numeral as
 *    a delta (0 -> 4) and the cost likewise (40 -> 24). This is also literally
 *    what the owner asked for."
 *
 * Which is why the arrows carry no counters at all now. A number on an arrow
 * was also a number on a control that goes dead the moment the deal balances —
 * the give arrow under a committed payer has nothing left to do — and a live
 * figure sitting on a greyed-out button reads as a payment you cannot take
 * back. On the card it reads as a pile that changed, which is what it is.
 *
 * The staging model is still ONE SIGNED NUMBER PER RESOURCE, with the sign
 * turned over to match:
 *
 *      stage[r] > 0   you are RECEIVING stage[r] cards of r        (up)
 *      stage[r] < 0   you are GIVING -stage[r] lots of r,
 *                     each lot costing ratio[r] of it              (down)
 *      stage[r] = 0   it is sitting in the middle, untouched
 *
 * Up is +1 and Down is -1, always — the invariant survived the flip, which is
 * why the flip is small. The same key stages and un-stages, a resource can
 * never be on both sides of one deal (so no exchange is illegal by
 * construction), and there is no mode to be in.
 *
 * ---------------------------------------------------------------------------
 * ASK FIRST, THEN CHOOSE WHO PAYS
 * ---------------------------------------------------------------------------
 *
 *   "I can click upwards (to add) to how many of an item I want to trade for —
 *    let's say I have 0 brick, I click the up arrow four times to add 4 brick to
 *    the trade I want to make."
 *
 * The old sheet could not do this. It made you stage the GOODS first and only
 * then let you name what they bought, because the receive arrows were dead
 * until something had paid for them. Asking for four brick you do not own was
 * the one thing it refused, and asking for what you do not own is the entire
 * reason anyone walks to a trading post.
 *
 * So the order is reversed and the two rules are the mirror of what they were:
 *
 *   up (receive)  is free — you may ask for anything you could conceivably pay
 *                 for. The cap is the honest one: the total number of cards the
 *                 pack could still buy, counting every resource EXCEPT the ones
 *                 you are already asking for, because a resource on the receive
 *                 side is not a resource you can hand over. Ask past that and
 *                 the arrow greys, so the sheet never lets you build a deal
 *                 that has no possible payer.
 *   down (give)   needs an unpaid card above it, and enough left in the pack for
 *                 one more lot. Before you have asked for anything, every down
 *                 arrow is grey — and the brown band says "Ask above first",
 *                 because a whole row of grey with no reason given is the one
 *                 way this could read as broken.
 *
 * Going back towards zero is always allowed in both directions. Undo is never
 * blocked, which is also why over-paying is possible for exactly one moment —
 * un-ask a card you had already covered and the green band says "Take 1 more"
 * rather than silently discarding a lot you staged.
 *
 * ---------------------------------------------------------------------------
 * THE MIDDLE BUTTON PAYS AS MUCH OF IT AS THAT PILE CAN
 * ---------------------------------------------------------------------------
 *
 *   "But if I have 16 wood or more, and I'm trying to trade to receive 4 brick,
 *    I can click the middle button with the image of the wood itself, and that
 *    automatically knows I want to trade the exact amount of wood it takes...
 *    let's say I need 4 ore, I press the up arrow to receive ore 4 times, then I
 *    have 28 sheep (more than enough), I click the sheep image/middle button,
 *    and it automatically takes the same effect that pressing the down arrow
 *    below the sheep button 4 separate times would have done."
 *
 * The card was already a button — it moved the keyboard cursor, which is worth
 * about nothing to a thumb. It is the one-tap payer now, and it is defined as
 * exactly that sentence: N presses of the down arrow underneath it. Nothing new
 * happens; a slow route is simply available in one tap, which means it can never
 * disagree with the slow route.
 *
 * AND N IS "AS MANY AS THIS PILE CAN MANAGE", NOT "ALL OF THEM OR NONE". That
 * distinction cost this sheet a whole review, because getting it wrong switches
 * the feature off in the one case the owner used to describe it:
 *
 *   "In the ask3 frame all five cards sample inert tan with an empty plate slot,
 *    even though every pile of 8 is a perfectly legal contribution toward the
 *    12. This kills the owner's own headline example. He wrote 'trade 8 wood and
 *    8 sheep for 4 brick' — a cost of 16 against two piles of 8. No single pile
 *    covers it, so that exact trade opens in precisely this state, with every
 *    card dead and the one-tap payer withheld."
 *
 * So a pile offers what it has: `payOffer` is min(what the ask still owes, what
 * the pile can find), the plate carries THAT number — PAY 8 on a pile of eight
 * against a bill of twelve — and the tap pays it. Three brick out of a pack of
 * eights is now tap wood, tap sheep. Two taps, the second of which is the
 * owner's own mixed payment, where it used to be twelve presses of an arrow.
 *
 * The plate never lies about the size of what it does: read against the NEEDS 12
 * standing in the band directly underneath it, PAY 8 is visibly a part payment
 * without the sheet having to find room for the word "part".
 *
 * WHAT "THE EXACT AMOUNT" MEANS WHEN THE ASK IS MIXED. Ask for two brick and
 * two ore, then tap wool: you get four lots of wool, 4 x ratio[wool]. The price
 * of a lot is set by WHAT YOU HAND OVER and never by what you get back —
 * `activeTradeRatio(state, pid, give, port)` takes the give resource and nothing
 * else — so one lot of wool buys one card whatever that card happens to be, and
 * "the exact amount it takes" is the whole outstanding ask, not the share of it
 * belonging to any one resource. The alternative — make the button pay only for
 * the largest single ask, or ask the player which line it applies to — invents a
 * per-line bookkeeping the rules layer does not have and would leave the deal
 * half paid after a tap that says it pays for it. Rejected.
 *
 *   "The other middle tiles for the resources start to grey out (unless I have
 *    enough of that resource to make the trade), so I could click the down
 *    arrows on items I have at least four of, to let's say trade 8 wood and 8
 *    sheep for 4 brick."
 *
 * ---------------------------------------------------------------------------
 * WHAT DIMS, AND WHAT THE FIRST PASS GOT WRONG ABOUT IT
 * ---------------------------------------------------------------------------
 *
 * The first version of this greyed a card the moment it could not cover the
 * WHOLE ask on its own, and a reviewer took it apart with the owner's own
 * sentence:
 *
 *   "He wrote 'trade 8 wood and 8 sheep for 4 brick' — a MIXED payment from two
 *    piles, neither of which covers the full cost. Your rule makes that exact
 *    trade look forbidden. Light any resource the player holds at least one lot
 *    of; reserve dimming for piles that genuinely cannot contribute."
 *
 * Which is right, and it was right in a way that mattered: eight of everything
 * is the pack a real player walks in with, and asking for three brick out of it
 * greyed all five cards while every give arrow underneath stayed bright. The
 * card said no and the button under it said yes.
 *
 * So dimming is now ONE FACT ABOUT THE PACK, not about the size of the ask:
 *
 *      dim   you do not hold a single lot of this. It cannot pay for anything
 *            at this post, today, at any ask — held < ratio, full stop.
 *
 * It never moves as you ask for more, it always agrees with the give arrow
 * under it, and the mixed payment the owner described is simply five lit cards
 * and five live arrows, which is what it always should have looked like.
 *
 * ARMED is the separate, additive state: tapping this pile right now would put
 * something in, and here is exactly how much. It is not the opposite of dim and
 * it is not a highlight — it is a gold pressable plate carrying the verb and the
 * price, "PAY 16", because the marquee feature of this sheet shipped once
 * already as a cream tile that gave no sign it could be pressed:
 *
 *   "This was the owner's marquee request and it currently ships as an easter
 *    egg: the card is a passive cream tile with an icon and a numeral, no verb,
 *    no press affordance."
 *
 * Once a pile is committed the same plate turns into CLEAR, in the same slot,
 * and takes the whole payment back out in one tap. One slot, one plate, two
 * words — the price chip used to be a corner badge that jumped forty pixels
 * across the card between those two states, which is the sort of thing nobody
 * consciously notices and everybody has to re-read the sheet after.
 *
 * CLEAR IS NOT THE ONLY WAY BACK OUT. A committed pile can also be trimmed one
 * lot at a time, and the control for that is the arrow ABOVE it — which is not
 * a strange place for it to be, because taking a lot back out of the give lane
 * puts those cards back in your pack, and up has meant "into my pack" since the
 * flip. The arrow underneath is correctly dead once the deal balances: one more
 * lot down there would buy nothing. What that arrangement was missing was
 * anything saying so out loud, so the up arrow over a paying pile now reads
 * "Take back one Wool lot" rather than "Receive Wool", which was simply the
 * wrong sentence over a card that is spending wool.
 *
 * ---------------------------------------------------------------------------
 * AND THE BAND SAYS WHAT IT COSTS
 * ---------------------------------------------------------------------------
 *
 *   "The price of the deal is currently only ever inferable: in the ask frame
 *    you read it off the PAY plates, in the mixed frame you must mentally add
 *    CLEAR 8 + CLEAR 4, and in trade-960x444-ask3.png the number 12 appears
 *    NOWHERE on the sheet — the header says 4:1, the card says 8 -> 11, and
 *    that is all."
 *
 * So the brown band carries a running total at its left-hand end, facing the
 * tip at its right: NEEDS 12 before anything pays, 8 OF 12 part-way, 12 OF 12
 * when the deal is covered. It is arithmetic the sheet was making the player do
 * — ratio times cards asked, minus whatever is already staged — and the worst
 * case for it is the commonest one, the eight-of-everything pack asking for
 * three brick, where no pile can cover twelve alone so NOTHING arms and there
 * is no plate anywhere on the sheet quoting a price at all.
 *
 * Both halves come out of the live rates. `paidSoFar` sums each committed pile
 * at ITS OWN rate, and the unpaid remainder is quoted at the cheapest rate
 * still able to finish (see `quoteRatio`), which is the only defensible single
 * number at a dock where the row does not all charge the same.
 *
 * ---------------------------------------------------------------------------
 * ONE RING, ONE MEANING
 * ---------------------------------------------------------------------------
 *
 * GOLD RING = THIS CARD IS PAYING. It is on a card that could pay in one tap
 * and on a card that already is, and the WEIGHT is the difference: a committed
 * payer carries the full gold collar, a card merely offering to pay carries the
 * hairline and its plate. One hue, one meaning, and the weight tracks how far
 * into the deal the pile actually is —
 *
 *   "The ask frame fires four gold rings plus four identical PAY plates —
 *    eight equal-weight gold calls to action at once — while the card the
 *    player actually acted on is the quietest thing on the sheet."
 *
 * — which is what a row of eights asking for two brick does: every other pile
 * can settle it alone, so every other pile offers. Four offers are honest; four
 * offers shouting as loudly as a commitment are not.
 *
 * Nothing else on the sheet is ever ringed: the card you are asking for takes a
 * mint fill and a green lip, and the keyboard cursor is a dotted outline that
 * could not be mistaken for a state if it tried. The first pass had gold and
 * cobalt swapping between the two states of the SAME card, which meant the ring
 * signified nothing.
 *
 * The rate is quoted once, in the header, next to the name of the post. Five
 * copies of `4:1` down a row where the rate is the same on every card is five
 * copies of one fact; a card only carries its own rate when it DIFFERS from the
 * headline, which is exactly the 2:1 dock a player crossed the island for.
 *
 *   left / right   move between cards
 *   up / down      ask for one more / pay with one more lot (and back out)
 *   space          pay for the whole ask with the resource under the cursor,
 *                  or take that payment back out again
 *   Enter          do the deal — the sheet stays open for the next one
 *   Escape         close. So does the X, and a tap outside.
 *
 * Every keyboard route has a pointer equivalent: both arrows are real buttons,
 * and the card is the one-tap payer as well as the cursor.
 *
 * Owner: UI agent.
 */

import { RES, RES_LABEL, TRADE_BASE } from '../core/constants.js';
import { activeTradeRatio, doTrade } from '../core/rules.js';
import { ports } from '../board/layout.js';
import { el, button, toggle, setText } from './dom.js';
import { icon, resIcon } from './icons.js';

/* Resource art on a card. Never under 20px (see the mobile constraints); the
   short-viewport rule in ui.css scales the same SVG down to 26. */
const ICON_PX = 32;

export function createTradeSheet(state, game, opts = {}) {
  const me = state.players[0];
  const requestClose = opts.onClose || (() => {});

  /** Signed staging, one entry per resource. See the header. */
  const stage = {};
  for (const r of RES) stage[r] = 0;

  let portId = null;
  let focus = 0;
  let ready = false;
  /* What the foot button was last painted as. See the note where it is built:
     the paint is written only on a change, because this refresh runs at 5Hz and
     rewriting a class every sync cancels a press already in flight. */
  let wasReady = null;
  /* A refusal that came back from the rules layer on the last confirm. It is
     shown once, in the give band, and cleared by the next thing the player
     does. It used to be written into a `why` element that was deleted with the
     foot's block of prose two changes ago, which left `confirm()` throwing a
     ReferenceError on the one path where a trade is refused — the path nobody
     exercises until the day it matters. */
  let refusal = '';

  /* ---------------------------------------------------------------- markup */

  const where = el('span', { class: 'tr-where', text: 'Great Market' });
  /* THE RATE, ONCE. It used to be stamped on all five cards, which at the Great
     Market is the same three characters printed five times down a row — five
     copies of one fact, competing for the corner of a card that now has a price
     and a verb to put there. It belongs beside the name of the post, because it
     is a property of the POST; a card only carries its own rate when that rate
     disagrees with this one, which is precisely the 2:1 dock somebody crossed
     the island to stand on. */
  const headRate = el('b', { class: 'tr-headrate', text: `${TRADE_BASE}:1` });
  /* The match genuinely stops while this sheet is up — main.js holds the clock,
     the bots, the gathering and the settler on any open in-play sheet, so a
     rival cannot Knight the player out of half their pack mid-exchange. Said
     out loud, because a safety the player cannot see is a safety they still
     have to hurry against. */
  const paused = el('span', { class: 'tr-paused' },
    el('i'), el('span', { text: 'Match paused' }));
  const closeBtn = button('cbtn small ghost x', {
    'aria-label': 'Close', on: { click: () => requestClose() }
  }, el('span', { class: 'cb-ico', html: icon('close', 18) }));

  const row = el('div', { class: 'tr-row' });
  const cells = {};

  /*
   * TAPPING FAST HAS TO COUNT.
   *
   *   "Can you make it so I can press the up and down arrows in a much quicker
   *    succession inside of the trading post — since I'm typically going and
   *    clicking so quickly, but right now it's not registering."
   *
   * The arrows ran on `click`, and `click` is the slowest and most cancellable
   * event a touch screen produces. It is synthesised after the finger leaves,
   * it is withheld while the browser decides whether a fast second tap was a
   * gesture, and — the one that actually bit here — it is DROPPED if anything
   * disables the button between the finger landing and lifting. `sync()` runs
   * on every stage and again on panels.js's 5Hz refresh, and it was writing
   * `disabled` unconditionally on all ten arrows every time, so a press could
   * be voided by a repaint that changed nothing.
   *
   * So a press is a POINTERDOWN now: it fires the instant the finger lands,
   * before any of that can happen to it. Holding repeats — 320ms, then every
   * 90ms — because staging eight lots should not be eight taps. `click` is
   * still wired for the keyboard (Enter on a focused arrow), and ignores
   * itself for 700ms after a pointer press so one tap is never counted twice.
   *
   * This applies to the ARROWS ONLY, and deliberately not to the card. A card
   * tap now spends the whole outstanding ask in one go, so it is the one
   * control on the sheet where firing early on a finger that turns out to be
   * going somewhere else would be expensive rather than merely wrong. `click`
   * gives that tap its confirmation for free, and unlike an arrow nobody ever
   * needs to hit it eight times in a row.
   */
  const HOLD_FIRST = 320;
  const HOLD_EVERY = 90;

  function pressable(btn, fire) {
    let delay = 0, tick = 0, lastPointer = 0;
    const stop = () => {
      if (delay) { clearTimeout(delay); delay = 0; }
      if (tick) { clearInterval(tick); tick = 0; }
    };
    btn.addEventListener('pointerdown', ev => {
      if (ev.button > 0 || btn.disabled) return;
      lastPointer = Date.now();
      // The press itself, immediately — nothing downstream can take it back.
      fire();
      stop();
      delay = setTimeout(() => {
        tick = setInterval(() => {
          // A repeat stops the moment the arrow can no longer legally move,
          // so holding never queues up presses against a dead control.
          if (btn.disabled) { stop(); return; }
          fire();
        }, HOLD_EVERY);
      }, HOLD_FIRST);
      /* Capture, so lifting off the edge of a 38px plate still ends the hold —
         and so a slide off the arrow does not become a drag on the island. */
      try { btn.setPointerCapture(ev.pointerId); } catch (e) { /* older Safari */ }
      ev.preventDefault();
    });
    for (const t of ['pointerup', 'pointercancel', 'pointerleave', 'lostpointercapture']) {
      btn.addEventListener(t, stop);
    }
    btn.addEventListener('click', () => {
      // Keyboard only. A pointer press has already been counted.
      if (Date.now() - lastPointer < 700) return;
      fire();
    });
  }

  RES.forEach((r, i) => {
    /* The labels name the LANE the arrow feeds, not the direction it points:
       a screen reader reading "Receive Wood" over the top arrow is being told
       the same thing the green band above it tells everyone else.

       NO COUNTERS ON THE ARROWS. They carried the staged amount for two years
       and it was always the wrong home for it: an 11px badge, smaller than the
       inert pile counts it was competing with, riding a control that goes dead
       the moment the deal balances. The amounts live on the card now, at the
       size the deal deserves, and the arrows are one job each again. */
    const up = el('button', {
      class: 'tr-arr up', type: 'button', 'data-ui': '',
      'aria-label': `Receive ${RES_LABEL[r]}`
    });
    pressable(up, () => { focus = i; step(r, 1); });

    const dn = el('button', {
      class: 'tr-arr dn', type: 'button', 'data-ui': '',
      'aria-label': `Give ${RES_LABEL[r]}`
    });
    pressable(dn, () => { focus = i; step(r, -1); });

    /* Only ever shown when this card's rate DISAGREES with the headline rate in
       the sheet's title bar — which at the Great Market is never, and at a 2:1
       dock is exactly the one card the player walked here for. */
    const rate = el('span', { class: 'tr-rate', text: '' });

    /* THE PILE, AND WHAT THE DEAL DOES TO IT. `was` is what you hold and only
       appears once something is staged; `now` is what you would be left with,
       and it is the biggest thing on the card in every state. Untouched, the
       two collapse to the plain count. */
    const was = el('i', { class: 'tr-was', text: '' });
    const now = el('em', { class: 'tr-now', text: '0' });
    const count = el('b', { class: 'tr-count' }, was, now);

    /* The action plate, in a slot that is reserved whether or not it has
       anything in it, so that a card arming or a payment landing never moves
       anything else on the card by a pixel. */
    const act = el('span', { class: 'tr-act' }, el('u', { text: '' }));

    const card = el('button', {
      class: 'tr-card', type: 'button', 'data-ui': '', 'data-res': r,
      'aria-label': RES_LABEL[r],
      on: { click: () => { focus = i; payAll(r); } }
    }, rate,
       el('span', { class: 'tr-face' },
         el('span', { class: 'tr-ico', html: icon(resIcon(r), ICON_PX) }), count),
       act);

    const col = el('div', { class: 'tr-col', 'data-res': r }, up, card, dn);
    cells[r] = {
      col, up, dn, rate, was, now, count, card, act, actLab: act.firstChild,
      label: null, rateTxt: null, upLab: null
    };
    row.appendChild(col);
  });

  /* THE TWO LANES, AND THE ONLY LIVE LINE LEFT ON THE SHEET.
   *
   *   "Can you make the YOU GIVE and YOU RECEIVE sections larger as well and
   *    more clearly marked — maybe with larger text and colored areas above and
   *    below. You can remove the arrow directions and all of that text on the
   *    bottom left side."
   *
   * They were two 8.5px grey captions, which is the same weight as a footnote
   * for the one fact that makes the whole sheet legible. They are bands now —
   * and since the flip it is GREEN ABOVE, BROWN BELOW, receive over give, each
   * band still sitting on the side of the row its arrows point at. The colours
   * did not move with the words: green has always meant "arrives", brown "leaves
   * your pack", on the badges and on the staged cards as well as here, so a
   * player who learned the palette before the flip still reads it correctly
   * after it.
   *
   * The live line rides in the band it applies to, and the band is the only
   * place the sheet ever says anything in words. It is blank most of the time:
   * the greying is the primary signal and it is visible from across the room.
   *
   * IT IS PARKED, NOT IN THE FLOW. It used to sit between the band's title and
   * the band's trailing chevron, so the title visibly slid sideways every time
   * the message appeared or changed — a wobble nobody consciously sees and
   * everybody has to re-read the sheet after. It hangs off the right-hand end
   * now and the title never moves. It is also drawn as a TIP rather than as a
   * stamp: a pale wash on the band's own colour, because the version painted in
   * black at 26% opacity read as the disabled badge on a broken control, which
   * is the exact opposite of what "here is what to do next" should look like. */
  const giveLive = el('i', { class: 'tc-live', text: '' });
  const getLive = el('i', { class: 'tc-live', text: '' });
  /* THE PRICE OF THE DEAL, AS A NUMBER, WHERE THE PRICE IS PAID.
   *
   *   "In the ask frame you read the cost off the PAY plates; in the mixed
   *    frame you have to mentally add CLEAR 8 + CLEAR 4; and in the ask3 shot
   *    the number 12 appears NOWHERE on the sheet — the header says 4:1, the
   *    card says 8 -> 11, and that is all."
   *
   * Which is true and was the worst of it: ask for three brick out of a pack of
   * eights and nothing arms, so there is no plate anywhere carrying a price,
   * and the one number the player needs — how much this costs — had to be
   * worked out from a ratio and a delta. It rides at the LEFT end of the brown
   * band now, opposite the tip, and it counts:
   *
   *      NEEDS 12    you have asked, nothing is paying yet
   *      8 OF 12     one pile is in, one more lot to find
   *      12 OF 12    covered — and the Trade button lights on the same beat
   *
   * Parked absolutely, like the tip it faces, so the band's own title never
   * moves when the number appears or changes width. Blank until something is
   * staged, because a sheet nobody has touched has no price. */
  const giveCost = el('i', { class: 'tc-cost', text: '' });
  const capGive = el('span', { class: 'tr-cap give' },
    giveCost, el('b', { text: 'You give' }), giveLive);
  const capGet = el('span', { class: 'tr-cap get' },
    el('b', { text: 'You receive' }), getLive);
  /*
   * ONE BUTTON, TWO JOBS, AND NEVER A DEAD ONE.
   *
   *   "Instead of having a greyed out trade button, could it just be a different
   *    coloured and labelled button until it's a valid trade — like before, it's
   *    grey and says cancel or clear or something, then when it's a valid trade
   *    it shows up as the green trade button."
   *
   * The foot of this sheet spent most of its life switched off, which is the
   * one state a full-width button at the bottom of a modal should never be in:
   * it is the biggest thing on the panel and it was saying nothing except "not
   * yet". Now it always does something. While the deal is incomplete it is a
   * stone CLEAR that empties the staging and gives the player their one-tap way
   * back out of a half-built trade; the moment the deal balances it turns into
   * the green TRADE. The label, the colour and the icon all change together, so
   * there is no state where the words and the paint disagree.
   *
   * `disabled` is gone from it entirely. The only time it truly cannot act is
   * when nothing is staged AND nothing is asked — and then CLEAR clearing an
   * empty sheet is a harmless no-op, which is a better answer than a grey slab.
   */
  const tradeIco = el('span', { class: 'sb-ico', html: icon('swap', 22) });
  const tradeLab = el('span', { class: 'sb-lab', text: 'Clear' });
  const tradeBtn = button('big stone', {
    'aria-label': 'Clear the trade', on: { click: () => (ready ? confirm() : clearAll()) }
  }, tradeIco, tradeLab);

  /* Document order IS the interaction order: receive band, row, give band. The
     uishot trade stage asserts it from the DOM rather than from the pixels,
     because a `column-reverse` that puts the right band on top for a sighted
     player would leave a screen reader and the tab order reading the sheet
     backwards, and that is the version of "receive on top" nobody wants. */
  const node = el('div', { class: 'sheet trade hid' },
    el('div', { class: 'sheet-head' },
      el('span', { class: 'sheet-title', text: 'Trade' }), where, headRate,
      paused, closeBtn),
    el('div', { class: 'trade-body' }, capGet, row, capGive),
    el('div', { class: 'sheet-foot' }, tradeBtn));

  /* ----------------------------------------------------------------- rates */

  /** What this post charges for giving away `r`, ignoring where the settler is. */
  function rateFor(r) {
    if (portId === null) return TRADE_BASE;
    return activeTradeRatio(state, 0, r, portId) || TRADE_BASE;
  }

  /**
   * The five live rates plus whether trading is possible at all.
   *
   * THE SHEET NEVER ASSUMES FOUR. The rate is 4 at the Great Market, 3 at a
   * generic dock the player has unlocked and 2 at a matching special one, and
   * the server recomputes all of it on its own copy of the state — so every
   * number on this sheet, the one-tap price included, is read back out of
   * `economy.quote()` whenever it is attached and out of `activeTradeRatio`
   * when it is not. A hard-coded 4 anywhere in here is a sheet that lies at
   * exactly the dock the player walked across the island to use.
   */
  function rates() {
    const out = { ok: true, label: null, reason: '', ratio: {} };
    const eco = game && game.economy;
    if (eco && typeof eco.quote === 'function') {
      for (const r of RES) {
        let q = null;
        try { q = eco.quote(r); } catch (e) { q = null; }
        if (!q) { out.ratio[r] = rateFor(r); continue; }
        out.ratio[r] = q.ok ? (q.ratio || rateFor(r)) : rateFor(r);
        if (!out.label && q.label) out.label = q.label;
        if (!q.ok) { out.ok = false; out.reason = q.reason || ''; }
      }
      return out;
    }
    for (const r of RES) out.ratio[r] = rateFor(r);
    return out;
  }

  /* --------------------------------------------------------------- staging */

  const cardsTaken = r => Math.max(0, stage[r]);
  const lotsGiven = r => Math.max(0, -stage[r]);
  const totalGet = () => RES.reduce((s, r) => s + cardsTaken(r), 0);
  const totalGive = () => RES.reduce((s, r) => s + lotsGiven(r), 0);
  /** Cards asked for that nothing has paid for yet. The whole sheet turns on it. */
  const owed = () => totalGet() - totalGive();

  /**
   * How many more cards this pack could pay for in total.
   *
   * `skip` is the set of resources that are off the table as payers because
   * they are on the receive side of this deal — you cannot buy wool with wool.
   * This is what stops the up arrow from letting a player build an ask that has
   * no possible payer: a request nobody can fill is not a kindness, it is a
   * dead sheet with a grey Trade button and no explanation.
   */
  function payCapacity(R, skip) {
    let n = 0;
    for (const r of RES) {
      if (skip && skip.has(r)) continue;
      const ratio = R.ratio[r] || TRADE_BASE;
      n += Math.floor((me.res[r] | 0) / ratio);
    }
    return n;
  }

  /**
   * May this arrow move? `dir` is +1 for up (ask for one more) and -1 for down
   * (hand over one more lot). Coming back towards zero is always allowed —
   * undo must never be blocked.
   */
  function canStep(r, dir, R) {
    if (!R.ok) return false;
    if (state.phase !== 'play') return false;
    /*
     * IT WORKS FROM EITHER END NOW.
     *
     *   "The trading should work the other way too, where I can start the trade
     *    by also clicking the down arrow and it works the opposite way, where I
     *    can then hit the remaining icons for the other resources to pick up
     *    those resources in bulk, or I can click the up arrows to receive those
     *    resources up to the amount that I'm able to based on what I'm giving
     *    away. So if I start by pressing up to gain, then I'm limited with how
     *    many presses down on the other resources I can press to give. But if I
     *    start by pressing down to give, I'm limited in the amount of up arrow
     *    presses I can do to receive."
     *
     * The sheet used to insist on one order. `owed() < 1` refused every give
     * arrow until something had been asked for, so a player who thought "I have
     * far too much wood, what can I get for it" met five dead controls and no
     * explanation. There was never a rule requiring that order — `stage` is
     * signed and the confirm only cares that the two sides balance — it was
     * just the order the sheet happened to be written in.
     *
     * Both directions now say the same thing in their own terms: you may take
     * one more step if the deal that step creates is still PAYABLE. Going up,
     * payable means the lots already staged plus what the untouched piles could
     * still find. Going down, payable means you actually hold another full lot.
     * Which produces the limits he describes without either side being special:
     * ask first and the gives are capped by the ask, give first and the asks are
     * capped by the gives plus whatever else the pack could add.
     */
    if (dir > 0) {
      if (stage[r] < 0) return true;                    // un-stage a give
      const skip = new Set(RES.filter(q => stage[q] > 0));
      skip.add(r);
      // Lots already committed count toward the ask; the rest has to be findable
      // in the piles nobody is receiving. This is the only line that had to
      // change for give-first to work — without it, staging four wood and then
      // asking for the brick it pays for was refused, because the wood was no
      // longer in `payCapacity` and its lots were not credited anywhere.
      return totalGet() + 1 <= totalGive() + payCapacity(R, skip);
    }
    if (stage[r] > 0) return true;                      // un-stage an ask
    const ratio = R.ratio[r] || TRADE_BASE;
    return (me.res[r] | 0) >= ratio * (lotsGiven(r) + 1);
  }

  /**
   * WHAT ONE TAP ON THIS CARD WOULD ACTUALLY PAY: as many lots as the ask still
   * owes, or as many as the pile can find, whichever runs out first.
   *
   * It used to be all-or-nothing — a pile that could not settle the whole
   * outstanding ask on its own offered nothing at all, showed no plate, and its
   * tap buzzed. Which switched the marquee feature off in precisely the case
   * the owner used to describe it:
   *
   *   "In the ask3 frame all five cards sample inert tan with an empty plate
   *    slot, even though every pile of 8 is a perfectly legal contribution
   *    toward the 12. This kills the owner's own headline example — 'trade 8
   *    wood and 8 sheep for 4 brick' is a cost of 16 against two piles of 8, so
   *    that exact trade opens in this state with every card dead and the
   *    one-tap payer withheld. The feature he asked for most is switched off in
   *    the case that needs it most."
   *
   * So the offer is a PART payment now, and the plate says which part: PAY 8 on
   * a pile of eight against a bill of twelve, and tapping it pays eight. Three
   * brick out of a pack of eights is tap wood, tap sheep — two taps, and the
   * second one is the owner's mixed payment — where it used to be twelve
   * separate presses of an arrow.
   *
   * Nothing about the slow route changes and nothing new happens: this is still
   * exactly N presses of the give arrow underneath, and N is now "as many as
   * this pile can manage" rather than "all of them or none". The promise on the
   * plate and the payment the tap makes come out of this one function, so they
   * cannot disagree.
   *
   * A pile that is ALREADY committed offers nothing — a committed card's tap is
   * the take-back, and a control that means two different things depending on a
   * number nobody is looking at is worse than a control that means one. Topping
   * a part-payment up is the give arrow underneath, one lot at a time.
   */
  function payOffer(r, R) {
    const none = { lots: 0, cost: 0, whole: false, take: false };
    if (!R.ok || state.phase !== 'play') return none;
    if (stage[r] !== 0) return none;
    const n = owed();
    const ratio = R.ratio[r] || TRADE_BASE;

    /*
     * THE BULK TAP POINTS WHICHEVER WAY THE DEAL IS FACING.
     *
     *   "I can then hit the remaining icons for the other resources to pick up
     *    those resources in bulk... and the glowing icons work both ways for
     *    quick bulk trades."
     *
     * `owed()` is `asked - given`, so its SIGN is the direction the sheet is
     * currently pointing, and it is the only thing this needs to read. Positive
     * means an ask is outstanding and a tap on a pile should PAY it, which is
     * what this always did. Negative means goods are on the table with nothing
     * claimed against them, and a tap should TAKE — as many of that resource as
     * the credit already staged will buy.
     *
     * The `take` flag is what the card reads to label its plate "Take 3" rather
     * than "Pay 12", so the same control never says one thing and do the other.
     */
    if (n < 0) {
      const lots = -n;                       // one lot of credit buys one card
      return { lots, cost: lots, whole: true, take: true };
    }
    if (n < 1) return none;
    const lots = Math.min(n, Math.floor((me.res[r] | 0) / ratio));
    if (lots < 1) return none;
    return { lots, cost: lots * ratio, whole: lots === n, take: false };
  }

  /**
   * This pile cannot pay for anything at this post, at any size of ask, because
   * you do not hold one whole lot of it. That is the ONLY thing that dims a
   * card. See the header for the version that dimmed on "cannot cover the whole
   * ask" and what a reviewer did to it with the owner's own worked example.
   */
  function tooPoor(r, R) {
    return (me.res[r] | 0) < (R.ratio[r] || TRADE_BASE);
  }

  /**
   * WHAT THE OUTSTANDING ASK WOULD COST TO FINISH, AT THE LIVE RATE.
   *
   * The give band quotes a running total, and a total needs a rate for the part
   * nobody has paid for yet. There is no single true answer when the rates
   * differ — the same three cards cost twelve out of the wood pile and six out
   * of the 2:1 wool dock the player crossed the island for — so the sheet
   * quotes the CHEAPEST WAY TO FINISH FROM HERE: the lowest rate among the
   * piles that could still legally hand over another lot. At the Great Market,
   * and at any generic dock, every rate in the row is the same one and this is
   * simply that rate; at a special dock the total re-quotes itself the moment
   * the player commits a pile, which is honest, because until they choose a
   * payer the price genuinely is not settled.
   *
   * Never TRADE_BASE unless there is nothing left that can pay. A hard-coded 4
   * here is a band that lies at exactly the dock somebody walked across the
   * island to use.
   */
  function quoteRatio(R) {
    let best = null;
    for (const r of RES) {
      if (stage[r] > 0) continue;                  // on the receive side
      const ratio = R.ratio[r] || TRADE_BASE;
      if ((me.res[r] | 0) < ratio * (lotsGiven(r) + 1)) continue;   // no lot left
      if (best === null || ratio < best) best = ratio;
    }
    return best === null ? headlineRatio(R) : best;
  }

  function step(r, dir) {
    const R = rates();
    if (!canStep(r, dir, R)) { ping('deny'); nudge(); return false; }
    refusal = '';
    stage[r] += dir;
    sync();
    ping('pick');
    return true;
  }

  /**
   * The middle button. "The same effect that pressing the down arrow below the
   * sheep button 4 separate times would have done" — so that is literally what
   * it does: it moves `stage[r]` by as many lots as `payOffer` says this pile
   * can put in, in one step. When the pile is deep enough that is the whole
   * outstanding ask; when it is not, it is everything the pile has, and the
   * plate said so before the tap.
   *
   * CLEAR COMES FIRST, and it comes first unconditionally. A card that is
   * carrying a payment always takes it straight back out, whatever the rest of
   * the sheet happens to look like, because the plate on that card says CLEAR
   * and a plate that says one thing and does another depending on arithmetic
   * the player cannot see is the worst kind of control. Topping a part-payment
   * up, or trimming one back by a single lot, is what the two arrows around it
   * are for, and both are one tap away.
   *
   * A card with nothing to do is still the cursor, as it has always been, with
   * no shake and no buzz — moving the cursor is not a failed trade.
   */
  function payAll(r) {
    if (lotsGiven(r) > 0) {                 // one tap in, one tap out
      refusal = '';
      stage[r] = 0;
      sync();
      ping('pick');
      return true;
    }
    const R = rates();
    const offer = payOffer(r, R);
    if (offer.lots > 0) {
      refusal = '';
      // `take` means the sheet is facing the other way — goods are already on
      // the table and this tap claims against them. Same control, opposite sign.
      stage[r] += offer.take ? offer.lots : -offer.lots;
      sync();
      ping('pick');
      return true;
    }
    if (owed() >= 1) { sync(); ping('deny'); nudge(); return false; }
    sync();
    ping('pick');
    return false;
  }

  function moveFocus(d) {
    focus = (focus + d + RES.length) % RES.length;
    sync();
    ping('pick');
  }

  function clearStage() {
    let any = false;
    for (const r of RES) { if (stage[r]) any = true; stage[r] = 0; }
    refusal = '';
    if (any) { sync(); ping('pick'); }
    return any;
  }

  const anythingStaged = () => RES.some(r => stage[r] !== 0);

  /**
   * Everything back to nothing — what the foot button does while the deal is
   * incomplete. `stage` is SIGNED, so one pass over it clears both halves at
   * once: what was asked for and what was staged to pay for it. That is why
   * this is a one-line alias rather than two loops — worth saying out loud,
   * because a reader who assumes two separate stores will go looking for the
   * second one. */
  function clearAll() { return clearStage(); }

  /* ------------------------------------------------------------------ view */

  /** The rate the header quotes: whichever one most of the row is charging. */
  function headlineRatio(R) {
    const tally = {};
    let best = TRADE_BASE, bestN = -1;
    for (const r of RES) {
      const v = R.ratio[r] || TRADE_BASE;
      tally[v] = (tally[v] || 0) + 1;
      if (tally[v] > bestN) { bestN = tally[v]; best = v; }
    }
    return best;
  }

  function sync() {
    const R = rates();
    const tg = totalGive(), tt = totalGet(), out = tt - tg;
    const base = headlineRatio(R);
    let short = false, anyPayer = false, anyArmed = false;
    /* Cards actually handed over so far, summed at each pile's OWN rate — two
       lots of wood at 4 and one of wool at 2 is ten, not twelve. */
    let paidSoFar = 0;

    RES.forEach((r, i) => {
      const c = cells[r];
      const held = me.res[r] | 0;
      const ratio = R.ratio[r] || TRADE_BASE;
      const give = lotsGiven(r), take = cardsTaken(r);
      const spent = give * ratio;
      paidSoFar += spent;
      if (held < spent) short = true;
      const offer = payOffer(r, R);
      if (canStep(r, -1, R) && stage[r] <= 0) anyPayer = true;
      if (offer.lots > 0) anyArmed = true;

      /* THE DEAL, IN THE BIGGEST TYPE ON THE CARD. `0 -> 4` when you are asking
         for four; `40 -> 24` when four lots of it are paying. Untouched, the
         "was" half disappears and it is the plain pile count it always was, so
         a resting sheet is still five numbers and nothing else. */
      const after = held + take - spent;
      setText(c.was, stage[r] === 0 ? '' : String(held));
      setText(c.now, String(after));
      toggle(c.count, 'get', take > 0);
      toggle(c.count, 'give', give > 0);

      /* The rate, only where it is news. */
      const rateTxt = ratio === base ? '' : `${ratio}:1`;
      if (c.rateTxt !== rateTxt) { c.rateTxt = rateTxt; setText(c.rate, rateTxt); }
      toggle(c.rate, 'on', !!rateTxt);

      toggle(c.col, 'cur', i === focus);
      toggle(c.col, 'giving', give > 0);
      toggle(c.col, 'getting', take > 0);
      /* One fact about the pack, and it never moves as the ask grows. */
      toggle(c.col, 'dim', R.ok && stage[r] === 0 && tooPoor(r, R));
      toggle(c.col, 'armed', offer.lots > 0);

      /* THE ACTION PLATE. One slot, two words, and it is a real gold button
         face rather than a corner badge, because "tap this card and it settles
         the whole deal" was invisible when it was drawn as a highlight.

         AND THE PRICE ON IT IS WHAT THE TAP WILL REALLY SPEND — "PAY 8" on a
         pile of eight against a bill of twelve, not a blank slot because eight
         is not twelve. Read it against the NEEDS 12 in the band underneath and
         the plate is telling you it is a part payment without having to say the
         word. */
      /* And "Take" when the sheet is facing the other way — goods already on
         the table, this tap claiming against them. One plate, one verb, and the
         verb is always the one the tap performs. */
      const act = give > 0 ? `Clear ${spent}`
        : (offer.lots > 0 ? `${offer.take ? 'Take' : 'Pay'} ${offer.cost}` : '');
      setText(c.actLab, act);
      toggle(c.act, 'on', !!act);
      toggle(c.act, 'clear', give > 0);

      /* The card's own label carries the tap's meaning for anyone the plate
         cannot reach — and it is the one place with room to say "toward" rather
         than "for", which is the whole difference between a part payment and a
         settlement. Written only when it changes: an attribute rewritten on
         every 5Hz sync is the same class of hazard `disabled` was. */
      const lab = give > 0 ? `Take back ${spent} ${RES_LABEL[r]}`
        : (offer.lots > 0
          ? (offer.take
            ? `Take ${offer.cost} ${RES_LABEL[r]} for what you have staged`
            : `Pay ${offer.cost} ${RES_LABEL[r]} ${offer.whole ? 'for' : 'toward'} the trade`)
          : RES_LABEL[r]);
      if (c.label !== lab) { c.label = lab; c.card.setAttribute('aria-label', lab); }

      const upOk = canStep(r, 1, R);
      const dnOk = canStep(r, -1, R);
      toggle(c.up, 'off', !upOk);
      toggle(c.dn, 'off', !dnOk);
      // Write `disabled` ONLY when it changes. Rewriting it on every 5Hz sync
      // is what let a repaint cancel a press that was already under way.
      if (c.up.disabled !== !upOk) c.up.disabled = !upOk;
      if (c.dn.disabled !== !dnOk) c.dn.disabled = !dnOk;
      toggle(c.up, 'staged', take > 0);
      toggle(c.dn, 'staged', give > 0);
      /* THE ARROW ABOVE A PAYING PILE IS THE ONE-LOT UNDO, and it says so.
       *
       *   "In the mixed frame sheep is 4 of 8 spent but its down arrow is
       *    dimmed, so the only adjustment is CLEAR 4 — all or nothing."
       *
       * It is not all or nothing, and it never was: the arrow ABOVE a paying
       * card hands one lot back, one tap at a time, and it is live in exactly
       * that state. The down arrow underneath is correctly dead once the deal
       * balances, because one more lot there would buy nothing — the lane that
       * has something left to do is the one pointing back into the pack, which
       * is also literally where those cards go. What was missing was anything
       * SAYING so, since "Receive Wool" over a card that is spending wool is
       * the wrong sentence. */
      const upLab = give > 0
        ? `Take back one ${RES_LABEL[r]} lot` : `Receive ${RES_LABEL[r]}`;
      if (c.upLab !== upLab) {
        c.upLab = upLab; c.up.setAttribute('aria-label', upLab);
      }
      toggle(c.up, 'back', give > 0);
    });

    setText(where, R.label || placeName());
    setText(headRate, `${base}:1`);

    ready = R.ok && !short && tt >= 1 && tg === tt && state.phase === 'play';
    /* Green TRADE when the deal balances, stone CLEAR while it does not — see
       the note where the button is built. Written only on a CHANGE, because
       this runs at 5Hz and rewriting a class every sync is the same hazard that
       `disabled` was on the arrows: it cancels a press already in flight. */
    if (wasReady !== ready) {
      wasReady = ready;
      toggle(tradeBtn, 'green', ready);
      toggle(tradeBtn, 'stone', !ready);
      tradeIco.innerHTML = icon(ready ? 'swap' : 'close', 22);
      setText(tradeLab, ready ? 'Trade' : 'Clear');
      tradeBtn.setAttribute('aria-label', ready ? 'Confirm the trade' : 'Clear the trade');
    }

    /* The two live lines, each in the lane it is about, and each written as a
       tip rather than as an error. Blank whenever the row has already said it,
       which is most of the time — but never blank while a whole lane is dead,
       because "every control here is switched off" and "you have not started
       yet" look identical, and one of them is a bug report.

       The dead end has its own line. Ask for more than the pack can ever pay
       for and every give arrow is legitimately dead with nothing left to try;
       saying so is the difference between a sheet that is finished with you and
       a sheet that is broken. */
    let giveSay = '', getSay = '';
    if (!R.ok) giveSay = R.reason || 'Head to a trading post';
    else if (refusal) giveSay = refusal;
    else if (short) giveSay = 'Not enough left';
    else if (tt < 1 && tg < 1) giveSay = 'Ask above, then pay here';
    else if (out >= 1 && !anyPayer) giveSay = 'Nothing left to pay with';
    /* And it points at the control that can actually finish it, which is now
       almost always a card.
       This line said "Use the arrows to pay" for the whole of the previous pass
       on the eights-pack-asking-three-brick sheet, because back then no pile
       could arm unless it covered the entire bill on its own:
         "As shipped the copy steers the player away from the one-tap payer in
          exactly the case where it saves the most taps."
       It does not any more. Every pile holding one lot arms and offers what it
       has, so `anyArmed` is true there and the tip says to tap a card — two
       taps instead of twelve. The arrows keep the line for the one case that is
       genuinely theirs: when the only piles that can still pay are ones already
       part-way in, whose taps are take-backs rather than payments.
       There used to be an `N more to pay` line in here as well. It is gone
       because the running total to its left says the same thing better — "8 OF
       12" is the same fact as "1 more to pay" with the price attached — and two
       chips in one band both counting down the same deal is the sort of litter
       this sheet keeps having to be talked out of. */
    else if (out >= 1) giveSay = anyArmed ? 'Tap a card to pay' : 'Use the arrows to pay';
    else if (out < 0) getSay = `Take ${-out} more`;
    setText(giveLive, giveSay);
    setText(getLive, getSay);
    toggle(capGive, 'say', !!giveSay);
    toggle(capGet, 'say', !!getSay);

    /* THE PRICE, SPELLED OUT. `paidSoFar` is what is really staged, each pile
       at its own rate; the rest of the bill is quoted at the cheapest rate
       still available to finish it (see quoteRatio). Over-paying — un-asking a
       card that was already covered — leaves the give side full and the receive
       side short, and the green band above is the one saying so, so the total
       reads as covered rather than going negative. */
    const owe = Math.max(0, out);
    const price = paidSoFar + owe * (owe > 0 ? quoteRatio(R) : 0);
    const costTxt = (R.ok && (tt >= 1 || tg >= 1))
      ? (tg < 1 ? `Needs ${price}` : `${paidSoFar} of ${price}`) : '';
    setText(giveCost, costTxt);
    toggle(capGive, 'cost', !!costTxt);
    toggle(giveCost, 'full', !!costTxt && tg >= 1 && paidSoFar >= price);
  }

  function placeName() {
    const port = portId === null ? null : ports[portId];
    if (!port) return 'Great Market';
    return port.resource ? `${RES_LABEL[port.resource]} Dock` : 'Trading Dock';
  }

  function ping(kind) {
    try {
      const a = game && game.audio;
      if (!a || !a.sfx) return;
      if (kind === 'deny') a.sfx('deny', { gain: 0.28, mine: true });
      else a.sfx('blip', { gain: 0.32 });
    } catch (e) { /* audio is optional */ }
  }

  function nudge() {
    row.classList.remove('nope');
    void row.offsetWidth;
    row.classList.add('nope');
  }

  /* --------------------------------------------------------------- confirm */

  /**
   * Pay every staged lot for every staged card, in order. Give and receive can
   * never name the same resource (the signed axis forbids it) so each pair is
   * always a legal exchange, and because the price of a lot depends only on
   * what is handed over, pairing them positionally costs exactly what the sheet
   * said it would even when both sides name several different resources.
   *
   * The sheet deliberately stays open: standing at a post you usually want two
   * or three deals, and being thrown back out to the island after each one was
   * the slowest part of trading.
   */
  function confirm() {
    if (!ready) return false;
    const gives = [], gets = [];
    for (const r of RES) {
      for (let i = 0; i < lotsGiven(r); i++) gives.push(r);
      for (let i = 0; i < cardsTaken(r); i++) gets.push(r);
    }
    const n = Math.min(gives.length, gets.length);
    if (!n) return false;

    const eco = game && game.economy;
    let done = 0;
    for (let i = 0; i < n; i++) {
      let res;
      if (eco && typeof eco.trade === 'function') res = eco.trade(gives[i], gets[i]);
      else {
        const ratio = rateFor(gives[i]);
        res = doTrade(state, 0, gives[i], gets[i], ratio)
          ? { ok: true, ratio } : { ok: false, reason: 'That trade was refused' };
      }
      if (!res || !res.ok) {
        if (!done) {
          // Straight into the give band. There is nowhere else on the sheet
          // that says anything in words any more, and a refusal that goes
          // nowhere is a Trade button that stops working for no stated reason.
          refusal = (res && res.reason) || 'That trade was refused';
          sync();
          ping('deny');
          nudge();
          return false;
        }
        break;
      }
      done++;
    }

    if (!done) { sync(); return false; }
    if (!eco && game && game.toast) {
      game.toast(`Traded ${done} time${done > 1 ? 's' : ''}`, 'good');
    }
    refusal = '';
    for (const r of RES) stage[r] = 0;
    sync();
    node.classList.remove('done');
    void node.offsetWidth;
    node.classList.add('done');
    return true;
  }

  /* -------------------------------------------------------------- keyboard */

  /** Returns true when the key belonged to this sheet. */
  function key(code) {
    switch (code) {
      case 'ArrowLeft': moveFocus(-1); return true;
      case 'ArrowRight': moveFocus(1); return true;
      case 'ArrowUp': step(RES[focus], 1); return true;
      case 'ArrowDown': step(RES[focus], -1); return true;
      // The keyboard route to the one-tap payer. Space is what a focused
      // button answers to everywhere else, and the cursor here IS a focused
      // button — it just happens to be drawn rather than browser-focused.
      case 'Space': payAll(RES[focus]); return true;
      case 'Tab': clearStage(); return true;
      case 'Escape': requestClose(); return true;
      case 'Enter':
      case 'NumpadEnter':
        // Enter both finishes and leaves: it does the deal when there is one,
        // and closes the sheet when the row is untouched.
        if (ready) confirm();
        else if (!anythingStaged()) requestClose();
        else nudge();
        return true;
      default: return false;
    }
  }

  /* ------------------------------------------------------------------ open */

  /**
   * Open on the card the player most likely walked here to BUY: the resource
   * they hold the least of that they could still ask for.
   *
   * It used to open on the cheapest resource they could pay with, richest pile
   * first, and that was right when the first move on the sheet was staging what
   * you hand over. It is wrong now — the first move is at the top of the sheet,
   * and parking the cursor on the fattest pile in the row points it at the
   * answer to a question the player has not been asked yet. The scarcest pile
   * is the one somebody standing at a dock is short of; if the ask turns out to
   * be something else, one press of Left or Right fixes it, which is a cheaper
   * mistake than opening pointed at the wrong half of the sheet.
   */
  function open(id) {
    portId = (id === undefined || id === null) ? null : id;
    if (portId !== null && !me.ports.has(portId)) portId = null;
    for (const r of RES) stage[r] = 0;
    refusal = '';

    const R = rates();
    let best = 0, bestKey = null;
    RES.forEach((r, i) => {
      const held = me.res[r] | 0;
      const skip = new Set([r]);
      // Askable at all? A resource nobody in the pack could buy is not where
      // the cursor should land, however little of it there is.
      const k = [payCapacity(R, skip) >= 1 ? 0 : 1, held];
      if (!bestKey || k[0] < bestKey[0]
        || (k[0] === bestKey[0] && k[1] < bestKey[1])) {
        bestKey = k; best = i;
      }
    });
    focus = best;
    node.classList.remove('done');
    sync();
  }

  sync();

  return {
    node, open, sync, key,
    get ready() { return ready; },
    get portId() { return portId; },
    clearStage
  };
}

export default createTradeSheet;
