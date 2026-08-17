/**
 * In-match HUD capture and measurement rig.
 *
 * A sibling of tools/uishot.mjs (whose CDP boilerplate this borrows wholesale)
 * and tools/shoot.mjs, pointed at the two surfaces those two never touch: the
 * settings sheet that drops out of the gear, and the centre notices that a card
 * draw puts up.
 *
 *   node tools/hudshot.mjs --stage=settings   [--w=960] [--h=444]
 *   node tools/hudshot.mjs --stage=notice
 *   node tools/hudshot.mjs --stage=vp
 *   node tools/hudshot.mjs --stage=all
 *
 * It MEASURES rather than photographs and hopes. Every screenshot it takes is
 * decoded back into pixels here in node (see `decodePNG`) so the questions that
 * actually matter can be answered with numbers:
 *
 *   - is there a dark plate behind the card notice, and how much darker is it
 *     than the board it is standing on? (WCAG relative luminance, both ways)
 *   - did the victory-point counter in the corner actually MOVE, and by how
 *     many pixels of change?
 *   - does a real press outside the settings sheet close it, and a real press
 *     inside it not?
 *   - does a touch drag that STARTS on a button inside the sheet scroll it
 *     rather than closing it?
 *
 * The scroll gesture is a real one — `Input.synthesizeScrollGesture` with a
 * touch source — because that is the only way to exercise the `touch-action:
 * pan-y` path in ui-base.css. A synthetic wheel would prove nothing.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const arg = (k, d) => {
  const hit = process.argv.find(a => a.startsWith(`--${k}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};

const W = +arg('w', 960);
const H = +arg('h', 444);
const OUT = resolve(ROOT, arg('out', 'progress/tut'));
const PORT = +arg('port', 5173);
const STAGE = arg('stage', 'all');
const PREFIX = arg('prefix', '');
const IPHONE = arg('iphone', '0') === '1';
const CHROME = arg('chrome', '/tmp/chrome-headless-shell-linux64/chrome-headless-shell');
const LIBS = arg('libs', '/tmp/xlibs/root/usr/lib/x86_64-linux-gnu');

mkdirSync(OUT, { recursive: true });
if (!existsSync(CHROME)) { console.error(`no chrome at ${CHROME}`); process.exit(2); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

const DP = 9700 + Math.floor(Math.random() * 500);
const chrome = spawn(CHROME, [
  '--headless', '--no-sandbox', '--disable-dev-shm-usage',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--disable-new-content-rendering-timeout', '--hide-scrollbars', '--mute-audio',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  `--window-size=${W},${H}`, `--remote-debugging-port=${DP}`, 'about:blank'
], {
  env: { ...process.env, LD_LIBRARY_PATH: `${LIBS}:${process.env.LD_LIBRARY_PATH || ''}` },
  stdio: ['ignore', 'ignore', 'pipe']
});
let chromeErr = '';
chrome.stderr.on('data', d => { chromeErr += d.toString(); });

let wsUrl;
for (let i = 0; i < 180; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${DP}/json/list`);
    const p = (await r.json()).find(t => t.type === 'page');
    if (p) { wsUrl = p.webSocketDebuggerUrl; break; }
  } catch { /* not up */ }
  await sleep(180);
}
if (!wsUrl) { console.error('devtools never came up\n' + chromeErr.slice(-500)); process.exit(2); }

const ws = new WebSocket(wsUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));

let msgId = 0;
const pending = new Map();
const exceptions = [];
const warnings = [];
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.id !== undefined) {
    const p = pending.get(m.id);
    if (p) { pending.delete(m.id); p(m.result || { __err: m.error }); }
    return;
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    exceptions.push(d.exception?.description || d.text);
  }
  if (m.method === 'Runtime.consoleAPICalled' && /error|warning/.test(m.params.type)) {
    const t = (m.params.args || []).map(a => a.value ?? a.description ?? '').join(' ');
    if (!/AudioContext/.test(t)) warnings.push(t);
  }
});
const send = (method, params = {}) => new Promise(res => {
  const id = ++msgId;
  pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
  /* Three minutes, not the forty seconds tools/uishot.mjs uses. A single
     SwiftShader capture of this scene was measured here at 6-28 seconds on a
     quiet machine and at 36 seconds on a busy one, and the variance is what
     kills a shorter deadline: a capture that times out is reported as a missing
     element, which sends the next hour chasing a bug in the game. Every check
     below that reads `null` for a rectangle or an image says so out loud rather
     than dividing by it — a rig that crashes on its own timeout tells you even
     less than one that lies. */
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); res({ __err: 'timeout' }); } }, 180000);
});
const ev = async (expr, awaitPromise = false) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
  if (r?.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
  return r?.result?.value;
};

/* ------------------------------------------------------------------ pixels */

/**
 * A minimal PNG reader: 8-bit, non-interlaced, colour types 0/2/4/6, which is
 * everything `Page.captureScreenshot` ever emits. Written out rather than
 * pulled in because this repository has no build step and no dependencies, and
 * a rig that cannot measure its own screenshots is a rig that proves nothing.
 */
function decodePNG(buf) {
  let p = 8, w = 0, h = 0, bd = 0, ct = 0;
  const idat = [];
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bd = data[8]; ct = data[9];
      if (data[12] !== 0) throw new Error('interlaced PNG');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (bd !== 8) throw new Error('bit depth ' + bd);
  const ch = ct === 6 ? 4 : ct === 2 ? 3 : ct === 4 ? 2 : ct === 0 ? 1 : 0;
  if (!ch) throw new Error('colour type ' + ct);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  let ip = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[ip++];
    const line = raw.subarray(ip, ip + stride); ip += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prev ? prev[x] : 0;
      const c = (prev && x >= ch) ? prev[x - ch] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[x] = v & 255;
    }
  }
  return { w, h, ch, data: out };
}

const px = (img, x, y) => {
  const i = (y * img.w + x) * img.ch;
  if (img.ch >= 3) return [img.data[i], img.data[i + 1], img.data[i + 2]];
  return [img.data[i], img.data[i], img.data[i]];
};
/** WCAG relative luminance, 0..1. */
function lum([r, g, b]) {
  const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
const contrast = (a, b) => {
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
};
/** Mean and darkest/brightest luminance over a rectangle of the capture. */
function region(img, x0, y0, x1, y1) {
  x0 = Math.max(0, Math.round(x0)); y0 = Math.max(0, Math.round(y0));
  x1 = Math.min(img.w, Math.round(x1)); y1 = Math.min(img.h, Math.round(y1));
  let sum = 0, n = 0, min = 1, max = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const L = lum(px(img, x, y));
    sum += L; n++;
    if (L < min) min = L;
    if (L > max) max = L;
  }
  return { mean: n ? sum / n : 0, min, max, n };
}
/** Mean colour over a rectangle, per channel. Hue is the question this answers. */
function regionRGB(img, x0, y0, x1, y1) {
  x0 = Math.max(0, Math.round(x0)); y0 = Math.max(0, Math.round(y0));
  x1 = Math.min(img.w, Math.round(x1)); y1 = Math.min(img.h, Math.round(y1));
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const p = px(img, x, y);
    r += p[0]; g += p[1]; b += p[2]; n++;
  }
  return n ? [Math.round(r / n), Math.round(g / n), Math.round(b / n)] : [0, 0, 0];
}
/** Share of pixels that differ between two captures over a rectangle. */
function diffRegion(a, b, x0, y0, x1, y1, thresh = 10) {
  x0 = Math.max(0, Math.round(x0)); y0 = Math.max(0, Math.round(y0));
  x1 = Math.min(a.w, Math.round(x1)); y1 = Math.min(a.h, Math.round(y1));
  let changed = 0, n = 0, worst = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const p1 = px(a, x, y), p2 = px(b, x, y);
    const d = Math.max(Math.abs(p1[0] - p2[0]), Math.abs(p1[1] - p2[1]), Math.abs(p1[2] - p2[2]));
    if (d > worst) worst = d;
    if (d > thresh) changed++;
    n++;
  }
  return { frac: n ? changed / n : 0, worst, n };
}

const shots = [];
/** Capture, write, and hand the decoded pixels back for measuring. */
const shot = async (name, clip) => {
  const file = `${PREFIX}${name}.png`;
  const t0 = Date.now();
  const p = { format: 'png' };
  if (clip) p.clip = { ...clip, scale: 1 };
  const r = await send('Page.captureScreenshot', p);
  if (!r?.data) { console.log(`  shot ${file} FAILED`); return null; }
  const buf = Buffer.from(r.data, 'base64');
  writeFileSync(resolve(OUT, file), buf);
  shots.push(`progress/tut/${file}`);
  console.log(`  shot ${file} (${(buf.length / 1024).toFixed(0)} KB, ${Date.now() - t0}ms)`);
  try { return decodePNG(buf); } catch (e) { console.log('  decode failed: ' + e.message); return null; }
};
/** Capture WITHOUT writing a file — for the animation frame-diffing. */
const grab = async clip => {
  const p = { format: 'png' };
  if (clip) p.clip = { ...clip, scale: 1 };
  const r = await send('Page.captureScreenshot', p);
  if (!r?.data) return null;
  try { return decodePNG(Buffer.from(r.data, 'base64')); } catch { return null; }
};

/* ------------------------------------------------------------- freezing --
 *
 * MEASURED, AND THE REASON EVERYTHING BELOW LOOKS LIKE THIS.
 *
 * A SwiftShader capture of this scene costs 6-11 SECONDS and the page runs at
 * about 4fps while it is happening. Every animation this rig exists to
 * photograph is under three seconds long, so a naive `trigger(); sleep(600);
 * shot()` photographs the empty screen AFTERWARDS — which is exactly what the
 * first baseline run of this file did, and the "missing" notice in it was the
 * rig's fault rather than the game's.
 *
 * So a transient is held still before it is photographed, in three steps that
 * each undo cleanly:
 *
 *   setTimeout   stubbed so that LONG timers never land. `replay()` in
 *                ui/dom.js takes a celebration class back off with one of
 *                these, and a class removed halfway through a capture is a
 *                blank photograph. Short timers (under 60ms) are next-tick
 *                plumbing — the standing chips use them to add their `on`
 *                class — and still fire, so the screen stays honest.
 *   rAF          queued rather than run, which halts main.js's loop after the
 *                frame in flight. Restoring it replays the queue, so the match
 *                carries on from where it stopped rather than dying.
 *   animations   paused, and then SEEKED to a chosen offset. That is what makes
 *                the frames below deterministic: "the counter at 180ms into the
 *                burst" is a thing this rig can ask for exactly, rather than a
 *                thing it hopes to catch.
 */
const FREEZE_TIMERS = `(()=>{const w=window;
  if(w.__FRZ) return 'already';
  w.__FRZ={raf:w.requestAnimationFrame.bind(w),st:w.setTimeout.bind(w),q:[],rafOff:false};
  w.setTimeout=(fn,d,...a)=>w.__FRZ.st(fn,(d|0)<60?d:36e5,...a);
  return 'timers frozen';})()`;

const HALT_FRAMES = `(()=>{const w=window; if(!w.__FRZ) return 'not frozen';
  if(w.__FRZ.rafOff) return 'already';
  w.__FRZ.rafOff=true;
  w.requestAnimationFrame=cb=>{w.__FRZ.q.push(cb);return 0};
  return 'frames halted';})()`;

const THAW = `(()=>{const w=window; if(!w.__FRZ) return 'not frozen';
  const f=w.__FRZ; w.__FRZ=null;
  w.setTimeout=f.st;
  if(f.rafOff) w.requestAnimationFrame=f.raf;
  for(const a of document.getAnimations()){try{a.play()}catch(e){}}
  const q=f.q.slice(); for(const cb of q){try{f.raf(cb)}catch(e){}}
  return 'thawed';})()`;

/** Pause every animation on the page; seek the ones under `sel` to `ms`. */
const seek = async (sel, ms) => ev(`(()=>{
  const root=${sel ? `document.querySelector(${JSON.stringify(sel)})` : 'null'};
  const out=[];
  for(const a of document.getAnimations()){
    let t=null; try{t=a.effect&&a.effect.target}catch(e){}
    try{a.pause()}catch(e){}
    if(!root||!t||!(root===t||root.contains(t))) continue;
    try{a.currentTime=${ms}}catch(e){}
    let dur=0; try{dur=a.effect.getTiming().duration}catch(e){}
    out.push({name:a.animationName||'?',pseudo:(a.effect&&a.effect.pseudoElement)||'',
      dur:dur,on:(t.className&&t.className.baseVal!==undefined?t.className.baseVal:t.className)||t.tagName});
  }
  return out;})()`);

/* ------------------------------------------------------------------ input */

/** A real press: pointerdown, pointerup and the click that follows. */
const tap = async (x, y) => {
  const base = { x, y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' };
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...base, buttons: 0 });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
  await sleep(40);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 });
  await sleep(160);
};

/**
 * A REAL FINGER, DRAGGING.
 *
 * Raw `Input.dispatchTouchEvent` rather than `Input.synthesizeScrollGesture`,
 * measured: the synthesized gesture does nothing at all in headless-shell (it
 * returns success and moves no scroller, with or without touch emulation, on a
 * page with no touch-action rules on it whatsoever), while a hand-rolled
 * touchStart / touchMove* / touchEnd scrolls a `touch-action: pan-y` panel
 * exactly the way a thumb does.
 *
 * That distinction matters here beyond rig plumbing, because this is the ONLY
 * way to exercise the block at the foot of ui-base.css. The same probe confirmed
 * the thing that block depends on and that nothing in the repository had
 * checked: `.pop { touch-action: pan-y }` still pans even though `html`, `body`
 * and `#app` above it are all `touch-action: none`. A scroll container resets
 * the panning bits it needs; the ancestors do not veto it.
 *
 * The finger travels UP the screen, which is what scrolls a panel DOWN.
 */
const touchDrag = async (x, y, dist) => {
  const pt = y => [{ x, y, id: 1, radiusX: 8, radiusY: 8, force: 1 }];
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(y) });
  for (let d = 6; d <= dist; d += 8) {
    await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(y - d) });
    await sleep(16);
  }
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(450);
};

/* ------------------------------------------------------------------- boot */

await send('Page.enable'); await send('Runtime.enable');
/* On Windows `--window-size` includes browser chrome. Emulate the requested
   content viewport directly so phone captures are not accidentally 223px tall. */
await send('Emulation.setDeviceMetricsOverride', {
  width: W, height: H, deviceScaleFactor: 1, mobile: true
});
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });

let booted = false;
for (let i = 0; i < 60; i++) {
  if (await ev('!!(window.__ISLAND__&&window.__ISLAND__.state)') === true) { booted = true; break; }
  await sleep(300);
}
if (!booted) { console.error('GAME DID NOT BOOT\n' + chromeErr.slice(-400)); ws.close(); chrome.kill('SIGKILL'); process.exit(1); }
console.log(`booted ${W}x${H}`);

/* Exercise the exact iPhone-only HUD branch without depending on the host
   browser's user-agent string. */
if (IPHONE) await ev(`(()=>{document.documentElement.classList.add('apple-phone');
  dispatchEvent(new Event('resize'));return true})()`);

await ev(`import('/src/core/rules.js').then(m=>{window.__R__=m}).then(()=>1)`, true);

/** Run the opening draft out so the match is in `play` and the HUD is live. */
const finishDraft = async () => ev(`(()=>{const {state}=window.__ISLAND__,R=window.__R__;
  if(!R) return 'no rules';
  let g=0;
  while(state.phase==='setup'&&g++<40){
    const pid=R.setupCurrentPlayer(state);
    if(state.setupNeed==='settlement'){
      const L=R.legalSettlements(state,pid,true);
      R.setupPlaceSettlement(state,pid,L[Math.floor(L.length*0.37)]||L[0]);
    } else {
      const L=R.legalRoads(state,pid,true,state.setupAnchor);
      R.setupPlaceRoad(state,pid,L[0]);
    }
  }
  return state.phase;})()`);

await finishDraft();
await sleep(2200);
/* Stand the settler still. Every measurement below compares two captures of the
   same corner, and a running avatar under a translucent plate is noise. */
await ev(`(()=>{const{state,game}=window.__ISLAND__;const p=state.players[0];
  p.vx=0;p.vz=0;p.action='idle';
  try{game.input && game.input.setEnabled && game.input.setEnabled(false)}catch(e){}
  return 1})()`);
await sleep(400);

/** Rect of the first match for a selector, in CSS pixels. */
const rect = async sel => ev(`(()=>{const n=document.querySelector(${JSON.stringify(sel)});
  if(!n) return null; const r=n.getBoundingClientRect();
  return {x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom};})()`);

const overlaps = (a, b) => !!(a && b
  && a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom);

const fails = [];
const ok = (label, pass, detail) => {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!pass) fails.push(label + (detail ? ' ' + detail : ''));
};

/* ================================================================ settings */

async function stageSettings() {
  console.log('\n--- settings sheet ---');
  await ev(`window.__ISLAND__.game.hud.openSettings&&0`);
  // Closed first, so the "before" shot is honest.
  await ev(`(()=>{const s=document.querySelector('.pop.settings');
    if(s&&!s.classList.contains('hid')){document.querySelector('.hud-tl .cbtn').click()}return 1})()`);
  await sleep(300);
  const closedImg = await shot('hud-settings-closed');

  const gear = await rect('.hud-tl .tl-row .cbtn');
  if (!gear) { ok('gear button exists', false); return; }
  if (IPHONE) {
    const awards = await rect('.hud-bl .scorecard');
    ok('iPhone settings button is in the top-left corner',
      gear.x < W / 3 && gear.y < H / 3,
      `gear ${Math.round(gear.x)},${Math.round(gear.y)}`);
    ok('iPhone road and army counter is in the bottom-left corner',
      !!awards && awards.x < W / 3 && awards.bottom > H * 2 / 3,
      awards ? `awards ${Math.round(awards.x)},${Math.round(awards.y)}` : 'missing');
  }
  await tap(gear.x + gear.w / 2, gear.y + gear.h / 2);
  await sleep(360);

  const openImg = await shot('hud-settings-open');
  const pop = await rect('.pop.settings');
  ok('settings sheet is open', !!pop && !(await ev(`document.querySelector('.pop.settings').classList.contains('hid')`)),
    pop ? `rect ${Math.round(pop.x)},${Math.round(pop.y)} ${Math.round(pop.w)}x${Math.round(pop.h)}` : 'missing');

  /* The owner: "I don't need the word Settings at the top of it, or the extra
     x button." Both are counted, not eyeballed. */
  const head = await ev(`document.querySelectorAll('.pop.settings .pop-head').length`);
  const title = await ev(`document.querySelectorAll('.pop.settings .pop-title').length`);
  const xbtn = await ev(`document.querySelectorAll('.pop.settings .cbtn.x, .pop.settings [aria-label="Close"]').length`);
  const saysSettings = await ev(`/settings/i.test(document.querySelector('.pop.settings').textContent||'')`);
  ok('no .pop-head row in the sheet', head === 0, `count=${head}`);
  ok('no .pop-title in the sheet', title === 0, `count=${title}`);
  ok('no close (x) button in the sheet', xbtn === 0, `count=${xbtn}`);
  ok('the word "Settings" is gone from the sheet', saysSettings === false, `textMatch=${saysSettings}`);

  /* "Just turn the settings icon/button into an x button while the settings
      are open." The gear publishes what it is currently wearing. */
  const icoOpen = await ev(`document.querySelector('.hud-tl .tl-row .cbtn').getAttribute('data-ico')`);
  const gearOn = await ev(`document.querySelector('.hud-tl .tl-row .cbtn').classList.contains('on')`);
  const label = await ev(`document.querySelector('.hud-tl .tl-row .cbtn').getAttribute('aria-label')`);
  ok('gear wears the x glyph while open', icoOpen === 'close', `data-ico=${icoOpen} on=${gearOn} aria="${label}"`);

  // And the glyph is a genuinely different drawing, not the same one relabelled.
  const glyphOpen = await ev(`document.querySelector('.hud-tl .tl-row .cbtn .cb-ico').innerHTML.length`);

  /* ------------------------------------------------ CAN THE CROSS BE SEEN?
   *
   *   "THE CLOSE (X) GLYPH IS ILLEGIBLE. The cross strokes are dark brown
   *    rgb(42,26,12) on a navy button fill rgb(34,66,101) — contrast 1.63:1...
   *    The button looks EMPTY at a glance."
   *
   * Measured the way the complaint was measured, in the pixels of the shot that
   * was complained about. The cross is the BRIGHTEST thing inside the button
   * now, so its stroke is the maximum over the button's middle; the fill is
   * sampled at four points that sit in the gaps BETWEEN the arms of the X —
   * north, south, east and west of the centre, where a cross never reaches. */
  if (openImg && gear) {
    const cx = gear.x + gear.w / 2, cy = gear.y + gear.h / 2;
    const inner = region(openImg, cx - gear.w * 0.28, cy - gear.h * 0.28,
      cx + gear.w * 0.28, cy + gear.h * 0.28);
    const off = gear.w * 0.30, pad = Math.max(2, gear.w * 0.06);
    const gaps = [[0, -off], [0, off], [-off, 0], [off, 0]]
      .map(([dx, dy]) => region(openImg, cx + dx - pad, cy + dy - pad,
        cx + dx + pad, cy + dy + pad));
    const fill = gaps.reduce((s, g) => s + g.mean, 0) / gaps.length;
    const cGlyph = contrast(inner.max, fill);
    ok('the close cross clears 4.5:1 against the button fill it is drawn on',
      cGlyph >= 4.5,
      `glyph L=${inner.max.toFixed(4)} fill L=${fill.toFixed(4)} -> ${cGlyph.toFixed(2)}:1`);
    // ...and it is genuinely LIGHT, not a dark glyph that happens to beat a
    // darker fill: the gear it replaces is cream, and this has to match it.
    ok('...and the cross is the light object on the button, like the gear',
      inner.max > fill, `max ${inner.max.toFixed(4)} vs fill ${fill.toFixed(4)}`);

    /* "Make the button fill opaque on phone." Asked directly rather than
       inferred from a colour: photograph the middle of the button, take the 3D
       canvas away underneath it, photograph it again. One pixel of change is a
       boat mast showing through. */
    const box = {
      x: Math.round(cx - gear.w * 0.26), y: Math.round(cy - gear.h * 0.26),
      width: Math.round(gear.w * 0.52), height: Math.round(gear.h * 0.52)
    };
    const withWorld = await grab(box);
    await ev(`(()=>{const c=document.querySelector('canvas');
      if(c)c.style.visibility='hidden';return 1})()`);
    await sleep(140);
    const without = await grab(box);
    await ev(`(()=>{const c=document.querySelector('canvas');
      if(c)c.style.visibility='';return 1})()`);
    if (withWorld && without) {
      const d = diffRegion(withWorld, without, 0, 0, box.width, box.height, 1);
      ok('the gear button fill is opaque — no board reads through it',
        d.worst <= 1,
        `${(d.frac * 100).toFixed(2)}% of the button middle changed when the 3D `
        + `canvas was hidden behind it (max channel delta ${d.worst})`);
    } else ok('captured the button fill', false);
  }

  /* The popup is a centred modal card now. It may cover readouts and build
     cards while open; the important geometry is equal room on either side and
     a full phone-safe viewport around it. */
  ok('the settings sheet is centred in the phone viewport',
    !!pop && Math.abs((pop.x + pop.w / 2) - W / 2) <= 1
      && Math.abs((pop.y + pop.h / 2) - H / 2) <= 1,
    pop ? `centre ${Math.round(pop.x + pop.w / 2)},${Math.round(pop.y + pop.h / 2)}` : 'missing');
  ok('the complete settings sheet fits inside the viewport',
    !!pop && pop.x >= 0 && pop.y >= 0 && pop.right <= W && pop.bottom <= H,
    pop ? `edges ${Math.round(pop.x)},${Math.round(pop.y)}..${Math.round(pop.right)},${Math.round(pop.bottom)}` : 'missing');

  /* --- a press INSIDE must not close it ---------------------------------- */
  const inside = await rect('.pop.settings .side-row .side-lab');
  if (inside) {
    await tap(inside.x + inside.w / 2, inside.y + inside.h / 2);
    await sleep(280);
    const stillOpen = await ev(`!document.querySelector('.pop.settings').classList.contains('hid')`);
    ok('a real press INSIDE the sheet leaves it open', stillOpen === true);
  } else ok('found a target inside the sheet', false);

  /* The new four-band layout has no scrolling and therefore no edge fade. */
  const layout = await ev(`(()=>{const p=document.querySelector('.pop.settings');
    const rows=[...p.children].map(n=>{const r=n.getBoundingClientRect();return {
      text:(n.textContent||'').trim(),x:r.x,y:r.y,w:r.width,h:r.height};});
    const cs=getComputedStyle(p);return {rows,sh:p.scrollHeight,ch:p.clientHeight,
      above:p.classList.contains('sc-above'),below:p.classList.contains('sc-below'),
      mask:(cs.maskImage||cs.webkitMaskImage||'none')};})()`);
  ok('the settings sheet uses four horizontal bands', layout.rows.length === 4,
    `rows=${layout.rows.length}`);
  ok('buttons and graphics share the first line',
    /buttons/i.test(layout.rows[0]?.text || '') && /graphics/i.test(layout.rows[0]?.text || ''));
  ok('sound effects and ocean share the second line',
    /sound effects/i.test(layout.rows[1]?.text || '') && /ocean/i.test(layout.rows[1]?.text || ''));
  ok('How to Play is the full-width third line',
    /how to play/i.test(layout.rows[2]?.text || '') && Math.abs(layout.rows[2].w - (pop.w - 18)) <= 2);
  ok('Leave Match is the full-width last line',
    /leave match/i.test(layout.rows[3]?.text || '') && Math.abs(layout.rows[3].w - (pop.w - 18)) <= 2);
  ok('the complete sheet needs no scrolling', layout.sh === layout.ch,
    `scrollHeight=${layout.sh} clientHeight=${layout.ch}`);
  ok('a non-scrolling sheet has no fade mask', !layout.above && !layout.below && layout.mask === 'none',
    `above=${layout.above} below=${layout.below} mask=${layout.mask}`);

  /* --- a press OUTSIDE must close it, and must not eat the world tap ------ */
  const before = await ev(`(()=>{const s=window.__ISLAND__.state;return {t:s.time};})()`);
  const outX = W - 12, outY = H - 12;
  const overUI = await ev(`(()=>{const h=document.elementFromPoint(${outX},${outY});
    return h? (h.id||h.className||h.tagName) : 'none';})()`);
  await tap(outX, outY);
  await sleep(300);
  const closed = await ev(`document.querySelector('.pop.settings').classList.contains('hid')`);
  ok('a real press OUTSIDE the sheet closes it', closed === true, `tapped ${outX},${outY} over "${overUI}"`);
  const icoClosed = await ev(`document.querySelector('.hud-tl .tl-row .cbtn').getAttribute('data-ico')`);
  ok('the gear goes back to a gear when it closes', icoClosed === 'gear', `data-ico=${icoClosed}`);
  const glyphClosed = await ev(`document.querySelector('.hud-tl .tl-row .cbtn .cb-ico').innerHTML.length`);
  ok('the two glyphs are different drawings', glyphOpen !== glyphClosed,
    `open=${glyphOpen} bytes, closed=${glyphClosed} bytes`);

  /* The outside press must not have been swallowed: the joystick layer still
     saw it. `preventDefault` is fine, `stopPropagation` would not be. */
  const sawIt = await ev(`(()=>{const g=window.__ISLAND__.game;
    return !!(g.input && typeof g.input.frame === 'number');})()`);
  ok('the world layer is still receiving pointers', sawIt === true);

  await shot('hud-settings-after-outside-tap');
  await sleep(60);
  void before;
}

/* ================================================================= notices */

/**
 * Draw one specific card through the REAL purchase path.
 *
 * `drawCard` picks its type off `state.rng`, so pinning the generator is enough
 * to choose: the weights are knight .5, roadBuilding .3, victoryPoint .2, in
 * that order, and the roll walks them in order.
 */
const ROLL = { knight: 0.10, roadBuilding: 0.62, victoryPoint: 0.995 };

const drawCard = async kind => ev(`(()=>{const{state,game}=window.__ISLAND__;
  const me=state.players[0];
  me.res={wood:9,brick:9,wool:9,wheat:9,ore:9};
  const old=state.rng; state.rng=()=>${ROLL[kind]};
  const okd=game.hud.requestBuild('card');
  state.rng=old;
  return {ok:okd,cards:me.cards.map(c=>c.type),vpCards:me.vpCards};})()`);

/** Wait for a specific line to actually be up. Polling is free; captures are not. */
async function waitForNotice(text, ms = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const s = await ev(`(()=>{const w=document.querySelector('.announce');
      const t=document.querySelector('.ann-txt');
      return {cls:w?w.className:'',txt:t?t.textContent:''};})()`);
    if (s && s.txt === text && /\bshow\b/.test(s.cls)) return true;
    await sleep(150);
  }
  return false;
}

/**
 * Photograph one notice and measure the box behind it.
 *
 * `wantGlyph` is true for Road Building now, and that is the interesting one:
 * hud-road.js is owned by somebody else this week and has NOT been edited, so
 * that notice still arrives through the two-argument `announce` every other
 * caller in the game uses. The glyph it wears is worked out from its own words
 * by `glyphFor` in hud-notice.js — so what this measures is the fix to
 *
 *   "hud-notice-road.png HAS NO ICON... Road Building is text only, so it
 *    visibly does not belong to the same family"
 *
 * landing in a file the fix could not be written in.
 */
async function noticeShot(name, text, wantGlyph, trigger) {
  await ev(FREEZE_TIMERS);
  await trigger();
  const up = await waitForNotice(text);
  ok(`"${text}" reaches the centre of the screen`, up === true);
  // Hold the page and park the banner at 700ms into its 2600ms animation —
  // fully open, well before it starts to leave. Without this the capture, which
  // costs 6-17 seconds under SwiftShader, lands long after the notice has gone.
  await ev(HALT_FRAMES);
  const anims = await seek('.announce', 700);
  console.log('  held: ' + JSON.stringify(anims));

  const img = await shot(name);
  /* `.ann-card` is the plate. Falling back to `.ann-txt` is what lets this same
     measurement be run against the PREVIOUS build (git stash the three source
     files, `--prefix=base-`), where there was no plate and the notice was the
     lettering and its padding and nothing else. The bands sampled below then
     land in that padding, which is exactly the board the owner was complaining
     about reading through. */
  const box = (await rect('.announce .ann-card')) || (await rect('.announce .ann-txt'));
  const txt = await rect('.announce .ann-txt');
  const glyph = await rect('.announce .ann-ico:not(.hid)');
  const alpha = await ev(`(()=>{const c=document.querySelector('.ann-card')
      ||document.querySelector('.ann-txt');
    if(!c) return null;
    const cs=getComputedStyle(c);
    const bg=(cs.backgroundImage==='none'?cs.backgroundColor:cs.backgroundImage)||'';
    const a=[...bg.matchAll(/rgba?\\(([^)]*)\\)/g)]
      .map(m=>m[1].split(',').map(s=>parseFloat(s)))
      .map(p=>p.length>3?p[3]:1);
    return a.length?Math.min(...a):null;})()`);
  /* The page stays frozen through every measurement below — the read-through
     probe at the foot of this function takes two more captures of the SAME
     notice with the scene swapped out underneath it, and a thawed banner would
     have faded out somewhere between them. THAW is the last thing that runs. */
  if (!img || !box) { await ev(THAW); ok(`${name} notice on screen`, false); return null; }
  ok(`${name}: the notice is on screen`, box.w > 40 && box.h > 20,
    `plate ${Math.round(box.w)}x${Math.round(box.h)} at ${Math.round(box.x)},${Math.round(box.y)}`);
  ok(`${name}: ${wantGlyph ? 'carries the card glyph' : 'has no glyph (unedited caller)'}`,
    wantGlyph ? (!!glyph && glyph.w > 10) : !glyph,
    glyph ? `${Math.round(glyph.w)}x${Math.round(glyph.h)}` : 'none');

  /* THE MEASUREMENT THE OWNER ASKED FOR: is there a dark box behind it?
     Sample the plate inside its own edge, below the inset top highlight and
     clear of both the lettering and the gold disc, then the board immediately
     outside it on both sides. */
  const padY = Math.min(7, box.h * 0.16);
  const plateT = region(img, box.x + 9, box.y + 6, box.right - 9, box.y + 10);
  const plateB = region(img, box.x + 9, box.bottom - 9, box.right - 9, box.bottom - 5);
  const plate = (plateT.mean + plateB.mean) / 2;
  const outL = region(img, Math.max(0, box.x - 70), box.y + padY, Math.max(1, box.x - 10), box.bottom - padY);
  const outR = region(img, Math.min(img.w - 1, box.right + 10), box.y + padY, Math.min(img.w, box.right + 70), box.bottom - padY);
  const board = (outL.mean + outR.mean) / 2;
  /* The ratio of LINEAR luminances, not the WCAG contrast, because the board is
     the variable here. A WCAG figure against a hex that happens to be a dark
     mountain flatters a bad plate and punishes a good one — the same notice
     measured 5.97:1 over sand and 2.96:1 over ore on two runs of this rig, with
     the plate identical to four decimal places both times. "How many times
     darker than what is behind it" does not move: this plate comes out 13-24x,
     where the previous build's lettering-and-nothing came out 1.5x. */
  ok(`${name}: sits on a plate far darker than the board behind it`,
    plate < board * 0.25 && plate < 0.03,
    `plate L=${plate.toFixed(4)}  board L=${board.toFixed(4)}  `
    + `${(board / Math.max(plate, 1e-6)).toFixed(1)}x darker (WCAG ${contrast(board, plate).toFixed(2)}:1)`);

  // ...and the lettering against that plate. `max` is the brightest pixel of a
  // gold glyph on a dark field, which is what the eye actually reads.
  const ink = region(img, txt.x + 2, txt.y + txt.h * 0.25, txt.right - 2, txt.bottom - txt.h * 0.2);
  const cText = contrast(ink.max, plate);
  ok(`${name}: lettering clears 4.5:1 against its own plate`,
    cText >= 4.5, `${cText.toFixed(2)}:1`);

  /* The pixels above are one board in one lighting condition. The plate's own
     opacity is the reason they will hold over any other. */
  ok(`${name}: the plate is opaque enough that no board can read through it`,
    typeof alpha === 'number' && alpha >= 1, `weakest gradient stop alpha=${alpha}`);

  /* AND NOT ONE CHANNEL OF IT.
   *
   *   "The harbour 'x5 x9' label faintly shows through the lower centre of all
   *    three notice pills (channel delta 2-6); make the pill fully opaque or
   *    raise it above that label in z-order."
   *
   * Six parts in 255 is below what a stated alpha will tell you and above what
   * the eye will let go of once it has found it, so it is asked in pixels: the
   * plate, then the plate with the entire 3D scene taken away underneath it.
   * Sampled inside the border so the anti-aliased rim is not counted. */
  const inner = {
    x: Math.round(box.x + 3), y: Math.round(box.y + 3),
    width: Math.round(box.w - 6), height: Math.round(box.h - 6)
  };
  const withWorld = await grab(inner);
  await ev(`(()=>{const c=document.querySelector('canvas');
    if(c)c.style.visibility='hidden';return 1})()`);
  await sleep(140);
  const noWorld = await grab(inner);
  await ev(`(()=>{const c=document.querySelector('canvas');
    if(c)c.style.visibility='';return 1})()`);
  if (withWorld && noWorld) {
    const d = diffRegion(withWorld, noWorld, 0, 0, inner.width, inner.height, 1);
    ok(`${name}: nothing at all reads through the plate`, d.worst <= 1,
      `${(d.frac * 100).toFixed(2)}% of the plate changed with the 3D scene `
      + `hidden behind it (max channel delta ${d.worst})`);
  } else ok(`${name}: captured the plate over and without the world`, false);
  await ev(THAW);
  return { box, plate, board };
}

/** Put the island back the way it was between notices. */
const resetCards = async () => {
  await ev(`(()=>{const{state,game}=window.__ISLAND__;
    try{game.closeOverview&&game.closeOverview()}catch(e){}
    const me=state.players[0];me.cards=[];me.freeRoads=0;
    const n=document.querySelector('.announce');if(n)n.classList.remove('show');
    const t=document.querySelector('.ann-txt');if(t)t.textContent='';
    return 1})()`);
  await sleep(900);
};

async function stageNotice() {
  console.log('\n--- card notices ---');

  /* One convention across all three: what you just got, exclaimed. Two of the
     three strings live in files this agent may not edit ('Road Building!' in
     hud-road.js, '+1 Victory Point!' in systems/economy.js), so the odd one out
     was hud-knight.js's 'Knight Card!' and it is the one that moved. */
  const knightBox = await noticeShot('hud-notice-knight', 'Knight!', true,
    () => drawCard('knight'));
  // The Knight raises the board by itself a beat later; put it away again so
  // the next notice is measured over the island rather than over a map.
  await resetCards();

  /* ROAD BUILDING, THROUGH THE UNEDITED FILE. hud-road.js calls
     `g.hud.announce(msg, colour)` with two arguments and has not been touched;
     this is what the owner will see today, glyph and all. */
  const roadBox = await noticeShot('hud-notice-road', 'Road Building!', true,
    () => drawCard('roadBuilding'));
  await resetCards();

  const vpBox = await noticeShot('hud-notice-vp', '+1 Victory Point!', true,
    () => drawCard('victoryPoint'));
  await resetCards();

  /* THE THREE PLATES ARE ONE FAMILY. The complaint was that Road Building
     "visibly does not belong", so the badge is compared rather than asserted
     one notice at a time: same size, same left padding, to the pixel. */
  const badges = await ev(`(()=>{const out={};
    for(const t of ['Knight!','Road Building!','+1 Victory Point!']){
      window.__ISLAND__.game.hud.announce(t,'#ffc93c');
      const i=document.querySelector('.ann-ico:not(.hid)');
      const c=document.querySelector('.ann-card');
      if(!i||!c){out[t]=null;continue}
      const ir=i.getBoundingClientRect(),cr=c.getBoundingClientRect();
      out[t]={w:Math.round(ir.width),h:Math.round(ir.height),
        left:Math.round(ir.x-cr.x),svg:!!i.querySelector('svg')};
    }
    const n=document.querySelector('.announce');if(n)n.classList.remove('show');
    return out;})()`);
  const list = Object.values(badges || {});
  ok('all three notices carry a glyph badge',
    list.length === 3 && list.every(b => b && b.svg && b.w > 10),
    JSON.stringify(badges));
  ok('...the same size and the same distance from the left edge, all three',
    list.length === 3 && list.every(b => b && b.w === list[0].w && b.h === list[0].h
      && b.left === list[0].left),
    list.map(b => b ? `${b.w}x${b.h}@${b.left}` : 'none').join('  '));

  /* THE ONLINE VICTORY POINT, WHICH IS SOMEBODY ELSE'S CALL SITE.
     systems/economy.js:259 announces '+1 Victory Point!' with TWO arguments on
     the networked path and may not be edited. It gets the trophy for the same
     reason Road Building gets the road: the glyph is read off the words. */
  const online = await ev(`(()=>{
    window.__ISLAND__.game.hud.announce('+1 Victory Point!','#ffc93c');
    const i=document.querySelector('.ann-ico:not(.hid)');
    const svg=i&&i.innerHTML||'';
    const n=document.querySelector('.announce');if(n)n.classList.remove('show');
    return {shown:!!i,bytes:svg.length};})()`);
  ok('a two-argument announce (the ONLINE victory point) still gets the trophy',
    online && online.shown === true && online.bytes > 100,
    JSON.stringify(online));
  await resetCards();

  void knightBox; void roadBox; void vpBox;
}

/* ====================================================== victory-point burst */

/**
 * Offsets into the burst that the filmstrip is taken at.
 *
 * The celebration is 1.25s on one clock and its hinge is at 400ms — 32% — which
 * is where the trophy that set off from the centre of the screen lands on the
 * counter, where the held numeral flips to its new value, and where the ring,
 * the wash and the new pip all break. So the strip is dense around 400 and thin
 * either side of it, and 1600 is past the end of everything (nothing here fills)
 * so that frame IS the settled counter, captured inside the same freeze as all
 * the others. It is the reference every diff below is taken against, which is
 * the only way to ask "how much did the ANIMATION change" rather than "how much
 * did the whole corner change since the score was a different number".
 */
const VP_LAND = 400;
const VP_BEFORE = [0, 200, 380];        // the trophy is still in the air
const VP_AFTER = [400, 560, 800, 1100, 1600];
const VP_TIMES = VP_BEFORE.concat(VP_AFTER);
const VP_SETTLED = 1600;

/** Every rectangle the corner is judged on, read at whatever the page is showing. */
const VP_RECTS = `(()=>{const q=s=>{const n=document.querySelector(s);
    if(!n||!n.getClientRects().length) return null;
    const r=n.getBoundingClientRect();
    return {x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom};};
  const plus=document.querySelector('.vp-plus');
  return {plus:q('.vp-plus'),card:q('.scorecard'),row:q('.sc-vp'),
    num:q('.sc-vp b'),goal:q('.sc-goal'),gear:q('.hud-tl .tl-row .cbtn'),
    clock:q('.timechip'),fly:q('.vp-fly'),
    plusOpacity:plus?+getComputedStyle(plus).opacity:0,
    numText:(document.querySelector('.sc-vp b')||{}).textContent};})()`;

async function stageVp() {
  console.log('\n--- victory point counter ---');
  await resetCards();

  const card = await rect('.scorecard');
  if (!card) { ok('scorecard found', false); return; }
  /* The corner, with room above the card for the "+1" — which no longer leaves
     the panel, but the margin is kept so that a regression back OUT of the panel
     would be photographed rather than cropped away. */
  const clip = {
    x: Math.max(0, Math.round(card.x - 16)),
    y: Math.max(0, Math.round(card.y - 34)),
    width: Math.round(card.w + 60),
    height: Math.round(card.h + 52)
  };
  console.log(`  corner clip ${JSON.stringify(clip)}`);

  const vpBefore = await ev(`document.querySelector('.sc-vp b').textContent`);
  const before = await shot('hud-vp-0-before', clip);

  /* ------------------------------------------------------------------------
   * THE CAUSE, THEN THE PAYOFF — AND THE RIG HAS TO STOP LYING ABOUT IT.
   *
   *   "FIRE THE '+1' BEFORE THE NUMBER FLIPS. Currently the count reads 4 at
   *    t000 and the '+1' only appears at t170, so the payoff precedes the
   *    cause."
   *
   * The counter now genuinely holds the old total for 400ms (hud.js counts it
   * down on the HUD's own clock, not on a timer), and the previous version of
   * this stage could not have shown that even if it had been true: it slept 700
   * REAL milliseconds after the draw before halting the page, which is long
   * enough for any hold to have expired, and then seeked the animations back to
   * zero. Every frame of that filmstrip therefore carried the NEW numeral,
   * whatever the animation was doing.
   *
   * So the strip is shot in two passes, and between them the page is allowed to
   * run for exactly as long as the hold. Pass one halts the page in the same
   * breath as the purchase — nothing has ticked, the numeral is still the old
   * one — and covers 0 to 380ms. Pass two lets the clock run past the landing,
   * halts again and covers 400ms to the end. The result is a filmstrip in which
   * the number changes on the frame it changes on for the player.
   * --------------------------------------------------------------------- */
  await ev(FREEZE_TIMERS);
  await drawCard('victoryPoint');
  await ev(HALT_FRAMES);

  const held = await ev(`document.querySelector('.sc-vp b').textContent`);
  ok('the numeral is still the OLD total in the frame the card is bought',
    held === vpBefore, `counter reads "${held}", score was "${vpBefore}"`);

  const anims = await seek('.hud', VP_BEFORE[0]);
  console.log('  animations running: ' + JSON.stringify(anims));
  ok('the counter is genuinely animating', anims.length >= 3,
    `${anims.length} animations: ${anims.map(a => a.name + a.pseudo).join(', ')}`);
  const longest = anims.reduce((m, a) => Math.max(m, +a.dur || 0), 0);
  ok('...and it is over in about a second', longest > 0 && longest <= 1300,
    `longest is ${longest}ms`);
  ok('the floating +1 is one of them', anims.some(a => /vpPlus/.test(a.name)));
  ok('the whole card takes a bump', anims.some(a => /vpCard/.test(a.name)));
  ok('the numeral bursts', anims.some(a => /vpNum/.test(a.name)));
  ok('a ring expands out of the score row', anims.some(a => /vpRing/.test(a.name)));
  /* "MAKE THE EVENT CATCHABLE FROM SCREEN CENTRE... have the trophy travel from
      the centre notice pill to the counter." */
  ok('a trophy flies in from the middle of the screen', anims.some(a => /vpFly/.test(a.name)));
  const pip = anims.some(a => /vpPip/.test(a.name));
  const trackShown = await ev(`(()=>{const t=document.querySelector('.vp-track');
    return !!(t && t.getClientRects().length);})()`);
  ok('the new pip lights with a beat (where the track is drawn)',
    pip || !trackShown, `pip=${pip} trackVisible=${trackShown}`);

  /* THE "+1" IS ALREADY UP AT ZERO. It was 18% into its own animation before it
     was visible at all, which is what put it behind the number. */
  const atZero = await ev(VP_RECTS);
  ok('the "+1" is fully up in the very first frame',
    atZero && atZero.plusOpacity >= 0.9, `opacity=${atZero && atZero.plusOpacity}`);

  const frames = [];
  const geom = [];
  for (const t of VP_BEFORE) {
    await seek('.hud', t);
    geom.push({ t, r: await ev(VP_RECTS) });
    const img = await shot(`hud-vp-t${String(t).padStart(3, '0')}`, clip);
    if (img) frames.push({ t, img });
  }

  /* ...and one full-screen frame while the trophy is still crossing the board,
     because the whole point of it is that it is nowhere near the corner. */
  await seek('.hud', 240);
  const flightImg = await shot('hud-vp-flight-fullscreen');
  const flightAt = await ev(VP_RECTS);

  /* Let the hold expire — the page runs for the length of the flight and no
     more — then freeze it again for the second half of the strip. */
  await ev(THAW);
  await sleep(900);
  await ev(FREEZE_TIMERS);
  await ev(HALT_FRAMES);
  const flipped = await ev(`document.querySelector('.sc-vp b').textContent`);
  ok('...and it flips to the new total once the trophy has landed',
    +flipped === +vpBefore + 1, `"${held}" -> "${flipped}"`);

  for (const t of VP_AFTER) {
    await seek('.hud', t);
    geom.push({ t, r: await ev(VP_RECTS) });
    const img = await shot(`hud-vp-t${String(t).padStart(3, '0')}`, clip);
    if (img) frames.push({ t, img });
  }
  await ev(THAW);

  /* ------------------------------------------------------- where things were */
  const inside = (a, b, slack = 2) => !!(a && b
    && a.x >= b.x - slack && a.right <= b.right + slack && a.bottom <= b.bottom + slack);

  /* "keep its travel inside or immediately above the VP panel's own bounds so it
      never collides with the gear or the timer." Eight pixels of "immediately
      above" is the gap the layout leaves between the button row and the card. */
  const strays = geom.filter(f => f.r && f.r.plus && f.r.plusOpacity > 0.05)
    .filter(f => !(inside(f.r.plus, f.r.card) && f.r.plus.y >= f.r.card.y - 8));
  ok('the "+1" never leaves the scoreboard it belongs to',
    strays.length === 0,
    strays.length
      ? strays.map(f => `${f.t}ms plus=${JSON.stringify(f.r.plus)} card=${JSON.stringify(f.r.card)}`).join(' | ')
      : geom.filter(f => f.r && f.r.plus).map(f => `${f.t}:${Math.round(f.r.plus.y)}..${Math.round(f.r.plus.bottom)}`).join(' '));

  const collides = geom.filter(f => f.r && f.r.plus && f.r.plusOpacity > 0.05)
    .filter(f => overlaps(f.r.plus, f.r.gear) || overlaps(f.r.plus, f.r.clock));
  ok('...and never touches the gear or the clock',
    collides.length === 0,
    collides.map(f => `${f.t}ms`).join(' ') || 'clear at every frame');

  /* "At t170 the oversized white numeral OCCLUDES the '/' of '/ 12'." */
  const covered = geom.filter(f => f.r && f.r.num && f.r.goal && overlaps(f.r.num, f.r.goal));
  ok('the swelling total never covers the "/ 12" beside it',
    covered.length === 0,
    covered.length
      ? covered.map(f => `${f.t}ms num=${JSON.stringify(f.r.num)} goal=${JSON.stringify(f.r.goal)}`).join(' | ')
      : geom.filter(f => f.r && f.r.num).map(f => `${f.t}:${Math.round(f.r.num.right)}<${Math.round(f.r.goal ? f.r.goal.x : 0)}`).join(' '));

  /* THE FLIGHT ITSELF: it has to START somewhere near the middle of the screen
     and FINISH on the counter, or it is not doing the job it was added for. */
  const launch = geom.find(f => f.t === 0);
  const land = geom.find(f => f.t === VP_LAND);
  const vw = W, vh = H;
  if (launch && launch.r.fly && land && land.r.fly) {
    const a = launch.r.fly, b = land.r.fly;
    const dx = (b.x + b.w / 2) - (a.x + a.w / 2), dy = (b.y + b.h / 2) - (a.y + a.h / 2);
    const dist = Math.hypot(dx, dy);
    ok('the trophy starts out in the middle of the screen, not in the corner',
      a.x + a.w / 2 > vw * 0.28 && a.y + a.h / 2 > vh * 0.18,
      `launch centre ${Math.round(a.x + a.w / 2)},${Math.round(a.y + a.h / 2)} in a ${vw}x${vh} viewport`);
    ok('...and it has crossed the screen to the counter by the landing frame',
      dist > vw * 0.2 && overlaps(b, land.r.card),
      `travelled ${Math.round(dist)}px, ending ${Math.round(b.x)},${Math.round(b.y)} on the scoreboard`);
  } else ok('the flying trophy was measurable at both ends', false,
    `launch=${JSON.stringify(launch && launch.r.fly)} land=${JSON.stringify(land && land.r.fly)}`);
  if (flightAt && flightAt.fly) {
    console.log(`  mid-flight at 240ms: ${Math.round(flightAt.fly.x)},${Math.round(flightAt.fly.y)}`);
  }
  void flightImg;

  /* ------------------------------------------------------------ the pixels */
  if (!before || frames.length < 5) { ok('captured the filmstrip', false); return; }
  const rest = frames.find(f => f.t === VP_SETTLED);
  if (!rest) { ok('captured the settled reference frame', false); return; }
  const W2 = rest.img.w, H2 = rest.img.h;
  const changes = frames.filter(f => f.t !== VP_SETTLED)
    .map(f => ({ t: f.t, d: diffRegion(rest.img, f.img, 0, 0, W2, H2) }));
  console.log('  corner change vs. the SETTLED counter: '
    + changes.map(c => `${c.t}ms:${(c.d.frac * 100).toFixed(0)}%`).join('  '));
  const peak = changes.reduce((a, c) => (c.d.frac > a.d.frac ? c : a), changes[0]);
  ok('the corner visibly bursts while the point lands',
    peak.d.frac > 0.10 && peak.d.worst > 70,
    `peak ${(peak.d.frac * 100).toFixed(1)}% of the corner changed at ${peak.t}ms, max channel delta ${peak.d.worst}`);

  let motion = 0, motionPair = '';
  for (let i = 1; i < frames.length; i++) {
    const d = diffRegion(frames[i - 1].img, frames[i].img, 0, 0, W2, H2);
    if (d.frac > motion) { motion = d.frac; motionPair = `${frames[i - 1].t}->${frames[i].t}ms`; }
  }
  ok('it MOVES — the frames differ from each other, it is not one static restyle',
    motion > 0.05, `largest change between two frames ${(motion * 100).toFixed(1)}% (${motionPair})`);

  /* THE COLOUR OF THE FLASH, WHICH WAS THE OTHER HALF OF THE COMPLAINT.
   *
   *   "THE VP FLASH COLOUR IS MUDDY. The row washes to rgb(115,110,75) — a drab
   *    khaki... Use a warm gold/amber tint that keeps them readable."
   *
   * Khaki is a MEASURABLE thing: red and green within a few points of each
   * other. Gold is not. The row is averaged at the peak of the wash and asked
   * for daylight between the two channels. */
  const rowRect = await rect('.sc-vp');
  const hot = frames.find(f => f.t === 560) || frames.find(f => f.t === VP_LAND);
  if (rowRect && hot) {
    const rx = rowRect.x - clip.x, ry = rowRect.y - clip.y;
    const wash = regionRGB(hot.img, rx + 3, ry + 3, rx + rowRect.w - 3, ry + rowRect.h - 3);
    const calm = regionRGB(rest.img, rx + 3, ry + 3, rx + rowRect.w - 3, ry + rowRect.h - 3);
    ok('the flash is gold, not khaki — red is well clear of green',
      wash[0] - wash[1] >= 20 && wash[0] - wash[2] >= 55,
      `row averages rgb(${wash.join(',')}) at the peak, rgb(${calm.join(',')}) at rest `
      + `(r-g ${wash[0] - wash[1]}, r-b ${wash[0] - wash[2]}; the rejected build was rgb(115,110,75), r-g 5)`);
    ok('...and it is a LIFT — the row is brighter than it was, not dirtier',
      lum(wash) > lum(calm) * 1.4,
      `L ${lum(wash).toFixed(4)} vs ${lum(calm).toFixed(4)}`);

    /* "the trophy icon and number both wash out on it" — so the numeral is
       measured on the gold: its own box has to still contain a real dark-to-
       light edge, which is what its ink keyline is for. */
    const numR = (geom.find(f => f.t === 560) || {}).r;
    if (numR && numR.num) {
      const n = numR.num;
      const ink = region(hot.img, n.x - clip.x + 1, n.y - clip.y + 2,
        n.right - clip.x - 1, n.bottom - clip.y - 2);
      ok('...and the total is still cut out against it',
        contrast(ink.max, ink.min) >= 4.5,
        `numeral box runs L=${ink.min.toFixed(4)} to L=${ink.max.toFixed(4)} `
        + `(${contrast(ink.max, ink.min).toFixed(2)}:1 across its own keyline)`);
    }
  } else ok('measured the wash colour', false);

  /* And it must be OVER. The owner gets a handful of these a match; a corner
     still glowing two seconds later is the next complaint. */
  const late = changes.find(c => c.t === 1100);
  ok('and it is essentially finished by 1.1s',
    late && late.d.frac < 0.06,
    `${((late ? late.d.frac : 1) * 100).toFixed(1)}% of the corner still altered at 1100ms`);

  /* The resting counter before the point landed, versus the resting counter
     after it: everything should be back where it was except the score. */
  const settledVsBefore = diffRegion(before, rest.img, 0, 0, W2, H2);
  console.log(`  before vs. settled: ${(settledVsBefore.frac * 100).toFixed(1)}% `
    + '(the numeral and the pips genuinely did change — this is context, not a check)');

  // One full-screen frame at the landing, so the burst can be seen in context.
  await ev(FREEZE_TIMERS);
  await drawCard('victoryPoint');
  await sleep(700);
  await ev(HALT_FRAMES);
  await seek('.hud', VP_LAND + 60);
  await shot('hud-vp-burst-fullscreen');
  await ev(THAW);
  await sleep(1400);
  await shot('hud-vp-9-settled', clip);
}

/* -------------------------------------------------------------------- run */

if (STAGE === 'settings' || STAGE === 'all') await stageSettings();
if (STAGE === 'notice' || STAGE === 'all') await stageNotice();
if (STAGE === 'vp' || STAGE === 'all') await stageVp();

for (const e of exceptions.slice(0, 6)) console.log('  EXC ' + String(e).split('\n')[0].slice(0, 200));
for (const w of warnings.slice(0, 6)) console.log('  WARN ' + String(w).slice(0, 160));

console.log('\nPNGs:');
for (const s of shots) console.log('  ' + s);
console.log(fails.length ? `\n${fails.length} FAILING:\n  ` + fails.join('\n  ') : '\nall checks passed');

ws.close(); chrome.kill('SIGKILL');
process.exit(fails.length ? 1 : 0);
