/**
 * Build-sheet capture and measurement rig.
 *
 *   node tools/buildshot.mjs --chrome=/path/to/headless_shell [--w=640] [--h=320]
 *
 * A sibling of tools/uishot.mjs — same CDP plumbing, pointed at the one surface
 * that rig cannot reach: the placement map after the confirm bar came off it.
 *
 * WHY IT EXISTS RATHER THAN A SCREENSHOT AND AN OPINION
 * -----------------------------------------------------
 * Every claim this change makes is a claim about STATE OVER TIME — the sheet
 * stays open, the count goes down, the line appears only while pending, the
 * chip greys at nought — and none of those can be read off a still. So every
 * scene here does the same three things in the same order: drive the real
 * interface with real mouse events, MEASURE the DOM and the game state, and
 * only then take the picture. The pictures are evidence for a human; the
 * measurements are the pass.
 *
 * "Real" means real. Targets are tapped with `Input.dispatchMouseEvent` at
 * coordinates the panel itself reports, chips are clicked at the middle of
 * their own bounding boxes, and nothing calls `overview.commit()` — the whole
 * point of the change is that the second tap is now the only way to commit, so
 * a rig that committed any other way would be testing a route that no longer
 * exists. The one programmatic reach-in is `ov.select(id)` used purely to ask
 * the panel where a target IS on the canvas, and it is immediately undone
 * before the finger arrives.
 *
 * WHAT EACH SCENE PROVES
 *   open      the sheet comes up with four chips, the counts are right, the
 *             unaffordable ones are grey and `disabled`, and there is no
 *             Confirm and no Cancel anywhere in the panel
 *   arm       one tap arms a target and the line appears at the TOP of the
 *             screen; its box is measured, not eyeballed
 *   stay      a second tap builds, and the sheet is STILL OPEN with the count
 *             one lower and a fresh set of legal spots
 *   cancel    a tap on open water disarms and the sheet is still open
 *   switch    tapping the settlement chip re-points the map; tapping the grey
 *             city chip does nothing at all
 *   last      the same two taps with only one road affordable CLOSE the sheet
 *   free      two free roads from a Road Building card count as two roads on
 *             the chip even with an empty pack
 *   fit       every piece of the sheet is inside the viewport and nothing
 *             overlaps anything else, at whatever size was asked for
 *
 * Owner: UI agent.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const arg = (k, d) => {
  const hit = process.argv.find(a => a.startsWith(`--${k}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};

const W = +arg('w', 640);
const H = +arg('h', 320);
const OUT = resolve(ROOT, arg('out', 'progress/tut'));
const PORT = +arg('port', 5173);
const TAG = arg('tag', `${W}x${H}`);
const SHOT = arg('shot', '1') === '1';
const CHROME = arg('chrome', '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell');
const LIBS = arg('libs', '/usr/lib/x86_64-linux-gnu');
const SEED = +arg('seed', 7);

mkdirSync(OUT, { recursive: true });
if (!existsSync(CHROME)) { console.error(`no chrome at ${CHROME}`); process.exit(2); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ============================================================ chrome plumbing
   Lifted from tools/uishot.mjs and tools/testmatch.mjs so a failure here reads
   the same as a failure there. */

const DP = 9700 + Math.floor(Math.random() * 400);
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
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${DP}/json/list`);
    const p = (await r.json()).find(t => t.type === 'page');
    if (p) { wsUrl = p.webSocketDebuggerUrl; break; }
  } catch { /* not up yet */ }
  await sleep(200);
}
if (!wsUrl) { console.error('devtools never came up\n' + chromeErr.slice(-600)); process.exit(2); }

const ws = new WebSocket(wsUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));

let msgId = 0;
const pending = new Map();
const exceptions = [];
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
});
const send = (method, params = {}) => new Promise(res => {
  const id = ++msgId;
  pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); res({ __err: 'timeout' }); } }, 60000);
});
const ev = async (expr, awaitPromise = false) => {
  const r = await send('Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise, allowUnsafeEvalBlockedByCSP: true
  });
  if (r?.exceptionDetails) {
    return { __err: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
  }
  return r?.result?.value;
};
const pev = async (expr, awaitPromise = false) => {
  const v = await ev(expr, awaitPromise);
  if (v && v.__err) throw new Error(`page: ${String(v.__err).split('\n')[0]}`);
  return v;
};
const shot = async name => {
  if (!SHOT) return null;
  /* Under SwiftShader this page draws at well under a frame a second, and a
     capture that lands while the compositor is mid-frame comes back empty. One
     retry after a breath, and a loud failure if even that does not land — an
     evidence frame that quietly did not happen is worse than no rig. */
  let r = await send('Page.captureScreenshot', { format: 'png' });
  if (!r?.data) { await sleep(1200); r = await send('Page.captureScreenshot', { format: 'png' }); }
  if (!r?.data) { console.log(`  shot ${name} FAILED`); shotFails.push(name); return null; }
  const buf = Buffer.from(r.data, 'base64');
  const path = resolve(OUT, `${name}-${TAG}.png`);
  writeFileSync(path, buf);
  console.log(`      shot ${path.replace(ROOT + '/', '')} (${(buf.length / 1024).toFixed(0)} KB)`);
  return path;
};

const shotFails = [];

/** A real finger: press and release at one point, no travel between them. */
async function tap(x, y, ms = 90) {
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: Math.round(x), y: Math.round(y),
    button: 'left', clickCount: 1, buttons: 1
  });
  await sleep(30);
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: Math.round(x), y: Math.round(y),
    button: 'left', clickCount: 1, buttons: 0
  });
  await sleep(ms);
}

/* ================================================================== results */

const checks = [];
function claim(name, pass, evidence) {
  checks.push({ name, pass: !!pass, evidence });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}`);
  for (const line of String(evidence).split('\n')) {
    if (line.trim()) console.log(`      ${line}`);
  }
}

/* ===================================================================== boot */

await send('Page.enable'); await send('Runtime.enable');
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });

let booted = false;
for (let i = 0; i < 150; i++) {
  if (await ev('!!(window.__ISLAND__&&window.__ISLAND__.state)') === true) { booted = true; break; }
  await sleep(150);
}
if (!booted) { console.error('GAME DID NOT BOOT\n' + chromeErr.slice(-500)); ws.close(); chrome.kill('SIGKILL'); process.exit(1); }
console.log(`booted ${W}x${H}`);

await ev(`Promise.all([
  import('/src/core/rules.js').then(m=>{window.__R__=m}),
  import('/src/board/layout.js').then(m=>{window.__L__=m}),
  import('/src/core/constants.js').then(m=>{window.__C__=m})
]).then(()=>1)`, true);

/* ------------------------------------------------------- in-page harness
 *
 * Three kinds of helper and no more: one that gets a match to `play`, ones that
 * READ (never write) the sheet and the state, and one that answers "where on
 * the canvas is target N" so a real tap can be aimed at it.
 *
 * `expected()` deliberately recomputes the four counts from raw resources,
 * piece limits and rules.js — it does NOT call `buyCount`. A rig that measured
 * the implementation against itself would agree with any bug in it.
 */
await pev(`(()=>{
const I=()=>window.__ISLAND__, R=window.__R__, L=window.__L__, C=window.__C__;
const S=1/60;
const ov=()=>I().game.overview;
const st=()=>I().state;
const me=()=>st().players[0];
const box=n=>{ if(!n) return null; const r=n.getBoundingClientRect();
  return {x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height),
          r:Math.round(r.right),b:Math.round(r.bottom)}; };
const vis=n=>{ if(!n) return false; const s=getComputedStyle(n);
  const r=n.getBoundingClientRect();
  return s.display!=='none' && s.visibility!=='hidden' && +s.opacity>0.05 && r.width>0 && r.height>0; };

/** The real opening draft, answered through the panel's own commit. */
window.__draft=function(maxSec,stopAtPick){
  const s=st(), g=I().game;
  const n=Math.round((maxSec||45)*60);
  let picks=0,i=0;
  if (g.flow && g.flow.skipIntro) g.flow.skipIntro();
  for(;i<n && s.phase==='setup';i++){
    g.flow.update(S);
    const o=ov();
    if(o && o.isOpen && String(o.mode).indexOf('place-')===0){
      const road=s.setupNeed==='road';
      const list=road ? R.legalRoads(s,0,true,s.setupAnchor) : R.legalSettlements(s,0,true);
      if(!list.length) break;
      // The draft is a placement panel that is NOT a build sheet, and taking
      // the confirm bar off it changed how it looks — so the rig can stop on
      // the human's own pick and photograph it before answering.
      if(stopAtPick) return {phase:s.phase,picks:picks,stopped:true,mode:o.mode,
        need:s.setupNeed,id:list[Math.floor(list.length*0.4)]};
      o.select(list[Math.floor(list.length*0.4)]);
      o.commit(); picks++;
    }
  }
  return {phase:s.phase,picks:picks,buildings:s.buildings.size,roads:s.roadOwner.size};
};

/** Set the pack to exactly this, and the free-road debt with it. */
window.__pack=function(bag,free){
  const p=me();
  for(const k of C.RES) p.res[k]=bag && bag[k]!==undefined ? bag[k] : 0;
  if(free!==undefined) p.freeRoads=free|0;
  return {res:{...p.res},freeRoads:p.freeRoads|0};
};

/** Where target \`id\` sits on the canvas, via the panel's own projection.
 *  The arm is undone before the answer is returned. */
window.__xy=function(id){
  const o=ov(); const had=o.metrics.sel;
  o.select(id);
  const xy=o.metrics.selXY;
  o.select(had===undefined?null:had);
  if(!xy) return null;
  const c=document.querySelector('.ov-cv').getBoundingClientRect();
  return {x:Math.round(c.left+xy[0]),y:Math.round(c.top+xy[1])};
};

/** A point on the board that is NOT within tapping range of any target —
 *  "somewhere else on the map (that isn't another open road)". Scanned rather
 *  than guessed, and the winning point's clearance is reported. */
window.__empty=function(){
  const o=ov(), m=o.metrics;
  const c=document.querySelector('.ov-cv').getBoundingClientRect();
  const pts=m.ids.map(id=>window.__xy(id)).filter(Boolean);
  const need=m.hitPx/2+14;
  let best=null,bd=-1;
  for(let gy=0.12;gy<=0.88;gy+=0.04){
    for(let gx=0.12;gx<=0.88;gx+=0.04){
      const x=c.left+c.width*gx, y=c.top+c.height*gy;
      // Clear of the chips, the line, the zoom pad and the pip strip too: a
      // tap that lands on chrome is not a tap on the map.
      const el=document.elementFromPoint(x,y);
      if(!el || !el.classList.contains('ov-cv')) continue;
      let d=1e9;
      for(const p of pts) d=Math.min(d,Math.hypot(p.x-x,p.y-y));
      if(d>bd){bd=d;best={x:Math.round(x),y:Math.round(y)};}
    }
  }
  return best?{...best,clearPx:Math.round(bd),needPx:Math.round(need),ok:bd>need}:null;
};

/** The four chips as the screen has them. */
window.__chips=function(){
  return [...document.querySelectorAll('.ov .ovb-chip')].map(n=>{
    const s=getComputedStyle(n);
    return {
      kind:n.getAttribute('data-kind'),
      count:+(n.querySelector('.ovb-n').textContent||'-1'),
      grey:n.classList.contains('off'),
      active:n.classList.contains('on'),
      free:n.classList.contains('free'),
      disabled:!!n.disabled,
      opacity:+(+s.opacity).toFixed(2),
      filtered:s.filter!=='none',
      border:s.borderTopStyle,
      fill:s.backgroundImage==='none'?'hollow':'filled',
      box:box(n)
    };
  });
};

/** Everything about the sheet a claim might need, in one round trip. */
window.__sheet=function(){
  const o=ov(), m=o.metrics;
  const say=document.querySelector('.ov .ovb-say');
  const bar=document.querySelector('.ov .ovb');
  const buttons=[...document.querySelectorAll('.ov button')].map(b=>({
    cls:b.className,txt:(b.textContent||'').trim(),
    shown:vis(b),box:box(b)
  }));
  return {
    open:o.isOpen, mode:o.mode, targets:m.targets, sel:m.sel,
    bar:{shown:vis(bar),box:box(bar)},
    say:{shown:vis(say),text:(say.textContent||'').trim(),
         armed:say.classList.contains('arm'),
         pointer:getComputedStyle(say).pointerEvents,box:box(say)},
    buttons,
    confirmOrCancel:buttons.filter(b=>/confirm|cancel/i.test(b.txt)).map(b=>b.txt),
    legacyGreenInBar:!!document.querySelector('.ov-bar .btn.green'),
    roads:st().roadOwner.size, buildings:st().buildings.size,
    res:{...me().res}, freeRoads:me().freeRoads|0,
    viewport:{w:innerWidth,h:innerHeight}
  };
};

/** The counts the bar OUGHT to be showing, derived from first principles. */
window.__expected=function(){
  const s=st(), p=me();
  const legal={road:R.legalRoads(s,0).length,
               settlement:R.legalSettlements(s,0).length,
               city:R.legalCities(s,0).length, card:Infinity};
  const left={road:C.PIECE_LIMIT.road-p.roads.size,
              settlement:C.PIECE_LIMIT.settlement-(p.settlements.size+p.cities.size),
              city:C.PIECE_LIMIT.city-p.cities.size, card:Infinity};
  const out={};
  for(const k of ['road','settlement','city','card']){
    let n=Infinity;
    for(const r of C.RES){ const need=C.COST[k][r]; if(!need) continue;
      n=Math.min(n,Math.floor((p.res[r]|0)/need)); }
    if(k==='road') n+=Math.max(0,p.freeRoads|0);
    out[k]=Math.max(0,Math.min(n,left[k],legal[k]));
  }
  return out;
};

/**
 * Lay free roads out of the network until a legal corner exists.
 *
 * Two draft roads usually leave nowhere legal for a settlement — both far ends
 * are neighbours of your own corners — so without this the settlement chip is
 * honestly, and uselessly, x0 for the whole run and the switch scene has
 * nothing to switch to. Every segment goes through rules.placeRoad exactly as
 * testmatch's own check 8 does it.
 */
window.__openCorner=function(){
  const s=st(); let laid=0;
  for(let i=0;i<8 && !R.legalSettlements(s,0).length;i++){
    const legal=R.legalRoads(s,0);
    if(!legal.length) break;
    if(R.placeRoad(s,0,legal[legal.length-1],true)) laid++; else break;
  }
  return {laid, corners:R.legalSettlements(s,0).length};
};

/**
 * Step the opening flow until the match is really running.
 *
 * The countdown after the draft is counted in GAME time, and this page draws
 * at about one frame a second under SwiftShader — so waiting for it in wall
 * clock is waiting a minute and a half for three seconds of '3, 2, 1, GO'.
 * Stepped here the same way __draft steps the draft itself.
 */
window.__toPlay=function(maxSec){
  const g=I().game, s=st();
  const n=Math.round((maxSec||30)*60);
  for(let i=0;i<n;i++){
    const f=g.flow||{};
    if(s.phase==='play' && f.stage==='play' && !f.counting) break;
    g.flow.update(S);
  }
  return {stage:(g.flow||{}).stage,counting:!!(g.flow||{}).counting,phase:s.phase};
};

/** Where the opening flow has got to. Nothing may be built until it says play. */
window.__flow=function(){
  const f=I().game.flow||{};
  return {stage:f.stage,counting:!!f.counting,phase:st().phase};
};

/** Boxes of everything the map floats over the board, for the overlap test. */
window.__furniture=function(){
  const pick=sel=>{const n=document.querySelector(sel); return (n&&vis(n))?{sel,...box(n)}:null;};
  return ['.ov .ovb','.ov .ovb-say','.ov .ov-x','.ov .ovz','.ov .ov-strip','.ov .ov-rail']
    .map(pick).filter(Boolean);
};

/* ----------------------------------------------------------- loop two
 *
 * Everything below was added after a review of the first pass. Each helper
 * exists because one of its findings could not be answered with a still.
 */

/**
 * The PAINTED board — harbour signs included — in page coordinates.
 *
 * 'metrics.boardBox' is in canvas px and is built from the painter's own
 * 'portRects()', so this is the real ink and not a guess at it. The review's
 * finding was "a razor-straight cut at y=260 slicing the bottom ~40% off both
 * bottom port badges", and the only way to test that automatically is to ask
 * whether any chrome's rectangle intersects this one.
 */
window.__board=function(){
  const o=ov(), m=o.metrics;
  const c=document.querySelector('.ov-cv').getBoundingClientRect();
  const [x0,y0,x1,y1]=m.boardBox;
  return {x:Math.round(c.left+x0),y:Math.round(c.top+y0),
          r:Math.round(c.left+x1),b:Math.round(c.top+y1),dockOv:m.dockOv};
};

/**
 * Is anything actually PAINTED where a target is supposed to be?
 *
 * The map draws into a 2d canvas, so the pixels are readable — which turns
 * "the settlement chip switches the map to an empty board" from an opinion
 * about a diff into a measurement. A box is read around the target's own
 * reported position and every pixel bright enough and warm enough to be the
 * gold ring is counted, against a control patch of open water the same size.
 */
window.__ink=function(pt,half){
  const cv=document.querySelector('.ov-cv');
  const ctx=cv.getContext('2d');
  const c=cv.getBoundingClientRect();
  const dpr=cv.width/Math.max(1,c.width);
  const h=(half||14);
  const x=Math.max(0,Math.round((pt.x-c.left-h)*dpr));
  const y=Math.max(0,Math.round((pt.y-c.top-h)*dpr));
  const w=Math.round(h*2*dpr);
  const d=ctx.getImageData(x,y,w,w).data;
  let warm=0,bright=0,n=0;
  for(let i=0;i<d.length;i+=4){
    const R=d[i],G=d[i+1],B=d[i+2];
    n++;
    if(R>150&&G>120&&B<170&&R-B>40) warm++;      // gold / cream ring ink
    if(R+G+B>560) bright++;
  }
  return {warm,bright,n,warmPct:+(100*warm/n).toFixed(2)};
};

/** The same read, on a patch of open sea, as the control. */
window.__inkControl=function(half){
  const c=document.querySelector('.ov-cv').getBoundingClientRect();
  return window.__ink({x:c.left+14+(half||14),y:c.top+c.height-14-(half||14)},half);
};

/** Chip geometry the review measured by hand: heights, gaps, centring. */
window.__bar=function(){
  const bar=document.querySelector('.ov .ovb');
  const cs=bar?[...bar.querySelectorAll('.ovb-chip')]:[];
  const bx=cs.map(n=>n.getBoundingClientRect());
  const gaps=[];
  for(let i=1;i<bx.length;i++) gaps.push(Math.round(bx[i].left-bx[i-1].right));
  const st=cs.map(n=>{const s=getComputedStyle(n);
    return {kind:n.getAttribute('data-kind'),off:n.classList.contains('off'),
      borderStyle:s.borderTopStyle,bgImage:s.backgroundImage==='none'?'none':'gradient',
      filter:s.filter,opacity:+(+s.opacity).toFixed(2),
      color:s.color,
      icoW:Math.round((n.querySelector('.ovb-ico svg')||{}).clientWidth||0),
      numPx:Math.round(parseFloat(getComputedStyle(n.querySelector('.ovb-n')).fontSize)),
      flag:!!(n.querySelector('.ovb-flag')&&!n.querySelector('.ovb-flag').classList.contains('hid'))};
  });
  const r=bar?bar.getBoundingClientRect():{left:0,right:0};
  return {
    w:bx.map(b=>Math.round(b.width)), h:bx.map(b=>Math.round(b.height)), gaps,
    centre:+(((r.left+r.right)/2)).toFixed(1), screenCentre:innerWidth/2,
    labels:document.querySelectorAll('.ov .ovb-lab').length,
    chips:st
  };
};

/**
 * The blur test, run rather than eyeballed.
 *
 *   "Test each by blurring at 1.6px — if it does not survive, it is not done."
 *
 * Each glyph is drawn at 14px onto its own canvas through 'ctx.filter =
 * blur(1.6px)', and then two things are asked of the result: is there still
 * ink in it (a shape that blurs to nothing is not a shape), and is it still
 * TELLABLE from the other three — measured as the mean absolute pixel
 * difference between every pair. A pair that comes out under the threshold is
 * two glyphs a player cannot tell apart at arm's length.
 */
window.__blurTest=function(px,sigma){
  window.__BLUR=null;
  const S=px||14, PAD=6, N=S+PAD*2;
  const kinds=[...document.querySelectorAll('.ov .ovb-chip')]
    .map(n=>({kind:n.getAttribute('data-kind'),
              svg:n.querySelector('.ovb-ico svg').outerHTML}));
  const draw=one=>new Promise(res=>{
    const c=document.createElement('canvas'); c.width=N; c.height=N;
    const x=c.getContext('2d');
    const img=new Image();
    const svg=one.svg.replace(/width="\\d+"/,'width="'+S+'"')
                     .replace(/height="\\d+"/,'height="'+S+'"')
                     .replace('<svg','<svg xmlns="http://www.w3.org/2000/svg" '+
                       'style="color:#eaf2fb"');
    img.onload=()=>{
      x.filter='blur('+(sigma||1.6)+'px)';
      x.drawImage(img,PAD,PAD,S,S);
      res({kind:one.kind,data:x.getImageData(0,0,N,N).data});
    };
    img.onerror=()=>res({kind:one.kind,data:x.getImageData(0,0,N,N).data});
    img.src='data:image/svg+xml;base64,'+btoa(unescape(encodeURIComponent(svg)));
  });
  return Promise.all(kinds.map(draw)).then(bits=>{
    const ink=b=>{let s=0;for(let i=3;i<b.data.length;i+=4)s+=b.data[i];
      return +(s/(b.data.length/4)/255).toFixed(3);};
    const diff=(a,b)=>{let s=0,n=0;
      for(let i=0;i<a.data.length;i+=4){
        const av=a.data[i+3]*(a.data[i]+a.data[i+1]+a.data[i+2])/765;
        const bv=b.data[i+3]*(b.data[i]+b.data[i+1]+b.data[i+2])/765;
        s+=Math.abs(av-bv); n++; }
      return +(s/n).toFixed(2);};
    const pairs=[];
    for(let i=0;i<bits.length;i++) for(let j=i+1;j<bits.length;j++)
      pairs.push({a:bits[i].kind,b:bits[j].kind,d:diff(bits[i],bits[j])});
    window.__BLUR={ink:bits.map(b=>({kind:b.kind,ink:ink(b)})),pairs};
    return 1;
  });
  return 1;
};

/**
 * Watch for the decrement bounce.
 *
 * 'replay()' in dom.js puts 'tick' on the chip and takes it off again 620ms
 * later, and this page draws at three frames a second — so polling for the
 * class is polling for something that has already gone. An observer records
 * that it happened instead.
 */
window.__watchTick=function(){
  window.__TICKS=[];
  if(window.__TICKOBS) window.__TICKOBS.disconnect();
  const o=new MutationObserver(ms=>{
    for(const m of ms){
      const n=m.target;
      if(n.classList&&n.classList.contains('tick'))
        window.__TICKS.push(n.getAttribute('data-kind'));
    }
  });
  for(const n of document.querySelectorAll('.ov .ovb-chip'))
    o.observe(n,{attributes:true,attributeFilter:['class']});
  window.__TICKOBS=o;
  return 1;
};
window.__ticks=function(){return window.__TICKS||[];};

/**
 * The objective card, asked directly.
 *
 * The real '.mf-obj' node — flowUI.js built it — is put into the exact state
 * matchflow.js puts it in on GO, and its computed opacity is read back. That
 * tests the rule that is shipping, not a copy of it, and it is restored
 * immediately afterwards.
 */
window.__objective=function(){
  const n=document.querySelector('.mf-obj');
  if(!n) return {found:false};
  const hadHid=n.classList.contains('mf-hid'), hadOn=n.classList.contains('on');
  n.classList.remove('mf-hid'); n.classList.add('on');
  const s=getComputedStyle(n);
  const out={found:true,opacity:+(+s.opacity).toFixed(3),
             pointer:s.pointerEvents,
             root:document.getElementById('ui').classList.contains('ov-live')};
  if(hadHid) n.classList.add('mf-hid');
  if(!hadOn) n.classList.remove('on');
  return out;
};

/** The close key's accessible name — the free-road forfeit warning lives there. */
window.__closeKey=function(){
  const n=document.querySelector('.ov .ov-x');
  return n?{label:n.getAttribute('aria-label'),shown:vis(n)}:null;
};
return 1;})()`);

/* ------------------------------------------------------------- to the match */
const drafted = await pev(`(()=>{ const g=window.__ISLAND__.game;
  if (window.__ISLAND__.state.phase!=='play' && g.flow && g.flow.restartInPlace)
    g.flow.restartInPlace({seed:${SEED}});
  return 1;})()`);
await sleep(500);
/* ==================================================== the draft, in passing
 * Not a build sheet — no chips, no counts, nothing to afford — but it is a
 * placement panel and it lost the same two buttons, so it gets one photograph
 * and one measurement: the human's own pick, armed by a real tap, with the top
 * line doing the job Confirm used to. */
const pick = await pev('__draft(45,true)');
if (pick && pick.stopped) {
  const pxy = await pev(`__xy(${pick.id})`);
  await tap(pxy.x, pxy.y, 300);
  let ds = null;
  for (let i = 0; i < 25; i++) {
    ds = await pev('__sheet()');
    if (ds.say.shown) break;
    await sleep(200);
  }
  await shot('build-draft');
  claim('a draft pick keeps the two-tap route and gains the whole panel',
    ds.sel === pick.id && ds.bar.shown === false && ds.say.armed === true &&
    ds.confirmOrCancel.length === 0,
    `${pick.need} pick: sel=${ds.sel} armed line="${ds.say.text}" ` +
    `chip bar shown=${ds.bar.shown} (a draft affords nothing — it is free)
` +
    `buttons offering confirm/cancel: ${JSON.stringify(ds.confirmOrCancel)}`);
}

const d = await pev('__draft(45)');
if (d.phase !== 'play') {
  console.error('never reached play: ' + JSON.stringify(d));
  ws.close(); chrome.kill('SIGKILL'); process.exit(1);
}
console.log(`  draft done: ${d.buildings} settlements, ${d.roads} roads`);

/* WAIT FOR THE STARTER'S GUN, AND DO NOT SKIP IT.
 *
 * `state.phase === 'play'` is not the same thing as the match having started.
 * The last road of the draft flips the phase, and matchflow then runs a
 * HANDOFF stage — camera snap, input armed, "3, 2, 1, GO" — which ends in
 * `enterPlay()`, and `enterPlay` closes the board map on principle ("whatever
 * route got us here, the board map does not survive into third-person play").
 *
 * A rig that starts building on the phase flag alone therefore has its sheet
 * pulled out from under it mid-scene, at an unpredictable moment — and worse,
 * unpredictably LATE, because an open map pauses the match and the countdown
 * with it, so the gun goes off the moment the rig closes the sheet for its own
 * reasons. That cost an afternoon; it is not a bug in the sheet, and it is why
 * this loop is here. */
let fl = await pev('__toPlay(40)');
for (let i = 0; i < 60 && !(fl.phase === 'play' && fl.stage === 'play' && !fl.counting); i++) {
  await sleep(200);
  fl = await pev('__flow()');
}
console.log(`  flow: ${JSON.stringify(fl)}`);
const corner = await pev('__openCorner()');
console.log(`  opened a legal corner: ${JSON.stringify(corner)}`);
await sleep(400);

/** Open the build sheet the way a thumb does: a real click on the HUD's own
 *  road card. No `requestBuild`, no `overview.open` — if the card cannot open
 *  the sheet, the scene fails here and that is the right place to fail. */
async function openViaCard(kind) {
  const at = await pev(`(()=>{const b=document.querySelector('.bcard[data-kind="${kind}"]');
    if(!b) return null; const r=b.getBoundingClientRect();
    return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),
            shown:r.width>0&&r.height>0};})()`);
  if (!at) throw new Error(`no ${kind} build card on screen`);
  await tap(at.x, at.y, 380);
  return at;
}

/* ===================================================================== open
 * Three roads' worth of wood and brick, one settlement's worth of everything
 * else it needs, and nothing at all for a city — which is the owner's own
 * example of the bar: "3 more roads, or 1 settlement, 0 cities greyed out". */
console.log('\nSCENE open — the sheet, the chips, and no buttons');
await pev(`__pack({wood:12,brick:12,wheat:4,wool:4,ore:0},0)`);
await openViaCard('road');
let s = await pev('__sheet()');
let chips = await pev('__chips()');
let want = await pev('__expected()');
await shot('build-open');

claim('the sheet opens on the road, with the chip bar under it',
  s.open === true && s.mode === 'place-road' && s.bar.shown === true,
  `open=${s.open} mode=${s.mode} targets=${s.targets} bar=${JSON.stringify(s.bar.box)}`);

claim('every chip count matches the count derived from the rules',
  chips.every(c => c.count === want[c.kind]),
  `shown  ${chips.map(c => `${c.kind}=${c.count}`).join(' ')}\n` +
  `truth  ${Object.keys(want).map(k => `${k}=${want[k]}`).join(' ')}\n` +
  `pack   ${JSON.stringify(s.res)} freeRoads=${s.freeRoads}`);

claim('a chip at nought is hollow AND inert; a chip above nought is neither',
  chips.every(c => (c.count === 0) === c.grey && (c.count === 0) === c.disabled)
  && chips.some(c => c.count === 0) && chips.some(c => c.count > 0),
  chips.map(c => `${c.kind} x${c.count} off=${c.grey} disabled=${c.disabled} ` +
    `${c.fill} ${c.border} border (no filter, no opacity trick: ` +
    `filter=${c.filtered} opacity=${c.opacity})`).join('\n'));

claim('the chip the map is currently offering is the one marked active',
  chips.filter(c => c.active).length === 1 && chips.find(c => c.active).kind === 'road',
  chips.map(c => `${c.kind} active=${c.active}`).join('  '));

claim('there is no Confirm button and no Cancel button anywhere in the panel',
  s.confirmOrCancel.length === 0 && s.legacyGreenInBar === false,
  `buttons in .ov: ${JSON.stringify(s.buttons.filter(b => b.shown).map(b => b.txt || b.cls.split(' ')[1] || b.cls))}\n` +
  `text matching /confirm|cancel/i: ${JSON.stringify(s.confirmOrCancel)}\n` +
  `legacy '.ov-bar .btn.green' still present: ${s.legacyGreenInBar}`);

/* THE TOP LINE, PART ONE.
 *
 *   "Let them know they can tap twice to build a road, instead of having to
 *    press confirm."
 *
 * A fresh sheet opens with the gesture written along the top for a few seconds.
 * It is NOT the armed line — different words, no gold — and it must take itself
 * away, or it is the permanent caption the bar was just deleted for being. */
for (let i = 0; i < 25 && !s.say.shown; i++) { await sleep(200); s = await pev('__sheet()'); }
claim('a fresh sheet says how to build, in a line that is not the armed one',
  s.say.shown === true && s.say.armed === false &&
  /tap.*again/i.test(s.say.text) && s.sel === null,
  `sel=${s.sel} say.shown=${s.say.shown} armed=${s.say.armed} text="${s.say.text}"`);

/* AND IT DOES NOT GO AWAY AGAIN.
 *
 * This claim used to be the opposite of itself — "and it clears itself while
 * nothing is pending" — and the review of that pass is the reason it flipped:
 *
 *   "Keep the hint pill present in EVERY open, non-pending state. It is
 *    missing in build-cancelled, build-stayed and build-switch, yet present in
 *    the state-identical build-open."
 *
 * `OPEN_SAY_SEC` is 3.6 IN-GAME seconds and this page draws at a few frames a
 * second under SwiftShader, so the wait below is far longer than the timeout
 * it is outliving — which is the point: if the line were still on a timer, it
 * would be gone by the end of it. The measured frame rate is in the evidence
 * so a reader can see the wait was real. */
await pev(`(()=>{window.__F=0;window.__FT=performance.now();
  (function f(){window.__F++;requestAnimationFrame(f);})();return 1;})()`);
await sleep(2000);
const fps = await pev('+(window.__F/((performance.now()-window.__FT)/1000)).toFixed(1)');
let fade = null;
const t0 = Date.now();
for (let i = 0; i < 40; i++) {
  fade = await pev('__sheet()');
  if (!fade.say.shown) break;
  await sleep(250);
}
claim('and it STAYS up for as long as the sheet does, with nothing pending',
  fade.say.shown === true && fade.sel === null && fade.open === true &&
  fade.say.armed === false && /tap an edge/i.test(fade.say.text),
  `after ${((Date.now() - t0) / 1000).toFixed(1)}s of wall clock at ${fps} fps ` +
  `(more than the 3.6 in-game seconds the old timeout ran for):\n` +
  `say.shown=${fade.say.shown} armed=${fade.say.armed} text="${fade.say.text}" ` +
  `sel=${fade.sel} sheet still open=${fade.open}`);

/* ========================================= the intro banner over the island
 *
 *   "Suppress the 'GATHER. BUILD. WIN. / FIRST TO 12 POINTS' intro banner
 *    while the build sheet is open ... it covers board rows y=175-259 — 85px,
 *    27% of a 320px screen."
 *
 * The REAL `.mf-obj` node is put into the exact state matchflow.js puts it in
 * on GO and its computed opacity is read back, so this tests the rule that
 * ships rather than a copy of it. */
const objOpen = await pev('__objective()');
claim('the objective banner cannot cover the island while the map is up',
  objOpen.found === true && objOpen.opacity < 0.02 && objOpen.root === true,
  `#ui carries ov-live: ${objOpen.root}\n` +
  `.mf-obj forced to its on-GO state (.on, not .mf-hid) -> ` +
  `computed opacity ${objOpen.opacity}, pointer-events ${objOpen.pointer}`);

/* ====================================================================== fit */
const furn = await pev('__furniture()');
const overlaps = [];
for (let i = 0; i < furn.length; i++) {
  for (let j = i + 1; j < furn.length; j++) {
    const a = furn[i], b = furn[j];
    const ow = Math.min(a.r, b.r) - Math.max(a.x, b.x);
    const oh = Math.min(a.b, b.b) - Math.max(a.y, b.y);
    if (ow > 0 && oh > 0) overlaps.push(`${a.sel} x ${b.sel} = ${ow}x${oh}px`);
  }
}
const off = furn.filter(f => f.x < 0 || f.y < 0 || f.r > W || f.b > H);
claim(`everything fits inside ${W}x${H} and nothing overlaps anything`,
  overlaps.length === 0 && off.length === 0,
  furn.map(f => `${f.sel.padEnd(16)} ${f.x},${f.y} ${f.w}x${f.h} -> ${f.r},${f.b}`).join('\n') +
  `\noverlaps: ${overlaps.length ? overlaps.join('; ') : 'none'}` +
  `\noutside the viewport: ${off.length ? JSON.stringify(off) : 'none'}`);

/* ==================================================== the board, uncovered
 *
 *   "RESERVE THE BAR'S HEIGHT IN THE BOARD FIT. There is a razor-straight cut
 *    at y=260 slicing the bottom ~40% off both bottom port badges, ratio text
 *    cut through, no fade or mask."
 *   "Stop the pill occluding the board at 640x320 — it covers two 3:1 port
 *    badges at rows 10-41."
 *
 * One test answers both, and it answers them for every other piece of
 * furniture on the panel at the same time: the painted board — harbour signs
 * INCLUDED, taken from the painter's own `portRects()` — must not intersect
 * anything the map floats over it. `boardBox` is what makes it possible to ask;
 * before this loop nothing in the code knew where the board's ink ended,
 * which is exactly how the signs came to be drawn under the bar. */
async function claimBoardClear(where) {
  const bd = await pev('__board()');
  const fu = await pev('__furniture()');
  const hits = fu.map(f => {
    const ow = Math.min(f.r, bd.r) - Math.max(f.x, bd.x);
    const oh = Math.min(f.b, bd.b) - Math.max(f.y, bd.y);
    return (ow > 0 && oh > 0) ? `${f.sel} covers ${ow}x${oh}px of it` : null;
  }).filter(Boolean);
  claim(`no chrome stands on the painted board (${where})`,
    hits.length === 0 && bd.y >= 0 && bd.b <= H && bd.x >= 0 && bd.r <= W,
    `board incl. harbour signs: ${bd.x},${bd.y} -> ${bd.r},${bd.b} ` +
    `(the fit reserves ${bd.dockOv}px for the signs on every side)\n` +
    `furniture: ${fu.map(f => `${f.sel} ${f.x},${f.y}->${f.r},${f.b}`).join(' | ')}\n` +
    `overlaps: ${hits.length ? hits.join('; ') : 'none'}`);
}
await claimBoardClear('road sheet');

/* ================================================================ the bar
 *
 *   "Raise chip height from 38px to at least 44px and widen the 5px inter-chip
 *    gap."   "Raise chip label cap height ... or drop the labels entirely."
 *   "Give disabled chips a CATEGORICAL treatment, not just opacity."
 */
const bar = await pev('__bar()');
claim('every chip is at least 44px tall, with at least 8px between them',
  bar.h.every(v => v >= 44) && bar.gaps.every(g => g >= 8),
  `heights ${JSON.stringify(bar.h)}  widths ${JSON.stringify(bar.w)}  ` +
  `gaps ${JSON.stringify(bar.gaps)}\n` +
  `icon ${bar.chips[0].icoW}px, count ${bar.chips[0].numPx}px`);

claim('the tiles are all one size and the bar is centred on the screen',
  new Set(bar.w).size === 1 && new Set(bar.h).size === 1 &&
  Math.abs(bar.centre - bar.screenCentre) < 1,
  `four tiles of ${bar.w[0]}x${bar.h[0]}; bar centre ${bar.centre} against a ` +
  `screen centre of ${bar.screenCentre}`);

claim('the 5px labels are gone; the glyph and the count carry the chip',
  bar.labels === 0 && bar.chips.every(c => c.icoW >= 20),
  `.ovb-lab nodes on screen: ${bar.labels}; glyphs drawn at ` +
  `${bar.chips.map(c => c.icoW).join('/')}px`);

const onChip = bar.chips.find(c => !c.off), offChip = bar.chips.find(c => c.off);
claim('a spent chip differs from a live one in KIND, not in brightness',
  !!onChip && !!offChip && offChip.borderStyle !== onChip.borderStyle &&
  offChip.bgImage === 'none' && onChip.bgImage === 'gradient' &&
  offChip.filter === 'none',
  `live  ${onChip.kind}: border ${onChip.borderStyle}, background ` +
  `${onChip.bgImage}, filter ${onChip.filter}, opacity ${onChip.opacity}\n` +
  `spent ${offChip.kind}: border ${offChip.borderStyle}, background ` +
  `${offChip.bgImage}, filter ${offChip.filter}, opacity ${offChip.opacity}\n` +
  `(a filled slab against a dashed outline — it survives a squint, a thumbnail ` +
  `and a colour-blind eye, which a 2.8:1 brightness step did not)`);

/* ============================================================== the glyphs
 *
 *   "Redraw the four icons as flat silhouettes legible at 14px ... Test each by
 *    blurring at 1.6px — if it does not survive, it is not done."
 *
 * Run, not eyeballed: each glyph is drawn at 14px through a 1.6px blur and then
 * asked whether there is still ink in it and whether it is still tellable from
 * the other three. `MIN_DIFF` is the mean absolute difference per pixel below
 * which two blurred glyphs are the same smudge. */
const MIN_DIFF = 12;
await pev('__blurTest(14,1.6)');
let blur = null;
for (let i = 0; i < 60; i++) {
  blur = await pev('window.__BLUR');
  if (blur) break;
  await sleep(250);
}
if (!blur) blur = { ink: [], pairs: [{ a: '?', b: '?', d: 0 }] };
const worst = blur.pairs.reduce((a, b) => (a.d < b.d ? a : b));
claim('all four glyphs survive a 1.6px blur at 14px and stay tellable apart',
  blur.ink.every(g => g.ink > 0.12) && worst.d >= MIN_DIFF,
  `ink left after the blur: ${blur.ink.map(g => `${g.kind} ${g.ink}`).join('  ')}\n` +
  `pairwise difference: ${blur.pairs.map(p => `${p.a}/${p.b} ${p.d}`).join('  ')}\n` +
  `closest pair ${worst.a}/${worst.b} at ${worst.d} (floor ${MIN_DIFF})`);

/* ====================================================================== arm */
console.log('\nSCENE arm — one tap, and the line along the top');
const ids = await pev('window.__ISLAND__.game.overview.metrics.ids');
const p1 = await pev(`__xy(${ids[0]})`);
await tap(p1.x, p1.y, 260);
/* The line fades in over 180ms and this page draws at a few frames a second,
   so a fixed sleep measures whatever the compositor happened to be part-way
   through. Poll until it has settled, and fail if it never does. */
for (let i = 0; i < 25; i++) {
  s = await pev('__sheet()');
  if (s.say.shown) break;
  await sleep(200);
}
await shot('build-armed');
claim('one tap arms that target and nothing is built yet',
  s.sel === ids[0] && s.open === true,
  `tapped (${p1.x},${p1.y}) -> sel=${s.sel} (wanted ${ids[0]}) roads on board=${s.roads}`);

claim('the "tap again" line is up, at the TOP of the screen, and takes no taps',
  s.say.shown === true && s.say.armed === true &&
  /tap again/i.test(s.say.text) && s.say.box.y < H * 0.25 &&
  s.say.pointer === 'none',
  `text="${s.say.text}" armed=${s.say.armed} box=${JSON.stringify(s.say.box)} ` +
  `(top ${((s.say.box.y / H) * 100).toFixed(0)}% of ${H}px) pointer-events=${s.say.pointer}`);

/* =================================================================== cancel */
console.log('\nSCENE cancel — a tap on open water takes the choice back');
const empty = await pev('__empty()');
await tap(empty.x, empty.y, 260);
s = await pev('__sheet()');
await shot('build-cancelled');
claim('tapping the map away from any target disarms it and the sheet STAYS OPEN',
  s.sel === null && s.open === true && s.mode === 'place-road' && s.roads === fade.roads,
  `tapped (${empty.x},${empty.y}), ${empty.clearPx}px clear of the nearest target ` +
  `(tap radius is ${empty.needPx}px)\n` +
  `sel=${s.sel} open=${s.open} mode=${s.mode} targets=${s.targets} ` +
  `roads on board ${fade.roads} -> ${s.roads} (nothing was built)`);
/* The gold "TAP AGAIN" goes; the quiet reminder comes BACK, because the sheet
   is still open and still waiting for exactly that tap. */
claim('the gold "tap again" line stands down to the idle reminder, not to nothing',
  s.say.shown === true && s.say.armed === false && /tap an edge/i.test(s.say.text),
  `say.shown=${s.say.shown} armed=${s.say.armed} text="${s.say.text}"`);

/* ===================================================================== stay */
console.log('\nSCENE stay — build one of three, and the sheet stays up');
const before = await pev('__sheet()');
const beforeChips = await pev('__chips()');
await pev('__watchTick()');
const p2 = await pev(`__xy(${ids[0]})`);
await tap(p2.x, p2.y, 200);          // arm
await tap(p2.x, p2.y, 500);          // build
s = await pev('__sheet()');
chips = await pev('__chips()');
want = await pev('__expected()');
await shot('build-stayed');
claim('two taps on the same edge build a road',
  s.roads === before.roads + 1,
  `roads on board ${before.roads} -> ${s.roads}; wood/brick ` +
  `${before.res.wood}/${before.res.brick} -> ${s.res.wood}/${s.res.brick}`);
claim('the sheet is still open, with a fresh set of legal edges and nothing armed',
  s.open === true && s.mode === 'place-road' && s.sel === null && s.targets > 0,
  `open=${s.open} mode=${s.mode} sel=${s.sel} targets ${before.targets} -> ${s.targets}`);
claim('the road chip has counted down and still matches the rules',
  chips.every(c => c.count === want[c.kind]) &&
  chips.find(c => c.kind === 'road').count === beforeChips.find(c => c.kind === 'road').count - 1,
  `road chip ${beforeChips.find(c => c.kind === 'road').count} -> ` +
  `${chips.find(c => c.kind === 'road').count}\n` +
  `shown  ${chips.map(c => `${c.kind}=${c.count}`).join(' ')}\n` +
  `truth  ${Object.keys(want).map(k => `${k}=${want[k]}`).join(' ')}`);

/* SOMETHING VISIBLE HAPPENED, AND IT WAS NOT A 10px DIGIT.
 *
 *   "Add a positive build confirmation. The only feedback in build-stayed is
 *    one 10px digit changing 3 to 2 inside a 52x38 chip. A player with three
 *    rivals moving will not notice. Flash or bounce the chip on decrement."
 *
 * Two answers and both are asserted: the chip bounces (recorded by an observer,
 * because the class is on for 620ms and this page draws every 300), and the
 * line at the top names what landed and what is left. */
const ticks = await pev('__ticks()');
claim('the chip that counted down BOUNCED, and only that one',
  ticks.includes('road') && !ticks.includes('settlement') &&
  !ticks.includes('city') && !ticks.includes('card'),
  `chips seen wearing the decrement bounce: ${JSON.stringify(ticks)} ` +
  `(recorded by a MutationObserver — the class is on for 620ms and this page ` +
  `draws every ${Math.round(1000 / fps)}ms)`);

claim('and the top line says what was built and how many are left',
  s.say.shown === true && /built/i.test(s.say.text) && /road/i.test(s.say.text),
  `say.text="${s.say.text}" armed=${s.say.armed}`);

/* =================================================================== switch */
console.log('\nSCENE switch — the chips change what the map is offering');
const settleChip = (await pev('__chips()')).find(c => c.kind === 'settlement');
await tap(settleChip.box.x + settleChip.box.w / 2, settleChip.box.y + settleChip.box.h / 2, 420);
/* Let the "built" line hand back to the idle one before the picture is taken,
   so the frame shows the state a player stands in and not a passing beat. */
for (let i = 0; i < 60; i++) {
  s = await pev('__sheet()');
  if (!/built/i.test(s.say.text)) break;
  await sleep(250);
}
chips = await pev('__chips()');
const sm = await pev('window.__ISLAND__.game.overview.metrics');
await shot('build-switch');
claim('tapping the settlement chip re-points the map at corners, in place',
  s.open === true && s.mode === 'place-settlement' && s.targets > 0 &&
  chips.find(c => c.kind === 'settlement').active === true,
  `mode=${s.mode} targets=${s.targets} active chip=` +
  `${(chips.find(c => c.active) || {}).kind}`);

/* ================================================ THE ONE THAT STOPPED IT
 *
 *   "THE SETTLEMENT CHIP SWITCHES THE MAP TO AN EMPTY BOARD. Diffing
 *    build-switch against build-stayed yields nine changed regions: two are the
 *    chip bar, five are the REMOVAL of white road ghosts ... Nothing was added.
 *    The chip reads 'x1' and is selected with a gold ring, the road candidates
 *    are cleared, and the player is left staring at a board with zero
 *    highlights and no hint text."
 *
 * Nothing was broken and that is why it took a photograph to find: two legal
 * corners were returned and both were painted, as 9px rings on a board whose
 * number discs are 26px and whose road invitations are 14.5px slabs. So the
 * proof has to be about SIZE and about INK, not about the target list:
 *
 *   SIZE  the corner invitation is now at least as big across as the road one,
 *         and it is measured against the piece it is inviting.
 *   INK   the canvas pixels around every reported target are read back and the
 *         gold ring is counted, against a control patch of open sea. A ring
 *         nobody can see does not pass this even when `targets` is right.
 *   WORDS the sheet says what to do, in corner-specific copy that did not
 *         exist before this loop ("the only copy is road-specific"). */
const ringPx = +(sm.targetR * 2).toFixed(1);
claim('a corner invitation is at least as big as a road one, and near a piece',
  ringPx >= sm.roadSlabW && ringPx >= sm.pipR,
  `corner ring ${ringPx}px across, road slab ${sm.roadSlabW}px, ` +
  `placed settlement ${sm.pipR * 2}px — an invitation smaller than the thing it ` +
  `invites reads as a hairline (the road slot has carried that note for months)`);

const inkAt = [];
for (const id of sm.ids) {
  const at = await pev(`__xy(${id})`);
  if (at) inkAt.push({ id, ...(await pev(`__ink(${JSON.stringify(at)},14)`)) });
}
const ctrl = await pev('__inkControl(14)');
claim('every offered corner has a visible ring painted on it',
  inkAt.length > 0 && inkAt.every(i => i.warmPct > ctrl.warmPct + 0.8),
  `open water control: ${ctrl.warmPct}% warm pixels\n` +
  inkAt.map(i => `corner ${i.id}: ${i.warmPct}% warm pixels in a 28x28 box`).join('\n'));

claim('and the sheet says what to do with them, in corner copy not road copy',
  s.say.shown === true && /corner/i.test(s.say.text) && s.say.armed === false,
  `say.text="${s.say.text}" (the road sheet says "tap an edge")`);

await claimBoardClear('settlement sheet');

const cityChip = chips.find(c => c.kind === 'city');
await tap(cityChip.box.x + cityChip.box.w / 2, cityChip.box.y + cityChip.box.h / 2, 380);
const after = await pev('__sheet()');
claim('tapping the greyed city chip does nothing at all',
  cityChip.count === 0 && after.mode === 'place-settlement' && after.open === true,
  `city chip x${cityChip.count} disabled=${cityChip.disabled}; ` +
  `mode after the tap=${after.mode} (unchanged) open=${after.open}`);

/* ===================================================================== last
 * The other half of the sentence: "if I can only build 1 based on the resources
 * I have it still closes". */
console.log('\nSCENE last — one road affordable, and the sheet closes behind it');
await pev(`(()=>{const o=window.__ISLAND__.game.overview; o.close(); return 1;})()`);
await sleep(400);
await pev(`__pack({wood:4,brick:4,wheat:0,wool:0,ore:0},0)`);
await openViaCard('road');
const one = await pev('__sheet()');
const oneChips = await pev('__chips()');
const ids2 = await pev('window.__ISLAND__.game.overview.metrics.ids');
const p3 = await pev(`__xy(${ids2[0]})`);
await tap(p3.x, p3.y, 200);
await tap(p3.x, p3.y, 600);
const closed = await pev('__sheet()');
await shot('build-closed');
claim('with exactly one road affordable the bar says x1',
  oneChips.find(c => c.kind === 'road').count === 1,
  oneChips.map(c => `${c.kind}=${c.count}`).join(' ') + `  pack=${JSON.stringify(one.res)}`);
claim('building it spends the last of the pack and CLOSES the sheet',
  closed.open === false && closed.roads === one.roads + 1,
  `open ${one.open} -> ${closed.open}; roads ${one.roads} -> ${closed.roads}; ` +
  `pack ${JSON.stringify(one.res)} -> ${JSON.stringify(closed.res)}`);

/* ===================================================================== free
 * Free roads are a separate currency: an empty pack and two owed roads is a
 * road chip reading x2. The map is raised by main.js's own reconciler here,
 * exactly as it is when a Road Building card is played. */
console.log('\nSCENE free — two owed roads on an empty pack');
/* Wait for the sheet from the previous scene to be all the way down first:
   main.js only offers the free-road map on a frame where nothing else owns the
   screen, so crediting the debt while the old sheet is still fading is a debt
   that sits there until the next frame that happens to be clear. */
for (let i = 0; i < 30; i++) {
  if ((await pev('__sheet()')).open === false) break;
  await sleep(200);
}
await pev(`__pack({wood:0,brick:0,wheat:0,wool:0,ore:0},2)`);
let freeUp = null, freeChips = null;
for (let i = 0; i < 60; i++) {
  freeUp = await pev('__sheet()');
  freeChips = await pev('__chips()');
  if (freeUp.open && freeUp.mode === 'place-road' &&
      freeChips.find(c => c.kind === 'road').count === 2) break;
  await sleep(250);
}
const freeWant = await pev('__expected()');
const freeBar = await pev('__bar()');
const freeX = await pev('__closeKey()');
await shot('build-freeroads');
claim('the road chip counts two free roads even with nothing in the pack',
  freeUp.open === true && freeChips.find(c => c.kind === 'road').count === 2 &&
  freeChips.find(c => c.kind === 'road').free === true &&
  freeChips.every(c => c.count === freeWant[c.kind]),
  `pack=${JSON.stringify(freeUp.res)} freeRoads=${freeUp.freeRoads}\n` +
  `shown  ${freeChips.map(c => `${c.kind}=${c.count}${c.free ? ' (free)' : ''}`).join(' ')}\n` +
  `truth  ${Object.keys(freeWant).map(k => `${k}=${freeWant[k]}`).join(' ')}`);

/* AND IT DOES NOT LOOK LIKE AN ORDINARY ROAD BUILD ANY MORE.
 *
 *   "build-freeroads-640x320.png is visually identical to a normal road build
 *    despite the count being card-granted free roads. Say so, and either
 *    disable the X or warn that closing forfeits the remaining free road."
 *
 * A gold tab on the tile, the count in the card's own gold, the line at the top
 * saying how many are owed, and the close key carrying the answer to "what
 * happens if I leave" — which is that nothing is forfeit, because economy.js
 * defers the debt and main.js re-offers it. That is why the X stays live. */
claim('the free-roads sheet says in words that these roads are card-paid',
  freeBar.chips.find(c => c.kind === 'road').flag === true &&
  /free road/i.test(freeUp.say.text) && freeUp.say.shown === true &&
  /free road/i.test(String(freeX && freeX.label)),
  `FREE tab on the road tile: ${freeBar.chips.find(c => c.kind === 'road').flag}\n` +
  `top line: "${freeUp.say.text}"\n` +
  `close key reads: "${freeX && freeX.label}"`);

/* Lay one of the two and prove the sheet holds for the second. */
const idsF = await pev('window.__ISLAND__.game.overview.metrics.ids');
const pf = await pev(`__xy(${idsF[0]})`);
await tap(pf.x, pf.y, 200);
await tap(pf.x, pf.y, 700);
const afterFree = await pev('__sheet()');
const afterFreeChips = await pev('__chips()');
claim('laying the first free road leaves the sheet open on the second',
  afterFree.open === true && afterFree.freeRoads === 1 &&
  afterFreeChips.find(c => c.kind === 'road').count === 1,
  `freeRoads ${freeUp.freeRoads} -> ${afterFree.freeRoads}; ` +
  `roads ${freeUp.roads} -> ${afterFree.roads}; ` +
  `road chip ${freeChips.find(c => c.kind === 'road').count} -> ` +
  `${afterFreeChips.find(c => c.kind === 'road').count}; open=${afterFree.open}`);

/* =================================================================== report */
if (shotFails.length) claim('every evidence frame was actually captured', false,
  `these screenshots came back empty twice: ${shotFails.join(', ')}`);
const bad = checks.filter(c => !c.pass);
console.log(`\n${checks.length - bad.length}/${checks.length} claims hold at ${TAG}`);
if (exceptions.length) {
  console.log(`${exceptions.length} page exception(s)`);
  for (const e of exceptions.slice(0, 6)) console.log('  EXC ' + String(e).split('\n')[0].slice(0, 180));
}
ws.close(); chrome.kill('SIGKILL');
process.exit(bad.length ? 1 : 0);
