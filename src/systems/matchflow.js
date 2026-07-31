/**
 * Island Settlers — match flow.
 *
 *   createMatchFlow(state, game) ->
 *     { update(dt), begin(), skipIntro(), restartInPlace(), stage }
 *
 * The first ninety seconds and the last ten. This module owns:
 *
 *   1. the opening cinematic — an establishing sweep over the island, the match
 *      intro card, and the four competitors;
 *   2. the snake draft — six watchable bot picks with camera nudges and
 *      callouts, and two human picks driven through the board overview;
 *   3. the handoff into third-person play, plus the pacing beats that keep a
 *      real-time match legible (halfway, match point, final minute);
 *   4. the stalemate safety net at MATCH_SOFT_CAP_SEC;
 *   5. the victory sequence — freeze, hold a beat, pull to the board overview,
 *      light up the winner's network, then release the results panel.
 *
 * All rules mutation goes through rules.js; all speech goes through hud.js and
 * overview.js. `state.flowActive` is set immediately so the 3.5s draft
 * watchdog inside bots.js — which only exists to cover for this module being
 * absent — never fires.
 *
 * Victory is intercepted by wrapping `game.panels.showResults` and
 * `game.camera.celebrate` rather than by racing main.js's event pump: main.js
 * drains events after the fixed-step loop, so an event emitted by the bots can
 * reach the results panel before this module's next update. Wrapping the two
 * presentation entry points is the only interception that is frame-order safe.
 *
 * Owner: Flow agent.
 */

import { VICTORY_POINTS, MATCH_SOFT_CAP_SEC, HEX_SIZE } from '../core/constants.js';

import { tiles, intersections, edges, BOUNDS } from '../board/layout.js';

import { mulberry32 } from '../board/nodes.js';

import {
  setupCurrentPlayer, setupAdvance, setupPlaceSettlement, setupPlaceRoad,
  legalSettlements, legalRoads, scoreOf, rankings, emit
} from '../core/rules.js';

import { chooseSetupSettlement, chooseSetupRoad } from './bots.js';
import { createFlowUI } from './flowUI.js';
import { createFlowCamera } from './flowCamera.js';
import { resetMatchInPlace } from './flowRestart.js';

/* ------------------------------------------------------------------ timing */

const T = {
  boot: 0.40,          // let the boot splash clear before the title lands
  title: 5.2,          // intro card hold (skippable)
  draftIntro: 1.30,    // "opening draft" beat before the first pick
  botSettleBase: 0.66, // watchable, not sluggish
  botSettleSpread: 0.34,
  botRoadBase: 0.50,
  botRoadSpread: 0.26,
  humanOpen: 0.16,     // beat before the map opens for a settlement
  humanReopen: 0.38,   // longer beat between settlement and road, so it reads
  handoff: 2.30,
  idleNudge: 14.0      // gentle reminder if the player wanders off mid-draft
};

const WIN = {
  overview: 0.34,      // pull to the board framing
  firstTile: 0.62,     // begin lighting the winner's network
  tileStep: 0.12,
  reveal: 2.20         // results panel + celebration orbit
};

const HALF_TARGET = Math.ceil(VICTORY_POINTS / 2);
const FINAL_CALL = 60;                 // seconds of soft cap left for the warning

/* ------------------------------------------------------------- board poetry */

const COMPASS = [
  'northern', 'north-eastern', 'eastern', 'south-eastern',
  'southern', 'south-western', 'western', 'north-western'
];

const FEATURE = {
  forest: 'woods', hills: 'clay ridge', pasture: 'meadows',
  fields: 'grainfields', mountains: 'peaks', desert: 'dunes'
};

function compassOf(x, z) {
  const dx = x - BOUNDS.cx;
  const dz = z - BOUNDS.cz;
  // Screen-space north is -z, and the compass runs clockwise from there.
  let a = Math.atan2(dx, -dz);
  if (a < 0) a += Math.PI * 2;
  return COMPASS[Math.round(a / (Math.PI / 4)) % 8];
}

/** "the north-eastern woods" / "the southern dock" — a place, not an index. */
function placeName(iid) {
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

/* ==================================================================== flow */

export function createMatchFlow(state, game) {
  const g = game || {};
  const rng = mulberry32(((state && state.flowSeed) || 0x1f2e3d4c) >>> 0);

  // Claim the draft before bots.js's fallback timer can ever matter.
  state.flowActive = true;

  const root = pickRoot(g);
  const ui = createFlowUI(root, state, g);
  const cam = createFlowCamera(g);

  ui.onSkip(() => skipIntro());

  /* ------------------------------------------------------- outcome capture */

  let realShowResults = null;
  let realCelebrate = null;
  patchOutcome();

  function patchOutcome() {
    const panels = g.panels;
    if (panels && typeof panels.showResults === 'function' && !panels.__mfWrapped) {
      const original = panels.showResults;
      realShowResults = wid => { try { original.call(panels, wid); } catch (e) { warn(e); } };
      panels.showResults = wid => startWin(wid);
      panels.__mfWrapped = true;
    }
    const c = g.camera;
    if (c && typeof c.celebrate === 'function' && !c.__mfWrapped) {
      const original = c.celebrate;
      realCelebrate = p => { try { original.call(c, p); } catch (e) { warn(e); } };
      // main.js celebrates the moment the event lands; we hold it for the beat.
      c.celebrate = () => {};
      c.__mfWrapped = true;
    }
  }

  /* ------------------------------------------------------------------ state */

  let started = false;
  let stage = 'boot';       // boot|title|draftIntro|draft|handoff|play|over
  let stageT = 0;
  let elapsed = 0;

  const step = {
    key: '', t: 0, delay: 0, pid: -1, human: false,
    target: -1, opened: false, nudged: false, idle: 0
  };

  const win = {
    active: false, done: false, t: 0, wid: -1,
    byTime: false, tiles: [], lit: 0
  };

  const beats = { half: false, matchPoint: new Set(), finalCall: false };
  let beatT = 0;

  /* ------------------------------------------------------------- utilities */

  function warn(e) {
    if (typeof console !== 'undefined' && console.warn) console.warn('[flow]', e && e.message);
  }

  function pickRoot(gg) {
    if (gg && gg.uiRoot) return gg.uiRoot;
    if (typeof document === 'undefined' || !document.getElementById) return null;
    return document.getElementById('ui');
  }

  function announce(text, color) {
    const hud = g.hud;
    if (hud && typeof hud.announce === 'function') {
      try { hud.announce(text, color); return; } catch (e) { warn(e); }
    }
    toast(text);
  }

  function toast(text, kind) {
    const hud = g.hud;
    if (hud && typeof hud.toast === 'function') {
      try { hud.toast(text, kind); return; } catch (e) { warn(e); }
    }
    if (typeof g.toast === 'function') { try { g.toast(text, kind); } catch (e) { warn(e); } }
  }

  function sfx(name, opts) {
    const a = g.audio;
    if (a && typeof a.sfx === 'function') { try { a.sfx(name, opts); } catch (e) { warn(e); } }
  }

  let inputLocked = false;

  function setInput(on) {
    inputLocked = !on;
    const inp = g.input;
    if (!inp) return;
    if (typeof inp.setEnabled === 'function') { try { inp.setEnabled(on); } catch (e) { warn(e); } }
    if (!on) holdStick();
  }

  /**
   * `input.setEnabled(false)` drops the touch joystick but the keyboard
   * fallback keeps writing to `stick` every frame. This runs before
   * playerController.update() inside the same fixed step, so zeroing here is
   * what actually keeps the settler still during the draft and after victory.
   */
  function holdStick() {
    const inp = g.input;
    if (inp && inp.stick) { inp.stick.x = 0; inp.stick.y = 0; }
  }

  function closeOverview() {
    const ov = g.overview;
    if (ov && typeof ov.close === 'function') { try { ov.close(); } catch (e) { warn(e); } }
    const panels = g.panels;
    if (panels && panels.kind && panels.kind !== 'results' && typeof panels.close === 'function') {
      try { panels.close(); } catch (e) { warn(e); }
    }
  }

  const world = () => (g.world || {});

  /* ------------------------------------------------------------------ begin */

  function begin() {
    if (started) return;
    started = true;
    state.flowActive = true;

    if (state.phase === 'play') { enterPlay(true); return; }
    if (state.phase === 'over') { startWin(state.winner); return; }

    setInput(false);
    cam.setActive(true);
    cam.overview(false);
    // A slow, low arc across the island: this is the establishing shot.
    cam.arc(-2.55, -0.52, BOUNDS.radius * 0.60, BOUNDS.radius * 0.44, T.boot + T.title);
    stage = 'boot';
    stageT = 0;
  }

  function skipIntro() {
    if (!started) begin();
    if (stage === 'boot' || stage === 'title') {
      ui.hideIntro();
      stage = 'draftIntro';
      stageT = 0;
      openDraftFraming();
    } else if (stage === 'draftIntro') {
      stageT = T.draftIntro;
    }
  }

  function openDraftFraming() {
    cam.setActive(true);
    cam.overview(true);
    ui.showDraft();
    ui.setDraft({
      index: state.setupIndex, pid: setupCurrentPlayer(state),
      status: 'Opening Draft', sub: 'Two picks each',
      tip: 'Snake order: everyone picks once, then again in reverse.'
    });
    announce('Opening Draft', '#ffc93c');
  }

  /* ------------------------------------------------------------- the draft */

  function stepKey() { return `${state.setupIndex}:${state.setupNeed}`; }

  function beginStep() {
    step.key = stepKey();
    step.t = 0;
    step.opened = false;
    step.nudged = false;
    step.idle = 0;
    step.pid = setupCurrentPlayer(state);
    step.human = step.pid === 0;
    step.target = -1;

    const p = state.players[step.pid];
    if (!p) { step.human = false; return; }

    const road = state.setupNeed === 'road';
    const second = state.setupIndex >= state.players.length;

    if (step.human) {
      step.delay = road ? T.humanReopen : T.humanOpen;
      ui.setDraft({
        index: state.setupIndex, pid: 0,
        status: 'Your Pick',
        sub: road ? 'Lay your first road' : 'Claim a corner',
        tip: road
          ? 'Roads reach toward your next corner — point it at open ground or a dock.'
          : humanTip(second)
      });
      return;
    }

    // Bots decide up front so the camera can travel while they "think".
    step.delay = road
      ? T.botRoadBase + rng() * T.botRoadSpread
      : T.botSettleBase + rng() * T.botSettleSpread;

    if (road) {
      step.target = safeRoadChoice(step.pid, state.setupAnchor);
      const e = edges[step.target];
      if (e) cam.look(e.x, e.z, 2.6);
    } else {
      step.target = safeSettlementChoice(step.pid);
      const n = intersections[step.target];
      if (n) cam.look(n.x, n.z, 2.2);
    }
    cam.overview(false);

    ui.setDraft({
      index: state.setupIndex, pid: step.pid,
      status: p.name,
      sub: road ? 'is laying a road' : 'is choosing a corner',
      tip: road ? '' : `${p.name} plays ${strategyOf(p)}.`
    });
  }

  function strategyOf(p) {
    return ({
      expansion: 'for expansion and the Longest Road',
      cities: 'for settlements and cities',
      cards: 'for development cards and the army'
    })[p.strategy] || 'their own game';
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

  function safeSettlementChoice(pid) {
    let iid = -1;
    try { iid = chooseSetupSettlement(state, pid, rng); } catch (e) { warn(e); }
    const legal = legalSettlements(state, pid, true);
    if (legal.indexOf(iid) < 0) iid = legal.length ? legal[0] : -1;
    return iid;
  }

  function safeRoadChoice(pid, anchor) {
    let eid = -1;
    try { eid = chooseSetupRoad(state, pid, anchor, rng); } catch (e) { warn(e); }
    const legal = legalRoads(state, pid, true, anchor);
    if (legal.indexOf(eid) < 0) eid = legal.length ? legal[0] : -1;
    return eid;
  }

  /** The one hard guarantee of this module: the draft always moves forward. */
  function forceAdvance() {
    try { setupAdvance(state); } catch (e) { warn(e); }
  }

  function placeForBot() {
    const pid = step.pid;
    const p = state.players[pid];
    const road = state.setupNeed === 'road';
    let ok = false;

    if (road) {
      const list = legalRoads(state, pid, true, state.setupAnchor);
      const order = step.target >= 0 ? [step.target, ...list] : list;
      for (const eid of order) { if (setupPlaceRoad(state, pid, eid)) { ok = true; break; } }
      if (ok) {
        ui.setDraft({
          index: state.setupIndex, pid,
          status: p ? p.name : '', sub: 'lays the first road', tip: ''
        });
        sfx('build', { gain: 0.6 });
        cam.shake(0.08);
      }
    } else {
      const list = legalSettlements(state, pid, true);
      const order = step.target >= 0 ? [step.target, ...list] : list;
      let placed = -1;
      for (const iid of order) {
        if (setupPlaceSettlement(state, pid, iid)) { ok = true; placed = iid; break; }
      }
      if (ok) {
        announce(`${p.name} claims ${placeName(placed)}`, p.color.css);
        sfx('build');
        cam.shake(0.14);
        flourish(placed, p);
      }
    }

    if (!ok) forceAdvance();
  }

  function flourish(iid, p) {
    const w = world();
    const n = intersections[iid];
    if (!n) return;
    try {
      if (w.effects && typeof w.effects.ring === 'function') w.effects.ring(n.x, n.z, p.color.hex);
    } catch (e) { /* fx are optional */ }
  }

  function openHumanTurn() {
    step.opened = true;
    const ov = g.overview;
    const road = state.setupNeed === 'road';
    const anchor = state.setupAnchor;

    const opts = road
      ? {
          setup: true, cancellable: false, anchor,
          title: 'Lay Your First Road',
          hint: 'Tap a glowing edge, then Confirm',
          onConfirm: eid => humanRoad(eid)
        }
      : {
          setup: true, cancellable: false,
          title: state.setupIndex >= state.players.length ? 'Your Second Corner' : 'Claim Your Corner',
          hint: 'High pips · three resources · a dock',
          onConfirm: iid => humanSettlement(iid)
        };

    let opened = false;
    if (ov && typeof ov.open === 'function') {
      try {
        opened = ov.open(road ? 'place-road' : 'place-settlement', opts) !== false;
      } catch (e) { warn(e); }
    }
    if (!opened) {
      // No map, or nothing legal to show — never strand the player mid-draft.
      autoPlaceForHuman();
    }
  }

  function humanSettlement(iid) {
    const ok = setupPlaceSettlement(state, 0, iid);
    if (!ok) return false;
    const p = state.players[0];
    announce(`You claim ${placeName(iid)}`, p.color.css);
    sfx('build');
    flourish(iid, p);
    return true;
  }

  function humanRoad(eid) {
    const ok = setupPlaceRoad(state, 0, eid);
    if (!ok) return false;
    sfx('build');
    return true;
  }

  function autoPlaceForHuman() {
    if (state.setupNeed === 'road') {
      const list = legalRoads(state, 0, true, state.setupAnchor);
      for (const eid of list) if (setupPlaceRoad(state, 0, eid)) return;
    } else {
      const list = legalSettlements(state, 0, true);
      for (const iid of list) if (setupPlaceSettlement(state, 0, iid)) return;
    }
    forceAdvance();
  }

  function runDraft(d) {
    if (state.phase !== 'setup') { enterHandoff(); return; }

    const key = stepKey();
    if (key !== step.key) beginStep();
    if (step.pid < 0) { forceAdvance(); return; }

    step.t += d;

    if (step.human) {
      // The player's turn waits. It does not time out into an auto-pick.
      if (!step.opened && step.t >= step.delay) openHumanTurn();
      if (step.opened) {
        step.idle += d;
        if (step.idle > T.idleNudge) {
          step.idle = 0;
          toast('Tap a glowing spot, then Confirm', 'warn');
        }
      }
      return;
    }

    if (step.t >= step.delay) placeForBot();
  }

  /* ------------------------------------------------------------- handoff */

  function enterHandoff() {
    stage = 'handoff';
    stageT = 0;
    closeOverview();
    ui.hideDraft();
    cam.overview(false);
    const me = state.players[0];
    if (me) cam.look(me.x, me.z, 3.4);
    ui.showObjective('Gather. Build. Win.', `First to ${VICTORY_POINTS} points`, 2.8);
  }

  function enterPlay(immediate) {
    stage = 'play';
    stageT = 0;
    cam.release();
    cam.overview(false);
    setInput(true);
    ui.hideDraft();
    if (immediate) ui.hideIntro();
  }

  /* ---------------------------------------------------------- pacing beats */

  function runPlay(d) {
    beatT += d;
    if (beatT < 0.4) return;
    beatT = 0;

    if (state.phase !== 'play') return;

    for (const p of state.players) {
      const vp = scoreOf(state, p);
      if (vp >= VICTORY_POINTS - 1 && !beats.matchPoint.has(p.id)) {
        beats.matchPoint.add(p.id);
        announce(`Match Point — ${p.name}`, p.color.css);
        toast(`${p.name} is one point from winning`, 'warn');
        sfx('horn', { gain: 0.7 });
        continue;
      }
      if (!beats.half && vp >= HALF_TARGET) {
        beats.half = true;
        announce(`${p.name} is halfway there`, p.color.css);
        toast(`${p.name} reached ${vp} of ${VICTORY_POINTS} points`, 'info');
      }
    }

    if (!beats.finalCall && state.time > MATCH_SOFT_CAP_SEC - FINAL_CALL) {
      beats.finalCall = true;
      announce('Final Minute', '#ffc93c');
      toast('When the clock runs out the leader takes the island', 'warn');
    }

    if (state.time >= MATCH_SOFT_CAP_SEC) endOnPoints();
  }

  /** Stalemate safety net — decide it on points rather than running forever. */
  function endOnPoints() {
    if (state.phase !== 'play') return;
    const lead = rankings(state)[0];
    const wid = lead ? lead.p.id : 0;
    win.byTime = true;
    state.phase = 'over';
    state.winner = wid;
    emit(state, 'victory', { player: wid });
    // main.js turns that event into showResults(), which lands in startWin().
    // If the panels are missing we still need the sequence, so kick it here.
    if (!realShowResults) startWin(wid);
  }

  /* ------------------------------------------------------------- victory */

  function winnerTiles(wid) {
    const p = state.players[wid];
    if (!p) return [];
    const seen = new Set();
    const out = [];
    const ids = [...p.settlements, ...p.cities];
    for (const iid of ids) {
      const n = intersections[iid];
      if (!n) continue;
      for (const tid of n.tiles) {
        if (seen.has(tid)) continue;
        seen.add(tid);
        out.push(tid);
      }
    }
    return out;
  }

  function startWin(wid) {
    if (win.active) return;
    win.active = true;
    win.done = false;
    win.t = 0;
    win.lit = 0;
    const ranked = rankings(state)[0];
    win.wid = (wid === undefined || wid === null || wid < 0)
      ? (ranked ? ranked.p.id : 0) : wid;
    win.tiles = winnerTiles(win.wid);
    stage = 'over';

    freezeMatch();

    const w = state.players[win.wid];
    if (w) {
      announce(win.byTime ? `Time — ${w.name} leads` : `${w.name} takes the island`, w.color.css);
      toast(win.byTime
        ? `Match called on points · ${scoreOf(state, w)} VP`
        : `${w.name} reached ${scoreOf(state, w)} points`, 'good');
    }
    cam.shake(0.6);
    sfx('horn');
  }

  /** Nothing may mutate the match after this point. */
  function freezeMatch() {
    state.phase = 'over';
    state.flowActive = true;
    setInput(false);
    closeOverview();
    ui.hideDraft();
    ui.hideIntro();
    ui.hideObjective();
    for (const p of state.players) {
      p.gatherNode = null;
      p.gatherIntent = null;
      p.gatherProgress = 0;
      p.freeRoads = 0;
      p.vx = 0; p.vz = 0;
      if (p.action === 'gather' || p.action === 'run') p.action = 'idle';
    }
    cam.setActive(true);
  }

  function runWin(d) {
    if (win.done) {
      // Belt and braces: the match is over and stays over.
      if (state.phase !== 'over') state.phase = 'over';
      return;
    }
    win.t += d;
    if (state.phase !== 'over') state.phase = 'over';

    if (win.t >= WIN.overview) cam.overview(true);

    if (win.t >= WIN.firstTile && win.lit < win.tiles.length) {
      const want = Math.min(
        win.tiles.length,
        Math.floor((win.t - WIN.firstTile) / WIN.tileStep) + 1
      );
      const w = state.players[win.wid];
      const island = world().island;
      while (win.lit < want) {
        const tid = win.tiles[win.lit++];
        if (island && typeof island.highlightTile === 'function') {
          try { island.highlightTile(tid, w ? w.color.hex : 0xffe07a, 0.40); } catch (e) { warn(e); }
        }
        cam.shake(0.05);
      }
    }

    if (win.t >= WIN.reveal) {
      win.done = true;
      const w = state.players[win.wid];
      if (realCelebrate) realCelebrate(w);
      if (realShowResults) realShowResults(win.wid);
      setInput(false);
    }
  }

  /* --------------------------------------------------------------- update */

  function update(dt) {
    if (!started) begin();
    const d = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.1) : 1 / 60;
    elapsed += d;
    stageT += d;

    if (inputLocked) holdStick();
    cam.update(d);
    ui.update(d);

    if (win.active) { runWin(d); return; }

    // Something ended the match without going through the panels (no UI, or a
    // rules-side victory with panels missing) — still run the sequence.
    if (state.phase === 'over' && stage !== 'over') { startWin(state.winner); return; }

    // The draft completed without this state machine driving it — a test
    // harness, a restored match, or the bots' own fallback watchdog. Tear the
    // opening chrome down instead of leaving the intro card floating over live
    // gameplay, and hand control to the player.
    if (state.phase === 'play' && stage !== 'play' && stage !== 'handoff') {
      ui.hideIntro();
      enterPlay(true);
      return;
    }

    switch (stage) {
      case 'boot':
        if (stageT >= T.boot) {
          stage = 'title'; stageT = 0;
          ui.showIntro();
          sfx('award', { gain: 0.5 });
        }
        break;

      case 'title':
        if (stageT >= T.title) {
          ui.hideIntro();
          stage = 'draftIntro'; stageT = 0;
          openDraftFraming();
        }
        break;

      case 'draftIntro':
        if (stageT >= T.draftIntro) { stage = 'draft'; stageT = 0; step.key = ''; }
        break;

      case 'draft':
        runDraft(d);
        break;

      case 'handoff':
        if (stageT >= T.handoff) enterPlay(false);
        break;

      case 'play':
        runPlay(d);
        break;

      default:
        break;
    }
  }

  /* -------------------------------------------------------------- restart */

  /**
   * Rebuild the match without a page reload — see flowRestart.js for why every
   * field is cleared in place rather than swapped for a fresh createMatch().
   * If anything required is missing we cannot promise a clean board, so we hand
   * back to the reload path main.js already provides and return false.
   */
  function restartInPlace(opts = {}) {
    if (!resetMatchInPlace(state, g, opts)) return reload();

    // Rewind the flow itself, skipping the title card — a replay wants the
    // draft, not the credits.
    win.active = false; win.done = false; win.t = 0; win.wid = -1;
    win.byTime = false; win.tiles = []; win.lit = 0;
    beats.half = false; beats.finalCall = false; beats.matchPoint.clear();
    step.key = ''; step.pid = -1; step.human = false; step.opened = false;
    started = true;
    elapsed = 0;
    stage = 'draftIntro';
    stageT = 0;
    setInput(false);
    cam.setActive(true);
    openDraftFraming();
    return true;
  }

  function reload() {
    warn(new Error('in-place restart unavailable — reloading'));
    if (typeof g.restart === 'function') { g.restart(); return false; }
    if (typeof location !== 'undefined' && location.reload) location.reload();
    return false;
  }

  /* ------------------------------------------------------------------ api */

  return {
    update, begin, skipIntro, restartInPlace,
    get stage() { return stage; },
    get elapsed() { return elapsed; },
    get isWinSequence() { return win.active; },
    get winner() { return win.wid; },
    destroy() { cam.release(); ui.destroy(); }
  };
}

export default createMatchFlow;
