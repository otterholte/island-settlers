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
 *   3. the handoff into third-person play — including the 3 · 2 · 1 · GO start
 *      line (flowCountdown.js), which freezes the bots as well as the player so
 *      nobody gets a head start off the last road of the draft;
 *   4. the pacing beats that keep a real-time match legible (halfway, match
 *      point, final minute) and the stalemate safety net at MATCH_SOFT_CAP_SEC;
 *   5. the victory sequence — freeze, pull out to the whole island, flood every
 *      hex with the winner's colour, and only then celebrate and release the
 *      results panel. See `WIN` for the timeline: the player is never taken off
 *      the board to be shown a score.
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
import { createCountdown } from './flowCountdown.js';
import { resetMatchInPlace } from './flowRestart.js';
import { createTutorial } from './tutorial.js';

/* ------------------------------------------------------------------ timing */

const T = {
  boot: 0.40,          // let the boot splash clear before the title lands
  /*
   * THE OPENING SCREEN NEVER TIMES OUT. NOT AFTER NINETY SECONDS, NOT EVER.
   *
   *   "It's starting games without me explicitly saying to. Like while I'm
   *    waiting on the screen to choose the settings I want for the game, or
   *    waiting for friends to join, it just starts the game for me. That should
   *    never happen."
   *
   * It was 90 seconds, described as "a safety net for an abandoned tab", and it
   * was nothing of the sort: reading the setup panel, picking a difficulty,
   * typing a room code, waiting for a third friend to press JOIN — all of those
   * are longer than ninety seconds, and all of them ended with the draft
   * starting underneath the player. An abandoned tab needs no safety net; it is
   * a tab sitting on a menu, which is what menus are for.
   *
   * `Infinity` rather than a bigger number, because a bigger number is the same
   * bug with a longer fuse. The only ways out of the opening screen are now the
   * ones the player presses.
   */
  title: Infinity,
  draftIntro: 1.90,    // board is up, the order is on it — let it be read
  // The camera blend out of the board framing runs under the start countdown,
  // so this is only the fallback for a build with no countdown view at all.
  handoff: 2.30,
  handoffCap: 9.0      // hard safety net: never strand the player at the line
};

/*
 * THE LAST SEVEN SECONDS
 *
 *   "I don't understand why random tiles light up at the end when someone wins,
 *    it seems to be random tiles. Could you actually animate that all of the
 *    hexes/tiles turn into the color of the winner, and then the celebration
 *    happens right after that."
 *
 * They were not random — they were the winner's own five or six hexes, lit one
 * every 0.12s, which from a whole-island framing is indistinguishable from
 * flickering. It is gone. In its place is the victory flood from
 * `world/mood.js`: one continuous wavefront that starts on the winner's land
 * and sweeps the ENTIRE island into their colour — terrain, trees, flock,
 * boulders, all on the same per-hex texture, so nineteen hexes turn as one
 * object rather than as a sequence of nineteen events.
 *
 * The order is now exactly the order the player asked for:
 *
 *   0.00  freeze. The winner is named, the horn goes, the board is live.
 *   0.25  pull straight out to the whole island — the flood needs to be seen
 *         across the board, not over the settler's shoulder.
 *   0.75  the flood starts and crosses the island (`floodDur`), then holds
 *         (`floodHold`). Nothing else happens while it runs.
 *   3.10  THE CELEBRATION, once every hex is their colour: the win/lose plate
 *         and the shower of paper (panels.endBanner) and the camera's orbit of
 *         the winner's holdings, together.
 *   6.55  the orbit stops and the board framing comes back.
 *   8.60  the last of the paper clears and the plate is pulled (hud-end.js).
 *   8.85  the results panel — dismissible, so the flooded island is still
 *         there to go back to. The camera is released here and stays released:
 *         free navigation after the match belongs to camera.js/overview.js.
 *
 * The last 2.3 seconds of that are the whole island sitting in the winner's
 * colour with nothing moving on it — the part that was asked for, and the part
 * that used to be over in eight tenths of a second. See the note on WIN below.
 */
/*
 * AND THEN IT WANTED LONGER.
 *
 *   "Can you show the full board the colour of my character when I win a little
 *    longer, maybe like 2 extra seconds, before I see the scores. Then let the
 *    confetti flow an additional like 3 seconds as well."
 *
 * Both are honoured exactly, and they are two different measurements:
 *
 *   THE ORBIT is the gap between the celebration firing and the orbit stopping
 *   — the rotating shot around the winner's holdings. 1.95s, now 3.45s.
 *
 *   THE BOARD is the gap between the orbit stopping (which is what puts the
 *   whole flooded island back in frame) and the scoreboard landing on top of
 *   it. 0.80s — long enough to register, nowhere near long enough to look at —
 *   now 2.30s. "Specifically I like seeing both the rotating view, and the full
 *   map view, maybe 1.5 seconds longer each": `endOrbit` 5.05 -> 6.55 and
 *   `reveal` 5.85 -> 8.85 is exactly +1.5 to each of them.
 *
 *   THE PAPER is the gap between the celebration firing and hud-end.js pulling
 *   the plate. That was 2.50s; it is 5.50s now (the stagger range and the hide
 *   timer in `hud-end.js` both moved, and the piece count went up with them so
 *   the shower keeps its density over the longer window rather than thinning
 *   into a drizzle).
 *
 * The sequence therefore runs to 8.85s rather than 5.85s. That is a long time
 * to hold a player who has just watched their own match end, which is why the
 * whole of it is skippable: the results panel is dismissible, the board stays
 * behind it, and nothing here blocks input.
 */
const WIN = {
  overview: 0.25,
  flood: 0.75,
  floodDur: 1.90,      // seconds for the wave to cross the island
  floodHold: 0.45,     // fully flooded, held, before anything else moves
  celebrate: 3.10,     // = flood + floodDur + floodHold
  endOrbit: 6.55,
  reveal: 8.85
};

/**
 * "You take the island" — but "Alex takes the island".
 *
 *   "When you win the game it says 'YOU TAKES THE ISLAND', can you change the
 *    verbiage so that it works for single player if I won, since that's not
 *    grammatically correct."
 *
 * The line was built by dropping a name into a third-person sentence, and the
 * one seat whose name is not a name got the sentence written about it anyway.
 * The only second-person subject in the game is the default seat-0 label, so
 * that is the only thing this has to test — a player who has typed a name gets
 * a third-person sentence, because by then they have a name in the seat and
 * `Eli takes the island` is right. See `playerName()` in core/options.js.
 */
const verb = (p, stem) => (p && p.name === 'You' ? stem : `${stem}s`);

/*
 * THE CARD THAT WON IT, HELD FOR A BEAT.
 *
 *   "Sometimes I win the game with a victory point, but I need to actually see
 *    that I won a victory point in an easier way, instead of it just going
 *    straight into the victory / game ending animation. Give it like 1-2
 *    seconds, so I know what happened."
 *
 * A Victory Point card scores the instant it is drawn, so the tap that buys it
 * and the horn that ends the match are the same moment: the player pressed BUY
 * and the island started celebrating, with nothing in between to say a card had
 * been drawn at all, let alone which one. Every other route to the last point —
 * a settlement, a city, an award changing hands — is something the player did on
 * the board and watched happen.
 *
 * So when the last point comes off a card, the whole victory sequence is pushed
 * back by this much and the card is named in the gap. The match is already
 * frozen by then (freezeMatch runs first, as it always did); this only delays
 * the celebration, so nothing can happen in the beat except reading it.
 */
const WIN_CARD_BEAT = 1.6;

/*
 * AND THEN THE COLOUR HAS TO GO
 *
 *   "Also remove the color of all the tiles after I view the scoreboard, so
 *    that I can tell what the hexes' resources were."
 *
 * The flood is the celebration and it stays for the celebration. But the moment
 * the player has seen the score and gone back to the island to look at it, the
 * winner's colour is no longer a trophy — it is nineteen identical hexes with no
 * readable terrain on any of them, which is the one thing a review view exists
 * to show.
 *
 * So the review state clears it. `hud-end.js` raises the review bar the instant
 * the results are dismissed and tells this module; the wave then RECEDES the way
 * it came — `floodWinner(colour, progress)` driven from 1 back to 0 over
 * `FLOOD_FADE_SEC` — and `stopVictoryFlood()` lands it exactly on the ordinary
 * terrain. It is not a snap, and it is not undone by toggling BOARD / CLOSE
 * VIEW or by bringing the scoreboard back: once cleared, it stays cleared for
 * the rest of the review.
 */
const FLOOD_FADE_SEC = 1.60;
/** A beat first, so the island is not already changing as the panel slides out. */
const FLOOD_FADE_DELAY = 0.35;

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
    active: false, done: false, t: 0, celT: 0, wid: -1,
    byTime: false, tiles: [],
    flooded: false, hasFlood: false,
    celebrated: false, orbitEnded: false, board: true,
    // Seconds of held beat before the sequence opens — see WIN_CARD_BEAT.
    lead: 0, opened: false
  };

  // The receding flood. `done` latches so a second dismissal of the scoreboard
  // does not re-run a fade that has already finished.
  const fade = { active: false, done: false, t: 0, from: 1 };

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
  let roaming = false;

  function setInput(on) {
    inputLocked = !on;
    // Any lock at all ends a roam. Every route out of the review — a replay,
    // the results going back up, a restart in place — goes through here, so
    // none of them can leave the settler holding a stick it no longer owns.
    if (!on && roaming) markRoam(false);
    const inp = g.input;
    if (!inp) return;
    if (typeof inp.setEnabled === 'function') { try { inp.setEnabled(on); } catch (e) { warn(e); } }
    if (!on) holdStick();
  }

  /** The flag alone — no input side effects, so `setInput` can call it. */
  function markRoam(on) {
    roaming = !!on;
    if (typeof g.setRoam === 'function') { try { g.setRoam(roaming); } catch (e) { warn(e); } }
  }

  /**
   * Hand the settler back for the walk-around, or take it away again.
   *
   *   "When I'm reviewing the board after the game has ended, instead of having
   *    me use my finger to swipe up and down left and right, just let me use
   *    the normal invisible joystick and run around with my character."
   *
   * The match stays frozen — `freezeMatch` has already stopped the clock, the
   * bots, the gathering and every rules call, and none of that is undone here.
   * All this does is re-enable the stick and tell playerController that the
   * usual `phase === 'over'` lock does not apply, which turns the review from a
   * camera on rails into the island you just won, on foot. hud-end.js drives
   * it off the review bar's view toggle.
   */
  function setRoam(on) {
    const want = !!on && win.active && win.done;
    if (want === roaming) return roaming;
    // The flag first, so `setInput`'s own "a lock ends a roam" line is already
    // a no-op by the time it runs — one owner for the flag, no recursion.
    markRoam(want);
    setInput(want);
    return roaming;
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
  const localDraft = createDraft(state, g, {
    ui, cam, rng, announce, toast, sfx, warn, world,
    onDone: () => enterHandoff()
  });

  /**
   * An online match brings its OWN draft.
   *
   * The stage machine below asks the draft two questions — are you holding the
   * board, and are you finished — and neither answer changes when a server is
   * choosing the order. What does change is everything underneath: there are
   * no bots here to pick for, the pick clock belongs to the server, and a
   * human's turn arrives as a message rather than as a cursor this module
   * moved. `src/net/netmatch.js` supplies an object with the same two answers
   * and swaps it in through `useDraft`.
   */
  let draft = localDraft;
  function useDraft(next) {
    draft = next || localDraft;
    return draft;
  }

  /* -------------------------------------------------------------- start line */

  // 3 · 2 · 1 · GO. Owns the freeze on both sides of the line: it zeroes the
  // bots by borrowing `game.bots.update` (see flowCountdown.js for why that is
  // the only interception main.js's frame order allows) while this module holds
  // the human's stick down.
  const count = createCountdown(state, g, { root, warn, sfx });

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
    // The last road of the draft flips `state.phase` to 'play', and bots.js
    // starts driving on that flag alone — which is exactly the head start the
    // player could feel. Arm the start line on the same tick, before anybody
    // has been given a frame to move in.
    setInput(false);
    count.begin();
  }

  function enterPlay(immediate) {
    stage = 'play';
    stageT = 0;
    draft.reset();
    count.cancel();
    cam.release();
    // Terminal state for the opening: whatever route got us here, the board
    // map does not survive into third-person play.
    closeOverview();
    cam.overview(false);
    setInput(true);
    ui.hideDraft();
    if (immediate) ui.hideIntro();
    // The objective card lands ON GO, not under the countdown — it used to sit
    // in the middle of the screen exactly where the numerals are. `immediate`
    // is the harness/restored-match route, which never had one.
    if (!immediate) ui.showObjective('Gather. Build. Win.', `First to ${VICTORY_POINTS} points`, 2.6);
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

    // ONLINE THE CLOCK IS NOT OURS TO CALL. Four machines counting to 420
    // independently will not agree on which frame crosses it, and the one that
    // gets there first would declare a winner the others have not seen. The
    // server runs the same cap and sends the result.
    if (state.time >= MATCH_SOFT_CAP_SEC && !netOwned()) endOnPoints();
  }

  /** True while a networked match owns the rules; see systems/economy.js. */
  function netOwned() {
    return !!(g.net && g.net.active);
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
    const ranked = rankings(state)[0];
    win.wid = (wid === undefined || wid === null || wid < 0)
      ? (ranked ? ranked.p.id : 0) : wid;
    win.tiles = winnerTiles(win.wid);
    win.flooded = false;
    win.hasFlood = false;
    win.celebrated = false;
    win.celT = 0;
    win.orbitEnded = false;
    win.board = true;
    stage = 'over';

    freezeMatch();

    /* Did the last point come out of a card, in this player's hand, just now?
     *
     * Two ways of knowing, and BOTH are needed because of a race the rig found:
     * `noteCard` is fed from main.js's event pump, which drains AFTER the fixed
     * step — so on the frame a card wins the match, this module's own watchdog
     * (`state.phase === 'over' && stage !== 'over'`) reaches `startWin` first
     * and the pump has not run yet. The card is sitting in `state.events`,
     * emitted and undelivered.
     *
     * So look there too. Reading the queue is not draining it: main.js still
     * gets every event, in order, a moment later. */
    const noted = lastCard.pid === 0 && lastCard.type === 'victoryPoint'
      && (elapsed - lastCard.at) <= 1.0;
    // `instant` is only ever true for a Victory Point card — it is the one that
    // scores as it is drawn rather than going into the hand.
    const queued = Array.isArray(state.events) && state.events.some(e =>
      e && e.type === 'cardDrawn' && e.player === 0 && e.instant === true);
    const byCard = win.wid === 0 && (noted || queued);
    win.lead = byCard ? WIN_CARD_BEAT : 0;
    win.t = -win.lead;
    win.opened = false;
    if (byCard) {
      // After freezeMatch, which clears the objective card this borrows.
      ui.showObjective('Victory Point Card', 'The point that wins the island',
        WIN_CARD_BEAT);
    } else {
      openWin();
    }
  }

  /** The horn and the words. Held back for the beat when a card won it. */
  function openWin() {
    if (win.opened) return;
    win.opened = true;
    const w = state.players[win.wid];
    if (w) {
      announce(win.byTime
        ? `Time — ${w.name} ${verb(w, 'lead')}` : `${w.name} ${verb(w, 'take')} the island`,
        w.color.css);
      toast(win.byTime
        ? `Match called on points · ${scoreOf(state, w)} VP`
        : `${w.name} reached ${scoreOf(state, w)} points`, 'good');
    }
    cam.shake(0.6);
    sfx('horn');
  }

  /* ------------------------------------------------------------- the flood */

  /** `game.world.props` — may be a stub in a degraded build. Always optional. */
  function floodApi() {
    const p = world().props;
    return p && typeof p.startVictoryFlood === 'function' ? p : null;
  }

  /**
   * Every hex sweeps to the winner's colour, seeded on the land they hold.
   * mood.js advances it inside `props.update(dt)`, which main.js already calls
   * every frame, so this is one call and then a wait.
   */
  function startFlood() {
    const p = floodApi();
    const w = state.players[win.wid];
    if (!p) return 0;
    try {
      return p.startVictoryFlood(win.wid, {
        color: w ? w.color.hex : undefined,
        from: win.tiles,
        duration: WIN.floodDur,
        hold: WIN.floodHold
      }) || 0;
    } catch (e) { warn(e); return 0; }
  }

  /** 0..1 — how far the wave has travelled. -1 when there is no flood at all. */
  function floodAt() {
    const p = floodApi();
    if (!p || typeof p.floodProgress !== 'function') return -1;
    try { return p.floodProgress(); } catch (e) { return -1; }
  }

  function stopFlood() {
    const p = floodApi();
    if (!p || typeof p.stopVictoryFlood !== 'function') return;
    try { p.stopVictoryFlood(); } catch (e) { warn(e); }
  }

  function floodLive() {
    const p = floodApi();
    if (!p || typeof p.victoryFloodActive !== 'function') return false;
    try { return !!p.victoryFloodActive(); } catch (e) { return false; }
  }

  /* --------------------------------------------------- clearing the colour */

  /**
   * The score has been seen; hand the terrain back.
   *
   * Called by hud-end.js the moment the review bar goes up — which is the one
   * state where the player is looking at the island rather than at a panel.
   * Safe to call repeatedly and safe to call with no flood running at all.
   */
  function clearVictoryFlood(opts) {
    if (fade.active || fade.done) return fade.done;
    if (!floodLive()) {
      // Nothing to clear (a degraded build, or the flood never started). Mark it
      // done so we never come back and so `floodCleared` reads true.
      fade.done = true;
      return true;
    }
    const at = floodAt();
    fade.active = true;
    fade.t = 0;
    fade.from = at > 0 ? Math.min(1, at) : 1;
    if (opts && opts.immediate) { fade.t = FLOOD_FADE_DELAY + FLOOD_FADE_SEC; runFade(0); }
    return false;
  }

  /** Drive the recede. Runs off the flow's own clock, every frame, after done. */
  function runFade(d) {
    if (!fade.active) return;
    const p = floodApi();
    if (!p || typeof p.floodWinner !== 'function') {
      fade.active = false; fade.done = true; stopFlood();
      return;
    }
    fade.t += d;
    const k = (fade.t - FLOOD_FADE_DELAY) / FLOOD_FADE_SEC;
    if (k <= 0) return;                       // the held beat before it moves
    const e = k >= 1 ? 1 : 1 - Math.pow(1 - k, 3);   // ease out, no snap
    const w = state.players[win.wid];
    try {
      p.floodWinner(w ? w.color.hex : 0xffc93c, fade.from * (1 - e));
    } catch (err) { warn(err); }
    if (k >= 1) {
      fade.active = false;
      fade.done = true;
      // Land it exactly on the ordinary terrain rather than on 0.0001 of tint.
      stopFlood();
    }
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

  const hideObjectiveSafe = () => {
    try { ui.hideObjective(); } catch (e) { warn(e); }
  };

  /** The rules' own card draws, so `startWin` can tell what scored the last
   *  point. main.js feeds this from the `cardDrawn` event. */
  let lastCard = { pid: -1, type: '', at: -99 };
  function noteCard(pid, type) {
    lastCard = { pid: pid | 0, type: String(type || ''), at: elapsed };
  }

  /** Nothing may mutate the match after this point. */
  function freezeMatch() {
    state.phase = 'over';
    state.flowActive = true;
    // A match that ends during the start line (a restart, or a rules-side
    // victory) must not leave the bots' update borrowed.
    count.cancel();
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
      // The review state is the only thing still moving after the scoreboard:
      // the winner's colour draining back off the island.
      runFade(d);
      return;
    }
    win.t += d;
    if (state.phase !== 'over') state.phase = 'over';

    // The card beat, if there was one: nothing in the sequence starts until it
    // is over, and it ends with the horn the sequence would have opened on.
    if (win.t < 0) return;
    if (!win.opened) { hideObjectiveSafe(); openWin(); }

    // 1. the whole island, framed. The flood has to be watched across the
    //    board, so this happens before anything else moves.
    if (win.t >= WIN.overview && !win.celebrated) cam.overview(true);

    // 2. the flood: one wavefront out of the winner's land, every hex turning
    //    to their colour. mood.js runs the clock from props.update(dt).
    if (!win.flooded && win.t >= WIN.flood) {
      win.flooded = true;
      win.hasFlood = startFlood() > 0;
    }

    // 3. the celebration — and not one frame before the island is entirely
    //    their colour. The plate, the paper and the orbit land together.
    //
    //    `WIN.celebrate` is already flood + floodDur + floodHold, so the wave
    //    is due to be finished by then and the usual answer is simply "yes".
    //    The reading only matters when it disagrees: a wave still crossing
    //    (0 < p < 1) buys up to 1.2s of grace. A wave sitting at exactly 0 is
    //    a caller who never drove `props.update` — a harness stepping the flow
    //    on its own — and waiting on a clock nobody is winding would strand
    //    the whole end of the match.
    const fp = win.hasFlood ? floodAt() : -1;
    const floodDone = !(fp > 0 && fp < 0.999) || win.t >= WIN.celebrate + 1.2;
    if (!win.celebrated && win.t >= WIN.celebrate && floodDone) {
      win.celebrated = true;
      win.celT = win.t;
      const panels = g.panels;
      if (panels && typeof panels.endBanner === 'function') {
        try { panels.endBanner(win.wid); } catch (e) { warn(e); }
      }
      const w = state.players[win.wid];
      if (realCelebrate) realCelebrate(w);
      cam.shake(0.4);
      sfx('horn', { gain: 0.9 });
    }

    // 4. release the orbit and go back to the whole island. The orbit is
    //    applied after the overview blend inside camera.js, so it has to stop
    //    first or the board framing never comes back. Everything from here is
    //    measured off the celebration, not off the freeze, so a slow flood
    //    stretches the sequence instead of eating the end of it.
    if (win.celebrated && !win.orbitEnded
        && win.t >= win.celT + (WIN.endOrbit - WIN.celebrate)) {
      win.orbitEnded = true;
      cam.endCelebrate();
      cam.overview(true);
    }

    if (win.celebrated && win.t >= win.celT + (WIN.reveal - WIN.celebrate)) {
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
    // The `draft.holding` exemption is the draft asking for time: the last
    // road has just gone down and flipped the phase, and the draft still owes
    // the player something before the view changes. That used to be half a
    // second of watching the piece land — and it was scoped to `stage ===
    // 'draft'`, which was true for the landing beat and false for the other
    // case that now exists. With the opening picked for you the whole draft
    // resolves inside `draft.begin()`, which runs during `draftIntro`, so the
    // phase flips a stage early and the board the player was handed to look at
    // was torn down under them on the next tick. A draft that says it is
    // holding is holding, whatever the machine is calling this moment.
    if (state.phase === 'play' && stage !== 'play' && stage !== 'handoff'
        && !draft.holding) {
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
        // Deliberately nothing. See T.title: the opening screen waits for a
        // press, however long that takes.
        break;

      case 'draftIntro':
        if (stageT >= T.draftIntro) { stage = 'draft'; stageT = 0; }
        break;

      case 'draft':
        if (draft.update(d)) enterHandoff();
        break;

      case 'handoff':
        // The countdown is the gate. Without one (a headless build, or a UI
        // that failed to construct) the old fixed beat still gets the player
        // onto the island, and `handoffCap` catches anything stranger.
        if (count.active) {
          if (count.update(d)) enterPlay(false);
          else if (stageT >= T.handoffCap) { count.cancel(); enterPlay(false); }
        } else if (stageT >= T.handoff) {
          enterPlay(false);
        }
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
    win.active = false; win.done = false; win.t = 0; win.celT = 0; win.wid = -1;
    win.byTime = false; win.tiles = [];
    win.flooded = false; win.hasFlood = false;
    win.celebrated = false; win.orbitEnded = false; win.board = true;
    beats.half = false; beats.finalCall = false; beats.matchPoint.clear();
    fade.active = false; fade.done = false; fade.t = 0; fade.from = 1;
    // A replay starts on a clean island, not on the last winner's colour.
    stopFlood();
    count.cancel();
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
    update, begin, skipIntro, restartInPlace, setEndView, useDraft, setRoam,
    noteCard,
    /** Capture-rig hook: seconds of held beat before the sequence opens. */
    get winLead() { return win.lead || 0; },
    /** True while the finished island is the player's to walk around. */
    get roaming() { return roaming; },
    /** hud-end.js calls this when the review bar goes up. See FLOOD_FADE_SEC. */
    clearVictoryFlood,
    /** True once the winner's colour is off the island for good. */
    get floodCleared() { return fade.done && !fade.active; },
    /** True while it is draining. */
    get floodFading() { return fade.active; },
    get endView() { return win.board ? 'board' : 'close'; },
    get stage() { return stage; },
    /** Capture-rig hook: is the draft asking the machine to wait? */
    get draftHolding() { return !!(draft && draft.holding); },
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
    /** 0..1 sweep of the victory flood, -1 when there is no flood running. */
    get floodProgress() { return win.flooded ? floodAt() : -1; },
    /** True once the win/lose plate and the orbit have fired — after the flood. */
    get celebrated() { return win.celebrated; },
    /** The start line: '3' | '2' | '1' | 'GO' | '' when it is not running. */
    get countdown() { return count.label; },
    get counting() { return count.active; },
    get tutorial() { return tutorial; },
    destroy() { cam.release(); count.destroy(); ui.destroy(); tutorial.destroy(); }
  };
}

export default createMatchFlow;
