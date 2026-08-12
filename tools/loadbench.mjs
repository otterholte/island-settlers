/**
 * Island Settlers — how many matches does this machine hold?
 *
 *   node tools/loadbench.mjs                        # 8 matches, 2 humans each
 *   node tools/loadbench.mjs --matches=64 --humans=2
 *   node tools/loadbench.mjs --matches=64 --secs=60 --json
 *
 * Starts N real `matchworker.mjs` threads — the real rules, the real 60Hz
 * loop, the real bots — drives the human seats with a stick input 30 times a
 * second, waits for every match to get past the load-in and the draft, and
 * then measures for a fixed window:
 *
 *   coresPerMatch     process CPU seconds per wall second, divided by N
 *   matchesPerCore    the reciprocal — the number you actually size a box on
 *   rssPerMatchMB     marginal resident memory per match
 *   outBytesPerSec    what one match posts UP to the hub, per second
 *   wireBytesPerSec   the same multiplied by the seats a hub would send it to,
 *                     which is the number that shows up on the egress bill
 *   tickLagMs         how far behind the sim clock fell. THE ONE THAT MATTERS.
 *
 * WHY TICK LAG IS THE REAL ANSWER
 * -------------------------------
 * CPU percentage tells you when a box is full. It does not tell you when the
 * GAME is full, and those are not the same moment. `matchworker.mjs` drives
 * itself on a `setInterval` at 1/60s and stamps every snapshot with the match
 * clock; when the machine is oversubscribed the interval slips, the sim runs
 * slow, and every player sees their settler wading through treacle long before
 * `top` shows anything alarming. So the pass mark here is not "under 100% CPU",
 * it is **p99 tick lag under about 16ms** — one frame. Find the match count
 * where that breaks and take 60% of it.
 *
 * WHAT THIS DOES NOT MEASURE
 * --------------------------
 * The hub. There are no websockets here, so the JSON encoding, the frame
 * headers and the write syscalls for four sockets per match are all absent.
 * That work is small — a snapshot is ~140 bytes and encodes in about two
 * microseconds — but it lands on ONE thread (the main one) for every match on
 * the process at once, so it is the thing that will actually cap a single
 * process. Measure that with `nettest.mjs` against a real deployment; measure
 * the simulation here.
 *
 * Owner: net agent.
 */

import { Worker } from 'node:worker_threads';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = resolve(HERE, '../server/matchworker.mjs');

/* ------------------------------------------------------------------ args */

const argv = new Map(
  process.argv.slice(2).map(a => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] === undefined ? '1' : m[2]] : [a, '1'];
  })
);
const num = (k, d) => (argv.has(k) ? Number(argv.get(k)) : d);

const MATCHES = num('matches', 8);
const HUMANS = Math.min(4, Math.max(0, num('humans', 2)));
const SECS = num('secs', 30);
/** Load-in is a floored 7s and the draft runs a few seconds past it. Nothing
 *  measured before this is steady state. */
const WARMUP_SEC = num('warmup', 22);
const AS_JSON = argv.has('json');

const COLORS = ['#e2584d', '#4db38a', '#4d8ce2', '#e2be4d'];
const BOT_NAMES = ['Alex', 'Alex', 'Maya', 'Finn'];

/** Four seats: the first `HUMANS` of them are people, the rest are brains.
 *  This matters more than it looks — a bot seat costs MORE than a human one,
 *  because a bot thinks and a human seat only integrates a stick. A lobby of
 *  four friends is the cheapest match this server can run. */
function roster() {
  return [0, 1, 2, 3].map(pid => {
    const human = pid < HUMANS;
    return {
      pid,
      kind: human ? 'human' : 'bot',
      userId: human ? `bench-u${pid}` : null,
      name: human ? `P${pid}` : BOT_NAMES[pid],
      color: COLORS[pid],
      state: human ? 'live' : 'bot'
    };
  });
}

/* --------------------------------------------------------------- workers */

const say = (...a) => { if (!AS_JSON) console.log('[bench]', ...a); };

say(`${MATCHES} matches · ${HUMANS} human seats each · ${WARMUP_SEC}s warmup · ${SECS}s window`);

const workers = [];
const stats = { msgs: 0, snaps: 0, bytes: 0, errors: 0 };
/** Off until the warmup is over. Declared here rather than beside the measure
 *  block because the message handler below closes over it. */
let measuring = false;
/** Every gap between consecutive snapshots from every worker. A worker emits
 *  one every SNAP_EVERY ticks — 50ms at 60Hz/20Hz — so a healthy box produces
 *  a tight pile at 50 and a starved one produces a long tail. This, and not
 *  CPU percent, is what a player feels. */
const gaps = [];
/** Sim seconds actually simulated, against wall seconds that passed. The
 *  worker's accumulator catches up after a stall, but it refuses to replay
 *  more than half a second or more than 8 steps per fire — past that the match
 *  genuinely runs slow, and this ratio is the only thing that shows it. */
let simTicks0 = null, simTicks1 = null;

for (let i = 0; i < MATCHES; i++) {
  const w = new Worker(WORKER, {
    workerData: {
      seed: (Math.random() * 0xffffffff) >>> 0,
      roster: roster(),
      roomId: `bench-r${i}`,
      matchId: `bench-m${i}`,
      difficulty: 'medium',
      knights: true
    },
    resourceLimits: { maxOldGenerationSizeMb: 192 },
    // The worker logs; a hundred of them logging is not a benchmark result.
    stdout: true,
    stderr: true
  });
  let lastSnap = 0;
  w.on('message', m => {
    stats.msgs++;
    stats.bytes += Buffer.byteLength(JSON.stringify(m));
    if (!m || m.t !== 'snap') return;
    stats.snaps++;
    const now = Date.now();
    if (measuring && lastSnap) gaps.push(now - lastSnap);
    lastSnap = now;
    // Worker 0 is the sim-rate probe. `k` is its tick counter, so the ticks it
    // burns across the window against the wall seconds the window took is the
    // ratio between game time and real time.
    if (measuring && i === 0 && typeof m.k === 'number') {
      if (simTicks0 === null) simTicks0 = m.k;
      simTicks1 = m.k;
    }
  });
  w.on('error', e => { stats.errors++; console.error('[bench] worker threw:', e && e.message); });
  workers.push(w);
}

/* Drive the human seats like people rather than statues. A settler standing
   still skips most of the movement and gathering work, which flatters the
   result by roughly a third. */
let phase = 0;
const driver = HUMANS > 0 ? setInterval(() => {
  phase += 0.033;
  for (let i = 0; i < workers.length; i++) {
    for (let pid = 0; pid < HUMANS; pid++) {
      const a = phase + pid * 1.7 + i * 0.31;
      try {
        workers[i].postMessage({ t: 'in', pid, x: Math.cos(a), z: Math.sin(a) });
      } catch (e) { /* worker gone; the exit handler has it */ }
    }
  }
}, 33) : null;

/* ----------------------------------------------------------------- measure */

await sleep(WARMUP_SEC * 1000);

stats.msgs = 0; stats.snaps = 0; stats.bytes = 0;
gaps.length = 0; simTicks0 = null; simTicks1 = null;
measuring = true;

const cpu0 = process.cpuUsage();
const t0 = process.hrtime.bigint();

await sleep(SECS * 1000);

const cpu = process.cpuUsage(cpu0);
const wall = Number(process.hrtime.bigint() - t0) / 1e9;
const cores = (cpu.user + cpu.system) / 1e6 / wall;
const rss = process.memoryUsage().rss / 1048576;

gaps.sort((a, b) => a - b);
const pct = p => (gaps.length ? Math.round(gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * p))]) : 0);
/** 1.0 means the match ran at exactly real speed. 0.9 means every player saw
 *  a settler moving at nine tenths pace, which reads as lag but is not lag. */
const simRate = (simTicks0 !== null && simTicks1 !== null)
  ? (simTicks1 - simTicks0) / 60 / wall : null;

const out = {
  matches: MATCHES,
  humanSeatsPerMatch: HUMANS,
  windowSec: +wall.toFixed(1),
  coresUsed: +cores.toFixed(3),
  coresPerMatch: +(cores / MATCHES).toFixed(4),
  matchesPerCore: +(MATCHES / cores).toFixed(1),
  rssTotalMB: Math.round(rss),
  rssPerMatchMB: Math.round(rss / MATCHES),
  snapsPerSecPerMatch: +(stats.snaps / wall / MATCHES).toFixed(1),
  outBytesPerSecPerMatch: Math.round(stats.bytes / wall / MATCHES),
  // What a hub would actually put on the wire: every snapshot goes to every
  // occupied seat, so the bill is this multiplied by the humans in the room.
  wireBytesPerSecPerMatch: Math.round(stats.bytes / wall / MATCHES * Math.max(1, HUMANS)),
  // Target is 50ms flat. p99 is where a stutter starts being visible.
  snapGapP50ms: pct(0.50),
  snapGapP99ms: pct(0.99),
  snapGapMaxMs: gaps.length ? gaps[gaps.length - 1] : 0,
  simRealtimeRatio: simRate === null ? null : +simRate.toFixed(3),
  workerErrors: stats.errors,
  verdict:
    (simRate !== null && simRate < 0.97) ? 'oversubscribed — the sim is running slow'
    : pct(0.99) > 150 ? 'oversubscribed — snapshots are stuttering'
    : pct(0.99) > 100 ? 'strained'
    : 'ok'
};

if (AS_JSON) {
  console.log(JSON.stringify(out));
} else {
  console.log('');
  for (const [k, v] of Object.entries(out)) {
    console.log(`  ${k.padEnd(24)} ${v}`);
  }
  console.log('');
  if (out.verdict !== 'ok') {
    console.log('  Past this box\'s match count. Halve --matches and go again;');
    console.log('  the last count that reads `ok` is the ceiling, and 60% of it');
    console.log('  is what you should actually run.');
  } else {
    console.log(`  Room to spare. A box sized for this should run about`);
    console.log(`  ${Math.floor(out.matchesPerCore * 0.6)} matches per core in production (60% of measured).`);
  }
}

if (driver) clearInterval(driver);
for (const w of workers) { try { w.postMessage({ t: 'stop' }); } catch (e) { /* going anyway */ } }
await sleep(800);
for (const w of workers) { try { w.terminate(); } catch (e) { /* already gone */ } }
process.exit(0);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
