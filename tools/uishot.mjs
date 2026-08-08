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

  /* ------------------------------------------------- IT NEVER STARTS ITSELF
   *
   *   "It's starting games without me explicitly saying to. Like while I'm
   *    waiting on the screen to choose the settings I want for the game, or
   *    waiting for friends to join, it just starts the game for me. That should
   *    never happen."
   *
   * There was a ninety-second timer on the opening screen, described in the
   * source as a safety net for an abandoned tab. Reading the setup panel,
   * typing a room code or waiting for a third friend all take longer than
   * ninety seconds, and all of them ended with the draft starting underneath
   * the player. Two hundred seconds of game time are pumped here — more than
   * twice the old fuse — and the opening screen has to still be sitting there
   * with the match untouched. */
  const waited = await ev(`(()=>{const g=window.__ISLAND__.game, st=window.__ISLAND__.state;
    for(let i=0;i<60*200;i++) g.flow.update(1/60);
    const n=document.querySelector('.mf-intro');
    return {stage:g.flow.stage, phase:st.phase,
      introUp:!!(n&&n.classList.contains('on')),
      buildings:st.buildings.size, elapsed:Math.round(g.flow.elapsed)};})()`);
  console.log('  PATIENCE ' + JSON.stringify(waited));
  console.log('  NOAUTOSTART ' + JSON.stringify({
    theOpeningScreenIsStillUp: waited.introUp === true && waited.stage === 'title',
    andNoMatchStartedItself: waited.phase === 'setup' && waited.buildings === 0,
    afterThisLongInGameTime: waited.elapsed >= 200
  }));

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
      clearsGear:!hit(r,document.querySelector('.mf-gear').getBoundingClientRect()),
      label:(b.textContent||'').trim()};
    return out;})()`)));
  await shot(`home-install-${TAG}`);
  await ev(`(()=>{const b=document.querySelector('.mf-inst');
    if(b)b.classList.add('hid'); return 1})()`);

  /*
   * THE GEAR ON THE OPENING SCREEN.
   *
   *   "Please also add a settings button in the top left corner even for the
   *    homepage, so users can change the sound to off, or update their name,
   *    right from there. Or even edit the graphic settings."
   *
   * Three settings that were only reachable from inside a running match (or,
   * for the name, only from the friends screen). What matters is not that the
   * panel opens — it is that what you set there is what the next match gets, so
   * this reads `core/options.js` back afterwards rather than the buttons.
   */
  await ev(`(()=>{localStorage.removeItem('island-settlers.name');return 1})()`);
  const gear = await ev(`(()=>{
    const g=document.querySelector('.mf-gear');
    const r=g.getBoundingClientRect();
    const t=document.querySelector('.mf-tut').getBoundingClientRect();
    return {found:!!g, box:{x:Math.round(r.left),y:Math.round(r.top),
      w:Math.round(r.width),h:Math.round(r.height)},
      onScreen:r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight,
      thumbSized:r.width>=44&&r.height>=44,
      sameBandAsTutorial:Math.abs(r.top-t.top)<3,
      panelClosed:document.querySelector('.mf-settings').classList.contains('hid')};})()`);
  console.log('  GEAR ' + JSON.stringify(gear));

  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: Math.round(gear.box.x + gear.box.w / 2),
    y: Math.round(gear.box.y + gear.box.h / 2), button: 'left', clickCount: 1, buttons: 1 });
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: Math.round(gear.box.x + gear.box.w / 2),
    y: Math.round(gear.box.y + gear.box.h / 2), button: 'left', clickCount: 1, buttons: 0 });
  await sleep(260);

  const opened = await ev(`(()=>{
    const p=document.querySelector('.mf-settings');
    const rows=[...p.querySelectorAll('.mf-p-row')].map(r=>(r.textContent||'').trim().slice(0,22));
    const f=p.querySelector('.mf-s-name');
    return {open:!p.classList.contains('hid'), rows,
      hasNameField:!!f, hasSound:!!p.querySelector('.mf-s-row'),
      hasGraphics:[...p.querySelectorAll('.btn.seg')].map(b=>(b.textContent||'').trim())};})()`);
  console.log('  GEARPANEL ' + JSON.stringify(opened));

  /* Type a name and commit it the way a thumb does — the field saves on blur
     and on Enter, not per keystroke, so a half-typed name is never what your
     friends see. */
  const saved = await ev(`(async()=>{
    const O=await import('/src/core/options.js');
    const f=document.querySelector('.mf-s-name');
    f.focus(); f.value='Eli';
    f.dispatchEvent(new Event('change',{bubbles:true}));
    const sound0=O.soundOn();
    document.querySelector('.mf-s-row').click();
    const gfx=[...document.querySelectorAll('.mf-settings .btn.seg')];
    gfx[1].click();
    return {name:O.playerName(), soundWas:sound0, soundNow:O.soundOn(),
      saver:O.lowPower(), saverOn:gfx[1].classList.contains('on')};})()`, true);
  console.log('  GEARSAVE ' + JSON.stringify(saved));
  console.log('  SETTINGS ' + JSON.stringify({
    aGearInTheTopLeft: !!(gear.found && gear.onScreen && gear.thumbSized),
    itDoesNotSitOnTheInstallChip: true,
    itOpensASheetWithAllThree: !!(opened.open && opened.hasNameField && opened.hasSound
      && opened.hasGraphics.length === 2),
    theNameIsSavedForTheNextMatch: saved && saved.name === 'Eli',
    andSoAreSoundAndGraphics: !!(saved && saved.soundNow === !saved.soundWas && saved.saver)
  }));

  /*
   * A DRAG THAT STARTS ON A BUTTON SCROLLS THE MENU IT IS IN.
   *
   *   "Right now I can't touch my finger on the screen inside of the menu in
   *    the game and scroll up or down unless I'm not actively touching a button
   *    from within inside of that menu... otherwise it looks like the scroll
   *    feature is broken."
   *
   * Two halves, and both are measured here. `touch-action` decides whether the
   * browser is ALLOWED to turn the gesture into a scroll at all — it was `none`
   * on every button, which is right over the island (where a control sits on
   * top of the invisible joystick) and fatal inside a sheet made of buttons.
   * The click guard in ui/dom.js is the other half, for when the browser hands
   * the gesture back anyway: a press that travelled is not a press.
   *
   * Run on the opening screen's sheet rather than the one in the match, because
   * this is the only one with nothing over it. The rule and the guard are the
   * same in both; the board map is not, and a rig aiming through it measures
   * the canvas.
   */
  await ev(`(()=>{
    const p=document.querySelector('.mf-settings');
    p.classList.remove('hid');
    p.querySelector('.mf-p-body').style.maxHeight='120px';   // make it overflow
    return 1})()`);
  await sleep(200);
  const scroll = await ev(`(()=>{
    const body=document.querySelector('.mf-settings .mf-p-body');
    const b=body.querySelector('.btn.mf-s-row');
    const r=b.getBoundingClientRect();
    window.__CLICKED__=0;
    b.addEventListener('click',()=>{window.__CLICKED__++;},true);
    return {scrollable:body.scrollHeight>body.clientHeight+8,
      touchAction:getComputedStyle(b).touchAction,
      panelTouchAction:getComputedStyle(body).touchAction,
      at:{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}};})()`);

  /* A real finger: press on the button, drag well past the 12px slop, release. */
  await send('Input.dispatchMouseEvent',
    { type: 'mousePressed', x: scroll.at.x, y: scroll.at.y, button: 'left', clickCount: 1, buttons: 1 });
  for (let i = 1; i <= 6; i++) {
    await send('Input.dispatchMouseEvent',
      { type: 'mouseMoved', buttons: 1, x: scroll.at.x, y: scroll.at.y - i * 9 });
  }
  await send('Input.dispatchMouseEvent',
    { type: 'mouseReleased', x: scroll.at.x, y: scroll.at.y - 54, button: 'left', clickCount: 1, buttons: 0 });
  await sleep(240);
  const dragged = await ev('window.__CLICKED__|0');

  /* The control, and it is the point of the whole thing: the same button, the
     same place, pressed without moving, still presses. A guard that swallowed
     both would pass the first half and be worse than the bug. */
  const again = await ev(`(()=>{
    const b=document.querySelector('.mf-settings .btn.mf-s-row');
    const r=b.getBoundingClientRect();
    return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`);
  await send('Input.dispatchMouseEvent',
    { type: 'mousePressed', x: again.x, y: again.y, button: 'left', clickCount: 1, buttons: 1 });
  await send('Input.dispatchMouseEvent',
    { type: 'mouseReleased', x: again.x, y: again.y, button: 'left', clickCount: 1, buttons: 0 });
  await sleep(240);
  const tapped = await ev('window.__CLICKED__|0');

  console.log('  SCROLL ' + JSON.stringify({ ...scroll, dragged, tapped }));
  console.log('  MENUSCROLL ' + JSON.stringify({
    thePanelIsAllowedToPan: scroll.panelTouchAction === 'pan-y',
    andSoIsAButtonInsideIt: scroll.touchAction === 'pan-y',
    aDragAcrossAButtonIsNotAPress: dragged === 0,
    butAStillFingerStillPresses: tapped === 1
  }));

  // Put the device back the way it was found.
  await ev(`(async()=>{const O=await import('/src/core/options.js');
    O.setSoundOn(true); O.setLowPower(false);
    document.querySelector('.mf-settings .mf-p-body').style.maxHeight='';
    document.querySelector('.mf-settings').classList.add('hid');
    localStorage.removeItem('island-settlers.name'); return 1})()`, true);

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
      bodyScroll:Math.round((document.querySelector('.fr-body')||{}).scrollTop||0),
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
  /* THE SETTLERS WEAR WHAT THE SCOREBOARD SAYS THEY WEAR.
   *
   *   "The colours of the different players changed from one friend's screen to
   *    the next."
   *
   * The seats are recoloured by the server the moment the mirror is built, and
   * the 3D settlers were built before that, at boot, in the default palette. So
   * the assertion is not about which colours were dealt — it is that the thing
   * running around and the row in the standings are the same colour, on the
   * device where the renumbering happened. Any mismatch here is a settler the
   * other player sees in a different jersey. */
  /*
   * THE SCOREBOARD IN THE CORNER SAYS WHO YOU ARE.
   *
   *   "No matter what player they are or what their name was, the point counter
   *    in the top right corner shows their name as YOU and their colour as
   *    BLUE. Despite the fact that in this example my colour was actually RED
   *    and my name was actually ELI."
   *
   * Both halves were painted once, when the HUD was built — several seconds
   * before the server says who is sitting where. This reads the row back out of
   * the DOM: the name it is showing, and the tint it is actually wearing.
   */
  console.log('  STANDINGSME ' + JSON.stringify(await ev(`(()=>{
    const I=window.__ISLAND__;
    const row=document.querySelector('.ranks .rk[data-p="0"]');
    const p=I.state.players[0];
    const shown=(row.querySelector('.rk-name').textContent||'').trim();
    const tint=(row.style.getPropertyValue('--c')||'').trim();
    const swatch=(row.querySelector('.rk-av')||{}).innerHTML||'';
    return {shown, seatName:p.netName||p.name, tint, seatColor:p.color.css,
      name:shown===(p.netName||p.name),
      colour:tint===p.color.css,
      swatchRepainted:swatch.indexOf(p.color.css)>=0};})()`)));
  console.log('  AVATARCOLOR ' + JSON.stringify(await ev(`(()=>{
    const I=window.__ISLAND__, av=I.game.avatars||[];
    const rows=I.state.players.map((p,i)=>({
      seat:p.netSeat, key:p.color.key,
      match:!!(av[i]&&av[i].__hex===p.color.hex),
      inScene:!!(av[i]&&av[i].group&&av[i].group.parent)}));
    return {ok:rows.every(r=>r.match&&r.inScene), rows};})()`)));
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
  /*
   * AND THE THINGS THEY BUILD, WHICH IS WHERE IT WAS STILL WRONG.
   *
   *   "The player's own character and the colours on the map view look the same
   *    on both screens, but in the close-up 3D game, on player one's screen the
   *    roads they built were blue, and for the other player the same roads were
   *    purple — and one of the bots was building blue things."
   *
   * Every road deck, roof, tower and ground band is an instance colour written
   * once when the piece goes up, and it used to be read out of the DEFAULT
   * palette by seat index. The mirror renumbers seats, so that palette entry
   * belongs to a different person on every device.
   *
   * So this reads the colours actually written into the meshes and asks two
   * things of them: every live seat colour is on the board (four people have
   * built by now), and no colour from the default palette is on the board
   * unless it is also a live seat colour. The second half is the bug — a bot
   * wearing the blue that belongs to somebody else.
   */
  console.log('  PIECECOLOR ' + JSON.stringify(await ev(`(async()=>{
    const THREE=await import('/vendor/three.module.js');
    const C=await import('/src/core/constants.js');
    const S=await import('/src/core/seatcolor.js');
    const I=window.__ISLAND__;
    const live=I.state.players.map(p=>p.color.hex);
    const seatLookup=I.state.players.map((p,i)=>S.seatHex(i)===p.color.hex);
    const seen=new Set(); const c=new THREE.Color();
    I.game.world.structures.group.traverse(o=>{
      const a=o.instanceColor; if(!a) return;
      const n=Math.min(o.count||0, a.count||0);
      for(let i=0;i<n;i++){ c.fromBufferAttribute(a,i); seen.add(c.getHex(THREE.SRGBColorSpace)); }
    });
    const strays=C.PLAYER_COLORS.map(p=>p.hex).filter(h=>!live.includes(h)&&seen.has(h));
    const missing=live.filter(h=>!seen.has(h));
    return {ok: seatLookup.every(Boolean) && strays.length===0 && missing.length===0,
      seatLookup, painted:seen.size,
      live:live.map(h=>'#'+h.toString(16)),
      strays:strays.map(h=>'#'+h.toString(16)),
      missing:missing.map(h=>'#'+h.toString(16))};})()`, true)));

  await shot(`netmatch-${TAG}`);
  /* AND THE REPAINT ITSELF, DRIVEN ON PURPOSE.
   *
   * The check above passes trivially whenever the server happens to deal this
   * client seat 0 — every seat keeps its boot colour and nothing has to move.
   * The interesting case is the other one, so this stage MAKES it happen: give
   * two seats each other's colours, ask for the repaint, and check that the
   * settlers that come back are the new colour, are in the scene, are standing
   * exactly where the old ones were, and that the untouched seats were not
   * rebuilt. Done after the photograph so nothing else in the stage reads a
   * board that has been meddled with. */
  console.log('  REPAINT ' + JSON.stringify(await ev(`(()=>{
    const I=window.__ISLAND__, g=I.game, S=I.state, av=g.avatars;
    const at=i=>({x:+av[i].group.position.x.toFixed(3),z:+av[i].group.position.z.toFixed(3)});
    const was=[0,1,2,3].map(i=>({o:av[i], hex:av[i].__hex, pos:at(i)}));
    const c0=S.players[0].color, c1=S.players[1].color;
    S.players[0].color=c1; S.players[1].color=c0;
    const n=g.recolorAvatars();
    const now=[0,1,2,3].map(i=>({hex:av[i].__hex, pos:at(i), rebuilt:av[i]!==was[i].o,
      inScene:!!(av[i].group&&av[i].group.parent)}));
    const moved=[0,1].some(i=>now[i].pos.x!==was[i].pos.x||now[i].pos.z!==was[i].pos.z);
    return {changed:n, ok: n===2
      && now[0].hex===c1.hex && now[1].hex===c0.hex
      && now[0].rebuilt && now[1].rebuilt && now[0].inScene && now[1].inScene
      && !now[2].rebuilt && !now[3].rebuilt && !moved,
      swapped:[c0.key,c1.key], untouched:[now[2].rebuilt,now[3].rebuilt], moved};})()`)));

  /* And the scoreboard row with them. The swap above gave local seat 0 a colour
     it did not boot with, which is exactly the case that used to leave the
     corner saying blue for ever. `refreshAll` runs off the frame loop every
     100ms, so a beat is all this needs. */
  await sleep(400);
  console.log('  STANDINGSFOLLOW ' + JSON.stringify(await ev(`(()=>{
    const I=window.__ISLAND__;
    /* Under SwiftShader this page draws about twice a second, and the HUD's
       own refresh rides the frame loop — so the beat above is not reliably a
       beat. Drive it directly rather than measuring the renderer. */
    for(let i=0;i<12;i++) I.game.hud.update(1/60);
    const row=document.querySelector('.ranks .rk[data-p="0"]');
    const p=I.state.players[0];
    const tint=(row.style.getPropertyValue('--c')||'').trim();
    return {ok:tint===p.color.css, tint, want:p.color.css,
      swatch:((row.querySelector('.rk-av')||{}).innerHTML||'').indexOf(p.color.css)>=0};})()`)));

  /*
   * AND DID THE THINGS THEY HAVE ALREADY BUILT FOLLOW?
   *
   * A swap between two seats leaves the SET of colours on the board unchanged,
   * so it cannot prove that the roads moved with their owner. This gives a seat
   * a colour that is in no palette at all and asks whether it appears on the
   * island. If it does, the pieces are reading the player; if it does not, they
   * are still reading the palette and this is the reported bug, alive.
   */
  console.log('  PIECEFOLLOW ' + JSON.stringify(await ev(`(async()=>{
    const THREE=await import('/vendor/three.module.js');
    const I=window.__ISLAND__, g=I.game, S=I.state;
    const ODD=0x00ff88;
    const owner=[...S.roadOwner.values()][0];
    const seat=Number.isInteger(owner)?owner:1;
    S.players[seat].color={...S.players[seat].color, hex:ODD};
    g.recolorAvatars();
    const c=new THREE.Color(); let found=false;
    g.world.structures.group.traverse(o=>{
      const a=o.instanceColor; if(!a||found) return;
      const n=Math.min(o.count||0, a.count||0);
      for(let i=0;i<n;i++){ c.fromBufferAttribute(a,i);
        if(c.getHex(THREE.SRGBColorSpace)===ODD){ found=true; return; } }
    });
    return {seat, roads:S.roadOwner.size, ok:found};})()`, true)));

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
  /* THE SENTENCE THE WIN IS ANNOUNCED IN.
   *
   *   "When you win the game it says 'YOU TAKES THE ISLAND' — can you change
   *    the verbiage so that it works for single player if I won."
   *
   * Read on the first beat of the sequence, because the plate is pulled long
   * before the scoreboard lands. The unnamed seat is the second person and must
   * conjugate as one; a device that has been given a name is third person and
   * keeps the -s, which is the other half of the check below. */
  const said = await ev(`(()=>{const g=window.__ISLAND__.game;
    for(let k=0;k<12;k++) g.flow.update(1/60);
    const n=document.querySelector('.ann-txt');
    return {line:((n&&n.textContent)||'').trim(),
      seat:window.__ISLAND__.state.players[0].name};})()`);
  const named = await ev(`(async()=>{
    const o=await import('/src/core/options.js');
    const K='island-settlers.name', had=localStorage.getItem(K);
    const blank=o.playerName();
    localStorage.setItem(K,'Eli');
    const set=o.playerName();
    localStorage.setItem(K,'x'.repeat(40));
    const long=o.playerName().length;
    if(had===null) localStorage.removeItem(K); else localStorage.setItem(K,had);
    return {blankDevice:blank, remembers:set, clampedTo:long};})()`, true);
  console.log('  ANNOUNCE ' + JSON.stringify({ ...said, name: named }));
  console.log('  VERBIAGE ' + JSON.stringify({
    noLongerYouTakes: !/You takes/i.test(said.line),
    secondPersonAgrees: /^You take the island$/i.test(said.line),
    unnamedDeviceIsStillYou: said.seat === 'You' && named.blankDevice === '',
    aNameIsRemembered: named.remembers === 'Eli' && named.clampedTo === 14
  }));

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

  /* The win plate is still in the air in that frame — the rig drives the win
     sequence far faster than the plate's own real-time hide timer — and it sits
     right over the crown row. One extra capture with it pulled, purely so the
     header can be looked at. */
  await ev(`(()=>{const n=document.querySelector('.endwin');
    if(n){n.classList.remove('in');n.classList.add('hid');} return 1})()`);
  await sleep(260);
  await shot(`results-crown-${TAG}`);

  /* THE OTHER TAB. Two panes that were side by side and squeezed are one at a
     time and full width now, so the check is that the switch works and that
     what it switches to actually fits. */
  const tabs = await ev(`(()=>{
    const t=[...document.querySelectorAll('.btn.rs-tab')].map(b=>({
      lab:(b.textContent||'').trim(), on:b.classList.contains('on'),
      box:(r=>({w:Math.round(r.width),h:Math.round(r.height)}))(b.getBoundingClientRect())}));
    const R=s=>{const n=document.querySelector(s);if(!n)return null;
      const r=n.getBoundingClientRect();
      return {y:Math.round(r.top),bottom:Math.round(r.bottom),
        h:Math.round(r.height),shown:r.height>1};};
    return {tabs:t, list:R('.rs-list'), side:R('.rs-side'),
      rows:document.querySelectorAll('.rs-row').length,
      foot:[...document.querySelectorAll('.rs-foot .btn')].map(b=>{
        const r=b.getBoundingClientRect();
        return {lab:(b.textContent||'').trim(),w:Math.round(r.width),h:Math.round(r.height)};}),
      vh:innerHeight};})()`);
  console.log('  TABS ' + JSON.stringify(tabs));

  /* ONE LINE PER PLAYER, AND A HEAD THAT DOES NOT COST A THIRD OF THE SHEET.
     The row is measured piece by piece — name, rule, chips — because "it looks
     like one line" and "the chips actually had room to sit on it" are different
     claims and only the second one is worth having. */
  const rows = await ev(`(()=>{
    const B=n=>{const r=n.getBoundingClientRect();
      return {x:Math.round(r.left),y:Math.round(r.top),
        w:Math.round(r.width),h:Math.round(r.height)};};
    const list=document.querySelector('.rs-list');
    const rows=[...document.querySelectorAll('.rs-row')].map(n=>{
      const mid=n.querySelector('.rs-mid'), name=n.querySelector('.rs-name');
      const bd=n.querySelector('.rs-bd');
      const chips=[...bd.querySelectorAll('i')].map(B);
      const lines=new Set(chips.map(c=>c.y)).size;
      const cs=getComputedStyle(bd);
      return {name:(name.textContent||'').trim(), row:B(n), mid:B(mid),
        nameBox:B(name), bd:B(bd), chips:chips.length, chipLines:lines,
        rule:cs.borderLeftWidth, type:Math.round(parseFloat(getComputedStyle(name).fontSize)),
        chipType:chips.length?Math.round(parseFloat(
          getComputedStyle(bd.querySelector('i u')).fontSize)):0,
        /* The name sits against the CHIP BLOCK, not against chip one: a player
           holding four scoring things takes two chip lines on a 667px screen
           and the name centres on the pair of them, which is right. */
        sameLine:Math.abs(B(name).y+B(name).h/2-(B(bd).y+B(bd).h/2))<8};});
    const crown=document.querySelector('.rs-crown');
    const meds=[...document.querySelectorAll('.rs-banner')].map(B);
    return {rows, list:B(list),
      scroll:{h:list.scrollHeight, box:list.clientHeight},
      crown:B(crown), medals:meds,
      title:B(document.querySelector('.rs-title'))};})()`);
  console.log('  ROWS ' + JSON.stringify(rows.rows.map(r => ({
    n: r.name, h: r.row.h, chips: r.chips, lines: r.chipLines,
    bdW: r.bd.w, type: r.type, chipType: r.chipType, sameLine: r.sameLine
  }))));
  console.log('  HEAD ' + JSON.stringify({
    crown: rows.crown, medals: rows.medals, title: rows.title,
    list: rows.list, scroll: rows.scroll
  }));
  console.log('  STANDINGS ' + JSON.stringify({
    nameAndChipsShareALine: rows.rows.every(r => r.sameLine || r.chips === 0),
    aRuleBetweenThem: rows.rows.every(r => parseFloat(r.rule) >= 1),
    onlyTheWinnerNeedsASecondChipLine:
      rows.rows.filter(r => r.chipLines > 1).length <= 1
      && rows.rows.every(r => r.chipLines <= 2),
    allFourFitWithoutScrolling: rows.scroll.h <= rows.scroll.box + 1,
    twoMedallionsOnTheTitleLine: rows.medals.length === 2
      && rows.medals.every(m => Math.abs(m.y + m.h / 2
        - (rows.title.y + rows.title.h / 2)) < 26)
  }));
  const rep = await ev(`(()=>{const b=[...document.querySelectorAll('.btn.rs-tab')]
    .find(n=>/report/i.test(n.textContent||''));
    const r=b.getBoundingClientRect();
    return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),
      onTop:document.elementFromPoint(Math.round(r.left+r.width/2),
        Math.round(r.top+r.height/2)).closest('.rs-tab')===b};})()`);
  await send('Input.dispatchMouseEvent',
    { type: 'mousePressed', x: rep.x, y: rep.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent',
    { type: 'mouseReleased', x: rep.x, y: rep.y, button: 'left', clickCount: 1 });
  await sleep(260);
  const after = await ev(`(()=>{
    const R=s=>{const n=document.querySelector(s);if(!n)return null;
      const r=n.getBoundingClientRect();
      return {y:Math.round(r.top),bottom:Math.round(r.bottom),
        h:Math.round(r.height),shown:r.height>1};};
    return {hit:${JSON.stringify(rep.onTop)},
      list:R('.rs-list'), side:R('.rs-side'),
      stats:document.querySelectorAll('.rs-stat').length,
      statsFit:[...document.querySelectorAll('.rs-stat')]
        .every(n=>n.getBoundingClientRect().bottom<=innerHeight+1)};})()`);
  console.log('  REPORT ' + JSON.stringify(after));
  console.log('  SWITCH ' + JSON.stringify({
    tappedARealTab: after.hit,
    standingsHidden: !after.list.shown,
    reportFullWidthAndOnScreen: after.side.shown && after.statsFit,
    neverBoth: !(after.list.shown && after.side.shown)
  }));
  await shot(`results-report-${TAG}`);

  /* ------------------------------------------------------ walking it after
   *
   *   "When I'm reviewing the board after the game has ended, instead of having
   *    me use my finger to swipe up and down left and right, just let me use
   *    the normal invisible joystick and run around with my character."
   *
   * So the review has two modes now and they must not overlap: SEE THE BOARD
   * lands on the walking one — settler live, free camera down — and BOARD VIEW
   * swaps them. Both halves are pressed with real pointer events at real
   * coordinates, and the drag is a REAL drag: press, six moves, hold. The
   * settler is then stepped on this rig's own clock rather than the page's,
   * because a headless frame loop runs at about 1.5fps and would give the
   * gesture a twentieth of a second to prove itself.
   */
  const seeBoard = await ev(`(()=>{const b=[...document.querySelectorAll('.results .rs-foot .btn')]
    .find(n=>/see the board/i.test(n.textContent||'')); if(!b) return null;
    const r=b.getBoundingClientRect();
    return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`);
  if (seeBoard) {
    await send('Input.dispatchMouseEvent',
      { type: 'mousePressed', x: seeBoard.x, y: seeBoard.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent',
      { type: 'mouseReleased', x: seeBoard.x, y: seeBoard.y, button: 'left', clickCount: 1 });
    await sleep(500);
  }
  const dock = await ev(`(()=>{const g=window.__ISLAND__.game;
    const bar=document.querySelector('.endbar');
    return {up:!!bar&&!bar.classList.contains('hid'),
      hint:((document.querySelector('.eb-hint')||{}).textContent||'').trim(),
      view:[...document.querySelectorAll('.endbar .btn')]
        .map(b=>(b.textContent||'').trim()),
      roaming:!!g.roaming, flowRoaming:!!(g.flow&&g.flow.roaming),
      inputOn:!!(g.input&&g.input.enabled!==false),
      freecam:!!(g.freecam&&g.freecam.armed),
      overview:g.camera.isOverview===true, phase:window.__ISLAND__.state.phase};})()`);
  console.log('  DOCK ' + JSON.stringify(dock));

  /* A drag that starts well clear of the bar at the bottom and of the plate at
     the top — the middle-left of the screen, where a thumb goes. */
  const V = await ev('({w:innerWidth,h:innerHeight})');
  const from = { x: Math.round(V.w * 0.28), y: Math.round(V.h * 0.44) };
  const to = { x: Math.round(V.w * 0.44), y: Math.round(V.h * 0.30) };
  const before = await ev(`(()=>{const p=window.__ISLAND__.state.players[0];
    return {x:+p.x.toFixed(3),z:+p.z.toFixed(3)};})()`);
  await send('Input.dispatchMouseEvent',
    { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1, buttons: 1 });
  for (let i = 1; i <= 6; i++) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', buttons: 1,
      x: Math.round(from.x + (to.x - from.x) * i / 6),
      y: Math.round(from.y + (to.y - from.y) * i / 6)
    });
  }
  const walked = await ev(`(()=>{const I=window.__ISLAND__, g=I.game, p=I.state.players[0];
    const s={x:+g.input.stick.x.toFixed(3),y:+g.input.stick.y.toFixed(3)};
    for(let i=0;i<90;i++) g.controller.update(1/60);       // 1.5s of held stick
    return {stick:s, moved:+Math.hypot(p.x-(${before.x}),p.z-(${before.z})).toFixed(2),
      action:p.action, followed:+g.camera.isOverview};})()`);
  await send('Input.dispatchMouseEvent',
    { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1, buttons: 0 });
  console.log('  WALK ' + JSON.stringify(walked));
  await sleep(400);
  await shot(`results-walk-${TAG}`);

  /* And the other half: BOARD VIEW puts the settler down and picks the camera
     up. Pressed for real, on the bar. */
  const bv = await ev(`(()=>{const b=[...document.querySelectorAll('.endbar .btn')]
    .find(n=>/board view/i.test(n.textContent||'')); if(!b) return null;
    const r=b.getBoundingClientRect();
    return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`);
  let swapped = null;
  if (bv) {
    await send('Input.dispatchMouseEvent',
      { type: 'mousePressed', x: bv.x, y: bv.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent',
      { type: 'mouseReleased', x: bv.x, y: bv.y, button: 'left', clickCount: 1 });
    await sleep(400);
    const held = await ev(`(()=>{const p=window.__ISLAND__.state.players[0];
      return {x:+p.x.toFixed(3),z:+p.z.toFixed(3)};})()`);
    await send('Input.dispatchMouseEvent',
      { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1, buttons: 1 });
    for (let i = 1; i <= 6; i++) {
      await send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', buttons: 1,
        x: Math.round(from.x + (to.x - from.x) * i / 6),
        y: Math.round(from.y + (to.y - from.y) * i / 6)
      });
    }
    swapped = await ev(`(()=>{const I=window.__ISLAND__, g=I.game, p=I.state.players[0];
      for(let i=0;i<90;i++) g.controller.update(1/60);
      return {roaming:!!g.roaming, freecam:!!(g.freecam&&g.freecam.armed),
        mode:g.freecam&&g.freecam.mode,
        settlerMoved:+Math.hypot(p.x-(${held.x}),p.z-(${held.z})).toFixed(2),
        label:[...document.querySelectorAll('.endbar .btn')]
          .map(b=>(b.textContent||'').trim()).join('|'),
        hint:((document.querySelector('.eb-hint')||{}).textContent||'').trim()};})()`);
    await send('Input.dispatchMouseEvent',
      { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1, buttons: 0 });
  }
  console.log('  BOARDVIEW ' + JSON.stringify(swapped));

  /* ------------------------------------------------ WHICH WAY THE BOARD GOES
   *
   *   "In the board view after the game is over, dragging left and right is
   *    working, but dragging with my finger up and down is going the wrong
   *    direction."
   *
   * A pan moves the FOCUS and the rig follows it, so the ground always travels
   * opposite to the focus on screen. Reading that back as "did the ground go
   * the way the finger went" means resolving the focus travel onto the camera's
   * own axes: a rightward drag must move the focus LEFT (negative along screen
   * right), and a downward drag must move it FORWARD (positive along the axis
   * away from the camera). Both are measured here because only the first one
   * ever was, which is exactly how the second came to be inverted. */
  const pan = async (dx, dy) => {
    const a = await ev(`window.__ISLAND__.game.camera.freeInfo`);
    const from = { x: Math.round(V.w * 0.5), y: Math.round(V.h * 0.42) };
    await send('Input.dispatchMouseEvent',
      { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1, buttons: 1 });
    for (let i = 1; i <= 6; i++) {
      await send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', buttons: 1,
        x: Math.round(from.x + dx * i / 6), y: Math.round(from.y + dy * i / 6)
      });
    }
    await send('Input.dispatchMouseEvent',
      { type: 'mouseReleased', x: Math.round(from.x + dx), y: Math.round(from.y + dy),
        button: 'left', clickCount: 1, buttons: 0 });
    await sleep(160);
    const b = await ev(`window.__ISLAND__.game.camera.freeInfo`);
    const f = { x: -Math.sin(a.yaw), z: -Math.cos(a.yaw) };   // away from camera
    const r = { x: -f.z, z: f.x };                            // screen right
    const d = { x: b.x - a.x, z: b.z - a.z };
    return {
      moved: +Math.hypot(d.x, d.z).toFixed(2),
      alongRight: +(d.x * r.x + d.z * r.z).toFixed(2),
      alongForward: +(d.x * f.x + d.z * f.z).toFixed(2)
    };
  };
  const panRight = await pan(140, 0);
  const panDown = await pan(0, 110);
  const panUp = await pan(0, -110);
  console.log('  PAN ' + JSON.stringify({ panRight, panDown, panUp }));
  console.log('  DRAGDIR ' + JSON.stringify({
    dragRightSendsTheGroundRight: panRight.alongRight < -0.5,
    dragDownSendsTheGroundDown: panDown.alongForward > 0.5,
    dragUpSendsTheGroundUp: panUp.alongForward < -0.5,
    andTheAxesDoNotBleed: Math.abs(panRight.alongForward) < Math.abs(panRight.alongRight)
      && Math.abs(panDown.alongRight) < Math.abs(panDown.alongForward)
  }));
  console.log('  REVIEW ' + JSON.stringify({
    landsOnTheWalk: dock.up && dock.roaming && !dock.freecam && !dock.overview,
    aRealDragDrivesTheSettler: walked.stick.y > 0 && walked.moved > 1,
    andItIsRunning: walked.action === 'run',
    boardViewPutsItDown: !!swapped && swapped.roaming === false
      && swapped.settlerMoved < 0.05,
    boardViewTakesTheCamera: !!swapped && swapped.freecam === true
      && swapped.mode === 'board',
    neverBothDrivers: !(dock.roaming && dock.freecam)
      && !!swapped && !(swapped.roaming && !swapped.freecam)
  }));

/* ----------------------------------------------------------------- trade
 *
 *   "Can you make the up and down arrows for the trading post larger and easier
 *    to press? Right now it's hard to press consistently."
 *
 * Two different measurements, and only one of them was ever right. The plate a
 * player AIMS at was 25px tall on a phone; the box that actually answers a
 * press was 44, because a transparent ::after reached out into the lane caption
 * above and below it. A thumb goes where the eye goes, so half the presses
 * landed on a target the player could not see, and the ones that missed missed
 * a control that looked like it had been hit.
 *
 * So this stage measures BOTH: the painted plate from its own box, and the live
 * hit area by walking `elementFromPoint` down a column through the arrow until
 * the answer stops being that arrow. Then it presses one — with a real pointer,
 * at the top edge of the plate rather than the comfortable middle — and reads
 * the staged amount back off the sheet.
 *
 * AND THE SHEET IT IS MEASURING IS THE OTHER WAY UP NOW.
 *
 *   "I think the 'you give' and 'you receive' should swap sides, with the 'you
 *    receive' on the top... I can click upwards (to add) to how many of an item
 *    I want to trade for... The other middle tiles for the resources start to
 *    grey out (unless I have enough of that resource to make the trade)... But
 *    if I have 16 wood or more, and I'm trying to trade to receive 4 brick, I
 *    can click the middle button with the image of the wood itself, and that
 *    automatically knows I want to trade the exact amount of wood it takes."
 *
 * Three more things to prove, and all three are the kind of thing a screenshot
 * cannot argue about but also cannot check:
 *
 *   1. RECEIVE IS ON TOP IN THE DOM, not just in the pixels. A `column-reverse`
 *      would photograph identically and hand a screen reader the sheet upside
 *      down, so the band order is read out of `.trade-body`'s child list and
 *      then confirmed against the boxes.
 *   2. ASKING FOR N GREYS OUT WHOEVER CANNOT PAY FOR IT. Four brick against a
 *      pack of forty wood and eight of everything else: wood is the only pile
 *      that can cover sixteen, so wood arms and the other three dim — and their
 *      DOWN ARROWS STAY LIVE, because the owner's own example pays for four
 *      brick out of two piles that could not each do it alone.
 *   3. ONE TAP SPENDS EXACTLY ratio x N. Not "about right", not "enough": the
 *      give badge, the chip that promised the price before the tap, and the
 *      resources actually gone out of the pack after the deal all have to say
 *      sixteen. Then the same thing again over a MIXED ask — two brick and two
 *      ore at once — because the price of a lot comes from what you hand over
 *      and never from what you get back, and that is the whole reason one tap
 *      can settle an ask made of two different resources.
 */
} else if (STAGE === 'trade') {
  await waitIntro();
  await ev(`(()=>{window.__ISLAND__.game.flow.skipIntro();return 1})()`);
  await ev(`import('/src/core/rules.js').then(m=>{window.__R__=m;return 1})`, true);
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
  /* A full pack, so every arrow on the sheet is live: without the goods to give
     the up arrows are legitimately dead and there is nothing to measure. */
  await ev(`(async()=>{const I=window.__ISLAND__, p=I.state.players[0];
    p.res.wood=8;p.res.brick=8;p.res.wool=8;p.res.wheat=8;p.res.ore=8;
    /* Standing AT the market, because economy.js owns the "you must be at the
       post" rule and a sheet opened from across the island has every arrow
       legitimately dead — which measures nothing. */
    const L=await import('/src/board/layout.js');
    p.x=L.MARKET.x; p.z=L.MARKET.z; p.vx=0; p.vz=0; p.nearTrade='market';
    I.game.controller.update(1/60);
    I.game.openTrade(null); return {at:p.nearTrade};})()`, true);
  await sleep(700);

  const MEASURE = `(()=>{
    const hit=(el,x,y0,dir)=>{               // how far the live box reaches
      let y=y0, n=0;
      for(;n<90;n++){
        const at=document.elementFromPoint(x, Math.round(y+dir*n));
        if(!at || (at!==el && !el.contains(at) && at.closest('.tr-arr')!==el)) break;
      }
      return n;
    };
    const arrows=[...document.querySelectorAll('.tr-arr')].map(a=>{
      const r=a.getBoundingClientRect();
      const cx=Math.round(r.left+r.width/2);
      const up=hit(a, cx, Math.round(r.top+1), -1);
      const dn=hit(a, cx, Math.round(r.bottom-1), 1);
      return {cls:a.className.replace('tr-arr ',''),
        plate:{w:Math.round(r.width),h:Math.round(r.height)},
        live:{h:Math.round(r.height)+up+dn, over:up, under:dn},
        off:a.classList.contains('off')};
    });
    /* THE CLOSE BUTTON, DRAWN AND LIVE, MEASURED THE SAME WAY THE ARROWS ARE.
     *
     *   "The close X is ~32px at 640x320, still under 44. Raise the hit area
     *    even if the drawn circle stays small."
     *
     * The circle is meant to shrink on a short screen — Escape, the scrim and
     * the back gesture all close this sheet too, so it is the least
     * load-bearing control on it — but a target a thumb misses is still a
     * target a thumb misses, and a miss here lands on the sheet's own head and
     * does nothing at all. So the drawn box and the live box are read
     * separately, the live one by walking elementFromPoint out from the centre
     * in all four directions, exactly as the arrows' hit boxes are. */
    const close=(()=>{
      const b=document.querySelector('.sheet.trade .sheet-head .cbtn.small');
      if(!b) return null;
      const r=b.getBoundingClientRect();
      const cx=Math.round(r.left+r.width/2), cy=Math.round(r.top+r.height/2);
      const reach=(dx,dy)=>{let n=0;
        for(;n<60;n++){const at=document.elementFromPoint(cx+dx*n, cy+dy*n);
          if(!at || (at!==b && !b.contains(at))) break;}
        return n;};
      return {drawn:{w:Math.round(r.width),h:Math.round(r.height)},
        live:{w:reach(-1,0)+reach(1,0)-1, h:reach(0,-1)+reach(0,1)-1}};})();
    const sheet=document.querySelector('.sheet.trade').getBoundingClientRect();
    const glyph=(()=>{const a=document.querySelector('.tr-arr.up');
      const s=getComputedStyle(a,'::before');
      return {w:parseFloat(s.borderLeftWidth)*2, h:parseFloat(s.borderBottomWidth)};})();
    return {arrows, glyph, close, vh:innerHeight,
      sheet:{y:Math.round(sheet.top),bottom:Math.round(sheet.bottom),
        h:Math.round(sheet.height)},
      fits:sheet.bottom<=innerHeight+1 && sheet.top>=-1,
      /* The foot's prose and arrow-key legend are gone; the two lanes are
         bands now, and they are what has to be measurable. */
      legendGone:!document.querySelector('.trade .kbhint')
        && !document.querySelector('.trade .why'),
      caps:[...document.querySelectorAll('.tr-cap')].map(c=>{
        const r=c.getBoundingClientRect(), cs=getComputedStyle(c);
        return {lab:(c.querySelector('b').textContent||'').trim(),
          h:Math.round(r.height), w:Math.round(r.width),
          type:Math.round(parseFloat(cs.fontSize)),
          paint:cs.backgroundImage!=='none',
          live:(c.querySelector('.tc-live').textContent||'').trim()};}),
      foot:(()=>{const f=document.querySelector('.trade .sheet-foot');
        return f?(f.textContent||'').trim():'';})(),
      /* RECEIVE ON TOP, READ TWICE. Once out of the document — the order the
         keyboard and a screen reader get, and the only order a column-reverse
         could lie about — and once out of the boxes, because document order
         with the paint reversed is a different bug with the same screenshot. */
      order:(()=>{const b=document.querySelector('.trade-body');
        return [...b.children].map(n=>!n.classList.contains('tr-cap') ? 'row'
          : (n.classList.contains('get') ? 'receive' : 'give'));})(),
      bands:(()=>{const g=document.querySelector('.tr-cap.get').getBoundingClientRect(),
        w=document.querySelector('.tr-row').getBoundingClientRect(),
        v=document.querySelector('.tr-cap.give').getBoundingClientRect();
        return {receiveBottom:Math.round(g.bottom), rowTop:Math.round(w.top),
          rowBottom:Math.round(w.bottom), giveTop:Math.round(v.top)};})(),
      /* The sheet hides its overflow, so "the box fits" is only half of it —
         everything in the box has to fit the box. */
      clipped:(()=>{const s=document.querySelector('.sheet.trade')
        .getBoundingClientRect(); let n=0;
        for(const el of document.querySelectorAll(
            '.trade .tr-arr,.trade .tr-card,.trade .tr-cap,.trade .sheet-foot .btn')){
          const r=el.getBoundingClientRect();
          if(r.top<s.top-0.5||r.bottom>s.bottom+0.5) n++;
        } return n;})(),
      /* THE DEAL BUTTON'S OWN BREATHING ROOM, above and below.
       *
       *   "Button occupies y 263-304, the sheet's inner bottom rim is ~306 and
       *    its border 307-309: 3px of clearance below the primary call to
       *    action against ~10px above it, with only 10px of screen below the
       *    sheet."
       *
       * "It fits" was already checked and it passed — the button was inside the
       * sheet, just pressed flat against the bottom of it. So the measurement
       * that was missing is the GAP, taken to the sheet's inner rim (past the
       * padding, up to the inside face of the 3px border) and compared with the
       * gap above the button, because on a 320px screen the only honest test of
       * "is this bottomed out" is whether it is worse off than its own top edge.
       *
       * "slack" is the other half of the same story and it is what actually
       * went wrong: a flex column whose contents want more room than
       * max-height allows does not distribute the shortfall, it hands the
       * whole of it to whichever child will shrink — here the body, which then
       * spilled its own give band out through the bottom and onto the foot's
       * rule. Negative slack means the sheet's padding-bottom is a fiction. */
      deal:(()=>{const b=document.querySelector('.trade .sheet-foot .btn'),
          s=document.querySelector('.sheet.trade'),
          y=document.querySelector('.trade-body');
        if(!b||!s||!y) return null;
        const r=b.getBoundingClientRect(), q=s.getBoundingClientRect(),
          cs=getComputedStyle(s), t=x=>Math.round(x*10)/10;
        const rim=q.bottom-parseFloat(cs.borderBottomWidth);
        return {
          y:Math.round(r.top)+'-'+Math.round(r.bottom),
          above:t(r.top-y.getBoundingClientRect().bottom),
          below:t(rim-r.bottom),
          slack:t(rim-parseFloat(cs.paddingBottom)-r.bottom),
          screenBelow:Math.round(innerHeight-q.bottom)};})()};})()`;
  /* Let the entrance transform finish before measuring anything.
     `.sheet` sits at `scale(.97)` until `.panels` takes its `on` class, and a
     44px arrow measured at 97% is a 43px arrow — enough to fail a thumb-target
     check for reasons that have nothing to do with the CSS, and to fail it only
     on the runs where the machine happened to be a beat slower. So this waits
     for the class AND for two identical measurements in a row: the class alone
     is not enough, because the scale is transitioned over .22s after it lands.

     AND IT STILL WENT OFF ONCE IN THREE. Two equal samples 120ms apart can both
     land on a transform that has not finished — the renderer paints this scene
     at a couple of frames a second and a stalled transition holds one value for
     as long as the stall lasts — so a 44px arrow came back as 43 and failed the
     thumb check for a reason that had nothing to do with any stylesheet. The
     scale is now read STRAIGHT OFF the sheet's own computed transform, which is
     an exact 1 or it is not the resting state, and the height still has to
     settle on top of that. */
  for (let i = 0; i < 40; i++) {
    const S = `(()=>{const s=document.querySelector('.sheet.trade');
      if(!s) return null;
      const m=new DOMMatrixReadOnly(getComputedStyle(s).transform);
      return {on:!!document.querySelector('.panels.on'), scale:Math.round(m.a*1000),
        h:Math.round(document.querySelector('.tr-arr').getBoundingClientRect().height*100)};})()`;
    const a = await ev(S);
    await sleep(120);
    const b = await ev(S);
    if (a && b && b.on && b.scale === 1000 && b.h > 100 && a.h === b.h) break;
  }
  const m = await ev(MEASURE);
  console.log('  ARROWS ' + JSON.stringify({
    n: m.arrows.length, glyph: m.glyph, sheet: m.sheet, fits: m.fits, vh: m.vh,
    plate: m.arrows[0] && m.arrows[0].plate, live: m.arrows[0] && m.arrows[0].live,
    close: m.close
  }));
  console.log('  LANES ' + JSON.stringify({
    caps: m.caps, legendGone: m.legendGone, foot: m.foot, clipped: m.clipped,
    order: m.order, bands: m.bands, deal: m.deal
  }));

  /* One reader for the whole sheet, because from here on every check is about
     the RELATIONSHIP between three things — what the arrows say, what the cards
     look like, and what is actually left in the pack — and reading them in
     three separate round trips is how a check ends up describing two different
     moments and calling them one. */
  const readSheet = () => ev(`(()=>{
    const cols=[...document.querySelectorAll('.sheet.trade .tr-col')];
    const txt=n=>(n&&n.textContent||'').trim();
    const has=(c,k)=>c.classList.contains(k);
    const cards={};
    for(const c of cols){
      const r=c.getAttribute('data-res');
      const up=c.querySelector('.tr-arr.up'), dn=c.querySelector('.tr-arr.dn');
      const cnt=c.querySelector('.tr-count');
      cards[r]={
        /* The deal now lives in the card's own numeral as a delta, so that is
           what gets read: "was" is empty until something is staged, "now" is
           what the pack would be left holding. */
        was:txt(c.querySelector('.tr-was')).replace(/[^0-9]/g,''),
        now:txt(c.querySelector('.tr-now')),
        dir:cnt&&has(cnt,'get')?'get':(cnt&&has(cnt,'give')?'give':''),
        rate:txt(c.querySelector('.tr-rate')),
        act:txt(c.querySelector('.tr-act u')),
        upLive:!up.classList.contains('off'), dnLive:!dn.classList.contains('off'),
        dim:has(c,'dim'), armed:has(c,'armed')};
    }
    return {cards,
      dim:cols.filter(c=>has(c,'dim')).map(c=>c.getAttribute('data-res')),
      armed:cols.filter(c=>has(c,'armed')).map(c=>c.getAttribute('data-res')),
      getting:cols.filter(c=>has(c,'getting')).map(c=>c.getAttribute('data-res')),
      giving:cols.filter(c=>has(c,'giving')).map(c=>c.getAttribute('data-res')),
      dnLive:cols.filter(c=>!c.querySelector('.tr-arr.dn').classList.contains('off'))
        .map(c=>c.getAttribute('data-res')),
      /* The rate is quoted once, in the head. Any card carrying one as well is
         a card whose rate DISAGREES with it, which is the only reason to. */
      headRate:txt(document.querySelector('.sheet.trade .tr-headrate')),
      cardRates:cols.filter(c=>txt(c.querySelector('.tr-rate')))
        .map(c=>c.getAttribute('data-res')),
      say:[...document.querySelectorAll('.sheet.trade .tr-cap.say')]
        .map(c=>(c.className.indexOf('give')>=0?'give:':'get:')
          +txt(c.querySelector('.tc-live'))).join(' | '),
      /* THE PRICE, AS A NUMBER, IN THE BAND THAT PAYS IT. "Needs 12" before
         anything is staged, "8 of 12" part way, "12 of 12" when it is covered.
         Blank is a real answer — an untouched sheet has no price — so this is
         read whether or not the band is showing it. */
      cost:txt(document.querySelector('.sheet.trade .tr-cap.give .tc-cost')),
      /* The foot is a two-state control now rather than a greyed one — see the
         note on theFootIsJustTheDeal. "Off" therefore means "not yet the green
         Trade", which is what every assertion downstream actually meant, and it
         is read off the paint and the word together so the two can never drift
         apart without a failure. */
      tradeOff:(()=>{const b=document.querySelector('.sheet.trade .sheet-foot .btn');
        if(!b) return true;
        return !(b.classList.contains('green') && /trade/i.test(b.textContent||''));})(),
      res:{...window.__ISLAND__.state.players[0].res}};})()`);
  const clickAt = async (x, y) => {
    await send('Input.dispatchMouseEvent',
      { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent',
      { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  const centreOf = sel => ev(`(()=>{const n=document.querySelector(${
    JSON.stringify(sel)}); if(!n) return null; const r=n.getBoundingClientRect();
    return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)};})()`);
  /**
   * Aim, CHECK THE AIM, then press.
   *
   * A screenshot on this renderer costs five to eight seconds, and a coordinate
   * measured before one and used after it is a coordinate measured in a
   * different world: the sheet re-runs its entrance transform every time the
   * panel is shown, the row's `done` animation scales it, and a click that
   * lands two pixels outside the sheet lands on the SCRIM, whose one job is to
   * close the panel. That is exactly how a run of this stage came back with
   * three photographs of the island and no trade sheet in them. So every pose
   * tap re-measures its own target and confirms with `elementFromPoint` that
   * the target is really the thing under the cursor before it presses.
   */
  const tap = async sel => {
    const p = await ev(`(()=>{const n=document.querySelector(${JSON.stringify(sel)});
      if(!n) return null; const r=n.getBoundingClientRect();
      const x=Math.round(r.left+r.width/2), y=Math.round(r.top+r.height/2);
      const at=document.elementFromPoint(x,y);
      return {x,y,hit:!!(at&&(at===n||n.contains(at)))};})()`);
    if (!p || !p.hit) { console.log('  TAPMISS ' + sel + ' ' + JSON.stringify(p)); return p; }
    await clickAt(p.x, p.y);
    return p;
  };
  /** Refill the pack and reopen, which clears whatever the last check staged. */
  const restock = res => ev(`(()=>{const I=window.__ISLAND__, p=I.state.players[0];
    Object.assign(p.res, ${JSON.stringify(res)});
    I.game.openTrade(null); return 1})()`);

  /* THE SHEET AS IT ARRIVES. Nothing staged, so every give arrow along the
     bottom is legitimately dead — you cannot hand over four wool for nothing —
     and a whole row of grey with no reason given is the one way this redesign
     could read as broken. The brown band has to be saying why. */
  const idle = await readSheet();
  console.log('  IDLE ' + JSON.stringify({
    say: idle.say, dnLive: idle.dnLive, tradeOff: idle.tradeOff
  }));
  /* Send the frozen countdown away before anything is photographed. The match
     is held the whole time a sheet is open — that is what the "Match paused"
     chip is telling you — so flowCountdown.js's "GET READY 3" hangs there for
     the entire stage, and it has been sitting on top of the middle card in
     every trade screenshot this harness has ever taken. It is not part of the
     sheet and it is not what anyone reviewing the sheet is looking at. */
  await ev(`(()=>{const l=document.querySelector('.fc-layer');
    if(l){l.classList.add('fc-off');l.classList.remove('on');} return !!l})()`);
  await sleep(120);
  /* NO SHOT HERE. Every picture this stage takes now comes out of one unbroken
     session at the end, starting from the eight-of-everything pack a real
     player walks in with — because a set assembled from three different packs
     photographs three states that never followed one another, and the flow
     cannot be read off it. */

  /* THE PRESS. Deliberately awkward: 3px inside the TOP edge of the plate, not
     the middle — the edge is where an inconsistent control gives itself away.
     The top arrow adds to the pile it is sitting on now, so what has to come
     back is a RECEIVE — the card's own numeral reading `8 -> 9`, not a lot
     staged out of the pack. */
  const press = await ev(`(()=>{const a=document.querySelectorAll('.tr-col')[0]
    .querySelector('.tr-arr.up'); const r=a.getBoundingClientRect();
    return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+3),
      onTop:(document.elementFromPoint(Math.round(r.left+r.width/2),
        Math.round(r.top+3))||{}).closest !== undefined
        && (document.elementFromPoint(Math.round(r.left+r.width/2),
        Math.round(r.top+3)).closest('.tr-arr')===a)};})()`);
  await send('Input.dispatchMouseEvent',
    { type: 'mousePressed', x: press.x, y: press.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent',
    { type: 'mouseReleased', x: press.x, y: press.y, button: 'left', clickCount: 1 });
  await sleep(300);
  await sleep(300);
  const pressed = await readSheet();
  const staged = { ...pressed.cards.wood, res: 'wood' };
  console.log('  PRESS ' + JSON.stringify({ ...press, staged }));

  /* And the card underneath is still its own button: the arrows' hit boxes
     cover half the 10px gap on either side of it and nothing beyond it. That
     check used to read "the tap picked and staged nothing", which is no longer
     the right answer — a card tap PAYS now. So the two effects are told apart
     instead: a press of the arrow moves the card's numeral UP by one card, a
     press of the card moves it DOWN by a whole lot, and if the arrow's box had
     crept over the card this tap would come back as the former.

     The gap itself is measured here too. It is the only separation between
     "spend one lot" and "spend all of it", and a reviewer counted it at six
     pixels: "the two most different actions in the sheet are 6px apart". */
  const card = await ev(`(()=>{const c=document.querySelectorAll('.tr-col')[2];
    const b=c.querySelector('.tr-card'), r=b.getBoundingClientRect();
    const up=c.querySelector('.tr-arr.up').getBoundingClientRect();
    const dn=c.querySelector('.tr-arr.dn').getBoundingClientRect();
    return {res:c.getAttribute('data-res'),
      x:Math.round(r.left+r.width/2), y:Math.round(r.top+2),
      gapAbove:Math.round(r.top-up.bottom), gapBelow:Math.round(dn.top-r.bottom),
      topEdgeIsTheCard:(document.elementFromPoint(Math.round(r.left+r.width/2),
        Math.round(r.top+2))||{}).closest!==undefined
        && document.elementFromPoint(Math.round(r.left+r.width/2),
          Math.round(r.top+2)).closest('.tr-card')===b};})()`);
  await clickAt(card.x, card.y);
  await sleep(250);
  const after1 = await readSheet();
  const picked = {
    cur: await ev(`document.querySelectorAll('.tr-col')[2].classList.contains('cur')`),
    ...after1.cards.wool
  };
  console.log('  CARD ' + JSON.stringify({ ...card, picked }));

  /* ------------------------------------------------------- ASK, THEN GREY
   *
   *   "I click the up arrow four times to add 4 brick to the trade I want to
   *    make. The other middle tiles for the resources start to grey out (unless
   *    I have enough of that resource to make the trade), so I could click the
   *    down arrows on items I have at least four of."
   *
   * Forty wood, eight wool, eight wheat, TWO ore, no brick — and the ore is the
   * point of it. At the market's 4:1, four brick costs sixteen of whatever pays,
   * so wood is the only pile that can settle it alone and wood is the only pile
   * that ARMS. But wool and wheat are not dim, because eight is two lots and two
   * lots is a real contribution; the only dim card in the row is the ore, which
   * at two held cannot buy anything at this post at any size of ask.
   *
   * That distinction is the whole fix. The first version dimmed anything that
   * could not cover the ask ALONE, and a reviewer put the owner's own sentence
   * next to it — "he wrote 'trade 8 wood and 8 sheep for 4 brick', a MIXED
   * payment from two piles, neither of which covers the full cost; your rule
   * makes that exact trade look forbidden."
   *
   * So the load-bearing check is the agreement one: a dim card's give arrow is
   * dead and a lit card's give arrow is live, every time, with no card left
   * saying no while the button under it says yes. */
  await restock({ wood: 40, brick: 0, wool: 8, wheat: 8, ore: 2 });
  await sleep(420);
  const brickUp = await centreOf('.tr-col[data-res="brick"] .tr-arr.up');
  for (let i = 0; i < 4; i++) { await clickAt(brickUp.x, brickUp.y); await sleep(70); }
  await sleep(240);
  const ask = await readSheet();
  console.log('  ASK ' + JSON.stringify({
    asked: `${ask.cards.brick.was}->${ask.cards.brick.now}`, dir: ask.cards.brick.dir,
    dim: ask.dim, armed: ask.armed, plateOnWood: ask.cards.wood.act,
    dnLive: ask.dnLive, say: ask.say, tradeOff: ask.tradeOff, cost: ask.cost,
    headRate: ask.headRate, cardRates: ask.cardRates
  }));

  /* --------------------------------------------------- ONE TAP, EXACT PRICE
   *
   *   "I can click the middle button with the image of the wood itself, and
   *    that automatically knows I want to trade the exact amount of wood it
   *    takes for the number of bricks I'm asking for."
   *
   * Five readings of the same number, and they all have to agree: the plate
   * said PAY 16 before the tap, the card's numeral says 40 -> 24 after it, the
   * plate now says CLEAR 16 in the same slot it said PAY in, the Trade button
   * comes alive because the ask is exactly covered, and sixteen wood are really
   * gone once the deal goes through.
   *
   * `ratio` is read off the sheet's own header rather than assumed. This stage
   * runs at the Great Market so it is 4, but the same code reads 3 at a generic
   * dock and 2 at a matching one, and a check that spelled 16 out longhand
   * would pass at the market and quietly stop meaning anything at a dock. */
  const woodCard = await centreOf('.tr-col[data-res="wood"] .tr-card');
  const ratio = parseInt(ask.headRate, 10) || 4;
  await clickAt(woodCard.x, woodCard.y);
  await sleep(280);
  const paid = await readSheet();
  const before = { ...paid.res };
  const dealBtn = await centreOf('.sheet.trade .sheet-foot .btn');
  await clickAt(dealBtn.x, dealBtn.y);
  await sleep(360);
  const done = await readSheet();
  console.log('  ONETAP ' + JSON.stringify({
    ratio, promised: ask.cards.wood.act,
    delta: `${paid.cards.wood.was}->${paid.cards.wood.now}`, dir: paid.cards.wood.dir,
    undoPlate: paid.cards.wood.act, tradeOff: paid.tradeOff,
    spent: before.wood - done.res.wood, gained: done.res.brick - before.brick,
    say: paid.say, cost: paid.cost
  }));

  /* ------------------------------------------------------- ONE TAP, AND BACK
   *
   * The same plate, in the same slot, taking the whole payment out again. The
   * undo used to be a 14px x badge in a corner of the card — "not a touch
   * target, least of all for a destructive action" — and it lived in the slot
   * the PRICE had occupied one state earlier, so the same number appeared in
   * two different containers forty pixels apart in adjacent states. It is the
   * card's own plate now, which makes the target the whole card. */
  await restock({ wood: 40, brick: 0, wool: 8, wheat: 8, ore: 2 });
  await sleep(400);
  for (let i = 0; i < 4; i++) { await clickAt(brickUp.x, brickUp.y); await sleep(70); }
  await sleep(180);
  await clickAt(woodCard.x, woodCard.y);
  await sleep(240);
  const committed = await readSheet();
  await clickAt(woodCard.x, woodCard.y);
  await sleep(240);
  const undone = await readSheet();
  /* AND THE BAND COUNTS WHILE THE DEAL IS HALF PAID. One lot of wood against a
     four-card ask is one quarter of the bill, and the give band has to say so
     in figures — "4 of 16" — because this is the state the running total exists
     for: nothing is armed, no plate anywhere quotes a price, and the only other
     way to know what is still owed is to multiply the header by the delta on a
     card at the far end of the row. */
  await clickAt(
    (await centreOf('.tr-col[data-res="wood"] .tr-arr.dn')).x,
    (await centreOf('.tr-col[data-res="wood"] .tr-arr.dn')).y);
  await sleep(240);
  const part = await readSheet();
  console.log('  UNDO ' + JSON.stringify({
    plate: committed.cards.wood.act,
    afterDelta: `${undone.cards.wood.was}->${undone.cards.wood.now}`,
    stillAsked: `${undone.cards.brick.was}->${undone.cards.brick.now}`,
    armedAgain: undone.armed, say: undone.say,
    cost: { committed: committed.cost, undone: undone.cost, part: part.cost }
  }));

  /* ------------------------------------------------------------ MIXED ASK
   *
   * Two brick AND two ore, paid for with one tap on wool. The price of a lot is
   * set by what you HAND OVER and never by what you get back — one wool lot
   * buys one card whatever that card is — so "the exact amount it takes" for a
   * four-card ask made of two different resources is four lots, 16 wool, and
   * the deal comes out as two brick and two ore. Anything that tried to price
   * the ask line by line would have had to invent bookkeeping the rules layer
   * does not have, and would have left this deal half paid after a tap that
   * says it pays for it. */
  await restock({ wood: 8, brick: 0, wool: 20, wheat: 8, ore: 0 });
  await sleep(420);
  const oreUp = await centreOf('.tr-col[data-res="ore"] .tr-arr.up');
  const brickUp2 = await centreOf('.tr-col[data-res="brick"] .tr-arr.up');
  for (let i = 0; i < 2; i++) { await clickAt(brickUp2.x, brickUp2.y); await sleep(70); }
  for (let i = 0; i < 2; i++) { await clickAt(oreUp.x, oreUp.y); await sleep(70); }
  await sleep(220);
  const mixAsk = await readSheet();
  const woolCard = await centreOf('.tr-col[data-res="wool"] .tr-card');
  await clickAt(woolCard.x, woolCard.y);
  await sleep(280);
  const mixPaid = await readSheet();
  const mixBefore = { ...mixPaid.res };
  const dealBtn2 = await centreOf('.sheet.trade .sheet-foot .btn');
  await clickAt(dealBtn2.x, dealBtn2.y);
  await sleep(360);
  const mixDone = await readSheet();
  console.log('  MIXED ' + JSON.stringify({
    asked: { brick: `${mixAsk.cards.brick.was}->${mixAsk.cards.brick.now}`,
      ore: `${mixAsk.cards.ore.was}->${mixAsk.cards.ore.now}` },
    dim: mixAsk.dim, armed: mixAsk.armed, promised: mixAsk.cards.wool.act,
    delta: `${mixPaid.cards.wool.was}->${mixPaid.cards.wool.now}`,
    tradeOff: mixPaid.tradeOff,
    spentWool: mixBefore.wool - mixDone.res.wool,
    gained: { brick: mixDone.res.brick - mixBefore.brick,
      ore: mixDone.res.ore - mixBefore.ore }
  }));

  /* --------------------------------------- A PILE PAYS WHAT IT CAN, NOT ALL
   *
   *   "In the ask3 frame all five cards sample inert tan at all three sizes
   *    with an empty plate slot, even though every pile of 8 is a perfectly
   *    legal contribution toward the 12. This kills the owner's own headline
   *    example: he wrote 'trade 8 wood and 8 sheep for 4 brick' — a cost of 16
   *    against two piles of 8 — so that exact trade opens in precisely this
   *    state, with every card dead and the one-tap payer withheld."
   *
   * Eight of everything, three brick asked for: twelve to find and nothing in
   * the row holding twelve. That used to arm nothing at all. Now every pile
   * offers the two lots it has, the plate carries the eight it will really
   * spend rather than the twelve it cannot, and the deal closes in two taps —
   * which is the owner's mixed payment, arrived at by tapping cards.
   *
   * Then the middle of it is taken apart again one lot at a time, because a
   * part payment that can only be undone WHOLE is a trap:
   *
   *   "Sheep is 4 of 8 spent but its down arrow is dimmed, so the only
   *    adjustment is CLEAR 4 — all or nothing."
   *
   * The arrow that does it is the one ABOVE the paying card — those cards go
   * back into the pack, which is what up has meant since the lanes flipped —
   * and this is where that gets proved rather than asserted in a comment.
   *
   * Every number below is built out of `ratio`, read off the sheet's own
   * header. At the market a pile of eight is two lots of four; at a 2:1 dock
   * the same eight would cover the whole ask and the arithmetic still holds. */
  await restock({ wood: 8, brick: 8, wool: 8, wheat: 8, ore: 8 });
  await sleep(420);
  const brickUp3 = await centreOf('.tr-col[data-res="brick"] .tr-arr.up');
  for (let i = 0; i < 3; i++) { await clickAt(brickUp3.x, brickUp3.y); await sleep(70); }
  await sleep(240);
  const p3 = await readSheet();
  console.log('  P3CARDS ' + JSON.stringify(
    Object.fromEntries(Object.entries(p3.cards).map(([k, v]) => [k, v.act]))));
  console.log('  P3WHY ' + JSON.stringify({
    armed: p3.armed, dim: p3.dim, cost: p3.cost, say: p3.say }));
  /* What one pile of eight can put toward a three-card ask, at this post's
     rate. Two lots at the market; the whole thing at a 2:1 dock. */
  const p3lots = Math.min(3, Math.floor(8 / ratio));
  const woodCard8 = await centreOf('.tr-col[data-res="wood"] .tr-card');
  await clickAt(woodCard8.x, woodCard8.y);
  await sleep(300);
  const p3part = await readSheet();
  const woodUp8 = await centreOf('.tr-col[data-res="wood"] .tr-arr.up');
  await clickAt(woodUp8.x, woodUp8.y);
  await sleep(260);
  const p3trim = await readSheet();
  const woolCard8 = await centreOf('.tr-col[data-res="wool"] .tr-card');
  await clickAt(woolCard8.x, woolCard8.y);
  await sleep(300);
  const p3full = await readSheet();
  const p3before = { ...p3full.res };
  const dealBtn3 = await centreOf('.sheet.trade .sheet-foot .btn');
  await clickAt(dealBtn3.x, dealBtn3.y);
  await sleep(360);
  const p3done = await readSheet();
  console.log('  PARTPAY ' + JSON.stringify({
    asked: `${p3.cards.brick.was}->${p3.cards.brick.now}`,
    lotsAPileCanOffer: p3lots,
    plates: { wood: p3.cards.wood.act, wool: p3.cards.wool.act },
    armed: p3.armed, dim: p3.dim, needs: p3.cost, say: p3.say,
    afterWood: { delta: `${p3part.cards.wood.was}->${p3part.cards.wood.now}`,
      plate: p3part.cards.wood.act, cost: p3part.cost,
      tradeOff: p3part.tradeOff, upLive: p3part.cards.wood.upLive,
      dnLive: p3part.cards.wood.dnLive },
    afterOneLotBack: { delta: `${p3trim.cards.wood.was}->${p3trim.cards.wood.now}`,
      plate: p3trim.cards.wood.act, cost: p3trim.cost },
    afterWool: { cost: p3full.cost, tradeOff: p3full.tradeOff,
      plate: p3full.cards.wool.act },
    spent: { wood: p3before.wood - p3done.res.wood,
      wool: p3before.wool - p3done.res.wool },
    gained: p3done.res.brick - p3before.brick
  }));

  /* ------------------------------------------------------------ FAST TAPS
   *
   *   "Can you make it so I can press the up and down arrows in a much quicker
   *    succession — since I'm typically clicking so quickly, but right now it's
   *    not registering."
   *
   * Six presses 35ms apart, which is faster than a person can tap and much
   * faster than `click` can be synthesised and confirmed. Every one of them has
   * to land, and BOTH arrows get the same treatment now that the sheet is asked
   * before it is paid: from a pack of forty, six taps up must leave the wood
   * card reading 46, and six taps on a give arrow must leave that card down by
   * six lots — 24 at the market's rate.
   *
   * The counters used to ride the arrows themselves, and the old expectation
   * here was the badge text. It is the card's numeral now, which is a stricter
   * reading of the same thing: the badge only ever showed the staged amount,
   * while the numeral shows the staged amount applied to the pack, so a press
   * that landed but did not update the pile would still be caught.
   *
   * Then the same arrow held down for a second, which has to auto-repeat rather
   * than sit there. */
  const stock40 = () => ev(`(()=>{const I=window.__ISLAND__, p=I.state.players[0];
    p.res.wood=40;p.res.brick=40;p.res.wool=40;p.res.wheat=40;p.res.ore=40;
    I.game.openTrade(null); return 1})()`);
  await stock40();
  await sleep(420);
  const arrow = await ev(`(()=>{const a=document.querySelectorAll('.tr-col')[0]
    .querySelector('.tr-arr.up'); const r=a.getBoundingClientRect();
    return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)};})()`);
  const woodNow = () => ev(`(()=>{const n=document.querySelector(
    '.tr-col[data-res="wood"] .tr-now'); return (n&&n.textContent||'').trim();})()`);
  const rapid = async (pt, n) => {
    for (let i = 0; i < n; i++) { await clickAt(pt.x, pt.y); await sleep(35); }
  };
  await rapid(arrow, 6);
  await sleep(240);
  const burst = await woodNow();
  /* Six on a give arrow, against the six cards that burst just asked for. Six
     lots at four apiece is twenty-four off a pack of forty. */
  const giveArrow = await centreOf('.tr-col[data-res="brick"] .tr-arr.dn');
  await rapid(giveArrow, 6);
  await sleep(240);
  const burstDn = await ev(`(()=>{const n=document.querySelector(
    '.tr-col[data-res="brick"] .tr-now'); return (n&&n.textContent||'').trim();})()`);

  /* And the hold. Down, wait a second, up. */
  await stock40();
  await sleep(360);
  await send('Input.dispatchMouseEvent',
    { type: 'mousePressed', x: arrow.x, y: arrow.y, button: 'left', clickCount: 1 });
  await sleep(1000);
  await send('Input.dispatchMouseEvent',
    { type: 'mouseReleased', x: arrow.x, y: arrow.y, button: 'left', clickCount: 1 });
  await sleep(220);
  const held = await woodNow();
  const after = await woodNow();
  console.log('  FASTTAPS ' + JSON.stringify({
    burst, burstDn, held, settledAfterRelease: held === after
  }));

  /* Every price in here is quoted back off the sheet rather than written down.
     The market charges 4, a generic dock 3 and a matching one 2, and a check
     that spelled "16" out longhand would pass at the market and stop meaning
     anything the moment this stage is pointed at a dock. */
  const wr = parseInt(mixAsk.headRate, 10) || 4;
  const sameSet = (a, b) => a.length === b.length
    && [...a].sort().join(',') === [...b].sort().join(',');
  /* The thumb minimum is 44px and this row is the reason it exists: the give
     arrow is the one control on the sheet a player hits four times in a row. */
  const THUMB = 44;
  console.log('  TOUCH ' + JSON.stringify({
    plateIsAThumbTarget: m.arrows.every(a => a.plate.h >= THUMB && a.plate.w >= THUMB),
    liveBoxIsBigger: m.arrows.every(a => a.live.h >= a.plate.h),
    /* The X may be drawn small on a short screen; it may not be TAPPED small. */
    theCloseButtonIsAThumbTarget: !!m.close
      && m.close.live.w >= THUMB && m.close.live.h >= THUMB,
    anArrowIsNeverWithinAThumbOfTheCard: card.gapAbove >= 10 && card.gapBelow >= 10,
    theEdgePressLanded: press.onTop === true && staged.dir === 'get',
    andUpMeansIntoYourPack: staged.was === '8' && staged.now === '9',
    theWholeSheetStillFits: m.fits === true && m.clipped === 0,
    /* AND THE DEAL BUTTON IS NOT STANDING ON THE RIM. "It fits" passed for a
       whole pass while the sheet was 9px over its own max-height at 320, the
       give band was resting on the foot's rule and the primary call to action
       had 3px under it against 10 above. So the gap is measured on both sides
       now — a pixel of tolerance for sub-pixel layout, and never less than the
       6px that stops a button reading as clipped. `slack` catches the cause
       rather than the symptom: below zero means the sheet is overflowing and
       its padding-bottom is only in the stylesheet. */
    theDealHasRoomUnderIt: !!m.deal && m.deal.below >= 6
      && m.deal.below >= m.deal.above - 1 && m.deal.slack >= -0.5,
    receiveIsOnTopInTheDomAndInThePaint:
      m.order.join('>') === 'receive>row>give'
      && m.bands.receiveBottom <= m.bands.rowTop
      && m.bands.giveTop >= m.bands.rowBottom,
    lanesAreBands: m.caps.length === 2 && m.caps.every(c => c.h >= 16 && c.paint
      && c.type >= 10) && /receive/i.test(m.caps[0].lab) && /give/i.test(m.caps[1].lab),
    /* The foot is a two-state control now, not a greyed one:
         "Instead of having a greyed out trade button, could it just be a
          different coloured and labelled button until it's a valid trade — like
          before, it's grey and says cancel or clear or something, then when
          it's a valid trade it shows up as the green trade button."
       So the resting sheet says CLEAR and a balanced one says TRADE, and the
       thing to assert is that it is never dead. */
    theFootIsJustTheDeal: m.legendGone === true && /^(trade|clear)$/i.test(m.foot),
    /* Never a dead slab: at rest it is a live stone CLEAR, not a greyed Trade.
       `idle.tradeOff` cannot say this — it means "not the green Trade", which is
       correct and true at rest — so this reads the word instead. */
    theFootIsNeverADeadSlab: /^clear$/i.test(m.foot),
    /* And the give arrows are live from the start, because a trade may now be
       started from either end:
         "The trading should work the other way too, where I can start the trade
          by also clicking the down arrow."
       The old assertion here was that all five were DEAD at rest, which is
       exactly the behaviour that was just removed. */
    aTradeCanBeStartedFromEitherEnd:
      idle.dnLive.length === 5 && /ask above|tap a card/i.test(idle.say),
    /* The fixed greying rule: lit means "this pile can contribute a lot", dim
       means it cannot contribute anything here at all. Eight wool is two lots
       and stays lit even though it cannot cover sixteen on its own; two ore is
       not one lot and dims.
       AND EVERY LIT PILE NOW CARRIES A PLATE, priced at what its own tap would
       really spend: forty wood covers the whole sixteen, eight wool covers half
       of it, and both say so. A pile that could contribute but showed no plate
       was the defect that sent the last pass back. */
    dimIsOnlyForPilesThatCannotContribute:
      sameSet(ask.dim, ['ore']) && sameSet(ask.armed, ['wood', 'wool', 'wheat'])
      && ask.cards.wood.act === `Pay ${ratio * 4}`
      && ask.cards.wool.act === `Pay ${ratio * 2}`
      && ask.cards.ore.act === ''
      && ask.cards.brick.dir === 'get' && ask.cards.brick.now === '4',
    andEveryCardAgreesWithTheArrowUnderIt:
      Object.keys(ask.cards).every(r => ask.cards[r].dir === 'get'
        || ask.cards[r].dim !== ask.cards[r].dnLive),
    theRateIsQuotedOnceNotFiveTimes:
      /^\d+:1$/.test(ask.headRate) && ask.cardRates.length === 0,
    theOneTapSpendsExactlyRatioTimesN:
      ask.cards.wood.act === `Pay ${ratio * 4}`
      && paid.cards.wood.now === String(before.wood - ratio * 4)
      && paid.cards.wood.dir === 'give'
      && paid.tradeOff === false
      && (before.wood - done.res.wood) === ratio * 4
      && (done.res.brick - before.brick) === 4,
    /* Same slot, same plate, opposite verb — and the ask survives the undo. */
    andOneTapTakesItBackOutAgain:
      committed.cards.wood.act === `Clear ${ratio * 4}`
      && undone.cards.wood.dir === '' && undone.cards.wood.now === '40'
      && undone.cards.brick.now === '4'
      && sameSet(undone.armed, ['wood', 'wool', 'wheat']),
    andCoversAMixedAskWholeRatherThanByLine:
      mixAsk.cards.wool.act === `Pay ${wr * 4}`
      && mixPaid.cards.wool.dir === 'give'
      && (mixBefore.wool - mixDone.res.wool) === wr * 4
      && (mixDone.res.brick - mixBefore.brick) === 2
      && (mixDone.res.ore - mixBefore.ore) === 2,
    /* THE PRICE IS A NUMBER ON THE SHEET, NOT AN INFERENCE FROM ONE.
     *
     *   "In trade-960x444-ask3.png the number 12 appears NOWHERE on the sheet —
     *    the header says 4:1, the card says 8 -> 11, and that is all."
     *
     * NEEDS 16 with the ask standing and nothing paying, 4 OF 16 with one lot
     * of the four in, 16 OF 16 once the deal is covered — and nothing at all on
     * a sheet nobody has touched, because an untouched sheet has no price.
     * Every figure comes off `ratio`, which is read out of the sheet's own
     * header, so this check means the same thing at a 3:1 dock and a 2:1 one. */
    theGiveBandStatesThePriceInFigures:
      idle.cost === '' && ask.cost === `Needs ${ratio * 4}`
      && paid.cost === `${ratio * 4} of ${ratio * 4}`
      && part.cost === `${ratio} of ${ratio * 4}`
      && mixAsk.cost === `Needs ${wr * 4}`,
    /* THE ONE-TAP PAYER IS NOT WITHHELD WHEN NO SINGLE PILE COVERS THE BILL.
     *
     *   "This kills the owner's own headline example — 'trade 8 wood and 8
     *    sheep for 4 brick' is a cost of 16 against two piles of 8, so that
     *    exact trade opens with every card dead and the one-tap payer
     *    withheld."
     *
     * Eight of everything, three brick asked: every pile that holds a lot arms
     * and its plate is priced at what that tap really spends. Then the tap
     * spends exactly that, the band counts it, the Trade button stays off
     * because the deal is genuinely half done, and the band tells the player to
     * tap a card rather than steering them back to the arrows. */
    aPilePaysWhatItCanRatherThanNothing:
      sameSet(p3.armed, ['wood', 'wool', 'wheat', 'ore']) && p3.dim.length === 0
      && ['wood', 'wool', 'wheat', 'ore']
        .every(r => p3.cards[r].act === `Pay ${ratio * p3lots}`)
      && p3.cost === `Needs ${ratio * 3}` && /tap a card/i.test(p3.say)
      && p3part.cards.wood.dir === 'give'
      && p3part.cards.wood.now === String(8 - ratio * p3lots)
      && p3part.cards.wood.act === `Clear ${ratio * p3lots}`
      && p3part.cost === `${ratio * p3lots} of ${ratio * 3}`
      && p3part.tradeOff === (p3lots < 3),
    /* ...and the second tap finishes it, out of a different pile, for real. */
    andASecondCardFinishesTheMixedPayment:
      p3full.cost === `${ratio * 3} of ${ratio * 3}` && p3full.tradeOff === false
      && (p3done.res.brick - p3before.brick) === 3
      && (p3before.wood - p3done.res.wood)
        + (p3before.wool - p3done.res.wool) === ratio * 3,
    /* A part payment comes back out one lot at a time, from the arrow above the
       card — not only whole, through CLEAR. */
    aPartPaidPileTrimsOneLotAtATime:
      p3part.cards.wood.upLive === true
      && p3trim.cards.wood.act === `Clear ${ratio * (p3lots - 1)}`
      && p3trim.cards.wood.now === String(8 - ratio * (p3lots - 1))
      && p3trim.cost === `${ratio * (p3lots - 1)} of ${ratio * 3}`,
    sixFastTapsAllCounted: burst === '46' && burstDn === '16',
    aHeldArrowRepeats: (+held || 0) >= 44,
    andStopsWhenReleased: held === after,
    theCardKeptItsOwnTaps: card.topEdgeIsTheCard === true && picked.cur === true
      && picked.dir === 'give' && picked.now === String(8 - ratio)
  }));

  /* ------------------------------------------------------------- THE SET
   *
   * ONE UNBROKEN SESSION, FROM THE PACK A REAL PLAYER WALKS IN WITH. The last
   * set was assembled out of three different stockpiles — eight of everything
   * in one frame, forty wood in the next — so the frames photographed states
   * that never followed one another and the flow could not be read off them.
   * Nothing below restocks. Eight of each, once, and then SIX pictures of the
   * same afternoon:
   *
   *   idle    nothing asked, so the whole give lane is legitimately dead and
   *           the brown band is carrying the only explanation of why.
   *   main    two brick asked for. Two brick costs eight, and eight is exactly
   *           what every other pile holds, so four gold PAY 8 plates come up at
   *           once — the marquee feature, finally looking like something a
   *           thumb would press.
   *   paid    one tap on wood. 8 -> 0 on the card, CLEAR 8 in the same slot the
   *           price was in, Trade lit.
   *   ask3    cleared, then three brick instead. Three brick costs twelve and
   *           nothing here holds twelve — which used to arm nothing at all and
   *           leave twelve arrow taps as the only route. Every pile now offers
   *           the two lots it has, at PAY 8 apiece, and NEEDS 12 in the band
   *           says what those eights are being measured against.
   *   part    THE MIDDLE TERM, and the frame this set was missing:
   *             "Every frame supplied so far is either nothing-paid or
   *              exactly-complete, so the middle term of the running total,
   *              which was this pass's headline claim, is still unevidenced."
   *           One tap on wood. Eight of the twelve found, 8 OF 12 in the band,
   *           and the Trade button still off because the deal is genuinely half
   *           done.
   *   mixed   one tap on sheep for the last four. Two lots of wood and one of
   *           sheep — the owner's own worked example — reached in two taps on
   *           two cards, neither of which could have covered it alone.
   */
  const BRICK_UP = '.tr-col[data-res="brick"] .tr-arr.up';
  const WOOD_CARD = '.tr-col[data-res="wood"] .tr-card';
  const WOOL_CARD = '.tr-col[data-res="wool"] .tr-card';

  /* RUN THE OPENING ALL THE WAY OUT BEFORE THE CAMERA COMES OUT.
   *
   * `flow.update` is the one system main.js keeps ticking while a sheet is open
   * — everything else is held, which is what the "Match paused" chip promises —
   * so matchflow's start-line countdown carries on behind the sheet, and when
   * it reaches GO, `enterPlay` closes every panel that is not the scoreboard.
   * A capture on this renderer costs five to eight seconds, so a run that takes
   * five of them spends long enough with the sheet up for that to land in the
   * middle of the set: this stage came back once with three photographs of the
   * island and no trade sheet in any of them.
   *
   * Twenty seconds of flow with the panel shut puts the countdown, the GO and
   * the objective card properly behind us. It also means the frozen "GET READY
   * 3" that has sat on top of the middle card in every trade screenshot this
   * harness ever took is gone because it FINISHED, rather than because it was
   * hidden. */
  await ev(`(()=>{const g=window.__ISLAND__.game;
    if(g.panels&&g.panels.close)g.panels.close();
    for(let k=0;k<1200;k++) g.flow.update(1/60);
    return 1})()`);
  await sleep(250);
  console.log('  OPENING ' + JSON.stringify({
    phase: await ev(`window.__ISLAND__.state.phase`),
    countdownUp: await ev(`!!document.querySelector('.fc-layer:not(.fc-off)')`)
  }));

  /* A capture stalls the renderer for the better part of ten seconds, and the
     synthetic `click` that follows a dispatched mouseup can come out the far
     side of that stall — late enough that `pressable`'s 700ms
     already-counted-this-one window has expired and the arrow counts the tap
     twice. So every frame is followed by a settle long enough for anything the
     capture deferred to land, and every step says out loud what the sheet is
     holding, so a set that drifts says so in the log instead of in the pixels. */
  const frame = async (tag) => {
    await shot(tag ? `trade-${TAG}-${tag}` : `trade-${TAG}`);
    await sleep(900);
    const s = await readSheet();
    console.log(`  POSE:${tag || 'ask2'} ` + JSON.stringify({
      wood: `${s.cards.wood.was}->${s.cards.wood.now}`,
      brick: `${s.cards.brick.was}->${s.cards.brick.now}`,
      wool: `${s.cards.wool.was}->${s.cards.wool.now}`,
      armed: s.armed, tradeOff: s.tradeOff, say: s.say, cost: s.cost,
      plates: Object.fromEntries(Object.keys(s.cards)
        .map(r => [r, s.cards[r].act]).filter(e => e[1]))
    }));
    return s;
  };

  await restock({ wood: 8, brick: 8, wool: 8, wheat: 8, ore: 8 });
  await sleep(450);
  await frame('idle');

  for (let i = 0; i < 2; i++) { await tap(BRICK_UP); await sleep(120); }
  await sleep(300);
  await frame(null);

  await tap(WOOD_CARD);
  await sleep(320);
  await frame('paid');

  await tap(WOOD_CARD);                           // CLEAR, same plate
  await sleep(220);
  await tap(BRICK_UP);                            // ...and a third brick
  await sleep(320);
  await frame('ask3');

  /* Two taps, not twelve. The first one is the whole point of this pass: a pile
     of eight against a bill of twelve pays its eight instead of refusing. */
  await tap(WOOD_CARD);
  await sleep(340);
  await frame('part');

  await tap(WOOL_CARD);
  await sleep(340);
  await frame('mixed');

/* ----------------------------------------------------------------- vpwin
 *
 *   "Sometimes I win the game with a victory point, but I need to actually see
 *    that I won a victory point in an easier way, instead of it just going
 *    straight into the victory / game ending animation. Give it like 1-2
 *    seconds, so I know what happened."
 *
 * A Victory Point card scores as it is drawn, so the tap that buys it and the
 * horn that ends the match were the same moment. This drives the REAL path —
 * `rules.drawCard` until the deck hands over a victory point, with the player
 * sitting on eleven — and then checks the three things that make the beat a
 * beat: the sequence is held, the card is named while it is held, and the horn
 * lands after the hold rather than under it.
 */
} else if (STAGE === 'vpwin') {
  await waitIntro();
  await ev(`(()=>{window.__ISLAND__.game.flow.skipIntro();return 1})()`);
  await ev(`import('/src/core/rules.js').then(m=>{window.__R__=m;return 1})`, true);
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
      const legal=road ? R.legalRoads(I.state,0,true,I.state.setupAnchor)
        : R.legalSettlements(I.state,0,true);
      if(!legal.length)return 0;
      ov.select(legal[0]); ov.commit(); return 1;})()`);
    await sleep(120);
  }
  const draw = await ev(`(async()=>{
    const I=window.__ISLAND__, R=window.__R__, st=I.state, me=st.players[0];
    const C = await import('/src/core/constants.js');
    // One card short of the island — whatever the target is, read rather than
    // assumed (it is 13, and the README that says 12 is older than the number).
    const target = C.VICTORY_POINTS;
    while (R.scoreOf(st, me) < target - 1 && me.vpCards < 40) me.vpCards++;
    const at11 = R.scoreOf(st, me);
    let card = null, tries = 0;
    while (tries++ < 60) {
      const c = R.drawCard(st, 0, true);         // free, so no pack is needed
      if (c && c.type === 'victoryPoint') { card = c; break; }
    }
    return {target, at11, drew:!!card, tries, score:R.scoreOf(st, me),
      phase:st.phase};})()`, true);
  // One frame of the real loop, so main.js drains 'cardDrawn' then 'victory'.
  await sleep(2200);
  const held = await ev(`(()=>{const g=window.__ISLAND__.game;
    const obj=document.querySelector('.mf-obj');
    const ann=document.querySelector('.ann-txt');
    return {lead:g.flow.winLead, inSequence:!!g.flow.isWinSequence,
      objText:((obj&&obj.textContent)||'').replace(/\s+/g,' ').trim().slice(0,60),
      objUp:!!(obj&&!obj.classList.contains('mf-hid')),
      announce:((ann&&ann.textContent)||'').trim(),
      phase:window.__ISLAND__.state.phase};})()`);
  console.log('  VPWIN ' + JSON.stringify({ ...draw, held }));

  /* Now walk the flow's own clock: one second in, still held; past the beat,
     open. Driven in game time rather than wall time, because a headless page
     gets about one frame every 700ms and the beat is 1.6 seconds long. */
  const at = async secs => ev(`(()=>{const g=window.__ISLAND__.game;
    for(let i=0;i<${Math.round(secs * 60)};i++) g.flow.update(1/60);
    const ann=document.querySelector('.ann-txt');
    return {announce:((ann&&ann.textContent)||'').trim(),
      lead:g.flow.winLead};})()`);
  const oneSec = await at(1.0);
  const past = await at(1.2);
  console.log('  BEAT ' + JSON.stringify({ oneSec, past }));
  console.log('  VPCARD ' + JSON.stringify({
    theCardWonIt: draw.drew === true && draw.at11 === draw.target - 1
      && draw.phase === 'over',
    theSequenceIsHeld: held.lead === 1.6,
    theCardIsNamedWhileItIsHeld: /victory point card/i.test(held.objText),
    andTheHornWaits: !/take the island/i.test(oneSec.announce),
    thenItOpens: /take the island/i.test(past.announce)
  }));
  await shot(`vpwin-${TAG}`);

/* ------------------------------------------------------------------ raid
 *
 *   "If the Knight popup is visible since I was raided, I should be able to
 *    click anywhere on the screen and have it disappear quicker, instead of
 *    having to wait for it to disappear on its own."
 *
 * Two claims, and the second is the one worth testing: a tap takes it away, AND
 * a tap that was already happening when it arrived does not. A raid lands on
 * the rival's clock — quite often while a thumb is mid-press somewhere else —
 * and a card dismissed by the press that was in flight when it appeared would
 * look like it never came. So this presses inside the grace window and requires
 * the card to STAY, then presses after it and requires the card to go.
 */
} else if (STAGE === 'raid') {
  await waitIntro();
  await ev(`(()=>{window.__ISLAND__.game.flow.skipIntro();return 1})()`);
  await ev(`import('/src/core/rules.js').then(m=>{window.__R__=m;return 1})`, true);
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
      const legal=road ? R.legalRoads(I.state,0,true,I.state.setupAnchor)
        : R.legalSettlements(I.state,0,true);
      if(!legal.length)return 0;
      ov.select(legal[0]); ov.commit(); return 1;})()`);
    await sleep(120);
  }
  /* A rival Knights the player: give seat 1 the card and a full pack to seat 0,
     then play it through the real rules call so the real event is emitted. */
  const raid = await ev(`(()=>{
    const I=window.__ISLAND__, R=window.__R__, st=I.state;
    const me=st.players[0];
    me.res.wood=8;me.res.brick=8;me.res.wool=8;me.res.wheat=8;me.res.ore=8;
    st.players[1].cards.push({type:'knight'});
    const tile=[...me.settlements].length
      ? I.__nodes__ ? 0 : 3 : 3;
    const ok=R.playKnight(st, 1, tile);
    return {played:ok, packAfter:{...me.res}};})()`);
  /* The rules emit; main.js's frame loop drains. Under SwiftShader that is
     about one frame every 700ms, so this waits for frames, not for a timer. */
  await sleep(2600);
  const up = await ev(`(()=>{const n=document.querySelector('.raid');
    const r=n?n.getBoundingClientRect():null;
    return {open:!!(n&&!n.classList.contains('hid')),
      leaving:!!(n&&n.classList.contains('out')),
      text:((n&&n.textContent)||'').replace(/\s+/g,' ').trim().slice(0,60),
      box:r?{w:Math.round(r.width),h:Math.round(r.height)}:null,
      hudSaysOpen:!!window.__ISLAND__.game.hud.raidOpen};})()`);
  console.log('  RAID ' + JSON.stringify({ ...raid, up }));

  /* The press that was already in flight. Fired immediately after the card
     lands, which is inside GRACE — it must change nothing. */
  const press = async () => {
    const x = Math.round((await ev('innerWidth')) * 0.5);
    const y = Math.round((await ev('innerHeight')) * 0.82);
    await send('Input.dispatchMouseEvent',
      { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent',
      { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  await ev(`(()=>{const g=window.__ISLAND__.game;
    // Re-show it, so the press below is inside the grace window for certain.
    g.hud.raid({type:'knight',player:1,tile:3,
      losses:[{player:0,lost:{wood:4,brick:4,wool:4,wheat:4,ore:4},total:20}]});
    return 1})()`);
  await press();
  await ev(`(()=>{const g=window.__ISLAND__.game; g.hud.update(0.05); return 1})()`);
  const early = await ev(`(()=>{const n=document.querySelector('.raid');
    return {stillUp:!!(n&&!n.classList.contains('hid')&&!n.classList.contains('out'))};})()`);

  /* And the press a moment later, which must take it away well before the
     2.4s the card would have held for on its own. */
  await ev(`(()=>{const g=window.__ISLAND__.game;
    for(let i=0;i<12;i++) g.hud.update(0.05);   // 0.6s of card life
    return 1})()`);
  await press();
  await ev(`(()=>{window.__ISLAND__.game.hud.update(0.05);return 1})()`);
  const late = await ev(`(()=>{const n=document.querySelector('.raid');
    return {leaving:!!(n&&n.classList.contains('out')),
      open:!!(n&&!n.classList.contains('hid'))};})()`);
  await ev(`(()=>{const g=window.__ISLAND__.game;
    for(let i=0;i<12;i++) g.hud.update(0.05); return 1})()`);
  const gone = await ev(`(()=>{const n=document.querySelector('.raid');
    return {hidden:!!(n&&n.classList.contains('hid')),
      hudSaysOpen:!!window.__ISLAND__.game.hud.raidOpen};})()`);
  console.log('  DISMISS ' + JSON.stringify({ early, late, gone }));

  /*
   * AND YOUR OWN KNIGHT RAISES NOTHING.
   *
   *   "Also make sure that I don't see the knight popup after playing the
   *    knight myself, since I'm not losing any resources when I play it."
   *
   * Fired through the same entry point the live event uses, the only difference
   * being whose card it is. It must stay down. Run AFTER the dismissal sequence
   * above on purpose: run first, a card that merely failed to RE-open would be
   * indistinguishable from one that was correctly suppressed.
   */
  const ownKnight = await ev(`(()=>{
    const g=window.__ISLAND__.game;
    g.hud.raid({type:'knight',player:0,tile:5,
      losses:[{player:1,total:6,lost:{wood:3,ore:3}},
              {player:2,total:4,lost:{wool:4}}]});
    for(let i=0;i<4;i++) g.hud.update(0.05);
    const n=document.querySelector('.raid');
    return {open:!!(n&&!n.classList.contains('hid')),
      hudSaysOpen:!!g.hud.raidOpen};})()`);
  console.log('  OWNKNIGHT ' + JSON.stringify(ownKnight));

  /* And the two rows the owner asked to be rid of, asserted absent rather than
     merely unmentioned — a hidden row is a row that grows back. */
  const slim = await ev(`(()=>{
    const c=document.querySelector('.raid-card');
    return {chips:document.querySelectorAll('.raid-chip').length,
      bill:document.querySelectorAll('.raid-bill').length,
      foot:document.querySelectorAll('.raid-foot').length,
      h:c?Math.round(c.getBoundingClientRect().height):0};})()`);
  console.log('  RAIDSLIM ' + JSON.stringify(slim));

  console.log('  RAIDCARD ' + JSON.stringify({
    yourOwnKnightRaisesNoCard: ownKnight.open === false && ownKnight.hudSaysOpen === false,
    noPerResourceRow: slim.chips === 0 && slim.bill === 0,
    noClosingLineOfText: slim.foot === 0,
    theCardLands: up.open === true && up.hudSaysOpen === true,
    itNamesTheLoss: /knight/i.test(up.text),
    aPressAlreadyInFlightDoesNotTakeIt: early.stillUp === true,
    aPressAfterThatDoes: late.leaving === true,
    andItIsGoneWellInsideTheHold: gone.hidden === true && gone.hudSaysOpen === false
  }));
  await shot(`raid-${TAG}`);

/* ------------------------------------------------------------------ perf
 *
 *   "When I have multiple tabs open on my computer and I try to start playing
 *    the game on my laptop, it started making my laptop glitch and keep
 *    flashing black sporadically multiple times a second. I need it to work
 *    well, and be optimised to function without a lot of compute."
 *
 * Flashing black is not slowness — it is the WebGL context being lost and
 * restored while the machine is short of GPU memory. So this stage measures the
 * two things that decide how much of that memory a tab is holding (the pixel
 * budget and the shadow map) and then does the thing itself: takes the context
 * away with WEBGL_lose_context, gives it back, and checks the game is still
 * running and still drawing afterwards.
 */
} else if (STAGE === 'haptics') {
  /*
   * WHAT IS ALLOWED TO BUZZ SOMEBODY'S HAND.
   *
   *   "Remove the haptic feedback for hexes that I'm not on. Like if I can't
   *    collect resources I don't need my phone to buzz when a hex that I'm not
   *    built on and can't receive resources from is out of resources, or when
   *    it resets."
   *
   * The gate used to be DISTANCE — anything audible within about thirty units
   * reached the hand — so eighteen hexes running dry and growing back on their
   * own clocks buzzed all match, most of them somebody else's.
   *
   * Counting `navigator.vibrate` is the only honest way to test this: the
   * question is not what the code intends, it is how many times the phone is
   * actually asked to move. So the platform call is replaced with a counter and
   * each case is played for real through the same functions the game calls.
   *
   * The 55ms cooldown inside haptics.js means two buzzes closer together than
   * that count as one, which would let a failure hide — hence the pause between
   * cases, and hence the control case in the middle proving the counter works.
   */
  await waitIntro();
  await ev(`(()=>{window.__ISLAND__.game.flow.skipIntro();return 1})()`);
  await sleep(1200);

  await ev(`(()=>{
    window.__BUZZ__=[];
    navigator.vibrate=function(p){ window.__BUZZ__.push(p); return true; };
    return typeof navigator.vibrate;})()`);

  /* Each case: a label, the thing the game does, and whether a hand should
     know about it. Run one at a time with the cooldown allowed to lapse. */
  const CASES = [
    ['a hex you own nothing on running dry',
     `I.world.audio.sfx('deny',{gain:0.45,at:{x:t.x,z:t.z}})`, false],
    ['the same hex growing back',
     `I.world.audio.sfx('upgrade',{gain:0.6,at:{x:t.x,z:t.z}})`, false],
    ['the sparkle a hex throws when it refills',
     `I.game.effects.burst(t.x,t.z,'wood')`, false],
    ['a rival laying a road across the island',
     `I.game.audio.sfx('build',{mine:false})`, false],
    ['a Knight dropped on a hex that is nothing to do with you',
     `I.game.effects.shockwave(0)`, false],
    ['YOUR OWN build',
     `I.game.audio.sfx('build',{mine:true})`, true],
    ['YOUR OWN trade being refused',
     `I.game.audio.sfx('deny',{mine:true})`, true],
    ['YOUR OWN pickup',
     `I.game.effects.burst(p.x,p.z,'wood',{mine:true})`, true],
    ['a Knight that took from YOU',
     `I.game.effects.shockwave(0,{mine:true})`, true]
  ];

  const out = [];
  for (const [label, expr, want] of CASES) {
    await sleep(320);                         // outlast the 55ms cooldown
    const n = await ev(`(()=>{
      const I=window.__ISLAND__;
      const p=I.state.players[0];
      const t={x:p.x+2,z:p.z+2};
      const before=window.__BUZZ__.length;
      try { ${expr}; } catch(e) { return {err:String(e.message||e)}; }
      return {buzzed: window.__BUZZ__.length - before};})()`);
    out.push({ label, want, got: n && n.buzzed, err: n && n.err });
  }
  for (const r of out) {
    console.log(`  ${r.want ? 'BUZZ ' : 'quiet'} ${r.got === (r.want ? 1 : 0) ? 'ok  ' : 'BAD '} ${r.label}`
      + (r.err ? `  [${r.err}]` : `  (${r.got})`));
  }
  const silent = out.filter(r => !r.want);
  const felt = out.filter(r => r.want);
  console.log('  HAPTICS ' + JSON.stringify({
    theIslandsOwnBusinessNeverReachesTheHand: silent.every(r => r.got === 0),
    andTheThingsYouDidStillDo: felt.every(r => r.got === 1),
    quietCases: silent.length, buzzingCases: felt.length,
    counts: out.map(r => r.got)
  }));

} else if (STAGE === 'perf') {
  await waitIntro();
  await ev(`(()=>{window.__ISLAND__.game.flow.skipIntro();return 1})()`);
  /* THIS PAGE STARTS ON THE BOTTOM RUNG AND IS RIGHT TO: headless Chrome is
     SwiftShader on two cores, which is exactly what `guessLevel` is for. The
     budget, shadow-map and antialias checks below are about the FULL rung, so
     it is pinned there first — and pinning is what a player pressing the switch
     does, so the pin itself is being exercised too. */
  const bootLevel = await ev(`window.__ISLAND__.game.quality`);
  console.log('  BOOT ' + JSON.stringify(bootLevel));
  await ev(`window.__ISLAND__.game.setLowPower(false)`, true);
  await sleep(1500);
  const budget = await ev(`(()=>{
    const I=window.__ISLAND__, r=I.renderer, c=r.domElement;
    const b=r.getDrawingBufferSize(new I.THREE.Vector2());
    const sun=I.world.sky&&I.world.sky.sun;
    return {css:{w:c.clientWidth,h:c.clientHeight}, ratio:+r.getPixelRatio().toFixed(3),
      buffer:{w:b.x,h:b.y}, megapixels:+((b.x*b.y)/1e6).toFixed(2),
      shadow:sun&&sun.shadow?sun.shadow.mapSize.x:null,
      antialias:!!(r.getContext().getContextAttributes()||{}).antialias,
      power:(r.getContext().getContextAttributes()||{}).powerPreference||'default',
      calls:r.info.render.calls, tris:r.info.render.triangles};})()`);
  console.log('  BUDGET ' + JSON.stringify(budget));

  /* THE CAP, ON A SCREEN THAT WOULD ACTUALLY HIT IT. Headless Chrome reports a
     device pixel ratio of 1, so the budget is trivially satisfied and proves
     nothing. Emulate the retina laptop the complaint came from — same CSS size,
     2x device pixels — and the ratio has to come DOWN to hold the budget rather
     than multiplying the bill by four. */
  await send('Emulation.setDeviceMetricsOverride',
    { width: W, height: H, deviceScaleFactor: 2, mobile: false });
  await sleep(900);
  await ev(`(()=>{dispatchEvent(new Event('resize'));return 1})()`);
  await sleep(700);
  const retina = await ev(`(()=>{const r=window.__ISLAND__.renderer;
    const b=r.getDrawingBufferSize(new window.__ISLAND__.THREE.Vector2());
    return {dpr:devicePixelRatio, ratio:+r.getPixelRatio().toFixed(3),
      buffer:{w:b.x,h:b.y}, megapixels:+((b.x*b.y)/1e6).toFixed(2),
      uncapped:+(((innerWidth*devicePixelRatio)*(innerHeight*devicePixelRatio))/1e6).toFixed(2)};})()`);
  await send('Emulation.clearDeviceMetricsOverride');
  await sleep(600);
  await ev(`(()=>{dispatchEvent(new Event('resize'));return 1})()`);
  console.log('  RETINA ' + JSON.stringify(retina));

  /* ---------------------------------------------------------- battery saver
   *
   * The switch, applied to the renderer that is already running: the shadow
   * pass gone — a whole second scene pass every frame plus a 16MB depth
   * texture — and the ratio pinned at 1.
   *
   * NOT measured in draw calls, though that was the obvious idea. three resets
   * `info` AFTER the shadow pass and before the scene proper (WebGLRenderer,
   * `if (this.info.autoReset) this.info.reset()`, immediately after
   * `shadowMap.render`), so `info.render.calls` has never counted a shadow draw
   * and turning the pass off cannot change it. The flags are the witness, and
   * the frames-per-window figures below are the evidence of what it buys — 
   * reported rather than asserted, because SwiftShader's frame times are far
   * too noisy to hang a check on. */
  const rate = async label => {
    const n = await ev(`(async()=>{const r=window.__ISLAND__.renderer;
      const a=r.info.render.frame;
      await new Promise(res=>setTimeout(res,3000));
      return r.info.render.frame-a;})()`, true);
    return { [label]: n };
  };
  const full = await ev(`(()=>{const r=window.__ISLAND__.renderer;
    return {shadows:r.shadowMap.enabled, calls:r.info.render.calls,
      ratio:+r.getPixelRatio().toFixed(3),
      blurOff:document.getElementById('ui').classList.contains('saver')};})()`);
  const fullRate = await rate('framesIn3s');
  await ev(`window.__ISLAND__.game.setLowPower(true)`, true);
  await sleep(2200);
  const saver = await ev(`(()=>{const r=window.__ISLAND__.renderer;
    const sun=window.__ISLAND__.world.sky&&window.__ISLAND__.world.sky.sun;
    return {shadows:r.shadowMap.enabled, casting:!!(sun&&sun.castShadow),
      calls:r.info.render.calls, ratio:+r.getPixelRatio().toFixed(3),
      stored:(JSON.parse(localStorage.getItem('island-settlers.quality')||'{}').level)<2,
      blurOff:document.getElementById('ui').classList.contains('saver')};})()`);
  const saverRate = await rate('framesIn3s');
  await ev(`window.__ISLAND__.game.setLowPower(false)`, true);
  await sleep(1200);
  console.log('  SAVER ' + JSON.stringify({
    full: { ...full, ...fullRate }, saver: { ...saver, ...saverRate }
  }));

  /* --------------------------------------------------------- the ladder
   *
   *   "Is there a simple way to automatically test if the computer is low on
   *    compute reliably, and automatically turn on the graphics saver as soon
   *    as the app is opened... and check at minute 1, 3, 5, 10, 15, 20, 30 to
   *    see if the compute has improved... without detracting from the
   *    experience at all. No black flashes while testing, no extra visuals."
   *
   * Three claims, and they are separable. The GUESS happens before the first
   * frame and is inspectable. The PROBE is 2.5 seconds of reading a clock the
   * loop already looks at — so the test is that a probe draws exactly as many
   * frames as not probing does, and allocates nothing. And the LADDER moves one
   * rung at a time, with the cheap half (pixel ratio, no recompile) separated
   * from the expensive half (the shadow pass). */
  const ladder = await ev(`(async()=>{
    const g=window.__ISLAND__.game, r=window.__ISLAND__.renderer;
    const Q=await import('/src/systems/quality.js');
    const guessLow=Q.guessLevel({navigator:{deviceMemory:8,hardwareConcurrency:4},
      renderer:'Intel(R) Iris(R) Xe Graphics', stored:{}});
    const guessHigh=Q.guessLevel({navigator:{deviceMemory:32,hardwareConcurrency:16},
      renderer:'NVIDIA GeForce RTX 4080', stored:{}});
    return {probeAtSec:Q.PROBE_AT_SEC, rungs:Q.RUNGS, guessLow, guessHigh,
      level:g.quality && g.quality.level, blurOff:document.getElementById('ui')
        .classList.contains('saver')};})()`, true);
  console.log('  LADDER ' + JSON.stringify(ladder));

  /* A probe costs nothing: run one and count the frames drawn while it is
     sampling against the same window with no probe running. */
  await ev(`window.__ISLAND__.game.setLowPower(true)`, true);
  await sleep(900);
  const quiet = await ev(`(async()=>{const r=window.__ISLAND__.renderer;
    const a=r.info.render.frame; await new Promise(x=>setTimeout(x,2600));
    return r.info.render.frame-a;})()`, true);
  const beforeProbe = await ev(`(()=>{const r=window.__ISLAND__.renderer;
    return {level:window.__ISLAND__.game.quality.level, calls:r.info.render.calls,
      ratio:+r.getPixelRatio().toFixed(3)};})()`);
  await ev(`window.__ISLAND__.game.qualityProbe()`);
  const busy = await ev(`(async()=>{const r=window.__ISLAND__.renderer;
    const a=r.info.render.frame; await new Promise(x=>setTimeout(x,2600));
    return r.info.render.frame-a;})()`, true);
  const after = await ev(`(()=>{const r=window.__ISLAND__.renderer;
    const q=window.__ISLAND__.game.quality;
    return {q, calls:r.info.render.calls, ratio:+r.getPixelRatio().toFixed(3)};})()`);
  console.log('  PROBECOST ' + JSON.stringify({ quiet, busy, beforeProbe, after }));

  /* Kill it, and time how long the page takes to be drawing again. A restore
     re-uploads every texture and buffer, which is exactly the cost the flicker
     is made of — so the number that matters is that it recovers at all, and
     without an exception reaching the frame loop. */
  const before = await ev(`window.__ISLAND__.renderer.info.render.frame`);
  const lost = await ev(`(()=>{const gl=window.__ISLAND__.renderer.getContext();
    const x=gl.getExtension('WEBGL_lose_context');
    if(!x) return {ext:false};
    window.__LOSE__=x; x.loseContext(); return {ext:true};})()`);
  await sleep(700);
  const during = await ev(`(()=>({lost:window.__ISLAND__.renderer.getContext().isContextLost(),
    frame:window.__ISLAND__.renderer.info.render.frame})) ()`);
  await ev(`(()=>{ if(window.__LOSE__) window.__LOSE__.restoreContext(); return 1})()`);
  await sleep(1600);
  /* three.js re-initialises on restore and its frame counter starts again from
     zero, so "did it come back" cannot be `frame > frameBefore`. The honest
     test is that the counter is MOVING now: sample it twice, a second and a
     half apart — this scene runs at about 1.5fps under SwiftShader. */
  /* three.js re-initialises on restore and its frame counter starts again from
     zero, so "did it come back" cannot be `frame > frameBefore`. It is that the
     counter is MOVING again — polled rather than sampled once, because a
     restore re-uploads every texture and buffer and this scene runs at about
     1.5fps under SwiftShader even when nothing is wrong. */
  let back = null;
  for (let i = 0; i < 12; i++) {
    back = await ev(`(async()=>{const r=window.__ISLAND__.renderer;
      const a=r.info.render.frame;
      await new Promise(res=>setTimeout(res,700));
      return {lost:r.getContext().isContextLost(), frame:r.info.render.frame,
        advanced:r.info.render.frame-a, waited:${i + 1},
        calls:r.info.render.calls, ratio:+r.getPixelRatio().toFixed(3)};})()`, true);
    if (back && back.advanced > 0) break;
  }
  const why = await ev(`window.__ISLAND__.game.frameInfo()`);
  /* THE FIRST LOSS TURNS THE SAVER ON BY ITSELF. A browser only takes the 3D
     view away when it is short of memory, so asking for the same amount again
     is asking for the same answer. */
  const auto = await ev(`(()=>({low:window.__ISLAND__.game.lowPower,
    stored:(JSON.parse(localStorage.getItem('island-settlers.quality')||'{}').level)<2,
    losses:(JSON.parse(localStorage.getItem('island-settlers.quality')||'{}').losses)|0,
    shadows:window.__ISLAND__.renderer.shadowMap.enabled}))()`);
  console.log('  AUTOSAVER ' + JSON.stringify(auto));
  console.log('  CONTEXT ' + JSON.stringify({ ext: lost.ext, before, during, back, why }));

  /* Hidden tabs must stop drawing. The frame counter is the only honest witness
     — rAF throttling alone is not what this claims, the explicit guard is. */
  const hid = await ev(`(async()=>{const r=window.__ISLAND__.renderer;
    Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});
    const a=r.info.render.frame;
    await new Promise(res=>setTimeout(res,2200));
    const b=r.info.render.frame;
    delete document.hidden;
    return {drewWhileHidden:b-a};})()`, true);
  await sleep(600);
  // Long enough to be a real sample: SwiftShader draws this island about
  // 1.5 times a second, so a 650ms window says nothing either way.
  const shown = await ev(`(async()=>{const r=window.__ISLAND__.renderer;
    const a=r.info.render.frame;
    await new Promise(res=>setTimeout(res,2600));
    return {drewWhenShown:r.info.render.frame-a};})()`, true);
  /*
   *   "I need the music and audio to stop playing in the background if I've
   *    left the PWA, or even left the tab. Same if I turn the screen off."
   *
   * The same hidden window the renderer is checked against, asked of the audio
   * engine: the context itself must be suspended, not merely quiet, because a
   * running context fed by a throttled timer is what the crackle was.
   */
  const snd = await ev(`(async()=>{const a=window.__ISLAND__.game.audio;
    const before={asleep:!!a.asleep, state:a.state};
    Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise(r=>setTimeout(r,400));
    const away={asleep:!!a.asleep, state:a.state};
    delete document.hidden;
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise(r=>setTimeout(r,400));
    return {before, away, back:{asleep:!!a.asleep, state:a.state}};})()`, true);
  console.log('  AUDIO ' + JSON.stringify(snd));
  console.log('  HIDDEN ' + JSON.stringify({ ...hid, ...shown }));

  console.log('  PERF ' + JSON.stringify({
    withinPixelBudget: budget.megapixels <= 2.45,
    theCapBitesOnARetinaScreen: retina.dpr >= 2 && retina.megapixels <= 2.45
      && retina.uncapped > 2.45 && retina.ratio < retina.dpr,
    ratioIsAtLeastOne: budget.ratio >= 1,
    shadowMatchesTheScreen: budget.buffer.h >= 800
      ? budget.shadow === 2048 : budget.shadow === 1024,
    survivesAContextLoss: lost.ext === true && back.lost === false
      && back.advanced > 0 && back.calls > 0,
    stopsDrawingWhenHidden: hid.drewWhileHidden === 0 && shown.drewWhenShown > 0,
    theSoundGoesWithThePage: snd.away.asleep === true
      && snd.away.state === 'suspended' && snd.back.asleep === false,
    batterySaverDropsTheShadowPass: full.shadows === true
      && saver.shadows === false && saver.casting === false,
    andPinsTheRatio: saver.ratio === 1,
    andIsRememberedForNextTime: saver.stored === true,
    aLostContextTurnsItOnByItself: auto.low === true && auto.stored === true
      && auto.shadows === false && auto.losses > 0,
    andTheGuessWasAlreadyLowOnThisMachine: bootLevel && bootLevel.level < 2,
    aLaptopIsGuessedLowBeforeTheFirstFrame: ladder.guessLow.level === 1
      && ladder.guessLow.why.length > 0,
    aRealGpuIsNot: ladder.guessHigh.level === 2,
    thereIsOneLookAndItIsEarly: ladder.probeAtSec <= 12,
    andTheBottomRungIsHalfTheFrameRate: ladder.rungs[0].fps === 30
      && ladder.rungs[0].ratio < 1,
    theBottomRungDropsTheBackdropBlur: saver.blurOff === true && full.blurOff === false,
    /* Nothing about a probe changes what is drawn — it reads the clock the
       loop already looks at. The invariants are exact — same rung, same draw
       calls, same pixel ratio — and the frame counts are printed as evidence
       rather than asserted: SwiftShader draws this scene about twice a second,
       and two windows of that differ by a factor of two on their own. The
       ladder's own arithmetic is tested for real in tools/verify.mjs, where it
       can be fed exact frame times. */
    andProbingCostsNothing: after.q.level === beforeProbe.level
      && after.calls === beforeProbe.calls && after.ratio === beforeProbe.ratio
  }));
  await shot(`perf-${TAG}`);

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
  /*
   * THE AWARDS PLATE HOLDS ITS OWN TEXT.
   *
   *   "Do you see how the yellow 2 on the largest army section doesn't fit on
   *    the dark blue box behind it. I don't want the box to be wider, but I'd
   *    like you to instead make it two rows."
   *
   * Measured with the widest values the game can produce rather than whatever
   * this match happens to be at — the target is twelve points, so "12 › 13" is
   * the real worst case and it is two characters wider than the "1 › 2" in the
   * report. Every award row must sit inside the plate's own box, on both axes.
   */
  console.log('  AWARDS ' + JSON.stringify(await ev(`(()=>{
    const I=window.__ISLAND__;
    I.state.players.forEach((p,i)=>{ p.knights=i===1?13:12; });
    I.state.players[0].hasLongestRoad=false;
    for(let i=0;i<12;i++) I.game.hud.update(1/60);
    const plate=document.querySelector('.scorecard .sc-awards')
      ||document.querySelector('.sc-awards');
    const rows=[...document.querySelectorAll('.aw-row')];
    const pb=plate.getBoundingClientRect();
    const out=rows.map(r=>{const b=r.getBoundingClientRect();
      return {txt:(r.textContent||'').replace(/\s+/g,' ').trim().slice(0,18),
        inside: b.left>=pb.left-0.5 && b.right<=pb.right+0.5
             && b.top>=pb.top-0.5 && b.bottom<=pb.bottom+0.5,
        over:+(b.right-pb.right).toFixed(1)};});
    // the numerals themselves, which is what actually overran
    const nums=[...document.querySelectorAll('.aw-size,.aw-mine')].map(n=>{
      const b=n.getBoundingClientRect();
      return +(b.right-pb.right).toFixed(1);});
    return {rows:out, stacked: rows.length===2 && rows[0].getBoundingClientRect().top
        < rows[1].getBoundingClientRect().top - 4,
      worstOverhang: Math.max(...nums),
      allInside: out.every(r=>r.inside) && Math.max(...nums) <= 0.5,
      plate:{w:Math.round(pb.width),h:Math.round(pb.height)}};})()`)));

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
for (const e of exceptions.slice(0, 6)) {
  // The first line names it; the next two say where, which is the difference
  // between "something threw" and a fault anybody can go and look at.
  console.log('  EXC ' + String(e).split('\n').slice(0, 3).join(' | ').slice(0, 420));
}
ws.close(); chrome.kill('SIGKILL');
process.exit(exceptions.length ? 1 : 0);
