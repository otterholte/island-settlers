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

import { el, toggle, setText } from '../ui/dom.js';
import { keyNav } from '../ui/kbnav.js';
import { buildIntro, INTRO_CSS, FRIENDS_EVENT } from './flowIntro.js';

const STYLE_ID = 'mf-flow-style';

const CSS = INTRO_CSS + `
.mf-hid{display:none !important}
.mf-layer{position:absolute;inset:0;pointer-events:none}

/* ------------------------------------------------------------ draft strip */
/* The fallback strip. When the board map is up — which is every draft that
   has an interface — overview.js carries the order in its rail instead, and
   this stays hidden. It exists for a build with no map to stand in. */
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
.mf-pip.mine{box-shadow:0 0 0 1.5px rgba(255,201,60,.85),inset 0 2px 0 rgba(255,255,255,.42)}
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

@media (max-height:500px),(max-width:1023px){
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
    const built = buildIntro(state, () => fireSkip());
    const intro = built.node;
    const cards = built.cards;

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

    /* ------------------------------------------------------ keyboard menus
     *
     *   "The up down left and right arrow keys all work to navigate any page
     *    I'm on to all of the different buttons on all of the different
     *    screens including the menus, settings, match setup, etc."
     *
     * Four scopes, in modal order. Each one is a node that is either on screen
     * or is not — `ui/kbnav.js` re-reads that on every key, so nothing here
     * has to tell it when a view changes. The FIRST control of each is the one
     * the cursor lands on the moment the screen appears, which is where PLAY
     * being pre-selected on the title screen comes from.
     */
    const nav = keyNav();
    const homeView = intro.querySelector('.mf-home');
    const setupView = intro.querySelector('.mf-setup');
    const offScopes = [];
    if (homeView) {
      offScopes.push(nav.registerScope({
        node: homeView, priority: 10,
        isOpen: () => introOn,
        first: () => built.playBtn
      }));
    }
    if (setupView) {
      offScopes.push(nav.registerScope({
        node: setupView, priority: 10,
        isOpen: () => introOn,
        first: () => built.startBtn,
        // Back out of Match Setup rather than doing nothing, so Escape is the
        // way out of every screen in the game and not only most of them.
        onEscape: () => { if (built.backBtn) built.backBtn.click(); }
      }));
    }
    if (built.settingsPanel) {
      offScopes.push(nav.registerScope({
        node: built.settingsPanel, priority: 30,
        isOpen: () => introOn,
        onEscape: () => built.showSettings(false)
      }));
    }

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
      // The opening screen has two views now, and an in-place replay re-shows
      // this same node — so come back on HOME rather than on whatever panel
      // the last match was started from.
      if (built.reset) built.reset();
      // The in-match HUD has nothing to say before the match exists, and it
      // was reading straight through the title. ui.css fades everything in
      // the interface layer except this one while the class is set.
      toggle(root, 'mf-introlive', true);
      toggle(intro, 'mf-hid', false);
      staggerTimers.push(setTimeout(() => toggle(intro, 'on', introOn), 20));
      cards.forEach((c, i) => {
        toggle(c, 'in', false);
        staggerTimers.push(setTimeout(() => toggle(c, 'in', introOn), 300 + i * 120));
      });
    }

    function hideIntro() {
      if (!introOn) return;
      introOn = false;
      clearStagger();
      toggle(root, 'mf-introlive', false);
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
      // The seating is shuffled per match and reshuffled on a replay, so the
      // pip colours are re-read from the live order rather than baked at
      // construction. The human's slots keep a gold outline.
      const live = Array.isArray(state.setupOrder) && state.setupOrder.length
        ? state.setupOrder : order;
      pips.forEach((pip, i) => {
        const pid = live[i];
        const pl = state.players[pid];
        if (pl && pip.style) {
          pip.style.setProperty('--c', pl.color.css);
          pip.style.setProperty('--cl', pl.color.light);
        }
        toggle(pip, 'mine', pid === 0);
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
      for (const off of offScopes) { try { off(); } catch (e) { /* gone already */ } }
      offScopes.length = 0;
      toggle(root, 'mf-introlive', false);
      if (typeof document !== 'undefined' && document.removeEventListener) {
        document.removeEventListener(FRIENDS_EVENT, openFriends);
      }
      if (friends && friends.destroy) { try { friends.destroy(); } catch (e) { /* fine */ } }
      if (layer && layer.parentNode) layer.parentNode.removeChild(layer);
    }

    /* ------------------------------------------------------ play with friends
       The third view, built the first time somebody asks for it and never
       before: it opens a websocket, and a player who only ever plays alone
       should not have one opened on their behalf. Loaded dynamically for the
       same reason — the whole net layer stays off the critical path of a solo
       boot. The opening screen raises a document event rather than calling
       anything, exactly as TUTORIAL does. */
    let friends = null;
    let friendsLoading = false;

    async function openFriends() {
      if (friends) { toggle(intro, 'mf-hid', true); friends.show(); return; }
      if (friendsLoading) return;
      friendsLoading = true;
      try {
        const [{ createRooms }, { netClient }] = await Promise.all([
          import('../ui/rooms.js'),
          import('../net/client.js')
        ]);
        friends = createRooms(layer, {
          client: netClient(),
          // START does not draw anything: the server begins the match once the
          // last player has pressed it, and netmatch.js parks it and reloads
          // the page into the right island.
          onClose: () => { friends.hide(); toggle(intro, 'mf-hid', !introOn); }
        });
        /* The friends panel throws its own body away and rebuilds it on every
           socket push, so the navigator is told to look at the wrapper and
           re-find the cursor rather than being handed any control inside it. */
        offScopes.push(nav.registerScope({
          node: friends.node, priority: 40,
          /* The panel names its own main control per screen — JOIN A ROOM on
             the choice, JOIN on the code box, START in the lobby — because
             the wrapper's first control is the X in the corner, and landing
             the cursor on the way out of a screen is not a default worth
             having. */
          first: () => friends.primary,
          /* One step back, then out. See `back()` in ui/rooms.js. */
          onEscape: () => {
            if (friends.back && friends.back()) return;
            friends.hide();
            toggle(intro, 'mf-hid', !introOn);
          }
        }));
        toggle(intro, 'mf-hid', true);
        friends.show();
      } catch (err) {
        if (typeof console !== 'undefined') console.warn('[flow] room screen —', err.message);
        if (built.nudgeFriends) {
          built.nudgeFriends('Multiplayer could not load — check your connection and reload.');
        }
      } finally {
        friendsLoading = false;
      }
    }

    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener(FRIENDS_EVENT, openFriends);
    }

    return {
      showIntro, hideIntro,
      onSkip(fn) { skipFn = fn; },
      showDraft, setDraft, hideDraft,
      showObjective, hideObjective,
      openFriends,
      update, destroy,
      get introOpen() { return introOn; },
      get friendsOpen() { return !!(friends && friends.node && !friends.node.classList.contains('hid')); },
      get root() { return layer; }
    };
  } catch (err) {
    if (layer && layer.parentNode) layer.parentNode.removeChild(layer);
    if (typeof console !== 'undefined') console.warn('[flow] UI unavailable —', err.message);
    return stubUI();
  }
}

export default createFlowUI;
