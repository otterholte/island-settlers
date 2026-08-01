/**
 * Island Settlers — ownership ground rings.
 *
 *   createOwnerRings(opts) -> {
 *     mesh, set(id, spec), clear(id), clearAll(), update(dt), triangles, slots
 *   }
 *
 * One painted band of the owner's colour on the dirt under every village and
 * city. It is the cheapest possible answer to "whose is that?" — you read it
 * before you have looked at a single roof, and it survives being 30 pixels
 * across on the overview.
 *
 * WHY A POOL AND NOT AN InstancedMesh: the ground is not flat. A shared ring
 * geometry pushed around by an instance matrix would sink into the uphill side
 * of a hex corner and hang in the air on the downhill side, which is exactly
 * the failure the plinths already work around. So each slot owns a slice of one
 * shared buffer and writes its own vertices, every one of them sampled from
 * `heightAt`. The whole pool is still a single draw call.
 *
 * The colour attribute is vec4: three.js turns on USE_COLOR_ALPHA for an
 * itemSize-4 `color`, which gives a per-vertex fade at both edges of the band
 * without a texture, a shader patch or a second material.
 */

import * as THREE from 'three';
import { heightAt } from './terrain.js';

/* Segments around the ring. Twelve reads as a chunky low-poly disc, which is
   the house style, and keeps the whole pool under ~1.3k triangles. */
const SEG = 12;
/* inner edge (clear) -> body -> outer edge (clear) */
const BANDS = 3;
const VPR = SEG + 1;            // vertices per band (seam duplicated for UVs)
const VERTS = VPR * BANDS;
const TRIS = SEG * (BANDS - 1) * 2;

const _c = new THREE.Color();
const _w = new THREE.Color(0xffffff);

export function createOwnerRings(opts = {}) {
  const SLOTS = opts.slots || 26;
  const lift = opts.lift ?? 0.085;

  const pos = new Float32Array(SLOTS * VERTS * 3);
  const col = new Float32Array(SLOTS * VERTS * 4);
  const idx = new Uint16Array(SLOTS * TRIS * 3);

  for (let s = 0; s < SLOTS; s++) {
    const v0 = s * VERTS;
    let o = s * TRIS * 3;
    for (let b = 0; b < BANDS - 1; b++) {
      for (let i = 0; i < SEG; i++) {
        const a = v0 + b * VPR + i, d = a + 1;
        const e = a + VPR, f = e + 1;
        idx[o++] = a; idx[o++] = e; idx[o++] = f;
        idx[o++] = a; idx[o++] = f; idx[o++] = d;
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 4));
  const nrm = new Float32Array(SLOTS * VERTS * 3);
  for (let i = 0; i < SLOTS * VERTS; i++) nrm[i * 3 + 1] = 1;
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 2, 0), 200);

  const material = new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, depthWrite: false,
    side: THREE.DoubleSide
  });
  material.polygonOffset = true;
  material.polygonOffsetFactor = -2;
  material.polygonOffsetUnits = -2;

  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'ownerRings';
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  mesh.matrixAutoUpdate = false;

  /* Each live ring: where it is, how wide, whose, and how far it has grown in. */
  const recs = new Map();       // id -> rec
  const bySlot = new Array(SLOTS).fill(null);
  const dirty = { pos: false, col: false };

  /* Only the slots actually in use are ever submitted: an empty pool costs
     nothing, and eight starting villages cost 384 triangles, not 1248. */
  function syncRange() {
    let high = 0;
    for (let i = 0; i < SLOTS; i++) if (bySlot[i]) high = i + 1;
    geo.setDrawRange(0, high * TRIS * 3);
  }

  function freeSlot() {
    for (let i = 0; i < SLOTS; i++) if (!bySlot[i]) return i;
    return -1;
  }

  function blank(slot) {
    const base = slot * VERTS;
    for (let i = 0; i < VERTS; i++) {
      pos[(base + i) * 3] = 0;
      pos[(base + i) * 3 + 1] = -400;
      pos[(base + i) * 3 + 2] = 0;
      col[(base + i) * 4 + 3] = 0;
    }
    dirty.pos = dirty.col = true;
  }

  for (let i = 0; i < SLOTS; i++) blank(i);
  geo.setDrawRange(0, 0);

  /** Write one ring's 39 vertices, every height sampled off the real ground. */
  function write(rec) {
    const base = rec.slot * VERTS;
    const k = rec.grow;
    const rIn = rec.rIn * (0.35 + 0.65 * k);
    const rOut = rec.rOut * (0.35 + 0.65 * k);
    const rMid = rIn + (rOut - rIn) * 0.5;
    const radii = [rIn, rMid, rOut];
    // alpha profile: clear, solid, clear — a soft-edged painted band
    const alpha = [0, rec.alpha * k, 0];
    for (let b = 0; b < BANDS; b++) {
      const r = radii[b];
      const c = b === 1 ? rec.body : rec.edge;
      for (let i = 0; i <= SEG; i++) {
        const a = (Math.PI * 2 * (i % SEG)) / SEG;
        const x = rec.x + Math.cos(a) * r;
        const z = rec.z + Math.sin(a) * r;
        const v = base + b * VPR + i;
        pos[v * 3] = x;
        pos[v * 3 + 1] = heightAt(x, z) + lift + (b === 1 ? 0.012 : 0);
        pos[v * 3 + 2] = z;
        col[v * 4] = c.r; col[v * 4 + 1] = c.g; col[v * 4 + 2] = c.b;
        col[v * 4 + 3] = alpha[b];
      }
    }
    dirty.pos = dirty.col = true;
  }

  /**
   * set(id, { x, z, rIn, rOut, color, emphasis, instant })
   * `emphasis` is the human's own pieces: a brighter, whiter-cored band that no
   * rival piece gets, so "mine" reads even among four similar hues.
   */
  function set(id, spec) {
    let rec = recs.get(id);
    if (!rec) {
      const slot = freeSlot();
      if (slot < 0) return null;
      rec = { id, slot, grow: 0 };
      bySlot[slot] = rec;
      recs.set(id, rec);
      syncRange();
    }
    rec.x = spec.x; rec.z = spec.z;
    rec.rIn = spec.rIn; rec.rOut = spec.rOut;
    const em = !!spec.emphasis;
    rec.alpha = em ? 0.92 : 0.66;
    rec.body = _c.set(spec.color ?? 0xffffff).clone();
    if (em) rec.body.lerp(_w, 0.16);
    rec.edge = rec.body.clone();
    if (spec.instant) rec.grow = 1;
    else if (rec.grow >= 1) rec.grow = 1;
    else rec.grow = 0.001;
    write(rec);
    return rec;
  }

  function clear(id) {
    const rec = recs.get(id);
    if (!rec) return;
    bySlot[rec.slot] = null;
    recs.delete(id);
    blank(rec.slot);
    syncRange();
  }

  function clearAll() {
    for (const rec of recs.values()) { bySlot[rec.slot] = null; blank(rec.slot); }
    recs.clear();
    syncRange();
  }

  function update(dt) {
    if (!(dt > 0)) dt = 0;
    for (const rec of recs.values()) {
      if (rec.grow >= 1) continue;
      rec.grow = Math.min(1, rec.grow + dt * 2.6);
      write(rec);
    }
    if (dirty.pos) { geo.attributes.position.needsUpdate = true; dirty.pos = false; }
    if (dirty.col) { geo.attributes.color.needsUpdate = true; dirty.col = false; }
  }

  return {
    mesh, geometry: geo, material,
    set, clear, clearAll, update,
    slots: SLOTS,
    perRing: TRIS,
    get triangles() { return recs.size * TRIS; },
    dispose() { geo.dispose(); material.dispose(); }
  };
}

export default createOwnerRings;
