/**
 * Island Settlers — the hex border grammar.
 *
 *   hexBorderGeometry() -> BufferGeometry  (position/normal/uv/color, indexed)
 *
 * Every hex boundary in the reference art is framed by a raised wooden beam
 * with a pale stone post at each vertex. That frame is what makes the board
 * readable: without it grass, sand and pasture simply bleed into one another.
 *
 * ---------------------------------------------------------------------------
 * WHERE IT SITS — shared with the structures agent
 *
 * The tan road strip is hexFrac 0.81 .. 1.00, i.e. a 2.96-wide band straddling
 * each hex boundary (1.481 either side of the boundary line). structures.js
 * lays its road decking down the middle of that band:
 *
 *     ROAD_W    = 2.30   -> deck occupies +/- 1.15 from the boundary
 *     stone kerbs are boxes 0.30 deep centred at +/- 1.06
 *
 * So the beam is the KERB/FRAME and lives strictly outboard of the decking:
 * centred at +/- 1.345, 0.29 wide, i.e. spanning 1.20 .. 1.49. It touches the
 * outer face of the road kerb and stops exactly at the edge of the painted
 * strip. Roads and beams can coexist on the same edge without intersecting.
 *
 * Interior edges get a beam on BOTH sides (each neighbouring hex owns one, and
 * together they read as a double rail bracketing the road). Coastal edges get
 * only the landward beam — the seaward side is already falling away down the
 * cliff, and the shoreline wobble in terrain.js would make a beam out there
 * lurch up and down by more than a unit.
 *
 * The whole thing merges into the island's ground mesh, so it costs ZERO extra
 * draw calls. UVs are the same planar x/z projection the ground uses, so the
 * painterly grain texture flows across the beams too.
 */

import * as THREE from 'three';
import { tiles, edges, intersections } from '../board/layout.js';
import { heightAt, vnoise2 } from './terrain.js';
import { merge, place, gradient } from './geo.js';

/* Geometry constants. See the header for why the offset is what it is. */
export const BEAM_OFFSET = 1.345;   // from the hex boundary line
export const BEAM_W = 0.33;         // across the strip
export const BEAM_PROUD = 0.36;     // how far the top stands above the ground
const BEAM_H = 1.05;                // total box height (mostly buried)
const SPANS = 4;                    // sub-boxes per beam, so it follows terrain
const END_TRIM = 0.62;              // shortened at each end to clear the posts

export const POST_W = 0.66;
const POST_PROUD = 0.56;
const POST_H = 1.30;

/* Oiled timber — a clear step darker and warmer than the tan strip it frames,
   otherwise the beam disappears into the sand it is supposed to separate. */
const BEAM_LOW = 0x6f4a20;
const BEAM_HI = 0xbb8c48;
const BEAM_LOW_ALT = 0x66492a;
const BEAM_HI_ALT = 0xae8450;

/* Pale limestone, matching the corner markers in the reference. */
const POST_LOW = 0x9d9683;
const POST_HI = 0xefe7d2;
const CAP_LOW = 0xb9b19c;
const CAP_HI = 0xfbf5e6;

const GRAIN_TILE = 13;   // must match island.js so the grain lines up

/** Planar x/z UVs, matching the ground mesh's own projection. */
function planarUV(g) {
  const pos = g.attributes.position;
  const uv = g.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    uv.setXY(i, pos.getX(i) / GRAIN_TILE, pos.getZ(i) / GRAIN_TILE);
  }
  uv.needsUpdate = true;
  return g;
}

/** Which side(s) of this edge carry a beam: +1 / -1 in perpendicular units. */
function sidesFor(e) {
  const px = -Math.sin(e.angle), pz = Math.cos(e.angle);
  if (e.tiles.length > 1) return [1, -1];
  // Coastal: keep only the side that points back at the tile that owns it.
  const t = tiles[e.tiles[0]];
  const inward = (t.x - e.x) * px + (t.z - e.z) * pz;
  return [inward >= 0 ? 1 : -1];
}

function beamParts(out) {
  const span = 9 /* HEX edge length */;
  for (const e of edges) {
    const dx = Math.cos(e.angle), dz = Math.sin(e.angle);
    const px = -Math.sin(e.angle), pz = Math.cos(e.angle);
    const len = (e.length || span) - END_TRIM * 2;
    const seg = len / SPANS;
    for (const side of sidesFor(e)) {
      const alt = ((e.id + (side > 0 ? 0 : 1)) & 1) === 1;
      for (let k = 0; k < SPANS; k++) {
        const t = -len / 2 + (k + 0.5) * seg;
        const x = e.x + dx * t + px * BEAM_OFFSET * side;
        const z = e.z + dz * t + pz * BEAM_OFFSET * side;
        const h = heightAt(x, z);
        // a touch of length overlap so neighbouring spans never show a seam
        const g = new THREE.BoxGeometry(seg * 1.10, BEAM_H, BEAM_W);
        gradient(g, alt ? BEAM_LOW_ALT : BEAM_LOW, alt ? BEAM_HI_ALT : BEAM_HI);
        out.push(place(g, x, h + BEAM_PROUD - BEAM_H / 2, z, 0, -e.angle, 0));
      }
    }
  }
}

function postParts(out) {
  for (const n of intersections) {
    const h = heightAt(n.x, n.z);
    const jitter = (vnoise2(n.x * 0.7, n.z * 0.7) - 0.5) * 0.34;
    const base = new THREE.BoxGeometry(POST_W, POST_H, POST_W);
    gradient(base, POST_LOW, POST_HI);
    out.push(place(base, n.x, h + POST_PROUD - POST_H / 2, n.z, 0, jitter, 0));
    // a slightly wider cap so the post reads as a carved marker, not a peg
    const cap = new THREE.BoxGeometry(POST_W * 1.28, 0.20, POST_W * 1.28);
    gradient(cap, CAP_LOW, CAP_HI);
    out.push(place(cap, n.x, h + POST_PROUD + 0.06, n.z, 0, jitter, 0));
  }
}

/**
 * One merged geometry holding every beam span and every corner post.
 * ~6.5k triangles, folded straight into the ground mesh by island.js.
 */
export function hexBorderGeometry() {
  const parts = [];
  beamParts(parts);
  postParts(parts);
  const g = merge(parts);
  return planarUV(g);
}

/** Top of the beam at a point — handy if anything wants to sit on the frame. */
export function beamTopAt(x, z) {
  return heightAt(x, z) + BEAM_PROUD;
}

export default hexBorderGeometry;
