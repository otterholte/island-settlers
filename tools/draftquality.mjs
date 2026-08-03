/**
 * Island Settlers — what kind of opening does the draft actually deal?
 *
 *   node tools/draftquality.mjs [--boards=80]
 *
 * Runs the real snake draft headlessly over many freshly dealt islands and
 * reports the shape of the opening seat 0 ends up with — the seat the OPENING
 * setting picks for. It exists because that setting shipped with a chooser
 * that scored corners almost entirely on production rate, and the player who
 * turned it on got told what that meant:
 *
 *   "It's almost always better to be placed on sections that have 3 hexes
 *    instead of two and a port. And trying to get a healthy mix of resources —
 *    hopefully touching one hex with every resource so you don't have to go to
 *    the trading post as often. I just had it pick for me and it picked a port
 *    and two total different types of resources, instead of all 5 resources."
 *
 * All three of those are measurable, and none of them were being measured. The
 * old scorer's structural terms — a coastal corner, a dock, a new resource —
 * were worth one or two points each against a rate term worth a hundred and
 * forty, so in practice the draft was "most pips wins" and everything the
 * sentence above asks for was arithmetically invisible.
 *
 * WHY THIS IS NOT IN testmatch.mjs
 * --------------------------------
 * Because one board proves nothing. Whether five resources are reachable from
 * two corners depends on the deal and on where the snake puts you, so the only
 * honest form of this check is a distribution over many boards. It runs in two
 * seconds with no browser.
 *
 * Owner: Bots agent.
 */

import { reshuffle, tiles, intersections } from '../src/board/layout.js';
import {
  createMatch, setupCurrentPlayer, setupPlaceSettlement, setupPlaceRoad
} from '../src/core/rules.js';
import { chooseSetupSettlement, chooseSetupRoad } from '../src/systems/botBrain.js';
import { difficultyParams } from '../src/systems/difficulty.js';

const arg = (k, d) => {
  const hit = process.argv.find(a => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};
const BOARDS = Number(arg('boards', 80));

/* The eyes the OPENING setting gives seat 0: the same chooser the rivals use,
   with the difficulty's opening randomness turned off. See flowDraft.js. */
const CLEAN = { d: { ...difficultyParams(), setupNoise: 0 } };

const seat = { kinds: [], threeHex: [], ports: 0, pips: [], settlements: 0 };

for (let g = 0; g < BOARDS; g++) {
  reshuffle((Math.random() * 0xffffffff) >>> 0);
  const st = createMatch({ seed: (Math.random() * 1e9) | 0 });
  // Sixteen placements: eight settlements and eight roads, alternating.
  for (let step = 0; step < 24 && st.phase === 'setup'; step++) {
    const pid = setupCurrentPlayer(st);
    const opts = pid === 0 ? CLEAN : {};
    if (st.setupNeed === 'settlement') {
      const iid = chooseSetupSettlement(st, pid, Math.random, opts);
      if (iid < 0 || !setupPlaceSettlement(st, pid, iid)) break;
    } else {
      const eid = chooseSetupRoad(st, pid, st.setupAnchor, Math.random, opts);
      if (eid < 0 || !setupPlaceRoad(st, pid, eid)) break;
    }
  }

  const ids = [...st.players[0].settlements];
  seat.settlements += ids.length;
  const kinds = new Set();
  let three = 0, pips = 0;
  for (const iid of ids) {
    const n = intersections[iid];
    if (n.tiles.length >= 3) three++;
    if (n.port !== null && n.port !== undefined) seat.ports++;
    for (const tid of n.tiles) {
      const t = tiles[tid];
      if (t.resource) kinds.add(t.resource);
      pips += t.pips || 0;
    }
  }
  seat.kinds.push(kinds.size);
  seat.threeHex.push(three);
  seat.pips.push(pips);
}

const hist = a => {
  const h = new Map();
  for (const v of a) h.set(v, (h.get(v) || 0) + 1);
  return [...h.entries()].sort((x, y) => x[0] - y[0]);
};
const mean = a => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
const pct = (n, of) => `${((n / Math.max(1, of)) * 100).toFixed(0)}%`;

const fives = seat.kinds.filter(k => k === 5).length;
const fourPlus = seat.kinds.filter(k => k >= 4).length;
const bothThree = seat.threeHex.filter(k => k === 2).length;

console.log(`\n=== the opening seat 0 is dealt, over ${BOARDS} freshly shuffled islands ===\n`);
console.log(`settlements placed   ${seat.settlements} (want ${BOARDS * 2})`);
console.log('distinct resources   '
  + hist(seat.kinds).map(([k, n]) => `${k}:${n}`).join('  ')
  + `   mean ${mean(seat.kinds).toFixed(2)}`);
console.log(`  all five           ${fives}  ${pct(fives, BOARDS)}`);
console.log(`  four or more       ${fourPlus}  ${pct(fourPlus, BOARDS)}`);
console.log('three-hex corners    '
  + hist(seat.threeHex).map(([k, n]) => `${k}:${n}`).join('  ')
  + `   mean ${mean(seat.threeHex).toFixed(2)} of 2`);
console.log(`  both corners        ${bothThree}  ${pct(bothThree, BOARDS)}`);
console.log(`dock corners taken   ${seat.ports}  ${pct(seat.ports, BOARDS * 2)} of settlements`);
console.log(`opening pips         mean ${mean(seat.pips).toFixed(1)}`);

/* The bars. Not "is this the best possible opening" — that depends on the deal
   and on where the snake put you — but "is the thing the player asked for
   actually happening more often than not". */
const checks = [
  ['every board placed two settlements', seat.settlements === BOARDS * 2],
  ['four or more resources on most boards', fourPlus / BOARDS >= 0.85],
  ['all five on a good share of them', fives / BOARDS >= 0.30],
  ['both corners work three hexes, usually', bothThree / BOARDS >= 0.55],
  ['docks are the exception, not the pick', seat.ports / (BOARDS * 2) <= 0.18],
  ['and none of it cost production', mean(seat.pips) >= 18]
];
console.log('');
let bad = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) bad++;
}
console.log('\n==========================================================');
console.log(`${checks.length - bad}/${checks.length} checks passed`);
process.exit(bad ? 1 : 0);
