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
 * The HUD's whole job is legibility of progress:
 *   top-left     who you are and how far along the 12-point track
 *   top-centre   what you own, which regions still have it, and the one line
 *                that answers "what should I do right now?"
 *   top-right    standings, deliberately quiet
 *   bottom-left  what the ground under your feet is offering, and when a
 *                worked-out region comes back
 *   bottom-centre four live progress meters, one per purchase
 *
 * Owner: UI agent.
 */

import {
  RES, RES_LABEL, COST, VICTORY_POINTS,
  CARD_LABEL,
  canAfford, missingFrom
} from '../core/constants.js';

import { scoreOf, rankings, drawCard } from '../core/rules.js';

import { el, button, setText, toggle, replay, setVar, fmtTime } from './dom.js';
import { icon, iconEl, resIcon, avatar } from './icons.js';
import { createBuildBar } from './hud-build.js';
import { createTradeCue } from './hud-trade.js';
import { createKnightCue } from './hud-knight.js';
import {
  createGuide, regionReport, standingRegion, pieceCapped, hasSomewhere,
  REGION_ONE
} from './hud-guide.js';

const RES_ICON_PX = 28;

const HOW_TO = [
  ['Move', 'Drag anywhere on the left half of the screen to run.'],
  ['Gather', 'Run straight over a tree, a sheep, a clay pile — it is yours the moment you touch it. No holding, no waiting.'],
  ['Your land', 'You may only pick things up on a hex where you own a settlement or a city. Everywhere else you run through and collect nothing.'],
  ['Regions', 'Sweep a hex clean and the whole field rests, then comes back at once. The bars under the resource pill show what is still standing.'],
  ['Build', 'Each card fills as you gather. When it glows gold you can afford it — tap it, then pick a glowing spot.'],
  ['Score', `Settlement 1 point, city 2, victory card 1. First to ${VICTORY_POINTS} wins.`],
  ['Awards', 'Longest Road is 4 points, Largest Army 2.'],
  ['Trade', 'The Great Market swaps 4:1; a dock you own does 3:1 or 2:1.'],
  ['Cards', 'A Knight opens the whole board so you can pick the region the Raider shuts down. Road Building opens the map and lays two roads for nothing.']
];

export function createHUD(root, state, game) {
  const me = state.players[0];
  const guide = createGuide(state, game);
  const rivalNames = state.players.filter(p => p.id !== 0).map(p => p.name);

  /* ------------------------------------------------------------- scaffold */
  const hud = el('div', { class: 'hud pre', id: 'hud' });
  const mk = (tag, cls, html) => el(tag, { class: cls, html });

  /* --- top-left: settings, identity, victory track ---------------------- */
  const gearBtn = button('cbtn small ghost', {
    'aria-label': 'Settings', on: { click: () => toggleSettings() }
  }, mk('span', 'cb-ico', icon('gear', 22)));

  const vpNum = el('b', { text: '0' });
  const vpCells = [];
  const vpTrack = el('span', { class: 'vp-track' });
  for (let i = 0; i < VICTORY_POINTS; i++) {
    const c = el('i', { class: i === VICTORY_POINTS - 1 ? 'goal' : '' });
    vpCells.push(c); vpTrack.appendChild(c);
  }
  /* The identity chip carries the player's colour hard: a full-height banner
     down its edge, a coloured frame and a coloured wash behind the name. The
     whole point is that "me" and "the blue buildings out there" are obviously
     the same thing, without a word of explanation. */
  const idCard = el('div', {
    class: 'idcard plate mine',
    style: { '--me': me.color.css, '--mel': me.color.light }
  },
    el('span', { class: 'idc-banner' }),
    el('span', { class: 'idc-av', html: avatar(me.color.css, me.color.light, 32) }),
    el('div', { class: 'idc-txt' },
      el('b', { class: 'idc-name', text: me.name }),
      el('span', { class: 'idc-hue' }, el('i'), el('em', { text: me.color.key })),
      vpTrack),
    el('div', { class: 'idc-vp' }, iconEl('trophy', 20), vpNum)
  );

  const timerTxt = el('b', { text: '0:00' });
  const timeChip = el('div', { class: 'timechip plate' }, iconEl('clock', 14), timerTxt);
  const tl = el('div', { class: 'hud-tl' },
    el('div', { class: 'tl-row' }, gearBtn, idCard), timeChip);

  /* --- top-centre: resources, region availability, next step -------------
     One beveled pill in the prime slot: five 28px objects, 20px stroked
     numerals, and a hairline bar under each showing how much of that
     resource is still standing on the island. Below it, one quiet line
     that always says what to do next. */
  const resSlots = {};
  const resBar = el('div', { class: 'resbar' });
  for (const r of RES) {
    const num = el('b', { text: '0' });
    const live = el('i', { class: 'res-live' }, el('span'));
    const slot = el('div', { class: 'res', 'data-res': r, title: RES_LABEL[r] },
      iconEl(resIcon(r), RES_ICON_PX), num, live);
    resSlots[r] = { node: slot, num, live, last: -1, lastF: -1 };
    resBar.appendChild(slot);
  }

  const obIco = el('span', { class: 'ob-ico' });
  const obLead = el('b', { class: 'ob-lead' });
  const obTail = el('span', { class: 'ob-tail' });
  const objective = el('div', { class: 'objective plate' }, obIco,
    el('span', { class: 'ob-body' }, obLead, obTail));

  const tc = el('div', { class: 'hud-tc' }, resBar, objective);

  /* --- toasts ------------------------------------------------------------ */
  const toastWrap = el('div', { class: 'hud-toasts' });

  /* --- top-right: standings, deliberately quiet -------------------------- */
  const rankRows = state.players.map(p => {
    const vp = el('b', { text: '0' });
    const award = el('span', { class: 'rk-award' });
    const row = el('div', {
      class: 'rk' + (p.id === 0 ? ' me' : ''), 'data-p': p.id,
      style: { '--c': p.color.css, '--cl': p.color.light }
    },
      el('span', { class: 'rk-av', html: avatar(p.color.css, p.color.light, p.id === 0 ? 26 : 22) }),
      el('span', { class: 'rk-name', text: p.name }),
      award,
      el('span', { class: 'rk-vp' }, p.id === 0 ? iconEl('trophy', 16) : null, vp));
    return { p, row, vp, award };
  });
  const rankList = el('div', { class: 'ranks' }, rankRows.map(r => r.row));
  const tr = el('div', { class: 'hud-tr plate' }, rankList);

  /* --- bottom-centre: the four progress meters --------------------------- */
  const buildBar = createBuildBar(state, game, { onBuy: kind => requestBuild(kind) });
  const buildRow = buildBar.node;
  const bc = el('div', { class: 'hud-bc' }, buildRow);

  /* --- bottom-right: circular actions ------------------------------------ */
  const mkCircle = (ico, label, cls, fn) => {
    const badge = el('i', { class: 'badge hid', text: '0' });
    const node = el('button', {
      class: 'cbtn ' + cls, type: 'button', 'data-ui': '', 'aria-label': label,
      on: { click: fn }
    },
      el('span', { class: 'cb-ico', html: icon(ico, 26) }),
      el('span', { class: 'cb-lab', text: label }), badge);
    return { node, badge };
  };
  const btnBuild = mkCircle('hammer', 'Build', 'gold', () => {
    toggle(buildRow, 'hid', !buildRow.classList.contains('hid'));
  });
  const btnCards = mkCircle('cards', 'Cards', 'cream', () => game.openCards());
  const btnMap = mkCircle('map', 'Map', 'blue', () => game.openOverview('view'));
  const br = el('div', { class: 'hud-br' }, btnMap.node, btnCards.node, btnBuild.node);

  /* --- bottom-left: what the ground here is offering ---------------------- */
  let promptAction = null;
  const promptIco = el('span', { class: 'pr-ico', html: icon('hammer', 26) });
  const promptTxt = el('span', { class: 'pr-txt', text: '' });
  const promptSub = el('span', { class: 'pr-sub', text: '' });
  const promptBar = el('span', { class: 'pr-bar' }, el('i'));
  // No `data-ui` until it is actually tappable: this sits in the joystick's
  // corner and must not swallow a thumb that only wants to run.
  const promptBtn = el('button', {
    class: 'prompt plate hid', type: 'button',
    on: { click: () => { if (promptAction) promptAction(); } }
  }, promptIco, el('span', { class: 'pr-body' }, promptTxt, promptSub, promptBar));
  const bl = el('div', { class: 'hud-bl' }, promptBtn);

  /* --- announcements ----------------------------------------------------- */
  const annTxt = el('div', { class: 'ann-txt' });
  const annWrap = el('div', { class: 'announce' }, annTxt);

  /* --- settings ----------------------------------------------------------- */
  let soundOn = true;
  const soundBtn = button('wide cream', { on: { click: () => setSound(!soundOn) } },
    el('span', { class: 'sb-ico', html: icon('sound', 20) }),
    el('span', { class: 'sb-lab', text: 'Sound: On' }));

  const howBody = el('div', { class: 'how hid' },
    HOW_TO.map(([t, d]) => el('p', {}, el('b', { text: t }), el('span', { text: d }))));

  const settings = el('div', { class: 'pop settings plate lift hid', 'data-ui': '' },
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

  hud.appendChild(tl); hud.appendChild(tc); hud.appendChild(tr);
  hud.appendChild(bl); hud.appendChild(bc); hud.appendChild(br);
  hud.appendChild(toastWrap); hud.appendChild(annWrap); hud.appendChild(settings);
  root.appendChild(hud);

  /* The world-anchored trade banner. It lives inside the HUD layer so it can
     measure itself against the same box everything else is laid out in. */
  const tradeCue = createTradeCue(hud, state, game);

  /* A Knight is the one card that needs the whole board to play, so it gets its
     own standing call-to-action rather than hiding behind the CARDS button.
     hud-knight.js announces the draw and owns the Raider placement gesture. */
  const knightCue = createKnightCue(hud, state, game);
  game.knightCue = knightCue;

  /* ---------------------------------------------------------------- toast */
  const liveToasts = [];

  function toast(msg, kind = 'info') {
    if (!msg) return;
    const t = el('div', { class: 'toast plate t-' + kind },
      el('span', { class: 'tk' }), el('span', { text: String(msg) }));
    toastWrap.appendChild(t);
    liveToasts.push({ node: t, t: 0 });
    while (liveToasts.length > 2) {
      const old = liveToasts.shift();
      if (old.node.parentNode) old.node.parentNode.removeChild(old.node);
    }
    return t;
  }

  /* A rival's news is news, not an event. It gets a toast, at most one every
     ten seconds; the centre banner is reserved for things the player did. */
  let annT = 0, lastRival = -99;

  function announce(text, color) {
    if (!text) return;
    const s = String(text);
    if (rivalNames.some(n => s.startsWith(n))) {
      if (state.time - lastRival < 10) return;
      lastRival = state.time;
      toast(s, 'info');
      return;
    }
    annTxt.textContent = s;
    if (color && annTxt.style) annTxt.style.setProperty('--ac', color);
    replay(annWrap, 'show', 2600);
    annT = 2.4;
  }

  /* ------------------------------------------------------------ resources */
  function pulseResource(res) {
    const s = resSlots[res];
    if (s) replay(s.node, 'pop', 480);
  }

  function flashCost(kind) { buildBar.flash(kind); }

  /* -------------------------------------------------------------- actions */
  function requestBuild(kind) {
    if (state.phase === 'over') return false;
    if (state.phase === 'setup') { toast('Finish the opening draft first', 'warn'); return false; }
    if (!COST[kind]) return false;

    if (pieceCapped(state, 0, kind)) {
      toast(`No ${kind} pieces left`, 'warn'); flashCost(kind); return false;
    }
    if (!canAfford(me.res, COST[kind])) {
      const miss = missingFrom(me.res, COST[kind]);
      toast(`Need ${Object.keys(miss).map(r => `${miss[r]} ${RES_LABEL[r]}`).join(', ')}`, 'bad');
      flashCost(kind);
      return false;
    }
    if (kind === 'card') {
      const card = drawCard(state, 0);
      if (!card) { flashCost('card'); return false; }
      // A Knight gets the centre banner from hud-knight.js, which also raises
      // the standing "play me" chip — so it deliberately says nothing here.
      if (card.type === 'victoryPoint') announce('+1 Victory Point!', '#ffc93c');
      else if (card.type === 'roadBuilding') {
        toast('Road Building — open CARDS to lay two roads free', 'good');
      } else toast(`Drew ${CARD_LABEL[card.type]}`, 'good');
      refreshAll(true);
      return true;
    }
    if (!hasSomewhere(state, kind)) {
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

  /* --------------------------------------------------------------- prompt
     The ground report. Gathering is contact-based now — you run over a thing
     and it is yours — so there is nothing here to hold, nothing to fill and no
     `action === 'gather'` to branch on. What is left are the three facts the
     player actually needs about the hex under their feet:

        is it mine        you may only collect where you own a corner
        what is left      items still standing, out of a full field
        why nothing       not yours / raider sitting on it / swept clean

     `statusHere` (src/systems/gathering.js) answers the first and third;
     `standingRegion` (hud-guide.js) answers the second and carries the
     recovery clock. Off a resource hex entirely, the chip stands down — the
     joystick lives in this corner and an empty plate is just an obstacle. */
  let promptKey = '';

  function refreshPrompt() {
    if (state.phase !== 'play') { setPrompt(null); return; }

    const here = standingRegion(state, me);
    if (!here) { setPrompt(null); return; }        // desert, market lawn, shore

    const g = game.gathering;
    const status = g && g.statusHere
      ? g.statusHere(0)
      : (!here.mine ? 'unowned' : here.blocked ? 'raider' : here.exhausted ? 'empty' : 'ok');

    const label = RES_LABEL[here.resource];
    const ico = resIcon(here.resource);

    // Standing on land nobody has settled for you. This is the single most
    // common reason a new player collects nothing, so it is named outright.
    // Both lines are kept short on purpose: this plate is 158px wide on a
    // 667px phone, and a sentence that ellipsises is a sentence nobody reads.
    if (status === 'unowned') {
      setPrompt('un' + here.tile.id, ico, 'Not your land',
        'Settle a corner', null, -1);
      return;
    }
    if (status === 'raider') {
      setPrompt('raid' + here.tile.id, 'knight', 'Raider is here',
        'It gives nothing', null, -1);
      return;
    }
    if (status === 'empty' || here.exhausted || here.units <= 0) {
      setPrompt('spent' + here.tile.id, ico, 'Worked out',
        `Back in ${Math.ceil(here.secondsLeft)}s`, null, here.recovery);
      return;
    }

    // Yours, standing, and there is something on it. Say what and how much.
    setPrompt('ok' + here.tile.id, ico, 'Your ' + REGION_ONE[here.resource],
      `${here.units} ${label} left`, null, -1);
  }

  /** `bar` < 0 hides the recovery meter; 0..1 shows it filling. */
  function setPrompt(key, ico, txt, sub, action, bar) {
    if (key === null) {
      if (promptKey !== '') { promptKey = ''; toggle(promptBtn, 'hid', true); promptAction = null; }
      return;
    }
    promptAction = action || null;
    toggle(promptBtn, 'tappable', !!action);
    if (action) promptBtn.setAttribute('data-ui', '');
    else if (promptBtn.removeAttribute) promptBtn.removeAttribute('data-ui');

    setText(promptSub, sub || '');           // sub carries a live countdown
    const showBar = bar >= 0;
    toggle(promptBar, 'on', showBar);
    if (showBar) setVar(promptBar.firstChild, 'width', (bar * 100).toFixed(1) + '%');
    toggle(promptBtn, 'spent', showBar);

    if (key === promptKey) return;
    promptKey = key;
    promptIco.innerHTML = icon(ico, 20);
    setText(promptTxt, txt);
    toggle(promptBtn, 'hid', false);
    replay(promptBtn, 'in', 400);
  }

  /* ------------------------------------------------------------ standings */
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
      toggle(r.row, 'lead', i === 0);
      let aw = '';
      if (e.p.hasLongestRoad) aw += icon('road', 16, 'aw');
      if (e.p.hasLargestArmy) aw += icon('knight', 16, 'aw');
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

  /* -------------------------------------------------------------- refresh */
  let regions = regionReport(state);
  let obKey = '';

  function refreshRegions() {
    regions = regionReport(state);
    for (const r of RES) {
      const s = resSlots[r];
      const rr = regions[r];
      const dry = rr.live === 0;
      const f = dry ? rr.recovery : rr.live / Math.max(1, rr.total);
      if (Math.abs(f - s.lastF) > 0.01) {
        s.lastF = f;
        setVar(s.live.firstChild, 'width', (f * 100).toFixed(1) + '%');
      }
      toggle(s.node, 'dry', dry);
    }
  }

  function refreshObjective() {
    const g = guide.read({ regions, buildHidden: buildRow.classList.contains('hid') });
    const ico = RES.indexOf(g.ico) >= 0 ? resIcon(g.ico) : g.ico;
    setText(obLead, g.lead);
    setText(obTail, g.tail || '');
    if (g.key !== obKey) {
      obKey = g.key;
      obIco.innerHTML = icon(ico, 20);
      toggle(objective, 'go', g.tone === 'go');
      toggle(objective, 'wait', g.tone === 'wait');
      replay(objective, 'turn', 420);
    }
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
    const vp = scoreOf(state, me);
    setText(vpNum, vp);
    for (let i = 0; i < vpCells.length; i++) toggle(vpCells[i], 'on', i < vp);
    refreshRanks();
    setBadge(btnBuild, buildBar.refresh());
    setBadge(btnCards, me.cards.length);
    if (force) { refreshRegions(); refreshPrompt(); refreshObjective(); }
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
    if (promptT >= 0.2) {
      promptT = 0;
      refreshRegions(); refreshPrompt(); refreshObjective();
    }

    timeT += d;
    if (timeT >= 0.25) { timeT = 0; setText(timerTxt, fmtTime(state.time)); }

    for (let i = liveToasts.length - 1; i >= 0; i--) {
      const t = liveToasts[i];
      t.t += d;
      if (t.t > 2.5 && !t.out) { t.out = true; toggle(t.node, 'out', true); }
      if (t.t > 3.1) {
        if (t.node.parentNode) t.node.parentNode.removeChild(t.node);
        liveToasts.splice(i, 1);
      }
    }

    if (annT > 0) { annT -= d; if (annT <= 0) toggle(annWrap, 'show', false); }

    tradeCue.update(d);
    knightCue.update(d);
  }

  function onPlayBegan() {
    toggle(hud, 'pre', false);
    replay(hud, 'enter', 900);
    refreshAll(true);
    announce('Settle the Island', me.color.css);
  }

  setSound(true);
  refreshAll(true);
  if (state.phase === 'play') toggle(hud, 'pre', false);

  return {
    update, toast, announce, pulseResource, flashCost, requestBuild, onPlayBegan,
    get root() { return hud; },
    openSettings: () => toggleSettings(true),
    get knightCue() { return knightCue; },
    destroy() {
      tradeCue.destroy();
      knightCue.destroy();
      if (hud.parentNode) hud.parentNode.removeChild(hud);
    }
  };
}

export default createHUD;
