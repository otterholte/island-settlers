/**
 * Island Settlers — heads-up display.
 *
 *   createHUD(root, state, game) ->
 *     { update(dt), toast(msg,kind), announce(text,color),
 *       pulseResource(res), flashCost(kind), requestBuild(kind), onPlayBegan() }
 *
 * Landscape, safe-area aware, and deliberately hollow in the middle: every
 * container is pointer-events:none and only real controls opt back in. Each
 * control carries `data-ui` so the joystick layer ignores touches on it.
 *
 * The HUD's whole job is legibility of progress:
 *   top-left     the scoreboard: your victory track, and who holds each award
 *                with what it would take to take it off them
 *   top-centre   what you own, which regions still have it, and the one line
 *                that answers "what should I do right now?"
 *   top-right    standings, deliberately quiet
 *   bottom-left  what the ground under your feet is offering, and when a
 *                worked-out region comes back
 *   bottom-centre four live progress meters, one per purchase
 *
 * Owner: UI agent.
 */

import {
  RES, RES_LABEL, COST, VICTORY_POINTS,
  CARD_LABEL, LONGEST_ROAD_MIN, LARGEST_ARMY_MIN,
  canAfford, missingFrom
} from '../core/constants.js';

import { scoreOf, rankings, drawCard } from '../core/rules.js';
import {
  knightsOn, buttonsSide, setButtonsSide, lowPower, setLowPower,
  soundOn, setSoundOn, oceanOn, setOceanOn, musicOn, setMusicOn
} from '../core/options.js';

import { el, button, setText, toggle, replay, fmtTime } from './dom.js';
import { icon, iconEl, resIcon, avatar } from './icons.js';
import { createBuildBar } from './hud-build.js';
import { createTradeCue } from './hud-trade.js';
import { createKnightCue } from './hud-knight.js';
import { createRoadCue } from './hud-road.js';
import { createRaidCue } from './hud-raid.js';
import { createNotice } from './hud-notice.js';
import { createHelp } from './hud-help.js';
import { keyNav } from './kbnav.js';
import {
  regionReport, pieceCapped, hasSomewhere
} from './hud-guide.js';

const RES_ICON_PX = 28;

/* THE RULES MOVED OUT OF THIS FILE.
 *
 *   "The How to Play button within the settings dropdown within the game
 *    itself ... should be a larger popup in the middle of the screen, where the
 *    game technically pauses in the background."
 *
 * What used to live here was `HOW_TO`, eleven `[topic, paragraph]` pairs that
 * `howBody` unfolded INSIDE the settings sheet — which is how a 250px drawer on
 * a 444px-tall phone ended up being the game's rules reference, and why
 * `paintSheetEdges` had to re-measure a scroll region every time it opened.
 *
 * Every one of those paragraphs is now a row on a slide in `ui/hud-help.js`,
 * which also freezes the match while it is up and says so. The button below
 * raises that instead. The per-match Knights filter went with it — the sheet
 * asks `knightsOn()` when it is built, so a match with Knights switched off
 * still never reads a word about them.
 *
 * (The old array survives, word for word, as the rows of `buildSlides()`.)
 */


export function createHUD(root, state, game) {
  const me = state.players[0];
  const rivalNames = state.players.filter(p => p.id !== 0).map(p => p.name);

  /* ------------------------------------------------------------- scaffold */
  const hud = el('div', { class: 'hud pre', id: 'hud' });
  const mk = (tag, cls, html) => el(tag, { class: cls, html });

  /* --- top-left: settings, the score, and the two awards -----------------
   *
   *   "I don't need to see the badge that says YOU in the top left corner, but
   *    I would like to see somewhere what the longest road and largest army
   *    size, as well as my current road size, so that if I don't have it I know
   *    how many road pieces it will take me to get it."
   *
   * The identity card is GONE. It carried an avatar, the word "You", the word
   * "BLUE" and a colour swatch — four different ways of saying the one thing
   * the player already knew, in the most valuable corner of the screen. The
   * standings on the right still name and colour every player, including you.
   *
   * What takes its place is the thing that corner should always have held: a
   * scoreboard. The victory track survives (it was the one useful thing in the
   * badge), and under it sit the two awards, each as one line — WHO holds it and
   * at what size, YOUR own number, and, when it is not yours, exactly how many
   * more roads or knights it takes to take it. That last figure is the whole
   * request and it is not derivable from anything the HUD showed before: ties go
   * to the incumbent, so taking Longest Road needs strictly MORE than the holder
   * has, not equal to it. */
  /* THE GEAR IS ALSO THE WAY OUT.
   *
   *   "I don't need the word Settings at the top of it, or the extra x button.
   *    Just turn the settings icon/button into an x button while the settings
   *    are open."
   *
   * The sheet used to carry a header row — the word SETTINGS and a round close
   * button — which is thirty-eight pixels of a two-hundred-and-thirty-eight
   * pixel panel spent telling the player the name of the thing they had just
   * opened, and offering a second way to shut it four pixels below the first.
   * The header is gone (see `settings` below) and this button carries the whole
   * job: press it once and the sheet drops out of it, press it again — now
   * wearing a cross — and it goes away. `data-ico` publishes which of the two
   * glyphs is on it, so what it is wearing can be asserted rather than eyeballed
   * by the capture rig in tools/hudshot.mjs.
   */
  /* THE CROSS IS DRAWN HERE, AND ONLY BECAUSE icons.js IS NOT MINE THIS WEEK.
   *
   *   "THE CLOSE (X) GLYPH IS ILLEGIBLE. The cross strokes are dark brown
   *    rgb(42,26,12) on a navy button fill rgb(34,66,101) — contrast 1.63:1.
   *    The closed-state gear is light cream rgb(174,184,198) at 6.28:1. The
   *    button looks EMPTY at a glance."
   *
   * Measured and true. `icons.js`'s `close` is one keyline path — the shared
   * dark outline every asset in the game is drawn WITH — and on a cream button
   * that is exactly right, which is where it is used everywhere else (the trade
   * sheet's close key is cream). On the HUD's dark glass disc it is ink on ink.
   *
   * The gear next to it in the same button solves this the way every other
   * object in the set does: a light body with the ink keyline around it. So the
   * cross gets the same treatment — one dark stroke laid down wide, the cream
   * one over the top of it — and the two colours are `C.steelL` and `C.ink` from
   * icons.js, copied rather than imported because that module is owned by
   * another agent this week and gaining two exports is not worth the collision.
   *
   * The LIGHTER steel, not the gear's own #aeb8c6, and that is deliberate: a
   * 2.9px stroke and a 22px solid body at the same colour do not read at the
   * same weight, because a thin line picks up its surroundings from both sides.
   * #aeb8c6 measured 4.88:1 here — over the line but with nothing to spare —
   * where #dde4ee measures 7.6:1 against the same fill, which is the margin this
   * glyph needs to survive being drawn at 22px on a phone. The dark under-stroke
   * keeps it readable if the disc is ever put over something pale. */
  const CLOSE_CROSS = 'M6.4 6.4 17.6 17.6M17.6 6.4 6.4 17.6';
  const closeGlyph = px =>
    `<svg class="svg-ico" viewBox="0 0 24 24" width="${px}" height="${px}" ` +
    'aria-hidden="true" focusable="false">' +
    `<path d="${CLOSE_CROSS}" fill="none" stroke="#2a1a0c" stroke-width="5.6" ` +
    'stroke-linecap="round"/>' +
    `<path d="${CLOSE_CROSS}" fill="none" stroke="#dde4ee" stroke-width="2.9" ` +
    'stroke-linecap="round"/></svg>';

  const gearIco = mk('span', 'cb-ico', icon('gear', 22));
  const gearBtn = button('cbtn small ghost gearkey', {
    'aria-label': 'Settings', 'data-ico': 'gear', on: { click: () => toggleSettings() }
  }, gearIco);

  let vpNum = el('b', { text: '0' });
  const vpCells = [];
  const vpTrack = el('span', { class: 'vp-track' });
  for (let i = 0; i < VICTORY_POINTS; i++) {
    const c = el('i', { class: i === VICTORY_POINTS - 1 ? 'goal' : '' });
    vpCells.push(c); vpTrack.appendChild(c);
  }
  /* The floating "+1" that lifts off the counter when a point lands. It is a
     permanent, invisible child of the score row rather than a node created per
     point: creating one would relayout the row it is rising out of, which is
     the one thing a celebration must not do to the number it is celebrating.
     See `celebrateVp` and the .vp-plus block in ui-hud.css. */
  const vpPlus = el('span', { class: 'vp-plus', text: '+1' });

  /* The trophy that flies out of the centre notice and into this counter. Also
     permanent and also invisible until it is asked for — it is appended to the
     HUD root rather than to the score row because it spends most of its half
     second nowhere near the corner. See `celebrateVp`. */
  const vpFly = el('div', { class: 'vp-fly', html: icon('trophy', 30) });
  let vpIco = iconEl('trophy', 20);
  /* What the trophy flies INTO and what gets the gain flash. Both were the
     left-corner card; they are the standings row for seat 0 now. */
  let vpBox = null;

  /**
   * One award line: icon, the full name, YOUR number against the record, and
   * who is holding it.
   *
   * THE PHONE HAD THE NUMBERS RIGHT AND THE DESKTOP DID NOT.
   *
   *   "Simplify this even more for the longest road and largest army popup on
   *    the left side of the screen specifically for desktop. I want it to look
   *    more like the mobile version in the numbers, with the white smaller
   *    number being your score and the large yellow number being the record
   *    right now. However, what I do like about the desktop version is that it
   *    says and highlights the current name of whoever's longest, and says
   *    Longest Road and Largest Army in full, since that actually fits on a
   *    desktop."
   *
   * The two layouts had drifted into saying the same thing differently. The
   * phone collapsed each award to one honest pair — `1 › 4`, yours in white
   * against the record in gold — while the desktop spread the same two figures
   * across two rows with a word and a chip between them: the record alone at
   * the end of the top line, then `you 1` and a `+4 roads` badge underneath. To
   * read your standing you had to pick two numbers out of different lines and
   * subtract, which is exactly the work the phone's arrangement does for you.
   *
   * So the PAIR moves up to the label's line, at both sizes, and two things go
   * away with it. The word "you" was labelling a figure whose position already
   * says whose it is. The `+N roads` chip was arithmetic on two numbers that
   * are now sitting next to each other — and the one thing it knew that they
   * did not, the floor you have to clear before an unclaimed award can be won
   * at all, has moved into the holder line, which was saying nothing but "Open".
   *
   * What stays is what the note says to keep: the name in full, and the holder
   * in their own colour.
   */
  function awardRow(ico, label) {
    const holder = el('b', { class: 'aw-holder', text: '—' });
    const size = el('em', { class: 'aw-size', text: '0' });
    const mineN = el('b', { text: '0' });
    const mine = el('span', { class: 'aw-mine' }, mineN);
    /* Kept, empty and hidden: `awardLine` still writes to it and the compact
       layout may want the chip back one day, but nothing shows it today. */
    const need = el('span', { class: 'aw-need hid', text: '' });
    const pair = el('span', { class: 'aw-pair' },
      mine, el('i', { class: 'aw-vs', 'aria-hidden': 'true' }), size);
    const row = el('div', { class: 'aw-row' },
      el('span', { class: 'aw-ico', html: icon(ico, 18) }),
      el('span', { class: 'aw-body' },
        el('span', { class: 'aw-top' },
          el('span', { class: 'aw-lab', text: label }), pair),
        el('span', { class: 'aw-bot' }, holder, need)));
    return { row, holder, size, mine, mineN, need, pair, last: '' };
  }
  const awRoad = awardRow('road', 'Longest Road');
  const awArmy = awardRow('knight', 'Largest Army');

  /*
   * THE LEFT CORNER STOPS COUNTING POINTS.
   *
   *   "On the point and longest road and largest army counter on the left side
   *    of the screen, get rid of my point counter, since the victory points are
   *    already counted on the right side of the screen. Instead just make the
   *    numbers and icons for the largest army and longest road slightly bigger.
   *    This means the +1 when I get a victory point animation should be on the
   *    points on the right side."
   *
   * He is right that it was said twice: the standings in the top right carry a
   * trophy and a number for every seat including his own, so the left corner was
   * a second, larger copy of one row of it — and the two had to be read against
   * each other to be sure they agreed.
   *
   * So the card keeps only the thing that is NOT said anywhere else: who holds
   * the two awards, at what length or count, and how far off you are. The
   * elements the score row was built from are still constructed above, because
   * the celebration machinery below is written against them; they are simply
   * never put on screen, and `vpNum` is re-pointed at the standings row for
   * seat 0 the moment the standings exist. See `celebrateVp`.
   */
  const scoreCard = el('div', { class: 'scorecard plate big-awards' },
    el('div', { class: 'sc-awards' }, awRoad.row, awArmy.row));
  const timerTxt = el('b', { text: '0:00' });
  const timeChip = el('div', { class: 'timechip plate' }, iconEl('clock', 14), timerTxt);
  const tl = el('div', { class: 'hud-tl' },
    el('div', { class: 'tl-row' }, gearBtn, timeChip), scoreCard);

  /* --- top-centre: resources and region availability ----------------------
     One beveled pill in the prime slot: five 28px objects, 20px stroked
     numerals, and a hairline bar under each showing how much of that
     resource is still standing on the island.

     THE COACHING LINE THAT USED TO SIT UNDER IT IS GONE.

       "During the game I don't need the little popups telling me what to do
        below my resource counter at the top middle of the page."

     It was a running instruction — BUILD A ROAD, you can afford it now — under
     the one readout the player checks most often, changing every couple of
     seconds as the numbers next to it moved. Everything it said is already on
     screen and said better: the build cards go gold when they are affordable,
     their cost chips are boxed green and red, and the scoreboard names both
     awards and what it takes to win them. */
  const resSlots = {};
  const resBar = el('div', { class: 'resbar' });
  for (const r of RES) {
    const num = el('b', { text: '0' });
    const live = el('i', { class: 'res-live' }, el('span'));
    const slot = el('div', { class: 'res', 'data-res': r, title: RES_LABEL[r] },
      iconEl(resIcon(r), RES_ICON_PX), num, live);
    resSlots[r] = { node: slot, num, live, last: -1 };
    resBar.appendChild(slot);
  }

  const tc = el('div', { class: 'hud-tc' }, resBar);

  /* --- top-right: standings, deliberately quiet -------------------------- */
  const rankRows = state.players.map(p => {
    const vp = el('b', { text: '0' });
    const award = el('span', { class: 'rk-award' });
    const nameEl = el('span', { class: 'rk-name', text: p.name });
    const av = el('span', { class: 'rk-av', html: avatar(p.color.css, p.color.light, p.id === 0 ? 26 : 22) });
    const row = el('div', {
      class: 'rk' + (p.id === 0 ? ' me' : ''), 'data-p': p.id,
      style: { '--c': p.color.css, '--cl': p.color.light }
    }, av, nameEl, award,
      el('span', { class: 'rk-vp' },
        p.id === 0 ? iconEl('trophy', 16) : null, vp,
        /* Your own row carries the celebration now that the left corner does not
           count points any more. Permanent and invisible until it is asked for,
           for the same reason it was in the old score row: creating a node per
           point would relayout the row it is rising out of, which is the one
           thing a celebration must not do to the number it is celebrating. */
        p.id === 0 ? vpPlus : null));
    /* `hex` is what the row is CURRENTLY wearing. These rows are built at boot,
       from the default palette, and a networked match re-seats everybody a few
       seconds later — see `refreshRanks`. Keeping the painted value beside the
       row is what lets that be noticed. */
    return { p, row, vp, award, nameEl, av, hex: p.color.hex };
  });

  /* The numeral the celebration bumps and holds back is the standings' own now.
     `vpNum` and `vpIco` were built for a score row that no longer exists; every
     line of `celebrateVp`, `flipVpNow` and `launchTrophy` below is written
     against them, so rather than rewrite all three, they are re-pointed here at
     the elements that ARE on screen. `vpCells` stays empty — there is no
     twelve-cell track any more, and the loop that lights it simply has nothing
     to walk. */
  vpNum = rankRows[0].vp;
  vpIco = rankRows[0].row.querySelector('.rk-vp .ico') || rankRows[0].row;
  vpBox = rankRows[0].row;
  const rankList = el('div', { class: 'ranks' }, rankRows.map(r => r.row));
  const tr = el('div', { class: 'hud-tr plate' }, rankList);

  /* --- bottom-centre: the four progress meters --------------------------- */
  const buildBar = createBuildBar(state, game, { onBuy: kind => requestBuild(kind) });
  const buildRow = buildBar.node;
  const bc = el('div', { class: 'hud-bc' }, buildRow);

  /* --- bottom-right: circular actions ------------------------------------ */
  const mkCircle = (ico, label, cls, fn) => {
    const badge = el('i', { class: 'badge hid', text: '0' });
    const node = el('button', {
      class: 'cbtn ' + cls, type: 'button', 'data-ui': '', 'aria-label': label,
      on: { click: fn }
    },
      el('span', { class: 'cb-ico', html: icon(ico, 26) }),
      el('span', { class: 'cb-lab', text: label }), badge);
    return { node, badge };
  };
  /** Show or hide the row of build cards. The B key is the other way in. */
  function toggleBuildRow(force) {
    const want = force === undefined
      ? buildRow.classList.contains('hid') : !!force;
    toggle(buildRow, 'hid', !want);
    return want;
  }
  const btnBuild = mkCircle('hammer', 'Build', 'gold', () => toggleBuildRow());
  /* THERE IS NO CARDS BUTTON.
   *
   *   "Remove the Cards button, I don't need it, since the build button lets
   *    you buy a card, and it's always used right away. Plus on mobile it makes
   *    the pause button cover the buttons for the types of things you can build
   *    that currently show up in the bottom middle of the screen."
   *
   * Both halves are right. Every card in the deck already announces itself and
   * carries its own control: a Knight raises the standing chip that opens the
   * board (hud-knight.js), Road Building does the same and lays its two roads
   * (hud-road.js), and a Victory Point scores the instant it is drawn. The
   * panel behind this button was a list of cards you had already been told
   * about, with a button to do the thing the chip on screen was already
   * offering. `panels.openCards()` still exists and is still opened by the one
   * caller that needs it — Road Building with no legal road left.
   *
   * And a rail of four 58px circles plus PAUSE is 300-odd pixels on a 667px
   * phone, which is what pushed the pause key over the build cards. */
  const btnMap = mkCircle('map', 'Map', 'blue', () => game.openOverview('view'));
  /*
   * PAUSE.
   *
   *   "I also want a way to pause the game easily, and pausing the game should
   *    still show me the full scores and board so I can review where we are in
   *    the game and who's winning."
   *
   * All three of those things already existed and none of them were joined up.
   * The board map ALREADY stops the match dead — main.js gates the clock, the
   * bots, the gathering and the settler on `overview.isOpen` — and it ALREADY
   * draws the whole island plus a per-player rail with score, settlements,
   * cities, road length and knights. Nothing said so. The MAP button reads as
   * "look at the map", the settings popover is titled "Paused" and pauses
   * nothing at all, and the one place in the game that admits the match stops
   * is a hint line inside the Knight flow.
   *
   * So this is a real control over the mechanism that was already there: a
   * PAUSE button next to MAP, the P and Escape keys, and the board coming up
   * titled "Paused" with the standings beside it. `paused` is only a label —
   * the freeze itself remains `overview.isOpen`, so there is exactly one way
   * for the match to be stopped and no way for the two to disagree.
   */
  const btnPause = mkCircle('pause', 'Pause', 'ghost', () => togglePause());
  const br = el('div', { class: 'hud-br' },
    btnPause.node, btnMap.node, btnBuild.node);

  /* --- bottom-left: NOTHING, deliberately ---------------------------------
   *
   *   "I also don't need any of the text popups in the bottom left corner, I'm
   *    too busy playing, I'm never going to look that way."
   *
   * That corner held two things and both are gone: the ground-report chip
   * ("Not your land · settle a corner", "Worked out · back in 26s") and the
   * toast stack above it. Both were correct and neither was ever read, because
   * the bottom-left is where the joystick thumb lives on a phone and where
   * nothing else on this screen asks the eye to go.
   *
   * Nothing they carried is lost, because none of it was only there:
   *   whose land is this   the hex tint and the owned-hex rim say it in the
   *                        world, where the player is already looking
   *   what is left on it   the five bars under the resource pill
   *   worked out, back in  the recovery clock floating over the hex itself
   *   the Knight is here   the Knight is standing on the hex, and the recovery
   *                        badge wears the barred glyph
   *
   * `toast()` is kept as a no-op rather than deleted: it is called from about
   * thirty places across six modules, and a function that quietly does nothing
   * is a much smaller thing to maintain than thirty deletions and the imports
   * that go with them. Anything that genuinely must be seen already goes to the
   * centre of the screen — `announce`, the Knight and Road Building cues, and
   * the raid card.
   */

  /* --- announcements -------------------------------------------------------
   *
   *   "The road building, knight, and victory point notices when you buy a card
   *    are too hard to see. Can you give them a darker box behind them instead
   *    of just laying over the board."
   *
   * The banner is no longer built here. hud-notice.js owns the plate, the glyph
   * disc and the hold, because three modules put notices on it and only one of
   * them lives in this file — see the long note at the head of that module for
   * why that placement is what lets hud-road.js pick the plate up without being
   * edited at all. `announce()` below is unchanged as far as every caller in the
   * game is concerned; it has simply stopped owning the pixels. */
  const notice = createNotice(null);
  const annWrap = notice.node;

  /* --- settings ----------------------------------------------------------- */
  /*
   * Read, not assumed. Muting used to be a local `let` that started true every
   * time a match booted, so turning the sound off and leaving put it back on
   * again for the next one. It is a device setting now — see core/options.js.
   *
   * THREE CHANNELS, THREE ROWS — the same builder as the opening screen's gear
   * (`systems/flowIntro.js`), because the two panels must not disagree about
   * what a switch does or what it is called.
   *
   *   "Separate the sound effects from the ocean sound. So they can toggle one
   *    on or off instead of always turning both on or off."
   *
   * The engine keeps the three on separate busses and always has; `applyPrefs`
   * in audio/audio.js is the one call that puts the player's choice into it.
   */
  function pushAudio() {
    const a = game.audio;
    if (!a) return;
    if (typeof a.applyPrefs === 'function') {
      a.applyPrefs({ sfx: soundOn(), ocean: oceanOn(), music: musicOn() });
      return;
    }
    if (typeof a.setMuted === 'function') a.setMuted(!soundOn());
    if (typeof a.ambience === 'function') a.ambience(oceanOn());
    if (typeof a.music === 'function' && !musicOn()) a.music('off');
  }

  function audioRow(label, read, write) {
    const btn = button('wide cream', { on: { click: () => set(!read()) } },
      el('span', { class: 'sb-ico', html: icon('sound', 20) }),
      el('span', { class: 'sb-lab', text: label + ': On' }));
    function set(on) {
      write(!!on);
      btn.childNodes[0].innerHTML = icon(on ? 'sound' : 'mute', 20);
      btn.childNodes[1].textContent = label + ': ' + (on ? 'On' : 'Off');
      pushAudio();
    }
    set(read());
    return btn;
  }

  const soundBtn = audioRow('Sound effects', soundOn, setSoundOn);
  const oceanBtn = audioRow('Ocean', oceanOn, setOceanOn);
  const musicBtn = audioRow('Music', musicOn, setMusicOn);


  /* --- where the controls live --------------------------------------------
   *
   *   "Let's actually switch the invisible joystick to work anywhere, but
   *    still have the buttons switch sides. So it doesn't need a toggle."
   *
   * So there is one switch where there were two. The joystick takes a drag from
   * anywhere that is not already a control, which cannot be on the wrong side
   * and therefore has nothing to ask; this is the half that was always the real
   * question — which corner a one-handed player wants MAP, PAUSE and BUILD in.
   * One class on the HUD root, and ui-hud.css reverses the row so the key
   * nearest the screen edge is the same key either way.
   */
  function sideRow(label, get, set) {
    const keys = ['left', 'right'];
    const btns = keys.map(v => button('seg', {
      on: { click: () => { set(v); paint(); } }
    }, el('span', { text: v === 'left' ? 'Left' : 'Right' })));
    function paint() {
      const cur = get();
      btns.forEach((b, i) => toggle(b, 'on', keys[i] === cur));
    }
    paint();
    return el('div', { class: 'side-row' },
      el('span', { class: 'side-lab', text: label }),
      el('div', { class: 'side-seg' }, btns));
  }

  function applyButtonSide() { toggle(hud, 'btn-left', buttonsSide() === 'left'); }
  applyButtonSide();

  /*
   * GRAPHICS: FULL or BATTERY SAVER.
   *
   *   "How do I keep my laptop from constantly doing the black screen flashes?
   *    It's still doing it like crazy."
   *
   * It sits under the gear rather than on the match-setup panel because it is a
   * property of the DEVICE, like which corner the buttons are in — the same
   * machine wants the same answer every match, and the setup panel had no room
   * for a fourth row without pushing its own buttons off a 375px screen.
   *
   * Battery saver drops the shadow pass — a second full pass over the scene
   * every frame, plus a 16MB depth texture — and pins the pixel ratio at 1.
   * main.js applies it to the renderer that is already running, so the switch
   * takes effect on the next frame rather than the next match. It also turns
   * itself on the first time the browser drops the 3D view; see the context
   * loss handler there.
   */
  function powerRow() {
    const keys = [false, true];
    const btns = keys.map(v => button('seg', {
      on: { click: () => choose(v) }
    }, el('span', { text: v ? 'Saver' : 'Full' })));

    /* PAINTING IS NOT CHOOSING.
     *
     * This row used to call `game.setLowPower` from its own initial paint,
     * which PINS the quality ladder — so the automatic tuning in
     * systems/quality.js was switched off before the first frame by the mere
     * existence of the settings popup. Painting reads; only a press decides. */
    function repaint() {
      const cur = !!(game && game.lowPower);
      btns.forEach((b, i) => toggle(b, 'on', keys[i] === cur));
    }
    function choose(v) {
      setLowPower(v);
      if (game && typeof game.setLowPower === 'function') {
        try { game.setLowPower(v); } catch (e) { /* next boot, then */ }
      }
      repaint();
    }
    repaint();
    return { node: el('div', { class: 'side-row' },
      el('span', { class: 'side-lab', text: 'Graphics' }),
      el('div', { class: 'side-seg' }, btns)), repaint };
  }
  const power = powerRow();

  /* NO HEADER, AND NO SECOND CLOSE BUTTON.
   *
   *   "I don't need the word Settings at the top of it, or the extra x button.
   *    Just turn the settings icon/button into an x button while the settings
   *    are open."
   *
   * What used to sit here was a `.pop-head` row: the word SETTINGS in gold, and
   * a 48px round close button. Together they cost about forty-four pixels off
   * the top of a panel that, on a 444px-tall landscape phone, was already
   * clipping LEAVE MATCH off its own bottom edge. And they were both redundant.
   * The sheet drops out of the gear, four pixels below it, and it is the only
   * thing on the screen shaped like a menu — nothing on it needed a title. The
   * close button was a second copy of the control the player had just pressed,
   * offered a thumb's width away from it.
   *
   * The gear above is now the whole story: press to open, press to close, and it
   * wears a cross while the sheet is down so it reads as the way out rather than
   * as the way back in. See `setGearGlyph`. */
  const settings = el('div', { class: 'pop settings plate lift hid', 'data-ui': '' },
    soundBtn,
    oceanBtn,
    musicBtn,
    sideRow('Buttons', buttonsSide, v => { setButtonsSide(v); applyButtonSide(); }),
    power.node,
    /* The rules are no longer a drawer inside a drawer. This closes the
       settings and raises the paused slide sheet in the middle of the screen —
       see ui/hud-help.js. The settings sheet therefore never scrolls on
       account of the rules again, which is most of why it scrolled at all. */
    button('wide cream', { on: { click: () => { toggleSettings(false); help.open(); } } },
      el('span', { class: 'sb-ico', html: icon('help', 20) }),
      el('span', { class: 'sb-lab', text: 'How to Play' })),
    /* ONE WAY OUT, AND IT IS RED.
     *
     *   "Please get rid of the restart match, I don't need that AND leave
     *    match. Just have one, but have leave match be red."
     *
     * They also did the same thing. `restart()` reloads the page and a cold boot
     * lands on the opening screen; `leaveMatch()` reloads the page — telling the
     * server first, which is the part that matters online — and lands on the
     * opening screen. Two buttons, one destination, and only one of them was
     * safe to press in a networked match. */
    button('wide red', { on: { click: () => leaveMatch() } },
      el('span', { class: 'sb-ico', html: icon('home', 20) }),
      el('span', { class: 'sb-lab', text: 'Leave Match' }))
  );

  hud.appendChild(tl); hud.appendChild(tc); hud.appendChild(tr);
  hud.appendChild(bc); hud.appendChild(br);
  hud.appendChild(annWrap); hud.appendChild(settings);
  /* Last, so the flying trophy passes OVER the notice it comes out of and over
     every other cluster on its way to the corner. It is 44px of gold for half a
     second and it must not disappear behind the resource pill halfway there. */
  hud.appendChild(vpFly);
  root.appendChild(hud);

  /* ------------------------------------------------------------ the rules
   * Appended to the interface ROOT rather than to the HUD, because it is a
   * modal over the whole game rather than another cluster in it — and because
   * `.hud` is `pointer-events:none` with each control opting back in, which is
   * exactly the wrong default for a full-screen sheet. */
  const help = createHelp(root, state, game);

  /* ------------------------------------------------------- keyboard scopes
   *
   *   "The up down left and right arrow keys all work to navigate any page I'm
   *    on to all of the different buttons on all of the different screens
   *    including the menus, settings, match setup, etc."
   *
   * The settings drawer is a menu like any other, so it registers like one.
   * `captures` is what keeps the settler still while somebody arrows around it:
   * `ui/kbnav.js` hands the keyboard over the same way `ui/panels.js` does. The
   * rules sheet registers itself inside hud-help.js at a higher priority, so a
   * sheet raised FROM the settings still out-ranks the settings. */
  const nav = keyNav();
  const offSettings = nav.registerScope({
    node: settings, priority: 50, captures: true,
    /* OPEN IS NOT ENOUGH — IT ALSO HAS TO BE THE FRONT-MOST THING.
     *
     * The drawer stays in the DOM, visible, behind anything raised over it, and
     * a scope that only asked `settingsOpen` went on claiming the arrow keys
     * while the trade sheet was on top of it — so the row of resource cards
     * stopped answering to Left and Right for no reason the player could see.
     * The sheets do not know this drawer exists and should not have to. */
    isOpen: () => settingsOpen
      && !(game.panels && game.panels.isOpen)
      && !(game.overview && game.overview.isOpen)
      && !help.isOpen,
    first: () => soundBtn,
    onEscape: () => toggleSettings(false)
  });

  /* The world-anchored trade banner. It lives inside the HUD layer so it can
     measure itself against the same box everything else is laid out in. */
  const tradeCue = createTradeCue(hud, state, game);

  /* A Knight is the one card that needs the whole board to play, so it gets its
     own standing call-to-action rather than hiding behind the CARDS button.
     hud-knight.js announces the draw and owns the Knight placement gesture. */
  const knightCue = createKnightCue(hud, state, game);
  game.knightCue = knightCue;

  /* ...and Road Building is the other one. It used to arrive as a single fading
     toast telling the player to go and find the CARDS button, which is how a
     card that opens the whole board ended up being "wasted, and nothing
     happens". hud-road.js is the Knight's twin: it announces the draw, raises a
     standing chip, and brings the placement map up by itself. */
  const roadCue = createRoadCue(hud, state, game);
  game.roadCue = roadCue;

  /* A Knight takes half of everything from every rival at once, and until now
     the game never said so — `playKnight` has always emitted a full per-player
     breakdown that nothing read. hud-raid.js is that payload on screen. */
  const raidCue = createRaidCue(hud, state, game);

  /* ---------------------------------------------------------------- toast
   * Retired with the corner it lived in (see the bottom-left note above). The
   * function stays so its thirty-odd callers keep working untouched. */
  function toast() { return null; }

  /* A rival's news is news, not an event. It gets a toast, at most one every
     ten seconds; the centre banner is reserved for things the player did. */
  let lastRival = -99;

  /**
   * Put a line on the centre plate.
   *
   * The third argument is new and is an icon name from icons.js — 'knight',
   * 'road', 'trophy'. It is OPTIONAL in the strongest sense: every one of the
   * thirty-odd existing callers passes two arguments and gets exactly what it
   * always got, now on a dark plate. Naming a glyph is what turns a sentence
   * into a card: a Knight, two roads or a trophy on a gold disc beside the
   * words, which is recognisable across a room before a word has been read.
   */
  function announce(text, color, glyph) {
    if (!text) return;
    const s = String(text);
    if (rivalNames.some(n => s.startsWith(n))) {
      if (state.time - lastRival < 10) return;
      lastRival = state.time;
      toast(s, 'info');
      return;
    }
    notice.show(s, color, glyph);
  }

  /* ------------------------------------------------------------ resources
   *
   * THE PULSE CLASS IS `res-pop`, AND IT USED TO BE `pop`.
   *
   *   "I don't like that while my resources are being collected, that resource
   *    in my pack disappears ... the whole resource for brick in my pack
   *    disappears until it has a new total for a second or two. I'd rather it
   *    stays in the pack and just live updates the number as I'm picking items
   *    up."
   *
   * It was doing exactly that, and it was not a timing problem — it was a name
   * collision. `pop` is also the class every popover in this interface wears,
   * and `.pop` in ui-hud.css is an unqualified rule that sets
   * `position:absolute; left:var(--gL); top:calc(var(--gT) + 56px); width:238px`.
   * Both selectors score (0,1,0) and the popover's is written later, so it won.
   * The instant a chip pulsed it stopped being a flex child of `.resbar` — the
   * other four closed the gap — and was thrown to a popover's coordinates
   * offscreen-left of the pill. It came back 480ms after the LAST pickup,
   * because `replay` restarts its own timer, which is why sweeping a hex hid
   * the chip for the whole sweep rather than for a frame.
   *
   * A rename is the fix rather than a specificity bump: the two things have
   * nothing to do with each other and should never have shared a word.
   */
  function pulseResource(res) {
    const s = resSlots[res];
    if (s) replay(s.node, 'res-pop', 480);
  }

  function flashCost(kind) { buildBar.flash(kind); }

  /* -------------------------------------------------------------- actions */
  function requestBuild(kind) {
    if (state.phase === 'over') return false;
    if (state.phase === 'setup') { toast('Finish the opening draft first', 'warn'); return false; }
    if (!COST[kind]) return false;

    // ONLINE, NOTHING IS BOUGHT HERE. These cards pay and draw locally, which
    // is right when this machine owns the rules and wrong when a server does —
    // it would spend the same resources twice and put down a piece the server
    // may refuse. economy.js knows how to ask; it runs the identical gates
    // first, so the refusals the player sees are the same refusals.
    const eco = game.economy;
    if (eco && typeof eco.isNet === 'function' && eco.isNet()) {
      return eco.buy(kind) !== false;
    }

    if (pieceCapped(state, 0, kind)) {
      toast(`No ${kind} pieces left`, 'warn'); flashCost(kind); return false;
    }
    if (!canAfford(me.res, COST[kind])) {
      const miss = missingFrom(me.res, COST[kind]);
      toast(`Need ${Object.keys(miss).map(r => `${miss[r]} ${RES_LABEL[r]}`).join(', ')}`, 'bad');
      flashCost(kind);
      return false;
    }
    if (kind === 'card') {
      const card = drawCard(state, 0);
      if (!card) { flashCost('card'); return false; }
      // A Knight gets the centre banner from hud-knight.js, which also raises
      // the standing "play me" chip — so it deliberately says nothing here.
      //
      // The Victory Point is the one card with nothing to play and nowhere to
      // go: it scores the instant it is drawn and then it is over. So it takes
      // the plate with the trophy on it, and the counter in the corner does the
      // rest — see `celebrateVp`.
      if (card.type === 'victoryPoint') announce('+1 Victory Point!', '#ffc93c', 'trophy');
      // Road Building says nothing here either, for the same reason: hud-road.js
      // takes the centre banner, raises its own chip and opens the map.
      else if (card.type !== 'roadBuilding') toast(`Drew ${CARD_LABEL[card.type]}`, 'good');
      refreshAll(true);
      return true;
    }
    if (!hasSomewhere(state, kind)) {
      toast(kind === 'city'
        ? 'Upgrade needs one of your settlements'
        : `Nowhere legal to place a ${kind}`, 'warn');
      flashCost(kind);
      return false;
    }
    /* ONE PIECE AT A TIME WHILE THE PRACTICE RUN IS ON.
     *
     *   "Override the rule that keeps the road builder map open if I have extra
     *    resources available in order to build a road. It should close right
     *    after I built one road in this instance."
     *
     * The stay-open rule is right in a match — build three roads on one visit
     * to the map and never leave it — and wrong in a lesson, where the pack has
     * been stocked with five roads on purpose and the step after this one is
     * written for a board with the piece already on it. `game.tutorial.running`
     * is the whole condition, so a real match is untouched. */
    const teaching = !!(game.tutorial && game.tutorial.running);
    game.openOverview('place-' + kind, teaching ? { once: true } : {});
    return true;
  }

  /**
   * THE SHEET SAYS WHEN THERE IS MORE OF IT.
   *
   *   "hud-settings-scrolled.png IS HARD-CLIPPED. '...you own a settlement or'
   *    is cut mid-sentence at the sheet's bottom rounded corner with no fade and
   *    no scrollbar, and the scrolled-off SOUND row is cut the same way at the
   *    top. Add a soft fade mask at both ends, or a subtle scroll indicator, so
   *    it reads as scrollable rather than broken."
   *
   * This game hides every scrollbar it has (ui-base.css), which is right for a
   * pad-first interface and leaves a scrolling panel with nothing at all to say
   * that it scrolls. A sentence sliced off square at a rounded corner does not
   * read as "there is more below"; it reads as a bug.
   *
   * These two classes are the whole mechanism and the fade itself is CSS — see
   * `.pop.settings.sc-above` / `.sc-below` in ui-hud.css. They are written by
   * measurement rather than left on permanently, because a sheet with nothing to
   * scroll must NOT have soft edges: the fade means something, and a fade on a
   * panel that is already showing everything would be a lie told four times a
   * match. Three pixels of slop, because a scroll container that has been
   * bounced sits a fraction off zero.
   */
  function paintSheetEdges() {
    const room = settings.scrollHeight - settings.clientHeight;
    const at = settings.scrollTop;
    toggle(settings, 'sc-above', at > 3);
    toggle(settings, 'sc-below', room - at > 3);
  }
  if (settings.addEventListener) settings.addEventListener('scroll', paintSheetEdges);

  let settingsOpen = false;

  /**
   * The gear wears a cross while the sheet is down.
   *
   * A class would have been cheaper, but the two glyphs are drawn SVG rather
   * than a font, so the drawing genuinely has to be swapped. `data-ico` is
   * written alongside it so that "which glyph is on the button" is a fact that
   * can be asserted — by tools/hudshot.mjs, and by anybody reading the DOM —
   * instead of a shape somebody has to squint at in a screenshot.
   */
  function setGearGlyph(open) {
    const want = open ? 'close' : 'gear';
    if (gearBtn.getAttribute('data-ico') === want) return;
    gearBtn.setAttribute('data-ico', want);
    gearBtn.setAttribute('aria-label', open ? 'Close settings' : 'Settings');
    // `closeGlyph` rather than icon('close') — see the note where it is drawn.
    gearIco.innerHTML = open ? closeGlyph(22) : icon('gear', 22);
  }

  function toggleSettings(force) {
    settingsOpen = force === undefined ? !settingsOpen : !!force;
    toggle(settings, 'hid', !settingsOpen);
    toggle(gearBtn, 'on', settingsOpen);
    setGearGlyph(settingsOpen);
    // Only measurable once it is on the screen — a `hid` panel has no height to
    // compare against its own contents.
    if (settingsOpen) paintSheetEdges();
  }

  /**
   * TAP ANYWHERE ELSE AND THE SHEET GOES AWAY.
   *
   *   "Also make it so that if I click anywhere outside of the settings box
   *    while the settings are open, it closes the settings box for me."
   *
   * Three things make this harder than it sounds in this interface, and each of
   * them decides one line of what is below.
   *
   * WHERE TO LISTEN. `#ui *` is `pointer-events:none` with `#ui [data-ui]`
   * opting back in (ui-base.css), so a press on the island does not land on any
   * element of the HUD at all — it lands on the WebGL canvas. There is therefore
   * no HUD-side "backdrop" element to hang this on, and adding one would mean
   * covering the whole screen with something that eats touches, which is exactly
   * what must not happen. The listener goes on the window instead, in the
   * CAPTURE phase, for the same reason systems/input.js puts its own release
   * handler there: ui/dom.js's `onTap` calls `stopPropagation` on pointerup, so
   * a bubble-phase listener would simply never hear some of these presses.
   *
   * IT MUST NOT SWALLOW THE PRESS. Nothing here calls `preventDefault` or
   * `stopPropagation`. A press on the island closes the sheet AND does whatever
   * it was going to do to the island — that is what "click anywhere outside"
   * means, and a tap that had to be spent twice would be a worse bug than the
   * one being fixed.
   *
   * A DRAG IS NOT A TAP. `.pop` is a scrolling panel and its buttons carry
   * `touch-action: pan-y` precisely so a finger that lands on LEAVE MATCH and
   * pulls down scrolls the sheet instead of pressing it (see the long note in
   * ui-base.css). That gesture ends with the finger wherever it stopped, which
   * may well be outside the panel, and closing the settings under it would undo
   * the very thing that block exists to allow. So the press is measured the same
   * way `guardTaps` in ui/dom.js measures one — twelve pixels of travel, the
   * house figure — and where it STARTED counts as much as where it ended.
   *
   * The gear counts as inside. Without that, pressing it while the sheet is open
   * would close the sheet here and then its own click would toggle it straight
   * back open, and the button would look broken.
   */
  const TAP_SLOP = 12;
  let downX = 0, downY = 0, downInside = false;

  const insideSheet = t =>
    !!(t && t.nodeType === 1 && (settings.contains(t) || gearBtn.contains(t)));

  function onDocDown(e) {
    downX = e.clientX; downY = e.clientY;
    downInside = insideSheet(e.target);
  }

  function onDocUp(e) {
    if (!settingsOpen) return;
    if (downInside || insideSheet(e.target)) return;
    if (Math.abs(e.clientX - downX) > TAP_SLOP) return;
    if (Math.abs(e.clientY - downY) > TAP_SLOP) return;
    toggleSettings(false);
  }

  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('pointerdown', onDocDown, true);
    window.addEventListener('pointerup', onDocUp, true);
  }

  /** Back to the opening screen. Falls back to a restart on an older `game`. */
  function leaveMatch() {
    toggleSettings(false);
    if (typeof game.leaveMatch === 'function') game.leaveMatch();
    else if (typeof game.restart === 'function') game.restart();
  }

    /* ------------------------------------------------------------ standings */
  let order = rankRows.map(r => r.p.id);

  function refreshRanks() {
    const rk = rankings(state);
    const next = rk.map(e => e.p.id);
    let changed = next.length !== order.length;
    for (let i = 0; !changed && i < next.length; i++) changed = next[i] !== order[i];

    const before = {};
    if (changed) for (const r of rankRows) before[r.p.id] = r.row.offsetTop || 0;

    rk.forEach((e, i) => {
      const r = rankRows[e.p.id];
      setText(r.vp, e.vp);
      toggle(r.row, 'lead', i === 0);
      let aw = '';
      if (e.p.hasLongestRoad) aw += icon('road', 16, 'aw');
      if (e.p.hasLargestArmy) aw += icon('knight', 16, 'aw');
      if (r.award.innerHTML !== aw) r.award.innerHTML = aw;
      /*
       * WHO IS STILL HERE.
       *
       *   "When one friend leaves a game the other should get a notification
       *    for it, and it should x and grey out their name in the leaderboard
       *    in the corner as well."
       *
       * `netState` is written by netmatch.js off the server's peer pushes:
       * 'live' is connected, 'gone' is a seat being held while somebody
       * reconnects, 'left' is a person who walked out and whose settler is
       * being played out by a subroutine, and 'bot' is a seat that was never
       * a person at all. The middle two are worth showing — the standings are
       * the only place that answers "is my friend still in this?" — and the
       * name is the honest place to show it.
       *
       *   "It just crossed out the friend's and the other bots' names in the
       *    top right corner even though the bots were still playing."
       *
       * That is this line, and it used to read `st === 'bot'`. Three of the
       * four seats in a two-player room are bots from the opening whistle, so
       * striking through 'bot' struck through the whole board the moment
       * anybody walked. Only 'left' is a departure.
       *
       * Names are re-read here too. In a networked match the roster arrives
       * after these rows are built, so the row created with 'Alex' on it has to
       * be told when the seat turns out to be a person called Sam.
       */
      const st = e.p.netState;
      toggle(r.row, 'left', st === 'left');
      toggle(r.row, 'away', st === 'gone');

      /*
       * THE ROW SAYS WHO YOU ARE AND WHAT YOU ARE WEARING.
       *
       *   "No matter what player they are or what their name was, the point
       *    counter in the top right corner shows their name as YOU and their
       *    colour as BLUE. Despite the fact that in this example my colour was
       *    actually RED and my name was actually ELI."
       *
       * Both halves were painted ONCE, when these rows were built, and in a
       * networked match that is several seconds before the server says who is
       * sitting where. The row for local seat 0 therefore kept the boot default
       * for ever: the name `createMatch` gives seat zero, and the first colour
       * in the palette.
       *
       * The name is read every pass now, not only for somebody who has left,
       * and it prefers the name the SEAT carries — that is the name typed on
       * the friends screen, the one on the lobby and the one the other player
       * sees. 'You' is still the fallback, because a single-player match has no
       * seat name and 'You' is right there.
       *
       * The colour is a repaint rather than a re-read: the swatch is drawn SVG
       * and the row's tint is two custom properties, so both have to be written
       * again. Guarded on the hex actually changing, which is once a match.
       */
      const label = e.p.netName || e.p.name;
      if (r.nameEl && r.nameEl.textContent !== label) setText(r.nameEl, label);

      if (r.hex !== e.p.color.hex) {
        r.hex = e.p.color.hex;
        if (r.row.style) {
          r.row.style.setProperty('--c', e.p.color.css);
          r.row.style.setProperty('--cl', e.p.color.light);
        }
        if (r.av) {
          r.av.innerHTML = avatar(e.p.color.css, e.p.color.light, e.p.id === 0 ? 26 : 22);
        }
      }
      if (changed) rankList.appendChild(r.row);
    });

    if (changed) {
      order = next;
      for (const r of rankRows) {
        const dy = (before[r.p.id] || 0) - (r.row.offsetTop || 0);
        if (!dy || !r.row.style) continue;
        r.row.style.transition = 'none';
        r.row.style.transform = `translateY(${dy}px)`;
        void (r.row.offsetWidth || 0);
        r.row.style.transition = 'transform .32s cubic-bezier(.22,.9,.3,1)';
        r.row.style.transform = 'translateY(0)';
      }
    }
  }

  /* -------------------------------------------------------------- refresh */
  let regions = regionReport(state);

  /*
   * THE HAIRLINE NO LONGER MEASURES ANYTHING.
   *
   *   "The hairline isn't needed at all, but I do like having the hairline just
   *    be always full, so it's more just a static visual element."
   *
   * It was two readouts in one 3px bar: how much of that resource was still
   * standing on the island, and — once a resource had run out everywhere — how
   * far the first region was through coming back. Neither is a number anybody
   * plays off. What the player actually reads at a glance is the numeral, and a
   * bar that quietly drains under it while they collect reads as a warning
   * about something they cannot act on.
   *
   * So the width write is gone and `width:100%` in ui-hud.css is now the only
   * width it has. `regionReport` is still called, because `regions` is read by
   * the guide panel; only the hairline stopped listening. The DRY state stays,
   * because "there is none of this anywhere" is worth saying — it just says it
   * by dimming the icon and the numeral instead.
   */
  function refreshRegions() {
    regions = regionReport(state);
    for (const r of RES) {
      toggle(resSlots[r].node, 'dry', regions[r].live === 0);
    }
  }

  function setBadge(b, n) {
    toggle(b.badge, 'hid', !n);
    if (n) setText(b.badge, n > 9 ? '9+' : n);
  }

  /* --------------------------------------------------- the latched counters
   *
   *   "That way you can't be stolen from while actively trading. But you don't
   *    know the Knight hit until you leave the port or trading post."
   *
   * Offline a trade sheet stops the world, so nothing can move behind it.
   * Online it cannot, so the five numbers you are trading against are frozen
   * at what they were when the sheet opened. They are DISPLAY only: `me.res`
   * stays truthful underneath, so a trade is judged on the goods you really
   * have and the server never has to disagree with the button you pressed.
   *
   * main.js holds the Knight card itself for the same window. Between them,
   * everything that would tell you about a raid mid-trade waits until you are
   * done and then arrives at once.
   */
  let latch = null;

  function displayRes() {
    const net = game.net;
    const online = !!(net && net.active);
    const sheet = !!(game.panels && game.panels.isOpen && state.phase === 'play');
    if (!online || !sheet) { latch = null; return me.res; }
    if (!latch) latch = { ...me.res };
    return latch;
  }

  /**
   * A POINT LANDED. MAKE THE CORNER IMPOSSIBLE TO MISS.
   *
   *   "Also add an animation for the victory point, since it's adding/increasing
   *    their point total by one — I want that animation in the point counter in
   *    the top corner to be a lot more clear and fun when I win a victory point
   *    card, so users who are still busy running around realize what happened."
   *
   * "Still busy running around" is the whole brief. The player is not looking at
   * the top-left corner; they are looking at their settler, somewhere in the
   * middle of the island. Nothing that only changes a numeral will ever reach
   * them, and the numeral is exactly what this used to do — `setText(vpNum, vp)`
   * and a pip quietly turning gold, with no transition on either.
   *
   * So four things fire at once, and they are four different KINDS of signal,
   * because peripheral vision is far better at some of them than at others:
   *
   *   MOTION AT THE EDGE   the whole scoreboard takes one short scale bump.
   *                        Movement in the corner of the eye is the only thing
   *                        that reliably pulls a gaze that is somewhere else,
   *                        and it is the one signal a player who is mid-run can
   *                        pick up without stopping.
   *   A BURST              a gold ring expands out of the score row and the row
   *                        itself washes gold and fades back down. This is what
   *                        is waiting when the gaze arrives a beat later — it
   *                        says WHERE, not just THAT.
   *   THE NUMBER ITSELF    the total swells to nearly half again its size, goes
   *                        white-hot, and settles. Read at any point in that
   *                        second it is still the right number.
   *   A RISING +1          lifts off the counter and fades out above it. This is
   *                        the one that answers "by how much", and it carries
   *                        the real figure, so a city (two points) or an award
   *                        (four) says so rather than lying.
   *
   * ...and the new pip on the victory track flares and drops back into the row,
   * so the progress bar is where the eye lands last and the step it just took
   * is the one thing still glowing. On a phone the track is not drawn at all
   * (see the compact block in ui-hud.css) and the other four carry it alone.
   *
   * IT IS ONE SECOND LONG. Every animation involved is under 1.05s and none of
   * them repeat. A player wins a handful of points a match and a celebration
   * that outstays that is a celebration they start resenting; the brief asked
   * for clear and fun, not for a cutscene. Nothing flashes white, nothing
   * strobes, nothing shakes the camera — it is a gold swell in the corner of a
   * calm interface, which is the register the rest of this game is written in.
   *
   * It fires on ANY increase, not only on the card. A settlement, a city and
   * Longest Road all put points on the same counter, and a counter that
   * celebrates one source and ignores three would be teaching the player that
   * the corner is unreliable — which is the habit this is trying to break.
   *
   * ---------------------------------------------------------------------------
   * AND IT HAD TO REACH FURTHER THAN THE CORNER
   * ---------------------------------------------------------------------------
   *   "MAKE THE EVENT CATCHABLE FROM SCREEN CENTRE. As shipped it is under
   *    700ms confined to a ~170x40px corner region with no motion travelling
   *    toward the player's gaze... Suggestion: have the trophy travel from the
   *    centre notice pill to the counter."
   *
   * Which is the honest reading of "users who are still busy running around".
   * Everything above happens where the player is NOT looking, and asking the
   * edge of somebody's vision to notice a forty-pixel-tall row is asking a lot.
   * The one place the eye demonstrably IS at that moment is the middle of the
   * screen, because the notice plate has just landed there saying VICTORY POINT.
   *
   * So a fifth signal starts where the eye already is and goes to where the
   * answer is: the trophy lifts off the centre plate and flies to the counter,
   * arriving at `LAND_MS`. It is one small gold disc travelling once, for just
   * over a third of a second — and everything in the corner is timed to ITS
   * arrival rather than to the draw. The "+1" is the only thing up before it
   * lands (see below); the number, the ring and the pip all break at the moment
   * it gets there, so the burst reads as caused by the thing that flew in.
   *
   * ---------------------------------------------------------------------------
   * THE +1 GOES UP BEFORE THE NUMBER MOVES
   * ---------------------------------------------------------------------------
   *   "FIRE THE '+1' BEFORE THE NUMBER FLIPS. Currently the count reads 4 at
   *    t000 and the '+1' only appears at t170, so the payoff precedes the
   *    cause."
   *
   * The old order was: set the numeral, then start an animation that faded a
   * "+1" in over the next fifth of a second. Read frame by frame that is the
   * total announcing itself and a receipt arriving afterwards.
   *
   * Now the "+1" is the FIRST thing on the counter — fully opaque within one
   * frame of the draw — and the numeral is genuinely held at its old value until
   * the trophy lands, `FLIP_S` later. Held on the HUD's own clock (see `update`)
   * rather than on a `setTimeout`, for the same reason the notice's hold is: a
   * match that pauses mid-celebration must not have the number flip behind the
   * pause screen, and a HUD that is torn down must not have a stale timer reach
   * into a detached node.
   */
  const FLY_MS = 1250;                   // the flying trophy's whole existence
  const LAND_MS = 400;                   // ...and when it reaches the counter
  const BURST_MS = 1250;                 // the corner's own celebration
  const FLIP_S = LAND_MS / 1000;

  /** Where the trophy sets off from: the centre plate, if one is up. */
  function flyFrom() {
    const plate = notice.plate;
    const r = plate && plate.getClientRects && plate.getClientRects().length
      ? plate.getBoundingClientRect() : null;
    const box = hud.getBoundingClientRect();
    // No notice on screen — a settlement, a city, an award. The middle of the
    // screen at the height a notice would have been is still the best guess at
    // where the player is looking, and it is where the eye goes anyway.
    if (!r) return { x: box.width / 2, y: box.height * 0.36 };
    return { x: r.x + r.width / 2 - box.x, y: r.y + r.height / 2 - box.y };
  }

  function launchTrophy() {
    if (!vpFly.style || !vpIco.getClientRects) return;
    const t = vpIco.getBoundingClientRect();
    const box = hud.getBoundingClientRect();
    if (!t.width) return;                // the corner is not on screen yet
    const from = flyFrom();
    const to = { x: t.x + t.width / 2 - box.x, y: t.y + t.height / 2 - box.y };
    vpFly.style.left = (from.x - 22).toFixed(1) + 'px';
    vpFly.style.top = (from.y - 22).toFixed(1) + 'px';
    vpFly.style.setProperty('--fx', (to.x - from.x).toFixed(1) + 'px');
    vpFly.style.setProperty('--fy', (to.y - from.y).toFixed(1) + 'px');
    replay(vpFly, 'fly', FLY_MS);
  }

  /* The numeral the counter is holding back, and how long for. `to` is null
     when nothing is pending, which is every frame but about twenty a match. */
  let vpFlipTo = null, vpFlipT = 0;

  function flipVpNow() {
    if (vpFlipTo === null) return;
    setText(vpNum, vpFlipTo);
    vpFlipTo = null; vpFlipT = 0;
  }

  function celebrateVp(from, to) {
    // A second point landing while the first is still held: show the first
    // immediately rather than skipping a number the player never saw.
    flipVpNow();
    vpFlipTo = to; vpFlipT = FLIP_S;

    setText(vpPlus, '+' + (to - from));
    replay(vpPlus, 'up', BURST_MS);
    replay(vpBox || scoreCard, 'vp-gain', BURST_MS);
    replay(vpNum, 'bump', BURST_MS);
    for (let i = from; i < to && i < vpCells.length; i++) replay(vpCells[i], 'lit', BURST_MS);
    launchTrophy();
  }

  /* What the counter is currently SHOWING, which is not the same as the score:
     -1 means nothing has been painted yet, and the first paint of a match — or
     of a client joining one already in progress — must not be celebrated as a
     gain from zero. */
  let vpShown = -1;

  function refreshAll(force) {
    const shown = displayRes();
    for (const r of RES) {
      const s = resSlots[r];
      const v = shown[r] | 0;
      if (s.last !== v) {
        if (v > s.last && s.last >= 0) replay(s.node, 'res-pop', 480);
        s.last = v;
        setText(s.num, v);
      }
    }
    const vp = scoreOf(state, me);
    if (vp !== vpShown) {
      const was = vpShown;
      vpShown = vp;
      // Only a real gain, in a match that is actually being played. The two
      // settlements of the opening draft are placed by the player one after the
      // other with the board in their face, so they need no help from the
      // corner and would only teach them to ignore it.
      const party = was >= 0 && vp > was && state.phase === 'play';
      // A celebrated gain holds the numeral back until the trophy lands on it;
      // everything else — the first paint, a client joining, a score going DOWN
      // — writes it here and now, as it always did.
      if (party) celebrateVp(was, vp);
      else { vpFlipTo = null; vpFlipT = 0; setText(vpNum, vp); }
    }
    for (let i = 0; i < vpCells.length; i++) toggle(vpCells[i], 'on', i < vp);
    refreshAwards();
    refreshRanks();
    setBadge(btnBuild, buildBar.refresh());
    if (force) refreshRegions();
  }

  /**
   * The two awards, and the one number that is hard to work out by eye.
   *
   * Ties go to the INCUMBENT (`recomputeAwards` in rules.js keeps the holder on
   * `>=`), so matching the leader's road length wins nothing — you need one
   * more than they have. And with nobody holding it you still need the floor:
   * four segments, two knights. Both cases collapse to the same expression,
   * which is what the `need` figure is:
   *
   *     max(FLOOR, holderValue + 1) - yourValue
   *
   * Written out in words on the line rather than left to the player, because
   * "how many road pieces will it take me to get it" was the actual question.
   */
  function awardLine(aw, floor, holderId, values, unit) {
    const mine = values[0] | 0;
    const held = holderId >= 0;
    const holder = held ? state.players[holderId] : null;
    const top = held ? values[holderId] | 0 : 0;
    const need = Math.max(0, Math.max(floor, top + 1) - mine);
    const key = `${holderId}|${top}|${mine}|${need}`;
    if (key === aw.last) return;
    aw.last = key;

    setText(aw.size, held ? String(top) : '—');
    toggle(aw.row, 'unheld', !held);
    toggle(aw.row, 'ours', holderId === 0);
    if (holder) {
      setText(aw.holder, holderId === 0 ? 'YOURS' : holder.name);
      aw.holder.style.setProperty('--c', holder.color.light);
    } else {
      /* THE FLOOR HAS TO BE SAID SOMEWHERE.
       *
       * With the `+N roads` chip gone, an unclaimed award showed `0 › —`, which
       * is true and useless: it does not say that four segments will not do it
       * either, because nothing under the floor can win it. That was the one
       * thing the chip knew which the number pair does not, so it moves onto
       * the line that was otherwise spending itself on the word "Open". */
      setText(aw.holder, `Open · needs ${floor}`);
      aw.holder.style.setProperty('--c', 'rgba(233,243,255,.55)');
    }
    setText(aw.mineN, String(mine));
    if (aw.pair) {
      aw.pair.setAttribute('aria-label', held
        ? `You have ${mine}. ${holder.name} leads with ${top}.`
        : `You have ${mine}. Nobody holds it; ${floor} claims it.`);
    }
    // Kept up to date though nothing shows it — see `awardRow`.
    setText(aw.need, holderId === 0 ? '' : `+${need} ${unit}${need === 1 ? '' : 's'}`);
  }

  function refreshAwards() {
    awardLine(awRoad, LONGEST_ROAD_MIN, state.longestRoadHolder,
      state.players.map(p => p.longestRoadLen), 'road');
    // With Knights switched off before the draft there are no Knights in the
    // deck, so Largest Army cannot be won by anybody. The line says so rather
    // than sitting at "Open · you 0 · +2 knights" for a whole match, inviting
    // the player to chase two points that are not on the table.
    if (!knightsOn()) {
      if (awArmy.last !== 'off') {
        awArmy.last = 'off';
        toggle(awArmy.row, 'unheld', true);
        toggle(awArmy.row, 'ours', false);
        setText(awArmy.size, '—');
        setText(awArmy.holder, 'Knights off');
        awArmy.holder.style.setProperty('--c', 'rgba(233,243,255,.5)');
        setText(awArmy.mineN, '—');
        setText(awArmy.need, '');
        if (awArmy.pair) awArmy.pair.setAttribute('aria-label', 'Knights are switched off.');
      }
      return;
    }
    awardLine(awArmy, LARGEST_ARMY_MIN, state.largestArmyHolder,
      state.players.map(p => p.knightsPlayed), 'knight');
  }

  /* ---------------------------------------------------------------- pause */

  let paused = false;

  const mapOpen = () => !!(game.overview && game.overview.isOpen);
  /** True only for the plain board view — a placement map is not a pause. */
  const viewOpen = () => mapOpen() && game.overview.mode === 'view';

  function togglePause(force) {
    const want = force === undefined ? !paused : !!force;
    if (want === paused) return paused;
    if (want) {
      if (state.phase !== 'play') return false;
      // Something else already owns the screen — a trade sheet, a placement
      // map, the results. Pausing on top of it would fight for the same panel.
      if (mapOpen() || (game.panels && game.panels.isOpen)) return false;
      toggleSettings(false);
      const opened = game.openOverview('view', {
        title: 'Paused',
        hint: 'Nothing moves · Esc or P to resume',
        keepOpen: true
      });
      if (opened === false) return false;
      paused = true;
    } else {
      if (viewOpen()) game.closeOverview();
      paused = false;
    }
    toggle(btnPause.node, 'on', paused);
    return paused;
  }

  /**
   * P toggles the pause, and that is now ALL this handler does.
   *
   *   "The space bar pauses and plays the game ... Esc should open the
   *    settings."
   *
   * Escape used to live here too, and it cannot any more: it has four other
   * jobs first (clear a staged trade, close a sheet, cancel a placement map,
   * close the settings) and deciding between them from inside the HUD would
   * mean the HUD reaching into the trade sheet. `ui/hotkeys.js` owns that whole
   * ladder, and Space with it. P stays here because it is unambiguous and
   * because it is the key the pause hint has always named.
   *
   * Everything that could already own the keyboard is still checked first:
   * panels.js runs its own handler for the trade, cards and results sheets,
   * and a placement map has a Cancel of its own that means something different
   * from "resume".
   */
  function onPauseKey(ev) {
    const code = ev.code || ev.key;
    if (code !== 'KeyP') return;
    if (game.panels && game.panels.isOpen) return;
    if (help && help.isOpen) return;
    if (mapOpen() && !viewOpen()) return;
    if (state.phase !== 'play') return;
    if (ev.preventDefault) ev.preventDefault();
    // A map the player opened themselves is not a pause, but this key closing
    // it is still the least surprising thing it can do.
    if (!paused && viewOpen()) { game.closeOverview(); return; }
    togglePause();
  }
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('keydown', onPauseKey);
  }

  /* ----------------------------------------------------------------- loop */
  let slow = 0, promptT = 0, timeT = 0;

  function update(dt) {
    const d = Number.isFinite(dt) ? dt : 1 / 60;

    // Safety net: if play started without a setupComplete event reaching us,
    // still reveal the controls rather than leaving the player with no HUD.
    if (state.phase === 'play' && hud.classList.contains('pre')) onPlayBegan();

    /* The moment it is over, the bottom of the screen clears. Driven off the
       phase rather than off the victory event, so it is also true for a match
       that ran out the clock and for a client that joined a match already
       won. See the .hud.won note in ui-hud.css. */
    const over = state.phase === 'over';
    if (over !== hud.classList.contains('won')) toggle(hud, 'won', over);

    // The map can be dismissed by its own close button, and the match ends on
    // its own clock. Either way the pause label follows the real state rather
    // than trying to be it.
    if (paused && (!viewOpen() || state.phase !== 'play')) {
      paused = false;
      toggle(btnPause.node, 'on', false);
    }

    /* The held numeral, counted down on the same clock as everything else here
       so that a paused match holds it rather than flipping it behind the pause
       screen. Four hundred milliseconds, once per point. */
    if (vpFlipT > 0) { vpFlipT -= d; if (vpFlipT <= 0) flipVpNow(); }

    slow += d;
    if (slow >= 0.1) { slow = 0; refreshAll(false); }

    // The five availability bars under the resource pill are all that is left
    // on this beat now that the ground report and the coaching line have gone.
    promptT += d;
    if (promptT >= 0.2) { promptT = 0; refreshRegions(); }

    timeT += d;
    if (timeT >= 0.25) { timeT = 0; setText(timerTxt, fmtTime(state.time)); }

    // The centre plate counts its own hold down, on this clock rather than on a
    // timer, so a paused match cannot expire a notice behind the pause screen.
    notice.update(d);

    tradeCue.update(d);
    knightCue.update(d);
    roadCue.update(d);
    raidCue.update(d);
    // The ladder can move by itself (systems/quality.js), so the row follows it
    // rather than remembering what it last drew.
    power.repaint();
  }

  function onPlayBegan() {
    toggle(hud, 'pre', false);
    replay(hud, 'enter', 900);
    refreshAll(true);
    announce('Settle the Island', me.color.css);
  }

  pushAudio();
  refreshAll(true);
  if (state.phase === 'play') toggle(hud, 'pre', false);

  return {
    update, toast, announce, pulseResource, flashCost, requestBuild, onPlayBegan,
    get root() { return hud; },
    openSettings: () => toggleSettings(true),
    closeSettings: () => toggleSettings(false),
    toggleSettings: force => toggleSettings(force),
    get settingsOpen() { return settingsOpen; },
    /* The rules sheet. `main.js` reads `helpOpen` to freeze the match while it
       is up — that freeze IS the pause the player asked for, and it is why the
       sheet does not simply raise the board map the way PAUSE does. */
    openHelp: () => help.open(),
    closeHelp: () => help.close(),
    toggleHelp: force => help.toggle(force),
    get helpOpen() { return help.isOpen; },
    /** The B key, and the BUILD circle, are the same switch. */
    toggleBuild: force => toggleBuildRow(force),
    get buildOpen() { return !buildRow.classList.contains('hid'); },
    get knightCue() { return knightCue; },
    get roadCue() { return roadCue; },
    /** Put the Knight's bill on screen. Driven by main.js's `knight` event. */
    raid(ev) { raidCue.show(ev); },
    get raidOpen() { return raidCue.open; },
    /** Capture-rig hook, and the keyboard route: send the raid card away. */
    dismissRaid() { return raidCue.dismiss ? raidCue.dismiss() : false; },
    togglePause,
    get isPaused() { return paused; },
    destroy() {
      if (typeof window !== 'undefined' && window.removeEventListener) {
        window.removeEventListener('keydown', onPauseKey);
        // The outside-tap close is bound to the window, so it outlives the HUD
        // unless it is taken off here. A stale one would reach into a detached
        // settings sheet on every press of the NEXT match.
        window.removeEventListener('pointerdown', onDocDown, true);
        window.removeEventListener('pointerup', onDocUp, true);
      }
      try { offSettings(); } catch (e) { /* already gone */ }
      help.destroy();
      notice.destroy();
      tradeCue.destroy();
      knightCue.destroy();
      roadCue.destroy();
      raidCue.destroy();
      if (hud.parentNode) hud.parentNode.removeChild(hud);
    }
  };
}

export default createHUD;
