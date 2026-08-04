/**
 * Island Settlers — the authoritative match, in a worker thread.
 *
 * One of these per running match. It imports the REAL game — `core/rules.js`,
 * `board/layout.js`, `systems/gathering.js`, `systems/bots.js`,
 * `entities/playerController.js` — and runs it at 60Hz with nothing rendering.
 *
 * WHY A WORKER AND NOT A FUNCTION
 * -------------------------------
 * The board is module state. `board/layout.js` deals the island while it is
 * still evaluating and `board/nodes.js` scatters ~300 items over it at import
 * time; `reshuffle()` then mutates those same objects IN PLACE, on purpose, so
 * that every module which captured a reference keeps pointing at a live board.
 * That is the right design for a game with one island on screen and it means
 * exactly one island can exist per module registry.
 *
 * A worker gets its own module registry. So one worker is one island is one
 * match, two matches cannot see each other's tiles, and none of the game files
 * had to be refactored into factories to make it true. The cost is about 40MB
 * and 250ms of startup per concurrent match, which is a bargain against
 * rewriting the board layer.
 *
 * WHAT IS AUTHORITATIVE HERE
 * --------------------------
 * Everything. Positions, pickups, purchases, trades, cards, the draft, the
 * clock and the winner. A client may ask; only this file decides. The client
 * predicts its own settler because a hundred milliseconds of input lag would
 * ruin a game about running into things, but the moment this file disagrees,
 * this file is right.
 *
 * THE ONE THING THAT IS NOT SENT
 * ------------------------------
 * The board. `reshuffle(seed)` is deterministic and so is the item scatter, so
 * the seed in `begin` is enough for the client to deal a byte-identical island
 * — the same terrain, the same tokens, the same docks, the same blade of wheat
 * in the same place. Nineteen hexes and three hundred pickups for four bytes.
 *
 * Owner: net agent.
 */

import { parentPort, workerData } from 'node:worker_threads';

import {
  createMatch, drainEvents, tickWorld, scoreOf, rankings,
  setupCurrentPlayer, setupPlaceSettlement, setupPlaceRoad,
  legalSettlements, legalRoads, legalCities,
  placeRoad, placeSettlement, upgradeCity,
  drawCard, playKnight, playRoadBuilding, hasCard,
  doTrade, activeTradeRatio, nearestPortFor
} from '../src/core/rules.js';
import { createBots, chooseSetupSettlement, chooseSetupRoad } from '../src/systems/bots.js';
import { createGathering } from '../src/systems/gathering.js';
import { createPlayerController } from '../src/entities/playerController.js';
import { reshuffle, tiles, MARKET, ports } from '../src/board/layout.js';
import { setDifficulty } from '../src/systems/difficulty.js';
import { setKnights } from '../src/core/options.js';
import {
  MATCH_SOFT_CAP_SEC, VICTORY_POINTS, TRADE_RADIUS, COST, canAfford, PIECE_LIMIT
} from '../src/core/constants.js';
import {
  SIM_HZ, SNAPSHOT_HZ, DRAFT_PICK_SEC, ACT, packSeats, inputToStick
} from '../src/net/protocol.js';

const DT = 1 / SIM_HZ;
const SNAP_EVERY = Math.max(1, Math.round(SIM_HZ / SNAPSHOT_HZ));

/* Beats for the opening draft. A bot that picks the instant its turn arrives
   reads as a script rather than an opponent, and a human staring at a board
   needs a moment to see whose turn it became. These are shorter than the
   single-player numbers in `flowDraft.js` because online there are three
   other people waiting rather than three subroutines. */
const BOT_PICK_MIN = 0.55;
const BOT_PICK_SPREAD = 0.45;
/** After the last road, before GO. Long enough to see the board settle. */
const HANDOFF_SEC = 3.2;

/**
 * Nothing happens for this long after the match is announced.
 *
 * The browser cannot re-deal an island under a scene that was built from the
 * old one, so a client loads INTO a match through a page load: it parks the
 * seed, reloads, and comes back with the right nineteen hexes under it. That
 * costs the cold open, which is a floored 2.65 seconds of splash by design.
 * Starting the draft clock before everybody is back would spend a human's
 * first pick on a screen they are not looking at.
 */
const LOAD_IN_SEC = 7;

const say = (...a) => console.log('[match]', ...a);

/* ================================================================== setup */

const cfg = workerData || {};
const roster = Array.isArray(cfg.roster) ? cfg.roster : [];
const matchId = cfg.matchId || '?';

// Order matters: deal the island first, THEN build the match on top of it.
// createMatch() resets the item field, and it can only reset a field that has
// already been re-tagged to the terrain it is standing on.
reshuffle(cfg.seed >>> 0);
setDifficulty(cfg.difficulty || 'medium');
setKnights(cfg.knights !== false);

const state = createMatch({ seed: cfg.seed >>> 0 });
state.botSeed = (cfg.seed ^ 0x51f3a2) >>> 0;

/* Which seats are people and which are subroutines. `isBot` is the flag
   `bots.js` filters on when it builds its brains, and it is the flag
   `gathering.js` and the rules never look at — a bot and a human are the same
   kind of thing to the rules, which is why this works at all. */
const human = new Set();
for (const s of roster) {
  const p = state.players[s.pid];
  if (!p) continue;
  if (s.kind === 'human') { p.isBot = false; human.add(s.pid); }
  else p.isBot = true;
}

/** The stub world. Every one of these is called by the real systems and every
 *  one of them has nothing to do on a server with no screen. */
const noop = () => {};
const world = {
  scene: null, renderer: null, camera: null, avatars: [],
  heightAt: () => 0,
  island: { update: noop, highlightTile: noop },
  props: { update: noop, playHarvest: noop, setDepleted: noop },
  structures: {
    update: noop, syncFromState: noop, spawnRoad: noop, spawnSettlement: noop,
    upgradeCity: noop, setRobber: noop, ghostRoad: noop, ghostSettlement: noop,
    clearGhost: noop
  },
  market: { update: noop },
  portsView: { setUnlocked: noop },
  effects: { burst: noop, floatText: noop, ring: noop, shockwave: noop, update: noop },
  audio: { sfx: noop, music: noop, ambience: noop, unlock: noop }
};

/* `bots` is rebuilt rather than reset when a seat changes hands, because
   `createBots` decides which brains exist by filtering `p.isBot` ONCE. There
   is no brain waiting in the wings for a human seat, so promoting one to a bot
   means building the set again. It costs a few hundred microseconds and
   happens at most three times in a match. */
let bots = createBots(state, world, { seed: state.botSeed });
const gathering = createGathering(state, world);

function rebuildBots() {
  bots = createBots(state, world, { seed: state.botSeed });
}

/* One controller per human seat, each reading its own stick. This is the same
   file the browser runs, which is the entire point: acceleration, deceleration,
   coastline sliding and the speed a settler turns are defined once. */
const sticks = new Map();     // pid -> { x, y }
const controllers = [];
for (const pid of human) {
  const stick = { x: 0, y: 0 };
  sticks.set(pid, stick);
  controllers.push(createPlayerController(
    state, null, { yaw: 0 }, { stick }, world, { pid }
  ));
}

/** Free roads owed by Road Building, per seat. The browser keeps this on the
 *  player (`p.freeRoads`) and so do we — `rules.playRoadBuilding` sets it. */
const peerState = new Map();  // pid -> 'live' | 'gone' | 'bot' | 'left'
for (const s of roster) peerState.set(s.pid, s.kind === 'human' ? 'live' : 'bot');

/* ================================================================== output */

function post(msg) {
  try { parentPort.postMessage(msg); } catch (e) { /* parent is gone */ }
}

let evBuf = [];
function flushEvents() {
  const evs = drainEvents(state);
  if (evs.length) evBuf.push(...evs);
  if (!evBuf.length) return;
  // Events go out in the order they happened, in one message per snapshot
  // beat. They are reliable and ordered because the transport is TCP, so a
  // client can replay them straight into its own rules and be exactly here.
  post({ t: 'ev', evs: evBuf });
  evBuf = [];
}

function snapshot() {
  post({
    t: 'snap',
    k: tick,
    ms: Math.round(state.time * 1000),
    p: packSeats(state.players)
  });
}

/* =================================================================== draft
   The snake order lives on `state.setupOrder` and the cursor on
   `state.setupIndex` / `state.setupNeed`, exactly as in single player. What
   is different online is that a human turn HAS A CLOCK: `flowDraft.js` says
   in as many words that the player's turn never times out, which is correct
   when the only thing waiting is three subroutines and unacceptable when it
   is three people. */
const draft = { pid: -1, need: 'settlement', wait: 0, deadline: 0, target: -1, sent: false };

function draftAnnounce(resend) {
  post({
    t: 'draft',
    // A REPEAT, not a new turn. The clients that already have this one must be
    // able to tell, or an auto-drafting client picks twice for the same seat —
    // once for the announcement and once for its echo. See netmatch.js.
    resend: !!resend,
    index: state.setupIndex,
    total: state.setupOrder.length * 2,
    pid: draft.pid,
    need: draft.need,
    anchor: state.setupAnchor === undefined ? -1 : state.setupAnchor,
    deadline: human.has(draft.pid) ? Math.round(draft.deadline * 1000) : 0
  });
}

function beginDraftStep() {
  draft.pid = setupCurrentPlayer(state);
  draft.need = state.setupNeed;
  draft.target = -1;
  draft.sent = false;
  if (human.has(draft.pid) && peerState.get(draft.pid) === 'live') {
    draft.wait = DRAFT_PICK_SEC;
    draft.deadline = state.time + DRAFT_PICK_SEC;
  } else {
    // A bot, or a human whose connection dropped and whose seat is being
    // played for them. Either way: think for a beat, then place.
    draft.wait = BOT_PICK_MIN + Math.random() * BOT_PICK_SPREAD;
    draft.deadline = state.time + draft.wait;
    draft.target = draft.need === 'road'
      ? safeRoad(draft.pid, state.setupAnchor)
      : safeSettlement(draft.pid);
  }
  draftAnnounce();
}

function safeSettlement(pid) {
  const legal = legalSettlements(state, pid, true);
  if (!legal.length) return -1;
  let pick = -1;
  try { pick = chooseSetupSettlement(state, pid); } catch (e) { pick = -1; }
  return legal.includes(pick) ? pick : legal[0];
}

function safeRoad(pid, anchor) {
  const legal = legalRoads(state, pid, true, anchor === undefined ? -1 : anchor);
  if (!legal.length) return -1;
  let pick = -1;
  try { pick = chooseSetupRoad(state, pid, anchor); } catch (e) { pick = -1; }
  return legal.includes(pick) ? pick : legal[0];
}

/** Place for whoever is up, and move the cursor. Returns true when the whole
 *  draft is finished. */
function commitDraft(pid, id) {
  const ok = state.setupNeed === 'road'
    ? setupPlaceRoad(state, pid, id)
    : setupPlaceSettlement(state, pid, id);
  if (!ok) return { ok: false };
  if (state.phase !== 'setup') return { ok: true, done: true };
  beginDraftStep();
  return { ok: true, done: false };
}

function updateDraft(dt) {
  if (draft.pid < 0) return;
  if (state.time < draft.deadline) return;

  // A human who ran out of clock gets the pick a bot would have made rather
  // than a random legal spot: being away should cost you tempo, not the match.
  let id = draft.target;
  if (id < 0) {
    id = draft.need === 'road'
      ? safeRoad(draft.pid, state.setupAnchor)
      : safeSettlement(draft.pid);
  }
  if (id < 0) {
    // Nothing legal at all. Should be impossible on a fair board; if it ever
    // happens, do not wedge the match on it.
    say(matchId, 'no legal draft spot for seat', draft.pid, '— skipping');
    state.setupIndex++;
    if (state.setupIndex >= state.setupOrder.length * 2) { finishDraft(); return; }
    beginDraftStep();
    return;
  }
  const r = commitDraft(draft.pid, id);
  if (r.done) finishDraft();
}

let handoff = -1;
function finishDraft() {
  draft.pid = -1;
  handoff = HANDOFF_SEC;
  // THE LAST ROAD GOES OUT BEFORE "DONE" DOES. Events are batched onto the
  // snapshot beat, so announcing the end of the draft first delivers a client
  // the news that the draft is over up to 50ms before the eighth road that
  // ended it — which is a board with a settlement standing on its own for
  // three frames, and a results screen that could disagree about who owns what.
  flushEvents();
  post({ t: 'draft', index: -1, pid: -1, need: 'done', anchor: -1, deadline: 0 });
  post({ t: 'go', in: Math.round(HANDOFF_SEC * 1000) });
}

/* ==================================================================== acts
   A client asking the match to do something. Every one is validated here as
   if the client were hostile, because from this file's point of view it is
   just bytes: the browser's own affordability checks and legal-target lists
   are a courtesy to the player, not a guarantee to the server. */

function act(pid, msg) {
  const kind = msg && msg.kind;
  const p = state.players[pid];
  if (!p) return { ok: false, code: 'move.illegal' };

  switch (kind) {
    case ACT.DRAFT_SETTLEMENT:
    case ACT.DRAFT_ROAD: {
      if (state.phase !== 'setup') return { ok: false, code: 'move.illegal' };
      if (draft.pid !== pid) return { ok: false, code: 'move.notyours' };
      const wantRoad = kind === ACT.DRAFT_ROAD;
      if (wantRoad !== (state.setupNeed === 'road')) return { ok: false, code: 'move.illegal' };
      const r = commitDraft(pid, msg.id | 0);
      if (!r.ok) return { ok: false, code: 'move.illegal' };
      if (r.done) finishDraft();
      return { ok: true };
    }

    case ACT.BUILD_ROAD: {
      if (!inPlay()) return { ok: false, code: 'move.illegal' };
      const id = msg.id | 0;
      if (!legalRoads(state, pid).includes(id)) return { ok: false, code: 'move.illegal' };
      if (!canAfford(p.res, COST.road)) return { ok: false, code: 'move.illegal' };
      return placeRoad(state, pid, id) ? { ok: true } : { ok: false, code: 'move.illegal' };
    }

    case ACT.FREE_ROAD: {
      // Road Building's two roads. Free means free — but only while the
      // player is actually owed one, which `playRoadBuilding` recorded.
      if (!inPlay()) return { ok: false, code: 'move.illegal' };
      if (!(p.freeRoads > 0)) return { ok: false, code: 'move.illegal' };
      const id = msg.id | 0;
      if (!legalRoads(state, pid).includes(id)) return { ok: false, code: 'move.illegal' };
      if (!placeRoad(state, pid, id, true)) return { ok: false, code: 'move.illegal' };
      p.freeRoads = Math.max(0, p.freeRoads - 1);
      post({ t: 'free', pid, left: p.freeRoads });
      return { ok: true };
    }

    case ACT.BUILD_SETTLEMENT: {
      if (!inPlay()) return { ok: false, code: 'move.illegal' };
      const id = msg.id | 0;
      if (!legalSettlements(state, pid).includes(id)) return { ok: false, code: 'move.illegal' };
      if (!canAfford(p.res, COST.settlement)) return { ok: false, code: 'move.illegal' };
      return placeSettlement(state, pid, id) ? { ok: true } : { ok: false, code: 'move.illegal' };
    }

    case ACT.BUILD_CITY: {
      if (!inPlay()) return { ok: false, code: 'move.illegal' };
      const id = msg.id | 0;
      if (!legalCities(state, pid).includes(id)) return { ok: false, code: 'move.illegal' };
      if (!canAfford(p.res, COST.city)) return { ok: false, code: 'move.illegal' };
      return upgradeCity(state, pid, id) ? { ok: true } : { ok: false, code: 'move.illegal' };
    }

    case ACT.BUY_CARD: {
      if (!inPlay()) return { ok: false, code: 'move.illegal' };
      if (!canAfford(p.res, COST.card)) return { ok: false, code: 'move.illegal' };
      return drawCard(state, pid) ? { ok: true } : { ok: false, code: 'move.illegal' };
    }

    case ACT.PLAY_KNIGHT: {
      if (!inPlay()) return { ok: false, code: 'move.illegal' };
      if (!hasCard(p, 'knight')) return { ok: false, code: 'move.illegal' };
      const tile = msg.tile | 0;
      const t = tiles[tile];
      if (!t || !t.resource || tile === state.robberTile) {
        return { ok: false, code: 'move.illegal' };
      }
      return playKnight(state, pid, tile) ? { ok: true } : { ok: false, code: 'move.illegal' };
    }

    case ACT.PLAY_ROADS: {
      if (!inPlay()) return { ok: false, code: 'move.illegal' };
      if (!hasCard(p, 'roadBuilding')) return { ok: false, code: 'move.illegal' };
      if (p.roads.size >= PIECE_LIMIT.road) return { ok: false, code: 'move.illegal' };
      if (!legalRoads(state, pid).length) return { ok: false, code: 'move.illegal' };
      if (!playRoadBuilding(state, pid)) return { ok: false, code: 'move.illegal' };
      post({ t: 'free', pid, left: p.freeRoads || 0 });
      return { ok: true };
    }

    case ACT.TRADE: {
      if (!inPlay()) return { ok: false, code: 'move.illegal' };
      const give = String(msg.give || '');
      const get = String(msg.get || '');
      // PROXIMITY IS CHECKED HERE, not taken on trust. The browser only offers
      // the sheet when you are standing at a post; the server proves it,
      // because "trade from anywhere" is the single cheapest thing to cheat.
      const spot = tradeSpot(p);
      if (!spot.ok) return { ok: false, code: 'move.illegal' };
      const ratio = activeTradeRatio(state, pid, give, spot.port);
      if (!ratio) return { ok: false, code: 'move.illegal' };
      return doTrade(state, pid, give, get, ratio)
        ? { ok: true, ratio }
        : { ok: false, code: 'move.illegal' };
    }

    default:
      return { ok: false, code: 'bad.request' };
  }
}

function inPlay() {
  return state.phase === 'play' && state.winner < 0;
}

/** Where this settler may trade from, judged on the server's own positions. */
function tradeSpot(p) {
  if (Math.hypot(p.x - MARKET.x, p.z - MARKET.z) < TRADE_RADIUS) {
    return { ok: true, port: null };
  }
  const port = nearestPortFor(state, p.id, p.x, p.z, TRADE_RADIUS);
  return port ? { ok: true, port } : { ok: false, port: null };
}

/* ==================================================================== loop */

let tick = 0;
let running = true;
let over = false;
let loadIn = LOAD_IN_SEC;

function endMatch(winner, reason) {
  if (over) return;
  over = true;
  state.winner = winner;
  state.phase = 'over';
  const table = rankings(state).map(e => ({
    pid: e.p.id,
    vp: scoreOf(state, e.p),
    knights: e.p.knightsPlayed || 0,
    road: e.p.roads ? e.p.roads.size : 0,
    gathered: e.p.stats ? e.p.stats.gathered : 0
  }));
  flushEvents();
  post({ t: 'over', winner, reason, table });
}

function step() {
  if (!running) return;

  if (loadIn > 0) {
    state.time += DT;
    loadIn -= DT;
    if (loadIn <= 0) { loadIn = 0; beginDraftStep(); }
  } else if (state.phase === 'setup') {
    // The clock runs during the draft too, because the draft's own timers are
    // measured in `state.time` and nothing else would advance it.
    state.time += DT;
    updateDraft(DT);
  } else if (handoff > 0) {
    state.time += DT;
    handoff -= DT;
    if (handoff <= 0) {
      handoff = -1;
      // `state.phase` was set to 'play' by setupAdvance; the handoff was only
      // ever a pause to let four people find their settler before the clock
      // that matters starts.
      state.time = 0;
    }
  } else {
    tickWorld(state, DT);
    for (const c of controllers) c.update(DT);
    gathering.update(DT);
    bots.update(DT);

    if (!over) {
      if (state.winner >= 0) endMatch(state.winner, 'victory');
      else if (state.time >= MATCH_SOFT_CAP_SEC) {
        // Nobody reached thirteen inside the cap. Highest score takes it, and
        // the tie-break is the same `rankings` order the results screen uses.
        const top = rankings(state)[0];
        endMatch(top ? top.p.id : -1, 'time');
      }
    }
  }

  tick++;
  if (tick % SNAP_EVERY === 0) { flushEvents(); snapshot(); }
  else if (state.events.length > 24) flushEvents();
}

/* A worker's timer is its own; nothing else runs on this thread, so a plain
   interval at the simulation rate is honest. `setInterval` drifts, so the
   accumulator below spends real elapsed time rather than assuming 16.67ms
   arrived — a busy host must not slow the match down, it must catch up. */
let last = Date.now();
let acc = 0;
const timer = setInterval(() => {
  const now = Date.now();
  let elapsed = (now - last) / 1000;
  last = now;
  // A long stall (GC, the host being descheduled) must not be replayed as
  // hundreds of steps at once. Half a second is the most we will ever try to
  // make up, which is also the most anybody would notice.
  if (elapsed > 0.5) elapsed = 0.5;
  acc += elapsed;
  let steps = 0;
  while (acc >= DT && steps++ < 8) { acc -= DT; step(); }
}, 1000 / SIM_HZ);

/* ================================================================ messages */

parentPort.on('message', msg => {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.t) {
    case 'in': {
      const stick = sticks.get(msg.pid);
      if (!stick) return;
      const s = inputToStick(msg.x, msg.z);
      stick.x = s.x; stick.y = s.y;
      return;
    }
    case 'act': {
      const r = act(msg.pid, msg);
      post({ t: 'actres', pid: msg.pid, i: msg.i, ok: r.ok, code: r.code || null });
      // Anything an act changed should reach the table promptly rather than
      // waiting out the rest of the snapshot beat: a road you paid for should
      // appear when you paid for it.
      if (r.ok) flushEvents();
      return;
    }
    case 'peer': {
      peerState.set(msg.pid, msg.state);
      const p = state.players[msg.pid];
      if (!p) return;
      if (msg.state === 'bot' || msg.state === 'left') {
        // Somebody left for good. Their settler carries on as a bot rather
        // than standing in the sea for the rest of the match — a frozen
        // settler is worse for everyone else than a competent one.
        //
        // 'left' and 'bot' are played identically and read differently: only
        // 'left' is a person who was here, and only that seat is struck
        // through in the standings (see `leaveRoom` in hub.mjs).
        p.isBot = true;
        const stick = sticks.get(msg.pid);
        if (stick) { stick.x = 0; stick.y = 0; }
        rebuildBots();
      } else if (msg.state === 'live') {
        p.isBot = false;
        rebuildBots();
        /*
         * AND TELL THEM WHOSE TURN IT IS.
         *
         *   "When I'm playing with a friend, the game would let one player pick
         *    their location, but not the other."
         *
         * The draft prompt is a BROADCAST, sent once when the turn changes. A
         * client that is reloading at that moment — which every client does
         * exactly once, on the way into a match, because the island cannot be
         * re-dealt under a live scene — misses it and has nothing to act on. It
         * then sits watching a board it is allowed to pick on and does not know
         * it. The seat is not stuck; the message was.
         *
         * So a peer coming back gets the current state of the opening, and the
         * cheapest correct way to do that is to say it again to everybody: the
         * clients that already have it are idempotent about it (`draftState` is
         * assigned, not accumulated) and it is one small message.
         */
        if (state.phase === 'setup') draftAnnounce(true);
      } else if (msg.state === 'gone') {
        // Held seat: stop moving, keep everything they own.
        const stick = sticks.get(msg.pid);
        if (stick) { stick.x = 0; stick.y = 0; }
      }
      post({ t: 'peerok', pid: msg.pid, state: msg.state });
      return;
    }
    case 'stop': {
      running = false;
      clearInterval(timer);
      post({ t: 'stopped' });
      return;
    }
    default:
      return;
  }
});

/* ================================================================== opening
   Announce, then start the draft on the next tick so the parent has posted
   `begin` to every client before anything can happen in it. */
post({
  t: 'begin',
  matchId,
  seed: cfg.seed >>> 0,
  roster,
  difficulty: cfg.difficulty || 'medium',
  knights: cfg.knights !== false,
  order: state.setupOrder.slice(),
  victoryPoints: VICTORY_POINTS,
  ports: ports.length,
  loadIn: Math.round(LOAD_IN_SEC * 1000)
});
// The draft starts when `loadIn` runs out, not now. Everybody is told the
// board is coming so the screen has something honest to say meanwhile.
post({ t: 'draft', index: -1, pid: -1, need: 'loading', anchor: -1, deadline: 0 });
