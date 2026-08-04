/**
 * Island Settlers — audio facade.
 *
 *   createAudio() -> { sfx, music, ambience, unlock, setMuted, mute, muted }
 *
 * Everything is synthesized at runtime with the Web Audio API: no files, no
 * fetch, no CDN. If the platform has no AudioContext (or blocks it) the whole
 * module degrades to silent no-ops rather than throwing — audio must never be
 * the reason the game fails to boot.
 *
 * sfx(name, opts) accepts:
 *   { gain, at: { x, z }, detune, pan }
 * and applies distance attenuation + panning relative to the listener (the
 * human settler, oriented by the camera) so bot activity across the island
 * sits behind the player's own work.
 */

import { createEngine, clamp, fin, rnd } from './synth.js';
import { BANK } from './sfxbank.js';
import { createBeds } from './beds.js';
import { haptic, PATTERNS } from '../fx/haptics.js';

/* Sounds that also get a buzz. Construction and the Knight are the moments
   worth feeling; gather completion is handled by the FX side. */
const HAPTIC_FOR = {
  build: PATTERNS.build,
  upgrade: PATTERNS.upgrade,
  horn: PATTERNS.heavy,
  award: PATTERNS.build,
  deny: PATTERNS.deny
};

const G = typeof globalThis !== 'undefined' ? globalThis : {};
const NOOP = () => {};

/* Listener falloff: 1 at the listener, 0.5 at REF units, ~0.2 at 2 x REF. */
const REF = 28;
const MIN_ATT = 0.04;

/* Rate limiting — four settlers chopping at once must not turn to mush. */
const SAME_WINDOW = 0.115;   // seconds
const SAME_MAX = 3;          // simultaneous copies of one sound
const ALL_WINDOW = 0.06;
const ALL_MAX = 10;

function silentAudio() {
  const a = {
    sfx: NOOP, music: NOOP, ambience: NOOP, unlock: NOOP,
    setMuted: NOOP, mute: NOOP, setListener: NOOP, dispose: NOOP,
    muted: false, ok: false
  };
  return a;
}

export function createAudio() {
  const E = createEngine();
  if (!E) return silentAudio();

  let beds = null;
  try { beds = createBeds(E); } catch (e) { beds = null; }

  let muted = false;
  let wantAmb = false;
  let lastMusic = 'off';

  /* ------------------------------------------------------------- listener */
  const lis = { x: 0, z: 0, rx: 1, rz: 0, known: false };

  function refreshListener() {
    const I = G.__ISLAND__ || (G.window && G.window.__ISLAND__) || null;
    if (!I) return;
    // Distance is measured from the human settler...
    const st = I.state;
    if (st && st.players && st.players[0] &&
        isFinite(st.players[0].x) && isFinite(st.players[0].z)) {
      lis.x = st.players[0].x; lis.z = st.players[0].z; lis.known = true;
    }
    // ...orientation comes from the camera's world right-axis.
    const cam = I.camera;
    if (cam) {
      if (!lis.known && cam.position && isFinite(cam.position.x)) {
        lis.x = cam.position.x; lis.z = cam.position.z; lis.known = true;
      }
      const m = cam.matrixWorld && cam.matrixWorld.elements;
      if (m && isFinite(m[0]) && isFinite(m[2])) {
        const l = Math.hypot(m[0], m[2]) || 1;
        lis.rx = m[0] / l; lis.rz = m[2] / l;
      }
    }
  }

  /** Distance attenuation + stereo placement for a world-space source. */
  function place(at) {
    if (!at || !isFinite(fin(at.x, NaN)) || !isFinite(fin(at.z, NaN))) {
      return { att: 1, pan: 0 };
    }
    refreshListener();
    if (!lis.known) return { att: 1, pan: 0 };
    const dx = at.x - lis.x, dz = at.z - lis.z;
    const d = Math.hypot(dx, dz);
    const att = clamp(1 / (1 + (d / REF) * (d / REF)), MIN_ATT, 1);
    let pan = 0;
    if (d > 0.001) pan = clamp((dx * lis.rx + dz * lis.rz) / Math.max(d, 6), -1, 1);
    return { att, pan: pan * 0.75 };
  }

  /* --------------------------------------------------------- rate limiting */
  const recent = Object.create(null);   // name -> array of times
  const allShots = [];

  function budget(name, now) {
    let arr = recent[name];
    if (!arr) arr = recent[name] = [];
    let n = 0;
    for (let i = arr.length - 1; i >= 0; i--) {
      if (now - arr[i] > SAME_WINDOW) { arr.splice(0, i + 1); break; }
      n++;
    }
    if (n >= SAME_MAX) return false;
    let m = 0;
    for (let i = allShots.length - 1; i >= 0; i--) {
      if (now - allShots[i] > ALL_WINDOW) { allShots.splice(0, i + 1); break; }
      m++;
    }
    if (m >= ALL_MAX) return false;
    arr.push(now);
    allShots.push(now);
    if (arr.length > 24) arr.splice(0, arr.length - 24);
    if (allShots.length > 64) allShots.splice(0, allShots.length - 64);
    return true;
  }

  /* -------------------------------------------------------------- the api */

  function sfx(name, opts) {
    if (muted) return;
    const spec = BANK[name];
    if (!spec) return;
    let now;
    try { now = E.now(); } catch (e) { return; }
    if (!isFinite(now)) return;
    if (!budget(name, now)) return;

    const o = opts || {};
    const p = place(o.at);
    const userGain = clamp(fin(o.gain, 1), 0, 4);
    const level = clamp(spec.gain * userGain * p.att, 0, 3);
    if (level <= 0.0008) return;

    const pan = clamp(fin(o.pan, p.pan), -1, 1);
    const detune = fin(o.detune, 0) + rnd(-spec.pitch, spec.pitch);
    // slight per-shot level jitter so repeats never lock together
    const jitter = 1 + rnd(-0.07, 0.07);

    try {
      const ch = E.channel({ gain: level * jitter, pan, rev: spec.rev, bus: E.sfxBus });
      spec.fn(E, now + 0.008, ch, { detune });
    } catch (e) { /* a bad sound must never break the frame */ }

    const buzz = HAPTIC_FOR[name];
    if (buzz && p.att > 0.35) haptic(buzz);
  }

  function music(mode) {
    if (!beds) return;
    const m = mode === 'play' || mode === 'victory' ? mode : 'off';
    lastMusic = m;
    if (muted && m !== 'off') return;
    try { beds.music(m); } catch (e) { /* ignore */ }
  }

  function ambience(on) {
    wantAmb = !!on;
    if (!beds) return;
    if (muted && wantAmb) return;
    try { beds.ambience(wantAmb); } catch (e) { /* ignore */ }
  }

  function unlock() {
    try {
      if (E.ctx && E.ctx.state === 'suspended' && typeof E.ctx.resume === 'function') {
        const r = E.ctx.resume();
        if (r && typeof r.catch === 'function') r.catch(NOOP);
      }
    } catch (e) { /* ignore */ }
    // Some mobile browsers only truly start after a scheduled source runs.
    try {
      if (!api._primed && E.ctx && typeof E.ctx.createBufferSource === 'function') {
        api._primed = true;
        const s = E.ctx.createBufferSource();
        s.buffer = E.noise('white');
        const g = E.gain(0.00001);
        s.connect(g); g.connect(E.master);
        const t = E.now();
        s.start(t); s.stop(t + 0.02);
      }
    } catch (e) { /* ignore */ }
  }

  /*
   * ------------------------------------------------------------------------
   * THE PAGE GOES AWAY, THE SOUND GOES WITH IT
   * ------------------------------------------------------------------------
   *
   *   "I need the music and audio to stop playing in the background if I've
   *    left the PWA, or even left the tab on my computer. If it's not active
   *    and open it shouldn't be making a sound. Same if I turn the screen off.
   *    Right now my smartphone is off but the sound of the ocean is still on
   *    and super crackly, like the audio is skipping/buffering."
   *
   * Both halves of that are the same fault. A hidden page keeps its AudioContext
   * running — the spec says an audio context is not throttled the way timers and
   * rAF are, which is what lets a music player keep playing — but everything
   * FEEDING it is throttled to a wake-up a second, so the beds' scheduled tones
   * run dry between refills. That gap is the crackle: it is not a buffering
   * artefact, it is a synthesiser being asked to play from a clock that has been
   * put to sleep.
   *
   * So the context is suspended outright when the page is hidden, and the beds
   * are stopped BEFORE it is: suspending mid-tone leaves the last block looping
   * on some Android builds, which would be the crackle again with extra steps.
   * `visibilitychange` covers a tab switch, a minimise, a home-screen swipe out
   * of the PWA and the screen locking; `pagehide` and `freeze` cover the rest of
   * the way out on iOS and a bfcache'd tab.
   *
   * Coming back restores exactly what was playing — `wantAmb` and `lastMusic`
   * are the same two flags `setMuted` uses, so a player who muted stays muted.
   */
  let asleep = false;

  function sleep(on) {
    const want = !!on;
    if (want === asleep) return asleep;
    asleep = want;
    try {
      if (asleep) {
        if (beds) { beds.ambience(false); beds.music('off'); }
        if (E.ctx && typeof E.ctx.suspend === 'function') {
          const r = E.ctx.suspend();
          if (r && typeof r.catch === 'function') r.catch(NOOP);
        }
      } else {
        if (E.ctx && E.ctx.state === 'suspended' && typeof E.ctx.resume === 'function') {
          const r = E.ctx.resume();
          if (r && typeof r.catch === 'function') r.catch(NOOP);
        }
        if (beds && !muted) {
          if (wantAmb) beds.ambience(true);
          if (lastMusic && lastMusic !== 'off') beds.music(lastMusic);
        }
      }
    } catch (e) { /* an audio engine is never worth an exception */ }
    return asleep;
  }

  const doc = (typeof document !== 'undefined') ? document : null;
  if (doc && doc.addEventListener) {
    doc.addEventListener('visibilitychange', () => sleep(!!doc.hidden));
    // iOS never fires visibilitychange on the way out of a standalone PWA.
    doc.addEventListener('freeze', () => sleep(true));
    doc.addEventListener('resume', () => sleep(!doc.hidden));
  }
  if (G && G.addEventListener) {
    G.addEventListener('pagehide', () => sleep(true));
    G.addEventListener('pageshow', () => sleep(false));
  }

  function setMuted(on) {
    const want = !!on;
    if (want === muted) return;
    muted = want;
    const t = E.now();
    try {
      E.master.gain.cancelScheduledValues(Math.max(0, t));
      E.master.gain.setValueAtTime(clamp(fin(E.master.gain.value, 0.9), 0, 2), Math.max(0, t));
      E.master.gain.linearRampToValueAtTime(muted ? 0 : 0.9, Math.max(0, t) + 0.18);
    } catch (e) { /* ignore */ }
    if (beds) {
      try {
        if (muted) { beds.ambience(false); beds.music('off'); }
        else {
          if (wantAmb) beds.ambience(true);
          if (lastMusic === 'play') beds.music('play');
        }
      } catch (e) { /* ignore */ }
    }
  }

  const api = {
    sfx, music, ambience, unlock, setMuted, sleep,
    /** Capture-rig hook: is the whole engine parked because the page is away? */
    get asleep() { return asleep; },
    get state() { return (E.ctx && E.ctx.state) || 'none'; },
    mute: setMuted,
    ok: true,
    _primed: false,
    setListener(x, z) {
      if (isFinite(x) && isFinite(z)) { lis.x = x; lis.z = z; lis.known = true; }
    },
    get context() { return E.ctx; },
    dispose() {
      try { if (beds) beds.dispose(); } catch (e) { /* ignore */ }
      try { if (E.ctx && typeof E.ctx.close === 'function') E.ctx.close(); } catch (e) { /* ignore */ }
    }
  };

  // hud.js does `audio.muted = !soundOn` *and* calls setMuted — keep them in
  // sync by making the property a live accessor.
  Object.defineProperty(api, 'muted', {
    enumerable: true,
    get() { return muted; },
    set(v) { setMuted(v); }
  });

  return api;
}

export default createAudio;
