/**
 * Island Settlers — the ocean bed, and the victory fanfare.
 *
 * Ambience: ocean swell (filtered noise with a slow LFO on the cutoff), wind,
 * distant gulls and faint market activity. Everything loops from seamless
 * procedural noise buffers, so it never seams or thuds. It is driven by one
 * lookahead scheduler — a single interval that wakes every ~90ms and schedules
 * the next stretch of events onto the audio clock — and that interval only
 * runs while the bed is actually sounding, so a quiet game costs nothing.
 *
 * =============================================================================
 * THERE USED TO BE MUSIC HERE
 * =============================================================================
 * A four-bar loop in D — pad, bass, arpeggio and a soft percussive pulse,
 * scheduled by the same lookahead timer. It is gone.
 *
 *   "I feel like I've never heard the music."
 *   "Remove the music toggle. I still don't hear anything."
 *   "I don't like the music anyway, you can keep it without."
 *
 * The first two were a mix fault and it is worth recording what it actually
 * was, because the diagnosis took three tries. The loop was audible in the
 * sense that it was scheduled, routed and rendering; it simply came out at
 * about 0.10 peak against a sound effect's 0.43, because three gains multiply
 * on the way to the bus and every one of them was small. Rendering the synth
 * offline and metering it settled it — the ocean was NOT drowning the music,
 * the two beds measure within a hair of each other. Both just sat around 30dB
 * under the effects, which are what a player sets their volume by.
 *
 * The third quote is why none of that got fixed: once the loop was audible
 * enough to judge, it was not wanted. So the whole scheduler half of this file
 * came out rather than being turned up.
 *
 * WHAT SURVIVES is the victory fanfare below, which is not background music —
 * it is a two-second event that fires once, when somebody wins, in the same
 * family as the horn and the build sounds. It never shared anything with the
 * loop except a bus and a triad table.
 */

import { clamp, fin, rnd, setAt, linTo } from './synth.js';

const LOOKAHEAD = 0.45;   // seconds of ambience scheduled ahead of the clock
const TICK_MS = 90;

/* Kept for the fanfare, which is the only thing that still builds a chord. */
const TRIAD = { maj: [1, 1.2599, 1.4983], min: [1, 1.1892, 1.4983] };

export function createBeds(E) {
  if (!E) return null;
  const ctx = E.ctx;

  let timer = null;
  let ambOn = false;
  let musicMode = 'off';        // 'off' | 'victory'

  // ambience event clocks
  let nextGull = 0;
  let nextVillage = 0;
  const ambNodes = [];

  /* ------------------------------------------------------------- scheduler */
  function ensureTimer() {
    if (timer !== null) return;
    if (typeof setInterval !== 'function') return;
    timer = setInterval(tick, TICK_MS);
  }
  /* The ocean is the only thing on this clock now. The fanfare is scheduled
     whole, in one call, so it needs no wake-ups at all. */
  function maybeStopTimer() {
    if (timer === null) return;
    if (ambOn) return;
    clearInterval(timer);
    timer = null;
  }

  function tick() {
    let now;
    try { now = E.now(); } catch (e) { return; }
    if (!isFinite(now)) return;
    try {
      if (ambOn) scheduleAmbienceEvents(now);
    } catch (e) { /* never let the bed take the frame loop down */ }
  }

  /* --------------------------------------------------------------- ambience */

  function startAmbience() {
    const t = E.now();
    // --- ocean swell: brown noise through a slowly opening lowpass
    //
    // "The audio of the ocean should be quieter in the mix." The swell (and
    // the surf hiss riding on it, just below) were loud enough to compete
    // with the music and sfx busses even though ambBus itself sits modest —
    // a wide-open 420Hz lowpass lets brown noise keep most of its low-end
    // energy through, so at 0.5 it read as considerably bigger than that
    // number suggests. Its gain is halved here, and the LFO that makes it
    // breathe is trimmed by the same fraction so the swell still moves the
    // same relative amount, just from a quieter floor — present and
    // pleasant, but no longer competing with everything else.
    const ocean = E.noiseLoop('brown', null, 0.9);
    if (ocean) {
      const lp = E.filter('lowpass', 420, 0.6);
      const swell = E.gain(0.25);
      ocean.out.connect(lp); lp.connect(swell); swell.connect(E.ambBus);
      const l1 = E.lfo(0.055, 260, lp.frequency, t);
      const l2 = E.lfo(0.083, 0.12, swell.gain, t);
      try { ocean.src.start(t); } catch (e) { /* ignore */ }
      ambNodes.push(ocean.src, l1, l2);
    }
    // --- surf hiss riding on top of the swell — part of the same "ocean"
    // sound to the ear, so it comes down by the same fraction as the swell
    // above rather than being left to poke through a now-quieter bed. Wind,
    // gulls and the village noises below are untouched: they weren't what
    // the report was about, and they now read in proportion against a
    // sea that isn't crowding them out anymore.
    const surf = E.noiseLoop('pink', null, 0.22);
    if (surf) {
      const bp = E.filter('bandpass', 1500, 0.7);
      const g = E.gain(0.25);
      surf.out.connect(bp); bp.connect(g); g.connect(E.ambBus);
      const l3 = E.lfo(0.071, 0.17, g.gain, t);
      const l4 = E.lfo(0.041, 500, bp.frequency, t);
      try { surf.src.start(t); } catch (e) { /* ignore */ }
      ambNodes.push(surf.src, l3, l4);
    }
    // --- wind through the palms
    const wind = E.noiseLoop('pink', null, 0.16);
    if (wind) {
      const bp = E.filter('bandpass', 560, 0.9);
      const g = E.gain(0.45);
      wind.out.connect(bp); bp.connect(g); g.connect(E.ambBus);
      const l5 = E.lfo(0.037, 300, bp.frequency, t);
      const l6 = E.lfo(0.029, 0.3, g.gain, t);
      try { wind.src.start(t); } catch (e) { /* ignore */ }
      ambNodes.push(wind.src, l5, l6);
    }
    nextGull = t + rnd(3, 9);
    nextVillage = t + rnd(1.5, 4);
  }

  function stopAmbience() {
    const t = E.now();
    for (const n of ambNodes) {
      if (!n) continue;
      try { n.stop(t + 0.8); } catch (e) { /* ignore */ }
    }
    ambNodes.length = 0;
  }

  /** Two or three descending gull cries, panned wide, far away. */
  function gull(t) {
    const ch = E.channel({ gain: 0.14, pan: rnd(-0.85, 0.85), rev: 0.6, bus: E.ambBus });
    const base = rnd(1150, 1650);
    const n = 2 + ((Math.random() * 2) | 0);
    for (let i = 0; i < n; i++) {
      const tt = t + i * rnd(0.17, 0.3);
      E.tone({ dest: ch, t: tt, type: 'triangle', f0: base * rnd(0.94, 1.08),
               f1: base * rnd(0.55, 0.7), glide: 0.16, dur: 0.24,
               gain: 0.5 - i * 0.09, attack: 0.02, vib: 26, vibRate: 13,
               lp: 3200, q: 0.8 });
      E.noiseVoice({ dest: ch, t: tt, bp: base * 2, q: 3, dur: 0.1,
                     gain: 0.08, attack: 0.02 });
    }
  }

  /** Faint settlement noise: a hammer, a crate, a bit of chatter. */
  function village(t) {
    const ch = E.channel({ gain: 0.075, pan: rnd(-0.6, 0.6), rev: 0.7, bus: E.ambBus });
    const r = Math.random();
    if (r < 0.4) {                     // distant hammering
      const n = 2 + ((Math.random() * 3) | 0);
      for (let i = 0; i < n; i++) {
        const tt = t + i * rnd(0.22, 0.34);
        E.tone({ dest: ch, t: tt, type: 'triangle', f0: rnd(240, 340),
                 f1: 120, glide: 0.03, dur: 0.09, gain: 0.5, attack: 0.001,
                 lp: 1400 });
      }
    } else if (r < 0.72) {             // crates, livestock, a cart
      E.noiseVoice({ dest: ch, t, lp: 900, fEnd: 300, noise: 'pink',
                     dur: 0.45, gain: 0.5, attack: 0.08 });
      E.tone({ dest: ch, t: t + 0.1, type: 'sine', f0: rnd(150, 260),
               f1: rnd(90, 140), glide: 0.2, dur: 0.35, gain: 0.28, attack: 0.06 });
    } else {                           // muffled market chatter
      const n = 3 + ((Math.random() * 3) | 0);
      for (let i = 0; i < n; i++) {
        E.tone({ dest: ch, t: t + i * rnd(0.09, 0.19), type: 'sawtooth',
                 f0: rnd(170, 330), f1: rnd(150, 300), glide: 0.1,
                 dur: rnd(0.09, 0.18), gain: rnd(0.1, 0.22), attack: 0.03,
                 lp: 800, q: 0.7 });
      }
    }
  }

  function scheduleAmbienceEvents(now) {
    const horizon = now + LOOKAHEAD;
    if (nextGull < now - 5) nextGull = now + rnd(2, 6);
    while (nextGull < horizon) {
      gull(Math.max(now, nextGull));
      nextGull += rnd(7, 17);
    }
    if (nextVillage < now - 5) nextVillage = now + rnd(1, 4);
    while (nextVillage < horizon) {
      village(Math.max(now, nextVillage));
      nextVillage += rnd(2.6, 6.5);
    }
  }

  /* --------------------------------------------------------------- fanfare */

  /** Short triumphant cadence: G -> A -> D with a fanfare and a timpani roll. */
  function victoryCadence() {
    const t0 = E.now() + 0.05;
    const ch = E.channel({ gain: 0.75, rev: 0.5, bus: E.musicBus });
    const brass = (t, f, dur, g) => {
      E.tone({ dest: ch, t, type: 'sawtooth', f0: f * 0.995, f1: f, glide: 0.05,
               dur, gain: g, attack: 0.02, lp: 2800, q: 0.7 });
      E.tone({ dest: ch, t, type: 'triangle', f0: f * 2, dur: dur * 0.8,
               gain: g * 0.35, attack: 0.02 });
    };
    const chordAt = (t, root, kind, dur, g) => {
      const tones = TRIAD[kind];
      for (let i = 0; i < tones.length; i++) brass(t, root * tones[i] * 2, dur, g);
      E.tone({ dest: ch, t, type: 'sine', f0: root, dur, gain: g * 1.4, attack: 0.01 });
    };
    // pickup run
    const run = [392, 440, 493.88];
    for (let i = 0; i < run.length; i++) brass(t0 + i * 0.11, run[i], 0.16, 0.12);
    chordAt(t0 + 0.34, 196, 'maj', 0.45, 0.12);   // G
    chordAt(t0 + 0.78, 220, 'maj', 0.45, 0.13);   // A
    chordAt(t0 + 1.22, 293.66, 'maj', 1.5, 0.15); // D — resolve
    brass(t0 + 1.22, 587.33, 1.5, 0.1);
    // timpani + shimmer
    for (let i = 0; i < 5; i++) {
      E.tone({ dest: ch, t: t0 + 0.9 + i * 0.075, type: 'sine', f0: 88, f1: 62,
               glide: 0.08, dur: 0.22, gain: 0.16 + i * 0.03, attack: 0.004 });
    }
    E.noiseVoice({ dest: ch, t: t0 + 1.2, hp: 6500, dur: 1.4, gain: 0.06, attack: 0.05 });
    E.noiseVoice({ dest: ch, t: t0 + 1.18, lp: 180, fEnd: 60, noise: 'brown',
                   dur: 1.1, gain: 0.3, attack: 0.006 });
    // This used to set `resumeAt`, which handed the bus back to a quieter copy
    // of the four-bar loop once the cadence had rung out. There is no loop to
    // hand back to; `music('victory')` closes the bus itself.
  }

  /* ---------------------------------------------------------------- the mix
   *
   *   "Make the ocean quieter."
   *
   * `AMB_LEVEL` is the only number that should move for a complaint about the
   * ocean. The per-voice gains inside `startAmbience` are shaped against each
   * other — quieting the swell alone would leave the gulls and the distant
   * market sitting on top of a bed that had gone away underneath them.
   *
   * For the record, since it was measured properly in the end: at AMB_LEVEL
   * 0.30 the ocean renders at about 0.086 peak / 0.016 RMS, and a chop lands
   * at 0.435. The bed is meant to be the room, and it is.
   */
  const AMB_LEVEL = 0.30;          // was 0.5
  const MUSIC_VICTORY = 0.82;      // the fanfare, and the only thing left on this bus

  /* ------------------------------------------------------------------- api */
  return {
    ambience(on) {
      const want = !!on;
      const t = E.now();
      if (want === ambOn) {
        if (want) linTo(E.ambBus.gain, AMB_LEVEL, t + 0.5);
        return;
      }
      ambOn = want;
      if (want) {
        startAmbience();
        setAt(E.ambBus.gain, Math.max(0.0001, fin(E.ambBus.gain.value, 0)), t);
        linTo(E.ambBus.gain, AMB_LEVEL, t + 2.2);
        ensureTimer();
      } else {
        setAt(E.ambBus.gain, clamp(fin(E.ambBus.gain.value, AMB_LEVEL), 0, 1), t);
        linTo(E.ambBus.gain, 0, t + 0.7);
        stopAmbience();
        maybeStopTimer();
      }
    },

    /**
     * 'victory' fires the fanfare. Anything else closes the bus.
     *
     * There is no 'play' any more — see the note at the top of the file. The
     * bus is opened and closed by this one call because the cadence is
     * scheduled WHOLE: every voice in it is written onto the audio clock at an
     * absolute time before this returns, so the ramp down can be written at
     * the same moment and no timer is involved in any of it.
     */
    music(mode) {
      const t = E.now();
      if (mode === 'victory') {
        musicMode = 'victory';
        setAt(E.musicBus.gain, 0.0001, t);
        linTo(E.musicBus.gain, MUSIC_VICTORY, t + 0.12);
        victoryCadence();
        // Hold through the cadence (~2.9s), then close behind it.
        setAt(E.musicBus.gain, MUSIC_VICTORY, t + 3.2);
        linTo(E.musicBus.gain, 0, t + 4.4);
      } else {                                   // 'off' / 'stop' / anything
        musicMode = 'off';
        setAt(E.musicBus.gain, clamp(fin(E.musicBus.gain.value, MUSIC_VICTORY), 0, 1), t);
        linTo(E.musicBus.gain, 0, t + 0.6);
      }
    },

    get playing() { return musicMode; },
    get ambient() { return ambOn; },

    dispose() {
      stopAmbience();
      musicMode = 'off';
      ambOn = false;
      if (timer !== null) { clearInterval(timer); timer = null; }
    }
  };
}

export default createBeds;
