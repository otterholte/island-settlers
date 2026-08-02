// Structural self-test for the frozen contracts. Run: node tools/verify.mjs
//
// Two halves:
//   1. the invariants of whatever board this process happened to be dealt
//   2. a soak over BOARDS freshly shuffled islands, proving the per-match
//      randomiser never produces an illegal or unfair one — and that it
//      actually produces different ones.
import {
  tiles, intersections, edges, ports, BOUNDS, MARKET, DESERT,
  reshuffle, currentViolations, LAYOUT, LAYOUT_SEED, TOPOLOGY
} from '../src/board/layout.js';
import {
  TERRAIN_BAG, TOKEN_BAG, FAIRNESS, DESERT_INDEX, openingPicks
} from '../src/board/shuffle.js';
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

const tallyOf = (list) => {
  const m = {};
  for (const v of list) m[v] = (m[v] || 0) + 1;
  return m;
};
const sameTally = (a, b) => {
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every(k => a[k] === b[k]);
};

const WANT_TERRAIN = tallyOf([...TERRAIN_BAG, 'desert']);
const WANT_TOKENS = tallyOf(TOKEN_BAG);

console.log(`board seed ${LAYOUT_SEED} (found in ${LAYOUT.attempts} attempt(s))\n`);

/* ============================================================== geometry */

ok(tiles.length === 19, 'tiles = 19', String(tiles.length));
ok(intersections.length === 54, 'intersections = 54', String(intersections.length));
ok(edges.length === 72, 'edges = 72', String(edges.length));
ok(ports.length === 9, 'ports = 9', String(ports.length));
// The POSITION POOL, not the live count: TILE_ITEM_POOL per resource hex.
ok(items.length >= 280 && items.length <= 620, 'harvestable field items', String(items.length));

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
const counts = tallyOf(nums);
ok(counts[2] === 1 && counts[12] === 1 && [3,4,5,6,8,9,10,11].every(n => counts[n] === 2),
   'classic token distribution');

/** Two hexes share a corner iff they are neighbours, so this tests adjacency
 *  exactly. Computed off the real graph, not off shuffle.js. */
function touchingReds() {
  const hot = tiles.filter(t => t.pips === 5);
  for (const a of hot) for (const b of hot) {
    if (a.id >= b.id) continue;
    if (a.corners.some(c => b.corners.includes(c))) return `${a.number}@${a.id}/${b.number}@${b.id}`;
  }
  return null;
}
ok(!touchingReds(), 'no two 6/8 tiles touch');
ok(BOUNDS.width > 70 && BOUNDS.width < 85, 'island spans ~78 units', BOUNDS.width.toFixed(1));

/* ================================================= 200+ shuffled islands */

const BOARDS = Math.max(200, parseInt(process.env.VERIFY_BOARDS || '240', 10));

console.log(`\n--- soak: ${BOARDS} freshly shuffled islands ---`);
{
  const marketAt = `${MARKET.x.toFixed(3)},${MARKET.z.toFixed(3)}`;
  const desertAt = `${DESERT.q},${DESERT.r}`;
  const nIntersections = intersections.length, nEdges = edges.length;
  const nItems = items.length;

  const bad = {
    composition: 0, tokens: 0, desert: 0, reds: 0, fairness: 0,
    cornerCap: 0, geometry: 0, ports: 0, items: 0, unfair: 0
  };
  const fingerprints = new Set();
  const numberPrints = new Set();
  const terrainPrints = new Set();
  const portPrints = new Set();
  const spreads = [];
  const attempts = [];
  const bestCorner = [];
  // How often does each terrain land on each position? A biased shuffle shows
  // up here as a position that always draws the same thing.
  const perPosition = tiles.map(() => new Set());
  let relaxed = 0;

  for (let i = 0; i < BOARDS; i++) {
    const board = reshuffle(0x51ed270b + i * 2654435761);
    if (!board.fair) relaxed++;
    attempts.push(board.attempts);
    spreads.push(board.openingSpread);

    const terrain = tiles.map(t => t.terrain);
    const numbers = tiles.map(t => t.number);
    const pips = tiles.map(t => t.pips);

    if (!sameTally(tallyOf(terrain), WANT_TERRAIN)) bad.composition++;
    if (!sameTally(tallyOf(numbers.filter((v, k) => k !== DESERT_INDEX)), WANT_TOKENS)) bad.tokens++;

    // desert dead centre, no token, market unmoved
    if (tiles[DESERT_INDEX].terrain !== 'desert' ||
        tiles[DESERT_INDEX].number !== 0 ||
        terrain.filter(t => t === 'desert').length !== 1 ||
        DESERT !== tiles[DESERT_INDEX] ||
        `${DESERT.q},${DESERT.r}` !== desertAt ||
        `${MARKET.x.toFixed(3)},${MARKET.z.toFixed(3)}` !== marketAt) bad.desert++;

    if (touchingReds()) bad.reds++;

    const worstCorner = Math.max(...intersections.map(
      n => n.tiles.reduce((s, t) => s + pips[t], 0)));
    bestCorner.push(worstCorner);
    if (worstCorner > FAIRNESS.maxCornerPips) bad.cornerCap++;

    const v = currentViolations();
    if (v.length) { bad.fairness++; bad.unfair++; }

    // resource/terrain agreement — a forest hex must actually grow trees
    if (tiles.some(t => (t.terrain === 'desert') !== (t.resource === null))) bad.composition++;

    // graph and item field untouched by the re-deal
    if (intersections.length !== nIntersections || edges.length !== nEdges) bad.geometry++;
    if (items.length !== nItems) bad.items++;
    if (items.some(it => it.resource !== tiles[it.tile].resource)) bad.items++;

    // ports: four 3:1 and one 2:1 per resource, always
    const generic = ports.filter(p => p.kind === 'generic').length;
    const specials = new Set(ports.filter(p => p.kind === 'special').map(p => p.resource));
    if (generic !== 4 || specials.size !== 5) bad.ports++;

    const tprint = terrain.join('');
    const nprint = numbers.join(',');
    terrainPrints.add(tprint);
    numberPrints.add(nprint);
    fingerprints.add(tprint + '|' + nprint);
    portPrints.add(ports.map(p => p.resource || '-').join(','));
    terrain.forEach((t, k) => perPosition[k].add(t));
  }

  const q = (arr, p) => {
    const s = arr.slice().sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))];
  };
  const mean = arr => arr.reduce((a, b) => a + b, 0) / arr.length;

  ok(bad.composition === 0, 'every board: 4 forest / 4 fields / 4 pasture / 3 hills / 3 mountains / 1 desert',
     `${BOARDS - bad.composition}/${BOARDS}`);
  ok(bad.tokens === 0, 'every board: classic 18-token distribution',
     `${BOARDS - bad.tokens}/${BOARDS}`);
  ok(bad.desert === 0, 'every board: desert dead centre, no token, market unmoved',
     `${BOARDS - bad.desert}/${BOARDS}`);
  ok(bad.reds === 0, 'every board: no two 6/8 tiles touch', `${BOARDS - bad.reds}/${BOARDS}`);
  ok(bad.cornerCap === 0, `every board: no corner over ${FAIRNESS.maxCornerPips} pips`,
     `worst seen ${Math.max(...bestCorner)}`);
  ok(bad.fairness === 0, 'every board passes the full fairness test',
     `${BOARDS - bad.fairness}/${BOARDS}`);
  ok(relaxed === 0, 'no board needed the relaxed fallback', `${relaxed} relaxed`);
  ok(bad.geometry === 0, 'every board: intersection/edge graph unchanged');
  ok(bad.items === 0, 'every board: item field re-tagged to the new terrain');
  ok(bad.ports === 0, 'every board: 4 generic + 5 distinct 2:1 docks');
  ok(Math.max(...spreads) <= FAIRNESS.maxOpeningSpread,
     `every board: opening-seat spread <= ${FAIRNESS.maxOpeningSpread} pips`,
     `max ${Math.max(...spreads)}`);

  ok(fingerprints.size === BOARDS, 'every board is distinct (terrain + numbers)',
     `${fingerprints.size}/${BOARDS}`);
  ok(terrainPrints.size >= BOARDS * 0.99, 'terrain arrangements distinct',
     `${terrainPrints.size}/${BOARDS}`);
  ok(numberPrints.size >= BOARDS * 0.99, 'number arrangements distinct',
     `${numberPrints.size}/${BOARDS}`);
  ok(portPrints.size >= BOARDS * 0.9, 'dock resources reshuffle too',
     `${portPrints.size}/${BOARDS} distinct assignments`);
  ok(perPosition.every((s, k) => k === DESERT_INDEX ? s.size === 1 : s.size === 5),
     'every non-centre position sees all five terrains');

  console.log(
    `      spread  min ${Math.min(...spreads)}  median ${q(spreads, 0.5)}  ` +
    `max ${Math.max(...spreads)}  mean ${mean(spreads).toFixed(2)}`);
  console.log(
    `      best corner  min ${Math.min(...bestCorner)}  median ${q(bestCorner, 0.5)}  ` +
    `max ${Math.max(...bestCorner)}`);
  console.log(
    `      rejection sampling  mean ${mean(attempts).toFixed(1)} attempts  ` +
    `p90 ${q(attempts, 0.9)}  max ${Math.max(...attempts)}  ` +
    `(cap ${FAIRNESS.maxAttempts})`);
}

/* ================================================= the match still plays */

console.log('\n--- a match on the last shuffled island ---');
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
ok(s.robberTile === DESERT.id, 'the Raider starts on the desert', String(s.robberTile));

// A pinned seed must reproduce a board exactly — that is what makes a bug
// report reproducible.
{
  const a = reshuffle(123456789);
  const printA = tiles.map(t => `${t.terrain}${t.number}`).join('|') + '#' +
                 ports.map(p => p.resource || '-').join(',');
  reshuffle(987654321);
  const b = reshuffle(123456789);
  const printB = tiles.map(t => `${t.terrain}${t.number}`).join('|') + '#' +
                 ports.map(p => p.resource || '-').join(',');
  ok(printA === printB && a.seed === b.seed, 'a pinned seed reproduces the board exactly');
}

console.log(fail ? `\n${fail} FAILURE(S)` : '\nAll structural checks passed.');
process.exit(fail ? 1 : 0);
