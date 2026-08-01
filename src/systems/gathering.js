/**
 * Island Settlers — gathering system.
 *
 *   createGathering(state, world) -> { update(dt), ...introspection }
 *
 * Pickup is instant and contact-based. Every fixed step this module asks
 * `rules.sweepPickups` to collect whatever each settler is currently standing
 * on. That is the whole loop. There is no latching, no swing timer, no
 * `gatherIntent` lease and no `action === 'gather'` state — running over a sheep
 * takes the sheep, and the rest of the flock stays exactly where it is.
 *
 * ---------------------------------------------------------------------------
 * WHO OWNS WHAT
 * ---------------------------------------------------------------------------
 *   board/nodes.js — the item field, whole-hex recovery, the spatial lookup.
 *   rules.js       — `sweepPickups`, ownership gating (`canGatherTile`), and
 *                    the `gained` / `exhausted` / `restored` / `blocked` events.
 *   main.js        — turns those events into floating text, bursts and sound.
 *   here           — calls the sweep once per player per step, keeps the
 *                    deprecated prop layer in sync with regrowth, and exposes
 *                    the readouts the HUD wants (what am I standing on, may I
 *                    work it, how long until it comes back).
 *
 * ---------------------------------------------------------------------------
 * BOTS
 * ---------------------------------------------------------------------------
 * Bots call `sweepPickups` themselves so a headless match resolves without this
 * module. The call is idempotent per player per tick: whoever gets there second
 * receives -1 and does nothing. `gatherIntent` no longer exists — bots simply
 * steer over the items they want.
 *
 * Owner: Gameplay agent.
 */

import { PICKUP_RADIUS } from '../core/constants.js';
import { sweepPickups, canGatherTile, playerOwnsTile } from '../core/rules.js';
import {
  nodes, itemsNear, nearestItem, tileRecovery,
  tileItemsRemaining, tileItemCount, isTileExhausted
} from '../board/nodes.js';
import { tileAt } from '../board/layout.js';

const RECENT_PICK = 0.35;   // seconds a settler still counts as "harvesting"

export function createGathering(state, world) {
  const W = world || {};

  function safe(fn) {
    try { return fn(); } catch (e) { return undefined; }
  }

  /* ---------------------------------------------------------------- regrowth
   * Nobody else consumes the deprecated `node.justRegrew` flag, so an old
   * renderer's stumps would stay stumps. Clear it and put the prop back. */
  function syncRegrowth() {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (!n.justRegrew) continue;
      n.justRegrew = false;
      safe(() => W.props && W.props.setDepleted && W.props.setDepleted(n.id, false));
    }
  }

  /* -------------------------------------------------------------------- loop */

  function update(dt) {
    syncRegrowth();
    if (!state || !state.players) return;
    if (state.phase !== 'play') {
      for (const p of state.players) p.gatherPct = 0;
      return;
    }
    for (const p of state.players) {
      sweepPickups(state, p.id);
      p.gatherPct = 0;
    }
  }

  /* --------------------------------------------------------------------- api */

  const scratch = [];

  const api = {
    update,
    radius: PICKUP_RADIUS,

    /** The hex this settler is standing on, or -1. */
    tileUnder(pid = 0) {
      const p = state.players[pid];
      if (!p) return -1;
      const t = tileAt(p.x, p.z);
      return t ? t.id : -1;
    },

    /** May this settler collect on the hex they are standing on? */
    canGatherHere(pid = 0) {
      const t = api.tileUnder(pid);
      return t >= 0 && canGatherTile(state, pid, t);
    },

    /** Why not, if not: 'ok' | 'unowned' | 'raider' | 'empty' | 'none'. */
    statusHere(pid = 0) {
      const t = api.tileUnder(pid);
      if (t < 0) return 'none';
      if (!playerOwnsTile(state, pid, t)) return 'unowned';
      if (!canGatherTile(state, pid, t)) return 'raider';
      if (isTileExhausted(t)) return 'empty';
      return 'ok';
    },

    /** Items this settler is close enough to take right now. */
    itemsInReach(pid = 0) {
      const p = state.players[pid];
      if (!p) return [];
      const near = itemsNear(p.x, p.z, PICKUP_RADIUS, scratch);
      return near.filter(it => it.available && canGatherTile(state, pid, it.tile));
    },

    /** Nearest item this settler is actually allowed to take. */
    nextItem(pid = 0, maxDist = Infinity) {
      const p = state.players[pid];
      if (!p) return null;
      return nearestItem(p.x, p.z, {
        maxDist,
        filter: it => canGatherTile(state, pid, it.tile)
      });
    },

    /** Did this settler pick something up in the last fraction of a second? */
    isGathering(pid = 0) {
      const p = state.players[pid];
      return !!(p && p.pickedAt >= 0 && state.time - p.pickedAt < RECENT_PICK);
    },

    tileRecovery(tileId) { return tileRecovery(tileId, state.time); },
    tileItemsRemaining,
    tileItemCount,

    /** Nothing has a progress bar any more; kept so old HUD code reads 0. */
    get progress() { return 0; },
    progressOf() { return 0; },
    swingTimeOf() { return 0; },
    activeNode() { return null; },
    setIntent() { return false; },
    release() {}
  };

  for (const p of state.players || []) {
    if (p.gatherPct === undefined) p.gatherPct = 0;
    if (p.gatherIntent === undefined) p.gatherIntent = null;
  }
  if (world) world.gathering = api;

  return api;
}

export default createGathering;
