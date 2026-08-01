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
 *   2. the snake draft, delegated to flowDraft.js — the draft holds one stable
 *      board view from its first beat to its last, and this module performs the
 *      single transition out of it;
 *   3. the handoff into third-person play, plus the pacing beats that keep a
 *      real-time match legible (halfway, match point, final minute);
 *   4. the stalemate safety net at MATCH_SOFT_CAP_SEC;
 *   5. the victory sequence — freeze, announce and celebrate over the live
 *      board, pull out to the whole island, light up the winner's network, and
 *      only then release the results panel. See `WIN` for the timeline: the
 *      player is never taken off the board to be shown a score.
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

import { VICTORY_POINTS, MATCH_SOFT_CAP_SEC } from '../core/constants.js';

import { intersections, BOUNDS } from '../board/layout.js';

import { mulberry32 } from '../board/nodes.js';

import { scoreOf, rankings, emit } from '../core/rules.js';

import { createFlowUI } from './flowUI.js';
import { createFlowCamera } from './flowCamera.js';
import { createDraft } from './flowDraft.js';
import { resetMatchInPlace } from './flowRestart.js';
import { createTutorial } from './tutorial.js';

/* ------------------------------------------------------------------ timing */

const T = {
  boot: 0.40,          // let the boot splash clear before the title lands
  // The opening screen is a MENU, not a cinematic: it carries the difficulty
  // picker, so it waits for BEGIN THE DRAFT rather than timing out from under
  // the player. This is only a safety net for an abandoned tab.
  title: 90.0,
  draftIntro: 1.90,    // board is up, the order is on it — let it be read
  handoff: 2.30
};

/*
 * The last ten seconds, and why they are spaced like this.
 *
 * The old sequence gave the finished island 2.2 seconds and then covered it
 * with a scoreboard. You never got to look at the thing you had just spent a
 * match building. Now the announcement and the celebration play over the LIVE
 * board — close third-person first, so the win reads on the settler — and the
 * camera only pulls out to the whole island afterwards, where it sits for
 * several seconds while the winner's network lights up hex by hex. The
 * scoreboard is last, and it is dismissible (panels.js), so the player can go
 * back to either view for as long as they like.
 */
const WIN = {
  celebrate: 0.30,     // orbit the winner's holdings, still close in
  endOrbit: 2.45,      // hand the camera back so the pull-out can be seen
  overview: 2.55,      // pull to the board framing
  firstTile: 2.95,     // begin lighting the winner's network
  tileStep: 0.12,
  reveal: 6.00         // results panel — a long look at the island first
};

const HALF_TARGET = Math.ceil(VICTORY_POINTS / 2);
const FINAL_CALL = 60;                 // seconds of soft cap left for the warning

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

  const win = {
    active: false, done: false, t: 0, wid: -1,
    byTime: false, tiles: [], lit: 0,
    celebrated: false, orbitEnded: false, board: true
  };

  const beats = { half: false, matchPoint: new Set(), finalCall: false };
  let beatT = 0;

  // The guided practice run switches the pacing beats and the stalemate cap
  // off: a tutorial must never have a clock running out under it.
  let practice = false;

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

  /* ------------------------------------------------------------------ draft */

  // flowDraft.js owns the snake draft end to end, including the promise that
  // the board view never changes while it is running.
  // `onDone` fires on the same tick as the last road — including when the
  // player's own Confirm places it — so the one view change of the draft is
  // synchronous with the placement that earned it.
  const draft = createDraft(state, g, {
    ui, cam, rng, announce, toast, sfx, warn, world,
    onDone: () => enterHandoff()
  });

  /* --------------------------------------------------------------- tutorial */

  // Owns the TUTORIAL button on the opening screen (it listens for that
  // button's event itself) and the guided practice run.
  const tutorial = createTutorial(state, g, {
    ui, setPractice: on => { practice = !!on; }
  });
  g.tutorial = tutorial;

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
      draft.begin();
    } else if (stage === 'draftIntro') {
      stageT = T.draftIntro;
    }
  }


  /* ------------------------------------------------------------- handoff */

  /**
   * The one view change of the whole draft. The cinematic focus is snapped to
   * the player first — invisible, because the board framing is still fully
   * blended in — so releasing the overview eases straight into third person
   * over the camera's own 0.55s blend instead of sliding across the island.
   */
  function enterHandoff() {
    if (stage === 'handoff') return;
    stage = 'handoff';
    stageT = 0;
    draft.reset();
    ui.hideDraft();
    const me = state.players[0];
    if (me) cam.snap(me.x, me.z);
    closeOverview();
    cam.overview(false);
    ui.showObjective('Gather. Build. Win.', `First to ${VICTORY_POINTS} points`, 2.8);
  }

  function enterPlay(immediate) {
    stage = 'play';
    stageT = 0;
    draft.reset();
    cam.release();
    // Terminal state for the opening: whatever route got us here, the board
    // map does not survive into third-person play.
    closeOverview();
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

    if (state.phase !== 'play' || practice) return;

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
    win.celebrated = false;
    win.orbitEnded = false;
    win.board = true;
    stage = 'over';

    freezeMatch();

    const w = state.players[win.wid];
    if (w) {
      announce(win.byTime ? `Time — ${w.name} leads` : `${w.name} takes the island`, w.color.css);
      toast(win.byTime
        ? `Match called on points · ${scoreOf(state, w)} VP`
        : `${w.name} reached ${scoreOf(state, w)} points`, 'good');
    }
    // The end-game moment, played over the board rather than across it: a
    // win/lose plate and a shower of paper that take no pointer events and
    // leave the middle of the screen — and the island — completely clear.
    const panels = g.panels;
    if (panels && typeof panels.endBanner === 'function') {
      try { panels.endBanner(win.wid); } catch (e) { warn(e); }
    }
    cam.shake(0.6);
    sfx('horn');
  }

  /**
   * Which framing the player is looking at once the scoreboard has been put
   * away. hud-end.js drives this from its BOARD VIEW / CLOSE VIEW button; the
   * cinematic camera has already been released by then, so the close framing is
   * the ordinary third-person one, following the settler.
   */
  function setEndView(mode) {
    if (!win.active) return false;
    win.board = mode !== 'close';
    cam.overview(win.board);
    return win.board;
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

    // 1. celebrate where the match was won — close in, on the winner's holdings
    if (!win.celebrated && win.t >= WIN.celebrate) {
      win.celebrated = true;
      const w = state.players[win.wid];
      if (realCelebrate) realCelebrate(w);
    }

    // 2. release the orbit, then pull out. The orbit is applied after the
    //    overview blend inside camera.js, so it has to stop first or the
    //    board framing never appears.
    if (!win.orbitEnded && win.t >= WIN.endOrbit) {
      win.orbitEnded = true;
      cam.endCelebrate();
    }

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
      // Hand the camera back before the scoreboard lands. From here the player
      // owns the view: BOARD VIEW / CLOSE VIEW on the end-of-match bar toggles
      // the overview blend, and the close framing follows the settler through
      // playerController's own follow() calls, exactly as in play.
      cam.release();
      cam.overview(win.board);
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
    //
    // The `draft.holding` exemption is the draft's own landing beat: the last
    // road has just gone down and flipped the phase, and the draft still owes
    // the player half a second of looking at it before the view changes once.
    if (state.phase === 'play' && stage !== 'play' && stage !== 'handoff'
        && !(stage === 'draft' && draft.holding)) {
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
        if (stageT >= T.draftIntro) { stage = 'draft'; stageT = 0; }
        break;

      case 'draft':
        if (draft.update(d)) enterHandoff();
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
    // `keepBoard` stops flowRestart tearing the map down half a millisecond
    // before draft.begin() puts it straight back up.
    if (!resetMatchInPlace(state, g, { ...opts, keepBoard: true })) return reload();

    // Rewind the flow itself, skipping the title card — a replay wants the
    // draft, not the credits.
    win.active = false; win.done = false; win.t = 0; win.wid = -1;
    win.byTime = false; win.tiles = []; win.lit = 0;
    win.celebrated = false; win.orbitEnded = false; win.board = true;
    beats.half = false; beats.finalCall = false; beats.matchPoint.clear();
    draft.reset();
    started = true;
    elapsed = 0;
    stage = 'draftIntro';
    stageT = 0;
    // A replay skips the title card. If it happens to still be up — a restart
    // fired during the opening — it goes now, rather than floating over the
    // new draft board.
    ui.hideIntro();
    ui.hideObjective();
    setInput(false);
    cam.setActive(true);
    draft.begin();
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
    update, begin, skipIntro, restartInPlace, setEndView,
    get endView() { return win.board ? 'board' : 'close'; },
    get stage() { return stage; },
    get elapsed() { return elapsed; },
    get isWinSequence() { return win.active; },
    /**
     * Seconds into the victory sequence — the clock `WIN` is spaced against.
     * Exposed so the capture rig can assert the beats in *game* time: a
     * software renderer feeds this loop far fewer fixed steps than a phone
     * does, so wall-clock timings out of headless mean nothing.
     */
    get winT() { return win.active ? win.t : -1; },
    get winner() { return win.wid; },
    get tutorial() { return tutorial; },
    destroy() { cam.release(); ui.destroy(); tutorial.destroy(); }
  };
}

export default createMatchFlow;
