/**
 * Island Settlers — headless match simulator.
 *
 *   node tools/simulate.mjs [--matches=30] [--seed=1] [--cap=420] [--verbose]
 *                          [--difficulty=easy|medium|hard|expert] [--novice]
 *
 * Runs full bot-vs-bot matches at a fixed 1/60 s step with no renderer, using
 * the real rules.js. Seat 0 (normally the human) is handed one of the three
 * strategies, rotating between matches, so every strategy plays every seat.
 *
 * `--difficulty` sets the level every bot plays at, exactly as the title screen
 * would. `--novice` additionally drops seat 0 onto the deliberately mediocre
 * "novice" policy from difficulty.js — the stand-in for a human who is still
 * learning — and the report then shows seat 0's win rate, which is the closest
 * this rig can get to "is this level beatable?".
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
  sweepPickups, playerOwnsTile, ownedTiles
} from '../src/core/rules.js';
import { createBots, chooseSetupSettlement, chooseSetupRoad } from '../src/systems/bots.js';
import { PORT_SPOT_REACH } from '../src/systems/botBrain.js';
import {
  setDifficulty, getDifficulty, difficultyParams, LEVELS, DIFFICULTY_ORDER
} from '../src/systems/difficulty.js';
import {
  tileAt, ports, tiles, reshuffle, currentViolations, LAYOUT_SEED
} from '../src/board/layout.js';
import { mulberry32, tileItemCount } from '../src/board/nodes.js';
import {
  RES, MATCH_SOFT_CAP_SEC, BOT_PROFILES, TRADE_RADIUS, VICTORY_POINTS,
  TILE_ITEMS, TILE_REGEN, PICKUP_RADIUS, START_RESOURCES, COST, PIECE_LIMIT
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
// The board is shuffled per match (board/shuffle.js), so a run of 30 matches is
// 30 different islands and the duration spread is honest about board variance.
//   --board=<seed>   pin every match to one island (A/B a tuning change)
//   --board=off      same thing, using whatever island the process loaded with
const BOARD_ARG = args.board === undefined ? null : String(args.board);
const FIXED_BOARD = BOARD_ARG !== null;
const boardSeed = Number.isFinite(Number(BOARD_ARG))
  ? (Number(BOARD_ARG) >>> 0) : (LAYOUT_SEED >>> 0);
const DT = 1 / 60;
const STRATS = BOT_PROFILES.map(b => b.strategy);          // expansion, cities, cards

/* ------------------------------------------------------------- difficulty */

const DIFF = String(args.difficulty ?? getDifficulty());
if (!DIFFICULTY_ORDER.includes(DIFF)) {
  console.error(`unknown --difficulty=${DIFF} (want ${DIFFICULTY_ORDER.join('|')})`);
  process.exit(2);
}
setDifficulty(DIFF);

// Seat 0 is the human's chair. `--novice` puts the mediocre-player policy in
// it; without the flag seat 0 is just another bot at the chosen level.
const NOVICE = !!args.novice;
const SEAT0 = NOVICE ? 'novice' : DIFF;

// --dset=speed=0.8,replan=1.4 retunes the level in-process (--nset does the
// same to the novice policy), the same way the economy flags below do, so a
// tuning pass can sweep before editing src/.
let TUNED_D = '';
function retune(levelKey, spec) {
  const L = LEVELS[levelKey];
  for (const part of String(spec).split(',')) {
    const m = /^([a-zA-Z]+)=(-?[\d.]+)$/.exec(part.trim());
    if (m && m[1] in L) L[m[1]] = Number(m[2]);
  }
  TUNED_D += `\n  ${levelKey}: ` + Object.entries(L)
    .filter(([, v]) => typeof v === 'number').map(([k, v]) => `${k}=${v}`).join(' ');
}
if (args.dset) retune(DIFF, args.dset);
if (args.nset) retune('novice', args.nset);

/* ------------------------------------------------------- pacing experiments
 * These flags exist so a tuning pass can measure a candidate economy *before*
 * anyone edits constants.js. They mutate the exported lookup tables in-process
 * only; with no flags the simulator runs the shipped numbers exactly. Nothing
 * here touches src/.
 *   --vp=10             victory target (simulator keeps play alive past it)
 *   --items=1.3         scale TILE_ITEMS (round, floor 1)
 *   --itemset=8,11,...  TILE_ITEMS for pips 1..5 outright
 *   --regen=1.4         scale TILE_REGEN
 *   --regenset=30,...   TILE_REGEN for pips 1..5 outright
 *   --cost=1.5          scale every COST entry (ceil)
 *   --start=1.5         scale START_RESOURCES (round)
 *   --pieces=r,s,c      PIECE_LIMIT
 */
const VP_TARGET = Math.max(VICTORY_POINTS, parseInt(args.vp ?? VICTORY_POINTS, 10));
const TUNED = [];

if (args.items) {
  const k = parseFloat(args.items);
  for (const p of Object.keys(TILE_ITEMS)) {
    TILE_ITEMS[p] = Math.max(1, Math.round(TILE_ITEMS[p] * k));
  }
  TUNED.push(`TILE_ITEMS x${k} -> ${JSON.stringify(TILE_ITEMS)}`);
}
if (args.itemset) {
  const v = String(args.itemset).split(',').map(Number);
  for (let i = 1; i <= 5; i++) TILE_ITEMS[i] = v[i - 1];
  TUNED.push(`TILE_ITEMS -> ${JSON.stringify(TILE_ITEMS)}`);
}
if (args.regen) {
  const k = parseFloat(args.regen);
  for (const p of Object.keys(TILE_REGEN)) {
    TILE_REGEN[p] = Math.round(TILE_REGEN[p] * k * 10) / 10;
  }
  TUNED.push(`TILE_REGEN x${k} -> ${JSON.stringify(TILE_REGEN)}`);
}
if (args.regenset) {
  const v = String(args.regenset).split(',').map(Number);
  for (let i = 1; i <= 5; i++) TILE_REGEN[i] = v[i - 1];
  TUNED.push(`TILE_REGEN -> ${JSON.stringify(TILE_REGEN)}`);
}
if (args.start) {
  const k = parseFloat(args.start);
  for (const r of Object.keys(START_RESOURCES)) {
    START_RESOURCES[r] = Math.max(0, Math.round(START_RESOURCES[r] * k));
  }
  TUNED.push(`START_RESOURCES x${k} -> ${JSON.stringify(START_RESOURCES)}`);
}
if (args.costs) {
  // --costs=city.ore=4,city.wheat=3 — surgical, unlike the blanket --cost.
  for (const part of String(args.costs).split(',')) {
    const m = /^([a-z]+)\.([a-z]+)=(\d+)$/.exec(part.trim());
    if (m && COST[m[1]]) COST[m[1]][m[2]] = Number(m[3]);
  }
  TUNED.push(`COST -> ${JSON.stringify(COST)}`);
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

/** Stand-in for systems/gathering.js — sweeps every settler's contact pickup
 *  first, so the bots' own call is the one that gets refused. */
function externalGathering(st) {
  for (const p of st.players) sweepPickups(st, p.id);
}

/* ----------------------------------------------------------------- audit */

const problems = [];
function flag(msg) {
  if (problems.length < 40) problems.push(msg);
}

/* ------------------------------------------------------------ one match */

function runMatch(index) {
  const seed = SEED0 * 1013 + index * 7919;

  // Deal a fresh island first: reshuffle() re-dresses the tiles and docks in
  // place and re-tags the item fields, and createMatch() below then resets the
  // node state on top of it. There is no world layer here to rebuild.
  const board = reshuffle(FIXED_BOARD ? boardSeed : (seed ^ 0x5bf03635));
  if (!board.fair) {
    flag(`match ${index}: board seed ${board.seed} fell back to a relaxed layout ` +
         `(${board.violations.map(v => v.rule).join(',')})`);
  }
  const late = currentViolations();
  if (late.length) {
    flag(`match ${index}: live board violates ${late.map(v => v.rule).join(',')}`);
  }

  const state = createMatch({ seed });
  state.botSeed = seed ^ 0x51f3a2;

  // Seat 0 becomes a bot too — rotate its strategy so seats stay fair.
  const seat0 = STRATS[index % STRATS.length];
  state.players[0].isBot = true;
  state.players[0].strategy = seat0;
  state.players[0].name = `Bot0/${seat0}`;

  const draftRng = mulberry32(seed ^ 0x2545f491);
  const bots = createBots(state, world, {
    seed: state.botSeed,
    profiles: NOVICE ? { 0: 'novice' } : {}
  });
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
      // Seat 0 drafts on its own policy — a novice picks its opening corners
      // about as well as it plays the rest of the match.
      const dOpt = { d: difficultyParams(pid === 0 ? SEAT0 : DIFF) };
      if (state.setupNeed === 'settlement') {
        const iid = chooseSetupSettlement(state, pid, draftRng, dOpt);
        if (iid < 0 || !setupPlaceSettlement(state, pid, iid)) {
          flag(`match ${index}: draft settlement failed for p${pid}`);
          break;
        }
      } else {
        const eid = chooseSetupRoad(state, pid, state.setupAnchor, draftRng, dOpt);
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
  let exhausted = 0, restored = 0;
  const gathered = state.players.map(() => 0);

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
    else if (EXT_GATHER) externalGathering(state);

    const t0 = process.hrtime.bigint();
    bots.update(DT);
    botMs += Number(process.hrtime.bigint() - t0) / 1e6;
    frames++;

    /* --- audit: resource conservation --- */
    const expect = state.players.map(() => ({ wood: 0, brick: 0, wool: 0, wheat: 0, ore: 0 }));
    const frameEvents = drainEvents(state);
    // A Knight played later in the same frame moves the Raider under a pickup
    // that was legal when it happened; don't misread that as a rules breach.
    const raiderMoved = frameEvents.some(e => e.type === 'knight');
    for (const ev of frameEvents) {
      if (ev.type === 'gained') {
        expect[ev.player][ev.resource] += ev.amount;
        // Ownership is a hard gate: nothing may ever be picked up off a hex the
        // player has no settlement or city on.
        if (!playerOwnsTile(state, ev.player, ev.tile)) {
          flag(`match ${index} t=${fmt(state.time)}: p${ev.player} collected ` +
               `${ev.resource} on tile ${ev.tile}, which they do not own`);
        }
        if (!raiderMoved && state.robberTile === ev.tile && state.robberOwner !== ev.player) {
          flag(`match ${index} t=${fmt(state.time)}: p${ev.player} collected on ` +
               `tile ${ev.tile} while the Raider blocked it`);
        }
        gathered[ev.player]++;
      } else if (ev.type === 'exhausted') exhausted++;
      else if (ev.type === 'restored') restored++;
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
    tilesOwned: ownedTiles(state, p.id).size,
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
    boardSeed: board.seed,
    boardPrint: tiles.map(t => `${t.terrain}${t.number}`).join('|'),
    boardAttempts: board.attempts,
    openingSpread: board.openingSpread,
    duration: state.time,
    winner: finished ? state.winner : -1,
    winStrategy: finished ? state.players[state.winner].strategy : null,
    rows, awards, tradesAt, frames,
    msPerFrame: frames ? botMs / frames : 0,
    offIsland, exhausted, restored,
    draftPips
  };
}

/* --------------------------------------------------------------- run all */

console.log(`Island Settlers — bot simulation: ${MATCHES} matches, ` +
            `dt=1/60, cap=${CAP}s, seed=${SEED0}, target=${VP_TARGET} VP`);
console.log(`DIFFICULTY: ${DIFF}` +
  (NOVICE ? '  |  seat 0 = novice (mediocre-human stand-in)' : '  |  all four seats at this level'));
console.log(`BOARD: ${FIXED_BOARD
  ? `pinned to seed ${boardSeed} for every match`
  : 'reshuffled every match (terrain, tokens and dock resources)'}`);
if (TUNED_D) console.log('DIFFICULTY OVERRIDES:' + TUNED_D);
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
    const w = r.rows[r.winner] || null;
    console.log(`  #${String(i).padStart(2)}  ${fmt(r.duration)}s  b=${r.boardSeed}  ` +
      `win=${r.winStrategy ?? 'NONE'}  ` +
      r.rows.map(x => `${x.strategy.slice(0, 3)}:${x.vp}`).join(' ') +
      (w ? `  | winner ${w.settlements}S ${w.cities}C ${w.vpCards}vpc ` +
           `${w.awardVp}awd road${w.longestRoad} kn${w.knights} ` +
           `hex${w.tilesOwned} got${w.gathered} trd${w.traded}` : ''));
  }
}
const wall = (Date.now() - t0) / 1000;

/* ---------------------------------------------------------------- report */

const done = results.filter(r => r.finished);
const durations = done.map(r => r.duration).sort((a, b) => a - b);
const unfinished = results.filter(r => !r.finished);

console.log('=== BOARDS ===');
{
  const prints = new Set(results.map(r => r.boardPrint));
  const spreads = results.map(r => r.openingSpread).sort((a, b) => a - b);
  const att = results.map(r => r.boardAttempts).sort((a, b) => a - b);
  console.log(table(
    ['stat', 'value'],
    [
      ['islands played', String(results.length)],
      ['distinct islands', String(prints.size)],
      ['opening-seat spread (median/max)',
        `${fmt(quantile(spreads, 0.5), 0)} / ${spreads[spreads.length - 1] ?? 0} pips`],
      ['shuffle attempts (mean/max)',
        `${fmt(att.reduce((s, v) => s + v, 0) / (att.length || 1))} / ${att[att.length - 1] ?? 0}`]
    ]
  ));
}

console.log('\n=== MATCH DURATION (finished matches) ===');
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

console.log(`\n=== WINS BY SEAT (${NOVICE ? 'seat 0 = novice policy' : 'every seat at ' + DIFF}) ===`);
{
  const wins = [0, 0, 0, 0];
  const vp = [0, 0, 0, 0];
  for (const r of results) {
    if (r.winner >= 0) wins[r.winner]++;
    for (const row of r.rows) vp[row.id] += row.vp;
  }
  console.log(table(
    ['seat', 'who', 'wins', 'win rate', 'avg VP'],
    wins.map((w, i) => [
      `p${i}`,
      i === 0 ? (NOVICE ? 'NOVICE (human stand-in)' : `bot/${DIFF}`) : `bot/${DIFF}`,
      w, pct(w, done.length), fmt(vp[i] / (results.length || 1), 2)
    ])
  ));
  if (NOVICE) {
    console.log(`  seat 0 (novice) beat three ${DIFF} bots in ` +
      `${wins[0]}/${done.length} finished matches — chance alone would be 25%.`);
  }
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
    acc[s] = { n: 0, g: 0, t: 0, cp: 0, b: 0, rd: 0, d: 0, tl: 0 };
  }
  for (const r of results) for (const row of r.rows) {
    const a = acc[row.strategy];
    a.n++; a.g += row.gathered; a.t += row.traded; a.cp += row.cardsPlayed;
    a.b += row.built; a.rd += row.roads; a.d += row.distance;
    a.tl += row.tilesOwned;
  }
  console.log(table(
    ['strategy', 'gathered', 'hexes owned', 'trades', 'cards played', 'pieces built', 'roads', 'metres run'],
    STRATS.map(s => {
      const a = acc[s];
      return [s, fmt(a.g / a.n, 1), fmt(a.tl / a.n, 2), fmt(a.t / a.n, 2), fmt(a.cp / a.n, 2),
              fmt(a.b / a.n, 2), fmt(a.rd / a.n, 2), fmt(a.d / a.n, 0)];
    })
  ));
}

console.log('\n=== THE FIELD (per match) ===');
{
  const ex = results.reduce((s, r) => s + r.exhausted, 0) / results.length;
  const re = results.reduce((s, r) => s + r.restored, 0) / results.length;
  const picked = results.reduce((s, r) =>
    s + r.rows.reduce((t, x) => t + x.gathered, 0), 0) / results.length;
  const secs = results.reduce((s, r) => s + r.duration, 0) / results.length;
  const island = tiles.filter(t => t.resource)
    .reduce((s, t) => s + tileItemCount(t.id), 0);
  console.log(table(
    ['metric', 'value'],
    [
      ['items on a full island', String(island)],
      ['items per hex by pips', JSON.stringify(TILE_ITEMS)],
      ['regen seconds by pips', JSON.stringify(TILE_REGEN)],
      ['pickup radius', String(PICKUP_RADIUS)],
      ['items picked up / match', fmt(picked, 0)],
      ['items picked up / second', fmt(picked / secs, 2)],
      ['hexes cleared out / match', fmt(ex, 1)],
      ['hexes grown back / match', fmt(re, 1)]
    ]
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
