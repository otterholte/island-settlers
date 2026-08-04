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
  /* The match genuinely stops while this sheet is up — main.js holds the clock,
     the bots, the gathering and the settler on any open in-play sheet, so a
     rival cannot Knight the player out of half their pack mid-exchange. Said
     out loud, because a safety the player cannot see is a safety they still
     have to hurry against. */
  const paused = el('span', { class: 'tr-paused' },
    el('i'), el('span', { text: 'Match paused' }));
  const closeBtn = button('cbtn small ghost x', {
    'aria-label': 'Close', on: { click: () => requestClose() }
  }, el('span', { class: 'cb-ico', html: icon('close', 18) }));

  const row = el('div', { class: 'tr-row' });
  const cells = {};

  /*
   * TAPPING FAST HAS TO COUNT.
   *
   *   "Can you make it so I can press the up and down arrows in a much quicker
   *    succession inside of the trading post — since I'm typically going and
   *    clicking so quickly, but right now it's not registering."
   *
   * The arrows ran on `click`, and `click` is the slowest and most cancellable
   * event a touch screen produces. It is synthesised after the finger leaves,
   * it is withheld while the browser decides whether a fast second tap was a
   * gesture, and — the one that actually bit here — it is DROPPED if anything
   * disables the button between the finger landing and lifting. `sync()` runs
   * on every stage and again on panels.js's 5Hz refresh, and it was writing
   * `disabled` unconditionally on all ten arrows every time, so a press could
   * be voided by a repaint that changed nothing.
   *
   * So a press is a POINTERDOWN now: it fires the instant the finger lands,
   * before any of that can happen to it. Holding repeats — 320ms, then every
   * 90ms — because staging eight lots should not be eight taps. `click` is
   * still wired for the keyboard (Enter on a focused arrow), and ignores
   * itself for 700ms after a pointer press so one tap is never counted twice.
   */
  const HOLD_FIRST = 320;
  const HOLD_EVERY = 90;

  function pressable(btn, fire) {
    let delay = 0, tick = 0, lastPointer = 0;
    const stop = () => {
      if (delay) { clearTimeout(delay); delay = 0; }
      if (tick) { clearInterval(tick); tick = 0; }
    };
    btn.addEventListener('pointerdown', ev => {
      if (ev.button > 0 || btn.disabled) return;
      lastPointer = Date.now();
      // The press itself, immediately — nothing downstream can take it back.
      fire();
      stop();
      delay = setTimeout(() => {
        tick = setInterval(() => {
          // A repeat stops the moment the arrow can no longer legally move,
          // so holding never queues up presses against a dead control.
          if (btn.disabled) { stop(); return; }
          fire();
        }, HOLD_EVERY);
      }, HOLD_FIRST);
      /* Capture, so lifting off the edge of a 38px plate still ends the hold —
         and so a slide off the arrow does not become a drag on the island. */
      try { btn.setPointerCapture(ev.pointerId); } catch (e) { /* older Safari */ }
      ev.preventDefault();
    });
    for (const t of ['pointerup', 'pointercancel', 'pointerleave', 'lostpointercapture']) {
      btn.addEventListener(t, stop);
    }
    btn.addEventListener('click', () => {
      // Keyboard only. A pointer press has already been counted.
      if (Date.now() - lastPointer < 700) return;
      fire();
    });
  }

  RES.forEach((r, i) => {
    const upN = el('em', { class: 'tr-badge', text: '' });
    const dnN = el('em', { class: 'tr-badge', text: '' });

    const up = el('button', {
      class: 'tr-arr up', type: 'button', 'data-ui': '',
      'aria-label': `Give ${RES_LABEL[r]}`
    }, upN);
    pressable(up, () => { focus = i; step(r, 1); });

    const dn = el('button', {
      class: 'tr-arr dn', type: 'button', 'data-ui': '',
      'aria-label': `Receive ${RES_LABEL[r]}`
    }, dnN);
    pressable(dn, () => { focus = i; step(r, -1); });

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

  /* THE TWO LANES, AND THE ONLY LIVE LINE LEFT ON THE SHEET.
   *
   *   "Can you make the YOU GIVE and YOU RECEIVE sections larger as well and
   *    more clearly marked — maybe with larger text and colored areas above and
   *    below. You can remove the arrow directions and all of that text on the
   *    bottom left side."
   *
   * They were two 8.5px grey captions, which is the same weight as a footnote
   * for the one fact that makes the whole sheet legible: up is what you hand
   * over, down is what you take. They are bands now — brown above, green below,
   * the colours the staged badges already use — and the foot's block of prose
   * and arrow-key legend is gone with them.
   *
   * Nothing was lost by deleting it. Of the five lines that block could show,
   * three were saying what the bands now say in colour and one was restating
   * the badges. The fifth — you have staged more to give than to take — is the
   * only one that ever told a player something they could act on, so it rides
   * in the band it applies to, where they are already looking. */
  const giveLive = el('i', { class: 'tc-live', text: '' });
  const getLive = el('i', { class: 'tc-live', text: '' });
  const capGive = el('span', { class: 'tr-cap give' },
    el('b', { text: 'You give' }), giveLive);
  const capGet = el('span', { class: 'tr-cap get' },
    el('b', { text: 'You receive' }), getLive);
  const tradeBtn = button('big green off', {
    'aria-label': 'Confirm the trade', on: { click: () => confirm() }
  }, el('span', { class: 'sb-ico', html: icon('swap', 22) }),
     el('span', { class: 'sb-lab', text: 'Trade' }));

  const node = el('div', { class: 'sheet trade hid' },
    el('div', { class: 'sheet-head' },
      el('span', { class: 'sheet-title', text: 'Trade' }), where, paused, closeBtn),
    el('div', { class: 'trade-body' }, capGive, row, capGet),
    el('div', { class: 'sheet-foot' }, tradeBtn));

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
      // Write `disabled` ONLY when it changes. Rewriting it on every 5Hz sync
      // is what let a repaint cancel a press that was already under way.
      if (c.up.disabled !== !upOk) c.up.disabled = !upOk;
      if (c.dn.disabled !== !dnOk) c.dn.disabled = !dnOk;
      toggle(c.upN, 'on', give > 0);
      toggle(c.dnN, 'on', take > 0);
      toggle(c.up, 'staged', give > 0);
      toggle(c.dn, 'staged', take > 0);
    });

    setText(where, R.label || placeName());

    ready = R.ok && !short && tg >= 1 && tg === tt && state.phase === 'play';
    toggle(tradeBtn, 'off', !ready);
    if (tradeBtn.disabled !== undefined) tradeBtn.disabled = !ready;

    /* The backstop, in the lane it belongs to. The greying has already said
       what is possible and the bands say which way is which, so this is only
       ever the ONE thing standing between a staged deal and a legal one —
       blank the rest of the time, which is most of the time. */
    let giveSay = '', getSay = '';
    if (!R.ok) giveSay = R.reason || 'Head to a trading post';
    else if (short) giveSay = 'Not enough left';
    else if (tg > tt) getSay = `Take ${tg - tt} more`;
    setText(giveLive, giveSay);
    setText(getLive, getSay);
    toggle(capGive, 'say', !!giveSay);
    toggle(capGet, 'say', !!getSay);
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
