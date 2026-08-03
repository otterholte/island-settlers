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

  /* ADD TO HOME SCREEN, forced up.
   *
   * The chip is correctly invisible here: `beforeinstallprompt` only fires
   * when the browser has decided the site is installable, and a headless
   * shell on http://127.0.0.1 with no engagement history never decides that.
   * So there is no capture in which it appears by itself, and the thing worth
   * checking — that it fits beside the wordmark on a 667x375 phone and does
   * not collide with the title or the tutorial key opposite it — has to be
   * asked for. Shown, measured, hidden again. */
  console.log('  INSTALL ' + JSON.stringify(await ev(`(()=>{
    const b=document.querySelector('.mf-inst');
    if(!b)return {chip:null};
    const hiddenByDefault=b.classList.contains('hid');
    b.classList.remove('hid');
    const r=b.getBoundingClientRect();
    const t=document.querySelector('.mf-tut').getBoundingClientRect();
    const ti=document.querySelector('.mf-i-title').getBoundingClientRect();
    const hit=(a,c)=>!(a.right<c.left||c.right<a.left||a.bottom<c.top||c.bottom<a.top);
    const out={hiddenByDefault,
      box:{x:Math.round(r.left),y:Math.round(r.top),
        w:Math.round(r.width),h:Math.round(r.height)},
      onScreen:r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight,
      clearsTutorial:!hit(r,t), clearsTitle:!hit(r,ti),
      label:(b.textContent||'').trim()};
    return out;})()`)));
  await shot(`home-install-${TAG}`);
  await ev(`(()=>{const b=document.querySelector('.mf-inst');
    if(b)b.classList.add('hid'); return 1})()`);

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

  /* CAN IT ACTUALLY BE TOUCHED?
   *
   * `element.click()` does not hit-test, so every earlier check of this screen
   * passed while not one real click could land: ui-base.css turns pointer
   * events off for everything under #ui and back on only inside [data-ui], and
   * the panel did not have the attribute. It looked right, it measured right,
   * and nobody could put a cursor in the name field.
   *
   * So this presses it the way a thumb does — a real mouse event at real
   * coordinates, then real keystrokes, including the four letters the joystick
   * claims and the space bar. */
  const field = await ev(`(()=>{const n=document.querySelector('.fr-input');
    if(!n)return null; const r=n.getBoundingClientRect();
    return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`);
  if (field) {
    console.log('  ONTOP ' + JSON.stringify(await ev(`(()=>{
      const el2=document.elementFromPoint(${field.x},${field.y});
      return {tag:el2?el2.tagName:null, cls:el2?String(el2.className):null,
        insidePanel:!!(el2&&el2.closest&&el2.closest('.fr-wrap'))};})()`)));
    await send('Input.dispatchMouseEvent',
      { type: 'mousePressed', x: field.x, y: field.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent',
      { type: 'mouseReleased', x: field.x, y: field.y, button: 'left', clickCount: 1 });
    await sleep(200);
    // Empty it first: the name field can legitimately arrive pre-filled from
    // this device's last visit, and typing into that measures nothing.
    await ev(`(()=>{const n=document.querySelector('.fr-input');n.value='';return 1})()`);
    for (const ch of ['o', 't', 't', 'e', 'r', 'w', 'a', 's', 'd', ' ', '1']) {
      const code = ch === ' ' ? 'Space' : 'Key' + ch.toUpperCase();
      await send('Input.dispatchKeyEvent',
        { type: 'keyDown', text: ch, unmodifiedText: ch, key: ch, code });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code });
    }
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab' });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab' });
    await sleep(200);
    console.log('  TOUCH ' + JSON.stringify(await ev(`(()=>{
      const n=document.querySelector('.fr-input');
      const a=document.activeElement;
      return {typed:n.value, wasdSurvived:n.value==='otterwasd 1',
        tabbedTo:a?a.placeholder:null};})()`)));
    // Leave the field as it was found.
    await ev(`(()=>{const n=document.querySelector('.fr-input'); n.value=''; return 1})()`);
  }

  /* The name is saved on the device, so the check is that it comes back.
     Typed with real keystrokes above; read out of localStorage here. */
  console.log('  NAME ' + JSON.stringify(await ev(`(async()=>{
    const c=(await import('/src/net/client.js')).netClient();
    await c.setName('Otter');
    return {client:c.name, stored:localStorage.getItem('island-settlers.name'),
      device:(localStorage.getItem('island-settlers.device')||'').slice(0,8)+'…',
      user:c.user&&c.user.name};})()`, true)));
  await shot(`rooms-home-${TAG}`);

  // ...and make a room, which is the screen with the code and the seats.
  console.log('  ROOM ' + JSON.stringify(await ev(`(async()=>{
    const btns=[...document.querySelectorAll('.fr-foot .btn')];
    const open=btns.find(b=>/create a room/i.test(b.textContent||''));
    if(!open)return 'no create button';
    open.click(); return 'clicked';})()`, true)));
  await sleep(900);
  console.log('  SEATS ' + JSON.stringify(await ev(`(()=>{
    const seats=[...document.querySelectorAll('.fr-seat')].map(s=>({
      kind:s.className.replace('fr-seat','').trim(),
      name:(s.querySelector('.fr-sname')||{}).textContent}));
    const panel=document.querySelector('.fr-panel');
    const r=panel?panel.getBoundingClientRect():null;
    const code=(document.querySelector('.fr-codeval')||{}).textContent||'';
    return {title:(document.querySelector('.fr-title')||{}).textContent,
      code, codeLen:code.length,
      seats,
      diff:[...document.querySelectorAll('.btn.fr-d')]
        .map(b=>(b.textContent||'').trim()+(b.classList.contains('on')?'*':'')),
      fits:r?(r.top>=0&&r.bottom<=innerHeight):false,
      h:r?Math.round(r.height):0};})()`)));
  await shot(`lobby-${TAG}`);

  /* A SECOND PLAYER, AND THE WAIT.
     START is a vote now, so the state worth photographing is the one in the
     middle: somebody has pressed it and the match has not begun. Driven from
     a second websocket in the page, which is the only way to have two people
     in one lobby from one browser. */
  console.log('  JOIN ' + JSON.stringify(await ev(`(async()=>{
    const P=await import('/src/net/protocol.js');
    // The code, read off the screen exactly the way a friend reads it.
    const code=(document.querySelector('.fr-codeval')||{}).textContent.trim();
    const me=(await import('/src/net/client.js')).netClient();
    const other=new WebSocket(me.url);
    await new Promise(r=>other.addEventListener('open',r,{once:true}));
    let id=0; const wait=new Map();
    other.addEventListener('message',e=>{const m=JSON.parse(e.data);
      if(m.i!==undefined&&wait.has(m.i)){wait.get(m.i)(m);wait.delete(m.i);}});
    const req=(t,b={})=>new Promise(ok=>{const i=++id;wait.set(i,ok);
      other.send(JSON.stringify({i,t,...b}));});
    const name='Pal';
    await req(P.REQ.HELLO,{version:P.PROTOCOL_VERSION,
      device:'uishot-pal-'+Math.floor(Math.random()*1e9),name});
    window.__other={req,P,name,code};
    /* NO FRIENDSHIP, NO INVITE, NOTHING TO ACCEPT. This is the whole change:
       a stranger with the five characters is in. */
    const r=await req(P.REQ.ROOM_JOIN,{code});
    return {code, joined:r.t==='ok', seats:r.room&&r.room.seats.map(s=>s.kind).join(),
      err:r.code||null};})()`, true)));
  await sleep(900);
  console.log('  TWO  ' + JSON.stringify(await ev(`(()=>{
    return {seats:[...document.querySelectorAll('.fr-seat')].map(s=>
      (s.querySelector('.fr-sname')||{}).textContent+':'+(s.querySelector('.fr-srole')||{}).textContent),
      tally:(document.querySelector('.fr-tally')||{}).textContent,
      start:(document.querySelector('.fr-foot .fr-go')||{}).textContent};})()`)));
  await shot(`lobby-two-${TAG}`);

  // Press START here only. The match must NOT begin.
  await ev(`(()=>{document.querySelector('.fr-foot .fr-go').click();return 1})()`);
  await sleep(900);
  console.log('  HALF ' + JSON.stringify(await ev(`(()=>{
    return {tally:(document.querySelector('.fr-tally')||{}).textContent,
      start:(document.querySelector('.fr-foot .fr-go')||{}).textContent,
      cancel:!!document.querySelector('.fr-cancel'),
      seatsReady:[...document.querySelectorAll('.fr-seat.set')].length,
      note:(document.querySelector('.fr-note:not(.hid)')||{}).textContent,
      stillInLobby:!!document.querySelector('.fr-seats')};})()`)));
  await shot(`lobby-waiting-${TAG}`);

/* THE HANDOFF. The riskiest path in the whole multiplayer build: pressing
   START parks the match in sessionStorage and reloads the page, and main.js
   has to deal THAT island before it builds a single mesh. If this works, a
   browser really is playing an authoritative match. */
} else if (STAGE === 'netmatch') {
  await waitIntro();
  await sleep(300);
  const who = 'Net' + Math.floor(Math.random() * 1000);
  console.log('  HELLO ' + JSON.stringify(await ev(`(async()=>{
    const c=(await import('/src/net/client.js')).netClient();
    await c.setName('${who}');
    c.connect(true);
    for(let i=0;i<40 && c.status!=='ready';i++) await new Promise(r=>setTimeout(r,150));
    return {status:c.status, name:c.name, user:c.user&&c.user.name};})()`, true)));

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
  const watch = { n: 0, mine: 0, mineOpen: 0, theirs: 0, theirsOpen: 0, title: null };

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
    /* THE BOARD MUST BE UP WHILE SOMEBODY ELSE IS PICKING.
     *
     *   "On mobile it was showing the second player as only seeing the close
     *    up of the board until it was their turn to pick, instead of showing
     *    the full map view and where other players were placing."
     *
     * So the interesting sample is the one taken when `pid !== 0`: a
     * networked client used to have nothing on screen at all then. Recorded
     * every tick and reported once, because which tick lands on somebody
     * else's turn depends on the shuffle. */
    if (now2 && now2.pid >= 0 && now2.phase !== 'play') {
      watch.n++;
      if (now2.pid === 0) { watch.mine++; if (now2.open) watch.mineOpen++; }
      else { watch.theirs++; if (now2.open) watch.theirsOpen++; }
      if (!watch.title && now2.pid !== 0) {
        watch.title = await ev(`(()=>{
          const t=document.querySelector('.ov-title'), h=document.querySelector('.ov-hint');
          const pips=[...document.querySelectorAll('.ov-pip')];
          return {title:t?t.textContent:null, hint:h?h.textContent:null,
            pips:pips.length, lit:pips.findIndex(p=>p.classList.contains('now'))};})()`);
      }
    }
    if (now2 && now2.b >= 8 && now2.r >= 8 && now2.phase === 'play') {
      console.log('  DRAFTED ' + JSON.stringify(now2));
      break;
    }
  }
  console.log('  WATCH ' + JSON.stringify(watch));
  console.log('  DRAFTVIEW ' + JSON.stringify({
    boardUpOnOthersTurns: watch.theirs > 0 && watch.theirsOpen === watch.theirs,
    boardUpOnYourTurns: watch.mine === 0 || watch.mineOpen === watch.mine,
    samples: `${watch.theirsOpen}/${watch.theirs} rival, ${watch.mineOpen}/${watch.mine} yours`
  }));
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

/* ---------------------------------------------------------------- mobile
 *
 *   "On the draft, hide the draft order popup on the right side of the screen
 *    so the game can be full screen... Then you can have a button that opens or
 *    closes the full pick order popup if users want but it defaults to closed."
 *
 * Three things have to be true at once and only one of them is visible in a
 * screenshot: the rail is DOWN, the strip is up and reading the right seat, and
 * the board actually took the space back. The third is the one that quietly
 * fails — hiding a panel and leaving its 158px reserved in the frame looks
 * identical until you measure. So the frame is measured before and after, and
 * the key is pressed with a real pointer at real coordinates (the `friends`
 * note above says why `element.click()` is not evidence of anything).
 */
} else if (STAGE === 'mobile') {
  await waitIntro();
  await ev(`(()=>{window.__ISLAND__.game.flow.skipIntro();return 1})()`);
  for (let i = 0; i < 60; i++) {
    if (await ev('window.__ISLAND__.state.phase') === 'draft') break;
    await sleep(250);
  }
  await sleep(1200);

  const READ = `(()=>{
    const ov=window.__ISLAND__.game.overview;
    const rail=document.querySelector('.ov-rail');
    const strip=document.querySelector('.ov-strip');
    const key=document.querySelector('.ov-rk');
    const pips=[...document.querySelectorAll('.ov-pip')];
    const R=n=>{if(!n)return null;const r=n.getBoundingClientRect();
      return {x:Math.round(r.left),y:Math.round(r.top),
        w:Math.round(r.width),h:Math.round(r.height)};};
    const f=ov.panInfo.frame;
    return {phase:window.__ISLAND__.state.phase,
      railUp:!!(rail&&!rail.classList.contains('hid')),
      frameW:f[2],
      strip:R(strip), key:R(key),
      pips:pips.length,
      nowAt:pips.findIndex(p=>p.classList.contains('now')),
      mine:pips.findIndex(p=>p.classList.contains('me')),
      colours:pips.map(p=>p.style.getPropertyValue('--c')),
      padKeys:document.querySelectorAll('.ovz b').length,
      fitKeys:document.querySelectorAll('.ovz-fit').length};})()`;

  const closed = await ev(READ);
  console.log('  CLOSED ' + JSON.stringify(closed));
  await shot(`mobile-draft-${TAG}`);

  // Press the list key the way a thumb does.
  if (closed.key) {
    const kx = closed.key.x + Math.round(closed.key.w / 2);
    const ky = closed.key.y + Math.round(closed.key.h / 2);
    console.log('  ONTOP ' + JSON.stringify(await ev(`(()=>{
      const n=document.elementFromPoint(${kx},${ky});
      return {tag:n?n.tagName:null,
        isKey:!!(n&&n.closest&&n.closest('.ov-rk'))};})()`)));
    await send('Input.dispatchMouseEvent',
      { type: 'mousePressed', x: kx, y: ky, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent',
      { type: 'mouseReleased', x: kx, y: ky, button: 'left', clickCount: 1 });
    await sleep(320);
    const open = await ev(READ);
    console.log('  OPENED ' + JSON.stringify(open));
    console.log('  TRADE  ' + JSON.stringify({
      railCameUp: open.railUp && !closed.railUp,
      boardGaveBack: closed.frameW - open.frameW,
      stripStillUp: !!open.strip
    }));
    await shot(`mobile-rail-${TAG}`);
    await send('Input.dispatchMouseEvent',
      { type: 'mousePressed', x: kx, y: ky, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent',
      { type: 'mouseReleased', x: kx, y: ky, button: 'left', clickCount: 1 });
    await sleep(320);
    console.log('  RECLOSED ' + JSON.stringify(await ev(READ)));
  }

  /* ------------------------------------------------------- the two sides
   *
   *   "Let's actually switch the invisible joystick to work anywhere, but
   *    still have the buttons switch sides. So it doesn't need a toggle."
   *
   * One switch, and what is checked is that it moves the action rail and that
   * the drag zone does not care: `#js-ring` has no resting position any more —
   * it appears where a thumb lands — so the thing to prove is that a press on
   * the far side from the buttons still raises it.
   *
   * The map is stood down for this: the settings popover is reachable from the
   * gear at any time, but during the opening draft the board is a full-screen
   * overlay that cannot be dismissed, and a real pointer would land on it. It
   * goes straight back afterwards.
   */
  await ev(`(()=>{const o=document.querySelector('.ov'); o.dataset.was=o.style.display;
    o.style.display='none'; return 1})()`);
  const gear = await ev(`(()=>{const b=document.querySelector('.hud-tl .cbtn');
    const r=b.getBoundingClientRect();
    return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`);
  const press = async (x, y) => {
    await send('Input.dispatchMouseEvent',
      { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent',
      { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await sleep(220);
  };
  await press(gear.x, gear.y);

  const SIDES = `(()=>{
    const C=n=>{const q=document.querySelector(n); if(!q)return null;
      const r=q.getBoundingClientRect();
      return Math.round(r.left+r.width/2);};
    const rows=[...document.querySelectorAll('.side-row')].map(r=>({
      lab:(r.querySelector('.side-lab').textContent||'').trim(),
      on:(r.querySelector('.btn.seg.on')||{textContent:''}).textContent.trim()}));
    return {rows, btnLeft:document.querySelector('.hud').classList.contains('btn-left'),
      railX:C('.hud-br'), stickX:C('#js-ring'), w:innerWidth};})()`;
  const seg = async (row, lab) => await ev(`(()=>{
    const r=[...document.querySelectorAll('.side-row')]
      .find(n=>n.querySelector('.side-lab').textContent.trim()==='${row}');
    const b=[...r.querySelectorAll('.btn.seg')]
      .find(n=>n.textContent.trim()==='${lab}');
    const q=b.getBoundingClientRect();
    return {x:Math.round(q.left+q.width/2),y:Math.round(q.top+q.height/2),
      onTop:document.elementFromPoint(Math.round(q.left+q.width/2),
        Math.round(q.top+q.height/2)).closest('.btn.seg')===b};})()`);

  const before = await ev(SIDES);
  console.log('  SIDES-RR ' + JSON.stringify(before));
  const t = await seg('Buttons', 'Left');
  console.log('  hit buttons/left ' + t.onTop);
  await press(t.x, t.y);
  const bl = await ev(SIDES);
  console.log('  SIDES-LEFT ' + JSON.stringify(bl));
  console.log('  MOVED  ' + JSON.stringify({
    railWentLeft: bl.railX < before.railX,
    classFollows: bl.btnLeft === true && before.btnLeft === false,
    onlyOneSwitch: bl.rows.length === 1 && bl.rows[0].lab === 'Buttons'
  }));
  await shot(`mobile-sides-${TAG}`);
  // Put it back so the shot of the default layout is the default.
  { const q = await seg('Buttons', 'Right'); await press(q.x, q.y); }
  console.log('  RESTORED ' + JSON.stringify(await ev(SIDES)));
  await ev(`(()=>{document.querySelector('.pop.settings')
    .classList.add('hid');
    const o=document.querySelector('.ov'); o.style.display=o.dataset.was||'';
    return 1})()`);

  /* The PWA half of the same request, measured rather than assumed: the
     manifest has to parse, be same-origin-relative, and name icons that
     actually 200. */
  console.log('  PWA ' + JSON.stringify(await ev(`(async()=>{
    const link=document.querySelector('link[rel=manifest]');
    if(!link)return {manifest:null};
    const url=new URL(link.getAttribute('href'),location.href);
    const m=await (await fetch(url)).json();
    const icons=[];
    for(const i of m.icons){
      const r=await fetch(new URL(i.src,url));
      icons.push({src:i.src,ok:r.ok,type:r.headers.get('content-type'),
        purpose:i.purpose});
    }
    const sw=await fetch(new URL('./sw.js',location.href));
    return {name:m.name,display:m.display,override:m.display_override,
      orientation:m.orientation,startUrl:m.start_url,scope:m.scope,
      relative:!String(m.start_url).startsWith('/'),
      icons, swOk:sw.ok,
      appleTouch:!!document.querySelector('link[rel=apple-touch-icon]'),
      themeColour:(document.querySelector('meta[name=theme-color]')||{}).content};})()`,
  true)));

  /* "Same goes for the players box on the standard map view." Re-dressed in
     place into plain view mode: the rail is still down, and off the draft each
     pip carries the one number the rail led with — the score. Last, because it
     re-dresses the panel the draft is using. */
  await ev(`(()=>{window.__ISLAND__.game.overview.open('view');return 1})()`);
  // A beat for the panel to be laid out again: `measure()` reads clientWidth,
  // and a canvas that was display:none one frame ago reports 0 and falls back
  // to its 800px default. Nothing to do with the game — the rig hid it.
  await sleep(400);
  console.log('  VIEW ' + JSON.stringify(await ev(`(()=>{
    const ov=window.__ISLAND__.game.overview;
    const rail=document.querySelector('.ov-rail');
    const pips=[...document.querySelectorAll('.ov-pip')];
    return {mode:ov.mode, railUp:!!(rail&&!rail.classList.contains('hid')),
      frameW:ov.panInfo.frame[2],
      pips:pips.length,
      scores:pips.map(p=>{const b=p.querySelector('b');
        return b?b.textContent:null;}),
      person:pips.every(p=>!!p.querySelector('svg.person'))};})()`)));
  /* No screenshot for this one on purpose. matchflow.js re-dresses the panel
     back into draft mode within about a tenth of a second, and a capture takes
     five: the picture would show the draft strip over a "view" reading and
     look like a bug that is not there. The measurement above is the evidence. */

/* ------------------------------------------------------------- the tilt
 *
 *   "Let me use two fingers and drag up and down on the map view to reposition
 *    my view so it's a bit more 3D, and have it save that view the next time I
 *    open the map, even during the next game."
 *
 * Three claims and all three are checkable: two fingers dragged down tilt the
 * board, the tilt survives a reload, and — the reason it was asked for — a
 * tilted board FITS MORE ISLAND on the same screen. The last one is measured
 * as the world-to-canvas scale before and after, because "I can see more
 * without zooming" is a number, not an impression.
 */
} else if (STAGE === 'maptilt') {
  const innerWidthGuess = W;
  await waitIntro();
  await ev(`(()=>{window.__ISLAND__.game.flow.skipIntro();return 1})()`);
  for (let i = 0; i < 60; i++) {
    if (await ev('window.__ISLAND__.state.phase') === 'setup') break;
    await sleep(250);
  }
  await sleep(1500);

  const READ = `(()=>{
    const ov=window.__ISLAND__.game.overview;
    const p=ov.panInfo;
    return {open:!!ov.isOpen, tilt:p.tilt, ky:p.ky, s:p.s,
      frame:p.frame, tilts:p.tilts,
      stored:JSON.parse(localStorage.getItem('island-settlers.options')||'{}').mapTilt};})()`;
  // Wait for the panel to have been laid out at least once: `panInfo` falls
  // back to 800x400 with s=1 before the first measure, which would make the
  // before/after comparison below a comparison with nothing.
  let flat = await ev(READ);
  for (let i = 0; i < 40 && (!flat || flat.frame[2] > innerWidthGuess); i++) {
    await sleep(200);
    flat = await ev(READ);
  }
  console.log('  FLAT ' + JSON.stringify(flat));
  await shot(`maptilt-flat-${TAG}`);

  /* Two real fingers, dragged down the canvas together. Dispatched as raw
     touch points through the input domain so it goes through the same
     pointerdown/pointermove path a thumb does — `pan.setTilt()` would prove
     the painter and nothing about the gesture. */
  const box = await ev(`(()=>{const c=document.querySelector('.ov-cv');
    const r=c.getBoundingClientRect();
    return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`);
  const two = async (dy, type) => {
    await send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [
        { x: box.x - 60, y: box.y + dy, id: 1 },
        { x: box.x + 60, y: box.y + dy, id: 2 }
      ]
    });
  };
  await two(-70, 'touchStart');
  for (let i = -70; i <= 70; i += 14) { await two(i, 'touchMove'); await sleep(24); }
  await two(70, 'touchEnd');
  await sleep(500);

  const tilted = await ev(READ);
  console.log('  TILTED ' + JSON.stringify(tilted));

  /* AND THE NUMBER DISCS STAY ROUND.
     The tilt squashes the whole canvas, so a token painted straight through it
     is an ellipse with squashed digits in it — "making it harder to read in
     3D". They are billboarded out of the squash, and the way to prove that
     from outside the painter is to read the actual pixels: a round disc is as
     tall as it is wide, a squashed one is not. */
  /* AND THE NUMBER DISCS STAY UPRIGHT.
   *
   *   "When I change the angle, please have the number tiles move to still be
   *    facing me whatever viewpoint I'm at, instead of just always facing
   *    straight up, making it harder to read in 3D."
   *
   * The tilt squashes the whole canvas, so a disc painted straight through it
   * is an ellipse with squashed digits in it. They are billboarded back out of
   * the squash, and this reads the transform the painter ACTUALLY had at each
   * of the two moments — no screenshot to interpret and no pixel to guess at.
   * The board leans; the labels stand up in it. */
  const up = await ev(`(()=>{const m=window.__ISLAND__.game.overview.metrics;
    return {ky:m.ky, scales:m.scales};})()`);
  console.log('  SCALES ' + JSON.stringify(up));
  console.log('  UPRIGHT ' + JSON.stringify({
    boardLeans: Math.abs(up.scales.board - up.ky) < 0.02,
    labelsStandUp: Math.abs(up.scales.label - 1) < 0.02,
    wouldHaveBeen: up.ky
  }));
  console.log('  GAINED ' + JSON.stringify({
    tiltMoved: tilted.tilt > flat.tilt + 0.05,
    squashed: tilted.ky < flat.ky - 0.05,
    // The payoff: a tilted board is fitted at a LARGER world-to-canvas scale,
    // so every hex and every token is bigger on the same screen.
    biggerHexes: +(tilted.s / flat.s).toFixed(3),
    gestureSeen: tilted.tilts > 0
  }));

  await shot(`maptilt-tilted-${TAG}`);

  /* AND YOU CAN PULL FURTHER BACK THAN THE FIT.
   *   "I should be able to zoom out more on the 3D version of the map
   *    overview. When I use two fingers to change the view I can't zoom out as
   *    far as I need."
   * The floor was 0.90 — ten per cent under the fit, which is a rounding error
   * rather than a range. Walked all the way down here so the number in the
   * log is the one a thumb can actually reach. */
  const zoomedOut = await ev(`(()=>{
    const ov=window.__ISLAND__.game.overview;
    for(let i=0;i<24;i++) if(ov.zoomOutForTest) ov.zoomOutForTest();
    return ov.panInfo;})()`);
  console.log('  ZOOMOUT ' + JSON.stringify({
    floor: zoomedOut.zoomRange ? zoomedOut.zoomRange[0] : null,
    reached: zoomedOut.zoom,
    boardStillOnScreen: zoomedOut.boardOnScreen
  }));
  await shot(`maptilt-out-${TAG}`);

  // And it is remembered. Reload the page and ask again.
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });
  await sleep(2500);
  await waitIntro();
  await ev(`(()=>{window.__ISLAND__.game.flow.skipIntro();return 1})()`);
  for (let i = 0; i < 60; i++) {
    if (await ev('window.__ISLAND__.state.phase') === 'setup') break;
    await sleep(250);
  }
  await sleep(1500);
  const after = await ev(READ);
  console.log('  RELOADED ' + JSON.stringify(after));
  console.log('  KEPT ' + JSON.stringify({
    survivedAReload: Math.abs(after.tilt - tilted.tilt) < 0.02,
    andANewMatch: after.ky < 0.999
  }));

/* --------------------------------------------------------- picked for you
 *
 *   "Add a setting that lets me have a randomized settlement and road
 *    placement for the start of the game, instead of forcing them to spend the
 *    time picking. Don't give them really scrappy locations though — just have
 *    the bot choose for them too."
 *
 * Two claims, and the second is the one worth checking. That the draft
 * completes with nobody touching the screen is easy; that the corners it hands
 * over are GOOD is the request. So this measures the opening the player was
 * dealt against the three the rivals dealt themselves — same board, same
 * chooser, and the player's is the only one run with the difficulty's opening
 * randomness turned off.
 */
} else if (STAGE === 'autodraft') {
  await waitIntro();
  // Turn it on the way the setting does, then start a match and touch nothing.
  console.log('  SET ' + JSON.stringify(await ev(`(async()=>{
    const o=await import('/src/core/options.js');
    o.setAutoDraft(true);
    return {on:o.autoDraft(),
      stored:JSON.parse(localStorage.getItem('island-settlers.options')||'{}').autoDraft};})()`,
  true)));
  await ev(`(()=>{window.__ISLAND__.game.flow.skipIntro();return 1})()`);

  /* THE WHOLE DRAFT LANDS AT ONCE, and then the board waits.
   *   "Instead of still having me watch the draft happen I should just
   *    automatically see all of the locations that were chosen on the map
   *    overview, and just press start game as another button on the map screen
   *    once I've reviewed the board."
   * So the assertion is in two halves and the second is the point: everything
   * is placed, and NOTHING has started. */
  await sleep(1200);
  const READY = `(()=>{const I=window.__ISLAND__;
    const act=document.querySelector('.ov-act');
    const r=act?act.getBoundingClientRect():null;
    return {phase:I.state.phase, b:I.state.buildings.size, r:I.state.roadOwner.size,
      mine:I.state.players[0].settlements.size,
      myRoads:[...I.state.roadOwner.values()].filter(v=>v===0).length,
      mapUp:!!(I.game.overview&&I.game.overview.isOpen),
      stage:(I.game.flow||{}).stage,
      holding:!!(I.game.flow&&I.game.flow.draftHolding),
      button:act&&!act.classList.contains('hid')?(act.textContent||'').trim():null,
      box:r?{w:Math.round(r.width),h:Math.round(r.height)}:null,
      clock:+I.state.time.toFixed(2)};})()`;
  let out = await ev(READY);
  console.log('  PLACED ' + JSON.stringify(out));

  // Give it several seconds of game time with nobody touching anything. The
  // match must still not have begun.
  await ev(`(()=>{const g=window.__ISLAND__.game;
    for(let k=0;k<600;k++){g.flow.update(1/60);if(g.bots.update)g.bots.update(1/60);}
    return 1})()`);
  await sleep(200);
  const waited = await ev(READY);
  console.log('  WAITED ' + JSON.stringify(waited));
  console.log('  REVIEW ' + JSON.stringify({
    everythingPlaced: out.b === 8 && out.r === 8,
    twoCornersTwoRoads: out.mine === 2 && out.myRoads === 2,
    boardIsUp: out.mapUp,
    oneButtonOnIt: !!out.button,
    // The eighth road flips `state.phase` to 'play' the moment it lands, so
    // "has it started" is not a question about the phase — it is whether the
    // board is still up and the stage machine is still holding.
    andItWaits: waited.mapUp && waited.stage !== 'play'
  }));
  await shot(`autodraft-review-${TAG}`);

  // Press it the way a thumb does.
  const btn = await ev(`(()=>{const b=document.querySelector('.ov-act');
    const r=b.getBoundingClientRect();
    return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),
      onTop:document.elementFromPoint(Math.round(r.left+r.width/2),
        Math.round(r.top+r.height/2)).closest('.ov-act')===b};})()`);
  console.log('  PRESS ' + JSON.stringify(btn));
  await send('Input.dispatchMouseEvent',
    { type: 'mousePressed', x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent',
    { type: 'mouseReleased', x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
  await sleep(300);
  for (let i = 0; i < 20; i++) {
    await ev(`(()=>{const g=window.__ISLAND__.game;
      for(let k=0;k<120;k++){g.flow.update(1/60);if(g.bots.update)g.bots.update(1/60);}
      return 1})()`);
    out = await ev(READY);
    if (out.phase === 'play') break;
    await sleep(40);
  }
  console.log('  STARTED ' + JSON.stringify(out));
  console.log('  HANDSOFF ' + JSON.stringify({
    startsOnlyWhenPressed: out.phase === 'play',
    twoCornersTwoRoads: out.mine === 2 && out.myRoads === 2
  }));

  /* AND THEY ARE NOT SCRAPPY. Pip total is the board's own measure of how much
     a corner produces, and every seat drafted from the same nineteen hexes. */
  const worth = await ev(`(async()=>{
    const L=await import('/src/board/layout.js');
    const I=window.__ISLAND__;
    const pipsAt=iid=>L.intersections[iid].tiles
      .reduce((n,t)=>n+(L.tiles[t].pips||0),0);
    const per=I.state.players.map(p=>({
      pid:p.id, name:p.name,
      pips:[...p.settlements].reduce((n,i)=>n+pipsAt(i),0),
      kinds:new Set([...p.settlements].flatMap(i=>L.intersections[i].tiles
        .map(t=>L.tiles[t].resource).filter(Boolean))).size
    }));
    return per;})()`, true);
  console.log('  OPENINGS ' + JSON.stringify(worth));
  const me = worth.find(w => w.pid === 0);
  const bots = worth.filter(w => w.pid !== 0);
  const avg = bots.reduce((n, b) => n + b.pips, 0) / Math.max(1, bots.length);
  /* WHAT TO ASSERT, AND WHAT NOT TO.
   *
   * Not "beats the rivals": the snake order is 0,1,2,3,3,2,1,0, so seat 0 gets
   * the pick of an empty board AND the very last leftover, while seat 3 gets
   * two middling corners back to back. Whether that adds up to more pips is a
   * property of the DRAFT POSITION, not of the chooser, and asserting on it
   * would fail on boards where the opening is perfectly good. Reported as
   * context, deliberately not asserted.
   *
   * What IS the request is that the opening is not scrappy, and that has two
   * halves that both matter: enough total production to build from, and enough
   * DIFFERENT resources that the first settlement does not need a 4:1 trade to
   * start. Twelve pips is a low bar a bad opening does not clear; three
   * resources out of five is the floor for building anything. */
  console.log('  QUALITY ' + JSON.stringify({
    myPips: me && me.pips,
    rivalAverage: +avg.toFixed(1),
    resourcesCovered: me && me.kinds,
    notScrappy: !!me && me.kinds >= 3 && me.pips >= 12,
    forContext: 'seat 0 picks 1st and 8th — the snake gives and takes back'
  }));
  await shot(`autodraft-${TAG}`);
  await ev(`(async()=>{(await import('/src/core/options.js')).setAutoDraft(false);
    return 1})()`, true);

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
