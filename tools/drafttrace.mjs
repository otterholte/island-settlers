/**
 * Island Settlers — draft view-stability trace.
 *
 *   node tools/drafttrace.mjs [--w=960] [--h=444] [--runs=3] [--port=5173]
 *
 * The player's complaint about the opening draft was "the screen keeps quickly
 * switching between the map view and the other view". That is not a thing you
 * can prove by looking at a screenshot, so this drives the real game at the
 * production fixed step and samples the two values that decide which view is
 * on screen — `camera.isOverview` (the 3D framing) and `overview.isOpen` (the
 * board panel) — on EVERY frame of a whole draft.
 *
 * It then asserts the pair is constant from the first draft frame to the last,
 * flips exactly once at the handoff, and reports every frame where either
 * value changed. A run also records where the human landed in the shuffled
 * snake order, so a "player first" and a "player last" draft can both be seen.
 *
 * Owner: Flow agent.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
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
const RUNS = +arg('runs', 3);
// Seeds 10 / 5 / 1 / 7 put the human 1st / 2nd / 3rd / 4th in the shuffled
// order, so a single run covers "player first" and "player last" on purpose
// rather than by luck.
const SEEDS = String(arg('seeds', '10,5,1,7')).split(',').map(Number).filter(Number.isFinite);
const SHOTS = arg('shots', '') === '1';
const OUT = resolve(ROOT, arg('out', 'progress/shots'));
if (SHOTS) mkdirSync(OUT, { recursive: true });
const CHROME = arg('chrome', '/tmp/chrome-headless-shell-linux64/chrome-headless-shell');
const LIBS = arg('libs', '/tmp/xlibs/root/usr/lib/x86_64-linux-gnu');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const DP = 9800 + Math.floor(Math.random() * 400);

const chrome = spawn(CHROME, [
  '--headless', '--no-sandbox', '--disable-dev-shm-usage',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--hide-scrollbars', '--mute-audio',
  `--window-size=${W},${H}`, `--remote-debugging-port=${DP}`, 'about:blank'
], {
  env: { ...process.env, LD_LIBRARY_PATH: `${LIBS}:${process.env.LD_LIBRARY_PATH || ''}` },
  stdio: ['ignore', 'ignore', 'ignore']
});

let wsUrl;
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${DP}/json/list`);
    const p = (await r.json()).find(t => t.type === 'page');
    if (p) { wsUrl = p.webSocketDebuggerUrl; break; }
  } catch { /* not up yet */ }
  await sleep(200);
}
if (!wsUrl) { console.error('devtools never came up'); process.exit(2); }

const ws = new WebSocket(wsUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));

let msgId = 0;
const pending = new Map();
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.id !== undefined) {
    const p = pending.get(m.id);
    if (p) { pending.delete(m.id); p(m.result || {}); }
  }
});
const send = (method, params = {}) => new Promise(res => {
  const id = ++msgId;
  pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); res({}); } }, 40000);
});
const ev = async expr => {
  const r = await send('Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise: false
  });
  if (r?.exceptionDetails) {
    return { __err: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
  }
  return r?.result?.value;
};

await send('Page.enable'); await send('Runtime.enable');
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });

let booted = false;
for (let i = 0; i < 150; i++) {
  if (await ev('!!(window.__ISLAND__&&window.__ISLAND__.state)') === true) { booted = true; break; }
  await sleep(60);
}
console.log('  booted at ' + process.uptime().toFixed(1) + 's');
if (!booted) { console.error('GAME DID NOT BOOT'); ws.close(); chrome.kill('SIGKILL'); process.exit(1); }

/**
 * One traced draft, entirely inside the page.
 *
 * The loop is main.js's own fixed step for the systems that can move the view
 * (`flow.update`), and the human's two picks are answered through the real
 * overview select + Confirm button — the same path a finger takes.
 */
const TRACE = seed => `(()=>{
  const g = window.__ISLAND__.game, st = window.__ISLAND__.state;
  const S = 1/60;
  g.flow.restartInPlace({ seed: ${seed} });
  const frames = [];
  const picks = [];
  let humanPicks = 0;
  const sample = () => ({
    cam: !!(g.camera && g.camera.isOverview),
    ov: !!(g.overview && g.overview.isOpen),
    blend: +((g.camera && g.camera.overviewBlend) || 0).toFixed(3),
    stage: g.flow.stage,
    mode: g.overview ? g.overview.mode : '-',
    phase: st.phase,
    idx: st.setupIndex,
    need: st.setupNeed
  });
  let n = 0;
  for (; n < 60*70; n++) {
    g.flow.update(S);
    frames.push(sample());
    const ov = g.overview;
    if (ov && ov.isOpen && String(ov.mode).indexOf('place-') === 0) {
      const road = st.setupNeed === 'road';
      const list = road ? window.__R__.legalRoads(st,0,true,st.setupAnchor)
                        : window.__R__.legalSettlements(st,0,true);
      if (list.length) {
        ov.select(list[Math.floor(list.length*0.4)]);
        const btn = document.querySelector('.ov-bar .btn.green');
        if (btn && !btn.disabled) btn.click(); else ov.commit();
        humanPicks++;
      }
    }
    if (g.flow.stage === 'play') break;
  }
  // Where the draft actually lived: first and last frame with stage==='draft'.
  let a = -1, b = -1;
  for (let i=0;i<frames.length;i++){
    if (frames[i].stage === 'draft') { if (a<0) a=i; b=i; }
  }
  // Every frame on which either view value changed, across the whole run.
  const flips = [];
  for (let i=1;i<frames.length;i++){
    const p = frames[i-1], c = frames[i];
    if (p.cam !== c.cam || p.ov !== c.ov) {
      flips.push({ frame:i, t:+(i*S).toFixed(2), stage:c.stage,
        from:(p.cam?'CAM':'cam')+'/'+(p.ov?'OV':'ov'),
        to:(c.cam?'CAM':'cam')+'/'+(c.ov?'OV':'ov') });
    }
  }
  // Inside the draft window specifically.
  const inside = flips.filter(f => f.frame > a && f.frame <= b);
  const modes = [];
  for (let i=Math.max(a,1);i<=b;i++){
    if (frames[i].mode !== frames[i-1].mode) modes.push({ t:+(i*S).toFixed(2), mode:frames[i].mode });
  }
  const order = (st.setupOrder||[]).slice();
  return {
    seed:${seed}, frames:frames.length, seconds:+(frames.length*S).toFixed(2),
    draftFrom:a, draftTo:b, draftSeconds:+(((b-a)+1)*S).toFixed(2),
    order, mySlots: order.map((p,i)=>p===0?i:-1).filter(i=>i>=0),
    humanPicks, phase: st.phase, buildings: st.buildings.size, roads: st.roadOwner.size,
    camDuringDraft: [...new Set(frames.slice(a,b+1).map(f=>f.cam))],
    ovDuringDraft: [...new Set(frames.slice(a,b+1).map(f=>f.ov))],
    flipsInsideDraft: inside,
    allFlips: flips,
    modeChanges: modes,
    tail: frames.slice(b, Math.min(frames.length, b+40)).filter((f,i)=>i%6===0)
  };
})()`;

await ev(`window.__R__ = null`);
await send('Runtime.evaluate', {
  expression: `import('/src/core/rules.js').then(m=>{window.__R__=m}).then(()=>1)`,
  awaitPromise: true, returnByValue: true
});

// Let the first (unwatched) boot draft settle before we start restarting it.
for (let i = 0; i < 40; i++) {
  const ok = await ev('!!(window.__R__ && window.__ISLAND__.game.flow)');
  if (ok === true) break;
  await sleep(150);
}
await sleep(150);

/* ------------------------------------------------------------------ shots */

const shot = async name => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  if (!r?.data) { console.log(`  shot ${name} FAILED`); return null; }
  const buf = Buffer.from(r.data, 'base64');
  const path = resolve(OUT, `${name}.png`);
  writeFileSync(path, buf);
  console.log(`  shot ${name}.png @${process.uptime().toFixed(1)}s (${(buf.length / 1024).toFixed(0)} KB)`);
  return path;
};

/** Step the production flow until a page-side predicate goes true. */
const stepUntil = (cond, max = 6000) => ev(`(()=>{
  const g = window.__ISLAND__.game, st = window.__ISLAND__.state, S = 1/60;
  const T = () => (document.querySelector('.ov-title')||{}).textContent||'';
  const H = () => (document.querySelector('.ov-hint')||{}).textContent||'';
  const ok = () => (${cond});
  let n = 0;
  while (n < ${max} && !ok()) { g.flow.update(S); n++; }
  return { n, hit: ok(), stage: g.flow.stage, mode: g.overview.mode,
    title: T(), hint: H(), idx: st.setupIndex, need: st.setupNeed };
})()`);

const SET = String(arg('set', 'watch,yours,first,docks')).split(',');
const wantShot = k => SET.indexOf(k) >= 0;

if (SHOTS) {
  const tag = `${W}x${H}`;

  // 1 + 2: the player drafts LAST (seed 7) — the stretch that used to be dead
  // air. Catch a rival mid-telegraph, then the player's own armed turn.
  if (wantShot('watch') || wantShot('yours')) {
    await ev(`window.__ISLAND__.game.flow.restartInPlace({ seed: 7 })`);
    await sleep(550);
  }
  if (wantShot('watch')) {
    console.log('  WATCH ' + JSON.stringify(await stepUntil(`/Eyeing/.test(H())`)));
    await sleep(450);
    await shot(`draft-watch-${tag}`);
  }
  if (wantShot('yours')) {
    console.log('  YOURS ' + JSON.stringify(await stepUntil(`g.overview.mode==='place-settlement'`)));
    await ev(`(()=>{const g=window.__ISLAND__.game, st=window.__ISLAND__.state;
      const L=window.__R__.legalSettlements(st,0,true);
      g.overview.select(L[Math.floor(L.length*0.42)]);
      for(let i=0;i<30;i++) g.overview.update(1/60);
      return g.overview.mode;})()`);
    await sleep(450);
    await shot(`draft-yourpick-${tag}`);
  }

  // 3: the player drafts FIRST (seed 10) — same view, first beat.
  if (wantShot('first')) {
    await ev(`window.__ISLAND__.game.flow.restartInPlace({ seed: 10 })`);
    await sleep(550);
    console.log('  FIRST ' + JSON.stringify(await stepUntil(`g.overview.mode==='place-settlement'`)));
    await sleep(450);
    await shot(`draft-first-${tag}`);
  }

  // 4: the docks. Finish the draft through rules, unlock a few ports for the
  // player, and photograph the plain board map.
  if (wantShot('docks')) {
  await ev(`(()=>{const {state}=window.__ISLAND__, R=window.__R__;
    let g=0;
    while(state.phase==='setup' && g++<40){
      const pid=R.setupCurrentPlayer(state);
      if(state.setupNeed==='settlement'){
        const L=R.legalSettlements(state,pid,true);
        R.setupPlaceSettlement(state,pid,L[Math.floor(L.length*0.37)]||L[0]);
      } else {
        const L=R.legalRoads(state,pid,true,state.setupAnchor);
        R.setupPlaceRoad(state,pid,L[0]);
      }
    }
    const me=state.players[0];
    me.ports.add(0); me.ports.add(4); me.ports.add(6);
    return { phase:state.phase, ports:[...me.ports] };})()`);
  // Let the flow finish handing off to play before opening the map, or its
  // own "the draft ended without me" path closes it again on the next frame.
  await sleep(500);
  console.log('  DOCKS ' + JSON.stringify(await ev(`(()=>{const g=window.__ISLAND__.game;
    g.overview.open('view',{});
    for(let i=0;i<30;i++) g.overview.update(1/60);
    return { open:g.overview.isOpen, mode:g.overview.mode, stage:g.flow.stage };})()`)));
  await sleep(250);
  await shot(`map-docks-${tag}`);
  }

  ws.close();
  chrome.kill('SIGKILL');
  process.exit(0);
}

let bad = 0;
const seen = [];
for (let r = 0; r < Math.min(RUNS, SEEDS.length); r++) {
  const out = await ev(TRACE(SEEDS[r]));
  if (!out || out.__err) { console.error('trace failed:', out && out.__err); bad++; continue; }
  seen.push(out);
  const stable = out.camDuringDraft.length === 1 && out.camDuringDraft[0] === true
    && out.ovDuringDraft.length === 1 && out.ovDuringDraft[0] === true
    && out.flipsInsideDraft.length === 0;
  const complete = out.phase === 'play' && out.buildings === 8 && out.roads === 8
    && out.humanPicks === 4;
  if (!stable || !complete) bad++;

  console.log(`\n--- run ${r + 1}  seed ${out.seed} ${W}x${H} ---`);
  console.log(`  order            ${JSON.stringify(out.order)}   (0 = you)`);
  const seat = out.mySlots[0];
  const half = out.order.length / 2;
  console.log(`  your slots       ${out.mySlots.map(i => i + 1).join(' & ')} of ${out.order.length}` +
    `   -> ${seat === 0 ? 'PLAYER FIRST' : (seat === half - 1 ? 'PLAYER LAST in round 1 (watches 3 bots first)' : `player ${seat + 1}${seat === 1 ? 'nd' : 'rd'} (watches ${seat} bot${seat > 1 ? 's' : ''} first)`)}`);
  console.log(`  draft window     frames ${out.draftFrom}..${out.draftTo}  (${out.draftSeconds}s)`);
  console.log(`  camera.isOverview during draft   ${JSON.stringify(out.camDuringDraft)}`);
  console.log(`  overview.isOpen  during draft    ${JSON.stringify(out.ovDuringDraft)}`);
  console.log(`  view flips INSIDE the draft      ${out.flipsInsideDraft.length}` +
    (out.flipsInsideDraft.length ? '  ' + JSON.stringify(out.flipsInsideDraft) : '   <- none, the view never switches'));
  console.log(`  view flips across the whole run  ${out.allFlips.length}  ` +
    JSON.stringify(out.allFlips));
  console.log(`  panel mode changes (same panel)  ${out.modeChanges.length}  ` +
    JSON.stringify(out.modeChanges.slice(0, 24)));
  console.log(`  finished         phase=${out.phase} settlements=${out.buildings} roads=${out.roads} humanPicksViaUI=${out.humanPicks}`);
  console.log(`  ${stable ? 'PASS' : 'FAIL'} view stability   ${complete ? 'PASS' : 'FAIL'} draft completion`);
}

const firsts = seen.filter(s => s.mySlots[0] === 0).length;
console.log(`\nruns where the player drafted first: ${firsts}/${seen.length}` +
  `  (orders seen: ${seen.map(s => s.order.slice(0, 4).join('')).join(', ')})`);
console.log(bad ? `\n${bad} run(s) FAILED` : '\nALL RUNS PASS — the draft holds one view');

ws.close();
chrome.kill('SIGKILL');
process.exit(bad ? 1 : 0);
