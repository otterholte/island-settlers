/**
 * Island Settlers — continuous beds: ambience and music.
 *
 * Both are driven by one lookahead scheduler (a single interval that wakes
 * every ~90ms and schedules the next ~400ms of events onto the audio clock).
 * The interval only runs while something is actually sounding, so a muted or
 * idle game costs nothing.
 *
 * Ambience: ocean swell (filtered noise with a slow LFO on the cutoff), wind,
 * distant gulls and faint market activity. Everything loops from seamless
 * procedural noise buffers, so it never seams or thuds.
 *
 * Music: a light four-bar loop — pad, bass, arpeggio and a soft percussive
 * pulse — plus a short victory cadence that resolves and hands back to a
 * quieter version of the same bed.
 */

import { clamp, fin, rnd, setAt, linTo } from './synth.js';

const BPM = 108;
const BEAT = 60 / BPM;
const BEATS_PER_BAR = 4;
const BARS = 4;
const LOOKAHEAD = 0.45;   // seconds scheduled ahead of the audio clock
const TICK_MS = 90;

/* Four-bar progression in D: D - A - Bm - G. Warm, folky, non-fatiguing. */
const PROG = [
  { root: 146.83, kind: 'maj' },   // D3
  { root: 110.00, kind: 'maj' },   // A2
  { root: 123.47, kind: 'min' },   // B2
  { root: 98.00,  kind: 'maj' }    // G2
];
const TRIAD = { maj: [1, 1.2599, 1.4983], min: [1, 1.1892, 1.4983] };

/* Eighth-note arpeggio pattern, indices into the chord tone list. */
const ARP = [0, 2, 1, 3, 2, 4, 1, 2];

export function createBeds(E) {
  if (!E) return null;
  const ctx = E.ctx;

  let timer = null;
  let ambOn = false;
  let musicMode = 'off';        // 'off' | 'play' | 'victory'
  let bedLevel = 0.34;

  // music clock
  let nextBeat = 0;
  let beatIndex = 0;
  let resumeAt = 0;

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
  function maybeStopTimer() {
    if (timer === null) return;
    if (ambOn || musicMode !== 'off') return;
    clearInterval(timer);
    timer = null;
  }

  function tick() {
    let now;
    try { now = E.now(); } catch (e) { return; }
    if (!isFinite(now)) return;
    try {
      if (musicMode === 'play') scheduleMusic(now);
      if (musicMode === 'victory' && resumeAt > 0 && now >= resumeAt) {
        musicMode = 'play';
        bedLevel = 0.26;                       // hand back to a quieter bed
        nextBeat = now + 0.12;
        beatIndex = 0;
        linTo(E.musicBus.gain, bedLevel, now + 1.4);
      }
      if (ambOn) scheduleAmbienceEvents(now);
    } catch (e) { /* never let the bed take the frame loop down */ }
  }

  /* --------------------------------------------------------------- ambience */

  function startAmbience() {
    const t = E.now();
    // --- ocean swell: brown noise through a slowly opening lowpass
    const ocean = E.noiseLoop('brown', null, 0.9);
    if (ocean) {
      const lp = E.filter('lowpass', 420, 0.6);
      const swell = E.gain(0.5);
      ocean.out.connect(lp); lp.connect(swell); swell.connect(E.ambBus);
      const l1 = E.lfo(0.055, 260, lp.frequency, t);
      const l2 = E.lfo(0.083, 0.24, swell.gain, t);
      try { ocean.src.start(t); } catch (e) { /* ignore */ }
      ambNodes.push(ocean.src, l1, l2);
    }
    // --- surf hiss riding on top of the swell
    const surf = E.noiseLoop('pink', null, 0.22);
    if (surf) {
      const bp = E.filter('bandpass', 1500, 0.7);
      const g = E.gain(0.5);
      surf.out.connect(bp); bp.connect(g); g.connect(E.ambBus);
      const l3 = E.lfo(0.071, 0.34, g.gain, t);
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

  /* ----------------------------------------------------------------- music */

  function padChord(t, chord, level) {
    const ch = E.channel({ gain: level * 0.55, rev: 0.4, bus: E.musicBus });
    const tones = TRIAD[chord.kind];
    for (let i = 0; i < tones.length; i++) {
      const f = chord.root * tones[i] * 2;    // up an octave for the pad
      E.tone({ dest: ch, t, type: 'triangle', f0: f, gain: 0.16 - i * 0.02,
               attack: 0.42, hold: BEAT * 2.4, release: 0.9, lp: 1500, q: 0.6,
               detune: -5 });
      E.tone({ dest: ch, t, type: 'triangle', f0: f * 1.0035, gain: 0.11,
               attack: 0.5, hold: BEAT * 2.2, release: 0.9, lp: 1300, q: 0.6,
               detune: 6 });
    }
  }

  function bassNote(t, chord, level, low) {
    const ch = E.channel({ gain: level * 0.85, rev: 0.12, bus: E.musicBus });
    const f = chord.root * (low ? 0.5 : 1);
    E.tone({ dest: ch, t, type: 'sine', f0: f, dur: BEAT * 0.85,
             gain: 0.3, attack: 0.012 });
    E.tone({ dest: ch, t, type: 'triangle', f0: f * 2, dur: BEAT * 0.4,
             gain: 0.07, attack: 0.01, lp: 900 });
  }

  function arpNote(t, chord, step, level) {
    const tones = TRIAD[chord.kind];
    const idx = ARP[step % ARP.length];
    const oct = idx >= tones.length ? 2 : 1;
    const f = chord.root * tones[idx % tones.length] * 4 * oct;
    const ch = E.channel({ gain: level * 0.5, pan: (step % 2 ? 0.22 : -0.22),
                           rev: 0.35, bus: E.musicBus });
    E.tone({ dest: ch, t, type: 'triangle', f0: f, dur: 0.3, gain: 0.16,
             attack: 0.004, lp: 4200, q: 0.7 });
    E.tone({ dest: ch, t, type: 'sine', f0: f * 2, dur: 0.16, gain: 0.05,
             attack: 0.004 });
  }

  function pulse(t, strong, level) {
    const ch = E.channel({ gain: level, rev: 0.1, bus: E.musicBus });
    if (strong) {
      E.tone({ dest: ch, t, type: 'sine', f0: 120, f1: 52, glide: 0.06,
               dur: 0.2, gain: 0.32, attack: 0.003 });
      E.noiseVoice({ dest: ch, t, lp: 420, fEnd: 160, noise: 'brown',
                     dur: 0.1, gain: 0.09, attack: 0.002 });
    } else {
      E.noiseVoice({ dest: ch, t, hp: 5200, dur: 0.035, gain: 0.055,
                     attack: 0.001 });
    }
  }

  function scheduleMusic(now) {
    if (nextBeat <= 0 || nextBeat < now - 1) { nextBeat = now + 0.1; beatIndex = 0; }
    const horizon = now + LOOKAHEAD;
    let guard = 0;
    while (nextBeat < horizon && guard++ < 32) {
      const t = nextBeat;
      const bar = ((beatIndex / BEATS_PER_BAR) | 0) % BARS;
      const beat = beatIndex % BEATS_PER_BAR;
      const chord = PROG[bar];
      const L = bedLevel;

      if (beat === 0) padChord(t, chord, L);
      if (beat === 0 || beat === 2) bassNote(t, chord, L, beat === 0);
      pulse(t, beat === 0 || beat === 2, L * 0.9);
      pulse(t + BEAT * 0.5, false, L * 0.7);

      // arpeggio: two eighths per beat, thinned on bar 3 so it breathes
      const step = beatIndex * 2;
      const thin = bar === 3 && beat >= 2;
      arpNote(t, chord, step, thin ? L * 0.5 : L);
      if (!thin) arpNote(t + BEAT * 0.5, chord, step + 1, L * 0.8);

      beatIndex = (beatIndex + 1) % (BEATS_PER_BAR * BARS);
      nextBeat += BEAT;
    }
  }

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
    resumeAt = t0 + 2.9;
  }

  /* ------------------------------------------------------------------- api */
  return {
    ambience(on) {
      const want = !!on;
      const t = E.now();
      if (want === ambOn) {
        if (want) linTo(E.ambBus.gain, 0.5, t + 0.5);
        return;
      }
      ambOn = want;
      if (want) {
        startAmbience();
        setAt(E.ambBus.gain, Math.max(0.0001, fin(E.ambBus.gain.value, 0)), t);
        linTo(E.ambBus.gain, 0.5, t + 2.2);
        ensureTimer();
      } else {
        setAt(E.ambBus.gain, clamp(fin(E.ambBus.gain.value, 0.5), 0, 1), t);
        linTo(E.ambBus.gain, 0, t + 0.7);
        stopAmbience();
        maybeStopTimer();
      }
    },

    music(mode) {
      const t = E.now();
      if (mode === 'play') {
        if (musicMode === 'play') return;
        musicMode = 'play';
        bedLevel = 0.34;
        nextBeat = t + 0.15;
        beatIndex = 0;
        setAt(E.musicBus.gain, 0.0001, t);
        linTo(E.musicBus.gain, 0.38, t + 2.0);
        ensureTimer();
      } else if (mode === 'victory') {
        musicMode = 'victory';
        setAt(E.musicBus.gain, clamp(fin(E.musicBus.gain.value, 0.38), 0, 1), t);
        linTo(E.musicBus.gain, 0.62, t + 0.12);
        victoryCadence();
        ensureTimer();
      } else {                                   // 'off' / 'stop' / anything
        musicMode = 'off';
        resumeAt = 0;
        setAt(E.musicBus.gain, clamp(fin(E.musicBus.gain.value, 0.38), 0, 1), t);
        linTo(E.musicBus.gain, 0, t + 0.6);
        maybeStopTimer();
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
