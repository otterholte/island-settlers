/**
 * Island Settlers — HUD guidance model.
 *
 * Pure logic, no DOM. Answers three questions the player kept asking:
 *
 *   "How close am I to a road / settlement / city / card?"  -> progressFor()
 *   "Where can I still pick resources up, and when do they
 *    come back?"                                            -> regionReport()
 *   "What should I be doing right now?"                     -> createGuide()
 *
 * Everything here reads state; nothing here mutates it.
 *
 * Owner: UI agent.
 */

import {
  RES, RES_LABEL, COST, VICTORY_POINTS, PIECE_LIMIT, TRADE_RADIUS
} from '../core/constants.js';

import {
  legalRoads, legalSettlements, legalCities, scoreOf,
  playerOwnsTile, canGatherTile
} from '../core/rules.js';
import { tiles, tileAt, MARKET } from '../board/layout.js';
import {
  tileItemsRemaining, tileItemCount, tileRecovery, nearestItem
} from '../board/nodes.js';

/* The four purchases, in the order the build bar shows them. */
export const BUILD_KINDS = [
  { kind: 'road',       label: 'Road',       ico: 'road',   vp: 0 },
  { kind: 'settlement', label: 'Settlement', ico: 'house',  vp: 1 },
  { kind: 'city',       label: 'City',       ico: 'castle', vp: 1 },
  { kind: 'card',       label: 'Card',       ico: 'cards',  vp: 0 }
];

/** Plain-English name for the terrain that yields each resource. */
export const REGION_OF = {
  wood: 'forests', brick: 'clay hills', wool: 'pastures',
  wheat: 'wheat fields', ore: 'mountains'
};

/** The same, for the one hex you are standing on. */
export const REGION_ONE = {
  wood: 'forest', brick: 'clay hill', wool: 'pasture',
  wheat: 'wheat field', ore: 'mountain'
};

const KIND_LABEL = { road: 'Road', settlement: 'Settlement', city: 'City', card: 'Card' };

/* ------------------------------------------------------------- purchases */

/**
 * How close `bank` is to paying `cost`.
 *
 *   p        0..1, min(have/need) across the cost — you cannot buy until it is 1
 *   blocking the single resource furthest from met (what to go and get)
 *   parts    [{ res, have, need, met }] in RES order
 */
export function progressFor(bank, cost) {
  const parts = [];
  let p = 1, blocking = null, worst = Infinity, worstGap = 0;
  for (const r of RES) {
    const need = cost && cost[r] ? cost[r] : 0;
    if (!need) continue;
    const have = Math.max(0, bank[r] | 0);
    const ratio = Math.min(1, have / need);
    parts.push({ res: r, have, need, met: have >= need });
    if (ratio < p) p = ratio;
    const gap = need - have;
    if (gap > 0 && (ratio < worst || (ratio === worst && gap > worstGap))) {
      worst = ratio; worstGap = gap; blocking = r;
    }
  }
  return { p, blocking, parts, afford: blocking === null };
}

export function pieceCapped(state, pid, kind) {
  const p = state.players[pid];
  if (kind === 'road') return p.roads.size >= PIECE_LIMIT.road;
  if (kind === 'settlement') return p.settlements.size + p.cities.size >= PIECE_LIMIT.settlement;
  if (kind === 'city') return p.cities.size >= PIECE_LIMIT.city;
  return false;
}

/** Somewhere legal to put this piece? Cards are always placeable. */
export function hasSomewhere(state, kind) {
  if (kind === 'card') return true;
  if (kind === 'road') return legalRoads(state, 0).length > 0;
  if (kind === 'settlement') return legalSettlements(state, 0).length > 0;
  return legalCities(state, 0).length > 0;
}

/* --------------------------------------------------------------- regions */

const RES_TILES = (() => {
  const m = {};
  for (const r of RES) m[r] = [];
  for (const t of tiles) if (t.resource) m[t.resource].push(t);
  return m;
})();

/**
 * Island-wide availability per resource. Counted in ITEMS, which is the only
 * unit the field has left — a hex is full, part-swept, or spent and counting
 * down as a whole.
 *   live/total  regions still carrying something
 *   stock       0..1 share of the standing crop across those regions
 *   recovery    0..1 progress of the soonest region on its way back (dry only)
 *   soonest     seconds until the next region returns (dry only)
 */
export function regionReport(state) {
  const now = state.time || 0;
  const out = {};
  for (const r of RES) {
    const list = RES_TILES[r] || [];
    let live = 0, units = 0, maxUnits = 0, soonest = Infinity, rec = 0;
    for (const t of list) {
      const left = tileItemsRemaining(t.id);
      units += left; maxUnits += tileItemCount(t.id);
      if (left > 0) { live++; continue; }
      const rc = tileRecovery(t.id, now);
      if (rc.exhausted && rc.secondsLeft < soonest) {
        soonest = rc.secondsLeft; rec = rc.progress;
      }
    }
    out[r] = {
      live, total: list.length,
      stock: maxUnits ? units / maxUnits : 0,
      recovery: live ? 1 : (soonest === Infinity ? 1 : rec),
      soonest: soonest === Infinity ? 0 : soonest
    };
  }
  return out;
}

/**
 * The hex the player is standing on: what it grows, how much of it is still
 * standing, whether this player may take any of it, and — if the hex has been
 * swept clean — how long until the whole field returns.
 *
 * `mine` and `blocked` are the two reasons the ground can be giving you
 * nothing while it plainly still has things on it.
 */
export function standingRegion(state, p, pid = 0) {
  const t = tileAt(p.x, p.z);
  if (!t || !t.resource) return null;
  const units = tileItemsRemaining(t.id);
  const total = tileItemCount(t.id);
  const rc = tileRecovery(t.id, state.time || 0);
  const mine = playerOwnsTile(state, pid, t.id);
  return {
    tile: t, resource: t.resource,
    units, total,
    live: units,                       // legacy alias: items, not sub-nodes
    fraction: total ? units / total : 0,
    mine,
    blocked: mine && !canGatherTile(state, pid, t.id),
    workable: mine && !rc.exhausted && units > 0 && canGatherTile(state, pid, t.id),
    exhausted: rc.exhausted,
    secondsLeft: rc.secondsLeft,
    recovery: rc.progress,
    total_sec: rc.total
  };
}

/** Nearest still-standing item of a resource, and which way it lies. */
export function nearestLive(p, resource) {
  return nearestItem(p.x, p.z, resource ? { resource } : {});
}

/**
 * Screen-relative bearing. The play camera has a fixed yaw, so -z is always
 * up-screen: these four words never lie and never need a compass rose.
 */
export function bearingWord(p, target) {
  if (!target) return '';
  const dx = target.x - p.x, dz = target.z - p.z;
  if (Math.abs(dx) > Math.abs(dz)) return dx > 0 ? 'right' : 'left';
  return dz < 0 ? 'ahead' : 'behind';
}

/* ----------------------------------------------------------------- guide */

const lower = s => String(s).toLowerCase();

/**
 * createGuide(state, game) -> { read(opts) }
 *
 * `read()` returns { key, ico, lead, tail, tone } where `lead` is the bold
 * clause and `tail` the quiet one. `key` changes only when the meaning
 * changes, so the HUD can animate on real transitions and not on a ticking
 * countdown.
 */
export function createGuide(state, game) {
  const me = state.players[0];

  function goal() {
    let best = null;
    for (const b of BUILD_KINDS) {
      if (pieceCapped(state, 0, b.kind)) continue;
      const pr = progressFor(me.res, COST[b.kind]);
      const where = hasSomewhere(state, b.kind);
      // Points-earning purchases win ties: the player asked how they *grow*.
      const score = pr.p + (b.vp ? 0.07 : 0) + (where ? 0 : -0.5);
      const cand = { ...b, ...pr, where, score };
      if (!best || score > best.score) best = cand;
    }
    return best;
  }

  function buyable() {
    // The most useful thing on the shelf right now. A road outranks a card
    // because a road is what unblocks the next settlement.
    for (const k of ['city', 'settlement', 'road', 'card']) {
      if (pieceCapped(state, 0, k)) continue;
      if (!progressFor(me.res, COST[k]).afford) continue;
      if (!hasSomewhere(state, k)) continue;
      return k;
    }
    return null;
  }

  function tradeReach() {
    if (me.nearTrade === 'market') return 'the market';
    if (typeof me.nearTrade === 'number') return 'this dock';
    const d = Math.hypot(me.x - MARKET.x, me.z - MARKET.z);
    return d < TRADE_RADIUS + MARKET.radius ? 'the market' : null;
  }

  function read(opts = {}) {
    const regions = opts.regions || regionReport(state);

    if (state.phase === 'setup') {
      return state.setupNeed === 'road'
        ? { key: 'setup-road', ico: 'road', lead: 'Place a road', tail: 'next to your new settlement', tone: 'go' }
        : { key: 'setup-set', ico: 'house', lead: 'Claim a corner', tail: 'pick a spot on the map', tone: 'go' };
    }
    if (state.phase === 'over') {
      return state.winner === 0
        ? { key: 'won', ico: 'trophy', lead: 'You settled the island', tail: '', tone: 'go' }
        : { key: 'lost', ico: 'trophy', lead: 'Match over', tail: '', tone: '' };
    }

    if ((me.freeRoads | 0) > 0) {
      return {
        key: 'freeroad', ico: 'road',
        lead: `${me.freeRoads} free road${me.freeRoads > 1 ? 's' : ''}`,
        tail: 'place them on the map', tone: 'go'
      };
    }

    const ready = buyable();
    if (ready) {
      const b = BUILD_KINDS.find(x => x.kind === ready);
      const left = VICTORY_POINTS - scoreOf(state, me);
      const tail = b.vp && left <= 3 ? `${left} point${left === 1 ? '' : 's'} from winning`
        : opts.buildHidden ? 'tap BUILD to place it'
        : 'you can afford it now';
      const verb = ready === 'card' ? 'Buy a' : ready === 'city' ? 'Upgrade to a' : 'Build a';
      return { key: 'buy-' + ready, ico: b.ico, lead: `${verb} ${lower(b.label)}`, tail, tone: 'go' };
    }

    const g = goal();

    // A settlement you can pay for but cannot legally site is the single most
    // confusing state in the game. Name the fix.
    if (g && g.afford && !g.where) {
      if (g.kind === 'city') {
        return { key: 'need-set', ico: 'house', lead: 'Build a settlement first', tail: 'cities upgrade one you own', tone: '' };
      }
      return { key: 'need-road', ico: 'road', lead: 'Extend a road first', tail: 'settlements sit on your network', tone: '' };
    }

    const here = standingRegion(state, me);
    if (here && here.mine && here.exhausted) {
      return {
        key: 'spent-' + here.tile.id, ico: here.resource,
        lead: 'Region worked out',
        tail: `back in ${Math.ceil(here.secondsLeft)}s — move on`, tone: 'wait'
      };
    }
    if (here && here.blocked) {
      return {
        key: 'raider-' + here.tile.id, ico: 'knight',
        lead: 'The raider holds this hex',
        tail: 'nothing comes off it while it sits there', tone: 'wait'
      };
    }

    if (!g || !g.blocking) {
      return { key: 'idle', ico: 'flag', lead: 'Gather and build', tail: '', tone: '' };
    }

    const short = g.blocking;
    const need = (COST[g.kind][short] | 0) - Math.max(0, me.res[short] | 0);
    const rr = regions[short];
    const lead = `${need} more ${lower(RES_LABEL[short])}`;
    const goalName = lower(KIND_LABEL[g.kind]);

    // Already standing on a hex of theirs that grows it: say so, and say what
    // it buys. Pickup is contact, so the instruction is "keep running".
    if (here && here.workable && here.resource === short) {
      return {
        key: 'keep-' + short + '-' + g.kind, ico: short, lead,
        tail: `run over them — then a ${goalName}`, tone: 'go'
      };
    }

    if (rr && rr.live === 0) {
      return {
        key: 'dry-' + short, ico: short, lead,
        tail: `${REGION_OF[short]} back in ${Math.ceil(rr.soonest)}s`, tone: 'wait'
      };
    }

    const spot = tradeReach();
    if (spot) {
      const spare = RES.filter(r => r !== short && (me.res[r] | 0) >= 4)
        .sort((a, b) => (me.res[b] | 0) - (me.res[a] | 0))[0];
      if (spare) {
        return {
          key: 'trade-' + short, ico: 'swap',
          lead: `Trade at ${spot}`,
          tail: `swap spare ${lower(RES_LABEL[spare])} for ${lower(RES_LABEL[short])}`, tone: 'go'
        };
      }
    }

    const target = nearestLive(me, short);
    const dir = bearingWord(me, target);
    return {
      key: 'need-' + g.kind + '-' + short, ico: short, lead,
      tail: `for a ${goalName} · ${REGION_OF[short]} ${dir}`,
      tone: ''
    };
  }

  return { read, goal, buyable, regionReport: () => regionReport(state) };
}

export default createGuide;
