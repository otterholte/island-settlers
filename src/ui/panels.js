/**
 * Island Settlers — modal panels: trade, development cards, results.
 *
 *   createPanels(root, state, game) ->
 *     { openTrade(portId), openCards(), showResults(winnerId), close(), update(dt) }
 *
 * One or two taps to do anything. Unaffordable actions grey out and say why
 * rather than silently failing. Owner: UI agent.
 */

import {
  RES, RES_LABEL, COST, CARD_LABEL, CARD_BLURB, TRADE_BASE,
  LONGEST_ROAD_VP, LARGEST_ARMY_VP, canAfford
} from '../core/constants.js';

import {
  tradeRatio, activeTradeRatio, doTrade,
  playRoadBuilding, placeRoad, scoreOf, rankings
} from '../core/rules.js';

import { ports } from '../board/layout.js';
import { el, button, clear, toggle, setText, fmtTime } from './dom.js';
import { icon, resIcon, avatar } from './icons.js';

const CARD_ART = { knight: 'knight', roadBuilding: 'road', victoryPoint: 'trophy' };

export function createPanels(root, state, game) {
  const me = state.players[0];

  const scrim = el('div', { class: 'scrim', on: { click: () => close() } });
  const wrap = el('div', { class: 'panels hid', 'data-ui': '' }, scrim);
  root.appendChild(wrap);

  let openKind = null;
  let refreshT = 0;

  /* ================================================================ trade */
  let portId = null, give = null, get = null;

  const tInv = el('div', { class: 'inv-strip' });
  const tInvNums = {};
  for (const r of RES) {
    const n = el('b', { text: '0' });
    tInvNums[r] = n;
    tInv.appendChild(el('div', { class: 'inv', html: icon(resIcon(r), 24) }, n));
  }

  const giveRow = el('div', { class: 'pickrow' });
  const getRow = el('div', { class: 'pickrow' });
  const givePick = {}, getPick = {};
  for (const r of RES) {
    const gn = el('em', { text: '0' });
    const g = el('button', {
      class: 'pick', type: 'button', 'data-ui': '', 'data-res': r,
      on: { click: () => { give = give === r ? null : r; syncTrade(); } }
    }, el('span', { class: 'pk-ico', html: icon(resIcon(r), 30) }),
       el('span', { class: 'pk-name', text: RES_LABEL[r] }), gn);
    givePick[r] = { node: g, num: gn };
    giveRow.appendChild(g);

    const t = el('button', {
      class: 'pick', type: 'button', 'data-ui': '', 'data-res': r,
      on: { click: () => { get = get === r ? null : r; syncTrade(); } }
    }, el('span', { class: 'pk-ico', html: icon(resIcon(r), 30) }),
       el('span', { class: 'pk-name', text: RES_LABEL[r] }));
    getPick[r] = { node: t };
    getRow.appendChild(t);
  }

  const ratioBig = el('div', { class: 'ratio' }, el('b', { text: '4' }),
    el('i', { text: ':' }), el('b', { text: '1' }));
  const ratioWhere = el('span', { class: 'ratio-where', text: 'Great Market' });
  const ratioNote = el('span', { class: 'ratio-note', text: '' });
  const tradeWhy = el('span', { class: 'why', text: 'Pick what to give' });
  const tradeBtn = button('big green off', { on: { click: () => doTheTrade() } },
    el('span', { class: 'sb-ico', html: icon('swap', 22) }),
    el('span', { class: 'sb-lab', text: 'Trade' }));

  const tradeSheet = el('div', { class: 'sheet trade hid' },
    head('Trade', () => close()),
    tInv,
    el('div', { class: 'trade-body' },
      el('div', { class: 'tcol' }, el('h4', { text: 'You give' }), giveRow),
      el('div', { class: 'tmid' }, ratioBig, ratioWhere, ratioNote),
      el('div', { class: 'tcol' }, el('h4', { text: 'You get' }), getRow)),
    el('div', { class: 'sheet-foot' }, tradeWhy, tradeBtn));
  wrap.appendChild(tradeSheet);

  function currentRatio() {
    if (!give) return portId === null ? TRADE_BASE : activeTradeRatio(state, 0, RES[0], portId);
    return portId === null ? TRADE_BASE : activeTradeRatio(state, 0, give, portId);
  }

  /**
   * The rate available *right now*. economy.js owns the proximity rule, so when
   * it is attached we defer to it — otherwise the sheet would keep honouring
   * the ratio it opened with after the settler has walked away from the post.
   * Without economy (a bare UI harness) we fall back to the opening ratio.
   */
  function liveQuote() {
    const eco = game && game.economy;
    if (eco && typeof eco.quote === 'function') {
      try {
        const q = eco.quote(give || RES[0]);
        if (q) return q;
      } catch (e) { /* fall through to the local rate */ }
    }
    return { ok: true, ratio: currentRatio(), label: null };
  }

  function syncTrade() {
    for (const r of RES) {
      const have = me.res[r] | 0;
      setText(tInvNums[r], have);
      setText(givePick[r].num, have);
      toggle(givePick[r].node, 'on', give === r);
      toggle(givePick[r].node, 'off', have <= 0);
      toggle(getPick[r].node, 'on', get === r);
      toggle(getPick[r].node, 'off', give === r);
    }
    const q = liveQuote();
    const ratio = q.ok ? q.ratio : currentRatio();
    setText(ratioBig.childNodes[0], ratio);
    const port = portId === null ? null : ports[portId];
    setText(ratioWhere, q.label || (port
      ? (port.resource ? `${RES_LABEL[port.resource]} Dock` : 'Trading Dock')
      : 'Great Market'));

    let note = '';
    if (give) {
      const best = tradeRatio(state, 0, give);
      if (best < ratio) note = `${best}:1 available at your dock`;
    }
    setText(ratioNote, note);

    const have = give ? (me.res[give] | 0) : 0;
    let why = '', ok = false;
    if (!q.ok) why = q.reason || 'Head to a trading post';
    else if (!give) why = 'Pick what to give';
    else if (!get) why = 'Pick what to get';
    else if (give === get) why = 'Pick two different resources';
    else if (have < ratio) why = `Need ${ratio} ${RES_LABEL[give]} — you have ${have}`;
    else { ok = true; why = `${ratio} ${RES_LABEL[give]} for 1 ${RES_LABEL[get]}`; }
    setText(tradeWhy, why);
    toggle(tradeBtn, 'off', !ok);
    if (tradeBtn.disabled !== undefined) tradeBtn.disabled = !ok;
  }

  function doTheTrade() {
    if (!give || !get || give === get) return false;

    // economy.js is the one path that enforces "you must be standing at the
    // post". Route through it whenever it exists; it toasts on success and
    // hands back a display-ready reason on refusal.
    const eco = game && game.economy;
    if (eco && typeof eco.trade === 'function') {
      const r = eco.trade(give, get);
      if (!r || !r.ok) {
        syncTrade();
        if (r && r.reason) setText(tradeWhy, r.reason);
        return false;
      }
      close();
      return true;
    }

    const ratio = currentRatio();
    const ok = doTrade(state, 0, give, get, ratio);
    if (!ok) { syncTrade(); return false; }
    if (game.toast) game.toast(`Traded ${ratio} ${RES_LABEL[give]} for 1 ${RES_LABEL[get]}`, 'good');
    close();
    return true;
  }

  function openTrade(id) {
    portId = (id === undefined || id === null) ? null : id;
    if (portId !== null && !me.ports.has(portId)) portId = null;
    give = null; get = null;
    syncTrade();
    show('trade');
  }

  /* ================================================================ cards */
  const hand = el('div', { class: 'hand' });
  const vpNote = el('span', { class: 'vp-note', text: '' });
  const buyCost = el('span', { class: 'buy-cost' });
  for (const r of RES) {
    const n = COST.card[r];
    if (!n) continue;
    buyCost.appendChild(el('i', { class: 'cc', html: icon(resIcon(r), 20) + `<em>${n}</em>` }));
  }
  const buyBtn = button('big gold', { on: { click: () => buyCard() } },
    el('span', { class: 'sb-ico', html: icon('cards', 22) }),
    el('span', { class: 'sb-lab', text: 'Buy Card' }), buyCost);

  const cardsSheet = el('div', { class: 'sheet cards hid' },
    head('Development Cards', () => close()),
    hand,
    el('div', { class: 'sheet-foot' }, vpNote, buyBtn));
  wrap.appendChild(cardsSheet);

  function syncCards() {
    clear(hand);
    const cs = me.cards;
    if (!cs.length) {
      hand.appendChild(el('div', { class: 'hand-empty' },
        el('span', { html: icon('cards', 40) }),
        el('p', { text: 'No cards in hand. Buy one to raise an army or lay free roads.' })));
    }
    cs.forEach((c, i) => {
      const spread = cs.length > 1 ? (i - (cs.length - 1) / 2) : 0;
      const card = el('button', {
        class: 'dcard c-' + c.type, type: 'button', 'data-ui': '',
        style: {
          transform: `rotate(${(spread * 5).toFixed(1)}deg) translateY(${Math.abs(spread) * 6}px)`,
          zIndex: String(10 + i)
        },
        on: { click: () => playCard(c) }
      },
        el('span', { class: 'dc-art', html: icon(CARD_ART[c.type] || 'cards', 44) }),
        el('span', { class: 'dc-name', text: CARD_LABEL[c.type] }),
        el('span', { class: 'dc-text', text: CARD_BLURB[c.type] }),
        el('span', { class: 'dc-play', text: 'Tap to play' }));
      hand.appendChild(card);
    });
    setText(vpNote, me.vpCards
      ? `${me.vpCards} victory point card${me.vpCards > 1 ? 's' : ''} held`
      : 'Knights also win you the Largest Army');
    const afford = canAfford(me.res, COST.card);
    toggle(buyBtn, 'off', !afford || state.phase !== 'play');
  }

  function buyCard() {
    const ok = game.requestBuild ? game.requestBuild('card') : false;
    syncCards();
    return ok;
  }

  function playCard(c) {
    if (state.phase !== 'play') return;
    if (c.type === 'knight') {
      close();
      game.openOverview('place-robber', {
        title: 'Send the Raider',
        hint: 'Block a region and rivals drop what they carry'
      });
      return;
    }
    if (c.type === 'roadBuilding') {
      if (!playRoadBuilding(state, 0)) return;
      close();
      if (game.toast) game.toast('Two free roads!', 'good');
      freeRoad();
    }
  }

  function freeRoad() {
    const left = me.freeRoads || 0;
    if (left <= 0) return;
    game.openOverview('place-road', {
      free: true,
      title: 'Free Road',
      hint: `${left} free road${left > 1 ? 's' : ''} remaining`,
      onConfirm(eid) {
        const ok = placeRoad(state, 0, eid, true);
        if (ok) {
          me.freeRoads = Math.max(0, (me.freeRoads || 1) - 1);
          if (me.freeRoads > 0) setTimeout(freeRoad, 340);
        }
        return ok;
      },
      onCancel() { me.freeRoads = 0; }
    });
  }

  /* ============================================================== results */
  const resBanner = el('div', { class: 'rs-banner' });
  const resTitle = el('h1', { class: 'rs-title', text: 'Victory!' });
  const resSub = el('p', { class: 'rs-sub', text: '' });
  const resList = el('div', { class: 'rs-list' });
  const resStats = el('div', { class: 'rs-stats' });
  const againBtn = button('big gold huge', { on: { click: () => game.restart() } },
    el('span', { class: 'sb-ico', html: icon('restart', 24) }),
    el('span', { class: 'sb-lab', text: 'Play Again' }));

  const resultsSheet = el('div', { class: 'results hid' },
    resBanner,
    el('div', { class: 'rs-head' }, resTitle, resSub),
    el('div', { class: 'rs-body' }, resList,
      el('div', { class: 'rs-side plate' }, el('h4', { text: 'Match Report' }), resStats)),
    el('div', { class: 'rs-foot' }, againBtn));
  wrap.appendChild(resultsSheet);

  function breakdown(p) {
    const bits = [];
    if (p.settlements.size) bits.push([`${p.settlements.size} Settlement`, p.settlements.size, 'house']);
    if (p.cities.size) bits.push([`${p.cities.size} City`, p.cities.size * 2, 'castle']);
    if (p.vpCards) bits.push([`${p.vpCards} VP Card`, p.vpCards, 'cards']);
    if (p.hasLongestRoad) bits.push(['Longest Road', LONGEST_ROAD_VP, 'road']);
    if (p.hasLargestArmy) bits.push(['Largest Army', LARGEST_ARMY_VP, 'knight']);
    return bits;
  }

  function showResults(winnerId) {
    const wid = winnerId === undefined || winnerId === null || winnerId < 0
      ? (rankings(state)[0] || { p: me }).p.id : winnerId;
    const w = state.players[wid];
    const iWon = wid === 0;

    if (resBanner.style) {
      resBanner.style.setProperty('--wc', w.color.css);
      resBanner.style.setProperty('--wl', w.color.light);
    }
    resBanner.innerHTML = icon('trophy', 64);
    setText(resTitle, iWon ? 'Victory!' : 'Defeat');
    toggle(resultsSheet, 'lost', !iWon);
    setText(resSub, iWon
      ? `You settled the island with ${scoreOf(state, w)} points`
      : `${w.name} reached ${scoreOf(state, w)} points first`);

    clear(resList);
    const rk = rankings(state);
    rk.forEach((entry, i) => {
      const p = entry.p;
      const bits = breakdown(p);
      const row = el('div', {
        class: 'rs-row plate r' + i + (p.id === 0 ? ' me' : '') + (i === 0 ? ' win' : ''),
        style: { '--c': p.color.css, '--cl': p.color.light }
      },
        el('span', { class: 'rs-pos', text: String(i + 1) }),
        el('span', { class: 'rs-av', html: avatar(p.color.css, p.color.light, 30) }),
        el('div', { class: 'rs-mid' },
          el('b', { class: 'rs-name', text: p.name }),
          el('span', {
            class: 'rs-bd',
            html: bits.length
              ? bits.map(b => `<i>${icon(b[2], 20)}<em>+${b[1]}</em><u>${b[0]}</u></i>`).join('')
              : '<i><u>No points scored</u></i>'
          })),
        el('span', { class: 'rs-vp' }, el('b', { text: String(entry.vp) }),
          el('i', { html: icon('trophy', 20) })));
      resList.appendChild(row);
      setTimeout(() => toggle(row, 'in', true), 220 + i * 170);
    });

    const s = me.stats;
    const rows = [
      ['clock', 'Match time', fmtTime(state.time)],
      ['log', 'Resources gathered', s.gathered],
      ['hammer', 'Pieces built', s.built],
      ['swap', 'Trades made', s.traded],
      ['cards', 'Cards played', s.cardsPlayed],
      ['road', 'Longest road', me.longestRoadLen],
      ['knight', 'Knights played', me.knightsPlayed]
    ];
    resStats.innerHTML = rows.map(r =>
      `<div class="rs-stat">${icon(r[0], 20)}<span>${r[1]}</span><b>${r[2]}</b></div>`).join('');

    show('results');
  }

  /* ================================================================ shell */
  function head(title, onClose) {
    return el('div', { class: 'sheet-head' },
      el('span', { class: 'sheet-title', text: title }),
      button('cbtn small ghost x', { 'aria-label': 'Close', on: { click: onClose } },
        el('span', { class: 'cb-ico', html: icon('close', 18) })));
  }

  function show(kind) {
    openKind = kind;
    toggle(wrap, 'hid', false);
    toggle(tradeSheet, 'hid', kind !== 'trade');
    toggle(cardsSheet, 'hid', kind !== 'cards');
    toggle(resultsSheet, 'hid', kind !== 'results');
    toggle(scrim, 'hard', kind === 'results');
    setTimeout(() => toggle(wrap, 'on', openKind === kind), 16);
  }

  function close() {
    if (openKind === 'results') return;   // the match is over; only Play Again exits
    openKind = null;
    toggle(wrap, 'on', false);
    setTimeout(() => { if (!openKind) toggle(wrap, 'hid', true); }, 220);
  }

  function openCards() { syncCards(); show('cards'); }

  function update(dt) {
    if (!openKind || openKind === 'results') return;
    refreshT += Number.isFinite(dt) ? dt : 1 / 60;
    if (refreshT < 0.2) return;
    refreshT = 0;
    if (openKind === 'trade') syncTrade();
    else if (openKind === 'cards') syncCards();
  }

  syncTrade();

  return {
    openTrade, openCards, showResults, close, update,
    get isOpen() { return openKind !== null; },
    get kind() { return openKind; },
    destroy() { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); }
  };
}

export default createPanels;
