/**
 * The practice run's capture and measurement rig.
 *
 *   node tools/tutshot.mjs                       [--w=667] [--h=375]
 *   node tools/tutshot.mjs --w=640 --h=320
 *   node tools/tutshot.mjs --shots=1,3,7,9,11    (which steps get a PNG)
 *
 * Built on the CDP boilerplate in tools/uishot.mjs — same launch flags, same
 * websocket plumbing, same `ev()` — but it does not photograph and hope. The
 * owner's notes about this screen are almost all geometric ("at the top middle
 * of the screen", "switch the tutorial to the bottom", "don't ever cover the
 * build, pause and map buttons — they shouldn't overlap at all"), so the run is
 * walked step by step and every one of those is arithmetic on rectangles read
 * out of the live DOM:
 *
 *   PLACE      the badge is centred and in the top band on steps 1-6 and on the
 *              two road steps, and in the bottom band from step 7 on.
 *   CLEARANCE  the badge's rectangle does not intersect `.hud-bc` (the four
 *              build cards) or `.hud-br` (pause / map / build) at ANY step, in
 *              any of its three sizes, at either shipping viewport.
 *   WARDROBE   the clock and the two award rows are gone the whole way through
 *              until the awards step; the pack is hidden for the opening
 *              lesson, back for step 7, gone again for the road, back after;
 *              the standings are only up where the script asks for them.
 *   CONTROLS   BACK and NEXT really move, and pressing the REAL build key —
 *              a mouse event at its real coordinates, not `.click()` — is what
 *              carries the road step forward.
 *   THE WASH   the spotlight canvas is dark at a point off the player's land
 *              and clear over the hex the step is teaching on, read back out of
 *              the canvas rather than eyeballed.
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

const W = +arg('w', 667);
const H = +arg('h', 375);
const OUT = resolve(ROOT, arg('out', 'progress/tut'));
const PORT = +arg('port', 5173);
const TAG = arg('tag', `${W}x${H}`);
const SHOT = arg('shot', '1') === '1';
const SHOTS = new Set(arg('shots', '1,2,3,4,7,8,9,10,11,13,16,17,21,22')
  .split(',').map(s => +s.trim()).filter(Boolean));
const CHROME = arg('chrome', '/tmp/chrome-headless-shell-linux64/chrome-headless-shell');
const LIBS = arg('libs', '/tmp/xlibs/root/usr/lib/x86_64-linux-gnu');

mkdirSync(OUT, { recursive: true });
if (!existsSync(CHROME)) { console.error(`no chrome at ${CHROME}`); process.exit(2); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

const DP = 9700 + Math.floor(Math.random() * 500);
const chrome = spawn(CHROME, [
  '--headless', '--no-sandbox', '--disable-dev-shm-usage',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--disable-new-content-rendering-timeout', '--hide-scrollbars', '--mute-audio',
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
});
const send = (method, params = {}) => new Promise(res => {
  const id = ++msgId;
  pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); res({ __err: 'timeout' }); } }, 180000);
});
const ev = async (expr, awaitPromise = false) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
  if (r?.exceptionDetails) {
    return { __err: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
  }
  return r?.result?.value;
};
const shot = async name => {
  if (!SHOT) return;
  const r = await send('Page.captureScreenshot', { format: 'png' });
  if (!r?.data) { console.log(`  shot ${name} FAILED`); return; }
  writeFileSync(resolve(OUT, `${name}.png`), Buffer.from(r.data, 'base64'));
};

/** A real finger: press and release at real coordinates, hit-tested by Chrome. */
async function tap(x, y) {
  await send('Input.dispatchMouseEvent',
    { type: 'mousePressed', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, buttons: 1 });
  await send('Input.dispatchMouseEvent',
    { type: 'mouseReleased', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, buttons: 0 });
}
async function tapSel(sel) {
  const box = await ev(`(()=>{const n=document.querySelector(${JSON.stringify(sel)});
    if(!n)return null;const r=n.getBoundingClientRect();
    if(r.width<2||r.height<2)return null;
    return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
  if (!box) return false;
  await tap(box.x, box.y);
  await sleep(240);
  return true;
}

/*
 * MEASURING THROUGH AN ANIMATION IS MEASURING THE PREVIOUS STEP.
 *
 * SwiftShader builds this scene on the main thread, and a frame here can take
 * over a second. Two things in this interface are therefore unreadable on a
 * wall clock: every wardrobe rule is a 280ms opacity transition, whose computed
 * value only advances when a frame runs, and the gold ring is placed from the
 * tutorial's own requestAnimationFrame tick. Sleeping does not help — the page
 * simply is not painting.
 *
 * So the rig does two things and neither of them is a guess. Transitions are
 * switched off outright, so a class landing is a computed style landing in the
 * same turn; and `frames(n)` waits for n REAL animation frames however long
 * they take, which is the only honest way to say "the tutorial has ticked".
 */
const NO_MOTION = `(()=>{
  if(document.getElementById('tutshot-still'))return 'already';
  const s=document.createElement('style');
  s.id='tutshot-still';
  s.textContent='*,*::before,*::after{transition-duration:0s !important;'+
    'transition-delay:0s !important}';
  document.head.appendChild(s); return 'stilled';})()`;

const frames = (n = 4) => ev(
  `new Promise(r=>{let i=0;const f=()=>{if(++i>=${n})return r(1);requestAnimationFrame(f);};`
  + `requestAnimationFrame(f);})`, true);

async function settle(n = 3) { await frames(n); await sleep(80); }

await send('Page.enable'); await send('Runtime.enable');
const T0 = Date.now();
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });

let booted = false;
for (let i = 0; i < 120; i++) {
  if (await ev('!!(window.__ISLAND__&&window.__ISLAND__.state)') === true) { booted = true; break; }
  await sleep(250);
}
if (!booted) { console.error('GAME DID NOT BOOT\n' + chromeErr.slice(-400)); ws.close(); chrome.kill('SIGKILL'); process.exit(1); }
console.log(`booted ${W}x${H} in ${((Date.now() - T0) / 1000).toFixed(1)}s`);

for (let i = 0; i < 60; i++) {
  const on = await ev(`(()=>{const n=document.querySelector('.mf-intro');
    return !!(n&&n.classList.contains('on'));})()`);
  if (on === true) break;
  await sleep(250);
}
await sleep(400);

/* The route a player really takes: TUTORIAL on the opening screen, then
   PRACTICE RUN in the book. Nothing here calls startPractice() directly. */
await tapSel('.mf-tut');
await sleep(500);
await tapSel('.tut-route.play');
await sleep(1100);
console.log('  STILL ' + await ev(NO_MOTION));
await settle(4);

console.log('  ENTRY ' + JSON.stringify(await ev(`(()=>{const t=window.__ISLAND__.game.tutorial;
  const row=document.querySelector('.build-row');
  return {running:t.running, step:t.step, of:t.stepCount, phase:t.phase,
    practiceClass:document.getElementById('ui').classList.contains('tut-practice'),
    buildCardsCollapsedAtTheStart:!!(row&&row.classList.contains('hid'))};})()`)));

/* ------------------------------------------------------------ measurement */

/** Every rectangle the owner's notes are about, plus the overlap arithmetic. */
const MEASURE = `(()=>{
  const R=s=>{const n=document.querySelector(s);if(!n)return null;
    const r=n.getBoundingClientRect();
    return {x:+r.left.toFixed(1),y:+r.top.toFixed(1),
      w:+r.width.toFixed(1),h:+r.height.toFixed(1),
      right:+r.right.toFixed(1),bottom:+r.bottom.toFixed(1)};};
  const shown=s=>{const n=document.querySelector(s);if(!n)return false;
    const cs=getComputedStyle(n);
    if(cs.display==='none'||cs.visibility==='hidden')return false;
    if(parseFloat(cs.opacity)<0.05)return false;
    const r=n.getBoundingClientRect();
    return r.width>2&&r.height>2;};
  const hit=(a,b)=>!!(a&&b)&&!(a.right<=b.x||b.right<=a.x||a.bottom<=b.y||b.bottom<=a.y);
  const t=window.__ISLAND__.game.tutorial;
  const card=R('.coach-card'), bc=R('.hud-bc'), br=R('.hud-br'),
        tl=R('.hud-tl'), tr=R('.hud-tr'), tc=R('.hud-tc');
  const cardUp=shown('.coach-card');
  const cls=(document.querySelector('.coach-card')||{className:''}).className;
  const out={
    vw:innerWidth, vh:innerHeight,
    n:t.stepIndex+1, id:t.step, of:t.stepCount, phase:t.phase,
    size:/\\bgone\\b/.test(cls)?'gone':(/\\bslim\\b/.test(cls)?'slim':'big'),
    place:/at-top/.test(cls)?'top':(/at-low/.test(cls)?'low':'bottom'),
    head:(document.querySelector('.coach-h')||{}).textContent,
    text:((document.querySelector('.coach-t')||{}).textContent||'').slice(0,150),
    keys:[...document.querySelectorAll('.coach-acts .btn')].map(b=>
      (b.textContent||'').trim()+(b.disabled?'(off)':'')),
    card:cardUp?card:null,
    clock:shown('.timechip'), awards:shown('.sc-awards'),
    pack:shown('.hud-tc'), ranks:shown('.hud-tr'), buildCards:shown('.hud-bc'),
    keysRow:shown('.hud-br'),
    ring:shown('.coach-mark.on'), ringBox:R('.coach-mark'),
    wash:shown('.tut-spot')&&!!window.__ISLAND__.game.tutorial,
    scrollW:document.documentElement.scrollWidth,
    scrollH:document.documentElement.scrollHeight
  };
  if(cardUp&&card){
    out.hitsBuildCards = shown('.hud-bc') && hit(card,bc);
    out.hitsKeys       = shown('.hud-br') && hit(card,br);
    out.hitsScoreboard = hit(card,tl);
    out.hitsStandings  = shown('.hud-tr') && hit(card,tr);
    out.onScreen = card.y>=-1 && card.x>=-1 && card.right<=innerWidth+1
                   && card.bottom<=innerHeight+1;
    out.centred = Math.abs((card.x+card.right)/2 - innerWidth/2) < 3;
    out.gapToBuildCards = shown('.hud-bc') ? +(bc.y-card.bottom).toFixed(1) : null;
    out.gapToKeys       = shown('.hud-br') ? +(br.y-card.bottom).toFixed(1) : null;
  } else { out.hitsBuildCards=false; out.hitsKeys=false; out.hitsScoreboard=false;
           out.hitsStandings=false; out.onScreen=true; out.centred=true; }
  return out;})()`;

/** `Runtime.evaluate` on a heavily loaded box can come back empty; ask again
    rather than letting one dropped reply take the whole run down. */
async function measure() {
  for (let i = 0; i < 4; i++) {
    const m = await ev(MEASURE);
    if (m && typeof m === 'object' && m.id) return m;
    await sleep(500);
  }
  throw new Error('the page never answered a measurement');
}

/* ------------------------------------------------------------- the walk
   Every step, in order, driven by the tutorial's own test hooks. A step with a
   large explain phase is measured TWICE — once big, once after OK — because
   the owner asked for exactly that pair and both halves have to fit. */

const rows = [];
const N = await ev('window.__ISLAND__.game.tutorial.stepCount');
async function walk(into, tag) {
  for (let i = 0; i < N; i++) {
    await ev(`window.__ISLAND__.game.tutorial.goTo(${i})`);
    await settle();
    const m = await measure();
    into.push(m);
    const brief = m.phase === 'brief';
    if (tag && SHOTS.has(i + 1)) {
      await shot(`step-${String(i + 1).padStart(2, '0')}${brief ? '-brief' : ''}-${tag}`);
    }
    if (brief) {
      await ev('window.__ISLAND__.game.tutorial.ok()');
      await settle(4);
      const m2 = await measure();
      into.push(m2);
      if (tag && SHOTS.has(i + 1)) {
        await shot(`step-${String(i + 1).padStart(2, '0')}-after-ok-${tag}`);
      }
    }
  }
}
await walk(rows, null);

for (const r of rows) {
  console.log(`  ${String(r.n).padStart(2)}/${r.of} ${r.phase === 'brief' ? 'BRIEF' : '     '} `
    + `${r.id.padEnd(10)} ${r.size.padEnd(4)} ${r.place.padEnd(6)} `
    + `card=${r.card ? `${r.card.x},${r.card.y} ${r.card.w}x${r.card.h}` : '\u2014'} `
    + `pack=${r.pack ? 'on ' : 'off'} ranks=${r.ranks ? 'on ' : 'off'} `
    + `awards=${r.awards ? 'on ' : 'off'} clock=${r.clock ? 'on' : 'off'} `
    + `build=${r.buildCards ? 'on ' : 'off'} ring=${r.ring ? 'on ' : 'off'} `
    + `gapBC=${r.gapToBuildCards === null || r.gapToBuildCards === undefined ? '\u2014' : r.gapToBuildCards} `
    + `gapBR=${r.gapToKeys === null || r.gapToKeys === undefined ? '\u2014' : r.gapToKeys}`);
}

/* ------------------------------------------- the real BUILD key carries a step
 *
 *   "Have the build button start as collapsed, since I haven't explained it in
 *    the tutorial yet."
 *   "Force them to actually press a button to build a road to automatically
 *    move to the next step."
 *
 * Two presses, both real. BUILD on step 8 is also the proof that the cards
 * started shut — there is nothing on the bottom of the screen to press until
 * this key is pressed — and the ROAD card on step 9 is the press that opens the
 * placement map and ends that step.
 */
await ev('window.__ISLAND__.game.tutorial.goTo(7)');
await settle();
const beforeBuild = await ev(`(()=>{const t=window.__ISLAND__.game.tutorial;
  const row=document.querySelector('.build-row');
  return {step:t.stepIndex, collapsed:!!(row&&row.classList.contains('hid'))};})()`);
await tapSel('.hud-br .cbtn.gold');
await frames(5); await sleep(200);
const afterBuild = await ev(`(()=>{const t=window.__ISLAND__.game.tutorial;
  const row=document.querySelector('.build-row');
  return {stepNow:t.stepIndex, id:t.step, phase:t.phase,
    collapsedNow:!!(row&&row.classList.contains('hid'))};})()`);
await settle();
await shot(`step-09-brief-${TAG}`);
await ev('window.__ISLAND__.game.tutorial.ok()');
await settle(4);
const armed = await measure();
await shot(`step-09-armed-${TAG}`);
await tapSel('.bcard[data-kind="road"]');
await frames(5); await sleep(200);
const afterRoad = await ev(`(()=>{const t=window.__ISLAND__.game.tutorial;
  const ov=window.__ISLAND__.game.overview;
  return {step:t.stepIndex, id:t.step,
    mapOpen:!!(ov&&ov.isOpen), mode:ov?ov.mode:null,
    badgeHidden:!document.querySelector('.coach-card:not(.gone)'),
    say:((document.querySelector('.ovb-say')||{}).textContent||'').trim()};})()`);
await shot(`step-10-on-the-map-${TAG}`);
console.log('  BUILDKEY ' + JSON.stringify({
  ...beforeBuild, ...afterBuild, road: afterRoad,
  theCardsWereShutUntilBuildWasPressed: beforeBuild.collapsed === true
    && afterBuild.collapsedNow === false,
  pressingBuildCarriedTheStep: afterBuild.stepNow === beforeBuild.step + 1,
  theRoadStepOpensBigThenGoesSlim: armed.size === 'slim' && armed.place === 'top',
  andLeavesTheRingOnTheRoadCard: armed.ring === true,
  theRoadCardOpensThePlacementMap: afterRoad.mapOpen === true
    && afterRoad.mode === 'place-road',
  andTheBadgeGetsCompletelyOutOfTheMapsWay: afterRoad.badgeHidden === true
}));
await ev(`(()=>{const g=window.__ISLAND__.game;
  if(g.overview&&g.overview.isOpen)g.closeOverview();return 1})()`);
await frames(4);

/* ---------------------------------------------- the walk again, cards open
 *
 *   "But don't ever cover the build, pause and map buttons. They shouldn't
 *    overlap at all."
 *
 * The first walk ran with the four build cards still shut, which is the state
 * the run really starts in — and it means the overlap test against `.hud-bc`
 * had nothing to overlap. So the whole run is walked a SECOND time with the
 * cards up, which is what every step from 8 onward actually looks like, and the
 * clearance arithmetic below is done on this pass. The photographs come from
 * here too, for the same reason.
 */
const open = [];
await walk(open, TAG);
for (const r of open) {
  console.log(`  ${String(r.n).padStart(2)}/${r.of} ${r.phase === 'brief' ? 'BRIEF' : '     '} `
    + `${r.id.padEnd(10)} ${r.size.padEnd(4)} ${r.place.padEnd(6)} `
    + `card=${r.card ? `${r.card.x},${r.card.y} ${r.card.w}x${r.card.h}` : '-'} `
    + `build=${r.buildCards ? 'on ' : 'off'} ring=${r.ring ? 'on ' : 'off'} `
    + `gapBC=${r.gapToBuildCards === null || r.gapToBuildCards === undefined ? '-' : r.gapToBuildCards} `
    + `gapBR=${r.gapToKeys === null || r.gapToKeys === undefined ? '-' : r.gapToKeys}`);
}

/* ------------------------------------------------------------- assertions
   `rows` is the first walk, with the four build cards still shut — the state
   the run genuinely starts in, and the pass the WARDROBE is judged on. `open`
   is the second walk, with the cards up, and it is the only pass in which
   there is anything for the badge to overlap, so the CLEARANCE arithmetic and
   the gold ring are judged on that one.

   Step 8 does not appear in the second walk at all, and that is correct: its
   whole test is "are the build cards open yet", and by then they are, so it
   completes the instant it is opened. */

const at = n => rows.find(r => r.n === n && r.phase !== 'brief');
const atOpen = n => open.find(r => r.n === n && r.phase !== 'brief');
const body = rows.filter(r => r.phase !== 'brief');
const TOP_STEPS = [1, 2, 3, 4, 5, 6, 9, 10];
const PACK_OFF = [1, 2, 3, 4, 5, 6, 9, 10];
const PACK_ON = [7, 8, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22];

console.log('  PLACE ' + JSON.stringify({
  theBadgeIsTopCentreForTheOpeningLesson:
    TOP_STEPS.every(n => at(n) && at(n).place === 'top'
      && at(n).card && at(n).card.y < at(n).vh * 0.45),
  andCentredOnTheScreen: rows.every(r => r.centred) && open.every(r => r.centred),
  itMovesToTheBottomAtStepSeven:
    !!at(7) && at(7).place !== 'top' && at(7).card.bottom > at(7).vh * 0.5,
  andComesBackToTheTopToBuildARoad:
    !!at(9) && at(9).place === 'top' && !!at(10) && at(10).place === 'top',
  stepElevenSitsLowestOfAll: !!at(11) && at(11).place === 'low',
  everyBadgeIsFullyOnScreen: rows.every(r => r.onScreen) && open.every(r => r.onScreen),
  andNothingScrollsAnywhere: open.every(r => r.scrollW <= r.vw && r.scrollH <= r.vh)
}));

const num = v => (v === null || v === undefined ? 999 : v);
const overBuild = open.filter(r => r.hitsBuildCards).map(r => r.n);
const overKeys = open.filter(r => r.hitsKeys).map(r => r.n);
const overScore = open.filter(r => r.hitsScoreboard).map(r => r.n);
const overRanks = open.filter(r => r.hitsStandings).map(r => r.n);
console.log('  CLEARANCE ' + JSON.stringify({
  theOwnersOwnRule_neverOverBuildPauseOrMap:
    overBuild.length === 0 && overKeys.length === 0,
  neverOverTheBuildCards: overBuild.length === 0,
  neverOverThePauseMapAndBuildKeys: overKeys.length === 0,
  neverOverTheScoreboard: overScore.length === 0,
  neverOverTheStandings: overRanks.length === 0,
  offendingSteps: { build: overBuild, keys: overKeys, score: overScore, ranks: overRanks },
  stepsMeasuredAgainstTheBuildCards: open.filter(r => r.buildCards).length,
  tightestGapToTheBuildCards: Math.min(...open.map(r => num(r.gapToBuildCards))),
  tightestGapToTheThreeKeys: Math.min(...open.map(r => num(r.gapToKeys)))
}));

console.log('  WARDROBE ' + JSON.stringify({
  theClockIsGoneForTheWholeRun: body.every(r => r.clock === false),
  theTwoAwardsAreHiddenUntilTheirOwnStep:
    body.filter(r => r.awards).map(r => r.n).join(',') === '21,22',
  thePackIsHiddenForTheOpeningLesson: PACK_OFF.every(n => at(n) && at(n).pack === false),
  thePackIsBackFromStepSevenOn: PACK_ON.every(n => at(n) && at(n).pack === true),
  theStandingsOnlyShowWhereTheScriptAsks:
    body.filter(r => r.ranks).map(r => r.n).join(',') === '11,18,19,20,21,22',
  theBuildCardsAreHiddenAtStepEleven: !!atOpen(11) && atOpen(11).buildCards === false,
  andForTheClosingCardToo: !!atOpen(22) && atOpen(22).buildCards === false,
  andTheyStayShutForTheWholeFirstWalk: rows.every(r => r.buildCards === false),
  stepsWithTheStandingsUp: body.filter(r => r.ranks).map(r => r.n),
  stepsWithTheAwardsUp: body.filter(r => r.awards).map(r => r.n),
  stepsWithThePackUp: body.filter(r => r.pack).map(r => r.n),
  stepsWithTheBuildCardsUp: open.filter(r => r.buildCards).map(r => r.n)
}));

const bodyOpen = open.filter(r => r.phase !== 'brief');
console.log('  RING ' + JSON.stringify({
  stepsWithAGoldRing: bodyOpen.filter(r => r.ring).map(r => r.n),
  itIsOnTheBuildCardsForEveryBuildStep:
    [12, 13, 14, 17].every(n => atOpen(n) && atOpen(n).ring === true),
  itIsOnTheAwardsForTheAwardsStep: !!atOpen(21) && atOpen(21).ring === true,
  ringDiametersSeen: [...new Set(bodyOpen.filter(r => r.ring && r.ringBox)
    .map(r => Math.round(r.ringBox.w)))].sort((a, b) => a - b)
}));

/* ---------------------------------------------------- back and next, really
   Pressed as a thumb presses them — a hit-tested mouse event at the key's own
   coordinates — because `.click()` would pass on a control nobody can reach. */
await ev('window.__ISLAND__.game.tutorial.goTo(4)');
await settle();
const navStart = await ev('window.__ISLAND__.game.tutorial.stepIndex');
await tapSel('.coach-next');
await frames(3);
const afterNext = await ev('window.__ISLAND__.game.tutorial.stepIndex');
await tapSel('.coach-back');
await frames(3);
const afterBack = await ev('window.__ISLAND__.game.tutorial.stepIndex');
await tapSel('.coach-back');
await frames(3);
const afterBack2 = await ev('window.__ISLAND__.game.tutorial.stepIndex');
console.log('  NAV ' + JSON.stringify({
  from: navStart, afterNext, afterBack, afterBack2,
  nextGoesForward: afterNext === navStart + 1,
  backGoesBackward: afterBack === navStart && afterBack2 === navStart - 1
}));

/* ------------------------------------------------------------- the wash
 *
 *   "increasing the darkness level of the other hexes you can't pick up from"
 *
 * Read back out of the canvas rather than eyeballed: over a hex the player may
 * work the wash must be gone, and away from all of them it must be genuinely
 * dark. The hole centres come from the tutorial's own projection so the samples
 * land where the wash claims they should, not where a screenshot suggests.
 */
await ev('window.__ISLAND__.game.tutorial.goTo(2)');
await settle(10);
console.log('  WASH ' + JSON.stringify(await ev(`(()=>{
  const cv=document.querySelector('.tut-spot');
  if(!cv)return {canvas:false};
  const g=cv.getContext('2d');
  const dpr=cv.width/innerWidth;
  const a=(x,y)=>g.getImageData(
    Math.max(0,Math.min(cv.width-1,Math.round(x*dpr))),
    Math.max(0,Math.min(cv.height-1,Math.round(y*dpr))),1,1).data[3];
  const t=window.__ISLAND__.game.tutorial;
  const sh=t.spotAt()||{holes:[],pips:[]};
  const inside=sh.holes.map(h=>a(h.x,h.y));
  // A point as far from every hole as the frame allows.
  let worst=null,best=-1;
  for(let x=12;x<innerWidth;x+=24)for(let y=12;y<innerHeight;y+=24){
    let d=1e9; for(const h of sh.holes) d=Math.min(d,Math.hypot(h.x-x,h.y-y)-h.r);
    if(d>best){best=d;worst={x,y};}}
  return {canvas:true, workableHexes:sh.holes.length, goldPips:sh.pips.length,
    alphaInsideEachHole:inside,
    alphaFurthestFromAnyHole:worst?a(worst.x,worst.y):null,
    clearOverEveryWorkableHex: inside.length>0 && inside.every(v=>v<=24),
    darkOffThem: worst ? a(worst.x,worst.y)>=90 : false};})()`)));
await shot(`step-03-wash-${TAG}`);

/* ------------------------------------------------- the market, out of the way
 *
 *   "hide / have a much smaller out-of-the-way but clear circles/highlights to
 *    follow so that you successfully make a trade without the tutorial in the
 *    way."
 */
await ev('window.__ISLAND__.game.tutorial.goTo(15)');
await settle();
// Stand the settler on the market so the sheet opens the way a player's would,
// with live rates rather than the "head to the market" refusal.
await ev(`import('/src/board/layout.js').then(L=>{
  const I=window.__ISLAND__, p=I.state.players[0];
  p.x=L.MARKET.x; p.z=L.MARKET.z; p.vx=0; p.vz=0; p.nearTrade='market';
  I.game.avatars[0].group.position.set(L.MARKET.x,0,L.MARKET.z);
  return 1;})`, true);
await frames(6);
await ev('window.__ISLAND__.game.tutorial.ok()');
await frames(4);
await ev('window.__ISLAND__.game.openTrade(null)');
await frames(5); await sleep(200);
const trade = await ev(`(()=>{
  const sheet=document.querySelector('.sheet.trade');
  const card=document.querySelector('.coach-card');
  const cs=card?getComputedStyle(card):null;
  const m=document.querySelector('.coach-mark');
  const mr=m?m.getBoundingClientRect():null;
  const ringOver=mr?document.elementFromPoint(
    Math.round(mr.left+mr.width/2),Math.round(mr.top+mr.height/2)):null;
  return {sheetUp:!!(sheet&&!sheet.classList.contains('hid')),
    badgeDisplay:cs?cs.display:null,
    ringUp:!!(m&&m.classList.contains('on')),
    ringDiameter:mr?Math.round(mr.width):0,
    ringIsOver: ringOver?(ringOver.className||ringOver.tagName):null,
    ringInsideTheSheet: !!(ringOver&&ringOver.closest&&ringOver.closest('.sheet.trade')),
    bandReads:((document.querySelector('.tr-cap.give')||{}).textContent||'').trim()};})()`);
console.log('  MARKET ' + JSON.stringify(trade));
await shot(`step-16-market-${TAG}`);
await ev(`(()=>{const p=window.__ISLAND__.game.panels; if(p&&p.close)p.close(); return 1})()`);
await sleep(400);

/* -------------------------------------------------- and it puts everything back
 * The whole wardrobe hangs off one class. Leaving must restore the HUD. */
await ev('window.__ISLAND__.game.tutorial.quit()');
await sleep(500);
console.log('  EXIT ' + JSON.stringify(await ev(`(()=>{
  const ui=document.getElementById('ui');
  const cls=[...ui.classList].filter(c=>c.indexOf('tut-')===0);
  const shown=s=>{const n=document.querySelector(s);if(!n)return false;
    const c=getComputedStyle(n);
    return c.display!=='none'&&c.visibility!=='hidden'&&parseFloat(c.opacity)>0.05;};
  return {leftoverClasses:cls,
    packBack:shown('.hud-tc'), clockBack:shown('.timechip'),
    awardsBack:shown('.sc-awards'), standingsBack:shown('.hud-tr'),
    buildCardsBack:shown('.hud-bc')};})()`)));

console.log(`${exceptions.length} exception(s)`);
for (const e of exceptions.slice(0, 6)) {
  console.log('  EXC ' + String(e).split('\n').slice(0, 3).join(' | ').slice(0, 400));
}
ws.close(); chrome.kill('SIGKILL');
process.exit(exceptions.length ? 1 : 0);
