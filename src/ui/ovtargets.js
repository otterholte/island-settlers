/**
 * Island Settlers — the placement layer of the board map.
 *
 *   createTargets(ctx, proj, paint, state) -> {
 *     drawTargets(view), drawSpotlight(view),
 *     targetR(), roadBodyW(), hitRadius()
 *   }
 *
 * Everything the map paints that is not the BOARD lives here: the corners you
 * may claim, the edges you may build a road along, the region you may send the
 * Raider to, and the mark that says which corner a rival is about to take.
 * `overview.js` owns the interaction, `ovmap.js` owns the board underneath;
 * this file owns the invitation on top of them.
 *
 * `view` is a plain snapshot passed in every frame:
 *   { mode, targets[], sel, hover, pulse, spotlight }
 *
 * ---------------------------------------------------------------------------
 * THE THREE THINGS THE PLAYER ASKED FOR
 * ---------------------------------------------------------------------------
 *
 * 1. "Make the little gold circles a little smaller, but keep my circle of the
 *    settlement after I place it the same size."
 *
 *    Two different discs that used to move together. The CHOOSE-A-SPOT ring is
 *    `targetR()` below and is now about 9px across at 667x375, down from 13;
 *    the PLACED settlement is `pipRadius()` in ovmap.js and has not moved at
 *    all. The confirm preview still draws at `pipRadius()`, because a preview
 *    that is not the size of the thing you are previewing is a lie — only the
 *    gold ring hugging it came in, from 1.40x to 1.24x.
 *
 * 2. "Make the places where I can choose to place my road more clear — that's
 *    the map view where I currently see the blinking yellow road options."
 *
 *    They were a 7px line at a wandering alpha, on a board that already carries
 *    four colours of real road. They are now ROADS: a dark-cased gold slab with
 *    sleepers across it, laid along the edge and trimmed at both ends so two
 *    available edges meeting at a corner stay two separate slabs. Nothing
 *    blinks out any more — the dimmest an available edge ever gets is 82%, so
 *    the pulse is a shimmer rather than a disappearance. The chosen one is
 *    painted last, in the player's own colour, inside a cream outline, with a
 *    disc at each end and a chevron bobbing over the middle of it.
 *
 * 3. The Raider used to tint EIGHTEEN of the nineteen hexes gold — every legal
 *    one — so the board read as uniformly gold and the terrain washed out. It
 *    is the other way round now: the one hex you may NOT choose (the one the
 *    Raider is already on) is dimmed and struck through, the legal ones keep
 *    their own colour under a thin gold rim, and gold fill is spent only on the
 *    hex under the finger and the hex you have chosen.
 *
 * Owner: UI agent.
 */

import { HEX_SIZE } from '../core/constants.js';
import { tiles, intersections, edges } from '../board/layout.js';
import { pipRadius } from './ovmap.js';

export function createTargets(ctx, proj, paint, state) {
  const PX = x => x * proj.s + proj.ox;
  const PY = z => z * proj.s + proj.oy;

  /* ------------------------------------------------------------- the sizes */

  /**
   * The choose-a-spot ring.
   *
   * A corner target is a ring rather than a disc, and stays hollow, because
   * fifty-odd of them are legal at the opening of a draft and a field of solid
   * discs hides the terrain the player is trying to judge.
   *
   * It has been walked down twice. A pass before last roughly doubled it to
   * 0.38 of the corner spacing, which at 667x375 put a 22px ring on a 29px
   * spacing and the board vanished under them; 0.21 halved that. The player
   * still found them too prominent — "make the little gold circles a little
   * smaller" — so this is 0.15 with the floor dropped from 6.5 to 4.6, which
   * lands a 9.2px ring at 667x375 against the 13px it was, and 10.5px against
   * 14.7px at 960x444.
   *
   * What the finger gets is unchanged: `hitRadius()` owns the hit test and
   * still claims a 52px zone around every corner, nearest wins, so shrinking
   * the paint costs no tappability at all.
   */
  const targetR = () => Math.max(4.6, HEX_SIZE * proj.s * 0.15);

  /**
   * The coloured core of a road target, in css px.
   *
   * A built road is `max(8, s*1.3)` wide in ovmap.js. A target has to be at
   * least that — an invitation that is thinner than the thing it invites you to
   * build reads as a hairline, which is precisely what the player was looking
   * at. This is a shade wider again, and it carries a 4.5px dark casing on top
   * of that, so an available edge is a ~15px slab on a ~28px edge: unmistakably
   * road-shaped, and impossible to confuse with the map's own strokes.
   */
  const roadBodyW = () => Math.max(10, proj.s * 1.7);

  /** Radius of the tap zone around any target. >= 22 gives >= 44px across. */
  const hitRadius = () => Math.max(26, HEX_SIZE * proj.s * 0.5);

  /* ------------------------------------------------------------ road slabs */

  /** The two ends of an edge in canvas px, trimmed back off both corners. */
  function edgeRun(id, w) {
    const e = edges[id];
    if (!e) return null;
    const A = intersections[e.a], B = intersections[e.b];
    if (!A || !B) return null;
    const ax = PX(A.x), ay = PY(A.z), bx = PX(B.x), by = PY(B.z);
    const dx = bx - ax, dy = by - ay;
    const L = Math.hypot(dx, dy) || 1;
    const ux = dx / L, uy = dy / L;
    // Trimmed at both ends so two available edges sharing a corner read as two
    // slabs with a gap, not as one long snake through the junction.
    const trim = Math.min(L * 0.13, w * 0.7);
    return {
      ax, ay, bx, by, ux, uy, nx: -uy, ny: ux, len: L,
      x0: ax + ux * trim, y0: ay + uy * trim,
      x1: bx - ux * trim, y1: by - uy * trim,
      mx: (ax + bx) / 2, my: (ay + by) / 2
    };
  }

  function runStroke(r, lw, col, cap) {
    ctx.lineCap = cap || 'round';
    ctx.lineWidth = lw;
    ctx.strokeStyle = col;
    ctx.beginPath();
    ctx.moveTo(r.x0, r.y0);
    ctx.lineTo(r.x1, r.y1);
    ctx.stroke();
  }

  /** Three cross-boards, so the slab reads as planking rather than as paint. */
  function sleepers(r, w, col) {
    ctx.lineCap = 'butt';
    ctx.lineWidth = Math.max(1.5, w * 0.17);
    ctx.strokeStyle = col;
    const half = w * 0.42;
    for (const t of [0.26, 0.5, 0.74]) {
      const cx = r.x0 + (r.x1 - r.x0) * t;
      const cy = r.y0 + (r.y1 - r.y0) * t;
      ctx.beginPath();
      ctx.moveTo(cx - r.nx * half, cy - r.ny * half);
      ctx.lineTo(cx + r.nx * half, cy + r.ny * half);
      ctx.stroke();
    }
  }

  /** An AVAILABLE edge: gold slab, dark casing, planking. Never invisible. */
  function drawRoadTarget(id, warm, beat) {
    const w = roadBodyW();
    const r = edgeRun(id, w);
    if (!r) return;
    ctx.save();
    ctx.globalAlpha = warm ? 1 : 0.82 + 0.18 * beat;
    // A dark bed first: the map has gold wheat hexes and pale sand on it, and a
    // gold road on gold ground is no road at all.
    runStroke(r, w + 9, 'rgba(6,16,26,.40)');
    runStroke(r, w + 4.5, 'rgba(26,17,4,.92)');
    runStroke(r, w, warm ? '#ffe79a' : '#ffc93c');
    // Top bevel down the middle of the slab — the same light every chunky
    // button and plate in this interface wears.
    runStroke(r, Math.max(1.6, w * 0.28), 'rgba(255,248,214,.78)');
    sleepers(r, w, 'rgba(126,76,10,.52)');
    ctx.restore();
  }

  /**
   * The CHOSEN edge, painted after every other target so nothing crosses it.
   *
   * The unmistakable state: the player's own colour rather than gold, a cream
   * outline around the whole slab, a disc at each corner it will connect, and a
   * chevron bobbing over the middle. Nothing else on the board looks like this.
   */
  function drawRoadChosen(id, beat) {
    const w = roadBodyW() * 1.16;
    const r = edgeRun(id, w);
    if (!r) return;
    const col = state.players[0].color;
    ctx.save();
    ctx.globalAlpha = 1;
    runStroke(r, w + 16, `rgba(255,201,60,${0.20 + 0.10 * beat})`);
    runStroke(r, w + 9, '#fff4cf');
    runStroke(r, w + 4.5, 'rgba(16,10,2,.95)');
    runStroke(r, w, col.css);
    runStroke(r, Math.max(1.8, w * 0.30), col.light);
    sleepers(r, w, 'rgba(10,18,30,.45)');

    // A stud on each corner the road will join: "this end and that end".
    const knob = Math.max(3.4, w * 0.44);
    for (const [kx, ky] of [[r.ax, r.ay], [r.bx, r.by]]) {
      ctx.beginPath(); ctx.arc(kx, ky, knob, 0, Math.PI * 2);
      ctx.fillStyle = '#fff4cf'; ctx.fill();
      ctx.lineWidth = Math.max(1.4, knob * 0.34);
      ctx.strokeStyle = 'rgba(16,10,2,.9)'; ctx.stroke();
    }

    // The same bobbing chevron the chosen corner wears, so "this is the one I
    // have picked" is one shape across every placement mode.
    const lift = w * (1.5 + 0.22 * beat) + 4;
    const k = Math.max(6, w * 0.62);
    ctx.beginPath();
    ctx.moveTo(r.mx, r.my - lift);
    ctx.lineTo(r.mx - k, r.my - lift - k * 1.25);
    ctx.lineTo(r.mx + k, r.my - lift - k * 1.25);
    ctx.closePath();
    ctx.fillStyle = '#ffd24a'; ctx.fill();
    ctx.lineWidth = Math.max(1.4, k * 0.26);
    ctx.strokeStyle = 'rgba(24,14,4,.78)'; ctx.stroke();
    ctx.restore();
  }

  /* ----------------------------------------------------------- the Raider */

  /**
   * Mark the ONE hex that is not a choice, and leave the other eighteen alone.
   *
   * Tinting every legal region gold painted 18 of 19 hexes the same colour and
   * the board stopped being a board — you cannot pick the best region to block
   * if you cannot read which region is which. The hex the Raider already
   * occupies gets a dark scrim and a red strike instead; everything else keeps
   * its terrain and takes a thin gold rim.
   */
  function drawRobberBlocked() {
    const t = tiles[state.robberTile];
    if (!t) return;
    ctx.save();
    paint.hexPath(t, 0);
    // Light-handed: ovmap.js's own `drawRobber` has already laid a scrim on
    // this hex in the baked board underneath, and two full-strength washes turn
    // the region black.
    ctx.fillStyle = 'rgba(6,12,22,.30)';
    ctx.fill();
    ctx.save();
    paint.hexPath(t, 0);
    ctx.clip();
    // Diagonal hatch: the universal "not this one", and it survives being
    // painted over a dark grey mountain or a bright wheat field alike.
    const R = HEX_SIZE * proj.s;
    const cx = PX(t.x), cy = PY(t.z);
    ctx.lineWidth = Math.max(1.6, proj.s * 0.24);
    ctx.strokeStyle = 'rgba(255,120,86,.30)';
    for (let i = -6; i <= 6; i++) {
      const o = i * R * 0.3;
      ctx.beginPath();
      ctx.moveTo(cx - R + o, cy - R);
      ctx.lineTo(cx + R + o, cy + R);
      ctx.stroke();
    }
    ctx.restore();
    paint.hexPath(t, 0);
    ctx.lineWidth = Math.max(2, proj.s * 0.2);
    ctx.strokeStyle = 'rgba(255,120,86,.7)';
    ctx.stroke();
    ctx.restore();
  }

  function drawRobberTarget(id, chosen, warm, beat) {
    const t = tiles[id];
    if (!t) return;
    ctx.save();
    if (chosen) {
      paint.hexPath(t, 0.02);
      ctx.fillStyle = 'rgba(255,201,60,.44)';
      ctx.fill();
    } else if (warm) {
      paint.hexPath(t, 0);
      ctx.fillStyle = 'rgba(255,201,60,.20)';
      ctx.fill();
    }
    // The rim is all an untouched legal region ever gets: it says "choosable"
    // without laying a colour over the terrain the choice is about.
    if (chosen) {
      // Dark first, cream second. A gold-on-gold chosen state is invisible on a
      // wheat hex, and the wheat hexes are exactly the ones worth blocking.
      paint.hexPath(t, 0.02);
      ctx.lineWidth = Math.max(3, proj.s * 0.38);
      ctx.strokeStyle = 'rgba(18,10,2,.85)';
      ctx.stroke();
      paint.hexPath(t, 0.02);
      ctx.lineWidth = Math.max(1.8, proj.s * 0.22);
      ctx.strokeStyle = '#fff4cf';
      ctx.shadowColor = '#ffc93c'; ctx.shadowBlur = proj.s * 2.2;
      ctx.stroke();
      ctx.shadowBlur = 0;
      // The same bobbing chevron every other placement mode uses.
      const cx = PX(t.x), cy = PY(t.z);
      const R = HEX_SIZE * proj.s;
      const k = Math.max(6, R * 0.2);
      const top = cy - R * (0.98 + 0.05 * beat);
      ctx.beginPath();
      ctx.moveTo(cx, top);
      ctx.lineTo(cx - k, top - k * 1.25);
      ctx.lineTo(cx + k, top - k * 1.25);
      ctx.closePath();
      ctx.fillStyle = '#ffd24a'; ctx.fill();
      ctx.lineWidth = Math.max(1.4, k * 0.26);
      ctx.strokeStyle = 'rgba(24,14,4,.78)'; ctx.stroke();
    } else {
      paint.hexPath(t, 0);
      ctx.lineWidth = Math.max(1.8, proj.s * (warm ? 0.2 : 0.14));
      ctx.strokeStyle = `rgba(255,201,60,${warm ? 0.9 : 0.34 + 0.16 * beat})`;
      if (warm) { ctx.shadowColor = '#ffc93c'; ctx.shadowBlur = proj.s * 1.2; }
      ctx.stroke();
    }
    ctx.restore();
  }

  /* ---------------------------------------------------------- corner rings */

  function drawCornerTarget(id, chosen, warm, beat, glow, halo) {
    const n = intersections[id];
    if (!n) return;
    const x = PX(n.x), y = PY(n.z);
    const r = targetR();
    ctx.save();

    if (warm) {
      // One expanding sonar ripple, on the one under the finger only, and kept
      // close to the ring it comes off: a wide ripple on a small target is all
      // ripple and no target.
      ctx.globalAlpha = (1 - halo) * 0.8;
      ctx.beginPath(); ctx.arc(x, y, r * (1.0 + halo * 0.5), 0, Math.PI * 2);
      ctx.lineWidth = Math.max(1.3, r * 0.2);
      ctx.strokeStyle = '#ffe79a';
      ctx.stroke();
    }

    const rr = r * (chosen ? 1.22 : (warm ? 1.12 : 1));
    ctx.globalAlpha = chosen || warm ? 1 : 0.82;
    if (chosen) {
      ctx.beginPath(); ctx.arc(x, y, rr, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,238,190,.94)'; ctx.fill();
    }
    // Hollow: the hex under the ring stays legible, which is the whole reason a
    // corner is worth choosing.
    ctx.beginPath(); ctx.arc(x, y, rr, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(1.4, r * 0.28);
    ctx.strokeStyle = 'rgba(20,12,4,.55)'; ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y, rr, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(1.3, r * 0.19) * (chosen ? 1.8 : 0.9 + 0.2 * beat);
    ctx.strokeStyle = chosen ? '#fff4cf' : (warm ? '#ffe79a' : '#ffc93c');
    if (chosen || warm) {
      ctx.shadowColor = 'rgba(255,201,60,.85)';
      ctx.shadowBlur = proj.s * (chosen ? 2.4 : 1.2);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
    if (!chosen) {
      ctx.beginPath();
      ctx.arc(x, y, Math.max(1.2, r * 0.19) * (0.75 + 0.4 * glow), 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,250,225,.9)'; ctx.fill();
    }
    ctx.restore();
  }

  /**
   * The confirm preview: the piece itself, dropped on the spot.
   *
   * The pip is drawn at `pipRadius()` — exactly the size the settlement will be
   * once it is built, which is the size the player asked to keep. Only the gold
   * ring around it came in, 1.40x -> 1.24x, so the preview no longer reads as
   * several concentric gold circles with a house somewhere inside them.
   */
  function drawChosenPiece(id, city, beat) {
    const n = intersections[id];
    if (!n) return;
    const x = PX(n.x), y = PY(n.z);
    const r = pipRadius(proj) * (city ? 1.22 : 1);
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r * (1.24 + 0.07 * beat), 0, Math.PI * 2);
    ctx.lineWidth = Math.max(1.8, r * 0.15);
    ctx.strokeStyle = `rgba(255,201,60,${0.5 + 0.28 * beat})`;
    ctx.stroke();
    ctx.globalAlpha = 0.98;
    paint.ownerPip(x, y, r, state.players[0].color, city, true);
    const lift = r * (1.55 + 0.2 * beat);
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.moveTo(x, y - lift);
    ctx.lineTo(x - r * 0.62, y - lift - r * 0.8);
    ctx.lineTo(x + r * 0.62, y - lift - r * 0.8);
    ctx.closePath();
    ctx.fillStyle = '#ffd24a';
    ctx.fill();
    ctx.lineWidth = Math.max(1.4, r * 0.16);
    ctx.strokeStyle = 'rgba(24,14,4,.75)';
    ctx.stroke();
    ctx.restore();
  }

  /* ------------------------------------------------------------------ draw */

  function drawTargets(view) {
    const { mode, targets, sel, hover } = view;
    if (!targets || !targets.length) return;
    const pulse = view.pulse || 0;
    const beat = 0.5 + 0.5 * Math.sin(pulse * 4.2);
    const glow = 0.5 + 0.5 * beat;
    const halo = (pulse * 0.9) % 1;

    if (mode === 'place-robber') drawRobberBlocked();

    for (const id of targets) {
      if (id === sel) continue;                 // the choice is painted last
      const warm = id === hover;
      if (mode === 'place-road') drawRoadTarget(id, warm, beat);
      else if (mode === 'place-robber') drawRobberTarget(id, false, warm, beat);
      else drawCornerTarget(id, false, warm, beat, glow, halo);
    }

    if (sel === null || sel === undefined) return;
    if (mode === 'place-road') drawRoadChosen(sel, beat);
    else if (mode === 'place-robber') drawRobberTarget(sel, true, false, beat);
    else {
      drawCornerTarget(sel, true, false, beat, glow, halo);
      drawChosenPiece(sel, mode === 'place-city', beat);
    }
  }

  /**
   * The bot telegraph. While a rival is "thinking", matchflow.js hands us the
   * corner or edge it has already decided on and we point at it for a beat
   * before the piece appears. That beat is the whole reason a spectated draft
   * reads as a draft rather than as pieces popping into existence.
   */
  function drawSpotlight(view) {
    const sp = view.spotlight;
    if (!sp || sp.id === undefined || sp.id === null || sp.id < 0) return;
    const pulse = view.pulse || 0;
    const s = proj.s;
    const col = sp.color || '#ffc93c';
    const beat = 0.5 + 0.5 * Math.sin(pulse * 3.4);
    const ring = (pulse * 0.85) % 1;
    let x, y;
    if (sp.kind === 'edge') {
      const e = edges[sp.id];
      if (!e) return;
      const A = intersections[e.a], B = intersections[e.b];
      x = (PX(A.x) + PX(B.x)) / 2; y = (PY(A.z) + PY(B.z)) / 2;
      ctx.save();
      ctx.lineCap = 'round';
      ctx.globalAlpha = sp.hot ? 0.95 : 0.55;
      ctx.beginPath(); ctx.moveTo(PX(A.x), PY(A.z)); ctx.lineTo(PX(B.x), PY(B.z));
      ctx.lineWidth = Math.max(8, s * 1.25);
      ctx.strokeStyle = col;
      ctx.setLineDash([Math.max(4, s * 0.7), Math.max(4, s * 0.7)]);
      ctx.lineDashOffset = -pulse * 26;
      ctx.stroke();
      ctx.restore();
    } else {
      const n = intersections[sp.id];
      if (!n) return;
      x = PX(n.x); y = PY(n.z);
    }

    const r = Math.max(12, HEX_SIZE * s * 0.5);
    ctx.save();
    // A dark backing disc, so the mark survives a bright wheat or sand hex.
    ctx.beginPath(); ctx.arc(x, y, r * 0.94, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(10,26,44,.5)'; ctx.fill();

    ctx.globalAlpha = (1 - ring) * (sp.hot ? 0.9 : 0.5);
    ctx.beginPath(); ctx.arc(x, y, r * (0.9 + ring * 1.7), 0, Math.PI * 2);
    ctx.lineWidth = Math.max(2, r * 0.22);
    ctx.strokeStyle = col;
    ctx.stroke();

    ctx.globalAlpha = 1;
    ctx.beginPath(); ctx.arc(x, y, r * (sp.hot ? 1.0 : 0.82), 0, Math.PI * 2);
    ctx.lineWidth = Math.max(2.8, r * 0.3) * (0.85 + 0.3 * beat);
    ctx.strokeStyle = col;
    ctx.setLineDash([Math.max(3, r * 0.45), Math.max(3, r * 0.42)]);
    ctx.lineDashOffset = -pulse * 22;
    ctx.shadowColor = col; ctx.shadowBlur = r * 1.1;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.shadowBlur = 0;

    // Crosshair ticks — a surveyor's mark, not a target reticle.
    ctx.lineWidth = Math.max(1.6, r * 0.18);
    ctx.strokeStyle = 'rgba(255,255,255,.9)';
    for (let i = 0; i < 4; i++) {
      const a = (Math.PI / 2) * i + Math.PI / 4;
      const c = Math.cos(a), sn = Math.sin(a);
      ctx.beginPath();
      ctx.moveTo(x + c * r * 1.18, y + sn * r * 1.18);
      ctx.lineTo(x + c * r * 1.62, y + sn * r * 1.62);
      ctx.stroke();
    }

    // A pennant in the rival's colour, bobbing above the mark. This is what
    // makes "Maya is about to build there" legible across the whole board.
    const lift = r * (1.9 + 0.16 * beat);
    const fh = r * 1.15;
    ctx.beginPath();
    ctx.moveTo(x, y - lift);
    ctx.lineTo(x, y - lift - fh);
    ctx.lineWidth = Math.max(1.6, r * 0.16);
    ctx.strokeStyle = 'rgba(16,26,40,.85)';
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x, y - lift - fh);
    ctx.lineTo(x + r * 1.1, y - lift - fh * 0.72);
    ctx.lineTo(x, y - lift - fh * 0.44);
    ctx.closePath();
    ctx.fillStyle = col;
    ctx.fill();
    ctx.lineWidth = Math.max(1.2, r * 0.13);
    ctx.strokeStyle = 'rgba(16,26,40,.85)';
    ctx.stroke();
    ctx.restore();
  }

  return { drawTargets, drawSpotlight, targetR, roadBodyW, hitRadius };
}

export default createTargets;
