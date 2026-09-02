/**
 * Island Settlers — economy: purchases, placement payment and trading.
 *
 *   attach(game) -> api        (main.js calls this once, after the UI exists)
 *
 * Everything here is also exported standalone (`buy`, `trade`, `canPlay`, ...)
 * against the last attached `game`, so the UI can `import { trade } from
 * '../systems/economy.js'` without threading an object around.
 *
 * ---------------------------------------------------------------------------
 * WHO OWNS WHICH CALL (the UI landed first; this module complements it)
 * ---------------------------------------------------------------------------
 *   hud.js       Its own build cards call hud's *internal* `requestBuild`,
 *                which does the same affordability gate as `buy()` and then
 *                `game.openOverview('place-<kind>')`. That path stays as it
 *                is — it is correct for a normal, paid purchase. We do not
 *                fight it, we mirror it.
 *   overview.js  Owns the placement UI and, with no `onConfirm` supplied,
 *                calls `placeRoad` / `placeSettlement` / `upgradeCity` /
 *                `playKnight` itself on Confirm. rules.js pays there, so a
 *                cancelled placement is free either way.
 *   panels.js    Owns the trade sheet (`doTrade` + `activeTradeRatio`) and the
 *                Road Building card (`playRoadBuilding` + its own free-road
 *                loop). `trade()` here is the programmatic equivalent with the
 *                proximity rule enforced, and it returns a reason string that
 *                panels can display verbatim.
 *   here         `game.requestBuild` is re-pointed at `buy()` on attach, so
 *                every purchase that goes through the `game` object (panels'
 *                Buy Card, matchflow, bots-driven UI) runs one code path — one
 *                that also understands `player.freeRoads`. Payment for a
 *                placement always happens inside the confirm callback, never
 *                when the map opens.
 *
 * Owner: Gameplay agent.
 */

import {
  RES, RES_LABEL, COST, PIECE_LIMIT, TRADE_RADIUS, PORT_RADIUS,
  canAfford, missingFrom
} from '../core/constants.js';

import {
  placeRoad, placeSettlement, upgradeCity,
  drawCard, playKnight, playRoadBuilding, hasCard,
  activeTradeRatio, tradeRatio, doTrade,
  legalRoads, legalSettlements, legalCities,
  nearestPortFor
} from '../core/rules.js';

import { MARKET, ports } from '../board/layout.js';

/** Milliseconds between two chained free-road placements — long enough for the
 *  overview's close transition to run before it re-opens. */
const FREE_ROAD_GAP_MS = 340;

/* ============================================================= the network
 *
 * In an online match NOTHING here may change the board.
 *
 * The server is running this same rulebook and it is the only copy that
 * counts; a client that also paid for its own road would be spending money
 * twice and putting a piece down that the server may be about to refuse. So
 * every mutation in this file asks first: is there a net agent? If there is,
 * the action goes down the wire and the piece appears when the server's event
 * comes back — sixty milliseconds later, through exactly the same `build`
 * handler that draws it in single player.
 *
 * The gates ABOVE the mutation stay where they are. Affordability, piece caps,
 * legal targets, proximity to a dock — all of that still runs locally, because
 * it is what makes the interface honest before you commit, and because being
 * told "need 2 more brick" instantly beats being told it by a server. The
 * server checks all of it again and does not believe a word of ours.
 *
 * `netAgent(kind, body)` returns true if it took the action. Null in single
 * player, which is every branch below falling through to the local rules
 * exactly as it always has.
 */
let netAgent = null;

/** systems/netmatch.js installs this when a networked match begins, and
 *  clears it when one ends. */
export function setNetAgent(fn) {
  netAgent = typeof fn === 'function' ? fn : null;
  return netAgent;
}

export function isNetMatch() { return !!netAgent; }

/**
 * The last line of defence, called by `overview.js` at the moment it would
 * otherwise place a piece itself.
 *
 * The board map places pieces directly whenever nobody handed it an
 * `onConfirm` — which is the normal route for a build card, and would be a
 * quiet way for a client to put a road down that the server never agreed to.
 * Returning true here means "sent; do not touch the board".
 */
export function netCommit(mode, id) {
  if (!netAgent) return false;
  const kind = {
    'place-road': 'build.road',
    'place-settlement': 'build.settlement',
    'place-city': 'build.city',
    'place-robber': 'play.knight'
  }[mode];
  if (!kind) return false;
  return netAgent(kind, kind === 'play.knight' ? { tile: id } : { id });
}

/**
 * Seconds of breathing room after the player cancels out of a free-road
 * placement.
 *
 * main.js reconciles the debt from state every single frame — any frame the
 * player is owed a road and nothing is in the way, it calls `placeFreeRoads`
 * again. That is what makes the feature self-healing, and it is also what made
 * Cancel look broken: the map came straight back on the next frame. The debt is
 * still owed and the map still returns; it just waits long enough for the tap
 * to have visibly done something and for the player to look at the board.
 */
const FREE_ROAD_DEFER_SEC = 2.4;

/* Radii match the HUD prompt exactly: economy must never refuse a trade the
   on-screen prompt just offered. The dock number is now `PORT_RADIUS` from
   core/constants.js, which `playerController` reads for `nearTrade` too, so
   the prompt and the rule cannot drift apart again — they were 6 and 9. */
const MARKET_REACH = TRADE_RADIUS + MARKET.radius;
const PORT_REACH = PORT_RADIUS;

let G = null;   // the attached game

/* ======================================================== small utilities */

function safe(fn) {
  try { return fn(); } catch (e) { return undefined; }
}

function say(g, msg, kind) {
  if (!msg) return;
  safe(() => g && g.hud && g.hud.toast && g.hud.toast(msg, kind));
  if (!(g && g.hud && g.hud.toast)) safe(() => g && g.toast && g.toast(msg, kind));
}

/* Every sound this file makes is the local player's own doing — their
   purchase, their refusal, their trade — so all of them are allowed to reach
   the hand. `mine` is what audio.js now gates haptics on; see the note there. */
function sfx(g, name) {
  safe(() => g && g.audio && g.audio.sfx && g.audio.sfx(name, { mine: true }));
}

function flash(g, kind) {
  safe(() => g && g.hud && g.hud.flashCost && g.hud.flashCost(kind));
}

function deny(g, kind, msg) {
  if (kind) flash(g, kind);
  say(g, msg, 'bad');
  sfx(g, 'deny');
  return false;
}

function listMissing(miss) {
  return Object.keys(miss)
    .map(r => `${miss[r]} ${RES_LABEL[r] || r}`)
    .join(', ');
}

function me(g) {
  return g && g.state && g.state.players ? g.state.players[0] : null;
}

function pieceCapped(state, pid, kind) {
  const p = state.players[pid];
  if (kind === 'road') return p.roads.size >= PIECE_LIMIT.road;
  if (kind === 'settlement') return p.settlements.size + p.cities.size >= PIECE_LIMIT.settlement;
  if (kind === 'city') return p.cities.size >= PIECE_LIMIT.city;
  return false;
}

function legalFor(state, kind) {
  if (kind === 'road') return legalRoads(state, 0);
  if (kind === 'settlement') return legalSettlements(state, 0);
  if (kind === 'city') return legalCities(state, 0);
  return [0];
}

const freeRoadsOf = p => Math.max(0, p && p.freeRoads ? p.freeRoads | 0 : 0);

/* ================================================================= helpers
   Used by the HUD build cards to grey themselves out and show shortfalls. */

/** The cost the player would actually pay right now — `{}` for a free road. */
export function costOf(kind, game = G) {
  const cost = COST[kind];
  if (!cost) return null;
  const p = me(game);
  if (kind === 'road' && p && freeRoadsOf(p) > 0) return {};
  return { ...cost };
}

/** What the player is short of, `{}` when they can pay. */
export function missingFor(kind, game = G) {
  const p = me(game);
  const cost = costOf(kind, game);
  if (!p || !cost) return {};
  return missingFrom(p.res, cost);
}

/** Affordable AND legal AND in the play phase — the full "can I press this?" */
export function canPlay(kind, game = G) {
  const g = game || G;
  const p = me(g);
  if (!p || !COST[kind]) return false;
  if (g.state.phase !== 'play') return false;
  if (pieceCapped(g.state, 0, kind)) return false;
  if (Object.keys(missingFor(kind, g)).length) return false;
  if (kind === 'card') return true;
  return legalFor(g.state, kind).length > 0;
}

/* =================================================================== buy */

/**
 * `buy(kind)` for 'road' | 'settlement' | 'city' | 'card'.
 *
 * Cards resolve immediately. Placements do NOT pay here: they open the
 * placement overview and the rules call (which is what charges you) runs in
 * the confirm callback, so cancelling costs nothing.
 * Returns true if the purchase happened or the placement UI opened.
 */
export function buy(kind, game = G) {
  const g = game || G;
  if (!g || !g.state) return false;
  const state = g.state;
  const p = me(g);
  if (!p || !COST[kind]) return false;

  if (state.phase === 'over') return false;
  if (state.phase !== 'play') {
    say(g, 'Finish the opening draft first', 'warn');
    return false;
  }

  if (pieceCapped(state, 0, kind)) {
    return deny(g, kind, `No ${kind} pieces left`);
  }

  const free = kind === 'road' && freeRoadsOf(p) > 0;

  if (!free && !canAfford(p.res, COST[kind])) {
    const miss = missingFrom(p.res, COST[kind]);
    return deny(g, kind, `Need ${listMissing(miss)}`);
  }

  if (kind === 'card') {
    if (netAgent) return netAgent('buy.card', {});
    const card = drawCard(state, 0);
    if (!card) return deny(g, 'card', 'Cannot draw a card right now');
    if (card.type === 'victoryPoint') {
      safe(() => g.hud && g.hud.announce && g.hud.announce('+1 Victory Point!', '#ffc93c'));
    }
    // Neither a Knight nor a Road Building card says anything here: hud-knight.js
    // and hud-road.js take the centre banner, raise their own standing chip and
    // open the board by themselves the moment they see the card. This used to
    // emit a fading "open CARDS to lay two roads free" toast, which was the only
    // thing a drawn Road Building card ever did.
    // A Knight goes to the hand; nothing auto-plays. `playKnightAt(tile)`
    // resolves it later, once the place-robber overview returns a tile.
    return true;
  }

  if (free) return placeFreeRoads(g);

  const legal = legalFor(state, kind);
  if (!legal.length) {
    return deny(g, kind, kind === 'city'
      ? 'Upgrade needs one of your settlements'
      : `Nowhere legal to place a ${kind}`);
  }

  return openPlacement(g, kind);
}

/** Opens the map in placement mode. Payment happens in `onConfirm`. */
function openPlacement(g, kind) {
  const state = g.state;
  const opened = safe(() => g.openOverview('place-' + kind, {
    onConfirm(id) {
      // Re-check at confirm time: a Knight may have robbed us while the map
      // was open. rules.js is the one that debits the bank.
      if (!canAfford(state.players[0].res, COST[kind])) {
        deny(g, kind, `Need ${listMissing(missingFrom(state.players[0].res, COST[kind]))}`);
        return false;
      }
      if (netAgent) {
        return netAgent(kind === 'road' ? 'build.road'
          : kind === 'settlement' ? 'build.settlement' : 'build.city', { id });
      }
      let ok = false;
      if (kind === 'road') ok = placeRoad(state, 0, id, false);
      else if (kind === 'settlement') ok = placeSettlement(state, 0, id, false);
      else if (kind === 'city') ok = upgradeCity(state, 0, id, false);
      if (!ok) sfx(g, 'deny');
      return ok;
    },
    onCancel() { /* nothing was paid — deliberately a no-op */ }
  }));
  return opened !== false;
}

const now = () => (typeof performance !== 'undefined' && performance.now
  ? performance.now() / 1000
  : Date.now() / 1000);

let freeRoadDeferUntil = 0;

/**
 * Is there anywhere at all to put a road right now?
 *
 * Asked BEFORE the Road Building card is spent, so a player holding a card they
 * cannot use keeps it instead of burning it on a placement panel that has
 * nothing to offer. `reason` is display-ready.
 */
export function roadRoom(game = G) {
  const g = game || G;
  const state = g && g.state;
  const p = me(g);
  if (!state || !p) return { ok: false, reason: 'No match running' };
  if (state.phase !== 'play') return { ok: false, reason: 'The match is not running' };
  if (p.roads.size >= PIECE_LIMIT.road) {
    return { ok: false, reason: 'All 18 of your roads are already on the board' };
  }
  if (!legalRoads(state, 0).length) {
    return {
      ok: false,
      reason: 'Nowhere to lay a road — every spot off your network is taken'
    };
  }
  return { ok: true, reason: '' };
}

/**
 * Road Building grants `player.freeRoads = 2`. Place them back to back: each
 * confirm decrements the counter and, while any remain, re-opens the map.
 * Cancelling keeps whatever is left so the player can finish later.
 *
 * Nothing is ever paid on this path — `placeRoad(..., free = true)` skips the
 * bank entirely — and the map opens the instant the card is played, which is
 * the whole point of the card.
 */
export function placeFreeRoads(game = G) {
  const g = game || G;
  const state = g && g.state;
  const p = me(g);
  if (!state || !p || freeRoadsOf(p) <= 0) return false;
  if (state.phase !== 'play') return false;
  if (now() < freeRoadDeferUntil) return false;

  const step = () => {
    const left = freeRoadsOf(p);
    if (left <= 0) return;
    const room = roadRoom(g);
    if (!room.ok) {
      // main.js re-checks this debt every frame, so an unspendable one would
      // otherwise re-announce itself sixty times a second. Write it off, once,
      // and say so plainly.
      p.freeRoads = 0;
      say(g, `${room.reason} — the free road is forfeit`, 'warn');
      return;
    }
    safe(() => g.openOverview('place-road', {
      free: true,
      title: left > 1 ? 'Free Road · 1 of 2' : 'Free Road · Last One',
      hint: 'Tap a glowing edge, then tap it again — this one is free',
      pickLabel: 'Pick an edge',
      onConfirm(eid) {
        if (netAgent) {
          // The server decrements the debt and tells us the new figure, so
          // the chained re-open below is driven by its answer, not our guess.
          netAgent('free.road', { id: eid });
          if (freeRoadsOf(p) > 1 && typeof setTimeout === 'function') {
            setTimeout(step, FREE_ROAD_GAP_MS + 120);
          }
          return true;
        }
        const ok = placeRoad(state, 0, eid, true);   // free: nothing is paid
        if (!ok) { sfx(g, 'deny'); return false; }
        p.freeRoads = Math.max(0, freeRoadsOf(p) - 1);
        if (p.freeRoads > 0) {
          say(g, 'One more free road — place it', 'good');
          if (typeof setTimeout === 'function') setTimeout(step, FREE_ROAD_GAP_MS);
          else step();
        } else {
          say(g, 'Both roads laid — nothing paid', 'good');
        }
        return true;
      },
      onCancel() {
        if (freeRoadsOf(p) <= 0) return;
        freeRoadDeferUntil = now() + FREE_ROAD_DEFER_SEC;
        say(g, `${freeRoadsOf(p)} free road${freeRoadsOf(p) > 1 ? 's' : ''} still owed`, 'info');
      }
    }));
  };

  step();
  return true;
}

/**
 * Play a Road Building card from hand and go straight to placement.
 *
 * If there is genuinely nowhere legal to lay a road the card is NOT spent and
 * no panel opens — the player is told why and keeps the card for later.
 */
export function useRoadBuilding(game = G) {
  const g = game || G;
  const state = g && g.state;
  const p = me(g);
  if (!state || !p) return false;
  if (!hasCard(p, 'roadBuilding')) {
    say(g, 'No Road Building card in hand', 'warn');
    return false;
  }
  const room = roadRoom(g);
  if (!room.ok) {
    sfx(g, 'deny');
    say(g, `${room.reason}. Keep the card for now.`, 'warn');
    return false;
  }
  if (netAgent) {
    // The card is spent server-side; its `roadBuilding` event sets freeRoads
    // and the map comes up on the back of that rather than on our say-so.
    netAgent('play.roads', {});
    freeRoadDeferUntil = 0;
    say(g, 'Two free roads — place them now', 'good');
    if (typeof setTimeout === 'function') setTimeout(() => placeFreeRoads(g), 180);
    return true;
  }
  if (!playRoadBuilding(state, 0)) return false;
  freeRoadDeferUntil = 0;
  say(g, 'Two free roads — place them now', 'good');
  return placeFreeRoads(g);
}

/* ================================================================= knight */

export function hasKnight(game = G) {
  const p = me(game || G);
  return !!p && hasCard(p, 'knight');
}

/** Called once the place-robber overview hands back a tile. */
export function playKnightAt(tileId, game = G) {
  const g = game || G;
  if (!g || typeof tileId !== 'number') return false;
  if (!hasKnight(g)) { say(g, 'No Knight in hand', 'warn'); return false; }
  if (netAgent) return netAgent('play.knight', { tile: tileId });
  const ok = playKnight(g.state, 0, tileId);
  if (!ok) sfx(g, 'deny');
  return ok;
}

/* ================================================================== trade */

/**
 * Where the human may trade *right now*.
 * Prefers `player.nearTrade` (written by playerController) and falls back to
 * raw geometry so headless callers and bots still get a sane answer.
 * Returns `{ at:'market'|'port', portId:number|null, label }` or null.
 */
export function tradeSpot(game = G) {
  const g = game || G;
  const state = g && g.state;
  const p = me(g);
  if (!state || !p) return null;

  const near = p.nearTrade;
  if (near === 'market') return { at: 'market', portId: null, label: 'Trading Post' };
  if (typeof near === 'number') {
    if (!p.ports.has(near)) return null;
    const port = ports[near];
    return {
      at: 'port', portId: near,
      label: port && port.resource ? `${RES_LABEL[port.resource]} Dock` : 'Trading Dock'
    };
  }

  const dm = Math.hypot(p.x - MARKET.x, p.z - MARKET.z);
  if (dm <= MARKET_REACH) return { at: 'market', portId: null, label: 'Trading Post' };

  const port = nearestPortFor(state, 0, p.x, p.z, PORT_REACH);
  if (port) {
    return {
      at: 'port', portId: port.id,
      label: port.resource ? `${RES_LABEL[port.resource]} Dock` : 'Trading Dock'
    };
  }
  return null;
}

export function canTradeHere(game = G) {
  return !!tradeSpot(game);
}

/**
 * The live rate for giving away `give`, plus where it comes from.
 * `{ ok, ratio, at, portId, label, reason }`.
 */
export function quote(give, game = G) {
  const g = game || G;
  const state = g && g.state;
  if (!state) return { ok: false, ratio: 0, reason: 'No match running' };

  const spot = tradeSpot(g);
  if (!spot) {
    return {
      ok: false, ratio: 0, at: null, portId: null,
      reason: 'Head to the Trading Post or one of your docks to trade'
    };
  }
  const ratio = activeTradeRatio(state, 0, give, spot.portId);
  const best = give ? tradeRatio(state, 0, give) : ratio;
  return {
    ok: true, ratio, at: spot.at, portId: spot.portId, label: spot.label,
    best, better: best < ratio ? best : null
  };
}

/**
 * Exchange `ratio` x `give` for 1 x `get` at whatever post the player is
 * standing on. Trading from across the island is refused.
 * Returns `{ ok, ratio, reason }` — `reason` is display-ready for panels.js.
 */
export function trade(give, get, game = G) {
  const g = game || G;
  const state = g && g.state;
  const p = me(g);
  if (!state || !p) return { ok: false, ratio: 0, reason: 'No match running' };

  if (state.phase !== 'play') return { ok: false, ratio: 0, reason: 'The match is not running' };
  if (!RES.includes(give)) return { ok: false, ratio: 0, reason: 'Pick what to give' };
  if (!RES.includes(get)) return { ok: false, ratio: 0, reason: 'Pick what to get' };
  if (give === get) return { ok: false, ratio: 0, reason: 'Pick two different resources' };

  const q = quote(give, g);
  if (!q.ok) { sfx(g, 'deny'); return { ok: false, ratio: 0, reason: q.reason }; }

  const have = p.res[give] | 0;
  if (have < q.ratio) {
    sfx(g, 'deny');
    return {
      ok: false, ratio: q.ratio,
      reason: `Need ${q.ratio} ${RES_LABEL[give]} — you have ${have}`
    };
  }

  if (netAgent) {
    netAgent('trade', { give, get, ratio: q.ratio, port: q.portId ?? null });
    say(g, `Traded ${q.ratio} ${RES_LABEL[give]} for 1 ${RES_LABEL[get]}`, 'good');
    return { ok: true, ratio: q.ratio, at: q.at, portId: q.portId, reason: '' };
  }

  if (!doTrade(state, 0, give, get, q.ratio)) {
    sfx(g, 'deny');
    return { ok: false, ratio: q.ratio, reason: 'That trade was refused' };
  }

  say(g, `Traded ${q.ratio} ${RES_LABEL[give]} for 1 ${RES_LABEL[get]}`, 'good');
  return { ok: true, ratio: q.ratio, at: q.at, portId: q.portId, reason: '' };
}

/* ================================================================= attach */

export function attach(game) {
  if (!game || !game.state) return null;
  G = game;

  const p = me(game);
  if (p && p.freeRoads === undefined) p.freeRoads = 0;

  // Cross-wire the bits gathering.js needs but main.js does not put on
  // `world` (it builds `world` before the input/game objects exist).
  if (game.world) {
    if (!game.world.input && game.input) game.world.input = game.input;
    if (!game.world.game) game.world.game = game;
  }

  const api = {
    /** True while a networked match owns the rules. Read by hud.js so its
     *  build cards route through here instead of paying locally. */
    isNet: () => isNetMatch(),
    setNetAgent,
    buy: kind => buy(kind, game),
    trade: (give, get) => trade(give, get, game),
    quote: give => quote(give, game),
    tradeSpot: () => tradeSpot(game),
    canTradeHere: () => canTradeHere(game),
    canPlay: kind => canPlay(kind, game),
    costOf: kind => costOf(kind, game),
    missingFor: kind => missingFor(kind, game),
    placeFreeRoads: () => placeFreeRoads(game),
    useRoadBuilding: () => useRoadBuilding(game),
    roadRoom: () => roadRoom(game),
    playKnightAt: tile => playKnightAt(tile, game),
    hasKnight: () => hasKnight(game),
    get freeRoads() { return freeRoadsOf(me(game)); }
  };

  // One purchase path for everything routed through `game`. hud.js keeps its
  // own equivalent for its build cards (see the ownership note at the top).
  game.requestBuild = kind => api.buy(kind);
  game.economy = api;

  return api;
}

export default attach;
