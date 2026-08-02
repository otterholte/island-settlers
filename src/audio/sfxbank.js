/**
 * Island Settlers — the sound-effect bank.
 *
 * One designed sound per entry. Each is a little arrangement of oscillator and
 * noise voices sharing a channel strip (level / pan / reverb send), never a
 * bare beep. Every function has the same shape:
 *
 *    fn(E, t, ch, o)   E = engine, t = start time, ch = channel strip node,
 *                      o = { detune, seed } small per-shot variation
 *
 * Detune is expressed in cents and applied as a pitch multiplier so a repeated
 * sound never sounds machine-gunned.
 */

import { rnd, clamp, fin, setAt, expTo } from './synth.js';

const cents = c => Math.pow(2, clamp(fin(c, 0), -2400, 2400) / 1200);

/* ------------------------------------------------------------ gather sounds */

/** Woody transient + a short filtered-noise tail. Axe into a trunk. */
function chop(E, t, ch, o) {
  const k = cents(o.detune);
  // knock body: fast falling triangle
  E.tone({ dest: ch, t, type: 'triangle', f0: 210 * k, f1: 78 * k, glide: 0.045,
           dur: 0.16, gain: 0.55, attack: 0.001 });
  E.tone({ dest: ch, t, type: 'sine', f0: 118 * k, f1: 60 * k, glide: 0.05,
           dur: 0.2, gain: 0.34, attack: 0.001 });
  // splintery crack
  E.noiseVoice({ dest: ch, t, bp: 1750 * k, fEnd: 900 * k, q: 1.4,
                 dur: 0.055, gain: 0.34, attack: 0.0008 });
  // dry tail through the woodgrain
  E.noiseVoice({ dest: ch, t: t + 0.012, lp: 1100, fEnd: 330, noise: 'pink',
                 dur: 0.19, gain: 0.16, attack: 0.004 });
}

/** Dull thud plus a scatter of gravel. Spade into clay. */
function dig(E, t, ch, o) {
  const k = cents(o.detune);
  E.tone({ dest: ch, t, type: 'sine', f0: 96 * k, f1: 47 * k, glide: 0.06,
           dur: 0.2, gain: 0.6, attack: 0.002 });
  E.tone({ dest: ch, t, type: 'triangle', f0: 150 * k, f1: 70 * k, glide: 0.04,
           dur: 0.1, gain: 0.22, attack: 0.001 });
  E.noiseVoice({ dest: ch, t, lp: 520, fEnd: 180, noise: 'brown',
                 dur: 0.16, gain: 0.4, attack: 0.002 });
  // gravel skittering off the blade
  for (let i = 0; i < 3; i++) {
    E.noiseVoice({ dest: ch, t: t + 0.05 + i * rnd(0.02, 0.05),
                   bp: rnd(1500, 3400), q: 2.2, dur: 0.03,
                   gain: rnd(0.05, 0.11), attack: 0.001 });
  }
}

/** Metallic clank with an inharmonic pitched ring. Pick into rock. */
function mine(E, t, ch, o) {
  const k = cents(o.detune);
  E.noiseVoice({ dest: ch, t, hp: 3800, dur: 0.026, gain: 0.3, attack: 0.0006 });
  E.tone({ dest: ch, t, type: 'triangle', f0: 430 * k, f1: 300 * k, glide: 0.03,
           dur: 0.09, gain: 0.3, attack: 0.0008 });
  // inharmonic partials give it metal rather than tone
  const parts = [1, 2.37, 3.61, 5.13];
  const amps = [0.2, 0.14, 0.09, 0.05];
  for (let i = 0; i < parts.length; i++) {
    E.tone({ dest: ch, t: t + 0.002, type: 'sine', f0: 620 * k * parts[i],
             dur: 0.34 - i * 0.05, gain: amps[i], attack: 0.001 });
  }
  // the ring that hangs after the strike
  E.tone({ dest: ch, t: t + 0.004, type: 'sine', f0: 1560 * k, dur: 0.5,
           gain: 0.075, attack: 0.006, detune: rnd(-9, 9) });
  E.noiseVoice({ dest: ch, t: t + 0.02, lp: 900, fEnd: 260, noise: 'brown',
                 dur: 0.13, gain: 0.14, attack: 0.004 });
}

/** Soft grassy swish. Scythe through wheat. */
function reap(E, t, ch, o) {
  const k = cents(o.detune);
  E.noiseVoice({ dest: ch, t, bp: 900 * k, fEnd: 2700 * k, fGlide: 0.14, q: 0.85,
                 noise: 'pink', dur: 0.2, gain: 0.34, attack: 0.03 });
  E.noiseVoice({ dest: ch, t: t + 0.09, bp: 2400 * k, fEnd: 1100 * k, q: 1.1,
                 dur: 0.13, gain: 0.16, attack: 0.012 });
  E.tone({ dest: ch, t: t + 0.02, type: 'sine', f0: 140 * k, f1: 96 * k,
           dur: 0.1, gain: 0.1, attack: 0.008 });
}

/** Bright noise snip, twice. Shears through fleece. */
function shear(E, t, ch, o) {
  const k = cents(o.detune);
  for (let i = 0; i < 2; i++) {
    const tt = t + i * rnd(0.055, 0.075);
    E.noiseVoice({ dest: ch, t: tt, hp: 2600 * k, dur: 0.035,
                   gain: 0.26 - i * 0.05, attack: 0.0008 });
    E.noiseVoice({ dest: ch, t: tt, bp: 5200 * k, q: 2.4, dur: 0.045,
                   gain: 0.14, attack: 0.001 });
    E.tone({ dest: ch, t: tt, type: 'triangle', f0: 4300 * k, f1: 3100 * k,
             glide: 0.02, dur: 0.05, gain: 0.05, attack: 0.001 });
  }
  // wool falling away
  E.noiseVoice({ dest: ch, t: t + 0.1, lp: 1600, fEnd: 500, noise: 'pink',
                 dur: 0.14, gain: 0.07, attack: 0.02 });
}

/* ---------------------------------------------------------- economy sounds */

/** Small bright pluck that rises a little. One resource banked. */
function gainSfx(E, t, ch, o) {
  const k = cents(o.detune);
  E.tone({ dest: ch, t, type: 'triangle', f0: 700 * k, f1: 1050 * k, glide: 0.09,
           dur: 0.2, gain: 0.3, attack: 0.003 });
  E.tone({ dest: ch, t, type: 'sine', f0: 1400 * k, f1: 2100 * k, glide: 0.09,
           dur: 0.16, gain: 0.11, attack: 0.003 });
  E.tone({ dest: ch, t: t + 0.055, type: 'sine', f0: 1575 * k, dur: 0.24,
           gain: 0.09, attack: 0.006 });
  E.noiseVoice({ dest: ch, t, hp: 5000, dur: 0.02, gain: 0.06, attack: 0.001 });
}

/** Hammer strike, then a wooden settle. */
function build(E, t, ch, o) {
  const k = cents(o.detune);
  E.noiseVoice({ dest: ch, t, hp: 2200, dur: 0.03, gain: 0.3, attack: 0.0006 });
  E.tone({ dest: ch, t, type: 'triangle', f0: 330 * k, f1: 132 * k, glide: 0.035,
           dur: 0.13, gain: 0.5, attack: 0.001 });
  E.tone({ dest: ch, t, type: 'sine', f0: 90 * k, f1: 55 * k, dur: 0.22,
           gain: 0.35, attack: 0.002 });
  // timber dropping into place
  const knock = (tt, f, g) => {
    E.tone({ dest: ch, t: tt, type: 'triangle', f0: f * k, f1: f * 0.42 * k,
             glide: 0.03, dur: 0.1, gain: g, attack: 0.001 });
    E.noiseVoice({ dest: ch, t: tt, bp: 1400, q: 1.3, dur: 0.05,
                   gain: g * 0.4, attack: 0.001 });
  };
  knock(t + 0.1, 250, 0.26);
  knock(t + 0.185, 190, 0.18);
  E.noiseVoice({ dest: ch, t: t + 0.19, lp: 800, fEnd: 250, noise: 'pink',
                 dur: 0.28, gain: 0.09, attack: 0.02 });
}

/** Bigger, richer build with a stone rumble under it. Settlement -> city. */
function upgrade(E, t, ch, o) {
  const k = cents(o.detune);
  build(E, t, ch, { detune: fin(o.detune, 0) - 130 });
  // stone slabs
  E.tone({ dest: ch, t: t + 0.02, type: 'sine', f0: 62 * k, f1: 38 * k, glide: 0.3,
           dur: 0.85, gain: 0.4, attack: 0.008 });
  E.noiseVoice({ dest: ch, t: t + 0.02, lp: 240, fEnd: 90, noise: 'brown',
                 dur: 0.9, gain: 0.34, attack: 0.02 });
  // a lift: fifth then octave, warm and short
  const root = 174.6 * k;
  E.tone({ dest: ch, t: t + 0.13, type: 'triangle', f0: root, dur: 0.5,
           gain: 0.16, attack: 0.01 });
  E.tone({ dest: ch, t: t + 0.2, type: 'triangle', f0: root * 1.5, dur: 0.46,
           gain: 0.13, attack: 0.01 });
  E.tone({ dest: ch, t: t + 0.27, type: 'triangle', f0: root * 2, dur: 0.5,
           gain: 0.12, attack: 0.012 });
  E.noiseVoice({ dest: ch, t: t + 0.3, hp: 4200, dur: 0.3, gain: 0.05, attack: 0.06 });
}

/** Coins, then the purse closing. */
function trade(E, t, ch, o) {
  const k = cents(o.detune);
  const n = 5;
  for (let i = 0; i < n; i++) {
    const tt = t + i * rnd(0.018, 0.05);
    const f = rnd(2100, 4300) * k;
    E.tone({ dest: ch, t: tt, type: 'triangle', f0: f, dur: rnd(0.1, 0.2),
             gain: rnd(0.06, 0.12), attack: 0.001 });
    E.tone({ dest: ch, t: tt, type: 'sine', f0: f * 1.47, dur: 0.09,
             gain: 0.05, attack: 0.001 });
    E.noiseVoice({ dest: ch, t: tt, hp: 6000, dur: 0.014, gain: 0.05, attack: 0.0006 });
  }
  E.noiseVoice({ dest: ch, t: t + 0.2, lp: 2200, fEnd: 600, noise: 'pink',
                 dur: 0.22, gain: 0.1, attack: 0.02 });
  E.tone({ dest: ch, t: t + 0.24, type: 'sine', f0: 180 * k, f1: 120 * k,
           dur: 0.14, gain: 0.12, attack: 0.004 });
}

/** Paper flick. A card off the top of the deck. */
function card(E, t, ch, o) {
  const k = cents(o.detune);
  E.noiseVoice({ dest: ch, t, hp: 3000 * k, dur: 0.05, gain: 0.2, attack: 0.002 });
  E.noiseVoice({ dest: ch, t: t + 0.01, bp: 1500 * k, fEnd: 4200 * k, fGlide: 0.08,
                 q: 0.9, dur: 0.1, gain: 0.18, attack: 0.006 });
  E.noiseVoice({ dest: ch, t: t + 0.085, hp: 5200, dur: 0.03, gain: 0.12, attack: 0.001 });
  E.tone({ dest: ch, t: t + 0.09, type: 'sine', f0: 520 * k, f1: 340 * k,
           dur: 0.07, gain: 0.05, attack: 0.002 });
}

/* ----------------------------------------------------------- event stingers */

/** Low ominous war horn with a fifth above it. The Knight is coming. */
function horn(E, t, ch, o) {
  const k = cents(o.detune);
  const root = 78 * k;
  const voice = (f, g, det, a) => {
    E.tone({ dest: ch, t, type: 'sawtooth', f0: f * 0.985, f1: f, glide: 0.16,
             gain: g, attack: a, hold: 0.62, release: 0.62,
             lp: 640, q: 0.8, detune: det, vib: f * 0.012, vibRate: 4.6 });
  };
  voice(root, 0.3, -6, 0.14);
  voice(root * 1.5, 0.2, 7, 0.2);
  E.tone({ dest: ch, t, type: 'sine', f0: root * 0.5, gain: 0.26, attack: 0.1,
           hold: 0.7, release: 0.55 });
  // breath at the start, growl underneath
  E.noiseVoice({ dest: ch, t, lp: 900, fEnd: 300, noise: 'pink',
                 dur: 0.3, gain: 0.1, attack: 0.05 });
  E.tone({ dest: ch, t: t + 0.05, type: 'triangle', f0: root * 2.01, gain: 0.07,
           attack: 0.25, hold: 0.4, release: 0.5, lp: 1200 });
}

/** Triumphant fanfare stab. An award changes hands. */
function award(E, t, ch, o) {
  const k = cents(o.detune);
  const root = 392 * k;                       // G4
  const chord = [1, 1.26, 1.5, 2];            // major triad + octave
  const stab = (tt, mul, g, dur) => {
    E.tone({ dest: ch, t: tt, type: 'sawtooth', f0: root * mul, gain: g,
             attack: 0.012, dur, lp: 2600, q: 0.7 });
    E.tone({ dest: ch, t: tt, type: 'triangle', f0: root * mul * 2, gain: g * 0.4,
             attack: 0.01, dur: dur * 0.8 });
  };
  // quick rip up the chord, then the full hit
  stab(t, 1, 0.16, 0.14);
  stab(t + 0.06, chord[1], 0.16, 0.14);
  stab(t + 0.12, chord[2], 0.17, 0.16);
  for (let i = 0; i < chord.length; i++) stab(t + 0.19, chord[i], 0.15, 0.7);
  E.tone({ dest: ch, t: t + 0.19, type: 'sine', f0: root * 0.5, gain: 0.3,
           attack: 0.006, dur: 0.5 });
  E.noiseVoice({ dest: ch, t: t + 0.19, hp: 6000, dur: 0.5, gain: 0.07, attack: 0.01 });
  E.noiseVoice({ dest: ch, t: t + 0.19, lp: 200, fEnd: 70, noise: 'brown',
                 dur: 0.4, gain: 0.28, attack: 0.004 });
}

/** Soft descending buzz. Not enough resources. */
function deny(E, t, ch, o) {
  const k = cents(o.detune);
  const f = 233 * k;
  E.tone({ dest: ch, t, type: 'sawtooth', f0: f, f1: f * 0.63, glide: 0.26,
           dur: 0.3, gain: 0.16, attack: 0.008, lp: 900, lpEnd: 380, q: 0.9 });
  E.tone({ dest: ch, t, type: 'sawtooth', f0: f * 1.004, f1: f * 0.628,
           glide: 0.26, dur: 0.3, gain: 0.13, attack: 0.008, lp: 700, q: 0.9,
           detune: 11 });
  E.tone({ dest: ch, t, type: 'sine', f0: f * 0.5, f1: f * 0.32, glide: 0.26,
           dur: 0.3, gain: 0.12, attack: 0.01 });
  E.noiseVoice({ dest: ch, t, lp: 700, fEnd: 260, noise: 'pink',
                 dur: 0.18, gain: 0.05, attack: 0.01 });
}

/* ------------------------------------------------------------- extra colour */

/** Ash and dust falling — used by the Knight shockwave. */
function rumble(E, t, ch, o) {
  const k = cents(o.detune);
  E.tone({ dest: ch, t, type: 'sine', f0: 54 * k, f1: 30 * k, glide: 0.6,
           dur: 1.2, gain: 0.45, attack: 0.02 });
  E.noiseVoice({ dest: ch, t, lp: 300, fEnd: 80, noise: 'brown',
                 dur: 1.3, gain: 0.3, attack: 0.05 });
}

/** UI blip, kept in the bank so callers never hit an unknown name. */
function blip(E, t, ch, o) {
  const k = cents(o.detune);
  E.tone({ dest: ch, t, type: 'triangle', f0: 880 * k, f1: 1180 * k, glide: 0.04,
           dur: 0.09, gain: 0.16, attack: 0.002 });
}

/**
 * name -> { fn, gain, rev, pitch }
 * `gain` is the design level, `rev` the reverb send, `pitch` the random cent
 * spread applied to every shot so repeats never phase-lock.
 */
export const BANK = {
  chop:    { fn: chop,     gain: 0.85, rev: 0.16, pitch: 90 },
  dig:     { fn: dig,      gain: 0.85, rev: 0.14, pitch: 100 },
  mine:    { fn: mine,     gain: 0.72, rev: 0.24, pitch: 80 },
  reap:    { fn: reap,     gain: 0.8,  rev: 0.12, pitch: 110 },
  shear:   { fn: shear,    gain: 0.7,  rev: 0.12, pitch: 120 },

  gain:    { fn: gainSfx,  gain: 0.55, rev: 0.2,  pitch: 45 },
  build:   { fn: build,    gain: 0.8,  rev: 0.22, pitch: 60 },
  upgrade: { fn: upgrade,  gain: 0.85, rev: 0.3,  pitch: 40 },
  trade:   { fn: trade,    gain: 0.6,  rev: 0.2,  pitch: 50 },
  card:    { fn: card,     gain: 0.7,  rev: 0.12, pitch: 70 },

  horn:    { fn: horn,     gain: 0.9,  rev: 0.45, pitch: 25 },
  award:   { fn: award,    gain: 0.75, rev: 0.35, pitch: 15 },
  deny:    { fn: deny,     gain: 0.7,  rev: 0.12, pitch: 20 },

  rumble:  { fn: rumble,   gain: 0.8,  rev: 0.4,  pitch: 40 },
  blip:    { fn: blip,     gain: 0.5,  rev: 0.1,  pitch: 40 }
};

export const SFX_NAMES = Object.keys(BANK);

export default BANK;
