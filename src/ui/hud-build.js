/**
 * Island Settlers — the four build cards.
 *
 *   createBuildBar(state, game, { onBuy }) ->
 *     { node, refresh(), flash(kind), ready }
 *
 * Each card is a live progress meter, not a price tag. It fills from the
 * bottom as `min(have/need)` climbs, shows every required resource as
 * have / need, marks the one resource still holding the purchase up, and
 * snaps to an unmistakable gold "affordable now" state the moment it is
 * buyable.
 *
 * Owner: UI agent.
 */

import { RES, COST } from '../core/constants.js';
import { el, setText, toggle, replay, setVar } from './dom.js';
import { icon, resIcon } from './icons.js';
import { BUILD_KINDS, progressFor, pieceCapped, hasSomewhere } from './hud-guide.js';

/* Nothing in the interface may draw a resource object smaller than this. */
const COST_ICON_PX = 20;

export function createBuildBar(state, game, hooks = {}) {
  const me = state.players[0];
  const cards = {};
  const row = el('div', { class: 'build-row' });

  for (const b of BUILD_KINDS) {
    const costRow = el('span', { class: 'bc-cost' });
    const chips = {};
    for (const r of RES) {
      const n = COST[b.kind][r];
      if (!n) continue;
      const have = el('b', { text: '0' });
      const chip = el('i', { class: 'cc', 'data-res': r },
        el('span', { class: 'cc-ico', html: icon(resIcon(r), COST_ICON_PX) }),
        el('span', { class: 'ccn' }, have, el('em', { text: String(n) })));
      chips[r] = { node: chip, have, need: n };
      costRow.appendChild(chip);
    }

    const card = el('button', {
      class: 'bcard off', type: 'button', 'data-ui': '', 'data-kind': b.kind,
      'aria-label': b.label,
      on: { click: () => hooks.onBuy && hooks.onBuy(b.kind) }
    },
      el('span', { class: 'bc-fill' }),
      el('span', { class: 'bc-name', text: b.label }),
      el('span', { class: 'bc-row' },
        el('span', { class: 'bc-ico', html: icon(b.ico, 30) }),
        b.vp ? el('i', { class: 'bc-vp', text: '+' + b.vp }) : null),
      costRow,
      el('span', { class: 'bc-lip' })
    );

    cards[b.kind] = { def: b, node: card, chips, ok: null, p: -1 };
    row.appendChild(card);
  }

  /* ------------------------------------------------------------- refresh */
  let readyCount = 0;
  let chimeAt = -99;

  function refresh() {
    let ready = 0;
    const playing = state.phase === 'play';
    let becameReady = false;

    for (const b of BUILD_KINDS) {
      const c = cards[b.kind];
      const pr = progressFor(me.res, COST[b.kind]);
      const capped = pieceCapped(state, 0, b.kind);
      const where = pr.afford ? hasSomewhere(state, b.kind) : true;
      const ok = pr.afford && !capped && where && playing;
      if (ok) ready++;

      // The fill only ever reports affordability, never legality: a player
      // who is two wood short should watch it climb regardless.
      const p = Math.round(pr.p * 100) / 100;
      if (c.p !== p) { c.p = p; setVar(c.node, '--p', (p * 100).toFixed(1) + '%'); }

      if (c.ok !== ok) {
        if (ok && c.ok !== null) { replay(c.node, 'ready', 720); becameReady = true; }
        c.ok = ok;
        toggle(c.node, 'ok', ok);
        toggle(c.node, 'off', !ok);
      }
      toggle(c.node, 'cap', capped || (pr.afford && !where));

      for (const part of pr.parts) {
        const chip = c.chips[part.res];
        if (!chip) continue;
        setText(chip.have, part.have > 99 ? '99' : part.have);
        toggle(chip.node, 'met', part.met);
        toggle(chip.node, 'block', part.res === pr.blocking);
      }
    }

    // One short, quiet chime when something new becomes buildable — never a
    // stack of them, never more than twice in ten seconds.
    if (becameReady && playing && (state.time - chimeAt) > 5) {
      chimeAt = state.time;
      try { game.audio && game.audio.sfx && game.audio.sfx('blip', { gain: 0.55 }); } catch (e) { /* silent */ }
    }

    readyCount = ready;
    return ready;
  }

  /** Shake the card and flag every resource the player is short of. */
  function flash(kind) {
    const c = cards[kind];
    if (!c) return;
    replay(c.node, 'nope', 520);
    const pr = progressFor(me.res, COST[kind]);
    for (const part of pr.parts) {
      const chip = c.chips[part.res];
      if (chip) toggle(chip.node, 'short', !part.met);
    }
    setTimeout(() => {
      for (const r in c.chips) toggle(c.chips[r].node, 'short', false);
    }, 1400);
  }

  return {
    node: row,
    refresh,
    flash,
    cardFor: kind => (cards[kind] ? cards[kind].node : null),
    get ready() { return readyCount; }
  };
}

export default createBuildBar;
