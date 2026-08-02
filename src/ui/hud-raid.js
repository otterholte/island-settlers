/**
 * Island Settlers — THE RAID. What a Knight actually takes, said out loud.
 *
 *   createRaidCue(root, state, game) -> { show(ev), update(dt), destroy() }
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * The player asked a question that should never have needed asking:
 *
 *   "I also want to know what happens with the robber. Does somebody actually
 *    lose resources at any point that they've already collected, like when
 *    someone rolls a seven in the real Catan game? Can you explain if that's
 *    part of the game right now, and if so how it works?"
 *
 * It very much is. `rules.playKnight` takes HALF of every resource type, rounded
 * up, off EVERY rival at once — which, because the round-up lands on each of
 * the five types separately, is nearer 57% of a full stockpile. It is not a
 * Catan-style steal-one-card: nothing is transferred, it is destroyed. There is
 * no eight-card threshold, no dice, and no other mechanic anywhere in the game
 * that takes back a resource you have already banked.
 *
 * And the game never mentioned it. `playKnight` emits a complete per-player
 * breakdown —
 *
 *     emit(state, 'knight', { player: pid, tile: targetTile, losses });
 *
 * — where `losses` is `[{ player, lost: {wood, brick, wool, wheat, ore}, total }]`,
 * and NOTHING IN THE CODEBASE HAS EVER READ IT. When a bot Knighted the human
 * out of well over half their goods, the entire feedback was a horn, a
 * shockwave on a hex somewhere, and five counters quietly going down. It is not
 * surprising the mechanic read as "I don't know if this game even does that".
 *
 * This module is that payload, on screen, at the size the event deserves: the
 * card lands hard, names who did it, spells out the loss resource by resource,
 * gives the total, and says which hex the Knight has just shut down. It is
 * SHORT — a couple of seconds, see `HOLD_LOSS` — because it is five numbers and
 * a total, not a paragraph, and the thing it is explaining (the counters at the
 * top of the screen) stays changed long after the card has gone.
 *
 * The mirror case is here too, and is deliberately quieter: when the HUMAN
 * plays the Knight, the same card reports what the three rivals dropped. Same
 * data, same layout, opposite sign.
 *
 * Nothing here touches the match. It is a read-only view of one event.
 *
 * Owner: UI agent.
 */

import { RES, RES_LABEL } from '../core/constants.js';
import { el, toggle, setText } from './dom.js';
import { icon, resIcon } from './icons.js';
import { regionName } from './hud-knight.js';

const STYLE_ID = 'hud-raid-style';

/* Seconds the card stays up before it starts to leave, and how long the fade
   itself takes.

   The first cut of this held the loss for 4.6s on the theory that a raid this
   large deserved to be read twice. In play that is a long time to be looking at
   a card instead of the island — "can you not show the knight popup screen when
   you were raided for as long" — and the numbers are five chips and a total, not
   a paragraph. Down to 2.4s, and the fade tightened with it. The information is
   still there for anyone who wants it: the resource counters it explains are
   permanent, and the toast it fires alongside outlives the card. */
const HOLD_LOSS = 2.4;
const HOLD_GAIN = 1.9;
const FADE = 0.38;

const CSS = `
.raid{
  position:absolute;left:0;right:0;top:26%;
  display:flex;justify-content:center;pointer-events:none;
  opacity:0;
}
.raid.hid{display:none}
.raid.in .raid-card{animation:raidIn .62s cubic-bezier(.16,1.3,.36,1) both}
.raid.in{opacity:1}
.raid.out{opacity:0;transition:opacity .38s ease}

.raid-card{
  position:relative;min-width:min(88vw,430px);max-width:min(92vw,520px);
  padding:15px 22px 17px;border-radius:18px;text-align:center;
  background:linear-gradient(180deg,rgba(38,12,10,.96),rgba(16,6,8,.97));
  border:2.5px solid var(--rc,#d0472f);
  box-shadow:0 10px 0 rgba(0,0,0,.45),0 18px 46px rgba(0,0,0,.6),
             inset 0 2px 0 rgba(255,255,255,.14),0 0 34px var(--rg,rgba(208,71,47,.5));
}
.raid.good .raid-card{
  background:linear-gradient(180deg,rgba(28,26,10,.96),rgba(12,12,6,.97));
}

.raid-hd{display:flex;align-items:center;justify-content:center;gap:10px}
.raid-hd .ico{line-height:0;filter:drop-shadow(0 2px 4px rgba(0,0,0,.7))}
.raid-ttl{
  font:800 34px/1 var(--ff);letter-spacing:.10em;text-transform:uppercase;
  color:var(--rc,#ff8a6a);
  -webkit-text-stroke:2px rgba(12,6,6,.9);paint-order:stroke fill;
  text-shadow:0 3px 0 rgba(10,4,4,.6),0 6px 20px rgba(0,0,0,.7);
}
.raid-who{
  margin-top:7px;font:800 12.5px/1.25 var(--ff);letter-spacing:.10em;
  text-transform:uppercase;color:rgba(255,232,222,.86);
}
.raid-who b{color:var(--wc,#fff);font-weight:800}

/* The bill. One chip per resource actually taken, so a raid on a full pack
   reads as five and a raid on a bare one reads as one. */
.raid-bill{
  display:flex;flex-wrap:wrap;align-items:center;justify-content:center;
  gap:8px;margin:12px 0 4px;
}
.raid-chip{
  display:inline-flex;align-items:center;gap:6px;
  padding:6px 11px 7px;border-radius:11px;
  background:rgba(0,0,0,.42);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.12),inset 0 0 0 1.5px rgba(255,255,255,.10);
}
.raid-chip svg{width:26px;height:26px;display:block}
.raid-chip b{font:800 21px/1 var(--ff);color:#ffd8cc;
  -webkit-text-stroke:1.5px rgba(12,6,6,.85);paint-order:stroke fill}
.raid.good .raid-chip b{color:#ffe79a}
.raid-none{font:800 13px/1 var(--ff);letter-spacing:.09em;text-transform:uppercase;
  color:rgba(255,232,222,.66)}

.raid-total{
  margin-top:9px;display:inline-flex;align-items:baseline;gap:8px;
  padding:5px 15px 7px;border-radius:11px;
  background:linear-gradient(180deg,rgba(208,71,47,.34),rgba(208,71,47,.12));
  box-shadow:inset 0 0 0 1.5px rgba(255,138,106,.44);
}
.raid.good .raid-total{
  background:linear-gradient(180deg,rgba(255,201,60,.30),rgba(255,201,60,.10));
  box-shadow:inset 0 0 0 1.5px rgba(255,201,60,.5);
}
.raid-total b{font:800 26px/1 var(--ff);color:#ff9c7e;
  -webkit-text-stroke:1.6px rgba(12,6,6,.85);paint-order:stroke fill}
.raid.good .raid-total b{color:var(--gold-l,#ffe79a)}
.raid-total span{font:800 10px/1 var(--ff);letter-spacing:.15em;
  text-transform:uppercase;color:rgba(255,232,222,.72)}

.raid-foot{
  margin-top:11px;padding-top:9px;border-top:1px solid rgba(255,255,255,.13);
  font:800 10.5px/1.35 var(--ff);letter-spacing:.09em;text-transform:uppercase;
  color:rgba(255,232,222,.62);
}

@keyframes raidIn{
  0%{opacity:0;transform:scale(.62) rotate(-3deg)}
  46%{opacity:1;transform:scale(1.10) rotate(1.2deg)}
  64%{transform:scale(.97) rotate(-.8deg)}
  80%{transform:scale(1.03) rotate(.4deg)}
  100%{transform:scale(1) rotate(0)}
}

@media (max-height:400px),(max-width:760px){
  .raid{top:20%}
  .raid-card{padding:11px 16px 13px;border-radius:15px;min-width:min(90vw,340px)}
  .raid-ttl{font-size:25px;letter-spacing:.08em}
  .raid-who{font-size:11px;margin-top:5px}
  .raid-bill{gap:6px;margin:9px 0 3px}
  .raid-chip{padding:4px 8px 5px;gap:5px}
  .raid-chip svg{width:22px;height:22px}
  .raid-chip b{font-size:18px}
  .raid-total{margin-top:7px;padding:4px 12px 6px}
  .raid-total b{font-size:22px}
  .raid-foot{margin-top:8px;padding-top:7px;font-size:9.5px}
}
`;

function injectStyle(doc) {
  if (!doc || !doc.head || !doc.createElement) return;
  if (doc.getElementById && doc.getElementById(STYLE_ID)) return;
  const s = doc.createElement('style');
  s.id = STYLE_ID;
  s.textContent = CSS;
  doc.head.appendChild(s);
}

const NOOP = () => {};
const stub = () => ({ show: NOOP, update: NOOP, destroy: NOOP, get open() { return false; } });

export function createRaidCue(root, state, game) {
  const doc = (root && root.ownerDocument)
    || (typeof document !== 'undefined' ? document : null);
  if (!doc || !doc.createElement || !root || !root.appendChild) return stub();

  let wrap, ttl, who, bill, totalNum, totalLab, foot, headIco;
  try {
    injectStyle(doc);
    headIco = el('span', { class: 'ico', html: icon('knight', 40) });
    ttl = el('div', { class: 'raid-ttl', text: 'Knight' });
    who = el('div', { class: 'raid-who' });
    bill = el('div', { class: 'raid-bill' });
    totalNum = el('b', { text: '0' });
    totalLab = el('span', { text: 'goods lost' });
    foot = el('div', { class: 'raid-foot' });
    wrap = el('div', { class: 'raid hid' },
      el('div', { class: 'raid-card' },
        el('div', { class: 'raid-hd' }, headIco, ttl),
        who, bill,
        el('div', { class: 'raid-total' }, totalNum, totalLab),
        foot));
    root.appendChild(wrap);
  } catch (e) {
    if (wrap && wrap.parentNode) wrap.parentNode.removeChild(wrap);
    return stub();
  }

  let t = 0;            // seconds the card has been up
  let hold = 0;         // how long this one holds before fading
  let live = false;

  const safe = fn => { try { return fn(); } catch (e) { return undefined; } };

  /** One `icon + −N` chip per resource that actually moved. */
  function fillBill(lost, sign) {
    bill.innerHTML = '';
    let any = 0;
    for (const r of RES) {
      const n = lost && lost[r] ? lost[r] | 0 : 0;
      if (n <= 0) continue;
      any++;
      bill.appendChild(el('span', {
        class: 'raid-chip', title: RES_LABEL[r] || r
      },
        el('span', { class: 'ico', html: icon(resIcon(r), 26) }),
        el('b', { text: `${sign}${n}` })));
    }
    if (!any) {
      bill.appendChild(el('span', { class: 'raid-none', text: 'Nothing to take' }));
    }
    return any;
  }

  function dress(ev) {
    const knight = state.players[ev.player];
    const mine = (ev.losses || []).find(l => l.player === 0);
    const stolenFromMe = ev.player !== 0;
    const colour = knight ? knight.color : null;

    toggle(wrap, 'good', !stolenFromMe);
    wrap.style.setProperty('--rc', stolenFromMe ? '#ff8a6a' : '#ffc93c');
    wrap.style.setProperty('--rg', stolenFromMe
      ? 'rgba(208,71,47,.55)' : 'rgba(255,201,60,.42)');
    wrap.style.setProperty('--wc', colour ? colour.light : '#fff');

    if (stolenFromMe) {
      /* Somebody Knighted YOU. This is the whole reason the module exists, so
         it says the rule as well as the number: half of everything, gone. */
      const total = mine ? mine.total | 0 : 0;
      setText(ttl, total > 0 ? 'Knight!' : 'Knight Sent');
      who.innerHTML = '';
      who.appendChild(el('b', { text: knight ? knight.name : 'A rival' }));
      who.appendChild(el('span', {
        text: total > 0
          ? ' played a Knight — half of everything you held is gone'
          : ' played a Knight — you had nothing to lose'
      }));
      fillBill(mine && mine.lost, '−');
      setText(totalNum, `−${total}`);
      setText(totalLab, total === 1 ? 'good lost' : 'goods lost');
      hold = HOLD_LOSS;
    } else {
      /* You played it. Same payload, read the other way round. */
      const all = ev.losses || [];
      const sum = {};
      let total = 0;
      for (const l of all) {
        total += l.total | 0;
        for (const r of RES) sum[r] = (sum[r] || 0) + (l.lost && l.lost[r] ? l.lost[r] | 0 : 0);
      }
      setText(ttl, 'Knight Sent');
      who.innerHTML = '';
      who.appendChild(el('span', { text: 'Your Knight takes half of everything from ' }));
      who.appendChild(el('b', { text: `all ${Math.max(1, all.length)} rivals` }));
      fillBill(sum, '−');
      setText(totalNum, `−${total}`);
      setText(totalLab, total === 1 ? 'good destroyed' : 'goods destroyed');
      hold = HOLD_GAIN;
    }

    setText(foot, `The Knight now shuts down ${regionName(ev.tile)} · nothing comes off it`);
  }

  /**
   * Put the card up for one `knight` event.
   *
   * Called straight from main.js's event pump, so it must never throw into the
   * frame loop: everything that could is wrapped.
   */
  function show(ev) {
    if (!ev) return;
    safe(() => dress(ev));
    t = 0;
    live = true;
    toggle(wrap, 'hid', false);
    toggle(wrap, 'out', false);
    // Re-trigger the entrance even if the card was already up: a second Knight
    // inside five seconds should land as a second hit, not extend the first.
    toggle(wrap, 'in', false);
    void wrap.offsetWidth;
    toggle(wrap, 'in', true);
  }

  function update(dt) {
    if (!live) return;
    t += Number.isFinite(dt) ? dt : 1 / 60;
    if (t >= hold && !wrap.classList.contains('out')) {
      toggle(wrap, 'in', false);
      toggle(wrap, 'out', true);
    }
    if (t >= hold + FADE) {
      live = false;
      toggle(wrap, 'out', false);
      toggle(wrap, 'hid', true);
    }
  }

  return {
    show, update,
    get open() { return live; },
    destroy() { if (wrap && wrap.parentNode) wrap.parentNode.removeChild(wrap); }
  };
}

export default createRaidCue;
