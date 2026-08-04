/**
 * Island Settlers — how much graphics this machine can actually afford.
 *
 *   createQuality({ renderer, scene, canvas, root, sunOf, ratioFor, onChange })
 *     -> { level, apply(level), frame(now), update(dt), loss(), pin(level),
 *          guess(), probeNow(), info }
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 *   "The graphics saver helped a TON. The only problem is that I have to go into
 *    a game, get through the draft, get to the board, and press the settings bar
 *    before I see it. Is there a simple way to automatically test if the
 *    computer is low on compute reliably, and automatically turn on the graphics
 *    saver as soon as the app is opened... Also I'd like for it to check, let's
 *    say at minute 1, 3, 5, 10, 15, 20, 30, just briefly in the background, to
 *    see if the compute has improved so it can do a subtle transition back out
 *    of graphics saver... but this needs to happen without detracting from the
 *    experience at all. No black flashes while testing, no extra visuals, all
 *    hidden behind the scenes."
 *
 * So: guess before the first frame, measure while playing, and move one step at
 * a time in whichever direction the measurement points.
 *
 * ---------------------------------------------------------------------------
 * A LADDER, NOT A SWITCH
 * ---------------------------------------------------------------------------
 * The old setting was a boolean, and a boolean cannot make a subtle transition:
 * coming back out of saver meant turning the shadow pass on, which makes three
 * recompile every material in the scene — a visible hitch, on the one machine
 * least able to absorb it. Three rungs, and the cheap half of the climb is
 * separated from the expensive half:
 *
 *   0  SAVER   no shadows · pixel ratio 1 · no backdrop blur anywhere
 *   1  MIDDLE  no shadows · full pixel budget · blur back
 *   2  FULL    shadows on · full pixel budget · blur back
 *
 * 0 -> 1 is a resize. No recompile, no allocation, invisible. 1 -> 2 is the
 * expensive one and is only attempted from a rung the machine has already been
 * holding comfortably, so by the time it is paid for we have evidence it can be
 * afforded. Downgrades skip straight to 0: a machine in trouble is not helped by
 * being let down gently.
 *
 * ---------------------------------------------------------------------------
 * WHAT "LOW ON COMPUTE" MEANS, MEASURABLY
 * ---------------------------------------------------------------------------
 * Two different questions, answered two different ways.
 *
 * BEFORE THE FIRST FRAME there is nothing to measure, so it is a guess off what
 * the browser will tell us: `deviceMemory` (Chrome reports 8 or less on the
 * laptop this came from), `hardwareConcurrency`, and the unmasked GL renderer
 * string, which names the adapter — an Intel Iris/UHD or a phone GPU means the
 * graphics memory IS the system memory, which is the condition that makes a
 * browser start dropping contexts. Guessing low is the cheap mistake: a fast
 * machine is at full quality twenty-five seconds later and never saw it.
 *
 * ONCE IT IS RUNNING the honest measure is frame TIME, and the honest statistic
 * is not the mean. The loop caps at 60Hz, so a healthy machine cannot report
 * better than ~16.7ms and the mean says nothing; what separates a machine that
 * is coping from one that is not is the tail. `p90` — the frame nine out of ten
 * are quicker than — is flat at the cap when things are fine and climbs first
 * when they are not. A probe is 2.5 seconds of that, and it costs nothing: it
 * is reading a clock the loop already looks at. Nothing is drawn, allocated,
 * resized or hidden to take a measurement.
 *
 * Owner: Lead.
 */

/** Rungs. See the header. */
export const SAVER = 0;
export const MIDDLE = 1;
export const FULL = 2;

/* When to look, in minutes of wall clock since the page opened. The first is
   deliberately early — a machine that was guessed wrong should not spend a whole
   match paying for it — and they thin out, because a laptop that has been fine
   for twenty minutes is not about to surprise anybody. */
export const PROBE_AT_MIN = [0.4, 1, 3, 5, 10, 15, 20, 30];

/** Seconds of frames per probe. Long enough to see a tail, short enough that a
 *  hiccup while it happens to be sampling does not decide anything on its own. */
const PROBE_SEC = 2.5;

/*
 * The bars, in milliseconds per frame.
 *
 * COMFORTABLE is what a machine has to show to be trusted with the next rung
 * up: a p90 of 20ms is 50fps at the tail with the loop capped at 60, which is
 * headroom rather than luck. STRUGGLING is what drops it to the bottom rung:
 * 30ms p90 is 33fps at the tail, which is where a player starts to feel it.
 *
 * The gap between them is deliberate and wide. A single threshold with anything
 * either side of it produces a machine that spends its life climbing one rung
 * and falling off it, which is far worse to look at than either rung.
 */
const COMFORTABLE_MS = 20;
const STRUGGLING_MS = 30;

/** No upgrade within this long of a downgrade or a lost context. */
const COOLDOWN_SEC = 90;
/** Two failed climbs and it stops trying for the rest of the session. */
const MAX_CLIMBS = 2;

const STORE_KEY = 'island-settlers.quality';

function store() {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; }
  catch (e) { return null; }
}

function readStored() {
  const s = store();
  if (!s) return null;
  try {
    const raw = JSON.parse(s.getItem(STORE_KEY) || 'null');
    if (!raw || typeof raw !== 'object') return null;
    return raw;
  } catch (e) { return null; }
}

function writeStored(patch) {
  const s = store();
  if (!s) return;
  try {
    s.setItem(STORE_KEY, JSON.stringify({ ...(readStored() || {}), ...patch }));
  } catch (e) { /* private mode; this session still works */ }
}

/**
 * The adapter's own name for itself, where the browser will say.
 * `WEBGL_debug_renderer_info` is gated in some builds; absent is not low, it is
 * unknown, and unknown is not evidence of anything.
 */
export function rendererName(gl) {
  try {
    if (!gl || typeof gl.getExtension !== 'function') return '';
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    if (dbg && dbg.UNMASKED_RENDERER_WEBGL) {
      return String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '');
    }
    return String(gl.getParameter(gl.RENDERER) || '');
  } catch (e) { return ''; }
}

/** Adapters whose memory is the machine's memory. Not slow — SHARED, which is
 *  the property that makes a browser evict a WebGL context under pressure. */
const SHARED_MEMORY_GPU =
  /(intel|iris|uhd graphics|hd graphics|mali|adreno|powervr|apple gpu|llvmpipe|swiftshader|software)/i;

/**
 * What to start at, before a single frame has been drawn.
 *
 * Returns { level, why } — `why` is kept because a decision nobody can inspect
 * is a decision nobody can argue with, and this one is a guess.
 */
export function guessLevel(env = {}) {
  const nav = env.navigator || (typeof navigator !== 'undefined' ? navigator : {});
  const mem = Number(nav.deviceMemory) || 0;         // GB, coarse, Chrome only
  const cores = Number(nav.hardwareConcurrency) || 0;
  const gpu = String(env.renderer || '');
  const stored = env.stored || readStored() || {};

  const why = [];
  let low = false;

  // The machine told us last time. A page that lost a context here before is
  // the strongest single signal there is, and it survives a reload.
  if (stored.losses > 0) { low = true; why.push(`lost ${stored.losses} context(s) before`); }
  if (stored.level === SAVER) { low = true; why.push('ended in saver last time'); }

  if (mem && mem <= 8) { low = true; why.push(`deviceMemory ${mem}GB`); }
  if (cores && cores <= 4) { low = true; why.push(`${cores} cores`); }
  if (gpu && SHARED_MEMORY_GPU.test(gpu)) { low = true; why.push(`shared-memory GPU (${gpu.slice(0, 42)})`); }

  // A stored level above saver from a machine that has been measured is worth
  // more than the hints — it is the same machine, and it coped.
  if (!low && Number.isInteger(stored.level)) return { level: stored.level, why: ['measured before'] };
  return { level: low ? SAVER : FULL, why: why.length ? why : ['no low-power signals'] };
}

export function createQuality(opts = {}) {
  const renderer = opts.renderer || null;
  const scene = opts.scene || null;
  const root = opts.root || null;              // the interface root, for CSS
  const sunOf = typeof opts.sunOf === 'function' ? opts.sunOf : () => null;
  const ratioFor = typeof opts.ratioFor === 'function' ? opts.ratioFor : () => 1;
  const onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {};

  const stored = readStored() || {};
  let level = Number.isInteger(opts.level) ? opts.level : FULL;
  let pinned = false;                 // the player chose; stop deciding for them
  let climbs = 0;                     // failed attempts to go up
  let losses = stored.losses | 0;
  let sinceChange = COOLDOWN_SEC;     // seconds; starts warm so probe 1 can act
  let elapsed = 0;                    // seconds since the page opened
  let nextProbe = 0;                  // index into PROBE_AT_MIN

  /* The sampler. `frame(now)` is called from the render loop with the same
     timestamp it already has, so measuring costs one subtraction. */
  const win = [];                     // recent frame intervals, ms
  let lastFrame = 0;
  let probing = 0;                    // seconds of sampling left
  let probeSkip = 0;                  // frames to ignore after a change

  function frame(now) {
    if (lastFrame) {
      const dt = now - lastFrame;
      // A tab that was hidden, or a debugger pause, is not a slow frame.
      if (probing > 0 && dt > 0 && dt < 500) {
        if (probeSkip > 0) probeSkip--;
        else win.push(dt);
      }
    }
    lastFrame = now;
  }

  function percentile(arr, p) {
    if (!arr.length) return 0;
    const a = [...arr].sort((x, y) => x - y);
    return a[Math.min(a.length - 1, Math.max(0, Math.round((a.length - 1) * p)))];
  }

  const last = { p50: 0, p90: 0, frames: 0, at: 0, verdict: 'none' };

  /* --------------------------------------------------------------- levels */

  /**
   * Put a rung in force. Everything here is idempotent — it is called on boot,
   * on a probe verdict, and by the settings switch.
   *
   * `needsUpdate` is only spent when the SHADOW state actually changes: three
   * bakes "is there a shadow map" into every program it compiles, so the flag
   * cannot move without a recompile, and a recompile is the one visible cost in
   * this whole file. Moving between 0 and 1 never touches it.
   */
  function apply(next, why) {
    const want = next < SAVER ? SAVER : (next > FULL ? FULL : next);
    const shadowsWere = !!(renderer && renderer.shadowMap && renderer.shadowMap.enabled);
    const shadowsWant = want === FULL;
    const changed = want !== level;
    level = want;

    if (renderer && renderer.shadowMap) renderer.shadowMap.enabled = shadowsWant;
    const sun = sunOf();
    if (sun) sun.castShadow = shadowsWant;

    /* GIVE THE MEMORY BACK. Turning the shadow pass off without disposing its
       target leaves a 16MB depth texture allocated on exactly the GPU that ran
       out of room — the whole point of the rung is the memory, not the pass. */
    if (!shadowsWant && sun && sun.shadow && sun.shadow.map) {
      try { sun.shadow.map.dispose(); } catch (e) { /* it may already be gone */ }
      sun.shadow.map = null;
    }
    if (shadowsWant !== shadowsWere && scene && scene.traverse) {
      scene.traverse(o => {
        const m = o && o.material;
        if (!m) return;
        for (const mm of (Array.isArray(m) ? m : [m])) { if (mm) mm.needsUpdate = true; }
      });
    }

    if (renderer && renderer.setPixelRatio) {
      const w = (renderer.domElement && renderer.domElement.clientWidth) || 0;
      const h = (renderer.domElement && renderer.domElement.clientHeight) || 0;
      renderer.setPixelRatio(want === SAVER ? 1 : ratioFor(w, h));
    }

    /*
     * AND THE BLUR, WHICH IS NOT A THREE.JS PROBLEM AT ALL.
     *
     *   "When I open the trading post or try and move too quickly, it starts to
     *    flash black screen again."
     *
     * Every plate in this interface carries `backdrop-filter: blur()` — the HUD
     * bars, the popups, the sheets, and the full-screen scrim behind a modal.
     * Each one makes the compositor snapshot what is behind it into its own
     * buffer, and a new blurred surface appearing is a new full-screen
     * allocation, on demand, on a GPU that is already out of room. Opening the
     * trade sheet allocates the biggest one of the lot, which is exactly the
     * moment named above.
     *
     * On the bottom rung they all go. The plates keep their dark translucent
     * background and lose an effect most people could not point to — for the one
     * that was costing a context.
     */
    if (root && root.classList) root.classList.toggle('saver', want === SAVER);

    if (changed) {
      sinceChange = 0;
      writeStored({ level, at: Date.now() });
      onChange(level, why || '');
    }
    return level;
  }

  /* --------------------------------------------------------------- probing */

  function startProbe() {
    win.length = 0;
    probing = PROBE_SEC;
    probeSkip = 3;         // the frames either side of a change are not typical
  }

  function finishProbe() {
    const frames = win.length;
    last.frames = frames;
    last.at = elapsed;
    if (frames < 20) { last.verdict = 'too few frames'; return; }
    last.p50 = Math.round(percentile(win, 0.5) * 10) / 10;
    last.p90 = Math.round(percentile(win, 0.9) * 10) / 10;

    if (pinned) { last.verdict = 'pinned'; return; }

    if (last.p90 >= STRUGGLING_MS && level > SAVER) {
      last.verdict = 'struggling';
      apply(SAVER, `p90 ${last.p90}ms`);
      return;
    }
    if (last.p90 <= COMFORTABLE_MS && level < FULL
        && sinceChange >= COOLDOWN_SEC && climbs < MAX_CLIMBS) {
      last.verdict = 'comfortable';
      // ONE RUNG. 0 -> 1 is free; 1 -> 2 is the recompile, and it only happens
      // from a rung this machine has already held for a cooldown.
      if (level === MIDDLE) climbs++;
      apply(level + 1, `p90 ${last.p90}ms`);
      return;
    }
    last.verdict = 'steady';
  }

  /** Seconds of wall clock. Drives the schedule and the sampling window. */
  function update(dt) {
    const d = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.25) : 1 / 60;
    elapsed += d;
    sinceChange += d;
    if (probing > 0) {
      probing -= d;
      if (probing <= 0) { probing = 0; finishProbe(); }
      return;
    }
    while (nextProbe < PROBE_AT_MIN.length && elapsed >= PROBE_AT_MIN[nextProbe] * 60) {
      nextProbe++;
      startProbe();
      return;
    }
  }

  /** The browser took the context away. Nothing to measure — this IS the
   *  verdict, and it is remembered across reloads. */
  function loss() {
    losses++;
    writeStored({ losses });
    climbs = MAX_CLIMBS;              // do not climb again this session
    if (level !== SAVER) apply(SAVER, 'context lost');
    sinceChange = 0;
    return level;
  }

  /** The player used the switch. Their choice outranks every measurement. */
  function pin(next) {
    pinned = true;
    climbs = MAX_CLIMBS;
    return apply(next, 'chosen');
  }

  return {
    apply, frame, update, loss, pin,
    startProbe, finishProbe,
    get level() { return level; },
    get pinned() { return pinned; },
    get info() {
      return {
        level, pinned, climbs, losses,
        elapsed: Math.round(elapsed),
        nextProbeAt: nextProbe < PROBE_AT_MIN.length ? PROBE_AT_MIN[nextProbe] : null,
        probing: probing > 0,
        last: { ...last }
      };
    }
  };
}

export default createQuality;
