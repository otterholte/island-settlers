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
import { el, button, setText } from '../ui/dom.js';
import { icon, avatar } from '../ui/icons.js';
import {
  DIFFICULTY_ORDER, LEVELS, getDifficulty, setDifficulty
} from './difficulty.js';
import {
  knightsOn, setKnights, autoDraft, setAutoDraft,
  soundOn, setSoundOn, lowPower, setLowPower, playerName, setPlayerName
} from '../core/options.js';

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
  background:linear-gradient(180deg,var(--cl,#93cbff),var(--c,#2f8ffb));
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

/* ============================================================ the two views
   HOME and MATCH SETUP share the layer; one is hidden at a time. Both fill it
   and centre their own column, so switching between them never shifts the
   crest or the buttons sideways. */
.mf-view{
  position:absolute;inset:0;
  display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:clamp(4px,1.4vh,10px);
  padding:calc(8px + var(--sat,0px)) calc(10px + var(--sar,0px))
          calc(8px + var(--sab,0px)) calc(10px + var(--sal,0px));
}
.mf-view.hid{display:none}

/* The two big choices, side by side and the SAME SIZE: neither is the small
   one. PLAY is green because it is what most presses do; FRIENDS is cream
   because it is the same size of decision made for a different reason.

   The width is pinned and the stack is forced because .btn is a ROW: left to
   itself the label and the sub-line sit shoulder to shoulder, so the button
   with the longer sub simply grows. That measured 306px against 531px — two
   buttons meant to read as equal choices, one nearly twice the other. */
.mf-i-cta .btn{
  flex-direction:column;gap:0;text-align:center;
  width:clamp(176px,25.5vw,254px);
  padding:0 clamp(10px,1.8vw,16px);
  min-height:clamp(52px,13vh,62px);
  font-size:clamp(12.5px,2vw,16px);letter-spacing:.11em;
}
.mf-i-cta .btn .sb-lab{white-space:normal;line-height:1.12}
.mf-friends{position:relative;--f1:#fdf5e2;--f2:#f0dfb6;--f3:#dcc493;--lip:#8f7444;--fg:#3f2a12}
.mf-friends .sb-lab{color:#3f2a12}
.mf-play .mf-p-sub,.mf-friends .mf-p-sub{
  display:block;margin-top:3px;
  font:700 clamp(7px,1.1vw,9px)/1.2 var(--ff);letter-spacing:.09em;
  text-transform:uppercase;opacity:.72;
}
.mf-i-note{
  margin-top:2px;padding:5px 12px 6px;border-radius:10px;
  background:rgba(8,22,42,.86);border:1.5px solid rgba(255,201,60,.32);
  font:700 clamp(8px,1.2vw,10px)/1.3 var(--ff);letter-spacing:.06em;
  text-transform:uppercase;color:rgba(226,240,255,.86);
}
.mf-i-note.hid{display:none}

/* ------------------------------------------------------------- setup panel
   A BOX, and an opaque one.

     "Make it so those settings are on a popup so the background images of the
      board on the home screen isn't overwhelming visually. I like having the
      settings grouped within a box for better clear UI."

   The controls used to float loose down the middle of a live 3D island with a
   drifting camera behind them, which is a lot of moving detail to read four
   buttons and a switch against. This is a plate with a real background, a
   heading, and one labelled row per setting. */
.mf-panel{
  width:min(560px,92vw);
  border-radius:20px;overflow:hidden;
  background:linear-gradient(180deg,rgba(14,36,64,.97),rgba(6,18,36,.98));
  border:2.5px solid rgba(255,201,60,.44);
  box-shadow:0 14px 0 rgba(0,0,0,.35),0 22px 50px rgba(0,0,0,.6),
             inset 0 2px 0 rgba(255,255,255,.14);
}
.mf-p-head{
  display:flex;align-items:baseline;justify-content:center;gap:10px;
  padding:clamp(8px,1.8vh,13px) 16px clamp(7px,1.5vh,11px);
  background:linear-gradient(180deg,rgba(255,201,60,.16),rgba(255,201,60,0));
  border-bottom:1.5px solid rgba(255,255,255,.12);
}
.mf-p-head b{font:800 clamp(12px,2vw,16px)/1 var(--ff);letter-spacing:.2em;
  text-transform:uppercase;color:var(--gold-l,#ffe79a);
  text-shadow:0 2px 4px rgba(0,0,0,.7)}
.mf-p-head span{font:700 clamp(7.5px,1.1vw,9.5px)/1 var(--ff);letter-spacing:.14em;
  text-transform:uppercase;color:rgba(206,226,246,.6)}
.mf-p-body{display:flex;flex-direction:column;gap:clamp(6px,1.4vh,12px);
  padding:clamp(9px,2vh,15px) clamp(10px,2.4vw,18px)}
.mf-p-row{display:flex;flex-direction:column;align-items:center;
  gap:clamp(3px,0.8vh,6px)}
.mf-p-foot{
  display:flex;align-items:center;justify-content:center;
  gap:clamp(10px,2.2vw,18px);
  padding:clamp(8px,1.8vh,13px) 16px clamp(10px,2.2vh,16px);
  border-top:1.5px solid rgba(255,255,255,.12);
  background:rgba(0,0,0,.22);
}
/* The four rungs were sized for the whole title screen — 4x152 + 3x10 inside a
   940px content box. The panel gives them 520, so left alone they wrapped 2x2
   and the body grew a whole extra row. Re-sized for 4x118 + 3x8 = 496. */
.mf-panel .mf-i-drow{gap:clamp(4px,1vw,8px)}
.mf-panel .btn.mf-diff{width:clamp(82px,20.5vw,118px);min-height:46px;padding:5px 5px 8px}
.mf-panel .btn.mf-diff .mf-d-name{font-size:clamp(10px,1.6vw,13px)}
.mf-panel .mf-play{min-height:clamp(46px,11.5vh,56px);animation:none}
.mf-back{min-height:clamp(40px,9vh,48px);padding:0 clamp(14px,3vw,24px);
  border-radius:14px;
  --f1:#e7e0cd;--f2:#cfc4a8;--f3:#b6a988;--lip:#7d6c48;--fg:#3f2a12}

@media (max-height:500px),(max-width:1023px){
  .mf-panel{width:min(540px,95vw)}
  .mf-p-head{padding:6px 12px 5px}
  .mf-p-body{gap:11px;padding:10px 10px 12px}
  .mf-p-row{gap:5px}
  .mf-p-foot{padding:7px 12px 9px;gap:10px}
  .mf-panel .mf-play{min-height:42px}
  .mf-back{min-height:40px}
  /* Specificity, not order: the un-nested compact rule for .btn.mf-diff loses
     to .mf-panel .btn.mf-diff above wherever it sits in the file, so the panel
     needs its own compact width. 4x110 + 3x6.7 = 460 inside the 476px body of
     a 500px panel — one row at 667x375, which is where this last wrapped. */
  .mf-panel .btn.mf-diff{width:clamp(78px,16.4vw,110px);min-height:44px;padding:4px 4px 7px}
}

/* ------------------------------------------------------------- the Knight
   A SWITCH, not two buttons.

     "Can you make the knights be a toggle instead of two large buttons."

   ON and OFF as a pair of 110px plates was the difficulty picker's shape used
   for a question that does not have four answers — two chunky mutually
   exclusive buttons carry all the visual weight of a real choice for something
   that is just a setting. This is one track with one knob, which says the same
   thing in a third of the width and reads as on-or-off without being labelled
   on-or-off. Its state is carried by position AND colour AND the word beside
   it, so it does not rely on any one of the three.

   The knob is a pseudo-element so the whole control is one focusable button
   with one hit area; 46px tall, comfortably over the tap-target floor. */
.mf-i-raid{display:flex;align-items:center;justify-content:center;
  gap:clamp(8px,1.6vw,13px)}
.btn.mf-switch{
  position:relative;flex:0 0 auto;
  width:clamp(62px,11vw,76px);min-height:34px;height:34px;padding:0;
  border-radius:999px;border-width:2px;
  --f1:#5b6b7e;--f2:#3d4a5a;--f3:#2b3644;--lip:#1a2330;
  box-shadow:0 3px 0 var(--lip),0 6px 12px rgba(0,0,0,.45),
             inset 0 2px 6px rgba(0,0,0,.45);
  transition:background .22s ease,box-shadow .22s ease;
}
.btn.mf-switch::after{
  content:'';position:absolute;top:3px;left:3px;
  width:24px;height:24px;border-radius:50%;
  background:linear-gradient(180deg,#fdf5e2,#dcc496);
  box-shadow:0 2px 0 rgba(0,0,0,.42),inset 0 2px 0 rgba(255,255,255,.75);
  transition:transform .22s cubic-bezier(.2,1.3,.35,1),background .22s ease;
}
.btn.mf-switch.on{
  --f1:#a6e58c;--f2:#4bab53;--f3:#2f8a3d;--lip:#1a5526;
  box-shadow:0 3px 0 var(--lip),0 6px 12px rgba(0,0,0,.45),
             0 0 18px rgba(75,171,83,.5),inset 0 2px 6px rgba(0,0,0,.28);
}
.btn.mf-switch.on::after{
  transform:translateX(calc(clamp(62px,11vw,76px) - 34px));
  background:linear-gradient(180deg,#ffffff,#e9f7e2);
}
/* The word is the third channel, and it is the one a colour-blind player
   reads: it changes with the knob rather than labelling the track. */
.mf-raid-state{
  min-width:3.4em;text-align:left;
  font:800 clamp(11px,1.85vw,14px)/1 var(--ff);letter-spacing:.16em;
  text-transform:uppercase;color:#8f9dad;
  text-shadow:0 1px 3px rgba(0,0,0,.8);transition:color .22s ease;
}
.mf-raid-state.on{color:#a6e58c}

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
   3px on its idle bounce, and neither is part of its layout box — with a 5px
   gap the lip paints straight across whatever sits underneath it. The floor is
   14px: 7 for the lip, 3 for the bounce, and 4 of actual air. Measured at
   960x444 and 667x375, button-bottom to next-top, not eyeballed. */
.mf-i-cta{
  display:flex;align-items:center;justify-content:center;
  gap:clamp(9px,2vw,16px);margin-top:clamp(4px,1.2vh,8px);
  flex-wrap:wrap;
}
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
/* Bottom-right corner, out of the title's column entirely, so BEGIN THE DRAFT
   is centred on the SCREEN rather than centred in a pair of buttons. The
   .mf-intro layer is the positioning context (absolute, inset 0), and the
   right/bottom insets match the crest's own margins so it reads as a deliberate
   corner rather than as something that fell off the stack.

   TOP right, not bottom: the help line along the foot runs most of the width of
   the screen at both shipping sizes, and a corner button down there sat on the
   end of it. The top corners are the only genuinely empty ones — the crest and
   the title are a centred column — so that is where it goes.
   (No backticks anywhere in this block: it is a JS template literal.) */
.mf-tut{
  position:absolute;right:clamp(10px,2.4vw,22px);top:clamp(10px,2.4vh,20px);
  min-height:clamp(44px,9.5vh,50px);padding:0 clamp(13px,2.6vw,22px);
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

/* THE GEAR, TOP LEFT.
   Opposite the tutorial and the same height as it, so the two top corners
   balance. It is deliberately the plainest control on the screen: a player who
   is not looking for it should not find it first. */
.btn.mf-gear{
  position:absolute;left:clamp(10px,2.4vw,22px);top:clamp(10px,2.4vh,20px);
  width:clamp(44px,9.5vh,50px);min-height:clamp(44px,9.5vh,50px);padding:0;
  border-radius:16px;border-width:2.5px;
  --f1:#fbf3de;--f2:#f0dfb6;--f3:#dcc493;--lip:#8f7444;--fg:#3f2a12;
  box-shadow:0 6px 0 var(--lip),0 11px 20px rgba(0,0,0,.5),
             inset 0 3px 0 rgba(255,255,255,.7),inset 0 -7px 11px rgba(0,0,0,.16);
}
.btn.mf-gear:active{transform:translateY(6px);
  box-shadow:0 0 0 var(--lip),0 4px 8px rgba(0,0,0,.45),
             inset 0 3px 0 rgba(255,255,255,.6)}
.mf-g-ico{display:flex;align-items:center;justify-content:center;width:22px;height:22px}
.mf-g-ico svg{width:100%;height:100%;display:block}

/* The settings sheet itself. Same plate as Match Setup — it IS the same kind of
   thing — laid over whichever screen is up, with a scrim so the island behind
   it stops competing for attention. */
.mf-settings{
  position:absolute;inset:0;z-index:6;
  display:flex;align-items:center;justify-content:center;
  padding:clamp(8px,2vh,20px);
  background:rgba(3,10,22,.62);
  pointer-events:auto;
}
.mf-settings.hid{display:none}
.mf-settings .mf-p-body{max-height:min(62vh,420px);overflow-y:auto}
.mf-s-name{
  width:min(280px,74vw);min-height:44px;padding:0 14px;
  border-radius:12px;border:2px solid rgba(255,201,60,.42);
  background:rgba(4,14,28,.9);color:#f3e7cd;
  font:800 clamp(13px,2.2vw,16px)/1 var(--ff);letter-spacing:.06em;text-align:center;
}
.mf-s-name:focus{outline:none;border-color:rgba(255,201,60,.9);
  box-shadow:0 0 0 3px rgba(255,201,60,.22)}
.mf-settings .btn.mf-s-row{width:min(280px,74vw)}

/* The install chip, opposite the tutorial. Quiet by design and hidden outright
   until there is something to install — see the askInstall() note below. */
/* Pushed right by the width of the gear plus a gap: both live in the top-left
   corner and the gear is the one that is always there, so the chip that only
   sometimes exists is the one that moves. */
.btn.mf-inst{
  position:absolute;
  left:calc(clamp(10px,2.4vw,22px) + clamp(44px,9.5vh,50px) + clamp(6px,1.4vw,10px));
  top:clamp(10px,2.4vh,20px);
  min-height:clamp(42px,9vh,48px);padding:0 clamp(11px,2.2vw,16px);
  border-radius:14px;border-width:2px;gap:8px;
  --f1:#eef4fc;--f2:#cfdcec;--f3:#b6c7dc;--lip:#6d7d92;--fg:#22344a;
  box-shadow:0 5px 0 var(--lip),0 9px 16px rgba(0,0,0,.45),
             inset 0 2px 0 rgba(255,255,255,.7);
}
.mf-inst:active{transform:translateY(5px);
  box-shadow:0 0 0 var(--lip),0 3px 7px rgba(0,0,0,.4),
             inset 0 2px 0 rgba(255,255,255,.6)}
.mf-inst .mf-inst-i{line-height:0;flex:0 0 auto;opacity:.8}
.mf-inst .mf-inst-t{display:flex;flex-direction:column;align-items:flex-start;gap:1px}
.mf-inst b{font:800 clamp(10px,1.7vw,12.5px)/1 var(--ff);letter-spacing:.13em;
  text-transform:uppercase}
.mf-inst .mf-t-sub{font:700 clamp(6.4px,1vw,8px)/1.15 var(--ff);letter-spacing:.1em;
  text-transform:uppercase;color:#5b6b80;text-shadow:none;white-space:nowrap}

.mf-i-hint{font:700 clamp(8px,1.3vw,10px)/1.3 var(--ff);letter-spacing:.14em;
  text-transform:uppercase;color:rgba(206,228,250,.72);text-align:center;
  text-shadow:0 1px 3px rgba(0,0,0,.8)}
.mf-i-hint b{color:var(--gold-l,#ffe79a)}
/* Clears the PLAY button's 7px lip plus its 3px idle bounce — see .mf-i-cta. */
.mf-home .mf-i-hint{margin-top:clamp(10px,2.2vh,14px)}

@media (max-height:500px),(max-width:1023px){
  .mf-intro{gap:4px}
  /* Specificity on purpose: flowUI.js's own compact block still sizes the old
     four-card row, and this plate is not a card. */
  .mf-intro .mf-cmp{width:auto;min-height:42px;padding:4px 13px 5px 11px;gap:8px}
  .mf-intro .mf-c-desc{font-size:8px}
  .mf-c-av svg{width:28px;height:28px}
  .mf-play{min-height:48px}
  .mf-tut{min-height:44px;padding:0 12px}
  .mf-inst{min-height:40px;padding:0 10px;gap:6px}
  /* Still a 46px tap target at 667x375 — the guideline floor, not a whisker
     under it. The blurb is what gives, not the button. Four of these at 667
     wide come to 4x116.7 + 3x8 of gap = 491px inside a 647px content box. */
  .btn.mf-diff{min-height:46px;width:clamp(96px,17.5vw,124px);padding:4px 6px 5px}
  /* ROOM TO BREATHE, AND TEXT YOU CAN ACTUALLY READ.
   *
   *   "The buttons and text here are too squished vertically and the smallest
   *    text is too small to read."
   *
   * Both true, and both were the compact block's doing: the switches were
   * pinned to a 30px track — under the 36px anything a thumb touches is
   * supposed to clear — and the caption under each one was set at SEVEN
   * PIXELS. Seven. That is not small type, it is a texture. The panel has the
   * room: it was measuring 275px tall inside a 375px viewport, so this spends
   * some of the eighty it was leaving empty. */
  .btn.mf-switch{width:clamp(62px,11vw,72px);height:38px;min-height:38px}
  .btn.mf-switch::after{width:26px;height:26px;top:5px;left:5px}
  .btn.mf-switch.on::after{transform:translateX(calc(clamp(62px,11vw,72px) - 36px))}
  .mf-raid-state{font-size:12px;letter-spacing:.1em}
  .mf-i-dnote{font-size:10px;line-height:1.3;margin-top:3px}
  .btn.mf-diff .mf-d-sub{font-size:6.6px;line-height:1.15}
  .mf-i-diff{gap:2px}
  .mf-i-cta{gap:10px;margin-top:4px}
}
`;

/** Raised when TUTORIAL is pressed; systems/tutorial.js is listening. */
export const TUTORIAL_EVENT = 'mf-tutorial';

/** Raised when PLAY WITH FRIENDS is pressed; flowUI.js is listening.
 *  Same grain as the tutorial: a document event rather than a callback, so the
 *  opening screen never has to hold a reference to the thing it opens. */
export const FRIENDS_EVENT = 'mf-friends';

function raise(type) {
  if (typeof document === 'undefined' || !document.dispatchEvent) return;
  try {
    document.dispatchEvent(typeof CustomEvent === 'function'
      ? new CustomEvent(type)
      : Object.assign(document.createEvent('Event'), { type }));
  } catch (e) { /* a browser this old is not running the game anyway */ }
}

function askForTutorial() { raise(TUTORIAL_EVENT); }
function askForFriends() { raise(FRIENDS_EVENT); }

/** The whole opening screen as one detached node. */
export function buildIntro(state, onBegin) {
  // No competitor cards at all — not the rivals, and not the player's own.
  // The title, the goal and the two buttons say everything this screen needs
  // to, and the empty band lets them breathe. `cards` stays an array so
  // flowUI.js's staggered reveal keeps working without knowing how many
  // there are.
  const cards = [];

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
      // The blurb stays on the accessible label, where a screen reader can
      // still reach it, but the button itself is just the name. Four rungs of
      // two-line copy was more words than the choice deserved.
      'aria-label': `${level.label} — ${level.blurb}`,
      on: { click: () => pick(key) }
    },
      el('b', { class: 'mf-d-name', text: level.label }));
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

  /* No heading. "Rival Skill" sat over four buttons reading EASY, MEDIUM, HARD
     and EXPERT — a label explaining a row that explains itself, on the screen
     with the least room to spare. The Knights row below keeps its label because
     a switch on its own says nothing about what it switches. */
  const difficulty = el('div', { class: 'mf-i-diff' },
    el('div', { class: 'mf-i-drow' }, diffButtons));

  /* --------------------------------------------------------------- knights
   *
   *   "Add a feature to turn off the robber/knight if you want, for that
   *    specific game, before the game started."
   *   "Can you make the knights be a toggle instead of two large buttons."
   *
   * A Knight takes half of every resource off every rival at once and then
   * shuts a hex down, and it is half the card deck — so a match with them and a
   * match without them are genuinely two different games, and which one you
   * want is a thing to decide before the draft rather than to endure.
   *
   * Switching it off pulls the Knight out of the deck (`rules.drawCard`
   * re-normalises what is left), stops anything blocking a hex, hides the
   * Knight in the world and on the map, and takes LARGEST ARMY out of reach —
   * which is stated on the caption under the switch, because a silent two
   * victory points going missing is exactly the kind of thing that gets found
   * out at the wrong moment.
   *
   * Storage is the same model as the difficulty picker above (see `core/options.js`): the
   * choice sticks between matches, and the switch is right here on every
   * opening screen so it is still a per-match decision.
   */
  /* --------------------------------------------------------- pick for me
   *
   *   "Add a setting to the game setup page that lets me have a randomized
   *    settlement and road placement for the start of the game, instead of
   *    forcing them to spend the time picking where they want it. Don't give
   *    them really scrappy locations though — just have the bot choose for
   *    them too."
   *
   * So the switch does exactly that and no more: your two corners and two
   * roads are chosen by the same brain the rivals use, and the draft plays
   * itself while you watch. Not random — `botBrain.chooseSetupSettlement`
   * weighs supply rate, then how many DIFFERENT resources the corner covers,
   * then how far it sits from your other one. Turned all the way up, with the
   * difficulty's opening randomness set to zero, so an EASY match still deals
   * you a good opening: the setting is about not spending the minute, not
   * about handicapping yourself.
   *
   * It sits beside Knights because it belongs to the same question — what kind
   * of match do I want — and it is stored per device rather than per match, so
   * it holds online too without anybody else having to agree to it. */
  const autoNote = el('div', { class: 'mf-i-dnote' });
  const autoState = el('b', { class: 'mf-raid-state', text: 'I pick' });
  const autoSwitch = button('mf-switch', {
    role: 'switch',
    'aria-label': 'Pick my opening for me — the bot claims your two corners and roads',
    on: { click: () => pickAuto(!autoDraft()) }
  });

  /* ON and OFF said nothing, and neither did the word OPENING above them.
   *
   *   "I don't think the word Opening makes a lot of sense. Make it more
   *    clear."
   *
   * A switch labelled with a noun makes the reader work out which way round it
   * is. This one answers the question instead — WHO PICKS MY SPOTS, and the
   * two answers are "I pick" and "Pick for me". Nothing to infer. */
  function paintAuto() {
    const cur = autoDraft();
    autoSwitch.classList.toggle('on', cur);
    autoSwitch.setAttribute('aria-checked', cur ? 'true' : 'false');
    autoState.classList.toggle('on', cur);
    autoState.textContent = cur ? 'Pick for me' : 'I pick';
    autoNote.textContent = cur
      ? 'Strong spots are claimed for you — look the board over, then start'
      : 'You claim your own two corners and two roads in the draft';
    autoNote.classList.toggle('off', !cur);
    setText(startBtn.querySelector('.sb-lab'),
      cur ? 'Continue' : 'Begin the Draft');
  }

  function pickAuto(on) {
    setAutoDraft(on);
    paintAuto();
  }

  const raidNote = el('div', { class: 'mf-i-dnote' });
  const raidState = el('b', { class: 'mf-raid-state', text: 'On' });
  const raidSwitch = button('mf-switch', {
    role: 'switch',
    'aria-label': 'Knights — the Knight card, the blocked region and Largest Army',
    on: { click: () => pickRaid(!knightsOn()) }
  });

  function paintRaid() {
    const cur = knightsOn();
    raidSwitch.classList.toggle('on', cur);
    raidSwitch.setAttribute('aria-checked', cur ? 'true' : 'false');
    raidState.classList.toggle('on', cur);
    raidState.textContent = cur ? 'On' : 'Off';
    raidNote.textContent = cur
      ? 'A Knight takes half of every rival\u2019s goods and blocks a region'
      : 'No Knight cards \u00b7 nothing blocks a region \u00b7 no Largest Army';
    raidNote.classList.toggle('off', !cur);
  }

  function pickRaid(on) {
    setKnights(on);
    paintRaid();
  }

  paintRaid();

  /* ======================================================== the two screens
   *
   *   "Maybe make the first home screen the normal play, or play with friends,
   *    then the second screen you see the difficulty level and knights
   *    settings. Also make it so those settings are on a popup so the
   *    background images of the board on the home screen isn't overwhelming
   *    visually. I like having the settings grouped within a box."
   *
   * One node, two states, switched by `show()`. HOME asks the only question
   * that matters first — who are you playing — and MATCH SETUP is a solid
   * panel: opaque enough that the island behind it stops competing with the
   * controls on top of it, which is the whole complaint. Everything that used
   * to be stacked loose down the middle of the title screen now lives inside
   * that box, in labelled rows.
   *
   * Back is always available and never costs anything: both settings are
   * stored the moment they are touched (difficulty.js / core/options.js), so
   * stepping back and forward is free.
   */
  let step = 'home';

  const playBtn = button('green huge mf-play', { on: { click: () => show('setup') } },
    el('span', { class: 'sb-lab', text: 'Play' }),
    el('span', { class: 'mf-p-sub', text: 'You against three rivals' }));

  /*
   * PLAY WITH FRIENDS, which is now one code and no ceremony.
   *
   * The sub-line used to read "Invite people you added", which described a
   * friends list, a request, an acceptance and an invite — four steps between
   * two people and a game, and the four steps were where it broke. It is a
   * five-character room code now, so the button can say the thing that is
   * actually true and the whole screen behind it is a name and a code.
   */
  const friendsBtn = button('cream huge mf-friends', {
    'aria-label': 'Play with friends — make a room, or type a room code',
    on: { click: () => askForFriends() }
  },
    el('span', { class: 'sb-lab', text: 'Play with Friends' }),
    el('span', { class: 'mf-p-sub', text: 'Share a room code' }));

  const friendsNote = el('div', { class: 'mf-i-note hid', text: '' });
  let noteT = 0;
  /** Shown only when the friends screen could not be built at all. */
  function nudgeFriends(text) {
    friendsNote.textContent = text;
    friendsNote.classList.remove('hid');
    if (noteT) clearTimeout(noteT);
    noteT = setTimeout(() => friendsNote.classList.add('hid'), 3600);
  }

  /*
   * TUTORIAL, IN THE CORNER.
   *
   *   "Put the tutorial in the corner of the screen somewhere so the Start Game
   *    button can be centered."
   *
   * It used to sit beside the start button in a two-button row, which meant the
   * one button everybody presses was never actually in the middle of the screen
   * — it was in the middle of a pair, pushed left by the width of a control
   * most players use once and never again. Top-right corner now, out of the
   * title's column entirely, and it belongs to the HOME screen only: once you
   * are choosing a difficulty you have already decided not to read the rules.
   */
  const tutBtn = button('cream mf-tut', {
    'aria-label': 'Tutorial — read the rules or take a guided practice run',
    on: { click: () => askForTutorial() }
  },
    el('b', { class: 'mf-t-lab', text: 'Tutorial' }),
    el('span', { class: 'mf-t-sub', text: 'New here? Start with this' }));

  /*
   * ADD TO HOME SCREEN.
   *
   *   "Maybe make it a PWA I can save to my homescreen so I don't see the URL
   *    bar for a start."
   *
   * The manifest and the service worker make the game installable; this is the
   * part that tells a player it is. Chrome fires `beforeinstallprompt` and
   * then waits to be asked — index.html catches it before any module has
   * parsed, because it can arrive that early, and parks it on the window.
   *
   * The chip only exists when there is something to install: it is hidden when
   * the event never came (an unsupported browser, or a site not served over
   * https), and hidden again the moment the game is already running installed,
   * where it would be an invitation to do a thing that is already done.
   *
   * iOS never fires the event and has no programmatic install at all, so there
   * the chip says where the button actually is: Share, then Add to Home Screen.
   */
  const iOS = typeof navigator !== 'undefined'
    && /iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent || '');

  /**
   * Is this a device with a home screen to add anything to?
   *
   *   "Know if you're on mobile or desktop. If you're not on mobile — anything
   *    larger than an iPad — don't show the add to homescreen button."
   *
   * Three questions, and it has to be all three rather than a user-agent
   * string, because a Chromebook, a touchscreen laptop and an iPad Pro in
   * landscape are all "touch device with a big screen" and only one of them
   * has a home screen.
   *
   *   - A coarse pointer and no hover: a finger, not a mouse. Desktop Chrome
   *     with a touchscreen still reports `hover: hover`.
   *   - `maxTouchPoints`, as the fallback for engines with no pointer media
   *     queries.
   *   - And the size cap the request names. A 12.9" iPad Pro is 1366 CSS px on
   *     its long edge, so 1400 is "an iPad or smaller" with a little room, and
   *     it is measured on the LONG edge because this game is landscape-locked
   *     and every phone is wide here.
   */
  const IPAD_MAX = 1400;
  function handheld() {
    const nav = typeof navigator !== 'undefined' ? navigator : null;
    const mm = typeof globalThis.matchMedia === 'function' ? globalThis.matchMedia : null;
    const coarse = mm ? mm('(pointer: coarse)').matches : false;
    const noHover = mm ? mm('(hover: none)').matches : false;
    const touch = !!(nav && (nav.maxTouchPoints > 0 || 'ontouchstart' in globalThis));
    const w = globalThis.innerWidth || 0;
    const h = globalThis.innerHeight || 0;
    const long = Math.max(w, h);
    return (coarse || noHover || touch) && long > 0 && long <= IPAD_MAX;
  }

  const installLab = el('b', { text: 'Add to Home Screen' });
  const installSub = el('span', {
    class: 'mf-t-sub',
    text: iOS ? 'Share ▸ Add to Home Screen' : 'Full screen, no address bar'
  });
  const installBtn = button('cream mf-inst hid', {
    'aria-label': 'Install Island Settlers to your home screen',
    on: { click: () => askInstall() }
  }, el('span', { class: 'mf-inst-i', html: icon('home', 15) }),
    el('div', { class: 'mf-inst-t' }, installLab, installSub));

  function standalone() {
    if (typeof globalThis.matchMedia === 'function'
      && globalThis.matchMedia('(display-mode: standalone)').matches) return true;
    if (typeof globalThis.matchMedia === 'function'
      && globalThis.matchMedia('(display-mode: fullscreen)').matches) return true;
    return !!(typeof navigator !== 'undefined' && navigator.standalone);
  }

  function paintInstall() {
    const box = globalThis.__INSTALL__ || null;
    const can = handheld() && !standalone() && (iOS || !!(box && box.evt));
    installBtn.classList.toggle('hid', !can);
  }

  async function askInstall() {
    const box = globalThis.__INSTALL__ || null;
    if (!box || !box.evt) return;          // iOS: the chip is a label, not a button
    const ev = box.evt;
    box.evt = null;
    try {
      ev.prompt();
      await ev.userChoice;
    } catch (e) { /* dismissed, or the browser changed its mind */ }
    paintInstall();
  }

  if (typeof globalThis.addEventListener === 'function') {
    globalThis.addEventListener('is-installable', paintInstall);
    // A laptop that gets narrowed, or a tablet that rotates: re-ask rather
    // than deciding once at boot.
    globalThis.addEventListener('resize', paintInstall);
    globalThis.addEventListener('appinstalled', () => {
      if (globalThis.__INSTALL__) globalThis.__INSTALL__.evt = null;
      paintInstall();
    });
  }
  paintInstall();

  const startBtn = button('green huge mf-play', { on: { click: () => onBegin() } },
    el('span', { class: 'sb-lab', text: 'Begin the Draft' }));

  // After `startBtn` exists: paintAuto writes its label, because the button
  // says what the switch above it means — Begin the Draft, or Continue.
  paintAuto();

  const backBtn = button('cream mf-back', {
    'aria-label': 'Back to the home screen',
    on: { click: () => show('home') }
  }, el('span', { class: 'sb-lab', text: 'Back' }));

  /*
   * ------------------------------------------------------------------------
   * THE GEAR, ON THE OPENING SCREEN
   * ------------------------------------------------------------------------
   *
   *   "Please also add a settings button in the top left corner even for the
   *    homepage, so users can change the sound to off, or update their name,
   *    right from there. Or even edit the graphic settings."
   *
   * Every one of those three was already a device setting with nowhere to set
   * it until a match was running. Sound and Graphics lived under the gear in
   * the HUD, which is behind a difficulty screen, a draft and a countdown; the
   * name lived only on the friends screen, so a player who never pressed Play
   * with Friends was called YOU by a game that had no way to be told otherwise.
   *
   * The same three switches, in the same words, in the corner of the first
   * screen. `core/options.js` is the single place all of them are stored, so
   * this panel and the one in the match cannot disagree — turning the sound off
   * here means the match starts quiet, and the gear in the match opens already
   * saying Off.
   *
   * The name field commits on blur and on Enter, not on every keystroke: a
   * half-typed name should not be what your friends see if you walk away
   * mid-word, and `setPlayerName` tidies it the same way the server would.
   */
  const nameInput = el('input', {
    class: 'mf-s-name', type: 'text', maxlength: '14', 'data-ui': '',
    placeholder: 'You', 'aria-label': 'The name your friends see',
    on: {
      change: e => commitName(e.target.value),
      blur: e => commitName(e.target.value),
      keydown: e => { if (e.key === 'Enter') { e.target.blur(); } }
    }
  });
  nameInput.value = playerName();

  function commitName(v) {
    const name = setPlayerName(v);
    nameInput.value = name;
    return name;
  }

  const soundBtn = button('wide cream mf-s-row', { on: { click: () => setSound(!soundOn()) } },
    el('span', { class: 'sb-ico', html: icon('sound', 20) }),
    el('span', { class: 'sb-lab', text: 'Sound: On' }));

  function setSound(on) {
    setSoundOn(!!on);
    soundBtn.childNodes[0].innerHTML = icon(on ? 'sound' : 'mute', 20);
    soundBtn.childNodes[1].textContent = 'Sound: ' + (on ? 'On' : 'Off');
    /* There is no match and therefore no audio engine yet on a cold boot; when
       there is one — a second match from the same page — tell it now rather
       than waiting for the HUD to be rebuilt. */
    const a = (typeof window !== 'undefined' && window.__ISLAND__)
      ? window.__ISLAND__.game && window.__ISLAND__.game.audio : null;
    if (a) {
      a.muted = !on;
      if (typeof a.setMuted === 'function') a.setMuted(!on);
      else if (typeof a.mute === 'function') a.mute(!on);
      if (typeof a.ambience === 'function') a.ambience(!!on);
      if (typeof a.music === 'function' && !on) a.music('off');
    }
  }
  setSound(soundOn());

  /* Full / Saver, the same two words as the gear in the match. The ladder in
     systems/quality.js reads `lowPower()` on the way up, so a choice made here
     is in force before the first frame of the next match is drawn — which is
     the whole point of it being on this screen. */
  const gfxBtns = [false, true].map(v => button('seg', {
    on: { click: () => setGfx(v) }
  }, el('span', { text: v ? 'Saver' : 'Full' })));

  function setGfx(v) {
    setLowPower(v);
    const g = (typeof window !== 'undefined' && window.__ISLAND__)
      ? window.__ISLAND__.game : null;
    if (g && typeof g.setLowPower === 'function') {
      try { g.setLowPower(v); } catch (e) { /* next boot, then */ }
    }
    paintGfx();
  }
  function paintGfx() {
    const cur = lowPower();
    gfxBtns.forEach((b, i) => b.classList.toggle('on', [false, true][i] === cur));
  }
  paintGfx();

  /* `data-ui` on the scrim AND on the field: `#ui *{pointer-events:none}` with
     `#ui [data-ui]{pointer-events:auto}` is what keeps the interface out of the
     way of the joystick, and `button()` adds the marker for itself. Anything
     that is not a button has to say so. */
  const settingsPanel = el('div', { class: 'mf-settings hid', 'data-ui': '' },
    el('div', { class: 'mf-panel' },
      el('div', { class: 'mf-p-head' },
        el('b', { text: 'Settings' }),
        el('span', { text: 'Saved on this device' })),
      el('div', { class: 'mf-p-body' },
        el('div', { class: 'mf-p-row' },
          el('div', { class: 'mf-i-dlab', text: 'Your name' }), nameInput),
        el('div', { class: 'mf-p-row' }, soundBtn),
        el('div', { class: 'mf-p-row' },
          el('div', { class: 'mf-i-dlab', text: 'Graphics' }),
          el('div', { class: 'side-seg' }, gfxBtns))),
      el('div', { class: 'mf-p-foot' },
        button('cream mf-back', { on: { click: () => showSettings(false) } },
          el('span', { class: 'sb-lab', text: 'Done' })))));

  const gearBtn = button('cream mf-gear', {
    'aria-label': 'Settings — sound, your name and graphics',
    on: { click: () => showSettings(settingsPanel.classList.contains('hid')) }
  }, el('span', { class: 'mf-g-ico', html: icon('gear', 20) }));

  function showSettings(on) {
    settingsPanel.classList.toggle('hid', !on);
    if (on) { nameInput.value = playerName(); paintGfx(); }
    else commitName(nameInput.value);
  }

  /* --------------------------------------------------------------- screen 1 */
  const homeView = el('div', { class: 'mf-view mf-home' },
    el('div', { class: 'mf-i-crest', text: 'Island' }),
    el('div', { class: 'mf-i-title', text: 'Settlers' }),
    el('div', { class: 'mf-i-obj', html: icon('trophy', 15) },
      el('span', { text: `First to ${VICTORY_POINTS} Points` })),
    el('div', { class: 'mf-i-row' }, cards),
    el('div', { class: 'mf-i-cta' }, playBtn, friendsBtn),
    friendsNote,
    el('div', { class: 'mf-i-hint' },
      el('b', { text: 'Claim two corners' }),
      ' · gather from the land you touch · build roads, settlements and cities'),
    tutBtn, installBtn, gearBtn);

  /* --------------------------------------------------------------- screen 2 */
  const setupView = el('div', { class: 'mf-view mf-setup hid' },
    el('div', { class: 'mf-panel' },
      el('div', { class: 'mf-p-head' },
        el('b', { text: 'Match Setup' }),
        el('span', { text: `First to ${VICTORY_POINTS} points` })),
      el('div', { class: 'mf-p-body' },
        el('div', { class: 'mf-p-row' },
          el('div', { class: 'mf-i-dlab', text: 'Rivals' }), difficulty),
        el('div', { class: 'mf-p-row' },
          el('div', { class: 'mf-i-dlab', text: 'Knights' }),
          el('div', { class: 'mf-i-raid' }, raidSwitch, raidState),
          raidNote),
        el('div', { class: 'mf-p-row' },
          el('div', { class: 'mf-i-dlab', text: 'Who picks my spots' }),
          el('div', { class: 'mf-i-raid' }, autoSwitch, autoState),
          autoNote)),
      el('div', { class: 'mf-p-foot' }, backBtn, startBtn)));

  function show(next) {
    step = next === 'setup' ? 'setup' : 'home';
    homeView.classList.toggle('hid', step !== 'home');
    setupView.classList.toggle('hid', step !== 'setup');
    friendsNote.classList.add('hid');
    showSettings(false);
  }

  const node = el('div', { class: 'mf-intro mf-hid' }, homeView, setupView, settingsPanel);

  return {
    node, cards, playBtn, startBtn, friendsBtn, tutBtn, backBtn,
    diffButtons, raidSwitch, gearBtn, settingsPanel,
    /** Capture-rig hook, and the keyboard route in later. */
    showSettings,
    /** flowUI calls this if the friends screen could not be built at all. */
    nudgeFriends,
    refreshDifficulty: paint,
    refreshKnights: paintRaid,
    refreshAutoDraft: paintAuto,
    /** flowUI re-shows this node between matches; always come back HOME. */
    reset: () => show('home'),
    get step() { return step; }
  };
}

export default buildIntro;
