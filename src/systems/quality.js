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
 * A LADDER THAT ONLY EVER GOES DOWN
 * ---------------------------------------------------------------------------
 *   "Maybe don't constantly check. Just have a simple test while the app is
 *    loading and if it should be on graphics saver just switch it there for me.
 *    Just harden the graphics saver even slightly more so it works well on even
 *    the worst struggling computers."
 *
 * Three rungs (see `RUNGS`), decided once and then left alone:
 *
 *   2  FULL   shadows · full pixel budget · the interface's backdrop blur
 *   1  SAVER  no shadows · pixel ratio 1 · no blur anywhere
 *   0  LOW    no shadows · ratio 0.8 · 30fps · no blur
 *
 * The first version of this climbed back up on a schedule, and on the laptop it
 * was written for that made things WORSE — every climb is an allocation. Raising
 * the ratio resizes every buffer; turning shadows back on recompiles every
 * material and allocates a 16MB target. Doing that repeatedly on a machine one
 * allocation away from losing its context is not a measurement, it is the thing
 * being measured. It goes down and stays down; the player can put it back.
 *
 * ---------------------------------------------------------------------------
 * WHAT "LOW ON COMPUTE" MEANS, MEASURABLY
 * ---------------------------------------------------------------------------
 * BEFORE THE FIRST FRAME there is nothing to measure, so it is a guess off what
 * the browser will tell us: `deviceMemory`, `hardwareConcurrency`, and the
 * unmasked GL renderer string — an Intel Iris/UHD or a phone GPU means the
 * graphics memory IS the system memory, which is the condition that makes a
 * browser drop contexts. Plus what this machine did here last time, which beats
 * any of them. Guessing low is the cheap mistake.
 *
 * ONE PROBE, eight seconds in, while the opening screen is up. The statistic is
 * p90 rather than the mean: the loop caps at 60Hz so a healthy machine cannot
 * report better than ~16.7ms, and it is the tail that moves first. It costs
 * nothing — reading a clock the loop already has — and it can only lower the
 * rung.
 *
 * Owner: Lead.
 */

/** Rungs. See the header. */
export const LOW = 0;
export const SAVER = 1;
export const FULL = 2;

/*
 * ONE LOOK, EARLY, AND THEN IT LEAVES THE MACHINE ALONE.
 *
 *   "Maybe don't constantly check. Just have a simple test while the app is
 *    loading and if it should be on graphics saver just switch it there for me.
 *    Just harden the graphics saver even slightly more so it works well on even
 *    the worst struggling computers."
 *
 * The first version of this climbed: it probed at 0.4, 1, 3, 5, 10, 15, 20 and
 * 30 minutes and stepped UP whenever the numbers looked good. On the laptop it
 * was written for that made things worse, and the reason is obvious in
 * hindsight — every climb is an allocation. Raising the pixel ratio resizes
 * every buffer; turning the shadow pass back on recompiles every material and
 * allocates a 16MB target. Doing that on a machine that is one allocation away
 * from losing its context is not a measurement, it is the thing being measured.
 *
 * So there is ONE probe, eight seconds in, while the opening screen is up and
 * nothing is at stake, and it can only ever move DOWN. After that the ladder is
 * still: the only things that move it are a lost context (down) and the player
 * (either way, and it stays where they put it).
 */
export const PROBE_AT_SEC = 8;

/*
 * AND A SECOND LOOK, ONCE THE MATCH IS ACTUALLY RUNNING.
 *
 *   "Only switch to saver if it's not doing well."
 *
 * The probe above happens on the opening screen, which is the lightest thing
 * this game ever draws: no settlers walking, no pickup bursts, no build
 * effects, no interface panels sliding over the top. While every phone started
 * in SAVER that did not matter much, because the ladder had nowhere to send
 * them anyway. Now that a phone starts at FULL, a verdict taken over a menu is
 * the only thing standing between it and a match it cannot hold — so there is
 * a second probe a few seconds into play, when the scene finally contains
 * everything a match contains.
 *
 * It is still DOWN ONLY, and still at most one move, so the worst this can do
 * is what the player would have asked for anyway.
 */
export const PLAY_PROBE_SEC = 6;

/** Seconds of frames per probe. Long enough to see a tail, short enough that a
 *  hiccup while it happens to be sampling does not decide anything on its own. */
const PROBE_SEC = 2.5;

/*
 * WHAT EACH RUNG COSTS THE MACHINE.
 *
 *   ratio     multiplies the pixel budget. 0.8 is 36% fewer fragments than 1.0
 *             and is very slightly soft; it is only ever reached by a machine
 *             that has already had a context taken away from it, where softness
 *             is not the problem being solved.
 *   fps       the frame cap. Halving it halves the GPU bill outright, and this
 *             is a game about walking around an island rather than a shooter —
 *             at 30 the only thing that changes is the fan.
 *   shadows   a second full pass over the scene, every frame, plus the target.
 *   blur      every `backdrop-filter` in the interface. See ui-base.css: each
 *             one is a compositor buffer, allocated when the panel appears.
 */
export const RUNGS = [
  { key: 'low', ratio: 0.80, fps: 30, shadows: false, blur: false },
  { key: 'saver', ratio: 1.00, fps: 60, shadows: false, blur: false },
  { key: 'full', ratio: 1.00, fps: 60, shadows: true, blur: true }
];

/*
 * The bars, in milliseconds per frame. Only ever used to go DOWN.
 *
 *   STRUGGLING  33fps at the tail. A machine showing this at full quality is
 *               told to save.
 *   DROWNING    20fps at the tail. A machine showing this while ALREADY saving
 *               has nothing left to give at this resolution, so it goes to the
 *               bottom rung — softer and half the frame rate — rather than
 *               carrying on at a rate the player can see.
 */
const STRUGGLING_MS = 30;
const DROWNING_MS = 50;

/*
 * The key carries a version because the meaning of what is stored under it has
 * changed. Every phone that ever ran the old build measured itself into SAVER
 * on its first frame — see `guessLevel` — and `stored.level === SAVER` is a
 * signal strong enough to hold a device there forever. Bumping the key retires
 * every one of those verdicts in one line, so the ladder gets to judge each
 * machine again on what it actually does rather than on what the old rule
 * assumed about it. Nothing reads the old key; it is simply left behind.
 */
const STORE_KEY = 'island-settlers.quality.v2';

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

/*
 * ADAPTERS THAT ARE NOT ADAPTERS.
 *
 * This list used to read
 *
 *   /(intel|iris|uhd graphics|hd graphics|mali|adreno|powervr|apple gpu|
 *     llvmpipe|swiftshader|software)/i
 *
 * under the heading "adapters whose memory is the machine's memory", and every
 * name in the first two thirds of it is the GPU in a PHONE or a laptop —
 * Adreno is every Qualcomm Android, Mali is most of the rest, Apple GPU is
 * every iPhone, Intel and Iris are most laptops ever sold. Between that and
 * the `deviceMemory <= 8` test below, nothing anybody actually plays this game
 * on could reach FULL. Shared memory was a real observation about why a
 * browser evicts a context under pressure, but it is a property of nearly all
 * hardware, and a signal that is true of nearly all hardware is not a signal.
 *
 * What is left is the case that is CONCLUSIVE rather than suggestive: there is
 * no GPU here at all and the frames are being drawn on the CPU. A software
 * rasteriser will not cope, no measurement is going to change that, and it is
 * worth not making it prove the point at 4fps first.
 *
 * Everything else starts at FULL and gets measured — see `finishProbe`, which
 * runs twice now: once on the opening screen and once under match load.
 */
const SOFTWARE_GPU = /(llvmpipe|swiftshader|softpipe|software|basic render)/i;

/**
 * What to start at, before a single frame has been drawn.
 *
 * Returns { level, why } — `why` is kept because a decision nobody can inspect
 * is a decision nobody can argue with, and this one is a guess.
 */
export function guessLevel(env = {}) {
  const nav = env.navigator || (typeof navigator !== 'undefined' ? navigator : {});
  const cores = Number(nav.hardwareConcurrency) || 0;
  const gpu = String(env.renderer || '');
  const stored = env.stored || readStored() || {};

  const why = [];
  let low = false;

  // The machine told us last time. A page that lost a context here before is
  // the strongest single signal there is, and it survives a reload.
  if (stored.losses > 0) { low = true; why.push(`lost ${stored.losses} context(s) before`); }
  if (stored.level === SAVER) { low = true; why.push('ended in saver last time'); }

  /*
   * WHY THERE IS NO `deviceMemory` TEST HERE ANY MORE.
   *
   *   "Have the default for a smartphone be full instead of saver. Only switch
   *    to saver if it's not doing well."
   *
   * This used to read `if (mem && mem <= 8)`, and `navigator.deviceMemory` is
   * specified to be CLAMPED AT 8 — a machine with 64GB reports 8, exactly like
   * a budget phone. So the test was true on every Chromium browser in
   * existence, every Android WebView and every desktop Chrome included, and
   * FULL was unreachable: the rung existed but nothing could ever start on it.
   * It was not a heuristic, it was a constant wearing a heuristic's clothes.
   *
   * What replaces it is the thing that was always the better answer, and it
   * was already written — `finishProbe` measures the first seconds of real
   * frames and drops a struggling machine to SAVER on the evidence. Guessing
   * badly costs a few seconds of a bad frame rate on a weak phone; guessing
   * the way it did cost every good phone its shadows and its pixel ratio for
   * the entire life of the app.
   *
   * The two signals left are the ones that are conclusive rather than
   * suggestive. A core count the spec does NOT clamp, at the bottom end where
   * it means a device from another decade — it was `<= 4`, which is a current
   * budget Android and a machine that should be allowed to try. And a renderer
   * that has named itself as software; see SOFTWARE_GPU above. Everything else
   * starts at FULL and is measured.
   */
  if (cores && cores <= 2) { low = true; why.push(`${cores} cores`); }
  if (gpu && SOFTWARE_GPU.test(gpu)) { low = true; why.push(`software renderer (${gpu.slice(0, 42)})`); }

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
  let playAt = 0;                     // when the under-load probe is due
  let playProbed = false;             // ...and whether it has happened
  let losses = stored.losses | 0;
  let elapsed = 0;                    // seconds since the page opened
  let probed = false;                 // the one look has been taken

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
    // Clamp to the ladder, whose floor is LOW. (It read `< SAVER ? SAVER` while
    // SAVER was the bottom rung; adding a rung underneath made that a floor at
    // the wrong height, and the bottom rung became unreachable.)
    const want = next < LOW ? LOW : (next > FULL ? FULL : next);
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

    const rung = RUNGS[want];
    if (renderer && renderer.setPixelRatio) {
      const w = (renderer.domElement && renderer.domElement.clientWidth) || 0;
      const h = (renderer.domElement && renderer.domElement.clientHeight) || 0;
      // FULL takes the whole pixel budget; the rungs below scale it down. 0.8
      // is 36% fewer fragments than 1.0 — the single biggest lever left once
      // the shadow pass has gone.
      const base = want === FULL ? ratioFor(w, h) : 1;
      renderer.setPixelRatio(Math.max(0.5, base * rung.ratio));
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
    if (root && root.classList) root.classList.toggle('saver', !rung.blur);

    if (changed) {
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

    /* DOWN ONLY. A machine that is coping is left exactly where it is: there is
       nothing to gain from moving it and an allocation to lose. */
    if (level === FULL && last.p90 >= STRUGGLING_MS) {
      last.verdict = 'struggling';
      apply(SAVER, `p90 ${last.p90}ms`);
      return;
    }
    if (level === SAVER && last.p90 >= DROWNING_MS) {
      last.verdict = 'drowning';
      apply(LOW, `p90 ${last.p90}ms`);
      return;
    }
    last.verdict = 'steady';
  }

  /**
   * The match has started. Arms the second probe — see PLAY_PROBE_SEC.
   * Idempotent: a rematch on the same page has already been measured under
   * load, and re-measuring would only risk demoting a machine over the
   * allocations of a scene being rebuilt.
   */
  function matchBegan() {
    if (playProbed || pinned) return false;
    playAt = elapsed + PLAY_PROBE_SEC;
    return true;
  }

  /** Seconds of wall clock. Drives the two probes and the sampling window. */
  function update(dt) {
    const d = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.25) : 1 / 60;
    elapsed += d;
    if (probing > 0) {
      probing -= d;
      if (probing <= 0) { probing = 0; finishProbe(); }
      return;
    }
    // One look, while the opening screen is up and nothing is at stake.
    if (!probed && elapsed >= PROBE_AT_SEC) { probed = true; startProbe(); }
    // And one under load, a few seconds into the match itself.
    else if (!playProbed && playAt > 0 && elapsed >= playAt) {
      playProbed = true;
      startProbe();
    }
  }

  /** The browser took the context away. Nothing to measure — this IS the
   *  verdict, and it is remembered across reloads. */
  function loss() {
    losses++;
    writeStored({ losses });
    /* THE BOTTOM RUNG, NOT THE MIDDLE ONE. A machine that has actually had its
       context taken away has proved it cannot hold what it was given, and the
       next thing that happens on that machine should be the cheapest frame this
       game can draw. Softer and half the rate is a far better answer than a
       black screen, and it is remembered for next time. */
    if (level !== LOW) apply(LOW, 'context lost');
    return level;
  }

  /** The player used the switch. Their choice outranks every measurement. */
  function pin(next) {
    pinned = true;
    probed = true;
    playProbed = true;
    return apply(next, 'chosen');
  }

  return {
    apply, frame, update, loss, pin, matchBegan,
    startProbe, finishProbe,
    get level() { return level; },
    /** Milliseconds the frame loop should leave between draws at this rung. */
    get frameMs() { return Math.round(1000 / RUNGS[level].fps) - 1.7; },
    get pinned() { return pinned; },
    get info() {
      return {
        level, pinned, losses, rung: RUNGS[level].key,
        fps: RUNGS[level].fps, ratioScale: RUNGS[level].ratio,
        elapsed: Math.round(elapsed),
        probeAt: probed ? null : PROBE_AT_SEC,
        playProbeAt: playProbed || !playAt ? null : Math.round(playAt),
        probing: probing > 0,
        last: { ...last }
      };
    }
  };
}

export default createQuality;
