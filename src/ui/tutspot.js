/**
 * Island Settlers — the practice run's hex spotlight.
 *
 *   createSpotlight(app) -> { set(shape), clear(), destroy(), get on() }
 *
 * WHY THIS EXISTS AT ALL, since the island already has an ownership read.
 *
 *   "For step 3 of the tutorial mention the hexes that you can pick up
 *    resources from have the glowing around them — actually point out clearly
 *    and minimally to all three, while actually increasing the darkness level
 *    of the other hexes you can't pick up from, at least during the tutorial.
 *    But just highlight one hex for the sake of learning."
 *
 * The glow is REAL and it is already there. `src/world/mood.js` polls
 * `canGatherTile(state, 0, id)` every 60ms and eases each hex's `own` toward 1
 * or 0; the terrain shader turns that into a warm sunlit lift on the hexes you
 * may work and a duotone mute on the ones you may not, and `src/world/regions.js`
 * hangs the blue rim and the standing light wall off the very same number. So
 * the tutorial does not need to invent a highlight — it needs to POINT AT the
 * one the game already draws, and it needs the contrast between the two states
 * turned up for the length of one lesson.
 *
 * Turning it up in the shader is not available: both files belong to the World
 * agent this week, the mute is a hard-coded curve in a GLSL chunk, and `tone`
 * is already pinned at -1 on an unowned hex, so there is no dial to turn. What
 * IS available is the space in front of it. This is a screen-space wash — one
 * canvas, inserted BEFORE `#ui` so the whole heads-up display stays crisp on
 * top of it — with a soft hole punched over each hex the player may collect
 * from. The hexes that were muted go a further step down; the three that glow
 * come through at full strength and are the only bright things left on screen.
 *
 * It is drawn rather than masked because `mask-composite: intersect` is the
 * only CSS route to several holes in one wash and support for it is younger
 * than the phones this game ships against. A canvas with `destination-out` is
 * the same picture, everywhere, in about twenty lines.
 *
 * Nothing here knows what a hex is: `set()` takes screen circles in CSS pixels
 * and systems/tutorial.js does the projection, exactly as it already does for
 * the coach's marker.
 *
 * Owner: Tutorial (flow) agent.
 */

/** How dark the wash gets over ground the player may not work. */
const WASH = 'rgba(3, 12, 26, 0.58)';

/** The gold pip that names a workable hex, and its dark keyline. */
const PIP = '#ffc93c';
const PIP_KEY = 'rgba(8, 16, 28, 0.9)';

export function createSpotlight(app) {
  if (!app || !app.appendChild || typeof document === 'undefined') {
    const noop = () => {};
    return { set: noop, clear: noop, destroy: noop, get on() { return false; } };
  }

  const cv = document.createElement('canvas');
  cv.className = 'tut-spot';
  cv.setAttribute('aria-hidden', 'true');
  /* Inserted in front of the WebGL canvas and behind `#ui`. The heads-up
     display must not dim with the island — the badge, the pack and the build
     keys are the things the player is being asked to read. */
  const ui = document.getElementById('ui');
  if (ui && ui.parentNode === app) app.insertBefore(cv, ui);
  else app.appendChild(cv);

  let shape = null;       // { holes:[{x,y,r}], pips:[{x,y}] }
  let w = 0, h = 0, dpr = 1;
  let fade = 0;           // 0..1, eased so the island does not snap dark

  function resize() {
    const nw = app.clientWidth || window.innerWidth;
    const nh = app.clientHeight || window.innerHeight;
    const nd = Math.min(window.devicePixelRatio || 1, 2);
    if (nw === w && nh === h && nd === dpr) return;
    w = nw; h = nh; dpr = nd;
    cv.width = Math.max(1, Math.round(w * dpr));
    cv.height = Math.max(1, Math.round(h * dpr));
  }

  /**
   * Repaint. Called every frame while the wash is up, which is cheap: a fill
   * and at most a handful of radial gradients over a canvas nobody reads back.
   */
  function paint() {
    resize();
    const ctx = cv.getContext && cv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (fade <= 0.002) return;

    ctx.globalAlpha = fade;
    ctx.fillStyle = WASH;
    ctx.fillRect(0, 0, w, h);

    /* The holes. A soft edge rather than a cut circle: a hard rim would read as
       a spotlight rig pointed at the board, and this interface is asked over and
       over to be calm. The gradient is opaque to 62% of the radius and gone by
       the rim, so the hex reads at full brightness and its neighbours fall away
       across about a third of a hex. */
    const holes = (shape && shape.holes) || [];
    /* FULL STRENGTH, whatever the wash is at. `globalAlpha` is still carrying
       the fade from the fill above, and a destination-out drawn at 42% only
       erases 42% of the wash — which leaves a visible grey disc sitting on the
       one hex the lesson is telling the player to look at, and it is worst in
       exactly the first half-second the eye is arriving. The hole is a hole. */
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'destination-out';
    for (const c of holes) {
      if (!(c.r > 1)) continue;
      const g = ctx.createRadialGradient(c.x, c.y, c.r * 0.62, c.x, c.y, c.r);
      g.addColorStop(0, 'rgba(0,0,0,1)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';

    /* The pips. "Point out clearly and minimally to ALL THREE" — so each
       workable hex gets one small gold dot at its centre and nothing else. The
       hex the step is actually teaching on takes the coach's own gold ring on
       top, which is the "just highlight one hex for the sake of learning" half.
       A dot is about as little as a mark can be and still be unmistakable. */
    const pips = (shape && shape.pips) || [];
    ctx.globalAlpha = fade;
    for (const p of pips) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 13, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 201, 60, 0.20)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(p.x, p.y, 6.5, 0, Math.PI * 2);
      ctx.fillStyle = PIP;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = PIP_KEY;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /**
   * `next` is `{ holes:[{x,y,r}], pips:[{x,y}] }` in CSS pixels, or null to
   * fade the wash back out. `dt` advances the ease; pass the frame's own delta.
   */
  function set(next, dt) {
    shape = next || null;
    const want = shape && shape.holes && shape.holes.length ? 1 : 0;
    const d = Math.min(0.1, Math.max(0, dt || 1 / 60));
    fade += (want - fade) * Math.min(1, d * 4.2);
    if (want === 0 && fade < 0.004) fade = 0;
    paint();
  }

  function clear() { shape = null; fade = 0; paint(); }

  function destroy() {
    if (cv.parentNode) cv.parentNode.removeChild(cv);
  }

  return {
    set, clear, destroy,
    get on() { return fade > 0.01; },
    get node() { return cv; }
  };
}

export default createSpotlight;
