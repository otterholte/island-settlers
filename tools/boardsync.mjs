/**
 * Island Settlers — do two machines actually deal the same island?
 *
 *   node tools/boardsync.mjs [--seeds=6] [--runs=3]
 *
 * The whole of multiplayer rests on one sentence in `src/net/protocol.js`: the
 * board is a seed, and both ends deal a byte-identical island from it "down to
 * which blade of wheat is at which coordinate". Everything else — replaying a
 * pickup by item id, drawing somebody's road at edge 41, telling a player which
 * hex is exhausted — is downstream of that being true.
 *
 * IT WAS NOT TRUE. `board/nodes.js` scattered its 576 items at module load,
 * seeded off the hex numbers of the RANDOM board `layout.js` deals on the way
 * up, and `refreshFieldsFromBoard` only ever re-tagged what each item was — it
 * never moved one. So every browser and the match worker agreed about the
 * terrain, the numbers and the docks, and disagreed about where every tree,
 * sheep and ore seam stood. Which is the reported bug, in the part of it that
 * survives being in the right match:
 *
 *   "It was clear it wasn't the same game."
 *
 * SEPARATE PROCESSES, ON PURPOSE. A check inside one process cannot see this:
 * the field is stable within a process, and the old nettest built one shared
 * `state` for both of its clients. The defect only exists ACROSS module
 * registries, so this spawns real ones and compares hashes.
 *
 * Owner: net agent.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const arg = (k, d) => {
  const hit = process.argv.find(a => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};

const SEEDS = Number(arg('seeds', 6));
const RUNS = Number(arg('runs', 3));

/* Dynamic imports inside the child must be URLs, not native Windows paths.
   A quoted `C:\\...` string is parsed as the unsupported `c:` URL scheme by
   Node's ESM loader, so build the file URLs in the parent on every platform. */
const LAYOUT_URL = pathToFileURL(join(ROOT, 'src/board/layout.js')).href;
const NODES_URL = pathToFileURL(join(ROOT, 'src/board/nodes.js')).href;

/* The child. Deals the seed it is given and prints one line of hashes.
   Written as a string and run with `--input-type=module` so this stays a
   single file with nothing to clean up. */
const CHILD = `
import { createHash } from 'node:crypto';
import { reshuffle, tiles, ports, intersections, edges } from ${JSON.stringify(LAYOUT_URL)};
import { items, nodes, itemsByTile } from ${JSON.stringify(NODES_URL)};
const seed = Number(process.env.SEED);
reshuffle(seed);
const h = s => createHash('sha1').update(s).digest('hex').slice(0, 16);
console.log(JSON.stringify({
  terrain: h(tiles.map(t => t.id + ':' + t.terrain + ':' + t.number + ':' + t.pips).join('|')),
  docks:   h(ports.map(p => p.id + ':' + p.resource + ':' + p.rate + ':' + p.node).join('|')),
  graph:   h(intersections.length + ':' + edges.length + ':' +
             edges.map(e => e.a + '-' + e.b).join(',')),
  // The one that was wrong. Position to four decimals, plus the visual
  // variant, because a tree that is the right kind in the wrong place is
  // exactly as desynchronised as one in the wrong kind.
  field:   h(items.map(i =>
             i.id + ':' + i.tile + ':' + i.resource + ':' + i.kind + ':' +
             i.x.toFixed(4) + ':' + i.z.toFixed(4) + ':' + i.variant).join('|')),
  props:   h(nodes.map(n => n.id + ':' + n.x.toFixed(4) + ':' + n.z.toFixed(4)).join('|')),
  // Item ids must also survive a re-deal: mirror.js replays a pickup by id.
  ids:     h(items.map(i => i.id).join(',') + '#' + items.length),
  counts:  items.length + '/' + nodes.length + '/' + itemsByTile.size
}));
`;

function deal(seed) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD], {
    env: { ...process.env, SEED: String(seed) },
    encoding: 'utf8'
  });
  if (r.status !== 0) {
    throw new Error(`child failed for seed ${seed}: ${(r.stderr || '').trim().slice(0, 400)}`);
  }
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

const FIELDS = ['terrain', 'docks', 'graph', 'field', 'props', 'ids', 'counts'];

let pass = 0, fail = 0;
const seedsUsed = [];
const perSeed = [];

console.log(`\n=== the same island in ${RUNS} separate processes, ${SEEDS} seeds ===\n`);

for (let s = 0; s < SEEDS; s++) {
  // Fixed, spread-out seeds rather than random ones, so a failure is a thing
  // you can reproduce by running the same command again.
  const seed = (1 + s) * 7919 + s * s * 104729;
  seedsUsed.push(seed);
  const runs = [];
  for (let r = 0; r < RUNS; r++) runs.push(deal(seed));
  const first = runs[0];
  const bad = [];
  for (const f of FIELDS) {
    if (runs.every(r => String(r[f]) === String(first[f]))) continue;
    bad.push(f);
  }
  perSeed.push({ seed, first });
  if (bad.length) {
    fail++;
    console.log(`FAIL  seed ${seed}  disagreed on: ${bad.join(', ')}`);
    for (const f of bad) console.log(`        ${f}: ${runs.map(r => r[f]).join('  ')}`);
  } else {
    pass++;
    console.log(`PASS  seed ${seed}  ${first.counts} items/props/tiles  field ${first.field}`);
  }
}

/* And the other half of the claim: a DIFFERENT seed has to give a different
   island. A `reshuffle` that quietly did nothing would sail through every
   check above. */
console.log('');
let distinct = 0;
for (let a = 0; a < perSeed.length; a++) {
  for (let b = a + 1; b < perSeed.length; b++) {
    const same = perSeed[a].first.terrain === perSeed[b].first.terrain
      && perSeed[a].first.field === perSeed[b].first.field;
    if (!same) distinct++;
    else console.log(`FAIL  seeds ${perSeed[a].seed} and ${perSeed[b].seed} dealt the SAME island`);
  }
}
const pairs = (perSeed.length * (perSeed.length - 1)) / 2;
if (distinct === pairs) {
  pass++;
  console.log(`PASS  every pair of seeds dealt a different island  ${pairs}/${pairs}`);
} else {
  fail++;
}

console.log('\n==========================================================');
console.log(`${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
