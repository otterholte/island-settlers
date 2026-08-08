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
const PACK_LESSON = { pack: true, nobuild: true, nokeysPhone: true };
/* The map-open steps. The pack stays up — it is what the costs are paid out of
   — and END PRACTICE stands down, because the chip sits in the top-right corner
   the map's own controls are using. `norail` is not listed: `onMap` implies it
   (see applyHud), so a step cannot ask for the column and forget to clear it. */
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
/* The score lesson. Everything in the corners stands down so the standings are
   the only lit thing on the screen — including END PRACTICE, which is a cream
   chip a thumb's width from the counter being pointed at. */
const SCORE_LESSON = {
  pack: true, ranks: true, nobuild: true, nokeys: true, noquit: true
};

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
   that have just appeared in the top-left corner and it must not stand in front
   of them — and `low` on a 375px screen puts its foot 26px INSIDE the build
   cards. That is the owner's one hard rule about this badge, in his words:
   "but don't ever cover the build pause and map buttons. they shouldn't overlap
   at all." Nothing on this step asks the player to build, so the four cards
   stand down for it exactly as they do for step 11. */
const EVERYTHING = { pack: true, ranks: true, awards: true, nobuild: true };
/* The awards lesson. Everything down but the scoreboard in the top-left, which
   is the one thing the three slides are about — including END PRACTICE and the
   three keys, for the same reason the score lesson loses them. */
const AWARD_LESSON = {
  pack: true, ranks: true, awards: true,
  nobuild: true, nokeys: true, noquit: true
};
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

  /* The player's own seat colour, named rather than shown, because the step
     that introduces the rail is read before the rail is looked at:
     "your color is blue". Read off the seat rather than hard-coded, so it
     cannot drift if the palette or the seat order ever changes. */
  const myColourName = () => (me.color && me.color.key)
    ? String(me.color.key).toLowerCase()
    : 'your colour';

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
      text: `A road costs ${COST.road.wood} wood and ${COST.road.brick} brick — you have plenty. Tap the ROAD card to open the map.`,
      enter: () => t.give(ROAD_PACK),
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
        ? 'Pinch to zoom in and out. Drag with one finger to move around the island.'
        : 'Scroll to zoom in and out. Click and drag to move around the island.',
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
      text: () => `Down the right are the four settlers and the colour each one builds in. You are ${myColourName()} — every road and settlement in that colour is yours.`,
      onMap: 'centre', size: 'big', place: 'centre', veil: true,
      hud: MAP_KEEP_RAIL,
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
      text: () => `The ${myColourName()} pieces on the board are the two settlements and two roads you were dealt at the start. Everything you build joins onto them.`,
      onMap: true, size: 'big', place: 'foot', hud: MAP_STEP,
      spotWorldMany: () => t.myPieces()
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
      text: 'The glowing white lines are every place a road may go right now. Tap one.',
      onMap: 'slim', size: 'slim', place: 'foot', hud: MAP_STEP,
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
      text: 'That line is chosen, not built. Tap the SAME line once more to confirm it. Tapping the open sea puts it back.',
      onMap: true, size: 'big', place: 'foot', hud: MAP_STEP,
      check: () => me.roads.size > t.base.roads
    },

    /* 15 ------------------------------------------------- ...AND WATCH IT GO UP
     *
     *   "Then close the tutorial steps, show the building of the road animation
     *    happen, and after it has you can show the next step."
     *
     * `quiet` is the whole step: the badge is not shown at all while the map
     * closes and the road drops into place, and it comes back when the timer
     * runs out. A card explaining a thing over the top of the thing happening is
     * the one mistake this rework keeps being asked to stop making.
     */
    {
      id: 'roadbuilt',
      title: 'Built',
      text: 'That is a road. It is worth no points on its own — what it does is REACH: every corner your network touches is a corner you may settle.',
      quiet: 1.9,
      size: 'big', place: 'low', hud: SCORING_NOKEYS
    },

    /* 16 ------------------------------------------------------- THE SCORE
     *
     *   "For step 11, add the scores on the right side of screen and hide the
     *    build cards. That way the step explanation for the tutorial isn't
     *    covering the game board and my player in the middle of the screen."
     *
     *   "Hide the End Practice button for this step, and hide the build map
     *    pause buttons. And instead of the yellow circle, darken the screen
     *    aside from the points counter in the top right corner."
     *
     * The second note finishes the first. The card had already dropped to the
     * LOW band with the build cards away; what was left in the corners was a
     * gold ring on the standings and a cream END PRACTICE chip sitting a
     * thumb's width from it, both competing with the thing being pointed at. So
     * the ring goes, the chip goes, the three keys go, and the wash lights the
     * standings alone.
     */
    {
      id: 'points',
      title: 'That is what points are',
      text: () => `You gather to build, and you build to score. A settlement is 1 point, a city 2, a victory card 1 — first to ${VICTORY_POINTS} wins. You are on ${scoreOf(state, me)}; the standings top right carry everybody's.`,
      live: true,
      size: 'big', place: 'foot', hud: SCORE_LESSON,
      spotDom: ['.hud-tr']
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

    /* ------------------------------------------------------- THE TWO AWARDS
     *
     *   "Don't forget to mention the largest army and the longest road and the
     *    points associated, and where you can find that info. Don't show that
     *    section until that step in the tutorial."
     *
     *   "Darken the screen again except for the longest road and largest army
     *    counter in the top left corner. Make the popup instruction explaining
     *    it use multiple slides and be extra clear. I want for this step to just
     *    choose random numbers — so even if the longest road and largest army
     *    haven't been claimed, we're artificially adding in numbers so you see
     *    that you have a 3 road streak and the longest is at 5 right now, and
     *    you've played 3 knights and that's the biggest right now. That way you
     *    can explain those numbers in the tutorial."
     *
     * THREE SLIDES, AND A CARD WITH SOMETHING ON IT.
     *
     * The old step was one paragraph with a gold ring on an award card that,
     * in a practice run where the rivals never move and the player has laid two
     * roads, read `0 › —` on both lines. It was explaining a readout using an
     * example of that readout with nothing in it — which is the whole reason
     * the note asks for invented numbers. So the run writes a board in: you on
     * 3 roads against a rival's 5, and you holding Largest Army on 3 knights.
     * One award you are chasing and one you already have, because those are the
     * two states the card has and both of them need reading.
     *
     * The numbers are written into `state` rather than faked in the text, so
     * the card the player is being taught is the real card doing its real job —
     * the holder's name is coloured by the real seat, YOURS appears because the
     * real rule fired. It is undone on the way out (see `enter` on the closing
     * step) so nothing invented survives into a match.
     */
    {
      id: 'awards',
      title: 'Points you never build',
      brief: {
        title: 'Two more ways to score',
        text: `There are ${LONGEST_ROAD_VP + LARGEST_ARMY_VP} points on the board that nobody builds. They sit in the scoreboard in the top left, and they change hands the moment somebody beats you. I have put some numbers on them so there is something to read.`
      },
      text: `LONGEST ROAD, top line: ${LONGEST_ROAD_MIN}+ segments in one unbroken line, worth ${LONGEST_ROAD_VP} points. The small white number is YOURS and the gold one is the record — so 3 against 5 means two more segments would tie it, three would take it.`,
      enter: () => t.fakeAwards(),
      size: 'big', place: 'foot', hud: AWARD_LESSON,
      spotDom: ['.scorecard']
    },

    {
      id: 'awards2',
      title: 'Largest Army',
      text: `LARGEST ARMY, second line: ${LARGEST_ARMY_VP} points for ${LARGEST_ARMY_MIN}+ Knights PLAYED — not held. You are on 3 and nobody has beaten it, so the line says YOURS and the ${LARGEST_ARMY_VP} points are already counted in your score.`,
      size: 'big', place: 'foot', hud: AWARD_LESSON,
      spotDom: ['.scorecard']
    },

    {
      id: 'awards3',
      title: 'They can be taken',
      text: 'Neither one is yours to keep. The moment a rival lays a longer line or plays one more Knight, the points move to them — which is why a two-point swing can end a match you thought you were winning.',
      size: 'big', place: 'foot', hud: AWARD_LESSON,
      spotDom: ['.scorecard']
    },

    /* 22 ----------------------------------------------------------------- */
    {
      id: 'done',
      title: 'That is the whole game',
      /* Put the board back. The awards lesson wrote numbers into `state` so it
         would have a filled-in card to teach from; nothing invented may survive
         into the match the player is about to be handed. */
      enter: () => t.clearFakeAwards(),
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
