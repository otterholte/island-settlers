/**
 * Island Settlers — the Great Market and the nine ports.
 *
 *   buildMarket(scene) -> { group, update(dt) }
 *   buildPorts(scene, state) -> { group, update(dt), setUnlocked(portId, pid) }
 *
 * The market is the island's landmark, and it earns that by being the one
 * clean silhouette on the board rather than the busiest square metre on it.
 * One trading pavilion under a single tiled hip roof, an empty paved plaza,
 * four plain stalls, a painted "TRADE 4:1" board over the door and the same
 * legend flying from the mast where it can be read from the far shore. Six
 * merchants work the floor. Three objects: solid, sign, crowd.
 *
 * What used to be here and is not any more: the second storey and its balcony,
 * the bell cupola, the dormer, the gate arch, two of the six stalls, the well
 * and its benches, four palms, four banner poles with pennants, twenty bunting
 * flags, two hung carpets, three rolled carpets, two braziers, two pack camels
 * and a hitching rail, a laden hand cart, two goods heaps and four loose
 * crates. The plaza is the point; the clutter was hiding it.
 *
 * Each port is one instanced kit (see buildport.js) placed at the wet-sand
 * anchor found by walking outward along `port.bearing` until the ground drops
 * to the shoreline. Six draw calls cover all nine: base, ship, flag, sign,
 * crew, gulls.
 */

import * as THREE from 'three';
import { MARKET, ports, edges } from '../board/layout.js';
import { PLAYER_COLORS } from '../core/constants.js';
import { heightAt } from './terrain.js';
import { merge, place, instanced, setInstance, hideInstance, triCount } from './geo.js';
import { villagerGeo, glowSolidMaterial, clothMaterial, rng } from './buildkit.js';
import * as MKT from './mktkit.js';
import * as P from './buildport.js';

const _c = new THREE.Color();

/* ======================================================== market geometry */

const PLAZA_R = 6.60;
/** How high the paved apron stands proud of the flattened desert. */
const PLAZA_LIFT = 0.12;
/** The trading house sits back on -X and faces the +X approach. */
const HOUSE_X = -2.40;

/**
 * Four stalls, not a ring of six: a wide pair flanking the approach and a
 * narrow pair tucked either side of the pavilion. Angle, trade good, and the
 * two colours of its awning — cream with one muted band, nothing shouting.
 */
const CREAM = 0xf4ead2;
const STALLS = [
  { a: 0.95, kind: 0, c: 0x3f7fa8 },   // timber
  { a: -0.95, kind: 3, c: 0x3f7fa8 },  // grain
  { a: 2.05, kind: 2, c: 0xc0562f },   // wool
  { a: -2.05, kind: 4, c: 0xc0562f }   // ore
];
const STALL_R = 4.85;
/** Middle of the open half of the plaza — where the roundel and the milling go. */
const HUB_X = 3.10;

function marketSolidGeo() {
  const parts = [MKT.plazaGeo(PLAZA_R, HUB_X)];

  parts.push(place(MKT.tradingHouse(), HOUSE_X, 0, 0));

  // Stall local +Z is the counter front, so -a - PI/2 turns it to face the
  // middle of the plaza from anywhere on the ring.
  for (const s of STALLS) {
    parts.push(place(MKT.stall(s.kind, CREAM, s.c),
      Math.cos(s.a) * STALL_R, 0, Math.sin(s.a) * STALL_R, 0, -s.a - Math.PI / 2, 0));
  }

  return merge(parts);
}

/* ================================================================= market */

/**
 * Where the crowd wants to be: one shopper at each counter and two by the
 * pavilion door. `face = -a` turns a villager's local +X out along the radius,
 * i.e. toward the stall they have stopped in front of.
 */
function crowdSpots() {
  const spots = STALLS.map(s =>
    [Math.cos(s.a) * (STALL_R - 1.55), Math.sin(s.a) * (STALL_R - 1.55), -s.a]);
  spots.push([HOUSE_X + 4.6, 1.05, Math.PI], [HOUSE_X + 5.1, -1.20, Math.PI]);
  return spots;
}

export function buildMarket(scene) {
  const group = new THREE.Group();
  group.name = 'market';
  if (scene) scene.add(group);

  // The plaza is deliberately flattened by terrain.js; sit on its high point,
  // then stand the paving a hand's width proud so the apron has a clean edge.
  let baseY = heightAt(MARKET.x, MARKET.z);
  for (let i = 0; i < 24; i++) {
    const a = (Math.PI * 2 * i) / 24;
    for (const rr of [2.6, 4.6, 6.6]) {
      const h = heightAt(MARKET.x + Math.cos(a) * rr, MARKET.z + Math.sin(a) * rr);
      if (h > baseY) baseY = h;
    }
  }
  group.position.set(MARKET.x, baseY + PLAZA_LIFT, MARKET.z);
  /*
   * Turn the whole plaza so the pavilion frontage, the porch, the lit doorway
   * and the painted board all face into the key light. Built facing +X, the
   * landmark's best side sat in permanent shadow — the sun runs from
   * (-0.82, +0.58) in the XZ plane, so -atan2(0.58, -0.82) points the front
   * straight at it.
   */
  group.rotation.y = -Math.atan2(0.58, -0.82);

  /*
   * The awnings used to be a second, two-sided, wind-animated mesh. With the
   * bunting, the pennants and the hung carpets gone there were four small
   * panels left in it, so the whole cloth pass folded back into the solid
   * geometry and the solid material simply went two-sided. One less mesh, one
   * less shadow-caster, one less shader.
   */
  const solid = glowSolidMaterial({ side: THREE.DoubleSide });

  const gSolid = marketSolidGeo();
  const gFolk = villagerGeo(true);
  const signTex = MKT.signTexture();

  const solidMesh = new THREE.Mesh(gSolid, solid);
  solidMesh.castShadow = true;
  solidMesh.receiveShadow = true;
  group.add(solidMesh);

  /*
   * Both painted boards are one two-triangle-per-board mesh sharing one atlas.
   *
   * The mast banner is a camera-facing billboard so it reads from any approach;
   * the shop board is a fixed plane hung under the porch beam. Neither is
   * additive and nothing on the canvas is authored above #fff2d2, so they roll
   * off through ACES like the rest of the frame instead of clipping the way the
   * old light-shaft beacon did.
   */
  const signMat = MKT.signMaterial(signTex);
  const gSign = MKT.signGeo(
    { x: HOUSE_X + 0.45, y: 9.75, z: 0, w: 3.00, h: 3.00 },
    { x: HOUSE_X + 3.22, y: 3.20, z: 0, w: 2.70, h: 1.32 }
  );
  const sign = new THREE.Mesh(gSign, signMat);
  sign.renderOrder = 5;
  sign.frustumCulled = false;
  group.add(sign);

  const CROWD = 6;
  const crowd = instanced(gFolk, solid, CROWD, true, false);
  crowd.instanceColor =
    new THREE.InstancedBufferAttribute(new Float32Array(CROWD * 3).fill(1), 3);
  group.add(crowd);

  const TONES = [0xd0472f, 0x3b7fd4, 0x3f9a52, 0xe0c27a, 0xdfe4ea, 0x8552c4];
  const SPOTS = crowdSpots();
  const folk = [];
  const r = rng(90210);
  for (let i = 0; i < CROWD; i++) {
    const s = SPOTS[i % SPOTS.length];
    const a = (Math.PI * 2 * i) / CROWD + 0.3;
    const rr = 1.1 + r() * 1.5;
    folk.push({
      x: s[0] + (r() - 0.5) * 0.6, z: s[1] + (r() - 0.5) * 0.6,
      tx: HUB_X + Math.cos(a) * rr, tz: Math.sin(a) * rr,
      ry: s[2], face: s[2], wait: r() * 3.0, phase: r() * 6.28,
      speed: 0.62 + r() * 0.45, scale: 0.94 + r() * 0.20
    });
    _c.set(TONES[i % TONES.length]).lerp(new THREE.Color(0xffffff), 0.28);
    crowd.instanceColor.setXYZ(i, _c.r, _c.g, _c.b);
  }
  crowd.instanceColor.needsUpdate = true;

  let t = 0;

  function update(dt) {
    if (!(dt > 0)) dt = 0;
    t += dt;
    signMat.userData.time.value = t;

    for (let i = 0; i < folk.length; i++) {
      const f = folk[i];
      f.phase += dt * 3.2;
      let moving = false;
      if (f.wait > 0) {
        f.wait -= dt;
        // turn to face whatever they stopped at
        let diff = f.face - f.ry;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        f.ry += diff * Math.min(1, dt * 4);
      } else {
        const dx = f.tx - f.x, dz = f.tz - f.z;
        const d = Math.hypot(dx, dz);
        if (d < 0.16) {
          const s = SPOTS[(Math.random() * SPOTS.length) | 0];
          f.tx = s[0] + (Math.random() - 0.5) * 0.9;
          f.tz = s[1] + (Math.random() - 0.5) * 0.9;
          f.face = s[2] + (Math.random() - 0.5) * 0.4;
          f.wait = 1.6 + Math.random() * 4.2;
        } else {
          moving = true;
          const k = Math.min(1, (dt * f.speed) / d);
          f.x += dx * k; f.z += dz * k;
          const want = Math.atan2(-dz, dx);
          let diff = want - f.ry;
          while (diff > Math.PI) diff -= Math.PI * 2;
          while (diff < -Math.PI) diff += Math.PI * 2;
          f.ry += diff * Math.min(1, dt * 6);
        }
      }
      // walking bob, or a slow gesture while haggling at a stall
      const bob = moving ? Math.abs(Math.sin(f.phase)) * 0.08 : Math.sin(f.phase * 0.5) * 0.025;
      const lean = moving ? Math.sin(f.phase) * 0.11 : Math.sin(f.phase * 0.9) * 0.07;
      setInstance(crowd, i, f.x, 0.03 + bob, f.z, f.ry, f.scale, f.scale, 0, lean);
    }
    crowd.instanceMatrix.needsUpdate = true;
  }

  update(0);

  const triangles = triCount(gSolid) + 4 + CROWD * triCount(gFolk);

  return {
    group, solidMesh, sign, beacon: sign, crowd,
    baseY, triangles, drawCalls: 3,
    update,
    dispose() {
      gSolid.dispose(); gSign.dispose(); gFolk.dispose();
      solid.dispose(); signMat.dispose(); signTex.dispose();
    }
  };
}

/* ================================================================== ports */

/** Where the ship sits along the dock, in port-local X. */
const DOCK_MID = P.DOCK_TO - 2.4;

/**
 * Walk seaward from the coastal edge midpoint until the ground drops to the
 * waterline, then stand the shore station just past it so the platform is
 * partly over the shallows — exactly where a working harbour sits. The deck
 * height is then derived from the highest ground under the station, so no port
 * ever buries itself in the cliff or hangs over the sand.
 */
export function shoreAnchor(port) {
  const e = edges[port.edge];
  const dx = Math.cos(port.bearing), dz = Math.sin(port.bearing);
  let water = null;
  for (let d = 1.0; d <= 18; d += 0.2) {
    if (heightAt(e.x + dx * d, e.z + dz * d) <= 0.06) { water = d; break; }
  }
  if (water === null) water = 8.0;
  const d = water + 0.9;
  const x = e.x + dx * d, z = e.z + dz * d;
  let hi = -Infinity, lo = Infinity;
  for (let lx = -3.5; lx <= 0.4; lx += 0.35) {
    for (let lz = -1.9; lz <= 1.9; lz += 0.95) {
      const h = heightAt(x + lx * dx - lz * dz, z + lx * dz + lz * dx);
      if (h > hi) hi = h;
      if (h < lo) lo = h;
    }
  }
  const y = Math.min(Math.max(hi - 0.08, 0.26), 1.30);
  return { x, z, y, d, ground: heightAt(x, z), hi, lo };
}

export function buildPorts(scene, state) {
  const group = new THREE.Group();
  group.name = 'ports';
  if (scene) scene.add(group);

  const solid = glowSolidMaterial();
  // Sails, banners and gulls all share one two-sided material. The ship no
  // longer runs the wind vertex shader: it made the hull ripple like a rag.
  const clothMat = clothMaterial();

  const gBase = P.portBaseGeo();
  const gShip = P.portShipGeo();
  const gFlag = P.portFlagGeo();
  const gGull = P.seagullGeo();
  const gFolk = villagerGeo(false);

  const N = ports.length;
  const CREW = 3, GULLS = 2;

  const base = instanced(gBase, solid, N, true, true);
  const ship = instanced(gShip, clothMat, N, true, false);
  const flag = instanced(gFlag, clothMat, N, false, false);
  const crew = instanced(gFolk, solid, N * CREW, true, false);
  const gulls = instanced(gGull, clothMat, N * GULLS, false, false);
  for (const m of [base, ship, flag, crew, gulls]) group.add(m);

  const white = n => new THREE.InstancedBufferAttribute(new Float32Array(n * 3).fill(1), 3);
  base.instanceColor = white(N);
  ship.instanceColor = white(N);
  flag.instanceColor = white(N);
  crew.instanceColor = white(N * CREW);

  const anchors = ports.map(shoreAnchor);
  const sign = P.buildSignMesh(ports, anchors);
  group.add(sign.mesh);

  // Instance colour multiplies the baked vertex colour, so it can only ever
  // darken. A hard grey turned every shaded coastline into a black smear —
  // these are pale enough to read as weathered timber, not as a silhouette.
  const LOCKED = new THREE.Color(0x8d98a6);
  const WEATHERED = new THREE.Color(0x8d98a6);
  const LIT = new THREE.Color(0xffffff);

  const recs = ports.map((p, i) => {
    const a = anchors[i];
    const cb = Math.cos(p.bearing), sb = Math.sin(p.bearing);
    const toWorld = (lx, lz) => ({ x: a.x + lx * cb - lz * sb, z: a.z + lx * sb + lz * cb });
    const r = rng(1000 + i * 77);
    const crewList = [];
    for (let k = 0; k < CREW; k++) {
      const lx = -2.4 + k * 2.4, lz = (k % 2 ? 0.85 : -0.80);
      const w = toWorld(lx, lz);
      crewList.push({
        slot: i * CREW + k, lx, lz, tlx: lx, tlz: lz,
        x: w.x, z: w.z, ry: -p.bearing, wait: r() * 2, phase: r() * 6.28,
        speed: 0.6 + r() * 0.4
      });
      _c.set([0xe0d3b8, 0xcf9b62, 0xa8bcd0][k % 3]);
      crew.instanceColor.setXYZ(i * CREW + k, _c.r, _c.g, _c.b);
    }
    return {
      port: p, i, x: a.x, z: a.z, y: a.y, ry: -p.bearing, cb, sb, toWorld,
      lit: 0, want: 0, owner: -1, crew: crewList,
      bob: r() * 6.28, gull: r() * 6.28
    };
  });
  crew.instanceColor.needsUpdate = true;

  function writeStatic(rec) {
    setInstance(base, rec.i, rec.x, rec.y, rec.z, rec.ry, 1, 1);
    // owner banner off the warehouse gable — grows in as the port lights up
    const f = rec.toWorld(-2.60, 0);
    setInstance(flag, rec.i, f.x, rec.y + P.DECK_Y + 2.52, f.z, rec.ry, 1, Math.max(0.02, rec.lit));
    _c.copy(LOCKED).lerp(LIT, rec.lit);
    base.instanceColor.setXYZ(rec.i, _c.r, _c.g, _c.b);
    _c.copy(WEATHERED).lerp(LIT, rec.lit);
    ship.instanceColor.setXYZ(rec.i, _c.r, _c.g, _c.b);
    for (let v = 0; v < 4; v++) {
      sign.colors.setXYZ(rec.i * 4 + v,
        0.46 + 0.54 * rec.lit, 0.49 + 0.51 * rec.lit, 0.54 + 0.46 * rec.lit);
    }
    if (rec.owner >= 0) {
      const pc = PLAYER_COLORS[((rec.owner | 0) % PLAYER_COLORS.length + PLAYER_COLORS.length) % PLAYER_COLORS.length];
      _c.set(pc ? pc.hex : 0xffffff);
      flag.instanceColor.setXYZ(rec.i, _c.r, _c.g, _c.b);
    }
  }

  function markDirty() {
    base.instanceColor.needsUpdate = true;
    ship.instanceColor.needsUpdate = true;
    flag.instanceColor.needsUpdate = true;
    sign.colors.needsUpdate = true;
  }

  for (const rec of recs) writeStatic(rec);
  markDirty();

  function setUnlocked(portId, pid) {
    const rec = recs[portId];
    if (!rec) return;
    rec.want = 1;
    rec.owner = pid ?? 0;
    writeStatic(rec);
    markDirty();
  }

  // Pick up any ports the match already considers unlocked.
  if (state && state.players) {
    for (const p of state.players) {
      if (p.ports) {
        for (const id of p.ports) {
          const rr = recs[id];
          if (rr) { rr.want = 1; rr.lit = 1; rr.owner = p.id; writeStatic(rr); }
        }
      }
    }
    markDirty();
  }

  let t = 0;

  function update(dt) {
    if (!(dt > 0)) dt = 0;
    t += dt;

    let dirty = false;
    for (const rec of recs) {
      if (Math.abs(rec.lit - rec.want) > 0.001) {
        rec.lit += (rec.want - rec.lit) * Math.min(1, dt * 3.2);
        writeStatic(rec);
        dirty = true;
      }
      const active = rec.lit > 0.55;

      /*
       * A derelict berth has no ship in it.
       *
       * Greying the hull was not enough: multiplying warm timber by a cool
       * grey only ever nudges the colour, so a locked port and a working one
       * looked near identical in a screenshot. Removing the ship changes the
       * silhouette, which is what actually reads at a glance — and sailing one
       * in is a decent reward for claiming the dock.
       */
      const b = t * 1.15 + rec.bob;
      const sw = active ? 1 : 0;
      const sc = rec.lit < 0.10 ? 0 : 0.82 + 0.18 * rec.lit;
      const s = rec.toWorld(DOCK_MID, P.DOCK_W / 2 + 2.05);
      setInstance(ship, rec.i, s.x, 0.68 + Math.sin(b) * 0.14 * sw, s.z, rec.ry, sc, sc,
        Math.sin(b * 0.8) * 0.05 * sw, Math.cos(b * 1.1) * 0.07 * sw);

      // dock workers — off shift entirely while the port is derelict
      for (const c of rec.crew) {
        if (!active) { hideInstance(crew, c.slot); continue; }
        c.phase += dt * 3.4;
        if (c.wait > 0) c.wait -= dt;
        else {
          const dx = c.tlx - c.lx, dz = c.tlz - c.lz;
          const d = Math.hypot(dx, dz);
          if (d < 0.12) {
            c.tlx = -3.0 + Math.random() * 9.2;
            c.tlz = (Math.random() - 0.5) * 1.7;
            c.wait = 0.4 + Math.random() * 1.8;
          } else {
            const k = Math.min(1, (dt * c.speed) / d);
            c.lx += dx * k; c.lz += dz * k;
          }
        }
        const w = rec.toWorld(c.lx, c.lz);
        const moving = c.wait <= 0;
        const bob = moving ? Math.abs(Math.sin(c.phase)) * 0.07 : 0;
        setInstance(crew, c.slot, w.x, rec.y + P.DECK_Y + bob, w.z,
          rec.ry + (moving ? 0 : 0.5), 1, 1, 0, moving ? Math.sin(c.phase) * 0.12 : 0);
      }

      // gulls only wheel over a working harbour
      for (let k = 0; k < GULLS; k++) {
        if (!active) { hideInstance(gulls, rec.i * GULLS + k); continue; }
        const a = t * (0.66 + k * 0.2) + rec.gull + k * 2.6;
        const rr = 3.4 + k * 1.4;
        const w = rec.toWorld(DOCK_MID + Math.cos(a) * rr, Math.sin(a) * rr * 0.7);
        setInstance(gulls, rec.i * GULLS + k, w.x,
          rec.y + 4.1 + k * 0.8 + Math.sin(a * 1.7) * 0.32, w.z,
          rec.ry - a - Math.PI / 2, 0.82, 0.82, 0, Math.sin(a * 3.1) * 0.45);
      }
    }
    if (dirty) {
      markDirty();
      flag.instanceMatrix.needsUpdate = true;
      base.instanceMatrix.needsUpdate = true;
    }
    ship.instanceMatrix.needsUpdate = true;
    crew.instanceMatrix.needsUpdate = true;
    gulls.instanceMatrix.needsUpdate = true;
  }

  update(0);

  const triangles = N * (triCount(gBase) + triCount(gShip) + triCount(gFlag))
    + N * CREW * triCount(gFolk) + N * GULLS * triCount(gGull) + N * 2;

  return {
    group, anchors, meshes: { base, ship, flag, crew, gulls, sign: sign.mesh },
    triangles, drawCalls: 6,
    update, setUnlocked,
    dispose() {
      for (const g of [gBase, gShip, gFlag, gGull, gFolk, sign.geometry]) g.dispose();
      solid.dispose(); clothMat.dispose();
      sign.material.dispose(); sign.atlas.texture.dispose();
    }
  };
}

export default { buildMarket, buildPorts };
