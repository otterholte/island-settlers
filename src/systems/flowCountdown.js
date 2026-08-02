/**
 * Island Settlers — the start-of-match countdown.
 *
 *   createCountdown(state, game, deps) -> {
 *     begin() -> seconds, update(dt) -> finishedThisTick,
 *     cancel(), destroy(), active, label, t, total
 *   }
 *
 * ---------------------------------------------------------------------------
 * WHY
 * ---------------------------------------------------------------------------
 *   "Once the game is about to start, show a countdown timer, since I feel like
 *    the bots are running before me."
 *
 * They were. `setupPlaceRoad` flips `state.phase` to 'play' on the last road of
 * the draft, and bots.js starts driving the instant it sees that phase — while
 * matchflow was still spending two and a bit seconds blending the camera out of
 * the board framing and fading the objective card in, with the human's input
 * still locked. Three bots got a two-second head start on every match.
 *
 * So the handoff is now an explicit, visible, *enforced* start line:
 *
 *      3  .  2  .  1  .  GO
 *
 * and nothing on the island may move until GO.
 *
 * ---------------------------------------------------------------------------
 * HOW THE FREEZE IS ENFORCED
 * ---------------------------------------------------------------------------
 * The human is easy: matchflow already zeroes the stick every fixed step while
 * its input lock is on.
 *
 * The bots are the interesting half. `bots.js` belongs to another agent and
 * `main.js` — which we may not edit — calls `bots.update(FIXED)` on the object
 * it built. That object is the *same reference* main.js hangs on `game.bots`,
 * and `bots.update(...)` resolves the property at call time, so replacing
 * `game.bots.update` with a gate is enough to stop the call reaching bots.js at
 * all. Same interception style as matchflow's `panels.showResults` wrap, and
 * the original is handed back untouched on `cancel()`.
 *
 * The gate also ADVANCES the countdown when the flow did not advance it first.
 * A harness (tools/testmatch.mjs) steps `bots.update` without always stepping
 * `flow.update`, and a freeze that can only be released by a clock nobody is
 * winding is a freeze that never ends. Whoever is stepping the simulation burns
 * it down; in the real frame loop `flow.update` runs first every time, so the
 * gate never double-counts.
 *
 * The match clock is held at its pre-countdown value too — the timer in the HUD
 * starts at 0:00 on GO, not at 0:03.
 *
 * Headless-safe: with no usable `document` the numerals are skipped and the
 * freeze still runs, so the start line is real even in a build with no UI.
 *
 * Owner: Flow agent.
 */

import { el, toggle, setText } from '../ui/dom.js';

const STYLE_ID = 'mf-count-style';

/* Three beats and a GO. Fast enough that it never feels like a loading bar,
   slow enough to read on a phone held at arm's length. */
const BEAT = 0.72;
const GO_HOLD = 0.62;
const TOTAL = BEAT * 3 + GO_HOLD;

const CSS = `
.fc-layer{position:absolute;inset:0;pointer-events:none;display:flex;
  align-items:center;justify-content:center;flex-direction:column;gap:4px;z-index:26}
.fc-layer.fc-off{display:none}
/* A soft dark pool under the numerals. Without it a cream "2" over a sunlit
   sand hex is barely a shape, and this thing has one job. */
.fc-glow{
  position:absolute;width:340px;height:340px;border-radius:50%;
  background:radial-gradient(circle,rgba(5,14,28,.62) 0%,rgba(5,14,28,.44) 42%,
    rgba(5,14,28,0) 72%);
  opacity:0;transition:opacity .35s ease;
}
.fc-layer.on .fc-glow{opacity:1}
.fc-cap{
  position:relative;
  padding:4px 14px 5px;border-radius:9px;
  background:rgba(6,18,34,.62);
  box-shadow:inset 0 0 0 1.5px rgba(255,201,60,.42);
  font:800 12px/1 var(--ff);letter-spacing:.28em;text-transform:uppercase;
  color:var(--gold-l,#ffe79a);
  text-shadow:0 2px 0 rgba(8,18,32,.85);
  opacity:0;transform:translateY(6px);
  transition:opacity .3s ease,transform .3s cubic-bezier(.2,.9,.3,1);
}
.fc-layer.on .fc-cap{opacity:1;transform:none}
.fc-num{
  position:relative;min-width:1.1em;text-align:center;
  font:800 124px/1 var(--ff);letter-spacing:.02em;
  color:#fff6dc;
  -webkit-text-stroke:3px rgba(10,20,34,.95);
  paint-order:stroke fill;
  text-shadow:0 7px 0 rgba(10,18,30,.6),0 12px 38px rgba(0,0,0,.7),
              0 0 52px rgba(255,201,60,.6);
}
.fc-num.beat{animation:fcBeat .70s cubic-bezier(.16,.9,.3,1) forwards}
.fc-num.go{color:#ffd75a;-webkit-text-stroke:3px rgba(24,10,2,.95);
  font-size:104px;letter-spacing:.10em;
  text-shadow:0 7px 0 rgba(30,12,2,.6),0 12px 38px rgba(0,0,0,.7),
              0 0 70px rgba(255,201,60,1)}
.fc-num.go.beat{animation:fcGo .62s cubic-bezier(.16,.9,.3,1) forwards}
.fc-ring{
  position:absolute;width:170px;height:170px;border-radius:50%;
  border:3px solid rgba(255,201,60,.75);opacity:0;pointer-events:none;
}
.fc-ring.beat{animation:fcRing .70s ease-out forwards}
/* The numeral holds at full strength for almost the whole beat and only lets go
   at the very end, so at any instant you are looking at a number rather than at
   a number fading out. */
@keyframes fcBeat{
  0%{opacity:0;transform:scale(1.9)}
  18%{opacity:1;transform:scale(.94)}
  32%{transform:scale(1.04)}
  90%{opacity:1;transform:scale(1)}
  100%{opacity:.35;transform:scale(.92)}
}
@keyframes fcGo{
  0%{opacity:0;transform:scale(.5)}
  26%{opacity:1;transform:scale(1.16)}
  46%{transform:scale(1)}
  100%{opacity:0;transform:scale(1.28)}
}
@keyframes fcRing{
  0%{opacity:.85;transform:scale(.35)}
  100%{opacity:0;transform:scale(1.55)}
}
@media (max-height:400px){
  .fc-num{font-size:98px}
  .fc-num.go{font-size:82px}
  .fc-ring{width:140px;height:140px}
  .fc-glow{width:270px;height:270px}
  .fc-cap{font-size:10.5px;letter-spacing:.24em;padding:3px 11px 4px}
}
`;

const NOOP = () => {};

function injectStyle(doc) {
  if (!doc || !doc.head || !doc.createElement) return;
  if (doc.getElementById && doc.getElementById(STYLE_ID)) return;
  const s = doc.createElement('style');
  s.id = STYLE_ID;
  s.textContent = CSS;
  doc.head.appendChild(s);
}

/** The four beats, in order. `t` is seconds from the start of the countdown. */
const BEATS = [
  { t: 0, text: '3', cap: 'Get Ready', go: false },
  { t: BEAT, text: '2', cap: 'Get Ready', go: false },
  { t: BEAT * 2, text: '1', cap: 'Get Ready', go: false },
  { t: BEAT * 3, text: 'GO', cap: 'Settle The Island', go: true }
];

export function createCountdown(state, game, deps) {
  const g = game || {};
  const d = deps || {};
  const warn = typeof d.warn === 'function' ? d.warn : NOOP;
  const sfx = typeof d.sfx === 'function' ? d.sfx : NOOP;

  const doc = (d.root && d.root.ownerDocument)
    || (typeof document !== 'undefined' ? document : null);

  /* ------------------------------------------------------------------ view */

  let layer = null, capEl = null, numEl = null, ringEl = null, glowEl = null;

  if (doc && doc.createElement && d.root && d.root.appendChild) {
    try {
      injectStyle(doc);
      capEl = el('span', { class: 'fc-cap', text: 'Get Ready' });
      numEl = el('b', { class: 'fc-num', text: '' });
      ringEl = el('i', { class: 'fc-ring' });
      glowEl = el('i', { class: 'fc-glow' });
      layer = el('div', { class: 'fc-layer fc-off' }, glowEl, ringEl, capEl, numEl);
      d.root.appendChild(layer);
    } catch (e) {
      warn(e);
      layer = null;
    }
  }

  function show(on) {
    if (!layer) return;
    toggle(layer, 'fc-off', !on);
    if (on) setTimeout(() => toggle(layer, 'on', active), 16);
    else toggle(layer, 'on', false);
  }

  function paint(b) {
    if (!layer) return;
    setText(capEl, b.cap);
    setText(numEl, b.text);
    toggle(numEl, 'go', b.go);
    // Restart the pop on every beat: removing the class and forcing a layout
    // read is the only reliable way to replay a CSS animation.
    for (const n of [numEl, ringEl]) {
      if (!n || !n.classList) continue;
      n.classList.remove('beat');
      void (n.offsetWidth || 0);
      n.classList.add('beat');
    }
  }

  /* ----------------------------------------------------------------- state */

  let active = false;
  let t = 0;
  let index = -1;
  let heldTime = 0;
  let flowDrove = false;

  /* ---------------------------------------------------- the bots' handbrake */

  let realBotUpdate = null;

  function patchBots() {
    const bots = g.bots;
    if (!bots || typeof bots.update !== 'function' || bots.__mfCount) return;
    const original = bots.update;
    realBotUpdate = original;
    bots.__mfCount = true;
    bots.update = function countGate(dt) {
      const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.1) : 1 / 60;
      if (active) {
        // Whoever is stepping the simulation winds this clock. In the real
        // frame loop matchflow got here first, so we only pick up the slack.
        if (!flowDrove) advance(step);
        flowDrove = false;
        holdStill();
        return undefined;
      }
      return original.call(bots, dt);
    };
  }

  function unpatchBots() {
    const bots = g.bots;
    if (!bots || !bots.__mfCount) return;
    if (realBotUpdate) bots.update = realBotUpdate;
    realBotUpdate = null;
    bots.__mfCount = false;
  }

  /** Nobody drifts across the start line — not even by a tenth of a unit. */
  function holdStill() {
    const players = (state && state.players) || [];
    for (const p of players) {
      if (!p || !p.isBot) continue;
      p.vx = 0; p.vz = 0;
      if (p.action === 'run') p.action = 'idle';
    }
    // The match clock starts on GO, not on the last road of the draft.
    if (state && Number.isFinite(heldTime)) state.time = heldTime;
  }

  /* ----------------------------------------------------------------- clock */

  function advance(dt) {
    if (!active) return false;
    t += dt;
    let i = -1;
    for (let k = 0; k < BEATS.length; k++) if (t >= BEATS[k].t) i = k;
    if (i !== index) {
      index = i;
      const b = BEATS[i];
      if (b) {
        paint(b);
        sfx(b.go ? 'horn' : 'blip', { gain: b.go ? 0.85 : 0.6 });
      }
    }
    if (t >= TOTAL) { stop(); return true; }
    return false;
  }

  function stop() {
    if (!active) return;
    active = false;
    show(false);
    unpatchBots();
  }

  /* ------------------------------------------------------------------- api */

  /** Arm the start line. Everything is frozen from this call until GO. */
  function begin() {
    if (active) return TOTAL;
    active = true;
    t = 0;
    index = -1;
    flowDrove = false;
    heldTime = state && Number.isFinite(state.time) ? state.time : 0;
    patchBots();
    show(true);
    paint(BEATS[0]);
    index = 0;
    sfx('blip', { gain: 0.6 });
    return TOTAL;
  }

  /** Returns true on the tick the countdown finishes. */
  function update(dt) {
    if (!active) return false;
    const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.1) : 1 / 60;
    flowDrove = true;
    holdStill();
    return advance(step);
  }

  /** Abandon it — a restart, or the match ending under it. */
  function cancel() {
    if (!active) { unpatchBots(); return; }
    t = TOTAL;
    stop();
  }

  function destroy() {
    cancel();
    unpatchBots();
    if (layer && layer.parentNode) layer.parentNode.removeChild(layer);
    layer = null;
  }

  return {
    begin, update, cancel, destroy,
    get active() { return active; },
    get t() { return t; },
    get total() { return TOTAL; },
    get label() { return active && BEATS[index] ? BEATS[index].text : ''; },
    get hasView() { return !!layer; }
  };
}

export default createCountdown;
