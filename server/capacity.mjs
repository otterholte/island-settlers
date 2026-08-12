/**
 * Island Settlers — how much of this machine is there, and is it coping?
 *
 *   machineSize()  -> { cores, memoryMB, source }
 *   matchCeiling() -> how many concurrent matches this box should ever hold
 *   memoryHeadroom() -> 0..1, how much of the memory limit is still free
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `MAX_MATCHES` was 6. Six matches is twenty-four players, and player
 * twenty-five was told the server was busy — on a box that was using about
 * three percent of its processor. The number was a guess written against the
 * smallest Fly machine and it never moved, so the game's entire population cap
 * was a constant in a file rather than anything to do with the hardware.
 *
 * It is measured now. `tools/loadbench.mjs` runs real matches and reports what
 * one costs: about **0.008 of a core and 15-25MB**, and the snapshot cadence
 * stays flat until roughly 60% of the processor is gone. The numbers below are
 * that measurement with a wide margin on top, and the ceiling is computed from
 * whatever the machine turns out to be rather than assumed.
 *
 * WHY NOT JUST os.cpus()
 * ----------------------
 * Because this runs in a container and `os.cpus()` reports the HOST's
 * processors, not the share this container is allowed to use. A 512MB Railway
 * container on a 32-core host would read 32 cores, compute a ceiling of
 * sixteen hundred matches, accept them, and be killed for running out of
 * memory — taking every match with it, which is the exact failure the old
 * hardcoded 6 was there to prevent. So the cgroup files are read first and the
 * `os` module is only the fallback for running on a laptop.
 *
 * Owner: net agent.
 */

import { readFileSync } from 'node:fs';
import os from 'node:os';

/* ------------------------------------------------------------ measurements

   From tools/loadbench.mjs on a 2-vCPU box, 2 human seats + 2 bots per match:

     64 matches   0.485 cores   19MB each   snapshot gap 49/65ms   ok
    200 matches   1.659 cores   15MB each   snapshot gap 47/131ms  breaks

   The break is at ~83% of the processor, so the honest ceiling is well under
   the arithmetic one. These constants are deliberately pessimistic against the
   measurement — roughly 2.5x on memory and 2.4x on CPU — because being wrong
   in the generous direction means an out-of-memory kill that ends every match
   on the box, and being wrong in the mean direction only means a full server
   politely turning somebody away. */
const MATCHES_PER_CORE = 50;
const MB_PER_MATCH = 45;
/** Node itself, the websockets, and room for the heap to breathe. */
const RESERVE_MB = 192;

/** Never trust a computed ceiling past this without an explicit MAX_MATCHES.
 *  A single process holding more than this many worker threads is territory
 *  nothing here has been tested in. */
const SANITY_CAP = 400;

function readNum(path) {
  try {
    const s = readFileSync(path, 'utf8').trim();
    if (!s || s === 'max' || s === '-1') return null;
    const n = Number(s.split(/\s+/)[0]);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch (e) {
    return null;
  }
}

/** cgroup v2 puts "quota period" on one line; v1 splits it over two files.
 *  Either way the answer is a fraction of one processor. */
function cgroupCores() {
  try {
    const v2 = readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim();
    const [quota, period] = v2.split(/\s+/);
    if (quota && quota !== 'max') {
      const c = Number(quota) / Number(period || 100000);
      if (Number.isFinite(c) && c > 0) return c;
    }
  } catch (e) { /* not v2, or not in a container */ }
  const q = readNum('/sys/fs/cgroup/cpu/cpu.cfs_quota_us');
  const p = readNum('/sys/fs/cgroup/cpu/cpu.cfs_period_us');
  if (q && p) return q / p;
  return null;
}

function cgroupMemoryMB() {
  const v2 = readNum('/sys/fs/cgroup/memory.max');
  const v1 = readNum('/sys/fs/cgroup/memory/memory.limit_in_bytes');
  const bytes = v2 || v1;
  // An unset v1 limit is a comically large number rather than absent. Anything
  // above a terabyte is "no limit", not a machine.
  if (!bytes || bytes > 1024 ** 4) return null;
  return Math.floor(bytes / 1048576);
}

let cached = null;

export function machineSize() {
  if (cached) return cached;
  const cgCores = cgroupCores();
  const cgMem = cgroupMemoryMB();
  const osCores = Math.max(1, os.availableParallelism ? os.availableParallelism() : os.cpus().length);
  const osMem = Math.floor(os.totalmem() / 1048576);
  cached = {
    cores: cgCores || osCores,
    memoryMB: cgMem || osMem,
    // Worth logging: "cgroup" means the number is the container's real share,
    // "os" means we are reading the whole host and should be believed less.
    source: cgCores || cgMem ? 'cgroup' : 'os'
  };
  return cached;
}

/**
 * The hard ceiling. Whichever runs out first — processor or memory — wins,
 * because a box that is out of either is out.
 */
export function matchCeiling() {
  const { cores, memoryMB } = machineSize();
  const byCpu = Math.floor(cores * MATCHES_PER_CORE);
  const byMemory = Math.floor(Math.max(0, memoryMB - RESERVE_MB) / MB_PER_MATCH);
  return Math.max(1, Math.min(SANITY_CAP, byCpu, byMemory));
}

/**
 * How much of the memory limit is still free, as 0..1.
 *
 * The ceiling above is a static estimate; this is the live truth, and it is
 * what stops a box that estimated generously from finding out the hard way.
 */
export function memoryHeadroom() {
  const { memoryMB } = machineSize();
  const usedMB = process.memoryUsage.rss() / 1048576;
  return Math.max(0, 1 - usedMB / Math.max(1, memoryMB));
}

export function describe() {
  const { cores, memoryMB, source } = machineSize();
  return `${cores.toFixed(2)} cores · ${memoryMB}MB · ceiling ${matchCeiling()} matches (read from ${source})`;
}

export default { machineSize, matchCeiling, memoryHeadroom, describe };
