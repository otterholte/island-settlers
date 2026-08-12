/**
 * Island Settlers — match supervision.
 *
 *   createMatchHost({ onMessage, onExit }) -> { start, stop, get, input, act, peer, size }
 *
 * Owns the worker threads. Knows nothing about the game and nothing about
 * websockets: it starts a worker, forwards messages both ways, and makes sure
 * that a match which dies, hangs or is abandoned stops costing anything.
 *
 * THE THREE WAYS A MATCH ENDS
 * ---------------------------
 *   1. Somebody wins, or the clock runs out. The worker posts `over`, the hub
 *      shows the results, and the worker is stopped a few seconds later so the
 *      final events have somewhere to arrive.
 *   2. Everybody leaves. There is nobody to send snapshots to; stop at once.
 *   3. It breaks. A worker that throws, exits, or stops posting is not nursed —
 *      it is killed and everybody is told, because a half-running match is
 *      worse than no match.
 *
 * WHY A HARD CAP ON CONCURRENT MATCHES
 * ------------------------------------
 * Each worker is a whole module registry — an island, three hundred items,
 * four bot brains — which is roughly 40MB. On the smallest Fly machine that is
 * a handful of matches before the box is out of memory, and an out-of-memory
 * kill takes every match down, not just the one that asked for too much. So
 * the limit is explicit and the refusal is polite.
 *
 * Owner: net agent.
 */

import { Worker } from 'node:worker_threads';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { matchCeiling, memoryHeadroom, describe } from './capacity.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = resolve(HERE, 'matchworker.mjs');

/** Measured from the machine rather than guessed — see capacity.mjs. `6` was
 *  a constant written for a 256MB VM and it capped the entire game at
 *  twenty-four players regardless of what it was running on. Set MAX_MATCHES
 *  to override; leave it unset and the box decides. */
const MAX_MATCHES = Number(process.env.MAX_MATCHES) || matchCeiling();

/**
 * A worker that has not posted anything in this long is wedged.
 *
 * THIS USED TO BE 20 SECONDS AND THAT WAS AN OUTAGE WAITING TO HAPPEN.
 * Measured under load at 83% CPU, healthy workers stalled for as long as 12.7
 * seconds before their accumulator caught them up — well inside a 20s budget,
 * but not by much. The failure mode is vicious: a busy box starts killing
 * LIVE MATCHES, which frees memory, which lets more matches start, which
 * makes it busier. Overload must shed new matches, never running ones, so
 * this is now far enough out that only a genuinely dead worker trips it.
 */
const SILENCE_MS = Number(process.env.MATCH_SILENCE_MS) || 60000;
/** A worker quiet for this long is not dead, but it is suffering — and a box
 *  with several of them should not be accepting new work. */
const STALL_MS = 3000;
/** Refuse new matches once memory is this close to the limit, whatever the
 *  match count says. The static ceiling is an estimate; this is the truth. */
const MIN_MEMORY_HEADROOM = 0.15;
/** How long the results stay live after the winner is known. */
const LINGER_MS = 20000;
/** A match cannot run forever, whatever the worker thinks. */
const HARD_LIFE_MS = 45 * 60 * 1000;

export function createMatchHost(opts = {}) {
  const onMessage = typeof opts.onMessage === 'function' ? opts.onMessage : () => {};
  const onExit = typeof opts.onExit === 'function' ? opts.onExit : () => {};
  const matches = new Map();   // matchId -> record

  /**
   * May another match start right now?
   *
   * Three questions, and a no to any of them means the same polite refusal.
   * The point is that this is asked at the DOOR. Once a match is running it is
   * somebody's evening and it does not get sacrificed to make room for
   * somebody else's — a server under pressure turns people away, it does not
   * kill games it already promised.
   */
  function admit() {
    if (matches.size >= MAX_MATCHES) return 'busy';
    if (memoryHeadroom() < MIN_MEMORY_HEADROOM) return 'busy';
    // If a meaningful share of what is already running is struggling to keep
    // its 50ms snapshot cadence, this box is past its real ceiling whatever
    // the arithmetic said. Stop adding to it.
    const now = Date.now();
    let stalling = 0;
    for (const rec of matches.values()) {
      if (!rec.stopping && !rec.over && now - rec.lastPost > STALL_MS) stalling++;
    }
    if (matches.size >= 4 && stalling / matches.size > 0.2) return 'busy';
    return null;
  }

  function start(cfg) {
    const refusal = admit();
    if (refusal) return { error: refusal };
    const matchId = randomBytes(6).toString('base64url');
    let worker;
    try {
      worker = new Worker(WORKER, {
        workerData: { ...cfg, matchId },
        // The sim allocates almost nothing per frame; the ceiling is here to
        // turn a runaway match into one dead match instead of a dead server.
        resourceLimits: { maxOldGenerationSizeMb: 192 }
      });
    } catch (e) {
      console.error('[match] worker would not start:', e && e.message);
      return { error: 'internal' };
    }

    const rec = {
      matchId,
      worker,
      cfg,
      roomId: cfg.roomId || null,
      startedAt: Date.now(),
      lastPost: Date.now(),
      over: false,
      stopping: false,
      linger: null
    };
    matches.set(matchId, rec);

    worker.on('message', msg => {
      rec.lastPost = Date.now();
      if (msg && msg.t === 'over' && !rec.over) {
        rec.over = true;
        // Let the last events land, then reclaim the thread. Nobody is
        // simulating anything after this; the worker is only alive so a
        // client reconnecting inside the window still sees a result.
        rec.linger = setTimeout(() => stop(matchId, 'finished'), LINGER_MS);
        rec.linger.unref?.();
      }
      try { onMessage(matchId, msg, rec); } catch (e) {
        console.error('[match] onMessage:', e && e.stack);
      }
    });

    worker.on('error', e => {
      console.error(`[match] ${matchId} threw:`, e && e.stack ? e.stack : e);
      finish(matchId, 'error');
    });

    worker.on('exit', code => {
      if (code !== 0 && !rec.stopping) {
        console.error(`[match] ${matchId} exited with ${code}`);
      }
      finish(matchId, rec.stopping ? 'stopped' : 'exited');
    });

    return { matchId, rec };
  }

  function get(matchId) {
    return matches.get(matchId) || null;
  }

  function post(matchId, msg) {
    const rec = matches.get(matchId);
    if (!rec || rec.stopping) return false;
    try { rec.worker.postMessage(msg); return true; } catch (e) { return false; }
  }

  const input = (matchId, pid, x, z) => post(matchId, { t: 'in', pid, x, z });

  /* The spread goes FIRST and the envelope goes last, on purpose. `body` is
     the client's own message, which still carries its `t` ('m.act') and its
     own `i`; spreading it after the envelope let those overwrite the worker's
     routing fields, so every act arrived as an unknown message type, fell
     through the switch, and was never answered. The symptom was a draft where
     nobody's pick ever landed and the pick clock ran out on every turn. */
  const act = (matchId, pid, i, body) => post(matchId, { ...body, t: 'act', pid, i });
  const peer = (matchId, pid, state) => post(matchId, { t: 'peer', pid, state });

  function stop(matchId, reason = 'stopped') {
    const rec = matches.get(matchId);
    if (!rec || rec.stopping) return;
    rec.stopping = true;
    if (rec.linger) { clearTimeout(rec.linger); rec.linger = null; }
    // Ask nicely — the worker clears its own interval, which lets the thread
    // exit on its own — then insist, because a wedged loop will not answer.
    /* Do not go through `post`: it deliberately refuses a record whose
       `stopping` flag is set. The old ordering therefore never sent this
       message and every normal stop waited for the 500ms axe. */
    try { rec.worker.postMessage({ t: 'stop' }); } catch (e) { /* axe below */ }
    const axe = setTimeout(() => {
      try { rec.worker.terminate(); } catch (e) { /* already gone */ }
    }, 500);
    axe.unref?.();
    rec.stopReason = reason;
  }

  function finish(matchId, reason) {
    const rec = matches.get(matchId);
    if (!rec) return;
    matches.delete(matchId);
    if (rec.linger) clearTimeout(rec.linger);
    try { rec.worker.terminate(); } catch (e) { /* fine */ }
    try { onExit(matchId, rec.stopReason || reason, rec); } catch (e) {
      console.error('[match] onExit:', e && e.stack);
    }
  }

  /* The watchdog. Two failure modes it catches that nothing else does: a
     worker that stopped posting without exiting (a busy loop, a deadlock in a
     native call), and a match that has simply been running far too long. */
  const watch = setInterval(() => {
    const now = Date.now();
    for (const [id, rec] of matches) {
      if (rec.stopping) continue;
      if (now - rec.lastPost > SILENCE_MS) {
        console.error(`[match] ${id} went quiet for ${Math.round((now - rec.lastPost) / 1000)}s — killing it`);
        stop(id, 'wedged');
        continue;
      }
      if (now - rec.startedAt > HARD_LIFE_MS) stop(id, 'expired');
    }
  }, 5000);
  watch.unref?.();

  console.log(`[match] capacity: ${describe()}`);

  return {
    start, stop, get, post, input, act, peer,
    /** Exposed so /health can show it: "full" is a thing an operator should be
     *  able to see coming rather than infer from complaints. */
    admit,
    get size() { return matches.size; },
    get max() { return MAX_MATCHES; },
    get headroom() { return +memoryHeadroom().toFixed(3); },
    all: () => [...matches.values()],
    shutdown() {
      clearInterval(watch);
      for (const id of [...matches.keys()]) stop(id, 'shutdown');
    }
  };
}

export default createMatchHost;
