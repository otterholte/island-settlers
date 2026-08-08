/**
 * Island Settlers — the practice run's script.
 *
 *   buildSteps(t) -> [ step, step, ... ]
 *
 * The twenty-two things the guided run says, in the order somebody who has
 * never played needs them. It is a DATA file: it owns no timers, no DOM and no
 * rules — `t` is the small toolkit systems/tutorial.js hands in (the match, the
 * board helpers, the pack top-up), and that module does all the driving. It
 * lives apart from the driver only because the two together are well past the
 * 900-line ceiling in CONTRACT.md, and because the script is the part the owner
 * reads.
 *
 * WHAT A STEP IS
 *
 *   title / text     what the badge says. `text` may be a function, and with
 *                    `live` it is re-read every frame (the recovery countdown).
 *   brief            an OPTIONAL large explain-first phase: the badge comes up
 *                    big with these words and an OK key, and only when it is
 *                    pressed does the step's own body take over at whatever
 *                    `size` it asked for. This is the shape the owner asked for
 *                    twice, once for the road and once for the market, and it
 *                    is why it is a field rather than two steps: BACK and NEXT
 *                    move between STEPS, and splitting an explanation from its
 *                    task would have made half the run's Back key land on a
 *                    paragraph the player had just dismissed.
 *   action           the green key's label on a step that is simply read.
 *   size / place     how big the badge is and where it sits — see the note
 *                    over `createCoach` in src/ui/tutorial.js.
 *   hud              which HUD clusters this step wants on screen. These become
 *                    classes on `#ui` and the rules are in tutorial.css; hud.js
 *                    is never touched, so leaving the run cannot leave the
 *                    interface in a state nobody can get out of.
 *   spot             the hex wash from src/ui/tutspot.js. `'pips'` also drops a
 *                    gold dot on every hex you may collect from.
 *   world / dom      what the gold ring points at, in the world or in the DOM.
 *                    `dom` may be a function, re-read every frame, which is how
 *                    the market step walks the ring across a live trade sheet.
 *   check            polled every frame; true means the player did the thing.
 *   enter            run once as the step comes up (the pack top-ups).
 *   skipIf           true means this step has nothing to teach today.
 *
 * WHICH STEP IS WHICH. Three numbers in the owner's notes are load-bearing —
 * "for step 3", "for step 7", "for step 11" — so the running order below is
 * pinned to them: 3 is the glowing land, 7 is the pack (and the move to the
 * bottom of the screen), 11 is the score. Anything inserted has to keep those
 * three where they are.
 *
 * Owner: Tutorial (flow) agent.
 */

import {
  COST, TRADE_BASE, VICTORY_POINTS, RES, TILE_REGEN, CARD_LABEL,
  LONGEST_ROAD_MIN, LONGEST_ROAD_VP, LARGEST_ARMY_MIN, LARGEST_ARMY_VP
} from '../core/constants.js';
import { MARKET } from '../board/layout.js';
import { handheld } from '../ui/dom.js';
import {
  legalSettlements, scoreOf, tileRecovery, tileItemsRemaining
} from '../core/rules.js';

/** The HUD wardrobe, per step. Anything left out is off for that step. */
const OPENING = {};                                   // pack, awards, clock: gone
const WITH_PACK = { pack: true };
/* The pack lesson. `nobuild` because nothing on it asks you to build, and
   `nokeys` — compact viewports only — because the badge has to reach the foot
   of the screen and the three circular keys are the last thing in its way:
   "on mobile just hide the build map and pause buttons for this step as well,
   so the instruction box can actually sit on the bottom without covering it." */
const PACK_LESSON = { pack: true, nobuild: true, nokeys: true };
const SCORING = { pack: true, ranks: true, nobuild: true };
/* The awards step, and the reason it carries `nobuild` like the scoring steps
   do. Its badge sits `low` — it has to, because it is pointing at the two rows
   that have just appeared in the top-left corner and it must not stand in front
   of them — and `low` on a 375px screen puts its foot 26px INSIDE the build
   cards. That is the owner's one hard rule about this badge, in his words:
   "but don't ever cover the build pause and map buttons. they shouldn't overlap
   at all." Nothing on this step asks the player to build, so the four cards
   stand down for it exactly as they do for step 11. */
const EVERYTHING = { pack: true, ranks: true, awards: true, nobuild: true };
/* The last card. Everything that was introduced stays introduced, and the four
   build cards stand down so the closing badge can sit as low as step 11's. */
const DONE = { pack: true, ranks: true, awards: true, nobuild: true };

export function buildSteps(t) {
  const { state, me, game } = t;


  /* The two resources the market lesson is built around: ask for the pile you
     are shortest of, pay out of the one you are deepest in. Read live off the
     pack rather than fixed, so the ring lands on a card that can really pay. */
  const askRes = () => RES.reduce((a, r) => ((me.res[r] | 0) < (me.res[a] | 0) ? r : a), RES[0]);

  const mapIn = kind => !!(game.overview && game.overview.isOpen
    && game.overview.mode === 'place-' + kind);
  const buildRowOpen = () => {
    const n = document.querySelector('.build-row');
    return !!(n && !n.classList.contains('hid'));
  };
  const cardsHeld = () => me.cards.length + (me.vpCards | 0);

  /**
   * Where the ring goes while a trade is being made.
   *
   *   "hide / have a much smaller out-of-the-way but clear circles/highlights
   *    to follow so that you successfully make a trade without the tutorial in
   *    the way."
   *
   * One ring, walking the sheet in the order the redesigned post is meant to be
   * used — and read off the sheet's OWN state classes rather than off a script,
   * so it follows the player instead of leading them somewhere they have
   * already been. `.tr-col.getting` is a card being asked for, `.tr-col.armed`
   * is a pile that can pay something toward it, and the foot key drops `.off`
   * the moment the bill is covered.
   */
  const tradeRing = () => {
    const sheet = document.querySelector('.sheet.trade:not(.hid)');
    if (!sheet) return ['.tradecue:not(.hid) .tc-card'];
    const go = sheet.querySelector('.sheet-foot .btn');
    if (go && !go.classList.contains('off')) return ['.sheet.trade .sheet-foot .btn'];
    if (!sheet.querySelector('.tr-col.getting')) {
      return [`.sheet.trade .tr-col[data-res="${askRes()}"] .tr-arr.up`];
    }
    if (sheet.querySelector('.tr-col.armed:not(.giving)')) {
      return ['.sheet.trade .tr-col.armed:not(.giving) .tr-card'];
    }
    return ['.sheet.trade .tr-cap.give'];
  };

  return [
    /* 1 ------------------------------------------------ THE ONE THAT STOPS YOU
     *
     *   "For step 1 the popup should actually be in the middle of the screen
     *    (not like the other steps) and everything else should be darkened. It
     *    should be switched to say something like (This is a tutorial, only YOU
     *    are playing right now, the other three players are standing still).
     *    Then I have to press okay."
     *
     * The only card in the run that is not pointing at anything, so the only
     * one allowed to take the whole display: `place: 'centre'` puts it dead
     * middle and `veil: true` turns everything behind it — island and heads-up
     * display both — down to nothing. Every other step has to leave the game
     * playable underneath, which is why this is a flag on one step rather than
     * the badge's normal manners.
     *
     * The words changed too, and the change is the whole point of the card. The
     * old line ("one thing at a time, and I will wait for you") described the
     * tutorial's TONE. What a player actually needs to know before they touch
     * anything is that the race they can see is not running: three rivals are
     * standing on the island doing nothing, on purpose, and nothing they do
     * here counts. That is the sentence that lets somebody stop hurrying.
     */
    {
      id: 'hello',
      title: 'This is a tutorial',
      text: 'Only YOU are playing right now — the other three settlers are standing still and will not move. Nothing here can go wrong and nothing here counts. Take as long as you like.',
      action: 'Okay',
      veil: true,
      size: 'big', place: 'centre', hud: OPENING
    },

    /* 2 ------------------------------------------------------------------ */
    {
      id: 'walk',
      title: 'Walk',
      /*
       *   "Mention that you can click and drag anywhere with your finger to
       *    move, not just the left side of the screen."
       *
       * The joystick has taken a drag from anywhere-that-is-not-a-button since
       * the sides toggle was removed from settings, and this step was still
       * sending the player's thumb to the left half of the screen.
       */
      /*
       * ...AND ON A LAPTOP IT IS NOT A THUMB.
       *
       *   "Check automatically to see if the screen is the size of an iPad or
       *    smaller, then have the normal directions for how to move. If it's
       *    larger like a laptop, then change the directions to be for arrow
       *    keys instead."
       *
       * `handheld()` in ui/dom.js is the same three-question test the Add to
       * Home Screen key uses — coarse pointer, no hover, and an iPad-or-smaller
       * long edge — so a touchscreen laptop is told about its keyboard and an
       * iPad is told about its thumb, which is the right way round.
       *
       * Both are true of both devices: systems/input.js takes WASD and the
       * arrow keys as well as a drag from anywhere that is not a button. This
       * only decides which one the sentence NAMES, and it names one, because a
       * first instruction that offers two ways to walk is a first instruction
       * that has to be read twice.
       */
      text: () => (handheld()
        ? 'Press and drag ANYWHERE on the screen — left side, right side, straight over the island. Your settler follows your thumb.'
        : 'Use the ARROW KEYS to walk — up, down, left, right. WASD does the same thing if you would rather.'),
      size: 'big', place: 'top', hud: OPENING,
      check: () => t.walked() > 6
    },

    /* 3 --------------------------------------------------- THE GLOWING LAND
     *
     *   "For step 3 of the tutorial mention the hexes that you can pick up
     *    resources from have the glowing around them — actually point out
     *    clearly and minimally to all three, while actually increasing the
     *    darkness level of the other hexes you can't pick up from... But just
     *    highlight one hex for the sake of learning."
     *
     * ...AND NO RING ON THIS ONE.
     *
     *   "Don't highlight with a circle yet. Just let me run around and
     *    collect."
     *
     * The wash and the gold dots stay, because they ARE the lesson — the whole
     * step is "these hexes, not those" — but the coach's own ring came off. A
     * ring names ONE hex, and naming one at the moment the player is being told
     * they own several turns an invitation to wander into an instruction to go
     * to a particular place. The dots say where; the player picks which.
     *
     * The check followed the ring off its single hex: standing on ANY workable
     * hex finishes this step now, so whichever one they walk to is the right
     * answer. `homeTile` is still the hex the later steps teach on.
     */
    {
      id: 'land',
      title: 'Your own land glows',
      text: () => {
        const n = t.workable().length;
        return `The island has gone dark except the ${n} hexes you may collect from — the glowing ones, with a gold dot on each. Walk onto any of them.`;
      },
      live: true,
      size: 'big', place: 'top', hud: OPENING, spot: 'pips',
      check: () => t.workable().some(id => t.standingOn(id))
    },

    /* 4 ------------------------------------------------------------------ */
    {
      id: 'collect',
      title: 'Run things over',
      text: 'Everything growing on a hex you own is yours. Walk over it — no tapping, no waiting. Collect six things.',
      size: 'big', place: 'top', hud: OPENING, spot: true,
      world: () => t.itemOnHome(),
      check: () => me.stats.gathered - t.base.gathered >= 6
    },

    /* 5 ------------------------------------------------- CLEAR ONE, ANY ONE
     *
     *   "Don't draw a circle anywhere, just show up if they haven't cleared a
     *    single whole hex yet. As soon as they do clear a single whole hex
     *    we'll move to the next step."
     *
     * So the ring is gone and the step is conditional on itself: `skipIf` walks
     * straight past it for a player who swept a hex during step 4 — which is
     * easy to do, since step 4 only asks for six things and a 1-pip hex holds
     * five — and `check` ends it the moment any hex they own goes bare, not
     * just the one the script had in mind. Two readings of "a single whole hex"
     * were available and this is the generous one: the player who cleared a
     * different hex than the tutorial expected has still learned the thing.
     */
    {
      id: 'sweep',
      title: 'Clear the whole hex',
      text: () => {
        const t0 = t.sweepTile();
        const left = t0 < 0 ? 0 : tileItemsRemaining(t0);
        return `Keep running until nothing is left standing on one of your hexes. ${left} to go on the nearest.`;
      },
      live: true,
      size: 'big', place: 'top', hud: OPENING, spot: true,
      skipIf: () => t.sweptAny(),
      check: () => t.sweptAny()
    },

    /* 6 --------------------------------------------------- THE RECOVERY CLOCK
     *
     *   "Darken everything on the screen except for highlight the countdown
     *    timer (remove the yellow circle as well). Be more clear it's not 6
     *    seconds. It takes time to reset the hex. The number tile on the hex
     *    will determine if the hex reloads quicker or slower."
     *
     * TWO CHANGES, AND THE FIRST ONE IS A CONSTRAINT.
     *
     * The countdown is not a HUD element. It is an instanced shader quad
     * floating over the hex (world/regionmark.js) with the seconds painted into
     * a glyph atlas — there is no node and therefore no selector a highlight
     * could be pointed at. What CAN be done is what the wash already does for
     * hexes: `spotWorld` projects the point the clock floats above and punches
     * the hole there, so the numerals are the only bright thing on the screen
     * and the gold ring is not needed to say which. That is the note's two
     * halves in one move — the timer highlighted, the circle gone.
     *
     * `spot` is dropped with the ring for the same reason: leaving every
     * workable hex lit would leave three bright patches competing with the one
     * the step is about. On this step the clock is the whole screen.
     *
     * THE SECOND CHANGE IS THE SENTENCE, and the old one was actively
     * misleading. It read "about 6 seconds" off whichever hex the run happened
     * to teach on, which made a number that RANGES from 6 to 34 look like a
     * constant — and worse, hid the only thing the player can act on, which is
     * that the disc on the hex is what sets it. TILE_REGEN is read out at both
     * ends so the range is named, and the disc is named as the cause.
     */
    {
      id: 'rest',
      title: 'It comes back',
      text: () => {
        const t0 = t.restTile();
        const rc = t0 < 0 ? null : tileRecovery(t0, state.time || 0);
        const clock = rc && rc.exhausted
          ? `The clock over the bare hex is counting it back in: ${Math.ceil(rc.secondsLeft)} seconds left, and then everything on it returns at once. `
          : 'A hex you have stripped goes bare and a clock appears over it. When it runs out, everything on it returns at once. ';
        return `${clock}It is not the same wait everywhere — the NUMBER DISC on the hex sets it. A ${TILE_REGEN[5]}-second hex is a 5-pip one; a 1-pip hex takes ${TILE_REGEN[1]}. Own several and walk a loop around them.`;
      },
      live: true,
      size: 'big', place: 'top', hud: OPENING,
      spotWorld: () => {
        const c = t.tileCentre(t.restTile());
        return c ? { x: c.x, z: c.z, lift: 7.0, r: 104 } : null;
      }
    },

    /* 7 ------------------------------------------------------- THE PACK
     *
     *   "Then for step 7, switch the tutorial to the bottom of the screen and
     *    add the pack/resources counter to the top middle of the screen again."
     *
     * So this is the step the badge moves house on, and the pill it was
     * standing in front of comes back underneath it.
     */
    {
      id: 'pack',
      title: 'Your pack',
      /*
       *   "Don't have a yellow circle, remove it. Instead highlight the exact
       *    element for my pack, and darken the rest of the screen to bring
       *    attention to the correct place. Maybe still keep the player I'm
       *    running with and the highlighted hexes lighter so I can run around
       *    and see the increase on that My Pack section as I collect items."
       *
       * The ring came off and the wash took its place, cut to the pill's own
       * rectangle: everything is turned down except the pack, the settler, and
       * the hexes they may collect on. That last part is why this step is a
       * spotlight and not a modal — the lesson is watching the numbers move,
       * which means the player has to be able to run while they read it.
       *
       *   "The box for the instruction is too high on the screen for both
       *    mobile and desktop. On mobile just hide the build map and pause
       *    buttons for this step as well, so the instruction box can actually
       *    sit on the bottom without covering it."
       *
       * `place: 'foot'` is the bottom of the screen rather than the band 126px
       * up that this step used to stand in. On a laptop it clears the three
       * circular keys; on a phone PACK_LESSON takes those away too and the card
       * drops onto the gutter. See the FOOT band in tutorial.css.
       *
       * The hairline sentence is gone with the hairline's job — it is a static
       * piece of trim now, not a supply meter, so describing it would be
       * teaching a readout that no longer reads anything.
       */
      text: 'Up in the middle is everything you are carrying: wood, brick, wool, wheat and ore. Run over things on your glowing land and watch the numbers climb.',
      size: 'big', place: 'foot', hud: PACK_LESSON,
      spot: true, spotMe: true, spotDom: ['.hud-tc']
    },

    /* 8 ------------------------------------------------------- THE BUILD KEY
     *
     *   "Have the build button start as collapsed, since I haven't explained it
     *    in the tutorial yet."
     *
     * The four cards have been shut since the run began — really shut, by the
     * same `hid` the BUILD key toggles, so opening them here is the player
     * pressing the real control and not a class being taken off behind them.
     */
    {
      id: 'buildkey',
      title: 'The BUILD key',
      /*
       *   "Push the instruction to the top of the page — in fact you can hide
       *    the Your Pack section for this step, so that the instruction popup
       *    isn't covering the screen. Darken everything else on the screen
       *    except for the three buttons on the bottom right and keep the circle
       *    around build. Let me go backwards, but if this is my first time on
       *    this step during this visit to the tutorial, don't let me press next
       *    until I've pressed build."
       *
       * All four, and the fourth one is the interesting one. `holdNext` dims
       * NEXT until the step's own check has come true ONCE this run, which
       * makes this the only step in the tutorial the player cannot read their
       * way past. It is defensible here and would not be anywhere else: every
       * later step depends on the four build cards being open, and a player who
       * skipped this one arrives at "tap the ROAD card" with no ROAD card on
       * screen. BACK is never held — that was asked for in the same breath —
       * and the hold is first-visit only, so walking back through the run and
       * forward again is free.
       *
       * The badge goes to the TOP with the pack hidden (`hud: OPENING`) because
       * the thing it is talking about is in the bottom-right corner: a card
       * standing in the bottom band would be sitting next to the keys it is
       * pointing at. The ring stays on BUILD — the note says to keep it — and
       * the wash cuts a hole round all three keys, so the ring names which one
       * and the darkness names where to look.
       */
      text: 'Tap BUILD, bottom right. Four cards slide up — road, settlement, city, card — and each one fills as you gather, then turns gold when you can afford it.',
      size: 'big', place: 'top', hud: OPENING,
      dom: ['.hud-br .cbtn.gold'],
      spotDom: ['.hud-br'],
      holdNext: true,
      check: () => buildRowOpen()
    },

    /* 9 -------------------------------------------------------- A ROAD
     *
     *   "When it's time to build a road, switch the tutorial step back to where
     *    the resource counter is, and remove that pack/resource counter
     *    temporarily. Force them to actually press a button to build a road to
     *    automatically move to the next step."
     *
     *   "On the step for building the road, show the popup for the tutorial
     *    larger, then they click okay, then just keep the highlight of what
     *    they're supposed to click... Let them know they can tap twice to build
     *    a road, instead of having to press confirm."
     *
     * Both halves, in one step: the badge comes up big at the top with the pack
     * out of the way, and after OK all that is left is one line and the ring
     * around the ROAD card. The step ends when the placement map opens, which
     * only the real card can do.
     */
    {
      id: 'road',
      title: 'Build a road',
      brief: {
        title: 'Build a road',
        text: `A road is ${COST.road.wood} wood and ${COST.road.brick} brick, and your pack is topped up. Tap the ROAD card, then a glowing line on the map — and tap that SAME line again to build it. There is no confirm button: the second tap is the confirm.`
      },
      text: 'Tap the ROAD card.',
      enter: () => t.topUp(COST.road),
      size: 'slim', place: 'top', hud: OPENING,
      dom: ['.bcard[data-kind="road"]'],
      check: () => mapIn('road') || me.roads.size > t.base.roads
    },

    /* 10 ----------------------------------------------------------------- */
    {
      id: 'roadplace',
      title: 'Tap it twice',
      text: 'Tap a glowing line, then tap it again. Tapping the empty sea puts it back.',
      size: 'slim', place: 'top', hud: OPENING,
      check: () => me.roads.size > t.base.roads
    },

    /* 11 ------------------------------------------------------- THE SCORE
     *
     *   "For step 11, add the scores on the right side of screen and hide the
     *    build cards. That way the step explanation for the tutorial isn't
     *    covering the game board and my player in the middle of the screen."
     *
     * With the four cards away the badge drops to the LOW slot, a hand's width
     * off the bottom edge, and the whole middle of the screen — the island, and
     * the settler standing on it — is clear while the standings are read.
     */
    {
      id: 'points',
      title: 'That is what points are',
      text: () => `You gather to build, and you build to score. A settlement is 1 point, a city 2, a victory card 1 — first to ${VICTORY_POINTS} wins. You are on ${scoreOf(state, me)}; the standings on the right carry everybody's.`,
      live: true,
      size: 'big', place: 'low', hud: SCORING,
      dom: ['.hud-tr .rk.me', '.hud-tr']
    },

    /* 12 ----------------------------------------------------------------- */
    {
      id: 'reach',
      title: 'One more road',
      text: 'Your network has to REACH a free corner before you can settle it. Build one more, further out.',
      enter: () => t.topUp(COST.road),
      skipIf: () => legalSettlements(state, 0).length > 0,
      size: 'slim', place: 'bottom', hud: WITH_PACK,
      dom: ['.bcard[data-kind="road"]'],
      check: () => legalSettlements(state, 0).length > 0
    },

    /* 13 -------------------------------------------------- A SETTLEMENT
     *
     *   "Mention that the settlement has to be two roads away from any other
     *    settlement, even your competitors'."
     *
     * It is the rule that decides which corners glow and the one that makes a
     * player think the map is broken when it does not offer the corner they
     * were looking at.
     */
    {
      id: 'settle',
      title: 'Build a settlement',
      brief: {
        title: 'Build a settlement',
        text: 'Topped up again. A settlement must stand TWO ROADS CLEAR of every other settlement on the island — your rivals\' as well as your own — so most corners will not glow. It is worth 1 point and opens the hexes it touches.'
      },
      text: 'Tap SETTLEMENT, then a glowing corner, then that corner again.',
      enter: () => t.topUp(COST.settlement),
      size: 'slim', place: 'bottom', hud: WITH_PACK,
      dom: ['.bcard[data-kind="settlement"]'],
      check: () => me.settlements.size > t.base.settlements
    },

    /* 14 ----------------------------------------------------------------- */
    {
      id: 'city',
      title: 'Grow it into a city',
      text: 'A city is a settlement that grew: 2 points instead of 1. Tap CITY, then one of your own settlements, twice.',
      enter: () => t.topUp(COST.city),
      size: 'slim', place: 'bottom', hud: WITH_PACK,
      dom: ['.bcard[data-kind="city"]'],
      check: () => me.cities.size > t.base.cities
    },

    /* 15 ----------------------------------------------------------------- */
    {
      id: 'market',
      title: 'Walk to the market',
      text: () => (me.nearTrade
        ? 'You are at the Great Market. Tap the offer to open it.'
        : 'The Great Market is the hex in the middle of the island. Walk to it — it will swap what you have spare for what you are short of.'),
      live: true,
      size: 'slim', place: 'bottom', hud: WITH_PACK,
      world: () => ({ x: MARKET.x, z: MARKET.z }),
      dom: () => (me.nearTrade ? ['.tradecue:not(.hid) .tc-card'] : []),
      check: () => !!me.nearTrade
    },

    /* 16 --------------------------------------------------- THE TRADING POST
     *
     *   "For the trade at the market step, explain how the market works, then
     *    have them press okay, and hide / have a much smaller out-of-the-way but
     *    clear circles/highlights to follow so that you successfully make a
     *    trade without the tutorial in the way."
     *
     * The sheet was redesigned: RECEIVE is the green band on top, GIVE the
     * brown one below, the up arrow adds to the pile it sits on, you ask FIRST
     * and then tap a resource CARD to pay out of that pile, and the brown band
     * counts the bill. This teaches THAT sheet — and then gets out of its way
     * completely: once the trade opens, the badge is not shown at all and the
     * ring alone walks the deal (see `tradeRing`).
     */
    {
      id: 'trade',
      title: 'Make the trade',
      brief: {
        title: 'How the market works',
        text: `YOU RECEIVE is the green band on top, YOU GIVE the brown one below. Tap the UP arrow over what you want — you may ask for what you do not own. The brown band counts the bill: NEEDS ${TRADE_BASE}. Then tap a resource CARD to pay out of that pile. At ${TRADE_BASE} OF ${TRADE_BASE}, TRADE lights up.`
      },
      text: 'Follow the ring: ask above, pay below, then TRADE.',
      enter: () => { me.res.wood = Math.max(me.res.wood | 0, TRADE_BASE * 3); },
      size: 'slim', place: 'bottom', hud: WITH_PACK,
      dom: tradeRing,
      check: () => me.stats.traded > t.base.traded
    },

    /* 17 ------------------------------------------------------ THE THREE CARDS
     *
     *   "...and the cards have a knight, and victory point, and a road building,
     *    which you should add a few steps to explain in a similar minimal and
     *    clear and out-of-the-way, hands-on method."
     *
     * One purchase, then one short step per card, each with the ring on a real
     * thing rather than on a picture of one.
     */
    {
      id: 'cards',
      title: 'Buy a card',
      brief: {
        title: 'Development cards',
        text: `One price — ${COST.card.wool} wool, ${COST.card.wheat} wheat, ${COST.card.ore} ore — and three things in the deck. I have topped you up for one. Buy it and I will take you through all three.`
      },
      text: 'Tap the CARD card.',
      enter: () => t.topUp(COST.card),
      size: 'slim', place: 'bottom', hud: WITH_PACK,
      dom: ['.bcard[data-kind="card"]'],
      check: () => cardsHeld() > t.base.cards
    },

    /* 18 ----------------------------------------------------------------- */
    {
      id: 'knight',
      title: CARD_LABEL.knight,
      /*
       * THIS TEXT HAD TO CHANGE WITH THE RULE, AND ALMOST DID NOT.
       *
       *   "I want it to only take from the players who have a settlement or
       *    city on the hex where you place the knight, and only they will lose
       *    half of all of their resources. If I place it on my own hex, I still
       *    can access that hex for resources, however I never lose half of my
       *    own resources if I'm the one that plays the knight."
       *
       * The old line said "every rival loses half", which was true of the old
       * Knight and is now simply wrong — it robbed one rival wherever it landed
       * and it robs the hex's neighbours now. A tutorial that teaches a rule the
       * game does not have is worse than no tutorial, because the player will
       * trust it and then be surprised by their own board, so the wording names
       * the three things the new rule actually turns on: WHO (only the seats
       * built on that hex), HOW MUCH (half of every resource, rounded down),
       * and the exemption that makes it worth aiming (never you).
       */
      text: 'Land it on a hex and everyone with a settlement or city THERE loses half of everything they carry — rounded down, so five becomes three. Nobody else is touched, and you never pay it yourself. The hex stops giving to them while it stands.',
      size: 'big', place: 'low', hud: SCORING,
      dom: ['.kn-cue:not(.rb-cue):not(.hid)', '.bcard[data-kind="card"]']
    },

    /* 19 ----------------------------------------------------------------- */
    {
      id: 'roadcard',
      title: CARD_LABEL.roadBuilding,
      text: 'Two roads, free. It opens the placement map by itself and lets you lay both, one after the other, without spending a stick of wood.',
      size: 'big', place: 'low', hud: SCORING,
      dom: ['.kn-cue.rb-cue:not(.hid)', '.bcard[data-kind="road"]']
    },

    /* 20 ----------------------------------------------------------------- */
    {
      id: 'vpcard',
      title: CARD_LABEL.victoryPoint,
      text: 'One point, the instant you draw it. Nothing to play and nothing to remember — the counter in the corner goes up and stays up.',
      size: 'big', place: 'low', hud: SCORING,
      dom: ['.sc-vp']
    },

    /* 21 ----------------------------------------------------- THE TWO AWARDS
     *
     *   "Don't forget to mention the largest army and the longest road and the
     *    points associated, and where you can find that info. Don't show that
     *    section until that step in the tutorial."
     *
     * So the two rows have been off the scoreboard for the whole run and they
     * arrive HERE, under the ring, at the moment they are explained.
     */
    {
      id: 'awards',
      title: 'Points you never build',
      text: `Longest Road: ${LONGEST_ROAD_VP} points for ${LONGEST_ROAD_MIN}+ segments in one unbroken line. Largest Army: ${LARGEST_ARMY_VP} for ${LARGEST_ARMY_MIN}+ Knights played. Both sit in the scoreboard, top left — who holds it, your own number, and how many more you need.`,
      size: 'big', place: 'low', hud: EVERYTHING,
      dom: ['.sc-awards']
    },

    /* 22 ----------------------------------------------------------------- */
    {
      id: 'done',
      title: 'That is the whole game',
      text: 'Collect on land you own, build roads to reach more, turn corners into settlements and cities, and trade for what you are short of. Go and win one.',
      action: 'Play a Match',
      onAction: () => t.restart(),
      // Everything that was introduced stays introduced: the last thing the
      // player sees is the whole interface a real match will hand them.
      size: 'big', place: 'low', hud: DONE
    }
  ];
}

export default buildSteps;
