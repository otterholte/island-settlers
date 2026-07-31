/**
 * Island Settlers — automated acceptance suite.
 *
 *   node tools/testmatch.mjs [--only=1,3,15] [--w=960] [--h=444] [--shots]
 *
 * Drives the REAL game in headless Chrome (SwiftShader WebGL) over the DevTools
 * protocol and asserts the nineteen shipping requirements against the running
 * build — not against the source.
 *
 * How it drives the game
 * ----------------------
 * SwiftShader renders this scene at ~3-5 fps, so waiting on requestAnimationFrame
 * for a four-minute match is not viable. Instead the harness calls the *same*
 * functions main.js's frame loop calls, at the same fixed 1/60 step, from inside
 * the page:
 *
 *     rules.tickWorld -> flow.update -> controller.update
 *                     -> gathering.update -> bots.update
 *
 * That is the production loop, minus rendering. Rendering still happens on its
 * own rAF cadence, so every event these systems emit is consumed by main.js's
 * `handleEvents` and turned into real meshes — which is exactly what we want to
 * see fail if it is going to fail.
 *
 * Nothing here reaches into a private field to make an assertion pass: player
 * positions are set (that is "the settler walked there"), and everything else
 * goes through rules.js / economy.js / overview.js / panels.js entry points.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const arg = (k, d) => {
  const hit = process.argv.find(a => a.startsWith(`--${k}=`));
  if (hit) return hit.split('=').slice(1).join('=');
  return process.argv.includes(`--${k}`) ? true : d;
};

const W = +arg('w', 960);
const H = +arg('h', 444);
const PORT = +arg('port', 5173);
const OUT = resolve(ROOT, arg('out', 'progress/shots'));
const CHROME = arg('chrome', '/tmp/chrome-headless-shell-linux64/chrome-headless-shell');
const LIBS = arg('libs', '/tmp/xlibs/root/usr/lib/x86_64-linux-gnu');
const SHOTS = !!arg('shots', false);
const ONLY = arg('only', '') ? String(arg('only', '')).split(',').map(Number) : null;

mkdirSync(OUT, { recursive: true });
if (!existsSync(CHROME)) { console.error(`no chrome at ${CHROME}`); process.exit(2); }

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ============================================================ chrome plumbing */

const DP = 9333 + Math.floor(Math.random() * 500);
const chrome = spawn(CHROME, [
  '--headless', '--no-sandbox', '--disable-dev-shm-usage',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  // NOT --run-all-compositor-stages-before-draw: the scene renders every rAF
  // anyway, and that flag makes each capture cost ~12s under SwiftShader.
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
const consoleLines = [];
const exceptions = [];

ws.addEventListener('message', evt => {
  const m = JSON.parse(evt.data);
  if (m.id !== undefined) {
    const p = pending.get(m.id);
    if (p) { pending.delete(m.id); p(m.result || { __err: m.error }); }
    return;
  }
  if (m.method === 'Runtime.consoleAPICalled') {
    consoleLines.push({
      level: m.params.type,
      text: (m.params.args || [])
        .map(a => (a.value !== undefined ? String(a.value) : (a.description || a.type)))
        .join(' ')
    });
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    exceptions.push({ text: d.exception?.description || d.text, url: d.url, line: d.lineNumber });
  }
  if (m.method === 'Log.entryAdded') {
    const e = m.params.entry;
    if (e.level === 'error' || e.level === 'warning') {
      consoleLines.push({ level: e.level, text: `[${e.source}] ${e.text}` });
    }
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
  if (r?.__err) return { __err: JSON.stringify(r.__err) };
  if (r?.exceptionDetails) {
    return { __err: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
  }
  return r?.result?.value;
};

const shot = async name => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  if (!r?.data) return null;
  const buf = Buffer.from(r.data, 'base64');
  const path = resolve(OUT, `${name}.png`);
  writeFileSync(path, buf);
  return path;
};

/* ============================================================ result recording */

const results = [];
let currentId = 0;

const T0 = Date.now();
let tMark = Date.now();

function record(id, name, pass, evidence) {
  const ms = Date.now() - tMark; tMark = Date.now();
  results.push({ id, name, pass: pass === null ? null : !!pass, evidence: String(evidence), ms });
  const tag = pass === null ? 'SKIP' : (pass ? 'PASS' : 'FAIL');
  console.log(`${tag}  ${String(id).padStart(2)}. ${name}  [${(ms / 1000).toFixed(1)}s]`);
  for (const line of String(evidence).split('\n')) {
    if (line.trim()) console.log(`        ${line}`);
  }
}

const wanted = id => !ONLY || ONLY.includes(id);

async function test(id, name, fn) {
  if (!wanted(id)) return;
  currentId = id;
  try {
    const r = await fn();
    record(id, name, r.pass, r.evidence);
  } catch (e) {
    record(id, name, false, `harness threw: ${e && e.message}`);
  }
}

/** Evaluate and blow up loudly on a page-side exception instead of silently. */
async function pev(expr) {
  const v = await ev(expr);
  if (v && v.__err) throw new Error(`page: ${String(v.__err).split('\n')[0]}`);
  return v;
}

/** Every check from 3 on needs a live match; make one if the suite is being
 *  run as a subset (`--only=`) and the board is still in the draft. */
async function ensurePlay() {
  const phase = await pev('window.__ISLAND__.state.phase');
  if (phase === 'play') return true;
  if (phase === 'over') {
    await pev('window.__ISLAND__.game.flow.restartInPlace({seed:7})');
    await sleep(400);
  }
  const d = await pev('__draft(45)');
  return d.phase === 'play';
}

/* ==================================================================== boot */

await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });

let booted = false;
for (let i = 0; i < 120; i++) {
  if (await ev('!!(window.__ISLAND__&&window.__ISLAND__.state)') === true) { booted = true; break; }
  await sleep(120);
}
if (!booted) {
  console.error('GAME DID NOT BOOT\n' + chromeErr.slice(-600));
  ws.close(); chrome.kill('SIGKILL'); process.exit(1);
}
await ev(`Promise.all([
  import('/src/core/rules.js').then(m=>{window.__R__=m}),
  import('/src/board/layout.js').then(m=>{window.__L__=m}),
  import('/src/board/nodes.js').then(m=>{window.__N__=m}),
  import('/src/core/constants.js').then(m=>{window.__C__=m}),
  import('/src/systems/economy.js').then(m=>{window.__E__=m})
]).then(()=>1)`, true);

const ready = await ev('!!(window.__R__&&window.__L__&&window.__N__&&window.__C__&&window.__E__)');
if (ready !== true) {
  console.error('module import into page failed');
  ws.close(); chrome.kill('SIGKILL'); process.exit(1);
}

/* --------------------------------------------------------- in-page harness */

await pev(`(()=>{
const I=()=>window.__ISLAND__, R=window.__R__, L=window.__L__, N=window.__N__, C=window.__C__;
const S=1/60;

/** Run the production fixed step. Nothing is simulated that main.js does not
 *  itself simulate; the systems are simply called directly. */
window.__tick = function(seconds, o){
  o = o || {};
  const g = I().game, st = I().state;
  const n = Math.max(1, Math.round(seconds*60));
  const stop = o.stop ? new Function('I','R','st','return ('+o.stop+')') : null;
  const drained = [];
  let i=0;
  for (; i<n; i++){
    R.tickWorld(st, S);
    if (o.flow && g.flow) g.flow.update(S);
    if (o.controller && g.controller) g.controller.update(S);
    if (o.gather && g.gathering) g.gathering.update(S);
    if (o.bots && g.bots) g.bots.update(S);
    if (o.drain) { const e = R.drainEvents(st); for (const x of e) drained.push(x); }
    if (stop && stop(I(), R, st)) { i++; break; }
  }
  return { steps:i, seconds:i*S, events:o.drain?drained:undefined };
};

/** Put a settler where a settler could walk. Position is not a private field —
 *  it is the same x/z the controller writes every frame. */
window.__place = function(pid,x,z){
  const p = I().state.players[pid];
  p.x=x; p.z=z; p.vx=0; p.vz=0; p.action='idle';
  p.gatherNode=null; p.gatherProgress=0; p.gatherIntent=null;
  return {x:p.x,z:p.z};
};

window.__res = pid => ({ ...I().state.players[pid].res });
window.__snap = () => {
  const st = I().state;
  return {
    phase: st.phase, time: +st.time.toFixed(2), winner: st.winner,
    buildings: st.buildings.size, roads: st.roadOwner.size,
    robberTile: st.robberTile, robberOwner: st.robberOwner,
    longestRoadHolder: st.longestRoadHolder, largestArmyHolder: st.largestArmyHolder,
    vp: st.players.map(p=>R.scoreOf(st,p)),
    res: st.players.map(p=>({ ...p.res })),
    ports: st.players.map(p=>[...p.ports]),
    knights: st.players.map(p=>p.knightsPlayed),
    cards: st.players.map(p=>p.cards.map(c=>c.type)),
    stats: st.players.map(p=>({ ...p.stats }))
  };
};

/** A live node on a tile with the given resource and pip count. */
window.__findNode = function(resource, pips, avoidOwned){
  const st = I().state;
  for (const n of N.nodes){
    if (n.remaining<=0) continue;
    const t = L.tiles[n.tile];
    if (resource && n.resource!==resource) continue;
    if (pips && t.pips!==pips) continue;
    if (avoidOwned){
      let owned=false;
      for (const c of t.corners) if (st.buildings.has(c)) owned=true;
      if (owned) continue;
    }
    return { id:n.id, x:n.x, z:n.z, tile:n.tile, resource:n.resource,
             pips:t.pips, remaining:n.remaining };
  }
  return null;
};

/** Refill every node so a measurement is not truncated by depletion. */
window.__refill = function(){
  for (const n of N.nodes){ n.remaining = C.NODE_CAPACITY; n.regrowAt = 0; n.justRegrew=false; }
  return N.nodes.length;
};

window.__grant = function(pid, bag){
  const p = I().state.players[pid];
  for (const k in bag) p.res[k] = (p.res[k]||0) + bag[k];
  return { ...p.res };
};

/** Drive the real opening draft: matchflow picks for the bots, and the human
 *  turns are answered through overview.select() + a click on the actual
 *  Confirm button in the DOM. */
window.__draft = function(maxSec){
  const st = I().state, g = I().game;
  const n = Math.round((maxSec||45)*60);
  const log=[]; let picks=0, i=0;
  if (g.flow && g.flow.skipIntro) g.flow.skipIntro();
  for (; i<n && st.phase==='setup'; i++){
    g.flow.update(S);
    const ov = g.overview;
    if (ov && ov.isOpen && String(ov.mode).indexOf('place-')===0){
      const road = st.setupNeed==='road';
      const list = road ? R.legalRoads(st,0,true,st.setupAnchor)
                        : R.legalSettlements(st,0,true);
      if (!list.length) { log.push('no legal '+st.setupNeed); break; }
      const id = list[Math.floor(list.length*0.4)];
      const need = st.setupNeed;
      ov.select(id);
      const btn = document.querySelector('.ov-bar .btn.green');
      if (btn && !btn.disabled){ btn.click(); picks++; log.push('human '+need+' #'+id+' (Confirm button)'); }
      else { ov.commit(); picks++; log.push('human '+need+' #'+id+' (commit)'); }
    }
  }
  return { phase:st.phase, humanPicks:picks, steps:i, seconds:+(i*S).toFixed(1),
           buildings:st.buildings.size, roads:st.roadOwner.size,
           perPlayer: st.players.map(p=>({ s:p.settlements.size, r:p.roads.size })),
           log };
};

window.__ui = function(sel, all){
  const q = all ? [...document.querySelectorAll(sel)] : [document.querySelector(sel)];
  return q.filter(Boolean).map(e=>({
    cls: e.className, text: (e.textContent||'').trim().slice(0,160),
    hidden: !e.offsetParent && getComputedStyle(e).position!=='fixed',
    w: e.getBoundingClientRect().width, h: e.getBoundingClientRect().height
  }));
};

window.__click = function(sel){
  const e = document.querySelector(sel);
  if (!e) return 'missing';
  if (e.disabled) return 'disabled';
  e.click();
  return 'clicked';
};

window.__perf = function(){
  const r = I().renderer;
  return { calls:r.info.render.calls, triangles:r.info.render.triangles,
           lines:r.info.render.lines, points:r.info.render.points,
           programs:(r.info.programs||[]).length,
           textures:r.info.memory.textures, geometries:r.info.memory.geometries };
};

/** Where the triangles actually live — grouped by the top-level scene child so
 *  a budget overrun is actionable rather than just a number. */
window.__triBreakdown = function(){
  const scene = I().scene;
  const rows = [];
  const count = o => {
    let tris=0, draws=0;
    o.traverse(n=>{
      if (!n.visible) return;
      const g = n.geometry;
      if (!g) return;
      const inst = n.isInstancedMesh ? n.count : 1;
      const idx = g.index ? g.index.count : (g.attributes.position ? g.attributes.position.count : 0);
      if (n.isMesh) { tris += (idx/3)*inst; draws += 1; }
      else if (n.isPoints || n.isLine) draws += 1;
    });
    return { tris:Math.round(tris), draws };
  };
  for (const c of scene.children){
    const s = count(c);
    if (!s.tris && !s.draws) continue;
    rows.push({ name: c.name || c.type, tris:s.tris, draws:s.draws });
  }
  rows.sort((a,b)=>b.tris-a.tris);
  return rows.slice(0,12);
};
return 1;})()`);

/* ============================================================= the checklist */

console.log(`\nIsland Settlers — acceptance suite @ ${W}x${H}\n${'='.repeat(58)}`);

/* ---- 1. clean launch ---------------------------------------------------- */

await test(1, 'Match launches with no uncaught exceptions and no broken shaders', async () => {
  // Let a few real frames render so every material has actually compiled.
  await sleep(450);
  const perf = await pev('__perf()');
  const shaderTrouble = consoleLines.filter(l =>
    /shader|program|glsl|link|compile|WebGL: INVALID|context lost/i.test(l.text));
  const hardErrors = consoleLines.filter(l => l.level === 'error');
  const bootExc = exceptions.slice();
  const pass = bootExc.length === 0 && shaderTrouble.length === 0 && perf.calls > 0;
  return {
    pass,
    evidence:
      `exceptions=${bootExc.length} consoleErrors=${hardErrors.length} shaderWarnings=${shaderTrouble.length}\n` +
      `programs=${perf.programs} drawCalls=${perf.calls} triangles=${perf.triangles}\n` +
      (bootExc.length ? 'EXC: ' + bootExc.map(e => String(e.text).split('\n')[0]).join(' | ') + '\n' : '') +
      (shaderTrouble.length ? 'SHADER: ' + shaderTrouble.map(l => l.text.slice(0, 140)).join(' | ') + '\n' : '') +
      (hardErrors.length ? 'ERR: ' + hardErrors.slice(0, 4).map(l => l.text.slice(0, 140)).join(' | ') : '')
  };
});

/* ---- 2. opening draft --------------------------------------------------- */

let draftInfo = null;
await test(2, 'Opening draft places 8 settlements + 8 roads and reaches phase=play', async () => {
  draftInfo = await pev('__draft(45)');
  const per = draftInfo.perPlayer.map(p => `${p.s}s/${p.r}r`).join(' ');
  const pass = draftInfo.phase === 'play'
    && draftInfo.buildings === 8 && draftInfo.roads === 8
    && draftInfo.humanPicks === 4     // 2 settlements + 2 roads, all through the UI
    && draftInfo.perPlayer.every(p => p.s === 2 && p.r === 2);
  return {
    pass,
    evidence: `phase=${draftInfo.phase} settlements=${draftInfo.buildings} roads=${draftInfo.roads} ` +
      `humanPicksViaUI=${draftInfo.humanPicks} draftTime=${draftInfo.seconds}s\n` +
      `per-player: ${per}\n` + draftInfo.log.slice(0, 4).join(' | ')
  };
});

/* ---- 3. all five resources gather --------------------------------------- */

await test(3, 'All five resources can be gathered and the inventory increases', async () => {
  await ensurePlay();
  const out = await pev(`(()=>{
    const R=window.__R__, C=window.__C__;
    const st=window.__ISLAND__.state;
    const rows=[];
    for (const r of C.RES){
      __refill();
      const n = __findNode(r, null, true) || __findNode(r, null, false);
      if (!n){ rows.push({res:r, ok:false, why:'no live node'}); continue; }
      __place(0, n.x, n.z);
      const before = st.players[0].res[r];
      st.players[0].gatherIntent = n.id;
      const t = __tick(12, { gather:true, stop:'st.players[0].res.'+r+' > '+before });
      const after = st.players[0].res[r];
      rows.push({res:r, ok:after>before, before, after, node:n.id, tile:n.tile,
                 pips:n.pips, secs:+t.seconds.toFixed(2)});
    }
    return rows;})()`);
  const bad = out.filter(r => !r.ok);
  return {
    pass: bad.length === 0,
    evidence: out.map(r => `${r.res}: ${r.before}->${r.after} in ${r.secs}s (node ${r.node}, ${r.pips} pips)`).join('\n')
      + (bad.length ? `\nFAILED: ${bad.map(b => b.res + ' ' + (b.why || '')).join(', ')}` : '')
  };
});

/* ---- 4. productivity ---------------------------------------------------- */

await test(4, 'Region productivity: a 5-pip tile yields faster than a 1-pip tile', async () => {
  await ensurePlay();
  const out = await pev(`(()=>{
    const C=window.__C__; const st=window.__ISLAND__.state;
    function measure(pips){
      __refill();
      const n = __findNode(null, pips, true) || __findNode(null, pips, false);
      if (!n) return null;
      __place(0, n.x, n.z);
      const r=n.resource, before=st.players[0].res[r];
      st.players[0].gatherIntent = n.id;
      // Three swings is one full node, i.e. pure gather time with no regrow wait.
      const t = __tick(30, { gather:true, stop:'st.players[0].res.'+r+' >= '+(before+3) });
      const gained = st.players[0].res[r]-before;
      // Sustained rate over a full minute, including the regrow wait. The
      // controller runs too, so the settler re-latches after a node regrows
      // exactly as it does for a player standing still on the tile.
      __refill(); __place(0,n.x,n.z);
      const b2 = st.players[0].res[r];
      st.players[0].gatherIntent = n.id;
      __tick(60, { gather:true, controller:true });
      return { pips, tile:n.tile, res:r, node:n.id, gained,
               burst:+t.seconds.toFixed(2),
               perSwing:+(t.seconds/Math.max(1,gained)).toFixed(3),
               perMin: st.players[0].res[r]-b2,
               declared: C.GATHER_TIME[pips] };
    }
    return { hi: measure(5), lo: measure(1) };})()`);
  const { hi, lo } = out;
  if (!hi || !lo) return { pass: false, evidence: `could not find a ${!hi ? '5' : '1'}-pip node` };
  const pass = hi.perSwing < lo.perSwing && hi.perMin > lo.perMin;
  return {
    pass,
    evidence:
      `5-pip tile ${hi.tile} (${hi.res}): ${hi.gained} units in ${hi.burst}s = ${hi.perSwing}s/unit ` +
      `(declared ${hi.declared}s) · ${hi.perMin} units in 60s\n` +
      `1-pip tile ${lo.tile} (${lo.res}): ${lo.gained} units in ${lo.burst}s = ${lo.perSwing}s/unit ` +
      `(declared ${lo.declared}s) · ${lo.perMin} units in 60s\n` +
      `speed ratio ${(lo.perSwing / hi.perSwing).toFixed(2)}x per swing, ` +
      `${(hi.perMin / Math.max(1, lo.perMin)).toFixed(2)}x sustained`
  };
});

/* ---- 5. trading post ---------------------------------------------------- */

await test(5, 'Trading post trades at 4:1 and requires physical proximity', async () => {
  await ensurePlay();
  const out = await pev(`(()=>{
    const L=window.__L__, E=window.__E__, C=window.__C__;
    const st=window.__ISLAND__.state, g=window.__ISLAND__.game;
    const p=st.players[0];
    __grant(0,{wood:10});
    // 1) stand ON the market and trade through economy.js (the human path)
    __place(0, L.MARKET.x, L.MARKET.z);
    __tick(0.2,{controller:true});
    const spotNear = E.tradeSpot(g);
    const w0=p.res.wood, o0=p.res.ore;
    const near = E.trade('wood','ore',g);
    const afterNear = { wood:p.res.wood, ore:p.res.ore, dWood:p.res.wood-w0, dOre:p.res.ore-o0 };
    // 2) walk to the far side of the island and try again
    __place(0, L.BOUNDS.cx + L.BOUNDS.radius*0.85, L.BOUNDS.cz);
    __tick(0.2,{controller:true});
    const spotFar = E.tradeSpot(g);
    const w1=p.res.wood;
    const far = E.trade('wood','ore',g);
    const farMoved = p.res.wood !== w1;
    // 3) the HUD only offers the market prompt when you are standing at it
    const promptFar = (document.querySelector('.prompt')||{}).className||'';
    // 4) the trade SHEET itself, opened then carried away from the post
    g.openTrade(null);
    const sheetOpen = !!document.querySelector('.sheet.trade:not(.hid)');
    const w2=p.res.wood, o2=p.res.ore;
    // click give=wood, get=ore, then Trade
    const gv=[...document.querySelectorAll('.trade-body .tcol')][0]
              .querySelectorAll('.pick')[C.RES.indexOf('wood')];
    const gt=[...document.querySelectorAll('.trade-body .tcol')][1]
              .querySelectorAll('.pick')[C.RES.indexOf('ore')];
    if(gv)gv.click(); if(gt)gt.click();
    const btn=document.querySelector('.sheet.trade .sheet-foot .btn.green');
    const btnOff = btn ? btn.className.indexOf('off')>=0 : null;
    if(btn && !btn.disabled) btn.click();
    const sheetTraded = { dWood:p.res.wood-w2, dOre:p.res.ore-o2 };
    if (g.panels && g.panels.close) g.panels.close();

    // 5) the whole human loop: stand at the post, tap the HUD prompt, pick the
    //    two resources, tap Trade.
    __place(0, L.MARKET.x, L.MARKET.z);
    __tick(0.2,{controller:true});
    if (g.hud && g.hud.update) g.hud.update(0.5);
    const prompt = document.querySelector('.prompt');
    const promptTxt = prompt ? prompt.textContent.trim().slice(0,40) : null;
    if (prompt) prompt.click();
    const uiOpen = !!document.querySelector('.sheet.trade:not(.hid)');
    const w3=p.res.wood, o3=p.res.ore;
    const cols=[...document.querySelectorAll('.trade-body .tcol')];
    const gv2=cols[0]&&cols[0].querySelectorAll('.pick')[C.RES.indexOf('wood')];
    const gt2=cols[1]&&cols[1].querySelectorAll('.pick')[C.RES.indexOf('ore')];
    if(gv2)gv2.click(); if(gt2)gt2.click();
    const btn2=document.querySelector('.sheet.trade .sheet-foot .btn.green');
    const btn2Off = btn2 ? btn2.className.indexOf('off')>=0 : null;
    const why = (document.querySelector('.sheet.trade .why')||{}).textContent;
    if(btn2 && !btn2.disabled) btn2.click();
    const uiTraded = { dWood:p.res.wood-w3, dOre:p.res.ore-o3,
                       closed: !document.querySelector('.sheet.trade:not(.hid)') };
    if (g.panels && g.panels.close) g.panels.close();

    return { spotNear, near, afterNear, spotFar, far, farMoved, promptFar,
             sheetOpen, btnOff, sheetTraded, base:C.TRADE_BASE,
             promptTxt, uiOpen, btn2Off, why, uiTraded };})()`);
  const nearOk = out.near.ok && out.near.ratio === 4
    && out.afterNear.dWood === -4 && out.afterNear.dOre === 1;
  const farOk = !out.far.ok && !out.farMoved;
  const sheetLeak = out.sheetTraded.dOre !== 0;
  const uiOk = out.uiOpen && out.btn2Off === false
    && out.uiTraded.dWood === -4 && out.uiTraded.dOre === 1;
  return {
    pass: nearOk && farOk && !sheetLeak && uiOk,
    evidence:
      `at market (${out.spotNear ? out.spotNear.label : 'none'}): trade ok=${out.near.ok} ` +
      `ratio=${out.near.ratio} wood${out.afterNear.dWood} ore+${out.afterNear.dOre}\n` +
      `far from any post (spot=${out.spotFar ? out.spotFar.label : 'null'}): ` +
      `ok=${out.far.ok} reason="${out.far.reason}" resourcesMoved=${out.farMoved}\n` +
      `trade sheet forced open while far: opened=${out.sheetOpen} confirmGreyed=${out.btnOff} ` +
      `wood${out.sheetTraded.dWood} ore+${out.sheetTraded.dOre}` +
      (sheetLeak ? '  <-- LEAK: panels.js traded without a proximity check' : '') +
      `\nfull human loop at the market: prompt="${out.promptTxt}" -> sheet opened=${out.uiOpen}, ` +
      `Trade enabled=${out.btn2Off === false} ("${out.why}"), ` +
      `wood${out.uiTraded.dWood} ore+${out.uiTraded.dOre}, sheet closed=${out.uiTraded.closed}` +
      (uiOk ? '' : '  <-- a human cannot complete a trade through the UI')
  };
});

/* ---- 6. ports ----------------------------------------------------------- */

await test(6, 'Ports unlock on a coastal build and then trade at 3:1 / 2:1', async () => {
  await ensurePlay();
  const out = await pev(`(()=>{
    const R=window.__R__, L=window.__L__, E=window.__E__, C=window.__C__;
    const st=window.__ISLAND__.state, g=window.__ISLAND__.game; const p=st.players[0];

    /** Lay a real, legal road chain from my network out to a dock corner —
     *  every segment goes through rules.placeRoad, exactly as building would. */
    function roadToPort(kindWant){
      const own = new Set([...p.settlements, ...p.cities]);
      for (const e of p.roads){ own.add(L.edges[e].a); own.add(L.edges[e].b); }
      const targets = new Set(L.intersections.filter(n =>
        n.port !== null && n.port !== undefined
        && (kindWant==='any' || L.ports[n.port].kind===kindWant)
        && R.settlementLegal(st,0,n.id,true)).map(n=>n.id));
      for (const s of own) if (targets.has(s)) return { iid:s, placed:0 };
      const prev=new Map(), seen=new Set(own); let q=[...own], goal=-1;
      while(q.length && goal<0){
        const cur=q.shift();
        const b=st.buildings.get(cur);
        if (b && b.owner!==0 && !own.has(cur)) continue;   // rival corner severs
        for (const eid of L.intersections[cur].edges){
          if (st.roadOwner.has(eid) && st.roadOwner.get(eid)!==0) continue;
          const e=L.edges[eid];
          const nx = e.a===cur ? e.b : e.a;
          if (seen.has(nx)) continue;
          seen.add(nx); prev.set(nx,{from:cur,edge:eid});
          if (targets.has(nx)){ goal=nx; break; }
          q.push(nx);
        }
      }
      if (goal<0) return { iid:-1, placed:0 };
      const path=[]; let c=goal;
      while(prev.has(c)){ const s=prev.get(c); path.push(s.edge); c=s.from; }
      path.reverse();
      let placed=0;
      for (const eid of path){
        if (st.roadOwner.has(eid)) continue;
        if (R.placeRoad(st,0,eid,true)) placed++; else return { iid:-1, placed };
      }
      return { iid:goal, placed, path };
    }

    const rows=[];
    const before = [...p.ports];
    let unlocked = [];
    for (const kindWant of ['special','generic']){
      const route = roadToPort(kindWant);
      if (route.iid < 0){ rows.push({ port:null, built:false, why:'no road route to a '+kindWant+' dock' }); continue; }
      const iid = route.iid;
      const pid = L.intersections[iid].port;
      const port = L.ports[pid];
      const had = p.ports.has(pid);
      const ok = R.placeSettlement(st,0,iid,true);
      unlocked = [...p.ports];
      if (!ok){ rows.push({port:pid, built:false, why:'placeSettlement refused'}); continue; }
      __place(0, port.x, port.z);
      __tick(0.2,{controller:true});
      const give = port.resource || 'wood';
      __grant(0, { [give]: 8 });
      const g0 = p.res[give], k0 = p.res[give==='ore'?'wool':'ore'];
      const t = E.trade(give, give==='ore'?'wool':'ore', g);
      rows.push({ port:pid, kind:port.kind, resource:port.resource||null,
                  declaredRatio:port.ratio, built:true, roadsLaid:route.placed,
                  hadBefore:had, unlockedNow:p.ports.has(pid),
                  tradeOk:t.ok, chargedRatio:t.ratio,
                  spent:g0-p.res[give], got:p.res[give==='ore'?'wool':'ore']-k0,
                  quoted:R.activeTradeRatio(st,0,give,pid) });
    }
    return { before, unlocked, rows, PORT_GENERIC:C.PORT_GENERIC, PORT_SPECIAL:C.PORT_SPECIAL };})()`);
  const rows = out.rows;
  const ok = rows.length >= 1 && rows.every(r =>
    r.built && r.unlockedNow && r.tradeOk && r.chargedRatio === r.declaredRatio
    && r.spent === r.declaredRatio && r.got === 1);
  const sawSpecial = rows.some(r => r.declaredRatio === out.PORT_SPECIAL);
  const sawGeneric = rows.some(r => r.declaredRatio === out.PORT_GENERIC);
  return {
    pass: ok && sawSpecial && sawGeneric,
    evidence: `ports held before build: [${out.before}] -> after: [${out.unlocked}]\n` +
      rows.map(r => r.built
        ? `port ${r.port} ${r.kind}${r.resource ? '/' + r.resource : ''}: ${r.roadsLaid} roads laid to reach it, ` +
          `declared ${r.declaredRatio}:1, quoted ${r.quoted}:1, charged ${r.chargedRatio}:1, ` +
          `spent ${r.spent} got ${r.got}, unlocked=${r.unlockedNow} (held before=${r.hadBefore})`
        : `port ${r.port}: NOT BUILT — ${r.why}`).join('\n')
  };
});

/* ---- 7. road legality --------------------------------------------------- */

await test(7, 'Roads follow legal connection rules; illegal placements are rejected', async () => {
  await ensurePlay();
  const out = await pev(`(()=>{
    const R=window.__R__, L=window.__L__, C=window.__C__;
    const st=window.__ISLAND__.state; const p=st.players[0];
    __grant(0,{wood:20,brick:20});
    const legal = new Set(R.legalRoads(st,0));
    const disconnected = L.edges.find(e => !st.roadOwner.has(e.id) && !legal.has(e.id));
    const occupied = [...st.roadOwner.keys()][0];
    const good = [...legal][0];
    const r0 = {...p.res};
    const aDisc = R.placeRoad(st,0,disconnected.id,false);
    const afterDisc = {...p.res};
    const aOcc = R.placeRoad(st,0,occupied,false);
    const rivalEdge = [...st.roadOwner.entries()].find(([,o])=>o!==0);
    const aRival = rivalEdge ? R.placeRoad(st,0,rivalEdge[0],false) : null;
    const before = st.roadOwner.size;
    const aGood = R.placeRoad(st,0,good,false);
    const afterGood = {...p.res};
    // and one placed through the real UI path (economy -> overview -> Confirm)
    const legal2 = R.legalRoads(st,0);
    const uiOpened = window.__ISLAND__.game.requestBuild('road');
    const ov = window.__ISLAND__.game.overview;
    let uiPlaced=false, uiCost=null;
    if (ov && ov.isOpen && legal2.length){
      const c0={...p.res};
      ov.select(legal2[0]);
      const btn=document.querySelector('.ov-bar .btn.green');
      if(btn && !btn.disabled) btn.click(); else ov.commit();
      uiPlaced = st.roadOwner.get(legal2[0])===0;
      uiCost = { wood:c0.wood-p.res.wood, brick:c0.brick-p.res.brick };
    }
    if (ov && ov.isOpen) ov.close();
    return { disconnected:disconnected.id, aDisc,
      discCharged: r0.wood!==afterDisc.wood || r0.brick!==afterDisc.brick,
      occupied, aOcc, rivalEdge: rivalEdge?rivalEdge[0]:null, aRival,
      good, aGood, roadsBefore:before, roadsAfter:st.roadOwner.size,
      goodCost:{ wood:afterDisc.wood-afterGood.wood, brick:afterDisc.brick-afterGood.brick },
      cost:C.COST.road, uiOpened, uiPlaced, uiCost };})()`);
  const pass = out.aDisc === false && !out.discCharged && out.aOcc === false
    && out.aRival === false && out.aGood === true
    && out.goodCost.wood === out.cost.wood && out.goodCost.brick === out.cost.brick
    && out.uiPlaced === true;
  return {
    pass,
    evidence:
      `disconnected edge #${out.disconnected} -> ${out.aDisc} (charged=${out.discCharged})\n` +
      `already-mine edge #${out.occupied} -> ${out.aOcc}; rival's edge #${out.rivalEdge} -> ${out.aRival}\n` +
      `legal edge #${out.good} -> ${out.aGood}, cost ${JSON.stringify(out.goodCost)} vs ${JSON.stringify(out.cost)}\n` +
      `via HUD build card -> overview -> Confirm: placed=${out.uiPlaced} cost=${JSON.stringify(out.uiCost)}`
  };
});

/* ---- 8. settlement rules ------------------------------------------------ */

await test(8, 'Settlements obey the distance rule and require a connected road', async () => {
  await ensurePlay();
  const out = await pev(`(()=>{
    const R=window.__R__, L=window.__L__, C=window.__C__;
    const st=window.__ISLAND__.state; const p=st.players[0];
    __grant(0,{wood:40,brick:40,wheat:40,wool:40});
    // Two draft roads leave no legal corner (both far ends are neighbours of my
    // own settlements), so extend the network first — through rules.placeRoad.
    let laid=0;
    for (let i=0;i<6 && !R.legalSettlements(st,0).length;i++){
      const legal=R.legalRoads(st,0);
      if(!legal.length) break;
      if (R.placeRoad(st,0,legal[legal.length-1],true)) laid++;
    }
    // a corner directly beside one of my own settlements
    const mine=[...p.settlements][0];
    if (mine===undefined) return { noSettlement:true };
    const adj = L.intersections[mine].neighbors.find(i=>!st.buildings.has(i));
    const aAdj = R.placeSettlement(st,0,adj,false);
    // a far corner with no road of mine touching it
    const legalNow = new Set(R.legalSettlements(st,0));
    const orphan = L.intersections.find(n =>
      !st.buildings.has(n.id) && !legalNow.has(n.id) &&
      n.neighbors.every(i=>!st.buildings.has(i)));
    const aOrphan = orphan ? R.placeSettlement(st,0,orphan.id,false) : null;
    const orphanReason = orphan
      ? { distanceOk:orphan.neighbors.every(i=>!st.buildings.has(i)),
          roadTouching: orphan.edges.some(e=>st.roadOwner.get(e)===0) } : null;
    const before={...p.res}, nb=st.buildings.size;
    const good=[...R.legalSettlements(st,0)][0];
    if (good===undefined) return { noLegalSpot:true };
    const aGood = R.placeSettlement(st,0,good,false);
    const cost = { wood:before.wood-p.res.wood, brick:before.brick-p.res.brick,
                   wheat:before.wheat-p.res.wheat, wool:before.wool-p.res.wool };
    // now the distance rule from the other side: neighbours of the new one
    const nb2 = L.intersections[good].neighbors.find(i=>!st.buildings.has(i));
    const aAfter = nb2===undefined ? null : R.placeSettlement(st,0,nb2,false);
    return { laid, mine, adj, aAdj, orphan:orphan?orphan.id:null, aOrphan, orphanReason,
             good, aGood, cost, want:C.COST.settlement,
             nb2, aAfter, buildings:{before:nb, after:st.buildings.size} };})()`);
  if (out.noSettlement || out.noLegalSpot) {
    return { pass: false, evidence: `precondition missing: ${JSON.stringify(out)}` };
  }
  const pass = out.aAdj === false && out.aOrphan === false && out.aGood === true
    && out.aAfter === false && out.buildings.after === out.buildings.before + 1
    && out.cost.wood === out.want.wood && out.cost.wheat === out.want.wheat;
  return {
    pass,
    evidence:
      `beside my own settlement #${out.mine} -> corner #${out.adj} rejected=${out.aAdj === false}\n` +
      `no connected road (#${out.orphan}, distanceOk=${out.orphanReason && out.orphanReason.distanceOk}, ` +
      `roadTouching=${out.orphanReason && out.orphanReason.roadTouching}) -> rejected=${out.aOrphan === false}\n` +
      `legal corner #${out.good} accepted=${out.aGood}, charged ${JSON.stringify(out.cost)}\n` +
      `its neighbour #${out.nb2} now rejected=${out.aAfter === false}`
  };
});

/* ---- 9. cities ---------------------------------------------------------- */

await test(9, 'Cities upgrade only the owner\'s own settlements', async () => {
  await ensurePlay();
  const out = await pev(`(()=>{
    const R=window.__R__;
    const st=window.__ISLAND__.state; const p=st.players[0];
    __grant(0,{wheat:20,ore:30});
    const rival=[...st.buildings.entries()].find(([,b])=>b.owner!==0 && b.type==='settlement');
    const aRival = rival ? R.upgradeCity(st,0,rival[0],false) : null;
    const rivalStill = rival ? st.buildings.get(rival[0]).type : null;
    const empty = [...Array(54).keys()].find(i=>!st.buildings.has(i));
    const aEmpty = R.upgradeCity(st,0,empty,false);
    const mine=[...p.settlements][0];
    const c0={...p.res};
    const aMine = R.upgradeCity(st,0,mine,false);
    const cost={ wheat:c0.wheat-p.res.wheat, ore:c0.ore-p.res.ore };
    const aTwice = R.upgradeCity(st,0,mine,false);
    return { rival:rival?rival[0]:null, aRival, rivalStill, empty, aEmpty,
             mine, aMine, cost, aTwice,
             type: st.buildings.get(mine).type,
             cities:p.cities.size, settlementsHold:p.settlements.has(mine) };})()`);
  const pass = out.aRival === false && out.rivalStill === 'settlement'
    && out.aEmpty === false && out.aMine === true && out.type === 'city'
    && out.aTwice === false && out.settlementsHold === false
    && out.cost.wheat === 4 && out.cost.ore === 6;
  return {
    pass,
    evidence:
      `rival settlement #${out.rival} -> ${out.aRival} (still a ${out.rivalStill})\n` +
      `empty corner #${out.empty} -> ${out.aEmpty}\n` +
      `my settlement #${out.mine} -> ${out.aMine}, now a ${out.type}, charged ${JSON.stringify(out.cost)}\n` +
      `upgrading the same city again -> ${out.aTwice}; cities=${out.cities}`
  };
});

/* ---- 10. development cards ---------------------------------------------- */

await test(10, 'All three development cards work (Knight, Road Building, Victory Point)', async () => {
  await ensurePlay();
  const out = await pev(`(()=>{
    const R=window.__R__, L=window.__L__, E=window.__E__;
    const st=window.__ISLAND__.state, g=window.__ISLAND__.game; const p=st.players[0];
    __grant(0,{wool:60,wheat:60,ore:60});
    const seen={}; const draws=[];
    let vpBefore=p.vpCards, vpJump=null;
    for (let i=0;i<40;i++){
      const before=p.vpCards;
      const c = R.drawCard(st,0,false);
      if(!c) break;
      draws.push(c.type);
      seen[c.type]=(seen[c.type]||0)+1;
      if (c.type==='victoryPoint' && vpJump===null) vpJump = p.vpCards-before;
      if (seen.knight && seen.roadBuilding && seen.victoryPoint) break;
    }
    // --- knight ---
    const tile = L.tiles.find(t=>t.id!==st.robberTile && t.resource);
    const rivalBefore = st.players.slice(1).map(o=>window.__C__.totalRes(o.res));
    const kBefore=p.knightsPlayed;
    const kOk = E.playKnightAt(tile.id, g);
    const rivalAfter = st.players.slice(1).map(o=>window.__C__.totalRes(o.res));
    // --- road building: play it and remember the pre-state; economy chains the
    //     second free road through a 340ms timer, so the placements happen in
    //     separate turns of the harness below.
    window.__rb = { roads0:p.roads.size, res0:{...p.res}, placed:0 };
    window.__rb.ok = E.useRoadBuilding(g);
    window.__rb.freeAfterPlay = p.freeRoads||0;
    return { draws, seen, vpCards:p.vpCards, vpJump,
      knight:{ ok:kOk, tile:tile.id, robberTile:st.robberTile, robberOwner:st.robberOwner,
               played:{before:kBefore, after:p.knightsPlayed},
               rivalBefore, rivalAfter } };})()`);

  // Place both free roads through the real overview Confirm button. economy.js
  // re-opens the map on a 340ms timer between the two, so poll for it.
  for (let i = 0; i < 5; i++) {
    if (await pev('window.__rb.placed') >= 2) break;
    await sleep(330);
    await pev(`(()=>{
      const R=window.__R__; const st=window.__ISLAND__.state; const ov=window.__ISLAND__.game.overview;
      if(!(ov&&ov.isOpen)) return 0;
      const legal=R.legalRoads(st,0);
      if(!legal.length) return 0;
      ov.select(legal[0]);
      const btn=document.querySelector('.ov-bar .btn.green');
      if(btn&&!btn.disabled) btn.click(); else ov.commit();
      window.__rb.placed++;
      return 1;})()`);
  }
  const rbOut = await pev(`(()=>{
    const st=window.__ISLAND__.state; const p=st.players[0]; const rb=window.__rb;
    return { ok:rb.ok, freeAfterPlay:rb.freeAfterPlay, placedFree:rb.placed,
      roads:{before:rb.roads0, after:p.roads.size},
      paid:{ wood:rb.res0.wood-p.res.wood, brick:rb.res0.brick-p.res.brick },
      freeLeft:p.freeRoads||0 };})()`);
  out.roadBuilding = rbOut;
  const k = out.knight, rb = out.roadBuilding;
  const robbed = k.rivalAfter.some((v, i) => v < k.rivalBefore[i]);
  const kOk = k.ok && k.robberTile === k.tile && k.robberOwner === 0
    && k.played.after === k.played.before + 1 && robbed;
  const rbOk = rb.ok && rb.freeAfterPlay === 2 && rb.placedFree === 2
    && rb.roads.after === rb.roads.before + 2
    && rb.paid.wood === 0 && rb.paid.brick === 0;
  const vpOk = out.seen.victoryPoint > 0 && out.vpJump === 1;
  return {
    pass: kOk && rbOk && vpOk,
    evidence:
      `drew ${out.draws.length} cards: ${JSON.stringify(out.seen)}\n` +
      `KNIGHT  played=${k.ok} raider->tile ${k.robberTile} (owner ${k.robberOwner}), ` +
      `knightsPlayed ${k.played.before}->${k.played.after}, rival stock ${JSON.stringify(k.rivalBefore)}->${JSON.stringify(k.rivalAfter)}\n` +
      `ROADBLD played=${rb.ok} freeRoads=${rb.freeAfterPlay} placed=${rb.placedFree} ` +
      `roads ${rb.roads.before}->${rb.roads.after} paid=${JSON.stringify(rb.paid)}\n` +
      `VICTORY vpCards=${out.vpCards}, +${out.vpJump} on draw (instant)`
  };
});

/* ---- 11. the Raider ----------------------------------------------------- */

await test(11, 'The Raider blocks the region for everyone except the player who moved it', async () => {
  await ensurePlay();
  const out = await pev(`(()=>{
    const R=window.__R__, L=window.__L__, N=window.__N__;
    const st=window.__ISLAND__.state; const g=window.__ISLAND__.game;
    __refill();
    // pick a tile with resources and at least one live node
    const node = N.nodes.find(n=>n.remaining>0 && L.tiles[n.tile].resource);
    const tile = node.tile;
    // player 1 sends the Raider there
    st.players[1].cards.push({type:'knight',id:'test'});
    const moved = R.playKnight(st,1,tile);
    const flags = st.players.map(p=>R.canGatherTile(st,p.id,tile));
    __refill();
    // functional check: the mover harvests, the human is refused
    const res = node.resource;
    __place(1,node.x,node.z);
    st.players[1].gatherIntent = node.id;
    const m0 = st.players[1].res[res];
    __tick(8,{gather:true, stop:'st.players[1].res.'+res+'>'+m0});
    const moverGain = st.players[1].res[res]-m0;
    __place(0,node.x,node.z);
    st.players[0].gatherIntent = node.id;
    const h0 = st.players[0].res[res];
    const t2 = __tick(8,{gather:true, drain:true});
    const humanGain = st.players[0].res[res]-h0;
    const blockedEvents = (t2.events||[]).filter(e=>e.type==='blocked').length;
    // and a rival bot
    __place(2,node.x,node.z);
    st.players[2].gatherIntent = node.id;
    const r0 = st.players[2].res[res];
    __tick(8,{gather:true});
    const rivalGain = st.players[2].res[res]-r0;
    return { tile, moved, flags, res, moverGain, humanGain, rivalGain, blockedEvents,
             robberOwner:st.robberOwner };})()`);
  const pass = out.moved && out.flags[1] === true
    && out.flags[0] === false && out.flags[2] === false && out.flags[3] === false
    && out.moverGain > 0 && out.humanGain === 0 && out.rivalGain === 0;
  return {
    pass,
    evidence:
      `Raider moved by player 1 to tile ${out.tile} (robberOwner=${out.robberOwner})\n` +
      `canGatherTile per player: ${JSON.stringify(out.flags)}\n` +
      `8s of harvesting on that tile — mover +${out.moverGain} ${out.res}, ` +
      `human +${out.humanGain}, rival bot +${out.rivalGain}, blocked events=${out.blockedEvents}`
  };
});

/* ---- 12. bots ----------------------------------------------------------- */

await test(12, 'Bots gather, trade, build and score, with no resource gained outside a rules call', async () => {
  // Fresh match so the earlier rules pokes do not colour the audit.
  await pev(`window.__ISLAND__.game.flow.restartInPlace({seed:4242})`);
  await sleep(400);
  const d = await pev('__draft(45)');
  if (d.phase !== 'play') return { pass: false, evidence: `draft did not complete: ${JSON.stringify(d)}` };

  const out = await pev(`(()=>{
    const R=window.__R__, C=window.__C__;
    const st=window.__ISLAND__.state, g=window.__ISLAND__.game;
    const S=1/60;
    const tot = p => C.RES.reduce((s,k)=>s+(p.res[k]||0),0);
    const before = st.players.map(tot);
    let violations=[]; let steps=0;
    const acc = st.players.map(()=>0);
    const events={};
    // Audit every single step: the only legal ways a stock may rise are a
    // 'gained' event, a 'trade' event, or the setup grant (we are past setup).
    for (let i=0;i<60*45 && st.phase==='play';i++){
      const pre = st.players.map(tot);
      R.tickWorld(st,S);
      g.flow.update(S);
      g.gathering.update(S);
      g.bots.update(S);
      const evs = R.drainEvents(st);
      // The ONLY events that may raise a stock are 'gained' (a harvest cycle)
      // and 'trade' (one unit back from a post). Everything else can only
      // spend. Any rise beyond that credit is income from nowhere.
      const credit = st.players.map(()=>0);
      for (const e of evs){
        events[e.type]=(events[e.type]||0)+1;
        if (e.type==='gained') credit[e.player]+=e.amount;
        else if (e.type==='trade') credit[e.player]+=1;
      }
      const post = st.players.map(tot);
      for (let k=0;k<post.length;k++){
        const d = post[k]-pre[k];
        if (d > credit[k] + 1e-9) {
          violations.push({ step:i, player:k, delta:d, credited:credit[k],
                            evs:evs.map(e=>e.type) });
        }
      }
      steps=i;
    }
    return { steps, seconds:+(steps/60).toFixed(1), phase:st.phase,
      events, violations: violations.slice(0,5), violationCount:violations.length,
      before, after: st.players.map(tot),
      stats: st.players.map(p=>({ name:p.name, gathered:p.stats.gathered,
        traded:p.stats.traded, built:p.stats.built, cards:p.stats.cardsPlayed,
        vp:R.scoreOf(st,p), roads:p.roads.size, s:p.settlements.size, c:p.cities.size })) };})()`);

  const bots = out.stats.slice(1);
  const gathered = bots.every(b => b.gathered > 0);
  const built = bots.every(b => b.built > 0);
  const scored = bots.every(b => b.vp >= 2);
  const anyTrade = out.stats.some(b => b.traded > 0) || (out.events.trade || 0) > 0;
  return {
    pass: gathered && built && scored && out.violationCount === 0,
    evidence:
      `${out.seconds}s of simulated play (phase=${out.phase}); events ${JSON.stringify(out.events)}\n` +
      out.stats.map(s => `  ${s.name.padEnd(5)} gathered=${s.gathered} built=${s.built} ` +
        `trades=${s.traded} cards=${s.cards} roads=${s.roads} ${s.s}S/${s.c}C vp=${s.vp}`).join('\n') +
      `\nunexplained resource gains: ${out.violationCount}` +
      (out.violationCount ? ' ' + JSON.stringify(out.violations) : '') +
      `\ntrades observed in this window: ${anyTrade ? 'yes' : 'no (see simulate.mjs — ~0.1/bot/match)'}`
  };
});

/* ---- 13/14. awards ------------------------------------------------------ */

await test(13, 'Longest Road can change hands', async () => {
  await ensurePlay();
  const out = await pev(`(()=>{
    const R=window.__R__, L=window.__L__;
    const st=window.__ISLAND__.state;
    const log=[];
    /** Build road by road until this player holds Longest Road (or runs out of
     *  pieces). Every segment is a real rules.placeRoad. */
    function extend(pid, n){
      let added=0;
      for (let k=0;k<n && st.longestRoadHolder!==pid;k++){
        const legal=R.legalRoads(st,pid);
        if(!legal.length) break;
        // grow the longest chain: pick the edge that raises longestRoadFor most
        let best=null,bl=-1;
        for (const e of legal.slice(0,40)){
          st.roadOwner.set(e,pid); st.players[pid].roads.add(e);
          const l=R.longestRoadFor(st,pid);
          st.roadOwner.delete(e); st.players[pid].roads.delete(e);
          if(l>bl){bl=l;best=e;}
        }
        if(best===null) break;
        if(!R.placeRoad(st,pid,best,true)) break;
        added++;
      }
      return added;
    }
    const start = { holder:st.longestRoadHolder, lens:st.players.map(p=>p.longestRoadLen) };
    const laidMe = extend(0, 18);
    const afterMe = { holder:st.longestRoadHolder, len:st.players[0].longestRoadLen,
                      flags:st.players.map(p=>p.hasLongestRoad), vp:R.scoreOf(st,st.players[0]),
                      laid:laidMe };
    R.drainEvents(st);
    extend(1, 18);
    const evs = R.drainEvents(st).filter(e=>e.type==='award'&&e.kind==='longestRoad');
    const afterRival = { holder:st.longestRoadHolder, len:st.players[1].longestRoadLen,
                         flags:st.players.map(p=>p.hasLongestRoad),
                         myVp:R.scoreOf(st,st.players[0]), theirVp:R.scoreOf(st,st.players[1]) };
    return { start, afterMe, afterRival, awardEvents:evs.map(e=>({player:e.player,value:e.value})) };})()`);
  const pass = out.afterMe.holder === 0 && out.afterRival.holder === 1
    && out.afterRival.flags[0] === false && out.afterRival.flags[1] === true
    && out.awardEvents.some(e => e.player === 1);
  return {
    pass,
    evidence:
      `start holder=${out.start.holder} lengths=${JSON.stringify(out.start.lens)}\n` +
      `after I lay ${out.afterMe.laid} roads: holder=${out.afterMe.holder} len=${out.afterMe.len} ` +
      `flags=${JSON.stringify(out.afterMe.flags)} myVP=${out.afterMe.vp}\n` +
      `after rival out-builds me: holder=${out.afterRival.holder} len=${out.afterRival.len} ` +
      `flags=${JSON.stringify(out.afterRival.flags)} myVP=${out.afterRival.myVp} theirVP=${out.afterRival.theirVp}\n` +
      `award events: ${JSON.stringify(out.awardEvents)}`
  };
});

await test(14, 'Largest Army can change hands', async () => {
  await ensurePlay();
  const out = await pev(`(()=>{
    const R=window.__R__, L=window.__L__;
    const st=window.__ISLAND__.state;
    function knights(pid,n){
      let played=0;
      for(let i=0;i<n;i++){
        st.players[pid].cards.push({type:'knight',id:'t'+pid+i});
        const tile=L.tiles.find(t=>t.id!==st.robberTile && t.resource);
        if(R.playKnight(st,pid,tile.id)) played++;
      }
      return played;
    }
    const start=st.largestArmyHolder;
    R.drainEvents(st);
    knights(0,2);
    const mine={ holder:st.largestArmyHolder, flags:st.players.map(p=>p.hasLargestArmy),
                 counts:st.players.map(p=>p.knightsPlayed), vp:R.scoreOf(st,st.players[0]) };
    R.drainEvents(st);
    knights(2,3);
    const evs=R.drainEvents(st).filter(e=>e.type==='award'&&e.kind==='largestArmy');
    const rival={ holder:st.largestArmyHolder, flags:st.players.map(p=>p.hasLargestArmy),
                  counts:st.players.map(p=>p.knightsPlayed), myVp:R.scoreOf(st,st.players[0]) };
    return { start, mine, rival, awardEvents:evs.map(e=>({player:e.player,value:e.value})) };})()`);
  const pass = out.mine.holder === 0 && out.rival.holder === 2
    && out.rival.flags[0] === false && out.rival.flags[2] === true
    && out.awardEvents.some(e => e.player === 2);
  return {
    pass,
    evidence:
      `start holder=${out.start}\n` +
      `after I play 2 knights: holder=${out.mine.holder} counts=${JSON.stringify(out.mine.counts)} myVP=${out.mine.vp}\n` +
      `after Maya plays 3: holder=${out.rival.holder} counts=${JSON.stringify(out.rival.counts)} ` +
      `flags=${JSON.stringify(out.rival.flags)} myVP=${out.rival.myVp}\n` +
      `award events: ${JSON.stringify(out.awardEvents)}`
  };
});

/* ---- 15. victory + results ---------------------------------------------- */

await test(15, 'A player can win; the results screen appears with correct rankings', async () => {
  await pev(`window.__ISLAND__.game.flow.restartInPlace({seed:99})`);
  await sleep(400);
  const d = await pev('__draft(45)');
  if (d.phase !== 'play') return { pass: false, evidence: `draft failed: ${JSON.stringify(d)}` };

  // Drive a real victory: a rival earns points through rules.js until it wins.
  const drive = await pev(`(()=>{
    const R=window.__R__; const st=window.__ISLAND__.state; const p=st.players[1];
    // give the rival the board it would have earned, one legal rules call at a time
    let guard=0;
    while (R.scoreOf(st,p) < window.__C__.VICTORY_POINTS && guard++ < 40){
      const legal = R.legalSettlements(st,1);
      if (legal.length && p.settlements.size+p.cities.size < 7){
        R.placeSettlement(st,1,legal[0],true); continue;
      }
      const up = R.legalCities(st,1);
      if (up.length){ R.upgradeCity(st,1,up[0],true); continue;}
      const roads = R.legalRoads(st,1);
      if (roads.length){ R.placeRoad(st,1,roads[0],true); continue; }
      break;
    }
    return { vp:R.scoreOf(st,p), phase:st.phase, winner:st.winner,
             ranks:R.rankings(st).map(e=>({name:e.p.name,vp:e.vp})) };})()`);

  // Let the real frame loop drain the victory event into panels.showResults,
  // which matchflow intercepts.
  await sleep(250);
  const seq = await pev(`(()=>{
    const g=window.__ISLAND__.game, st=window.__ISLAND__.state;
    // run the flow's win sequence at production cadence
    const before = { phase:st.phase, isWin:g.flow.isWinSequence };
    __tick(6, { flow:true, bots:true, gather:true });
    return { before, after:{ phase:st.phase, isWin:g.flow.isWinSequence,
      stage:g.flow.stage, winner:g.flow.winner,
      overview: !!(g.camera && g.camera.isOverview) } };})()`);
  await sleep(550);  // let the results rows' entrance timers run

  const ui = await pev(`(()=>{
    const R=window.__R__; const st=window.__ISLAND__.state; const g=window.__ISLAND__.game;
    const sheet=document.querySelector('.results');
    const rows=[...document.querySelectorAll('.rs-row')].map(r=>({
      pos:(r.querySelector('.rs-pos')||{}).textContent,
      name:(r.querySelector('.rs-name')||{}).textContent,
      vp:(r.querySelector('.rs-vp b')||{}).textContent,
      cls:r.className }));
    const stats=[...document.querySelectorAll('.rs-stat')].map(s=>s.textContent.trim());
    const again=document.querySelector('.rs-foot .btn');
    const cs = sheet ? getComputedStyle(sheet) : null;
    // is the match really frozen?
    const before={ b:st.buildings.size, r:st.roadOwner.size,
                   res:st.players.map(p=>window.__C__.totalRes(p.res)),
                   t:st.time };
    __tick(4,{flow:true,bots:true,gather:true,controller:true});
    const after={ b:st.buildings.size, r:st.roadOwner.size,
                  res:st.players.map(p=>window.__C__.totalRes(p.res)),
                  t:st.time };
    return { present:!!sheet, hidden: sheet? sheet.className.indexOf('hid')>=0 : true,
      visible: cs ? (cs.display!=='none' && cs.opacity!=='0') : false,
      title:(document.querySelector('.rs-title')||{}).textContent,
      sub:(document.querySelector('.rs-sub')||{}).textContent,
      rows, stats, again: again? again.textContent.trim():null,
      truth: R.rankings(st).map(e=>({name:e.p.name, vp:e.vp})),
      frozen: JSON.stringify(before)===JSON.stringify(after), before, after };})()`);

  const rankMatch = ui.rows.length === 4
    && ui.rows.every((r, i) => r.name === ui.truth[i].name && +r.vp === ui.truth[i].vp);
  const pass = drive.phase === 'over' && drive.winner === 1
    && seq.after.isWin === true && seq.after.overview === true
    && ui.present && !ui.hidden && rankMatch && ui.frozen && /Play Again/i.test(ui.again || '');
  if (SHOTS) await shot(`tm-results-${W}x${H}`);
  return {
    pass,
    evidence:
      `victory: phase=${drive.phase} winner=${drive.winner} winnerVP=${drive.vp}\n` +
      `flow: isWinSequence=${seq.after.isWin} stage=${seq.after.stage} cameraOverview=${seq.after.overview}\n` +
      `results panel present=${ui.present} hidden=${ui.hidden} title="${ui.title}" sub="${ui.sub}"\n` +
      `rankings shown: ${ui.rows.map(r => `${r.pos}.${r.name}=${r.vp}`).join('  ')}\n` +
      `rankings truth: ${ui.truth.map((t, i) => `${i + 1}.${t.name}=${t.vp}`).join('  ')}  match=${rankMatch}\n` +
      `frozen after 4s more of bots+gathering: ${ui.frozen} (${JSON.stringify(ui.before)} -> ${JSON.stringify(ui.after)})\n` +
      `stats rows: ${ui.stats.length} · button "${ui.again}"`
  };
});

/* ---- 16. replay --------------------------------------------------------- */

await test(16, 'Replay/restart works and starts a clean match', async () => {
  const brainSnap = `(()=>{const b=(window.__ISLAND__.game.bots&&window.__ISLAND__.game.bots.brains)||[];
    return b.map(x=>({ pid:x.pid, goal:x.goal?x.goal.kind:null, lastKnight:+(x.lastKnight||0).toFixed(0),
      sinceAct:+(x.sinceAct||0).toFixed(1), avoidN:x.avoidNodes.size, avoidG:x.avoidGoals.size }));})()`;
  const brainsBefore = await pev(brainSnap);
  const clicked = await pev(`__click('.rs-foot .btn')`);
  await sleep(700);
  const after = await pev(`(()=>{
    const st=window.__ISLAND__.state, g=window.__ISLAND__.game, C=window.__C__;
    const brains = (g.bots&&g.bots.brains)||[];
    return { phase:st.phase, time:+st.time.toFixed(2), winner:st.winner,
      buildings:st.buildings.size, roads:st.roadOwner.size,
      res:st.players.map(p=>({...p.res})), start:C.START_RESOURCES,
      cards:st.players.map(p=>p.cards.length),
      vpCards:st.players.map(p=>p.vpCards), knights:st.players.map(p=>p.knightsPlayed),
      awards:{ road:st.longestRoadHolder, army:st.largestArmyHolder },
      resultsHidden: (document.querySelector('.results')||{className:'hid'}).className.indexOf('hid')>=0,
      stage:g.flow.stage, isWin:g.flow.isWinSequence,
      brains: brains.map(b=>({ pid:b.pid, goal:b.goal?b.goal.kind:null,
        lastKnight:b.lastKnight, sinceAct:+(b.sinceAct||0).toFixed(1),
        avoidN:b.avoidNodes.size, avoidG:b.avoidGoals.size })) };})()`);

  const d2 = await pev('__draft(45)');
  const play = await pev(`(()=>{
    const R=window.__R__; const st=window.__ISLAND__.state, g=window.__ISLAND__.game;
    const b0=st.buildings.size;
    __tick(45,{flow:true,bots:true,gather:true});
    return { phase:st.phase, time:+st.time.toFixed(1), grew:st.buildings.size-b0,
      gathered:st.players.map(p=>p.stats.gathered),
      vp:st.players.map(p=>R.scoreOf(st,p)) };})()`);

  // Prove the wipe is load-bearing: dirty the brains with real play, restart
  // again, and check they come back clean.
  const dirty = await pev(brainSnap);
  await pev(`window.__ISLAND__.game.flow.restartInPlace({seed:1234})`);
  await sleep(300);
  const reclean = await pev(brainSnap);

  const cleanRes = after.res.every(r =>
    Object.keys(after.start).every(k => r[k] === after.start[k]));
  const isStale = b => b.goal !== null || b.lastKnight > 0 || b.sinceAct > 1
    || b.avoidN > 0 || b.avoidG > 0;
  const staleBrains = after.brains.filter(isStale);
  const stillStale = reclean.filter(isStale);
  const wasDirty = dirty.some(isStale);
  const pass = after.phase === 'setup' && after.buildings === 0 && after.roads === 0
    && after.winner === -1 && cleanRes && after.resultsHidden
    && after.awards.road === -1 && after.awards.army === -1
    && after.vpCards.every(v => v === 0) && after.knights.every(k => k === 0)
    && d2.phase === 'play' && d2.buildings === 8 && d2.roads === 8
    && play.gathered.slice(1).every(g => g > 0)
    && staleBrains.length === 0 && stillStale.length === 0 && wasDirty;
  return {
    pass,
    evidence:
      `Play Again -> ${clicked}; phase=${after.phase} time=${after.time} winner=${after.winner} ` +
      `buildings=${after.buildings} roads=${after.roads} resultsHidden=${after.resultsHidden}\n` +
      `resources back to START=${cleanRes}; vpCards=${JSON.stringify(after.vpCards)} ` +
      `knights=${JSON.stringify(after.knights)} awards=${JSON.stringify(after.awards)}\n` +
      `second draft: phase=${d2.phase} settlements=${d2.buildings} roads=${d2.roads}\n` +
      `45s of replayed play: buildings +${play.grew}, gathered=${JSON.stringify(play.gathered)}, vp=${JSON.stringify(play.vp)}\n` +
      `bot brains before Play Again: ${JSON.stringify(brainsBefore)}\n` +
      `bot brains after Play Again:  ${JSON.stringify(after.brains)}${staleBrains.length ? '  <-- STALE' : '  (clean)'}\n` +
      `bot brains after 45s of play: ${JSON.stringify(dirty)}${wasDirty ? '  (dirty, as expected)' : '  <-- never got dirty; the reset check is vacuous'}\n` +
      `bot brains after 2nd restart: ${JSON.stringify(reclean)}${stillStale.length ? '  <-- STALE' : '  (clean)'}`
  };
});

/* ---- 18/19. layout + performance ---------------------------------------- */

let perfSample = null;
await test(19, 'Performance: draw calls and triangles inside budget', async () => {
  await ensurePlay();
  const p = await pev(`(()=>{ const st=window.__ISLAND__.state;
    __tick(30,{flow:true,bots:true,gather:true}); return 1;})()`);
  await sleep(550);   // several real frames with everything on screen
  perfSample = await pev('(()=>({ perf:__perf(), snap:__snap(), breakdown:__triBreakdown() }))()');
  const { perf, snap, breakdown } = perfSample;
  const BUDGET_CALLS = 90, BUDGET_TRIS = 130000;
  const overCalls = perf.calls - BUDGET_CALLS;
  const overTris = perf.triangles - BUDGET_TRIS;
  return {
    pass: overCalls <= 0 && overTris <= 0,
    evidence:
      `draw calls ${perf.calls} / budget ${BUDGET_CALLS}  -> ${overCalls > 0 ? `OVER by ${overCalls} (+${(overCalls / BUDGET_CALLS * 100).toFixed(0)}%)` : `${-overCalls} under`}\n` +
      `triangles  ${perf.triangles} / budget ${BUDGET_TRIS} -> ${overTris > 0 ? `OVER by ${overTris} (+${(overTris / BUDGET_TRIS * 100).toFixed(0)}%)` : `${-overTris} under`}\n` +
      `programs=${perf.programs} textures=${perf.textures} geometries=${perf.geometries} ` +
      `lines=${perf.lines} points=${perf.points}\n` +
      `scene state: ${snap.buildings} buildings, ${snap.roads} roads, t=${snap.time}s, vp=${JSON.stringify(snap.vp)}\n` +
      `where the geometry lives (visible, incl. shadow-only passes):\n` +
      breakdown.map(b => `   ${String(b.tris).padStart(7)} tris  ${String(b.draws).padStart(3)} objs  ${b.name}`).join('\n')
  };
});

await test(18, 'Interface is usable at 667x375 and 960x444', async () => {
  await ensurePlay();
  const sizes = [[960, 444], [667, 375]];
  const notes = [];
  let ok = true;
  // Put the game back into plain third-person play before measuring or
  // capturing: no modal open, camera off the board framing.
  await pev(`(()=>{const g=window.__ISLAND__.game;
    try{ g.closeOverview(); }catch(e){}
    try{ g.panels.close(); }catch(e){}
    try{ if (g.camera && g.camera.setOverview) g.camera.setOverview(false); }catch(e){}
    return 1;})()`);
  await sleep(800);
  for (const [w, h] of sizes) {
    // Always override, even for the launch size: the headless window's content
    // box is a few pixels taller than `--window-size`, and we want the layout
    // measured against exactly the viewport we claim to support.
    await send('Emulation.setDeviceMetricsOverride', {
      width: w, height: h, deviceScaleFactor: 1, mobile: true
    });
    await ev(`dispatchEvent(new Event('resize'))`);
    await sleep(500);
    // The checklist item is about the in-play interface, so make sure no modal
    // is mid-transition over it — an opening sheet is scaled and would read as
    // "off screen" while it is animating in.
    await pev(`(()=>{const g=window.__ISLAND__.game;
      try{ g.closeOverview(); }catch(e){}
      try{ g.panels.close(); }catch(e){}
      return 1;})()`);
    // The HUD slides its bottom clusters in with a CSS transition; measuring
    // mid-flight reports them below the fold. Poll until the layout stops
    // moving rather than guessing at a sleep.
    let stable = '', settled = false;
    for (let k = 0; k < 16; k++) {
      const now = await pev(`(()=>[...document.querySelectorAll('.hud-bc,.hud-bl,.hud-br,.hud-tc')]
        .map(n=>{const b=n.getBoundingClientRect();
          return [Math.round(b.top),Math.round(b.bottom),Math.round(b.left)].join(',');}).join('|'))()`);
      if (now && now === stable) { settled = true; break; }
      stable = now;
      await sleep(110);
    }
    const geo = await pev(`(()=>{
      const r=el=>{const n=document.querySelector(el); if(!n) return null;
        const b=n.getBoundingClientRect();
        return {x:Math.round(b.left),y:Math.round(b.top),w:Math.round(b.width),h:Math.round(b.height)};};
      // checkVisibility walks ancestors, so a closed modal (the .ov wrapper is
      // opacity:0, not display:none) is correctly treated as not on screen.
      const shown = n => n.checkVisibility
        ? n.checkVisibility({ opacityProperty:true, visibilityProperty:true, contentVisibilityAuto:true })
        : !!n.offsetParent;
      const off=[];
      for (const n of document.querySelectorAll('#ui *')){
        const b=n.getBoundingClientRect();
        if (b.width<2||b.height<2) continue;
        if (!shown(n)) continue;
        if (b.right>innerWidth+2||b.bottom>innerHeight+2||b.left<-2||b.top<-2)
          off.push({cls:String(n.className).slice(0,40),
            r:[Math.round(b.left),Math.round(b.top),Math.round(b.right),Math.round(b.bottom)]});
      }
      const small=[];
      for (const n of document.querySelectorAll('#ui [data-ui], #ui button')){
        const b=n.getBoundingClientRect();
        if (b.width<1 || !shown(n)) continue;
        if (b.width<36||b.height<36) small.push({cls:String(n.className).slice(0,34),
          w:Math.round(b.width),h:Math.round(b.height)});
      }
      return { vw:innerWidth, vh:innerHeight,
        gate: (document.getElementById('rotate-gate')||{}).className,
        hud:r('.hud'), res:r('.resbar')||r('.res-strip')||r('.inv-strip'),
        build:r('.buildbar')||r('.builds'), ranks:r('.ranks')||r('.ranklist'),
        offscreen: off.slice(0,8), offscreenCount: off.length,
        tiny: small.slice(0,8), tinyCount: small.length };})()`);
    const path = await shot(`tm-play-${w}x${h}`);
    const bad = geo.offscreenCount > 0;
    if (bad) ok = false;
    notes.push(`${w}x${h}: viewport ${geo.vw}x${geo.vh}, layoutSettled=${settled}, rotate-gate="${geo.gate}", ` +
      `offscreen elements=${geo.offscreenCount}${geo.offscreenCount ? ' ' + JSON.stringify(geo.offscreen) : ''}, ` +
      `sub-36px tap targets=${geo.tinyCount}${geo.tinyCount ? ' ' + JSON.stringify(geo.tiny) : ''}\n` +
      `        shot: ${path}`);
  }
  await send('Emulation.clearDeviceMetricsOverride');
  return { pass: ok, evidence: notes.join('\n') + '\n(PNGs must still be eyeballed — see progress/shots/)' };
});

/* ---- 17. pacing (delegated) --------------------------------------------- */

if (wanted(17)) {
  record(17, 'Typical matches last 3-5 minutes',
    null, 'delegated: tools/simulate.mjs --matches=60 --gathersys is the pacing rig');
}

/* ================================================================== report */

const exc = exceptions.length;
const warns = consoleLines.filter(l => l.level === 'error' || l.level === 'warning');

console.log('\n' + '='.repeat(58));
const done = results.filter(r => r.pass !== null);
const passed = done.filter(r => r.pass).length;
console.log(`${passed}/${done.length} checks passed in ${((Date.now()-T0)/1000).toFixed(1)}s`);
for (const r of results.filter(x => x.pass === false)) console.log(`  FAIL ${r.id}. ${r.name}`);
console.log(`\nruntime console: ${exc} exception(s), ${warns.length} error/warning(s)`);
for (const e of exceptions.slice(0, 10)) console.log('  EXC ' + String(e.text).split('\n')[0].slice(0, 200));
const buckets = new Map();
for (const l of warns) {
  const k = l.text.replace(/\d+/g, '#').slice(0, 110);
  buckets.set(k, (buckets.get(k) || 0) + 1);
}
for (const [k, n] of [...buckets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`  x${String(n).padStart(3)}  ${k}`);
}

writeFileSync(resolve(OUT, 'testmatch.json'), JSON.stringify({
  at: new Date().toISOString(), w: W, h: H,
  results, perf: perfSample, exceptions, warnings: warns
}, null, 2));

ws.close();
chrome.stderr.removeAllListeners(); chrome.stderr.destroy();
chrome.kill('SIGKILL'); chrome.unref();
// exitCode rather than exit(): process.exit() truncates a piped stdout.
const code = results.some(r => r.pass === false) ? 1 : 0;
// Flush stdout before exiting: chrome's pipes otherwise keep the loop alive.
process.stdout.write('', () => process.exit(code));
