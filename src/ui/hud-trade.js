/**
 * Island Settlers — the trade approach cue.
 *
 *   createTradeCue(root, state, game) -> { update(dt), destroy() }
 *
 * Walking up to the Great Market used to produce a 44px chip in the bottom-left
 * corner, behind the thumb, saying "Open Market · Trade 4 : 1". Nobody read it.
 *
 * This puts the offer where the offer is: a banner that rises out of the
 * trading post itself, anchored to the landmark in world space and projected to
 * screen every frame, with the ratio spelled out in objects rather than words,
 * a shimmer as it lands and a sound cue. It fades out the moment you walk away
 * and it is never on screen otherwise.
 *
 * Pure DOM. The world-to-screen projection is done by hand off the camera's
 * two matrices so this file stays free of a three.js import.
 *
 * Owner: UI agent.
 */

import { RES, RES_LABEL, TRADE_RADIUS } from '../core/constants.js';
import { nearestPortFor } from '../core/rules.js';
import { MARKET } from '../board/layout.js';
import { el, setText, toggle } from './dom.js';
import { icon, resIcon } from './icons.js';

/* How high above the landmark the banner floats, in world units. */
const MARKET_LIFT = 4.6;
const PORT_LIFT = 3.4;

/** Don't re-chime for the same place more often than this. */
const CHIME_GAP = 8;

/**
 * World point -> normalised screen point, straight off the camera matrices.
 * Returns null when the point is behind the eye.
 */
function project(cam, x, y, z) {
  const v = cam.matrixWorldInverse && cam.matrixWorldInverse.elements;
  const p = cam.projectionMatrix && cam.projectionMatrix.elements;
  if (!v || !p) return null;
  const ax = v[0] * x + v[4] * y + v[8] * z + v[12];
  const ay = v[1] * x + v[5] * y + v[9] * z + v[13];
  const az = v[2] * x + v[6] * y + v[10] * z + v[14];
  const aw = v[3] * x + v[7] * y + v[11] * z + v[15];
  const cx = p[0] * ax + p[4] * ay + p[8] * az + p[12] * aw;
  const cy = p[1] * ax + p[5] * ay + p[9] * az + p[13] * aw;
  const cw = p[3] * ax + p[7] * ay + p[11] * az + p[15] * aw;
  if (!(cw > 0.0001)) return null;
  return { x: (cx / cw) * 0.5 + 0.5, y: 0.5 - (cy / cw) * 0.5 };
}

export function createTradeCue(root, state, game) {
  const me = state.players[0];

  /* ------------------------------------------------------------- scaffold */
  const head = el('b', { class: 'tc-head', text: '' });

  const giveN = el('b', { text: '4' });
  const giveIco = el('span', { class: 'tc-row' });
  const getN = el('b', { text: '1' });
  const getIco = el('span', { class: 'tc-row' });

  const deal = el('span', { class: 'tc-deal' },
    el('span', { class: 'tc-side give' },
      el('span', { class: 'tc-tag', text: 'GIVE' }),
      el('span', { class: 'tc-num' }, giveN, giveIco)),
    el('span', { class: 'tc-arrow', html: icon('swap', 22) }),
    el('span', { class: 'tc-side get' },
      el('span', { class: 'tc-tag', text: 'GET' }),
      el('span', { class: 'tc-num' }, getN, getIco))
  );

  const sub = el('span', { class: 'tc-sub', text: '' });
  const cta = el('span', { class: 'tc-cta', text: 'TAP TO TRADE' });

  const card = el('button', {
    class: 'tc-card', type: 'button', 'data-ui': '',
    'aria-label': 'Open trade',
    on: { click: () => open() }
  }, head, deal, sub, cta);

  const spark = el('span', { class: 'tc-spark' });
  for (let i = 0; i < 10; i++) {
    spark.appendChild(el('i', {
      style: { '--a': (i * 36) + 'deg', '--d': (i * 34) + 'ms' }
    }));
  }

  /*
   * The wrapper answers to `.prompt` while it is up.
   *
   * "Where can I trade?" is one question with one answer, and the harness (and
   * anything else that goes looking for the standing offer) should find that
   * answer in one place. While this banner is on screen it IS the trade prompt,
   * so it takes the class and sits ahead of the bottom-left chip in document
   * order; the moment it fades the chip is the only `.prompt` again.
   */
  const wrap = el('div', {
    class: 'tradecue hid',
    on: { click: () => open() }
  }, spark, card, el('span', { class: 'tc-stem' }), el('span', { class: 'tc-pin' }));
  root.insertBefore(wrap, root.firstChild);

  /* ------------------------------------------------------------- contents */
  const ICO_PX = 19;

  function fillRow(node, list) {
    node.innerHTML = list.map(r => icon(resIcon(r), ICO_PX)).join('');
  }

  let cur = null;         // { key, kind, ratio, portId, x, y, z }
  let vis = 0;            // 0 hidden, 1 shown
  let outT = 0;
  let lastChime = -99;

  function open() {
    if (!cur) return;
    game.openTrade(cur.kind === 'port' ? cur.portId : null);
  }

  function dress(next) {
    const port = next.kind === 'port';
    setText(head, port
      ? (next.resource ? `${RES_LABEL[next.resource]} dock` : 'Your dock')
      : 'Great Market');
    setText(giveN, String(next.ratio));
    setText(getN, '1');
    // Give side: the resource the dock specialises in, or "anything".
    fillRow(giveIco, port && next.resource ? [next.resource] : RES);
    fillRow(getIco, RES);
    setText(sub, port && next.resource
      ? `${next.ratio} ${RES_LABEL[next.resource].toLowerCase()} for any one you need`
      : `${next.ratio} of anything for the one you need`);
    toggle(wrap, 'port', port);
    toggle(wrap, 'market', !port);
  }

  function chime(kind) {
    const now = state.time || 0;
    if (now - lastChime < CHIME_GAP) return;
    lastChime = now;
    try {
      const a = game.audio;
      if (a && a.sfx) a.sfx(kind === 'port' ? 'card' : 'award', { gain: kind === 'port' ? 0.5 : 0.42 });
    } catch (e) { /* audio is optional */ }
  }

  /* ---------------------------------------------------------------- logic */

  function marketAnchor() {
    const m = game.world && game.world.market;
    const base = m && m.group ? m.group.position : null;
    return {
      x: base ? base.x : MARKET.x,
      y: (base ? base.y : 0) + MARKET_LIFT,
      z: base ? base.z : MARKET.z
    };
  }

  function portAnchor(id) {
    const pv = game.world && game.world.portsView;
    const a = pv && pv.anchors ? pv.anchors[id] : null;
    if (!a) return null;
    return { x: a.x, y: a.y + PORT_LIFT, z: a.z };
  }

  /** What, if anything, is within reach right now. */
  function target() {
    if (state.phase !== 'play') return null;
    const dm = Math.hypot(me.x - MARKET.x, me.z - MARKET.z);
    if (dm < TRADE_RADIUS + (MARKET.radius || 0)) {
      const a = marketAnchor();
      return { key: 'market', kind: 'market', ratio: 4, ...a };
    }
    const p = nearestPortFor(state, 0, me.x, me.z, TRADE_RADIUS + 3);
    if (p) {
      const a = portAnchor(p.id);
      if (a) {
        return {
          key: 'port' + p.id, kind: 'port', ratio: p.ratio,
          portId: p.id, resource: p.resource, ...a
        };
      }
    }
    return null;
  }

  function camera() {
    const c = game.camera;
    if (c && c.camera) return c.camera;
    if (c && c.projectionMatrix) return c;
    return (game.world && game.world.camera && game.world.camera.camera) || null;
  }

  function overviewOpen() {
    try { return !!(game.overview && game.overview.isOpen); } catch (e) { return false; }
  }

  function place() {
    const cam = camera();
    if (!cur || !cam) { toggle(wrap, 'off', true); return; }
    const s = project(cam, cur.x, cur.y, cur.z);
    if (!s) { toggle(wrap, 'off', true); return; }
    const W = root.clientWidth || window.innerWidth || 960;
    const H = root.clientHeight || window.innerHeight || 444;
    // Keep the banner on screen without ever letting it wander off its anchor:
    // clamped to a generous margin, and hidden outright once the market is
    // well behind the camera.
    if (s.x < -0.35 || s.x > 1.35 || s.y < -0.5 || s.y > 1.45) {
      toggle(wrap, 'off', true);
      return;
    }
    toggle(wrap, 'off', false);
    // It tracks the building. The only limits are the two bands it must not
    // cover: the resource pill up top and the build cards along the bottom.
    // The banner hangs upward from its anchor, so the top limit has to know how
    // tall the card actually is.
    const ch = card.offsetHeight || 92;
    const top = Math.min(H * 0.72, 96 + ch);
    let px = Math.max(W * 0.17, Math.min(W * 0.83, s.x * W));
    const py = Math.max(top, Math.min(H * 0.68, s.y * H));
    // Riding the top guard means the market is off past the horizon; pull the
    // banner into the middle third so it never lands under the identity chip
    // or the standings.
    if (py - ch < 124) px = Math.min(Math.max(px, W * 0.34), W * 0.66);
    wrap.style.transform = `translate(${px.toFixed(1)}px,${py.toFixed(1)}px)`;
  }

  /* ----------------------------------------------------------------- loop */

  function update(dt) {
    const d = Number.isFinite(dt) ? dt : 1 / 60;
    const next = overviewOpen() ? null : target();

    if (next && (!cur || cur.key !== next.key)) {
      cur = next;
      dress(next);
      toggle(wrap, 'hid', false);
      toggle(wrap, 'out', false);
      toggle(wrap, 'prompt', true);
      // restart the entrance + shimmer
      wrap.classList.remove('in');
      void wrap.offsetWidth;
      wrap.classList.add('in');
      chime(next.kind);
      vis = 1; outT = 0;
    } else if (next && cur) {
      cur.x = next.x; cur.y = next.y; cur.z = next.z;
    } else if (!next && vis) {
      vis = 0; outT = 0;
      toggle(wrap, 'out', true);
      toggle(wrap, 'prompt', false);
      wrap.classList.remove('in');
    }

    if (!vis && !wrap.classList.contains('hid')) {
      outT += d;
      if (outT > 0.42) { toggle(wrap, 'hid', true); cur = null; }
    }

    if (vis && cur) place();
  }

  return {
    update,
    get node() { return wrap; },
    destroy() { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); }
  };
}

export default createTradeCue;
