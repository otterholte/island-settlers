/**
 * Headless capture rig.
 *
 * Launches chrome-headless-shell with a real (SwiftShader) WebGL context,
 * drives the running game over the DevTools protocol, and writes PNGs plus a
 * console/exception report. This is how the critic gauntlet sees the actual
 * product instead of a description of it.
 *
 * SwiftShader renders this scene at ~4fps and a capture costs ~5s, so the run
 * is split into stages that each fit inside a single short-lived shell call.
 *
 *   node tools/shoot.mjs --stage=intro|play|map|late|results [--w=960] [--h=444]
 *
 * The `gather` stage exists to look at harvesting specifically: it parks the
 * hero on a node of a chosen kind, loads their pack, steps the real simulation
 * through N harvest cycles and captures before / after.
 *
 *   node tools/shoot.mjs --stage=gather --node=tree|sheep|wheat|claypit|orerock
 *        [--cycles=2] [--pre=0] [--hud=0] [--wait=1700] [--tag=name]
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
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
const STAGE = arg('stage', 'play');
const CHROME = arg('chrome', '/tmp/chrome-headless-shell-linux64/chrome-headless-shell');
const LIBS = arg('libs', '/tmp/xlibs/root/usr/lib/x86_64-linux-gnu');

mkdirSync(OUT, { recursive: true });
if (!existsSync(CHROME)) { console.error(`no chrome at ${CHROME}`); process.exit(2); }

const sleep = ms => new Promise(r => setTimeout(r, ms));

const DP = 9333 + Math.floor(Math.random() * 500);
const chrome = spawn(CHROME, [
  '--headless', '--no-sandbox', '--disable-dev-shm-usage',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--run-all-compositor-stages-before-draw', '--disable-new-content-rendering-timeout',
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
if (!wsUrl) { console.error('devtools never came up\n' + chromeErr.slice(-600)); process.exit(2); }

const ws = new WebSocket(wsUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));

let msgId = 0;
const pending = new Map();
const consoleLines = [];
const exceptions = [];

ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id !== undefined) {
    const p = pending.get(m.id);
    if (p) { pending.delete(m.id); p(m.result || { __err: m.error }); }
    return;
  }
  if (m.method === 'Runtime.consoleAPICalled') {
    consoleLines.push({
      level: m.params.type,
      text: (m.params.args || []).map(a => a.value !== undefined ? String(a.value) : (a.description || a.type)).join(' ')
    });
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    exceptions.push({ text: d.exception?.description || d.text, url: d.url, line: d.lineNumber });
  }
  if (m.method === 'Log.entryAdded') {
    const e = m.params.entry;
    if (e.level === 'error' || e.level === 'warning') consoleLines.push({ level: e.level, text: `[${e.source}] ${e.text}` });
  }
});

const send = (method, params = {}) => new Promise(res => {
  const id = ++msgId;
  pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); res({ __err: 'timeout' }); } }, 30000);
});

const ev = async (expr, awaitPromise = false) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
  if (r?.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
  return r?.result?.value;
};

const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  if (!r?.data) { console.log(`  shot ${name} FAILED`); return; }
  const buf = Buffer.from(r.data, 'base64');
  writeFileSync(resolve(OUT, `${name}.png`), buf);
  console.log(`  shot ${name}.png (${(buf.length / 1024).toFixed(0)} KB)`);
};

const key = async (k, code, kc) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc });
  await sleep(60);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc });
};
const hold = async (k, code, kc, ms) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc });
  await sleep(ms);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc });
};

await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });

let booted = false;
for (let i = 0; i < 40; i++) {
  if (await ev('!!(window.__ISLAND__&&window.__ISLAND__.state)') === true) { booted = true; break; }
  await sleep(250);
}
if (!booted) { console.error('GAME DID NOT BOOT'); ws.close(); chrome.kill('SIGKILL'); process.exit(1); }
console.log('booted');

// Load rules into the page so we can drive the match deterministically.
await ev(`import('/src/core/rules.js').then(m=>{window.__R__=m}).then(()=>1)`, true);

/** Complete the opening draft instantly (used by every stage but `intro`). */
const finishDraft = async () => ev(`(()=>{const {state}=window.__ISLAND__,R=window.__R__;
  if(!R) return 'no rules';
  let g=0;
  while(state.phase==='setup'&&g++<40){
    const pid=R.setupCurrentPlayer(state);
    if(state.setupNeed==='settlement'){
      const L=R.legalSettlements(state,pid,true);
      // pick the fattest corner so the board looks contested, not random
      let best=L[0],bs=-1;
      for(const i of L){let s=0;for(const t of window.__ISLAND__.state.players?[]:[]) {}
        s=0; for(const tid of (R.intersectionsOf?R.intersectionsOf(i):[])) s+=0;
        if(s>bs){bs=s;best=i;}}
      R.setupPlaceSettlement(state,pid,L[Math.floor(L.length*0.37)]||L[0]);
    } else {
      const L=R.legalRoads(state,pid,true,state.setupAnchor);
      R.setupPlaceRoad(state,pid,L[0]);
    }
  }
  return state.phase;})()`);

const stats = async () => ev(`(()=>{const{state,renderer,scene}=window.__ISLAND__;
  let meshes=0;scene.traverse(o=>{if(o.isMesh||o.isPoints||o.isLine)meshes++;});
  return {phase:state.phase,time:+state.time.toFixed(1),
    buildings:state.buildings.size,roads:state.roadOwner.size,
    vp:state.players.map(p=>p.settlements.size+p.cities.size*2+p.vpCards),
    gathered:state.players.map(p=>p.stats.gathered),
    calls:renderer.info.render.calls,tris:renderer.info.render.triangles,
    meshes,textures:renderer.info.memory.textures,geometries:renderer.info.memory.geometries};})()`);

if (STAGE === 'intro') {
  await sleep(2500);
  await shot('01-intro');
  // Click BEGIN THE DRAFT if it is on screen, else let flow advance.
  await ev(`(()=>{const b=[...document.querySelectorAll('button,[data-ui]')].find(e=>/begin/i.test(e.textContent||''));if(b){b.click();return 1}return 0})()`);
  await sleep(3000);
  await shot('02-draft');

} else if (STAGE === 'play') {
  await finishDraft();
  await sleep(2500);
  await shot('03-play-start');
  await hold('w', 'KeyW', 87, 1200);
  await sleep(1500);
  await shot('04-running');

} else if (STAGE === 'gather') {
  // Park the hero on a gather node, load their pack, and run real harvest
  // cycles so the depletion / carry-column work can actually be looked at.
  const KIND = arg('node', 'tree');
  const CYCLES = +arg('cycles', 2);
  const TAG = arg('tag', KIND);
  await finishDraft();
  console.log('  place ' + await ev(`(()=>{const{state,game}=window.__ISLAND__;
    const N=game.world.props?1:1;
    return import('/src/board/nodes.js').then(m=>{
      const list=m.nodes.filter(n=>n.kind===${JSON.stringify(KIND)});
      const n=list[Math.floor(list.length*0.42)];
      const p=state.players[0];
      p.x=n.x-1.75; p.z=n.z+0.9; p.vx=0; p.vz=0; p.action='idle';
      p.facing=Math.atan2(n.z-p.z,n.x-p.x);
      p.res={wood:11,brick:6,wool:3,wheat:9,ore:5};
      game.avatars[0].setCarry(p.res);
      game.avatars[0].group.position.set(p.x,0,p.z);
      try{ game.camera.follow(p.x,p.z,1/60); game.camera.focus.set(p.x,3,p.z); }catch(e){}
      window.__STEP__=(k)=>{for(let i=0;i<k;i++){window.__R__.tickWorld(state,1/60);
        game.flow.update(1/60);game.controller.update(1/60);
        game.gathering.update(1/60);game.bots.update(1/60);}return state.time.toFixed(1);};
      return n.kind+'@'+n.id+' rem='+n.remaining;
    });})()`, true));
  if (arg('hud', '1') === '0') await ev(`(()=>{const u=document.getElementById('ui');if(u)u.style.display='none';return 1})()`);
  await sleep(1300);
  const where = async () => ev(`(()=>{const{state,camera,THREE}=window.__ISLAND__;
    const p=state.players[0];
    const v=new THREE.Vector3(p.x,3.5,p.z).project(camera);
    return {px:+p.x.toFixed(1),pz:+p.z.toFixed(1),act:p.action,
      sx:+((v.x*0.5+0.5)).toFixed(3),sy:+((-v.y*0.5+0.5)).toFixed(3)};})()`);
  console.log('  cam ' + JSON.stringify(await where()));
  if (arg('pre', '1') !== '0') await shot(`g-${TAG}-a`);
  console.log('  t=' + await ev(`window.__STEP__(${Math.round(CYCLES * 78)})`));
  await sleep(+arg('wait', 1700));
  await shot(`g-${TAG}-b`);
  console.log('  ' + JSON.stringify(await ev(`(()=>{const {state,world}=window.__ISLAND__;
    const c={};world.props.group.traverse(o=>{if(o.isMesh)c[o.name||'?']=
      (o.isInstancedMesh?o.count:1)*((o.geometry.index?o.geometry.index.count:o.geometry.attributes.position.count)/3);});
    return {gathered:state.players[0].stats.gathered,res:state.players[0].res,
      propTris:world.props.triangles,propCalls:world.props.drawCalls};})()`)));

} else if (STAGE === 'map') {
  await finishDraft();
  await sleep(1500);
  await ev(`window.__ISLAND__.game.openOverview('view')`);
  await sleep(2500);
  await shot('06-overview');
  await ev(`window.__ISLAND__.game.closeOverview()`);
  await sleep(1200);
  await shot('06b-after-map');

} else if (STAGE === 'late') {
  await finishDraft();
  // Fast-forward the simulation so bots build real structures.
  await ev(`(()=>{const {state}=window.__ISLAND__;window.__FF__=true;return 1})()`);
  await sleep(20000);
  await shot('07-midmatch');
  console.log('  ' + JSON.stringify(await stats()));

} else if (STAGE === 'results') {
  await finishDraft();
  await ev(`(()=>{const {state}=window.__ISLAND__,R=window.__R__;
    const p=state.players[0];
    // Hand the human a winning board so the results screen can be inspected.
    for(let i=0;i<6;i++){const L=R.legalSettlements(state,0,true);if(L.length)R.placeSettlement(state,0,L[0],true);}
    [...p.settlements].slice(0,5).forEach(i=>R.upgradeCity(state,0,i,true));
    R.checkVictory(state);return state.phase;})()`);
  await sleep(4000);
  await shot('08-results');
}

const s = await stats();
console.log('  stats ' + JSON.stringify(s));

const errs = exceptions.length;
const warns = consoleLines.filter(l => l.level === 'error' || l.level === 'warning');
console.log(`${errs} exception(s), ${warns.length} console error/warning(s)`);
for (const e of exceptions.slice(0, 8)) console.log('  EXC ' + String(e.text).split('\n')[0].slice(0, 180));
for (const l of warns.slice(0, 10)) console.log('  ' + l.level.toUpperCase() + ' ' + l.text.slice(0, 180));

const reportPath = resolve(OUT, 'report.json');
let prev = {};
try { prev = JSON.parse(readFileSync(reportPath, 'utf8')); } catch { /* first run */ }
prev[STAGE] = { stats: s, exceptions, warnings: warns, w: W, h: H, at: new Date().toISOString() };
writeFileSync(reportPath, JSON.stringify(prev, null, 2));

ws.close(); chrome.kill('SIGKILL');
process.exit(errs === 0 ? 0 : 1);
