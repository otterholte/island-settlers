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
 * Standing on a trading post, Enter opens the trade sheet — no hunting for a
 * button with a thumb that is busy steering. The sheet itself lives in
 * `src/ui/trade.js` and owns its own arrow-key handling; this file only routes
 * keys to it and takes the keyboard off the settler while it is up.
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
  RES, COST, CARD_LABEL, CARD_BLURB,
  LONGEST_ROAD_VP, LARGEST_ARMY_VP, canAfford
} from '../core/constants.js';

import {
  playRoadBuilding, placeRoad, legalRoads, scoreOf, rankings
} from '../core/rules.js';

import { knightsOn } from '../core/options.js';
import { el, button, clear, toggle, setText, fmtTime } from './dom.js';
import { icon, resIcon, avatar } from './icons.js';
import { createEndgame } from './hud-end.js';
import { createTradeSheet } from './trade.js';

const CARD_ART = { knight: 'knight', roadBuilding: 'road', victoryPoint: 'trophy' };

/* What tapping the card actually does, said on the card itself. "Tap to play"
   told the player nothing about what was about to happen to their screen. */
const CARD_CTA = {
  knight: 'Tap · pick a region on the map',
  roadBuilding: 'Tap · place two roads free',
  victoryPoint: 'Already counted'
};

export function createPanels(root, state, game) {
  const me = state.players[0];

  const scrim = el('div', { class: 'scrim', on: { click: () => close() } });
  const wrap = el('div', { class: 'panels hid', 'data-ui': '' }, scrim);
  root.appendChild(wrap);

  let openKind = null;
  let refreshT = 0;

  /* ================================================================ trade */
  /* One row of five cards, driven by the arrow keys. trade.js owns the whole
     staging model and its own key handling; we only place it and route. */
  const tradeUI = createTradeSheet(state, game, { onClose: () => close() });
  const tradeSheet = tradeUI.node;
  wrap.appendChild(tradeSheet);

  function openTrade(id) {
    tradeUI.open(id);
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
        el('p', {
          text: knightsOn()
            ? 'No cards in hand. Buy one to raise an army or lay free roads.'
            : 'No cards in hand. Buy one for free roads or a straight victory point.'
        })));
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
        el('span', { class: 'dc-play', text: CARD_CTA[c.type] || 'Tap to play' }));
      hand.appendChild(card);
    });
    setText(vpNote, me.vpCards
      ? `${me.vpCards} victory point card${me.vpCards > 1 ? 's' : ''} held`
      // With Knights switched off the deck holds no Knights at all, so the
      // standing hint would be advertising a card that cannot be drawn.
      : (knightsOn()
        ? 'Knights also win you the Largest Army'
        : 'Knights are off for this match — none in this deck'));
    const afford = canAfford(me.res, COST.card);
    toggle(buyBtn, 'off', !afford || state.phase !== 'play');
  }

  function buyCard() {
    const ok = game.requestBuild ? game.requestBuild('card') : false;
    syncCards();
    return ok;
  }

  /**
   * Playing a card is one tap, and both playable cards go straight to the map.
   *
   *   KNIGHT         hud-knight.js owns the whole gesture: it closes this
   *                  sheet, opens the FULL board in Knight mode with every
   *                  legal region lit and "Choose a region to block" on the
   *                  plate, commits through rules.js and holds the board for a
   *                  beat afterwards so the Knight can be seen landing.
   *   ROAD BUILDING  economy.js checks there is somewhere legal to build
   *                  BEFORE spending the card. If there is not, it says so and
   *                  the card stays in hand — no panel, nothing consumed.
   *                  Otherwise the placement map opens immediately and two
   *                  roads go down for nothing.
   */
  function playCard(c) {
    if (state.phase !== 'play') return;
    if (c.type === 'victoryPoint') return;   // already scored; nothing to play

    if (c.type === 'knight') {
      const cue = game.knightCue;
      if (cue && typeof cue.play === 'function') { cue.play(); return; }
      close();
      game.openOverview('place-robber', {
        title: 'Send the Knight',
        hint: 'Tap a region, tap it again to send',
        pickLabel: 'Choose a region'
      });
      return;
    }

    if (c.type === 'roadBuilding') {
      const cue = game.roadCue;
      if (cue && typeof cue.play === 'function') { cue.play(); return; }
      const eco = game.economy;
      if (eco && typeof eco.useRoadBuilding === 'function') {
        // The sheet has to be OUT OF THE WAY before the placement map comes up,
        // exactly as the Knight route does it. Closing afterwards left the cards
        // sheet and its scrim sitting over a freshly opened map for the length
        // of the fade, and the scrim's own click handler ate the first tap —
        // which looked, from the player's chair, like the card doing nothing.
        // `roadRoom` inside `useRoadBuilding` refuses BEFORE spending the card,
        // so re-opening on a refusal costs the player nothing.
        close();
        if (!eco.useRoadBuilding()) openCards();
        return;
      }
      if (!legalRoads(state, 0).length) {
        if (game.toast) game.toast('Nowhere to lay a road — keep the card', 'warn');
        return;
      }
      if (!playRoadBuilding(state, 0)) return;
      close();
      if (game.toast) game.toast('Two free roads — place them now', 'good');
      freeRoad();
    }
  }

  /** Fallback chain, used only when economy.js is not attached. */
  function freeRoad() {
    const left = me.freeRoads || 0;
    if (left <= 0) return;
    game.openOverview('place-road', {
      free: true,
      title: left > 1 ? 'Free Road · 1 of 2' : 'Free Road · Last One',
      hint: 'Tap a glowing edge, then tap it again — this one is free',
      pickLabel: 'Pick an edge',
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

  /* TWO PANES, ONE AT A TIME ON A PHONE.
   *
   *   "Make there be two separate sections so you can tab between the match
   *    report in full size and the points breakdown. Since right now the
   *    individual players' points breakdowns are too tall, since they don't all
   *    fit in one line."
   *
   * Both halves of that are the same problem. The standings and the report were
   * side by side, so on a phone the standings got about two thirds of the width
   * and every player's chips wrapped onto a second line — which made each row
   * tall enough that the fourth player fell off the bottom — while the report
   * got a 210px column it had to scroll inside.
   *
   * Tabbed, each one gets the whole sheet. The chips fit on one line, four rows
   * fit on screen, and the report is readable without scrolling. On a desktop
   * there is room for both and the tabs stand down — see the media block in
   * ui.css. */
  const resSide = el('div', { class: 'rs-side plate' },
    el('h4', { text: 'Match Report' }), resStats);

  let resTab = 'scores';
  const tabBtn = (key, label) => button('rs-tab', {
    'aria-label': label, on: { click: () => setResTab(key) }
  }, el('span', { class: 'sb-lab', text: label }));
  const tabScores = tabBtn('scores', 'Standings');
  const tabReport = tabBtn('report', 'Match Report');
  const resTabs = el('div', { class: 'rs-tabs' }, tabScores, tabReport);

  function setResTab(key) {
    resTab = key === 'report' ? 'report' : 'scores';
    toggle(resultsSheet, 'tab-report', resTab === 'report');
    toggle(tabScores, 'on', resTab === 'scores');
    toggle(tabReport, 'on', resTab === 'report');
  }

  const resultsSheet = el('div', { class: 'results hid' },
    resBanner, resX,
    el('div', { class: 'rs-head' }, resTitle, resSub),
    resTabs,
    el('div', { class: 'rs-body' }, resList, resSide),
    el('div', { class: 'rs-foot' }, againBtn, boardBtn));
  setResTab('scores');
  wrap.appendChild(resultsSheet);

  const endgame = createEndgame(root, state, game, {
    onResults: () => showResults(lastWinner)
  });
  let lastWinner = -1;

  /* "+4" is a number, "+4 Points" is an answer — and "+4 🏆" is the same
   * answer three characters long.
   *
   *   "Maybe instead of saying +__ points you say +__🏆, since the trophy is
   *    showing the total points on the right side of the same section."
   *
   * Which is the argument that finishes the one this chip has been having with
   * itself for three passes. It went from "+4" to "+4 Victory Points" because a
   * bare number had no unit; the qualifier came off because nothing else on the
   * screen scores; and the word can go too, because the cup at the end of the
   * row already says what the unit is and says it in a picture. The word was
   * the longest thing on the longest chip, and dropping it is most of why four
   * players now fit on a phone. */
  const CUP = icon('trophy', 11);
  const points = n => `+${n}${CUP}`;

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  /**
   * Where a player's score actually came from.
   *
   *   "Don't just have the points they won for things like victory points,
   *    settlements, longest road etc be saying +1 +4 etc — have it actually say
   *    +4 Victory Points."
   *
   * Each chip is now the source and the payment in words: a castle icon,
   * "2 CITIES", "+4 Points". The bare "+4" was the one number on the results
   * screen with no unit attached to it, sitting next to a settlement count, a
   * city count and a card count that were all also bare numbers — so the four
   * of them looked like the same kind of figure and only one of them was.
   * (It read "+4 Victory Points" for a while; the qualifier came back off,
   * since nothing on this screen scores anything else.)
   */
  function breakdown(p) {
    const bits = [];
    if (p.settlements.size) {
      bits.push([plural(p.settlements.size, 'Settlement'), p.settlements.size, 'house']);
    }
    if (p.cities.size) bits.push([plural(p.cities.size, 'City').replace('Citys', 'Cities'),
      p.cities.size * 2, 'castle']);
    if (p.vpCards) bits.push([plural(p.vpCards, 'Victory Card'), p.vpCards, 'cards']);
    if (p.hasLongestRoad) bits.push(['Longest Road', LONGEST_ROAD_VP, 'road']);
    if (p.hasLargestArmy) bits.push(['Largest Army', LARGEST_ARMY_VP, 'knight']);
    return bits;
  }

  /**
   * The two things every player has a number for, whether or not they won the
   * award attached to it.
   *
   *   "On the results page can you also show things like how many knights they
   *    played for all players, and how long their longest roads were — just
   *    have the person who [has] the longest road have the badge for it."
   *
   * The breakdown above only ever mentions Longest Road and Largest Army on the
   * ONE player holding each, because that is the only player they scored for.
   * That left the most interesting number on the screen — how close everybody
   * else came — nowhere at all. This strip carries it for all four, and the
   * holder's chip goes gold and names the award. Knights are dropped entirely
   * when Knights were switched off before the draft, since a column of zeroes
   * that could never have been anything else is not a statistic.
   */
  function tally(p) {
    const chip = (won, ico, n, label) =>
      `<i class="${won ? 'won' : ''}">${icon(ico, 18)}<em>${n}</em><u>${label}</u></i>`;
    // The holder's chip is the BADGE and says the award's name; everybody
    // else's is the plain measurement. Same words on both would make the gold
    // the only difference, and gold alone is a thin thing to hang a badge on.
    let h = chip(p.hasLongestRoad, 'road', p.longestRoadLen,
      p.hasLongestRoad ? 'Longest Road' : 'Road');
    if (knightsOn()) {
      h += chip(p.hasLargestArmy, 'knight', p.knightsPlayed,
        p.hasLargestArmy ? 'Largest Army' : (p.knightsPlayed === 1 ? 'Knight' : 'Knights'));
    }
    return h;
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
    /* THE MEDALLION SAYS WHOSE ISLAND IT IS.
     *
     *   "Make this trophy not be a trophy if I lost, but if I win, make the
     *    trophy show."
     *
     * It used to be the same cup either way, on a plate tinted with the
     * WINNER's colour — so losing to Alex handed you a red rosette with a
     * trophy in it, which is a picture of somebody being congratulated and
     * that somebody was not you.
     *
     * Win and you get the cup, on gold. Lose and you get the winner's own
     * portrait, on their colour: the same fact the line underneath states in
     * words, said once in a picture. Nothing is being awarded to anybody who
     * did not earn it. */
    resBanner.innerHTML = iWon
      ? icon('trophyBig', 64)
      : avatar(w.color.css, w.color.light, 58);
    toggle(resBanner, 'lost', !iWon);
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
              ? bits.map(b =>
                `<i>${icon(b[2], 20)}<u>${b[0]}</u><em class="pt">${points(b[1])}</em></i>`).join('')
              : '<i><u>No points scored</u></i>'
          }),
          el('span', { class: 'rs-tally', html: tally(p) })),
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
      // trade.js answers true for every key it consumed. Nothing else may
      // reach the settler while the sheet is up, so an unclaimed key is simply
      // dropped rather than passed on.
      if (tradeUI.key(code)) eat();
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
    if (openKind === 'trade') tradeUI.sync();
    else if (openKind === 'cards') syncCards();
  }

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
