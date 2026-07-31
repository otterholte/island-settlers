/**
 * Island Settlers — gathering system.
 *
 *   createGathering(state, world) -> { update(dt), ...introspection }
 *
 * This module turns *intent* into rules calls. It never decides where anyone
 * should go and it never re-implements economy: yield, ownership multipliers,
 * node depletion and the Raider block all live in `core/rules.js`
 * (`beginGather` / `tickGather`). We only latch, tick, break off, and add the
 * feedback that `main.js` does not already produce from the event stream.
 *
 * ---------------------------------------------------------------------------
 * WHO OWNS WHAT (read this before adding a call here)
 * ---------------------------------------------------------------------------
 *   rules.js  — yield maths, `gatherStart` / `gained` / `blocked` events,
 *               node depletion, Raider legality.
 *   main.js   — reacts to those events: gather sound, `avatars[p].playChop()`
 *               on the FIRST swing, `effects.floatText` + `effects.burst` +
 *               `props.playHarvest(node)` on every `gained`, and
 *               `props.setDepleted(node, true)` when a node runs dry.
 *   here      — latching / un-latching, per-swing `playChop` for swings 2..n
 *               (main only ever sees one `gatherStart` per harvest), the
 *               depletion + regrowth feedback loop (`props.setDepleted(id,
 *               false)` on regrow — nobody else consumes `node.justRegrew`),
 *               a `blocked` event when the Raider interrupts a live harvest,
 *               and the progress value the HUD can draw.
 *
 * ---------------------------------------------------------------------------
 * BOT CONTRACT — `player.gatherIntent`            (Bot agent: this is for you)
 * ---------------------------------------------------------------------------
 * Bots do not call `beginGather` / `tickGather` themselves. They declare a
 * target and this system runs the harvest for them, exactly as it does for the
 * human:
 *
 *   p.gatherIntent = node        // a node OBJECT from `board/nodes.js`
 *   p.gatherIntent = node.id     // ...or its numeric id, both accepted
 *   p.gatherIntent = null        // stop / no target
 *
 * Rules of the contract:
 *   1. Set it the moment you commit to a node; you may set it while still
 *      walking. Gathering latches on automatically the first frame the bot is
 *      within INTERACT_RADIUS (2.6) of the node and the node is alive.
 *   2. Keep it set for as long as you want to keep harvesting. It is your
 *      lease on the node.
 *   3. Gathering CLEARS it (sets it to `null`) when the harvest can no longer
 *      continue — node depleted, or the Raider moved onto the tile. That null
 *      is your signal to pick a new target. It is never cleared just because
 *      you walked away, so a bot can leave and come back.
 *   4. Gathering NEVER moves a bot, never picks a target, and never writes
 *      `vx`/`vz`. Movement stays 100% yours.
 *   5. `p.action` is owned by gathering while a harvest runs: it sets
 *      `'gather'` on latch and drops back to `'idle'` on break-off. If your
 *      mover forces `p.action = 'run'` every frame the harvest is cancelled —
 *      only set `'run'` when the bot is actually moving.
 *   6. Read-only outputs you may use: `p.gatherNode` (node or null),
 *      `p.gatherProgress` (0..1 within the current swing), `p.gatherPct`
 *      (same value, clamped, 0 when idle), `p.gatherTime` (seconds per swing
 *      on this tile, 0.60–1.15).
 *
 * The human (player 0) uses the same field as an explicit override, but
 * normally gathers from `p.nearTarget`, which `playerController.js` sets when
 * the player is stopped inside INTERACT_RADIUS of a live node.
 *
 * Owner: Gameplay agent.
 */

import { INTERACT_RADIUS } from '../core/constants.js';
import { beginGather, tickGather, canGatherTile, emit } from '../core/rules.js';
import { nodes } from '../board/nodes.js';

/* Latch inside the interact radius, but keep working until a little further
   out — without hysteresis a settler hovering on the boundary would stutter
   in and out of the animation every other frame. */
const LATCH_R = INTERACT_RADIUS;
const HOLD_R = INTERACT_RADIUS * 1.35;

const RETRY_BLOCKED = 1.10;   // seconds before re-trying a Raider-blocked tile
const RETRY_FAIL = 0.30;      // seconds before re-trying any other refusal

const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Accepts a node object, a node id, or nothing. Returns a node or null. */
function resolveNode(ref) {
  if (ref === null || ref === undefined) return null;
  if (typeof ref === 'number') return nodes[ref] || null;
  if (typeof ref === 'object' && typeof ref.remaining === 'number') return ref;
  return null;
}

export function createGathering(state, world) {
  const W = world || {};

  /** Per-player scratch. Never leaks into `state`. */
  const rec = (state && state.players ? state.players : []).map(p => ({
    id: p.id,
    cool: 0,          // retry cooldown after a refused start
    node: null,       // node we latched (mirrors p.gatherNode)
    swings: 0,        // completed cycles this harvest
    blockedAt: -1     // tile we already complained about
  }));

  /* ------------------------------------------------------------ plumbing */

  // Presentation is optional and is being written in parallel: never let a
  // missing renderer break the simulation.
  function safe(fn) {
    try { return fn(); } catch (e) { return undefined; }
  }

  function avatarOf(pid) {
    const a = W.avatars;
    return a && a[pid] ? a[pid] : null;
  }

  /** The controller's input object is not on `world` at construction time.
   *  economy.attach() cross-wires it (world.input / world.game); until then we
   *  simply have no action button, which is fine — gathering is automatic. */
  function resolveInput() {
    if (W.input) return W.input;
    if (W.game && W.game.input) return W.game.input;
    const g = globalThis.__ISLAND__;
    if (g && g.game && g.game.input) return g.game.input;
    return null;
  }

  const dist2 = (p, n) => (p.x - n.x) * (p.x - n.x) + (p.z - n.z) * (p.z - n.z);

  /* ------------------------------------------------------------ feedback */

  function onLatch(p, n) {
    // main.js already plays the tool sound + the first playChop from the
    // `gatherStart` event. Add only the ground-level flourish it does not.
    if (p.id === 0) safe(() => W.effects && W.effects.ring && W.effects.ring(n.x, n.z, n.resource));
  }

  /** One swing landed and another is starting: keep the animation phase-locked
   *  to `p.gatherTime`, which varies 0.60s–1.15s with tile productivity. */
  function onSwing(p, n) {
    const av = avatarOf(p.id);
    if (av && av.playChop) safe(() => av.playChop(n.resource));
    if (p.id === 0) safe(() => W.camera && W.camera.shake && W.camera.shake(0.05));
  }

  function onDepleted(p, n) {
    // `props.setDepleted(id, true)` + the "+N" text come from main.js's
    // `gained` handler; the puff of dust when the last unit comes out is ours.
    safe(() => W.effects && W.effects.ring && W.effects.ring(n.x, n.z, n.resource));
    if (p.id === 0) safe(() => W.camera && W.camera.shake && W.camera.shake(0.10));
  }

  /** Nobody else consumes `node.justRegrew`, so the depleted stump would stay
   *  a stump forever. Clear the flag and put the prop back. */
  function syncRegrowth() {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (!n.justRegrew) continue;
      n.justRegrew = false;
      safe(() => W.props && W.props.setDepleted && W.props.setDepleted(n.id, false));
    }
  }

  /* -------------------------------------------------------------- harvest */

  function clearIntent(p) {
    if (p.gatherIntent !== null && p.gatherIntent !== undefined) p.gatherIntent = null;
  }

  function stop(p) {
    if (p.action === 'gather') p.action = 'idle';
    p.gatherNode = null;
    p.gatherProgress = 0;
    const r = rec[p.id];
    if (r) { r.node = null; r.swings = 0; }
  }

  /** What this player wants to work on right now, or null. */
  function desired(p, forced) {
    let n = resolveNode(p.gatherIntent);
    const explicit = !!n;
    if (!n && p.id === 0) n = resolveNode(p.nearTarget);
    if (!n) return null;

    if (n.remaining <= 0) {
      if (explicit) clearIntent(p);
      return null;
    }
    if (dist2(p, n) > LATCH_R * LATCH_R) return null;
    // Human: gathering is automatic the moment you stand still. The action
    // button only short-circuits the "wait until stopped" rule.
    if (p.id === 0 && !forced && p.action === 'run') return null;
    return n;
  }

  function drive(p, dt, forced) {
    const r = rec[p.id];
    if (!r) return;
    if (r.cool > 0) r.cool -= dt;

    // Somebody else (the controller, a bot mover) dropped us out of the
    // gather action: clean up the stale node so nothing reads a ghost target.
    if (p.gatherNode && p.action !== 'gather') stop(p);

    /* ---------------------------------------------------- already working */
    if (p.action === 'gather' && p.gatherNode) {
      const n = p.gatherNode;

      if (dist2(p, n) > HOLD_R * HOLD_R) {          // walked off
        stop(p);
      } else if (n.remaining <= 0) {                // someone else emptied it
        stop(p);
        clearIntent(p);
      } else if (!canGatherTile(state, p.id, n.tile)) {
        // The Raider arrived mid-harvest. rules.js only emits `blocked` from
        // beginGather, so the interruption would otherwise be silent.
        stop(p);
        clearIntent(p);
        if (p.id === 0 && r.blockedAt !== n.tile) {
          r.blockedAt = n.tile;
          emit(state, 'blocked', { player: p.id, tile: n.tile });
        }
        r.cool = RETRY_BLOCKED;
      } else {
        const before = p.gatherProgress;
        tickGather(state, p.id, dt);
        const completed = p.gatherProgress < before;
        if (completed) r.swings++;

        if (p.action !== 'gather' || !p.gatherNode) {
          // rules.js ended the harvest: the node ran dry on that swing.
          onDepleted(p, n);
          stop(p);
          clearIntent(p);
        } else if (completed) {
          onSwing(p, n);
        }
      }
    }

    /* -------------------------------------------------------- start a new */
    if (p.action !== 'gather' || !p.gatherNode) {
      const want = desired(p, forced);
      if (want && (r.cool <= 0 || forced)) {
        if (beginGather(state, p.id, want)) {
          r.node = want;
          r.swings = 0;
          r.blockedAt = -1;
          onLatch(p, want);
        } else if (!canGatherTile(state, p.id, want.tile)) {
          r.blockedAt = want.tile;
          r.cool = RETRY_BLOCKED;
          clearIntent(p);
        } else {
          r.cool = RETRY_FAIL;
          if (want.remaining <= 0) clearIntent(p);
        }
      }
    }

    p.gatherPct = p.action === 'gather' && p.gatherNode ? clamp01(p.gatherProgress) : 0;
  }

  /* ----------------------------------------------------------------- loop */

  function update(dt) {
    const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.1) : 1 / 60;

    // Regrowth is presentation-only bookkeeping and is safe in every phase.
    syncRegrowth();

    if (!state || !state.players) return;

    if (state.phase !== 'play') {
      for (const p of state.players) {
        if (p.action === 'gather') stop(p);
        p.gatherPct = 0;
      }
      return;
    }

    const input = resolveInput();
    const pressed = !!(input && input.actionPressed);

    for (const p of state.players) drive(p, step, pressed && p.id === 0);
  }

  /* ------------------------------------------------------------------ api */

  const api = {
    update,

    /** 0..1 progress of the current swing for the human — what the HUD draws
     *  around the gather prompt. 0 when not gathering. */
    get progress() {
      const p = state.players[0];
      return p && p.action === 'gather' && p.gatherNode ? clamp01(p.gatherProgress) : 0;
    },
    /** Same, for any player id. */
    progressOf(pid) {
      const p = state.players[pid];
      return p && p.action === 'gather' && p.gatherNode ? clamp01(p.gatherProgress) : 0;
    },
    /** Seconds one swing takes for this player on their current tile. */
    swingTimeOf(pid) {
      const p = state.players[pid];
      return p ? p.gatherTime || 0 : 0;
    },
    isGathering(pid = 0) {
      const p = state.players[pid];
      return !!(p && p.action === 'gather' && p.gatherNode);
    },
    activeNode(pid = 0) {
      const p = state.players[pid];
      return p ? p.gatherNode || null : null;
    },
    /** Explicit target setter — the same field bots write, exposed so UI or
     *  flow code never has to poke a player object directly. */
    setIntent(pid, ref) {
      const p = state.players[pid];
      if (!p) return false;
      const n = resolveNode(ref);
      p.gatherIntent = n;
      return !!n;
    },
    /** Cancel whatever this player is harvesting. */
    release(pid = 0) {
      const p = state.players[pid];
      if (!p) return;
      stop(p);
      clearIntent(p);
      p.gatherPct = 0;
    }
  };

  // Seed the fields so every consumer sees them from frame zero.
  for (const p of state.players || []) {
    if (p.gatherIntent === undefined) p.gatherIntent = null;
    if (p.gatherPct === undefined) p.gatherPct = 0;
  }
  if (world) world.gathering = api;

  return api;
}

export default createGathering;
