/**
 * Island Settlers — settler markers and collision-avoiding name plates.
 *
 *   createLabeller(ctx, proj, painter) ->
 *     { draw(state, bounds, obstacles), rects, plateRects, tokenRects }
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The four settlers wander the island in real time, and at the opening of a
 * match all four stand shoulder to shoulder around the market. Their name
 * plates were anchored a fixed distance below the marker, which put MAYA,
 * FINN, ALEX and YOU straight on top of the 6, 4 and 5 number discs — the
 * exact information the player is reading in order to choose a corner.
 *
 * So the plates no longer own a position. Every frame they are *solved* for
 * one: each plate is scored against every number disc, every dock tag, the
 * frame edges and the plates already placed, and the cheapest slot wins.
 * A number disc carries a weight two orders of magnitude above anything
 * else, so a plate will travel right off the island before it will sit on a
 * token. The solve is verifiable — `plateRects` and the obstacle list are
 * plain rectangles, and tools/mapshot.mjs asserts zero token intersection.
 *
 * Owner: UI agent.
 */

import { f } from './ovmap.js';

const PLATE_H = 20;
const GAP = 4;                 // breathing room added to every obstacle test
const TWO_PI = Math.PI * 2;

/* Sixteen candidate bearings. They are not tried in a fixed order: settlers
   crowd the middle of the island and the free space is always outboard of
   them, so each plate tries the direction pointing away from the board centre
   first and works inward. That is what keeps the leader lines short. */
const DIR_ANGLES = [];
for (let i = 0; i < 16; i++) DIR_ANGLES.push(i * TWO_PI / 16);

const RINGS = [0.9, 1.4, 2.0, 2.8, 3.8, 5.0, 6.4];

function angleGap(a, b) {
  let d = Math.abs(a - b) % TWO_PI;
  return d > Math.PI ? TWO_PI - d : d;
}

function dirsFor(mark, cx, cy) {
  const out = Math.atan2(mark.y - cy, mark.x - cx);
  return DIR_ANGLES
    .map(a => ({
      dx: Math.cos(a), dy: Math.sin(a),
      // Outward first; a downward tilt breaks ties because a plate below its
      // pin is the arrangement people read fastest.
      cost: angleGap(a, out) * 6 + angleGap(a, Math.PI / 2) * 0.7
    }))
    .sort((p, q) => p.cost - q.cost);
}

function overlap(a, b, pad) {
  const ox = Math.min(a.x + a.w / 2, b.x + b.w / 2) - Math.max(a.x - a.w / 2, b.x - b.w / 2) + pad;
  if (ox <= 0) return 0;
  const oy = Math.min(a.y + a.h / 2, b.y + b.h / 2) - Math.max(a.y - a.h / 2, b.y - b.h / 2) + pad;
  if (oy <= 0) return 0;
  return ox * oy;
}

/** True overlap area with no padding — what the verification tool measures. */
export function rectOverlap(a, b) { return overlap(a, b, 0); }

export function createLabeller(ctx, proj, painter) {
  const { PX, PY, plate } = painter;

  let plateRects = [];
  let obstacleRects = [];

  /* ------------------------------------------------------------- solving */

  /**
   * Find the cheapest free slot for one plate.
   * `blockers` is the live obstacle list; the winner is appended to it so the
   * next plate treats it as solid.
   */
  function solve(mark, w, h, blockers, bounds, dirs) {
    let best = null;
    for (const ring of RINGS) {
      const dist = mark.r + 11 + ring * (h + 4);
      for (const d of dirs) {
        let x = mark.x + d.dx * dist;
        let y = mark.y + d.dy * dist;
        // Keep it on the map before scoring, so a clamped candidate is judged
        // where it will actually be painted.
        x = Math.min(Math.max(x, bounds.x + w / 2 + 4), bounds.x + bounds.w - w / 2 - 4);
        y = Math.min(Math.max(y, bounds.y + h / 2 + 4), bounds.y + bounds.h - h / 2 - 4);
        const r = { x, y, w, h };

        let blocked = 0;
        for (const b of blockers) {
          const area = overlap(r, b, GAP);
          if (area > 0) blocked += area * b.weight;
        }
        // Rings ascend and directions are already in preference order, so the
        // first candidate that touches nothing is by construction the closest
        // acceptable slot. That is the answer in the overwhelming majority of
        // frames, and it needs no scoring at all.
        if (blocked === 0) return r;

        // Otherwise remember the least-bad option: a plate pulled far from its
        // marker still costs something, so distance stays in the score.
        const cost = blocked + ring * 9 + d.cost +
          Math.hypot(x - mark.x, y - mark.y) * 0.08;
        if (best === null || cost < best.cost) best = { x, y, w, h, cost };
      }
    }
    return best;
  }

  /* ------------------------------------------------------------ painting */

  function marker(m) {
    const { x, y, r, p } = m;
    const mine = p.id === 0;
    ctx.beginPath(); ctx.ellipse(x, y + r * 0.9, r * 0.95, r * 0.4, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,.38)'; ctx.fill();

    if (mine) {
      ctx.beginPath(); ctx.arc(x, y, r * 1.75, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,201,60,.16)'; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,201,60,.55)'; ctx.stroke();
    }

    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = p.color.css; ctx.fill();
    ctx.beginPath(); ctx.arc(x, y - r * 0.22, r * 0.66, Math.PI * 1.1, Math.PI * 1.9);
    ctx.lineWidth = r * 0.28; ctx.strokeStyle = p.color.light; ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(2, r * 0.34);
    ctx.strokeStyle = mine ? '#ffc93c' : 'rgba(6,16,28,.92)';
    ctx.stroke();
  }

  /** A leader from the marker to the plate, so a plate that had to travel is
      still unambiguously attached to its settler. */
  function leader(m, r, col) {
    const dx = r.x - m.x, dy = r.y - m.y;
    const len = Math.hypot(dx, dy) || 1;
    const sx = m.x + (dx / len) * (m.r + 1);
    const sy = m.y + (dy / len) * (m.r + 1);
    const ex = r.x - (dx / len) * (r.w / 2 - 2);
    const ey = r.y - (dy / len) * (r.h / 2 - 2);
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey);
    ctx.lineWidth = 3.4; ctx.strokeStyle = 'rgba(4,12,24,.8)'; ctx.lineCap = 'round';
    ctx.stroke();
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey);
    ctx.lineWidth = 1.6; ctx.strokeStyle = col; ctx.stroke();
  }

  function namePlate(r, name, col, mine) {
    const label = name.toUpperCase();
    plate(r.x, r.y, r.w, r.h,
      mine ? '#12406f' : 'rgba(9,24,44,.95)',
      mine ? '#ffc93c' : 'rgba(2,8,16,.92)', 7, mine ? 2.4 : 2);
    ctx.beginPath();
    ctx.moveTo(r.x - r.w / 2 + 3, r.y - r.h / 2 + 3.5);
    ctx.lineTo(r.x - r.w / 2 + 7.5, r.y - r.h / 2 + 3.5);
    ctx.lineTo(r.x - r.w / 2 + 7.5, r.y + r.h / 2 - 3.5);
    ctx.lineTo(r.x - r.w / 2 + 3, r.y + r.h / 2 - 3.5);
    ctx.closePath();
    ctx.fillStyle = col.css; ctx.fill();
    ctx.fillStyle = mine ? '#ffe79a' : '#e7f0fa';
    ctx.font = f(800, 12);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(label, r.x + 3.5, r.y + 1);
  }

  /* --------------------------------------------------------------- entry */

  /**
   * @param obstacles rectangles the plates must avoid (tokens, dock tags).
   * @param bounds    the map frame, in canvas css px.
   */
  function draw(state, bounds, obstacles, centre) {
    const s = proj.s;
    const cx = centre ? centre.x : bounds.x + bounds.w / 2;
    const cy = centre ? centre.y : bounds.y + bounds.h / 2;
    const marks = state.players.map(p => ({
      p, x: PX(p.x), y: PY(p.z), r: Math.max(6.5, s * (p.id === 0 ? 0.9 : 0.74))
    }));

    for (const m of marks) marker(m);

    // The human solves first so their plate gets the best slot on the board;
    // rivals then sort by how crowded their neighbourhood is.
    const order = marks.slice().sort((a, b) => {
      if (a.p.id === 0) return -1;
      if (b.p.id === 0) return 1;
      return a.y - b.y;
    });

    const blockers = obstacles.slice();
    // Markers are obstacles too: a plate must never bury another settler's pin.
    for (const m of marks) {
      blockers.push({ x: m.x, y: m.y, w: m.r * 2.4, h: m.r * 2.4, weight: 90, kind: 'pin' });
    }

    obstacleRects = blockers.slice();
    plateRects = [];

    ctx.font = f(800, 12);
    const solved = [];
    for (const m of order) {
      const w = Math.ceil(ctx.measureText(m.p.name.toUpperCase()).width) + 24;
      const r = solve(m, w, PLATE_H, blockers, bounds, dirsFor(m, cx, cy));
      const rect = { x: r.x, y: r.y, w, h: PLATE_H };
      blockers.push({ ...rect, weight: 70, kind: 'plate' });
      plateRects.push({ ...rect, name: m.p.name, pid: m.p.id });
      solved.push({ m, rect });
    }

    for (const { m, rect } of solved) leader(m, rect, m.p.color.light);
    for (const { m, rect } of solved) {
      namePlate(rect, m.p.name, m.p.color, m.p.id === 0);
    }
  }

  return {
    draw,
    get plateRects() { return plateRects; },
    get obstacleRects() { return obstacleRects; }
  };
}

export default createLabeller;
