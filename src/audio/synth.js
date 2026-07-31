/**
 * Island Settlers — Web Audio synthesis toolkit.
 *
 * Everything the game hears is generated here: oscillators, procedural noise
 * buffers, envelopes, filters, a procedural convolution reverb (with a
 * feedback-delay fallback) and a master bus with a compressor so a pile of
 * simultaneous hits never clips.
 *
 * NO audio files, no fetch, no CDN. Pure Web Audio.
 *
 * Every scheduling helper clamps its arguments: a NaN frequency or a negative
 * time is the classic way to make an AudioParam throw and take the frame loop
 * down with it, so nothing here trusts its caller.
 */

const G = typeof globalThis !== 'undefined' ? globalThis : {};
const AC = G.AudioContext || G.webkitAudioContext || null;

export const EPS = 0.0001;

export const fin = (v, d = 0) => (typeof v === 'number' && isFinite(v) ? v : d);
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const rnd = (a, b) => a + Math.random() * (b - a);
export const pick = arr => arr[(Math.random() * arr.length) | 0];

/* ------------------------------------------------------------ param safety */

export function setAt(p, v, t) {
  if (!p) return;
  try { p.setValueAtTime(fin(v, 0), Math.max(0, fin(t, 0))); } catch (e) { /* ignore */ }
}
export function linTo(p, v, t) {
  if (!p) return;
  try { p.linearRampToValueAtTime(fin(v, 0), Math.max(0, fin(t, 0))); } catch (e) { /* ignore */ }
}
export function expTo(p, v, t) {
  if (!p) return;
  try {
    p.exponentialRampToValueAtTime(Math.max(EPS, fin(v, EPS)), Math.max(0, fin(t, 0)));
  } catch (e) { /* ignore */ }
}

/** Percussive gain envelope: silence -> peak -> exponential tail -> hard zero. */
export function perc(param, t, peak, attack, dur) {
  const p = clamp(fin(peak, 0.2), 0, 6);
  const d = clamp(fin(dur, 0.2), 0.01, 12);
  const a = clamp(fin(attack, 0.004), 0.0004, d * 0.85);
  setAt(param, EPS, t);
  linTo(param, Math.max(EPS, p), t + a);
  expTo(param, EPS, t + d);
  setAt(param, 0, t + d + 0.004);
}

/** Sustained envelope with an explicit hold, for pads / horns / beds. */
export function ahdsr(param, t, peak, a, hold, rel) {
  const p = clamp(fin(peak, 0.2), 0, 6);
  const at = clamp(fin(a, 0.05), 0.001, 6);
  const hd = clamp(fin(hold, 0.3), 0.0, 20);
  const rl = clamp(fin(rel, 0.3), 0.01, 12);
  setAt(param, EPS, t);
  linTo(param, Math.max(EPS, p), t + at);
  linTo(param, Math.max(EPS, p * 0.78), t + at + hd);
  expTo(param, EPS, t + at + hd + rl);
  setAt(param, 0, t + at + hd + rl + 0.004);
}

/* --------------------------------------------------------------- the engine */

export function createEngine() {
  if (!AC) return null;

  let ctx = null;
  try { ctx = new AC({ latencyHint: 'interactive' }); }
  catch (e) {
    try { ctx = new AC(); } catch (e2) { return null; }
  }
  if (!ctx || typeof ctx.createGain !== 'function' ||
      typeof ctx.createOscillator !== 'function') return null;

  const SR = clamp(fin(ctx.sampleRate, 44100), 8000, 192000);

  /* ------------------------------------------------------------ master bus */
  const master = ctx.createGain();
  master.gain.value = 0.9;

  let tail = master;
  if (typeof ctx.createDynamicsCompressor === 'function') {
    const comp = ctx.createDynamicsCompressor();
    try {
      setAt(comp.threshold, -14, 0);
      setAt(comp.knee, 22, 0);
      setAt(comp.ratio, 7, 0);
      setAt(comp.attack, 0.004, 0);
      setAt(comp.release, 0.22, 0);
    } catch (e) { /* ignore */ }
    master.connect(comp);
    comp.connect(ctx.destination);
    tail = comp;
  } else {
    master.connect(ctx.destination);
  }

  const sfxBus = ctx.createGain();   sfxBus.gain.value = 0.85;
  const musicBus = ctx.createGain(); musicBus.gain.value = 0.0;
  const ambBus = ctx.createGain();   ambBus.gain.value = 0.0;
  sfxBus.connect(master);
  musicBus.connect(master);
  ambBus.connect(master);

  /* ---------------------------------------------------------- noise tables */
  const noiseCache = Object.create(null);

  function makeNoise(kind, seconds) {
    const len = Math.max(1, (SR * seconds) | 0);
    let buf = null;
    try { buf = ctx.createBuffer(1, len, SR); } catch (e) { return null; }
    if (!buf || typeof buf.getChannelData !== 'function') return null;
    const d = buf.getChannelData(0);
    if (!d || d.length < len) return buf;
    if (kind === 'white') {
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    } else if (kind === 'pink') {
      // Paul Kellet's economy pink filter.
      let b0 = 0, b1 = 0, b2 = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99765 * b0 + w * 0.0990460;
        b1 = 0.96300 * b1 + w * 0.2965164;
        b2 = 0.57000 * b2 + w * 1.0526913;
        d[i] = clamp((b0 + b1 + b2 + w * 0.1848) * 0.22, -1, 1);
      }
    } else { // brown
      let last = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        last = (last + 0.02 * w) / 1.02;
        d[i] = clamp(last * 3.2, -1, 1);
      }
    }
    // Seamless loop: crossfade the tail into the head, then strip DC.
    const xf = Math.min((SR * 0.05) | 0, (len / 4) | 0);
    for (let i = 0; i < xf; i++) {
      const t = i / xf;
      d[i] = d[i] * t + d[len - xf + i] * (1 - t);
    }
    let dc = 0;
    for (let i = 0; i < len; i++) dc += d[i];
    dc /= len;
    for (let i = 0; i < len; i++) d[i] = clamp(d[i] - dc, -1, 1);
    return buf;
  }

  function noise(kind = 'white') {
    const k = kind === 'pink' || kind === 'brown' ? kind : 'white';
    if (!noiseCache[k]) noiseCache[k] = makeNoise(k, k === 'white' ? 2.5 : 6);
    return noiseCache[k];
  }

  /* --------------------------------------------------------------- reverb */
  const revIn = ctx.createGain();
  revIn.gain.value = 1;
  const revOut = ctx.createGain();
  revOut.gain.value = 0.5;
  revOut.connect(master);

  let reverbOk = false;
  if (typeof ctx.createConvolver === 'function') {
    try {
      const secs = 1.9;
      const len = Math.max(1, (SR * secs) | 0);
      const ir = ctx.createBuffer(2, len, SR);
      if (ir && typeof ir.getChannelData === 'function') {
        for (let c = 0; c < 2; c++) {
          const ch = ir.getChannelData(c);
          if (!ch) continue;
          for (let i = 0; i < len; i++) {
            const t = i / len;
            // early reflections + exponential diffuse tail
            const env = Math.pow(1 - t, 2.6) * (1 + (i < SR * 0.02 ? 1.6 : 0));
            ch[i] = (Math.random() * 2 - 1) * env * 0.62;
          }
        }
        const conv = ctx.createConvolver();
        conv.buffer = ir;
        conv.normalize = true;
        const damp = ctx.createBiquadFilter();
        damp.type = 'lowpass';
        setAt(damp.frequency, 3600, 0);
        revIn.connect(conv); conv.connect(damp); damp.connect(revOut);
        reverbOk = true;
      }
    } catch (e) { reverbOk = false; }
  }
  if (!reverbOk && typeof ctx.createDelay === 'function') {
    // Fallback: a tiny two-tap feedback delay network.
    try {
      const fb = ctx.createGain(); fb.gain.value = 0.42;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; setAt(lp.frequency, 2600, 0);
      const d1 = ctx.createDelay(1.0); setAt(d1.delayTime, 0.071, 0);
      const d2 = ctx.createDelay(1.0); setAt(d2.delayTime, 0.113, 0);
      revIn.connect(d1); revIn.connect(d2);
      d1.connect(lp); d2.connect(lp);
      lp.connect(fb); fb.connect(d1); fb.connect(d2);
      lp.connect(revOut);
      reverbOk = true;
    } catch (e) { reverbOk = false; }
  }

  /* ----------------------------------------------------------- node makers */
  const hasPan = typeof ctx.createStereoPanner === 'function';

  function gain(v = 1) {
    const g = ctx.createGain();
    g.gain.value = clamp(fin(v, 1), 0, 8);
    return g;
  }

  function filter(type, freq, q) {
    const f = ctx.createBiquadFilter();
    f.type = type || 'lowpass';
    setAt(f.frequency, clamp(fin(freq, 1000), 10, 20000), 0);
    if (q !== undefined) setAt(f.Q, clamp(fin(q, 1), 0.0001, 40), 0);
    return f;
  }

  function panner(p) {
    if (!hasPan) return null;
    try {
      const n = ctx.createStereoPanner();
      setAt(n.pan, clamp(fin(p, 0), -1, 1), 0);
      return n;
    } catch (e) { return null; }
  }

  /**
   * A per-sound channel strip: level -> [pan] -> bus, plus a reverb send.
   * Returns the node every voice of that sound should connect into. Once the
   * sources stop the strip has no inputs, makes no sound and is collectable.
   */
  function channel(o) {
    o = o || {};
    const lvl = gain(clamp(fin(o.gain, 1), 0, 4));
    const bus = o.bus || sfxBus;
    const p = panner(o.pan);
    if (p) { lvl.connect(p); p.connect(bus); } else { lvl.connect(bus); }
    const rev = clamp(fin(o.rev, 0), 0, 1);
    if (rev > 0.001 && reverbOk) {
      const send = gain(rev);
      lvl.connect(send);
      send.connect(revIn);
    }
    return lvl;
  }

  /* --------------------------------------------------------------- voices */

  /** One oscillator voice with an optional pitch glide and a perc envelope. */
  function tone(o) {
    if (!o || !o.dest) return null;
    const t = Math.max(0, fin(o.t, ctx.currentTime));
    const dur = clamp(fin(o.dur, 0.2), 0.008, 12);
    const peak = clamp(fin(o.gain, 0.3), 0, 4);
    if (peak <= 0) return null;
    let osc;
    try { osc = ctx.createOscillator(); } catch (e) { return null; }
    osc.type = o.type || 'sine';
    const f0 = clamp(fin(o.f0, 220), 0.02, 20000);
    const f1 = clamp(fin(o.f1, f0), 0.02, 20000);
    setAt(osc.frequency, f0, t);
    if (Math.abs(f1 - f0) > 0.01) {
      const gl = clamp(fin(o.glide, dur * 0.55), 0.002, dur);
      expTo(osc.frequency, f1, t + gl);
    }
    if (o.detune) setAt(osc.detune, clamp(fin(o.detune, 0), -2400, 2400), t);

    const g = gain(0);
    if (o.hold !== undefined) ahdsr(g.gain, t, peak, o.attack, o.hold, o.release);
    else perc(g.gain, t, peak, o.attack, dur);

    let node = osc;
    if (o.lp || o.bp || o.hp) {
      const f = filter(o.hp ? 'highpass' : o.bp ? 'bandpass' : 'lowpass',
                       o.lp || o.bp || o.hp, o.q);
      if (o.lpEnd) expTo(f.frequency, o.lpEnd, t + dur);
      node.connect(f); node = f;
    }
    node.connect(g);
    g.connect(o.dest);

    // Optional vibrato — a small LFO on the oscillator frequency.
    if (o.vib) {
      try {
        const lfo = ctx.createOscillator();
        lfo.type = 'sine';
        setAt(lfo.frequency, clamp(fin(o.vibRate, 5.2), 0.05, 40), t);
        const amt = gain(clamp(fin(o.vib, 3), 0, 400));
        lfo.connect(amt); amt.connect(osc.frequency);
        lfo.start(t); lfo.stop(t + dur + 0.05);
      } catch (e) { /* ignore */ }
    }

    const total = t + (o.hold !== undefined
      ? clamp(fin(o.attack, 0.05), 0, 6) + clamp(fin(o.hold, 0.3), 0, 20) +
        clamp(fin(o.release, 0.3), 0, 12)
      : dur) + 0.05;
    try { osc.start(t); osc.stop(total); } catch (e) { /* ignore */ }
    return osc;
  }

  /** One filtered noise voice. */
  function noiseVoice(o) {
    if (!o || !o.dest) return null;
    const buf = noise(o.noise || 'white');
    if (!buf) return null;
    const t = Math.max(0, fin(o.t, ctx.currentTime));
    const dur = clamp(fin(o.dur, 0.15), 0.006, 12);
    const peak = clamp(fin(o.gain, 0.2), 0, 4);
    if (peak <= 0) return null;
    let src;
    try { src = ctx.createBufferSource(); } catch (e) { return null; }
    src.buffer = buf;
    src.loop = true;
    if (src.playbackRate) {
      setAt(src.playbackRate, clamp(fin(o.rate, 1), 0.06, 8), t);
    }

    let node = src;
    const type = o.hp ? 'highpass' : o.bp ? 'bandpass' : 'lowpass';
    const f0 = o.hp || o.bp || o.lp || 1200;
    const f = filter(type, f0, o.q === undefined ? (o.bp ? 1.1 : 0.9) : o.q);
    if (o.fEnd) expTo(f.frequency, o.fEnd, t + clamp(fin(o.fGlide, dur), 0.005, dur));
    node.connect(f); node = f;

    if (o.lp2) {
      const f2 = filter('lowpass', o.lp2, 0.7);
      node.connect(f2); node = f2;
    }

    const g = gain(0);
    if (o.hold !== undefined) ahdsr(g.gain, t, peak, o.attack, o.hold, o.release);
    else perc(g.gain, t, peak, o.attack === undefined ? 0.002 : o.attack, dur);
    node.connect(g);
    g.connect(o.dest);

    const total = t + (o.hold !== undefined
      ? clamp(fin(o.attack, 0.05), 0, 6) + clamp(fin(o.hold, 0.3), 0, 20) +
        clamp(fin(o.release, 0.3), 0, 12)
      : dur) + 0.05;
    try {
      const off = Math.random() * Math.max(0.01, fin(buf.duration, 1) - 0.2);
      src.start(t, off);
      src.stop(total);
    } catch (e) {
      try { src.start(t); src.stop(total); } catch (e2) { /* ignore */ }
    }
    return src;
  }

  /** A looping noise source for the ambience beds (caller stops it). */
  function noiseLoop(kind, dest, level) {
    const buf = noise(kind);
    if (!buf) return null;
    let src;
    try { src = ctx.createBufferSource(); } catch (e) { return null; }
    src.buffer = buf;
    src.loop = true;
    const g = gain(clamp(fin(level, 0.1), 0, 4));
    src.connect(g);
    if (dest) g.connect(dest);
    return { src, out: g };
  }

  /** Slow LFO -> AudioParam modulation, used by the ocean / wind beds. */
  function lfo(rate, depth, target, t) {
    try {
      const o = ctx.createOscillator();
      o.type = 'sine';
      setAt(o.frequency, clamp(fin(rate, 0.1), 0.005, 40), t);
      const a = gain(clamp(fin(depth, 1), 0, 20000));
      o.connect(a);
      if (target) a.connect(target);
      o.start(Math.max(0, fin(t, 0)));
      return o;
    } catch (e) { return null; }
  }

  return {
    ctx, master, tail, sfxBus, musicBus, ambBus,
    revIn, revOut, reverbOk, sampleRate: SR,
    now: () => fin(ctx.currentTime, 0),
    gain, filter, panner, channel, tone, noiseVoice, noiseLoop, lfo, noise
  };
}
