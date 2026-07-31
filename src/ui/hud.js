/**
 * Island Settlers — heads-up display.
 *
 *   createHUD(root, state, game) ->
 *     { update(dt), toast(msg,kind), announce(text,color),
 *       pulseResource(res), flashCost(kind), requestBuild(kind), onPlayBegan() }
 *
 * Landscape, safe-area aware, and deliberately hollow in the middle: every
 * container is pointer-events:none and only real controls opt back in. Each
 * control carries `data-ui` so the joystick layer ignores touches on it.
 *
 * Owner: UI agent.
 */

import {
  RES, RES_LABEL, COST, VICTORY_POINTS, MATCH_SOFT_CAP_SEC,
  CARD_LABEL, TRADE_RADIUS, INTERACT_RADIUS, PIECE_LIMIT,
  canAfford, missingFrom
} from '../core/constants.js';

import {
  scoreOf, rankings, drawCard, nearestPortFor,
  legalRoads, legalSettlements, legalCities
} from '../core/rules.js';

import { MARKET } from '../board/layout.js';
import { nodes } from '../board/nodes.js';
import { el, button, clear, setText, toggle, replay, fmtTime, clamp } from './dom.js';
import { icon, iconEl, resIcon } from './icons.js';

const BUILD_KINDS = [
  { kind: 'road',       label: 'Road',       ico: 'road',   blurb: 'Extend your network' },
  { kind: 'settlement', label: 'Settlement', ico: 'house',  blurb: 'Claim a corner' },
  { kind: 'city',       label: 'City',       ico: 'castle', blurb: 'Triple your yield' },
  { kind: 'card',       label: 'Card',       ico: 'cards',  blurb: 'Draw development' }
];

const HOW_TO = [
  ['Move', 'Drag anywhere on the left half of the screen to run.'],
  ['Gather', 'Stand on a resource and hold — trees, clay, sheep, wheat and ore.'],
  ['Build', 'Tap a build card, then pick a glowing spot on the map.'],
  ['Score', `Settlements 1 pt, cities 2 pts. First to ${VICTORY_POINTS} wins.`],
  ['Awards', 'Longest Road and Largest Army are worth 2 points each.'],
  ['Trade', 'Visit the Great Market for 4:1, or a dock you own for 3:1 / 2:1.']
];

export function createHUD(root, state, game) {
  const me = state.players[0];

  /* ------------------------------------------------------------- scaffold */
  const hud = el('div', { class: 'hud pre', id: 'hud' });

  /* --- top-left: settings, identity, inventory ------------------------- */
  const gearBtn = button('cbtn small ghost', {
    'aria-label': 'Settings',
    on: { click: () => toggleSettings() }
  }, mk('span', 'cb-ico', icon('gear', 22)));

  const vpNum = el('b', { text: '0' });
  const idName = el('b', { class: 'idc-name', text: me.name });
  const idCard = el('div', { class: 'idcard' },
    el('span', { class: 'chip', style: { '--c': me.color.css, '--cl': me.color.light } }),
    el('div', { class: 'idc-txt' },
      idName,
      el('span', { class: 'idc-sub', text: 'Settler' })),
    el('div', { class: 'idc-vp' }, iconEl('trophy', 18), vpNum,
      el('i', { text: '/' + VICTORY_POINTS }))
  );

  const resSlots = {};
  const resBar = el('div', { class: 'resbar' });
  for (const r of RES) {
    const num = el('b', { text: '0' });
    const slot = el('div', { class: 'res', 'data-res': r, title: RES_LABEL[r] },
      iconEl(resIcon(r), 21), num);
    resSlots[r] = { node: slot, num, last: -1 };
    resBar.appendChild(slot);
  }

  const tl = el('div', { class: 'hud-tl' },
    el('div', { class: 'tl-row' }, gearBtn, idCard),
    resBar);

  /* --- top-centre: match ribbon + timer --------------------------------- */
  const timerTxt = el('span', { class: 'tb-txt', text: '0:00' });
  const timerFill = el('i');
  const ribbon = el('div', { class: 'hud-tc' },
    el('div', { class: 'ribbon' },
      el('span', { class: 'rib-title', text: 'Island Settlers' }),
      el('span', { class: 'rib-obj', text: `First to ${VICTORY_POINTS} Points` })),
    el('div', { class: 'timerbar' }, timerFill, timerTxt),
    el('div', { class: 'toasts' })
  );
  const toastWrap = ribbon.lastChild;

  /* --- top-right: live rankings ---------------------------------------- */
  const rankRows = state.players.map(p => {
    const vp = el('b', { class: 'rk-vp', text: '0' });
    const row = el('div', { class: 'rk' + (p.id === 0 ? ' me' : ''), 'data-p': p.id },
      el('span', { class: 'rk-pos', text: '1' }),
      el('span', { class: 'chip sm', style: { '--c': p.color.css, '--cl': p.color.light } }),
      el('span', { class: 'rk-name', text: p.name }),
      el('span', { class: 'rk-award' }),
      vp);
    return { p, row, vp, award: row.childNodes[3] };
  });
  const rankList = el('div', { class: 'ranks' }, rankRows.map(r => r.row));
  const tr = el('div', { class: 'hud-tr' },
    el('div', { class: 'rk-head', text: 'Standings' }), rankList);

  /* --- bottom-centre: build cards --------------------------------------- */
  const buildCards = {};
  const buildRow = el('div', { class: 'build-row' });
  for (const b of BUILD_KINDS) {
    const costRow = el('span', { class: 'bc-cost' });
    const costBits = {};
    for (const r of RES) {
      const n = COST[b.kind][r];
      if (!n) continue;
      const chip = el('i', { class: 'cc', html: icon(resIcon(r), 15) + `<em>${n}</em>` });
      costBits[r] = chip;
      costRow.appendChild(chip);
    }
    const card = el('button', {
      class: 'bcard', type: 'button', 'data-ui': '', 'data-kind': b.kind,
      on: { click: () => requestBuild(b.kind) }
    },
      el('span', { class: 'bc-ico', html: icon(b.ico, 30) }),
      el('span', { class: 'bc-name', text: b.label }),
      costRow,
      el('span', { class: 'bc-lip' })
    );
    buildCards[b.kind] = { node: card, costBits, ok: null };
    buildRow.appendChild(card);
  }
  const bc = el('div', { class: 'hud-bc' }, buildRow);

  /* --- bottom-right: circular actions ----------------------------------- */
  const mkCircle = (ico, label, cls, fn) => {
    const badge = el('i', { class: 'badge hid', text: '0' });
    const node = el('button', {
      class: 'cbtn ' + cls, type: 'button', 'data-ui': '', 'aria-label': label,
      on: { click: fn }
    },
      el('span', { class: 'cb-ico', html: icon(ico, 26) }),
      el('span', { class: 'cb-lab', text: label }),
      badge);
    return { node, badge };
  };
  const btnBuild = mkCircle('hammer', 'Build', 'gold', () => {
    toggle(buildRow, 'hid', !buildRow.classList.contains('hid'));
  });
  const btnCards = mkCircle('cards', 'Cards', 'cream', () => game.openCards());
  const btnMap = mkCircle('map', 'Map', 'blue', () => game.openOverview('view'));
  const br = el('div', { class: 'hud-br' }, btnMap.node, btnCards.node, btnBuild.node);

  /* --- bottom-left: contextual prompt ----------------------------------- */
  let promptAction = null;
  const promptIco = el('span', { class: 'pr-ico', html: icon('hammer', 20) });
  const promptTxt = el('span', { class: 'pr-txt', text: '' });
  const promptSub = el('span', { class: 'pr-sub', text: '' });
  // No `data-ui` until it is actually tappable: this sits in the joystick's
  // corner and must not swallow a thumb that only wants to run.
  const promptBtn = el('button', {
    class: 'prompt hid', type: 'button',
    on: { click: () => { if (promptAction) promptAction(); } }
  }, promptIco, el('span', { class: 'pr-body' }, promptTxt, promptSub));
  const bl = el('div', { class: 'hud-bl' }, promptBtn);

  /* --- announcements ---------------------------------------------------- */
  const annTxt = el('div', { class: 'ann-txt' });
  const annWrap = el('div', { class: 'announce' }, annTxt);

  /* --- settings ---------------------------------------------------------- */
  let soundOn = true;
  const soundBtn = button('wide cream', {
    on: { click: () => setSound(!soundOn) }
  }, el('span', { class: 'sb-ico', html: icon('sound', 20) }),
     el('span', { class: 'sb-lab', text: 'Sound: On' }));

  const howBody = el('div', { class: 'how hid' },
    HOW_TO.map(([t, d]) => el('p', {}, el('b', { text: t }), el('span', { text: d }))));

  const settings = el('div', { class: 'pop settings hid', 'data-ui': '' },
    el('div', { class: 'pop-head' },
      el('span', { class: 'pop-title', text: 'Paused' }),
      button('cbtn small ghost x', { 'aria-label': 'Close', on: { click: () => toggleSettings(false) } },
        mk('span', 'cb-ico', icon('close', 18)))),
    soundBtn,
    button('wide cream', { on: { click: () => toggle(howBody, 'hid', !howBody.classList.contains('hid')) } },
      el('span', { class: 'sb-ico', html: icon('help', 20) }),
      el('span', { class: 'sb-lab', text: 'How to Play' })),
    howBody,
    button('wide red', { on: { click: () => game.restart() } },
      el('span', { class: 'sb-ico', html: icon('restart', 20) }),
      el('span', { class: 'sb-lab', text: 'Restart Match' }))
  );

  hud.appendChild(tl); hud.appendChild(ribbon); hud.appendChild(tr);
  hud.appendChild(bl); hud.appendChild(bc); hud.appendChild(br);
  hud.appendChild(annWrap); hud.appendChild(settings);
  root.appendChild(hud);

  function mk(tag, cls, html) { return el(tag, { class: cls, html }); }

  /* ---------------------------------------------------------------- toast */
  const liveToasts = [];

  function toast(msg, kind = 'info') {
    if (!msg) return;
    const t = el('div', { class: 'toast t-' + kind },
      el('span', { class: 'tk' }), el('span', { text: String(msg) }));
    toastWrap.appendChild(t);
    liveToasts.push({ node: t, t: 0 });
    while (liveToasts.length > 3) {
      const old = liveToasts.shift();
      if (old.node.parentNode) old.node.parentNode.removeChild(old.node);
    }
    return t;
  }

  let annT = 0;
  function announce(text, color) {
    if (!text) return;
    annTxt.textContent = String(text);
    if (color && annTxt.style) annTxt.style.setProperty('--ac', color);
    replay(annWrap, 'show', 2600);
    annT = 2.4;
  }

  /* ------------------------------------------------------------ resources */
  function pulseResource(res) {
    const s = resSlots[res];
    if (!s) return;
    replay(s.node, 'pop', 480);
  }

  function flashCost(kind) {
    const c = buildCards[kind];
    if (!c) return;
    replay(c.node, 'nope', 520);
    const miss = missingFrom(me.res, COST[kind] || {});
    for (const r in c.costBits) toggle(c.costBits[r], 'short', !!miss[r]);
    setTimeout(() => {
      for (const r in c.costBits) toggle(c.costBits[r], 'short', false);
    }, 1400);
  }

  /* -------------------------------------------------------------- actions */
  function pieceCap(kind) {
    if (kind === 'road') return me.roads.size >= PIECE_LIMIT.road;
    if (kind === 'settlement') return me.settlements.size + me.cities.size >= PIECE_LIMIT.settlement;
    if (kind === 'city') return me.cities.size >= PIECE_LIMIT.city;
    return false;
  }

  function legalFor(kind) {
    if (kind === 'road') return legalRoads(state, 0);
    if (kind === 'settlement') return legalSettlements(state, 0);
    if (kind === 'city') return legalCities(state, 0);
    return [1];
  }

  function requestBuild(kind) {
    if (state.phase === 'over') return false;
    if (state.phase === 'setup') { toast('Finish the opening draft first', 'warn'); return false; }
    if (!COST[kind]) return false;

    if (pieceCap(kind)) {
      toast(`No ${kind} pieces left`, 'warn');
      flashCost(kind);
      return false;
    }
    if (!canAfford(me.res, COST[kind])) {
      const miss = missingFrom(me.res, COST[kind]);
      const bits = Object.keys(miss).map(r => `${miss[r]} ${RES_LABEL[r]}`).join(', ');
      toast(`Need ${bits}`, 'bad');
      flashCost(kind);
      return false;
    }
    if (kind === 'card') {
      const card = drawCard(state, 0);
      if (!card) { flashCost('card'); return false; }
      if (card.type === 'victoryPoint') announce('+1 Victory Point!', '#ffc93c');
      else toast(`Drew ${CARD_LABEL[card.type]}`, 'good');
      refreshAll(true);
      return true;
    }
    const legal = legalFor(kind);
    if (!legal.length) {
      toast(kind === 'city'
        ? 'Upgrade needs one of your settlements'
        : `Nowhere legal to place a ${kind}`, 'warn');
      flashCost(kind);
      return false;
    }
    game.openOverview('place-' + kind, {});
    return true;
  }

  function setSound(on) {
    soundOn = !!on;
    const a = game.audio;
    if (a) {
      a.muted = !soundOn;
      if (typeof a.setMuted === 'function') a.setMuted(!soundOn);
      else if (typeof a.mute === 'function') a.mute(!soundOn);
      if (typeof a.ambience === 'function') a.ambience(soundOn);
      if (typeof a.music === 'function' && !soundOn) a.music('off');
    }
    soundBtn.childNodes[0].innerHTML = icon(soundOn ? 'sound' : 'mute', 20);
    soundBtn.childNodes[1].textContent = 'Sound: ' + (soundOn ? 'On' : 'Off');
  }

  let settingsOpen = false;
  function toggleSettings(force) {
    settingsOpen = force === undefined ? !settingsOpen : !!force;
    toggle(settings, 'hid', !settingsOpen);
    toggle(gearBtn, 'on', settingsOpen);
  }

  /* --------------------------------------------------------------- prompt */
  let promptKey = '';

  function nearestNode() {
    let best = null, bd = (INTERACT_RADIUS * 1.9) ** 2;
    for (const n of nodes) {
      if (n.remaining <= 0) continue;
      const d = (n.x - me.x) ** 2 + (n.z - me.z) ** 2;
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  }

  function refreshPrompt() {
    if (state.phase !== 'play') { setPrompt(null); return; }
    if (me.action === 'gather' && me.gatherNode) {
      setPrompt('gather', resIcon(me.gatherNode.resource),
        'Gathering', RES_LABEL[me.gatherNode.resource], null);
      return;
    }
    const dm = Math.hypot(me.x - MARKET.x, me.z - MARKET.z);
    if (dm < TRADE_RADIUS + MARKET.radius) {
      setPrompt('market', 'swap', 'Open Market', 'Trade 4 : 1', () => game.openTrade(null));
      return;
    }
    const port = nearestPortFor(state, 0, me.x, me.z, TRADE_RADIUS + 3);
    if (port) {
      setPrompt('port' + port.id, 'ship', `Trade ${port.ratio} : 1`,
        port.resource ? RES_LABEL[port.resource] + ' dock' : 'Any resource',
        () => game.openTrade(port.id));
      return;
    }
    const n = nearestNode();
    if (n) {
      setPrompt('node' + n.resource, resIcon(n.resource),
        'Hold to gather', RES_LABEL[n.resource], null);
      return;
    }
    setPrompt(null);
  }

  function setPrompt(key, ico, txt, sub, action) {
    if (key === null) {
      if (promptKey !== '') { promptKey = ''; toggle(promptBtn, 'hid', true); promptAction = null; }
      return;
    }
    promptAction = action || null;
    toggle(promptBtn, 'tappable', !!action);
    if (action) promptBtn.setAttribute('data-ui', '');
    else if (promptBtn.removeAttribute) promptBtn.removeAttribute('data-ui');
    if (key === promptKey) return;
    promptKey = key;
    promptIco.innerHTML = icon(ico, 20);
    setText(promptTxt, txt);
    setText(promptSub, sub || '');
    toggle(promptBtn, 'hid', false);
    replay(promptBtn, 'in', 400);
  }

  /* -------------------------------------------------------------- refresh */
  let order = rankRows.map(r => r.p.id);

  function refreshRanks() {
    const rk = rankings(state);
    const next = rk.map(e => e.p.id);
    let changed = next.length !== order.length;
    for (let i = 0; !changed && i < next.length; i++) changed = next[i] !== order[i];

    const before = {};
    if (changed) for (const r of rankRows) before[r.p.id] = r.row.offsetTop || 0;

    rk.forEach((e, i) => {
      const r = rankRows[e.p.id];
      setText(r.vp, e.vp);
      setText(r.row.childNodes[0], i + 1);
      toggle(r.row, 'lead', i === 0);
      let aw = '';
      if (e.p.hasLongestRoad) aw += icon('road', 14, 'aw');
      if (e.p.hasLargestArmy) aw += icon('knight', 14, 'aw');
      if (r.award.innerHTML !== aw) r.award.innerHTML = aw;
      if (changed) rankList.appendChild(r.row);
    });

    if (changed) {
      order = next;
      for (const r of rankRows) {
        const dy = (before[r.p.id] || 0) - (r.row.offsetTop || 0);
        if (!dy || !r.row.style) continue;
        r.row.style.transition = 'none';
        r.row.style.transform = `translateY(${dy}px)`;
        void (r.row.offsetWidth || 0);
        r.row.style.transition = 'transform .32s cubic-bezier(.22,.9,.3,1)';
        r.row.style.transform = 'translateY(0)';
      }
    }
  }

  function refreshBuild() {
    let ready = 0;
    for (const b of BUILD_KINDS) {
      const c = buildCards[b.kind];
      const afford = canAfford(me.res, COST[b.kind]);
      const capped = pieceCap(b.kind);
      const ok = afford && !capped && state.phase === 'play';
      if (ok) ready++;
      if (c.ok !== ok) {
        c.ok = ok;
        toggle(c.node, 'off', !ok);
        if (ok) replay(c.node, 'ready', 700);
      }
      const miss = afford ? null : missingFrom(me.res, COST[b.kind]);
      for (const r in c.costBits) toggle(c.costBits[r], 'lack', !!(miss && miss[r]));
    }
    setBadge(btnBuild, ready);
    setBadge(btnCards, me.cards.length);
  }

  function setBadge(b, n) {
    toggle(b.badge, 'hid', !n);
    if (n) setText(b.badge, n > 9 ? '9+' : n);
  }

  function refreshAll(force) {
    for (const r of RES) {
      const s = resSlots[r];
      const v = me.res[r] | 0;
      if (s.last !== v) {
        if (v > s.last && s.last >= 0) replay(s.node, 'pop', 480);
        s.last = v;
        setText(s.num, v);
      }
    }
    setText(vpNum, scoreOf(state, me));
    refreshRanks();
    refreshBuild();
    if (force) refreshPrompt();
  }

  /* ----------------------------------------------------------------- loop */
  let slow = 0, promptT = 0, timeT = 0;

  function update(dt) {
    const d = Number.isFinite(dt) ? dt : 1 / 60;

    // Safety net: if play started without a setupComplete event reaching us,
    // still reveal the controls rather than leaving the player with no HUD.
    if (state.phase === 'play' && hud.classList.contains('pre')) onPlayBegan();

    slow += d;
    if (slow >= 0.1) { slow = 0; refreshAll(false); }

    promptT += d;
    if (promptT >= 0.22) { promptT = 0; refreshPrompt(); }

    timeT += d;
    if (timeT >= 0.25) {
      timeT = 0;
      setText(timerTxt, fmtTime(state.time));
      if (timerFill.style) {
        timerFill.style.width =
          (clamp(state.time / MATCH_SOFT_CAP_SEC, 0, 1) * 100).toFixed(1) + '%';
      }
    }

    for (let i = liveToasts.length - 1; i >= 0; i--) {
      const t = liveToasts[i];
      t.t += d;
      if (t.t > 2.5 && !t.out) { t.out = true; toggle(t.node, 'out', true); }
      if (t.t > 3.1) {
        if (t.node.parentNode) t.node.parentNode.removeChild(t.node);
        liveToasts.splice(i, 1);
      }
    }

    if (annT > 0) {
      annT -= d;
      if (annT <= 0) toggle(annWrap, 'show', false);
    }
  }

  function onPlayBegan() {
    toggle(hud, 'pre', false);
    replay(hud, 'enter', 900);
    refreshAll(true);
    toast('Go! Gather, build, win.', 'good');
    announce('Settle the Island', me.color.css);
  }

  setSound(true);
  refreshAll(true);
  if (state.phase === 'play') toggle(hud, 'pre', false);

  return {
    update, toast, announce, pulseResource, flashCost, requestBuild, onPlayBegan,
    get root() { return hud; },
    openSettings: () => toggleSettings(true),
    destroy() { if (hud.parentNode) hud.parentNode.removeChild(hud); }
  };
}

export default createHUD;
