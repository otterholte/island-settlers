/**
 * Island Settlers — match-flow interface furniture.
 *
 *   createFlowUI(root, state, game) -> {
 *     showIntro(), hideIntro(), onSkip(fn),
 *     showDraft(), setDraft({ index, need, pid, status, sub, tip }), hideDraft(),
 *     showObjective(title, sub, seconds), hideObjective(),
 *     update(dt), destroy()
 *   }
 *
 * Three pieces of chrome that no other module owns: the match intro card, the
 * opening-draft order strip, and the objective card that fades as play begins.
 * Everything else the flow needs to say goes through `hud.announce` /
 * `hud.toast` / `overview.open`, which already exist.
 *
 * Styling matches src/ui/ui.css (cream #f6e7c6 panels with brown #5a3a1e
 * outlines, navy glass status bars, gold #ffc93c accents) but lives in its own
 * injected stylesheet so ui.css — owned by the UI agent — is never touched.
 * Containers are pointer-events:none; only the skip button carries `data-ui`.
 *
 * Headless-safe: with no usable `document` every method is a no-op.
 *
 * Owner: Flow agent.
 */

import { VICTORY_POINTS, BOT_PROFILES } from '../core/constants.js';
import { el, button, toggle, setText } from '../ui/dom.js';
import { icon } from '../ui/icons.js';

const STYLE_ID = 'mf-flow-style';

const CSS = `
.mf-hid{display:none !important}
.mf-layer{position:absolute;inset:0;pointer-events:none}

/* ------------------------------------------------------------- intro card */
.mf-intro{
  position:absolute;inset:0;pointer-events:none;
  display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;
  padding:calc(10px + var(--sat,0px)) calc(10px + var(--sar,0px))
          calc(10px + var(--sab,0px)) calc(10px + var(--sal,0px));
  background:radial-gradient(125% 92% at 50% 42%,rgba(8,32,60,.30),rgba(4,14,28,.88));
  opacity:0;transition:opacity .55s ease;
}
.mf-intro.on{opacity:1}
.mf-i-crest{
  font:800 12px/1 var(--ff);letter-spacing:.66em;text-indent:.66em;
  text-transform:uppercase;color:var(--gold-l,#ffe79a);
  text-shadow:0 2px 8px rgba(0,0,0,.7);
}
.mf-i-title{
  margin:-4px 0 2px;
  font:800 clamp(30px,7.4vw,60px)/1 var(--ff);letter-spacing:.12em;
  text-transform:uppercase;color:#fff;
  -webkit-text-stroke:2px rgba(12,20,34,.92);
  text-shadow:0 4px 0 rgba(10,18,30,.62),0 12px 30px rgba(0,0,0,.65),
              0 0 36px rgba(255,201,60,.42);
}
.mf-i-obj{
  display:inline-flex;align-items:center;gap:7px;padding:5px 17px 6px;border-radius:999px;
  background:linear-gradient(180deg,#1b4a7e,#0c203a 72%);
  border:2px solid rgba(255,201,60,.55);
  font:800 11px/1 var(--ff);letter-spacing:.2em;text-transform:uppercase;
  color:var(--gold,#ffc93c);
  box-shadow:0 6px 16px rgba(0,0,0,.5),inset 0 2px 0 rgba(255,255,255,.16);
}
.mf-i-row{display:flex;gap:8px;margin-top:5px;max-width:96vw}
.mf-cmp{
  flex:0 1 auto;display:flex;flex-direction:column;align-items:center;gap:4px;
  width:min(22vw,152px);padding:8px 8px 9px;border-radius:13px;
  background:linear-gradient(180deg,#fdf5e2 0%,#f6e7c6 40%,#e6d6b2 100%);
  border:2px solid #5a3a1e;
  box-shadow:0 5px 0 rgba(90,58,30,.55),0 11px 22px rgba(0,0,0,.46),
             inset 0 2px 0 rgba(255,255,255,.7);
  opacity:0;transform:translateY(16px) scale(.96);
  transition:opacity .34s ease,transform .34s cubic-bezier(.2,1.3,.35,1);
}
.mf-cmp.in{opacity:1;transform:none}
.mf-cmp.you{border-color:#3b7fd4;box-shadow:0 5px 0 rgba(37,90,157,.6),
  0 11px 22px rgba(0,0,0,.46),inset 0 2px 0 rgba(255,255,255,.7)}
.mf-cmp .chip{width:22px;height:22px;border-radius:8px}
.mf-c-name{font:800 12.5px/1 var(--ff);letter-spacing:.09em;text-transform:uppercase;color:#3a2208}
.mf-c-desc{font:700 8.5px/1.3 var(--ff);letter-spacing:.06em;text-transform:uppercase;
  color:#7a5228;text-align:center}
.mf-i-foot{display:flex;align-items:center;gap:10px;margin-top:7px}
.mf-i-hint{font:700 9px/1 var(--ff);letter-spacing:.18em;text-transform:uppercase;
  color:rgba(196,220,245,.6)}

/* ------------------------------------------------------------ draft strip */
.mf-draft{
  position:absolute;left:calc(10px + var(--sal,0px));bottom:calc(10px + var(--sab,0px));
  display:flex;flex-direction:column;gap:5px;padding:8px 12px 9px;
  max-width:min(54vw,430px);
  background:var(--navy,rgba(12,32,58,.86));
  border:1.5px solid rgba(255,201,60,.34);border-radius:14px;
  box-shadow:0 8px 22px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.12);
  backdrop-filter:blur(7px);-webkit-backdrop-filter:blur(7px);
  opacity:0;transform:translateY(14px);
  transition:opacity .3s ease,transform .3s cubic-bezier(.2,.9,.3,1);
}
.mf-draft.on{opacity:1;transform:none}
.mf-d-head{display:flex;align-items:baseline;gap:8px}
.mf-d-head b{font:800 10px/1 var(--ff);letter-spacing:.2em;text-transform:uppercase;
  color:var(--gold-l,#ffe79a)}
.mf-d-head i{font:700 8.5px/1 var(--ff);font-style:normal;letter-spacing:.14em;
  text-transform:uppercase;color:rgba(190,214,240,.68)}
.mf-d-order{display:flex;align-items:center;gap:5px;height:22px}
.mf-pip{
  width:15px;height:15px;border-radius:5px;flex:0 0 auto;
  border:1.5px solid rgba(0,0,0,.55);
  background:linear-gradient(160deg,var(--cl,#7fb2f0),var(--c,#3b7fd4) 62%);
  box-shadow:inset 0 2px 0 rgba(255,255,255,.42);
  opacity:.3;transition:opacity .2s ease,transform .2s cubic-bezier(.2,1.4,.4,1);
}
.mf-pip.done{opacity:.75}
.mf-pip.now{opacity:1;transform:scale(1.34);animation:mfPip 1.1s ease-in-out infinite}
@keyframes mfPip{
  0%,100%{box-shadow:0 0 0 2px rgba(255,201,60,.8),0 0 10px rgba(255,201,60,.45),
    inset 0 2px 0 rgba(255,255,255,.42)}
  50%{box-shadow:0 0 0 3px rgba(255,201,60,1),0 0 18px rgba(255,201,60,.9),
    inset 0 2px 0 rgba(255,255,255,.42)}
}
.mf-d-turn{display:flex;align-items:center;gap:7px;min-height:17px}
.mf-d-turn .chip{width:14px;height:14px;border-radius:5px;border-width:1.5px}
.mf-d-turn b{font:800 12.5px/1 var(--ff);letter-spacing:.08em;text-transform:uppercase;
  color:var(--tc,#fff);text-shadow:0 1px 2px rgba(0,0,0,.65)}
.mf-d-turn span{font:700 9px/1 var(--ff);letter-spacing:.12em;text-transform:uppercase;
  color:rgba(196,220,245,.8)}
.mf-d-tip{font:400 10px/1.35 var(--ff);color:rgba(224,236,248,.78)}
.mf-d-tip:empty{display:none}

/* --------------------------------------------------------- objective card */
.mf-obj{
  position:absolute;left:50%;top:57%;
  display:flex;flex-direction:column;align-items:center;gap:3px;
  padding:9px 26px 11px;border-radius:16px;
  background:linear-gradient(180deg,#fdf5e2 0%,#f6e7c6 42%,#e6d6b2 100%);
  border:2px solid #5a3a1e;
  box-shadow:0 6px 0 rgba(90,58,30,.5),0 14px 28px rgba(0,0,0,.5),
             inset 0 2px 0 rgba(255,255,255,.72);
  opacity:0;transform:translate(-50%,10px) scale(.94);
  transition:opacity .4s ease,transform .4s cubic-bezier(.2,1.2,.35,1);
}
.mf-obj.on{opacity:1;transform:translate(-50%,-4px) scale(1)}
.mf-obj b{font:800 17px/1 var(--ff);letter-spacing:.09em;text-transform:uppercase;color:#3a2208}
.mf-obj span{font:700 9px/1 var(--ff);letter-spacing:.18em;text-transform:uppercase;color:#7a5228}

@media (max-height:400px){
  .mf-i-row{gap:6px}
  .mf-cmp{width:min(21vw,132px);padding:6px 6px 7px}
  .mf-c-desc{font-size:8px}
  .mf-draft{max-width:min(50vw,360px);padding:6px 10px 7px}
}
`;

const NOOP = () => {};

function stubUI() {
  return {
    showIntro: NOOP, hideIntro: NOOP, onSkip: NOOP,
    showDraft: NOOP, setDraft: NOOP, hideDraft: NOOP,
    showObjective: NOOP, hideObjective: NOOP,
    update: NOOP, destroy: NOOP,
    get introOpen() { return false; }
  };
}

function injectStyle(doc) {
  if (!doc || !doc.head || !doc.createElement) return;
  if (doc.getElementById && doc.getElementById(STYLE_ID)) return;
  const s = doc.createElement('style');
  s.id = STYLE_ID;
  s.textContent = CSS;
  doc.head.appendChild(s);
}

export function createFlowUI(root, state, game) {
  const doc = (root && root.ownerDocument)
    || (typeof document !== 'undefined' ? document : null);
  if (!doc || !doc.createElement || !root || !root.appendChild) return stubUI();

  let layer;
  try {
    injectStyle(doc);

    /* ------------------------------------------------------------- intro */
    const cards = state.players.map(p => {
      const profile = BOT_PROFILES.find(b => b.id === p.id);
      const desc = p.id === 0 ? 'Your island to claim' : (profile ? profile.desc : 'Rival settler');
      return el('div', {
        class: 'mf-cmp' + (p.id === 0 ? ' you' : ''),
        style: { '--c': p.color.css, '--cl': p.color.light }
      },
        el('span', { class: 'chip', style: { '--c': p.color.css, '--cl': p.color.light } }),
        el('b', { class: 'mf-c-name', text: p.name }),
        el('span', { class: 'mf-c-desc', text: desc }));
    });

    const skipBtn = button('gold', {
      on: { click: () => fireSkip() }
    }, el('span', { class: 'sb-lab', text: 'Begin the Draft' }));

    const intro = el('div', { class: 'mf-intro mf-hid' },
      el('div', { class: 'mf-i-crest', text: 'Island' }),
      el('div', { class: 'mf-i-title', text: 'Settlers' }),
      el('div', { class: 'mf-i-obj', html: icon('trophy', 15) },
        el('span', { text: `First to ${VICTORY_POINTS} Points` })),
      el('div', { class: 'mf-i-row' }, cards),
      el('div', { class: 'mf-i-foot' },
        skipBtn,
        el('span', { class: 'mf-i-hint', text: 'Snake draft · 2 picks each' })));

    /* -------------------------------------------------------- draft strip */
    const order = Array.isArray(state.setupOrder) && state.setupOrder.length
      ? state.setupOrder : [0, 1, 2, 3, 3, 2, 1, 0];
    const pips = order.map(pid => {
      const c = state.players[pid] ? state.players[pid].color : { css: '#888', light: '#bbb' };
      return el('span', { class: 'mf-pip', style: { '--c': c.css, '--cl': c.light } });
    });

    const roundEl = el('i', { text: 'Round 1 of 2' });
    const orderRow = el('div', { class: 'mf-d-order' }, pips);
    const turnChip = el('span', { class: 'chip', style: { '--c': '#3b7fd4', '--cl': '#7fb2f0' } });
    const turnName = el('b', { text: '' });
    const turnWhat = el('span', { text: '' });
    const tipEl = el('div', { class: 'mf-d-tip', text: '' });

    const draft = el('div', { class: 'mf-draft mf-hid' },
      el('div', { class: 'mf-d-head' },
        el('b', { text: 'Opening Draft' }), roundEl),
      orderRow,
      el('div', { class: 'mf-d-turn' }, turnChip, turnName, turnWhat),
      tipEl);

    /* ----------------------------------------------------- objective card */
    const objTitle = el('b', { text: '' });
    const objSub = el('span', { text: '' });
    const objective = el('div', { class: 'mf-obj mf-hid' }, objTitle, objSub);

    layer = el('div', { class: 'mf-layer' }, intro, draft, objective);
    root.appendChild(layer);

    /* -------------------------------------------------------------- logic */
    let skipFn = null;
    let introOn = false;
    let objT = 0;
    let staggerTimers = [];

    function fireSkip() {
      if (typeof skipFn === 'function') { try { skipFn(); } catch (e) { /* ignore */ } }
    }

    function clearStagger() {
      for (const t of staggerTimers) clearTimeout(t);
      staggerTimers = [];
    }

    function showIntro() {
      if (introOn) return;
      introOn = true;
      toggle(intro, 'mf-hid', false);
      staggerTimers.push(setTimeout(() => toggle(intro, 'on', introOn), 20));
      cards.forEach((c, i) => {
        toggle(c, 'in', false);
        staggerTimers.push(setTimeout(() => toggle(c, 'in', introOn), 420 + i * 150));
      });
    }

    function hideIntro() {
      if (!introOn) return;
      introOn = false;
      clearStagger();
      toggle(intro, 'on', false);
      staggerTimers.push(setTimeout(() => toggle(intro, 'mf-hid', !introOn), 560));
    }

    let draftOn = false;

    function showDraft() {
      if (draftOn) return;
      draftOn = true;
      toggle(draft, 'mf-hid', false);
      setTimeout(() => toggle(draft, 'on', draftOn), 20);
    }

    function hideDraft() {
      if (!draftOn) return;
      draftOn = false;
      toggle(draft, 'on', false);
      setTimeout(() => toggle(draft, 'mf-hid', !draftOn), 340);
    }

    function setDraft(info) {
      const o = info || {};
      const idx = Number.isFinite(o.index) ? o.index : 0;
      pips.forEach((pip, i) => {
        toggle(pip, 'done', i < idx);
        toggle(pip, 'now', i === idx);
      });
      setText(roundEl, `Round ${idx >= order.length / 2 ? 2 : 1} of 2 · Pick ${Math.min(idx + 1, order.length)} of ${order.length}`);

      const p = state.players[o.pid];
      if (p && turnChip.style) {
        turnChip.style.setProperty('--c', p.color.css);
        turnChip.style.setProperty('--cl', p.color.light);
      }
      if (p && turnName.style) turnName.style.setProperty('--tc', p.color.light);
      setText(turnName, o.status || (p ? p.name : ''));
      setText(turnWhat, o.sub || '');
      setText(tipEl, o.tip || '');
    }

    function showObjective(title, sub, seconds) {
      setText(objTitle, title || '');
      setText(objSub, sub || '');
      toggle(objective, 'mf-hid', false);
      setTimeout(() => toggle(objective, 'on', objT > 0), 20);
      objT = Number.isFinite(seconds) ? seconds : 2.8;
    }

    function hideObjective() {
      if (objT <= 0) return;
      objT = 0;
      toggle(objective, 'on', false);
      setTimeout(() => toggle(objective, 'mf-hid', objT <= 0), 460);
    }

    function update(dt) {
      const d = Number.isFinite(dt) ? dt : 1 / 60;
      if (objT > 0) {
        objT -= d;
        if (objT <= 0) { objT = 0.0001; hideObjective(); }
      }
    }

    function destroy() {
      clearStagger();
      if (layer && layer.parentNode) layer.parentNode.removeChild(layer);
    }

    return {
      showIntro, hideIntro,
      onSkip(fn) { skipFn = fn; },
      showDraft, setDraft, hideDraft,
      showObjective, hideObjective,
      update, destroy,
      get introOpen() { return introOn; },
      get root() { return layer; }
    };
  } catch (err) {
    if (layer && layer.parentNode) layer.parentNode.removeChild(layer);
    if (typeof console !== 'undefined') console.warn('[flow] UI unavailable —', err.message);
    return stubUI();
  }
}

export default createFlowUI;
