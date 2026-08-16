/**
 * Island Settlers — the practice run's script.
 *
 *   buildSteps(t) -> [ step, step, ... ]
 *
 * The forty-odd things the guided run says, in the order somebody who has
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
 * WHICH STEP IS WHICH. The owner's notes name steps by NUMBER and the numbers
 * move every time one is inserted, so nothing here is pinned to an ordinal and
 * nothing should be: `id` is the stable name for a step, and tools/tutshot.mjs
 * asserts against ids for exactly that reason. When a note says "step 19", find
 * it by counting the list below once — do not try to keep the count true.
 *
 * Owner: Tutorial (flow) agent.
 */

import {
  COST, TRADE_BASE, VICTORY_POINTS, RES, TILE_REGEN, CARD_LABEL,
  LONGEST_ROAD_MIN, LONGEST_ROAD_VP, LARGEST_ARMY_MIN, LARGEST_ARMY_VP
} from '../core/constants.js';
import { MARKET, DESERT } from '../board/layout.js';
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
const PACK_LESSON = { pack: true, nobuild: true, nokeysPhone: true };
/* The map-open steps. The pack stays up — it is what the costs are paid out of
   — END PRACTICE stands down because its chip sits where the map's own controls
   are, and the build cards stand down so that the DECLARED place below is
   habitable. That place is the OFF-MAP fallback: `chromeFor` moves these cards
   into the map's right-hand column whenever the map is actually open, and the
   foot of the screen is where they land if it is not — which happens the moment
   somebody presses Back out of the sequence after the map has closed. A card
   that assumed the map would always be there stood on the build cards. */
const MAP_STEP = { pack: true, noquit: true, nobuild: true };
/* ...except the one map step that is ABOUT the rail, which needs it there. */
const MAP_KEEP_RAIL = { pack: true, noquit: true };
/* After the road lands: the standings come up and the bottom bar is empty, so
   the closing card can sit as low as the score lesson's. */
const SCORING_NOKEYS = { pack: true, ranks: true, nobuild: true };
/* ...the score lesson, with the pack away, for the steps that are about one
   corner of the screen and do not want a second bright thing in another.
   "I don't need the My Pack section highlighted." */
const SCORE_NOPACK = {
  ranks: true, nobuild: true, nokeys: true, noquit: true
};
/* ...and with it, for the steps that read a cost while they read a score.
   Everything in the corners stands down either way so the standings are the
   only lit thing — END PRACTICE included, being a cream chip a thumb's width
   from the counter being pointed at. */
const SCORE_LESSON = {
  pack: true, ranks: true, nobuild: true, nokeys: true, noquit: true
};
/*   "Hide the build map and pause buttons. Push the instructions for the step
 *    closer to the bottom of the screen. Darken the screen aside from the
 *    character that's running around and the trading post in the centre." */
const MARKET_WALK = { pack: true, nobuild: true, nokeys: true };
/* The trade steps stand beside the sheet rather than over it, and the sheet
   narrows to make room — see `tut-sidepanel` in tutorial.css. */
const TRADE_STEP = { pack: true, nokeys: true, noquit: true, sidepanel: true };
/*   "Put the instructions in the middle of the screen ... and darken the screen
 *    except for the 4 build cards at the bottom." No veil on this one: the four
 *    cards have to stay lit, so the wash does the work and the card simply
 *    stands in the middle of it. */
const CARD_LESSON = { pack: true, nokeys: true };
/* ...and the one card step that stands in the pack's own slot, so the pack
   cannot be up while it is there. See the `cards` step. */
const CARD_STEP = { nokeys: true };

/*
 * WHAT IS IN THE PACK WHEN THE BUILDING LESSONS START.
 *
 *   "Give them enough resources to build 5 roads and 3 settlements, but they
 *    have no ore, so they can't build a city."
 *
 * Five roads is 20 wood and 20 brick; three settlements is another 12 of each
 * plus 12 wheat and 12 wool. Ore is ZERO and that is the load-bearing part —
 * `t.give` sets rather than tops up, so the CITY card cannot come up gold
 * beside the ROAD card the step is telling the player to press.
 */
/* The city lesson is where ORE finally arrives. It has been zero since the road
   step so the CITY card could not come up gold before anybody explained it. */
const CITY_PACK = Object.freeze({
  wood: COST.road.wood * 3, brick: COST.road.brick * 3,
  wheat: COST.city.wheat + COST.settlement.wheat,
  wool: COST.settlement.wool,
  ore: COST.city.ore
});

/*   "We're going to reset and give them predetermined resources again here. So
 *    let's say they have 30 wood, 30 brick and 30 sheep, 3 wheat and 0 ore."
 *
 * Deep in three things and short of the one the step asks them to buy, which is
 * what makes the lesson land: the trade is not a demonstration, it is the only
 * way to get the wheat. */
const TRADE_PACK = Object.freeze({
  wood: 30, brick: 30, wool: 30, wheat: 3, ore: 0
});

/*   "Make sure even if I traded cards away that I'm topped up to purchase at
 *    least 4 of these cards during this step. That should reset as soon as this
 *    step opened." */
const CARD_PACK = Object.freeze({
  wood: 0, brick: 0,
  wool: COST.card.wool * 4, wheat: COST.card.wheat * 4, ore: COST.card.ore * 4
});

const ROAD_PACK = Object.freeze({
  wood: COST.road.wood * 5 + COST.settlement.wood * 3,
  brick: COST.road.brick * 5 + COST.settlement.brick * 3,
  wheat: COST.settlement.wheat * 3,
  wool: COST.settlement.wool * 3,
  ore: 0
});
const SCORING = { pack: true, ranks: true, nobuild: true };
/* The awards step, and the reason it carries `nobuild` like the scoring steps
   do. Its badge sits `low` — it has to, because it is pointing at the two rows
   that have just appeared in the BOTTOM-left corner and it must not stand in front
   of them — and `low` on a 375px screen puts its foot 26px INSIDE the build
   cards. That is the owner's one hard rule about this badge, in his words:
   "but don't ever cover the build pause and map buttons. they shouldn't overlap
   at all." Nothing on this step asks the player to build, so the four cards
   stand down for it exactly as they do for step 11. */
const EVERYTHING = { pack: true, ranks: true, awards: true, nobuild: true };
/* The awards lesson. Everything down but the awards card at the bottom-left,
   which
   is the one thing the three slides are about — including END PRACTICE and the
   three keys, for the same reason the score lesson loses them. */
const AWARD_LESSON = {
  pack: true, ranks: true, awards: true,
  nobuild: true, nokeys: true, noquit: true
};
/* The last card, and the only step in the run that clears the screen entirely.
 *
 *   "On the That is the Whole Game popup and the end of the tutorial, i want to
 *    hide the build map pause button, the road and knight counter, the
 *    leaderboard, and the your stack section. Basically the only things apart
 *    from the game board/island itself should be the popup moved up into the
 *    middle of the screen a bit more. and the end practice button."
 *
 * It used to be the opposite — everything introduced stayed introduced, on the
 * reasoning that the last thing you see should be the interface a real match
 * hands you. That reads well written down and badly on a phone: the sentence
 * "that is the whole game" was arriving over five separate readouts, none of
 * which the sentence is about. So every flag is off, `nogear` takes the last
 * corner, and `noquit` is deliberately ABSENT — END PRACTICE is one of the two
 * things that stays. */
const DONE = { nobuild: true, nokeys: true, nogear: true };

/* ============================================================ THE CHAPTERS
 *
 *   "Simplify the steps, since 43 is overwhelming. Split it into 1a, 2c, 5b
 *    etc., grouping them into things like picking up resources, building a
 *    road, building settlements, building a city, trading, development cards,
 *    conclusion."
 *
 * "STEP 31 OF 50" is a true number and a discouraging one: it tells a player
 * how much is left and nothing about what they are doing. "3d · ROADS" tells
 * them they are four cards into a chapter about roads, which is a thing a
 * person can hold in their head — and the chapter ends, visibly, which is the
 * part that makes a long run feel finite.
 *
 * Listed by the id each chapter STARTS on rather than by count, so inserting a
 * step in the middle of one costs nothing: the chapter it lands in is decided
 * by where it sits, not by a number anybody has to keep true. `tag` is what
 * fits under the badge's letter at 6.5px.
 */
const CHAPTERS = [
  { at: 'hello',        n: 1, tag: 'Start',  name: 'Getting started' },
  { at: 'land',         n: 2, tag: 'Gather', name: 'Picking up resources' },
  { at: 'buildkey',     n: 3, tag: 'Roads',  name: 'Building a road' },
  { at: 'reach',        n: 4, tag: 'Settle', name: 'Building settlements' },
  { at: 'city',         n: 5, tag: 'Cities', name: 'Building a city' },
  { at: 'market',       n: 6, tag: 'Trade',  name: 'Trading' },
  { at: 'cards',        n: 7, tag: 'Cards',  name: 'Development cards' },
  { at: 'awards',       n: 8, tag: 'Bonus',  name: 'Points you never build' },
  { at: 'done',         n: 9, tag: 'Done',   name: 'Conclusion' }
];

/** a, b, c ... and then a2, b2 for a chapter longer than the alphabet. */
function letterFor(i) {
  const a = String.fromCharCode(97 + (i % 26));
  return i < 26 ? a : a + (Math.floor(i / 26) + 1);
}

/** Stamp `chapter`, `label` and `chapterName` onto each step, in place. */
function paginate(steps) {
  let chap = CHAPTERS[0], within = 0;
  for (const step of steps) {
    const start = CHAPTERS.find(c => c.at === step.id);
    if (start) { chap = start; within = 0; }
    step.chapter = chap.n;
    step.chapterTag = chap.tag;
    step.chapterName = chap.name;
    step.label = `${chap.n}${letterFor(within)}`;
    within++;
  }
  return steps;
}

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

  /* The player's own seat color, named rather than shown, because the step
     that introduces the rail is read before the rail is looked at:
     "your color is blue". Read off the seat rather than hard-coded, so it
     cannot drift if the palette or the seat order ever changes. */
  const myColorName = () => (me.color && me.color.key)
    ? String(me.color.key).toLowerCase()
    : 'your color';

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

  return paginate([
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
      /* The OKAY key came off with the paragraph. The card is three short
         sentences over a veiled screen and NEXT is right there — a second key
         that does the same thing as the one beside it is a choice the player
         has to make about nothing. */
      text: 'Only you’re playing right now. Feel free to explore.',
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
       * Both are true of both devices: systems/input.js takes the arrow keys
       * as well as a drag from anywhere that is not a button. This only decides
       * which one the sentence NAMES, and it names one, because a first
       * instruction that offers two ways to walk is a first instruction that
       * has to be read twice.
       */
      text: () => (handheld()
        ? 'Press and drag anywhere on the screen to move.'
        : 'Use the ARROW KEYS to move.'),
      size: 'big', place: 'top', hud: OPENING,
      /* "Let me walk a bit longer on step two before step three opens up."
         Six units is about two seconds of holding a direction — long enough to
         prove the stick works and much too short to have gone anywhere. */
      check: () => t.walked() > 26
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
      /* "Make the text more clear. Say something instead like: you can collect
         resources from your hexes where you've built a settlement on the corner
         of. Those are the glowing hexes."

         The old line said WHICH hexes glow and never said why, which left the
         one rule this game turns on — you only collect where you have built —
         to be inferred from a color. */
      text: 'You can only collect from a resource hex where you have a settlement on one of its corners.',
      live: true,
      /* The gold dots came off: the glow IS the mark, and a second one on top
         of it was two answers to the same question. */
      size: 'big', place: 'top', hud: OPENING, spot: true,
      /* A player who sweeps a hex while still on the "walk onto one" card has
         plainly learned both of the next two lessons, so they go straight to
         the countdown rather than being asked to do it again twice. */
      jumpIf: () => t.sweptAny(), jumpTo: 'rest',
      check: () => t.workable().some(id => t.standingOn(id))
    },

    /* 4 ------------------------------------------------------------------ */
    {
      id: 'collect',
      title: 'Run things over',
      /*
       *   "Instead of saying collect six things, say collect all of the items
       *    on one hex."  ...and  "wait a bit longer before the clear the hex
       *    step shows up."
       *
       * The same change said twice. "Six things" was a number with nothing
       * behind it — a hex holds anywhere from 5 to 28 — and six of them is over
       * in about four seconds, which is why the next step arrived before this
       * one had been felt. Asking for a whole hex makes the count mean
       * something AND takes as long as the lesson deserves; the sweep step
       * after it then skips itself when the hex really does come up empty here,
       * which it usually will.
       */
      text: 'Everything growing on a hex you own is yours. Walk over it — no tapping, no waiting. Clear all of the items off one hex.',
      /* No ring: the wash already says which hexes, and pointing at ONE item
         on one of them is a smaller instruction than the step is giving. */
      size: 'big', place: 'top', hud: OPENING, spot: true,
      jumpIf: () => t.sweptAny(), jumpTo: 'rest',
      check: () => me.stats.gathered - t.base.gathered >= t.hexLoad()
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
      /*
       *   "Hide the step for a few seconds before the step/instructions show up
       *    again, so that I can see the highlighted countdown."
       *   "Don't give specifics on step 6 regarding the number of pips, just
       *    say that different numbers represent different lengths before it
       *    refreshes. Don't mention pips at all. Shorten the amount of text."
       *
       * `quiet` gives the clock the screen to itself first: the wash is already
       * up and lighting it, and a card arriving in the same frame is a card
       * standing where the player was about to look. Two and a half seconds is
       * long enough to watch a digit change, which is the whole point of the
       * step.
       *
       * The words lost the arithmetic with the pips. Naming a range in seconds
       * invited exactly the reading the shorter line avoids — that six is a
       * constant, or that the player should be counting — when all they need to
       * know is that the disc on the hex is the reason one comes back faster
       * than another.
       */
      text: 'Every hex has a countdown, and different numbered hexes take different amounts of time to reset.',
      quiet: 2.5,
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
      text: 'In the top middle of the screen is your pack. It shows every resource you have collected.',
      size: 'big', place: 'foot', hud: PACK_LESSON,
      /* "Highlight the pack more, and slightly darken the hexes a bit more —
         but not as much as the fully dark section." Three levels: the pill lit
         and ringed in gold, the player's own land at half wash so they can
         still run it while they read, everything else full dark. */
      spot: true, spotDim: 0.55, spotMe: true,
      spotDom: ['.hud-tc'], spotGlow: true
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
      text: 'Tap BUILD, bottom right. Four cards slide up — road, settlement, city, card — and each one fills as you gather resources from the island. It turns to gold when you can afford it.',
      size: 'big', place: 'top', hud: OPENING,
      dom: ['.hud-br .cbtn.gold'],
      /* "Just highlight the shape of the build key, not also the pause and map
         button." The step names one control, so it lights one. */
      /* Raised, so PAUSE and MAP go dark with the island rather than sitting
         bright beside the one key being named. */
      /* The ring names it; the box was a second answer to the same question.
         What the key needed instead was to stop being DARK — it is a plate like
         any other and the raised wash was sitting on it. Hole plus lift, no
         border. */
      /* A ROUND hole on a round key. The rectangle was the "weird square", and
         the lift was making up for a hole that only half cleared — a full
         circular hole leaves the key at exactly the brightness it has in every
         other step, which is what was asked for. */
      spotOverUi: true, spotDom: ['.hud-br .cbtn.gold'], spotRound: true,
      holdNext: true,
      check: () => buildRowOpen()
    },

    /* 9 ------------------------------------------------------- BUY A ROAD
     *
     *   "Darken the screen except for the four build type buttons on the bottom
     *    of the screen. Don't overcomplicate the step, there is too much text on
     *    the instructions. Just say that it costs you 4 wood and 4 brick to
     *    build a road, tap the road card to open the map and build your road.
     *    Again the first time they visit this step within the tutorial don't let
     *    them press next unless they press the road button already once. Make
     *    sure you give them a predetermined number of resources for this step —
     *    let's say they clear the resources they already collected, and you give
     *    them enough resources to build 5 roads and 3 settlements, but they have
     *    no ore, so they can't build a city. Once I click road, the yellow
     *    circle should remove and it goes to the next step."
     *
     * The BRIEF is gone. It was a paragraph and an OK key in front of a step
     * whose whole content is one sentence, and the note is explicit that this is
     * too much reading — so the sentence IS the step now, and the cost is in it
     * because the cost is the only number that matters here.
     *
     * THE PACK IS SET RATHER THAN TOPPED UP, and that is what makes the rest of
     * the run behave. `t.give` zeroes everything it is not handed, so ORE is
     * zero on purpose: the CITY card cannot light up gold next to the ROAD card
     * the player is being told to press, which is exactly the kind of thing that
     * makes somebody tap the wrong one. Five roads and three settlements is what
     * the note asks for and it is enough to carry the next several steps without
     * another top-up interrupting them.
     */
    {
      id: 'road',
      title: 'Build a road',
      text: `A road costs ${COST.road.wood} wood and ${COST.road.brick} brick. Tap the ROAD card to open the map.`,
      enter: () => t.give(ROAD_PACK),
      needs: 'buildcards',
      size: 'big', place: 'top', hud: OPENING,
      dom: ['.bcard[data-kind="road"]'],
      /* Everything down except the four cards. The ring stays on ROAD — it is
         naming one of four, which is the job a ring is actually good at. */
      spotDom: ['.hud-bc'],
      holdNext: true,
      /* "Once I click road ... it goes to the next step." The map opening is
         what a real tap on that card does, and the ring goes with the step. */
      check: () => mapIn('road') || me.roads.size > t.base.roads
    },

    /* 10 --------------------------------------------- MOVING AROUND THE MAP
     *
     *   "You can hide the players column on the right of the screen and put the
     *    instructions box for this step over there. Say zoom in and zoom out
     *    with your fingers or click and drag to navigate the map. After a few
     *    seconds of them doing that, have another step."
     *
     * The first of five short steps that all live in the map's own right-hand
     * column — see `onMap` in systems/tutorial.js and the SIDE band in
     * tutorial.css. The badge used to vanish entirely the moment this surface
     * opened, which was right when it had nothing to say about the map and is
     * wrong now that the map is the lesson.
     *
     * "After a few seconds of them doing that" is read as MOVING, not waiting:
     * the step ends once the player has actually pushed the board around,
     * measured off the map's own pan/zoom pose. Somebody who already knows how
     * to work a map is not held here, and somebody who has not touched it is not
     * moved on by a timer while they read.
     */
    {
      id: 'roadmapmove',
      title: 'Move the map',
      text: handheld()
        ? 'Drag with one finger to move around the island. Pinch to zoom in and out.'
        : 'Click and drag to move around the island. Scroll to zoom in and out.',
      needs: 'map:road',
      onMap: true, size: 'big', place: 'foot', hud: MAP_STEP,
      check: () => t.mapMoved() > 0.55
    },

    /* 11 ------------------------------------------------- WHO IS ON THE BOARD
     *
     *   "The next step shows the players section on the right and covers the
     *    map / darkens it, to show there's the players and their colors, your
     *    color is blue."
     *
     * So this one gives the column BACK — it is the only step in the sequence
     * that wants the rail rather than the slot — and stands in the middle over a
     * darkened board, because the thing being pointed at is the rail itself.
     */
    {
      id: 'roadmapwho',
      title: 'Who else is here',
      /* "Simplify the step description — right now it's just not easy to
         understand with a quick once-over." One idea a sentence. */
      text: () => `The four players and their colors show up on the right side of the map. Your settler, and every road and settlement you build, will be ${myColorName()}.`,
      /* The veil came off: it darkened the rail as well, which is the one thing
         this step is pointing at. The wash lights it instead, and it is raised
         above the interface because the rail lives inside the map. */
      /* The rail is a dark plate, so a hole in the wash only stopped it being
         dimmed — `spotBright` adds light to it instead. And the player's own
         pieces are NOT lit here: that is the next step's job.  */
      needs: 'map:road',
      onMap: 'centre', size: 'big', place: 'centre',
      /* "I don't need it darkened then artificially lightened, I just need
         that part not darkened in the first place." So: a hole, at full
         strength, and nothing else on top of it. The lift made it read flat
         because it was adding light to something that had already lost its
         own. */
      hud: MAP_KEEP_RAIL, railOpen: true,
      /*   "The players section looks faded instead of bright — I want it to
       *    look like it normally would, instead of having some faded film over
       *    the top. Just keep the rest of the screen darker."
       * So the lift came back off. A `lighter` composite ADDS colour, and on a
       * dark blue plate a warm 16% addition reads as exactly the milky film
       * described. The plain hole is the honest treatment: the rail at its own
       * brightness, everything around it turned down. */
      spotDom: ['.ov-rail']
    },

    /* 12 -------------------------------------------------- WHAT IS ALREADY YOURS
     *
     *   "Then the next step shows the map again with the instructions covering
     *    where the players section is. It highlights the blue roads and
     *    settlements that already exist on the map, showing that those are
     *    yours — without a yellow circle, but instead just darkening the rest of
     *    the map slightly again."
     */
    {
      id: 'roadmapmine',
      title: 'These are yours',
      text: () => `You start with two settlements and two roads — the ${myColorName()} pieces here. Everything new you build must connect to them.`,
      /* "Darken everything that isn't my own settlements and roads." Read off
         the map's own projection, roads included — see `minePieceXY`. */
      needs: 'map:road',
      onMap: true, size: 'big', place: 'foot', hud: MAP_STEP,
      spotMapMine: true, spotMapR: 40,
      /* "Remove the white glowing borders for where the user can place the
         roads — too visually busy, and that's the focus of the next step
         anyway." The map keeps its targets (taps, metrics); it just does not
         PAINT them for this one step. See `setTargetsHidden` in overview.js. */
      hideMapTargets: true
    },

    /* 13 ------------------------------------------------- WHERE A ROAD MAY GO
     *
     *   "The next step shows the white highlights showing where you can build
     *    roads right now, and it asks them to click one of the glowing sections
     *    to place a road."
     */
    {
      id: 'roadmappick',
      title: 'Pick a line',
      /* "Darken the rest and just highlight the white sections for where I can
         place a road. Force me to tap it to move forward to the next step." So
         the wash lights the legal edges and nothing else, and NEXT is held —
         this is the one step where reading past it leaves the player on a map
         with no idea what they were meant to touch. */
      text: 'The glowing lines are every place a road may go. Tap one.',
      needs: 'map:road',
      onMap: true, size: 'big', place: 'foot', hud: MAP_STEP,
      spotMapTargets: true, spotMapR: 34,
      holdNext: true,
      check: () => t.roadArmed() || me.roads.size > t.base.roads
    },

    /* 14 ---------------------------------------------------------- CONFIRM
     *
     *   "Mention that you have to click it twice to confirm that's actually
     *    where you want to place it, and make them click it again."
     */
    {
      id: 'roadplace',
      title: 'Tap it again',
      text: 'That line is chosen, not built. Tap it once more to confirm.',
      needs: 'map:road',
      onMap: true, size: 'big', place: 'foot', hud: MAP_STEP,
      spotMapSel: true, spotMapR: 40,
      /* "Force them to click one road and submit it to go to the next step." */
      holdNext: true,
      check: () => me.roads.size > t.base.roads
    },

    /* ------------------------------------------------------- REACH FURTHER
     *
     * Skipped outright when the network already touches a free corner, which
     * after the road step it usually does. It exists for the board where it
     * does not. */
    {
      id: 'reach',
      title: 'One more road',
      text: 'Your network has to REACH a free corner before you can settle it. Build one more, further out.',
      skipIf: () => legalSettlements(state, 0).length > 0,
      needs: 'buildcards',
      size: 'big', place: 'top', hud: OPENING,
      dom: ['.bcard[data-kind="road"]'],
      spotDom: ['.hud-bc'],
      check: () => legalSettlements(state, 0).length > 0
    },

    /* ------------------------------------------------------- A SETTLEMENT
     *
     *   "Do a similar process having them build a settlement, where it also
     *    makes clear that they can only build at least 2 roads away from the
     *    nearest settlement or city — that includes other players' settlements
     *    and cities."
     *
     * The same four beats as the road, because the note asks for the same
     * process and because the player has just learned to read them: buy it,
     * find the legal spots, tap, tap again. The one thing that is different is
     * the rule, and it gets a step of its own on the map with the legal corners
     * lit — the two-roads-clear rule is invisible until you see which corners
     * refuse to glow, which is exactly when it can be explained.
     */
    {
      id: 'settle',
      title: 'Build a settlement',
      text: `It costs ${COST.settlement.wood} wood, ${COST.settlement.brick} brick, ${COST.settlement.wheat} wheat, and ${COST.settlement.wool} wool to build a settlement. Tap the SETTLEMENT card.`,
      enter: () => t.give(ROAD_PACK),
      needs: 'buildcards',
      size: 'big', place: 'top', hud: OPENING,
      dom: ['.bcard[data-kind="settlement"]'],
      spotDom: ['.hud-bc'],
      holdNext: true,
      check: () => mapIn('settlement') || me.settlements.size > t.base.settlements
    },

    {
      id: 'settlerule',
      title: 'Two roads clear',
      text: 'A settlement must be at least TWO ROADS away from the nearest settlement or city — anyone’s, not just yours. The glowing corners are the only ones far enough.',
      needs: 'map:settlement',
      onMap: true, size: 'big', place: 'foot', hud: MAP_STEP,
      spotMapTargets: true, spotMapR: 36,
      /* Your own roads and settlements come up too, at half strength, so the
         two-roads rule can be SEEN — the corners you may take against the ones
         you already hold. The legal spots stay the brighter of the two. */
      spotMapMine: true, spotMapMineDim: 0.45,
      /* Tapping a corner while this is up means the rule has been read and the
         player is already ahead of it — carry them straight to the confirm. */
      check: () => t.placeArmed() || me.settlements.size > t.base.settlements
    },

    {
      id: 'settlepick',
      title: 'Pick a corner',
      text: 'Tap one of the glowing corners.',
      skipIf: () => t.placeArmed(),
      needs: 'map:settlement',
      onMap: true, size: 'big', place: 'foot', hud: MAP_STEP,
      check: () => t.placeArmed() || me.settlements.size > t.base.settlements
    },

    {
      id: 'settleplace',
      title: 'Tap it again',
      text: 'You have selected a placement. Press it again to confirm.',
      needs: 'map:settlement',
      onMap: true, size: 'big', place: 'foot', hud: MAP_STEP,
      check: () => me.settlements.size > t.base.settlements
    },

    {
      id: 'settlebuilt',
      title: 'You gained a victory point!',
      text: 'And more land to explore with it — every hex touching that new corner you built a settlement on is yours to collect from now.',
      quiet: 1.9,
      /* The wash rather than the veil, because this card now lights the same
         counter the next one does — a veil would take that with everything
         else — and END PRACTICE stands down beside it. */
      size: 'big', place: 'centre', hud: SCORE_NOPACK,
      spotOverUi: true, spotGlow: true, spotDom: ['.hud-tr']
    },

    /* ------------------------------------------------------------- THE SCORE
     *
     * Moved here on purpose: the player has just scored their first point, so
     * the standings have something in them to read.
     */
    {
      id: 'points',
      title: () => `${VICTORY_POINTS} points wins the game`,
      /* One fact a line. `.coach-t` keeps its newlines (see `white-space` in
         tutorial.css), so this is a list without needing a list. */
      text: [
        'The current standings are in the top right corner.',
        '',
        'Settlement  =  1 victory point',
        'City  =  2 victory points'
      ].join('\n'),
      /* Centred, and the pack goes with the rest: the step is about the
         standings and nothing else on the screen is being read. */
      size: 'big', place: 'centre', hud: SCORE_NOPACK,
      spotOverUi: true, spotDom: ['.hud-tr'], spotGlow: true
    },

    /* ------------------------------------------------------------- A CITY
     *
     *   "I'd like for you to then clarify and do a similar process for the
     *    building of a city that you did for building a settlement and road,
     *    with the clear steps, multiple steps, and with the map open etc."
     *
     * Same four beats again. `CITY_PACK` is where the ore finally arrives — it
     * has been zero since the road lesson so that the CITY card could not light
     * up before anybody had explained it, and this is the step that explains it.
     */
    {
      id: 'city',
      title: 'Grow it into a city',
      text: `A city replaces one of your settlements and is worth TWO victory points instead of one. It costs ${COST.city.wheat} wheat and ${COST.city.ore} ore. Tap the CITY card.`,
      enter: () => t.give(CITY_PACK),
      needs: 'buildcards',
      size: 'big', place: 'top', hud: OPENING,
      dom: ['.bcard[data-kind="city"]'],
      spotDom: ['.hud-bc'],
      holdNext: true,
      check: () => mapIn('city') || me.cities.size > t.base.cities
    },

    {
      id: 'cityrule',
      title: 'Only your own',
      text: 'A city does not take new ground. The only spots glowing are settlements you already own — you’re upgrading a settlement, not building in a new location.',
      needs: 'map:city',
      onMap: 'centre', size: 'big', place: 'centre', veil: true, hud: MAP_STEP
    },

    {
      id: 'citypick',
      title: 'Pick a settlement',
      text: 'Select the settlement you want to upgrade to a City.',
      needs: 'map:city',
      onMap: true, size: 'big', place: 'foot', hud: MAP_STEP,
      spotMapTargets: true, spotMapR: 38,
      holdNext: true,
      /* "When I tap the settlement once it should automatically go to the next
         step that says press again to confirm." */
      check: () => t.placeArmed() || me.cities.size > t.base.cities
    },

    {
      id: 'cityplace',
      title: 'Tap it again',
      text: 'Chosen, not built. Tap the SAME settlement once more to confirm the upgrade.',
      needs: 'map:city',
      onMap: true, size: 'big', place: 'foot', hud: MAP_STEP,
      holdNext: true,
      check: () => me.cities.size > t.base.cities
    },

    {
      id: 'citybuilt',
      title: 'Two points',
      text: 'That corner is worth 2 points now instead of 1. It collects exactly the same as it did before.',
      quiet: 1.9,
      /* Lit and pointed at: the ring carries a bobbing chevron and `markerFor`
         clamps it to the frame, so a city built behind the camera still has an
         arrow saying which way to look. */
      /* "On step 5e, remove the End Practice button" — `noquit` on top of the
         usual scoring wardrobe, for this one step.
         ...and then, from the phone build:
         "On step 5e, in the live tutorial, hide the build map and pause
          buttons, and push the instructions for the step lower to the bottom of
          the screen."
         `nokeys` is the first half. The second half is free: `at-foot` already
         drops onto the gutter the moment the band under it is empty — see
         `.coach.tut-nokeys .coach-card.at-foot` in tutorial.css — so taking the
         keys away IS pushing the card down. */
      size: 'big', place: 'foot',
      hud: { pack: true, ranks: true, nobuild: true, nokeys: true, noquit: true },
      /* No ring. A ring says "this one" about something you can SEE, and
         `markerFor` clamps it into the frame — which round the edge of the
         screen turns into a circle drawn on a patch of sea. The wash still
         lights the city when it is in view, and when it is not, the arrow says
         which way to walk. */
      pointTo: () => t.newestCity(),
      spotWorld: () => { const c = t.newestCity(); return c ? { x: c.x, z: c.z, lift: 2.2, r: 110 } : null; }
    },

    /* ------------------------------------------------------------ THE MARKET
     *
     *   "Hide the build map and pause buttons. Push the instructions for the
     *    step closer to the bottom of the screen. Darken the screen aside from
     *    the character that's running around and the trading post in the
     *    centre. Remove the yellow circle."
     */
    {
      id: 'market',
      /* "Don't call the trading post the Great Market or the market — always
         refer to it as the Trading Post." Everywhere a player reads it: here,
         the sheet's title bar, the map's rate-board popup, the guide line and
         the walk-up prompt (trade.js, overview.js, hud.js, economy.js). */
      title: 'Walk to the Trading Post',
      text: 'The Trading Post is the hex in the middle of the island. Walk onto it.',
      size: 'big', place: 'foot', hud: MARKET_WALK,
      spotMe: true,
      /* "Give a little floating directional arrow, like they had on the step
         that points to the new city you built" — the same compass, the same
         rule: it appears when the post is off the edge of the screen and says
         which way to walk. */
      pointTo: () => ({ x: MARKET.x, z: MARKET.z }),
      spotWorld: () => ({ x: MARKET.x, z: MARKET.z, lift: 1.0, r: 120 }),
      check: () => !!me.nearTrade
    },

    /*   "When I get close to it, the next step should be to say press the badge
     *    that says enter/trade. That instruction should be on the bottom of the
     *    screen." */
    {
      id: 'marketcue',
      title: 'Open the post',
      text: 'You are on it. Press the badge that has come up — the one that says TRADE — to open the trading post.',
      size: 'big', place: 'foot', hud: MARKET_WALK,
      /* The post stays lit under the badge: "still keep the rest of the screen
         except for the market hex dark." */
      spotWorld: () => ({ x: MARKET.x, z: MARKET.z, lift: 1.0, r: 120 }),
      spotDom: ['.tradecue:not(.hid)'], spotGlow: true, spotOverUi: true,
      check: () => !!(game.panels && game.panels.isOpen)
    },

    /* ------------------------------------------------------ THE TRADING POST
     *
     *   "When the trade opens up, I want you to still have no yellow circle but
     *    for the steps to explain how to trade over the top of the trading
     *    popup somewhere. Maybe it's a pop-out from the right side like with the
     *    road building map, that resizes the trade screen temporarily. And it
     *    says you always trade 4 resources for 1 item at the trading post.
     *    There shouldn't be too much text per step and it should never cover
     *    the elements on the trading post popup."
     *
     * So the sheet moves rather than the card hiding: `onSheet` puts the coach
     * in the same right-hand column the map steps use and narrows the sheet's
     * own box to match (see `tut-sidepanel` in tutorial.css), which is the only
     * arrangement where a 600px sheet and a 186px card can both be fully on a
     * 667px screen. Four short steps instead of one paragraph.
     */
    {
      id: 'traderate',
      title: 'Four for one',
      text: `Every trade here is the same price: ${TRADE_BASE} of one thing for 1 of another. The post never haggles.`,
      enter: () => t.give(TRADE_PACK),
      needs: 'sheet',
      onSheet: true, size: 'big', place: 'foot', hud: TRADE_STEP
    },

    /*   "Then it should say to click up to say how many of that resource you
     *    want to add to your pack, and click the down arrow to determine how
     *    many you're willing to give away. Walk them through clicking the up
     *    arrow on wheat, and then the down arrow on wood." */
    {
      id: 'tradeask',
      title: 'Ask for wheat',
      /* Dealt again on the way in: the player may have spent the last few
         minutes poking at the post, and every step after this one is written
         against a known pack. And the sheet's own staging is wiped for the
         same reason — "if I had pressed the up arrow 5 times on another
         resource, clear that, so when I ask for a wheat and offer a wood it
         will actually let me do the trade." */
      enter: () => {
        t.give(TRADE_PACK);
        try {
          if (game.panels && game.panels.clearTrade) game.panels.clearTrade();
        } catch (e) { /* silent */ }
      },
      text: 'The UP arrow over a resource says how many you want ADDED to your pack. Tap the up arrow over WHEAT.',
      needs: 'sheet',
      onSheet: true, size: 'big', place: 'foot', hud: TRADE_STEP,
      /* A glowing border round the arrow itself rather than a ring floating
         over it, and the rest of the sheet turned down so it is the only lit
         control. NEXT is held: reading past a step that names one arrow leaves
         the player on a sheet with nothing asked for. */
      spotOverUi: true, spotGlow: true,
      spotDom: ['.sheet.trade .tr-col[data-res="wheat"] .tr-arr.up'],
      /* ...and the card between the arrows comes up a stop so the COLUMN is
         findable at a glance: "brighten up the middle bar of the resource
         buttons — it doesn't need a border, just make it brighter." */
      spotBright: ['.sheet.trade .tr-col[data-res="wheat"] .tr-card'],
      holdNext: true,
      check: () => t.tradeGetting('wheat') > 0
    },

    {
      id: 'tradegive',
      title: 'Pay in wood',
      text: `The DOWN arrow says what you are willing to give away. You have wood to spare — tap the down arrow under WOOD until it reads ${TRADE_BASE}.`,
      needs: 'sheet',
      onSheet: true, size: 'big', place: 'foot', hud: TRADE_STEP,
      spotOverUi: true, spotGlow: true,
      spotDom: ['.sheet.trade .tr-col[data-res="wood"] .tr-arr.dn'],
      spotBright: ['.sheet.trade .tr-col[data-res="wood"] .tr-card'],
      holdNext: true,
      check: () => t.tradeGiving('wood') >= TRADE_BASE
    },

    {
      id: 'tradego',
      title: 'Make it',
      text: 'The TRADE button turns green the moment the bill is covered. Press it.',
      needs: 'sheet',
      onSheet: true, size: 'big', place: 'foot', hud: TRADE_STEP,
      spotOverUi: true, spotGlow: true,
      spotDom: ['.sheet.trade .sheet-foot .btn'],
      spotBright: [
        '.sheet.trade .tr-col[data-res="wheat"] .tr-card',
        '.sheet.trade .tr-col[data-res="wood"] .tr-card'
      ],
      holdNext: true,
      check: () => me.stats.traded > t.base.traded
    },

    /* "Once that step is complete, highlight/glow the new numbers that they
        increased and decreased to on the trade popup, darken the rest, and have
        the right side step instructions explain that change simply." */
    {
      id: 'tradedone',
      title: 'Look what moved',
      text: `Wheat is up by 1, wood is down by ${TRADE_BASE}.`,
      needs: 'sheet',
      onSheet: true, size: 'big', place: 'foot', hud: TRADE_STEP,
      /* White, not gold: a gold ring round a gold numeral says nothing. */
      spotOverUi: true, spotGlow: 'white',
      spotDom: [
        '.sheet.trade .tr-col[data-res="wheat"] .tr-count',
        '.sheet.trade .tr-col[data-res="wood"] .tr-count'
      ],
      spotBright: [
        '.sheet.trade .tr-col[data-res="wheat"] .tr-card',
        '.sheet.trade .tr-col[data-res="wood"] .tr-card'
      ]
    },

    /* ------------------------------------------------------- FOUR AT A TIME
     *
     *   "Before we get to step 33, show steps in a similar manner for bulk
     *    trading. For example, if they say they want to add 4 ore, then want to
     *    bulk select the item they want to give up, like brick, make them press
     *    the brick icon in the middle of the arrows to make that trade quicker."
     *
     * The arrows are one at a time and a four-for-one trade taken four times is
     * sixteen taps. The CARD between the arrows pays the whole outstanding bill
     * out of that one pile in a single press, which is the sheet's fastest
     * control and the least discoverable thing on it — the arrows look like the
     * whole interface. Three short steps, same shape as the three above.
     */
    {
      id: 'bulkask',
      title: 'Bulk trading',
      text: 'Tap the UP arrow over ORE four times. The brown band underneath counts what it will cost you.',
      enter: () => t.give(TRADE_PACK),
      needs: 'sheet',
      onSheet: true, size: 'big', place: 'foot', hud: TRADE_STEP,
      spotOverUi: true, spotGlow: true,
      spotDom: ['.sheet.trade .tr-col[data-res="ore"] .tr-arr.up'],
      spotBright: ['.sheet.trade .tr-col[data-res="ore"] .tr-card'],
      holdNext: true,
      check: () => t.tradeGetting('ore') >= 4
    },

    {
      id: 'bulkpay',
      title: 'Pay it in one press',
      text: 'Instead of multiple taps on an arrow: press the BRICK card itself, between its two arrows. It pays the whole bill out of that one pile.',
      needs: 'sheet',
      onSheet: true, size: 'big', place: 'foot', hud: TRADE_STEP,
      spotOverUi: true, spotGlow: true,
      spotDom: ['.sheet.trade .tr-col[data-res="brick"] .tr-card'],
      spotBright: ['.sheet.trade .tr-col[data-res="brick"] .tr-card'],
      holdNext: true,
      /* ANY brick on the bill, not the full sixteen.
       *
       *   "When I press the brick button it should then highlight the trade
       *    button and add a step to complete the trade. Right now it's getting
       *    stuck so I can't see the next button."
       *
       * It was waiting for `>= 16`, and the card pays what the sheet decides it
       * owes — which is not sixteen if the ask was not exactly four, and is not
       * readable at all if the column renders the figure any other way. The
       * step is teaching the PRESS; one brick on the bill proves it happened,
       * and the step after it is the one that finishes the trade. */
      check: () => t.tradeGiving('brick') > 0
    },

    {
      id: 'bulkgo',
      title: 'And take it',
      /* "The description doesn't make sense, and the number of presses is
         incorrect and not relevant to mention specifically." Quite right —
         it was counting its own choreography. Say what the deal is. */
      text: 'Four ore, all paid out of your brick pile. Press TRADE to take it.',
      needs: 'sheet',
      onSheet: true, size: 'big', place: 'foot', hud: TRADE_STEP,
      spotOverUi: true, spotGlow: true,
      spotDom: ['.sheet.trade .sheet-foot .btn'],
      holdNext: true,
      check: () => me.stats.traded > t.base.traded
    },

    /*   "Explain that since they knew they needed extra wheat in order to build
     *    a settlement, here you press trade so that you'll have the resources
     *    needed to build a settlement even if you're not on a wheat hex yet on
     *    the map and can't collect it directly." */
    {
      id: 'tradewhy',
      title: 'Why trading matters',
      /* Shut the post on the way out. This card takes the whole screen behind a
         veil, and a trade sheet still standing under it is a surface nobody can
         reach and nobody was told about. */
      enter: () => t.closeSheet(),
      text: 'If you do not have a settlement or city built on an ore hex, you cannot collect ore — trading is the best way to get it.',
      veil: true, size: 'big', place: 'centre', hud: SCORING_NOKEYS
    },

    /*   "Please also make it clear on the tutorial that you can also trade for
     *    4:1 on the ports. They act like the trading post, plus the 2:1 of the
     *    specific types of resources, or the 3:1. make that clear but also
     *    simple."
     *
     * The whole rule in three sentences, and it IS the whole rule —
     * `activeTradeRatio` in core/rules.js says a dock you have not built on
     * charges TRADE_BASE like the post, a generic one you own charges its 3,
     * and a named one charges its 2 for its own resource and TRADE_BASE for
     * everything else. The numbers are read off the constants rather than
     * typed, so a rebalance cannot leave this card lying.
     *
     * No map, no walk, no thing to press: the docks are already on the board
     * the player has been staring at for six chapters, wearing the very labels
     * this card explains. One veil and one paragraph. */
    {
      id: 'ports',
      title: 'The docks trade too',
      /* THE SETTLEMENT IS THE HEADLINE, NOT A FOOTNOTE.
       *
       *   "it makes it sound like you can use any maritime port for 4:1 even if
       *    you havent built on it. Make it clear ... that you need to have a
       *    settlement on the port in order to use it, and if you do you can
       *    trade either 4:1 of any resource just like the trading post, but also
       *    you can do 3:1 or 2:1 of that specific resource."
       *
       * The first version opened on the price and left ownership to the last
       * clause, which is the wrong way round — a rule you only get to after
       * reading a price is a rule most people never read. Ownership first, in
       * its own sentence, and the two prices after it.
       *
       * One thing is deliberately said the way the CODE behaves rather than the
       * way the note asks: an unowned dock is not locked, it simply charges
       * TRADE_BASE like the post (see `activeTradeRatio` in core/rules.js), so
       * walking to one you do not own buys you nothing. "Worth nothing to you"
       * is the honest version of "you cannot use it" and it does not leave a
       * player who tries it wondering why the sheet opened anyway.
       */
      text: `A dock is only yours once you have built a settlement on one of its two corners — until then it charges the same ${TRADE_BASE} for 1 as the post in the middle, so it is worth nothing to you. Once it IS yours: a plain dock takes 3 of anything for 1, and a dock with a resource on its sign takes just 2 of THAT one. Everything else there still costs ${TRADE_BASE}.`,
      veil: true, size: 'big', place: 'centre', hud: SCORING_NOKEYS
    },

    /* ------------------------------------------------------- THE THREE CARDS
     *
     *   "Put the instructions in the middle of the screen, right now they're a
     *    little low. And darken the screen except for the 4 build cards at the
     *    bottom. Make sure even if I traded cards away that I'm topped up to
     *    purchase at least 4 of these cards during this step. That should reset
     *    as soon as this step opened."
     *
     * ...and the order is scripted, because each of the next three steps is
     * written against the card it is explaining. `t.scriptDeck` fills the queue
     * `drawCard` shifts from; see the note there.
     */
    {
      id: 'cards',
      title: 'Development cards',
      text: `You can also purchase development cards. There are three different types in the deck, and each one costs ${COST.card.wool} wool, ${COST.card.wheat} wheat and ${COST.card.ore} ore. Tap the CARD tile.`,
      enter: () => { t.give(CARD_PACK); t.scriptDeck(); },
      needs: 'buildcards',
      /*   "the popup for instructions is covering of the 4 build cards, can you
       *    actually hide the Your Stack section for this step, and so the popup,
       *    can be at the top of the screen."
       *
       * The step's whole instruction is TAP THE CARD TILE, and the card tile is
       * one of the four it was standing on — a lesson that hides its own target
       * is the one arrangement that cannot work. TOP is the only band left, and
       * the only thing already living there is the pack, so the pack stands
       * down for the one step: `CARD_STEP` is `CARD_LESSON` without `pack`.
       * The costs the sentence quotes are on the card tile itself anyway. */
      size: 'big', place: 'top', hud: CARD_STEP,
      dom: ['.bcard[data-kind="card"]'],
      spotDom: ['.hud-bc'],
      holdNext: true,
      check: () => cardsHeld() > t.base.cards
    },

    /*   "First is a victory point, where the instruction box disappears when
     *    the Card button is clicked, and I see the animation that I won a
     *    victory point, and it explains what that is with an instruction box
     *    after the animation." */
    {
      id: 'vpcard',
      title: CARD_LABEL.victoryPoint,
      /* Two sentences instead of four, and the wash raised so the pack and the
         rest of the interface go down with the island — the point landed in the
         standings and that is the only place to look. */
      text: 'One type of development card is a Victory Point. It is added to your score automatically, and added to the leaderboard.',
      quiet: 2.4,
      size: 'big', place: 'centre', hud: SCORE_NOPACK,
      spotOverUi: true, spotGlow: true, spotDom: ['.hud-tr']
    },

    /*   "The second is the road building, where it just says this will give you
     *    the opportunity to build two roads. And the map will open. (It doesn't
     *    have to open right now though, since they've already built roads.)" */
    {
      id: 'buycard2',
      title: 'Buy another',
      text: 'Tap the CARD card again.',
      needs: 'buildcards',
      size: 'big', place: 'top', hud: OPENING,
      dom: ['.bcard[data-kind="card"]'],
      /* Raised, so the merchant's ENTER TRADE badge — which is still up if the
         player is standing on the post — goes dark with everything else instead
         of competing with the card they are being sent to. */
      /* Not raised: 7a lights the four cards out of a dark ISLAND and this step
         was lighting them out of a dark interface, which came out a stop
         darker for no reason anybody could see. */
      spotDom: ['.hud-bc'],
      holdNext: true,
      check: () => cardsHeld() > t.base.cards
    },

    {
      id: 'roadcard',
      title: CARD_LABEL.roadBuilding,
      /*
       *   "I don't need the weird small Free Roads popup in the right middle of
       *    the screen. Instead just darken everything a second or two after I
       *    see the road building animation, and put the instructions popup in
       *    the middle of the screen while you darken everything else including
       *    the my stack and the build map and pause buttons. Make it clear
       *    since you already know how to build roads, we're just moving to the
       *    next step."
       *
       * The cue was being LIT by this step, which is what made a 90px chip on
       * the right edge the brightest thing on the screen while the sentence
       * explaining it sat somewhere else. The veil takes the whole interface —
       * pack, keys and cue together — and the card stands in the middle of it.
       * The words stop teaching road building, because that was four steps ago.
       */
      text: 'This card lets you build two roads for free. Lay both without spending anything.',
      quiet: 2.4,
      /* Shown ON the map, in the same column every other map lesson uses: the
         card opens a placement map in a real match, so the lesson about it
         should be read against one. `needs` opens it through the CARD's own
         path — free roads, nothing charged — and, per the note, the Free Roads
         cue never appears at all (see `tut-practice .kn-cue`). */
      needs: 'map:freeroads',
      onMap: true, size: 'big', place: 'foot', hud: MAP_STEP,
      /*   "7d didn't disappear or go to the next step after I built two roads,
       *    like it should've gone to 7e."
       * It had no check, so nothing ever carried it — the player laid both
       * roads, the map folded away, and the card sat there describing a thing
       * that was finished. Two roads more than the step opened with is the
       * lesson done. */
      check: () => me.roads.size >= t.base.roads + 2
    },

    /*   "The knight card would be the third. It should hide the instruction box
     *    again for the third time, showing the knight card animation, then open
     *    the map. Then the same thing with the instructions on the right side of
     *    the screen where the players section normally is, and the steps here
     *    should explain that you should place it on the opponent's hex /
     *    resource that is their best, so you stop them from collecting
     *    resources there, and they lose half of what they've already collected.
     *    That explanation should be across multiple steps, not all in one large
     *    text box." */
    {
      id: 'buycard3',
      title: 'One more',
      text: 'Tap the CARD card once more.',
      needs: 'buildcards',
      size: 'slim', place: 'top', hud: OPENING,
      dom: ['.bcard[data-kind="card"]'],
      spotDom: ['.hud-bc'],
      check: () => cardsHeld() > t.base.cards
    },

    {
      id: 'knight',
      title: CARD_LABEL.knight,
      text: 'The Knight. This one you aim — the map opens so you can choose a hex.',
      quiet: 2.0,
      /* "7f — the background should be dark." The veil, not the wash: this is
         one sentence between two surfaces, and the veil comes up with the card
         after the quiet gap, so the draw animation plays on a bright screen and
         THEN everything steps back for the words. */
      veil: true,
      size: 'big', place: 'centre', hud: SCORING_NOKEYS
    },

    {
      id: 'knightwhere',
      title: 'Aim it at their best hex',
      text: 'Place the Knight on a hex where an opponent picks up the most resources — a high number with their settlement on the corner. While the Knight is on that hex, they can’t pick up any of its resources.',
      needs: 'map:robber',
      /* "Use your best judgement on what sections should be highlighted." The
         sentence names a hex, so the wash lights hexes: the three busiest tiles
         a rival is actually built on, and nothing else. See `rivalHexXY` in
         overview.js for why this is not the legal-target list. */
      spotMapRivals: true, spotMapMax: 3,
      onMap: true, size: 'big', place: 'foot', hud: MAP_STEP,
      /* "If they click once on 7g to select a hex, change 7h to tell them to
         press it twice to confirm." Same shape as `citypick`: one tap arms the
         hex and carries the run forward to the confirm step. */
      holdNext: true,
      check: () => t.placeArmed() || state.robberTile !== DESERT.id
    },

    {
      id: 'knightconfirm',
      title: 'Tap it again',
      text: 'Chosen, not sent. Tap the SAME hex once more to confirm.',
      needs: 'map:robber',
      /* Skipped when the Knight already landed — a fast double-tap on the step
         before confirms in one motion, and this card would then be asking for a
         tap that has already happened. */
      skipIf: () => state.robberTile !== DESERT.id,
      /* Just the one that is armed, like the road and city confirms — with a
         hole cut for a HEX rather than for a corner piece. */
      spotMapSel: true, spotMapR: 58,
      onMap: true, size: 'big', place: 'foot', hud: MAP_STEP,
      holdNext: true,
      check: () => state.robberTile !== DESERT.id
    },

    /*   "Once the knight placement is confirmed, close the map, and switch what
     *    was on 7h before to now be on 7i and show it as a popup in front of
     *    the game while the game darkens, instead of being on the right side.
     *    Make 7i also be a popup in the middle of the screen with the rest of
     *    the screen being dark behind it."
     *
     * So the two consequences are read AFTER the deed, off the map, each a
     * veiled card in the middle of the screen. Neither declares `needs`, which
     * is what closes the map on arrival — a surface belongs to the steps that
     * declare it. */
    {
      id: 'knightcost',
      title: 'And it robs them',
      text: 'Everyone with a settlement or city on that hex also loses HALF of everything they are carrying, rounded down. Nobody else is touched, and you never pay it yourself.',
      veil: true,
      size: 'big', place: 'centre', hud: SCORING_NOKEYS
    },

    {
      id: 'knightown',
      title: 'Your own hex is fair game',
      text: 'Landing it on a hex of your own still lets YOU collect there — it only shuts out the rivals built on it.',
      veil: true,
      size: 'big', place: 'centre', hud: SCORING_NOKEYS
    },

    /* ------------------------------------------------------- THE TWO AWARDS
     *
     *   "Darken the screen again except for the longest road and largest army
     *    counter in the top left corner. Make the popup instruction explaining
     *    it use multiple slides and be extra clear. Even if the longest road and
     *    largest army haven't been claimed, we're artificially adding in numbers
     *    so you see that you have a 3 road streak and the longest is at 5, and
     *    you've played 3 knights and that's the biggest."
     *
     * Three slides over a board worth reading. In a practice run the card says
     * `0 > -` on both lines — the rivals are frozen and the player has laid two
     * roads — which is a gauge with the needle at zero. So the run writes real
     * numbers into `state`: one award you are chasing and one you already hold,
     * because those are the two states the card has and both need reading. Taken
     * back off at the closing step and on quit.
     */
    {
      /*
       * FOUR PLAIN STEPS, NO BRIEF, AND THE ORDER THE CARD IS PRINTED IN.
       *
       *   "Remove the OK button from step 8. You forgot to explain the longest
       *    road points. Do the longest road steps before the largest army,
       *    since it's on top — also highlight that row more than the knights
       *    row while the tutorial is talking about it."
       *
       * The forgetting was the brief's fault: NEXT on a brief advances to the
       * next STEP, so the intro slide's gold key skipped the Longest Road body
       * hiding behind it and landed the player straight on Largest Army. Three
       * points of the five were never explained by a card that existed to
       * explain them. Un-nesting the intro into a step of its own removes the
       * OK key (a brief is the only thing that shows one) and makes Longest
       * Road un-skippable by the same stroke — one press, one slide, in the
       * order the rows sit on the card.
       */
      id: 'awards',
      title: 'Two more ways to score',
      text: `There are ${LONGEST_ROAD_VP + LARGEST_ARMY_VP} points on the board that nobody builds. They sit in the card at the bottom left. I have put some numbers on them so there is something to read.`,
      enter: () => t.fakeAwards(),
      size: 'big', place: 'foot', hud: AWARD_LESSON,
      spotOverUi: true, spotGlow: true, spotDom: ['.scorecard']
    },

    {
      id: 'awardsroad',
      title: 'Longest Road',
      /*
       *   "Explain it a more clear way. Right now it tried to minimize the
       *    number of words but made it confusing in the process — find a better
       *    middle ground."
       *
       * The two numbers quoted are the two `fakeAwards` writes — yours 2, the
       * record 4 — so the words and the card agree. Ties go to the holder, so
       * the line asks for LONGER than the record, not for matching it.
       */
      text: `LONGEST ROAD: connect ${LONGEST_ROAD_MIN} or more of your roads in one unbroken line and it is worth ${LONGEST_ROAD_VP} points. On the counter, the white number is your longest line and the gold number is the current record. Yours is 2 and the record is 4 — build a longer line than the record and the points are yours.`,
      size: 'big', place: 'foot', hud: AWARD_LESSON,
      /*
       *   "The counter is faded instead of its normal brightness. The whole
       *    element should be brighter with the rest of the app dark — no faded
       *    film — but I do still like the gold border around the one you're
       *    specifically discussing."
       *
       * So: a plain hole over the WHOLE scorecard (its normal brightness, both
       * rows readable), and the ring alone on the row being read. The lift is
       * gone — a warm `lighter` film over a dark plate was the exact "faded
       * film" being described. `:first-child` because the rows are built in
       * the order they are drawn — road on top, see `awardRow` in hud.js.
       */
      spotOverUi: true,
      spotDom: [
        { sel: '.scorecard' },
        { sel: '.sc-awards .aw-row:first-child', glow: true }
      ]
    },

    {
      id: 'awardsarmy',
      title: 'Largest Army',
      /* "Don't mention Knights in your hand, since they are always used right
         away — and the description is still confusing." One thing at a time:
         what to do, what it is worth, what the card in the corner says now. */
      text: `LARGEST ARMY: play ${LARGEST_ARMY_MIN} or more Knight cards, and more than anyone else, and it is worth ${LARGEST_ARMY_VP} points. You have played ${LARGEST_ARMY_MIN} Knights and nobody has played more, so the line reads YOURS in your color — those points are already in your score.`,
      size: 'big', place: 'foot', hud: AWARD_LESSON,
      // The knight row's turn to wear the ring, same treatment as the road's.
      spotOverUi: true,
      spotDom: [
        { sel: '.scorecard' },
        { sel: '.sc-awards .aw-row:last-child', glow: true }
      ]
    },

    {
      id: 'awards3',
      title: 'They can be taken',
      text: 'Neither is yours to keep. The moment a rival lays a longer line or plays one more Knight, the points move to them.',
      size: 'big', place: 'foot', hud: AWARD_LESSON,
      spotOverUi: true, spotGlow: true, spotDom: ['.scorecard']
    },

    /* --------------------------------------------------------- TWO WAYS OUT
     *
     *   "Then let them have the option, when the tutorial is done, to roam
     *    around on freeplay getting the feel for the game with the opponents
     *    still frozen — or to go to the menu to play a real game."
     *
     * The run used to end on one green key that reloaded the page, which is a
     * strange thing to offer somebody who has just been told the whole game and
     * might reasonably want to stand on the island for a minute and try it
     * without three rivals racing them. FREE ROAM keeps everything the practice
     * run set up — frozen rivals, no clock, no stalemate cap — and simply takes
     * the coach away; see `roam` in systems/tutorial.js.
     */
    {
      id: 'done',
      title: 'That is the whole game',
      noBadge: true, noNext: true,
      /* Put the board back. The awards lesson wrote numbers into `state` so it
         would have a filled-in card to teach from; nothing invented may survive
         into the match the player is about to be handed. */
      enter: () => t.clearFakeAwards(),
      text: 'Collect on land you own, build roads to reach more, turn corners into settlements and cities, and trade for what you are short of.',
      text2: 'Take the island for a walk first if you like — the other three stay exactly where they are.',
      action: 'Free Roam',
      onAction: () => t.roam(),
      action2: 'Play a Match',
      onAction2: () => t.restart(),
      // CENTRE, not LOW. The bands below it were measured to clear the build
      // cards and the three round keys, and this step no longer has either —
      // see `DONE`. With the screen empty the card belongs where the eye is.
      size: 'big', place: 'centre', hud: DONE
    }
  ]);
}

export default buildSteps;
