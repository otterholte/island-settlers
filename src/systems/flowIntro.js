/**
 * Island Settlers — the opening screen.
 *
 *   buildIntro(state, onBegin) -> { node, cards, css }
 *
 * The first thing anyone sees. It is not a splash: the live 3D island keeps
 * drifting behind it, and the whole screen is two taps from the draft.
 *
 * Structure, top to bottom, so it fits a 375px-tall landscape phone:
 *   crest + title      ISLAND / SETTLERS, bevelled, sitting on the sea
 *   objective ribbon   FIRST TO 13 POINTS
 *   identity plate     one slim plate: your colour, your portrait, YOU
 *   difficulty picker  EASY / MEDIUM / HARD / EXPERT — how the rivals play
 *   two buttons        BEGIN THE DRAFT (green, primary) · TUTORIAL (cream)
 *   one line of help   how a turn actually works
 *
 * The three rival cards are gone on purpose — "have the home screen NOT show
 * the other players right now, just hide them". They are still in the match,
 * still named in the draft rail and the ranking; they simply do not introduce
 * themselves before anyone has asked. What is left is the player's own
 * identity, laid out horizontally so one plate reads as a deliberate badge
 * rather than as the survivor of a row of four.
 *
 * TUTORIAL raises a `mf-tutorial` CustomEvent on `document` rather than taking
 * a callback, so nothing between here and systems/tutorial.js has to grow a
 * parameter to carry it.
 *
 * The difficulty choice is written straight into `systems/difficulty.js`, which
 * `bots.js` re-reads on every planning tick, so no wiring is needed anywhere
 * else: pick a level here and the rivals are playing at it by the next frame.
 *
 * Owner: Flow agent (flow UI). Kept out of flowUI.js purely for file size.
 */

import { VICTORY_POINTS } from '../core/constants.js';
import { el, button } from '../ui/dom.js';
import { icon, avatar } from '../ui/icons.js';
import {
  DIFFICULTY_ORDER, LEVELS, getDifficulty, setDifficulty
} from './difficulty.js';

export const INTRO_CSS = `
/* --------------------------------------------------------- opening screen */
.mf-intro{
  position:absolute;inset:0;pointer-events:none;
  display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:clamp(4px,1.4vh,10px);
  padding:calc(8px + var(--sat,0px)) calc(10px + var(--sar,0px))
          calc(8px + var(--sab,0px)) calc(10px + var(--sal,0px));
  opacity:0;transition:opacity .5s ease;
}
.mf-intro.on{opacity:1}
/* Frame the island rather than paint over it: dark at the edges, clear in the
   middle band where the camera is drifting. */
.mf-intro::before{
  content:'';position:absolute;inset:0;pointer-events:none;
  background:
    radial-gradient(120% 88% at 50% 46%,rgba(6,26,50,.24) 0%,rgba(4,14,28,.86) 78%),
    linear-gradient(180deg,rgba(3,12,26,.78) 0%,rgba(3,12,26,0) 30%,
      rgba(3,12,26,0) 62%,rgba(3,12,26,.80) 100%);
}
.mf-intro>*{position:relative}

.mf-i-crest{
  display:flex;align-items:center;gap:clamp(8px,1.8vw,16px);
  font:800 clamp(12px,2.2vw,19px)/1 var(--ff);letter-spacing:.46em;text-indent:.46em;
  text-transform:uppercase;color:#fff;
  -webkit-text-stroke:2px #23150a;paint-order:stroke fill;
  text-shadow:0 3px 0 rgba(48,30,12,.9),0 6px 16px rgba(0,0,0,.75);
}
.mf-i-crest::before,.mf-i-crest::after{
  content:'';width:clamp(22px,6vw,64px);height:3px;border-radius:2px;
  background:linear-gradient(90deg,rgba(255,201,60,0),var(--gold,#ffc93c));
  box-shadow:0 1px 2px rgba(0,0,0,.7);
}
.mf-i-crest::after{background:linear-gradient(270deg,rgba(255,201,60,0),var(--gold,#ffc93c))}
.mf-i-title{
  margin:-4px 0 1px;
  font:800 clamp(34px,7.6vw,64px)/.92 var(--ff);letter-spacing:.055em;
  text-transform:uppercase;color:#ffd34e;
  -webkit-text-stroke:clamp(2px,.5vw,3.4px) #23150a;paint-order:stroke fill;
  text-shadow:
    0 3px 0 #b0730c, 0 5px 0 #8a5607, 0 7px 0 #5e3a05,
    0 12px 22px rgba(0,0,0,.7), 0 0 44px rgba(255,201,60,.45);
}
.mf-i-obj{
  display:inline-flex;align-items:center;gap:7px;padding:5px 20px 6px;border-radius:999px;
  background:linear-gradient(180deg,#2a68a8,#0d2440 74%);
  border:2px solid rgba(255,201,60,.7);
  font:800 clamp(9px,1.5vw,11.5px)/1 var(--ff);letter-spacing:.2em;text-transform:uppercase;
  color:var(--gold-l,#ffe79a);
  box-shadow:0 5px 0 rgba(4,14,28,.6),0 10px 20px rgba(0,0,0,.55),
             inset 0 2px 0 rgba(255,255,255,.22);
}
.mf-i-obj svg{filter:drop-shadow(0 1px 2px rgba(0,0,0,.6))}

/* -------------------------------------------------------------- identity
   One horizontal plate instead of four stacked cards. The colour band runs
   down its leading edge — the same "this is me" language the in-match identity
   chip uses — so the plate is legible as a badge on its own. */
.mf-i-row{display:flex;justify-content:center;margin-top:1px;max-width:96vw}
.mf-cmp{
  position:relative;overflow:hidden;
  display:flex;align-items:center;gap:clamp(7px,1.4vw,11px);
  min-height:44px;padding:5px clamp(13px,2.4vw,20px) 6px clamp(11px,2vw,16px);
  border-radius:14px;
  background:linear-gradient(180deg,#fdf5e2 0%,#f6e7c6 44%,#e2cfa6 100%);
  border:2px solid #4a2f16;
  box-shadow:0 5px 0 rgba(58,36,16,.62),0 12px 22px rgba(0,0,0,.5),
             inset 0 2px 0 rgba(255,255,255,.85);
  opacity:0;transform:translateY(14px) scale(.96);
  transition:opacity .34s ease,transform .34s cubic-bezier(.2,1.3,.35,1);
}
.mf-cmp.in{opacity:1;transform:none}
.mf-c-band{
  position:absolute;left:0;top:0;bottom:0;width:7px;
  background:linear-gradient(180deg,var(--cl,#7fb2f0),var(--c,#3b7fd4));
  box-shadow:inset -1px 0 0 rgba(0,0,0,.35);
}
.mf-c-av{line-height:0;flex:0 0 auto;margin-left:3px}
.mf-c-txt{display:flex;flex-direction:column;align-items:flex-start;gap:1px;min-width:0}
.mf-c-name{font:800 clamp(12px,2vw,15px)/1 var(--ff);letter-spacing:.16em;
  text-transform:uppercase;color:#2e1c06;text-shadow:0 1px 0 rgba(255,255,255,.7)}
.mf-c-desc{font:700 clamp(7.5px,1.15vw,9.5px)/1.25 var(--ff);letter-spacing:.09em;
  text-transform:uppercase;color:#7a5228;white-space:nowrap}
.mf-cmp.you{
  border-color:#c99413;
  box-shadow:0 5px 0 #9a6d08,0 12px 22px rgba(0,0,0,.5),
             0 0 22px rgba(255,201,60,.45),inset 0 2px 0 rgba(255,255,255,.9);
}

/* -------------------------------------------------------------- difficulty */
.mf-i-diff{
  display:flex;flex-direction:column;align-items:center;
  gap:clamp(2px,.7vh,5px);margin-top:clamp(1px,.6vh,4px);
}
.mf-i-dlab{
  display:inline-flex;align-items:center;gap:8px;
  font:800 clamp(8px,1.25vw,10px)/1 var(--ff);letter-spacing:.24em;text-indent:.24em;
  text-transform:uppercase;color:var(--gold-l,#ffe79a);
  text-shadow:0 1px 3px rgba(0,0,0,.85);
}
.mf-i-dlab::before,.mf-i-dlab::after{
  content:'';width:clamp(12px,3vw,30px);height:2px;border-radius:2px;
  background:linear-gradient(90deg,rgba(255,201,60,0),rgba(255,201,60,.75));
}
.mf-i-dlab::after{background:linear-gradient(270deg,rgba(255,201,60,0),rgba(255,201,60,.75))}
/* Four rungs, not three. They fit on one line at both shipping sizes — see the
   measurements against .btn.mf-diff below — but the row wraps and re-centres
   rather than overflowing if a narrower viewport ever turns up. */
.mf-i-drow{display:flex;flex-wrap:wrap;justify-content:center;
  gap:clamp(5px,1.2vw,10px)}

/* Sized for four across. At 960x444 that is 4x152 + 3x10 of gap = 638px inside
   a 940px content box; the floor of 102px keeps four on one line down to a
   ~440px-wide viewport before .mf-i-drow wraps them 2x2. */
.btn.mf-diff{
  flex-direction:column;gap:2px;
  min-height:48px;width:clamp(102px,19vw,152px);
  padding:6px 7px 9px;border-radius:13px;
  --f1:#fdf5e2;--f2:#f0dfb6;--f3:#dcc496;--lip:#8f7444;--fg:#4a2f16;
  filter:saturate(.9) brightness(.97);
}
.btn.mf-diff .mf-d-name{
  font:800 clamp(11px,1.85vw,14px)/1 var(--ff);letter-spacing:.16em;
  text-transform:uppercase;
}
.btn.mf-diff .mf-d-sub{
  font:700 clamp(6.6px,1.05vw,8.6px)/1.22 var(--ff);letter-spacing:.045em;
  text-transform:uppercase;color:#7a5228;text-align:center;white-space:normal;
  text-shadow:none;
}
.btn.mf-diff.on{
  --f1:#ffe79a;--f2:#ffc93c;--f3:#eaad20;--lip:#a8741a;--fg:#3a2208;
  filter:none;
  box-shadow:0 4px 0 var(--lip),0 8px 14px rgba(0,0,0,.42),
             0 0 20px rgba(255,201,60,.5),
             inset 0 2px 0 rgba(255,255,255,.7),inset 0 -6px 10px rgba(0,0,0,.16);
}
.btn.mf-diff.on .mf-d-sub{color:#6b4406}
.btn.mf-diff.on::after{
  content:'';position:absolute;left:50%;bottom:3px;transform:translateX(-50%);
  width:26px;height:3px;border-radius:2px;background:#6b4406;opacity:.75;
}

/* ------------------------------------------------------------- call to act
   THE GAP IS LOAD-BEARING. .mf-play carries a 7px hard under-lip and floats
   3px on its idle bounce, and neither is part of its layout box — with the old
   5px gap the lip painted straight across the help line underneath it ("the
   Begin draft is covering the text below it"). The floor here is 14px: 7 for
   the lip, 3 for the bounce, and 4 of actual air. Measured at 960x444 and
   667x375, button-bottom to hint-top, not eyeballed. */
.mf-i-foot{
  display:flex;flex-direction:column;align-items:center;
  gap:clamp(14px,3.4vh,20px);margin-top:clamp(4px,1.2vh,8px);
}
.mf-i-cta{display:flex;align-items:center;gap:clamp(9px,2vw,16px)}
.mf-play{
  position:relative;overflow:hidden;
  min-height:clamp(48px,12vh,58px);padding:0 clamp(22px,5vw,44px);
  font-size:clamp(14px,2.5vw,19px);letter-spacing:.15em;border-radius:18px;
  border-width:2.5px;
  --f1:#a6e58c;--f2:#4bab53;--f3:#2f8a3d;--lip:#1a5526;--fg:#0c2c13;
  box-shadow:0 7px 0 var(--lip),0 13px 24px rgba(0,0,0,.55),
             inset 0 3px 0 rgba(255,255,255,.62),inset 0 -8px 12px rgba(0,0,0,.2);
  animation:mfPlay 2.6s ease-in-out infinite;
}
.mf-play:active,.mf-play.press{
  transform:translateY(7px);animation:none;
  box-shadow:0 0 0 var(--lip),0 4px 8px rgba(0,0,0,.5),
             inset 0 3px 0 rgba(255,255,255,.5);
}
.mf-play::after{
  content:'';position:absolute;top:0;bottom:0;left:-60%;width:38%;
  background:linear-gradient(100deg,transparent,rgba(255,255,255,.5),transparent);
  animation:mfSheen 3.4s ease-in-out infinite;
}
@keyframes mfPlay{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}
@keyframes mfSheen{0%,62%{left:-60%}88%,100%{left:120%}}

/* The second route in. Same bevel, same outline, same press — cream instead of
   green and a size down, so it is unmistakably an option rather than the
   option. 48px tall at every size we ship. */
.mf-tut{
  min-height:clamp(48px,10.5vh,54px);padding:0 clamp(15px,3vw,26px);
  border-radius:16px;border-width:2.5px;
  flex-direction:column;gap:1px;
  --f1:#fbf3de;--f2:#f0dfb6;--f3:#dcc493;--lip:#8f7444;--fg:#3f2a12;
  box-shadow:0 6px 0 var(--lip),0 11px 20px rgba(0,0,0,.5),
             inset 0 3px 0 rgba(255,255,255,.7),inset 0 -7px 11px rgba(0,0,0,.16);
}
.mf-tut:active{transform:translateY(6px);
  box-shadow:0 0 0 var(--lip),0 4px 8px rgba(0,0,0,.45),
             inset 0 3px 0 rgba(255,255,255,.6)}
.mf-tut .mf-t-lab{font:800 clamp(12px,2.1vw,15px)/1 var(--ff);letter-spacing:.15em;
  text-transform:uppercase}
.mf-tut .mf-t-sub{font:700 clamp(6.6px,1.05vw,8.4px)/1.15 var(--ff);letter-spacing:.11em;
  text-transform:uppercase;color:#7a5228;text-shadow:none;white-space:nowrap}

.mf-i-hint{font:700 clamp(8px,1.3vw,10px)/1.3 var(--ff);letter-spacing:.14em;
  text-transform:uppercase;color:rgba(206,228,250,.72);text-align:center;
  text-shadow:0 1px 3px rgba(0,0,0,.8)}
.mf-i-hint b{color:var(--gold-l,#ffe79a)}

@media (max-height:400px){
  .mf-intro{gap:4px}
  /* Specificity on purpose: flowUI.js's own compact block still sizes the old
     four-card row, and this plate is not a card. */
  .mf-intro .mf-cmp{width:auto;min-height:42px;padding:4px 13px 5px 11px;gap:8px}
  .mf-intro .mf-c-desc{font-size:8px}
  .mf-c-av svg{width:28px;height:28px}
  .mf-play{min-height:48px}
  .mf-tut{min-height:48px}
  /* Still a 46px tap target at 667x375 — the guideline floor, not a whisker
     under it. The blurb is what gives, not the button. Four of these at 667
     wide come to 4x116.7 + 3x8 of gap = 491px inside a 647px content box. */
  .btn.mf-diff{min-height:46px;width:clamp(96px,17.5vw,124px);padding:4px 6px 5px}
  .btn.mf-diff .mf-d-sub{font-size:6.6px;line-height:1.15}
  .mf-i-diff{gap:2px}
  .mf-i-foot{gap:14px;margin-top:4px}
}
`;

/** Raised when TUTORIAL is pressed; systems/tutorial.js is listening. */
export const TUTORIAL_EVENT = 'mf-tutorial';

function askForTutorial() {
  if (typeof document === 'undefined' || !document.dispatchEvent) return;
  try {
    document.dispatchEvent(typeof CustomEvent === 'function'
      ? new CustomEvent(TUTORIAL_EVENT)
      : Object.assign(document.createEvent('Event'), { type: TUTORIAL_EVENT }));
  } catch (e) { /* a browser this old is not running the game anyway */ }
}

/** The whole opening screen as one detached node. */
export function buildIntro(state, onBegin) {
  // The rivals are deliberately absent. `cards` stays an array so flowUI.js's
  // staggered reveal keeps working without knowing how many there are.
  const me = state.players[0] || { color: { css: '#3b7fd4', light: '#7fb2f0' } };
  const cards = [
    el('div', {
      class: 'mf-cmp you',
      style: { '--c': me.color.css, '--cl': me.color.light }
    },
      el('span', { class: 'mf-c-band' }),
      el('span', { class: 'mf-c-av', html: avatar(me.color.css, me.color.light, 34) }),
      el('div', { class: 'mf-c-txt' },
        el('b', { class: 'mf-c-name', text: 'You' }),
        el('span', { class: 'mf-c-desc', text: 'Your island to claim' })))
  ];

  /* ----------------------------------------------------------- difficulty */
  // One chunky, obviously-tappable option per rung of DIFFICULTY_ORDER — four
  // of them — so adding or removing a level never needs an edit here. Each
  // button carries the level's label and its blurb, which says what the rivals
  // do rather than passing comment on whoever picked it. The choice goes
  // straight into difficulty.js; bots.js re-reads it every planning tick, and
  // it is what a replay re-applies, so there is nothing else to wire up.
  const diffButtons = DIFFICULTY_ORDER.map(key => {
    const level = LEVELS[key];
    const b = button('cream mf-diff', {
      'data-level': key,
      'aria-label': `${level.label} — ${level.blurb}`,
      on: { click: () => pick(key) }
    },
      el('b', { class: 'mf-d-name', text: level.label }),
      el('span', { class: 'mf-d-sub', text: level.blurb }));
    return b;
  });

  function paint() {
    const cur = getDifficulty();
    diffButtons.forEach(b => {
      const on = b.getAttribute('data-level') === cur;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function pick(key) {
    setDifficulty(key);
    paint();
  }

  paint();

  const difficulty = el('div', { class: 'mf-i-diff' },
    el('div', { class: 'mf-i-dlab', text: 'Rival Skill' }),
    el('div', { class: 'mf-i-drow' }, diffButtons));

  const playBtn = button('green huge mf-play', { on: { click: () => onBegin() } },
    el('span', { class: 'sb-lab', text: 'Begin the Draft' }));

  const tutBtn = button('cream mf-tut', {
    'aria-label': 'Tutorial — read the rules or take a guided practice run',
    on: { click: () => askForTutorial() }
  },
    el('b', { class: 'mf-t-lab', text: 'Tutorial' }),
    el('span', { class: 'mf-t-sub', text: 'New here? Start with this' }));

  const node = el('div', { class: 'mf-intro mf-hid' },
    el('div', { class: 'mf-i-crest', text: 'Island' }),
    el('div', { class: 'mf-i-title', text: 'Settlers' }),
    el('div', { class: 'mf-i-obj', html: icon('trophy', 15) },
      el('span', { text: `First to ${VICTORY_POINTS} Points` })),
    el('div', { class: 'mf-i-row' }, cards),
    difficulty,
    el('div', { class: 'mf-i-foot' },
      el('div', { class: 'mf-i-cta' }, playBtn, tutBtn),
      el('div', { class: 'mf-i-hint' },
        el('b', { text: 'Claim two corners' }),
        ' · gather from the land you touch · build roads, settlements and cities')));

  return { node, cards, playBtn, tutBtn, diffButtons, refreshDifficulty: paint };
}

export default buildIntro;
