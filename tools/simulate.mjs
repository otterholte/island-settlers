/**
 * Island Settlers — headless match simulator.
 *
 *   node tools/simulate.mjs [--matches=30] [--seed=1] [--cap=420] [--verbose]
 *
 * Runs full bot-vs-bot matches at a fixed 1/60 s step with no renderer, using
 * the real rules.js. Seat 0 (normally the human) is handed one of the three
 * strategies, rotating between matches, so every strategy plays every seat.
 *
 * It also audits the bots: no settler may ever stand off the island, and no
 * player may ever gain a resource that is not accounted for by a `gained` or
 * `trade` event from rules.js.
 *
 * This tool is the pacing rig — keep it.
 */

import {
  createMatch, drainEvents, tickWorld, scoreOf,
  setupCurrentPlayer, setupPlaceSettlement, setupPlaceRoad,
  beginGather, tickGather
} from '../src/core/rules.js';
import { createBots, chooseSetupSettlement, chooseSetupRoad } from '../src/systems/bots.js';
import { PORT_SPOT_REACH } from '../src/systems/botBrain.js';
import { tileAt, ports } from '../src/board/layout.js';
import { mulberry32 } from '../src/board/nodes.js';
import {
  RES, MATCH_SOFT_CAP_SEC, BOT_PROFILES, TRADE_RADIUS, VICTORY_POINTS,
  GATHER_YIELD, GATHER_TIME, OWNERSHIP_MULT, COST, PIECE_LIMIT
} from '../src/core/constants.js';

/* ------------------------------------------------------------------- args */

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
}));

const MATCHES = Math.max(1, parseInt(args.matches ?? 30, 10));
const SEED0 = parseInt(args.seed ?? 1, 10);
const CAP = parseFloat(args.cap ?? MATCH_SOFT_CAP_SEC);
const VERBOSE = !!args.verbose;
// --draft=bots exercises the watchdog inside bots.js that covers for a missing
// matchflow.js. --gathersys stands in for systems/gathering.js so we can prove
// the bots defer harvest timing instead of double-ticking it.
const DRAFT_BY_BOTS = String(args.draft ?? 'flow') === 'bots';
const EXT_GATHER = !!args.gathersys;
const DT = 1 / 60;
const STRATS = BOT_PROFILES.map(b => b.strategy);          // expansion, cities, cards

/* ------------------------------------------------------- pacing experiments
 * These flags exist so the next tuning pass can measure a candidate economy
 * *before* anyone edits the frozen constants file. They mutate the exported
 * lookup tables in-process only; with no flags the simulator runs the shipped
 * numbers exactly. Nothing here touches src/.
 *   --vp=10       victory target (simulator keeps play alive past 7)
 *   --yield=0.5   scale GATHER_YIELD (floor 1)
 *   --gtime=1.6   scale GATHER_TIME
 *   --mult=1,2,3  OWNERSHIP_MULT none,settlement,city
 *   --cost=1.5    scale every COST entry (ceil)
 */
const VP_TARGET = Math.max(VICTORY_POINTS, parseInt(args.vp ?? VICTORY_POINTS, 10));
const TUNED = [];

if (args.yield) {
  const k = parseFloat(args.yield);
  for (const p of Object.keys(GATHER_YIELD)) {
    GATHER_YIELD[p] = Math.max(1, Math.round(GATHER_YIELD[p] * k));
  }
  TUNED.push(`GATHER_YIELD x${k} -> ${JSON.stringify(GATHER_YIELD)}`);
}
if (args.yieldset) {
  const v = String(args.yieldset).split(',').map(Number);
  for (let i = 1; i <= 5; i++) GATHER_YIELD[i] = v[i - 1];
  TUNED.push(`GATHER_YIELD -> ${JSON.stringify(GATHER_YIELD)}`);
}
if (args.gtimeset) {
  const v = String(args.gtimeset).split(',').map(Number);
  for (let i = 1; i <= 5; i++) GATHER_TIME[i] = v[i - 1];
  TUNED.push(`GATHER_TIME -> ${JSON.stringify(GATHER_TIME)}`);
}
if (args.gtime) {
  const k = parseFloat(args.gtime);
  for (const p of Object.keys(GATHER_TIME)) {
    GATHER_TIME[p] = Math.round(GATHER_TIME[p] * k * 100) / 100;
  }
  TUNED.push(`GATHER_TIME x${k} -> ${JSON.stringify(GATHER_TIME)}`);
}
if (args.mult) {
  const [a, b, c] = String(args.mult).split(',').map(Number);
  OWNERSHIP_MULT.none = a; OWNERSHIP_MULT.settlement = b; OWNERSHIP_MULT.city = c;
  TUNED.push(`OWNERSHIP_MULT -> ${JSON.stringify(OWNERSHIP_MULT)}`);
}
if (args.cost) {
  const k = parseFloat(args.cost);
  for (const kind of Object.keys(COST)) {
    for (const r of Object.keys(COST[kind])) COST[kind][r] = Math.ceil(COST[kind][r] * k);
  }
  TUNED.push(`COST x${k} -> ${JSON.stringify(COST)}`);
}
if (args.pieces) {
  const [r, s, c] = String(args.pieces).split(',').map(Number);
  PIECE_LIMIT.road = r; PIECE_LIMIT.settlement = s; PIECE_LIMIT.city = c;
  TUNED.push(`PIECE_LIMIT -> ${JSON.stringify(PIECE_LIMIT)}`);
}
if (VP_TARGET !== VICTORY_POINTS) TUNED.push(`VICTORY_POINTS -> ${VP_TARGET}`);

/* ------------------------------------------------------------- world stub */

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
  effects: { burst: noop, floatText: noop, ring: noop, shockwave: noop, update: noop },
  audio: { sfx: noop, music: noop, ambience: noop, unlock: noop }
};

/* ---------------------------------------------------------------- helpers */

const fmt = (n, d = 1) => Number(n).toFixed(d);
const pct = (n, total) => total ? `${fmt(n / total * 100, 0)}%` : '0%';

function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

function table(headers, rows) {
  const all = [headers, ...rows];
  const w = headers.map((_, c) => Math.max(...all.map(r => String(r[c]).length)));
  const line = (r, pad = ' ') => r.map((v, c) =>
    (c === 0 ? String(v).padEnd(w[c], pad) : String(v).padStart(w[c], pad))).join('  ');
  return [line(headers), line(w.map(n => '-'.repeat(n)), '-'), ...rows.map(r => line(r))]
    .join('\n');
}

/* When systems/gathering.js is present we drive the real thing, which is the
   strongest available test of the `gatherIntent` contract. If it is missing
   (parallel work not landed yet) we fall back to the minimal stub below. */
let createGathering = null;
if (EXT_GATHER) {
  try {
    ({ createGathering } = await import('../src/systems/gathering.js'));
  } catch (e) {
    console.log(`  (systems/gathering.js unavailable — using stub: ${e.message})`);
  }
}

/** Stand-in for systems/gathering.js — consumes gatherIntent, owns the clock. */
function externalGathering(st, dt) {
  for (const p of st.players) {
    if (p.gatherIntent && p.action !== 'gather') {
      beginGather(st, p.id, p.gatherIntent);
      p.gatherIntent = null;
    }
    if (p.action === 'gather') tickGather(st, p.id, dt);
  }
}

/* ----------------------------------------------------------------- audit */

const problems = [];
function flag(msg) {
  if (problems.length < 40) problems.push(msg);
}

/* ------------------------------------------------------------ one match */

function runMatch(index) {
  const seed = SEED0 * 1013 + index * 7919;
  const state = createMatch({ seed });
  state.botSeed = seed ^ 0x51f3a2;

  // Seat 0 becomes a bot too — rotate its strategy so seats stay fair.
  const seat0 = STRATS[index % STRATS.length];
  state.players[0].isBot = true;
  state.players[0].strategy = seat0;
  state.players[0].name = `Bot0/${seat0}`;

  const draftRng = mulberry32(seed ^ 0x2545f491);
  const bots = createBots(state, world, { seed: state.botSeed });
  const gathering = EXT_GATHER && createGathering ? createGathering(state, world) : null;

  /* ---- opening snake draft (what matchflow.js will drive in the game) --- */
  let setupFrames = 0;
  if (DRAFT_BY_BOTS) {
    // No flow module at all: bots.js must notice and finish the draft itself.
    while (state.phase === 'setup' && setupFrames++ < 60 * 300) bots.update(DT);
  } else {
    let guard = 0;
    while (state.phase === 'setup' && guard++ < 64) {
      const pid = setupCurrentPlayer(state);
      if (pid < 0) break;
      if (state.setupNeed === 'settlement') {
        const iid = chooseSetupSettlement(state, pid, draftRng);
        if (iid < 0 || !setupPlaceSettlement(state, pid, iid)) {
          flag(`match ${index}: draft settlement failed for p${pid}`);
          break;
        }
      } else {
        const eid = chooseSetupRoad(state, pid, state.setupAnchor, draftRng);
        if (eid < 0 || !setupPlaceRoad(state, pid, eid)) {
          flag(`match ${index}: draft road failed for p${pid}`);
          break;
        }
      }
    }
  }
  if (state.phase !== 'play') {
    flag(`match ${index}: draft did not complete (phase=${state.phase})`);
    return null;
  }
  drainEvents(state);

  const draftPips = state.players.map(p =>
    [...p.settlements].length ? 0 : 0);   // placeholder, filled below via score

  /* ------------------------------------------------------------ the match */
  const awards = { longestRoad: 0, largestArmy: 0 };
  const tradesAt = { market: 0, port: 0 };
  let frames = 0;
  let botMs = 0;
  let offIsland = 0;

  const before = state.players.map(p => ({ ...p.res }));

  while (state.time < CAP) {
    if (state.phase === 'over') {
      // Simulator-side victory target: keep playing until somebody clears it.
      const top = state.players.reduce((a, p) => Math.max(a, scoreOf(state, p)), 0);
      if (top >= VP_TARGET) break;
      state.phase = 'play';
      state.winner = -1;
    } else if (state.phase !== 'play') break;

    tickWorld(state, DT);

    for (let i = 0; i < state.players.length; i++) {
      const r = state.players[i].res;
      const b = before[i];
      for (const k of RES) b[k] = r[k];
    }

    if (gathering) gathering.update(DT);          // real systems/gathering.js
    else if (EXT_GATHER) externalGathering(state, DT);

    const t0 = process.hrtime.bigint();
    bots.update(DT);
    botMs += Number(process.hrtime.bigint() - t0) / 1e6;
    frames++;

    /* --- audit: resource conservation --- */
    const expect = state.players.map(() => ({ wood: 0, brick: 0, wool: 0, wheat: 0, ore: 0 }));
    for (const ev of drainEvents(state)) {
      if (ev.type === 'gained') expect[ev.player][ev.resource] += ev.amount;
      else if (ev.type === 'trade') {
        expect[ev.player][ev.get] += 1;
        if (ports.some(p => p.ratio === ev.ratio && p.ratio < 4)) tradesAt.port++;
        else tradesAt.market++;
      } else if (ev.type === 'award') awards[ev.kind]++;
      else if (ev.type === 'awardLost') awards[ev.kind]++;
    }
    for (let i = 0; i < state.players.length; i++) {
      const r = state.players[i].res;
      for (const k of RES) {
        const delta = r[k] - before[i][k];
        if (delta > expect[i][k] + 1e-9) {
          flag(`match ${index} t=${fmt(state.time)}: p${i} gained ${delta} ${k} ` +
               `but events only justify ${expect[i][k]}`);
        }
        if (r[k] < -1e-9) flag(`match ${index}: p${i} negative ${k} (${r[k]})`);
      }
    }

    /* --- audit: everybody on land --- */
    for (const p of state.players) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.z) || !tileAt(p.x, p.z)) {
        offIsland++;
        if (offIsland === 1) {
          flag(`match ${index} t=${fmt(state.time)}: p${p.id} off island ` +
               `at ${fmt(p.x)},${fmt(p.z)}`);
        }
      }
    }
  }

  if (EXT_GATHER) {
    for (const b of bots.brains) {
      if (!b.externalGather && state.players[b.pid].stats.gathered > 0) {
        flag(`match ${index}: p${b.pid} kept driving tickGather itself even ` +
             `though an external gathering system was running`);
      }
    }
  }

  let finished = state.phase === 'over';
  if (finished) {
    // With a raised target the winner is whoever actually cleared it.
    let bi = -1, bs = -Infinity;
    for (const p of state.players) {
      const s = scoreOf(state, p);
      if (s > bs) { bs = s; bi = p.id; }
    }
    if (bs < VP_TARGET) finished = false; else state.winner = bi;
  }
  const rows = state.players.map(p => ({
    id: p.id,
    strategy: p.strategy,
    vp: scoreOf(state, p),
    settlements: p.settlements.size,
    cities: p.cities.size,
    vpCards: p.vpCards,
    awardVp: (p.hasLongestRoad ? 2 : 0) + (p.hasLargestArmy ? 2 : 0),
    longestRoad: p.longestRoadLen,
    knights: p.knightsPlayed,
    gathered: p.stats.gathered,
    traded: p.stats.traded,
    built: p.stats.built,
    cardsPlayed: p.stats.cardsPlayed,
    roads: p.roads.size,
    distance: p.stats.distance
  }));

  return {
    index, seed, finished,
    duration: state.time,
    winner: finished ? state.winner : -1,
    winStrategy: finished ? state.players[state.winner].strategy : null,
    rows, awards, tradesAt, frames,
    msPerFrame: frames ? botMs / frames : 0,
    offIsland,
    draftPips
  };
}

/* --------------------------------------------------------------- run all */

console.log(`Island Settlers — bot simulation: ${MATCHES} matches, ` +
            `dt=1/60, cap=${CAP}s, seed=${SEED0}, target=${VP_TARGET} VP`);
if (TUNED.length) {
  console.log('EXPERIMENTAL ECONOMY (simulator-side overrides, src/ untouched):');
  for (const t of TUNED) console.log('  ' + t);
}
console.log('');

const results = [];
const t0 = Date.now();
for (let i = 0; i < MATCHES; i++) {
  const r = runMatch(i);
  if (r) results.push(r);
  if (VERBOSE && r) {
    console.log(`  #${String(i).padStart(2)}  ${fmt(r.duration)}s  ` +
      `win=${r.winStrategy ?? 'NONE'}  ` +
      r.rows.map(x => `${x.strategy.slice(0, 3)}:${x.vp}`).join(' '));
  }
}
const wall = (Date.now() - t0) / 1000;

/* ---------------------------------------------------------------- report */

const done = results.filter(r => r.finished);
const durations = done.map(r => r.duration).sort((a, b) => a - b);
const unfinished = results.filter(r => !r.finished);

console.log('=== MATCH DURATION (finished matches) ===');
if (durations.length) {
  console.log(table(
    ['stat', 'seconds'],
    [
      ['min', fmt(durations[0])],
      ['p25', fmt(quantile(durations, 0.25))],
      ['median', fmt(quantile(durations, 0.5))],
      ['p75', fmt(quantile(durations, 0.75))],
      ['max', fmt(durations[durations.length - 1])],
      ['mean', fmt(durations.reduce((s, d) => s + d, 0) / durations.length)],
      ['in 180-300s band', `${done.filter(r => r.duration >= 180 && r.duration <= 300).length}/${done.length}`],
      ['under 180s', String(done.filter(r => r.duration < 180).length)],
      ['over 300s', String(done.filter(r => r.duration > 300).length)]
    ]
  ));
} else {
  console.log('  no match finished');
}

console.log('\n=== WINS BY STRATEGY ===');
{
  const seats = {}, wins = {};
  for (const s of STRATS) { seats[s] = 0; wins[s] = 0; }
  for (const r of results) {
    for (const row of r.rows) seats[row.strategy]++;
    if (r.winStrategy) wins[r.winStrategy]++;
  }
  console.log(table(
    ['strategy', 'seats', 'wins', 'win rate', 'expected'],
    STRATS.map(s => [
      s, seats[s], wins[s],
      pct(wins[s], done.length),
      pct(seats[s] / 4, done.length)
    ])
  ));
}

console.log('\n=== AVERAGE END-OF-MATCH VP BREAKDOWN (per player, all seats) ===');
{
  const acc = {};
  for (const s of STRATS) {
    acc[s] = { n: 0, vp: 0, set: 0, cit: 0, awd: 0, vpc: 0, lr: 0, kn: 0 };
  }
  for (const r of results) for (const row of r.rows) {
    const a = acc[row.strategy];
    a.n++; a.vp += row.vp; a.set += row.settlements; a.cit += row.cities;
    a.awd += row.awardVp; a.vpc += row.vpCards; a.lr += row.longestRoad; a.kn += row.knights;
  }
  console.log(table(
    ['strategy', 'VP', 'settle', 'cities', 'awardVP', 'VPcards', 'roadLen', 'knights'],
    STRATS.map(s => {
      const a = acc[s];
      return [s, fmt(a.vp / a.n, 2), fmt(a.set / a.n, 2), fmt(a.cit / a.n, 2),
              fmt(a.awd / a.n, 2), fmt(a.vpc / a.n, 2), fmt(a.lr / a.n, 2),
              fmt(a.kn / a.n, 2)];
    })
  ));
}

console.log('\n=== AWARD CHURN (times an award changed hands per match) ===');
{
  const lr = results.reduce((s, r) => s + r.awards.longestRoad, 0) / results.length;
  const la = results.reduce((s, r) => s + r.awards.largestArmy, 0) / results.length;
  const lrAny = results.filter(r => r.awards.longestRoad > 0).length;
  const laAny = results.filter(r => r.awards.largestArmy > 0).length;
  console.log(table(
    ['award', 'avg changes/match', 'matches where claimed'],
    [
      ['Longest Road', fmt(lr, 2), `${lrAny}/${results.length}`],
      ['Largest Army', fmt(la, 2), `${laAny}/${results.length}`]
    ]
  ));
}

console.log('\n=== PER-BOT ACTIVITY (average per match) ===');
{
  const acc = {};
  for (const s of STRATS) {
    acc[s] = { n: 0, g: 0, t: 0, cp: 0, b: 0, rd: 0, d: 0 };
  }
  for (const r of results) for (const row of r.rows) {
    const a = acc[row.strategy];
    a.n++; a.g += row.gathered; a.t += row.traded; a.cp += row.cardsPlayed;
    a.b += row.built; a.rd += row.roads; a.d += row.distance;
  }
  console.log(table(
    ['strategy', 'gathered', 'trades', 'cards played', 'pieces built', 'roads', 'metres run'],
    STRATS.map(s => {
      const a = acc[s];
      return [s, fmt(a.g / a.n, 1), fmt(a.t / a.n, 2), fmt(a.cp / a.n, 2),
              fmt(a.b / a.n, 2), fmt(a.rd / a.n, 2), fmt(a.d / a.n, 0)];
    })
  ));
}

console.log('\n=== COST / SAFETY ===');
{
  const ms = results.reduce((s, r) => s + r.msPerFrame, 0) / results.length;
  const worst = Math.max(...results.map(r => r.msPerFrame));
  const off = results.reduce((s, r) => s + r.offIsland, 0);
  const trades = results.reduce((s, r) => s + r.tradesAt.market + r.tradesAt.port, 0);
  const portTrades = results.reduce((s, r) => s + r.tradesAt.port, 0);
  console.log(table(
    ['metric', 'value'],
    [
      ['bots.update avg ms/frame (4 bots)', fmt(ms, 4)],
      ['worst match avg ms/frame', fmt(worst, 4)],
      ['off-island player-frames', String(off)],
      ['unexplained resource gains', String(problems.filter(p => p.includes('gained')).length)],
      ['port-rate trades / all trades', `${portTrades}/${trades}`],
      ['port stand-spot max reach', fmt(Math.max(...PORT_SPOT_REACH), 2) +
        ` (limit ${TRADE_RADIUS})`],
      ['matches over cap', `${unfinished.length}/${results.length}`],
      ['wall clock', `${fmt(wall, 1)}s`]
    ]
  ));
}

if (unfinished.length) {
  console.log('\n!!! MATCHES THAT HIT THE SOFT CAP:');
  for (const r of unfinished) {
    console.log(`  match ${r.index} (seed ${r.seed}) stalled at ${fmt(r.duration)}s — ` +
      r.rows.map(x => `${x.strategy.slice(0, 3)} vp${x.vp} b${x.built} g${x.gathered}`).join(' | '));
  }
}

if (problems.length) {
  console.log('\n!!! AUDIT PROBLEMS:');
  for (const p of problems) console.log('  ' + p);
}

const bad = unfinished.length + problems.length;
console.log(bad
  ? `\n${bad} issue(s).`
  : `\nAll ${results.length} matches finished cleanly; no audit violations.`);
process.exit(bad ? 1 : 0);
