/**
 * Match-flow trace rig.
 *
 *   node tools/flowtrace.mjs --t=countdown|road|knight|flood|camera [--shot=1]
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
 *   knight     the Knight RAISES the full board itself in Knight mode, the
 *              simulation is held still for as long as it is up, and the Knight
 *              lands on the region that was chosen. A rival's Knight must never
 *              open the human's map.
 *   flood      floodProgress() sampled across the win sequence, with the
 *              celebration required to start only once it reads 1 — and then
 *              draining back to 0 once the scoreboard has been dismissed
 *   camera     the post-match review camera: one fixed gesture on every axis,
 *              pointer and keyboard, with the travel it produces printed
 */

/* The Chrome / DevTools plumbing lives in tools/cdp.mjs — this file was over
   the 900-line budget with it inlined, and nothing in it is trace-specific. */
import { openChrome, arg, sleep } from './cdp.mjs';

const W = +arg('w', 960);
const H = +arg('h', 444);
const PORT = +arg('port', 5173);
const TRACE = arg('t', 'countdown');
const SHOT = arg('shot', '0') === '1';

const cdp = await openChrome({
  w: W, h: H, port: PORT, shot: SHOT, out: arg('out', 'progress/shots'),
  chrome: arg('chrome', undefined), libs: arg('libs', undefined)
});
const { send, ev, shot, done, exceptions } = cdp;

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
/**
 * main.js's fixed-step loop, verbatim — including THE BOARD MAP PAUSES THE
 * MATCH: while the overview is open the world, the settler, the gathering and
 * the bots are all skipped and only the flow (and the HUD, which is outside the
 * fixed step) is stepped. A headless page gets almost no rAF, so every trace
 * that needs game time to pass drives it through here.
 */
window.__frame = function(n){
  const st=I().state, g=I().game, R=window.__R__;
  let paused=0;
  for(let i=0;i<n;i++){
    const mapPaused = !!(g.overview && g.overview.isOpen);
    g.flow.update(S);
    if(mapPaused){ paused++; }
    else { R.tickWorld(st,S); g.controller.update(S); g.gathering.update(S); g.bots.update(S); }
    g.hud.update(S);
    if(I().world.props && I().world.props.update) I().world.props.update(S);
    g.overview.update(S); g.panels.update(S);
  }
  return paused;
};
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

const say =(k, v) => console.log(`  ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
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
  await ev('__frame(60*4)');

  /* --- 1. the card lands, and NOBODY touches anything ---------------------
     The player's report was that the board never came up. It now raises
     itself, so this half of the trace makes no gesture at all: the card goes
     into the hand and the frame loop runs, exactly as it would while the
     player is running around. */
  const drew = await ev(`(()=>{
    const I=()=>window.__ISLAND__, st=I().state, g=I().game, p=st.players[0];
    p.cards.push({type:'knight',id:'trace'});
    for(let i=0;i<20;i++) g.hud.update(1/60);       // the cue polls the hand
    const cue=document.querySelector('.kn-cue');
    return { chip: !!cue && !cue.classList.contains('hid'), cls: cue?cue.className:'',
      chipText: cue ? cue.textContent.replace(/\\s+/g,' ').trim() : '',
      autoPending: g.knightCue.autoPending, autoIn: +g.knightCue.autoIn.toFixed(2),
      ovOpen: g.overview.isOpen,
      banner: (document.querySelector('.ann-txt')||{}).textContent };})()`);
  say('on drawing a Knight', drew);
  check('the draw is announced in the centre banner', /knight/i.test(drew.banner || ''),
    `"${drew.banner}"`);
  check('a standing call-to-action appears', drew.chip === true, `"${drew.chipText}"`);
  check('and the board is already on its way up, unasked',
    drew.autoPending === true && drew.ovOpen === false,
    `raising in ${drew.autoIn}s`);
  if (SHOT && arg('at', 'board') === 'cue') { await sleep(250); await shot('fl-knight-cue'); done(); }

  // Run the loop with nothing touched. The board must come up by itself.
  const rise = await ev(`(()=>{
    const I=()=>window.__ISLAND__, g=I().game, st=I().state;
    const t0=st.time; let atStep=-1;
    for(let i=0;i<60*4;i++){ __frame(1); if(atStep<0 && g.overview.isOpen) atStep=i+1; }
    return { atStep, seconds:+(atStep/60).toFixed(2), open:g.overview.isOpen,
      mode:g.overview.mode, clockToRaise:+(st.time-t0).toFixed(2) };})()`);
  say('raised itself after', `${rise.seconds}s of play (step ${rise.atStep})`);
  check('the Knight opens the FULL board with no tap at all',
    rise.open === true && rise.mode === 'place-robber' && rise.atStep > 0,
    `mode=${rise.mode} after ${rise.seconds}s`);

  const open = await ev(`(()=>{
    const I=()=>window.__ISLAND__, g=I().game, L=window.__L__, st=I().state;
    const ov=g.overview;
    // The chosen region: a productive hex the Knight is not already on.
    const want=L.tiles.filter(t=>t.id!==st.robberTile&&t.resource).slice(-1)[0].id;
    window.__want=want;
    const bar=document.querySelector('.ov-bar');
    return { open:ov.isOpen, mode:ov.mode,
      title:(document.querySelector('.ov-title')||{}).textContent,
      hint:(document.querySelector('.ov-hint')||{}).textContent,
      barVisible: !!bar && !bar.classList.contains('hid'),
      targets: (()=>{ let n=0; for(const t of L.tiles) if(t.id!==st.robberTile) n++; return n; })(),
      overviewCam: !!(g.camera && g.camera.isOverview),
      autoRaised: g.knightCue.autoRaised,
      want, robberWas:st.robberTile };})()`);
  say('board opened', open);
  if (SHOT) { await sleep(250); await shot('fl-knight-board'); done(); }
  check('the FULL board opens in Knight mode',
    open.open === true && open.mode === 'place-robber' && open.overviewCam === true,
    `mode=${open.mode} overviewCamera=${open.overviewCam} legalRegions=${open.targets}`);
  check('the instruction is plain', /choose a region to block/i.test(open.hint || ''),
    `"${open.title}" / "${open.hint}"`);

  /* --- 2. and the match STOPS while they think --------------------------- */
  const held = await ev(`(()=>{
    const I=()=>window.__ISLAND__, st=I().state, g=I().game;
    const t0=st.time, a=__pos();
    const bots0=st.players.slice(1).map(p=>p.res.wood+p.res.brick+p.res.ore+p.res.wheat+p.res.wool);
    const paused=__frame(60*3);
    const b=__pos(); let move=0;
    for(let k=0;k<a.length;k++) move=Math.max(move,Math.hypot(b[k][0]-a[k][0],b[k][1]-a[k][1]));
    return { steps:180, pausedSteps:paused, clock:+(st.time-t0).toFixed(6),
      maxMove:+move.toFixed(8), stillOpen:g.overview.isOpen,
      botGain: st.players.slice(1)
        .map((p,i)=>(p.res.wood+p.res.brick+p.res.ore+p.res.wheat+p.res.wool)-bots0[i]) };})()`);
  say('three seconds with the board up', held);
  check('the match is PAUSED while the board is up — the clock does not move',
    held.clock === 0, `state.time advanced ${held.clock}s over ${held.steps} steps`);
  check('nothing on the island moves — player or bot', held.maxMove === 0,
    `largest displacement ${held.maxMove}`);
  check('every fixed step was gated', held.pausedSteps === held.steps,
    `${held.pausedSteps}/${held.steps}`);
  check('and no rival gathered a thing while the player was thinking',
    held.botGain.every(v => v === 0), JSON.stringify(held.botGain));

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
  check('the Knight lands on the region that was chosen',
    landed.robber === landed.want && landed.owner === 0
    && landed.knights.after === landed.knights.before + 1,
    `chose ${landed.want}, Knight is on ${landed.robber}`);
  check('rivals drop what they were carrying',
    landed.rivalsAfter.some((v, i) => v < landed.rivalsBefore[i]),
    `${JSON.stringify(landed.rivalsBefore)} -> ${JSON.stringify(landed.rivalsAfter)}`);
  check('the board is held so the landing can be watched',
    landed.stillUp === true && /knight lands/i.test(landed.title || ''),
    `"${landed.title}"`);

  await sleep(600);
  // The hold is measured in game time, and SwiftShader feeds this loop about a
  // tenth of the frames a phone does — so step it the way main.js does.
  const back = await ev(`(()=>{const I=()=>window.__ISLAND__, g=I().game, st=I().state;
    let held=0; const t0=st.time;
    for(let i=0;i<180&&g.overview.isOpen;i++){ __frame(1); held=i+1; }
    const a=__pos(); __frame(60); const b=__pos(); let move=0;
    for(let k=0;k<a.length;k++) move=Math.max(move,Math.hypot(b[k][0]-a[k][0],b[k][1]-a[k][1]));
    const c=document.querySelector('.kn-cue');
    return { heldSeconds:+(held/60).toFixed(2), open:g.overview.isOpen,
      overviewCam: !!g.camera.isOverview, clockAfter:+(st.time-t0).toFixed(2),
      movedAfter:+move.toFixed(3),
      cls: c?c.className:'(gone)', knightsHeld:g.knightCue.pending,
      autoPending: g.knightCue.autoPending,
      chip: !!document.querySelector('.kn-cue.on') };})()`);
  say('back in play', back);
  check('and then it hands the board back',
    back.open === false && back.overviewCam === false,
    `board held ~${back.heldSeconds}s after Confirm, then closed`);
  check('play resumes — the clock runs and the island moves again',
    back.clockAfter > 0.9 && back.movedAfter > 0,
    `clock +${back.clockAfter}s, largest move ${back.movedAfter}`);
  check('the call-to-action clears once the Knight is spent',
    back.chip === false && back.knightsHeld === 0 && back.autoPending === false,
    `class="${back.cls}"`);

  /* --- 3. the manual routes still work: the chip, and the CARDS sheet ---- */
  const manual = await ev(`(()=>{
    const I=()=>window.__ISLAND__, st=I().state, g=I().game;
    const out={};
    // (a) the standing chip, tapped.
    st.players[0].cards.push({type:'knight',id:'trace-chip'});
    for(let i=0;i<20;i++) g.hud.update(1/60);
    document.querySelector('.kn-cue').click();
    out.chip={open:g.overview.isOpen, mode:g.overview.mode};
    g.overview.close(); __frame(30);
    // (b) the card in the CARDS sheet, tapped.
    g.openCards();
    const card=document.querySelector('.hand .dcard.c-knight');
    out.cardOnScreen=!!card;
    out.cta=card?card.querySelector('.dc-play').textContent:'';
    if(card) card.click();
    out.sheet={open:g.overview.isOpen, mode:g.overview.mode, panel:g.panels.kind};
    g.overview.close(); __frame(30);
    st.players[0].cards=st.players[0].cards.filter(c=>c.type!=='knight');
    for(let i=0;i<20;i++) g.hud.update(1/60);
    return out;})()`);
  say('the two routes a thumb can take', manual);
  check('the KNIGHT READY chip still opens the board when tapped',
    manual.chip.open === true && manual.chip.mode === 'place-robber');
  check('and so does the card in the CARDS sheet',
    manual.cardOnScreen === true && manual.sheet.open === true
    && manual.sheet.mode === 'place-robber' && manual.sheet.panel === null,
    `card says "${manual.cta}"`);

  /* --- 4. a RIVAL's Knight must never take the human's screen ------------ */
  const bot = await ev(`(()=>{
    const I=()=>window.__ISLAND__, st=I().state, g=I().game, R=window.__R__, L=window.__L__;
    g.closeOverview(); __frame(30);
    const rival=st.players[1];
    rival.cards.push({type:'knight',id:'trace-bot'});
    const target=L.tiles.filter(t=>t.id!==st.robberTile)[0].id;
    const ok=R.playKnight(st,1,target);
    let openedOnUs=0;
    for(let i=0;i<60*3;i++){ __frame(1); if(g.overview.isOpen) openedOnUs++; }
    return { played:ok, robber:st.robberTile, target, owner:st.robberOwner,
      openedOnUs, humanKnights:g.knightCue.pending,
      autoPending:g.knightCue.autoPending, ovOpen:g.overview.isOpen };})()`);
  say('a rival plays a Knight', bot);
  check('a bot Knight moves the Knight without opening the human\'s map',
    bot.played === true && bot.robber === bot.target && bot.owner === 1
    && bot.openedOnUs === 0 && bot.autoPending === false,
    `map open on ${bot.openedOnUs} of 180 frames`);
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

  if (SHOT && arg('at', 'mid') === 'cleared') {
    // Run the whole thing out, put the scoreboard away, and photograph the
    // island the player is left reviewing: every hex its own terrain again.
    const st = await ev(`(()=>{
      const S=1/60, I=()=>window.__ISLAND__, R=window.__R__;
      const s=I().state, g=I().game, props=I().world.props;
      for(let i=0;i<60*9;i++){ R.tickWorld(s,S); g.flow.update(S); props.update(S); }
      const btn=[...document.querySelectorAll('.results .rs-foot .btn')]
        .find(b=>/see the board/i.test(b.textContent||''));
      if(btn) btn.click(); else g.panels.hideResults();
      for(let i=0;i<60*4;i++){ g.flow.update(S); props.update(S); g.camera.update(S,s,false); }
      return { flood:+props.floodProgress().toFixed(3), active:props.victoryFloodActive(),
        bar: !!document.querySelector('.endbar:not(.hid)') };})()`);
    say('review state', st);
    await holdFlow(true);
    await sleep(400);
    await shot('fl-flood-cleared');
    done();
  }

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

  /* --- and it comes back off once the score has been seen ---------------- */
  const clear = await ev(`(()=>{
    const S=1/60, I=()=>window.__ISLAND__, R=window.__R__;
    const st=I().state, g=I().game, props=I().world.props;
    const before=+props.floodProgress().toFixed(3);
    // The tap a thumb makes on the scoreboard: SEE THE BOARD.
    const btn=[...document.querySelectorAll('.results .rs-foot .btn')]
      .find(b=>/see the board/i.test(b.textContent||''));
    const how = btn ? 'button' : 'api';
    if(btn) btn.click(); else g.panels.hideResults();
    const samples=[]; let zeroAt=-1;
    for(let i=0;i<60*4;i++){
      R.tickWorld(st,S); g.flow.update(S); props.update(S);
      const p=+props.floodProgress().toFixed(3);
      if(i%12===0) samples.push([+(i/60).toFixed(2), p]);
      if(zeroAt<0 && p<=0.001) zeroAt=+(i/60).toFixed(2);
    }
    return { how, before, samples, zeroAt,
      after:+props.floodProgress().toFixed(3),
      active: props.victoryFloodActive(),
      cleared: g.flow.floodCleared, fading: g.flow.floodFading,
      reviewBar: !!document.querySelector('.endbar:not(.hid)'),
      panel: g.panels.kind };})()`);
  console.log('  t(s)  flood  (after the scoreboard was dismissed)');
  for (const s of clear.samples) console.log(`  ${String(s[0]).padStart(5)}  ${String(s[1]).padStart(5)}`);
  say('dismissed via', clear.how);
  say('flood', `${clear.before} -> ${clear.after}, reached zero at ${clear.zeroAt}s`);
  check('the review bar comes up when the score is put away',
    clear.reviewBar === true && clear.panel === null);
  check('the winner\'s colour drains off rather than snapping',
    clear.samples.filter(s => s[1] > 0.02 && s[1] < 0.98).length >= 3,
    `${clear.samples.filter(s => s[1] > 0.02 && s[1] < 0.98).length} sampled frames mid-fade`);
  check('every hex is its own terrain again once the score has been seen',
    clear.after <= 0.001 && clear.active === false && clear.cleared === true,
    `floodProgress=${clear.after} active=${clear.active}`);

  // And it stays cleared: bringing the score back and putting it away again
  // must not repaint the island.
  const again = await ev(`(()=>{
    const S=1/60, I=()=>window.__ISLAND__, g=I().game, props=I().world.props;
    g.panels.showResults(g.flow.winner);
    for(let i=0;i<30;i++) g.flow.update(S);
    g.panels.hideResults();
    for(let i=0;i<120;i++){ g.flow.update(S); props.update(S); }
    return { p:+props.floodProgress().toFixed(3), active:props.victoryFloodActive() };})()`);
  say('after a second look at the score', again);
  check('and it stays cleared', again.p <= 0.001 && again.active === false);
}

/* ================================================ 5. the review camera */

if (TRACE === 'camera') {
  /* The rates this pass replaced, so the trace prints the comparison rather
     than the reader having to hold two files in their head. */
  const WAS = {
    yawPerPx: 0.0060, pitchPerPx: 0.0042, yawStep: 0.30, pitchStep: 0.13,
    zoomStep: 1.18, keyYaw: 1.60, keyPitch: 0.80,
    wheelGain: 0.0016, wheelCap: 1.2, pinchPower: 1, pinchTwist: 1,
    panGain: 1.0, stepK: 0.65, stepClamp: [16, 90], ease: 9.0
  };

  say('draft', await ev('__draftUI(45)'));
  await ev('__frame(60*5)');
  await ev(`(()=>{
    const I=()=>window.__ISLAND__, R=window.__R__, st=I().state, p=st.players[0];
    for(let k=0;k<16;k++){const L=R.legalRoads(st,0);if(!L.length)break;R.placeRoad(st,0,L[0],true);}
    for(let k=0;k<5;k++){const L=R.legalSettlements(st,0);if(!L.length)break;R.placeSettlement(st,0,L[0],true);}
    [...p.settlements].slice(0,5).forEach(i=>R.upgradeCity(st,0,i,true));
    while(R.scoreOf(st,p) < 13 && p.vpCards < 14) p.vpCards++;
    R.checkVictory(st); return st.phase;})()`);
  // Run the whole win sequence out, then put the scoreboard away — which is
  // the only thing that ever hands the camera to the player.
  /* THE SCOREBOARD NO LONGER ARMS THIS. Dismissing the score lands on the
     WALKING review — settler live, invisible joystick, follow camera, free
     camera deliberately down (see hud-end.js). The free camera is the OTHER
     review, and BOARD VIEW is what asks for it, so that is what this presses.
     `uishot --stage=results` owns the walking half and the never-both check;
     everything below is about the camera the board view hands over. */
  const armed = await ev(`(()=>{
    const S=1/60, I=()=>window.__ISLAND__, R=window.__R__, g=I().game, st=I().state;
    for(let i=0;i<60*9;i++){ R.tickWorld(st,S); g.flow.update(S); I().world.props.update(S); }
    const btn=[...document.querySelectorAll('.results .rs-foot .btn')]
      .find(b=>/see the board/i.test(b.textContent||''));
    if(btn) btn.click(); else g.panels.hideResults();
    const walk = { roaming: !!g.roaming, freecam: !!(g.freecam && g.freecam.armed) };
    const bv=[...document.querySelectorAll('.endbar .btn')]
      .find(b=>/board view/i.test(b.textContent||''));
    if(bv) bv.click();
    for(let i=0;i<20;i++){ g.flow.update(S); g.camera.update(S, st, false); }
    return { walk, freecam: !!g.freecam && g.freecam.armed, mode: g.freecam && g.freecam.mode,
      free: g.camera.freeLook, roaming: !!g.roaming,
      hint: !!document.querySelector('.fcam-hint:not(.hid)'),
      info: g.camera.freeInfo };})()`);
  say('after the scoreboard', armed);
  check('the score comes down on the walking review, not on the camera',
    armed.walk.roaming === true && armed.walk.freecam === false);
  check('and BOARD VIEW hands the camera over instead',
    armed.freecam === true && armed.free === true
    && armed.mode === 'board' && armed.roaming === false && armed.hint === true);

  const rates = await ev(`({ ...window.__ISLAND__.game.freecam.rates,
    ...window.__ISLAND__.game.camera.freeRates })`);

  if (SHOT) {
    // What one unhurried gesture buys: a slow orbit and a notch of zoom in,
    // then hold and photograph what the player is left looking at.
    await ev(`(()=>{const I=()=>window.__ISLAND__, c=I().game.camera, r=I().game.freecam.rates;
      // Let the flood drain first — the review state is the cleared island.
      for(let i=0;i<180;i++){ I().game.flow.update(1/60); I().world.props.update(1/60);
        c.update(1/60, I().state, false); }
      for(let i=0;i<40;i++) c.freeTurn(-r.yawPerPx*6, -r.pitchPerPx*3);
      c.freeZoom(1/r.zoomStep);
      for(let i=0;i<90;i++){ I().game.flow.update(1/60); c.update(1/60, I().state, false); }
      return { cam:c.freeInfo, flood:I().world.props.floodProgress() };})()`);
    await holdFlow(true);
    await sleep(400);
    await shot('fl-review-camera');
    done();
  }

  /* One fixed gesture per axis, measured through the REAL driver. */
  const V = await ev('({w:innerWidth,h:innerHeight})');
  const px = (x, y) => ({ x: Math.round(V.w * x), y: Math.round(V.h * y) });
  const A = px(0.32, 0.34), B = px(0.62, 0.34);      // a 30%-of-width drag right

  const snap = () => ev('window.__ISLAND__.game.camera.freeInfo');
  const step = n => ev(`(()=>{const I=()=>window.__ISLAND__;
    for(let i=0;i<${n};i++) I().game.camera.update(1/60, I().state, false); return 1;})()`);

  async function drag(shift) {
    const mods = shift ? 8 : 0;
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: A.x, y: A.y, button: 'left', clickCount: 1, buttons: 1, modifiers: mods });
    for (let i = 1; i <= 6; i++) {
      await send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', buttons: 1, modifiers: mods,
        x: Math.round(A.x + (B.x - A.x) * i / 6), y: A.y
      });
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: B.x, y: A.y, button: 'left', clickCount: 1, buttons: 0, modifiers: mods });
  }

  const measured = {};
  const dx = B.x - A.x;

  let a = await snap();
  await drag(false);
  await step(6);
  let b = await snap();
  measured.panPerDrag = +Math.hypot(b.x - a.x, b.z - a.z).toFixed(3);

  a = await snap();
  await drag(true);
  await step(6);
  b = await snap();
  measured.yawPerDrag = +Math.abs(b.yaw - a.yaw).toFixed(4);

  // Wheel: one full notch of a desktop mouse.
  a = await snap();
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: A.x, y: A.y, deltaX: 0, deltaY: 120 });
  await step(40);
  b = await snap();
  measured.zoomPerNotch = +(b.dist / a.dist).toFixed(4);

  // The on-screen pad: one press of TURN RIGHT and one of ZOOM IN.
  const padPress = async label => {
    const p = await ev(`(()=>{const b=[...document.querySelectorAll('.fcam b.fcam-k')]
      .find(b=>b.getAttribute('aria-label')==='${label}'); if(!b) return null;
      const r=b.getBoundingClientRect(); return {x:(r.left+r.width/2)|0,y:(r.top+r.height/2)|0};})()`);
    if (!p) return false;
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1, buttons: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1, buttons: 0 });
    return true;
  };
  a = await snap();
  await padPress('Turn right');
  await step(6);
  b = await snap();
  measured.yawPerPadPress = +Math.abs(b.yaw - a.yaw).toFixed(4);

  /* The keyboard. freecam's own key loop runs on requestAnimationFrame, which a
     headless page barely gets, so a held key is played back exactly the way that
     loop plays it: one second of fixed steps at the tuned rate. */
  const kb = await ev(`(()=>{
    const I=()=>window.__ISLAND__, c=I().game.camera, r=I().game.freecam.rates;
    const a=c.freeInfo;
    for(let i=0;i<60;i++) c.freeStep(0,1,1/60);          // one second of D held
    const b=c.freeInfo;
    for(let i=0;i<60;i++) c.freeTurn(r.keyYaw/60,0);     // one second of E held
    const d=c.freeInfo;
    return { panPerSec:+Math.hypot(b.x-a.x,b.z-a.z).toFixed(2),
      yawPerSec:+Math.abs(d.yaw-b.yaw).toFixed(3) };})()`);
  Object.assign(measured, kb);

  console.log('  axis                     before          after');
  const row = (lab, was, now) =>
    console.log(`  ${lab.padEnd(24)} ${String(was).padEnd(15)} ${now}`);
  row('orbit drag, yaw', WAS.yawPerPx + ' rad/px', rates.yawPerPx + ' rad/px');
  row('orbit drag, pitch', WAS.pitchPerPx + ' rad/px', rates.pitchPerPx + ' rad/px');
  row('pan drag', WAS.panGain + 'x ground', rates.panGain + 'x ground');
  row('pad turn press', WAS.yawStep + ' rad', rates.yawStep + ' rad');
  row('pad tilt press', WAS.pitchStep + ' rad', rates.pitchStep + ' rad');
  row('zoom press', 'x' + WAS.zoomStep, 'x' + rates.zoomStep);
  row('wheel gain / cap', WAS.wheelGain + ' / ' + WAS.wheelCap, rates.wheelGain + ' / ' + rates.wheelCap);
  row('pinch power / twist', WAS.pinchPower + ' / ' + WAS.pinchTwist, rates.pinchPower + ' / ' + rates.pinchTwist);
  row('Q E held', WAS.keyYaw + ' rad/s', rates.keyYaw + ' rad/s');
  row('R F held', WAS.keyPitch + ' rad/s', rates.keyPitch + ' rad/s');
  row('WASD held', WAS.stepK + ' x dist ' + JSON.stringify(WAS.stepClamp),
    rates.stepK + ' x dist ' + JSON.stringify(rates.stepClamp));
  row('pose ease', WAS.ease + '/s', rates.ease + '/s');
  say('measured through the real driver', measured);
  say('gesture', `${dx}px drag, one 120-unit wheel notch, one pad press, 1s of key`);

  const slower = k => rates[k] < WAS[k];
  check('every pointer axis is slower than it was',
    slower('yawPerPx') && slower('pitchPerPx') && slower('zoomStep')
    && slower('wheelGain') && slower('wheelCap') && slower('panGain'),
    `yaw ${(WAS.yawPerPx / rates.yawPerPx).toFixed(2)}x, pan ${(WAS.panGain / rates.panGain).toFixed(2)}x slower`);
  check('every keyboard axis is slower than it was',
    slower('keyYaw') && slower('keyPitch') && slower('stepK'),
    `Q/E ${(WAS.keyYaw / rates.keyYaw).toFixed(2)}x, WASD ${(WAS.stepK / rates.stepK).toFixed(2)}x slower`);
  /* The on-screen pad is deliberately gone — every key on it duplicated a
     gesture the player already had and it covered the corner of the board it
     was there to help inspect. `yawPerPadPress` is kept in the table as a
     zero, because a rig that stops measuring a thing it removed cannot notice
     the thing coming back. It is not part of this bar. */
  check('and every gesture still MOVES the camera',
    measured.panPerDrag > 0.5 && measured.yawPerDrag > 0.01
    && measured.zoomPerNotch !== 1
    && measured.panPerSec > 1 && measured.yawPerSec > 0.1,
    JSON.stringify(measured));
  check('and the LOOK pad is still gone', measured.yawPerPadPress === 0,
    `pad presses moved the yaw by ${measured.yawPerPadPress}`);

  /* Which way the ground goes. The rates above say how FAR a drag travels and
     never said which way it went, which is how the vertical axis shipped
     inverted: a downward drag pushed the island up and away. `uishot
     --stage=results` owns the full four-way assertion; this is the sign. */
  const dir = await ev(`(()=>{const c=window.__ISLAND__.game.camera;
    const a=c.freeInfo;
    c.freeDrag(0, 100, innerHeight);          // finger down 100px
    const b=c.freeInfo;
    const f={x:-Math.sin(a.yaw), z:-Math.cos(a.yaw)};
    return +(((b.x-a.x)*f.x+(b.z-a.z)*f.z)).toFixed(2);})()`);
  check('a downward drag brings the ground DOWN after the finger', dir > 0.5,
    `focus travelled ${dir} along the axis away from the camera`);

  /* The clamps are untouched: push far past every edge and stop at it. */
  const clamped = await ev(`(()=>{
    const I=()=>window.__ISLAND__, c=I().game.camera;
    for(let i=0;i<400;i++) c.freeStep(1,1,1/60);
    const far=c.freeInfo;
    for(let i=0;i<200;i++) c.freeTurn(0,0.2);
    const hi=c.freeInfo;
    for(let i=0;i<200;i++) c.freeTurn(0,-0.2);
    const lo=c.freeInfo;
    for(let i=0;i<80;i++){ c.freeZoom(1.3); c.update(1/60,I().state,false); }
    const out=c.freeInfo;
    for(let i=0;i<120;i++){ c.freeZoom(0.7); c.update(1/60,I().state,false); }
    const inn=c.freeInfo;
    return { range:far.r, rangeMax:far.range, farLimit:far.limit,
      pitchHi:hi.pitch, pitchLo:lo.pitch, pitchRange:hi.pitchRange,
      distOut:out.dist, distIn:inn.dist, distRange:out.distRange,
      limits:[far.limit,hi.limit,lo.limit,out.limit,inn.limit] };})()`);
  say('pushed past every edge', clamped);
  check('the clamps still hold — range, pitch and distance',
    clamped.range <= clamped.rangeMax + 0.01
    && clamped.pitchHi <= clamped.pitchRange[1] + 1e-6
    && clamped.pitchLo >= clamped.pitchRange[0] - 1e-6
    && clamped.distOut <= clamped.distRange[1] + 0.02
    && clamped.distIn >= clamped.distRange[0] - 0.02,
    JSON.stringify(clamped.limits));

}

/* ============================================== 6. results panel (probe) */

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

done(pass ? 0 : 1);
