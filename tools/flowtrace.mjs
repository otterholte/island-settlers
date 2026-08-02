/**
 * Match-flow trace rig.
 *
 *   node tools/flowtrace.mjs --t=countdown|road|knight|flood [--shot=1] [--w] [--h]
 *
 * Data first, pixels second. Each trace drives the REAL game in headless Chrome
 * through the same entry points a thumb would hit — the overview's Confirm
 * button, panels' card taps, economy's card plays — and prints numbers that
 * either hold or do not. Screenshots cost ~12s each under SwiftShader, so they
 * are opt-in (`--shot=1`) and a data-only run finishes in ~15s, which fits in a
 * single short shell call.
 *
 *   countdown  every player's position sampled every fixed step from the last
 *              road of the draft to GO — nobody may move by so much as 1e-6
 *   road       Road Building: two roads land, nothing is paid; and with no
 *              legal edge anywhere the card is NOT spent and no panel opens
 *   knight     the Knight opens the FULL board in Raider mode and the Raider
 *              lands on the region that was chosen
 *   flood      floodProgress() sampled across the win sequence, with the
 *              celebration required to start only once it reads 1
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
const PORT = +arg('port', 5173);
const TRACE = arg('t', 'countdown');
const SHOT = arg('shot', '0') === '1';
const OUT = resolve(ROOT, arg('out', 'progress/shots'));
const CHROME = arg('chrome', '/tmp/chrome-headless-shell-linux64/chrome-headless-shell');
const LIBS = arg('libs', '/tmp/xlibs/root/usr/lib/x86_64-linux-gnu');

mkdirSync(OUT, { recursive: true });
if (!existsSync(CHROME)) { console.error(`no chrome at ${CHROME}`); process.exit(2); }

const sleep = ms => new Promise(r => setTimeout(r, ms));

const DP = 9833 + Math.floor(Math.random() * 400);
const chrome = spawn(CHROME, [
  '--headless', '--no-sandbox', '--disable-dev-shm-usage',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--disable-new-content-rendering-timeout', '--hide-scrollbars', '--mute-audio',
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
  await sleep(150);
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
    exceptions.push(m.params.exceptionDetails.exception?.description
      || m.params.exceptionDetails.text);
  }
});
const send = (method, params = {}, ms = 25000) => new Promise(res => {
  const id = ++msgId;
  pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); res({ __err: 'timeout' }); } }, ms);
});
const ev = async (expr, awaitPromise = false) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
  if (r?.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
  return r?.result?.value;
};
const T0 = Date.now();
const el = () => ((Date.now() - T0) / 1000).toFixed(1) + 's';
const shot = async name => {
  if (!SHOT) return;
  console.log(`  [${el()}] capturing ${name}...`);
  const r = await send('Page.captureScreenshot', { format: 'png' }, 60000);
  if (!r?.data) { console.log(`  shot ${name} FAILED`); return; }
  writeFileSync(resolve(OUT, `${name}.png`), Buffer.from(r.data, 'base64'));
  console.log(`  [${el()}] shot ${name}.png`);
};

await send('Page.enable'); await send('Runtime.enable');
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });

let booted = false;
for (let i = 0; i < 120; i++) {
  if (await ev('!!(window.__ISLAND__&&window.__ISLAND__.state)') === true) { booted = true; break; }
  await sleep(120);
}
if (!booted) { console.error('GAME DID NOT BOOT'); ws.close(); chrome.kill('SIGKILL'); process.exit(1); }

await ev(`Promise.all([
  import('/src/core/rules.js').then(m=>{window.__R__=m}),
  import('/src/board/layout.js').then(m=>{window.__L__=m}),
  import('/src/systems/economy.js').then(m=>{window.__E__=m})
]).then(()=>1)`, true);

/* Shared in-page helpers. */
await ev(`(()=>{
const S=1/60, I=()=>window.__ISLAND__;
/** Run the opening draft through the real flow, confirming the human's picks
 *  on the real Confirm button. Stops the instant phase leaves 'setup'. */
window.__draftUI = function(maxSec){
  const st=I().state, g=I().game, R=window.__R__;
  const n=Math.round((maxSec||45)*60); let picks=0,i=0;
  if(g.flow&&g.flow.skipIntro) g.flow.skipIntro();
  for(;i<n&&st.phase==='setup';i++){
    g.flow.update(S);
    const ov=g.overview;
    if(ov&&ov.isOpen&&String(ov.mode).indexOf('place-')===0){
      const road=st.setupNeed==='road';
      const list=road?R.legalRoads(st,0,true,st.setupAnchor):R.legalSettlements(st,0,true);
      if(!list.length) break;
      ov.select(list[Math.floor(list.length*0.4)]);
      const b=document.querySelector('.ov-bar .btn.green');
      if(b&&!b.disabled) b.click(); else ov.commit();
      picks++;
    }
  }
  return {phase:st.phase,picks,steps:i};
};
window.__pos = () => I().state.players.map(p=>[+p.x.toFixed(6),+p.z.toFixed(6)]);
window.__grant = (pid,bag)=>{const p=I().state.players[pid];for(const k in bag)p.res[k]=bag[k];return {...p.res};};
window.__confirm = ()=>{const b=document.querySelector('.ov-bar .btn.green');
  if(b&&!b.disabled){b.click();return 'button';}
  const ov=I().game.overview; return ov.commit()?'commit':'refused';};
return 1;})()`);

/* SwiftShader needs a real moment to present its first frames, and the boot
   splash sits over everything until it has. Every trace drives the match with
   synchronous evaluates, which never give the page that moment — so when we are
   here for pixels, hand it one. */
if (SHOT) {
  await ev(`(()=>{const b=document.getElementById('boot');if(b&&b.remove)b.remove();return 1})()`);
  await sleep(2200);
}

/** Hold the flow still for the duration of a capture. Under SwiftShader a
 *  screenshot costs ~12s of wall clock, and the page's own rAF loop would step
 *  right past the beat we came to photograph. */
const holdFlow = async on => ev(on
  ? `(()=>{const g=window.__ISLAND__.game;
      if(!g.__heldUpdate){g.__heldUpdate=g.flow.update;g.flow.update=()=>{};}return 1})()`
  : `(()=>{const g=window.__ISLAND__.game;
      if(g.__heldUpdate){g.flow.update=g.__heldUpdate;g.__heldUpdate=null;}return 1})()`);

const done = (code = 0) => { ws.close(); chrome.kill('SIGKILL'); process.exit(code); };

const say = (k, v) => console.log(`  ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
let pass = true;
const check = (label, ok, extra = '') => {
  if (!ok) pass = false;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
};

/* ======================================================== 1. the start line */

if (TRACE === 'countdown') {
  const d = await ev('__draftUI(45)');
  say('draft', d);

  // Sample every player's position on every fixed step of the countdown, the
  // way main.js runs it: tickWorld -> flow -> controller -> gathering -> bots.
  // Run in chunks so a screenshot can be taken mid-count without the sampling
  // losing its place.
  await ev(`(()=>{
    const S=1/60, I=()=>window.__ISLAND__, R=window.__R__;
    const st=I().state, g=I().game;
    const brains = g.bots.brains || [];
    const start=__pos(), labels=[]; let maxMove=0, steps=0, botRan=0, frozenSteps=0;
    const t0 = st.time;
    window.__cdStep = function(n){
    let ran=0;
    while (g.flow.counting && steps < 60*8 && ran++ < n){
      R.tickWorld(st,S);
      g.flow.update(S);
      // Read the gate AFTER the flow has stepped it: on the final step the
      // countdown ends here and the bots are legitimately live again.
      const frozen = g.flow.counting;
      const L = g.flow.countdown;
      if (frozen && (!labels.length||labels[labels.length-1][0]!==L)) {
        labels.push([L,+(steps/60).toFixed(2)]);
      }
      const think0 = brains.map(b=>b.think);
      g.controller.update(S);
      g.gathering.update(S);
      g.bots.update(S);
      // A bot's own replanning clock only moves inside bots.js's update body.
      // If it moved on a frozen step, bots.js ran and the freeze leaked.
      if (frozen){
        frozenSteps++;
        if (brains.some((b,i)=>b.think!==think0[i])) botRan++;
      }
      const p=__pos();
      for(let k=0;k<p.length;k++){
        const m=Math.hypot(p[k][0]-start[k][0],p[k][1]-start[k][1]);
        if(m>maxMove) maxMove=m;
      }
      steps++;
    }
    return { steps, frozenSteps, botRan, seconds:+(steps/60).toFixed(2),
      maxMove:+maxMove.toFixed(8), counting:g.flow.counting,
      labels, phase:st.phase, flowStage:g.flow.stage,
      clockHeld:+(st.time-t0).toFixed(4),
      start, end:__pos() };};
    return 1;})()`);

  // Hold on the "2" beat long enough for a capture, then run it out.
  const mid = await ev('__cdStep(50)');
  say('paused at', `${mid.seconds}s on "${mid.labels[mid.labels.length - 1][0]}"`);
  if (SHOT) {
    // Capture-only run: a SwiftShader screenshot costs most of a shell call, so
    // the assertions live in the data run and this one just brings back pixels.
    await holdFlow(true);
    await sleep(250);
    // A capture costs ~17s of wall clock and CSS animations run on that clock,
    // not on the flow's — so the 0.7s numeral pop would be long finished by the
    // time the pixels are read back. Pause the REAL animation 300ms in, which
    // is the frame a player actually looks at.
    await ev(`(()=>{let n=0;
      for(const e of document.querySelectorAll('.fc-num,.fc-ring,.fc-cap'))
        for(const a of (e.getAnimations?e.getAnimations():[])){a.currentTime=300;a.pause();n++;}
      return n;})()`);
    await shot('fl-countdown');
    done();
  }
  const out = await ev('__cdStep(600)');
  say('beats', out.labels);
  say('seconds frozen', out.seconds);
  say('largest movement by ANY player', out.maxMove);
  say('match clock advanced during countdown', out.clockHeld);
  say('frozen steps / steps where bots.js ran', `${out.frozenSteps} / ${out.botRan}`);

  // With --shot=1 the capture costs ~12s of real time and the page's own rAF
  // loop steps the flow while we wait, so the sampler can miss a beat it never
  // saw. Off, the whole ladder must be there.
  const seq = out.labels.map(l => l[0]);
  const want = ['3', '2', '1', 'GO'];
  let sub = 0;
  for (const s of seq) { const i = want.indexOf(s, sub); if (i < 0) { sub = -1; break; } sub = i + 1; }
  check(SHOT ? 'the countdown ladder runs down to GO' : 'the countdown runs 3 - 2 - 1 - GO',
    sub > 0 && seq[seq.length - 1] === 'GO' && (SHOT || seq.length === 4),
    JSON.stringify(out.labels));
  check('nobody moves — player OR bot — until GO', out.maxMove === 0,
    `max displacement ${out.maxMove} world units over ${out.steps} steps`);
  check('bots.js never ran a step during the countdown', out.botRan === 0,
    `${out.botRan} of ${out.frozenSteps} frozen steps reached bots.js`);
  check('the match clock does not start before GO', out.clockHeld === 0,
    `${out.clockHeld}s`);

  // And the moment it ends, everything is live again.
  const after = await ev(`(()=>{
    const S=1/60,I=()=>window.__ISLAND__,R=window.__R__;
    const st=I().state,g=I().game; const a=__pos();
    for(let i=0;i<60*3;i++){R.tickWorld(st,S);g.flow.update(S);g.controller.update(S);
      g.gathering.update(S);g.bots.update(S);}
    const b=__pos(); let moved=0;
    for(let k=1;k<a.length;k++) moved+=Math.hypot(b[k][0]-a[k][0],b[k][1]-a[k][1])>0.5?1:0;
    return {botsMoving:moved, stage:g.flow.stage, counting:g.flow.counting};})()`);
  say('after GO', after);
  check('bots move again the moment GO lands', after.botsMoving >= 2 && !after.counting,
    `${after.botsMoving}/3 bots moved in the 3s after GO`);
}

/* ==================================================== 2. Road Building card */

if (TRACE === 'road') {
  say('draft', await ev('__draftUI(45)'));
  await ev(`(()=>{const S=1/60,I=()=>window.__ISLAND__;
    for(let i=0;i<60*4;i++) I().game.flow.update(S); return I().game.flow.stage;})()`);

  // --- the happy path: play the card, place two roads, pay nothing ---------
  const pre = await ev(`(()=>{
    const I=()=>window.__ISLAND__, st=I().state, g=I().game, p=st.players[0];
    p.cards.push({type:'roadBuilding',id:'trace'});
    window.__rb={ roads0:p.roads.size, res0:{...p.res} };
    // The tap a thumb makes: open the cards sheet and hit the card itself.
    g.openCards();
    const card=[...document.querySelectorAll('.hand .dcard.c-roadBuilding')][0];
    window.__rb.cardOnScreen = !!card;
    window.__rb.cta = card ? card.querySelector('.dc-play').textContent : '';
    if(card) card.click();
    const ov=g.overview;
    return { cardOnScreen:window.__rb.cardOnScreen, cta:window.__rb.cta,
      free:p.freeRoads|0, ovOpen:ov.isOpen, ovMode:ov.mode,
      title:(document.querySelector('.ov-title')||{}).textContent,
      hint:(document.querySelector('.ov-hint')||{}).textContent,
      panelClosed: g.panels.kind===null };})()`);
  say('after tapping the card', pre);
  if (SHOT) { await sleep(250); await shot('fl-road-open'); done(); }

  const placed = [];
  for (let i = 0; i < 4; i++) {
    const st = await ev(`(()=>{const I=()=>window.__ISLAND__;const ov=I().game.overview;
      if(!(ov&&ov.isOpen&&ov.mode==='place-road')) return {open:false,free:I().state.players[0].freeRoads|0};
      const legal=window.__R__.legalRoads(I().state,0);
      ov.select(legal[0]);
      const how=__confirm();
      return {open:true,how,free:I().state.players[0].freeRoads|0,
        roads:I().state.players[0].roads.size};})()`);
    placed.push(st);
    if (!st.open) break;
    await sleep(420);
  }
  say('placements', placed);

  const post = await ev(`(()=>{const I=()=>window.__ISLAND__,p=I().state.players[0],rb=window.__rb;
    return { roads:{before:rb.roads0,after:p.roads.size},
      paid:{wood:rb.res0.wood-p.res.wood, brick:rb.res0.brick-p.res.brick},
      freeLeft:p.freeRoads|0, cards:p.cards.map(c=>c.type) };})()`);
  say('result', post);
  check('the card opens road placement immediately',
    pre.ovOpen === true && pre.ovMode === 'place-road' && pre.free === 2,
    `mode=${pre.ovMode} freeRoads=${pre.free} title="${pre.title}"`);
  check('two roads land back to back',
    post.roads.after === post.roads.before + 2 && post.freeLeft === 0,
    `${post.roads.before} -> ${post.roads.after}`);
  check('nothing is paid for either road',
    post.paid.wood === 0 && post.paid.brick === 0, JSON.stringify(post.paid));

  // --- the refusal: no legal edge anywhere on the board -------------------
  const no = await ev(`(()=>{
    const I=()=>window.__ISLAND__, st=I().state, g=I().game, L=window.__L__, E=window.__E__;
    const p=st.players[0];
    g.closeOverview();
    // Take every edge on the island: now no road is legal for anybody.
    const saved=new Map(st.roadOwner);
    for(const e of L.edges) if(!st.roadOwner.has(e.id)) st.roadOwner.set(e.id,1);
    p.cards.push({type:'roadBuilding',id:'trace2'});
    const cards0=p.cards.length, free0=p.freeRoads|0;
    const room=E.roadRoom(g);
    const ok=E.useRoadBuilding(g);
    const out={ room, played:ok, cardsBefore:cards0, cardsAfter:p.cards.length,
      freeBefore:free0, freeAfter:p.freeRoads|0, ovOpen:g.overview.isOpen,
      toast:[...document.querySelectorAll('.toast')].map(t=>t.textContent).slice(-2) };
    st.roadOwner.clear(); for(const [k,v] of saved) st.roadOwner.set(k,v);
    return out;})()`);
  say('with no legal edge anywhere', no);
  check('a card with nowhere to build is NOT spent',
    no.played === false && no.cardsAfter === no.cardsBefore && no.freeAfter === 0,
    `cards ${no.cardsBefore}->${no.cardsAfter}, freeRoads ${no.freeAfter}`);
  check('and no placement panel opens', no.ovOpen === false);
  check('and the player is told why', /nowhere to lay a road/i.test(no.toast.join(' ')),
    JSON.stringify(no.toast));
}

/* ============================================================== 3. Knight */

if (TRACE === 'knight') {
  say('draft', await ev('__draftUI(45)'));
  await ev(`(()=>{const S=1/60,I=()=>window.__ISLAND__;
    for(let i=0;i<60*4;i++) I().game.flow.update(S); return 1;})()`);

  const drew = await ev(`(()=>{
    const I=()=>window.__ISLAND__, st=I().state, g=I().game, p=st.players[0];
    p.cards.push({type:'knight',id:'trace'});
    for(let i=0;i<20;i++) g.hud.update(1/60);       // the cue polls the hand
    const cue=document.querySelector('.kn-cue');
    return { chip: !!cue && !cue.classList.contains('hid'), cls: cue?cue.className:'',
      chipText: cue ? cue.textContent.replace(/\\s+/g,' ').trim() : '',
      banner: (document.querySelector('.ann-txt')||{}).textContent };})()`);
  say('on drawing a Knight', drew);
  check('the draw is announced in the centre banner', /knight/i.test(drew.banner || ''),
    `"${drew.banner}"`);
  check('a standing call-to-action appears', drew.chip === true, `"${drew.chipText}"`);
  if (SHOT && arg('at', 'board') === 'cue') { await sleep(250); await shot('fl-knight-cue'); done(); }

  const open = await ev(`(()=>{
    const I=()=>window.__ISLAND__, g=I().game, L=window.__L__, st=I().state;
    g.knightCue.play();
    const ov=g.overview;
    // The chosen region: a productive hex the Raider is not already on.
    const want=L.tiles.filter(t=>t.id!==st.robberTile&&t.resource).slice(-1)[0].id;
    window.__want=want;
    const bar=document.querySelector('.ov-bar');
    return { open:ov.isOpen, mode:ov.mode,
      title:(document.querySelector('.ov-title')||{}).textContent,
      hint:(document.querySelector('.ov-hint')||{}).textContent,
      barVisible: !!bar && !bar.classList.contains('hid'),
      overviewCam: !!(g.camera && g.camera.isOverview),
      want, robberWas:st.robberTile };})()`);
  say('board opened', open);
  if (SHOT) { await sleep(250); await shot('fl-knight-board'); done(); }
  check('the FULL board opens in Raider mode',
    open.open === true && open.mode === 'place-robber' && open.overviewCam === true,
    `mode=${open.mode} overviewCamera=${open.overviewCam}`);
  check('the instruction is plain', /choose a region to block/i.test(open.hint || ''),
    `"${open.title}" / "${open.hint}"`);

  const landed = await ev(`(()=>{
    const I=()=>window.__ISLAND__, st=I().state, g=I().game;
    const p=st.players[0]; const k0=p.knightsPlayed;
    const rivals0=st.players.slice(1).map(o=>Object.values(o.res).reduce((a,b)=>a+b,0));
    g.overview.select(window.__want);
    const sel=(document.querySelector('.ov-sel')||{}).textContent;
    const how=__confirm();
    return { how, sel, robber:st.robberTile, want:window.__want,
      owner:st.robberOwner, knights:{before:k0,after:p.knightsPlayed},
      cards:p.cards.map(c=>c.type),
      rivalsBefore:rivals0,
      rivalsAfter:st.players.slice(1).map(o=>Object.values(o.res).reduce((a,b)=>a+b,0)),
      stillUp:g.overview.isOpen, mode:g.overview.mode,
      title:(document.querySelector('.ov-title')||{}).textContent };})()`);
  say('after Confirm', landed);
  check('the Raider lands on the region that was chosen',
    landed.robber === landed.want && landed.owner === 0
    && landed.knights.after === landed.knights.before + 1,
    `chose ${landed.want}, Raider is on ${landed.robber}`);
  check('rivals drop what they were carrying',
    landed.rivalsAfter.some((v, i) => v < landed.rivalsBefore[i]),
    `${JSON.stringify(landed.rivalsBefore)} -> ${JSON.stringify(landed.rivalsAfter)}`);
  check('the board is held so the landing can be watched',
    landed.stillUp === true && /raider lands/i.test(landed.title || ''),
    `"${landed.title}"`);

  await sleep(600);
  // The hold is measured in game time, and SwiftShader feeds this loop about a
  // tenth of the frames a phone does — so step it the way main.js does.
  const back = await ev(`(()=>{const g=window.__ISLAND__.game; let held=0;
    for(let i=0;i<180&&g.overview.isOpen;i++){ g.hud.update(1/60); held=i+1; }
    const c=document.querySelector('.kn-cue');
    return { heldSeconds:+(held/60).toFixed(2), open:g.overview.isOpen,
      overviewCam: !!g.camera.isOverview,
      cls: c?c.className:'(gone)', knightsHeld:g.knightCue.pending,
      chip: !!document.querySelector('.kn-cue.on') };})()`);
  say('back in play', back);
  check('and then it hands the board back',
    back.open === false && back.overviewCam === false,
    `board held ~${back.heldSeconds}s after Confirm, then closed`);
  check('the call-to-action clears once the Knight is spent',
    back.chip === false && back.knightsHeld === 0, `class="${back.cls}"`);
}

/* ========================================================= 4. victory flood */

if (TRACE === 'flood') {
  say('draft', await ev('__draftUI(45)'));
  // Clear the start line before forcing the finish.
  await ev(`(()=>{const S=1/60,I=()=>window.__ISLAND__;
    for(let i=0;i<60*5;i++) I().game.flow.update(S); return I().game.flow.stage;})()`);
  const setup = await ev(`(()=>{
    const I=()=>window.__ISLAND__, R=window.__R__, st=I().state, p=st.players[0];
    // A real winning board, built through the rules: run the network out, settle
    // on it, upgrade, and top up with victory-point cards if it is still short.
    for(let k=0;k<16;k++){const L=R.legalRoads(st,0);if(!L.length)break;R.placeRoad(st,0,L[0],true);}
    for(let k=0;k<5;k++){const L=R.legalSettlements(st,0);if(!L.length)break;R.placeSettlement(st,0,L[0],true);}
    [...p.settlements].slice(0,5).forEach(i=>R.upgradeCity(st,0,i,true));
    while(R.scoreOf(st,p) < 13 && p.vpCards < 14) p.vpCards++;
    R.checkVictory(st);
    return { phase:st.phase, winner:st.winner, vp:R.scoreOf(st,p),
      s:p.settlements.size, c:p.cities.size, vpCards:p.vpCards };})()`);
  say('forced finish', setup);

  if (SHOT) {
    // Pin the wave mid-flight with mood.js's manual driver, hold the flow, and
    // photograph the wavefront crossing the island.
    const at = await ev(`(()=>{
      const S=1/60, I=()=>window.__ISLAND__, R=window.__R__;
      const st=I().state, g=I().game, props=I().world.props;
      for(let i=0;i<60*3;i++){R.tickWorld(st,S);g.flow.update(S);props.update(S);}
      const w=st.players[g.flow.winner]||st.players[0];
      props.floodWinner(w.color.hex, 0.55);
      return {winner:w.name, p:props.floodProgress(), winT:+g.flow.winT.toFixed(2)};})()`);
    say('pinned', at);
    await holdFlow(true);
    await sleep(250);
    await shot('fl-flood-mid');
    done();
  }

  const out = await ev(`(()=>{
    const S=1/60, I=()=>window.__ISLAND__, R=window.__R__;
    const st=I().state, g=I().game, p=st.players[0];
    const samples=[]; let celebAt=-1, floodAtCeleb=-1, revealAt=-1, doneAt=-1;
    const props=I().world.props;
    for(let i=0;i<60*11;i++){
      R.tickWorld(st,S);
      g.flow.update(S);
      props.update(S);                       // main.js calls this every frame
      const t=+g.flow.winT.toFixed(2);
      const fp=props.floodProgress?+props.floodProgress().toFixed(3):-1;
      if(i%12===0) samples.push([t,fp,g.flow.celebrated?1:0]);
      if(celebAt<0&&g.flow.celebrated){celebAt=t;floodAtCeleb=fp;}
      if(revealAt<0&&g.panels.kind==='results'){revealAt=t;}
    }
    return { samples, celebAt, floodAtCeleb, revealAt,
      finalProgress: props.floodProgress?+props.floodProgress().toFixed(3):-1,
      active: props.victoryFloodActive?props.victoryFloodActive():false,
      winner: g.flow.winner, phase: st.phase, resultsUp: g.panels.kind };})()`);
  console.log('  t(s)  flood  celebrating');
  for (const s of out.samples) console.log(`  ${String(s[0]).padStart(5)}  ${String(s[1]).padStart(5)}  ${s[2]}`);
  say('celebration starts at', `${out.celebAt}s, flood was at ${out.floodAtCeleb}`);
  say('results panel at', `${out.revealAt}s`);

  const rise = out.samples.filter(s => s[1] > 0 && s[1] < 1).length;
  check('the flood sweeps the island rather than blinking on',
    rise >= 3, `${rise} sampled frames mid-sweep`);
  check('every hex ends in the winner\'s colour', out.finalProgress >= 0.999,
    `floodProgress=${out.finalProgress}`);
  check('the celebration starts only AFTER the flood completes',
    out.celebAt > 0 && out.floodAtCeleb >= 0.999,
    `celebration at ${out.celebAt}s with flood at ${out.floodAtCeleb}`);
  check('and the results panel comes after the celebration',
    out.revealAt > out.celebAt, `results ${out.revealAt}s vs celebration ${out.celebAt}s`);
  check('no per-tile flicker is left behind — one wave, not nineteen events',
    out.active === true);
}

/* ============================================== 5. results panel (probe) */

if (TRACE === 'results') {
  say('draft', await ev('__draftUI(45)'));
  const drive = await ev(`(()=>{
    const I=()=>window.__ISLAND__, R=window.__R__, st=I().state, p=st.players[1];
    let guard=0;
    while (R.scoreOf(st,p) < 13 && guard++ < 40){
      const legal=R.legalSettlements(st,1);
      if(legal.length && p.settlements.size+p.cities.size<7){R.placeSettlement(st,1,legal[0],true);continue;}
      const up=R.legalCities(st,1); if(up.length){R.upgradeCity(st,1,up[0],true);continue;}
      const rd=R.legalRoads(st,1); if(rd.length){R.placeRoad(st,1,rd[0],true);continue;}
      break;
    }
    return { vp:R.scoreOf(st,p), phase:st.phase, winner:st.winner };})()`);
  say('rival win', drive);
  const seq = await ev(`(()=>{
    const S=1/60, I=()=>window.__ISLAND__, R=window.__R__;
    const st=I().state, g=I().game, props=I().world.props;
    const marks=[];
    for(let i=0;i<60*8;i++){
      R.tickWorld(st,S); g.flow.update(S); props.update(S);
      if(i%30===0) marks.push([+g.flow.winT.toFixed(2), g.panels.kind,
        document.querySelectorAll('.rs-row').length]);
    }
    return { marks, winT:+g.flow.winT.toFixed(2), kind:g.panels.kind,
      sheets:document.querySelectorAll('.results').length,
      rows:document.querySelectorAll('.rs-row').length,
      stats:document.querySelectorAll('.rs-stat').length,
      title:(document.querySelector('.rs-title')||{}).textContent,
      cls:(document.querySelector('.results')||{}).className };})()`);
  for (const m of seq.marks) console.log(`  winT=${m[0]}  panel=${m[1]}  rows=${m[2]}`);
  say('final', seq);
  check('the results panel carries its four rows',
    seq.rows === 4 && seq.stats === 7 && seq.sheets === 1,
    `${seq.sheets} sheet(s), ${seq.rows} rows, ${seq.stats} stat rows`);
}

if (exceptions.length) {
  pass = false;
  for (const e of exceptions.slice(0, 6)) console.log('  EXC ' + String(e).split('\n')[0].slice(0, 170));
}
console.log(pass ? `\n${TRACE}: all checks passed` : `\n${TRACE}: FAILURES ABOVE`);

ws.close(); chrome.kill('SIGKILL');
process.exit(pass ? 0 : 1);
