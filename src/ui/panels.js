/**
 * Island Settlers — modal panels: trade, development cards, results.
 *
 *   createPanels(root, state, game) ->
 *     { openTrade(portId), openCards(), showResults(winnerId), endBanner(wid),
 *       close(), update(dt) }
 *
 * One or two taps to do anything. Unaffordable actions grey out and say why
 * rather than silently failing.
 *
 * ---------------------------------------------------------------------------
 * THE KEYBOARD (and why it never fights the settler)
 * ---------------------------------------------------------------------------
 * Standing at a trading post, Enter opens this sheet — no hunting for a button
 * with a thumb that is busy steering. Inside it:
 *
 *   left / right   move the cursor around a ring of ten cells: the five things
 *                  you can give, then the five you can get. Wherever the cursor
 *                  lands IS the selection for that row, so the deal is always
 *                  live and always legal.
 *   up / down      how many you are trading for.
 *   Tab            jump between the give row and the get row.
 *   Enter          do the deal — or, when there is no deal to do, close.
 *   Escape         close. So do the X, the scrim, and tapping outside.
 *
 * Those are the same arrow keys that drive the settler, so while any panel is
 * open we take the keyboard off input.js with `setKeyboardCapture(true)` and
 * give it back on close. input.js still swallows the keys (preventDefault) but
 * records none of them, which is what stops a direction latching on and the
 * settler running in circles behind the sheet. Every keyboard route has a
 * pointer equivalent on screen and vice versa.
 *
 * Owner: UI agent.
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
import { createEndgame } from './hud-end.js';

const CARD_ART = { knight: 'knight', roadBuilding: 'road', victoryPoint: 'trophy' };

/** Most you can ask for in one confirm — nine is more than any board affords. */
const MAX_LOTS = 9;

export function createPanels(root, state, game) {
  const me = state.players[0];

  const scrim = el('div', { class: 'scrim', on: { click: () => close() } });
  const wrap = el('div', { class: 'panels hid', 'data-ui': '' }, scrim);
  root.appendChild(wrap);

  let openKind = null;
  let refreshT = 0;

  /* ================================================================ trade */
  // The cursor is the selection: `giveI` / `getI` index RES, `side` says which
  // of the two rows the arrow keys are steering.
  let portId = null;
  let giveI = 0, getI = 1;
  let side = 'get';
  let lots = 1;
  let tradeReady = false;

  const giveRes = () => RES[giveI];
  const getRes = () => RES[getI];

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
  RES.forEach((r, i) => {
    const gn = el('em', { text: '0' });
    const g = el('button', {
      class: 'pick', type: 'button', 'data-ui': '', 'data-res': r,
      'aria-label': `Give ${RES_LABEL[r]}`,
      on: { click: () => pickAt('give', i) }
    }, el('span', { class: 'pk-ico', html: icon(resIcon(r), 30) }),
       el('span', { class: 'pk-name', text: RES_LABEL[r] }), gn);
    givePick[r] = { node: g, num: gn };
    giveRow.appendChild(g);

    const tn = el('em', { class: 'pk-lots', text: '' });
    const t = el('button', {
      class: 'pick', type: 'button', 'data-ui': '', 'data-res': r,
      'aria-label': `Get ${RES_LABEL[r]}`,
      on: { click: () => pickAt('get', i) }
    }, el('span', { class: 'pk-ico', html: icon(resIcon(r), 30) }),
       el('span', { class: 'pk-name', text: RES_LABEL[r] }), tn);
    getPick[r] = { node: t, num: tn };
    getRow.appendChild(t);
  });

  const ratioBig = el('div', { class: 'ratio' }, el('b', { text: '4' }),
    el('i', { text: ':' }), el('b', { text: '1' }));
  const ratioWhere = el('span', { class: 'ratio-where', text: 'Great Market' });
  const ratioNote = el('span', { class: 'ratio-note', text: '' });

  const lotsNum = el('b', { class: 'amt-n', text: '1' });
  const amtUp = el('button', {
    class: 'amt-b up', type: 'button', 'data-ui': '', 'aria-label': 'Trade for more',
    on: { click: () => bump(1) }
  });
  const amtDn = el('button', {
    class: 'amt-b dn', type: 'button', 'data-ui': '', 'aria-label': 'Trade for fewer',
    on: { click: () => bump(-1) }
  });
  const amtBox = el('div', { class: 'amt' }, amtUp, lotsNum, amtDn,
    el('span', { class: 'amt-lab', text: 'How many' }));

  const dealGive = el('span', { class: 'td-side give' });
  const dealGet = el('span', { class: 'td-side get' });
  const tradeDeal = el('span', { class: 'tdeal' }, dealGive,
    el('span', { class: 'td-arrow', html: icon('swap', 16) }), dealGet);
  const tradeWhy = el('span', { class: 'why', text: 'Pick what to give' });
  const kbHint = el('span', { class: 'kbhint' });
  const tradeBtn = button('big green off', { on: { click: () => doTheTrade() } },
    el('span', { class: 'sb-ico', html: icon('swap', 22) }),
    el('span', { class: 'sb-lab', text: 'Trade' }));

  const tradeSheet = el('div', { class: 'sheet trade hid' },
    head('Trade', () => close()),
    tInv,
    el('div', { class: 'trade-body' },
      el('div', { class: 'tcol' }, el('h4', { text: 'You give' }), giveRow),
      el('div', { class: 'tmid' }, ratioBig, ratioWhere, amtBox, ratioNote),
      el('div', { class: 'tcol' }, el('h4', { text: 'You get' }), getRow)),
    el('div', { class: 'sheet-foot' },
      el('div', { class: 'tfoot' }, tradeDeal, tradeWhy, kbHint), tradeBtn));
  wrap.appendChild(tradeSheet);

  function currentRatio() {
    return portId === null ? TRADE_BASE : activeTradeRatio(state, 0, giveRes(), portId);
  }

  /* ------------------------------------------------------ selection moves */

  /** Never let the two rows point at the same resource: the deal stays legal. */
  function separate(justMoved) {
    if (giveI !== getI) return;
    if (justMoved === 'give') getI = (getI + 1) % RES.length;
    else giveI = (giveI + 1) % RES.length;
  }

  function pickAt(which, i) {
    side = which;
    if (which === 'give') giveI = i; else getI = i;
    separate(which);
    lots = 1;
    syncTrade();
  }

  /** Left/right walk one ring: give[0..4] then get[0..4], wrapping both ways. */
  function moveCursor(dir) {
    let idx = side === 'give' ? giveI : getI + RES.length;
    idx = (idx + dir + RES.length * 2) % (RES.length * 2);
    if (idx < RES.length) pickAt('give', idx);
    else pickAt('get', idx - RES.length);
    ping('pick');
  }

  function swapSide() {
    side = side === 'give' ? 'get' : 'give';
    syncTrade();
    ping('pick');
  }

  function bump(d) {
    const next = Math.max(1, Math.min(maxLots(), lots + d));
    if (next === lots) return;
    lots = next;
    syncTrade();
    ping('pick');
  }

  function maxLots() {
    const q = liveQuote();
    const ratio = (q && q.ok ? q.ratio : currentRatio()) || TRADE_BASE;
    const have = me.res[giveRes()] | 0;
    return Math.max(1, Math.min(MAX_LOTS, Math.floor(have / ratio) || 0));
  }

  function ping(kind) {
    try {
      const a = game && game.audio;
      if (a && a.sfx) a.sfx(kind === 'pick' ? 'blip' : 'trade', { gain: 0.35 });
    } catch (e) { /* audio is optional */ }
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
        const q = eco.quote(giveRes());
        if (q) return q;
      } catch (e) { /* fall through to the local rate */ }
    }
    return { ok: true, ratio: currentRatio(), label: null };
  }

  function dealSide(node, n, res) {
    node.innerHTML = `<b>${n}</b>${icon(resIcon(res), 18)}` +
      `<u>${RES_LABEL[res]}</u>`;
  }

  function syncTrade() {
    const give = giveRes(), get = getRes();
    const q = liveQuote();
    const ratio = (q.ok ? q.ratio : currentRatio()) || TRADE_BASE;
    const have = me.res[give] | 0;
    const cap = maxLots();
    if (lots > cap) lots = cap;
    if (lots < 1) lots = 1;

    RES.forEach((r, i) => {
      const held = me.res[r] | 0;
      setText(tInvNums[r], held);
      setText(givePick[r].num, held);
      toggle(givePick[r].node, 'on', i === giveI);
      toggle(givePick[r].node, 'cur', i === giveI && side === 'give');
      toggle(givePick[r].node, 'off', held <= 0);
      toggle(getPick[r].node, 'on', i === getI);
      toggle(getPick[r].node, 'cur', i === getI && side === 'get');
      toggle(getPick[r].node, 'off', i === giveI);
      setText(getPick[r].num, i === getI && lots > 1 ? '+' + lots : '');
    });

    setText(ratioBig.childNodes[0], ratio);
    const port = portId === null ? null : ports[portId];
    setText(ratioWhere, q.label || (port
      ? (port.resource ? `${RES_LABEL[port.resource]} Dock` : 'Trading Dock')
      : 'Great Market'));

    let note = '';
    const best = tradeRatio(state, 0, give);
    if (best < ratio) note = `${best}:1 at your dock`;
    setText(ratioNote, note);

    setText(lotsNum, lots);
    toggle(amtUp, 'off', lots >= cap);
    toggle(amtDn, 'off', lots <= 1);

    const cost = ratio * lots;
    dealSide(dealGive, cost, give);
    dealSide(dealGet, lots, get);

    let why = '', ok = false;
    if (!q.ok) why = q.reason || 'Head to a trading post';
    else if (give === get) why = 'Pick two different resources';
    else if (have < cost) why = `Need ${cost} ${RES_LABEL[give]} — you have ${have}`;
    else { ok = true; why = `${cost} ${RES_LABEL[give]} for ${lots} ${RES_LABEL[get]}`; }
    setText(tradeWhy, why);
    kbHint.innerHTML =
      '<i>Left / Right</i> pick <i>Up / Down</i> how many ' +
      `<i>Enter</i> ${ok ? 'trade' : 'close'} <i>Esc</i> close`;
    tradeReady = ok;
    toggle(tradeBtn, 'off', !ok);
    if (tradeBtn.disabled !== undefined) tradeBtn.disabled = !ok;
  }

  /**
   * Do the deal `lots` times over. The sheet deliberately stays open: standing
   * at a post you usually want two or three exchanges, and being thrown back
   * out to the island after each one was the slowest part of trading.
   */
  function doTheTrade() {
    const give = giveRes(), get = getRes();
    if (!give || !get || give === get) return false;

    // economy.js is the one path that enforces "you must be standing at the
    // post". Route through it whenever it exists; it toasts on success and
    // hands back a display-ready reason on refusal.
    const eco = game && game.economy;
    const want = Math.max(1, lots | 0);
    let done = 0, ratio = currentRatio();

    for (let i = 0; i < want; i++) {
      let r;
      if (eco && typeof eco.trade === 'function') r = eco.trade(give, get);
      else r = doTrade(state, 0, give, get, ratio) ? { ok: true, ratio } : { ok: false };
      if (!r || !r.ok) {
        if (!done) {
          syncTrade();
          if (r && r.reason) setText(tradeWhy, r.reason);
          return false;
        }
        break;
      }
      if (r.ratio) ratio = r.ratio;
      done++;
    }

    if (!done) { syncTrade(); return false; }
    if (!eco && game.toast) {
      game.toast(`Traded ${ratio * done} ${RES_LABEL[give]} for ${done} ${RES_LABEL[get]}`, 'good');
    }
    lots = 1;
    syncTrade();
    tradeSheet.classList.remove('done');
    void tradeSheet.offsetWidth;
    tradeSheet.classList.add('done');
    return true;
  }

  function openTrade(id) {
    portId = (id === undefined || id === null) ? null : id;
    if (portId !== null && !me.ports.has(portId)) portId = null;
    // Open on the resource you are richest in — the one you came here to spend.
    let best = 0;
    RES.forEach((r, i) => { if ((me.res[r] | 0) > (me.res[RES[best]] | 0)) best = i; });
    giveI = best;
    getI = (best + 1) % RES.length;
    side = 'get';
    lots = 1;
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

  // Nothing traps the player on the scoreboard. Both of these put the finished
  // island back on screen; the bar from hud-end.js brings the scores back.
  const boardBtn = button('big blue', { on: { click: () => hideResults() } },
    el('span', { class: 'sb-ico', html: icon('map', 22) }),
    el('span', { class: 'sb-lab', text: 'See The Board' }));

  const resX = button('cbtn small ghost x rs-x', {
    'aria-label': 'Hide the results and look at the board',
    on: { click: () => hideResults() }
  }, el('span', { class: 'cb-ico', html: icon('close', 18) }));

  const resultsSheet = el('div', { class: 'results hid' },
    resBanner, resX,
    el('div', { class: 'rs-head' }, resTitle, resSub),
    el('div', { class: 'rs-body' }, resList,
      el('div', { class: 'rs-side plate' }, el('h4', { text: 'Match Report' }), resStats)),
    el('div', { class: 'rs-foot' }, againBtn, boardBtn));
  wrap.appendChild(resultsSheet);

  const endgame = createEndgame(root, state, game, {
    onResults: () => showResults(lastWinner)
  });
  let lastWinner = -1;

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
    lastWinner = wid;
    endgame.setDock(false);

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

  /**
   * While a sheet is up the arrow keys belong to it, not to the settler.
   * input.js keeps swallowing the keys either way, so nothing leaks through to
   * the browser or the 3D layer, and it drops every held key on both edges.
   */
  function grabKeys(on) {
    const inp = game && game.input;
    if (inp && typeof inp.setKeyboardCapture === 'function') {
      try { inp.setKeyboardCapture(!!on); } catch (e) { /* optional */ }
    }
  }

  function show(kind) {
    openKind = kind;
    toggle(wrap, 'hid', false);
    toggle(tradeSheet, 'hid', kind !== 'trade');
    toggle(cardsSheet, 'hid', kind !== 'cards');
    toggle(resultsSheet, 'hid', kind !== 'results');
    toggle(scrim, 'hard', kind === 'results');
    grabKeys(true);
    setTimeout(() => toggle(wrap, 'on', openKind === kind), 16);
  }

  function close() {
    if (!openKind) return;
    if (openKind === 'results') { hideResults(); return; }
    openKind = null;
    grabKeys(false);
    toggle(wrap, 'on', false);
    setTimeout(() => { if (!openKind) toggle(wrap, 'hid', true); }, 220);
  }

  /** Put the scoreboard away and hand the finished island back to the player. */
  function hideResults() {
    openKind = null;
    grabKeys(false);
    toggle(wrap, 'on', false);
    setTimeout(() => {
      if (!openKind) { toggle(wrap, 'hid', true); toggle(resultsSheet, 'hid', true); }
    }, 220);
    endgame.setDock(true);
  }

  function openCards() { syncCards(); show('cards'); }

  /* --------------------------------------------------------------- keyboard */

  function nearbyTrade() {
    if (state.phase !== 'play') return undefined;
    const ov = game && game.overview;
    if (ov && ov.isOpen) return undefined;
    const eco = game && game.economy;
    if (!eco || typeof eco.tradeSpot !== 'function') return undefined;
    let spot = null;
    try { spot = eco.tradeSpot(); } catch (e) { return undefined; }
    return spot ? (spot.portId === undefined ? null : spot.portId) : undefined;
  }

  function onKey(ev) {
    // NOT gated on `ev.defaultPrevented`: input.js listens first (it is built
    // before the UI) and already calls preventDefault on every arrow, on Tab
    // and on Space so the browser does nothing with them. Reading that flag
    // here meant the sheet never saw a single arrow key.
    if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
    const code = ev.code || ev.key;
    const eat = () => { if (ev.preventDefault) ev.preventDefault(); };

    if (openKind === 'trade') {
      switch (code) {
        case 'ArrowLeft': moveCursor(-1); break;
        case 'ArrowRight': moveCursor(1); break;
        case 'ArrowUp': bump(1); break;
        case 'ArrowDown': bump(-1); break;
        case 'Tab': swapSide(); break;
        case 'Escape': close(); break;
        case 'Enter': case 'NumpadEnter':
          // Enter is the one key that both finishes and leaves: it does the
          // deal when there is a deal to do, and otherwise closes the sheet.
          if (tradeReady) doTheTrade(); else close();
          break;
        default: return;
      }
      eat();
      return;
    }

    if (openKind === 'cards') {
      if (code === 'Escape' || code === 'Enter' || code === 'NumpadEnter') { eat(); close(); }
      return;
    }

    if (openKind === 'results') {
      if (code === 'Escape' || code === 'Enter' || code === 'NumpadEnter') { eat(); hideResults(); }
      return;
    }

    if (code !== 'Enter' && code !== 'NumpadEnter') return;

    // Nothing is open. Enter brings the scoreboard back once the match is over,
    // and otherwise opens the trade sheet if the settler is standing at a post.
    if (state.phase === 'over') {
      if (lastWinner >= 0) { eat(); showResults(lastWinner); }
      return;
    }
    const port = nearbyTrade();
    if (port === undefined) return;
    eat();
    openTrade(port);
  }

  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('keydown', onKey);
  }

  function update(dt) {
    // Self-healing: a replay can rewind the match from under a dismissed
    // scoreboard, and the end-of-match bar must not outlive the match it ended.
    if (state.phase !== 'over' && endgame.dockOpen) {
      endgame.setDock(false);
      lastWinner = -1;
    }
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
    hideResults,
    /** matchflow.js plays this the moment the match freezes, over the board. */
    endBanner(wid) { endgame.banner(wid); },
    get isOpen() { return openKind !== null; },
    get kind() { return openKind; },
    destroy() {
      if (typeof window !== 'undefined' && window.removeEventListener) {
        window.removeEventListener('keydown', onKey);
      }
      endgame.destroy();
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
    }
  };
}

export default createPanels;
