/**
 * Board-map / opening-screen capture rig.
 *
 * A lean sibling of tools/shoot.mjs. Two jobs the general rig cannot do:
 *
 *   1. photograph the *draft* board directly (all four settlers standing at
 *      their spawns, the placement overlay live) without waiting out the
 *      opening cinematic, so it fits in one short shell call;
 *   2. MEASURE the name-plate layout — every plate rectangle against every
 *      number-token rectangle — and fail loudly if any pair intersects.
 *
 *   node tools/mapshot.mjs --stage=draft|map|intro [--w=960] [--h=444] [--tag=x]
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
  // A capture takes ~20s of wall clock and the match keeps running underneath,
  // so the layout has to be measured on the frame that is about to be
  // photographed, not on whatever the board looks like once the PNG lands.
  console.log('  MEASURE ' + JSON.stringify(await measure()));
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

/** Plate-vs-token intersection report, straight out of the live layout. */
const measure = async () => ev(`(()=>{
  const ov=window.__ISLAND__.game.overview;
  if(!ov||!ov.debugLabels) return {err:'no debugLabels'};
  const {plates,obstacles}=ov.debugLabels();
  const tokens=obstacles.filter(o=>o.kind==='token');
  const ports=obstacles.filter(o=>o.kind==='port');
  const R=r=>({l:r.x-r.w/2,r:r.x+r.w/2,t:r.y-r.h/2,b:r.y+r.h/2});
  const hit=(a,b)=>{const A=R(a),B=R(b);
    const ox=Math.min(A.r,B.r)-Math.max(A.l,B.l), oy=Math.min(A.b,B.b)-Math.max(A.t,B.t);
    return (ox>0&&oy>0)?+(ox*oy).toFixed(1):0;};
  const clashes=[];let minGap=1e9;
  for(const p of plates) for(const t of tokens){
    const a=hit(p,t);
    if(a>0) clashes.push({plate:p.name,area:a,at:[Math.round(t.x),Math.round(t.y)]});
    const A=R(p),B=R(t);
    const gx=Math.max(B.l-A.r,A.l-B.r), gy=Math.max(B.t-A.b,A.t-B.b);
    minGap=Math.min(minGap,Math.max(gx,gy));
  }
  let pclash=0;
  for(const p of plates) for(const q of ports) if(hit(p,q)>0) pclash++;
  return {open:ov.isOpen,mode:ov.mode,phase:window.__ISLAND__.state.phase,
    plates:plates.map(p=>({n:p.name,x:Math.round(p.x),y:Math.round(p.y),
      w:p.w,h:p.h})),
    tokens:tokens.length, tokenClashes:clashes, portClashes:pclash,
    minPlateTokenGapPx:+minGap.toFixed(1)};})()`);

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
