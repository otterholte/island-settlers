/**
 * Island Settlers — the opening snake draft.
 *
 *   createDraft(state, game, deps) ->
 *     { begin(), update(dt) -> doneBoolean, reset(), holding, boardUp }
 *
 * Split out of matchflow.js, which owns everything either side of it.
 *
 * The one rule this module exists to enforce: **the draft is a single, stable
 * view.** The camera goes to the board framing and the board map opens once,
 * in `begin()`, and neither is touched again until matchflow hands off to
 * third-person play. Every beat after that — a rival thinking, a rival's spot
 * lighting up, a piece landing, the player's corners arming, the player's own
 * settlement giving way to the player's own road — is a *re-dress of the same
 * open panel* through `showBoard()`, which overview.js applies in place.
 *
 * Nothing here calls `overview.close()` or `cam.overview(false)`. That pair is
 * what used to snap the player back to the close third-person camera between
 * their settlement and their road, and between every bot pick.
 *
 * A bot pick is three beats rather than one event:
 *
 *   1. `beat` — "Alex is choosing". Nothing on the board yet.
 *   2. `aim`  — the corner or edge Alex has already settled on lights up, so
 *               the player sees where it is going before it gets there.
 *   3. `act`  — the piece lands, then `hold` keeps it on screen for a moment
 *               with a caption naming who picks next.
 *
 * That is what makes a draft the player is only watching — which the shuffled
 * seating in `buildSetupOrder` makes likely — read as an unfolding draft.
 *
 * Owner: Flow agent.
 */

import { HEX_SIZE } from '../core/constants.js';
import { tiles, intersections, BOUNDS } from '../board/layout.js';

import {
  setupCurrentPlayer, setupAdvance, setupPlaceSettlement, setupPlaceRoad,
  legalSettlements, legalRoads
} from '../core/rules.js';

import { chooseSetupSettlement, chooseSetupRoad } from './bots.js';
import { autoDraft } from '../core/options.js';
// `reviewing` holds the stage machine while the finished board is on screen.
import { difficultyParams } from './difficulty.js';

/* ------------------------------------------------------------------ timing */

export const DRAFT_T = {
  // A bot pick is deliberately watchable. Six of these plus the player's two
  // is a ~20s opening, which is the length of a draft rather than the length
  // of a loading bar.
  botBeat: 0.52, botBeatSpread: 0.24,
  botAim: 0.72, botAimSpread: 0.20,
  botRoadBeat: 0.34,
  botRoadAim: 0.42,
  land: 0.38,          // hold after any piece lands, so you see where it went

  humanOpen: 0.50,     // "you're up" beat before the corners arm
  humanReopen: 0.70,   // between your settlement and your road — same view
  idleNudge: 14.0      // gentle reminder if the player wanders off mid-draft
};

/* ------------------------------------------------------------- board poetry */

const COMPASS = [
  'northern', 'north-eastern', 'eastern', 'south-eastern',
  'southern', 'south-western', 'western', 'north-western'
];

const FEATURE = {
  forest: 'woods', hills: 'clay ridge', pasture: 'meadows',
  fields: 'grainfields', mountains: 'peaks', desert: 'dunes'
};

const ORDINAL = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th'];
const ord = i => ORDINAL[i] || `${i + 1}th`;

function compassOf(x, z) {
  const dx = x - BOUNDS.cx;
  const dz = z - BOUNDS.cz;
  // Screen-space north is -z, and the compass runs clockwise from there.
  let a = Math.atan2(dx, -dz);
  if (a < 0) a += Math.PI * 2;
  return COMPASS[Math.round(a / (Math.PI / 4)) % 8];
}

/** "the north-eastern woods" / "the southern dock" — a place, not an index. */
export function placeName(iid) {
  const n = intersections[iid];
  if (!n) return 'the island';
  const central = Math.hypot(n.x - BOUNDS.cx, n.z - BOUNDS.cz) < HEX_SIZE * 0.95;
  if (n.port !== null && n.port !== undefined) return `the ${compassOf(n.x, n.z)} dock`;
  let best = null;
  for (const tid of n.tiles) {
    const t = tiles[tid];
    if (!best || t.pips > best.pips) best = t;
  }
  const noun = best ? (FEATURE[best.terrain] || 'shore') : 'shore';
  if (central) return `the heart of the ${noun}`;
  return `the ${compassOf(n.x, n.z)} ${noun}`;
}

function pipTotal(iid) {
  const n = intersections[iid];
  if (!n) return 0;
  let s = 0;
  for (const tid of n.tiles) s += tiles[tid].pips;
  return s;
}

function strategyOf(p) {
  return ({
    expansion: 'for expansion and the Longest Road',
    cities: 'for settlements and cities',
    cards: 'for development cards and the army'
  })[p.strategy] || 'their own game';
}

/* ==================================================================== draft */

export function createDraft(state, game, deps) {
  const g = game || {};
  const d = deps || {};
  const ui = d.ui;
  const cam = d.cam;
  const rng = typeof d.rng === 'function' ? d.rng : Math.random;
  const announce = d.announce || (() => {});
  const toast = d.toast || (() => {});
  const sfx = d.sfx || (() => {});
  const warn = d.warn || (() => {});
  const world = d.world || (() => ({}));
  const onDone = typeof d.onDone === 'function' ? d.onDone : null;

  const T = DRAFT_T;

  const step = {
    key: '', t: 0, pid: -1, human: false, road: false,
    phase: 'beat', beat: 0, aim: 0,
    target: -1, opened: false, idle: 0
  };

  // The board map is open for the entire draft; `boardUp` records whether it
  // actually came up, because a headless build has no map to stand in.
  let boardUp = false;
  let hold = 0;                  // post-placement beat, shared by bots and human
  let done = false;
  let reviewing = false;         // the finished board is up, waiting on the player

  /**
   * The last road has just gone down. The single view change of the whole
   * draft happens *here*, on the same tick as the placement, rather than a
   * beat later — "only when the last road is placed does it transition" — and
   * the smoothness comes from the transition itself (a 0.55s camera blend
   * under a 0.26s panel fade), not from stalling in front of it.
   */
  function finish() {
    if (done) return;
    done = true;
    hold = 0;
    if (onDone) { try { onDone(); } catch (e) { warn(e); } }
  }

  /* ------------------------------------------------------------- narration */

  /** Where the shuffle put the player, in words. */
  function seatLine() {
    const order = state.setupOrder || [];
    const mine = [];
    for (let i = 0; i < order.length; i++) if (order[i] === 0) mine.push(ord(i));
    if (!mine.length) return 'Snake order — two picks each';
    return `Snake order · you pick ${mine.join(' and ')} of ${order.length}`;
  }

  function picksLeftLine() {
    const total = (state.setupOrder || []).length || 8;
    const left = Math.max(0, total - state.setupIndex - 1);
    return left === 0 ? 'Last pick of the draft' : `${left} pick${left === 1 ? '' : 's'} to follow`;
  }

  function pickLine() {
    const total = (state.setupOrder || []).length || 8;
    return `Pick ${Math.min(state.setupIndex + 1, total)} of ${total}`;
  }

  /**
   * Re-dress the one open board panel. Never closes, never reopens.
   *
   * The sub-line is handed to the rail as well as to the title plate, because
   * ui.css drops `.ov-hint` at 375px tall and the commentary must survive the
   * short viewport.
   */
  function showBoard(mode, extra) {
    const ov = g.overview;
    if (!ov || typeof ov.open !== 'function') return false;
    const e = extra || {};
    const o = Object.assign({ setup: true, cancellable: false, keepOpen: true }, e);
    o.draft = Object.assign({
      index: state.setupIndex,
      order: state.setupOrder,
      pid: step.pid >= 0 ? step.pid : setupCurrentPlayer(state)
    }, e.draft || {}, { note: e.hint || '' });
    try { return ov.open(mode, o) !== false; } catch (err) { warn(err); return false; }
  }

  /* ----------------------------------------------------------------- begin */

  function begin() {
    hold = 0;
    done = false;
    reviewing = false;
    step.key = '';
    step.phase = 'beat';
    step.pid = -1;
    step.target = -1;
    step.opened = false;

    cam.setActive(true);
    cam.overview(true);
    cam.snap(BOUNDS.cx, BOUNDS.cz);

    /* NOBODY WATCHES A DRAFT THEY ARE NOT IN.
     *
     *   "Instead of still having me watch the draft happen I should just
     *    automatically see all of the locations that were chosen on the map
     *    overview, and just press start game as another button on the map
     *    screen once I've reviewed the board — giving me time to create my own
     *    plan of attack once the game starts."
     *
     * So with the setting on there is no draft to watch: all sixteen pieces go
     * down at once, and what the player gets instead is the finished board and
     * as long as they want to look at it. Which is the better version of the
     * request — the minute they were trying not to spend is gone, and the
     * planning time they actually wanted is theirs to end. */
    if (autoDraft()) { runWholeDraft(); return; }

    boardUp = showBoard('draft-watch', { title: 'Opening Draft', hint: seatLine() });

    if (!boardUp) ui.showDraft();
    ui.setDraft({
      index: state.setupIndex, pid: setupCurrentPlayer(state),
      status: 'Opening Draft', sub: 'Two picks each', tip: seatLine()
    });
    announce('Opening Draft', '#ffc93c');
    toast(seatLine(), 'info');
  }

  /**
   * Place the whole opening in one go, then hand the board over for review.
   *
   * Every seat is drafted by the same chooser the rivals use — seat 0 with the
   * difficulty's opening randomness switched off, see `brainOpts` — so this is
   * the same draft that would have played out over the next minute, without
   * the minute. The guard is a hard iteration cap rather than a `while`: a
   * chooser that somehow returns nothing must not spin the tab.
   */
  function runWholeDraft() {
    for (let i = 0; i < 40 && state.phase === 'setup'; i++) {
      const pid = setupCurrentPlayer(state);
      if (pid < 0) { forceAdvance(); continue; }
      if (state.setupNeed === 'road') {
        const eid = safeRoadChoice(pid, state.setupAnchor);
        if (eid < 0 || !setupPlaceRoad(state, pid, eid)) forceAdvance();
      } else {
        const iid = safeSettlementChoice(pid);
        if (iid < 0 || !setupPlaceSettlement(state, pid, iid)) forceAdvance();
      }
    }
    openReview();
  }

  /** The finished board, and one button. The match starts when they say so. */
  function openReview() {
    reviewing = true;
    boardUp = showBoard('draft-watch', {
      title: 'The Island',
      hint: 'Every settlement is placed — start when you are ready',
      cancellable: false,
      action: { label: 'Start the Match', onPress: () => { reviewing = false; finish(); } }
    });
    if (!boardUp) { reviewing = false; finish(); return; }
    ui.setDraft({
      index: 8, pid: 0,
      status: 'The Island',
      sub: 'Every settlement is placed',
      tip: 'Take as long as you like — the clock starts when you do.'
    });
    announce('Your Island', state.players[0].color.css);
  }

  function reset() {
    step.key = ''; step.pid = -1; step.human = false; step.opened = false;
    step.phase = 'beat'; step.target = -1; step.t = 0; step.idle = 0;
    hold = 0; boardUp = false; done = true; reviewing = false;
  }

  /* ------------------------------------------------------------ the picks */

  function stepKey() { return `${state.setupIndex}:${state.setupNeed}`; }

  function beginStep() {
    step.key = stepKey();
    step.t = 0;
    step.opened = false;
    step.idle = 0;
    step.pid = setupCurrentPlayer(state);
    /* WHOSE HANDS THIS PICK IS IN.
     *
     * Seat 0 is the player — unless they have asked not to be asked, in which
     * case the turn runs down the bot path from here: telegraphed, aimed at,
     * placed, narrated as theirs. That is the whole implementation of "just
     * have the bot choose for them too", and it costs no second code path;
     * the difference is one boolean and `brainOpts` handing seat 0 a cleaner
     * set of eyes than any rival gets. */
    step.human = step.pid === 0 && !autoDraft();
    step.target = -1;
    step.road = state.setupNeed === 'road';
    step.phase = 'beat';

    const p = state.players[step.pid];
    if (!p) { step.human = false; return; }

    const road = step.road;
    const second = state.setupIndex >= state.players.length;

    if (step.human) {
      step.beat = road ? T.humanReopen : T.humanOpen;
      ui.setDraft({
        index: state.setupIndex, pid: 0,
        status: 'Your Pick',
        sub: road ? 'Lay your first road' : 'Claim a corner',
        tip: road
          ? 'Roads reach toward your next corner — point it at open ground or a dock.'
          : humanTip(second)
      });
      // The "you're up" beat: the board says so before the corners arm, so the
      // handover from watching to picking is never a surprise.
      showBoard('draft-watch', {
        title: road ? 'Your Road' : "You're Up",
        hint: `${pickLine()} · ${road ? 'Lay your first road' : 'Claim a corner'}`
      });
      announce(road ? 'Your Road' : 'Your Pick', p.color.css);
      sfx('award', { gain: 0.5 });
      return;
    }

    // Bots decide up front so the board can point at the spot while they
    // "think" — the telegraph is the decision, shown a beat early.
    step.beat = road ? T.botRoadBeat : T.botBeat + rng() * T.botBeatSpread;
    step.aim = road ? T.botRoadAim : T.botAim + rng() * T.botAimSpread;
    step.target = road
      ? safeRoadChoice(step.pid, state.setupAnchor)
      : safeSettlementChoice(step.pid);

    /* Seat 0 is called "You", so the third-person phrasing the rivals get
       reads as "You is choosing a corner". When the opening is being claimed
       on the player's behalf it is still THEIR corner, and the board should
       say so in the second person. */
    const mine = step.pid === 0;
    ui.setDraft({
      index: state.setupIndex, pid: step.pid,
      status: mine ? 'Your Pick' : p.name,
      sub: mine
        ? (road ? 'Your road, claimed for you' : 'Your corner, claimed for you')
        : (road ? 'is laying a road' : 'is choosing a corner'),
      tip: road ? picksLeftLine() : (mine
        ? 'Your opening is being picked for you — change that under Opening.'
        : `${p.name} plays ${strategyOf(p)}.`)
    });

    showBoard('draft-watch', {
      title: mine
        ? (road ? 'Your Road' : 'Your Corner')
        : (road ? `${p.name} is laying a road` : `${p.name} is choosing`),
      hint: `${pickLine()} · ${road ? picksLeftLine()
        : (mine ? 'Claimed for you' : 'Plays ' + strategyOf(p))}`
    });
  }

  /**
   * Second beat of a bot pick: light up the spot they have settled on.
   *
   * The title deliberately does not change from the previous beat — a headline
   * that rewrites itself mid-pick reads as a flicker, which is the exact
   * complaint this whole rework is answering. Only the sub-line moves.
   */
  function aimBotStep() {
    step.phase = 'aim';
    const p = state.players[step.pid];
    if (!p) return;
    const road = step.road;
    showBoard('draft-watch', {
      title: road ? `${p.name} is laying a road` : `${p.name} is choosing`,
      hint: road ? 'Running it out now' : `Eyeing ${placeName(step.target)}`,
      spotlight: {
        kind: road ? 'edge' : 'node',
        id: step.target,
        color: p.color.light,
        hot: true
      }
    });
    sfx('blip', { gain: 0.5 });
  }

  function humanTip(second) {
    const legal = legalSettlements(state, 0, true);
    let best = 0;
    for (const iid of legal) best = Math.max(best, pipTotal(iid));
    const bits = [
      `Corners score by pips — the best spot open right now is worth ${best}.`,
      'Three different resources beats two rich ones.',
      'A corner on a dock unlocks 2:1 or 3:1 trading for the whole match.'
    ];
    if (second) bits.push('Your second settlement pays out its resources immediately.');
    return bits.join(' ');
  }

  /**
   * The brain's options for one seat.
   *
   *   "Don't give them really scrappy locations though — just have the bot
   *    choose for them too."
   *
   * Both halves matter. It is the SAME chooser the rivals use, so the opening
   * is a real opening and not a random legal corner — but with `setupNoise` at
   * zero, which is the knob the difficulty levels turn UP to make a weak rival
   * misjudge the draft. An Easy match must not deal its own player a bad
   * corner for the sake of consistency: the setting is about not spending the
   * minute, not about playing worse.
   */
  const CLEAN = { d: { ...difficultyParams(), setupNoise: 0 } };
  const brainOpts = pid => (pid === 0 ? CLEAN : {});

  function safeSettlementChoice(pid) {
    let iid = -1;
    try { iid = chooseSetupSettlement(state, pid, rng, brainOpts(pid)); } catch (e) { warn(e); }
    const legal = legalSettlements(state, pid, true);
    if (legal.indexOf(iid) < 0) iid = legal.length ? legal[0] : -1;
    return iid;
  }

  function safeRoadChoice(pid, anchor) {
    let eid = -1;
    try { eid = chooseSetupRoad(state, pid, anchor, rng, brainOpts(pid)); } catch (e) { warn(e); }
    const legal = legalRoads(state, pid, true, anchor);
    if (legal.indexOf(eid) < 0) eid = legal.length ? legal[0] : -1;
    return eid;
  }

  /** The one hard guarantee of this module: the draft always moves forward. */
  function forceAdvance() {
    try { setupAdvance(state); } catch (e) { warn(e); }
  }

  function placeForBot() {
    step.phase = 'act';
    const pid = step.pid;
    const p = state.players[pid];
    const road = state.setupNeed === 'road';
    let ok = false;
    let placed = -1;

    if (road) {
      const list = legalRoads(state, pid, true, state.setupAnchor);
      const order = step.target >= 0 ? [step.target, ...list] : list;
      for (const eid of order) {
        if (setupPlaceRoad(state, pid, eid)) { ok = true; placed = eid; break; }
      }
      if (ok) {
        ui.setDraft({
          index: state.setupIndex, pid,
          status: p ? p.name : '', sub: 'lays the first road', tip: picksLeftLine()
        });
        sfx('build', { gain: 0.6, mine: pid === 0 });
        cam.shake(0.08);
      }
    } else {
      const list = legalSettlements(state, pid, true);
      const order = step.target >= 0 ? [step.target, ...list] : list;
      for (const iid of order) {
        if (setupPlaceSettlement(state, pid, iid)) { ok = true; placed = iid; break; }
      }
      if (ok) {
        /* NOT ANNOUNCED. "Maya claims the northern pasture" flashed across the
           middle of the board six times in forty seconds, over the board it
           was describing — "commentary no one cares about, and it goes by so
           fast that it's just distracting". The piece appearing on the map IS
           the announcement, and the pip strip says whose turn is next. */
        /* Eight settlements and eight roads go down in the opening and only
           two of them are yours. The sound is the announcement — see the note
           just above — but the buzz is only for your own. */
        sfx('build', { mine: pid === 0 });
        cam.shake(0.14);
        flourish(placed, p);
      }
    }

    if (!ok) { forceAdvance(); return; }

    landedBoard(p, road, placed);
    if (state.phase !== 'setup') { finish(); return; }
    // Hold on the piece that just landed. `setupAdvance` has already moved the
    // pointer on, so this beat is charged against the *next* step and read at
    // the top of update() before beginStep runs.
    hold = T.land;
  }

  /** The board after a piece lands: name what happened, then whose turn next. */
  function landedBoard(p, road, id) {
    if (!p) return;
    const nextPid = setupCurrentPlayer(state);
    const next = state.players[nextPid];
    const nextLine = state.phase !== 'setup'
      ? 'Draft complete'
      : (nextPid === 0 ? 'You are up next' : `${next ? next.name : ''} picks next`);
    showBoard('draft-watch', {
      title: road ? `${p.name} lays a road` : `${p.name} takes a corner`,
      hint: road ? nextLine : `${placeName(id)} · ${nextLine}`,
      spotlight: road ? null : { kind: 'node', id, color: p.color.light, hot: false },
      draft: { index: state.setupIndex, order: state.setupOrder, pid: nextPid }
    });
  }

  function flourish(iid, p) {
    const w = world();
    const n = intersections[iid];
    if (!n) return;
    try {
      if (w.effects && typeof w.effects.ring === 'function') w.effects.ring(n.x, n.z, p.color.hex);
    } catch (e) { /* fx are optional */ }
  }

  /**
   * Arm the *already open* board for the player's pick. This is a re-dress of
   * the same panel — no close, no reopen, no camera change — so the only thing
   * that visibly happens is that the corners light up and the confirm bar
   * slides in.
   */
  function openHumanTurn() {
    step.opened = true;
    const road = state.setupNeed === 'road';
    const anchor = state.setupAnchor;

    const extra = road
      ? {
          anchor,
          title: 'Lay Your First Road',
          hint: 'Tap a glowing edge · tap it again to place',
          pickLabel: 'Pick an edge',
          onConfirm: eid => humanRoad(eid)
        }
      : {
          title: state.setupIndex >= state.players.length
            ? 'Your Second Corner' : 'Claim Your Corner',
          hint: 'High pips · three resources · a dock',
          pickLabel: 'Pick a corner',
          onConfirm: iid => humanSettlement(iid)
        };

    const opened = showBoard(road ? 'place-road' : 'place-settlement', extra);
    // No map, or nothing legal to show — never strand the player mid-draft.
    if (!opened) autoPlaceForHuman();
  }

  function humanSettlement(iid) {
    const ok = setupPlaceSettlement(state, 0, iid);
    if (!ok) return false;
    const p = state.players[0];
    // Your own pick is not narrated either: you just made it.
    sfx('build');
    flourish(iid, p);
    // Same board, same camera — only the caption changes while the road beat
    // runs. This is the transition the player called out by name.
    hold = T.land;
    showBoard('draft-watch', {
      title: 'You take a corner',
      hint: `${placeName(iid)} · now run a road out of it`,
      spotlight: { kind: 'node', id: iid, color: p.color.light, hot: false },
      draft: { index: state.setupIndex, order: state.setupOrder, pid: 0 }
    });
    return true;
  }

  function humanRoad(eid) {
    const ok = setupPlaceRoad(state, 0, eid);
    if (!ok) return false;
    sfx('build');
    landedBoard(state.players[0], true, eid);
    if (state.phase !== 'setup') { finish(); return true; }
    hold = T.land;
    return true;
  }

  /* The last resort, and it used to take the FIRST legal spot in the list —
     which is an arbitrary corner and exactly the "really scrappy location" the
     player asked not to be given. It asks the brain first now, for the same
     reason and with the same clean eyes as the Opening setting; the first legal
     spot survives only as the fallback behind the fallback. */
  function autoPlaceForHuman() {
    if (state.setupNeed === 'road') {
      const pick = safeRoadChoice(0, state.setupAnchor);
      if (pick >= 0 && setupPlaceRoad(state, 0, pick)) return;
      const list = legalRoads(state, 0, true, state.setupAnchor);
      for (const eid of list) if (setupPlaceRoad(state, 0, eid)) return;
    } else {
      const pick = safeSettlementChoice(0);
      if (pick >= 0 && setupPlaceSettlement(state, 0, pick)) return;
      const list = legalSettlements(state, 0, true);
      for (const iid of list) if (setupPlaceSettlement(state, 0, iid)) return;
    }
    forceAdvance();
  }

  /* ---------------------------------------------------------------- update */

  /** Returns true when the draft is finished and the caller may hand off. */
  function update(dt) {
    if (done) return false;

    // The landing beat is charged before anything else, so the piece that just
    // appeared gets held on screen before the next name comes up.
    if (hold > 0) {
      hold -= dt;
      if (hold > 0) return false;
    }

    // The board is placed and the player is looking at it. Nothing advances
    // until they press the button — that wait IS the feature.
    if (reviewing) return false;

    // Backstop: the draft ended somewhere this module did not see it happen.
    if (state.phase !== 'setup') { done = true; return true; }

    if (stepKey() !== step.key) beginStep();
    if (step.pid < 0) { forceAdvance(); return false; }

    step.t += dt;

    if (step.human) {
      // The player's turn waits. It does not time out into an auto-pick.
      if (!step.opened && step.t >= step.beat) openHumanTurn();
      if (step.opened) {
        step.idle += dt;
        if (step.idle > T.idleNudge) {
          step.idle = 0;
          toast('Tap a glowing spot, then tap it again to place', 'warn');
        }
      }
      return false;
    }

    if (step.phase === 'beat' && step.t >= step.beat) aimBotStep();
    if (step.phase === 'aim' && step.t >= step.beat + step.aim) placeForBot();
    return false;
  }

  return {
    begin, update, reset,
    /* `holding` is what matchflow's phase watchdog asks before it decides the
       draft finished without it and yanks the player into play. The landing
       beat used it; the review screen needs it for the same reason and for
       longer: the eighth road flips `state.phase` to 'play' the instant it
       lands, so without this the board would be torn down under somebody who
       has been given it to look at. */
    get holding() { return (hold > 0 || reviewing) && !done; },
    get done() { return done; },
    get boardUp() { return boardUp; },
    get pid() { return step.pid; }
  };
}

export default createDraft;
