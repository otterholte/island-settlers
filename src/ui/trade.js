/**
 * Island Settlers — the maritime trade sheet.
 *
 *   createTradeSheet(state, game, { onClose }) ->
 *     { node, open(portId), sync(), key(code), close, get ready }
 *
 * ---------------------------------------------------------------------------
 * ONE ROW OF FIVE CARDS
 * ---------------------------------------------------------------------------
 * A maritime trade is one sentence — "four of these for one of those" — so the
 * sheet is one row. Each resource gets a single card carrying the three facts
 * that decide the deal: what it is, how many you hold, and what this post
 * charges for it. An arrow sits above the card (push it up into YOU GIVE) and
 * another below it (pull it down into YOU RECEIVE).
 *
 * The whole staging model is ONE SIGNED NUMBER PER RESOURCE:
 *
 *      stage[r] > 0   you are giving stage[r] lots of r, each costing ratio[r]
 *      stage[r] < 0   you are taking -stage[r] cards of r
 *      stage[r] = 0   it is sitting in the middle, untouched
 *
 * Up is +1 and Down is -1, always. That single axis is what makes the sheet
 * quick: the same key both stages and un-stages, a resource can never be on
 * both sides of the same deal (so no exchange is ever illegal by construction),
 * and there is no mode to be in.
 *
 * ---------------------------------------------------------------------------
 * NOTHING IMPOSSIBLE IS EVER OFFERED
 * ---------------------------------------------------------------------------
 * An arrow greys out the instant it would stage something that cannot happen:
 *
 *   up    needs ratio[r] more of r in the pack than you have already promised.
 *         Two brick at 4:1 — the brick card's up arrow is dead, and the 4:1 in
 *         its corner next to the 2 you hold says why without a sentence.
 *   down  needs an unmatched lot on the give side to pay for it. Before you
 *         have staged anything to give, every down arrow is dead.
 *
 * So the reason line under the row is only ever a backstop; the greying is the
 * primary signal and it is visible from across the room.
 *
 *   left / right   move between cards
 *   up / down      stage into give / receive (and back out again)
 *   Enter          do the deal — the sheet stays open for the next one
 *   Escape         close. So does the X, and a tap outside.
 *
 * Every keyboard route has a pointer equivalent: both arrows are real buttons
 * and the card itself takes focus on tap.
 *
 * Owner: UI agent.
 */

import { RES, RES_LABEL, TRADE_BASE } from '../core/constants.js';
import { activeTradeRatio, doTrade } from '../core/rules.js';
import { ports } from '../board/layout.js';
import { el, button, toggle, setText } from './dom.js';
import { icon, resIcon } from './icons.js';

/* Resource art on a card. Never under 20px (see the mobile constraints); the
   short-viewport rule in ui.css scales the same SVG down to 26. */
const ICON_PX = 32;

export function createTradeSheet(state, game, opts = {}) {
  const me = state.players[0];
  const requestClose = opts.onClose || (() => {});

  /** Signed staging, one entry per resource. See the header. */
  const stage = {};
  for (const r of RES) stage[r] = 0;

  let portId = null;
  let focus = 0;
  let ready = false;

  /* ---------------------------------------------------------------- markup */

  const where = el('span', { class: 'tr-where', text: 'Great Market' });
  const closeBtn = button('cbtn small ghost x', {
    'aria-label': 'Close', on: { click: () => requestClose() }
  }, el('span', { class: 'cb-ico', html: icon('close', 18) }));

  const row = el('div', { class: 'tr-row' });
  const cells = {};

  RES.forEach((r, i) => {
    const upN = el('em', { class: 'tr-badge', text: '' });
    const dnN = el('em', { class: 'tr-badge', text: '' });

    const up = el('button', {
      class: 'tr-arr up', type: 'button', 'data-ui': '',
      'aria-label': `Give ${RES_LABEL[r]}`,
      on: { click: () => { focus = i; step(r, 1); } }
    }, upN);

    const dn = el('button', {
      class: 'tr-arr dn', type: 'button', 'data-ui': '',
      'aria-label': `Receive ${RES_LABEL[r]}`,
      on: { click: () => { focus = i; step(r, -1); } }
    }, dnN);

    const rate = el('span', { class: 'tr-rate', text: '4:1' });
    const have = el('b', { class: 'tr-have', text: '0' });

    const card = el('button', {
      class: 'tr-card', type: 'button', 'data-ui': '', 'data-res': r,
      'aria-label': RES_LABEL[r],
      on: { click: () => { focus = i; sync(); ping('pick'); } }
    }, rate, el('span', { class: 'tr-ico', html: icon(resIcon(r), ICON_PX) }), have);

    const col = el('div', { class: 'tr-col', 'data-res': r }, up, card, dn);
    cells[r] = { col, up, dn, upN, dnN, rate, have, card };
    row.appendChild(col);
  });

  const why = el('span', { class: 'why', text: '' });
  const keys = el('span', { class: 'kbhint' });
  const tradeBtn = button('big green off', {
    'aria-label': 'Confirm the trade', on: { click: () => confirm() }
  }, el('span', { class: 'sb-ico', html: icon('swap', 22) }),
     el('span', { class: 'sb-lab', text: 'Trade' }));

  const node = el('div', { class: 'sheet trade hid' },
    el('div', { class: 'sheet-head' },
      el('span', { class: 'sheet-title', text: 'Trade' }), where, closeBtn),
    el('div', { class: 'trade-body' },
      el('span', { class: 'tr-cap give', text: 'You give' }),
      row,
      el('span', { class: 'tr-cap get', text: 'You receive' })),
    el('div', { class: 'sheet-foot' },
      el('div', { class: 'tfoot' }, why, keys), tradeBtn));

  keys.innerHTML = '<i>&#9664;&#9654;</i>pick <i>&#9650;</i>give '
    + '<i>&#9660;</i>receive <i>Enter</i>trade';

  /* ----------------------------------------------------------------- rates */

  /** What this post charges for giving away `r`, ignoring where the settler is. */
  function rateFor(r) {
    if (portId === null) return TRADE_BASE;
    return activeTradeRatio(state, 0, r, portId) || TRADE_BASE;
  }

  /**
   * The five live rates plus whether trading is possible at all.
   * economy.js owns the "you must be standing at the post" rule, so we defer
   * to it whenever it is attached; a bare UI harness falls back to the ratio
   * the sheet opened with.
   */
  function rates() {
    const out = { ok: true, label: null, reason: '', ratio: {} };
    const eco = game && game.economy;
    if (eco && typeof eco.quote === 'function') {
      for (const r of RES) {
        let q = null;
        try { q = eco.quote(r); } catch (e) { q = null; }
        if (!q) { out.ratio[r] = rateFor(r); continue; }
        out.ratio[r] = q.ok ? (q.ratio || rateFor(r)) : rateFor(r);
        if (!out.label && q.label) out.label = q.label;
        if (!q.ok) { out.ok = false; out.reason = q.reason || ''; }
      }
      return out;
    }
    for (const r of RES) out.ratio[r] = rateFor(r);
    return out;
  }

  /* --------------------------------------------------------------- staging */

  const lotsGiven = r => Math.max(0, stage[r]);
  const cardsTaken = r => Math.max(0, -stage[r]);
  const totalGive = () => RES.reduce((s, r) => s + lotsGiven(r), 0);
  const totalGet = () => RES.reduce((s, r) => s + cardsTaken(r), 0);

  /**
   * May this arrow move? `dir` is +1 for up (towards give) and -1 for down.
   * Coming back towards zero is always allowed — undo must never be blocked.
   */
  function canStep(r, dir, R) {
    if (!R.ok) return false;
    if (state.phase !== 'play') return false;
    if (dir > 0) {
      if (stage[r] < 0) return true;                    // un-stage a receive
      const ratio = R.ratio[r] || TRADE_BASE;
      return (me.res[r] | 0) >= ratio * (stage[r] + 1); // afford one more lot
    }
    if (stage[r] > 0) return true;                      // un-stage a give
    return totalGive() > totalGet();                    // something must pay
  }

  function step(r, dir) {
    const R = rates();
    if (!canStep(r, dir, R)) { ping('deny'); nudge(); return false; }
    stage[r] += dir;
    sync();
    ping('pick');
    return true;
  }

  function moveFocus(d) {
    focus = (focus + d + RES.length) % RES.length;
    sync();
    ping('pick');
  }

  function clearStage() {
    let any = false;
    for (const r of RES) { if (stage[r]) any = true; stage[r] = 0; }
    if (any) { sync(); ping('pick'); }
    return any;
  }

  const anythingStaged = () => RES.some(r => stage[r] !== 0);

  /* ------------------------------------------------------------------ view */

  function listSide(pick, label) {
    return RES.filter(pick).map(label).join(', ');
  }

  function sync() {
    const R = rates();
    const tg = totalGive(), tt = totalGet();
    let short = false;

    RES.forEach((r, i) => {
      const c = cells[r];
      const held = me.res[r] | 0;
      const ratio = R.ratio[r] || TRADE_BASE;
      const give = lotsGiven(r), take = cardsTaken(r);
      if (held < ratio * give) short = true;

      setText(c.have, held);
      setText(c.rate, `${ratio}:1`);
      setText(c.upN, give ? String(give * ratio) : '');
      setText(c.dnN, take ? String(take) : '');

      toggle(c.col, 'cur', i === focus);
      toggle(c.col, 'giving', give > 0);
      toggle(c.col, 'getting', take > 0);
      toggle(c.col, 'broke', R.ok && held < ratio && give === 0);

      const upOk = canStep(r, 1, R);
      const dnOk = canStep(r, -1, R);
      toggle(c.up, 'off', !upOk);
      toggle(c.dn, 'off', !dnOk);
      c.up.disabled = !upOk;
      c.dn.disabled = !dnOk;
      toggle(c.upN, 'on', give > 0);
      toggle(c.dnN, 'on', take > 0);
      toggle(c.up, 'staged', give > 0);
      toggle(c.dn, 'staged', take > 0);
    });

    setText(where, R.label || placeName());

    ready = R.ok && !short && tg >= 1 && tg === tt && state.phase === 'play';
    toggle(tradeBtn, 'off', !ready);
    if (tradeBtn.disabled !== undefined) tradeBtn.disabled = !ready;

    /* The backstop line. The greying has already said what is possible; this
       only ever names the deal, or the one thing standing in its way. */
    let line;
    if (!R.ok) {
      line = R.reason || 'Head to a trading post';
    } else if (!tg && !tt) {
      line = 'Up to give, down to receive';
    } else if (short) {
      line = 'You no longer hold enough for that';
    } else if (tg > tt) {
      const n = tg - tt;
      line = `Take ${n} more — press down on what you need`;
    } else {
      const g = listSide(r => lotsGiven(r) > 0,
        r => `${lotsGiven(r) * (R.ratio[r] || TRADE_BASE)} ${RES_LABEL[r]}`);
      const t = listSide(r => cardsTaken(r) > 0,
        r => `${cardsTaken(r)} ${RES_LABEL[r]}`);
      line = `Give ${g} for ${t}`;
    }
    setText(why, line);
  }

  function placeName() {
    const port = portId === null ? null : ports[portId];
    if (!port) return 'Great Market';
    return port.resource ? `${RES_LABEL[port.resource]} Dock` : 'Trading Dock';
  }

  function ping(kind) {
    try {
      const a = game && game.audio;
      if (!a || !a.sfx) return;
      if (kind === 'deny') a.sfx('deny', { gain: 0.28 });
      else a.sfx('blip', { gain: 0.32 });
    } catch (e) { /* audio is optional */ }
  }

  function nudge() {
    row.classList.remove('nope');
    void row.offsetWidth;
    row.classList.add('nope');
  }

  /* --------------------------------------------------------------- confirm */

  /**
   * Pay every staged lot for every staged card, in order. Give and receive can
   * never name the same resource (the signed axis forbids it) so each pair is
   * always a legal exchange.
   *
   * The sheet deliberately stays open: standing at a post you usually want two
   * or three deals, and being thrown back out to the island after each one was
   * the slowest part of trading.
   */
  function confirm() {
    if (!ready) return false;
    const gives = [], gets = [];
    for (const r of RES) {
      for (let i = 0; i < lotsGiven(r); i++) gives.push(r);
      for (let i = 0; i < cardsTaken(r); i++) gets.push(r);
    }
    const n = Math.min(gives.length, gets.length);
    if (!n) return false;

    const eco = game && game.economy;
    let done = 0;
    for (let i = 0; i < n; i++) {
      let res;
      if (eco && typeof eco.trade === 'function') res = eco.trade(gives[i], gets[i]);
      else {
        const ratio = rateFor(gives[i]);
        res = doTrade(state, 0, gives[i], gets[i], ratio)
          ? { ok: true, ratio } : { ok: false, reason: 'That trade was refused' };
      }
      if (!res || !res.ok) {
        if (!done) {
          sync();
          if (res && res.reason) setText(why, res.reason);
          ping('deny');
          return false;
        }
        break;
      }
      done++;
    }

    if (!done) { sync(); return false; }
    if (!eco && game && game.toast) {
      game.toast(`Traded ${done} time${done > 1 ? 's' : ''}`, 'good');
    }
    for (const r of RES) stage[r] = 0;
    sync();
    node.classList.remove('done');
    void node.offsetWidth;
    node.classList.add('done');
    return true;
  }

  /* -------------------------------------------------------------- keyboard */

  /** Returns true when the key belonged to this sheet. */
  function key(code) {
    switch (code) {
      case 'ArrowLeft': moveFocus(-1); return true;
      case 'ArrowRight': moveFocus(1); return true;
      case 'ArrowUp': step(RES[focus], 1); return true;
      case 'ArrowDown': step(RES[focus], -1); return true;
      case 'Tab': clearStage(); return true;
      case 'Escape': requestClose(); return true;
      case 'Enter':
      case 'NumpadEnter':
        // Enter both finishes and leaves: it does the deal when there is one,
        // and closes the sheet when the row is untouched.
        if (ready) confirm();
        else if (!anythingStaged()) requestClose();
        else nudge();
        return true;
      default: return false;
    }
  }

  /* ------------------------------------------------------------------ open */

  /**
   * Open on the card the player most likely walked here to spend: the cheapest
   * rate they can actually pay, richest pile first. At the Great Market every
   * rate is 4:1 so that is simply the biggest pile; at a specialised dock it is
   * the resource the dock is FOR, which is the whole reason for the journey.
   */
  function open(id) {
    portId = (id === undefined || id === null) ? null : id;
    if (portId !== null && !me.ports.has(portId)) portId = null;
    for (const r of RES) stage[r] = 0;

    const R = rates();
    let best = 0, bestKey = null;
    RES.forEach((r, i) => {
      const held = me.res[r] | 0;
      const ratio = R.ratio[r] || TRADE_BASE;
      const k = [held >= ratio ? 0 : 1, ratio, -held];
      if (!bestKey || k[0] < bestKey[0]
        || (k[0] === bestKey[0] && k[1] < bestKey[1])
        || (k[0] === bestKey[0] && k[1] === bestKey[1] && k[2] < bestKey[2])) {
        bestKey = k; best = i;
      }
    });
    focus = best;
    node.classList.remove('done');
    sync();
  }

  sync();

  return {
    node, open, sync, key,
    get ready() { return ready; },
    get portId() { return portId; },
    clearStage
  };
}

export default createTradeSheet;
