/**
 * Island Settlers — procedural inline-SVG icon set.
 *
 * Every glyph is drawn here in code: no image files, no icon font, no emoji,
 * no remote asset of any kind.
 *
 * The nine gameplay icons — wood, brick, sheep, wheat, ore, road, settlement,
 * city and dev-card — are authored on a 48x48 box at high detail and scaled
 * down, so they still read as lit, dimensional objects at 24 css px. They are
 * built the way a painted game asset is: a merged dark silhouette pass, a base
 * colour pass, then light facets on top. Chrome icons stay on the cheaper
 * 24x24 box.
 *
 * Usage:
 *   icon('log', 28)              -> '<svg ...>...</svg>' markup string
 *   iconEl('trophy', 20, 'gold') -> a <span class="ico gold"> wrapping it
 *   resIcon('wood')              -> the icon name for a resource key
 *   avatar('#2f8ffb', '#93cbff', 32) -> circular player disc
 *
 * Owner: UI agent.
 */

/* ------------------------------------------------------------------ palette */
const C = {
  ink:    '#2a1a0c',
  wood:   '#96601f', woodL: '#d29a54', woodD: '#5f3a12', woodX: '#f0c68a',
  brick:  '#c9532a', brickL: '#ee8a55', brickD: '#8e3315', brickX: '#ffb98a',
  wool:   '#fbf7ee', woolD: '#d9cdb8', woolS: '#b9ab93', face: '#3c3226',
  wheat:  '#f0bd3d', wheatL: '#ffe08a', wheatD: '#a97a12', leaf: '#63a838',
  ore:    '#96a1b1', oreL: '#ccd6e2', oreD: '#5f6a79', oreX: '#eef3fa',
  gold:   '#ffc93c', goldD: '#c98f14', goldL: '#ffe79a',
  cream:  '#f6e7c6', creamD: '#e0cba0', creamX: '#fffaec', brown: '#5a3a1e',
  steel:  '#aeb8c6', steelL: '#dde4ee', steelD: '#5c6878',
  stone:  '#c8c0ae', stoneL: '#e8e2d2', stoneD: '#8b8172',
  blue:   '#2f8ffb', blueL: '#93cbff', blueD: '#1a5db0',
  wall:   '#eef3fa', wallD: '#c3cfdf', wallX: '#ffffff',
  sea:    '#2f8fd0', night: '#24303e', red: '#ff4a35'
};

/** Dark keyline, the outline every asset shares. */
const K = (d, w = 1.5, fill = 'none') =>
  `<path d="${d}" fill="${fill}" stroke="${C.ink}" stroke-width="${w}" ` +
  `stroke-linejoin="round" stroke-linecap="round"/>`;

function polyPath(pts, close = true) {
  let d = `M${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`;
  for (let i = 1; i < pts.length; i++) d += `L${pts[i][0].toFixed(2)} ${pts[i][1].toFixed(2)}`;
  return close ? d + 'Z' : d;
}
const poly = (pts, fill) => `<path d="${polyPath(pts)}" fill="${fill}"/>`;
const line = (d, col, w) =>
  `<path d="${d}" fill="none" stroke="${col}" stroke-width="${w}" ` +
  `stroke-linecap="round" stroke-linejoin="round"/>`;

/** Circle list rendered at r+grow — the merged-silhouette trick. */
const discs = (list, grow, fill) => list
  .map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${(r + grow).toFixed(2)}" fill="${fill}"/>`)
  .join('');

/** Ellipse list, same trick, with rotation. */
const blobs = (list, grow, fill) => list
  .map(([x, y, rx, ry, rot]) =>
    `<ellipse cx="${x}" cy="${y}" rx="${(rx + grow).toFixed(2)}" ry="${(ry + grow).toFixed(2)}"` +
    (rot ? ` transform="rotate(${rot} ${x} ${y})"` : '') + ` fill="${fill}"/>`)
  .join('');

/** One chunky 3D block: front face, lit top face, shaded right face. */
function block(x, y, w, h, dx, dy, f, t, s) {
  const top = [[x, y], [x + dx, y - dy], [x + w + dx, y - dy], [x + w, y]];
  const side = [[x + w, y], [x + w + dx, y - dy], [x + w + dx, y - dy + h], [x + w, y + h]];
  return (
    `<path d="${polyPath([[x, y], [x + dx, y - dy], [x + w + dx, y - dy],
      [x + w + dx, y - dy + h], [x + w, y + h], [x, y + h]])}" fill="${f}"/>` +
    poly(top, t) + poly(side, s) +
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${f}"/>` +
    K(polyPath(top), 2.6) + K(polyPath(side), 2.6) +
    K(`M${x} ${y}h${w}v${h}h${-w}z`, 2.6)
  );
}

/** Crenellated parapet used by the city glyph. */
function merlons(x, y, w, n, h, fill) {
  let out = '';
  const step = w / (n * 2 - 1);
  for (let i = 0; i < n; i++) {
    out += `<rect x="${(x + i * step * 2).toFixed(2)}" y="${y}" width="${step.toFixed(2)}" ` +
      `height="${h}" fill="${fill}" stroke="${C.ink}" stroke-width="2.4" stroke-linejoin="round"/>`;
  }
  return out;
}

function gearPath(teeth = 8, rOuter = 11, rInner = 8.2, cx = 12, cy = 12) {
  const pts = [];
  const step = (Math.PI * 2) / teeth;
  const half = step * 0.26;
  for (let i = 0; i < teeth; i++) {
    const a = i * step - Math.PI / 2;
    pts.push([cx + Math.cos(a - half) * rInner, cy + Math.sin(a - half) * rInner]);
    pts.push([cx + Math.cos(a - half * 0.62) * rOuter, cy + Math.sin(a - half * 0.62) * rOuter]);
    pts.push([cx + Math.cos(a + half * 0.62) * rOuter, cy + Math.sin(a + half * 0.62) * rOuter]);
    pts.push([cx + Math.cos(a + half) * rInner, cy + Math.sin(a + half) * rInner]);
  }
  return polyPath(pts);
}

function starPath(points = 5, rO = 10, rI = 4.4, cx = 12, cy = 12.4) {
  const pts = [];
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 ? rI : rO;
    const a = (Math.PI * i) / points - Math.PI / 2;
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return polyPath(pts);
}

/* =========================================================== 48px gameplay */

/** A cut log: end-grain rings on the near cap, a second log stacked behind. */
const I_LOG = (
  // back log
  `<g>` +
  `<rect x="23" y="9.5" width="21" height="13" rx="6.5" fill="${C.woodD}"/>` +
  `<rect x="26" y="11" width="16" height="4.4" rx="2.2" fill="${C.wood}" opacity=".85"/>` +
  `<ellipse cx="23.6" cy="16" rx="5.2" ry="6.6" fill="${C.woodL}"/>` +
  `<ellipse cx="23.6" cy="16" rx="2.6" ry="3.4" fill="none" stroke="${C.woodD}" stroke-width="1.7"/>` +
  K('M23.6 9.5h14a6.5 6.5 0 0 1 0 13h-14', 2.6) +
  K('M23.6 22.6a5.2 6.6 0 0 1 0-13.2 5.2 6.6 0 0 1 0 13.2z', 2.6) +
  `</g>` +
  // front log
  `<rect x="13.5" y="21" width="31" height="19" rx="9.5" fill="${C.wood}"/>` +
  `<path d="M18 23.4h20a9.5 9.5 0 0 1 5.2 3.6H18z" fill="${C.woodL}" opacity=".75"/>` +
  `<path d="M20 36.6h18a9.5 9.5 0 0 0 4.4-2.6H20z" fill="${C.woodD}" opacity=".5"/>` +
  line('M36.5 24.6c2.6 2.6 2.6 9.6 0 12.2', C.woodD, 2) +
  line('M31 24.2c2 3 2 10.4 0 13.4', C.woodD, 1.5) +
  `<ellipse cx="13.5" cy="30.5" rx="7" ry="9.5" fill="${C.woodX}"/>` +
  `<ellipse cx="13.5" cy="30.5" rx="4.6" ry="6.4" fill="none" stroke="${C.woodL}" stroke-width="2.1"/>` +
  `<ellipse cx="13.5" cy="30.5" rx="2.1" ry="3" fill="none" stroke="${C.woodD}" stroke-width="1.8"/>` +
  `<ellipse cx="13.5" cy="30.5" rx=".7" ry="1" fill="${C.woodD}"/>` +
  K('M13.5 21h21.5a9.5 9.5 0 0 1 0 19H13.5', 3) +
  K('M13.5 40a7 9.5 0 0 1 0-19 7 9.5 0 0 1 0 19z', 3)
);

/** Three fired clay bricks, stacked two-plus-one. */
const I_BRICK =
  block(4, 30, 19, 10, 4.5, 4, C.brick, C.brickL, C.brickD) +
  block(25, 30, 19, 10, 4.5, 4, C.brick, C.brickL, C.brickD) +
  block(14.5, 17, 19, 10, 4.5, 4, C.brick, C.brickX, C.brickD) +
  `<rect x="17" y="19.5" width="9" height="2.4" rx="1.2" fill="${C.brickX}" opacity=".6"/>`;

/** A woolly sheep in profile: merged fleece silhouette, big dark head. */
const I_SHEEP = (() => {
  const fleece = [[15, 25, 9], [23.5, 21, 9.5], [31, 25.5, 8.6], [18.5, 31.5, 8.2], [28, 32, 7.8]];
  return (
    // legs, behind the fleece and long enough to survive at 20px
    `<rect x="15.5" y="32" width="5" height="13" rx="2.2" fill="${C.face}" stroke="${C.ink}" stroke-width="2.6"/>` +
    `<rect x="27" y="32" width="5" height="13" rx="2.2" fill="${C.face}" stroke="${C.ink}" stroke-width="2.6"/>` +
    discs(fleece, 2.4, C.ink) +
    discs(fleece, 0, C.woolS) +
    discs([[23.5, 21, 8.6], [15, 24, 7.8], [31, 24.6, 7.2]], 0, C.woolD) +
    discs([[22, 19.5, 7], [14.6, 22.6, 6]], 0, C.wool) +
    `<circle cx="20.5" cy="18.5" r="4.6" fill="${C.creamX}"/>` +
    // head: large, dark, unmistakable in silhouette
    `<path d="M33 21.5a8 8 0 0 1 8 8 8 8 0 0 1-8 8 8 8 0 0 1-6.6-3.5c1.4-1.6 2-3 2-4.5s-.6-3-2-4.5a8 8 0 0 1 6.6-3.5z" fill="${C.face}" stroke="${C.ink}" stroke-width="2.8" stroke-linejoin="round"/>` +
    `<path d="M41 27.5c2.4.4 3.6 1.6 3.6 3.4s-1.4 3-3.6 3.2z" fill="#5a4a34" stroke="${C.ink}" stroke-width="2.4" stroke-linejoin="round"/>` +
    `<path d="M31.5 20.6c-1.2-2.6-3.4-3.8-6.4-3.4.6 3 2.6 4.6 6 4.8z" fill="${C.face}" stroke="${C.ink}" stroke-width="2.4" stroke-linejoin="round"/>` +
    `<circle cx="36.6" cy="27.4" r="2.4" fill="${C.creamX}"/>` +
    `<circle cx="37.2" cy="27.8" r="1.3" fill="${C.ink}"/>`
  );
})();

/** A three-stalk wheat sheaf, tied at the base. */
const I_WHEAT = (() => {
  // Few, fat kernels: at 20px the dark gaps between them are what says
  // "grain" rather than "gold blob".
  const kern = [
    [19.4, 25, 4.0, 6.8, -34], [28.6, 25, 4.0, 6.8, 34],
    [24.0, 13.5, 3.9, 7.4, 0]
  ];
  const stemD = 'M22 44V17h4v27z';
  const pass = (grow, fill) =>
    `<path d="${stemD}" fill="${fill}" stroke="${fill}" stroke-width="${(grow * 2).toFixed(1)}" stroke-linejoin="round"/>` +
    blobs(kern, grow, fill);
  const g = (rot, body) => `<g transform="rotate(${rot} 24 46)">${body}</g>`;
  const detail =
    blobs(kern.map(k => [k[0], k[1], k[2] * 0.36, k[3] * 0.60, k[4]]), 0, C.wheatL) +
    line('M24 40V20', C.wheatD, 2);
  let out = '';
  for (const r of [-21, 21, 0]) out += g(r, pass(2.2, C.ink));
  for (const r of [-21, 21, 0]) out += g(r, pass(0, C.wheat) + detail);
  out +=
    `<rect x="16" y="35" width="16" height="8" rx="3.4" fill="${C.wood}" stroke="${C.ink}" stroke-width="2.8"/>` +
    `<rect x="17.4" y="36.4" width="13.2" height="2.4" rx="1.2" fill="${C.woodL}" opacity=".7"/>`;
  return out;
})();

/** A cluster of faceted ore stones with a metallic glint. */
const I_ORE = (() => {
  const big = [[5.5, 30], [11, 17.5], [23, 14], [30.5, 24], [25, 38.5], [11, 40]];
  const bigTop = [[11, 17.5], [23, 14], [30.5, 24], [17.5, 27]];
  const right = [[27, 24], [35, 15.5], [44, 22], [42.5, 34], [31.5, 37]];
  const rightTop = [[27, 24], [35, 15.5], [44, 22], [34, 27.5]];
  const front = [[16, 34], [25, 30.5], [32.5, 36], [26, 44], [17, 43]];
  const frontTop = [[16, 34], [25, 30.5], [32.5, 36], [21, 38]];
  return (
    poly(right, '#4a5666') + poly(rightTop, C.oreD) + K(polyPath(right), 2.8) +
    poly(big, C.ore) + poly(bigTop, C.oreL) + K(polyPath(big), 3) +
    line('M17.5 27L11 17.5M17.5 27l7.5 11.2', C.oreD, 1.8) +
    poly(front, C.oreL) + poly(frontTop, C.oreX) + K(polyPath(front), 2.8) +
    `<path d="M38.5 5.5l1.7 4.2 4.2 1.7-4.2 1.7-1.7 4.2-1.7-4.2-4.2-1.7 4.2-1.7z" fill="${C.goldL}" stroke="${C.ink}" stroke-width="1.8" stroke-linejoin="round"/>`
  );
})();

/** A plank road running away from the viewer between stone kerbs. */
const I_ROAD = (() => {
  const outer = [[4.5, 43], [17, 6], [31, 6], [43.5, 43]];
  const surf = [[10, 43], [18.6, 8], [29.4, 8], [38, 43]];
  const lerp = (a, b, t) => a + (b - a) * t;
  let planks = '';
  for (let i = 0; i < 5; i++) {
    const t0 = i / 5, t1 = (i + 0.62) / 5;
    const y0 = lerp(8, 43, t0), y1 = lerp(8, 43, t1);
    const hw0 = lerp(5.4, 14, t0), hw1 = lerp(5.4, 14, t1);
    planks += poly(
      [[24 - hw0, y0], [24 + hw0, y0], [24 + hw1, y1], [24 - hw1, y1]],
      i % 2 ? C.woodL : C.wood);
  }
  return (
    poly(outer, C.stoneD) +
    poly([[4.5, 43], [17, 6], [24, 6], [24, 43]], C.stone) +
    poly(surf, C.woodD) + planks +
    K(polyPath(surf), 2.6) +
    K(polyPath(outer), 3) +
    line('M24 8v35', C.woodD, 1.4)
  );
})();

/** A settler's cottage — pitched player-blue roof, lit walls, warm door. */
const I_HOUSE = (
  `<ellipse cx="24" cy="43" rx="18" ry="3.4" fill="rgba(20,12,4,.28)"/>` +
  `<rect x="31.5" y="10" width="6" height="11" rx="1.6" fill="${C.blueD}" stroke="${C.ink}" stroke-width="2.6"/>` +
  `<rect x="11" y="24" width="26" height="18" rx="1.6" fill="${C.wall}"/>` +
  `<rect x="28" y="24" width="9" height="18" fill="${C.wallD}"/>` +
  poly([[24, 5.5], [43, 24.5], [5, 24.5]], C.blue) +
  poly([[24, 5.5], [43, 24.5], [30, 24.5]], C.blueD) +
  poly([[24, 5.5], [17, 24.5], [5, 24.5]], C.blueL) +
  K(polyPath([[24, 5.5], [43, 24.5], [5, 24.5]]), 3) +
  K('M11 24.5v17.5h26V24.5', 3) +
  `<rect x="19.5" y="30" width="9" height="12" rx="1.4" fill="${C.brown}" stroke="${C.ink}" stroke-width="2.4"/>` +
  `<circle cx="26.4" cy="36.5" r="1.2" fill="${C.gold}"/>` +
  `<rect x="12.8" y="28.5" width="5.2" height="5.2" rx="1" fill="${C.gold}" stroke="${C.ink}" stroke-width="2.1"/>` +
  `<rect x="30" y="28.5" width="5.2" height="5.2" rx="1" fill="${C.goldD}" stroke="${C.ink}" stroke-width="2.1"/>`
);

/** A walled city — twin crenellated towers over a gated keep. */
const I_CASTLE = (
  `<ellipse cx="24" cy="43.5" rx="20" ry="3.2" fill="rgba(20,12,4,.28)"/>` +
  `<path d="M9.5 6.5h7.4l-1.8 2.8 1.8 2.8H9.5z" fill="${C.gold}" stroke="${C.ink}" stroke-width="2"/>` +
  line('M9.5 6v9', C.ink, 2.2) +
  `<path d="M38.5 6.5h-7.4l1.8 2.8-1.8 2.8h7.4z" fill="${C.red}" stroke="${C.ink}" stroke-width="2"/>` +
  line('M38.5 6v9', C.ink, 2.2) +
  // keep
  `<rect x="14" y="26" width="20" height="17" fill="${C.wall}"/>` +
  `<rect x="26" y="26" width="8" height="17" fill="${C.wallD}"/>` +
  merlons(14, 21.5, 20, 4, 5, C.blue) +
  K('M14 26h20v17H14z', 2.8) +
  // towers
  `<rect x="3.5" y="18" width="11.5" height="25" fill="${C.wall}"/>` +
  `<rect x="11" y="18" width="4" height="25" fill="${C.wallD}"/>` +
  merlons(3.5, 13.5, 11.5, 3, 5, C.blue) +
  K('M3.5 18h11.5v25H3.5z', 2.8) +
  `<rect x="33" y="18" width="11.5" height="25" fill="${C.wall}"/>` +
  `<rect x="40" y="18" width="4.5" height="25" fill="${C.wallD}"/>` +
  merlons(33, 13.5, 11.5, 3, 5, C.blue) +
  K('M33 18h11.5v25H33z', 2.8) +
  // gate + windows
  `<path d="M19.5 43V34a4.5 4.5 0 0 1 9 0v9z" fill="${C.brown}" stroke="${C.ink}" stroke-width="2.6"/>` +
  `<rect x="6.6" y="24" width="4.4" height="6" rx="2.2" fill="${C.gold}" stroke="${C.ink}" stroke-width="2"/>` +
  `<rect x="36.2" y="24" width="4.4" height="6" rx="2.2" fill="${C.gold}" stroke="${C.ink}" stroke-width="2"/>`
);

/** Two fanned development cards with a wax seal. */
const I_CARDS = (
  `<g transform="rotate(-14 20 28)">` +
  `<rect x="6" y="11" width="21" height="30" rx="3.4" fill="${C.creamD}" stroke="${C.ink}" stroke-width="3"/>` +
  `<rect x="9.5" y="14.5" width="14" height="23" rx="2" fill="none" stroke="${C.brown}" stroke-width="1.6" opacity=".5"/>` +
  `</g>` +
  `<g transform="rotate(12 30 26)">` +
  `<rect x="19" y="7" width="23" height="32" rx="3.6" fill="${C.creamX}" stroke="${C.ink}" stroke-width="3"/>` +
  `<rect x="22.6" y="10.6" width="15.8" height="24.8" rx="2.2" fill="${C.cream}" stroke="${C.brown}" stroke-width="1.6" opacity=".8"/>` +
  `<circle cx="30.5" cy="21" r="6.2" fill="${C.red}" stroke="${C.ink}" stroke-width="2.4"/>` +
  `<path d="${starPath(5, 4, 1.8, 30.5, 21.2)}" fill="${C.goldL}"/>` +
  `</g>`
);

/** A victory trophy. */
const I_TROPHY = (
  `<path d="M15 6h18v13a9 9 0 0 1-18 0z" fill="${C.gold}"/>` +
  `<path d="M15 6h6.4v21.4a9 9 0 0 1-6.4-8.4z" fill="${C.goldL}" opacity=".7"/>` +
  line('M15 9.4h-5a7 7 0 0 0 6.2 10', C.goldD, 3.6) +
  line('M33 9.4h5a7 7 0 0 1-6.2 10', C.goldD, 3.6) +
  `<rect x="21" y="27.4" width="6" height="7" fill="${C.goldD}"/>` +
  `<path d="M13 42c0-4.2 4-6.6 11-6.6S35 37.8 35 42z" fill="${C.gold}"/>` +
  `<path d="M13 42h22v3.4H13z" fill="${C.goldD}"/>` +
  K('M15 6h18v13a9 9 0 0 1-18 0z', 3) +
  K('M13 42c0-4.2 4-6.6 11-6.6S35 37.8 35 42z', 3) +
  K('M13 42h22v3.6H13z', 3) +
  `<path d="${starPath(5, 4.4, 1.9, 24, 15)}" fill="${C.goldL}"/>`
);

/* -------------------------------------------------------------------- icons */

export const ICONS = {
  /* ---- resources (48 box) ---- */
  log: I_LOG,
  brick: I_BRICK,
  sheep: I_SHEEP,
  wheat: I_WHEAT,
  ore: I_ORE,

  /* ---- pieces (48 box) ---- */
  road: I_ROAD,
  house: I_HOUSE,
  castle: I_CASTLE,
  cards: I_CARDS,
  trophy: I_TROPHY,

  /* ---- chrome (24 box) ---- */
  knight:
    `<path d="M12.6 4.2c2.4-2 5.6-2.6 8-1.4-1.6 1.4-2.2 3-2.2 4.6z" fill="${C.red}"/>` +
    `<path d="M12 2.8c4.2 0 6.7 3 6.7 7.5 0 4.7-2.5 8.2-6.7 10.7C7.8 18.5 5.3 15 5.3 10.3 5.3 5.8 7.8 2.8 12 2.8z" fill="${C.steel}"/>` +
    `<path d="M12 2.8c-4.2 0-6.7 3-6.7 7.5 0 4.7 2.5 8.2 6.7 10.7z" fill="${C.steelL}" opacity=".55"/>` +
    `<rect x="7" y="8.9" width="10" height="2.1" rx="1" fill="${C.night}"/>` +
    `<rect x="7.6" y="12.3" width="8.8" height="1.8" rx=".9" fill="${C.night}"/>` +
    K('M12 2.8c4.2 0 6.7 3 6.7 7.5 0 4.7-2.5 8.2-6.7 10.7C7.8 18.5 5.3 15 5.3 10.3 5.3 5.8 7.8 2.8 12 2.8z', 1.5),

  ship:
    `<rect x="11.2" y="2.8" width="1.6" height="13" rx=".6" fill="${C.woodD}"/>` +
    `<path d="M13.2 3.8c4 1.9 5.6 4.8 5.8 9.4h-5.8z" fill="${C.cream}"/>` +
    `<path d="M10.8 6c-2.9 1.2-4.2 3.6-4.5 7.2h4.5z" fill="${C.creamD}"/>` +
    `<path d="M2.4 15.4h19.2l-2.6 5H5z" fill="${C.wood}"/>` +
    `<path d="M2.4 15.4h19.2l-.7 1.4H3.1z" fill="${C.woodL}"/>` +
    K('M2.4 15.4h19.2l-2.6 5H5z', 1.5) +
    K('M13.2 3.8c4 1.9 5.6 4.8 5.8 9.4h-5.8zM10.8 6c-2.9 1.2-4.2 3.6-4.5 7.2h4.5z', 1.3),

  hammer:
    `<g transform="rotate(-34 12 12)">` +
    `<rect x="4.6" y="3.6" width="11.4" height="5.8" rx="1.5" fill="${C.steel}"/>` +
    `<rect x="4.6" y="3.6" width="11.4" height="2.4" rx="1.2" fill="${C.steelL}"/>` +
    `<rect x="8.6" y="9" width="3" height="11.6" rx="1.3" fill="${C.wood}"/>` +
    `<rect x="8.6" y="9" width="1.2" height="11.6" fill="${C.woodL}" opacity=".6"/>` +
    K('M4.6 6.5a2.9 2.9 0 0 1 2.9-2.9h5.6a2.9 2.9 0 0 1 2.9 2.9 2.9 2.9 0 0 1-2.9 2.9H7.5a2.9 2.9 0 0 1-2.9-2.9z', 1.5) +
    K('M8.6 10.3v9a1.5 1.5 0 0 0 3 0v-9', 1.5) +
    `</g>`,

  gear:
    `<path d="${gearPath(8, 11, 8.1)}" fill="${C.steel}"/>` +
    `<path d="${gearPath(8, 11, 8.1)}" fill="none" stroke="${C.ink}" stroke-width="1.4" stroke-linejoin="round"/>` +
    `<circle cx="12" cy="12" r="4" fill="${C.night}"/>` +
    `<circle cx="12" cy="12" r="4" fill="none" stroke="${C.ink}" stroke-width="1.2"/>`,

  star:
    `<path d="${starPath()}" fill="${C.gold}"/>` +
    `<path d="${starPath()}" fill="none" stroke="${C.ink}" stroke-width="1.4" stroke-linejoin="round"/>`,

  map:
    `<path d="${polyPath([[2.4, 5.4], [9, 3.2], [15, 6], [21.6, 3.6], [21.6, 18.4], [15, 20.8], [9, 18], [2.4, 20.4]])}" fill="${C.cream}"/>` +
    `<path d="${polyPath([[9, 3.2], [15, 6], [15, 20.8], [9, 18]])}" fill="${C.creamD}"/>` +
    `<path d="M12.4 8.2c1.9 0 3.2 1.3 3.2 3.1 0 2.2-3.2 5.5-3.2 5.5s-3.2-3.3-3.2-5.5c0-1.8 1.3-3.1 3.2-3.1z" fill="${C.brick}"/>` +
    `<circle cx="12.4" cy="11.3" r="1.1" fill="${C.cream}"/>` +
    K(polyPath([[2.4, 5.4], [9, 3.2], [15, 6], [21.6, 3.6], [21.6, 18.4], [15, 20.8], [9, 18], [2.4, 20.4]]), 1.5) +
    K('M9 3.4v14.4M15 6v14.6', 1.2),

  pause:
    `<rect x="5.6" y="4" width="4.8" height="16" rx="1.8" fill="${C.cream}" stroke="${C.ink}" stroke-width="1.5"/>` +
    `<rect x="13.6" y="4" width="4.8" height="16" rx="1.8" fill="${C.cream}" stroke="${C.ink}" stroke-width="1.5"/>`,

  close: K('M6 6l12 12M18 6L6 18', 2.6),
  check: K('M4.6 12.8l4.8 4.8L19.4 6.6', 3),

  clock:
    `<circle cx="12" cy="12" r="9" fill="${C.cream}" stroke="${C.ink}" stroke-width="1.6"/>` +
    K('M12 6.4V12l4 2.4', 2),

  restart:
    K('M20 12a8 8 0 1 1-2.6-5.9', 2.4) +
    `<path d="${polyPath([[20.6, 2.4], [21, 8.4], [15.2, 6.6]])}" fill="${C.ink}"/>`,

  sound:
    `<path d="${polyPath([[3, 9], [7.4, 9], [12.4, 4.4], [12.4, 19.6], [7.4, 15], [3, 15]])}" fill="${C.cream}" />` +
    K(polyPath([[3, 9], [7.4, 9], [12.4, 4.4], [12.4, 19.6], [7.4, 15], [3, 15]]), 1.5) +
    K('M15.6 8.6a4.8 4.8 0 0 1 0 6.8M18.6 5.6a9 9 0 0 1 0 12.8', 1.9),

  mute:
    `<path d="${polyPath([[3, 9], [7.4, 9], [12.4, 4.4], [12.4, 19.6], [7.4, 15], [3, 15]])}" fill="${C.cream}" />` +
    K(polyPath([[3, 9], [7.4, 9], [12.4, 4.4], [12.4, 19.6], [7.4, 15], [3, 15]]), 1.5) +
    K('M15.8 9.4l5.4 5.2M21.2 9.4l-5.4 5.2', 2.1),

  help:
    `<circle cx="12" cy="12" r="9" fill="${C.cream}" stroke="${C.ink}" stroke-width="1.6"/>` +
    K('M9.2 9.4a2.9 2.9 0 1 1 3.6 2.9v1.7', 2.1) +
    `<circle cx="12.6" cy="17.4" r="1.4" fill="${C.ink}"/>`,

  swap:
    K('M4.4 8.6h13.2M14.4 5.2l3.6 3.4-3.6 3.4', 2.2) +
    K('M19.6 15.4H6.4M9.6 12l-3.6 3.4 3.6 3.4', 2.2),

  flag:
    `<path d="M6 3.4v17.2" stroke="${C.woodD}" stroke-width="2.2" stroke-linecap="round"/>` +
    `<path d="M7.4 4.2h11.2l-2.6 3.8 2.6 3.8H7.4z" fill="${C.gold}"/>` +
    K('M7.4 4.2h11.2l-2.6 3.8 2.6 3.8H7.4z', 1.4),

  robber:
    `<path d="M12 2.8c3 0 5 2.1 5 5.1 0 1.4-.4 2.4-1 3.3l3.4 2.6c1 .8 1.6 2 1.6 3.3v3.2H3v-3.2c0-1.3.6-2.5 1.6-3.3L8 11.2c-.6-.9-1-1.9-1-3.3 0-3 2-5.1 5-5.1z" fill="${C.night}"/>` +
    `<circle cx="9.8" cy="8" r="1.15" fill="${C.red}"/>` +
    `<circle cx="14.2" cy="8" r="1.15" fill="${C.red}"/>` +
    K('M12 2.8c3 0 5 2.1 5 5.1 0 1.4-.4 2.4-1 3.3l3.4 2.6c1 .8 1.6 2 1.6 3.3v3.2H3v-3.2c0-1.3.6-2.5 1.6-3.3L8 11.2c-.6-.9-1-1.9-1-3.3 0-3 2-5.1 5-5.1z', 1.4),

  anchor:
    `<circle cx="12" cy="4.6" r="2.6" fill="none" stroke="${C.steelL}" stroke-width="2"/>` +
    K('M12 7.4v13M7 11h10M4 14.6c0 3.9 3.6 6.4 8 6.4s8-2.5 8-6.4', 2.1)
};

/** Icons authored on the larger, higher-detail box. */
const VBOX = {
  log: 48, brick: 48, sheep: 48, wheat: 48, ore: 48,
  road: 48, house: 48, castle: 48, cards: 48, trophy: 48
};

/* -------------------------------------------------------------------- API */

export const RES_ICON = {
  wood: 'log', brick: 'brick', wool: 'sheep', wheat: 'wheat', ore: 'ore'
};

export function resIcon(res) { return RES_ICON[res] || 'ore'; }

export function hasIcon(name) { return Object.prototype.hasOwnProperty.call(ICONS, name); }

/** Inline SVG markup for `name` at `size` css px. */
export function icon(name, size = 24, cls = '') {
  const body = ICONS[name];
  if (!body) return '';
  const s = Math.round(size);
  const v = VBOX[name] || 24;
  return `<svg class="svg-ico${cls ? ' ' + cls : ''}" viewBox="0 0 ${v} ${v}" width="${s}" ` +
    `height="${s}" aria-hidden="true" focusable="false">${body}</svg>`;
}

/** A <span> wrapper carrying the icon — handy as a flex child. */
export function iconEl(name, size = 24, cls = '') {
  const span = document.createElement('span');
  span.className = 'ico' + (cls ? ' ' + cls : '');
  span.innerHTML = icon(name, size);
  return span;
}

/** Icon + number, e.g. a cost chip or an inventory slot. */
export function iconCount(name, size, count, cls = '') {
  const span = document.createElement('span');
  span.className = 'ico-count' + (cls ? ' ' + cls : '');
  span.innerHTML = icon(name, size) + `<b>${count}</b>`;
  return span;
}

/**
 * A circular player portrait disc. Procedural: a lit rim in the owner colour,
 * a shaded backdrop and a simple settler bust. Reads at 24–36 css px.
 */
export function avatar(css, light, size = 32) {
  const s = Math.round(size);
  return `<svg class="svg-ico avatar" viewBox="0 0 48 48" width="${s}" height="${s}" ` +
    `aria-hidden="true" focusable="false">` +
    `<circle cx="24" cy="24" r="22" fill="${light}"/>` +
    `<path d="M24 2a22 22 0 0 1 0 44z" fill="${css}"/>` +
    `<path d="M9 44c1.6-9.6 7-14 15-14s13.4 4.4 15 14z" fill="${css}"/>` +
    `<path d="M9 44c1.6-9.6 7-14 15-14v14z" fill="${light}"/>` +
    `<circle cx="24" cy="20" r="11" fill="#f6cf9f"/>` +
    `<path d="M24 9c6 0 10 3.4 10 8.4 0 1.6-.4 3-1.1 4.1-1.5-4-4.6-5.8-8.9-5.8s-7.4 1.8-8.9 5.8c-.7-1.1-1.1-2.5-1.1-4.1C14 12.4 18 9 24 9z" fill="#4a2f16"/>` +
    `<ellipse cx="19.6" cy="21" rx="1.9" ry="2.2" fill="#241505"/>` +
    `<ellipse cx="28.4" cy="21" rx="1.9" ry="2.2" fill="#241505"/>` +
    `<path d="M20.8 26.4c1.8 1.6 4.6 1.6 6.4 0" fill="none" stroke="#a8703f" stroke-width="2" stroke-linecap="round"/>` +
    `<circle cx="24" cy="24" r="20.5" fill="none" stroke="rgba(8,16,28,.9)" stroke-width="4"/>` +
    `<circle cx="24" cy="24" r="17.5" fill="none" stroke="rgba(255,255,255,.30)" stroke-width="1.8"/>` +
    `</svg>`;
}

export default { ICONS, icon, iconEl, iconCount, resIcon, RES_ICON, hasIcon, avatar };
