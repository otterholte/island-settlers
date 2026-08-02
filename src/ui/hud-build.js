/**
 * Island Settlers — the four build cards.
 *
 *   createBuildBar(state, game, { onBuy }) ->
 *     { node, refresh(), flash(kind), ready }
 *
 * Each card is a live progress meter, not a price tag. It fills from the
 * bottom as `min(have/need)` climbs, shows every required resource as
 * have / need — GREEN-boxed where the pack already covers it, RED-boxed where
 * it does not, every one of them — and snaps to an unmistakable gold
 * "affordable now" state the moment it is buyable.
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

      /*
       * EVERY chip reports its own state, not just the worst one.
       *
       *   "I only see one red box around the resource I need ... instead of
       *    seeing the red box around all of the resources I need. ... Can you
       *    make there also be a green box around the resources I have enough."
       *
       * This used to paint `.block` on `pr.blocking` alone — the single
       * resource with the worst ratio — so a settlement with an empty pack put
       * a red box on one of four missing goods and left the other three
       * indistinguishable from goods already banked. Two classes now, applied
       * per chip: `miss` on anything short, `met` on anything covered. Reading
       * the price is reading the colours, with nothing left to infer.
       */
      for (const part of pr.parts) {
        const chip = c.chips[part.res];
        if (!chip) continue;
        /*
         * The `have` half of the fraction is CAPPED AT THE NEED.
         *
         * It is progress toward one purchase, not a bank statement — the
         * resource pill across the top of the screen is the bank statement, and
         * it is the most-read thing in the game. Once a part is covered, `4/4`
         * says the true thing ("this part is paid") and the chip is already
         * green; `12/4` says the same thing in two digits.
         *
         * Which matters because every cost is 1..4, so capping here makes the
         * numerator PERMANENTLY one digit. The number column then never widens,
         * and SETTLEMENT's four chips and CARD's three can never wrap an extra
         * line — which is what was intermittently pushing the cost strip off the
         * bottom of the viewport at both shipping sizes, depending only on
         * whether the player happened to be holding ten of something.
         */
        setText(chip.have, Math.min(part.have, part.need));
        toggle(chip.node, 'met', part.met);
        toggle(chip.node, 'miss', !part.met);
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
