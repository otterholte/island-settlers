/**
 * Island Settlers — the trade approach cue.
 *
 *   createTradeCue(root, state, game) -> { update(dt), destroy() }
 *
 * A quiet hint, not a billboard.
 *
 * This used to be a full banner — heading, both sides of the exchange spelled
 * out in icons, a sub-line, a shimmer burst — floating over the market from
 * anywhere inside TRADE_RADIUS. It was the loudest thing on a screen the player
 * had already called visually busy, and it followed them around a whole hex of
 * grass before they had decided to trade at all.
 *
 * What is left is one navy chip: the key to press, the word, and the rate. It
 * appears only when the settler is standing ON the post's own hex — the desert
 * tile that carries the Great Market, or the coastal tile that owns one of the
 * player's docks — and it says nothing about the deal, because the sheet one
 * keypress away says all of it properly.
 *
 * The cut went one stop too far, though, and the chip is now about half again
 * the size it shrank to:
 *
 *   "Make the press enter to trade on the ports and trading post larger so it's
 *    easier to see."
 *
 * At 9px type on a 26px plate it was legible in a screenshot and easy to run
 * straight past in motion, over a 3D island at play-camera distance. The type
 * carries the fix (9 -> 14px, rate 11 -> 18px, see `.tc-*` in ui-hud.css) and
 * the plate grew to hold it — about 42px tall now, a third of the old banner.
 * It also floats a little higher, because a taller chip hangs lower.
 *
 * Pure DOM. The world-to-screen projection is done by hand off the camera's
 * two matrices so this file stays free of a three.js import.
 *
 * Owner: UI agent.
 */

import { TRADE_BASE, TRADE_RADIUS } from '../core/constants.js';
import { nearestPortFor } from '../core/rules.js';
import { MARKET, DESERT, edges, tileAt } from '../board/layout.js';
import { el, setText, toggle } from './dom.js';

/* How high above the landmark the chip floats, in world units. Still well under
   the old banner, but up a notch with the chip's own height: the card hangs
   DOWNWARD from this point (`translate(-50%,-100%)`), so growing it by 16px
   pushed its bottom edge that much closer to the roof it is labelling. */
const MARKET_LIFT = 6.1;
const PORT_LIFT = 4.9;

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

/** The land hex a dock belongs to — the coastal edge it was built on. */
function portTileId(port) {
  const e = edges[port.edge];
  return e && e.tiles && e.tiles.length ? e.tiles[0] : -1;
}

export function createTradeCue(root, state, game) {
  const me = state.players[0];

  /* ------------------------------------------------------------- scaffold */
  /*
   * `.tc-cta` names the keyboard route, `.tc-rate` the price. Both routes are
   * always live: the chip is a real button, so a thumb opens the same sheet the
   * Enter key does.
   */
  const cta = el('span', { class: 'tc-cta' },
    el('b', { class: 'tc-key', text: 'Enter' }),
    el('i', { text: 'Trade' }));
  const rate = el('span', { class: 'tc-rate', text: `${TRADE_BASE}:1` });

  const card = el('button', {
    class: 'tc-card', type: 'button', 'data-ui': '',
    'aria-label': 'Open trade',
    on: { click: () => open() }
  }, cta, rate);

  /*
   * The wrapper answers to `.prompt` while it is up.
   *
   * "Where can I trade?" is one question with one answer, and the harness (and
   * anything else that goes looking for the standing offer) should find that
   * answer in one place. While this chip is on screen it IS the trade prompt,
   * so it takes the class and sits ahead of the bottom-left chip in document
   * order; the moment it fades the chip is the only `.prompt` again.
   */
  const wrap = el('div', {
    class: 'tradecue hid',
    on: { click: () => open() }
  }, card, el('span', { class: 'tc-pin' }));
  root.insertBefore(wrap, root.firstChild);

  /* ------------------------------------------------------------- contents */

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
    setText(rate, `${next.ratio}:1`);
    toggle(wrap, 'port', port);
    toggle(wrap, 'market', !port);
  }

  function chime() {
    const now = state.time || 0;
    if (now - lastChime < CHIME_GAP) return;
    lastChime = now;
    try {
      const a = game.audio;
      if (a && a.sfx) a.sfx('blip', { gain: 0.26 });
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

  /**
   * What, if anything, the settler is STANDING ON right now.
   *
   * Not "within TRADE_RADIUS" — on the post's own hex. For the market that is
   * the desert tile it was built on; for a dock it is the coastal tile the
   * dock's edge belongs to, and the dock must also be close enough that
   * economy.js will honour the trade, so the chip can never make an offer the
   * rules would then refuse.
   */
  function target() {
    if (state.phase !== 'play') return null;
    const here = tileAt(me.x, me.z);
    if (!here) return null;

    if (here.id === DESERT.id) {
      const a = marketAnchor();
      return { key: 'market', kind: 'market', ratio: TRADE_BASE, ...a };
    }

    const p = nearestPortFor(state, 0, me.x, me.z, TRADE_RADIUS + 3);
    if (p && portTileId(p) === here.id) {
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
    if (s.x < -0.35 || s.x > 1.35 || s.y < -0.5 || s.y > 1.45) {
      toggle(wrap, 'off', true);
      return;
    }
    toggle(wrap, 'off', false);
    // It tracks the building, clamped clear of the two bands it must not
    // cover: the resource pill up top and the build cards along the bottom.
    // The chip hangs upward from its anchor, so the top limit knows its height.
    const ch = card.offsetHeight || 28;
    const top = Math.min(H * 0.72, 74 + ch);
    const px = Math.max(W * 0.14, Math.min(W * 0.86, s.x * W));
    const py = Math.max(top, Math.min(H * 0.7, s.y * H));
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
      wrap.classList.remove('in');
      void wrap.offsetWidth;
      wrap.classList.add('in');
      chime();
      vis = 1; outT = 0;
    } else if (next && cur) {
      cur.x = next.x; cur.y = next.y; cur.z = next.z;
      if (cur.ratio !== next.ratio) { cur.ratio = next.ratio; dress(cur); }
    } else if (!next && vis) {
      vis = 0; outT = 0;
      toggle(wrap, 'out', true);
      toggle(wrap, 'prompt', false);
      wrap.classList.remove('in');
    }

    if (!vis && !wrap.classList.contains('hid')) {
      outT += d;
      if (outT > 0.3) { toggle(wrap, 'hid', true); cur = null; }
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
