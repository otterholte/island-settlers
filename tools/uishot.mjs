/**
 * Tutorial / opening-screen capture and measurement rig.
 *
 * A third sibling of tools/shoot.mjs and tools/mapshot.mjs, for the surfaces
 * neither of them can reach: the opening screen's layout arithmetic, the rules
 * book, and the guided practice run.
 *
 *   node tools/uishot.mjs --stage=home      [--w=960] [--h=444] [--shot=1]
 *   node tools/uishot.mjs --stage=splash
 *   node tools/uishot.mjs --stage=book      [--page=0]
 *   node tools/uishot.mjs --stage=practice  [--step=3]
 *
 * `home` is the one that matters most: it MEASURES element rectangles rather
 * than photographing them and hoping. The opening screen's primary button
 * carries a 7px hard under-lip and a 3px idle float, neither of which is part
 * of its layout box, so the assertion is `hint.top - (button.bottom + 10) > 0`.
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
const OUT = resolve(ROOT, arg('out', 'progress/tut'));
const PORT = +arg('port', 5173);
const STAGE = arg('stage', 'home');
const TAG = arg('tag', `${W}x${H}`);
const SHOT = arg('shot', '1') === '1';
const CHROME = arg('chrome', '/tmp/chrome-headless-shell-linux64/chrome-headless-shell');
const LIBS = arg('libs', '/tmp/xlibs/root/usr/lib/x86_64-linux-gnu');

mkdirSync(OUT, { recursive: true });
if (!existsSync(CHROME)) { console.error(`no chrome at ${CHROME}`); process.exit(2); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

const DP = 9200 + Math.floor(Math.random() * 500);
const chrome = spawn(CHROME, [
  '--headless', '--no-sandbox', '--disable-dev-shm-usage',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--disable-new-content-rendering-timeout', '--hide-scrollbars', '--mute-audio',
  // Headless throttles timers on a page it thinks nobody is looking at, which
  // makes a 2.6s setTimeout land four seconds late and the splash measurement
  // meaningless. These three put the page back on a foreground clock.
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
  } catch { /* not up */ }
  await sleep(180);
}
if (!wsUrl) { console.error('devtools never came up\n' + chromeErr.slice(-500)); process.exit(2); }

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
  if (m.method === 'Runtime.consoleAPICalled' && /error|warning/.test(m.params.type)) {
    const t = (m.params.args || []).map(a => a.value ?? a.description ?? '').join(' ');
    if (!/AudioContext/.test(t)) warnings.push(t);
  }
});
const warnings = [];
const send = (method, params = {}) => new Promise(res => {
  const id = ++msgId;
  pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); res({ __err: 'timeout' }); } }, 40000);
});
const ev = async (expr, awaitPromise = false) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
  if (r?.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
  return r?.result?.value;
};
/* A SwiftShader capture of this scene costs 10-25s, and the variance is what
   kills a 45s shell call. `--fmt=jpeg` trades a little fidelity for a capture
   that reliably lands. */
const FMT = arg('fmt', 'png');
const shot = async name => {
  if (!SHOT) { console.log(`  (no shot ${name})`); return; }
  const t0 = Date.now();
  const p = FMT === 'jpeg' ? { format: 'jpeg', quality: +arg('q', 82) } : { format: 'png' };
  const sc = +arg('scale', 1);
  if (sc !== 1) p.clip = { x: 0, y: 0, width: W, height: H, scale: sc };
  const r = await send('Page.captureScreenshot', p);
  if (!r?.data) { console.log(`  shot ${name} FAILED`); return; }
  const buf = Buffer.from(r.data, 'base64');
  writeFileSync(resolve(OUT, `${name}.${FMT === 'jpeg' ? 'jpg' : 'png'}`), buf);
  console.log(`  shot ${name} (${(buf.length / 1024).toFixed(0)} KB, ${Date.now() - t0}ms)`);
};

await send('Page.enable'); await send('Runtime.enable');

/* `--fake=N` stands in for a fast device: it flags the world ready N ms after
   the document starts, which is what a desktop actually does and what
   SwiftShader (25s to build the scene) never can. That is the only way to see
   the minimum hold do its job. */
/* --------------------------------------------------------------- art sheet
   A contact sheet of every rules illustration at the real size the book gives
   it, drawn without booting the 3D world at all — main.js is blocked, so this
   run costs two seconds instead of twenty-five and the pictures can actually
   be iterated on. */
if (STAGE === 'art') {
  const CW = +arg('cw', 305), CH = +arg('ch', 245), COLS = +arg('cols', 3);
  await send('Network.enable');
  await send('Network.setBlockedURLs', { urls: ['*/src/main.js'] });
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });
  await sleep(900);
  const n = await ev(`import('/src/systems/flowTutArt.js').then(m=>{
    const names=['goal','land','number','ownership','contact',
                 'recovery','build','trade','cards','awards'];
    const b=document.getElementById('boot'); if(b)b.remove();
    const wrap=document.createElement('div');
    wrap.id='sheet';
    wrap.style.cssText='position:absolute;left:0;top:0;z-index:99;display:flex;'+
      'flex-wrap:wrap;gap:8px;padding:8px;width:${(CW + 8) * COLS + 16}px;background:#3a2a18';
    document.body.appendChild(wrap);
    const dpr=2;
    for(const nm of names){
      const box=document.createElement('div');
      box.style.cssText='width:${CW}px;height:${CH}px;border-radius:12px;overflow:hidden;'+
        'border:2px solid #5a3a1e;background:linear-gradient(180deg,#fffaee,#ead9b4)';
      const c=document.createElement('canvas');
      c.width=${CW}*dpr; c.height=${CH}*dpr;
      c.style.cssText='width:${CW}px;height:${CH}px;display:block';
      box.appendChild(c); wrap.appendChild(box);
      const g=c.getContext('2d'); g.setTransform(dpr,0,0,dpr,0,0);
      m.paintScene(nm,g,${CW},${CH});
    }
    return wrap.getBoundingClientRect().height;
  })`, true);
  console.log('  sheet height ' + JSON.stringify(n));
  const r = await send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: (CW + 8) * COLS + 16, height: Math.ceil(+n || 1000), scale: 1 }
  });
  if (r?.data) {
    writeFileSync(resolve(OUT, `art-sheet.png`), Buffer.from(r.data, 'base64'));
    console.log('  shot art-sheet.png');
  } else console.log('  art sheet FAILED ' + JSON.stringify(r).slice(0, 200));
  for (const e of exceptions.slice(0, 5)) console.log('  EXC ' + String(e).split('\n')[0].slice(0, 200));
  ws.close(); chrome.kill('SIGKILL');
  process.exit(0);
}

const FAKE = +arg('fake', 0);
if (STAGE === 'splash' && FAKE > 0) {
  // main.js is blocked as well as faked: SwiftShader spends ~20s of solid
  // main-thread work building the scene, which starves every timer on the
  // page. Blocking it leaves the splash alone on the thread, which is the
  // condition a real phone is in, and lets the hold be measured honestly.
  await send('Network.enable');
  await send('Network.setBlockedURLs', { urls: ['*/src/main.js'] });
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `setTimeout(function(){var b=document.getElementById('boot');
      if(b)b.classList.add('done');},${FAKE});`
  });
}

const T0 = Date.now();
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });

if (STAGE === 'splash') {
  // Watch the real handoff rather than the artwork: the inline splash script
  // publishes when the world became ready and when the bloom actually fired.
  for (let i = 0; i < 150; i++) {
    const s = await ev('window.__SPLASH__ && window.__SPLASH__.handoffAt');
    if (typeof s === 'number' && s > 0) break;
    await sleep(200);
  }
  console.log('  SPLASH ' + JSON.stringify(await ev(`(()=>{const s=window.__SPLASH__||{};
    const b=document.getElementById('boot');
    return {minHold:s.minHold,land:s.land,
      worldReadyAt:Math.round(s.readyAt),
      heldExtraMs:Math.round(s.waitMs),
      scheduledHandoffAt:Math.round(s.readyAt+s.waitMs+s.land),
      barLandedAt:Math.round(s.landedAt),
      observedHandoffAt:Math.round(s.handoffAt),
      cls:b?b.className:'gone'};})()`)));
  console.log(`${exceptions.length} exception(s)`);
  for (const e of exceptions.slice(0, 5)) console.log('  EXC ' + String(e).split('\n')[0].slice(0, 180));
  ws.close(); chrome.kill('SIGKILL');
  process.exit(exceptions.length ? 1 : 0);
}

let booted = false;
for (let i = 0; i < 90; i++) {
  if (await ev('!!(window.__ISLAND__&&window.__ISLAND__.state)') === true) { booted = true; break; }
  await sleep(250);
}
if (!booted) { console.error('GAME DID NOT BOOT\n' + chromeErr.slice(-400)); ws.close(); chrome.kill('SIGKILL'); process.exit(1); }
console.log(`booted ${W}x${H} in ${((Date.now() - T0) / 1000).toFixed(1)}s`);

/* Wait for the opening screen to be fully up (the splash now holds ~3s). */
const waitIntro = async () => {
  for (let i = 0; i < 40; i++) {
    const on = await ev(`(()=>{const n=document.querySelector('.mf-intro');
      return !!(n&&n.classList.contains('on'));})()`);
    if (on === true) return true;
    await sleep(200);
  }
  console.log('  !! opening screen never came up: ' + JSON.stringify(await ev(
    `(()=>{const n=document.querySelector('.mf-intro');
      return {found:!!n,cls:n?n.className:null,
        stage:(window.__ISLAND__.game.flow||{}).stage,
        phase:window.__ISLAND__.state.phase};})()`)));
  for (const e of exceptions.slice(0, 4)) console.log('  EXC ' + String(e).split('\n')[0].slice(0, 220));
  for (const t of warnings.slice(0, 6)) console.log('  WARN ' + String(t).slice(0, 220));
  return false;
};

/** Rectangles of the opening screen, plus the overlap arithmetic. */
const MEASURE_INTRO = `(()=>{
  const R=s=>{const n=document.querySelector(s);if(!n)return null;
    const r=n.getBoundingClientRect();
    return {sel:s,x:+r.left.toFixed(1),y:+r.top.toFixed(1),
      w:+r.width.toFixed(1),h:+r.height.toFixed(1),
      right:+r.right.toFixed(1),bottom:+r.bottom.toFixed(1)};};
  const play=R('.mf-play'), tut=R('.mf-tut'), hint=R('.mf-i-hint');
  const LIP=7, FLOAT=3;
  const out={vw:innerWidth,vh:innerHeight,
    title:R('.mf-i-title'),obj:R('.mf-i-obj'),me:R('.mf-cmp'),
    diff:R('.mf-i-drow'),play,tut,hint,
    rivals:document.querySelectorAll('.mf-cmp').length,
    scrollW:document.documentElement.scrollWidth,
    scrollH:document.documentElement.scrollHeight};
  if(play&&hint){
    out.gapPlayToHint=+(hint.y-play.bottom).toFixed(1);
    out.clearanceAfterLip=+(hint.y-play.bottom-LIP-FLOAT).toFixed(1);
    out.overlaps=out.clearanceAfterLip<0;
  }
  if(tut&&hint) out.gapTutToHint=+(hint.y-tut.bottom).toFixed(1);
  if(play&&tut) out.gapPlayToTut=+(tut.x-play.right).toFixed(1);
  out.tapTargets=[...document.querySelectorAll('.mf-intro button')]
    .map(b=>{const r=b.getBoundingClientRect();
      return {lab:(b.textContent||'').trim().slice(0,18),
        w:Math.round(r.width),h:Math.round(r.height)};});
  const rects=[...document.querySelectorAll('.mf-intro > *, .mf-i-foot > *, .mf-i-cta > *')]
    .map(n=>({c:String(n.className).split(' ')[0],
      t:Math.round(n.getBoundingClientRect().top),
      b:Math.round(n.getBoundingClientRect().bottom)}));
  out.stack=rects;
  return out;})()`;

if (STAGE === 'home') {
  await waitIntro();
  await sleep(350);
  console.log('  INTRO ' + JSON.stringify(await ev(MEASURE_INTRO)));
  await shot(`home-${TAG}`);

} else if (STAGE === 'book') {
  // The book does not need the opening screen to be on screen — the TUTORIAL
  // button is pressed here, but going through the real button means waiting
  // out the splash hold as well, and this stage is about the book.
  console.log('  open ' + await ev(`(()=>{const b=document.querySelector('.mf-tut');
    if(b){b.click();return 'clicked the real button';}
    window.__ISLAND__.game.tutorial.openBook();return 'opened directly';})()`));
  await sleep(400);
  const PAGE = +arg('page', -1);
  if (PAGE >= 0) {
    await ev(`(()=>{document.querySelector('.tut-route.read').click();return 1})()`);
    await sleep(300);
    for (let i = 0; i < PAGE; i++) {
      await ev(`(()=>{const n=[...document.querySelectorAll('.tut-nav .btn')];
        n[n.length-1].click();return 1})()`);
      await sleep(120);
    }
    await sleep(400);
  }
  // A capture costs 11-17s under SwiftShader, and most of it is the software
  // compositor: the 3D island still rendering behind the modal, plus the
  // scrim's backdrop blur. Neither is what this stage photographs.
  if (arg('hidegl', '0') === '1') {
    await ev(`(()=>{const c=document.getElementById('gl');if(c)c.style.display='none';
      const s=document.querySelector('.tut-scrim');
      if(s){s.style.backdropFilter='none';s.style.webkitBackdropFilter='none';
        s.style.background='rgba(4,14,28,.92)';}
      window.__ISLAND__.game.camera.update=()=>{};return 1})()`);
    await sleep(250);
  }
  console.log('  BOOK ' + JSON.stringify(await ev(`(()=>{
    const R=s=>{const n=document.querySelector(s);if(!n)return null;
      const r=n.getBoundingClientRect();
      return [Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)];};
    const cv=document.querySelector('.tut-art canvas');
    return {sheet:R('.tut-sheet'),art:R('.tut-art'),copy:R('.tut-copy'),
      nav:R('.tut-nav'),routes:R('.tut-routes'),
      title:(document.querySelector('.tut-title')||{}).textContent,
      count:(document.querySelector('.tut-count')||{}).textContent,
      canvas:cv?[cv.width,cv.height]:null,
      head:(document.querySelector('.tut-h')||{}).textContent,
      vh:innerHeight,scrollH:document.documentElement.scrollHeight};})()`)));
  await shot(`book-${PAGE >= 0 ? 'p' + PAGE : 'menu'}-${TAG}`);

} else if (STAGE === 'practice') {
  await waitIntro();
  await sleep(400);
  const STEP = +arg('step', 0);
  if (arg('via', 'api') === 'route') {
    // The route a player actually takes: TUTORIAL on the opening screen, then
    // PRACTICE RUN in the book. Nothing here calls startPractice() directly.
    console.log('  tap TUTORIAL ' + await ev(`(()=>{const b=document.querySelector('.mf-tut');
      if(!b)return 'missing';b.click();return 'ok';})()`));
    await sleep(500);
    console.log('  tap PRACTICE ' + await ev(`(()=>{const b=document.querySelector('.tut-route.play');
      if(!b)return 'missing';b.click();return 'ok';})()`));
  } else {
    console.log('  start ' + await ev(`(()=>{const t=window.__ISLAND__.game.tutorial;
      if(!t)return 'no tutorial';t.startPractice();return t.step+'/'+t.stepCount;})()`));
  }
  await sleep(900);
  // Walk the run forward the way the Skip control does, so a late step can be
  // photographed without simulating a human thumb for two minutes.
  for (let i = 0; i < STEP; i++) {
    await ev(`window.__ISLAND__.game.tutorial.forceStep()`);
    await sleep(180);
  }
  // Put the settler on the hex the run is teaching on, so the shot shows the
  // marker doing its job over real terrain.
  await ev(`(()=>{const g=window.__ISLAND__.game,s=window.__ISLAND__.state;
    return import('/src/board/layout.js').then(L=>import('/src/core/rules.js').then(R=>{
      const own=[...s.players[0].settlements].map(i=>L.intersections[i])
        .reduce((a,n)=>a.concat(n.tiles),[]).filter(t=>L.tiles[t].resource);
      if(!own.length) return 'no owned hex';
      const t=L.tiles[own[0]];
      const p=s.players[0]; p.x=t.x; p.z=t.z; p.vx=0; p.vz=0;
      g.avatars[0].group.position.set(t.x,0,t.z);
      return 'on tile '+t.id+' '+t.terrain;}));})()`, true);
  await sleep(1100);
  console.log('  COACH ' + JSON.stringify(await ev(`(()=>{
    const R=s=>{const n=document.querySelector(s);if(!n)return null;
      const r=n.getBoundingClientRect();
      return {x:Math.round(r.left),y:Math.round(r.top),
        w:Math.round(r.width),h:Math.round(r.height),b:Math.round(r.bottom)};};
    const t=window.__ISLAND__.game.tutorial;
    const card=R('.coach-card'), build=R('.hud-bc'), bl=R('.hud-bl'), br=R('.hud-br');
    const out={step:t.step,index:t.stepIndex,of:t.stepCount,
      phase:window.__ISLAND__.state.phase,
      head:(document.querySelector('.coach-h')||{}).textContent,
      text:((document.querySelector('.coach-t')||{}).textContent||'').slice(0,120),
      card,build,bl,br,
      mark:R('.coach-mark'),
      markOn:!!document.querySelector('.coach-mark.on'),
      botsFrozen:!!(window.__ISLAND__.game.bots.__tutFrozen),
      vw:innerWidth,vh:innerHeight};
    if(card&&build) out.cardToBuildGap=build.y-card.b;
    if(card&&bl) out.cardToPromptGap=bl.y-card.b;
    return out;})()`)));
  await shot(`practice-${STEP}-${TAG}`);
}

console.log(`${exceptions.length} exception(s)`);
for (const e of exceptions.slice(0, 6)) console.log('  EXC ' + String(e).split('\n')[0].slice(0, 200));
ws.close(); chrome.kill('SIGKILL');
process.exit(exceptions.length ? 1 : 0);
