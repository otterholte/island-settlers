// Structural self-test for the frozen contracts. Run: node tools/verify.mjs
import { tiles, intersections, edges, ports, BOUNDS } from '../src/board/layout.js';
import { items, tileItemCount, tileRegenSeconds } from '../src/board/nodes.js';
import {
  createMatch, legalSettlements, legalRoads, setupCurrentPlayer,
  setupPlaceSettlement, setupPlaceRoad, scoreOf, longestRoadFor
} from '../src/core/rules.js';

let fail = 0;
const ok = (cond, label, extra = '') => {
  if (!cond) fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
};

ok(tiles.length === 19, 'tiles = 19', String(tiles.length));
ok(intersections.length === 54, 'intersections = 54', String(intersections.length));
ok(edges.length === 72, 'edges = 72', String(edges.length));
ok(ports.length === 9, 'ports = 9', String(ports.length));
ok(items.length >= 280 && items.length <= 460, 'harvestable field items', String(items.length));

// The number on a hex means two things and only two: how much it holds, and
// how fast it comes back. Both must move monotonically with the pips.
{
  const hot = tiles.filter(t => t.pips === 5);
  const cold = tiles.filter(t => t.pips === 1);
  ok(hot.length > 0 && cold.length > 0, 'board has 5-pip and 1-pip regions');
  ok(tileItemCount(hot[0].id) > tileItemCount(cold[0].id),
     'a high number holds more items',
     `${tileItemCount(hot[0].id)} vs ${tileItemCount(cold[0].id)}`);
  ok(tileRegenSeconds(hot[0].id) < tileRegenSeconds(cold[0].id),
     'a high number regrows faster',
     `${tileRegenSeconds(hot[0].id)}s vs ${tileRegenSeconds(cold[0].id)}s`);
}

const nums = tiles.filter(t => t.number).map(t => t.number).sort((a, b) => a - b);
ok(nums.length === 18, 'number tokens = 18');
const counts = {};
nums.forEach(n => counts[n] = (counts[n] || 0) + 1);
ok(counts[2] === 1 && counts[12] === 1 && [3,4,5,6,8,9,10,11].every(n => counts[n] === 2),
   'classic token distribution');

// No two 5-pip tiles adjacent.
const hot = tiles.filter(t => t.pips === 5);
let adjacentHot = false;
for (const a of hot) for (const b of hot) {
  if (a.id >= b.id) continue;
  if (a.corners.some(c => b.corners.includes(c))) adjacentHot = true;
}
ok(!adjacentHot, 'no two 6/8 tiles touch');

const s = createMatch({ seed: 7 });
let guard = 0;
while (s.phase === 'setup' && guard++ < 40) {
  const pid = setupCurrentPlayer(s);
  if (s.setupNeed === 'settlement') {
    const L = legalSettlements(s, pid, true);
    setupPlaceSettlement(s, pid, L[(pid * 7 + guard) % L.length]);
  } else {
    const L = legalRoads(s, pid, true, s.setupAnchor);
    setupPlaceRoad(s, pid, L[0]);
  }
}
ok(s.phase === 'play', 'snake draft completes -> play');
ok(s.buildings.size === 8, 'eight starting settlements', String(s.buildings.size));
ok(s.roadOwner.size === 8, 'eight starting roads', String(s.roadOwner.size));
ok(s.players.every(p => scoreOf(s, p) === 2), 'everyone opens on 2 VP');
ok(s.players.every(p => longestRoadFor(s, p.id) === 1), 'longest road starts at 1');
ok(BOUNDS.width > 70 && BOUNDS.width < 85, 'island spans ~78 units', BOUNDS.width.toFixed(1));

console.log(fail ? `\n${fail} FAILURE(S)` : '\nAll structural checks passed.');
process.exit(fail ? 1 : 0);
