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
 *   objective ribbon   FIRST TO 12 POINTS
 *   four settler cards colour, portrait, name, the strategy they play
 *   difficulty picker  EASY / MEDIUM / HARD — how good the rivals are
 *   the primary button BEGIN THE DRAFT — green, deep lip, real press
 *   one line of help   how a turn actually works
 *
 * The difficulty choice is written straight into `systems/difficulty.js`, which
 * `bots.js` re-reads on every planning tick, so no wiring is needed anywhere
 * else: pick a level here and the rivals are playing at it by the next frame.
 *
 * Owner: Flow agent (flow UI). Kept out of flowUI.js purely for file size.
 */

import { VICTORY_POINTS, BOT_PROFILES } from '../core/constants.js';
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

/* ------------------------------------------------------------ competitors */
.mf-i-row{display:flex;gap:clamp(5px,1.2vw,10px);margin-top:2px;max-width:96vw}
.mf-cmp{
  position:relative;flex:0 1 auto;overflow:hidden;
  display:flex;flex-direction:column;align-items:center;gap:3px;
  width:clamp(104px,20vw,160px);padding:0 7px 8px;border-radius:13px;
  background:linear-gradient(180deg,#fdf5e2 0%,#f6e7c6 44%,#e2cfa6 100%);
  border:2px solid #4a2f16;
  box-shadow:0 5px 0 rgba(58,36,16,.62),0 12px 22px rgba(0,0,0,.5),
             inset 0 2px 0 rgba(255,255,255,.85);
  opacity:0;transform:translateY(18px) scale(.95);
  transition:opacity .34s ease,transform .34s cubic-bezier(.2,1.3,.35,1);
}
.mf-cmp.in{opacity:1;transform:none}
.mf-c-band{
  align-self:stretch;height:7px;margin:0 -7px 5px;
  background:linear-gradient(180deg,var(--cl,#7fb2f0),var(--c,#3b7fd4));
  box-shadow:inset 0 -1px 0 rgba(0,0,0,.35);
}
.mf-c-av{line-height:0;margin-top:1px}
.mf-c-name{font:800 clamp(11px,1.9vw,14px)/1 var(--ff);letter-spacing:.1em;
  text-transform:uppercase;color:#2e1c06;text-shadow:0 1px 0 rgba(255,255,255,.7)}
.mf-c-desc{font:700 clamp(7.5px,1.15vw,9px)/1.28 var(--ff);letter-spacing:.05em;
  text-transform:uppercase;color:#7a5228;text-align:center}
.mf-cmp.you{
  border-color:#c99413;
  box-shadow:0 5px 0 #9a6d08,0 12px 22px rgba(0,0,0,.5),
             0 0 22px rgba(255,201,60,.45),inset 0 2px 0 rgba(255,255,255,.9);
}
.mf-c-you{
  position:absolute;top:7px;right:-27px;width:92px;padding:2px 0 3px;
  transform:rotate(38deg);text-align:center;
  background:linear-gradient(180deg,var(--gold-l,#ffe79a),var(--gold,#ffc93c));
  font:800 8px/1 var(--ff);letter-spacing:.18em;text-transform:uppercase;color:#3a2208;
  box-shadow:0 2px 6px rgba(0,0,0,.5);
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
.mf-i-drow{display:flex;gap:clamp(5px,1.2vw,10px)}

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

/* ------------------------------------------------------------- call to act */
.mf-i-foot{display:flex;flex-direction:column;align-items:center;gap:5px;margin-top:3px}
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
.mf-i-hint{font:700 clamp(8px,1.3vw,10px)/1.3 var(--ff);letter-spacing:.14em;
  text-transform:uppercase;color:rgba(206,228,250,.72);text-align:center;
  text-shadow:0 1px 3px rgba(0,0,0,.8)}
.mf-i-hint b{color:var(--gold-l,#ffe79a)}

@media (max-height:400px){
  .mf-intro{gap:4px}
  .mf-i-row{gap:5px}
  .mf-cmp{width:clamp(96px,19vw,132px);padding:0 5px 6px}
  .mf-c-band{height:6px;margin:0 -5px 4px}
  .mf-c-av svg{width:28px;height:28px}
  .mf-play{min-height:48px}
  /* Still a 46px tap target at 667x375 — the guideline floor, not a whisker
     under it. The blurb is what gives, not the button. */
  .btn.mf-diff{min-height:46px;width:clamp(96px,17.5vw,124px);padding:4px 6px 5px}
  .btn.mf-diff .mf-d-sub{font-size:6.6px;line-height:1.15}
  .mf-i-diff{gap:2px}
}
`;

/** The whole opening screen as one detached node. */
export function buildIntro(state, onBegin) {
  const cards = state.players.map(p => {
    const profile = BOT_PROFILES.find(b => b.id === p.id);
    const mine = p.id === 0;
    const desc = mine ? 'Your island to claim' : (profile ? profile.desc : 'Rival settler');
    const card = el('div', {
      class: 'mf-cmp' + (mine ? ' you' : ''),
      style: { '--c': p.color.css, '--cl': p.color.light }
    },
      el('span', { class: 'mf-c-band' }),
      el('span', { class: 'mf-c-av', html: avatar(p.color.css, p.color.light, 34) }),
      el('b', { class: 'mf-c-name', text: mine ? 'You' : p.name }),
      el('span', { class: 'mf-c-desc', text: desc }));
    if (mine) card.appendChild(el('span', { class: 'mf-c-you', text: 'You' }));
    return card;
  });

  /* ----------------------------------------------------------- difficulty */
  // Three chunky, obviously-tappable options. The choice goes straight into
  // difficulty.js; bots.js re-reads it every planning tick, and it is what a
  // replay re-applies, so there is nothing else to wire up.
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

  const node = el('div', { class: 'mf-intro mf-hid' },
    el('div', { class: 'mf-i-crest', text: 'Island' }),
    el('div', { class: 'mf-i-title', text: 'Settlers' }),
    el('div', { class: 'mf-i-obj', html: icon('trophy', 15) },
      el('span', { text: `First to ${VICTORY_POINTS} Points` })),
    el('div', { class: 'mf-i-row' }, cards),
    difficulty,
    el('div', { class: 'mf-i-foot' },
      playBtn,
      el('div', { class: 'mf-i-hint' },
        el('b', { text: 'Claim two corners' }),
        ' · gather from the land you touch · build roads, settlements and cities')));

  return { node, cards, playBtn, diffButtons, refreshDifficulty: paint };
}

export default buildIntro;
