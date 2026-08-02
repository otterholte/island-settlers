/**
 * Island Settlers — the MOOD of every hex, and the one shader that paints it.
 *
 *   syncMood()                  poll + smooth the per-tile read (idempotent)
 *   MOOD[tileId]                { tone, own, spent, flash, exhausted, ... }
 *   applyMood(material)         inject the tint into any Lambert/standard mat
 *   moodAttrFromList(list)      per-INSTANCE aMood for an InstancedMesh
 *   moodAttrFromPositions(geo)  per-VERTEX aMood for a baked / ground mesh
 *   moodTint(tileId, out)       the same tint as a plain rgb multiplier
 *
 *   startVictoryFlood(pid, o)   END OF MATCH: sweep every hex to the winner's
 *   floodWinner(hex, p01)       colour. Full contract in the block headed
 *   updateVictoryFlood(dt)      "THE VICTORY FLOOD" further down this file;
 *   stopVictoryFlood()          all of it is re-exported from `buildProps`, so
 *   victoryFloodActive()        the flow layer reaches it as
 *   floodProgress() floodOf(t)  `game.world.props.startVictoryFlood(pid)`.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * Three times now the player has said the same thing:
 *
 *   "It's still way too hard to tell which hexes I can use and which I can't.
 *    Make it much more drastic and clear."
 *   "I still want the hexes I can choose from to be even more obvious. Can you
 *    make them glow."
 *
 * A translucent wash over the ground was never going to carry that, because the
 * thing that fills a hex is not the ground — it is four hundred trees, sheep and
 * rocks standing on it. So the separation is applied to the PIXELS THEMSELVES:
 * the terrain, the trees, the flock, the boulders, the wheat. A hex you may work
 * is saturated, warm and lit. A hex you may not is desaturated to near-monochrome
 * and dropped half a stop, cool and inert. There is no reading past it.
 *
 * And now it GLOWS. The tint above is a multiply, and a multiply can only ever
 * take light away or push it around; it cannot make a hex look lit from within,
 * which is what the player is asking for. So a second, additive term is injected
 * further down the shader — into `outgoingLight`, AFTER the sun and the shadow
 * map, so it survives both — that breathes a cool blue emissive over every
 * surface on a hex you may work. Terrain, trunk, fleece and brick all rise and
 * fall together on one clock, and the region layer's rim and light wall
 * (`regions.js`) breathe on the very same uniform, so the whole hex pulses as
 * one object rather than as a decal sitting on top of some scenery.
 *
 *   tone  +1  yours — collect here, and it glows
 *   tone   0  neutral (the desert; nobody's crop)
 *   tone  -1  off limits — you own no corner of it, or the Raider has it shut
 *   spent  1  worked out; calm bare ground, NO glow, a countdown overhead
 *   flash  1  the moment it all comes back
 *
 * SPENT is deliberately the QUIETEST state on the board. It used to crush the
 * hex most of the way to a flat neutral stone colour and sit that under a pile
 * of stumps, churn, scars and a rotating dashed warning band, and the player's
 * verdict was "too overstimulating". It now drains the hex's internal colour,
 * keeps its own terrain ink so you can still see what it was, and drops the
 * value a clear step — one flat, restful tone with a big countdown badge over
 * it and almost nothing left standing on it (see `stand.js` / `nodelife.js`
 * for the residue cull and `regions.js` for the ground treatment).
 *
 * ---------------------------------------------------------------------------
 * ...AND WHAT THE MUTE USED TO COST
 * ---------------------------------------------------------------------------
 * Crushing a hex toward NEUTRAL grey did say "off limits" — and it also said
 * nothing at all about what the hex was. Fifteen of the nineteen hexes on the
 * board are hexes you do not own, and all fifteen of them looked like the same
 * slate-blue smudge: you could not plan a settlement because you could not tell
 * a forest from a mountain from a wheat field from where you were standing.
 *
 * So the mute no longer goes to grey. It goes to a DUOTONE: an off-limits hex
 * is flattened onto ONE colour of its own — deep green for forest, ochre for
 * fields, terracotta for clay, blue-slate for mountains — keeping only the
 * fragment's brightness. Measured against what it replaced, that is a *harder*
 * mute in both directions the eye reads: 88% of the surface's own colour is
 * thrown away instead of 74%, and the value drops to 52% instead of 64%. The
 * hex still looks drained, printed and inert, and next to a hex you own — which
 * keeps every one of its colours, gains a warm lift, an additive blue breath and
 * a light wall around its border — there is no confusing the two.
 *
 * What comes back is identity. Each unowned hex is now one bold flat colour that
 * names its terrain from the far side of the island, and because every surface
 * on the hex is forced onto that ONE colour, the internal variety that would
 * make it look alive is gone. A forest reads as a green print, not as a forest.
 *
 * ---------------------------------------------------------------------------
 * HOW IT REACHES THE GPU
 * ---------------------------------------------------------------------------
 * A 19x2 RGBA byte texture, one column per hex — updated for the price of 152
 * bytes a frame and shared by every material in the world. The bottom row is
 * the live state (tone, spent, flash, and in ALPHA the end-of-match victory
 * flood, which is zero for the whole match); the top row is that hex's ink,
 * a fixed colour derived from its terrain. Each mesh carries an `aMood`
 * attribute of (tileIndex, influence): per-vertex on the baked ground,
 * per-instance on the four hundred instanced props. A mesh that has no `aMood`
 * gets the constant generic attribute (0, 0) and is simply left alone, which is
 * exactly the right default for boats, roads and buildings.
 *
 * Owner: World agent.
 */

import * as THREE from 'three';
import { PLAYER_COLORS } from '../core/constants.js';
import { tiles } from '../board/layout.js';
import {
  tileFraction, tileRecovery, isTileExhausted, tileItemsRemaining, tileItemCount
} from '../board/nodes.js';
import { playerOwnsTile, canGatherTile } from '../core/rules.js';
import { minFrac, nearestTile } from './terrain.js';

const N = tiles.length;
const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Read-only peek at the running match. Always optional. */
function match() {
  const g = typeof globalThis !== 'undefined' ? globalThis : null;
  return (g && g.__ISLAND__) || null;
}

/* ==================================================================== state */

export const MOOD = tiles.map(t => ({
  id: t.id,
  terrain: t.terrain,
  resource: t.resource || null,
  workable: !!t.resource,
  // Starts at the neutral middle so the opening flyover is not a dead island.
  own: 0.55, ownWant: 0.55,     // 0..1 — do I hold a corner of this hex
  spent: 0, spentWant: 0,       // 0..1 — worked out
  flash: 0,                     // 0..1 — the regrowth beat
  blocked: false,
  // which terrain the duotone ink in the texture was last painted for
  inkFor: null,
  exhausted: false, wasExhausted: false,
  fraction: 1, seconds: 0, progress: 1,
  remaining: 0, capacity: 0,
  tone: 0
}));

/** Fired once when a hex refills, so the world can play a beat. */
const restoredHooks = [];
export function onRestored(fn) { restoredHooks.push(fn); }
const spentHooks = [];
export function onSpent(fn) { spentHooks.push(fn); }

/* --------------------------------------------------------- the duotone ink
 *
 * The one colour an off-limits hex prints in. Authored as the terrain's own
 * hue at a strength that still reads across the island, then normalised in
 * `inkOf` so every ink has luminance 1 — the shader multiplies it by the
 * fragment's own brightness, so the ink decides HUE and nothing else, and every
 * unowned hex ends up at exactly the same value no matter what terrain it is.
 * That is what keeps the mute even: forest cannot end up darker than fields
 * just because leaves are darker than wheat.
 */
const INK_HEX = {
  forest:    0x3f8a4a,   // deep leaf green
  fields:    0xd9a83a,   // ripe gold
  pasture:   0xa8c452,   // yellow-green turf — deliberately far from forest
  hills:     0xb06f4e,   // wet clay
  mountains: 0x7d93b5,   // blue-slate
  desert:    0xcdb188    // pale sand
};

/**
 * How far each ink leans from a cool neutral toward its terrain hue. Zero would
 * be the old grey-out exactly; one would be full-strength poster paint. 0.70 is
 * where a wheat hex is unmistakably golden and still plainly switched off.
 */
const INK_CHROMA = 0.70;

/** Cool neutral (luminance 1) the inks are mixed out of — the old grey's tilt. */
const COOL = [0.936, 0.998, 1.206];

/** The largest channel any ink may carry; the byte texture encodes v / INK_ENC. */
const INK_ENC = 2.5;

const _ink = new THREE.Color();
const lumOf = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function inkOf(terrain) {
  _ink.setHex(INK_HEX[terrain] || INK_HEX.desert, THREE.SRGBColorSpace);
  let l = lumOf(_ink.r, _ink.g, _ink.b) || 1;
  const out = [
    COOL[0] + (_ink.r / l - COOL[0]) * INK_CHROMA,
    COOL[1] + (_ink.g / l - COOL[1]) * INK_CHROMA,
    COOL[2] + (_ink.b / l - COOL[2]) * INK_CHROMA
  ];
  l = lumOf(out[0], out[1], out[2]) || 1;
  for (let i = 0; i < 3; i++) out[i] = clamp01(out[i] / l / INK_ENC);
  return out;
}

/* ------------------------------------------------------------- the texture */

/* Two rows: row 0 is the live state, row 1 is the duotone ink. */
const data = new Uint8Array(N * 2 * 4);
export const moodTexture = new THREE.DataTexture(data, N, 2, THREE.RGBAFormat);
moodTexture.magFilter = THREE.NearestFilter;
moodTexture.minFilter = THREE.NearestFilter;
moodTexture.wrapS = THREE.ClampToEdgeWrapping;
moodTexture.wrapT = THREE.ClampToEdgeWrapping;
moodTexture.generateMipmaps = false;
moodTexture.needsUpdate = true;

const uMoodTex = { value: moodTexture };
const uMoodN = { value: N };

/**
 * The one clock the whole ownership read breathes on. Exported as a live
 * uniform object (not a number) so `regions.js` can hand the very same
 * reference to its own ShaderMaterial: the ground rim, the light wall and the
 * emissive on every tree standing inside it then pulse in exact lockstep, with
 * no second timer to drift.
 */
export const uMoodTime = { value: 0 };

/** Radians per second of the ownership breath. Slow — this is a heartbeat, not
 *  a strobe, and it has to sit under the game for four minutes at a time. */
export const GLOW_HZ = 1.85;

/* ===========================================================================
 * THE VICTORY FLOOD
 * ===========================================================================
 *
 *   "I don't understand why random tiles light up at the end when someone wins,
 *    it seems to be random tiles. Could you actually animate that all of the
 *    hexes/tiles turn into the color of the winner, and then the celebration
 *    happens right after that."
 *
 * ---------------------------------------------------------------------------
 * THE API — this is what the flow layer drives
 * ---------------------------------------------------------------------------
 * Everything below is re-exported from the object `buildProps(scene)` returns,
 * which `main.js` hangs on the world, so from `systems/matchflow.js`:
 *
 *     const props = game.world.props;          // may be a stub — see below
 *
 *     // 1. FIRE AND FORGET (the normal way). Starts the wave and advances it
 *     //    on the clock inside props.update(dt), which main.js already calls
 *     //    every frame. Returns the TOTAL SECONDS the whole thing will take,
 *     //    so the celebration can be scheduled for straight afterwards.
 *     const secs = props.startVictoryFlood(winnerPlayerId);
 *     //  -> startVictoryFlood(pid, opts?) -> seconds
 *     //     pid   0..3, the winning player's index. Its colour comes from
 *     //           PLAYER_COLORS[pid].hex and the wave starts on the hexes that
 *     //           player holds, spreading outward from them across the island.
 *     //     opts  { color: 0xRRGGBB,   override the winner's colour
 *     //             from: [tileId,..], override the seed hexes ([] = centre)
 *     //             duration: 2.4,     seconds for the wave to cross the board
 *     //             hold: 1.0 }        seconds fully flooded before it lets go
 *     //     Returns duration + hold.
 *
 *     // 2. DRIVE IT BY HAND, if the flow layer would rather own the clock.
 *     props.floodWinner(0xd0472f, 0.55);   // colour, progress 0..1
 *     //  -> floodWinner(playerColorHex, progress01)
 *     //     progress 0 = untouched island, 1 = every hex in the winner's
 *     //     colour. Safe to call every frame with your own easing; it cancels
 *     //     any running clock and takes over. Seeds default to the island
 *     //     centre unless startVictoryFlood set them first.
 *
 *     // 3. HOUSEKEEPING
 *     props.stopVictoryFlood();            // instantly back to normal colour
 *     props.victoryFloodActive();          // bool
 *     props.floodProgress();               // 0..1, the wave's global progress
 *
 * If nothing ever calls any of it, every per-hex value stays at zero, the
 * texture's alpha channel stays at zero, and the shader's flood branch never
 * fires. It degrades to nothing.
 *
 * ---------------------------------------------------------------------------
 * HOW IT LOOKS
 * ---------------------------------------------------------------------------
 * Not nineteen hexes switching on in sequence, which is what "random tiles
 * flickering" was. Every hex is given an ORDER KEY — its distance from the
 * nearest hex the winner holds, normalised across the board — and a band of
 * width `BAND` sweeps that key from 0 to 1. Any hex the band is crossing is
 * part way over, so at every instant there is a continuous WAVEFRONT travelling
 * outward from the winner's own land: terrain, trees, sheep, boulders and
 * stumps all turning together, because they all read the same per-hex texture.
 * The crest of the wave gets an additive lift in the winner's colour so the
 * edge of it is a visible line of light rather than a soft gradient.
 */

const FLOOD = {
  running: false,      // the internal clock is advancing
  manual: false,       // floodWinner() is driving instead
  t: 0,
  duration: 2.4,
  hold: 1.0,
  progress: 0,
  key: new Float32Array(N),   // 0..1 order key per hex, seeded on start
  val: new Float32Array(N)    // 0..1 how flooded each hex is right now
};

/** Width of the travelling wavefront, in units of the order key. */
const BAND = 0.36;

/** The winner's colour, in the renderer's working (linear) space. */
export const uFloodColor = { value: new THREE.Color(0xffc93c) };

/* The board is re-dealt between matches and `tiles` is mutated in place, so the
   ink row is refreshed off the LIVE terrain whenever a hex changes under us.

   Row 0's ALPHA channel carries the victory flood (see the block below). It is
   zero for the whole match and nothing reads it until the flood is started, so
   a build that never calls the flood API behaves exactly as it did before. */
function writeTexture() {
  const inkRow = N * 4;
  for (let i = 0; i < N; i++) {
    const m = MOOD[i];
    data[i * 4] = Math.round(clamp01((m.tone + 1) * 0.5) * 255);
    data[i * 4 + 1] = Math.round(clamp01(m.spent) * 255);
    data[i * 4 + 2] = Math.round(clamp01(m.flash) * 255);
    data[i * 4 + 3] = Math.round(clamp01(FLOOD.val[i]) * 255);

    const terrain = tiles[i] ? tiles[i].terrain : m.terrain;
    if (terrain !== m.inkFor) {
      m.inkFor = terrain;
      m.terrain = terrain;
      const ink = inkOf(terrain);
      data[inkRow + i * 4] = Math.round(ink[0] * 255);
      data[inkRow + i * 4 + 1] = Math.round(ink[1] * 255);
      data[inkRow + i * 4 + 2] = Math.round(ink[2] * 255);
      data[inkRow + i * 4 + 3] = 255;
    }
  }
  moodTexture.needsUpdate = true;
}
writeTexture();

/* ==================================================================== poll */

let lastMs = -1;
let clock = 0;

/**
 * Re-sample the match and advance the smoothing. Safe to call from as many
 * places as you like in a frame — it does the work at most every 60ms and
 * measures its own elapsed time, so island.js and props.js can both ask.
 */
export function syncMood() {
  const now = (typeof performance !== 'undefined' && performance.now)
    ? performance.now() : Date.now();
  if (lastMs < 0) { lastMs = now; }
  const dt = Math.min(0.25, (now - lastMs) / 1000);
  if (dt < 0.016) return MOOD;
  lastMs = now;
  clock += dt;
  uMoodTime.value = clock;

  const I = match();
  const state = I && I.state;
  const playing = !!state && state.phase === 'play';
  const time = state ? state.time : 0;

  for (let i = 0; i < N; i++) {
    const m = MOOD[i];
    if (!m.workable) {
      m.tone = 0; m.spent = 0; m.flash = Math.max(0, m.flash - dt * 0.6);
      continue;
    }

    let owns = false, mayWork = false;
    if (state && state.buildings) {
      try {
        owns = playerOwnsTile(state, 0, m.id);
        mayWork = canGatherTile(state, 0, m.id);
      } catch (e) { owns = false; mayWork = false; }
    }
    m.blocked = owns && !mayWork;

    m.fraction = tileFraction(m.id);
    m.remaining = tileItemsRemaining(m.id);
    m.capacity = tileItemCount(m.id);
    m.exhausted = isTileExhausted(m.id);
    const rc = tileRecovery(m.id, time);
    m.seconds = rc.secondsLeft;
    m.progress = rc.progress;

    // Before the draft has finished nobody owns anything; showing fifteen dead
    // hexes during the opening flyover would be a lie about the board.
    m.ownWant = playing ? (mayWork ? 1 : 0) : 0.55;
    m.spentWant = m.exhausted ? 1 : 0;

    if (m.exhausted && !m.wasExhausted) {
      m.wasExhausted = true;
      for (const fn of spentHooks) { try { fn(m); } catch (e) { /* optional */ } }
    } else if (!m.exhausted && m.wasExhausted) {
      m.wasExhausted = false;
      m.flash = 1;
      for (const fn of restoredHooks) { try { fn(m); } catch (e) { /* optional */ } }
    }

    m.own += (m.ownWant - m.own) * Math.min(1, dt * 3.4);
    m.spent += (m.spentWant - m.spent) * Math.min(1, dt * (m.spentWant ? 3.2 : 2.4));
    if (m.flash > 0) m.flash = Math.max(0, m.flash - dt * 0.62);

    // Before play begins every hex sits at the neutral middle; once the match
    // is live the five you own go to +1 and the rest fall away to -1.
    m.tone = playing ? (m.own * 2 - 1) : (m.own - 0.55) * 2;
  }

  writeTexture();
  return MOOD;
}

export function moodOf(tileId) { return MOOD[tileId] || null; }

/* ========================================================= the flood, driven */

/** Every hex the given player holds a corner of. Empty if we cannot tell. */
function heldTiles(pid) {
  const I = match();
  const state = I && I.state;
  const out = [];
  if (!state || !state.buildings) return out;
  for (const t of tiles) {
    try { if (playerOwnsTile(state, pid, t.id)) out.push(t.id); }
    catch (e) { /* mid-restart; fall back to the centre */ }
  }
  return out;
}

/**
 * Give every hex its place in the queue: distance from the nearest seed hex,
 * normalised so the furthest corner of the island lands at 1. With no seeds at
 * all it falls back to distance from the middle of the board, which sweeps the
 * island from the centre outward — still ordered, still legible.
 */
function seedOrder(from) {
  const seeds = [];
  if (Array.isArray(from)) {
    for (const id of from) {
      const t = tiles[id];
      if (t) seeds.push(t);
    }
  }
  let hi = 0;
  for (let i = 0; i < N; i++) {
    const t = tiles[i];
    if (!t) { FLOOD.key[i] = 0; continue; }
    let d = Infinity;
    if (seeds.length) {
      for (const s of seeds) {
        const dd = Math.hypot(t.x - s.x, t.z - s.z);
        if (dd < d) d = dd;
      }
    } else {
      d = Math.hypot(t.x, t.z);
    }
    FLOOD.key[i] = d;
    if (d > hi) hi = d;
  }
  const inv = 1 / (hi || 1);
  for (let i = 0; i < N; i++) FLOOD.key[i] *= inv;
}

/** Resolve the per-hex values for a global progress and push them to the GPU. */
function applyFloodProgress(p) {
  FLOOD.progress = clamp01(p);
  // The wave has to travel a little past 1 for the last hex to finish filling,
  // hence the (1 + BAND) span.
  const front = FLOOD.progress * (1 + BAND);
  for (let i = 0; i < N; i++) {
    const v = (front - FLOOD.key[i]) / BAND;
    FLOOD.val[i] = v < 0 ? 0 : v > 1 ? 1 : v;
  }
  writeTexture();
}

function setFloodColor(hex) {
  if (hex === undefined || hex === null) return;
  uFloodColor.value.setHex(hex >>> 0, THREE.SRGBColorSpace);
}

/**
 * Start the wave and let it run itself. See the long comment above for the
 * full contract; `props.update(dt)` advances it, so the caller only ever needs
 * this one line. Returns the total seconds the sequence will take.
 */
export function startVictoryFlood(pid, opts = {}) {
  const p = PLAYER_COLORS[pid | 0];
  setFloodColor(opts.color !== undefined ? opts.color : (p ? p.hex : 0xffc93c));
  seedOrder(opts.from !== undefined ? opts.from : heldTiles(pid | 0));
  FLOOD.duration = Math.max(0.2, +opts.duration || 2.4);
  FLOOD.hold = Math.max(0, opts.hold === undefined ? 1.0 : +opts.hold);
  FLOOD.t = 0;
  FLOOD.running = true;
  FLOOD.manual = false;
  applyFloodProgress(0);
  return FLOOD.duration + FLOOD.hold;
}

/**
 * Drive the wave by hand: colour plus a 0..1 progress. Cancels the internal
 * clock, so a flow layer that would rather own the easing can simply call this
 * every frame.
 */
export function floodWinner(playerColorHex, progress01) {
  setFloodColor(playerColorHex);
  if (!FLOOD.manual && !FLOOD.running) seedOrder(null);
  FLOOD.running = false;
  FLOOD.manual = true;
  applyFloodProgress(+progress01 || 0);
}

/** Advance the internal clock. Harmless — and free — when nothing is running. */
export function updateVictoryFlood(dt) {
  if (!FLOOD.running) return;
  FLOOD.t += dt;
  applyFloodProgress(FLOOD.t / FLOOD.duration);
}

/** Back to normal colour immediately. */
export function stopVictoryFlood() {
  FLOOD.running = false;
  FLOOD.manual = false;
  applyFloodProgress(0);
}

export function victoryFloodActive() {
  return (FLOOD.running || FLOOD.manual) && FLOOD.progress > 0;
}

/** The wave's global progress, 0..1. */
export function floodProgress() { return FLOOD.progress; }

/** How flooded one hex is right now, 0..1 — the region layer fades against it. */
export function floodOf(tileId) {
  const v = FLOOD.val[tileId | 0];
  return v > 0 ? v : 0;
}

/* ============================================================== attributes */

/**
 * Per-instance aMood for an InstancedMesh whose instance list carries `.tile`.
 * A tile of -1 (the shoreline collar) gets zero influence and is never tinted.
 */
export function moodAttrFromList(list) {
  const arr = new Float32Array(list.length * 2);
  for (let i = 0; i < list.length; i++) {
    const t = list[i].tile;
    arr[i * 2] = t >= 0 ? t : 0;
    arr[i * 2 + 1] = t >= 0 ? 1 : 0;
  }
  return new THREE.InstancedBufferAttribute(arr, 2);
}

/**
 * Per-vertex aMood sampled straight off world positions. Influence fades out
 * across the tan road strip so the border, the cliffs and the beach keep their
 * own colour — the tint belongs to the hex TOP, which is the part you work.
 */
export function moodAttrFromPositions(geo, fade0 = 0.78, fade1 = 0.96) {
  const pos = geo.attributes.position;
  const n = pos.count;
  const arr = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const t = nearestTile(x, z);
    const f = minFrac(x, z);
    let k = 1 - (f - fade0) / (fade1 - fade0);
    k = k < 0 ? 0 : k > 1 ? 1 : k;
    arr[i * 2] = t ? t.id : 0;
    arr[i * 2 + 1] = k * k * (3 - 2 * k);
  }
  return new THREE.BufferAttribute(arr, 2);
}

/* ================================================================== shader */

const MOOD_PARS_VERT = /* glsl */`
attribute vec2 aMood;
uniform sampler2D uMoodTex;
uniform float uMoodN;
varying vec3 vMood;
varying vec3 vInk;
varying float vFlood;
`;

const MOOD_BODY_VERT = /* glsl */`
{
  float mu = (aMood.x + 0.5) / uMoodN;
  vec4 md = texture2D(uMoodTex, vec2(mu, 0.25));
  vMood = vec3(md.r * 2.0 - 1.0, md.g, md.b) * aMood.y;
  vInk = texture2D(uMoodTex, vec2(mu, 0.75)).rgb * ${INK_ENC.toFixed(2)};
  // The victory flood rides the alpha channel. It uses a HARDER influence curve
  // than the tint does: the ground's per-vertex influence tapers off across the
  // tan border strip so the mood tint stays on the hex top, but the flood is
  // supposed to swallow the whole island, so anything with any influence at all
  // is taken all the way. A mesh with no aMood (boats, roads, buildings) still
  // gets the constant (0, 0) and is still left completely alone.
  vFlood = md.a * smoothstep(0.0, 0.30, aMood.y);
}
`;

const MOOD_PARS_FRAG = /* glsl */`
varying vec3 vMood;
varying vec3 vInk;
varying float vFlood;
uniform float uMoodTime;
uniform vec3 uFloodCol;
`;

/*
 * The whole "mine / not mine" read, in eight lines of arithmetic.
 *
 *  OFF LIMITS  printed as a DUOTONE in the hex's own ink: 88% of the surface's
 *              colour thrown away, only its brightness kept, and the whole thing
 *              dropped to 52% value. Harder than the grey-out it replaces on
 *              both counts — and a forest you cannot chop is still green, a
 *              mountain is still slate and a clay hill is still red, so you can
 *              read the board you are planning your next settlement on.
 *  YOURS       pushed the other way: saturation up, a warm bias, and a lift in
 *              the shadows so the hex reads as sunlit rather than merely bright.
 *  SPENT       flat grey. Stubble, spoil and stumps, and nothing worth walking
 *              across until the clock overhead runs out.
 *  FLASH       one bright green beat as the whole hex comes back.
 */
const MOOD_BODY_FRAG = /* glsl */`
{
  float mTone = vMood.x, mSpent = vMood.y, mFlash = vMood.z;
  float mLum = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  if (mTone < -0.003) {
    // vInk carries luminance 1, so this is the fragment's own brightness in the
    // hex's colour and nothing else — one flat ink across terrain, trunk,
    // fleece and brick alike. That uniformity is what reads as "switched off".
    vec3 dead = mix(diffuseColor.rgb, vec3(mLum) * vInk, 0.88) * 0.52;
    diffuseColor.rgb = mix(diffuseColor.rgb, dead, -mTone);
  } else if (mTone > 0.003) {
    vec3 lit = clamp(diffuseColor.rgb * vec3(1.22, 1.14, 0.95)
                     + vec3(0.060, 0.046, 0.016), 0.0, 1.0);
    diffuseColor.rgb = mix(diffuseColor.rgb, lit, mTone);
  }
  if (mSpent > 0.003) {
    // CALM, not grey.
    //
    //   "Make the empty hexes once the resources are gone look more empty and
    //    less busy. Right now it's too overstimulating."
    //
    // The old treatment crushed a spent hex almost the whole way to a flat
    // neutral stone colour. That did say "worked out" — and it also threw away
    // the terrain identity the duotone pass had just bought back, and it sat a
    // hard grey plate underneath an already noisy pile of residue.
    //
    // This is quieter in every direction that matters. The hex keeps its OWN
    // ink (so a cleared forest is still plainly a forest and a cleared mountain
    // is still slate), most of its internal colour variation is drained so
    // nothing on it competes for attention, and the value comes down a clear
    // step. Restful bare ground with a countdown over it — which is exactly
    // what a spent hex is.
    vec3 rest = mix(diffuseColor.rgb, vec3(mLum) * vInk, 0.74) * 0.64;
    diffuseColor.rgb = mix(diffuseColor.rgb, rest, mSpent * 0.88);
  }
  if (mFlash > 0.003) {
    diffuseColor.rgb = mix(diffuseColor.rgb,
      clamp(diffuseColor.rgb * 1.85 + vec3(0.09, 0.24, 0.05), 0.0, 1.0), mFlash * 0.85);
  }
  // THE VICTORY FLOOD, last and over the top of everything else. The surface
  // keeps its own light and shade — a tree is still darker than the grass it
  // stands on — but every hue on the hex is replaced by the winner's, so a
  // flooded forest, a flooded mountain and a flooded wheat field are one solid
  // block of their colour with the island's modelling still visible in it.
  if (vFlood > 0.002) {
    float fl = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
    vec3 won = clamp(uFloodCol * (0.32 + 1.15 * fl), 0.0, 1.0);
    diffuseColor.rgb = mix(diffuseColor.rgb, won, vFlood);
  }
}
`;

/*
 * THE GLOW.
 *
 * Everything above is a multiply on the ALBEDO, and no multiply can make a
 * surface look lit from inside — the best it can do is stop taking light away.
 * That is why two rounds of "warm bias plus a rim" did not land.
 *
 * This term is different in three ways that matter:
 *
 *   1. It is ADDITIVE, and it goes into `outgoingLight` — after the sun, the
 *      hemisphere fill and the shadow map. A tree standing in its own shadow on
 *      a hex you own still glows; nothing can subtract it back out.
 *   2. It BREATHES, on the shared `uMoodTime`, between 30% and 100% of its
 *      amplitude roughly every three and a half seconds. Motion is what the
 *      periphery actually detects — a static tint at this strength reads as
 *      "that hex is a slightly different colour", and a breathing one reads as
 *      "that hex is alive".
 *   3. It is COOL and small in the red channel (0.026 / 0.054 / 0.110 at full
 *      amplitude, in linear light). Terrain and items keep their own hue —
 *      grass stays green, brick stays terracotta, gold stays gold — they simply
 *      sit in a pool of the player's blue. Anything stronger and a wheat hex
 *      goes lilac, which is the "washing out" failure this had to avoid.
 *
 * It dies completely when the hex is worked out (`mSpent`), so a cleared hex is
 * grey, still and counting down, and lights straight back up on restore.
 */
const MOOD_GLOW_FRAG = /* glsl */`
{
  float gTone = vMood.x, gSpent = vMood.y;
  float glow = max(gTone, 0.0) * (1.0 - gSpent) * (1.0 - vFlood);
  if (glow > 0.004) {
    float breath = 0.30 + 0.70 * (0.5 + 0.5 * sin(uMoodTime * ${GLOW_HZ.toFixed(2)}));
    outgoingLight += vec3(0.026, 0.054, 0.110) * glow * breath;
  }
  if (vFlood > 0.002) {
    // The CREST of the wave. A hex part way through the sweep gets a bright
    // additive lift in the winner's colour, peaking dead in the middle of the
    // transition, so the leading edge of the flood reads as a line of light
    // running outward across the island instead of a soft cross-fade. What is
    // left behind it keeps a small steady lift, so the flooded island looks
    // lit in their colour rather than merely painted it.
    float crest = sin(vFlood * 3.14159265);
    outgoingLight += uFloodCol * (crest * crest * 0.52 + vFlood * 0.10);
  }
}
`;

/**
 * Inject the tint into a material. Composes with whatever `onBeforeCompile` the
 * material already had (the wind shaders in props.js), and extends its cache key
 * so the two never share a compiled program.
 */
export function applyMood(mat) {
  if (!mat || mat.userData.__mood) return mat;
  mat.userData.__mood = true;
  const prevCompile = mat.onBeforeCompile;
  const prevKey = mat.customProgramCacheKey;

  mat.onBeforeCompile = (sh, renderer) => {
    if (prevCompile) prevCompile.call(mat, sh, renderer);
    sh.uniforms.uMoodTex = uMoodTex;
    sh.uniforms.uMoodN = uMoodN;
    sh.uniforms.uMoodTime = uMoodTime;
    sh.uniforms.uFloodCol = uFloodColor;
    sh.vertexShader = MOOD_PARS_VERT + sh.vertexShader;
    sh.vertexShader = sh.vertexShader.replace(
      '#include <begin_vertex>', '#include <begin_vertex>\n' + MOOD_BODY_VERT);
    sh.fragmentShader = MOOD_PARS_FRAG + sh.fragmentShader;
    sh.fragmentShader = sh.fragmentShader.replace(
      '#include <color_fragment>', '#include <color_fragment>\n' + MOOD_BODY_FRAG);
    // r152 renamed <output_fragment> to <opaque_fragment>; accept either so the
    // glow never silently vanishes if the vendored three is swapped out.
    const hook = sh.fragmentShader.indexOf('#include <opaque_fragment>') >= 0
      ? '#include <opaque_fragment>'
      : (sh.fragmentShader.indexOf('#include <output_fragment>') >= 0
        ? '#include <output_fragment>' : null);
    if (hook) {
      sh.fragmentShader = sh.fragmentShader.replace(hook, MOOD_GLOW_FRAG + '\n' + hook);
    }
  };
  mat.customProgramCacheKey = () =>
    'mood|' + (prevKey ? prevKey.call(mat) : (mat.type || ''));
  return mat;
}

/* ============================================================ cpu-side tint */

/* The same read as the shader, for the handful of things that are driven by an
   instanceColor multiplier instead of a fragment: the number tokens' halo, the
   badge accent, anything that has to agree with the ground it stands on. */
const OFF = [0.44, 0.47, 0.56];
const LIT = [1.10, 1.06, 0.96];
const ASH = [0.56, 0.56, 0.58];

export function moodTint(tileId, out = [1, 1, 1]) {
  const m = MOOD[tileId];
  out[0] = out[1] = out[2] = 1;
  if (!m) return out;
  const t = m.tone;
  if (t < 0) {
    const k = -t;
    for (let i = 0; i < 3; i++) out[i] = 1 + (OFF[i] - 1) * k;
  } else if (t > 0) {
    for (let i = 0; i < 3; i++) out[i] = 1 + (LIT[i] - 1) * t;
  }
  if (m.spent > 0) {
    for (let i = 0; i < 3; i++) out[i] *= 1 + (ASH[i] - 1) * m.spent;
  }
  return out;
}

/** How different two tints are — used to skip pointless attribute uploads. */
export function tintMoved(a, b, eps = 0.006) {
  return Math.abs(a[0] - b[0]) > eps
    || Math.abs(a[1] - b[1]) > eps
    || Math.abs(a[2] - b[2]) > eps;
}

export default MOOD;
