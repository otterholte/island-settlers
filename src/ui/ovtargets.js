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
 * Knight to, and the mark that says which corner a rival is about to take.
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
 * 2. "The thick yellow sections showing where I can place a road actually are
 *    too distracting, I'd rather them have glow slowly flashing pulsing white
 *    borders." And: "Don't let the highlight or border of where I can place a
 *    road ever cover the settlement or city on the map view of myself or
 *    another player."
 *
 *    An available edge started as a 7px line at a wandering alpha, then became a
 *    solid dark-cased GOLD SLAB with sleepers on it — legible, and on a board
 *    that already carries four colours of real road, far too loud: thirty of
 *    them at once read as thirty new roads rather than as thirty invitations.
 *    It is now an EMPTY SLOT with a slowly pulsing white glow round its border,
 *    so the terrain, the tokens and the real roads all stay visible through
 *    every target. Any end of a slot that lands on a BUILT corner is trimmed
 *    back clear of the piece standing there, because settlements and cities are
 *    baked BEHIND this layer and anything painted over one hides it — and "is
 *    that junction already taken" is exactly the question being asked when a
 *    player is working out whether a road dead-ends.
 *
 *    The chosen edge stays solid and stays in the player's own colour: there is
 *    only ever one of it, and it should look like the road about to exist.
 *
 * 3. The Knight used to tint EIGHTEEN of the nineteen hexes gold — every legal
 *    one — so the board read as uniformly gold and the terrain washed out. It
 *    is the other way round now: the one hex you may NOT choose (the one the
 *    Knight is already on) is dimmed and struck through, the legal ones keep
 *    their own colour under a thin gold rim, and gold fill is spent only on the
 *    hex under the finger and the hex you have chosen.
 *
 * Owner: UI agent.
 */

import { HEX_SIZE } from '../core/constants.js';
import { tiles, intersections, edges, ports } from '../board/layout.js';
import { pipRadius } from './ovmap.js';

export function createTargets(ctx, proj, paint, state) {
  const PX = x => x * proj.s + proj.ox;
  const PY = z => z * proj.s + proj.oy;

  /* ------------------------------------------------------------- the sizes */

  /**
   * How many corner rings the last frame painted. Written by `drawTargets`,
   * read by `targetR` — see the note there for why the ring has two sizes.
   */
  let ringCount = 0;
  /* True while the map is offering CITY upgrades, which is the one mode whose
     ring is not the size of the thing being placed — see `targetR`. */
  let ringCity = false;

  /**
   * A field of corners is CROWDED above this many; below it, it is a shortlist.
   * The opening draft offers 40-54 legal corners; a build sheet offers one to
   * about eight, and has never once offered sixteen.
   */
  const CROWD = 16;

  /**
   * The choose-a-spot ring, at one of two sizes.
   *
   * A corner target is a ring rather than a disc, and stays hollow, because
   * fifty-odd of them are legal at the opening of a draft and a field of solid
   * discs hides the terrain the player is trying to judge.
   *
   * It has been walked down twice. A pass before last roughly doubled it to
   * 0.38 of the corner spacing, which at 667x375 put a 22px ring on a 29px
   * spacing and the board vanished under them; 0.21 halved that. The player
   * still found them too prominent — "make the little gold circles a little
   * smaller" — so the CROWDED size is 0.15 with the floor dropped from 6.5 to
   * 4.6, which lands a 9.2px ring at 667x375 against the 13px it was.
   *
   * WHICH IS HALF THE SIZE OF THE PIECE IT IS INVITING, AND ON A SHORTLIST
   * THAT IS INVISIBLE. A review of the build sheet tapped the settlement chip
   * and photographed the result:
   *
   *   "THE SETTLEMENT CHIP SWITCHES THE MAP TO AN EMPTY BOARD ... five are the
   *    REMOVAL of white road ghosts ... Nothing was added. The chip reads 'x1'
   *    and is selected with a gold ring, the road candidates are cleared, and
   *    the player is left staring at a board with zero highlights."
   *
   * Nothing was broken: `legalSettlements` had returned two corners and both
   * were painted. They were painted as 9px rings on a board whose number discs
   * are 26px and whose road invitations are 14.5px slabs, so a diff of the two
   * frames could not tell them from compression noise — and neither could a
   * player. The road slot already carries this argument in its own comment
   * ("an invitation that is thinner than the thing it invites you to build
   * reads as a hairline"); the corner ring was exempt from it by accident.
   *
   * So on a SHORTLIST the ring is sized off `pipRadius` — the settlement that
   * will stand on the spot. 0.74 of it was the first answer and it was still
   * too quiet:
   *
   *   "i also want the white glowing circles for the settlements to be a bit
   *    more obvious."
   *
   * 0.95 is that: the ring is now very nearly the footprint of the settlement
   * it is offering, which is the same argument the road slot won years ago.
   *
   * THE CITY RING IS A DIFFERENT SIZE, AND IT HAS TO BE.
   *
   *   "for the cities, right now the white glow is the same size as the current
   *    settlement thats on it, i would prefer that the white glowing circle is
   *    larger and occupys a space larger and around the perimeter of the
   *    settlement, like maybe the width of where the new city would actually
   *    be, since cities are wider then settlements."
   *
   * Every other mode offers an EMPTY spot, so a ring the size of the piece is
   * exactly right. A city upgrade offers a spot that is already occupied — the
   * settlement disc is standing in it — so a ring at settlement size lands on
   * top of the thing it is pointing at and reads as a highlight rather than as
   * a footprint. `drawBuildings` in ovmap.js paints a city at `pipRadius * 1.28`
   * against a settlement's 1.0, so 1.58 of the ring's own 0.95 puts the stroke
   * at 1.5 pips: clear of the disc already there, and about where the city's
   * own edge is going to be.
   *
   * What the finger gets is unchanged either way: `hitRadius()` owns the hit
   * test and still claims a 52px zone around every corner, nearest wins.
   */
  const CITY_RING = 1.58;
  /* Both sizes are plain multiples of `proj.s` — no floors, for the reason
     given at length on `pipRadius` in ovmap.js. The CROWDED ring goes from 0.15
     of the hex radius to 0.28: at the fitted scale 0.15 drew a 7.6px circle on
     a 25px corner spacing, and a draft board offering fifty of those is
     offering nothing anyone can see. 0.28 is a 14px ring — still well inside
     the spacing, still hollow, and still much the smaller of the two sizes. */
  const targetR = () => {
    const base = (ringCount > 0 && ringCount <= CROWD)
      ? Math.max(pipRadius(proj) * 0.95, HEX_SIZE * proj.s * 0.28)
      : HEX_SIZE * proj.s * 0.28;
    return ringCity ? base * CITY_RING : base;
  };

  /**
   * The coloured core of a road target, in css px.
   *
   * A built road is `s * 2.2` wide in ovmap.js. A target has to be at
   * least that — an invitation that is thinner than the thing it invites you to
   * build reads as a hairline, which is precisely what the player was looking
   * at. This is a shade wider again, and it carries a dark casing on top of
   * that, so an available edge is a slab on a ~25px edge: unmistakably
   * road-shaped, and impossible to confuse with the map's own strokes.
   *
   *   "The glowing sections for where roads can go are also too small."
   *
   * THE SLOT AND THE ROAD ARE ONE DECISION, and neither has a pixel floor —
   * see the note on `pipRadius` in ovmap.js for why a floor is the thing that
   * made pieces appear to resize on their own. 2.75 is 1.25x the road's own
   * 2.2, the same margin the two have always carried, so the slot stays visibly
   * wider than the road it becomes at every scale. If `drawRoads` in ovmap.js
   * changes, this changes with it, in the same commit.
   */
  const roadBodyW = () => proj.s * 2.75;

  /** Radius of the tap zone around any target. >= 22 gives >= 44px across. */
  const hitRadius = () => Math.max(26, HEX_SIZE * proj.s * 0.5);

  /* ------------------------------------------------------------ road slabs */

  /** Does a settlement or a city already stand on this corner? */
  function built(iid) {
    const b = state && state.buildings;
    if (!b) return false;
    return typeof b.has === 'function' ? b.has(iid) : !!b[iid];
  }

  /**
   * How far a road highlight must stand off a corner, in css px.
   *
   *   "Don't let the highlight or border of where I can place a road ever cover
   *    the settlement or city on the map view of myself or another player,
   *    otherwise I can't really see where I might get stuck if I play a road
   *    there and it's a dead end after that since there's a settlement that
   *    wasn't clear enough."
   *
   * Settlements and cities are baked into the board BEHIND the target layer
   * (see `overview.draw`), so there is no z-order fix available — anything
   * painted on an occupied corner covers the piece standing on it, full stop.
   * The only fix is to not paint there, so an end that lands on a built corner
   * is trimmed back past the pip AND past the round cap the widest layer of the
   * highlight bulges out with. `pad` is that cap allowance, supplied by the
   * caller because the chosen edge is drawn fatter than an available one.
   *
   * The cost is a slightly shorter highlight against an occupied junction, and
   * the gain is that you can always see whose piece is sitting on the end of the
   * road you are about to build — which is exactly the dead-end read asked for.
   */
  function cornerClear(iid, pad) {
    return built(iid) ? pipRadius(proj) * 1.30 + pad : 0;
  }

  /**
   * The two ends of an edge in canvas px, trimmed back off both corners.
   *
   * `pad` is half the width of the widest stroke the caller will lay down, so
   * an occupied corner can be cleared by the ink rather than by the centreline.
   */
  function edgeRun(id, w, pad = 0) {
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
    // ...and trimmed a great deal harder at an end that already holds a piece.
    // Capped at 42% each so an edge with a settlement on BOTH ends still keeps a
    // stub of highlight in the middle rather than vanishing.
    const ta = Math.min(L * 0.42, Math.max(trim, cornerClear(e.a, pad)));
    const tb = Math.min(L * 0.42, Math.max(trim, cornerClear(e.b, pad)));
    return {
      ax, ay, bx, by, ux, uy, nx: -uy, ny: ux, len: L,
      builtA: built(e.a), builtB: built(e.b),
      x0: ax + ux * ta, y0: ay + uy * ta,
      x1: bx - ux * tb, y1: by - uy * tb,
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

  /**
   * The OUTLINE of a road slot as a path: a stadium — two parallel sides and a
   * round cap at each end — traced round the run at width `w`.
   *
   * Both caps sweep anticlockwise in canvas terms, which is what keeps the path
   * a single closed loop rather than a bow tie.
   */
  function runOutline(r, w) {
    const h = w / 2;
    const nx = r.nx * h, ny = r.ny * h;
    const a0 = Math.atan2(r.ny, r.nx);
    ctx.beginPath();
    ctx.moveTo(r.x0 + nx, r.y0 + ny);
    ctx.lineTo(r.x1 + nx, r.y1 + ny);
    ctx.arc(r.x1, r.y1, h, a0, a0 - Math.PI, true);
    ctx.lineTo(r.x0 - nx, r.y0 - ny);
    ctx.arc(r.x0, r.y0, h, a0 + Math.PI, a0, true);
    ctx.closePath();
  }

  /** Stroke the current path at a width and alpha, in white. */
  function ghost(lw, alpha) {
    ctx.lineWidth = lw;
    ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
    ctx.stroke();
  }

  /**
   * An AVAILABLE edge: a HOLLOW slot with a slow pulsing white glow round it.
   *
   *   "The thick yellow sections showing where I can place a road actually are
   *    too distracting, I'd rather them have glow slowly flashing pulsing white
   *    borders."
   *
   * What this replaces was a solid object: a 15px gold slab with a dark casing
   * and cross-planks on it, laid over every legal edge at once. Thirty of them
   * on screen together was thirty new ROADS painted on a board that already
   * carries four colours of real road, and the eye had to work out which of them
   * were real before it could think about where to build. That is the whole
   * complaint — the highlight was competing with the board instead of annotating
   * it.
   *
   * So the slot is empty now. Four concentric strokes of one stadium outline —
   * a wide faint halo, a soft mid, a bright edge and a hairline — plus a whisper
   * of dark wash inside to seat it on pale sand. The terrain, the tokens and the
   * real roads all stay visible THROUGH every target, and what marks the spot is
   * light rather than paint.
   *
   * The pulse is deliberately slow: `slow` runs at 1.9 rad/s against the 4.2 the
   * corner rings beat at, so it reads as breathing rather than blinking, and it
   * never falls below half strength — an invitation that disappears is worse
   * than a loud one.
   *
   * Concentric strokes rather than `shadowBlur`: a canvas shadow on thirty paths
   * a frame is the one thing in this layer that could cost a phone its frame
   * rate, and four cheap strokes look the same.
   */
  function drawRoadTarget(id, warm, beat, slow) {
    const w = roadBodyW();
    const r = edgeRun(id, w, w * 0.5 + 7);
    if (!r) return;
    const k = warm ? 1 : 0.52 + 0.48 * slow;      // never fully dark
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    runOutline(r, w);
    // A whisper of shade inside the slot. Not a fill — a seat, so the white
    // border has something to sit against on bright sand and gold wheat.
    ctx.fillStyle = `rgba(9,20,34,${0.10 + 0.05 * k})`;
    ctx.fill();
    /* The three inner passes are absolute pixels on purpose — a glowing border
       is a border, and a border that thins as the board is zoomed out is the
       hairline this whole treatment exists to stop being. Widened by about a
       quarter along with the slot itself ("the glowing sections for where roads
       can go are also too small"); the halo is tied to `w` and grew with it. */
    ghost(w * 0.62 + 9, 0.055 + 0.075 * k);       // the halo
    ghost(8.0, 0.10 + 0.16 * k);                  // the bloom
    ghost(3.8, 0.34 + 0.40 * k);                  // the edge
    ghost(1.8, 0.55 + 0.45 * k);                  // the hairline
    ctx.restore();
  }

  /**
   * The CHOSEN edge, painted after every other target so nothing crosses it.
   *
   * This one stays SOLID and stays in the player's own colour. Exactly one of
   * them is ever on screen, so it costs the board nothing, and the whole job of
   * the chosen state is to look like the road that is about to exist. It wears
   * the same white glow as the empty slots around it, so picking one reads as
   * the outline filling in rather than as a change of language.
   */
  function drawRoadChosen(id, beat, slow) {
    const w = roadBodyW() * 1.16;
    const r = edgeRun(id, w, w * 0.5 + 9);
    if (!r) return;
    const col = state.players[0].color;
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    runStroke(r, w + 4.5, 'rgba(16,10,2,.95)');
    runStroke(r, w, col.css);
    runStroke(r, Math.max(1.8, w * 0.30), col.light);
    sleepers(r, w, 'rgba(10,18,30,.45)');
    runOutline(r, w + 4.5);
    ghost(w * 0.62 + 11, 0.07 + 0.10 * slow);
    ghost(7.0, 0.16 + 0.20 * slow);
    ghost(3.2, 0.48 + 0.42 * slow);
    ghost(1.5, 0.70 + 0.30 * slow);

    // A stud on each corner the road will join: "this end and that end". A
    // corner that already carries a settlement or a city gets none — covering
    // the piece is the exact thing the player asked us to stop doing, and the
    // built piece says "this end joins here" better than a stud ever did.
    const knob = Math.max(3.4, w * 0.44);
    const ends = [];
    if (!r.builtA) ends.push([r.ax, r.ay]);
    if (!r.builtB) ends.push([r.bx, r.by]);
    for (const [kx, ky] of ends) {
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

  /* ----------------------------------------------------------- the Knight */

  /**
   * Mark the ONE hex that is not a choice, and leave the other eighteen alone.
   *
   * Tinting every legal region gold painted 18 of 19 hexes the same colour and
   * the board stopped being a board — you cannot pick the best region to block
   * if you cannot read which region is which. The hex the Knight already
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

  /**
   * An AVAILABLE corner: the SAME object as an available edge, in a circle.
   *
   *   "Update the settlement and city location selection so it looks instead of
   *    a thin yellow circle to see where my potential placements are, its a
   *    thicker white glowing circle, like the appearance of the ovals for the
   *    potential road placements."
   *
   * The road slots were rebuilt into a hollow white glow at the same request,
   * one step earlier in the run — "I'd rather them have glow slowly flashing
   * pulsing white borders" — and the corners were left in the old language.
   * Two kinds of "you may build here" in two colours at two pulse rates on one
   * board is a thing the eye has to learn rather than read.
   *
   * So this is `drawRoadTarget` with `arc` where it had `edgeRun`: the same
   * seat of shade inside the shape, the same four-pass white stack from a wide
   * faint halo down to a bright hairline, the same `slow` breath. Nothing about
   * the SIZE moved — `targetR()` is untouched and still owns it, along with the
   * crowded-board rule and the capture rig that measures it.
   *
   * The gold survives in exactly one place, and it has to: the CHOSEN corner.
   * That one is not an invitation any more, it is an answer, and it is the only
   * ring on screen that means something different from the others.
   */
  function drawCornerTarget(id, chosen, warm, beat, glow, halo, slow) {
    const n = intersections[id];
    if (!n) return;
    const x = PX(n.x), y = PY(n.z);
    const r = targetR();
    const rr = r * (chosen ? 1.22 : (warm ? 1.12 : 1));
    ctx.save();

    if (warm) {
      // One expanding sonar ripple, on the one under the finger only, and kept
      // close to the ring it comes off: a wide ripple on a small target is all
      // ripple and no target.
      ctx.globalAlpha = (1 - halo) * 0.7;
      ctx.beginPath(); ctx.arc(x, y, r * (1.0 + halo * 0.5), 0, Math.PI * 2);
      ctx.lineWidth = Math.max(1.3, r * 0.2);
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    if (chosen) {
      // The answer, not an invitation: solid, gold, and the only one on screen.
      ctx.beginPath(); ctx.arc(x, y, rr, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,238,190,.94)'; ctx.fill();
      ctx.beginPath(); ctx.arc(x, y, rr, 0, Math.PI * 2);
      ctx.lineWidth = Math.max(1.4, r * 0.28);
      ctx.strokeStyle = 'rgba(20,12,4,.55)'; ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y, rr, 0, Math.PI * 2);
      ctx.lineWidth = Math.max(1.3, r * 0.19) * 1.8;
      ctx.strokeStyle = '#fff4cf';
      ctx.shadowColor = 'rgba(255,201,60,.85)';
      ctx.shadowBlur = proj.s * 2.4;
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.restore();
      return;
    }

    // ...and every other corner is a road slot that happens to be round.
    const k = warm ? 1 : 0.52 + 0.48 * (slow === undefined ? beat : slow);
    ctx.beginPath(); ctx.arc(x, y, rr, 0, Math.PI * 2);
    /* A whisper of shade inside the ring. Not a fill — a seat, so the white has
       something to sit against on bright sand and gold wheat. The CITY ring
       does not get one: there is a settlement disc inside that circle already,
       and washing it grey would dim the very thing being pointed at. */
    if (!ringCity) {
      ctx.fillStyle = `rgba(9,20,34,${0.12 + 0.06 * k})`;
      ctx.fill();
    }
    // Four restrained, projection-relative passes: enough contrast to remain
    // obvious without turning a crowded draft board into a field of white discs.
    ghost(rr * 0.62, 0.04 + 0.06 * k);                 // the halo
    ghost(rr * 0.40, 0.08 + 0.12 * k);                 // the bloom
    ghost(rr * 0.22, 0.28 + 0.30 * k);                 // the edge
    ghost(rr * 0.10, 0.50 + 0.28 * k);                 // the hairline
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
    const r = pipRadius(proj) * (city ? 1.28 : 1);
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r * (1.24 + 0.07 * beat), 0, Math.PI * 2);
    ctx.lineWidth = r * 0.10;
    ctx.strokeStyle = `rgba(255,201,60,${0.38 + 0.20 * beat})`;
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

  /**
   * A dock the M key is offering.
   *
   *   "It opens the map, and highlights all of your maritime ports and lets you
   *    use the arrow keys to select the port you want."
   *
   * Drawn OVER the painted harbour sign rather than instead of it, because the
   * sign already says which dock trades what at what rate and that is most of
   * what the player is choosing between. A gold ring around the berth is the
   * whole treatment; the armed one gets the ring filled and the same bobbing
   * chevron every other armed target wears, so a dock and a corner read as the
   * same gesture.
   */
  function drawPortTarget(id, chosen, warm, beat, glow) {
    const p = ports[id];
    if (!p) return;
    const x = PX(p.x), y = PY(p.z);
    const r = Math.max(13, HEX_SIZE * proj.s * 0.33);

    ctx.save();
    if (chosen) {
      ctx.beginPath(); ctx.arc(x, y, r * (1.16 + 0.05 * beat), 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,201,60,${0.24 + 0.12 * glow})`;
      ctx.fill();
    }
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(2.2, r * (chosen ? 0.26 : 0.17));
    ctx.strokeStyle = chosen
      ? 'rgba(255,214,90,.98)'
      : `rgba(255,201,60,${warm ? 0.92 : 0.52 + 0.24 * beat})`;
    ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(1, r * 0.07);
    ctx.strokeStyle = 'rgba(28,16,4,.55)';
    ctx.stroke();
    ctx.restore();

    if (!chosen) return;
    // The same bobbing chevron every other armed target wears.
    const lift = r * (1.1 + 0.14 * beat);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x, y - lift);
    ctx.lineTo(x - r * 0.42, y - lift - r * 0.54);
    ctx.lineTo(x + r * 0.42, y - lift - r * 0.54);
    ctx.closePath();
    ctx.fillStyle = '#ffd24a';
    ctx.fill();
    ctx.lineWidth = Math.max(1.4, r * 0.11);
    ctx.strokeStyle = 'rgba(24,14,4,.75)';
    ctx.stroke();
    ctx.restore();
  }

  /* ------------------------------------------------------------------ draw */

  function drawTargets(view) {
    const { mode, targets, sel, hover } = view;
    /* Set BEFORE the early return, not after: `targetR()` is also read from
       outside this file (overview's `metrics`, and the capture rig through it),
       and a stale count left over from the last mode would have it reporting a
       ring size that nothing on screen is drawn at. */
    ringCount = (!targets || mode === 'place-road' || mode === 'place-robber'
      || mode === 'pick-port') ? 0 : targets.length;
    // Set beside `ringCount` and for the same reason: `targetR()` is read from
    // outside this file, so both have to be true before the early return.
    ringCity = mode === 'place-city';
    if (!targets || !targets.length) return;
    const pulse = view.pulse || 0;
    const beat = 0.5 + 0.5 * Math.sin(pulse * 4.2);
    // The road slots breathe at less than half that rate. "Slowly flashing
    // pulsing" was the ask, and 4.2 rad/s on thirty edges at once is a strobe.
    const slow = 0.5 + 0.5 * Math.sin(pulse * 1.9);
    const glow = 0.5 + 0.5 * beat;
    const halo = (pulse * 0.9) % 1;

    if (mode === 'place-robber') drawRobberBlocked();

    for (const id of targets) {
      if (id === sel) continue;                 // the choice is painted last
      const warm = id === hover;
      if (mode === 'place-road') drawRoadTarget(id, warm, beat, slow);
      else if (mode === 'place-robber') drawRobberTarget(id, false, warm, beat);
      else if (mode === 'pick-port') drawPortTarget(id, false, warm, beat, glow);
      else drawCornerTarget(id, false, warm, beat, glow, halo, slow);
    }

    if (sel === null || sel === undefined) return;
    if (mode === 'place-road') drawRoadChosen(sel, beat, slow);
    else if (mode === 'place-robber') drawRobberTarget(sel, true, false, beat);
    else if (mode === 'pick-port') drawPortTarget(sel, true, false, beat, glow);
    else drawChosenPiece(sel, mode === 'place-city', beat);
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
