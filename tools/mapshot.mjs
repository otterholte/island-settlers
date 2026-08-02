/**
 * Board-map / boot-splash capture rig.
 *
 * A lean sibling of tools/shoot.mjs. Two jobs the general rig cannot do:
 *
 *   1. photograph the *draft* board directly (all four settlers standing at
 *      their spawns, the placement overlay live) without waiting out the
 *      opening cinematic, so it fits in one short shell call;
 *   2. photograph the `#boot` splash, which is gone by the time shoot.mjs's
 *      "has the game published __ISLAND__ yet" gate opens. The `boot` stage
 *      captures on a timer from the moment of navigation instead, and pins the
 *      splash open so a slow-to-fade screen is still photographable.
 *
 *   node tools/mapshot.mjs --stage=boot|draft|map|intro [--w=960] [--h=444]
 *
 * The board no longer carries name plates, so there is nothing left to measure
 * here: "no text sits on a hex" is now true by construction (src/ui/ovmap.js
 * paints one pin for the human and nothing else).
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

const W = +arg('w', 960);
const H = +arg('h', 444);
const OUT = resolve(ROOT, arg('out', 'progress/shots'));
const PORT = +arg('port', 5173);
const STAGE = arg('stage', 'draft');
const TAG = arg('tag', `${W}x${H}`);
const CHROME = arg('chrome', '/tmp/chrome-headless-shell-linux64/chrome-headless-shell');
const LIBS = arg('libs', '/tmp/xlibs/root/usr/lib/x86_64-linux-gnu');

mkdirSync(OUT, { recursive: true });
if (!existsSync(CHROME)) { console.error(`no chrome at ${CHROME}`); process.exit(2); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

const DP = 9833 + Math.floor(Math.random() * 400);
// `--run-all-compositor-stages-before-draw` makes a capture cost ~22s under
// SwiftShader, which does not fit in one shell call alongside boot. The scene
// is left to settle for seconds before every shot anyway, so it is opt-in.
const SLOW = arg('slow', '0') === '1';
const chrome = spawn(CHROME, [
  '--headless', '--no-sandbox', '--disable-dev-shm-usage',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  ...(SLOW ? ['--run-all-compositor-stages-before-draw'] : []),
  '--disable-new-content-rendering-timeout',
  '--hide-scrollbars', '--mute-audio',
  `--window-size=${W},${H}`, `--remote-debugging-port=${DP}`, 'about:blank'
], {
  env: { ...process.env, LD_LIBRARY_PATH: `${LIBS}:${process.env.LD_LIBRARY_PATH || ''}` },
  stdio: ['ignore', 'ignore', 'pipe']
});
let chromeErr = '';
chrome.stderr.on('data', d => { chromeErr += d.toString(); });

let wsUrl;
for (let i = 0; i < 50; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${DP}/json/list`);
    const p = (await r.json()).find(t => t.type === 'page');
    if (p) { wsUrl = p.webSocketDebuggerUrl; break; }
  } catch { /* not up */ }
  await sleep(200);
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
    warnings.push((m.params.args || []).map(a => a.value ?? a.description ?? '').join(' '));
  }
});

const send = (method, params = {}) => new Promise(res => {
  const id = ++msgId;
  pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); res({ __err: "timeout" }); } }, 40000);
});

const ev = async (expr, awaitPromise = false) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
  if (r?.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
  return r?.result?.value;
};

const NOSHOT = arg('noshot', '0') === '1';

const shot = async name => {
  if (NOSHOT) { console.log(`  (skipped ${name})`); return; }
  const t0 = Date.now();
  console.log(`  capturing ${name} at +${at()}`);
  const r = await send('Page.captureScreenshot', { format: 'png' });
  console.log(`  capture took ${Date.now() - t0}ms`);
  if (!r?.data) { console.log(`  shot ${name} FAILED`); return; }
  const buf = Buffer.from(r.data, 'base64');
  writeFileSync(resolve(OUT, `${name}.png`), buf);
  console.log(`  shot ${name}.png (${(buf.length / 1024).toFixed(0)} KB)`);
};

await send('Page.enable'); await send('Runtime.enable');

/* --------------------------------------------------------------- boot stage
   The splash is torn down the instant main.js finishes, so this stage cannot
   use the "wait for __ISLAND__" gate every other stage relies on. Instead the
   page is asked, on document-start, to hold `#boot` open: a MutationObserver
   strips the `done` class back off, and the page is photographed on a plain
   timer. `--hold=0` lets the handoff run for real so the cross-fade into the
   opening screen can be watched. */
if (STAGE === 'boot') {
  const HOLD = arg('hold', '1') === '1';
  const WAIT = +arg('wait', 2200);
  if (HOLD) {
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(()=>{const keep=()=>{const b=document.getElementById('boot');
        if(b&&b.classList.contains('done'))b.classList.remove('done');};
        setInterval(keep,50);})()`
    });
  }
  const t0 = Date.now();
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });
  await sleep(WAIT);
  console.log(`boot splash at +${((Date.now() - t0) / 1000).toFixed(1)}s (held=${HOLD})`);
  console.log('  STATE ' + JSON.stringify(await ev(`(()=>{const b=document.getElementById('boot');
    if(!b) return {err:'no #boot'};
    const r=b.getBoundingClientRect(); const cs=getComputedStyle(b);
    const tip=document.querySelector('.bs-tip');
    const fill=document.querySelector('.bs-fill');
    return {cls:b.className, box:[Math.round(r.width),Math.round(r.height)],
      opacity:cs.opacity, tip:tip?tip.textContent.trim():null,
      fill:fill?getComputedStyle(fill).width:null,
      scrollW:document.documentElement.scrollWidth,
      scrollH:document.documentElement.scrollHeight,
      vw:innerWidth, vh:innerHeight};})()`)));
  const b = await send('Page.captureScreenshot', { format: 'png' });
  if (b?.data) {
    const buf = Buffer.from(b.data, 'base64');
    writeFileSync(resolve(OUT, `boot-${TAG}.png`), buf);
    console.log(`  shot boot-${TAG}.png (${(buf.length / 1024).toFixed(0)} KB)`);
  } else console.log('  shot boot FAILED');
  console.log(`${exceptions.length} exception(s), ${warnings.length} console error/warning(s)`);
  for (const e of exceptions.slice(0, 6)) console.log('  EXC ' + String(e).split('\n')[0].slice(0, 200));
  ws.close(); chrome.kill('SIGKILL');
  process.exit(exceptions.length === 0 ? 0 : 1);
}

await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });

let booted = false;
for (let i = 0; i < 40; i++) {
  if (await ev('!!(window.__ISLAND__&&window.__ISLAND__.state)') === true) { booted = true; break; }
  await sleep(250);
}
if (!booted) { console.error('GAME DID NOT BOOT'); ws.close(); chrome.kill('SIGKILL'); process.exit(1); }
const T0 = Date.now();
console.log(`booted ${W}x${H} at ${(process.uptime()).toFixed(1)}s`);
const at = () => ((Date.now() - T0) / 1000).toFixed(1) + 's';

await ev(`import('/src/core/rules.js').then(m=>{window.__R__=m}).then(()=>1)`, true);
await ev(`import('/src/board/nodes.js').then(m=>{window.__N__=m}).then(()=>1)`, true);

const finishDraft = async () => ev(`(()=>{const {state}=window.__ISLAND__,R=window.__R__;
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

/**
 * What is actually painted over the board. There are no name plates left to
 * measure, so this reports the thing that replaced them: the overview's own
 * canvas, its mode, and every interface node that sits over the map — proof
 * that the hexes carry no text.
 */
const measure = async () => ev(`(()=>{
  const ov=window.__ISLAND__.game.overview;
  if(!ov) return {err:'no overview'};
  const over=[...document.querySelectorAll('.ov *')]
    .filter(n=>{const t=(n.textContent||'').trim();
      return t && n.children.length===0 && n.getBoundingClientRect().width>1;})
    .map(n=>String(n.className).split(' ')[0]||n.tagName);
  return {open:ov.isOpen,mode:ov.mode,phase:window.__ISLAND__.state.phase,
    hasDebugLabels:typeof ov.debugLabels==='function',
    textNodesOverMap:[...new Set(over)]};})()`);

if (STAGE === 'intro') {
  await sleep(2600);
  await shot(`ov-intro-${TAG}`);

} else if (STAGE === 'draft') {
  // The exact board the player complained about: nobody has built yet and all
  // four settlers are standing shoulder to shoulder around the market.
  await sleep(300);
  await ev(`(()=>{window.__ISLAND__.game.flow.skipIntro();return 1})()`);
  await sleep(1500);
  // Belt and braces: if the flow has not opened the map yet, open it the way
  // the flow would, so the stage always photographs the same board.
  await ev(`(()=>{const g=window.__ISLAND__.game;
    if(!g.overview.isOpen) g.overview.open('place-settlement',{setup:true,
      cancellable:false,title:'Claim Your Corner',
      hint:'High pips · three resources · a dock'});
    return g.overview.isOpen})()`);
  await sleep(350);
  await shot(`ov-draft-${TAG}`);
  console.log('  MEASURE-after ' + JSON.stringify(await measure()));

} else if (STAGE === 'hud') {
  /* The in-world HUD with the ground report live. The settler is walked onto a
     hex they actually own so the bottom-left plate is showing, which is the
     state check 18 has to survive: `.hud-bl` and `.hud-bc` on screen together.
     Every gather status is then read straight out of the DOM. */
  await finishDraft();
  await ev(`(()=>{const {state,game}=window.__ISLAND__;
    const L=window.__L__; return 1})()`);
  await ev(`import('/src/board/layout.js').then(m=>{window.__L__=m}).then(()=>1)`, true);
  /* `where`: mine | other | knight | swept. Every case is produced the way the
     game produces it — walk there, and for `swept` actually collect the field
     through rules.collectItem rather than poking a flag. */
  const stand = async where => ev(`(()=>{const {state,game}=window.__ISLAND__;
    const L=window.__L__,N=window.__N__,W=${JSON.stringify(where)};
    const me=state.players[0]; const owned=new Set();
    state.robberTile=L.DESERT.id; state.robberOwner=-1;
    for(const iid of me.settlements) for(const t of L.intersections[iid].tiles) owned.add(t);
    for(const t of L.tiles) if(t.resource) N.restoreTile(t.id);
    const pick = W==='other'
      ? L.tiles.find(t=>t.resource&&!owned.has(t.id))
      : L.tiles.find(t=>t.resource&&owned.has(t.id));
    if(!pick) return 'no tile';
    me.x=pick.x; me.z=pick.z; me.vx=0; me.vz=0;
    if(W==='knight'){ state.robberTile=pick.id; state.robberOwner=1; }
    if(W==='swept') for(const it of N.tileItems(pick.id)) N.collectItem(it,state.time,0);
    for(let i=0;i<20;i++){ game.gathering.update(1/60); game.hud.update(1/60); }
    const g=game.gathering;
    return {tile:pick.id, terrain:pick.terrain, status:g.statusHere(0),
      left:g.tileItemsRemaining(pick.id),
      txt:(document.querySelector('.pr-txt')||{}).textContent,
      sub:(document.querySelector('.pr-sub')||{}).textContent,
      hidden:(document.querySelector('.prompt')||{className:''}).className.indexOf('hid')>=0};})()`);
  console.log('  MINE     ' + JSON.stringify(await stand('mine')));
  console.log('  UNOWNED  ' + JSON.stringify(await stand('other')));
  console.log('  KNIGHT   ' + JSON.stringify(await stand('knight')));
  console.log('  SWEPT    ' + JSON.stringify(await stand('swept')));
  console.log('  MINE     ' + JSON.stringify(await stand('mine')));

  /* The layout assertion behind check 18, run in the state check 18 does not
     reach on its own: the bottom-left ground report AND the bottom-centre
     build row on screen at the same time, at both supported sizes. */
  for (const [w, h] of [[960, 444], [667, 375]]) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: w, height: h, deviceScaleFactor: 1, mobile: true
    });
    await ev(`dispatchEvent(new Event('resize'))`);
    await sleep(450);
    await stand('mine');
    await sleep(250);
    console.log(`  FIT ${w}x${h} ` + JSON.stringify(await ev(`(()=>{
      const r=s=>{const n=document.querySelector(s); if(!n) return null;
        const b=n.getBoundingClientRect();
        return {t:Math.round(b.top),b:Math.round(b.bottom),l:Math.round(b.left),r:Math.round(b.right)};};
      const shown=n=>n.checkVisibility?n.checkVisibility({opacityProperty:true,
        visibilityProperty:true,contentVisibilityAuto:true}):!!n.offsetParent;
      const off=[];
      for(const n of document.querySelectorAll('#ui *')){
        const b=n.getBoundingClientRect();
        if(b.width<2||b.height<2||!shown(n))continue;
        if(b.right>innerWidth+2||b.bottom>innerHeight+2||b.left<-2||b.top<-2)
          off.push(String(n.className).slice(0,32)+':'+Math.round(b.bottom));}
      return {vh:innerHeight,vw:innerWidth,app:r('#app'),bl:r('.hud-bl'),
        bc:r('.hud-bc'),br:r('.hud-br'),
        promptShown:!(document.querySelector('.prompt')||{className:'hid'})
          .className.includes('hid'),
        offscreen:off};})()`)));
  }
  await send('Emulation.clearDeviceMetricsOverride');
  await ev(`dispatchEvent(new Event('resize'))`);
  await sleep(500);
  await stand('mine');
  await sleep(400);
  await shot(`hud-${TAG}`);

} else if (STAGE === 'map') {
  await finishDraft();
  await sleep(300);
  await ev(`window.__ISLAND__.game.openOverview('view')`);
  await sleep(600);
  await shot(`ov-map-${TAG}`);
  console.log('  MEASURE-after ' + JSON.stringify(await measure()));
}

console.log(`${exceptions.length} exception(s), ${warnings.length} console error/warning(s)`);
for (const e of exceptions.slice(0, 6)) console.log('  EXC ' + String(e).split('\n')[0].slice(0, 200));
for (const w of warnings.slice(0, 6)) console.log('  WARN ' + String(w).slice(0, 200));

ws.close(); chrome.kill('SIGKILL');
process.exit(exceptions.length === 0 ? 0 : 1);
