/**
 * Island Settlers — in-place match reset.
 *
 *   resetMatchInPlace(state, game, opts) -> true | false
 *
 * `game.restart()` in main.js reloads the page, which works but throws away the
 * island, every texture and every buffer for the sake of clearing eight
 * settlements. This rebuilds the match instead.
 *
 * The important constraint: **nothing may be replaced, only cleared.** Every
 * module in the build captured references when it was constructed — hud.js and
 * panels.js hold `state.players[0]`, bots.js holds all three rival player
 * objects, playerController.js holds the human's — so swapping in a fresh
 * `createMatch()` result would leave the interface pointed at a dead match.
 * Each field is therefore reset on the object that already exists.
 *
 * Returns false if anything required is missing, and the caller falls back to
 * the reload path. It never throws.
 *
 * Owner: Flow agent.
 */

import { START_RESOURCES } from '../core/constants.js';
import { SPAWNS, DESERT } from '../board/layout.js';
import { resetNodes, mulberry32 } from '../board/nodes.js';

const SETUP_ORDER = [0, 1, 2, 3, 3, 2, 1, 0];

function resetPlayer(p) {
  const spawn = SPAWNS[p.id] || { x: 0, z: 0, facing: 0 };
  p.res = { ...START_RESOURCES };
  p.roads.clear(); p.settlements.clear(); p.cities.clear(); p.ports.clear();
  p.cards.length = 0;
  p.knightsPlayed = 0;
  p.vpCards = 0;
  p.longestRoadLen = 0;
  p.hasLongestRoad = false;
  p.hasLargestArmy = false;
  p.freeRoads = 0;
  p.x = spawn.x; p.z = spawn.z; p.facing = spawn.facing;
  p.vx = 0; p.vz = 0;
  p.action = 'idle';
  p.gatherNode = null;
  p.gatherIntent = null;
  p.gatherProgress = 0;
  p.gatherTime = 1;
  p.carried = 0;
  p.nearTarget = null;
  p.nearTrade = null;
  p.stats = { gathered: 0, traded: 0, built: 0, cardsPlayed: 0, distance: 0 };
}

function resetState(state, seed) {
  state.buildings.clear();
  state.roadOwner.clear();
  state.events.length = 0;
  if (Array.isArray(state.log)) state.log.length = 0;
  state.phase = 'setup';
  state.time = 0;
  state.winner = -1;
  state.robberTile = DESERT.id;
  state.robberOwner = -1;
  state.longestRoadHolder = -1;
  state.largestArmyHolder = -1;
  state.setupOrder = SETUP_ORDER.slice();
  state.setupIndex = 0;
  state.setupNeed = 'settlement';
  state.setupAnchor = -1;
  state.rng = mulberry32(seed >>> 0);
  state.flowActive = true;
}

function resyncWorld(state, game, world) {
  world.structures.syncFromState();

  if (world.island && typeof world.island.clearHighlights === 'function') {
    try { world.island.clearHighlights(); } catch (e) { /* optional */ }
  }
  // The item field is put back by `resetNodes()` above, and the prop renderer
  // polls the item flags every frame (world/nodelife.js) rather than being
  // told. The old per-node `setDepleted(id,false)` sweep across the deprecated
  // `nodes` array had nothing left to talk to and is gone.

  const avatars = game.avatars || world.avatars;
  if (Array.isArray(avatars)) {
    const h = typeof world.heightAt === 'function' ? world.heightAt : () => 0;
    avatars.forEach((a, i) => {
      const p = state.players[i];
      if (a && a.group && a.group.position && p) {
        a.group.position.set(p.x, h(p.x, p.z), p.z);
      }
    });
  }
}

/**
 * The rival brains outlive the match: bots.js builds them once, in main.js, and
 * nothing here can replace them. Left alone they carry a goal aimed at a
 * building that no longer exists, blacklists keyed on the *old* clock, and a
 * `lastKnight` stamp from ~200s in — which, against a match clock that has just
 * gone back to zero, reads as "played a knight in the future" and suppresses
 * the Knight heuristic for the whole replay.
 *
 * main.js exposes the bots on `game`, so wipe the per-match fields in place
 * (never the identity fields: rng, lag, speedScale, noise — those are the
 * personalities, and a replayed Alex should still move like Alex).
 */
function resetBots(game) {
  const bots = game.bots;
  if (!bots) return false;
  if (typeof bots.reset === 'function') {
    try { bots.reset(); return true; } catch (e) { /* fall through */ }
  }
  const brains = bots.brains;
  if (!Array.isArray(brains)) return false;
  brains.forEach((b, i) => {
    b.goal = null;
    b.hold = 0;
    b.stuck = 0;
    b.sinceAct = 0;
    b.watchProgress = -1;
    b.externalGather = false;
    b.intentAge = 0;
    b.lastKnight = -999;
    b.think = 0.15 + i * 0.17;
    if (b.avoidNodes && b.avoidNodes.clear) b.avoidNodes.clear();
    if (b.avoidGoals && b.avoidGoals.clear) b.avoidGoals.clear();
  });
  return true;
}

function resetInterface(game) {
  // showResults() is deliberately un-closeable — only "Play Again" leaves it.
  // Routing through a dismissible sheet lets the modal layer go without a
  // reload, and it never becomes visible because `close()` lands first.
  const panels = game.panels;
  if (panels && panels.kind === 'results') {
    if (typeof panels.openTrade === 'function') panels.openTrade(null);
    if (typeof panels.close === 'function') panels.close();
  }
  if (game.overview && typeof game.overview.close === 'function') game.overview.close();

  // Put the HUD back into its pre-match state; hud.js drops the class itself
  // the moment the new draft finishes.
  const hudRoot = game.hud && game.hud.root;
  if (hudRoot && hudRoot.classList) hudRoot.classList.add('pre');

  const cam = game.camera;
  if (cam && typeof cam.setOverview === 'function') cam.setOverview(false);
}

export function resetMatchInPlace(state, game, opts = {}) {
  try {
    const g = game || {};
    const world = g.world;
    if (!state || !Array.isArray(state.players) || !state.players.length) return false;
    if (!state.buildings || !state.roadOwner) return false;
    if (!world || !world.structures || typeof world.structures.syncFromState !== 'function') {
      return false;
    }

    resetNodes();
    for (const p of state.players) resetPlayer(p);
    resetState(state, (opts.seed ?? (Math.random() * 1e9)) | 0);
    resyncWorld(state, g, world);
    resetBots(g);
    resetInterface(g);
    return true;
  } catch (err) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[flow] in-place restart failed —', err && err.message);
    }
    return false;
  }
}

export default resetMatchInPlace;
