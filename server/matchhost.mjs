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

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = resolve(HERE, 'matchworker.mjs');

/** Tunable by env for a bigger machine; the default suits a 256MB Fly VM. */
const MAX_MATCHES = Number(process.env.MAX_MATCHES || 6);
/** A worker that has not posted anything in this long is wedged. */
const SILENCE_MS = 20000;
/** How long the results stay live after the winner is known. */
const LINGER_MS = 20000;
/** A match cannot run forever, whatever the worker thinks. */
const HARD_LIFE_MS = 45 * 60 * 1000;

export function createMatchHost(opts = {}) {
  const onMessage = typeof opts.onMessage === 'function' ? opts.onMessage : () => {};
  const onExit = typeof opts.onExit === 'function' ? opts.onExit : () => {};
  const matches = new Map();   // matchId -> record

  function start(cfg) {
    if (matches.size >= MAX_MATCHES) return { error: 'busy' };
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
    post(matchId, { t: 'stop' });
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

  return {
    start, stop, get, post, input, act, peer,
    get size() { return matches.size; },
    get max() { return MAX_MATCHES; },
    all: () => [...matches.values()],
    shutdown() {
      clearInterval(watch);
      for (const id of [...matches.keys()]) stop(id, 'shutdown');
    }
  };
}

export default createMatchHost;
