/**
 * Island Settlers — procedural inline-SVG icon set.
 *
 * Every glyph is drawn here in code: no image files, no icon font, no emoji,
 * no remote asset of any kind. Each icon lives on a 24x24 viewBox, is built
 * from filled shapes with a dark keyline so it reads as a chunky game icon,
 * and stays legible down to 22 css px.
 *
 * Usage:
 *   icon('log', 22)            -> '<svg ...>...</svg>' markup string
 *   iconEl('trophy', 18, 'gold') -> a <span class="ico gold"> wrapping it
 *   resIcon('wood')            -> the icon name for a resource key
 *
 * Owner: UI agent.
 */

/* ------------------------------------------------------------------ palette */
const C = {
  ink:    '#2a1a0c',
  wood:   '#8a5a2b', woodL: '#c69255', woodD: '#6d4520',
  brick:  '#c0562f', brickL: '#e07a4c', brickD: '#9b3f1e',
  wool:   '#f4efe3', woolD: '#c9bda8', face: '#3a3128',
  wheat:  '#e8b53c', wheatD: '#a9801f', leaf: '#6db33f',
  ore:    '#8d97a6', oreL: '#bcc5d2', oreD: '#66707e',
  gold:   '#ffc93c', goldD: '#d99a17', goldL: '#ffe79a',
  cream:  '#f6e7c6', creamD: '#e0cba0', brown: '#5a3a1e',
  steel:  '#aeb8c6', steelL: '#dde4ee', steelD: '#5c6878',
  stone:  '#b9b0a2', stoneD: '#8b8172',
  sea:    '#2f8fd0', night: '#24303e', red: '#d0472f'
};

const K = (d, w = 1.5, cap = 'round') =>
  `<path d="${d}" fill="none" stroke="${C.ink}" stroke-width="${w}" ` +
  `stroke-linejoin="round" stroke-linecap="${cap}"/>`;

/* ----------------------------------------------------- procedural generators */

function polyPath(pts, close = true) {
  let d = `M${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`;
  for (let i = 1; i < pts.length; i++) d += `L${pts[i][0].toFixed(2)} ${pts[i][1].toFixed(2)}`;
  return close ? d + 'Z' : d;
}

/** Cog outline: `teeth` trapezoid teeth swept around a ring. */
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

/** Classic five-point star. */
function starPath(points = 5, rO = 10, rI = 4.4, cx = 12, cy = 12.4) {
  const pts = [];
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 ? rI : rO;
    const a = (Math.PI * i) / points - Math.PI / 2;
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return polyPath(pts);
}

/** A ring of grain kernels climbing a wheat stalk. */
function wheatGrains() {
  let out = '';
  for (let i = 0; i < 4; i++) {
    const y = 15.4 - i * 2.9;
    const w = 1.55 - i * 0.12;
    out +=
      `<ellipse cx="${(9.5 + i * 0.32).toFixed(2)}" cy="${y}" rx="${w.toFixed(2)}" ry="2.5" ` +
      `transform="rotate(30 ${(9.5 + i * 0.32).toFixed(2)} ${y})" fill="${C.wheat}"/>` +
      `<ellipse cx="${(14.5 - i * 0.32).toFixed(2)}" cy="${y}" rx="${w.toFixed(2)}" ry="2.5" ` +
      `transform="rotate(-30 ${(14.5 - i * 0.32).toFixed(2)} ${y})" fill="${C.wheatD}"/>`;
  }
  return out;
}

/** Crenellated parapet used by the city glyph. */
function merlons(x, y, w, n, h, fill) {
  let out = '';
  const step = w / (n * 2 - 1);
  for (let i = 0; i < n; i++) {
    out += `<rect x="${(x + i * step * 2).toFixed(2)}" y="${y}" width="${step.toFixed(2)}" ` +
      `height="${h}" fill="${fill}"/>`;
  }
  return out;
}

/* -------------------------------------------------------------------- icons */

export const ICONS = {

  /* ---- resources ---- */
  log:
    `<rect x="3.4" y="7.4" width="17.2" height="9.2" rx="4.4" fill="${C.wood}"/>` +
    `<path d="M7.4 7.4h12.2a4.4 4.4 0 0 1 0 4.2H7.4z" fill="${C.woodL}" opacity=".55"/>` +
    `<ellipse cx="7.6" cy="12" rx="3.5" ry="4.6" fill="${C.woodL}"/>` +
    `<ellipse cx="7.6" cy="12" rx="2.1" ry="2.9" fill="none" stroke="${C.woodD}" stroke-width="1.1"/>` +
    `<ellipse cx="7.6" cy="12" rx=".8" ry="1.1" fill="${C.woodD}"/>` +
    `<path d="M17.4 8.8c1.5 1.1 1.5 5.3 0 6.4" stroke="${C.woodD}" stroke-width="1.2" fill="none" stroke-linecap="round"/>` +
    K('M3.4 11.8a4.4 4.4 0 0 1 4.4-4.4h9.6a4.6 4.6 0 0 1 0 9.2H7.8a4.4 4.4 0 0 1-4.4-4.4z', 1.5),

  brick:
    `<rect x="2.6" y="13.1" width="8.6" height="5.4" rx="1.1" fill="${C.brick}"/>` +
    `<rect x="2.6" y="13.1" width="8.6" height="2" rx="1" fill="${C.brickL}" opacity=".7"/>` +
    `<rect x="12.8" y="13.1" width="8.6" height="5.4" rx="1.1" fill="${C.brickD}"/>` +
    `<rect x="12.8" y="13.1" width="8.6" height="2" rx="1" fill="${C.brick}" opacity=".8"/>` +
    `<rect x="7.7" y="6.4" width="8.6" height="5.4" rx="1.1" fill="${C.brick}"/>` +
    `<rect x="7.7" y="6.4" width="8.6" height="2" rx="1" fill="${C.brickL}" opacity=".75"/>` +
    K('M2.6 14.2v4.3h8.6v-5.4H2.6zM12.8 13.1h8.6v5.4h-8.6zM7.7 6.4h8.6v5.4H7.7z', 1.4),

  sheep:
    `<ellipse cx="6.4" cy="10.4" rx="2.5" ry="1.6" transform="rotate(-28 6.4 10.4)" fill="${C.woolD}"/>` +
    `<ellipse cx="17.6" cy="10.4" rx="2.5" ry="1.6" transform="rotate(28 17.6 10.4)" fill="${C.woolD}"/>` +
    `<circle cx="7.6" cy="8.4" r="3.5" fill="${C.wool}"/>` +
    `<circle cx="16.4" cy="8.4" r="3.5" fill="${C.wool}"/>` +
    `<circle cx="12" cy="6.6" r="4" fill="${C.wool}"/>` +
    `<path d="M12 9.4c3.1 0 5 2 5 5s-2.1 5.4-5 5.4S7 17.4 7 14.4s1.9-5 5-5z" fill="${C.face}"/>` +
    `<circle cx="10" cy="13.6" r="1.15" fill="${C.wool}"/>` +
    `<circle cx="14" cy="13.6" r="1.15" fill="${C.wool}"/>` +
    `<path d="M10.4 17.2h3.2" stroke="${C.wool}" stroke-width="1.2" stroke-linecap="round"/>` +
    K('M12 9.4c3.1 0 5 2 5 5s-2.1 5.4-5 5.4S7 17.4 7 14.4s1.9-5 5-5z', 1.3),

  wheat:
    `<path d="M12 21.4V8.6" stroke="${C.wheatD}" stroke-width="1.7" stroke-linecap="round"/>` +
    `<path d="M11.6 18.6c-2.4.1-3.8-1-4.3-3 2.3-.5 3.9.5 4.3 3z" fill="${C.leaf}"/>` +
    `<path d="M12.4 17.2c2.3.1 3.7-1 4.2-3-2.3-.5-3.8.5-4.2 3z" fill="${C.leaf}"/>` +
    wheatGrains() +
    `<ellipse cx="12" cy="4.6" rx="1.7" ry="2.9" fill="${C.wheat}"/>` +
    K('M12 21.4V8.6', 1.2) +
    K('M12 1.7c1.7 0 1.7 5.8 0 5.8s-1.7-5.8 0-5.8z', 1.2),

  ore:
    `<path d="${polyPath([[4.6, 13.4], [9.2, 6.4], [15.4, 5.2], [20, 10.6], [17.3, 18], [9.4, 19.4]])}" fill="${C.ore}"/>` +
    `<path d="${polyPath([[9.2, 6.4], [15.4, 5.2], [20, 10.6], [13.4, 12.2]])}" fill="${C.oreL}"/>` +
    `<path d="${polyPath([[4.6, 13.4], [13.4, 12.2], [9.4, 19.4]])}" fill="${C.oreD}"/>` +
    `<path d="M17.6 2.2l.75 1.85 1.85.75-1.85.75-.75 1.85-.75-1.85-1.85-.75 1.85-.75z" fill="${C.goldL}"/>` +
    K(polyPath([[4.6, 13.4], [9.2, 6.4], [15.4, 5.2], [20, 10.6], [17.3, 18], [9.4, 19.4]]), 1.5),

  /* ---- pieces ---- */
  road:
    `<path d="${polyPath([[4.4, 20.6], [9, 3.8], [15, 3.8], [19.6, 20.6]])}" fill="${C.stoneD}"/>` +
    `<path d="${polyPath([[6.6, 20.6], [10.2, 3.8], [15, 3.8], [19.6, 20.6]])}" fill="${C.stone}"/>` +
    `<rect x="11.3" y="4.6" width="1.5" height="3.4" rx=".7" fill="${C.cream}"/>` +
    `<rect x="11.2" y="10" width="1.7" height="3.8" rx=".8" fill="${C.cream}"/>` +
    `<rect x="11" y="16" width="2" height="4.2" rx=".9" fill="${C.cream}"/>` +
    K(polyPath([[4.4, 20.6], [9, 3.8], [15, 3.8], [19.6, 20.6]]), 1.5),

  house:
    `<path d="M12 2.6l9.4 7.4H2.6z" fill="${C.brick}"/>` +
    `<path d="M12 2.6l9.4 7.4h-4.9L12 5.6z" fill="${C.brickD}"/>` +
    `<rect x="5.2" y="10" width="13.6" height="10.6" rx="1.2" fill="${C.cream}"/>` +
    `<rect x="5.2" y="10" width="13.6" height="3" fill="${C.creamD}" opacity=".7"/>` +
    `<path d="M10.1 20.6v-5.4a1.9 1.9 0 0 1 3.8 0v5.4z" fill="${C.brown}"/>` +
    K('M2.6 10L12 2.6 21.4 10', 1.6) +
    K('M5.2 10.2v10.4h13.6V10.2', 1.6),

  castle:
    `<rect x="2.4" y="9" width="5.4" height="11.6" rx=".8" fill="${C.creamD}"/>` +
    `<rect x="16.2" y="9" width="5.4" height="11.6" rx=".8" fill="${C.creamD}"/>` +
    `<rect x="7.2" y="12" width="9.6" height="8.6" rx=".8" fill="${C.cream}"/>` +
    merlons(2.4, 6.4, 5.4, 3, 2.8, C.creamD) +
    merlons(16.2, 6.4, 5.4, 3, 2.8, C.creamD) +
    merlons(7.4, 9.6, 9.2, 4, 2.6, C.cream) +
    `<path d="M9.8 20.6v-4.4a2.2 2.2 0 0 1 4.4 0v4.4z" fill="${C.brown}"/>` +
    `<path d="M2.4 3.4h4.2L5.1 6.4H2.4z" fill="${C.brick}"/>` +
    `<path d="M17.4 3.4h4.2v3h-2.7z" fill="${C.brick}"/>` +
    K('M2.4 9v11.6h19.2V9', 1.5) +
    K('M7.2 12.2v8.4h9.6v-8.4', 1.4),

  knight:
    `<path d="M12.6 4.2c2.4-2 5.6-2.6 8-1.4-1.6 1.4-2.2 3-2.2 4.6z" fill="${C.red}"/>` +
    `<path d="M12 2.8c4.2 0 6.7 3 6.7 7.5 0 4.7-2.5 8.2-6.7 10.7C7.8 18.5 5.3 15 5.3 10.3 5.3 5.8 7.8 2.8 12 2.8z" fill="${C.steel}"/>` +
    `<path d="M12 2.8c-4.2 0-6.7 3-6.7 7.5 0 4.7 2.5 8.2 6.7 10.7z" fill="${C.steelL}" opacity=".55"/>` +
    `<rect x="7" y="8.9" width="10" height="2.1" rx="1" fill="${C.night}"/>` +
    `<rect x="7.6" y="12.3" width="8.8" height="1.8" rx=".9" fill="${C.night}"/>` +
    `<path d="M12 5.6v13" stroke="${C.steelD}" stroke-width="1" opacity=".6"/>` +
    K('M12 2.8c4.2 0 6.7 3 6.7 7.5 0 4.7-2.5 8.2-6.7 10.7C7.8 18.5 5.3 15 5.3 10.3 5.3 5.8 7.8 2.8 12 2.8z', 1.5),

  ship:
    `<rect x="11.2" y="2.8" width="1.6" height="13" rx=".6" fill="${C.woodD}"/>` +
    `<path d="M13.2 3.8c4 1.9 5.6 4.8 5.8 9.4h-5.8z" fill="${C.cream}"/>` +
    `<path d="M10.8 6c-2.9 1.2-4.2 3.6-4.5 7.2h4.5z" fill="${C.creamD}"/>` +
    `<path d="M2.4 15.4h19.2l-2.6 5H5z" fill="${C.wood}"/>` +
    `<path d="M2.4 15.4h19.2l-.7 1.4H3.1z" fill="${C.woodL}"/>` +
    K('M2.4 15.4h19.2l-2.6 5H5z', 1.5) +
    K('M13.2 3.8c4 1.9 5.6 4.8 5.8 9.4h-5.8zM10.8 6c-2.9 1.2-4.2 3.6-4.5 7.2h4.5z', 1.3),

  /* ---- meta ---- */
  trophy:
    `<path d="M7.6 3.2h8.8v6a4.4 4.4 0 0 1-8.8 0z" fill="${C.gold}"/>` +
    `<path d="M7.6 3.2h3.1v10.3a4.4 4.4 0 0 1-3.1-4.3z" fill="${C.goldL}" opacity=".65"/>` +
    `<path d="M7.6 4.4H5.2a3.4 3.4 0 0 0 3 4.9" fill="none" stroke="${C.goldD}" stroke-width="1.7" stroke-linecap="round"/>` +
    `<path d="M16.4 4.4h2.4a3.4 3.4 0 0 1-3 4.9" fill="none" stroke="${C.goldD}" stroke-width="1.7" stroke-linecap="round"/>` +
    `<rect x="10.8" y="13.4" width="2.4" height="3.4" fill="${C.goldD}"/>` +
    `<path d="M7 20.8c0-2 1.9-3.2 5-3.2s5 1.2 5 3.2z" fill="${C.gold}"/>` +
    K('M7.6 3.2h8.8v6a4.4 4.4 0 0 1-8.8 0z', 1.5) +
    K('M7 20.8c0-2 1.9-3.2 5-3.2s5 1.2 5 3.2z', 1.5),

  hammer:
    `<g transform="rotate(-34 12 12)">` +
    `<rect x="4.6" y="3.6" width="11.4" height="5.8" rx="1.5" fill="${C.steel}"/>` +
    `<rect x="4.6" y="3.6" width="11.4" height="2.4" rx="1.2" fill="${C.steelL}"/>` +
    `<rect x="8.6" y="9" width="3" height="11.6" rx="1.3" fill="${C.wood}"/>` +
    `<rect x="8.6" y="9" width="1.2" height="11.6" fill="${C.woodL}" opacity=".6"/>` +
    K('M4.6 6.5a2.9 2.9 0 0 1 2.9-2.9h5.6a2.9 2.9 0 0 1 2.9 2.9 2.9 2.9 0 0 1-2.9 2.9H7.5a2.9 2.9 0 0 1-2.9-2.9z', 1.5) +
    K('M8.6 10.3v9a1.5 1.5 0 0 0 3 0v-9', 1.5) +
    `</g>`,

  cards:
    `<g transform="rotate(-15 9 13)">` +
    `<rect x="3.4" y="6" width="9.6" height="13.4" rx="1.8" fill="${C.creamD}" stroke="${C.ink}" stroke-width="1.4"/>` +
    `</g>` +
    `<g transform="rotate(13 15 12)">` +
    `<rect x="10.6" y="4.6" width="9.8" height="13.6" rx="1.8" fill="${C.cream}" stroke="${C.ink}" stroke-width="1.4"/>` +
    `<circle cx="15.5" cy="11.4" r="2.5" fill="${C.brick}"/>` +
    `<path d="M12.6 6.4h1.6M17 16.4h1.6" stroke="${C.brown}" stroke-width="1.2" stroke-linecap="round"/>` +
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

  /* ---- controls ---- */
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

/* -------------------------------------------------------------------- API */

export const RES_ICON = {
  wood: 'log', brick: 'brick', wool: 'sheep', wheat: 'wheat', ore: 'ore'
};

export function resIcon(res) { return RES_ICON[res] || 'ore'; }

export function hasIcon(name) { return Object.prototype.hasOwnProperty.call(ICONS, name); }

/** Inline SVG markup for `name` at `size` css px. */
export function icon(name, size = 22, cls = '') {
  const body = ICONS[name];
  if (!body) return '';
  const s = Math.round(size);
  return `<svg class="svg-ico${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" width="${s}" ` +
    `height="${s}" aria-hidden="true" focusable="false">${body}</svg>`;
}

/** A <span> wrapper carrying the icon — handy as a flex child. */
export function iconEl(name, size = 22, cls = '') {
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

export default { ICONS, icon, iconEl, iconCount, resIcon, RES_ICON, hasIcon };
