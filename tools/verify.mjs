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
  setupPlaceSettlement, setupPlaceRoad, scoreOf, longestRoadFor,
  playKnight, knightVictims, knightBlocks, canGatherTile, RES
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
// One to ten, low to high: a single 1 and a single 2, two of everything else.
ok(counts[1] === 1 && counts[2] === 1 && [3,4,5,6,7,8,9,10].every(n => counts[n] === 2),
   'token distribution is 1..10');
ok(nums[0] === 1 && nums[nums.length - 1] === 10, 'numbers run 1 to 10');
// The printed number and the productivity rung must never disagree.
ok(tiles.filter(t => t.number).every(t => t.pips === Math.ceil(t.number / 2)),
   'every printed number matches its productivity rung');

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
ok(!touchingReds(), 'no two 9/10 tiles touch');
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
ok(s.robberTile === DESERT.id, 'the Knight starts on the desert', String(s.robberTile));

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

/* ------------------------------------------------------------- the raid
 *
 *   "Can you change how the knight works. I want it to only take from the
 *    players who have a settlement or city on the hex where you placed the
 *    knight, and only they will lose half of all of their resources. If I place
 *    it on my own hex, I still can access that hex for resources, however I
 *    never lose half of my own resources if I'm the one that plays the knight."
 *
 *   "Also make sure that it works that the knight rounds down to the nearest
 *    full resource ... if I have 7 of something I lose 3, or if I halve 1
 *    brick, I just keep it."
 *
 * Both halves are arithmetic on a board, which is exactly the sort of thing a
 * browser cannot check and this file can. The scene is built by hand rather
 * than drafted: `state.buildings` is written directly so the raided hex has a
 * known rival settlement, a known rival CITY, a corner belonging to the player
 * who sends the Knight, and a bystander parked on a hex that shares no corner
 * with it. Placement law is not what is under test here — who pays is.
 */
console.log('\n--- the Knight raid ---');
{
  /** Put a building on a corner without going through the distance rule. */
  const put = (st, pid, iid, type) => {
    st.buildings.set(iid, { owner: pid, type, builtAt: 0 });
    st.players[pid][type === 'city' ? 'cities' : 'settlements'].add(iid);
  };
  const bank = (o) => RES.map(r => `${r} ${o[r]}`).join(', ');
  const sameBank = (a, b) => RES.every(r => (a[r] | 0) === (b[r] | 0));

  // Two resource hexes that share no corner, so "settled on the raided hex" and
  // "settled somewhere else entirely" are genuinely different places.
  const home = tiles.find(t => t.resource);
  const away = tiles.find(t => t.resource && t.id !== home.id
    && !t.corners.some(c => home.corners.includes(c)));
  ok(!!home && !!away, 'two hexes that share no corner exist to raid between');

  /**
   * A match held still in `play`, with:
   *   seat 0  the Knight's sender, settled ON the raided hex
   *   seat 1  a rival settled on the raided hex          (a victim)
   *   seat 2  a bystander settled only on the far hex    (never a victim)
   *   seat 3  a rival with a CITY on the raided hex      (a victim)
   */
  const scene = (banks) => {
    const st = createMatch({ seed: 4242 });
    st.phase = 'play';
    put(st, 0, home.corners[4], 'settlement');
    put(st, 1, home.corners[0], 'settlement');
    put(st, 3, home.corners[2], 'city');
    put(st, 2, away.corners[0], 'settlement');
    st.players.forEach((p, i) => { p.res = { ...banks[i] }; });
    st.players[0].cards.push({ type: 'knight', id: 'test-knight' });
    st.events.length = 0;
    return st;
  };

  const FLAT = { wood: 6, brick: 6, wool: 6, wheat: 6, ore: 6 };
  const HOARD = { wood: 19, brick: 17, wool: 15, wheat: 13, ore: 11 };
  // The owner's own worked example, plus the two edges either side of it.
  const ODDS = { wood: 8, brick: 7, wool: 5, wheat: 1, ore: 0 };
  const KEPT = { wood: 4, brick: 4, wool: 3, wheat: 1, ore: 0 };

  {
    const st = scene([FLAT, ODDS, HOARD, FLAT]);
    const played = playKnight(st, 0, home.id);
    ok(played, 'the Knight is sent');

    // 1. a rival settled on the raided hex pays, and pays floor(n/2) per type
    ok(sameBank(st.players[1].res, KEPT),
      'a rival with a settlement on the raided hex loses floor(n/2) of each type',
      bank(st.players[1].res));
    ok(st.players[1].res.wood === 4 && st.players[1].res.brick === 4
      && st.players[1].res.wool === 3 && st.players[1].res.wheat === 1
      && st.players[1].res.ore === 0,
    'the owner\'s worked example: 8->4 kept, 7->4, 5->3, 1->1 (a lone brick is kept), 0->0',
    bank(st.players[1].res));

    // 2. everybody else on the island is untouched, however much they hold
    ok(sameBank(st.players[2].res, HOARD),
      'a rival with nothing on that hex loses nothing, even holding 75 goods',
      bank(st.players[2].res));

    // 3. the sender never pays, even owning a corner of the hex they chose
    ok(sameBank(st.players[0].res, FLAT),
      'the player who played the Knight loses nothing, though they own a corner there',
      bank(st.players[0].res));

    // a city on the hex is a victim just as a settlement is
    ok(sameBank(st.players[3].res, { wood: 3, brick: 3, wool: 3, wheat: 3, ore: 3 }),
      'a rival with a CITY on the raided hex pays the same half',
      bank(st.players[3].res));

    // 4. the event `ui/hud-raid.js`, `main.js` and `net/mirror.js` read
    const ev = st.events.find(e => e.type === 'knight');
    ok(!!ev && ev.player === 0 && ev.tile === home.id && Array.isArray(ev.losses),
      'the knight event still carries { player, tile, losses[] }');
    ok(ev.losses.length === 2 && ev.losses.every(l => l.total > 0
      && RES.every(r => Number.isInteger(l.lost[r]))),
    'losses names exactly the two settled victims, each with a full five-type bill',
    ev.losses.map(l => `${l.player}:${l.total}`).join(' '));
    ok(ev.losses.every(l => l.total === RES.reduce((s, r) => s + l.lost[r], 0)),
      'each bill totals its own five lines');
    ok(!ev.losses.some(l => l.player === 0), 'the sender is not on the bill');
    // Nothing is transferred — a raid destroys, it does not steal.
    ok(sameBank(st.players[0].res, FLAT), 'and nothing raided is credited to the sender');
  }

  // The Knight on a hex only its sender has built on bills nobody at all.
  {
    const st = scene([FLAT, FLAT, FLAT, FLAT]);
    st.buildings.delete(home.corners[0]);
    st.buildings.delete(home.corners[2]);
    st.players[1].settlements.delete(home.corners[0]);
    st.players[3].cities.delete(home.corners[2]);
    ok(knightVictims(st, 0, home.id).length === 0,
      'a hex only the sender has built on has no victims to name');
    playKnight(st, 0, home.id);
    const ev = st.events.find(e => e.type === 'knight');
    ok(ev && ev.losses.length === 0 && st.players.every(p => sameBank(p.res, FLAT)),
      'so the raid takes nothing from anybody and the bill is empty');
  }

  // A victim holding at most one of each pays nothing and stays off the bill,
  // which is what `net/mirror.js` expects to replay.
  {
    const ONES = { wood: 1, brick: 1, wool: 0, wheat: 1, ore: 0 };
    const st = scene([FLAT, ONES, FLAT, FLAT]);
    playKnight(st, 0, home.id);
    ok(sameBank(st.players[1].res, ONES),
      'a victim holding one of each keeps all of it', bank(st.players[1].res));
    const ev = st.events.find(e => e.type === 'knight');
    ok(ev.losses.every(l => l.player !== 1),
      'and an all-zero bill is left off the event rather than sent as noise');
  }

  // Targeting is by the BOARD, not by who is standing where or holding what.
  {
    const st = scene([FLAT, FLAT, FLAT, FLAT]);
    const victims = knightVictims(st, 0, home.id).map(o => o.id).sort();
    ok(victims.join(',') === '1,3',
      'knightVictims is exactly the settled rivals, in seat order', victims.join(','));
    ok(knightVictims(st, 1, home.id).map(o => o.id).sort().join(',') === '0,3',
      'and it excludes whoever is asking, never anybody else');
    ok(knightVictims(st, 0, away.id).map(o => o.id).join(',') === '2',
      'raiding the far hex bills only the player settled on the far hex');
  }

  /* The blocking half is UNCHANGED, and it always did let the sender keep
     working the hex they blocked — "If I place it on my own hex, I still can
     access that hex for resources". Pinned here so it stays that way. */
  {
    const st = scene([FLAT, FLAT, FLAT, FLAT]);
    playKnight(st, 0, home.id);
    ok(st.robberTile === home.id && st.robberOwner === 0,
      'the Knight lands on the chosen hex and remembers who sent it');
    ok(!knightBlocks(st, 0, home.id) && canGatherTile(st, 0, home.id),
      'the player who sent the Knight can still gather from the hex they blocked');
    ok(knightBlocks(st, 1, home.id) && !canGatherTile(st, 1, home.id),
      'while a rival settled there is shut out of it');
    ok(!knightBlocks(st, 1, away.id),
      'and no other hex on the island is blocked');
  }
}

/* ------------------------------------------------------- the quality ladder
 *
 * `systems/quality.js` decides how much graphics a machine can afford, and its
 * arithmetic is the one part of that which can be tested exactly: feed it frame
 * times and check which way it steps. A browser cannot do this — under
 * SwiftShader every frame is 500ms and the ladder correctly never climbs — so
 * it is tested here, with a clock we own.
 */
{
  const Q = await import('../src/systems/quality.js');
  const mk = level => {
    const seen = [];
    const q = Q.createQuality({
      renderer: { shadowMap: {}, setPixelRatio: () => {}, domElement: {} },
      scene: null, root: null, level,
      sunOf: () => null, ratioFor: () => 1.5,
      onChange: (l, why) => seen.push([l, why])
    });
    q.apply(level, 'test');
    return { q, seen };
  };
  /* `update` clamps a step to 0.25s — a frame loop never hands it more, and a
     tab that was away must not age the schedule by an hour. So waiting is
     ticking, not one big number. */
  const wait = (q, secs) => { for (let i = 0; i < secs * 4; i++) q.update(0.25); };
  /** Play `ms`-per-frame for one probe's worth of frames. */
  const run = (q, ms, frames = 200) => {
    q.startProbe();
    let t = 0;
    for (let i = 0; i < frames; i++) { t += ms; q.frame(t); }
    q.finishProbe();
  };

  const a = mk(Q.SAVER);
  run(a.q, 16.7);
  wait(a.q, 600);
  run(a.q, 16.7);
  ok(a.q.level === Q.SAVER,
    'a comfortable machine is LEFT WHERE IT IS — the ladder never climbs',
    `level ${a.q.level} after two clean probes and ten minutes`);

  const b = mk(Q.FULL);
  run(b.q, 45);
  ok(b.q.level === Q.SAVER, 'a struggling machine drops out of full quality',
    `level ${b.q.level} after p90 ${b.q.info.last.p90}ms`);

  const c = mk(Q.SAVER);
  run(c.q, 60);
  ok(c.q.level === Q.LOW,
    'and one that is drowning even in saver goes to the bottom rung',
    `level ${c.q.level} after p90 ${c.q.info.last.p90}ms`);

  const c2 = mk(Q.FULL);
  run(c2.q, 24);
  ok(c2.q.level === Q.FULL,
    'while a machine inside the bar is not touched at all',
    `p90 ${c2.q.info.last.p90}ms left it at ${c2.q.level}`);

  const d = mk(Q.FULL);
  d.q.loss();
  ok(d.q.level === Q.LOW,
    'a lost context goes straight to the bottom, not one rung down',
    `level ${d.q.level}`);

  const e = mk(Q.FULL);
  e.q.pin(Q.SAVER);
  run(e.q, 16.7);
  wait(e.q, 600);
  ok(e.q.level === Q.SAVER && e.q.pinned === true,
    'and a choice made by hand is where it stays',
    `level ${e.q.level}`);

  const f = mk(Q.LOW);
  ok(Q.RUNGS[Q.LOW].fps === 30 && Q.RUNGS[Q.LOW].ratio < 1
    && Q.RUNGS[Q.LOW].shadows === false && Q.RUNGS[Q.LOW].blur === false
    && f.q.frameMs > 30,
  'the bottom rung is half the frame rate and fewer pixels than the saver',
  `${Q.RUNGS[Q.LOW].fps}fps, ratio ${Q.RUNGS[Q.LOW].ratio}, ${f.q.frameMs.toFixed(1)}ms between draws`);

  ok(Q.PROBE_AT_SEC <= 12,
    'and the one look happens while the opening screen is still up',
    `${Q.PROBE_AT_SEC}s`);

  ok(Q.guessLevel({ navigator: { deviceMemory: 8, hardwareConcurrency: 4 },
    renderer: 'Intel(R) Iris(R) Xe Graphics', stored: {} }).level === Q.SAVER,
  'a shared-memory laptop is guessed low before the first frame');
  ok(Q.guessLevel({ navigator: { deviceMemory: 32, hardwareConcurrency: 16 },
    renderer: 'NVIDIA GeForce RTX 4080', stored: {} }).level === Q.FULL,
  'and a real GPU is not');
  ok(Q.guessLevel({ navigator: { deviceMemory: 32, hardwareConcurrency: 16 },
    renderer: 'NVIDIA GeForce RTX 4080', stored: { losses: 1 } }).level === Q.SAVER,
  'a machine that dropped a context here before is believed over its spec sheet');
}

/* ------------------------------------------------------- who wears what
 *
 *   "On player one's screen the roads they built were blue, and for the other
 *    player the same roads were purple — and one of the bots was building blue
 *    things."
 *
 * The renderers used to index the default palette by seat, which is right in a
 * single-player match and wrong in every networked one, because `mirror.js`
 * renumbers seats so the local player is always index 0. `core/seatcolor.js`
 * is the indirection: the palette when there is no match, the PLAYER when
 * there is — and the same player objects the mirror assigns onto, so a re-seat
 * needs no second call.
 */
{
  const S = await import('../src/core/seatcolor.js');
  const { PLAYER_COLORS } = await import('../src/core/constants.js');

  S.clearSeats();
  ok(S.seatHex(2) === PLAYER_COLORS[2].hex,
    'with no match running, a seat wears its palette colour');

  const seats = [
    { color: PLAYER_COLORS[3] }, { color: PLAYER_COLORS[0] },
    { color: PLAYER_COLORS[1] }, { color: PLAYER_COLORS[2] }
  ];
  S.useSeats(seats);
  ok(S.seatHex(0) === PLAYER_COLORS[3].hex && S.seatHex(1) === PLAYER_COLORS[0].hex,
    'in a match, a seat wears what the server gave it, not its index');

  // The mirror assigns onto the SAME objects. Nothing is told twice.
  seats[1].color = { ...PLAYER_COLORS[2], hex: 0x00ff88 };
  ok(S.seatHex(1) === 0x00ff88,
    'and a re-seat is picked up without anybody being told again');

  ok(S.seatHex(-1) === S.seatHex(3) && S.seatHex(9) === S.seatHex(1),
    'a stray player id still answers a colour rather than throwing');

  S.clearSeats();
  ok(S.seatHex(1) === PLAYER_COLORS[1].hex,
    'and the opening screen gets the palette back when the match is gone');
}

/* ------------------------------------------------ two roads from anybody
 *
 *   "Technically there are times where even if I have the resources I can't
 *    build a settlement, since they need to be 2 roads away from all other
 *    hexes, just make sure that's the case."
 *
 * It is, and this is the check that keeps it that way. The rule reads
 * `state.buildings`, which holds every player's pieces rather than only yours,
 * so a RIVAL's settlement refuses the three corners around it exactly as your
 * own does — which is the half that is easy to break and impossible to see,
 * because the build sheet can honestly tell you a settlement is affordable and
 * the board still offer nowhere to put it. That is not a bug in the sheet; it
 * is this rule doing its job, and the two facts have to be tested together.
 */
{
  const R = await import('../src/core/rules.js');
  const { intersections } = await import('../src/board/layout.js');
  const st = R.createMatch({ seed: 4242 });

  st.phase = 'setup';
  const theirs = 20;
  R.placeSettlement(st, 1, theirs, true);          // a RIVAL builds here
  const around = intersections[theirs].neighbors;

  // Give seat 0 a road on every edge touching those corners, so the only thing
  // left that can refuse them is the distance rule itself.
  st.phase = 'play';
  for (const nb of around) for (const e of intersections[nb].edges) st.roadOwner.set(e, 0);

  ok(around.every(nb => !R.settlementLegal(st, 0, nb, false)),
    "a rival's settlement refuses every corner touching it, roads or not",
    `corners ${around.join(',')} around ${theirs}`);

  const twoAway = intersections[around[0]].neighbors
    .filter(x => x !== theirs && !around.includes(x));
  ok(twoAway.some(x => R.settlementLegal(st, 0, x, false)),
    'and two corners away is allowed once a road of yours reaches it',
    `of ${twoAway.join(',')}`);

  // The same rule, your own piece: nobody gets a private exemption from it.
  const mine = R.legalSettlements(st, 0, false)[0];
  if (Number.isInteger(mine)) {
    R.placeSettlement(st, 0, mine, true);
    ok(intersections[mine].neighbors.every(nb => !R.settlementLegal(st, 0, nb, false)),
      'and your own settlement refuses its own neighbours just the same');
  }
}

console.log(fail ? `\n${fail} FAILURE(S)` : '\nAll structural checks passed.');
process.exit(fail ? 1 : 0);
