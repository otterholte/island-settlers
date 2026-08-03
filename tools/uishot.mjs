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
  const rects=[...document.querySelectorAll('.mf-view > *, .mf-i-cta > *')]
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

/* The opening screen's second view. PLAY no longer starts a match — it opens
   MATCH SETUP, a panel over the same board, and BEGIN THE DRAFT is in there.
   This stage checks the panel fits and that the two views really do swap. */
} else if (STAGE === 'setup') {
  await waitIntro();
  await sleep(300);
  console.log('  CLICK ' + JSON.stringify(await ev(`(()=>{
    const b=document.querySelector('.mf-play');
    if(!b)return 'no play button';
    b.click();return 'clicked';})()`)));
  await sleep(400);
  console.log('  SETUP ' + JSON.stringify(await ev(`(()=>{
    const R=s=>{const n=document.querySelector(s);if(!n)return null;
      const r=n.getBoundingClientRect();
      return {x:Math.round(r.left),y:Math.round(r.top),
        w:Math.round(r.width),h:Math.round(r.height),
        right:Math.round(r.right),bottom:Math.round(r.bottom)};};
    const vis=s=>{const n=document.querySelector(s);
      return !!(n&&!n.classList.contains('hid'));};
    const panel=R('.mf-panel');
    const out={vw:innerWidth,vh:innerHeight,
      homeShown:vis('.mf-home'),setupShown:vis('.mf-setup'),
      panel,head:R('.mf-p-head'),body:R('.mf-p-body'),foot:R('.mf-p-foot'),
      diffRow:R('.mf-i-diff'),knightRow:R('.mf-i-raid'),
      back:R('.mf-back'),begin:R('.mf-setup .mf-play'),
      scrollW:document.documentElement.scrollWidth,
      scrollH:document.documentElement.scrollHeight};
    if(panel){
      out.panelFits=panel.y>=0&&panel.bottom<=innerHeight
        &&panel.x>=0&&panel.right<=innerWidth;
      out.overflowTop=Math.round(-panel.y);
      out.overflowBottom=Math.round(panel.bottom-innerHeight);
    }
    out.tapTargets=[...document.querySelectorAll('.mf-setup button')]
      .map(b=>{const r=b.getBoundingClientRect();
        return {lab:(b.textContent||'').trim().slice(0,20),
          w:Math.round(r.width),h:Math.round(r.height)};});
    return out;})()`)));
  await shot(`setup-${TAG}`);
  console.log('  BACK ' + JSON.stringify(await ev(`(()=>{
    const b=document.querySelector('.mf-back');
    if(!b)return 'no back button';
    b.click();
    const h=document.querySelector('.mf-home'),s=document.querySelector('.mf-setup');
    return {homeShown:!h.classList.contains('hid'),
            setupShown:!s.classList.contains('hid')};})()`)));

/* PLAY WITH FRIENDS. Point `--port` at a server started with STATIC=1 and the
   page is served from the same origin the websocket lives on, so the client
   finds it with no configuration — which is also the local-development story
   this stage is proving works. */
} else if (STAGE === 'friends') {
  await waitIntro();
  await sleep(300);
  console.log('  CLICK ' + JSON.stringify(await ev(`(()=>{
    const b=document.querySelector('.mf-friends');
    if(!b)return 'no friends button';
    b.click();return 'clicked';})()`)));
  // The screen is built by a dynamic import and then waits on a websocket.
  for (let i = 0; i < 60; i++) {
    const st = await ev(`(()=>{const n=document.querySelector('.fr-wrap');
      if(!n||n.classList.contains('hid'))return null;
      const d=n.querySelector('.fr-dot');
      return d?d.className:'';})()`);
    if (typeof st === 'string' && st.includes('ok')) break;
    await sleep(250);
  }
  console.log('  FRIENDS ' + JSON.stringify(await ev(`(()=>{
    const R=s=>{const n=document.querySelector(s);if(!n)return null;
      const r=n.getBoundingClientRect();
      return {x:Math.round(r.left),y:Math.round(r.top),
        w:Math.round(r.width),h:Math.round(r.height),
        right:Math.round(r.right),bottom:Math.round(r.bottom)};};
    const wrap=document.querySelector('.fr-wrap');
    const panel=R('.fr-panel');
    return {vw:innerWidth,vh:innerHeight,
      shown:!!(wrap&&!wrap.classList.contains('hid')),
      introHidden:!!document.querySelector('.mf-intro.mf-hid'),
      status:(document.querySelector('.fr-status-t')||{}).textContent,
      dot:(document.querySelector('.fr-dot')||{}).className,
      title:(document.querySelector('.fr-title')||{}).textContent,
      panel,
      fits:panel?(panel.y>=0&&panel.bottom<=innerHeight
        &&panel.x>=0&&panel.right<=innerWidth):false,
      inputs:[...document.querySelectorAll('.fr-input')].map(n=>{
        const r=n.getBoundingClientRect();
        return {ph:n.placeholder,w:Math.round(r.width),h:Math.round(r.height)};}),
      buttons:[...document.querySelectorAll('.fr-foot .btn')].map(b=>{
        const r=b.getBoundingClientRect();
        return {lab:(b.textContent||'').trim().slice(0,20),
          w:Math.round(r.width),h:Math.round(r.height)};}),
      scrollW:document.documentElement.scrollWidth,
      scrollH:document.documentElement.scrollHeight};})()`)));
  await shot(`friends-${TAG}`);

  // Sign up, so the friends list itself can be photographed too.
  const who = 'shot' + Math.floor(Math.random() * 100000);
  console.log('  SIGNUP ' + JSON.stringify(await ev(`(async()=>{
    const c=(await import('/src/net/client.js')).netClient();
    try{ const u=await c.register('${who}','islandpass'); return u&&u.name; }
    catch(e){ return 'ERR ' + (e.code||e.message); }})()`, true)));
  await sleep(700);
  console.log('  LIST ' + JSON.stringify(await ev(`(()=>{
    return {title:(document.querySelector('.fr-title')||{}).textContent,
      sub:(document.querySelector('.fr-sub')||{}).textContent,
      rows:document.querySelectorAll('.fr-row').length,
      addBox:!!document.querySelector('.fr-add'),
      buttons:[...document.querySelectorAll('.fr-foot .btn')]
        .map(b=>(b.textContent||'').trim())};})()`)));
  await shot(`friends-list-${TAG}`);

  // ...and open a lobby, which is the screen with the seats in it.
  console.log('  LOBBY ' + JSON.stringify(await ev(`(async()=>{
    const btns=[...document.querySelectorAll('.fr-foot .btn')];
    const open=btns.find(b=>/lobby/i.test(b.textContent||''));
    if(!open)return 'no lobby button';
    open.click(); return 'clicked';})()`, true)));
  await sleep(900);
  console.log('  SEATS ' + JSON.stringify(await ev(`(()=>{
    const seats=[...document.querySelectorAll('.fr-seat')].map(s=>({
      kind:s.className.replace('fr-seat','').trim(),
      name:(s.querySelector('.fr-sname')||{}).textContent}));
    const panel=document.querySelector('.fr-panel');
    const r=panel?panel.getBoundingClientRect():null;
    return {title:(document.querySelector('.fr-title')||{}).textContent,
      sub:(document.querySelector('.fr-sub')||{}).textContent,
      seats,
      diff:[...document.querySelectorAll('.btn.fr-d')]
        .map(b=>(b.textContent||'').trim()+(b.classList.contains('on')?'*':'')),
      fits:r?(r.top>=0&&r.bottom<=innerHeight):false,
      h:r?Math.round(r.height):0};})()`)));
  await shot(`lobby-${TAG}`);

/* THE HANDOFF. The riskiest path in the whole multiplayer build: pressing
   START parks the match in sessionStorage and reloads the page, and main.js
   has to deal THAT island before it builds a single mesh. If this works, a
   browser really is playing an authoritative match. */
} else if (STAGE === 'netmatch') {
  await waitIntro();
  await sleep(300);
  const who = 'net' + Math.floor(Math.random() * 100000);
  console.log('  SIGNUP ' + JSON.stringify(await ev(`(async()=>{
    const c=(await import('/src/net/client.js')).netClient();
    c.connect(true);
    for(let i=0;i<40 && c.status!=='ready';i++) await new Promise(r=>setTimeout(r,150));
    try{ const u=await c.register('${who}','islandpass'); return u&&u.name; }
    catch(e){ return 'ERR ' + (e.code||e.message); }})()`, true)));

  console.log('  START ' + JSON.stringify(await ev(`(async()=>{
    const c=(await import('/src/net/client.js')).netClient();
    const P=await import('/src/net/protocol.js');
    const room=await c.req(P.REQ.ROOM_CREATE,{});
    await c.req(P.REQ.ROOM_SETTINGS,{difficulty:'easy',knights:true});
    await c.req(P.REQ.ROOM_START,{});
    return room.room.id;})()`, true)));

  // The reload is the transition. Wait for the page to come back up INSIDE the
  // match rather than on the opening screen.
  // The page has no rules handle of its own; import one so the stage can work
  // out what is legal, exactly as the browser's own draft panel does.
  let back = null;
  for (let i = 0; i < 140; i++) {
    await sleep(400);
    back = await ev(`(()=>{
      const I=window.__ISLAND__;
      if(!I||!I.state)return null;
      const n=I.game.net;
      return {net:!!(n&&n.active), phase:I.state.phase,
        seed:(n&&n.info)?n.info.seed:null,
        yourPid:(n&&n.info)?n.info.yourPid:null,
        draft:(n&&n.draftState)?{pid:n.draftState.pid,need:n.draftState.need}:null,
        buildings:I.state.buildings.size, roads:I.state.roadOwner.size,
        names:I.state.players.map(p=>p.name+':'+p.color.key),
        stage:(I.game.flow||{}).stage,
        time:+I.state.time.toFixed(1)};})()`);
    if (back && back.net) break;
  }
  console.log('  REJOINED ' + JSON.stringify(back));
  await ev(`import('/src/core/rules.js').then(m=>{window.__R__=m;return 1})`, true);

  // Let the load-in pause run out and the draft play itself: three of the four
  // seats are bots, and the fourth auto-places if the browser says nothing.
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    /* Tap for the player. This deliberately goes through the REAL panel —
       select a glowing target and press its Confirm — so the path under test
       is the one a thumb takes: overview.commit -> openPick's onConfirm ->
       netmatch.send -> the server. */
    await ev(`(()=>{
      const I=window.__ISLAND__; const n=I.game.net, ov=I.game.overview;
      if(!n||!n.draftState||n.draftState.pid!==0)return 0;
      if(!ov||!ov.isOpen)return 0;
      const R=window.__R__;
      const legal=n.draftState.need==='road'
        ? R.legalRoads(I.state,0,true,n.draftState.anchor)
        : R.legalSettlements(I.state,0,true);
      if(!legal.length)return 0;
      ov.select(legal[0]);
      const btn=document.querySelector('.ov-bar .btn.green');
      if(btn&&!btn.disabled)btn.click(); else ov.commit();
      return 1;})()`);
    const now2 = await ev(`(()=>{const I=window.__ISLAND__;
      const n=I.game.net;
      return {phase:I.state.phase, b:I.state.buildings.size, r:I.state.roadOwner.size,
        pid:n&&n.draftState?n.draftState.pid:-9,
        need:n&&n.draftState?n.draftState.need:'?',
        open:!!(I.game.overview&&I.game.overview.isOpen),
        snaps:n&&n.mirror?n.mirror.stats.snaps:0,
        evs:n&&n.mirror?n.mirror.stats.events:0,
        me:[+I.state.players[0].x.toFixed(1),+I.state.players[0].z.toFixed(1)],
        t:+I.state.time.toFixed(1)};})()`);
    if (i === 3 || i === 12 || i === 30) console.log(`  t+${i}s ` + JSON.stringify(now2));
    if (now2 && now2.b >= 8 && now2.r >= 8 && now2.phase === 'play') {
      console.log('  DRAFTED ' + JSON.stringify(now2));
      break;
    }
  }
  await sleep(2500);
  console.log('  PLAYING ' + JSON.stringify(await ev(`(()=>{
    const I=window.__ISLAND__; const n=I.game.net;
    return {phase:I.state.phase, buildings:I.state.buildings.size,
      roads:I.state.roadOwner.size,
      packs:I.state.players.map(p=>p.res.wood+p.res.brick+p.res.wool+p.res.wheat+p.res.ore),
      snaps:n.mirror.stats.snaps, events:n.mirror.stats.events,
      dropped:n.mirror.stats.dropped, unknown:n.mirror.stats.unknown,
      buffered:n.buffered, t:+I.state.time.toFixed(1),
      hudUp:!!document.querySelector('.hud:not(.pre)')};})()`)));
  await shot(`netmatch-${TAG}`);

/* The results sheet, both ways round. `--win=1` for your victory, `--win=0` to
   lose to a rival, which is the state the medallion had to stop congratulating
   people in. */
} else if (STAGE === 'results') {
  await waitIntro();
  await ev(`(()=>{window.__ISLAND__.game.flow.skipIntro();return 1})()`);
  await ev(`import('/src/core/rules.js').then(m=>{window.__R__=m;return 1})`, true);
  /* The player's own draft turn WAITS — flowDraft.js says in as many words
     that it never times out into an auto-pick, which is correct in a game
     where the only thing waiting is three subroutines. So this stage taps for
     them, through the real panel, or the draft never finishes and there is no
     results screen to photograph. */
  for (let i = 0; i < 90; i++) {
    const p = await ev('window.__ISLAND__.state.phase');
    if (p === 'play') break;
    await ev(`(()=>{
      const I=window.__ISLAND__, g=I.game, R=window.__R__;
      for(let k=0;k<40;k++){ g.flow.update(1/60); g.bots&&g.bots.update&&g.bots.update(1/60); }
      if(I.state.phase!=='setup')return 0;
      if(R.setupCurrentPlayer(I.state)!==0)return 0;
      const ov=g.overview;
      if(!ov||!ov.isOpen)return 0;
      const road=I.state.setupNeed==='road';
      const legal=road
        ? R.legalRoads(I.state,0,true,I.state.setupAnchor)
        : R.legalSettlements(I.state,0,true);
      if(!legal.length)return 0;
      ov.select(legal[0]); ov.commit();
      return 1;})()`);
    await sleep(120);
  }
  const WIN = arg('win', '1') === '1';
  /* Win it for real rather than poking the panel: matchflow intercepts
     showResults and runs an eight-second victory sequence in front of it, so
     the only way to photograph the sheet the player actually sees is to score
     thirteen points and wait. */
  console.log('  FORCE ' + JSON.stringify(await ev(`(async()=>{
    const R=await import('/src/core/rules.js');
    const I=window.__ISLAND__, st=I.state;
    const wid=${WIN ? 0 : 1};
    const w=st.players[wid];
    w.knightsPlayed=3;
    st.largestArmyHolder=wid; st.longestRoadHolder=wid;
    for(const p of st.players){ p.hasLongestRoad=p.id===wid; p.hasLargestArmy=p.id===wid; }
    let guard=0;
    while(R.scoreOf(st,w) < 13 && guard++ < 40) w.vpCards++;
    R.checkVictory(st);
    return {winner:w.name, colour:w.color.key, vp:R.scoreOf(st,w), phase:st.phase};})()`, true)));
  /* Drive the win timeline by hand. It is 8.85 seconds long and this scene
     renders at about 1.5fps under SwiftShader with dt capped at 0.1 — so left
     to the frame loop the reveal is a minute away, and the wait would look
     like a hang rather than a sequence. */
  for (let i = 0; i < 80; i++) {
    await ev(`(()=>{const g=window.__ISLAND__.game;
      for(let k=0;k<20;k++) g.flow.update(1/60);
      return 1})()`);
    await sleep(120);
    const up = await ev(`(()=>{const n=document.querySelector('.results');
      if(!n||n.classList.contains('hid'))return false;
      return !!document.querySelector('.rs-banner svg');})()`);
    if (up === true) break;
  }
  await sleep(900);
  console.log('  RESULTS ' + JSON.stringify(await ev(`(()=>{
    const b=document.querySelector('.rs-banner');
    const r=b?b.getBoundingClientRect():null;
    const svg=b?b.querySelector('svg'):null;
    return {lost:!!(b&&b.classList.contains('lost')),
      glyph:svg?svg.getAttribute('viewBox'):null,
      title:(document.querySelector('.rs-title')||{}).textContent,
      sub:(document.querySelector('.rs-sub')||{}).textContent,
      points:[...document.querySelectorAll('.results *')]
        .map(n=>(n.textContent||'').trim())
        .filter(t=>/^\\+\\d+ Point/.test(t)).slice(0,4),
      stillSaysVictoryPoints:/Victory Point/.test(document.querySelector('.results').textContent),
      banner:r?{x:Math.round(r.left),y:Math.round(r.top),
        w:Math.round(r.width),h:Math.round(r.height)}:null};})()`)));
  await shot(`results-${WIN ? 'win' : 'lose'}-${TAG}`);

/* The gear popup, which carries the second way home for the rest of the match
   — the map pad is only up while the map is. */
} else if (STAGE === 'settings') {
  await waitIntro();
  await ev(`(()=>{window.__ISLAND__.game.flow.skipIntro();return 1})()`);
  for (let i = 0; i < 90; i++) {
    if (await ev('window.__ISLAND__.state.phase') === 'play') break;
    await ev(`(()=>{const g=window.__ISLAND__.game;
      for(let i=0;i<600;i++){g.flow.update(1/60);g.bots.update&&g.bots.update(1/60);}
      return 1})()`);
    await sleep(120);
  }
  await ev(`(()=>{document.querySelector('.hud-tl .cbtn').click();return 1})()`);
  await sleep(320);
  console.log('  SETTINGS ' + JSON.stringify(await ev(`(()=>{
    const s=document.querySelector('.pop.settings');
    const r=s?s.getBoundingClientRect():null;
    return {phase:window.__ISLAND__.state.phase,
      open:!!(s&&!s.classList.contains('hid')),
      box:r?{x:Math.round(r.left),y:Math.round(r.top),
        w:Math.round(r.width),h:Math.round(r.height)}:null,
      onScreen:r?(r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight):false,
      buttons:[...(s?s.querySelectorAll('.btn'):[])].map(b=>{
        const q=b.getBoundingClientRect();
        return {lab:(b.textContent||'').trim().slice(0,20),
          w:Math.round(q.width),h:Math.round(q.height)};})};})()`)));
  await shot(`settings-${TAG}`);

/* The map pad's HOME key, in the one state the player named it for: the
   opening draft, where the board is locked and the map cannot be dismissed. */
} else if (STAGE === 'leavedraft') {
  await waitIntro();
  await ev(`(()=>{window.__ISLAND__.game.flow.skipIntro();return 1})()`);
  for (let i = 0; i < 60; i++) {
    const p = await ev('window.__ISLAND__.state.phase');
    if (p === 'draft') break;
    await sleep(250);
  }
  await sleep(1200);
  console.log('  DRAFT ' + JSON.stringify(await ev(`(()=>{
    const ov=window.__ISLAND__.game.overview;
    const pad=document.querySelector('.ovz');
    const home=document.querySelector('.ovz-home');
    const R=n=>{if(!n)return null;const r=n.getBoundingClientRect();
      return {x:Math.round(r.left),y:Math.round(r.top),
        w:Math.round(r.width),h:Math.round(r.height)};};
    return {phase:window.__ISLAND__.state.phase,mapOpen:!!ov.isOpen,
      keys:pad?pad.children.length:0,pad:R(pad),home:R(home),
      homeLabel:home?home.getAttribute('aria-label'):null};})()`)));
  await shot(`draftpad-${TAG}`);
  // Arm it, but do NOT fire the second tap: the second tap reloads the page.
  await ev(`(()=>{const h=document.querySelector('.ovz-home');
    h.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));return 1})()`);
  await sleep(250);
  console.log('  ARMED ' + JSON.stringify(await ev(`(()=>{
    const h=document.querySelector('.ovz-home'),a=document.querySelector('.ovz-ask');
    const r=a?a.getBoundingClientRect():null;
    return {armed:h.classList.contains('arm'),
      label:h.getAttribute('aria-label'),
      chip:a?(a.textContent||'').trim():null,
      chipOn:a?!a.classList.contains('off'):false,
      chipBox:r?{x:Math.round(r.left),y:Math.round(r.top),
        w:Math.round(r.width),h:Math.round(r.height)}:null,
      chipOnScreen:r?(r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight):false};})()`)));
  await shot(`leavedraft-${TAG}`);

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
