/**
 * Island Settlers — the three rival settlers.
 *
 *   createBots(state, world) -> { update(dt) }
 *
 * Alex, Maya and Finn are real characters on the island. This module moves
 * them exactly the way the human controller moves player 0 — accelerate toward
 * a target, slide along the coastline, clamp to land — and then makes every
 * economic decision through `rules.js`. A bot can only ever hold a resource it
 * physically walked to and harvested, traded for at a dock, or was granted by
 * the opening draft. No teleporting, no free stock, no hidden income.
 *
 * The planner is utility-scored and re-evaluated roughly twice a second per
 * bot (staggered), not per frame. Scoring lives in `botBrain.js`.
 *
 * Owner: Bots agent.
 */

import {
  BOT_SPEED, PICKUP_RADIUS, TRADE_RADIUS, PIECE_LIMIT,
  COST, canAfford
} from '../core/constants.js';

import { clampToIsland, MARKET } from '../board/layout.js';

import { mulberry32, nearestItem, tileItemsRemaining, itemsByTile } from '../board/nodes.js';

import { difficultyParams, LEVELS, RAMP_CEILING } from './difficulty.js';

import {
  placeRoad, placeSettlement, upgradeCity, drawCard,
  playKnight, playRoadBuilding, doTrade, sweepPickups,
  legalRoads, setupCurrentPlayer, canGatherTile, scoreOf,
  setupPlaceSettlement, setupPlaceRoad
} from '../core/rules.js';

import { VICTORY_POINTS } from '../core/constants.js';

import {
  choosePurchase, chooseRoad, planGather, planTrade, knightTarget, wantsKnight,
  productionOf, affinityOf, needWeights, chooseHarvestTile,
  chooseSetupSettlement, chooseSetupRoad,
  INTERSECTION_SPOT, MARKET_SPOT
} from './botBrain.js';

export { chooseSetupSettlement, chooseSetupRoad };

/* ------------------------------------------------------------------ tuning */

const BOT_ACCEL = 55.0;            // slightly softer than the human's 60
const RUN_THRESHOLD = 0.6;
const ARRIVE_BUILD = 1.5;
// Pickup is contact-based, so a bot sweeping a field aims straight THROUGH each
// item rather than braking beside it.
const ARRIVE_GATHER = PICKUP_RADIUS * 0.35;
const ACTION_HOLD = 0.42;          // seconds a build/trade pose is held
const REPLAN_MIN = 0.42;
const REPLAN_SPREAD = 0.34;
const STUCK_SEC = 2.2;
const BLACKLIST_SEC = 9.0;
const SETUP_FALLBACK_SEC = 3.5;    // only fires if matchflow.js never shows up

/* Anti-stall, and the reason even the slowest field still ends a match.
   A dawdling field grinds: everybody on ten or eleven points, nobody able to
   close, and the clock runs into the soft cap.

   The old version of this block clawed the entire handicap back at 210s and
   dropped a full-strength `hard` rival on a human who was, at that exact
   moment, finally catching up. It now does two separate things:

     SOFT RAMP — from `level.rampFrom`, over RAMP_SPAN seconds, the rivals blend
     toward `hard`. `hard` is itself a mild level now, and RAMP_WEIGHT holds the
     *visible* knobs — run speed, raiding, the award chase — most of the way
     back regardless. What the soft ramp really sharpens is the bookkeeping: it
     stops them dithering, stops them wandering off, and shortens the patience
     that flips the planner into "finish something". That is what converts a
     stuck position into a finished match, and it costs the player almost no
     perceived pressure.

     PANIC — a genuine last resort, and the only thing in the build that still
     plays like the retired Hard. It does not begin until RAMP_PANIC_SEC, by
     which point the match has already overrun the three-to-five minutes it is
     meant to take, and it lifts RAMP_WEIGHT out of the way as it goes so the
     field is at full `RAMP_CEILING` strength by
     RAMP_PANIC_SEC + RAMP_PANIC_SPAN, leaving a comfortable margin before
     matchflow.js's stalemate net at MATCH_SOFT_CAP_SEC.

   Two things protect the player, who is always seat 0:
     - on match point (within RAMP_SAFE_VP) BOTH ramps are held off for
       RAMP_GRACE seconds, so a beginner about to win is never chased down;
     - if instead they are RAMP_PACE_VP or more off the pace a five-minute
       match needs, the soft ramp comes forward by RAMP_EARLY.
   Neither ramp applies to a seat running an explicit profile — see
   `opts.profiles` — because a human does not get better at 4:00.

   Measured over 120 matches per level (`tools/simulate.mjs --matches=60
   --novice`, seeds 1 and 7): the share that reaches the stalemate net rather
   than a 13-point win is 15% easy / 12% medium / 11% hard, against 12% / 5% /
   0% before this pass. That is the price of a field this much weaker, and it is
   paid in matches that finish on points at seven minutes rather than in matches
   that hang.

   Expert, added later, reaches the net least often of the four — 3 of 120, on
   the same rig at seeds 101/202/303 — because a field that dithers less closes
   on its own before either ramp has much to do. Note that the simulator is not
   bit-reproducible (rules.js and the draft fall back to Math.random in places),
   so any single 25-match run of it carries a ±10-point band on these shares;
   the numbers above are pooled. */
const RAMP_SPAN = 80;           // seconds the soft ramp takes to run in
const RAMP_SAFE_VP = 2;
const RAMP_GRACE = 65;          // extra seconds when the player is on match point
const RAMP_PANIC_GRACE = 1.0;   // ...of which the panic ramp honours this share
const RAMP_PACE_SEC = 300;      // the pace a five-minute match would need
const RAMP_PACE_VP = 3;         // how far off it the player has to be
const RAMP_EARLY = 55;          // ...to bring the soft ramp forward this far
const RAMP_PANIC_SEC = 268;     // absolute clock at which "end this" takes over
const RAMP_PANIC_SPAN = 50;     // ...reaching RAMP_CEILING this many seconds later

/* How much of the distance to the target each knob is allowed to travel on the
   SOFT ramp. Anything the player can see and feel — how fast a rival crosses
   the island, how often the Knight lands on them, how hard the trophies are
   chased — barely moves. Everything that only makes a bot stop wasting its own
   time moves nearly all the way. Panic scales all of these toward 1. */
const RAMP_WEIGHT = {
  speed: 0.22, accel: 0.30,
  replan: 0.85, hesitate: 0.90, pause: 0.90, actDelay: 0.85,
  noise: 0.65, secondBest: 0.85, routeSlop: 0.70, tileSlop: 0.70,
  wander: 1.00, wanderSec: 1.00,
  hoard: 1.00,
  trade: 0.70,
  knight: 0.25, knightAim: 0.25, knightGap: 0.25,
  // The trophy chase is worth two victory points and is most of how a stuck
  // field finally closes; it is also the one "sharper" behaviour a player never
  // feels as pressure, because it happens out on the road network.
  award: 0.60, setupNoise: 0.00,
  desperate: 1.00
};

/* Difficulty (src/systems/difficulty.js) scales almost everything below: how
   fast a rival runs, how long it stands about, how often it re-plans, how good
   its choice is when it does, and how willing it is to trade or raid. Nothing
   here changes what a bot is *allowed* to do — a resource still only ever
   arrives through a rules.js call on a hex the bot owns. */

/* ----------------------------------------------------------------- helpers */

/** Coast-sliding move, mirrored from the human controller. */
function moveWithSlide(p, nx, nz) {
  const full = clampToIsland(nx, nz);
  if (!full.clamped) { p.x = nx; p.z = nz; return; }

  const dx = nx - p.x, dz = nz - p.z;
  const ax = Math.abs(dx) > 1e-7 ? clampToIsland(nx, p.z) : null;
  const az = Math.abs(dz) > 1e-7 ? clampToIsland(p.x, nz) : null;
  const okX = ax && !ax.clamped;
  const okZ = az && !az.clamped;

  if (okX && okZ) {
    if (Math.abs(dx) >= Math.abs(dz)) { p.x = nx; p.vz *= 0.25; }
    else { p.z = nz; p.vx *= 0.25; }
  } else if (okX) {
    p.x = nx; p.vz *= 0.25;
  } else if (okZ) {
    p.z = nz; p.vx *= 0.25;
  } else {
    p.x = full.x; p.z = full.z;
    p.vx *= 0.1; p.vz *= 0.1;
  }
}

const dist = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);

const clamp01 = v => (v > 1 ? 1 : v < 0 ? 0 : v);

/** A random standing item on a hex — the sloppy alternative to `nearestItem`. */
function randomItemOn(tileId, rand) {
  const pool = itemsByTile.get(tileId);
  if (!pool || !pool.length) return null;
  let live = 0;
  for (const it of pool) if (it.available) live++;
  if (!live) return null;
  let k = Math.floor(rand() * live);
  for (const it of pool) {
    if (!it.available) continue;
    if (k-- <= 0) return it;
  }
  return null;
}

/* ==================================================================== bots */

/**
 * `opts.profiles` maps a player id to a difficulty key, overriding the level
 * the player picked for that one seat. Only the simulator uses it, to seat a
 * deliberately mediocre "novice" policy where the human would be.
 */
export function createBots(state, world, opts = {}) {
  const seed = (opts.seed ?? state.botSeed ?? 0x5eed1e) >>> 0;
  const profiles = opts.profiles || {};

  const brains = state.players.filter(p => p.isBot).map((p, i) => {
    const rng = mulberry32(seed + p.id * 9176 + 17);
    return {
      pid: p.id,
      p,
      rng,
      profile: profiles[p.id] || null,
      d: difficultyParams(profiles[p.id] || undefined),
      pause: 0,
      // A little personality so the three never move in lockstep.
      lag: 0.06 + rng() * 0.22,
      speedScale: 0.93 + rng() * 0.07,
      noise: 0.8 + rng() * 0.7,
      think: 0.15 + i * 0.17 + rng() * 0.2,
      goal: null,
      hold: 0,
      stuck: 0,
      sinceAct: 0,
      avoidTiles: new Map(),
      avoidGoals: new Map(),
      externalGather: false,
      lastKnight: -999
    };
  });

  // `avoidNodes` is the old name for the same map; flowRestart.js still clears
  // it by name, and it costs nothing to keep the alias pointing at the truth.
  for (const b of brains) b.avoidNodes = b.avoidTiles;

  // Setup-draft watchdog: only ever fires when matchflow.js is absent.
  let setupKey = '';
  let setupWait = 0;
  const setupRng = mulberry32(seed ^ 0x9e3779b9);

  /* ------------------------------------------------------------ utilities */

  const jitterFor = b => (amp) => (b.rng() - 0.5) * amp * b.noise * b.d.noise;

  /** Effective run speed for this bot at this difficulty. */
  const speedOf = b => BOT_SPEED * b.speedScale * b.d.speed;

  /** Slop options for the brain's land-picking helpers. */
  const slopOf = b => ({ slop: b.d.tileSlop, rand: b.rng });

  /* ---------------------------------------------------------- anti-stall */

  /**
   * The two ramps, as a pair of 0..1 fractions.
   *   `k` — the soft ramp, weighted by RAMP_WEIGHT, target `hard`.
   *   `panic` — the last-resort blend toward RAMP_CEILING, which also lifts
   *             RAMP_WEIGHT out of the way. Zero for the whole of any match
   *             that ends anywhere near on time.
   */
  function rampAmounts() {
    if (state.phase !== 'play') return { k: 0, panic: 0 };
    // Seat 0 is the player's chair (and the simulator's novice stand-in).
    const you = state.players[0];
    const yourVp = you ? scoreOf(state, you) : 0;
    const closing = yourVp >= VICTORY_POINTS - RAMP_SAFE_VP;
    // Grace, not a veto: a player on match point gets an extra RAMP_GRACE
    // seconds of dawdling rivals. If they still cannot close, the match has to
    // end some time, so the ramp comes back.
    const grace = closing ? RAMP_GRACE : 0;

    // A match nobody is winning should not be allowed to sprawl. If the player
    // is a long way off the pace needed for a five-minute match, the rivals
    // start sharpening earlier and it gets wrapped up.
    const pace = VICTORY_POINTS * (state.time / RAMP_PACE_SEC);
    const from = difficultyParams().rampFrom
      - (yourVp <= pace - RAMP_PACE_VP ? RAMP_EARLY : 0);
    const k = clamp01((state.time - from - grace) / RAMP_SPAN);

    const panic = clamp01(
      (state.time - RAMP_PANIC_SEC - grace * RAMP_PANIC_GRACE) / RAMP_PANIC_SPAN);
    return { k, panic };
  }

  /**
   * Blend a level toward `hard` (soft) and then toward RAMP_CEILING (panic).
   *
   * Every knob travels `k * RAMP_WEIGHT[knob]` of the way to `hard`, so the
   * things the player can feel stay handicapped even at full soft ramp; `panic`
   * scales those weights toward 1 and pulls the result on toward the ceiling.
   *
   * `hard` is the soft ramp's target because it is the level the anti-stall
   * pass was measured against, not because it is the top of the ladder — Expert
   * sits above it. A ramp is only ever allowed to SHARPEN: for each knob we ask
   * which of `d` and `hard` already sits nearer RAMP_CEILING, which is what
   * "playing better" means for that knob whichever way its numbers run, and
   * leave the knob alone if blending would walk it back. So Expert never gets
   * slower, or more hesitant, at 3:00 for having started out ahead of Hard.
   */
  function sharpen(d, k, panic) {
    if (k <= 0 && panic <= 0) return d;
    const H = LEVELS.hard;
    const out = { ...d };
    for (const key in H) {
      const a = d[key], h = H[key];
      if (typeof a !== 'number' || typeof h !== 'number') continue;
      const c = RAMP_CEILING[key];
      if (typeof c === 'number' && Math.abs(h - c) > Math.abs(a - c)) continue;
      const w = RAMP_WEIGHT[key] === undefined ? 1 : RAMP_WEIGHT[key];
      // Panic un-caps the weight: at panic 1 every knob travels the full way.
      const eff = w + (1 - w) * panic;
      out[key] = Math.max(0, a + (h - a) * k * eff);
    }
    if (panic > 0) {
      for (const key in RAMP_CEILING) {
        const a = out[key], c = RAMP_CEILING[key];
        if (typeof a !== 'number' || typeof c !== 'number') continue;
        out[key] = Math.max(0, a + (c - a) * panic);
      }
    }
    // Sharpening always switches the endgame push on: a rival that is one point
    // from winning and does not notice is exactly how a match stalls. This is
    // the one part of the soft ramp with real teeth, and it is also the part
    // that costs the player nothing — it only stops a rival wasting a win.
    out.endgame = d.endgame || k > 0.35 || panic > 0;
    // ...and shortens the patience that flips the planner into "take whatever
    // I can finish soonest", which is what converts a stuck position into a
    // finished match. Never to zero: a bot that only ever buys the cheapest
    // thing available buys roads forever and never scores.
    const urge = Math.min(1, Math.max(k, panic));
    out.desperate = Math.max(7, d.desperate * (1 - 0.6 * urge));
    // A field that has to finish stops postponing purchases it can already
    // afford, whatever level it is nominally playing at.
    out.hoard = (d.hoard || 0) * (1 - urge);
    return out;
  }

  // Quantised so the blend is built a handful of times per match, not 60 times
  // a second per bot.
  let rampQ = '';
  const rampCache = new Map();
  function effectiveD(base, k, panic) {
    if (k <= 0 && panic <= 0) return base;
    const qk = Math.round(k * 20) / 20;
    const qp = Math.round(panic * 20) / 20;
    const q = `${qk}/${qp}`;
    if (q !== rampQ) { rampQ = q; rampCache.clear(); }
    let v = rampCache.get(base.key);
    if (!v) { v = sharpen(base, qk, qp); rampCache.set(base.key, v); }
    return v;
  }

  function liveAvoid(b, map) {
    const out = new Set();
    for (const [k, until] of map) {
      if (state.time >= until) map.delete(k); else out.add(k);
    }
    return out;
  }

  function blacklistTile(b, id) { b.avoidTiles.set(id, state.time + BLACKLIST_SEC); }
  function blacklistGoal(b, key) { b.avoidGoals.set(key, state.time + BLACKLIST_SEC); }

  function noteAct(b) { b.sinceAct = 0; b.think = 0.05 + b.rng() * 0.12; }

  /* ------------------------------------------------------------- planning */

  function planFor(b) {
    const p = b.p;
    const d = b.d;
    const jitter = jitterFor(b);
    const ctx = { aff: affinityOf(p.strategy), prod: productionOf(state, p.id), jitter, d };
    const avoidN = liveAvoid(b, b.avoidTiles);
    const avoidG = liveAvoid(b, b.avoidGoals);
    const desperate = b.sinceAct > d.desperate;

    /* --- amble off and achieve nothing --- */
    // The single most visible difference between a beginner and an expert is
    // that the beginner is often just... walking somewhere else.
    if (d.wander > 0 && !desperate && b.rng() < d.wander) return wanderGoal(b);

    /* --- spend Road Building charges first --- */
    if ((p.freeRoads || 0) > 0 && p.roads.size < PIECE_LIMIT.road) {
      const rd = bestRoadTarget(b, ctx, avoidG);
      if (rd) return { kind: 'build', what: 'road', target: rd.id, free: true,
                       tx: rd.spot.x, tz: rd.spot.z, arrive: ARRIVE_BUILD };
      p.freeRoads = 0;                       // nowhere legal left to put them
    }

    /* --- card plays are instant, no travel --- */
    if (wantsKnight(state, p.id, state.time - b.lastKnight, { d, rand: b.rng })) {
      const kt = knightTarget(state, p.id, { d, rand: b.rng });
      if (kt.tile >= 0) return { kind: 'knight', tile: kt.tile };
    }
    if (p.cards.some(c => c.type === 'roadBuilding')
        && p.roads.size < PIECE_LIMIT.road
        && legalRoads(state, p.id).length) {
      return { kind: 'roadCard' };
    }

    /* --- what are we saving for? --- */
    const purchase = choosePurchase(state, p.id, p.x, p.z, ctx);
    if (!purchase) return gatherFallback(b, avoidN);

    let options = purchase.options.filter(o => !avoidG.has(goalKey(o)));
    if (!options.length) options = purchase.options;

    // Normally we chase the highest-scoring purchase. If we have been stalled
    // for a while we instead take whatever we can complete soonest. A weaker
    // bot regularly talks itself into the second- or third-best idea instead.
    let ranked = desperate ? options.slice(0, 3) : [options[0]];
    if (!desperate && options.length > 1 && b.rng() < d.secondBest) {
      const alt = 1 + Math.floor(b.rng() * Math.min(2, options.length - 1));
      ranked = [options[Math.min(alt, options.length - 1)]];
    }
    let best = null;
    for (const o of ranked) {
      const route = routeFor(b, o, avoidN, desperate);
      if (!route) continue;
      const score = desperate ? -route.eta : o.score - route.eta * 0.35;
      if (!best || score > best.score) best = { score, o, route };
    }
    if (!best) return gatherFallback(b, avoidN);

    const o = best.o, route = best.route;
    if (route.kind === 'ready') {
      if (o.kind === 'card') {
        return { kind: 'card', tx: MARKET_SPOT.x, tz: MARKET_SPOT.z, arrive: ARRIVE_BUILD };
      }
      return { kind: 'build', what: o.kind, target: o.target, free: false,
               tx: o.spot.x, tz: o.spot.z, arrive: ARRIVE_BUILD, key: goalKey(o) };
    }
    if (route.kind === 'trade') {
      return { kind: 'trade', portId: route.plan.portId, trades: route.plan.trades,
               tx: route.plan.x, tz: route.plan.z, arrive: ARRIVE_BUILD,
               venue: { x: route.plan.vx, z: route.plan.vz } };
    }
    const pick = route.pick;
    return { kind: 'gather', tile: pick.tile, tx: pick.x, tz: pick.z, arrive: ARRIVE_GATHER };
  }

  const goalKey = o => `${o.kind}:${o.target}`;

  function bestRoadTarget(b, ctx, avoidG) {
    const legal = legalRoads(state, b.pid).filter(e => !avoidG.has(`road:${e}`));
    if (!legal.length) return null;
    return chooseRoad(state, b.pid, b.p.x, b.p.z, { ...ctx, legalRoads: legal });
  }

  /** How do we get from "want it" to "have it"? */
  function routeFor(b, o, avoidN, desperate = false) {
    const p = b.p;
    const cost = COST[o.kind];
    if (canAfford(p.res, cost)) {
      // Sitting on the wood and brick for a settlement and going back out to
      // collect more anyway is the most human thing a weak bot does, and it is
      // the single biggest brake on how relentlessly a rival expands. The roll
      // is per plan, so it postpones rather than forbids, and it is off the
      // moment the bot has been stalled long enough to count as desperate.
      if (!desperate && (b.d.hoard || 0) > 0 && b.rng() < b.d.hoard) {
        const idle = planGather(state, p.id, null, p.x, p.z, avoidN, slopOf(b));
        if (idle) return { kind: 'gather', eta: idle.eta, pick: idle.first };
      }
      return { kind: 'ready', eta: travelEta(b, o) };
    }

    const g = planGather(state, p.id, cost, p.x, p.z, avoidN, slopOf(b));
    // Trading four wool for one ore is a learned move. Weak bots mostly do not
    // think of it, and go and dig for the ore they will never own instead.
    const t = b.rng() < b.d.trade ? planTrade(state, p.id, cost, p.x, p.z) : null;
    if (g && (!t || g.eta <= t.eta * 1.05)) return { kind: 'gather', eta: g.eta, pick: g.first };
    if (t) return { kind: 'trade', eta: t.eta, plan: t };
    if (g) return { kind: 'gather', eta: g.eta, pick: g.first };
    return null;
  }

  function travelEta(b, o) {
    const s = o.spot || MARKET_SPOT;
    return dist(b.p.x, b.p.z, s.x, s.z) / Math.max(1, speedOf(b));
  }

  /** A short, pointless stroll to somewhere near enough to look deliberate. */
  function wanderGoal(b) {
    const p = b.p;
    const a = b.rng() * Math.PI * 2;
    const r = 9 + b.rng() * 14;
    const spot = clampToIsland(p.x + Math.cos(a) * r, p.z + Math.sin(a) * r);
    return {
      kind: 'wander', tx: spot.x, tz: spot.z, arrive: 1.8,
      t: b.d.wanderSec * (0.6 + b.rng() * 0.8)
    };
  }

  /**
   * Nothing worth buying, or no route to it: go and work our own land. The
   * `true` opens the search up to hexes of ours that are currently bare, so a
   * bot with one exhausted forest walks over and waits for it rather than
   * milling around the market with nothing to do.
   */
  function gatherFallback(b, avoidN) {
    const w = needWeights(state, b.pid, null);
    const sl = slopOf(b);
    const pick = chooseHarvestTile(state, b.pid, w, b.p.x, b.p.z, avoidN, true, sl)
      || chooseHarvestTile(state, b.pid, w, b.p.x, b.p.z, null, true, sl);
    if (!pick) return null;
    return { kind: 'gather', tile: pick.tile, tx: pick.x, tz: pick.z, arrive: ARRIVE_GATHER };
  }

  /* ------------------------------------------------------------ execution */

  function runGoal(b, dt) {
    const p = b.p;
    const g = b.goal;
    if (!g) { coast(b, dt); return; }

    /* -- instant plays -------------------------------------------------- */
    if (g.kind === 'knight') {
      if (playKnight(state, p.id, g.tile)) {
        p.action = 'build'; b.hold = ACTION_HOLD; b.lastKnight = state.time;
      }
      b.goal = null; noteAct(b); coast(b, dt); return;
    }
    if (g.kind === 'roadCard') {
      playRoadBuilding(state, p.id);
      b.goal = null; noteAct(b); coast(b, dt); return;
    }

    /* -- gathering ------------------------------------------------------ */
    /* Contact pickup: there is nothing to "start". Chain from one item to the
       nearest next one and let `sweepPickups` scoop them up as we run over
       them. The hex empties, we replan. */
    /* -- the pointless stroll ------------------------------------------- */
    if (g.kind === 'wander') {
      g.t -= dt;
      const dw = steer(b, g.tx, g.tz, dt);
      if (g.t <= 0 || dw <= g.arrive) { b.goal = null; b.think = 0.1; }
      return;
    }

    if (g.kind === 'gather') {
      if (!canGatherTile(state, p.id, g.tile)) {
        blacklistTile(b, g.tile);
        b.goal = null; b.think = 0; return;
      }
      // Hold onto the chosen item until it is gone, then pick the next one —
      // usually the nearest, but a sloppy bot regularly heads across the hex
      // for one it merely happened to think of.
      let it = g.item && g.item.available && g.item.tile === g.tile ? g.item : null;
      if (!it) {
        if (b.d.routeSlop > 0 && b.rng() < b.d.routeSlop) it = randomItemOn(g.tile, b.rng);
        if (!it) it = nearestItem(p.x, p.z, { tile: g.tile });
        g.item = it;
      }
      if (it) {
        g.tx = it.x; g.tz = it.z;
        b.sinceAct = 0;              // productive: not stalled, do not panic
        steer(b, g.tx, g.tz, dt);
        return;
      }
      // Bare hex of ours: walk onto it and wait for the regrowth. The planner
      // re-runs twice a second and will pull us off if anything better appears.
      const d = steer(b, g.tx, g.tz, dt);
      if (d <= 2.6) { p.vx *= 0.4; p.vz *= 0.4; b.stuck = 0; }
      return;
    }

    /* -- travel-then-act goals ------------------------------------------ */
    const d = steer(b, g.tx, g.tz, dt);
    // For a trade the thing that matters is standing inside TRADE_RADIUS of the
    // actual dock, not of the patch of sand we aimed at.
    const arrived = (g.kind === 'trade' && g.venue)
      ? dist(p.x, p.z, g.venue.x, g.venue.z) <= TRADE_RADIUS - 0.25 || d <= g.arrive
      : d <= g.arrive;
    if (!arrived) return;

    // Loitering on the spot before actually doing the thing. This is what
    // "slower" looks like once a bot has stopped running.
    if (g.settle === undefined) g.settle = b.d.actDelay * (0.6 + b.rng() * 0.8);
    if (g.settle > 0) {
      g.settle -= dt;
      p.vx *= 0.35; p.vz *= 0.35;
      return;
    }

    if (g.kind === 'trade') {
      // Hard gate: never trade unless we are genuinely standing at the venue.
      const vx = g.venue ? g.venue.x : MARKET.x;
      const vz = g.venue ? g.venue.z : MARKET.z;
      if (dist(p.x, p.z, vx, vz) > TRADE_RADIUS) { b.goal = null; b.think = 0; return; }
      let did = 0;
      for (const t of g.trades) if (doTrade(state, p.id, t.give, t.get, t.ratio)) did++;
      p.action = 'trade'; b.hold = ACTION_HOLD;
      if (!did) blacklistGoal(b, `trade:${g.portId}`);
      b.goal = null; noteAct(b);
      return;
    }

    if (g.kind === 'card') {
      if (dist(p.x, p.z, MARKET.x, MARKET.z) > TRADE_RADIUS) { b.goal = null; b.think = 0; return; }
      if (drawCard(state, p.id)) { p.action = 'build'; b.hold = ACTION_HOLD; }
      else blacklistGoal(b, 'card:null');
      b.goal = null; noteAct(b);
      return;
    }

    if (g.kind === 'build') {
      let ok = false;
      if (g.what === 'road') {
        ok = placeRoad(state, p.id, g.target, !!g.free);
        if (ok && g.free) p.freeRoads = Math.max(0, (p.freeRoads || 0) - 1);
      } else if (g.what === 'settlement') {
        ok = placeSettlement(state, p.id, g.target, false);
      } else if (g.what === 'city') {
        ok = upgradeCity(state, p.id, g.target, false);
      }
      if (ok) { p.action = 'build'; b.hold = ACTION_HOLD; noteAct(b); }
      else blacklistGoal(b, g.key || `${g.what}:${g.target}`);
      b.goal = null;
      if (!ok) b.think = 0;
      return;
    }

    b.goal = null;
  }

  /* ------------------------------------------------------------- movement */

  /** Steer toward (tx,tz). Returns the distance remaining before the step. */
  function steer(b, tx, tz, dt) {
    const p = b.p;
    const dx = tx - p.x, dz = tz - p.z;
    const d = Math.hypot(dx, dz);

    const arrive = b.goal ? b.goal.arrive : 1.2;
    let tvx = 0, tvz = 0;
    // Brake into the target rather than orbiting it — a settler that overshoots
    // its node can never get slow enough to latch on.
    if (d > arrive) {
      const ease = Math.min(1, Math.max(0.25, (d - arrive) / 2.2));
      const sp = speedOf(b) * ease;
      tvx = (dx / d) * sp; tvz = (dz / d) * sp;
    }
    applyVelocity(b, tvx, tvz, dt, true);

    // Stall detection: wanted to move, barely did. The threshold tracks the
    // difficulty's run speed, or a deliberately slow bot reads as stuck.
    const spd = Math.hypot(p.vx, p.vz);
    if (d > (b.goal ? b.goal.arrive : 1.5) && spd < 1.2 * b.d.speed) {
      b.stuck += dt;
      if (b.stuck > STUCK_SEC) {
        if (b.goal && b.goal.kind === 'gather') blacklistTile(b, b.goal.tile);
        else if (b.goal && b.goal.key) blacklistGoal(b, b.goal.key);
        b.stuck = 0; b.goal = null; b.think = 0;
      }
    } else {
      b.stuck = 0;
    }
    return d;
  }

  function coast(b, dt) { applyVelocity(b, 0, 0, dt, false); }

  function applyVelocity(b, tvx, tvz, dt, moving) {
    const p = b.p;
    if (!Number.isFinite(p.vx)) p.vx = 0;
    if (!Number.isFinite(p.vz)) p.vz = 0;

    const dvx = tvx - p.vx, dvz = tvz - p.vz;
    const dm = Math.hypot(dvx, dvz);
    const maxDelta = BOT_ACCEL * b.d.accel * dt * (tvx || tvz ? 1 : 1.7);
    if (dm > maxDelta && dm > 1e-6) {
      p.vx += (dvx / dm) * maxDelta;
      p.vz += (dvz / dm) * maxDelta;
    } else {
      p.vx = tvx; p.vz = tvz;
    }

    const bx = p.x, bz = p.z;
    const nx = p.x + p.vx * dt, nz = p.z + p.vz * dt;
    if (Number.isFinite(nx) && Number.isFinite(nz)) moveWithSlide(p, nx, nz);
    if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) { p.x = MARKET.x; p.z = MARKET.z; }
    const safe = clampToIsland(p.x, p.z);
    p.x = safe.x; p.z = safe.z;

    const moved = Math.hypot(p.x - bx, p.z - bz);
    if (p.stats) p.stats.distance += moved;

    const spd = Math.hypot(p.vx, p.vz);
    if (spd > 0.35) p.facing = Math.atan2(p.vz, p.vx);
    if (!Number.isFinite(p.facing)) p.facing = 0;

    if (moving && spd > RUN_THRESHOLD && moved > 1e-5) {
      if (b.hold <= 0) p.action = 'run';
    } else if (p.action === 'run' && b.hold <= 0 && spd <= RUN_THRESHOLD) {
      p.action = 'idle';
    }
  }

  /* --------------------------------------------------------- pickup sweep */

  /**
   * Collect whatever this settler is touching — the single rules call through
   * which a bot may ever acquire a resource from the ground.
   *
   * `systems/gathering.js` sweeps every player each step when it is present, so
   * this call normally comes second and is refused with -1. That is the tell we
   * report as `externalGather`: proof the bots are deferring rather than
   * double-collecting. Without that module (a bare headless match) the bots do
   * the sweeping themselves and the match still resolves.
   */
  function driveGather(b) {
    const got = sweepPickups(state, b.pid);
    if (got === -1) b.externalGather = true;
  }

  /* ------------------------------------------------------------- setup AI */

  function driveSetup(dt) {
    const pid = setupCurrentPlayer(state);
    const key = `${state.setupIndex}:${state.setupNeed}`;
    if (key !== setupKey) { setupKey = key; setupWait = 0; }
    else setupWait += dt;

    // Amble toward the corner we just claimed so play opens with everyone
    // standing somewhere sensible.
    for (const b of brains) {
      const own = [...b.p.settlements];
      if (own.length) {
        const s = INTERSECTION_SPOT[own[own.length - 1]];
        steer(b, s.x, s.z, dt);
      } else {
        coast(b, dt);
      }
    }

    if (state.flowActive) return;                 // matchflow.js is in charge
    if (pid < 0 || !state.players[pid] || !state.players[pid].isBot) return;
    if (setupWait < SETUP_FALLBACK_SEC) return;

    const dOpt = { d: difficultyParams() };
    if (state.setupNeed === 'settlement') {
      const iid = chooseSetupSettlement(state, pid, setupRng, dOpt);
      if (iid >= 0) setupPlaceSettlement(state, pid, iid);
    } else {
      const eid = chooseSetupRoad(state, pid, state.setupAnchor, setupRng, dOpt);
      if (eid >= 0) setupPlaceRoad(state, pid, eid);
    }
    setupWait = 0;
  }

  /* ----------------------------------------------------------- main update */

  function update(dt) {
    const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.1) : 1 / 60;

    // Re-read the level every step: the player chooses it on the title screen,
    // which is long after main.js built these brains, and may change it again
    // between matches without anything being rebuilt.
    const live = difficultyParams();
    const { k, panic } = rampAmounts();
    for (const b of brains) {
      // A seat running an explicit profile — the simulator's novice stand-in
      // for a human — never ramps: people do not suddenly get better at 5:00.
      b.d = b.profile ? difficultyParams(b.profile) : effectiveD(live, k, panic);
    }

    if (state.phase === 'setup') { driveSetup(step); return; }
    if (state.phase !== 'play') {
      for (const b of brains) coast(b, step);
      return;
    }

    for (const b of brains) {
      if (b.hold > 0) {
        b.hold -= step;
        if (b.hold <= 0 && (b.p.action === 'build' || b.p.action === 'trade')) {
          b.p.action = 'idle';
        }
      }
      b.sinceAct += step;

      driveGather(b);

      // Dithering: having just decided something, stand there and think about
      // it. Pickup is contact-based, so a paused bot still collects whatever it
      // is standing in — it simply stops making progress.
      if (b.pause > 0) {
        b.pause -= step;
        coast(b, step);
        continue;
      }

      b.think -= step;
      if (b.think <= 0) {
        b.think = (REPLAN_MIN + b.lag + b.rng() * REPLAN_SPREAD) * b.d.replan;
        const next = planFor(b);
        if (next) {
          const same = b.goal && next.kind === 'gather' && b.goal.kind === 'gather'
            && b.goal.tile === next.tile;
          if (!same) {
            b.goal = next; b.stuck = 0;
            if (b.d.hesitate > 0 && b.rng() < b.d.hesitate) {
              b.pause = b.d.pause * (0.35 + b.rng() * 0.65);
            }
          }
        } else if (!b.goal) {
          coast(b, step);
        }
      }

      runGoal(b, step);
    }
  }

  /** Wipe every per-match field, keeping the personalities. Used by the
   *  in-place restart in systems/flowRestart.js. */
  function reset() {
    const live = difficultyParams();
    brains.forEach((b, i) => {
      b.d = b.profile ? difficultyParams(b.profile) : live;
      b.pause = 0;
      b.goal = null;
      b.hold = 0;
      b.stuck = 0;
      b.sinceAct = 0;
      b.externalGather = false;
      b.lastKnight = -999;
      b.think = 0.15 + i * 0.17;
      b.avoidTiles.clear();
      b.avoidGoals.clear();
    });
    setupKey = ''; setupWait = 0;
  }

  /**
   * Re-read the chosen level. `update()` already does this every step, so this
   * exists purely so flowRestart.js can say what it means: a replay runs at the
   * difficulty in force now.
   */
  function applyDifficulty() {
    const live = difficultyParams();
    for (const b of brains) b.d = b.profile ? difficultyParams(b.profile) : live;
    return live.key;
  }

  return { update, reset, applyDifficulty, brains };
}

export default createBots;
