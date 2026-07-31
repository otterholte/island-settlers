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
  BOT_SPEED, INTERACT_RADIUS, TRADE_RADIUS, PIECE_LIMIT,
  COST, canAfford
} from '../core/constants.js';

import { clampToIsland, MARKET } from '../board/layout.js';

import { mulberry32 } from '../board/nodes.js';

import {
  placeRoad, placeSettlement, upgradeCity, drawCard,
  playKnight, playRoadBuilding, doTrade, beginGather, tickGather,
  legalRoads, setupCurrentPlayer,
  setupPlaceSettlement, setupPlaceRoad
} from '../core/rules.js';

import {
  choosePurchase, chooseRoad, planGather, planTrade, knightTarget, wantsKnight,
  productionOf, affinityOf, needWeights, chooseNode,
  chooseSetupSettlement, chooseSetupRoad,
  INTERSECTION_SPOT, MARKET_SPOT
} from './botBrain.js';

export { chooseSetupSettlement, chooseSetupRoad };

/* ------------------------------------------------------------------ tuning */

const BOT_ACCEL = 55.0;            // slightly softer than the human's 60
const RUN_THRESHOLD = 0.6;
const ARRIVE_BUILD = 1.5;
const ARRIVE_GATHER = INTERACT_RADIUS * 0.78;
const LATCH_SPEED = 1.4;           // must be nearly stopped to latch, as p0 is
const ACTION_HOLD = 0.42;          // seconds a build/trade pose is held
const REPLAN_MIN = 0.42;
const REPLAN_SPREAD = 0.34;
const STUCK_SEC = 2.2;
const BLACKLIST_SEC = 9.0;
const DESPERATE_SEC = 18.0;
const SETUP_FALLBACK_SEC = 3.5;    // only fires if matchflow.js never shows up
const INTENT_GRACE = 0.09;         // let gathering.js consume gatherIntent first

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

/* ==================================================================== bots */

export function createBots(state, world, opts = {}) {
  const seed = (opts.seed ?? state.botSeed ?? 0x5eed1e) >>> 0;

  const brains = state.players.filter(p => p.isBot).map((p, i) => {
    const rng = mulberry32(seed + p.id * 9176 + 17);
    return {
      pid: p.id,
      p,
      rng,
      // A little personality so the three never move in lockstep.
      lag: 0.06 + rng() * 0.22,
      speedScale: 0.93 + rng() * 0.07,
      noise: 0.8 + rng() * 0.7,
      think: 0.15 + i * 0.17 + rng() * 0.2,
      goal: null,
      hold: 0,
      stuck: 0,
      sinceAct: 0,
      avoidNodes: new Map(),
      avoidGoals: new Map(),
      watchProgress: -1,
      externalGather: false,
      intentAge: 0,
      lastKnight: -999
    };
  });

  // Setup-draft watchdog: only ever fires when matchflow.js is absent.
  let setupKey = '';
  let setupWait = 0;
  const setupRng = mulberry32(seed ^ 0x9e3779b9);

  /* ------------------------------------------------------------ utilities */

  const jitterFor = b => (amp) => (b.rng() - 0.5) * amp * b.noise;

  function liveAvoid(b, map) {
    const out = new Set();
    for (const [k, until] of map) {
      if (state.time >= until) map.delete(k); else out.add(k);
    }
    return out;
  }

  function blacklistNode(b, id) { b.avoidNodes.set(id, state.time + BLACKLIST_SEC); }
  function blacklistGoal(b, key) { b.avoidGoals.set(key, state.time + BLACKLIST_SEC); }

  function stopGathering(p) {
    if (p.action === 'gather') { p.action = 'idle'; }
    p.gatherNode = null;
    p.gatherProgress = 0;
    p.gatherIntent = null;
  }

  function noteAct(b) { b.sinceAct = 0; b.think = 0.05 + b.rng() * 0.12; }

  /* ------------------------------------------------------------- planning */

  function planFor(b) {
    const p = b.p;
    const jitter = jitterFor(b);
    const ctx = { aff: affinityOf(p.strategy), prod: productionOf(state, p.id), jitter };
    const avoidN = liveAvoid(b, b.avoidNodes);
    const avoidG = liveAvoid(b, b.avoidGoals);
    const desperate = b.sinceAct > DESPERATE_SEC;

    /* --- spend Road Building charges first --- */
    if ((p.freeRoads || 0) > 0 && p.roads.size < PIECE_LIMIT.road) {
      const rd = bestRoadTarget(b, ctx, avoidG);
      if (rd) return { kind: 'build', what: 'road', target: rd.id, free: true,
                       tx: rd.spot.x, tz: rd.spot.z, arrive: ARRIVE_BUILD };
      p.freeRoads = 0;                       // nowhere legal left to put them
    }

    /* --- card plays are instant, no travel --- */
    if (wantsKnight(state, p.id, state.time - b.lastKnight)) {
      const kt = knightTarget(state, p.id);
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
    // for a while we instead take whatever we can complete soonest.
    const ranked = desperate ? options.slice(0, 3) : [options[0]];
    let best = null;
    for (const o of ranked) {
      const route = routeFor(b, o, avoidN);
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
    const n = route.pick.node;
    return { kind: 'gather', node: n, tx: n.x, tz: n.z, arrive: ARRIVE_GATHER };
  }

  const goalKey = o => `${o.kind}:${o.target}`;

  function bestRoadTarget(b, ctx, avoidG) {
    const legal = legalRoads(state, b.pid).filter(e => !avoidG.has(`road:${e}`));
    if (!legal.length) return null;
    return chooseRoad(state, b.pid, b.p.x, b.p.z, { ...ctx, legalRoads: legal });
  }

  /** How do we get from "want it" to "have it"? */
  function routeFor(b, o, avoidN) {
    const p = b.p;
    const cost = COST[o.kind];
    if (canAfford(p.res, cost)) return { kind: 'ready', eta: travelEta(b, o) };

    const g = planGather(state, p.id, cost, p.x, p.z, avoidN);
    const t = planTrade(state, p.id, cost, p.x, p.z);
    if (g && (!t || g.eta <= t.eta * 1.05)) return { kind: 'gather', eta: g.eta, pick: g.first };
    if (t) return { kind: 'trade', eta: t.eta, plan: t };
    if (g) return { kind: 'gather', eta: g.eta, pick: g.first };
    return null;
  }

  function travelEta(b, o) {
    const s = o.spot || MARKET_SPOT;
    return dist(b.p.x, b.p.z, s.x, s.z) / BOT_SPEED;
  }

  function gatherFallback(b, avoidN) {
    const pick = chooseNode(state, b.pid, needWeights(state, b.pid, null),
                            b.p.x, b.p.z, avoidN);
    if (!pick) return null;
    const n = pick.node;
    return { kind: 'gather', node: n, tx: n.x, tz: n.z, arrive: ARRIVE_GATHER };
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
    if (g.kind === 'gather') {
      if (p.action === 'gather' && p.gatherNode) {
        if (p.gatherNode.id !== g.node.id) { b.goal = null; return; }
        // Planted at the node. gathering.js owns `p.action` from here; we must
        // not write 'run' or the harvest is cancelled out from under it.
        p.vx = 0; p.vz = 0;
        p.gatherIntent = g.node;                  // hold the lease
        return;
      }
      if (g.node.remaining <= 0) { b.goal = null; b.think = 0; return; }

      const d = steer(b, g.tx, g.tz, dt);
      if (d <= g.arrive && Math.hypot(p.vx, p.vz) < LATCH_SPEED) {
        p.gatherIntent = g.node;
        b.intentAge += dt;
        if (b.intentAge > INTENT_GRACE && p.action !== 'gather') {
          if (!beginGather(state, p.id, g.node)) {
            blacklistNode(b, g.node.id);
            p.gatherIntent = null;
            b.goal = null; b.think = 0;
          } else {
            noteAct(b);
          }
          b.intentAge = 0;
        }
      } else {
        b.intentAge = 0;
      }
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
      const sp = BOT_SPEED * b.speedScale * ease;
      tvx = (dx / d) * sp; tvz = (dz / d) * sp;
    }
    applyVelocity(b, tvx, tvz, dt, true);

    // Stall detection: wanted to move, barely did.
    const spd = Math.hypot(p.vx, p.vz);
    if (d > (b.goal ? b.goal.arrive : 1.5) && spd < 1.2) {
      b.stuck += dt;
      if (b.stuck > STUCK_SEC) {
        if (b.goal && b.goal.kind === 'gather') blacklistNode(b, b.goal.node.id);
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
    const maxDelta = BOT_ACCEL * dt * (tvx || tvz ? 1 : 1.7);
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

    // `p.action` belongs to gathering.js while a harvest runs, so we only ever
    // claim it when we are genuinely under power and genuinely moving.
    if (moving && spd > RUN_THRESHOLD && moved > 1e-5) {
      if (p.action === 'gather') stopGathering(p);
      if (b.hold <= 0) p.action = 'run';
    } else if (p.action === 'run' && b.hold <= 0 && spd <= RUN_THRESHOLD) {
      p.action = 'idle';
    }
  }

  /* --------------------------------------------------------- gather ticks */

  /**
   * `gathering.js` owns harvest timing when it is present. We watch
   * `gatherProgress`; the moment somebody else advances it we stop ticking and
   * defer forever. Without that module the bots drive `tickGather` themselves
   * so a headless match still resolves. Either way the resources come from
   * rules.js.
   */
  function driveGather(b, dt) {
    const p = b.p;
    if (p.action !== 'gather' || !p.gatherNode) { b.watchProgress = -1; return; }
    if (b.watchProgress >= 0 && Math.abs(p.gatherProgress - b.watchProgress) > 1e-9) {
      b.externalGather = true;
    }
    if (!b.externalGather) tickGather(state, p.id, dt);
    b.watchProgress = p.action === 'gather' ? p.gatherProgress : -1;
    if (p.gatherNode === null) b.goal = null;
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

    if (state.setupNeed === 'settlement') {
      const iid = chooseSetupSettlement(state, pid, setupRng);
      if (iid >= 0) setupPlaceSettlement(state, pid, iid);
    } else {
      const eid = chooseSetupRoad(state, pid, state.setupAnchor, setupRng);
      if (eid >= 0) setupPlaceRoad(state, pid, eid);
    }
    setupWait = 0;
  }

  /* ----------------------------------------------------------- main update */

  function update(dt) {
    const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.1) : 1 / 60;

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

      driveGather(b, step);

      b.think -= step;
      if (b.think <= 0) {
        b.think = REPLAN_MIN + b.lag + b.rng() * REPLAN_SPREAD;
        const next = planFor(b);
        if (next) {
          const same = b.goal && next.kind === 'gather' && b.goal.kind === 'gather'
            && b.goal.node.id === next.node.id;
          if (!same) {
            if (b.p.action === 'gather' && !(next.kind === 'gather'
                && b.p.gatherNode && b.p.gatherNode.id === next.node.id)) {
              stopGathering(b.p);
            }
            b.goal = next;
            b.stuck = 0;
          }
        } else if (!b.goal) {
          coast(b, step);
        }
      }

      runGoal(b, step);
    }
  }

  return { update, brains };
}

export default createBots;
