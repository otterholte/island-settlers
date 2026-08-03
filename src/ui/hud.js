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
import { knightsOn, buttonsSide, setButtonsSide } from '../core/options.js';

import { el, button, setText, toggle, replay, setVar, fmtTime } from './dom.js';
import { icon, iconEl, resIcon, avatar } from './icons.js';
import { createBuildBar } from './hud-build.js';
import { createTradeCue } from './hud-trade.js';
import { createKnightCue } from './hud-knight.js';
import { createRoadCue } from './hud-road.js';
import { createRaidCue } from './hud-raid.js';
import {
  regionReport, pieceCapped, hasSomewhere
} from './hud-guide.js';

const RES_ICON_PX = 28;

/* Built per match: the two Knight lines are removed outright when the option is
   switched off before the draft, because a How to Play that explains a mechanic
   the match does not have is worse than one that says nothing about it. */
const HOW_TO_ALL = [
  ['Move', 'Drag anywhere on the screen to run — no need to find anything, the stick appears under your thumb.'],
  ['Gather', 'Run straight over a tree, a sheep, a clay pile — it is yours the moment you touch it. No holding, no waiting.'],
  ['Your land', 'You may only pick things up on a hex where you own a settlement or a city. Everywhere else you run through and collect nothing.'],
  ['Regions', 'Sweep a hex clean and the whole field rests, then comes back at once. The bars under the resource pill show what is still standing.'],
  ['Build', 'Each card fills as you gather. When it glows gold you can afford it — tap it, then pick a glowing spot.'],
  ['Score', `Settlement 1 point, city 2, victory card 1. First to ${VICTORY_POINTS} wins.`],
  ['Awards', 'Longest Road is 4 points, Largest Army 2.'],
  ['Trade', 'The Great Market swaps 4:1; a dock you own does 3:1 or 2:1.'],
  ['Cards', 'A Knight opens the whole board so you can pick the region it shuts down. Road Building opens the map and lays two roads for nothing.'],
  ['The Knight', 'Playing one takes HALF of every resource off every rival at once — and it is gone, not stolen. The hex you then send it to gives nothing to anybody but you.'],
  ['Pause', 'Tap PAUSE, or press P or Escape. The clock, the bots and every settler stop, and the board and standings stay up for as long as you want them.']
];

const KNIGHT_TOPICS = new Set(['Cards', 'The Knight']);
const HOW_TO = knightsOn() ? HOW_TO_ALL : HOW_TO_ALL
  .filter(([t]) => !KNIGHT_TOPICS.has(t))
  .concat([
    ['Cards', 'Road Building opens the map and lays two roads for nothing. Victory Point scores the moment you draw it.'],
    ['No Knights', 'You switched Knights off before the draft, so there are no Knight cards, nothing ever blocks a region, and Largest Army is out of play for everyone.']
  ]);

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
  const gearBtn = button('cbtn small ghost', {
    'aria-label': 'Settings', on: { click: () => toggleSettings() }
  }, mk('span', 'cb-ico', icon('gear', 22)));

  const vpNum = el('b', { text: '0' });
  const vpCells = [];
  const vpTrack = el('span', { class: 'vp-track' });
  for (let i = 0; i < VICTORY_POINTS; i++) {
    const c = el('i', { class: i === VICTORY_POINTS - 1 ? 'goal' : '' });
    vpCells.push(c); vpTrack.appendChild(c);
  }

  /** One award line: icon, who holds it and at what size, your own standing. */
  function awardRow(ico, label) {
    const holder = el('b', { class: 'aw-holder', text: '—' });
    const size = el('em', { class: 'aw-size', text: '0' });
    /* "you" and the number are separate elements so the phone layout can drop
       the word and keep the figure — see the compact block in ui-hud.css,
       where each award collapses to `4 > 6` beside its icon. */
    const mineN = el('b', { text: '0' });
    const mine = el('span', { class: 'aw-mine' },
      el('u', { class: 'aw-you', text: 'you' }), mineN);
    const need = el('span', { class: 'aw-need', text: '' });
    const row = el('div', { class: 'aw-row' },
      el('span', { class: 'aw-ico', html: icon(ico, 18) }),
      el('span', { class: 'aw-body' },
        el('span', { class: 'aw-top' },
          el('span', { class: 'aw-lab', text: label }), size),
        el('span', { class: 'aw-bot' }, holder, mine, need)));
    return { row, holder, size, mine, mineN, need, last: '' };
  }
  const awRoad = awardRow('road', 'Longest Road');
  const awArmy = awardRow('knight', 'Largest Army');

  const scoreCard = el('div', { class: 'scorecard plate' },
    el('div', { class: 'sc-vp' },
      iconEl('trophy', 20), vpNum,
      el('span', { class: 'sc-goal', text: `/ ${VICTORY_POINTS}` }), vpTrack),
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
    resSlots[r] = { node: slot, num, live, last: -1, lastF: -1 };
    resBar.appendChild(slot);
  }

  const tc = el('div', { class: 'hud-tc' }, resBar);

  /* --- top-right: standings, deliberately quiet -------------------------- */
  const rankRows = state.players.map(p => {
    const vp = el('b', { text: '0' });
    const award = el('span', { class: 'rk-award' });
    const row = el('div', {
      class: 'rk' + (p.id === 0 ? ' me' : ''), 'data-p': p.id,
      style: { '--c': p.color.css, '--cl': p.color.light }
    },
      el('span', { class: 'rk-av', html: avatar(p.color.css, p.color.light, p.id === 0 ? 26 : 22) }),
      el('span', { class: 'rk-name', text: p.name }),
      award,
      el('span', { class: 'rk-vp' }, p.id === 0 ? iconEl('trophy', 16) : null, vp));
    return { p, row, vp, award };
  });
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
  const btnBuild = mkCircle('hammer', 'Build', 'gold', () => {
    toggle(buildRow, 'hid', !buildRow.classList.contains('hid'));
  });
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

  /* --- announcements ----------------------------------------------------- */
  const annTxt = el('div', { class: 'ann-txt' });
  const annWrap = el('div', { class: 'announce' }, annTxt);

  /* --- settings ----------------------------------------------------------- */
  let soundOn = true;
  const soundBtn = button('wide cream', { on: { click: () => setSound(!soundOn) } },
    el('span', { class: 'sb-ico', html: icon('sound', 20) }),
    el('span', { class: 'sb-lab', text: 'Sound: On' }));

  const howBody = el('div', { class: 'how hid' },
    HOW_TO.map(([t, d]) => el('p', {}, el('b', { text: t }), el('span', { text: d }))));

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

  const settings = el('div', { class: 'pop settings plate lift hid', 'data-ui': '' },
    el('div', { class: 'pop-head' },
      el('span', { class: 'pop-title', text: 'Settings' }),
      button('cbtn small ghost x', { 'aria-label': 'Close', on: { click: () => toggleSettings(false) } },
        mk('span', 'cb-ico', icon('close', 18)))),
    soundBtn,
    sideRow('Buttons', buttonsSide, v => { setButtonsSide(v); applyButtonSide(); }),
    button('wide cream', { on: { click: () => toggle(howBody, 'hid', !howBody.classList.contains('hid')) } },
      el('span', { class: 'sb-ico', html: icon('help', 20) }),
      el('span', { class: 'sb-lab', text: 'How to Play' })),
    howBody,
    button('wide red', { on: { click: () => game.restart() } },
      el('span', { class: 'sb-ico', html: icon('restart', 20) }),
      el('span', { class: 'sb-lab', text: 'Restart Match' })),
    /* The second way home. The map pad's HOME key is the one the player named,
       but the pad is only up while the map is, so the gear carries the same
       exit for the rest of the match. Both land on the opening screen. */
    button('wide cream', { on: { click: () => leaveMatch() } },
      el('span', { class: 'sb-ico', html: icon('home', 20) }),
      el('span', { class: 'sb-lab', text: 'Leave Match' }))
  );

  hud.appendChild(tl); hud.appendChild(tc); hud.appendChild(tr);
  hud.appendChild(bc); hud.appendChild(br);
  hud.appendChild(annWrap); hud.appendChild(settings);
  root.appendChild(hud);

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
  let annT = 0, lastRival = -99;

  function announce(text, color) {
    if (!text) return;
    const s = String(text);
    if (rivalNames.some(n => s.startsWith(n))) {
      if (state.time - lastRival < 10) return;
      lastRival = state.time;
      toast(s, 'info');
      return;
    }
    annTxt.textContent = s;
    if (color && annTxt.style) annTxt.style.setProperty('--ac', color);
    replay(annWrap, 'show', 2600);
    annT = 2.4;
  }

  /* ------------------------------------------------------------ resources */
  function pulseResource(res) {
    const s = resSlots[res];
    if (s) replay(s.node, 'pop', 480);
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
      if (card.type === 'victoryPoint') announce('+1 Victory Point!', '#ffc93c');
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
    game.openOverview('place-' + kind, {});
    return true;
  }

  function setSound(on) {
    soundOn = !!on;
    const a = game.audio;
    if (a) {
      a.muted = !soundOn;
      if (typeof a.setMuted === 'function') a.setMuted(!soundOn);
      else if (typeof a.mute === 'function') a.mute(!soundOn);
      if (typeof a.ambience === 'function') a.ambience(soundOn);
      if (typeof a.music === 'function' && !soundOn) a.music('off');
    }
    soundBtn.childNodes[0].innerHTML = icon(soundOn ? 'sound' : 'mute', 20);
    soundBtn.childNodes[1].textContent = 'Sound: ' + (soundOn ? 'On' : 'Off');
  }

  let settingsOpen = false;
  function toggleSettings(force) {
    settingsOpen = force === undefined ? !settingsOpen : !!force;
    toggle(settings, 'hid', !settingsOpen);
    toggle(gearBtn, 'on', settingsOpen);
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

  function refreshRegions() {
    regions = regionReport(state);
    for (const r of RES) {
      const s = resSlots[r];
      const rr = regions[r];
      const dry = rr.live === 0;
      const f = dry ? rr.recovery : rr.live / Math.max(1, rr.total);
      if (Math.abs(f - s.lastF) > 0.01) {
        s.lastF = f;
        setVar(s.live.firstChild, 'width', (f * 100).toFixed(1) + '%');
      }
      toggle(s.node, 'dry', dry);
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

  function refreshAll(force) {
    const shown = displayRes();
    for (const r of RES) {
      const s = resSlots[r];
      const v = shown[r] | 0;
      if (s.last !== v) {
        if (v > s.last && s.last >= 0) replay(s.node, 'pop', 480);
        s.last = v;
        setText(s.num, v);
      }
    }
    const vp = scoreOf(state, me);
    setText(vpNum, vp);
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
      setText(aw.holder, 'Open');
      aw.holder.style.setProperty('--c', 'rgba(233,243,255,.55)');
    }
    setText(aw.mineN, String(mine));
    // The player already holding it does not need to be told how to take it.
    setText(aw.need, holderId === 0 ? '' : `+${need} ${unit}${need === 1 ? '' : 's'}`);
    toggle(aw.need, 'hid', holderId === 0);
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
        toggle(awArmy.need, 'hid', true);
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
   * P toggles. Escape pauses, and un-pauses.
   *
   * Everything that could already own the keyboard is checked first and left
   * alone: panels.js runs its own Escape handler for the trade, cards and
   * results sheets, and a placement map has a Cancel button of its own that
   * means something different from "resume".
   */
  function onPauseKey(ev) {
    const code = ev.code || ev.key;
    if (code !== 'KeyP' && code !== 'Escape') return;
    if (game.panels && game.panels.isOpen) return;
    if (mapOpen() && !viewOpen()) return;
    if (state.phase !== 'play') return;
    if (ev.preventDefault) ev.preventDefault();
    // A map the player opened themselves is not a pause, but Escape closing it
    // is still the least surprising thing that key can do.
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

    slow += d;
    if (slow >= 0.1) { slow = 0; refreshAll(false); }

    // The five availability bars under the resource pill are all that is left
    // on this beat now that the ground report and the coaching line have gone.
    promptT += d;
    if (promptT >= 0.2) { promptT = 0; refreshRegions(); }

    timeT += d;
    if (timeT >= 0.25) { timeT = 0; setText(timerTxt, fmtTime(state.time)); }

    if (annT > 0) { annT -= d; if (annT <= 0) toggle(annWrap, 'show', false); }

    tradeCue.update(d);
    knightCue.update(d);
    roadCue.update(d);
    raidCue.update(d);
  }

  function onPlayBegan() {
    toggle(hud, 'pre', false);
    replay(hud, 'enter', 900);
    refreshAll(true);
    announce('Settle the Island', me.color.css);
  }

  setSound(true);
  refreshAll(true);
  if (state.phase === 'play') toggle(hud, 'pre', false);

  return {
    update, toast, announce, pulseResource, flashCost, requestBuild, onPlayBegan,
    get root() { return hud; },
    openSettings: () => toggleSettings(true),
    get knightCue() { return knightCue; },
    get roadCue() { return roadCue; },
    /** Put the Knight's bill on screen. Driven by main.js's `knight` event. */
    raid(ev) { raidCue.show(ev); },
    get raidOpen() { return raidCue.open; },
    togglePause,
    get isPaused() { return paused; },
    destroy() {
      if (typeof window !== 'undefined' && window.removeEventListener) {
        window.removeEventListener('keydown', onPauseKey);
      }
      tradeCue.destroy();
      knightCue.destroy();
      roadCue.destroy();
      raidCue.destroy();
      if (hud.parentNode) hud.parentNode.removeChild(hud);
    }
  };
}

export default createHUD;
