/**
 * Island Settlers — board map painting.
 *
 *   createPainter(ctx, proj) -> { ...draw fns, tokenRects(), portRects() }
 *
 * Everything that puts pixels on the overview canvas lives here so
 * `overview.js` can stay about interaction. The painter reads `proj`
 * live — overview.js mutates that object on resize — so no state is
 * cached across frames.
 *
 * The map is meant to read as a *board*: a painted sea with depth bands,
 * a carved outer frame, an island that sits on the water with a beach and
 * a shelf, hex plates with real thickness, and wooden number discs that
 * match the ones standing in the 3D world.
 *
 * Owner: UI agent.
 */

import { HEX_SIZE, isHotNumber, TRADE_BASE } from '../core/constants.js';
import { tiles, intersections, edges, ports, BOUNDS, cornerOffset } from '../board/layout.js';
import { knightsOn } from '../core/options.js';
import { hash01 } from './dom.js';

/** Five terrains plus desert, tuned for tonal separation at thumbnail size:
    dark green / light green / orange / gold / cool grey / pale sand. */
export const TERRAIN = {
  forest:    { a: '#57a63e', b: '#256b22', rim: '#123f16', motif: 'tree' },
  hills:     { a: '#e28a48', b: '#a4501f', rim: '#632d10', motif: 'bump' },
  pasture:   { a: '#aede63', b: '#65ab39', rim: '#3a6a20', motif: 'dot' },
  fields:    { a: '#f8d75e', b: '#cd9a20', rim: '#7f5b0d', motif: 'stripe' },
  mountains: { a: '#bcc6d3', b: '#6b7684', rim: '#3c4552', motif: 'peak' },
  desert:    { a: '#f2dfb2', b: '#d2b077', rim: '#8b7343', motif: 'speck' }
};

const FONT = `'Trebuchet MS','Avenir Next Condensed','Segoe UI',system-ui,sans-serif`;
export const f = (w, s) => `${w} ${s}px ${FONT}`;

/**
 * Radius of a PLACED settlement's owner pip, in canvas css px.
 *
 * Exported because `overview.js` draws the same disc for the confirm preview,
 * and because the player drew a hard line between the two things that used to
 * scale together: "make the little gold circles a little smaller, but keep my
 * circle of the settlement after I place it the same size." This is the one
 * that does not move. A city is 1.22x it.
 */
export const pipRadius = proj => Math.max(11, proj.s * 1.05);

/**
 * How far past the coastline a harbour sign reaches, in CSS pixels.
 *
 * `BOUNDS` is the box around the fifty-four intersections, which is the ISLAND
 * and not the BOARD: the nine docks are built outward from the mid-point of a
 * coastal edge, and their ratio boards stand at `len + signH * 0.62` with
 * another `signH / 2` of their own height beyond that. Whoever is fitting the
 * board into a frame has to add this on all four sides or the outermost signs
 * are drawn under whatever furniture is standing at the edge — which is
 * precisely what was happening, sliced off flat by the top of the chip bar at
 * 640x320 and by the panel's own gold rail with no bar up at all.
 *
 * Exported rather than duplicated because every term is lifted from `dockGeom`
 * below, and a second copy of `Math.max(15, ...)` is a second copy that gets
 * to be wrong on its own. The `+2` is the drop shadow under the plate.
 *
 * PIXELS, NOT WORLD UNITS. Both terms have a pixel floor, so on a small screen
 * the signs stop shrinking with the island and the margin they need grows as a
 * fraction of the board — which is why the constant slack this replaced could
 * not be right at 640x320 and 960x444 at the same time.
 */
export const dockOverhang = s =>
  Math.max(15, HEX_SIZE * s * 0.74) + Math.max(15, s * 4.4) * 1.12 + 2;

export function createPainter(ctx, proj) {
  const PX = x => x * proj.s + proj.ox;
  const PY = z => z * proj.s + proj.oy;

  /* ------------------------------------------------------------ billboards
   *
   *   "When I change the angle, please have the number tiles move to still be
   *    facing me whatever viewpoint I'm at, instead of just always facing
   *    straight up, making it harder to read in 3D."
   *
   * The tilt is a vertical squash applied to the whole canvas by overview.js,
   * so everything painted through it is flattened — including the number
   * discs, which become ellipses with squashed digits inside them. On a board
   * tilted to 55% a 12 is half as tall as it should be, which is exactly the
   * complaint.
   *
   * A billboard in a 3D scene is a flat thing turned to face the camera. Here
   * that is the same operation and one line of maths: undo the squash about
   * the label's OWN centre. The disc stays where the tilt put it — anchored to
   * its hex, moving with the board — and stands up out of it, round and full
   * height, which is what a token propped up on a tilted table looks like.
   *
   * Applied to the number discs and the dock ratio boards. Not to the hexes,
   * the roads, the buildings or the coast: those are the board, and the board
   * is what is being tilted. */
  const billboard = (cx, cy) => {
    const ky = proj.ky || 1;
    if (ky >= 0.999) { note('board'); return false; }
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(1, 1 / ky);
    ctx.translate(-cx, -cy);
    note('label');
    return true;
  };

  /* What the canvas is ACTUALLY scaled by, sampled from the live context at
     the two moments that matter: while the board is being drawn, and while a
     billboarded label is. Nothing in the game reads these — they exist so the
     capture rig can assert "the tokens are upright" against the transform the
     painter really used, rather than against a screenshot of a number. */
  const seen = { board: 1, label: 1 };
  function note(which) {
    if (typeof ctx.getTransform !== 'function') return;
    const t = ctx.getTransform();
    // `d` is the vertical scale, device pixels included; normalise by `a` so
    // the number is the squash on its own whatever the display's DPR.
    seen[which] = t.a ? t.d / t.a : t.d;
  }

  /* ------------------------------------------------------------- geometry */

  function hexPath(t, inflate = 0, dy = 0, begin = true) {
    if (begin) ctx.beginPath();
    const k = 1 + inflate;
    for (let i = 0; i < 6; i++) {
      const o = cornerOffset(i);
      const x = PX(t.x) + o.x * proj.s * k;
      const y = PY(t.z) + o.z * proj.s * k + dy;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  /** One path holding all 19 hexes. Wound identically, so a nonzero fill
      renders their union — that is what gives the island one silhouette
      instead of nineteen overlapping stamps. */
  function islandPath(inflate, dy) {
    ctx.beginPath();
    for (const t of tiles) hexPath(t, inflate, dy, false);
  }

  function rounded(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /** A rounded plate — the one shape every label on this map sits on. */
  function plate(x, y, w, h, fill, stroke, rad, lw) {
    rounded(x - w / 2, y - h / 2, w, h, rad === undefined ? Math.min(h / 2, 7) : rad);
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.55)'; ctx.shadowBlur = 8; ctx.shadowOffsetY = 3;
    ctx.fillStyle = fill; ctx.fill();
    ctx.restore();
    ctx.lineWidth = lw || 2; ctx.strokeStyle = stroke; ctx.stroke();
  }

  /* ------------------------------------------------------------------ sea */

  /**
   * Just the water, edge to edge, with no island on it.
   *
   * `overview.js` bakes the whole board into an offscreen canvas and blits it.
   * Once the player can DRAG that board around (ovpan.js) the blit no longer
   * covers the frame, and what it leaves behind is open ocean — so this paints
   * open ocean under it rather than leaving bare canvas. Runs every frame the
   * map is up, so the gradient is cached on the canvas height.
   */
  let seaGrad = null, seaH = -1;
  function fillSea() {
    if (!seaGrad || seaH !== proj.h) {
      seaH = proj.h;
      seaGrad = ctx.createLinearGradient(0, 0, 0, proj.h);
      seaGrad.addColorStop(0, '#062a52');
      seaGrad.addColorStop(0.5, '#0b4b86');
      seaGrad.addColorStop(1, '#0a3a68');
    }
    ctx.fillStyle = seaGrad;
    ctx.fillRect(0, 0, proj.w, proj.h);
  }

  function drawSea() {
    const { w, h } = proj;
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#062a52');
    g.addColorStop(0.5, '#0b4b86');
    g.addColorStop(1, '#0a3a68');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    const cx = PX(BOUNDS.cx), cy = PY(BOUNDS.cz);
    const rr = (BOUNDS.radius + HEX_SIZE) * proj.s;

    // Depth bands: the water gets warmer and shallower toward the island.
    const bands = [
      [1.34, 'rgba(20,124,178,.42)'],
      [1.16, 'rgba(38,162,196,.44)'],
      [1.03, 'rgba(78,206,214,.40)']
    ];
    for (const [k, col] of bands) {
      ctx.beginPath(); ctx.arc(cx, cy, rr * k, 0, Math.PI * 2);
      ctx.fillStyle = col; ctx.fill();
    }

    // Swell lines — hand-drawn chart feel, never a mechanical ring.
    ctx.strokeStyle = 'rgba(226,248,255,.20)';
    ctx.lineCap = 'round';
    for (let i = 0; i < 5; i++) {
      const rad = rr * (1.10 + i * 0.085);
      const a0 = 0.35 + i * 1.24, a1 = a0 + 0.85 + hash01(i * 3.3) * 0.7;
      ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.arc(cx, cy, rad, a0, a1); ctx.stroke();
      ctx.lineWidth = 1.1;
      ctx.beginPath(); ctx.arc(cx, cy, rad + 5, a0 + 0.16, a1 - 0.2); ctx.stroke();
    }

    // Vignette — the map is lit at the middle and falls away at the frame.
    const vg = ctx.createRadialGradient(cx, cy, rr * 0.7, cx, cy, Math.max(w, h) * 0.82);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(2,10,22,.72)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, w, h);
  }

  /** The carved outer frame: a brass bead, a dark reveal and corner studs. */
  /**
   * Clip everything that follows to the inside of the board's own frame.
   *
   *   "Right now the map items when I zoom in are not staying within the
   *    confines of their border box for the draft/map."
   *
   * The frame has always been drawn LAST, over the top of the board, so at rest
   * it looked like a window when it was really a picture frame painted onto the
   * glass. Zooming in is what gives that away: the board grows past the
   * rectangle and hexes, docks and settlers carry on across the label strip and
   * the resource chips, because nothing was ever stopping them.
   *
   * The radius and the inset match the frame's innermost keyline
   * (`fr.x + 7`, `r - 5`) so the board is cut off exactly where the moulding
   * begins, with no gap and no overlap. Returns whether a clip was actually
   * pushed, so a caller that gets a frameless projection — the very first draw,
   * before `measure()` has run — does not restore a state it never saved.
   */
  function clipToFrame(fr) {
    if (!fr || !(fr.w > 0) || !(fr.h > 0)) return false;
    ctx.save();
    rounded(fr.x + 7, fr.y + 7, fr.w - 14, fr.h - 14, 11);
    ctx.clip();
    return true;
  }

  function drawFrame(fr) {
    const r = 16;
    ctx.save();
    rounded(fr.x + 1, fr.y + 1, fr.w - 2, fr.h - 2, r);
    ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(3,12,24,.85)'; ctx.stroke();

    rounded(fr.x + 3.5, fr.y + 3.5, fr.w - 7, fr.h - 7, r - 2);
    const bg = ctx.createLinearGradient(0, fr.y, 0, fr.y + fr.h);
    bg.addColorStop(0, '#ffe1a0');
    bg.addColorStop(0.45, '#c08a2c');
    bg.addColorStop(1, '#8a5c15');
    ctx.lineWidth = 3; ctx.strokeStyle = bg; ctx.stroke();

    rounded(fr.x + 7, fr.y + 7, fr.w - 14, fr.h - 14, r - 5);
    ctx.lineWidth = 1.4; ctx.strokeStyle = 'rgba(6,18,34,.6)'; ctx.stroke();

    const studs = [
      [fr.x + 13, fr.y + 13], [fr.x + fr.w - 13, fr.y + 13],
      [fr.x + 13, fr.y + fr.h - 13], [fr.x + fr.w - 13, fr.y + fr.h - 13]
    ];
    for (const [sx, sy] of studs) {
      ctx.beginPath(); ctx.arc(sx, sy, 3.6, 0, Math.PI * 2);
      const sg = ctx.createLinearGradient(sx, sy - 4, sx, sy + 4);
      sg.addColorStop(0, '#ffeec0'); sg.addColorStop(1, '#96661a');
      ctx.fillStyle = sg; ctx.fill();
      ctx.lineWidth = 1.2; ctx.strokeStyle = 'rgba(6,18,34,.8)'; ctx.stroke();
    }
    ctx.restore();
  }

  /* --------------------------------------------------------------- island */

  /** Scatter dressing. Each element gets its own light and shade so a tile
      reads as painted terrain rather than a flat swatch. */
  function motif(t, kind, s) {
    const cx = PX(t.x), cy = PY(t.z);
    const n = kind === 'dot' || kind === 'speck' ? 12 : 9;
    for (let i = 0; i < n; i++) {
      const a = hash01(t.id * 31.7 + i * 5.3) * Math.PI * 2;
      const rr = (0.16 + hash01(t.id * 7.1 + i * 2.9) * 0.66) * HEX_SIZE * s;
      const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr * 0.9;
      const k = HEX_SIZE * s * (0.10 + hash01(i * 3.3 + t.id) * 0.06);
      if (kind === 'tree') {
        ctx.beginPath();
        ctx.ellipse(x, y + k * 0.95, k * 0.9, k * 0.32, 0, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(8,32,10,.38)'; ctx.fill();
        ctx.beginPath();
        ctx.moveTo(x, y - k * 1.9); ctx.lineTo(x + k * 0.98, y + k * 0.85);
        ctx.lineTo(x - k * 0.98, y + k * 0.85); ctx.closePath();
        ctx.fillStyle = '#17470f'; ctx.fill();
        ctx.beginPath();
        ctx.moveTo(x, y - k * 1.9); ctx.lineTo(x - k * 0.98, y + k * 0.85);
        ctx.lineTo(x - k * 0.08, y + k * 0.85); ctx.closePath();
        ctx.fillStyle = '#49a233'; ctx.fill();
      } else if (kind === 'peak') {
        ctx.beginPath();
        ctx.moveTo(x, y - k * 1.95); ctx.lineTo(x + k * 1.2, y + k * 0.85);
        ctx.lineTo(x - k * 1.2, y + k * 0.85); ctx.closePath();
        ctx.fillStyle = '#5d6875'; ctx.fill();
        ctx.beginPath();
        ctx.moveTo(x, y - k * 1.95); ctx.lineTo(x - k * 1.2, y + k * 0.85);
        ctx.lineTo(x - k * 0.12, y + k * 0.85); ctx.closePath();
        ctx.fillStyle = '#eef4fb'; ctx.fill();
      } else if (kind === 'bump') {
        ctx.beginPath(); ctx.arc(x, y, k, Math.PI, 0); ctx.closePath();
        ctx.fillStyle = '#7d3a15'; ctx.fill();
        ctx.beginPath(); ctx.arc(x - k * 0.28, y - k * 0.1, k * 0.52, Math.PI, 0);
        ctx.closePath(); ctx.fillStyle = '#d87d3d'; ctx.fill();
      } else if (kind === 'stripe') {
        ctx.beginPath(); ctx.rect(x - k * 0.32, y - k * 1.5, k * 0.64, k * 3);
        ctx.fillStyle = '#a4770f'; ctx.fill();
        ctx.beginPath(); ctx.ellipse(x, y - k * 1.5, k * 0.5, k, 0, 0, Math.PI * 2);
        ctx.fillStyle = '#ffe89a'; ctx.fill();
      } else if (kind === 'dot') {
        ctx.beginPath(); ctx.arc(x, y + k * 0.34, k * 0.86, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(28,66,18,.32)'; ctx.fill();
        ctx.beginPath(); ctx.arc(x, y, k * 0.86, 0, Math.PI * 2);
        ctx.fillStyle = '#fdfaf3'; ctx.fill();
      } else {
        ctx.beginPath(); ctx.arc(x, y, k * 0.42, 0, Math.PI * 2);
        ctx.fillStyle = '#c3a778'; ctx.fill();
      }
    }
  }

  /** Sea shelf, beach and the drop shadow the island casts on the water. */
  function drawShelf() {
    const s = proj.s;
    const lift = HEX_SIZE * s * 0.24;

    islandPath(0.30, lift * 0.5);
    ctx.fillStyle = 'rgba(120,232,232,.34)'; ctx.fill();

    ctx.save();
    ctx.shadowColor = 'rgba(2,14,30,.62)'; ctx.shadowBlur = 18; ctx.shadowOffsetY = 9;
    islandPath(0.155, lift * 0.35);
    ctx.fillStyle = '#e9d3a1'; ctx.fill();
    ctx.restore();

    islandPath(0.155, lift * 0.35);
    ctx.lineWidth = Math.max(1.5, s * 0.1);
    ctx.strokeStyle = 'rgba(120,86,36,.5)'; ctx.stroke();

    // The rock the island stands on, pushed down so the plates have thickness.
    islandPath(0.045, lift * 2.35);
    ctx.fillStyle = '#3a2a18'; ctx.fill();
  }

  function drawTiles() {
    const s = proj.s;
    const lift = HEX_SIZE * s * 0.24;
    const R = HEX_SIZE * s;

    for (const t of tiles) {
      const pal = TERRAIN[t.terrain] || TERRAIN.desert;
      hexPath(t, 0.012, lift);
      ctx.fillStyle = pal.rim;
      ctx.fill();
    }

    for (const t of tiles) {
      const pal = TERRAIN[t.terrain] || TERRAIN.desert;
      const cx = PX(t.x), cy = PY(t.z);
      hexPath(t, 0);
      ctx.save(); ctx.clip();

      const g = ctx.createLinearGradient(0, cy - R, 0, cy + R);
      g.addColorStop(0, pal.a);
      g.addColorStop(0.6, pal.b);
      g.addColorStop(1, pal.rim);
      ctx.fillStyle = g;
      ctx.fillRect(cx - R * 1.2, cy - R * 1.2, R * 2.4, R * 2.4);

      // Sun off the upper-left, the way the 3D scene is lit.
      const sun = ctx.createRadialGradient(
        cx - R * 0.34, cy - R * 0.44, R * 0.08, cx - R * 0.2, cy - R * 0.3, R * 1.25);
      sun.addColorStop(0, 'rgba(255,250,220,.38)');
      sun.addColorStop(1, 'rgba(255,250,220,0)');
      ctx.fillStyle = sun;
      ctx.fillRect(cx - R * 1.2, cy - R * 1.2, R * 2.4, R * 2.4);

      for (let i = 0; i < 2; i++) {
        const a = hash01(t.id * 12.3 + i * 4.1) * Math.PI * 2;
        const d = hash01(t.id * 5.9 + i) * R * 0.6;
        ctx.globalAlpha = 0.22;
        ctx.beginPath();
        ctx.ellipse(cx + Math.cos(a) * d, cy + Math.sin(a) * d,
          R * 0.5, R * 0.36, a, 0, Math.PI * 2);
        ctx.fillStyle = i ? pal.a : pal.rim;
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      motif(t, pal.motif, s);

      const vig = ctx.createRadialGradient(cx, cy, R * 0.52, cx, cy, R * 1.06);
      vig.addColorStop(0, 'rgba(0,0,0,0)');
      vig.addColorStop(1, 'rgba(10,22,12,.34)');
      ctx.fillStyle = vig;
      ctx.fillRect(cx - R * 1.2, cy - R * 1.2, R * 2.4, R * 2.4);

      ctx.save();
      ctx.translate(0, R * 0.11);
      hexPath(t, 0);
      ctx.lineWidth = Math.max(2, s * 0.24);
      ctx.strokeStyle = 'rgba(255,252,228,.36)';
      ctx.stroke();
      ctx.restore();
      ctx.restore();

      hexPath(t, 0);
      ctx.lineWidth = Math.max(1.7, s * 0.14);
      ctx.strokeStyle = 'rgba(8,22,12,.66)';
      ctx.stroke();
    }
  }

  /* --------------------------------------------------------------- tokens */

  /* A third of the hex radius. The old floor of 13px was absolute, so on a
     667x375 phone the discs grew to the full radius of the hex they sat on and
     buried the terrain under them. */
  /* A billboarded disc keeps its full height while the board around it loses a
     third of theirs, so at full tilt two tokens on hexes above one another can
     touch. Giving back a little of the radius as the tilt grows keeps them
     apart and still leaves them taller than they would be squashed: at ky 0.67
     a disc is 0.91 of its flat size and 1.36x the height it would have had. */
  const tokenR = () => {
    const ky = proj.ky || 1;
    return Math.max(10.5, HEX_SIZE * proj.s * 0.33 * (0.73 + 0.27 * ky));
  };

  /** Where every number disc sits, in canvas css px. Label placement treats
      these as no-go zones — the numbers are what the player is reading. */
  function tokenRects() {
    const r = tokenR();
    const out = [];
    for (const t of tiles) {
      if (!t.number) continue;
      out.push({
        x: PX(t.x), y: PY(t.z),
        w: r * 2.16, h: r * 2.3, weight: 260, kind: 'token'
      });
    }
    return out;
  }

  function drawToken(t) {
    if (!t.number) return;
    const r = tokenR();
    const cx = PX(t.x), cy = PY(t.z);
    const hot = isHotNumber(t.number);
    const up = billboard(cx, cy);

    ctx.beginPath(); ctx.arc(cx, cy + r * 0.2, r * 1.06, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,.42)'; ctx.fill();

    // Dark wooden rim, then the cream face inset into it.
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
    const rim = ctx.createLinearGradient(0, cy - r, 0, cy + r);
    rim.addColorStop(0, '#7a4f24'); rim.addColorStop(1, '#3a2210');
    ctx.fillStyle = rim; ctx.fill();

    ctx.beginPath(); ctx.arc(cx, cy, r * 0.86, 0, Math.PI * 2);
    const g = ctx.createLinearGradient(0, cy - r, 0, cy + r);
    g.addColorStop(0, '#fffaea'); g.addColorStop(0.52, '#f4e5c1'); g.addColorStop(1, '#d8c091');
    ctx.fillStyle = g; ctx.fill();

    ctx.beginPath(); ctx.arc(cx, cy - r * 0.16, r * 0.68, Math.PI * 1.14, Math.PI * 1.86);
    ctx.lineWidth = Math.max(1.3, r * 0.10);
    ctx.strokeStyle = 'rgba(255,255,255,.8)'; ctx.stroke();

    if (hot) {
      ctx.beginPath(); ctx.arc(cx, cy, r * 0.93, 0, Math.PI * 2);
      ctx.lineWidth = Math.max(1.4, r * 0.11);
      ctx.strokeStyle = 'rgba(192,39,27,.85)'; ctx.stroke();
    }

    /* No dot row under the numeral any more — see world/paint.js. The glyph
       takes the whole face and is centred in it. */
    ctx.fillStyle = hot ? '#bd2114' : '#33200a';
    ctx.font = f(800, Math.round(r * 1.36));
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(t.number), cx, cy + r * 0.02);

    if (up) ctx.restore();
  }

  /**
   * The Great Market's own rate board, on the hex in the middle.
   *
   *   "On the map show the 4:1 on the middle hex, so that the ports make more
   *    sense."
   *
   * Nine harbours around the coast wear a ratio and the tenth trading post does
   * not, which makes the 3:1s and 2:1s look like the whole system rather than
   * the discounts they are. The centre hex is the baseline every one of those
   * signs is a discount ON, and saying so is one plate: the same shape, the
   * same ink and the same billboard trick as a number disc, so it reads as part
   * of the board rather than as a caption laid over it.
   *
   * It is drawn with the tokens rather than with the ports because it belongs
   * to a HEX, not to an edge, and because that is the pass the number discs are
   * painted in — the market's plate has to sit at the same height in the stack
   * as the discs it is standing among.
   */
  function drawMarketRate() {
    const t = tiles.find(x => !x.resource);
    if (!t) return;
    const s = proj.s;
    const cx = PX(t.x), cy = PY(t.z);
    const w = Math.max(30, s * 8.6), h = Math.max(15, s * 4.2);
    const up = billboard(cx, cy);
    plate(cx, cy, w, h, '#f4e5c1', '#5d3a10', Math.min(h / 2, 7), 2);
    ctx.fillStyle = '#33200a';
    ctx.font = f(800, Math.round(h * 0.62));
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(`${TRADE_BASE}:1`, cx, cy + h * 0.02);
    if (up) ctx.restore();
  }

  function drawTokens() {
    note('board');
    for (const t of tiles) drawToken(t);
    drawMarketRate();
  }

  /* ---------------------------------------------------------------- ports */

  /**
   * The nine harbours, drawn as harbours.
   *
   * A port used to be a stick and a floating label. It is now a real jetty:
   * two gangways running down off the coastal corners that own it, a planked
   * deck reaching out over the water, mooring posts along both sides, and the
   * ratio board bolted to the seaward end of the deck rather than hovering
   * next to it. Unlocked docks are gold-planked, lantern-lit and shadowed
   * warm; locked ones are weathered grey driftwood.
   *
   * Everything is measured off `proj.s` so the whole harbour shrinks with the
   * board instead of overhanging the coast at 375px tall.
   */

  const WOOD = {
    open: { deck: '#e3ae4d', plank: '#96601b', rim: '#5d3a10', post: '#8a5418',
            sign: '#ffd764', ink: '#3a2208', edge: '#6f4505' },
    shut: { deck: '#b08d61', plank: '#7a5b33', rim: '#4b3719', post: '#6d5228',
            sign: '#f2e6c8', ink: '#3a2208', edge: '#5a3a1e' }
  };

  /** Resource swatches for the 2:1 boards. */
  const RES_DOT = {
    wood: '#2f7d32', brick: '#c05a24', wheat: '#e8b62c',
    wool: '#8fc95a', ore: '#8593a3'
  };

  const dockGeom = p => {
    const s = proj.s;
    const e = edges[p.edge];
    const bx = PX(e.x), by = PY(e.z);          // the coastline, mid-edge
    let ox = Math.cos(p.bearing), oy = Math.sin(p.bearing);
    const m = Math.hypot(ox, oy) || 1;
    ox /= m; oy /= m;
    const len = Math.max(15, HEX_SIZE * s * 0.74);
    return {
      e, bx, by, ox, oy,
      nx: -oy, ny: ox,                          // across the pier
      len,
      foot: len * 0.24,                         // where the deck leaves the sand
      half: Math.max(4.4, HEX_SIZE * s * 0.235),
      signW: Math.max(31, s * 9.2) * (p.resource ? 1.2 : 1),
      signH: Math.max(15, s * 4.4)
    };
  };

  /** Where the market's own rate board is, so a tap can find it. */
  function marketRect() {
    const t = tiles.find(x => !x.resource);
    if (!t) return null;
    const s = proj.s;
    return {
      x: PX(t.x), y: PY(t.z),
      w: Math.max(30, s * 8.6) + 6, h: Math.max(15, s * 4.2) + 6,
      weight: 22, kind: 'market'
    };
  }

  function portRects() {
    return ports.map(p => {
      const d = dockGeom(p);
      return {
        x: d.bx + d.ox * (d.len + d.signH / 2),
        y: d.by + d.oy * (d.len + d.signH / 2),
        w: d.signW + 6, h: d.signH + 6, weight: 22, kind: 'port'
      };
    });
  }

  /** A mooring post: a dark stub with a lit top, standing proud of the deck. */
  function mooring(x, y, r, col) {
    ctx.beginPath(); ctx.ellipse(x, y + r * 0.5, r * 0.95, r * 0.5, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(4,18,34,.42)'; ctx.fill();
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = col.post; ctx.fill();
    ctx.lineWidth = Math.max(1, r * 0.42);
    ctx.strokeStyle = col.rim; ctx.stroke();
    ctx.beginPath(); ctx.arc(x - r * 0.25, y - r * 0.28, r * 0.4, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,240,205,.7)'; ctx.fill();
  }

  function drawDock(p, unlocked) {
    const s = proj.s;
    const col = unlocked ? WOOD.open : WOOD.shut;
    const d = dockGeom(p);
    const { bx, by, ox, oy, nx, ny, len, foot, half } = d;

    const heelX = bx + ox * foot, heelY = by + oy * foot;
    const tipX = bx + ox * len, tipY = by + oy * len;
    // Deck corners, flared at the seaward end so it reads as a jetty rather
    // than a plank.
    const inA = [heelX + nx * half * 0.86, heelY + ny * half * 0.86];
    const inB = [heelX - nx * half * 0.86, heelY - ny * half * 0.86];
    const outA = [tipX + nx * half * 1.2, tipY + ny * half * 1.2];
    const outB = [tipX - nx * half * 1.2, tipY - ny * half * 1.2];
    const deckPath = () => {
      ctx.beginPath();
      ctx.moveTo(inA[0], inA[1]); ctx.lineTo(outA[0], outA[1]);
      ctx.lineTo(outB[0], outB[1]); ctx.lineTo(inB[0], inB[1]);
      ctx.closePath();
    };

    // An unlocked harbour throws a warm pool of light on the water.
    if (unlocked) {
      ctx.save();
      const gl = ctx.createRadialGradient(
        (heelX + tipX) / 2, (heelY + tipY) / 2, half * 0.4,
        (heelX + tipX) / 2, (heelY + tipY) / 2, len * 1.05);
      gl.addColorStop(0, 'rgba(255,201,60,.30)');
      gl.addColorStop(1, 'rgba(255,201,60,0)');
      ctx.fillStyle = gl;
      ctx.beginPath();
      ctx.arc((heelX + tipX) / 2, (heelY + tipY) / 2, len * 1.05, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Two gangways running down off the corners that actually own the port —
    // the classic harbour V, and the only bit of the dock that touches land.
    ctx.lineCap = 'round';
    for (const iid of p.intersections) {
      const n = intersections[iid];
      if (!n) continue;
      const ax = PX(n.x), ay = PY(n.z);
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(heelX, heelY);
      ctx.lineWidth = Math.max(4, s * 0.5);
      ctx.strokeStyle = col.rim; ctx.stroke();
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(heelX, heelY);
      ctx.lineWidth = Math.max(2.2, s * 0.3);
      ctx.strokeStyle = col.deck; ctx.stroke();
      // Sleepers across the gangway so it is planking, not a cable.
      const steps = 3;
      ctx.lineWidth = Math.max(0.9, s * 0.1);
      ctx.strokeStyle = col.plank;
      for (let i = 1; i <= steps; i++) {
        const t = i / (steps + 1);
        const mx = ax + (heelX - ax) * t, my = ay + (heelY - ay) * t;
        let gx = heelX - ax, gy = heelY - ay;
        const gm = Math.hypot(gx, gy) || 1;
        gx /= gm; gy /= gm;
        const w = Math.max(1.6, s * 0.22);
        ctx.beginPath();
        ctx.moveTo(mx - gy * w, my + gx * w);
        ctx.lineTo(mx + gy * w, my - gx * w);
        ctx.stroke();
      }
    }

    // Deck, with a shadow on the water under it.
    ctx.save();
    ctx.shadowColor = 'rgba(2,14,30,.6)';
    ctx.shadowBlur = Math.max(5, s * 1.3);
    ctx.shadowOffsetY = Math.max(2, s * 0.55);
    deckPath();
    ctx.fillStyle = col.deck; ctx.fill();
    ctx.restore();

    // Planking: cross-boards along the run, plus a centre stringer.
    ctx.save();
    deckPath();
    ctx.clip();
    ctx.lineWidth = Math.max(1, s * 0.13);
    ctx.strokeStyle = col.plank;
    const planks = 5;
    for (let i = 1; i <= planks; i++) {
      const t = foot + (i / (planks + 1)) * (len - foot);
      ctx.beginPath();
      ctx.moveTo(bx + ox * t + nx * half * 1.4, by + oy * t + ny * half * 1.4);
      ctx.lineTo(bx + ox * t - nx * half * 1.4, by + oy * t - ny * half * 1.4);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(heelX, heelY); ctx.lineTo(tipX, tipY);
    ctx.lineWidth = Math.max(0.8, s * 0.1);
    ctx.strokeStyle = 'rgba(255,244,214,.4)';
    ctx.stroke();
    ctx.restore();

    deckPath();
    ctx.lineWidth = Math.max(1.3, s * 0.17);
    ctx.strokeStyle = col.rim;
    ctx.stroke();

    // Four mooring posts, two a side.
    const pr = Math.max(2, s * 0.28);
    for (const t of [0.42, 0.94]) {
      const along = foot + (len - foot) * t;
      for (const side of [1, -1]) {
        mooring(bx + ox * along + nx * half * 1.3 * side,
          by + oy * along + ny * half * 1.3 * side, pr, col);
      }
    }
    return d;
  }

  /** The ratio board, bolted to the seaward end of its own dock. */
  function drawDockSign(p, d, unlocked) {
    const col = unlocked ? WOOD.open : WOOD.shut;
    const { bx, by, ox, oy, nx, ny, len, signW, signH } = d;
    const cx = bx + ox * (len + signH * 0.62);
    const cy = by + oy * (len + signH * 0.62);
    // The ratio boards read like the number discs and stand up like them too.
    const up = billboard(cx, cy);

    // Two legs from the deck tip up to the board.
    ctx.lineWidth = Math.max(1.4, proj.s * 0.2);
    ctx.strokeStyle = col.rim;
    for (const side of [1, -1]) {
      ctx.beginPath();
      ctx.moveTo(bx + ox * len + nx * signW * 0.16 * side,
        by + oy * len + ny * signW * 0.16 * side);
      ctx.lineTo(cx + nx * signW * 0.2 * side, cy + ny * signW * 0.2 * side);
      ctx.stroke();
    }

    plate(cx, cy, signW, signH, col.sign, col.edge, Math.min(signH / 2, 7), 2);
    rounded(cx - signW / 2 + 3, cy - signH / 2 + 2.5, signW - 6, signH * 0.22, 2);
    ctx.fillStyle = 'rgba(255,255,255,.6)'; ctx.fill();

    const dot = RES_DOT[p.resource];
    const fs = Math.round(Math.min(signH * 0.72, signW * 0.34));
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = f(800, fs);
    ctx.fillStyle = col.ink;
    if (dot) {
      // Resource bead on the left of the board, ratio on the right.
      const dr = signH * 0.28;
      ctx.fillText(p.label, cx + signW * 0.14, cy + 1);
      ctx.beginPath(); ctx.arc(cx - signW * 0.28, cy, dr, 0, Math.PI * 2);
      ctx.fillStyle = dot; ctx.fill();
      ctx.lineWidth = Math.max(1, dr * 0.3);
      ctx.strokeStyle = 'rgba(20,14,4,.8)'; ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx - signW * 0.28, cy - dr * 0.28, dr * 0.55, Math.PI * 1.1, Math.PI * 1.9);
      ctx.lineWidth = Math.max(0.8, dr * 0.24);
      ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.stroke();
    } else {
      ctx.fillText(p.label, cx, cy + 1);
    }

    // A lit lantern on a post at the seaward end of any dock the player has
    // unlocked, so "which of these nine are mine" is answered at a glance.
    if (unlocked) {
      const lx = bx + ox * (len + signH * 0.05) + nx * (signW * 0.5 + signH * 0.18);
      const ly = by + oy * (len + signH * 0.05) + ny * (signW * 0.5 + signH * 0.18);
      ctx.beginPath(); ctx.arc(lx, ly, signH * 0.42, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,214,110,.34)'; ctx.fill();
      ctx.beginPath(); ctx.arc(lx, ly, signH * 0.23, 0, Math.PI * 2);
      ctx.fillStyle = '#fff6d0'; ctx.fill();
      ctx.lineWidth = Math.max(1.1, signH * 0.09);
      ctx.strokeStyle = '#7a4a16'; ctx.stroke();
    }
    if (up) ctx.restore();
  }

  function drawPorts(state) {
    const mine = state.players[0].ports;
    for (const p of ports) {
      const unlocked = mine.has(p.id);
      const d = drawDock(p, unlocked);
      drawDockSign(p, d, unlocked);
    }
  }

  /* -------------------------------------------------------------- network */

  function drawRoads(state) {
    const s = proj.s;
    const w = Math.max(8, s * 1.3);
    for (const [eid, pid] of state.roadOwner) {
      const e = edges[eid];
      const A = intersections[e.a], B = intersections[e.b];
      const col = state.players[pid].color;
      const mine = pid === 0;
      const ax = PX(A.x), ay = PY(A.z), bx = PX(B.x), by = PY(B.z);
      ctx.lineCap = 'round';
      if (mine) {
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
        ctx.lineWidth = w + Math.max(5, s * 0.46);
        ctx.strokeStyle = 'rgba(255,201,60,.42)';
        ctx.stroke();
      }
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
      ctx.lineWidth = w + Math.max(2.4, s * 0.24);
      ctx.strokeStyle = 'rgba(8,18,10,.72)';
      ctx.stroke();
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
      ctx.lineWidth = w;
      ctx.strokeStyle = col.css;
      ctx.stroke();
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
      ctx.lineWidth = w * 0.34;
      ctx.strokeStyle = col.light;
      ctx.stroke();
    }
  }

  function houseGlyph(x, y, k, col) {
    ctx.beginPath();
    ctx.moveTo(x, y - k * 1.35);
    ctx.lineTo(x + k, y - k * 0.25);
    ctx.lineTo(x + k * 0.72, y - k * 0.25);
    ctx.lineTo(x + k * 0.72, y + k);
    ctx.lineTo(x - k * 0.72, y + k);
    ctx.lineTo(x - k * 0.72, y - k * 0.25);
    ctx.lineTo(x - k, y - k * 0.25);
    ctx.closePath();
    ctx.fillStyle = col.css; ctx.fill();
    ctx.lineWidth = Math.max(1.1, k * 0.28);
    ctx.strokeStyle = 'rgba(10,20,32,.85)'; ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x, y - k * 1.25); ctx.lineTo(x + k * 0.7, y - k * 0.3);
    ctx.lineTo(x - k * 0.7, y - k * 0.3); ctx.closePath();
    ctx.fillStyle = col.light; ctx.fill();
  }

  function castleGlyph(x, y, k, col) {
    ctx.beginPath();
    ctx.moveTo(x - k * 1.25, y + k);
    ctx.lineTo(x - k * 1.25, y - k * 0.75);
    ctx.lineTo(x - k * 0.85, y - k * 0.75);
    ctx.lineTo(x - k * 0.85, y - k * 1.25);
    ctx.lineTo(x - k * 0.45, y - k * 1.25);
    ctx.lineTo(x - k * 0.45, y - k * 0.75);
    ctx.lineTo(x + k * 0.45, y - k * 0.75);
    ctx.lineTo(x + k * 0.45, y - k * 1.25);
    ctx.lineTo(x + k * 0.85, y - k * 1.25);
    ctx.lineTo(x + k * 0.85, y - k * 0.75);
    ctx.lineTo(x + k * 1.25, y - k * 0.75);
    ctx.lineTo(x + k * 1.25, y + k);
    ctx.closePath();
    ctx.fillStyle = col.css; ctx.fill();
    ctx.lineWidth = Math.max(1.1, k * 0.26);
    ctx.strokeStyle = 'rgba(10,20,32,.85)'; ctx.stroke();
    ctx.fillStyle = col.light;
    ctx.fillRect(x - k * 1.25, y - k * 0.75, k * 2.5, k * 0.34);
    ctx.fillStyle = 'rgba(10,20,32,.75)';
    ctx.fillRect(x - k * 0.3, y + k * 0.05, k * 0.6, k * 0.95);
  }

  /**
   * Owner-coloured pip with the piece glyph on it — and nothing else.
   *
   * The player's own pieces used to wear a gold outline, a gold halo ring and
   * an extra tenth of radius on top. The player asked for all three to go:
   * "I don't need that gold section for where my house is... I just wanted the
   * actual blue circle a little bigger once it's placed on the map." So every
   * pip on the board is now the same plain disc in its owner's colour, a size
   * up from before, and the colour alone does the identifying — which is what
   * the colour swatch in the right-hand rail is there to key.
   *
   * `mine` is kept in the signature because overview.js's placement preview
   * calls through here; it no longer changes anything about the drawing.
   */
  function ownerPip(x, y, r, col, city, mine) {
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.55)'; ctx.shadowBlur = r * 0.9; ctx.shadowOffsetY = r * 0.34;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = col.css; ctx.fill();
    ctx.restore();
    ctx.beginPath(); ctx.arc(x, y - r * 0.22, r * 0.72, Math.PI * 1.1, Math.PI * 1.9);
    ctx.lineWidth = r * 0.24; ctx.strokeStyle = col.light; ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(2, r * 0.26);
    ctx.strokeStyle = 'rgba(8,18,30,.9)';
    ctx.stroke();
    const k = r * 0.56;
    if (city) castleGlyph(x, y + k * 0.1, k, { css: '#f4f8ff', light: '#ffffff' });
    else houseGlyph(x, y + k * 0.1, k, { css: '#f4f8ff', light: '#ffffff' });
  }

  function drawBuildings(state) {
    // A step up from the old 0.9 / 9.5px floor. With the gold gone the disc is
    // the only thing carrying "a settlement stands here", so it has to be big
    // enough to read at a glance on a 375px-tall phone. Frozen at the player's
    // request — only the choose-a-spot target shrank.
    const r = pipRadius(proj);
    for (const [iid, b] of state.buildings) {
      const n = intersections[iid];
      const col = state.players[b.owner].color;
      ownerPip(PX(n.x), PY(n.z), b.type === 'city' ? r * 1.22 : r,
        col, b.type === 'city', b.owner === 0);
    }
  }

  function drawRobber(state) {
    // Switched off for this match: there is no Knight to draw, and a hooded
    // figure sitting on the desert would be a promise the deck cannot keep.
    if (!knightsOn()) return;
    const t = tiles[state.robberTile];
    if (!t) return;
    const s = proj.s;
    hexPath(t, 0);
    ctx.fillStyle = 'rgba(8,14,24,.46)'; ctx.fill();
    const x = PX(t.x), y = PY(t.z) - HEX_SIZE * s * 0.42;
    const k = Math.max(5, s * 0.9);
    ctx.beginPath();
    ctx.moveTo(x - k, y + k * 1.1);
    ctx.quadraticCurveTo(x - k * 0.9, y - k * 1.35, x, y - k * 1.35);
    ctx.quadraticCurveTo(x + k * 0.9, y - k * 1.35, x + k, y + k * 1.1);
    ctx.closePath();
    ctx.fillStyle = '#232f3d'; ctx.fill();
    ctx.lineWidth = Math.max(1, k * 0.24);
    ctx.strokeStyle = 'rgba(255,255,255,.38)'; ctx.stroke();
    ctx.fillStyle = '#ff5a3c';
    ctx.beginPath(); ctx.arc(x - k * 0.33, y - k * 0.25, k * 0.17, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(x + k * 0.33, y - k * 0.25, k * 0.17, 0, Math.PI * 2); ctx.fill();
  }

  /**
   * Where you are standing, and nothing else.
   *
   * The board used to carry a solved name plate for all four settlers. The
   * player was unambiguous about it — "I don't want to see the players' names
   * on the board at all while picking positions" — so the plates, their leader
   * lines and the collision solver behind them are gone. What is left is one
   * gold-ringed pin for the human, because "which end of the island am I on"
   * is the one question the map cannot answer any other way. Rivals are named,
   * scored and coloured in the right-hand rail; they need nothing on the hexes.
   */
  function drawSettlers(state) {
    const p = state.players && state.players[0];
    if (!p) return;
    const s = proj.s;
    const r = Math.max(6.5, s * 0.9);
    const x = PX(p.x), y = PY(p.z);

    ctx.save();
    ctx.beginPath(); ctx.ellipse(x, y + r * 0.9, r * 0.95, r * 0.4, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,.38)'; ctx.fill();

    ctx.beginPath(); ctx.arc(x, y, r * 1.75, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,201,60,.16)'; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,201,60,.55)'; ctx.stroke();

    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = p.color.css; ctx.fill();
    ctx.beginPath(); ctx.arc(x, y - r * 0.22, r * 0.66, Math.PI * 1.1, Math.PI * 1.9);
    ctx.lineWidth = r * 0.28; ctx.strokeStyle = p.color.light; ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(2, r * 0.34); ctx.strokeStyle = '#ffc93c'; ctx.stroke();
    ctx.restore();
  }

  return {
    PX, PY, hexPath, plate, rounded,
    drawSea, fillSea, drawFrame, clipToFrame,
    drawShelf, drawTiles, drawTokens, tokenRects,
    /** The vertical scale the canvas really had while the board and while a
     *  billboarded label were painted. Read by the capture rig only. */
    get scales() { return { board: +seen.board.toFixed(3), label: +seen.label.toFixed(3) }; },
    drawPorts, portRects, marketRect, drawRoads, drawBuildings, drawRobber, ownerPip,
    drawSettlers
  };
}

export default createPainter;
