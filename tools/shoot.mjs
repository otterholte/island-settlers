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

/*
 * 30s was the budget here and it is not enough on a shared box either. The
 * `sweep` stage's setup block imports two modules into the page, claims a hex
 * through the real rules and installs eight driver functions on `window`, all
 * inside one awaited evaluate — and when that came back `undefined` the run did
 * not stop. It carried on and photographed a hex it had never swept, which is
 * how `ph-hills-1-last.png` came back showing twenty-eight standing items with
 * "LAST" printed over it. A rig whose timeout produces a plausible-looking
 * wrong photograph is worse than one that produces none, so the budget goes to
 * two minutes to match `SHOT_MS` below. Nothing here is on a hot path; the only
 * cost of a long timeout is how long a genuinely broken eval takes to admit it.
 */
const send = (method, params = {}, timeoutMs = 120000) => new Promise(res => {
  const id = ++msgId;
  pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); res({ __err: 'timeout' }); } }, timeoutMs);
});

const ev = async (expr, awaitPromise = false) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
  if (r?.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
  return r?.result?.value;
};

/*
 * A CAPTURE IS ALLOWED TO BE SLOW, AND IT HAS TO BE.
 *
 * `Page.captureScreenshot` used to ride the shared 30-second `send` timeout,
 * and the failure mode when it ran out was silent in the worst possible way: a
 * line saying `shot sw-forest-1-full FAILED` scrolled past in a run of forty
 * frames, no file was written, and the PNG the last pass left on disk stayed
 * there — so the next reader compares a fresh capture of one hex against a
 * stale one of another and cannot tell.
 *
 * Thirty seconds is not a generous budget on this box. SwiftShader renders this
 * scene at about four frames a second on two cores, a 960x444 capture is five
 * seconds of that on its own, and the whole point of a rig like this is that
 * several of them run while other work is going on. Under contention from one
 * other headless render the same frame takes upwards of a minute, which is not
 * a defect in the frame.
 *
 * So the capture gets its own two-minute budget and one retry. Two minutes is
 * chosen against the outer `timeout 300` these are launched under: a stage
 * takes about a minute of setup, so one retry still fits. The retry costs
 * nothing when the first attempt works, and the failure is LOUD when both fail
 * — a run that could not photograph what it was asked to photograph should not
 * look like a run that did.
 */
const SHOT_MS = 120000;
const shotFailures = [];
const shot = async (name) => {
  let r = await send('Page.captureScreenshot', { format: 'png' }, SHOT_MS);
  if (!r?.data) {
    console.log(`  shot ${name} slow — retrying`);
    await sleep(2000);
    r = await send('Page.captureScreenshot', { format: 'png' }, SHOT_MS);
  }
  if (!r?.data) { console.log(`  shot ${name} FAILED`); shotFailures.push(name); return; }
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
  await hold('ArrowUp', 'ArrowUp', 38, 1200);
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

} else if (STAGE === 'sweep') {
  /*
   * The whole arc of a hex you own, photographed through the real contact
   * pickup: FULL -> PARTLY SWEPT -> CLEARED WITH THE COUNTDOWN -> RESTORED,
   * plus a wide shot of owned hexes next to hexes you do not own.
   *
   *   --terrain=forest|fields|pasture|hills|mountains
   *   --phase=a   full field, then half of it swept up
   *   --phase=b   cleared out with the clock running, then further into it
   *   --phase=c   the regrowth beat and the refilled hex
   *   --phase=wide  the owned / off-limits contrast across the whole island
   *   --phase=farside a cleared hex from the front and then from BEHIND, which
   *                 is the only framing that catches a landmark authored
   *                 against the play camera's fixed +Z bearing
   *   --phase=proof THE PHANTOM TEST — see below
   *
   * THE PHANTOM TEST
   * ----------------
   * "There should be no Phantom trees, only pickable resources ... once its
   *  collected the phantom tree then disappears."
   *
   * A phantom is a prop that LOOKS like a resource, cannot be picked up, and
   * then vanishes anyway the moment the hex's last real item is taken — because
   * the dressing answers the hex's fill fraction through `world/stand.js`, so
   * emptying the hex spends the whole decorative pool at once. That is a defect
   * you cannot see in any single still: a full hex and an empty hex both look
   * fine on their own, and the bug lives entirely in the DIFFERENCE between two
   * frames.
   *
   * So this phase photographs exactly that difference, from a camera that does
   * not move between the two exposures:
   *
   *   ph-<terrain>-1-last    the hex swept down to its LAST standing item
   *   ph-<terrain>-2-empty   the same camera, immediately after that item is
   *                          taken and the hex has gone dormant
   *
   * Read them side by side. Exactly one object may leave the hex between the
   * two frames — the item that was picked up. Anything else that is standing in
   * the first and gone in the second is a phantom, and it is a phantom whatever
   * it looked like. The settler is parked well off the tile for both exposures
   * so nothing is hidden behind them and the two frames differ in one thing
   * only.
   *
   * The console census printed with each frame is the same claim in numbers:
   * `field` is the harvestable items (units / standing / animating), `dress` is
   * the responsive dressing the stand holds on that hex broken down BY ROLE,
   * and `props` is every decorative kit standing on it. A hex whose `dress`
   * roles contain no `fell` has nothing on it that can topple, and a `props`
   * list with nothing tree-shaped or stone-shaped in it has nothing on it that
   * could be mistaken for the crop in the first place.
   */
  const TERRAIN = arg('terrain', 'forest');
  const PHASE = arg('phase', 'a');
  await finishDraft();
  await ev(`import('/src/board/nodes.js').then(m=>{window.__N__=m}).then(()=>1)`, true);
  console.log('  setup ' + await ev(`(()=>{const{state,game}=window.__ISLAND__,R=window.__R__;
    return import('/src/board/layout.js').then(L=>{
      // Give the human a hex of this terrain to work, through the real rules.
      let t=L.tiles.filter(x=>x.terrain===${JSON.stringify(TERRAIN)})
        .find(x=>R.playerOwnsTile(state,0,x.id));
      if(!t){
        const cands=L.tiles.filter(x=>x.terrain===${JSON.stringify(TERRAIN)})
          .sort((a,b)=>b.pips-a.pips);
        outer: for(const c of cands){
          for(const corner of c.corners){
            const ph=state.phase; state.phase='setup';
            const ok=R.placeSettlement(state,0,corner,true);
            state.phase=ph;
            if(ok){ t=c; break outer; }
          }
        }
      }
      if(!t) return 'could not claim a '+${JSON.stringify(TERRAIN)}+' hex';
      window.__T__=t;
      // The bots keep playing knights while the capture sleeps between frames;
      // park the Knight somewhere harmless so the shot is about the field.
      window.__UNBLOCK__=()=>{state.robberTile=L.DESERT.id; state.robberOwner=0; return 1;};
      window.__UNBLOCK__();
      const p=state.players[0];
      p.x=t.x; p.z=t.z+9.5; p.vx=0; p.vz=0; p.action='idle'; p.facing=-Math.PI/2;
      p.res={wood:6,brick:4,wool:3,wheat:5,ore:3};
      game.avatars[0].setCarry(p.res);
      game.avatars[0].group.position.set(p.x,0,p.z);
      window.__STEP__=(k)=>{for(let i=0;i<k;i++){window.__R__.tickWorld(state,1/60);
        game.flow.update(1/60);game.gathering.update(1/60);game.bots.update(1/60);}
        return +state.time.toFixed(1);};
      // Walk the settler item to item and let the contact sweep take them.
      window.__SWEEP__=(n)=>{let got=0;
        window.__UNBLOCK__();
        for(let k=0;k<n;k++){
          const it=window.__N__.nearestItem(p.x,p.z,{tile:t.id});
          if(!it) break;
          p.x=it.x; p.z=it.z; p.sweptAt=-1;
          window.__R__.tickWorld(state,1/60); game.gathering.update(1/60); got++;
        }
        game.avatars[0].group.position.set(p.x,0,p.z);
        game.avatars[0].setCarry(p.res);
        return {got, left:window.__N__.tileItemsRemaining(t.id),
                full:window.__N__.tileItemCount(t.id)};};
      window.__REC__=()=>{const r=window.__N__.tileRecovery(t.id,state.time);
        const g=window.__ISLAND__.world.props.regions;
        return {left:+r.secondsLeft.toFixed(1), progress:+r.progress.toFixed(2),
          items:window.__N__.tileItemsRemaining(t.id),
          badge:(g?g.readout():[]).filter(x=>x.tile===t.id)[0],
          field:window.__ISLAND__.world.props.field.debug(t.id),
          dress:g&&g.debug?g.debug(t.id):null};};
      // Park the settler well off the tile so a capture can photograph the hex
      // and nothing else. world/stand.js uses the nearest player as the origin
      // its sweep clears outward from, which is a presentation detail only — by
      // the time this is called the hex is already at the fill fraction we want.
      // (No backticks anywhere inside this block: it is itself the body of a
      // template literal, and a backtick in a comment still ends the string.)
      window.__STANDOFF__=()=>{p.x=t.x-19; p.z=t.z-13; p.vx=0; p.vz=0;
        game.avatars[0].group.position.set(p.x,0,p.z); return 1;};
      // Everything standing on this hex, in one object: the harvestable field,
      // the dressing the stand is holding (by role), and the decorative kits.
      // Sweep DOWN TO a target number of standing items rather than taking a
      // fixed count. Pickup is contact-based on a 2.4-unit radius and the field
      // is blue-noise spaced about 2.1 apart, so walking onto one item takes
      // two or three of its neighbours with it — "take 27 of 28" empties the
      // whole hex. This walks, re-reads the truth, and stops.
      window.__SWEEPTO__=(target)=>{let guard=0;
        window.__UNBLOCK__();
        while(window.__N__.tileItemsRemaining(t.id)>target&&guard++<200){
          const it=window.__N__.nearestItem(p.x,p.z,{tile:t.id});
          if(!it) break;
          p.x=it.x; p.z=it.z; p.sweptAt=-1;
          window.__R__.tickWorld(state,1/60); game.gathering.update(1/60);
        }
        game.avatars[0].group.position.set(p.x,0,p.z);
        game.avatars[0].setCarry(p.res);
        return {left:window.__N__.tileItemsRemaining(t.id),
                full:window.__N__.tileItemCount(t.id)};};
      window.__CENSUS__=()=>{const W=window.__ISLAND__.world.props;
        return {items:window.__N__.tileItemsRemaining(t.id),
          full:window.__N__.tileItemCount(t.id),
          field:W.field.debug(t.id),
          dress:W.regions&&W.regions.debug?W.regions.debug(t.id):null,
          props:W.tileCounts[t.id]||{}};};
      window.__CAM__=(d,hh,fov,aim)=>{const{camera}=window.__ISLAND__;
        window.__ISLAND__.game.camera.update=()=>{};
        camera.position.set(t.x+1.5,hh,t.z+d); camera.lookAt(t.x,aim||5.5,t.z);
        camera.fov=fov; camera.updateProjectionMatrix(); return 1;};
      // The same shot from the OTHER side of the hex. The play camera never
      // goes here — PLAY_YAW in systems/camera.js is 0 and it always sits on
      // +Z — which is exactly why it is worth photographing: a landmark that is
      // authored against one fixed viewpoint is a landmark whose back nobody
      // has ever looked at, and the quarry is a ring of geometry whose far arc
      // is back-face culled from the front. Same distance, same lens, mirrored
      // bearing.
      window.__CAMFAR__=(d,hh,fov,aim)=>{const{camera}=window.__ISLAND__;
        window.__ISLAND__.game.camera.update=()=>{};
        camera.position.set(t.x-1.5,hh,t.z-d); camera.lookAt(t.x,aim||5.5,t.z);
        camera.fov=fov; camera.updateProjectionMatrix(); return 1;};
      return 'hex '+t.id+' '+t.terrain+' pips='+t.pips+
        ' items='+window.__N__.tileItemCount(t.id);
    });})()`, true));
  if (arg('hud', '1') === '0') await ev(`(()=>{const u=document.getElementById('ui');if(u)u.style.display='none';return 1})()`);

  if (PHASE === 'wide') {
    await ev(`(()=>{const{camera,THREE}=window.__ISLAND__;
      window.__ISLAND__.game.camera.update=()=>{};
      camera.position.set(6,64,72); camera.lookAt(0,2,-2);
      camera.fov=40; camera.updateProjectionMatrix(); return 1;})()`);
    await ev(`window.__STEP__(30)`);
    await sleep(+arg('settle', 3600));
    await shot('sw-wide-owned');
    console.log('  owned ' + JSON.stringify(await ev(`(()=>{const R=window.__R__,st=window.__ISLAND__.state;
      return import('/src/board/layout.js').then(L=>({
        mine:L.tiles.filter(t=>t.resource&&R.playerOwnsTile(st,0,t.id)).map(t=>t.id),
        total:L.tiles.filter(t=>t.resource).length }));})()`, true)));
    /*
     * THE LANDMARK CENSUS, once per board, on the one phase that photographs
     * the whole island at once.
     *
     * `world/props.js` publishes `tileCounts` precisely so a rig can make this
     * claim in numbers rather than in adjectives, and until now nothing read
     * it. Every landmark on this island is placed by a sampler or a scorer that
     * is allowed to come up short — the pasture's fence arc can decline every
     * bearing on a twenty-eight sheep flock, the hills' stones can find no gap
     * wide enough, and both of them have shipped at nought before. Each one
     * carries a floor for that reason (two panels, two stones, two bales), and
     * a floor nobody measures is a floor nobody knows is holding.
     *
     * It matters more now than it did, because this pass took ground away from
     * all three: the six corner discs in `makePlacer` reserve the vertices of
     * every hex for the settlements and cities the players may build there, so
     * the strict pass has about a third less hex to aim at than it used to.
     * The relaxed passes drop those discs again exactly so the floors keep
     * holding — and this line is how you check that they do, on whatever board
     * the run happened to deal, without opening a single PNG.
     *
     * Printed as terrain:pips -> the kits that stand on that hex, so a short
     * count can be read straight off against how crowded the hex is.
     */
    console.log('  landmarks ' + JSON.stringify(await ev(`(()=>{
      const W=window.__ISLAND__.world.props, C=W.tileCounts||{};
      // 'boulder' and 'hay' stay on this list even though neither is supposed
      // to stand on a resource hex any more — the stones came off the brick
      // hills and the bale came off the pastures — precisely so a run that
      // starts putting them back somewhere prints the evidence. A census that
      // only lists what you expect cannot tell you when you are wrong.
      const KEEP=['hay','fence','boulder','shovel','clayWorks','mine','rockSmall','spire'];
      return import('/src/board/layout.js').then(L=>{
        const out={};
        for(const t of L.tiles){
          if(!t.resource) continue;
          const got=C[t.id]||{}, row={};
          for(const k of KEEP) if(got[k]) row[k]=got[k];
          out[t.terrain+'/'+t.pips+'#'+t.id]=row;
        }
        return out;});})()`, true)));
  } else {
    await ev(`window.__CAM__(${+arg('dist', 22)}, ${+arg('eye', 15)}, ${+arg('fov', 38)}, ${+arg('aim', 5.5)})`);
    // --park=1 walks the settler off the tile before anything is photographed.
    // The avatar carries a column of resource cards stacked over its head that
    // is taller than a conifer, and parked at the near rim — which is where the
    // sweep leaves it — that column stands directly between this camera and the
    // hex. Fine for a shot ABOUT the settler; useless for a shot about a hex.
    if (arg('park', '0') === '1') await ev(`__STANDOFF__()`);
    await sleep(+arg('settle', 2800));
    if (PHASE === 'pop') {
      // One item, taken on contact, photographed while the chip is still in the
      // air — the "which one did I just pick up" shot.
      console.log('  pre ' + JSON.stringify(await ev(`(()=>{const{state}=window.__ISLAND__,R=window.__R__,t=window.__T__;
        return {phase:state.phase, owns:R.playerOwnsTile(state,0,t.id),
          may:R.canGatherTile(state,0,t.id), robber:state.robberTile,
          rec:window.__REC__()};})()`)));
      await shot(`sw-${TERRAIN}-0-before`);
      console.log('  take ' + JSON.stringify(await ev(`__SWEEP__(1)`)));
      console.log('  post ' + JSON.stringify(await ev(`__REC__()`)));
      await shot(`sw-${TERRAIN}-0-pop`);
      await sleep(+arg('gap', 700));
      await shot(`sw-${TERRAIN}-0-after`);
    } else if (PHASE === 'a') {
      await shot(`sw-${TERRAIN}-1-full`);
      console.log('  sweep ' + JSON.stringify(await ev(`__SWEEP__(${+arg('take', 8)})`)));
      await sleep(1600);
      await shot(`sw-${TERRAIN}-2-swept`);
      console.log('  ' + JSON.stringify(await ev(`__REC__()`)));
    } else if (PHASE === 'proof') {
      // Down to the last handful, settler parked off the tile, camera locked.
      console.log('  sweep ' + JSON.stringify(await ev(`__SWEEPTO__(${+arg('left', 5)})`)));
      await ev(`__STANDOFF__()`);
      await sleep(+arg('gap', 3000));
      console.log('  LAST  ' + JSON.stringify(await ev(`__CENSUS__()`)));
      await shot(`ph-${TERRAIN}-1-last`);
      // ...and now the rest of them, with nothing else touched.
      console.log('  take  ' + JSON.stringify(await ev(`__SWEEPTO__(0)`)));
      await ev(`__STANDOFF__()`);
      await sleep(+arg('gap', 3000));
      console.log('  EMPTY ' + JSON.stringify(await ev(`__CENSUS__()`)));
      await shot(`ph-${TERRAIN}-2-empty`);
    } else if (PHASE === 'farside') {
      /*
       * THE LANDMARK FROM BEHIND, on an emptied hex.
       *
       *   "sw-hills-5-quarry-farside.png was requested but never written to
       *    disk. Re-shoot it — the far-side angle is the quarry's weakest read,
       *    and from ph-hills-2-empty.png the pit currently looks like a thin
       *    cream crescent rather than a dug pit."
       *
       * The crescent was the whole of that defect and it is a back-face
       * problem: every wall `geo.js` builds is a closed tube pointing OUTWARD,
       * so a ring of them shows the camera its near arc and culls its far one.
       * Turn the camera round and the arc that was drawn is the one that
       * vanishes — which makes this the one framing that cannot be satisfied by
       * a kit that only works from +Z. Shot with the hex swept clean, because
       * an empty hex is where a decorative landmark has nowhere to hide.
       */
      console.log('  sweep ' + JSON.stringify(await ev(`__SWEEPTO__(0)`)));
      await ev(`__STANDOFF__()`);
      // Long enough for twenty-three pickup badges and their flying chips to
      // finish: a frame full of +1s is a photograph of a harvest, and this pair
      // is supposed to be a photograph of a landmark on an emptied hex.
      await ev(`window.__STEP__(${Math.round(+arg('skip', 5) * 60)})`);
      await sleep(+arg('rest', 2600));
      await shot(`sw-${TERRAIN}-5-quarry-farside-near`);
      // TAKE IT DOWN AGAIN BEFORE THE SECOND EXPOSURE. `tickWorld` runs off the
      // frame loop as well as off `__STEP__`, and a capture on SwiftShader
      // spends the better part of a minute between two shots — longer than
      // TILE_REGEN for every hex on the board except the 1-pip ones. So the hex
      // quietly refills while the first frame is being encoded, and the far-side
      // exposure comes back showing a hex full of brick.
      console.log('  resweep ' + JSON.stringify(await ev(`__SWEEPTO__(0)`)));
      // The standoff parks the settler at (-19, -13) from the hex, which is
      // behind the front camera and directly in front of this one. Mirror it.
      await ev(`(()=>{const{state,game}=window.__ISLAND__,t=window.__T__;
        const p=state.players[0]; p.x=t.x+19; p.z=t.z+13; p.vx=0; p.vz=0;
        game.avatars[0].group.position.set(p.x,0,p.z); return 1;})()`);
      await ev(`__CAMFAR__(${+arg('dist', 22)}, ${+arg('eye', 15)}, ${+arg('fov', 38)}, ${+arg('aim', 5.5)})`);
      await sleep(+arg('gap', 2200));
      await shot(`sw-${TERRAIN}-5-quarry-farside`);
      console.log('  ' + JSON.stringify(await ev(`__CENSUS__()`)));

    } else if (PHASE === 'b') {
      console.log('  sweep ' + JSON.stringify(await ev(`__SWEEP__(40)`)));
      await ev(`window.__STEP__(60)`);
      // The sweep walks the settler item to item, so it undoes any parking done
      // before it — park again, and give the pickup FX time to finish. A frame
      // full of flying chips and +1 badges is a photograph of a HARVEST, and
      // this pair is supposed to be a photograph of an emptied hex.
      if (arg('park', '0') === '1') await ev(`__STANDOFF__()`);
      await sleep(+arg('rest', 2400));
      await shot(`sw-${TERRAIN}-3-cleared`);
      console.log('  ' + JSON.stringify(await ev(`__REC__()`)));
      await ev(`window.__STEP__(${Math.round(+arg('skip', 16) * 60)})`);
      await sleep(1500);
      await shot(`sw-${TERRAIN}-4-countdown`);
      console.log('  ' + JSON.stringify(await ev(`__REC__()`)));
    } else {
      console.log('  sweep ' + JSON.stringify(await ev(`__SWEEP__(40)`)));
      const total = await ev(`window.__N__.tileRegenSeconds(window.__T__.id)`);
      await ev(`window.__STEP__(${Math.round((+total - 0.4) * 60)})`);
      await sleep(+arg('beat', 1200));
      await shot(`sw-${TERRAIN}-5-regrowing`);
      console.log('  ' + JSON.stringify(await ev(`__REC__()`)));
      await sleep(+arg('wait', 2400));
      await shot(`sw-${TERRAIN}-6-restored`);
      console.log('  ' + JSON.stringify(await ev(`__REC__()`)));
    }
  }

} else if (STAGE === 'region') {
  /*
   * Region depletion + recovery. Drains a WHOLE TILE through the real
   * `depleteNode` path so the region layer sees exactly what it sees in play,
   * and photographs the arc: full -> half worked -> clear cut -> spent badge
   * with a live countdown -> regrown.
   *
   *   --terrain=forest|fields|pasture|hills|mountains
   *   --phase=a   full region / half worked
   *   --phase=b   clear cut with the spent badge / mid countdown
   *   --phase=c   the last second of dormancy / the regrowth beat
   *   --fov=34    narrow the lens so one hex fills the frame
   */
  const TERRAIN = arg('terrain', 'forest');
  const PHASE = arg('phase', 'a');
  await finishDraft();
  await ev(`import('/src/board/nodes.js').then(m=>{window.__N__=m}).then(()=>1)`, true);
  console.log('  setup ' + await ev(`(()=>{const{state,game}=window.__ISLAND__;
    return import('/src/board/layout.js').then(L=>{
      const t=L.tiles.filter(t=>t.terrain===${JSON.stringify(TERRAIN)})
        .sort((a,b)=>Math.hypot(a.x,a.z)-Math.hypot(b.x,b.z))[0];
      window.__T__=t;
      const p=state.players[0];
      p.x=t.x+0.6; p.z=t.z+2.2; p.vx=0; p.vz=0; p.action='idle';
      p.facing=-Math.PI/2;
      try{game.camera.focus.set(t.x,3.4,t.z+1.0);}catch(e){}
      p.res={wood:9,brick:5,wool:3,wheat:7,ore:4};
      game.avatars[0].setCarry(p.res);
      game.avatars[0].group.position.set(p.x,0,p.z);
      window.__STEP__=(k)=>{for(let i=0;i<k;i++){window.__R__.tickWorld(state,1/60);
        game.flow.update(1/60);game.controller.update(1/60);
        game.gathering.update(1/60);game.bots.update(1/60);}return +state.time.toFixed(1);};
      window.__DRAIN__=(cnt)=>{const list=window.__N__.nodesByTile.get(t.id)||[];
        let done=0;
        for(const n of list){ if(done>=cnt) break;
          while(n.remaining>0) window.__N__.depleteNode(n,state.time); done++; }
        return window.__N__.tileRemaining(t.id);};
      window.__REC__=()=>{const r=window.__N__.tileRecovery(t.id,state.time);
        const g=window.__ISLAND__.world.props.regions;
        return {left:+r.secondsLeft.toFixed(1),
          badge:(g?g.readout():[]).filter(x=>x.tile===t.id)[0],
          dress:g&&g.debug?g.debug(t.id):null};};
      return 'tile '+t.id+' '+t.terrain+' n='+(window.__N__.nodesByTile.get(t.id)||[]).length;
    });})()`, true));
  if (arg('hud', '1') === '0') await ev(`(()=>{const u=document.getElementById('ui');if(u)u.style.display='none';return 1})()`);
  await ev(`(()=>{const c=window.__ISLAND__.camera;c.fov=${+arg('fov', 34)};c.updateProjectionMatrix();return c.fov})()`);
  await sleep(+arg('settle', 2600));

  if (PHASE === 'board') {
    // Several regions in different states at once — the "can I read the board
    // at a glance" test. Drains three tiles fully and half-works two more.
    console.log('  ' + JSON.stringify(await ev(`(()=>{const{state}=window.__ISLAND__,N=window.__N__;
      return import('/src/board/layout.js').then(L=>{
        const pick=k=>L.tiles.filter(t=>t.terrain===k)
          .sort((a,b)=>Math.hypot(a.x,a.z)-Math.hypot(b.x,b.z))[0];
        const out=[];
        for(const k of ['forest','fields','mountains']){const t=pick(k);
          for(const n of (N.nodesByTile.get(t.id)||[])) while(n.remaining>0) N.depleteNode(n,state.time);
          out.push(k+':spent');}
        for(const k of ['pasture','hills']){const t=pick(k);
          const l=N.nodesByTile.get(t.id)||[];
          l.slice(0,4).forEach(n=>{while(n.remaining>0) N.depleteNode(n,state.time);});
          out.push(k+':'+N.tileRemaining(t.id).fraction.toFixed(2));}
        return out;});})()`, true)));
    await ev(`window.__STEP__(60)`);
    await sleep(3200);
    await shot('r-board-glance');
    await ev(`window.__ISLAND__.game.openOverview('view')`);
    await sleep(2600);
    await shot('r-board-overview');

  } else if (PHASE === 'a') {
    if (arg('pre', '1') !== '0') await shot(`r-${TERRAIN}-1-full`);
    console.log('  drain ' + JSON.stringify(await ev(`window.__DRAIN__(${+arg('take', 3)})`)));
    await ev(`window.__STEP__(30)`);
    await sleep(2000);
    await shot(`r-${TERRAIN}-2-half`);
    console.log('  ' + JSON.stringify(await ev(`window.__REC__()`)));
  } else if (PHASE === 'b') {
    console.log('  drain ' + JSON.stringify(await ev(`window.__DRAIN__(9)`)));
    await ev(`window.__STEP__(60)`);
    await sleep(2600);
    await shot(`r-${TERRAIN}-3-clearcut`);
    console.log('  ' + JSON.stringify(await ev(`window.__REC__()`)));
    await ev(`window.__STEP__(${Math.round(+arg('skip', 13) * 60)})`);
    await sleep(1400);
    await shot(`r-${TERRAIN}-4-countdown`);
    console.log('  ' + JSON.stringify(await ev(`window.__REC__()`)));
  } else {
    console.log('  drain ' + JSON.stringify(await ev(`window.__DRAIN__(9)`)));
    // Run the dormancy out on the simulation clock, then hand the last stretch
    // back to real frames so the regrowth beat actually animates.
    await ev(`window.__STEP__(${Math.round(+arg('skip', 19.9) * 60)})`);
    await sleep(+arg('beat', 900));
    await shot(`r-${TERRAIN}-5-regrowing`);
    console.log('  ' + JSON.stringify(await ev(`window.__REC__()`)));
    await sleep(+arg('wait', 2600));
    await shot(`r-${TERRAIN}-6-regrown`);
    console.log('  ' + JSON.stringify(await ev(`window.__REC__()`)));
  }

} else if (STAGE === 'landmark') {
  /*
   * Park the camera close on a landmark so the market and the ports can
   * actually be judged instead of guessed at from a 40-pixel smudge.
   *
   *   --target=market|port|wide   --port=3  --lock=0|1  --tag=name
   *
   * Also reports the measured draw-call / triangle cost of the market group
   * and the ports group by rendering the frame with each group toggled off.
   */
  const TAG = arg('tag', 'now');
  const SETTLE = +arg('settle', 2200);
  await finishDraft();
  if (arg('hud', '0') === '0') {
    await ev(`(()=>{const u=document.getElementById('ui');if(u)u.style.display='none';return 1})()`);
  }
  await ev(`(()=>{window.__ISLAND__.game.camera.update=()=>{};return 1})()`);

  /* spec: name:kind[:portId]  kind = market|mktfar|portU|portL|wide */
  const SHOTS = arg('targets', 'market:market,portU:portU:2,portL:portL:5,wide:wide')
    .split(',').filter(Boolean).map(s => s.split(':'));

  for (const [name, kind, pid] of SHOTS) {
    console.log('  park ' + await ev(`(()=>{const{camera,world,THREE}=window.__ISLAND__;
      return import('/src/board/layout.js').then(L=>import('/src/world/terrain.js').then(T=>{
        const k=${JSON.stringify(kind)}; let eye,look,fov=${+arg('fov', 44)};
        if(k==='wide'){
          eye=new THREE.Vector3(30,54,78); look=new THREE.Vector3(0,3,0); fov=40;
        } else if(k==='market'||k==='mktfar'){
          // stand on the sunlit side, where the trading house now faces
          const m=L.MARKET, h=T.heightAt(m.x,m.z), far=k==='mktfar';
          const d=far?34:17.5, az=2.07;
          eye=new THREE.Vector3(m.x+Math.cos(az)*d,h+(far?23:12.5),m.z+Math.sin(az)*d);
          look=new THREE.Vector3(m.x,h+(far?7.0:4.0),m.z);
        } else {
          // a locked shot has to use a berth the opening draft did not claim
          const owned=new Set();
          for(const pl of window.__ISLAND__.state.players) for(const q of pl.ports) owned.add(q);
          let id=${+(pid || 0)};
          if(k==='portL'&&owned.has(id)){ for(let j=0;j<L.ports.length;j++) if(!owned.has(j)){ id=j; break; } }
          const p=L.ports[id], a=world.portsView.anchors[id];
          if(k==='portU') world.portsView.setUnlocked(id,0);
          const cb=Math.cos(p.bearing), sb=Math.sin(p.bearing);
          const lx=16.5, lz=-8.0;
          eye=new THREE.Vector3(a.x+lx*cb-lz*sb,a.y+7.6,a.z+lx*sb+lz*cb);
          look=new THREE.Vector3(a.x+0.5*cb,a.y+1.5,a.z+0.5*sb);
        }
        camera.position.copy(eye); camera.lookAt(look);
        camera.fov=fov; camera.near=0.5; camera.far=800; camera.updateProjectionMatrix();
        return k+'#'+${+(pid || 0)};
      }));})()`, true));
    await sleep(SETTLE);
    await shot(`lm-${TAG}-${name}`);
  }

  // The painted boards are too small on screen to judge; dump the canvases.
  if (arg('atlas', '0') === '1') {
    const d = await ev(`(()=>{const w=window.__ISLAND__.world;
      return {sign:w.portsView.meshes.sign.material.map.image.toDataURL('image/png'),
              beacon:w.market.beacon.material.map.image.toDataURL('image/png')};})()`);
    for (const k of ['sign', 'beacon']) {
      if (d && d[k]) {
        writeFileSync(resolve(OUT, `atlas-${k}.png`), Buffer.from(d[k].split(',')[1], 'base64'));
        console.log(`  atlas-${k}.png`);
      }
    }
  }

  console.log('  cost ' + JSON.stringify(await ev(`(()=>{const{renderer,scene,camera,world}=window.__ISLAND__;
    const R=()=>{renderer.render(scene,camera);
      return {c:renderer.info.render.calls,t:renderer.info.render.triangles};};
    const full=R();
    world.market.group.visible=false;
    const noMkt=R();
    world.portsView.group.visible=false;
    const neither=R();
    world.market.group.visible=true; world.portsView.group.visible=true;
    return {frame:full,
      market:{calls:full.c-noMkt.c,tris:full.t-noMkt.t},
      ports:{calls:noMkt.c-neither.c,tris:noMkt.t-neither.t},
      both:{calls:full.c-neither.c,tris:full.t-neither.t},
      declared:{market:[world.market.drawCalls,world.market.triangles],
        ports:[world.portsView.drawCalls,world.portsView.triangles]}};})()`)));

} else if (STAGE === 'art') {
  /*
   * One tight, single-shot look at a hex — the world-art review framing.
   * Deliberately minimal so it always finishes inside a short shell call.
   *
   *   --terrain=mountains   which hex to stand over
   *   --clear=0|1           strip the hex of every item first (the spent read)
   *   --skip=6              seconds of countdown to burn before the shot
   *   --dist / --eye / --fov / --tag
   */
  const TERRAIN = arg('terrain', 'mountains');
  const TAG = arg('tag', 'now');
  await finishDraft();
  await ev(`import('/src/board/nodes.js').then(m=>{window.__N__=m}).then(()=>1)`, true);
  console.log('  setup ' + await ev(`(()=>{const{state,game,camera}=window.__ISLAND__,R=window.__R__;
    return import('/src/board/layout.js').then(L=>{
      const cands=L.tiles.filter(x=>x.terrain===${JSON.stringify(TERRAIN)});
      let t=cands.find(x=>R.playerOwnsTile(state,0,x.id));
      if(!t){ outer: for(const c of cands){ for(const corner of c.corners){
        const ph=state.phase; state.phase='setup';
        const ok=R.placeSettlement(state,0,corner,true); state.phase=ph;
        if(ok){ t=c; break outer; } } } }
      if(!t) t=cands[0];
      if(!t) return 'no '+${JSON.stringify(TERRAIN)}+' hex';
      window.__T__=t;
      state.robberTile=L.DESERT.id; state.robberOwner=0;
      const p=state.players[0];
      p.x=t.x; p.z=t.z+12.5; p.vx=0; p.vz=0; p.action='idle'; p.facing=-Math.PI/2;
      game.avatars[0].group.position.set(p.x,0,p.z);
      window.__STEP__=(k)=>{for(let i=0;i<k;i++){window.__R__.tickWorld(state,1/60);
        game.flow.update(1/60);game.gathering.update(1/60);}return +state.time.toFixed(1);};
      if(${arg('clear', '0')}){
        // Through the real contact-pickup path, exactly as play does it.
        for(let k=0;k<60;k++){
          const it=window.__N__.nearestItem(p.x,p.z,{tile:t.id});
          if(!it) break;
          p.x=it.x; p.z=it.z; p.sweptAt=-1;
          window.__R__.tickWorld(state,1/60); game.gathering.update(1/60);
        }
        p.x=t.x; p.z=t.z+12.5;
        game.avatars[0].group.position.set(p.x,0,p.z);
        for(let i=0;i<Math.round(${+arg('skip', 6)}*60);i++){
          window.__R__.tickWorld(state,1/60); game.flow.update(1/60);
        }
      }
      game.camera.update=()=>{};
      camera.position.set(t.x+1.0, ${+arg('eye', 11)}, t.z+${+arg('dist', 16)});
      camera.lookAt(t.x, ${+arg('aim', 3.2)}, t.z);
      camera.fov=${+arg('fov', 34)}; camera.updateProjectionMatrix();
      return 'hex '+t.id+' '+t.terrain+' items='+window.__N__.tileItemsRemaining(t.id)
        +'/'+window.__N__.tileItemCount(t.id)
        +' owns='+R.playerOwnsTile(state,0,t.id)+' may='+R.canGatherTile(state,0,t.id);
    });})()`, true));
  await ev(`(()=>{const u=document.getElementById('ui');if(u)u.style.display='none';return 1})()`);
  // --only=field-orerock isolates one instanced batch so a single kit can be
  // judged without the rest of the hex standing in front of it.
  const ONLY = arg('only', '');
  if (ONLY) {
    console.log('  only ' + await ev(`(()=>{const g=window.__ISLAND__.world.props.group;
      let kept=0;g.traverse(o=>{if(o.isMesh){const k=(o.name||'').indexOf(${JSON.stringify(ONLY)})>=0;
        o.visible=k;if(k)kept++;}});return kept;})()`));
  }
  await sleep(+arg('settle', 2400));
  await shot(`art-${TAG}`);

} else if (STAGE === 'flood') {
  /*
   * The end-of-match colour wave. Drives world.props.floodWinner() by hand at
   * fixed progress values so the sweep can be photographed mid-flight without
   * racing a real clock.
   *
   *   --p=0.35,0.7   progress values to capture (one shot each)
   *   --pid=1        which player's colour floods the island
   *   --tag=name
   */
  const PS = arg('p', '0.4,0.85').split(',').filter(Boolean);
  const PID = +arg('pid', 1);
  const TAG = arg('tag', 'now');
  await finishDraft();
  if (arg('hud', '0') === '0') {
    await ev(`(()=>{const u=document.getElementById('ui');if(u)u.style.display='none';return 1})()`);
  }
  await ev(`(()=>{const{camera,THREE}=window.__ISLAND__;
    window.__ISLAND__.game.camera.update=()=>{};
    camera.position.set(8,62,74); camera.lookAt(0,2,-2);
    camera.fov=42; camera.updateProjectionMatrix();
    const C=[0x3b7fd4,0xd0472f,0x3f9a52,0x8552c4][${PID}]||0xffc93c;
    window.__FLOOD__=(p)=>{window.__ISLAND__.world.props.floodWinner(C,p);
      return {p:window.__ISLAND__.world.props.floodProgress(),
              on:window.__ISLAND__.world.props.victoryFloodActive()};};
    // seed the wave on the winner's own holdings, then hand it back to manual
    try{ window.__ISLAND__.world.props.startVictoryFlood(${PID}); }catch(e){}
    return 1;})()`);
  await sleep(+arg('settle', 1400));
  if (arg('auto', '0') === '1') {
    // The fire-and-forget path: startVictoryFlood() + props.update(dt) only.
    console.log('  start ' + await ev(`(()=>{const p=window.__ISLAND__.world.props;
      p.stopVictoryFlood();
      const secs=p.startVictoryFlood(${PID},{duration:${+arg('dur', 3.0)},hold:2});
      return {secs, on:p.victoryFloodActive()};})()`));
    await sleep(+arg('at', 1500));
    console.log('  at ' + JSON.stringify(await ev(`window.__ISLAND__.world.props.floodProgress()`)));
    await shot(`fl-${TAG}-auto`);
  } else {
    for (const p of PS) {
      console.log('  flood ' + JSON.stringify(await ev(`window.__FLOOD__(${+p})`)));
      await sleep(+arg('gap', 500));
      await shot(`fl-${TAG}-${String(p).replace('.', '')}`);
    }
  }

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
// A frame that was asked for and never written is a hole in the evidence, and
// it used to be one line in the middle of the log. Say it again at the end,
// where the run's verdict is read.
if (shotFailures.length) console.log('  MISSING SHOTS: ' + shotFailures.join(', '));
for (const e of exceptions.slice(0, 8)) console.log('  EXC ' + String(e.text).split('\n')[0].slice(0, 180));
for (const l of warns.slice(0, 10)) console.log('  ' + l.level.toUpperCase() + ' ' + l.text.slice(0, 180));

const reportPath = resolve(OUT, 'report.json');
let prev = {};
try { prev = JSON.parse(readFileSync(reportPath, 'utf8')); } catch { /* first run */ }
prev[STAGE] = { stats: s, exceptions, warnings: warns, missingShots: shotFailures,
  w: W, h: H, at: new Date().toISOString() };
writeFileSync(reportPath, JSON.stringify(prev, null, 2));

ws.close(); chrome.kill('SIGKILL');
process.exit(errs === 0 ? 0 : 1);
