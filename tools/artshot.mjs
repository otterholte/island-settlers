/**
 * Fast art / map capture rig.
 *
 * tools/shoot.mjs launches Chrome with `--run-all-compositor-stages-before-draw`,
 * which makes a single SwiftShader capture cost twenty-odd seconds — too slow to
 * fit an art review inside one short shell call. This rig rides tools/cdp.mjs
 * (same headless shell, no compositor stall) and does two jobs:
 *
 *   node tools/artshot.mjs --what=hex --terrain=fields --tag=x [--only=field-wheat]
 *       one tight single-hex shot, the same framing as shoot.mjs --stage=art
 *
 *   node tools/artshot.mjs --what=map --mode=place-road --tag=x [--w=667 --h=375]
 *       the board map in a placement mode, plus MEASURED pixel sizes for the
 *       settlement target ring, the placed owner pip and the road hit area
 *
 *   node tools/artshot.mjs --what=sweep --terrain=fields
 *       walk the settler item to item across a hex it owns and report whether
 *       the contact sweep still clears it
 *
 * Nothing here is part of the game; it is a review instrument.
 */

import { openChrome, arg, sleep } from './cdp.mjs';

const WHAT = arg('what', 'hex');
const TERRAIN = arg('terrain', 'fields');
const TAG = arg('tag', 'now');
const MODE = arg('mode', 'place-settlement');
const W = +arg('w', 960);
const H = +arg('h', 444);

const cdp = await openChrome({ w: W, h: H, shot: true, port: +arg('port', 5173) });
const { ev, shot, done } = cdp;

await ev(`import('/src/core/rules.js').then(m=>{window.__R__=m}).then(()=>1)`, true);
await ev(`import('/src/board/nodes.js').then(m=>{window.__N__=m}).then(()=>1)`, true);
await ev(`import('/src/board/layout.js').then(m=>{window.__L__=m}).then(()=>1)`, true);

const finishDraft = () => ev(`(()=>{const {state}=window.__ISLAND__,R=window.__R__;
  let g=0;
  while(state.phase==='setup'&&g++<40){
    const pid=R.setupCurrentPlayer(state);
    if(state.setupNeed==='settlement'){
      const L=R.legalSettlements(state,pid,true);
      R.setupPlaceSettlement(state,pid,L[Math.floor(L.length*0.37)]||L[0]);
    } else {
      const L=R.legalRoads(state,pid,true,state.setupAnchor);
      R.setupPlaceRoad(state,pid,L[0]);
    }
  }
  return state.phase;})()`);

/* ------------------------------------------------------------------ one hex */

if (WHAT === 'hex') {
  await finishDraft();
  console.log('  setup ' + await ev(`(()=>{const{state,game,camera}=window.__ISLAND__,R=window.__R__,L=window.__L__;
    // densest hex of the terrain first: a 5-pip fields hex holds 22 items and
    // that is the load the art has to survive
    const cands=L.tiles.filter(x=>x.terrain===${JSON.stringify(TERRAIN)})
      .sort((a,b)=>b.pips-a.pips);
    let t=cands.find(x=>R.playerOwnsTile(state,0,x.id));
    if(!t||t.pips<cands[0].pips) t=null;
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
    game.camera.update=()=>{};
    camera.position.set(t.x+1.0, ${+arg('eye', 11)}, t.z+${+arg('dist', 16)});
    camera.lookAt(t.x, ${+arg('aim', 3.2)}, t.z);
    camera.fov=${+arg('fov', 34)}; camera.updateProjectionMatrix();
    const u=document.getElementById('ui'); if(u)u.style.display='none';
    return 'hex '+t.id+' '+t.terrain+' items='+window.__N__.tileItemsRemaining(t.id)
      +'/'+window.__N__.tileItemCount(t.id);})()`));
  const ONLY = arg('only', '');
  if (ONLY) {
    console.log('  only ' + await ev(`(()=>{const g=window.__ISLAND__.world.props.group;
      let kept=0;g.traverse(o=>{if(o.isMesh){const k=(o.name||'').indexOf(${JSON.stringify(ONLY)})>=0;
        o.visible=k;if(k)kept++;}});return kept;})()`));
  }
  await sleep(+arg('settle', 1500));
  await shot(`art-${TAG}`);
  console.log('  budget ' + JSON.stringify(await ev(`(()=>{const{renderer,world}=window.__ISLAND__;
    return {calls:renderer.info.render.calls,tris:renderer.info.render.triangles,
      propTris:world.props.triangles,propCalls:world.props.drawCalls};})()`)));

/* ------------------------------------------------------------------- sweep */

} else if (WHAT === 'sweep') {
  await finishDraft();
  console.log('  setup ' + await ev(`(()=>{const{state,game}=window.__ISLAND__,R=window.__R__,L=window.__L__;
    const cands=L.tiles.filter(x=>x.terrain===${JSON.stringify(TERRAIN)}).sort((a,b)=>b.pips-a.pips);
    let t=cands.find(x=>R.playerOwnsTile(state,0,x.id));
    if(!t){ outer: for(const c of cands){ for(const corner of c.corners){
      const ph=state.phase; state.phase='setup';
      const ok=R.placeSettlement(state,0,corner,true); state.phase=ph;
      if(ok){ t=c; break outer; } } } }
    if(!t) return 'no hex';
    window.__T__=t;
    state.robberTile=L.DESERT.id; state.robberOwner=0;
    const p=state.players[0];
    p.x=t.x; p.z=t.z+9.5; p.vx=0; p.vz=0; p.action='idle';
    return 'hex '+t.id+' pips='+t.pips+' items='+window.__N__.tileItemCount(t.id);})()`));
  // Walk the settler from item to item exactly the way stage=sweep does, and
  // count the world distance the run costs — that is the "can I still get
  // through it" number the crop size has to answer to.
  console.log('  sweep ' + JSON.stringify(await ev(`(()=>{const{state,game}=window.__ISLAND__;
    const N=window.__N__,R=window.__R__,t=window.__T__,p=state.players[0];
    let got=0,dist=0,steps=0;
    for(let k=0;k<80;k++){
      const it=N.nearestItem(p.x,p.z,{tile:t.id});
      if(!it) break;
      dist+=Math.hypot(it.x-p.x,it.z-p.z);
      p.x=it.x; p.z=it.z; p.sweptAt=-1;
      R.tickWorld(state,1/60); game.gathering.update(1/60); steps++;
      got=N.tileItemCount(t.id)-N.tileItemsRemaining(t.id);
    }
    // seconds at the settler's own run speed
    const spd=(state.players[0].speed||9.5);
    return {full:N.tileItemCount(t.id), taken:got,
      left:N.tileItemsRemaining(t.id), hops:steps,
      pathUnits:+dist.toFixed(1), seconds:+(dist/spd).toFixed(2)};})()`)));
  await ev(`(()=>{for(let i=0;i<120;i++){window.__R__.tickWorld(window.__ISLAND__.state,1/60);
    window.__ISLAND__.game.world.props.update(1/60);}return 1})()`);
  console.log('  field ' + JSON.stringify(await ev(
    `window.__ISLAND__.world.props.field.debug(window.__T__.id)`)));
  // Put the hex back and stand the settler in the middle of it at play pitch:
  // "can I still see myself in there" is the other half of "can I run through".
  await ev(`(()=>{const{state,game,camera}=window.__ISLAND__,t=window.__T__;
    window.__N__.restoreTile(t.id);
    const p=state.players[0];
    p.x=t.x-1.2; p.z=t.z+1.4; p.vx=0; p.vz=0;
    game.avatars[0].group.position.set(p.x,0,p.z);
    game.camera.update=()=>{};
    camera.position.set(t.x-1.2, 8.4, t.z+13.5);
    camera.lookAt(t.x, 2.6, t.z);
    camera.fov=46; camera.updateProjectionMatrix();
    const u=document.getElementById('ui'); if(u)u.style.display='none';
    return 1;})()`);
  await sleep(+arg('settle', 1200));
  await shot(`art-stand-${TERRAIN}`);

/* --------------------------------------------------------------------- map */

} else if (WHAT === 'map') {
  await finishDraft();
  await sleep(200);
  // Give the human something to build from so place-road / place-city have
  // legal targets in every deal.
  // The board map covers the whole viewport, so the 3D scene behind it is
  // invisible — and under SwiftShader it is also the entire cost of a capture.
  // Stubbing the render call takes a screenshot from ~18s to ~2s.
  await ev(`(()=>{window.__ISLAND__.renderer.render=()=>{};return 1})()`);
  console.log('  open ' + await ev(`(()=>{const{state,game}=window.__ISLAND__;
    state.players[0].res={wood:19,brick:19,wool:19,wheat:19,ore:19};
    const ov=game.overview;
    const ok=ov.open(${JSON.stringify(MODE)},{setup:${arg('setup', '1')}===1||${JSON.stringify(arg('setup', '1'))}==='1'});
    for(let i=0;i<8;i++) ov.update(1/60);
    return ok+' targets='+(ov.metrics?ov.metrics.targets:'?');})()`));
  await sleep(700);
  if (arg('sel', '') !== '') {
    console.log('  sel ' + await ev(`(()=>{const ov=window.__ISLAND__.game.overview;
      const m=ov.metrics; ov.select(m.ids[Math.floor(m.ids.length*${+arg('sel', 0.4)})]);
      for(let i=0;i<6;i++) ov.update(1/60); return ov.metrics.sel;})()`));
    await sleep(300);
  }
  console.log('  MEASURE ' + JSON.stringify(await ev(`(()=>{
    const ov=window.__ISLAND__.game.overview;
    if(!ov) return {err:'no overview'};
    const m=ov.metrics;
    if(m) return m;
    // pre-change fallback: replay the formulas the old build painted with
    const s=ov.panInfo.s, HEX=9.0;
    return {legacy:true, s:+s.toFixed(2),
      targetR:+Math.max(6.5,HEX*s*0.21).toFixed(1),
      pipR:+Math.max(11,s*1.05).toFixed(1),
      roadPaintW:+Math.max(7,s*1.0).toFixed(1),
      hitPx:+(2*Math.max(26,HEX*s*0.5)).toFixed(1)};})()`)));
  await sleep(200);
  await shot(`ov-${TAG}`);
}

console.log(`${cdp.exceptions.length} exception(s)`);
for (const e of cdp.exceptions.slice(0, 4)) console.log('  EXC ' + String(e).split('\n')[0].slice(0, 180));
done(0);
